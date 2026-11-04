import { Injectable } from '@nestjs/common';
import {
  ConnectionException, DeadlockException, LockMode, LockWaitTimeoutException, MikroORM,
  UniqueConstraintViolationException, type EntityManager,
} from '@mikro-orm/postgresql';
import { TransactionRunner, WalletStore } from '../../application/ports';
import { TransientInfrastructureError, UniqueViolationError } from '../../application/errors';
import type { Wallet } from '../../domain/wallet';
import type { WagerTransaction } from '../../domain/wager-transaction';
import type { WalletLedgerEntry } from '../../domain/wallet-ledger-entry';
import type { OutboxMessage } from '../../domain/messaging/outbox-message';
import type { InboxMessage } from '../../domain/messaging/inbox-message';
import { WalletRecord } from './records/wallet.record';
import { WagerTransactionRecord } from './records/wager-transaction.record';
import { LedgerEntryRecord } from './records/ledger-entry.record';
import { InboxMessageRecord, OutboxMessageRecord } from './records/messaging.record';
import {
  inboxFromRecord, inboxToRecordData, ledgerEntryToRecordData, outboxFromRecord, outboxToRecordData, transactionFromRecord,
  transactionStateData, transactionToRecordData, walletFromRecord, walletToRecordData,
} from './mappers';

/** Quanto uma operação espera pela trava de uma wallet ocupada antes de desistir (vira 503). */
function lockTimeout(): string {
  const value = process.env.LOCK_TIMEOUT ?? '5s';
  if (!/^\d+(ms|s)$/.test(value)) throw new Error(`invalid LOCK_TIMEOUT ${value}`);
  return value;
}

/**
 * `WalletStore` sobre o EntityManager de UMA transação. As escritas só registram no Unit of Work;
 * o MikroORM grava tudo no flush que o `transactional` faz antes do COMMIT.
 */
class MikroOrmWalletStore extends WalletStore {
  /** Registros carregados com lock, para atualizar a mesma instância que o Unit of Work rastreia. */
  private readonly lockedWallets = new Map<string, WalletRecord>();
  private readonly loadedTransactions = new Map<string, WagerTransactionRecord>();
  private readonly loadedOutbox = new Map<string, OutboxMessageRecord>();

  constructor(private readonly em: EntityManager) {
    super();
  }

  async lockWallet(walletId: string): Promise<Wallet | undefined> {
    const record = await this.em.findOne(WalletRecord, { id: walletId }, { lockMode: LockMode.PESSIMISTIC_WRITE });
    if (!record) return undefined;
    this.lockedWallets.set(walletId, record);
    return walletFromRecord(record);
  }

  addWallet(wallet: Wallet): void {
    this.em.create(WalletRecord, walletToRecordData(wallet));
  }

  saveWallet(wallet: Wallet): void {
    const record = this.lockedWallets.get(wallet.id);
    if (!record) throw new Error(`wallet ${wallet.id} must be locked before it is saved`);
    const { balanceMinor, version, updatedAt } = walletToRecordData(wallet);
    this.em.assign(record, { balanceMinor, version, updatedAt });
    this.em.persist(record);
  }

  async findTransactionById(id: string): Promise<WagerTransaction | undefined> {
    return this.toDomain(await this.em.findOne(WagerTransactionRecord, { id }));
  }

  async findTransactionByIdempotencyKey(key: string): Promise<WagerTransaction | undefined> {
    return this.toDomain(await this.em.findOne(WagerTransactionRecord, { idempotencyKey: key }));
  }

  async findTransactionByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined> {
    return this.toDomain(await this.em.findOne(WagerTransactionRecord, { providerId, externalTransactionId }));
  }

  async hasProcessedReversal(referenceTransactionId: string): Promise<boolean> {
    const count = await this.em.count(WagerTransactionRecord, {
      referenceTransactionId, kind: { $in: ['REFUND', 'ROLLBACK'] }, status: 'PROCESSED',
    });
    return count > 0;
  }

