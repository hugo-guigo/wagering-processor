// Conversão entre registros de persistência e objetos do domínio. Dinheiro sai e entra como centavos
// (bigint) mais a moeda; null do banco vira undefined no domínio.
import { Money } from '../../domain/money';
import { Wallet } from '../../domain/wallet';
import {
  WagerTransaction, type WagerTransactionKind, type WagerTransactionStatus,
} from '../../domain/wager-transaction';
import type { FailureCode } from '../../domain/failure-code';
import type { LedgerDirection, WalletLedgerEntry } from '../../domain/wallet-ledger-entry';
import { OutboxMessage } from '../../domain/messaging/outbox-message';
import { InboxMessage } from '../../domain/messaging/inbox-message';
import type { WalletRecord } from './records/wallet.record';
import type { WagerTransactionRecord } from './records/wager-transaction.record';
import type { LedgerEntryRecord } from './records/ledger-entry.record';
import type { InboxMessageRecord, OutboxMessageRecord } from './records/messaging.record';

const orUndefined = <T>(value: T | null | undefined): T | undefined => value ?? undefined;

export function walletFromRecord(r: WalletRecord): Wallet {
  return Wallet.rehydrate({
    id: r.id,
    playerId: r.playerId,
    currency: r.currency,
    balance: Money.fromMinor(r.balanceMinor, r.currency),
    version: r.version,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  });
}

export function walletToRecordData(w: Wallet) {
  return {
    id: w.id,
    playerId: w.playerId,
    currency: w.currency,
    balanceMinor: w.balance.toMinorUnits(),
    version: w.version,
    createdAt: w.createdAt,
    updatedAt: w.updatedAt,
  };
}

export function transactionFromRecord(r: WagerTransactionRecord): WagerTransaction {
  return WagerTransaction.rehydrate({
    id: r.id,
    providerId: r.providerId,
    externalTransactionId: r.externalTransactionId,
    idempotencyKey: r.idempotencyKey,
    payloadHash: r.payloadHash,
    walletId: r.walletId,
    playerId: r.playerId,
    roundId: orUndefined(r.roundId),
    gameId: orUndefined(r.gameId),
    kind: r.kind as WagerTransactionKind,
    money: Money.fromMinor(r.amountMinor, r.currency),
    referenceExternalTransactionId: orUndefined(r.referenceExternalTransactionId),
    createdAt: r.createdAt,
    status: r.status as WagerTransactionStatus,
    referenceTransactionId: orUndefined(r.referenceTransactionId),
    failureCode: orUndefined(r.failureCode) as FailureCode | undefined,
    processedAt: orUndefined(r.processedAt),
    resultingBalance: r.resultBalanceMinor == null ? undefined : Money.fromMinor(r.resultBalanceMinor, r.currency),
    referenceAttempts: r.referenceAttempts,
    nextReferenceAttemptAt: orUndefined(r.nextReferenceAttemptAt),
    updatedAt: r.updatedAt,
  });
}

export function transactionToRecordData(t: WagerTransaction) {
  return {
    id: t.id,
    providerId: t.providerId,
    externalTransactionId: t.externalTransactionId,
    idempotencyKey: t.idempotencyKey,
    payloadHash: t.payloadHash,
    walletId: t.walletId,
    playerId: t.playerId,
    roundId: t.roundId ?? null,
    gameId: t.gameId ?? null,
    kind: t.kind,
    amountMinor: t.money.toMinorUnits(),
    currency: t.money.currency,
    referenceExternalTransactionId: t.referenceExternalTransactionId ?? null,
    referenceTransactionId: t.referenceTransactionId ?? null,
    status: t.status,
    failureCode: t.failureCode ?? null,
    resultBalanceMinor: t.resultingBalance?.toMinorUnits() ?? null,
    referenceAttempts: t.referenceAttempts,
    nextReferenceAttemptAt: t.nextReferenceAttemptAt ?? null,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    processedAt: t.processedAt ?? null,
  };
}

/** Só as colunas que podem mudar depois do INSERT (o banco recusa mudança nas outras). */
export function transactionStateData(t: WagerTransaction) {
  const { status, failureCode, resultBalanceMinor, referenceTransactionId, referenceAttempts, nextReferenceAttemptAt, updatedAt, processedAt } =
    transactionToRecordData(t);
  return { status, failureCode, resultBalanceMinor, referenceTransactionId, referenceAttempts, nextReferenceAttemptAt, updatedAt, processedAt };
}

export function ledgerEntryToRecordData(e: WalletLedgerEntry) {
  return {
    id: e.id,
    walletId: e.walletId,
    transactionId: e.transactionId,
    direction: e.direction as LedgerDirection,
    amountMinor: e.money.toMinorUnits(),
    currency: e.money.currency,
    balanceBeforeMinor: e.balanceBefore.toMinorUnits(),
    balanceAfterMinor: e.balanceAfter.toMinorUnits(),
    createdAt: e.createdAt,
  };
}

export function outboxToRecordData(m: OutboxMessage) {
  return {
    id: m.id,
    aggregateId: m.aggregateId,
    eventType: m.eventType,
    payload: { ...m.payload },
    occurredAt: m.occurredAt,
    attempts: m.attempts,
    nextAttemptAt: m.nextAttemptAt ?? m.occurredAt,
    publishedAt: m.publishedAt ?? null,
    lastError: null,
  };
}

export function outboxFromRecord(r: OutboxMessageRecord): OutboxMessage {
  return OutboxMessage.rehydrate({
    id: r.id,
    aggregateId: r.aggregateId,
    eventType: r.eventType,
    payload: r.payload,
    occurredAt: r.occurredAt,
    attempts: r.attempts,
    nextAttemptAt: r.nextAttemptAt,
    publishedAt: orUndefined(r.publishedAt),
  });
}

export function inboxFromRecord(r: InboxMessageRecord): InboxMessage {
  return InboxMessage.rehydrate({
    messageId: r.messageId,
    consumerName: r.consumerName,
    payloadHash: r.payloadHash,
    receivedAt: r.receivedAt,
    processedAt: orUndefined(r.processedAt),
  });
}

export function inboxToRecordData(m: InboxMessage, transactionId?: string) {
  return {
    consumerName: m.consumerName,
    messageId: m.messageId,
    payloadHash: m.payloadHash,
    transactionId: transactionId ?? null,
    receivedAt: m.receivedAt,
    processedAt: m.processedAt ?? null,
  };
}

export type { WalletRecord, WagerTransactionRecord, LedgerEntryRecord, OutboxMessageRecord, InboxMessageRecord };
