// REFUND, ROLLBACK e referências fora de ordem (seção 7 e cenário 7 da seção 13).
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import { ResolvePendingReferences } from '../../src/application/resolve-pending-references';
import { resetSchema, sql } from './support/database';
import { createWallet, ledgerSnapshot, startApp, submit, wager } from '../support/app';

let app: INestApplication;
let url: string;
let worker: ResolvePendingReferences;
const usados = new Set<string>();

beforeAll(async () => {
  await resetSchema();
  // Esperas curtas: 1ª nova tentativa em 30 ms, desiste depois de 3 novas tentativas.
  ({ app, url } = await startApp({ REFERENCE_RETRY_BASE_MS: '30', REFERENCE_RETRY_MAX_ATTEMPTS: '3' }));
  worker = app.get(ResolvePendingReferences);
});
afterAll(() => app?.close());
afterEach(async () => {
  for (const walletId of usados) {
    const s = await ledgerSnapshot(walletId);
    expect(s.balance).toBe(s.rebuilt);
  }
  usados.clear();
});

const brl = (amount: string) => ({ amount, currency: 'BRL' });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function novaWallet(amount: string) {
  const w = await createWallet(url, amount);
  usados.add(w.walletId);
  return w;
}

/** Roda o worker até não sobrar pendência vencida, esperando o backoff entre as rodadas. */
async function drenarPendencias(rodadas = 10) {
  for (let i = 0; i < rodadas; i++) {
    const [{ n }] = await sql`select count(*)::int as n from wager_transactions where status = 'PENDING_REFERENCE'`;
    if (n === 0) return;
    await sleep(80);
    await worker.runOnce();
  }
}

async function statusDe(transactionId: string) {
  const [row] = await sql`select status, failure_code from wager_transactions where id = ${transactionId}`;
  return row;
}

describe('REFUND e ROLLBACK', () => {
  test('REFUND de BET devolve o valor; segundo REFUND e ROLLBACK da mesma BET são recusados', async () => {
    const w = await novaWallet('100.00');
    const bet = wager(w, { money: brl('30.00') });
    await submit(url, bet);
    const ref = { referenceExternalTransactionId: bet.body.externalTransactionId, money: brl('30.00') };

    const refund = await submit(url, wager(w, { kind: 'REFUND', ...ref }));
    expect(refund.status).toBe(201);
    expect(refund.body.balance.amount).toBe('100.00');

    const outro = await submit(url, wager(w, { kind: 'REFUND', ...ref }));
    expect(outro.body).toMatchObject({ status: 'REJECTED', failureCode: 'REFERENCE_ALREADY_REVERSED' });
    const rollback = await submit(url, wager(w, { kind: 'ROLLBACK', ...ref }));
    expect(rollback.body.failureCode).toBe('REFERENCE_ALREADY_REVERSED');

    expect(await ledgerSnapshot(w.walletId)).toMatchObject({ balance: 10_000n, debits: 1, credits: 2 });
  });

  test('ROLLBACK de BET credita; ROLLBACK de WIN debita; ROLLBACK de REFUND debita', async () => {
    const w = await novaWallet('100.00');
    const bet = wager(w, { money: brl('10.00') });
    const win = wager(w, { kind: 'WIN', money: brl('50.00') });
    await submit(url, bet);
    await submit(url, win);
    const rbBet = await submit(url, wager(w, { kind: 'ROLLBACK', referenceExternalTransactionId: bet.body.externalTransactionId, money: brl('10.00') }));
    expect(rbBet.body.balance.amount).toBe('150.00');
    const rbWin = await submit(url, wager(w, { kind: 'ROLLBACK', referenceExternalTransactionId: win.body.externalTransactionId, money: brl('50.00') }));
    expect(rbWin.body.balance.amount).toBe('100.00');

    const bet2 = wager(w, { money: brl('20.00') });
    await submit(url, bet2);
    const refund = wager(w, { kind: 'REFUND', referenceExternalTransactionId: bet2.body.externalTransactionId, money: brl('20.00') });
    await submit(url, refund);
    const rbRefund = await submit(url, wager(w, { kind: 'ROLLBACK', referenceExternalTransactionId: refund.body.externalTransactionId, money: brl('20.00') }));
    expect(rbRefund.body.balance.amount).toBe('80.00');
  });

  test('ROLLBACK de WIN sem saldo: REVERSAL_INSUFFICIENT_FUNDS, diferente de aposta sem saldo', async () => {
    const w = await novaWallet('0.00');
    const win = wager(w, { kind: 'WIN', money: brl('50.00') });
    await submit(url, win);
    await submit(url, wager(w, { money: brl('45.00') })); // o jogador gastou o prêmio
    const r = await submit(url, wager(w, { kind: 'ROLLBACK', referenceExternalTransactionId: win.body.externalTransactionId, money: brl('50.00') }));
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({ status: 'REJECTED', failureCode: 'REVERSAL_INSUFFICIENT_FUNDS', balance: brl('5.00') });
  });

  test.each([
    ['REFUND de WIN', 'REFUND', 'WIN', {}, 'REFERENCE_KIND_NOT_ALLOWED'],
    ['referência de outra rodada', 'REFUND', 'BET', { roundId: 'outra' }, 'REFERENCE_MISMATCH'],
    ['valor diferente', 'REFUND', 'BET', { money: brl('9.99') }, 'REFERENCE_AMOUNT_MISMATCH'],
  ])('%s: %s', async (_, kind, kindReferencia, diferenca, codigo) => {
    const w = await novaWallet('100.00');
    const referencia = wager(w, { kind: kindReferencia, money: brl('10.00') });
    await submit(url, referencia);
    const r = await submit(url, wager(w, {
      kind, referenceExternalTransactionId: referencia.body.externalTransactionId, money: brl('10.00'), ...diferenca,
    }));
    expect(r.status).toBe(422);
    expect(r.body.failureCode).toBe(codigo);
  });

  test('REFUND de BET rejeitada: REFERENCE_NOT_PROCESSED', async () => {
    const w = await novaWallet('1.00');
    const bet = wager(w, { money: brl('10.00') });
    await submit(url, bet);
    const r = await submit(url, wager(w, { kind: 'REFUND', referenceExternalTransactionId: bet.body.externalTransactionId, money: brl('10.00') }));
    expect(r.body.failureCode).toBe('REFERENCE_NOT_PROCESSED');
  });
});

