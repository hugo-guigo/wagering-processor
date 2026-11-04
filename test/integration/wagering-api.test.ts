// API HTTP contra o Postgres real: wallets, BET, WIN, LOSS, idempotência, rejeições e outbox.
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import { resetSchema, sql } from './support/database';
import { api, createWallet, ledgerSnapshot, startApp, submit, wager } from '../support/app';

let app: INestApplication;
let url: string;
const usados = new Set<string>();

beforeAll(async () => {
  await resetSchema();
  ({ app, url } = await startApp());
});
afterAll(() => app?.close());

/** Toda wallet tocada pelo teste termina com saldo == ledger reconstruído. */
afterEach(async () => {
  for (const walletId of usados) {
    const s = await ledgerSnapshot(walletId);
    expect(s.balance).toBe(s.rebuilt);
  }
  usados.clear();
});

async function novaWallet(amount: string) {
  const wallet = await createWallet(url, amount);
  usados.add(wallet.walletId);
  return wallet;
}

async function eventos(walletId: string) {
  const rows = await sql`select event_type from outbox_messages where aggregate_id = ${walletId} order by seq`;
  return rows.map((r: { event_type: string }) => r.event_type);
}

describe('POST /wallets', () => {
  test('cria com saldo inicial: versão 1, transação OPENING, crédito no ledger e evento na outbox', async () => {
    const playerId = `p-${crypto.randomUUID()}`;
    const r = await api(url).post('/wallets', { playerId, initialBalance: { amount: '1000.00', currency: 'BRL' } });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ playerId, balance: { amount: '1000.00', currency: 'BRL' }, version: 1 });
    usados.add(r.body.id);

    const s = await ledgerSnapshot(r.body.id);
    expect(s).toMatchObject({ balance: 100_000n, credits: 1, debits: 0, version: 1 });
    const [opening] = await sql`select kind, status from wager_transactions where wallet_id = ${r.body.id}`;
    expect(opening).toEqual({ kind: 'OPENING', status: 'PROCESSED' });
    expect(await eventos(r.body.id)).toEqual(['WalletBalanceChanged']);
  });

  test('saldo inicial zero não gera transação, lançamento nem evento', async () => {
    const { walletId } = await novaWallet('0.00');
    expect(await ledgerSnapshot(walletId)).toMatchObject({ balance: 0n, credits: 0 });
    expect(await eventos(walletId)).toEqual([]);
  });

  test('wallet duplicada para o mesmo player e moeda: 409; outra moeda pode', async () => {
    const playerId = `p-${crypto.randomUUID()}`;
    expect((await api(url).post('/wallets', { playerId, initialBalance: { amount: '1', currency: 'BRL' } })).status).toBe(201);
    const dup = await api(url).post('/wallets', { playerId, initialBalance: { amount: '1', currency: 'BRL' } });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('WALLET_ALREADY_EXISTS');
    expect((await api(url).post('/wallets', { playerId, initialBalance: { amount: '1', currency: 'USD' } })).status).toBe(201);
  });

  test.each([
    [{ initialBalance: { amount: '1.00', currency: 'BRL' } }],
    [{ playerId: 'p', initialBalance: { amount: '-1.00', currency: 'BRL' } }],
    [{ playerId: 'p', initialBalance: { amount: 10, currency: 'BRL' } }],
    [{ playerId: 'p', initialBalance: { amount: '1.001', currency: 'BRL' } }],
    [{ playerId: 'p', initialBalance: { amount: '1e3', currency: 'BRL' } }],
  ])('payload inválido: 400 (%j)', async (body) => {
    expect((await api(url).post('/wallets', body)).status).toBe(400);
  });

  test('JSON malformado: 400', async () => {
    expect((await api(url).post('/wallets', '{"playerId":')).status).toBe(400);
  });
});

