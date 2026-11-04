// Consumidor SQS contra o Postgres e o MiniStack reais: inbox, ack depois do commit, retry, DLQ e parada.
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import { SqsWagerConsumer, CONSUMER_NAME } from '../../src/infra/messaging/sqs-wager-consumer';
import { QUEUES } from '../../src/infra/messaging/sqs';
import { resetSchema, sql } from './support/database';
import { createWallet, ledgerSnapshot, startApp, submit, wager } from '../support/app';
import { drain, purgeQueues, sendWagerMessage } from '../support/sqs';

let app: INestApplication;
let url: string;
let consumer: SqsWagerConsumer;

beforeAll(async () => {
  await resetSchema();
  // Backoff zero (a mensagem volta na hora) e lock_timeout curto para simular falha transitória.
  ({ app, url } = await startApp({ CONSUMER_BACKOFF_BASE_SECONDS: '0', LOCK_TIMEOUT: '300ms' }));
  consumer = app.get(SqsWagerConsumer);
});
afterAll(() => app?.close());
beforeEach(purgeQueues);

const brl = (amount: string) => ({ amount, currency: 'BRL' });

/** Dados de uma mensagem WagerTransactionRequested (inclui a idempotencyKey, como na seção 10). */
function dados(w: { walletId: string; playerId: string }, over: Record<string, unknown> = {}) {
  const op = wager(w, over);
  return { ...op.body, idempotencyKey: op.key };
}

async function transacoesDa(walletId: string) {
  return sql`select status, failure_code from wager_transactions where wallet_id = ${walletId} and kind <> 'OPENING'`;
}

/** Segura a linha da wallet numa transação à parte até `soltar()` ser chamado. */
async function travarWallet(walletId: string) {
  let soltar!: () => void;
  const liberada = new Promise<void>((resolve) => { soltar = resolve; });
  let travou!: () => void;
  const travada = new Promise<void>((resolve) => { travou = resolve; });
  const transacao = sql.begin(async (tx) => {
    await tx`select id from wallets where id = ${walletId} for update`;
    travou();
    await liberada;
  });
  await travada;
  return async () => {
    soltar();
    await transacao;
  };
}

test('processa a mensagem, grava o inbox na mesma transação e só então apaga da fila', async () => {
  const w = await createWallet(url, '100.00');
  const messageId = await sendWagerMessage(dados(w, { money: brl('30.00') }));

  expect(await consumer.consumeOnce(0)).toBe(1);

  expect(await ledgerSnapshot(w.walletId)).toMatchObject({ balance: 7_000n, debits: 1 });
  const [inbox] = await sql`select processed_at is not null as processada, transaction_id is not null as ligada
                            from inbox_messages where consumer_name = ${CONSUMER_NAME} and message_id = ${messageId}`;
  expect(inbox).toEqual({ processada: true, ligada: true });
  expect(await drain(QUEUES.wagers)).toHaveLength(0);
});

test('a mesma mensagem entregue duas vezes: um débito só, as duas confirmadas', async () => {
  const w = await createWallet(url, '100.00');
  const d = dados(w, { money: brl('30.00') });
  // O SQS FIFO lembra o id de deduplicação por 5 min: cada execução do teste usa ids novos.
  const messageId = `msg-${crypto.randomUUID()}`;
  await sendWagerMessage(d, { messageId, dedupId: `${messageId}-entrega-1` });
  await consumer.consumeOnce(0);
  await sendWagerMessage(d, { messageId, dedupId: `${messageId}-entrega-2` }); // redelivery com outro id de dedup do broker
  await consumer.consumeOnce(0);

  expect(await ledgerSnapshot(w.walletId)).toMatchObject({ balance: 7_000n, debits: 1 });
  expect(await drain(QUEUES.wagers)).toHaveLength(0);
  expect(await drain(QUEUES.wagersDeadLetter)).toHaveLength(0);
});

test('a mesma operação pela API e pela fila: o mesmo caso de uso, um débito só', async () => {
  const w = await createWallet(url, '100.00');
  const op = wager(w, { money: brl('30.00') });
  expect((await submit(url, op)).status).toBe(201);
  await sendWagerMessage({ ...op.body, idempotencyKey: op.key });
  await consumer.consumeOnce(0);

  expect(await ledgerSnapshot(w.walletId)).toMatchObject({ balance: 7_000n, debits: 1 });
  expect(await drain(QUEUES.wagers)).toHaveLength(0);
});

