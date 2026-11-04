// Seção 13, concorrência 4 a 8: três ou mais processos do app contra o mesmo PostgreSQL e SQS.
import { afterEach, beforeAll, beforeEach, expect, setDefaultTimeout, test } from 'bun:test';
import { resetSchema, sql } from '../integration/support/database';
import { api, createWallet, ledgerSnapshot, submit, wager } from '../support/app';
import { GetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import { drain, purgeQueues, queueUrl, sendWagerMessage, sqs } from '../support/sqs';
import { logLines, spawnInstance, waitUntil, type Instance } from '../support/instances';
import { QUEUES } from '../../src/infra/messaging/sqs';

setDefaultTimeout(120_000);

let instances: Instance[] = [];

beforeAll(resetSchema);
beforeEach(purgeQueues);
afterEach(async () => {
  await Promise.all(instances.map((i) => i.kill()));
  instances = [];
});

async function subir(n: number, env: Record<string, string> = {}, prefixo = 'app') {
  const novas = await Promise.all(Array.from({ length: n }, (_, i) => spawnInstance(`${prefixo}-${i + 1}`, env)));
  instances.push(...novas);
  return novas;
}

const brl = (amount: string) => ({ amount, currency: 'BRL' });

/** Invariante final: saldo == ledger, e a reconciliação de cada wallet diz consistente. */
async function conferirWallets(url: string, walletIds: string[]) {
  for (const walletId of walletIds) {
    const s = await ledgerSnapshot(walletId);
    expect(s.balance).toBe(s.rebuilt);
    expect((await api(url).post(`/wallets/${walletId}/reconciliation`, {})).body.consistent).toBe(true);
  }
}

/** Nem visível nem em processamento: tudo confirmado (ou na DLQ). */
async function filaVazia(name: string): Promise<boolean> {
  const { Attributes } = await sqs.send(new GetQueueAttributesCommand({
    QueueUrl: await queueUrl(name), AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
  }));
  return Number(Attributes?.ApproximateNumberOfMessages) === 0 && Number(Attributes?.ApproximateNumberOfMessagesNotVisible) === 0;
}

test('3 instâncias pelo HTTP: wallet quente, a mesma aposta repetida e wallets diferentes', async () => {
  const [a, b, c] = await subir(3);
  const urls = [a!.url, b!.url, c!.url];
  const em = (i: number) => urls[i % 3]!;

  // Wallet quente: 60 apostas de 7 numa wallet de 100, espalhadas pelas 3 instâncias.
  const quente = await createWallet(a!.url, '100.00');
  const apostas = await Promise.all(Array.from({ length: 60 }, (_, i) => submit(em(i), wager(quente, { money: brl('7.00') }))));
  expect(apostas.filter((r) => r.body.status === 'PROCESSED')).toHaveLength(14);
  expect(apostas.filter((r) => r.body.failureCode === 'INSUFFICIENT_FUNDS')).toHaveLength(46);

  // A mesma aposta 30 vezes, 10 em cada instância: um débito só.
  const w = await createWallet(a!.url, '100.00');
  const mesma = wager(w, { money: brl('10.00') });
  const repetidas = await Promise.all(Array.from({ length: 30 }, (_, i) => submit(em(i), mesma)));
  expect(new Set(repetidas.map((r) => r.body.transactionId)).size).toBe(1);
  expect(repetidas.filter((r) => !r.body.idempotentReplay)).toHaveLength(1);

  // Seção 8 nas 3 instâncias, em 10 wallets.
  const disputadas = await Promise.all(Array.from({ length: 10 }, () => createWallet(a!.url, '100.00')));
  const duplas = await Promise.all(disputadas.flatMap((d, i) => [
    submit(em(i), wager(d, { money: brl('80.00') })),
    submit(em(i + 1), wager(d, { money: brl('80.00') })),
  ]));
  expect(duplas.filter((r) => r.body.status === 'PROCESSED')).toHaveLength(10);

  expect(await ledgerSnapshot(quente.walletId)).toMatchObject({ balance: 200n, debits: 14 });
  expect(await ledgerSnapshot(w.walletId)).toMatchObject({ balance: 9_000n, debits: 1 });
  await conferirWallets(a!.url, [quente.walletId, w.walletId, ...disputadas.map((d) => d.walletId)]);
});

test('3 consumidores na mesma fila, com mensagens duplicadas: cada operação aplicada uma vez', async () => {
  const [a] = await subir(3, { WORKERS: 'consumer' });
  const wallets = await Promise.all(Array.from({ length: 10 }, () => createWallet(a!.url, '100.00')));

  let enviadas = 0;
  for (const w of wallets) {
    for (let i = 0; i < 5; i++) {
      const op = wager(w, { money: brl('3.00') });
      const data = { ...op.body, idempotencyKey: op.key };
      const messageId = `msg-${crypto.randomUUID()}`;
      await sendWagerMessage(data, { messageId, dedupId: `${messageId}-1` });
      await sendWagerMessage(data, { messageId, dedupId: `${messageId}-2` }); // entrega duplicada
      enviadas += 2;
    }
  }
  expect(enviadas).toBe(100);
  await waitUntil('fila de transações vazia', () => filaVazia(QUEUES.wagers));

  for (const w of wallets) expect(await ledgerSnapshot(w.walletId)).toMatchObject({ balance: 8_500n, debits: 5 });
  const [{ n }] = await sql`select count(*)::int as n from inbox_messages`;
  expect(n).toBeGreaterThanOrEqual(50);
  await conferirWallets(a!.url, wallets.map((w) => w.walletId));
});

test('consumidor morre depois do commit e antes do ack: outra instância recebe de novo e não duplica', async () => {
  const [morre] = await subir(1, { WORKERS: 'consumer', FAIL_AFTER_COMMIT: '1', CONSUMER_VISIBILITY_TIMEOUT: '2' }, 'morre');
  const w = await createWallet(morre!.url, '100.00');
  const op = wager(w, { money: brl('40.00') });
  const messageId = await sendWagerMessage({ ...op.body, idempotencyKey: op.key });

  expect(await morre!.exited).toBe(1); // process.exit(1) logo depois do commit
  expect(logLines(morre!, (e) => String(e.msg ?? '').includes('FAIL_AFTER_COMMIT'))).toHaveLength(1);
  instances = instances.filter((i) => i !== morre);
  expect(await ledgerSnapshot(w.walletId)).toMatchObject({ balance: 6_000n, debits: 1 }); // commit aconteceu
  expect(await filaVazia(QUEUES.wagers)).toBe(false); // e a mensagem não foi apagada

  const [assume] = await subir(1, { WORKERS: 'consumer', CONSUMER_VISIBILITY_TIMEOUT: '2' }, 'assume');
  await waitUntil('mensagem reentregue e confirmada', () => filaVazia(QUEUES.wagers));

  expect(await ledgerSnapshot(w.walletId)).toMatchObject({ balance: 6_000n, debits: 1 });
  expect(logLines(assume!, (e) => String(e.msg ?? '').includes(`duplicate message ${messageId}`))).toHaveLength(1);
  await conferirWallets(assume!.url, [w.walletId]);
});

test('3 publishers sobre a mesma outbox: todo evento publicado, nenhum duas vezes', async () => {
  const [a] = await subir(1);
  const wallets = await Promise.all(Array.from({ length: 15 }, () => createWallet(a!.url, '20.00')));
  await Promise.all(wallets.map((w) => submit(a!.url, wager(w))));
  const [{ total }] = await sql`select count(*)::int as total from outbox_messages where published_at is null`;

  await subir(3, { WORKERS: 'publisher' }, 'pub');
  await waitUntil('outbox publicada', async () => {
    const [{ n }] = await sql`select count(*)::int as n from outbox_messages where published_at is null`;
    return n === 0;
  });
  const ids = (await drain(QUEUES.events, 100)).map((m) => JSON.parse(m.Body!).eventId);
  expect(ids.length).toBeGreaterThanOrEqual(total);
  expect(new Set(ids).size).toBe(ids.length);
});

test('reinício: instâncias mortas no meio do trabalho, novas sobem e o estado final é consistente', async () => {
  const [a, b, c] = await subir(3, {
    WORKERS: 'consumer,publisher,references', CONSUMER_VISIBILITY_TIMEOUT: '2', REFERENCE_RETRY_BASE_MS: '100',
  });
  const urls = [a!.url, b!.url, c!.url];
  const wallets = await Promise.all(Array.from({ length: 8 }, () => createWallet(a!.url, '200.00')));

  // Mistura: apostas pelo HTTP e pela fila, e REFUNDs que chegam antes da BET.
  const operacoes: Promise<unknown>[] = [];
  const esperado = new Map<string, bigint>();
  wallets.forEach((w, i) => {
    const bet = wager(w, { money: brl('15.00') });
    const refund = wager(w, { kind: 'REFUND', referenceExternalTransactionId: bet.body.externalTransactionId, money: brl('15.00') });
    const filaBet = wager(w, { money: brl('5.00') });
    operacoes.push(submit(urls[i % 3]!, refund).then(() => submit(urls[(i + 1) % 3]!, bet)));
    operacoes.push(sendWagerMessage({ ...filaBet.body, idempotencyKey: filaBet.key }));
    esperado.set(w.walletId, 20_000n - 500n); // BET e REFUND se anulam; sobra a aposta da fila
  });
  await Promise.all(operacoes);

  // Duas instâncias morrem sem desligamento limpo, com trabalho em andamento.
  await a!.kill();
  await b!.kill();
  instances = instances.filter((i) => i !== a && i !== b);
  await subir(2, {
    WORKERS: 'consumer,publisher,references', CONSUMER_VISIBILITY_TIMEOUT: '2', REFERENCE_RETRY_BASE_MS: '100',
  }, 'novo');

  await waitUntil('tudo processado e publicado', async () => {
    const [row] = await sql`select
        (select count(*) from wager_transactions where status = 'PENDING_REFERENCE')::int as pendentes,
        (select count(*) from outbox_messages where published_at is null)::int as eventos`;
    return row.pendentes === 0 && row.eventos === 0 && (await filaVazia(QUEUES.wagers));
  }, 60_000);

  for (const [walletId, saldo] of esperado) {
    expect((await ledgerSnapshot(walletId)).balance).toBe(saldo);
  }
  await conferirWallets(c!.url, [...esperado.keys()]);
  const [{ semRegistro }] = await sql`select count(*)::int as "semRegistro" from wager_transactions
    where status = 'PROCESSED' and kind <> 'LOSS'
      and not exists (select 1 from wallet_ledger_entries l where l.transaction_id = wager_transactions.id)`;
  expect(semRegistro).toBe(0);
});