describe('referência fora de ordem', () => {
  test('REFUND chega antes da BET: 202 PENDING_REFERENCE, e o worker aplica depois que a BET chega', async () => {
    const w = await novaWallet('100.00');
    const bet = wager(w, { money: brl('40.00') });
    const refund = wager(w, { kind: 'REFUND', referenceExternalTransactionId: bet.body.externalTransactionId, money: brl('40.00') });

    const antes = await submit(url, refund);
    expect(antes.status).toBe(202);
    expect(antes.body).toMatchObject({ status: 'PENDING_REFERENCE', balance: brl('100.00') });

    expect((await submit(url, bet)).body.balance.amount).toBe('60.00');
    await drenarPendencias();

    expect(await statusDe(antes.body.transactionId)).toEqual({ status: 'PROCESSED', failure_code: null });
    expect(await ledgerSnapshot(w.walletId)).toMatchObject({ balance: 10_000n, debits: 1, credits: 2 });
    // O replay agora mostra o estado atual da transação.
    const replay = await submit(url, refund);
    expect(replay.status).toBe(201);
    expect(replay.body).toMatchObject({ status: 'PROCESSED', idempotentReplay: true });

    const eventos = await sql`select event_type from outbox_messages where payload->'data'->>'transactionId' = ${antes.body.transactionId} order by seq`;
    expect(eventos.map((e: { event_type: string }) => e.event_type))
      .toEqual(['WagerTransactionPendingReference', 'WagerTransactionProcessed', 'WalletBalanceChanged']);
  });

  test('referência que nunca chega: depois do limite de tentativas, REJECTED REFERENCE_NOT_FOUND com evento', async () => {
    const w = await novaWallet('100.00');
    const r = await submit(url, wager(w, { kind: 'ROLLBACK', referenceExternalTransactionId: 'nunca-vai-chegar', money: brl('1.00') }));
    expect(r.status).toBe(202);
    await drenarPendencias();

    const [tx] = await sql`select status, failure_code, reference_attempts from wager_transactions where id = ${r.body.transactionId}`;
    expect(tx).toEqual({ status: 'REJECTED', failure_code: 'REFERENCE_NOT_FOUND', reference_attempts: 2 });
    const [{ n }] = await sql`select count(*)::int as n from outbox_messages
      where event_type = 'WagerTransactionRejected' and payload->'data'->>'transactionId' = ${r.body.transactionId}`;
    expect(n).toBe(1);
    expect(await ledgerSnapshot(w.walletId)).toMatchObject({ balance: 10_000n, debits: 0 });
  });

  test('dois workers ao mesmo tempo sobre as mesmas pendências: cada uma é aplicada uma vez só', async () => {
    const wallets = await Promise.all(Array.from({ length: 5 }, () => novaWallet('100.00')));
    const bets = wallets.flatMap((w) => [wager(w, { money: brl('10.00') }), wager(w, { money: brl('5.00') })]);
    const refunds = bets.map((bet) => wager(
      { walletId: bet.body.walletId, playerId: bet.body.playerId },
      { kind: 'REFUND', referenceExternalTransactionId: bet.body.externalTransactionId, money: bet.body.money },
    ));
    for (const refund of refunds) expect((await submit(url, refund)).status).toBe(202);
    for (const bet of bets) await submit(url, bet);
    await sleep(80);

    const [a, b] = await Promise.all([worker.runOnce(), worker.runOnce()]);
    expect(a.processed + b.processed).toBe(refunds.length);

    for (const w of wallets) {
      expect(await ledgerSnapshot(w.walletId)).toMatchObject({ balance: 10_000n, debits: 2, credits: 3 });
    }
  });
});
