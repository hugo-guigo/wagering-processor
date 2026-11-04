import { expect, test } from 'bun:test';
import { Money } from '../../src/domain/money';
import { Wallet } from '../../src/domain/wallet';
import { WalletBalanceChanged } from '../../src/domain/events/wagering-events';
import { OutboxMessage } from '../../src/domain/messaging/outbox-message';
import { InboxMessage } from '../../src/domain/messaging/inbox-message';
import { LedgerDirection } from '../../src/domain/wallet-ledger-entry';

const at = new Date('2026-11-04T12:00:00.000Z');

function evento() {
  const { wallet, openingEntry } = Wallet.open({
    id: 'w1', playerId: 'p1', initialBalance: Money.from({ amount: '1000.00', currency: 'BRL' }), at,
    openingTransactionId: 't1', openingEntryId: 'e1',
  });
  return WalletBalanceChanged.from(wallet, openingEntry!, { eventId: 'ev-1', correlationId: 'corr-1', occurredAt: at });
}

test('envelope do evento: tipo e versão vêm da classe, dinheiro sai como string, data em ISO', () => {
  expect(evento().toJSON()).toEqual({
    eventId: 'ev-1',
    eventType: 'WalletBalanceChanged',
    aggregateId: 'w1',
    correlationId: 'corr-1',
    occurredAt: '2026-11-04T12:00:00.000Z',
    version: 1,
    data: {
      walletId: 'w1', transactionId: 't1', direction: LedgerDirection.Credit,
      money: { amount: '1000.00', currency: 'BRL' },
      balanceBefore: { amount: '0.00', currency: 'BRL' },
      balanceAfter: { amount: '1000.00', currency: 'BRL' },
      walletVersion: 1,
    },
  });
});

test('outbox: id da mensagem = eventId, nasce pendente e vencida', () => {
  const msg = OutboxMessage.enqueue(evento());
  expect(msg.id).toBe('ev-1');
  expect(msg.eventType).toBe('WalletBalanceChanged');
  expect(msg.isPending()).toBe(true);
  expect(msg.isDue(at)).toBe(true);
});

test('outbox: backoff exponencial 1 s, 2 s, 4 s... com teto de 5 min', () => {
  const msg = OutboxMessage.enqueue(evento());
  const atrasos: number[] = [];
  for (let i = 0; i < 12; i++) {
    msg.scheduleRetry(at);
    atrasos.push(msg.nextAttemptAt!.getTime() - at.getTime());
  }
  expect(atrasos.slice(0, 4)).toEqual([1_000, 2_000, 4_000, 8_000]);
  expect(atrasos.at(-1)).toBe(300_000);
  expect(msg.attempts).toBe(12);
  expect(msg.isDue(at)).toBe(false);
});

test('outbox: publicar duas vezes é seguro e mantém a primeira data', () => {
  const msg = OutboxMessage.enqueue(evento());
  msg.markPublished(at);
  msg.markPublished(new Date(at.getTime() + 5_000));
  expect(msg.publishedAt).toEqual(at);
  expect(msg.isPending()).toBe(false);
});

test('inbox: processar duas vezes mantém a primeira data', () => {
  const inbox = InboxMessage.receive({ messageId: 'm1', consumerName: 'c', payloadHash: 'a'.repeat(64), receivedAt: at });
  expect(inbox.isProcessed()).toBe(false);
  inbox.markProcessed(at);
  inbox.markProcessed(new Date(at.getTime() + 1));
  expect(inbox.processedAt).toEqual(at);
});
