// Transactional outbox contra o Postgres e o SQS (MiniStack) reais.
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import { RelayOutbox } from '../../src/application/relay-outbox';
import { EventPublisher, TransactionRunner, Clock } from '../../src/application/ports';
import { SqsEventPublisher } from '../../src/infra/messaging/sqs-event-publisher';
import { SqsQueues, QUEUES } from '../../src/infra/messaging/sqs';
import type { OutboxMessage } from '../../src/domain/messaging/outbox-message';
import { resetSchema, sql } from './support/database';
import { createWallet, startApp, submit, wager } from '../support/app';
import { drain, purgeQueues } from '../support/sqs';

let app: INestApplication;
let url: string;
let relay: RelayOutbox;

beforeAll(async () => {
  await resetSchema();
  ({ app, url } = await startApp());
  relay = app.get(RelayOutbox);
});
afterAll(() => app?.close());
beforeEach(async () => {
  await relay.runOnce(1_000); // publica sobras de outros testes
  await purgeQueues();
});

async function pendentes(walletId?: string) {
  const [{ n }] = walletId
    ? await sql`select count(*)::int as n from outbox_messages where published_at is null and aggregate_id = ${walletId}`
    : await sql`select count(*)::int as n from outbox_messages where published_at is null`;
  return n as number;
}

/** Relay com um publisher específico, usando o mesmo banco do app. */
function relayCom(publisher: EventPublisher) {
  return new RelayOutbox(app.get(TransactionRunner), publisher, app.get(Clock));
}

test('publica os eventos pendentes, marca como publicados e mantém a ordem por wallet', async () => {
  const w = await createWallet(url, '100.00');
  await submit(url, wager(w, { money: { amount: '10.00', currency: 'BRL' } }));
  expect(await pendentes()).toBe(3); // abertura + Processed + BalanceChanged

  const r = await relay.runOnce();
  expect(r).toEqual({ published: 3, failed: 0 });
  expect(await pendentes()).toBe(0);

  const mensagens = await drain(QUEUES.events);
  const corpos = mensagens.map((m) => JSON.parse(m.Body!));
  expect(corpos.map((c) => c.eventType)).toEqual(['WalletBalanceChanged', 'WagerTransactionProcessed', 'WalletBalanceChanged']);
  expect(mensagens.every((m) => m.Attributes?.MessageGroupId === w.walletId)).toBe(true);
  const ids = await sql`select id from outbox_messages where aggregate_id = ${w.walletId} order by seq`;
  expect(corpos.map((c) => c.eventId)).toEqual(ids.map((row: { id: string }) => row.id));
});

test('dois publishers ao mesmo tempo: cada evento sai uma vez, sem perder nenhum', async () => {
  const wallets = await Promise.all(Array.from({ length: 10 }, () => createWallet(url, '50.00')));
  await Promise.all(wallets.map((w) => submit(url, wager(w))));
  const total = await pendentes();
  expect(total).toBe(30);

  // Lotes pequenos para os dois relays disputarem as mesmas linhas várias vezes.
  const rodar = async () => {
    let publicados = 0;
    for (let r = await relay.runOnce(3); r.published > 0; r = await relay.runOnce(3)) publicados += r.published;
    return publicados;
  };
  const [a, b] = await Promise.all([rodar(), rodar()]);
  expect(a + b).toBe(total);
  expect(a).toBeGreaterThan(0);
  expect(b).toBeGreaterThan(0);

  const ids = (await drain(QUEUES.events, 50)).map((m) => JSON.parse(m.Body!).eventId);
  expect(ids).toHaveLength(total);
  expect(new Set(ids).size).toBe(total);
});

test('SQS fora do ar: nada é perdido; a tentativa é contada, o erro guardado e a próxima agendada com backoff', async () => {
  const w = await createWallet(url, '10.00');
  const queues = new SqsQueues();
  Object.assign(queues, { client: (await import('../../src/infra/messaging/sqs')).createSqsClient('http://localhost:1') });
  const r = await relayCom(new SqsEventPublisher(queues)).runOnce();
  expect(r).toEqual({ published: 0, failed: 1 });

  const [row] = await sql`select attempts, published_at, last_error, next_attempt_at > now() as adiado
                          from outbox_messages where aggregate_id = ${w.walletId}`;
  expect(row).toMatchObject({ attempts: 1, published_at: null, adiado: true });
  expect(row.last_error).toBeTruthy();
  expect((await relay.runOnce()).published).toBe(0); // ainda não venceu o backoff de 1 s
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  expect((await relay.runOnce()).published).toBe(1);
});

test('processo morre depois de publicar e antes do COMMIT: o evento volta, é publicado de novo e continua seguro', async () => {
  const w = await createWallet(url, '10.00');
  const real = app.get(EventPublisher);
  // Publica de verdade e "morre" antes de marcar como publicado (a transação SQL faz ROLLBACK).
  const morreDepoisDePublicar = new (class extends EventPublisher {
    async publish(messages: OutboxMessage[]): Promise<Map<string, string>> {
      await real.publish(messages);
      throw new Error('processo morreu');
    }
  })();
  await expect(relayCom(morreDepoisDePublicar).runOnce()).rejects.toThrow('processo morreu');
  expect(await pendentes(w.walletId)).toBe(1);

  await relay.runOnce(); // outra instância assume
  expect(await pendentes(w.walletId)).toBe(0);

  // A republicação usa o mesmo eventId como MessageDeduplicationId: o SQS FIFO descarta a cópia
  // dentro de 5 minutos. Fora dessa janela, o consumidor deduplica pelo eventId.
  const eventos = (await drain(QUEUES.events)).map((m) => JSON.parse(m.Body!).eventId);
  const [{ id }] = await sql`select id from outbox_messages where aggregate_id = ${w.walletId}`;
  expect(eventos).toEqual([id]);
});