  addTransaction(tx: WagerTransaction): void {
    this.em.create(WagerTransactionRecord, transactionToRecordData(tx));
  }

  saveTransaction(tx: WagerTransaction): void {
    const record = this.loadedTransactions.get(tx.id);
    if (!record) throw new Error(`transaction ${tx.id} must be loaded before it is saved`);
    this.em.assign(record, transactionStateData(tx));
    this.em.persist(record);
  }

  addLedgerEntry(entry: WalletLedgerEntry): void {
    this.em.create(LedgerEntryRecord, ledgerEntryToRecordData(entry));
  }

  enqueue(message: OutboxMessage): void {
    this.em.create(OutboxMessageRecord, outboxToRecordData(message));
  }

  addInboxMessage(message: InboxMessage, transactionId?: string): void {
    this.em.create(InboxMessageRecord, inboxToRecordData(message, transactionId));
  }

  async findInboxMessage(consumerName: string, messageId: string): Promise<InboxMessage | undefined> {
    const record = await this.em.findOne(InboxMessageRecord, { consumerName, messageId });
    return record ? inboxFromRecord(record) : undefined;
  }

  async claimDuePendingReference(now: Date): Promise<WagerTransaction | undefined> {
    const record = await this.em.findOne(
      WagerTransactionRecord,
      { status: 'PENDING_REFERENCE', nextReferenceAttemptAt: { $lte: now } },
      { orderBy: { nextReferenceAttemptAt: 'asc' }, lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE },
    );
    return this.toDomain(record);
  }

  async claimDueOutbox(now: Date, limit: number): Promise<OutboxMessage[]> {
    const records = await this.em.find(
      OutboxMessageRecord,
      { publishedAt: null, nextAttemptAt: { $lte: now } },
      { orderBy: { nextAttemptAt: 'asc', occurredAt: 'asc' }, limit, lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE },
    );
    for (const record of records) this.loadedOutbox.set(record.id, record);
    return records.map(outboxFromRecord);
  }

  saveOutbox(message: OutboxMessage, lastError?: string): void {
    const record = this.loadedOutbox.get(message.id);
    if (!record) throw new Error(`outbox message ${message.id} must be claimed before it is saved`);
    this.em.assign(record, {
      attempts: message.attempts,
      nextAttemptAt: message.nextAttemptAt ?? record.nextAttemptAt,
      publishedAt: message.publishedAt ?? null,
      lastError: lastError?.slice(0, 500) ?? null,
    });
    this.em.persist(record);
  }

  private toDomain(record: WagerTransactionRecord | null): WagerTransaction | undefined {
    if (!record) return undefined;
    this.loadedTransactions.set(record.id, record);
    return transactionFromRecord(record);
  }
}

@Injectable()
export class MikroOrmTransactionRunner extends TransactionRunner {
  constructor(private readonly orm: MikroORM) {
    super();
  }

  /** Cada execução usa um EntityManager novo (identity map limpo) e uma transação SQL própria. */
  async run<T>(work: (store: WalletStore) => Promise<T>): Promise<T> {
    try {
      return await this.orm.em.fork().transactional(async (em) => {
        await em.execute(`set local lock_timeout = '${lockTimeout()}'`);
        return work(new MikroOrmWalletStore(em));
      });
    } catch (error) {
      throw translate(error);
    }
  }
}

/** Traduz exceções do ORM para os erros que a aplicação entende. O resto passa como está. */
function translate(error: unknown): unknown {
  if (error instanceof UniqueConstraintViolationException) {
    const constraint = /unique constraint "([^"]+)"/.exec(error.message)?.[1];
    return new UniqueViolationError(constraint, error);
  }
  if (error instanceof LockWaitTimeoutException || error instanceof DeadlockException || error instanceof ConnectionException) {
    return new TransientInfrastructureError(error.constructor.name, error);
  }
  if (isConnectionFailure(error)) {
    return new TransientInfrastructureError('database unavailable', error);
  }
  return error;
}

function isConnectionFailure(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === '57P01' || code === '08006';
}