describe('POST /wagering/transactions', () => {
  test('BET processada: 201, saldo novo, um débito e eventos Processed + BalanceChanged', async () => {
    const w = await novaWallet('1000.00');
    const r = await submit(url, wager(w, { money: { amount: '25.00', currency: 'BRL' } }));
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ status: 'PROCESSED', balance: { amount: '975.00', currency: 'BRL' }, idempotentReplay: false });
    expect(await ledgerSnapshot(w.walletId)).toMatchObject({ balance: 97_500n, debits: 1, version: 2 });
    expect(await eventos(w.walletId)).toEqual(['WalletBalanceChanged', 'WagerTransactionProcessed', 'WalletBalanceChanged']);
  });

  test('replay: mesma key e mesmo payload devolvem a resposta original, sem novo débito', async () => {
    const w = await novaWallet('100.00');
    const op = wager(w, { money: { amount: '30.00', currency: 'BRL' } });
    const primeira = await submit(url, op);
    await submit(url, wager(w, { money: { amount: '50.00', currency: 'BRL' } })); // saldo muda depois
    const repetida = await submit(url, op);
    expect(repetida.status).toBe(primeira.status);
    expect(repetida.body).toEqual({ ...primeira.body, idempotentReplay: true });
    expect(repetida.body.balance.amount).toBe('70.00'); // o saldo daquele momento, não o atual (20.00)
    expect(await ledgerSnapshot(w.walletId)).toMatchObject({ debits: 2, balance: 2_000n });
  });

  test('"25.5" e "25.50" são o mesmo pedido: replay, não conflito', async () => {
    const w = await novaWallet('100.00');
    const op = wager(w, { money: { amount: '25.50', currency: 'BRL' } });
    await submit(url, op);
    const r = await submit(url, { ...op, body: { ...op.body, money: { amount: '25.5', currency: 'BRL' } } });
    expect(r.body.idempotentReplay).toBe(true);
  });

  test('mesma key com payload diferente: 409, sem novo débito', async () => {
    const w = await novaWallet('100.00');
    const op = wager(w);
    const original = await submit(url, op);
    const r = await submit(url, { ...op, body: { ...op.body, money: { amount: '99.00', currency: 'BRL' } } });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT', existingTransactionId: original.body.transactionId });
    expect(await ledgerSnapshot(w.walletId)).toMatchObject({ debits: 1 });
  });

  test('mesmo externalTransactionId com outra key: 409', async () => {
    const w = await novaWallet('100.00');
    const op = wager(w);
    await submit(url, op);
    expect((await submit(url, { ...op, key: `${op.key}-outra` })).status).toBe(409);
  });

  test('BET sem saldo: 422 INSUFFICIENT_FUNDS, saldo intacto, sem lançamento, evento Rejected', async () => {
    const w = await novaWallet('10.00');
    const r = await submit(url, wager(w, { money: { amount: '10.01', currency: 'BRL' } }));
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({ status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS', balance: { amount: '10.00' } });
    expect(await ledgerSnapshot(w.walletId)).toMatchObject({ balance: 1_000n, debits: 0, version: 1 });
    expect((await eventos(w.walletId)).at(-1)).toBe('WagerTransactionRejected');
  });

  test('a rejeição também é idempotente: o replay devolve 422 de novo', async () => {
    const w = await novaWallet('1.00');
    const op = wager(w, { money: { amount: '5.00', currency: 'BRL' } });
    await submit(url, op);
    const r = await submit(url, op);
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({ failureCode: 'INSUFFICIENT_FUNDS', idempotentReplay: true });
  });

  test('WIN credita; LOSS registra sem mexer no saldo nem no ledger', async () => {
    const w = await novaWallet('100.00');
    const win = await submit(url, wager(w, { kind: 'WIN', money: { amount: '40.00', currency: 'BRL' } }));
    expect(win.body.balance.amount).toBe('140.00');
    const loss = await submit(url, wager(w, { kind: 'LOSS', money: { amount: '10.00', currency: 'BRL' } }));
    expect(loss.status).toBe(201);
    expect(loss.body).toMatchObject({ status: 'PROCESSED', balance: { amount: '140.00' } });
    expect(await ledgerSnapshot(w.walletId)).toMatchObject({ balance: 14_000n, credits: 2, debits: 0, version: 2 });
    expect((await eventos(w.walletId)).at(-1)).toBe('WagerTransactionProcessed'); // LOSS: sem BalanceChanged
  });

  test('moeda diferente da wallet: 422 CURRENCY_MISMATCH', async () => {
    const w = await novaWallet('100.00');
    const r = await submit(url, wager(w, { money: { amount: '1.00', currency: 'USD' } }));
    expect(r.status).toBe(422);
    expect(r.body.failureCode).toBe('CURRENCY_MISMATCH');
  });

  test('wallet de outro player: 422 WALLET_PLAYER_MISMATCH', async () => {
    const w = await novaWallet('100.00');
    const r = await submit(url, wager({ ...w, playerId: 'intruso' }));
    expect(r.body.failureCode).toBe('WALLET_PLAYER_MISMATCH');
  });

  test('wallet inexistente: 422 WALLET_NOT_FOUND, nada gravado', async () => {
    const op = wager({ walletId: crypto.randomUUID(), playerId: 'p' });
    const r = await submit(url, op);
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({ transactionId: null, failureCode: 'WALLET_NOT_FOUND' });
    const [{ n }] = await sql`select count(*)::int as n from wager_transactions where idempotency_key = ${op.key}`;
    expect(n).toBe(0);
  });

  test.each([
    ['sem Idempotency-Key', {}, undefined],
    ['kind OPENING', { kind: 'OPENING' }, 'key'],
    ['kind desconhecido', { kind: 'JACKPOT' }, 'key'],
    ['valor com 3 casas', { money: { amount: '1.001', currency: 'BRL' } }, 'key'],
    ['valor como number', { money: { amount: 1, currency: 'BRL' } }, 'key'],
    ['REFUND sem referência', { kind: 'REFUND' }, 'key'],
    ['walletId que não é UUID', { walletId: 'abc' }, 'key'],
  ])('payload inválido (%s): 400', async (_, over, key) => {
    const op = wager({ walletId: crypto.randomUUID(), playerId: 'p' }, over);
    const headers: Record<string, string> = key ? { 'Idempotency-Key': `${key}-${crypto.randomUUID()}` } : {};
    const r = await api(url).post('/wagering/transactions', op.body, headers);
    expect(r.status).toBe(400);
  });
});
