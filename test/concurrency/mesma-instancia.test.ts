// Concorrência dentro de uma instância: requisições HTTP simultâneas, cada uma com sua conexão do
// pool, disputando a mesma wallet. Nada de mock nem de execução sequencial.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import { resetSchema } from '../integration/support/database';
import { createWallet, ledgerSnapshot, startApp, submit, wager } from '../support/app';

let app: INestApplication;
let url: string;

beforeAll(async () => {
  await resetSchema();
  ({ app, url } = await startApp());
});
afterAll(() => app?.close());

const brl = (amount: string) => ({ amount, currency: 'BRL' });

test('seção 8: saldo 100, duas apostas de 80 ao mesmo tempo (repetido em 20 wallets)', async () => {
  for (let rodada = 0; rodada < 20; rodada++) {
    const w = await createWallet(url, '100.00');
    const a = wager(w, { money: brl('80.00') });
    const b = wager(w, { money: brl('80.00') });

    const respostas = await Promise.all([submit(url, a), submit(url, b)]);
    const status = respostas.map((r) => r.body.status).sort();
    expect(status).toEqual(['PROCESSED', 'REJECTED']);
    expect(respostas.find((r) => r.body.status === 'REJECTED')?.body.failureCode).toBe('INSUFFICIENT_FUNDS');

    // Reenvio das duas (retry do provedor): replays, nenhum débito novo.
    const reenvio = await Promise.all([submit(url, a), submit(url, b)]);
    expect(reenvio.every((r) => r.body.idempotentReplay)).toBe(true);

    const s = await ledgerSnapshot(w.walletId);
    expect(s).toMatchObject({ balance: 2_000n, debits: 1, version: 2 });
    expect(s.balance).toBe(s.rebuilt);
  }
});

test('a mesma aposta 50 vezes em paralelo: um único débito, e as 50 respostas apontam para a mesma transação', async () => {
  const w = await createWallet(url, '1000.00');
  const op = wager(w, { money: brl('25.00') });

  const respostas = await Promise.all(Array.from({ length: 50 }, () => submit(url, op)));

  expect(respostas.every((r) => r.status === 201)).toBe(true);
  expect(new Set(respostas.map((r) => r.body.transactionId)).size).toBe(1);
  expect(respostas.filter((r) => !r.body.idempotentReplay)).toHaveLength(1);
  expect(respostas.every((r) => r.body.balance.amount === '975.00')).toBe(true);

  const s = await ledgerSnapshot(w.walletId);
  expect(s).toMatchObject({ balance: 97_500n, debits: 1, version: 2 });
  expect(s.balance).toBe(s.rebuilt);
});

test('muitas apostas diferentes na mesma wallet quente: nenhuma passa do saldo', async () => {
  const w = await createWallet(url, '100.00');
  const respostas = await Promise.all(Array.from({ length: 30 }, () => submit(url, wager(w, { money: brl('7.00') }))));

  const processadas = respostas.filter((r) => r.body.status === 'PROCESSED').length;
  expect(processadas).toBe(14); // 14 x 7 = 98; a 15ª deixaria o saldo negativo
  expect(respostas.filter((r) => r.body.failureCode === 'INSUFFICIENT_FUNDS')).toHaveLength(16);

  const s = await ledgerSnapshot(w.walletId);
  expect(s).toMatchObject({ balance: 200n, debits: 14, version: 15 });
  expect(s.balance).toBe(s.rebuilt);
});

test('wallets diferentes em paralelo: cada uma correta e independente', async () => {
  const wallets = await Promise.all(Array.from({ length: 10 }, () => createWallet(url, '50.00')));
  const operacoes = wallets.flatMap((w) => [
    wager(w, { money: brl('20.00') }),
    wager(w, { money: brl('20.00') }),
    wager(w, { kind: 'WIN', money: brl('5.00') }),
    wager(w, { kind: 'LOSS', money: brl('20.00') }),
  ]);

  const respostas = await Promise.all(operacoes.map((op) => submit(url, op)));
  expect(respostas.every((r) => r.status === 201)).toBe(true);

  for (const w of wallets) {
    const s = await ledgerSnapshot(w.walletId);
    expect(s).toMatchObject({ balance: 1_500n, debits: 2, credits: 2 }); // 50 - 20 - 20 + 5
    expect(s.balance).toBe(s.rebuilt);
  }
});
