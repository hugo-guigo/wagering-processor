// Consultas, extrato com cursor, reconciliação, health e métricas.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import { resetSchema, sql } from './support/database';
import { api, createWallet, startApp, submit, wager } from '../support/app';

let app: INestApplication;
let url: string;

beforeAll(async () => {
  await resetSchema();
  ({ app, url } = await startApp());
});
afterAll(() => app?.close());

const get = async (path: string) => {
  const r = await fetch(`${url}${path}`);
  const text = await r.text();
  return { status: r.status, body: r.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text };
};
const brl = (amount: string) => ({ amount, currency: 'BRL' });

describe('consultas', () => {
  test('GET /wallets/:id: 200 com saldo e versão; 404 se não existe; 400 se o id não é UUID', async () => {
    const w = await createWallet(url, '10.00');
    await submit(url, wager(w, { money: brl('1.00') }));
    expect((await get(`/wallets/${w.walletId}`)).body).toMatchObject({ id: w.walletId, balance: brl('9.00'), version: 2 });
    expect((await get(`/wallets/${crypto.randomUUID()}`)).status).toBe(404);
    expect((await get('/wallets/abc')).status).toBe(400);
  });

  test('GET da transação por id interno e por (provider, id externo)', async () => {
    const w = await createWallet(url, '10.00');
    const op = wager(w, { money: brl('2.50') });
    const { body } = await submit(url, op);
    const porId = await get(`/wagering/transactions/${body.transactionId}`);
    expect(porId.body).toMatchObject({ transactionId: body.transactionId, kind: 'BET', status: 'PROCESSED', money: brl('2.50'), balance: brl('7.50') });
    const porExterno = await get(`/providers/provider-a/wagering/transactions/${op.body.externalTransactionId}`);
    expect(porExterno.body.transactionId).toBe(body.transactionId);
    expect((await get('/providers/provider-a/wagering/transactions/nao-existe')).status).toBe(404);
  });

  test('extrato: do mais novo para o mais antigo, cursor opaco e estável mesmo com lançamentos novos', async () => {
    const w = await createWallet(url, '100.00');
    for (let i = 1; i <= 7; i++) await submit(url, wager(w, { money: brl(`${i}.00`) }));

    const p1 = await get(`/wallets/${w.walletId}/ledger?limit=3`);
    expect(p1.body.items.map((i: any) => i.money.amount)).toEqual(['7.00', '6.00', '5.00']);
    expect(typeof p1.body.nextCursor).toBe('string');

    await submit(url, wager(w, { kind: 'WIN', money: brl('50.00') })); // chega no meio da paginação

    const p2 = await get(`/wallets/${w.walletId}/ledger?limit=3&cursor=${p1.body.nextCursor}`);
    expect(p2.body.items.map((i: any) => i.money.amount)).toEqual(['4.00', '3.00', '2.00']);
    const p3 = await get(`/wallets/${w.walletId}/ledger?limit=3&cursor=${p2.body.nextCursor}`);
    expect(p3.body.items.map((i: any) => i.money.amount)).toEqual(['1.00', '100.00']);
    expect(p3.body.items.at(-1)).toMatchObject({ direction: 'CREDIT', balanceBefore: brl('0.00'), balanceAfter: brl('100.00') });
    expect(p3.body.nextCursor).toBeNull();
  });

  test('extrato: cursor adulterado e limite fora da faixa são 400', async () => {
    const w = await createWallet(url, '1.00');
    expect((await get(`/wallets/${w.walletId}/ledger?cursor=nao-e-cursor`)).status).toBe(400);
    expect((await get(`/wallets/${w.walletId}/ledger?limit=0`)).status).toBe(400);
    expect((await get(`/wallets/${w.walletId}/ledger?limit=201`)).status).toBe(400);
  });
});

describe('reconciliação', () => {
  test('wallet consistente: diferença zero e lançamentos conferidos', async () => {
    const w = await createWallet(url, '100.00');
    await submit(url, wager(w, { money: brl('25.00') }));
    const r = await api(url).post(`/wallets/${w.walletId}/reconciliation`, {});
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      walletId: w.walletId,
      storedBalance: brl('75.00'),
      calculatedBalance: brl('75.00'),
      difference: brl('0.00'),
      consistent: true,
      checkedEntries: 2,
    });
  });

  test('divergência é sinalizada e contada na métrica, nunca corrigida', async () => {
    const w = await createWallet(url, '100.00');
    // Simula corrupção vinda de fora da aplicação: só um superusuário desligando os triggers consegue.
    await sql.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`update wallets set balance_minor = balance_minor + 1 where id = ${w.walletId}`;
    });

    const r = await api(url).post(`/wallets/${w.walletId}/reconciliation`, {});
    expect(r.body).toMatchObject({ consistent: false, difference: brl('0.01'), storedBalance: brl('100.01') });
    const [{ balance_minor }] = await sql`select balance_minor from wallets where id = ${w.walletId}`;
    expect(BigInt(balance_minor)).toBe(10_001n); // continua divergente: não foi "consertado"

    const metricas = (await get('/metrics')).body as string;
    expect(metricas).toMatch(/wagering_reconciliation_divergences_total [1-9]/);
  });
});

describe('health e métricas', () => {
  test('live e ready', async () => {
    expect((await get('/health/live')).body).toEqual({ status: 'ok' });
    expect((await get('/health/ready')).body).toEqual({ status: 'ok', checks: { postgres: 'up', sqs: 'up' } });
  });

  test('/metrics expõe o que a seção 12 pede', async () => {
    const w = await createWallet(url, '10.00');
    const op = wager(w);
    await submit(url, op);
    await submit(url, op); // replay
    const texto = (await get('/metrics')).body as string;
    for (const nome of [
      'wagering_transactions_total{status="PROCESSED",kind="BET",source="http"}',
      'wagering_duplicates_detected_total{type="idempotent_replay"}',
      'wagering_processing_duration_seconds_bucket',
      'wagering_wallet_lock_wait_seconds_bucket',
      'wagering_outbox_lag_seconds',
      'wagering_outbox_pending',
      'wagering_dlq_depth',
    ]) {
      expect(texto).toContain(nome);
    }
  });

  test('toda resposta devolve um x-correlation-id (o do chamador, se veio)', async () => {
    const r = await fetch(`${url}/health/live`, { headers: { 'x-correlation-id': 'meu-id' } });
    expect(r.headers.get('x-correlation-id')).toBe('meu-id');
  });
});