test('rejeição de negócio é resultado: a mensagem é confirmada, não vai para a DLQ', async () => {
  const w = await createWallet(url, '10.00');
  await sendWagerMessage(dados(w, { money: brl('50.00') }));
  await consumer.consumeOnce(0);

  expect(await transacoesDa(w.walletId)).toEqual([{ status: 'REJECTED', failure_code: 'INSUFFICIENT_FUNDS' }]);
  expect(await drain(QUEUES.wagers)).toHaveLength(0);
  expect(await drain(QUEUES.wagersDeadLetter)).toHaveLength(0);
});

test.each([
  ['corpo que não é JSON', { body: '{quebrado' }],
  ['tipo errado', { body: JSON.stringify({ messageId: 'm', type: 'Outro', data: {} }) }],
  ['valor com 3 casas', { money: brl('1.001') }],
  ['OPENING pela fila', { kind: 'OPENING' }],
])('mensagem inválida (%s): direto para a DLQ, com o motivo', async (_, caso) => {
  const w = await createWallet(url, '10.00');
  const { body, ...over } = caso as { body?: string };
  await sendWagerMessage(dados(w, over), { body });
  await consumer.consumeOnce(0);

  expect(await drain(QUEUES.wagers)).toHaveLength(0);
  const mortas = await drain(QUEUES.wagersDeadLetter);
  expect(mortas).toHaveLength(1);
  expect(mortas[0]!.MessageAttributes?.reason?.StringValue).toBeTruthy();
  expect(await transacoesDa(w.walletId)).toHaveLength(0);
});

test('mesma idempotency key com outro payload pela fila: DLQ (precisa de alguém olhar)', async () => {
  const w = await createWallet(url, '100.00');
  const d = dados(w, { money: brl('10.00') });
  await sendWagerMessage(d);
  await consumer.consumeOnce(0);
  await sendWagerMessage({ ...d, money: brl('99.00') });
  await consumer.consumeOnce(0);

  expect(await drain(QUEUES.wagersDeadLetter)).toHaveLength(1);
  expect(await ledgerSnapshot(w.walletId)).toMatchObject({ debits: 1 });
});

test('falha transitória (wallet travada além do lock_timeout): a mensagem volta e passa depois', async () => {
  const w = await createWallet(url, '100.00');
  await sendWagerMessage(dados(w, { money: brl('30.00') }));

  const soltar = await travarWallet(w.walletId);
  await consumer.consumeOnce(0);
  expect(await transacoesDa(w.walletId)).toHaveLength(0); // nada gravado: a transação SQL foi desfeita
  await soltar();

  await consumer.consumeOnce(0);
  expect(await ledgerSnapshot(w.walletId)).toMatchObject({ balance: 7_000n, debits: 1 });
  expect(await drain(QUEUES.wagers)).toHaveLength(0);
});

test('falha transitória que não passa: depois de 5 entregas a redrive policy manda para a DLQ', async () => {
  const w = await createWallet(url, '100.00');
  await sendWagerMessage(dados(w, { money: brl('30.00') }));

  const soltar = await travarWallet(w.walletId);
  for (let i = 0; i < 6; i++) await consumer.consumeOnce(0);
  await soltar();

  expect(await drain(QUEUES.wagers)).toHaveLength(0);
  const mortas = await drain(QUEUES.wagersDeadLetter);
  expect(mortas).toHaveLength(1);
  expect(await transacoesDa(w.walletId)).toHaveLength(0);
});

test('parada (SIGTERM): termina a mensagem em andamento e devolve as que não começaram', async () => {
  const w = await createWallet(url, '100.00');
  for (const valor of ['10.00', '20.00', '30.00']) await sendWagerMessage(dados(w, { money: brl(valor) }));

  const soltar = await travarWallet(w.walletId); // a 1ª mensagem fica esperando o lock
  consumer.start();
  await new Promise((resolve) => setTimeout(resolve, 150));
  const parando = consumer.stop();
  await soltar(); // a 1ª consegue o lock e termina
  await parando;

  expect(await transacoesDa(w.walletId)).toEqual([{ status: 'PROCESSED', failure_code: null }]);
  expect(await ledgerSnapshot(w.walletId)).toMatchObject({ balance: 9_000n, debits: 1 });
  // As outras duas foram devolvidas (visibilidade 0): estão disponíveis na hora, para outra instância.
  const devolvidas = await drain(QUEUES.wagers);
  expect(devolvidas.map((m) => JSON.parse(m.Body!).data.money.amount)).toEqual(['20.00', '30.00']);
});
