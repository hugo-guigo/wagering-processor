import { InsufficientFundsError } from '../domain/errors';
import { FailureCode } from '../domain/failure-code';
import { Money } from '../domain/money';
import type { Wallet } from '../domain/wallet';
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from '../domain/wager-transaction';
import { LedgerDirection, type WalletLedgerEntry } from '../domain/wallet-ledger-entry';
import type { EventContext } from '../domain/events/integration-event';
import {
  WagerTransactionPendingReference, WagerTransactionProcessed, WagerTransactionRejected, WalletBalanceChanged,
} from '../domain/events/wagering-events';
import { OutboxMessage } from '../domain/messaging/outbox-message';
import { InboxMessage } from '../domain/messaging/inbox-message';
import { IdempotencyConflictError, InvalidRequestError, UniqueViolationError } from './errors';
import { payloadHash, type WagerPayload } from './payload-hash';
import { nextReferenceAttemptAt } from './reference-retry-policy';
import type { OperationContext } from './open-wallet';
import type { Clock, IdGenerator, TransactionRunner, WalletStore } from './ports';

const SUBMITTABLE = new Set<string>([
  WagerTransactionKind.Bet, WagerTransactionKind.Win, WagerTransactionKind.Loss,
  WagerTransactionKind.Refund, WagerTransactionKind.Rollback,
]);

export interface SubmitWagerCommand {
  idempotencyKey: string;
  payload: WagerPayload;
  /** Presente quando a entrada é a fila: o registro do inbox entra na mesma transação SQL. */
  inbox?: { consumerName: string; messageId: string; payloadHash: string };
}

interface Draft {
  hash: string;
  tx: WagerTransaction;
}

export type WagerOutcome =
  | { type: 'transaction'; transaction: WagerTransaction; replay: boolean }
  | { type: 'walletNotFound' };

/**
 * O caso de uso único de entrada de transações: HTTP e fila chamam este mesmo `execute`.
 *
 * Concorrência: a linha da wallet é travada (FOR UPDATE) antes de qualquer leitura que decida o
 * resultado. Duas operações da mesma wallet nunca se intercalam; wallets diferentes não se esperam.
 * Idempotência: a idempotency key é única no banco. A checagem é refeita depois do lock, e se duas
 * requisições com a mesma key ainda assim disputarem o INSERT, a perdedora relê e vira replay.
 */
export class ProcessWagerTransaction {
  constructor(
    private readonly runner: TransactionRunner,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  async execute(command: SubmitWagerCommand, ctx: OperationContext): Promise<WagerOutcome> {
    const draft = this.validate(command);

    // Caminho rápido do replay: sem travar a wallet.
    const known = await this.runner.run((store) => store.findTransactionByIdempotencyKey(command.idempotencyKey));
    if (known) return this.replay(known, draft.hash);

    try {
      return await this.runner.run((store) => this.process(store, command, draft, ctx));
    } catch (error) {
      if (error instanceof UniqueViolationError) {
        // Outra instância gravou a mesma key ou o mesmo id externo entre a nossa checagem e o COMMIT.
        const winner = await this.runner.run(async (store) =>
          (await store.findTransactionByIdempotencyKey(command.idempotencyKey))
          ?? store.findTransactionByExternalId(command.payload.providerId, command.payload.externalTransactionId));
        if (winner) {
          if (winner.idempotencyKey !== command.idempotencyKey) throw this.externalIdConflict(winner);
          return this.replay(winner, draft.hash);
        }
      }
      throw error;
    }
  }

  /**
   * Monta a transação antes de tocar no banco: payload inválido é 400 mesmo que a wallet não exista.
   * A transação só é gravada se passar pelo lock e pela checagem de idempotência.
   */
  private validate(command: SubmitWagerCommand): Draft {
    const { payload } = command;
    if (!SUBMITTABLE.has(payload.kind)) {
      throw new InvalidRequestError(`kind must be one of ${[...SUBMITTABLE].join(', ')}`, 'kind');
    }
    const hash = payloadHash(payload);
    const tx = WagerTransaction.create({
      id: this.ids.next(),
      providerId: payload.providerId,
      externalTransactionId: payload.externalTransactionId,
      idempotencyKey: command.idempotencyKey,
      payloadHash: hash,
      walletId: payload.walletId,
      playerId: payload.playerId,
      roundId: payload.roundId,
      gameId: payload.gameId,
      kind: payload.kind as WagerTransactionKind,
      money: Money.from(payload.money),
      referenceExternalTransactionId: payload.referenceExternalTransactionId,
      createdAt: this.clock.now(),
    });
    return { hash, tx };
  }

  private replay(existing: WagerTransaction, hash: string): WagerOutcome {
    if (!existing.matchesPayload(hash)) {
      throw new IdempotencyConflictError('idempotency key already used with a different payload', existing.id);
    }
    return { type: 'transaction', transaction: existing, replay: true };
  }

  private externalIdConflict(existing: WagerTransaction): IdempotencyConflictError {
    return new IdempotencyConflictError('externalTransactionId already used with a different idempotency key', existing.id);
  }

  private async process(
    store: WalletStore,
    command: SubmitWagerCommand,
    draft: Draft,
    ctx: OperationContext,
  ): Promise<WagerOutcome> {
    const { payload } = command;
    const wallet = await store.lockWallet(payload.walletId);
    if (!wallet) return { type: 'walletNotFound' };

    // Refeito sob o lock: quem esperava a mesma wallet enxerga o que a anterior gravou.
    const again = await store.findTransactionByIdempotencyKey(command.idempotencyKey);
    if (again) return this.replay(again, draft.hash);
    const sameExternal = await store.findTransactionByExternalId(payload.providerId, payload.externalTransactionId);
    if (sameExternal) throw this.externalIdConflict(sameExternal);

    const now = this.clock.now();
    const { tx } = draft;

    const entry = await this.decide(store, tx, wallet, now);
    store.addTransaction(tx);
    if (entry) {
      store.addLedgerEntry(entry);
      store.saveWallet(wallet);
    }
    this.enqueueEvents(store, tx, wallet, entry, { correlationId: ctx.correlationId, causationId: ctx.causationId, occurredAt: now });
    if (command.inbox) {
      const inbox = InboxMessage.receive({ ...command.inbox, receivedAt: now });
      inbox.markProcessed(now);
      store.addInboxMessage(inbox, tx.id);
    }
    return { type: 'transaction', transaction: tx, replay: false };
  }

  /**
   * Aplica as regras e leva a transação a PROCESSED, REJECTED ou PENDING_REFERENCE.
   * Devolve o lançamento quando o saldo muda.
   */
  private async decide(store: WalletStore, tx: WagerTransaction, wallet: Wallet, now: Date): Promise<WalletLedgerEntry | undefined> {
    const reject = (code: FailureCode) => {
      tx.reject(code, { at: now, currentBalance: wallet.balance });
      return undefined;
    };

    if (tx.playerId !== wallet.playerId) return reject(FailureCode.WalletPlayerMismatch);
    if (tx.money.currency !== wallet.currency) return reject(FailureCode.CurrencyMismatch);

    let reference: WagerTransaction | undefined;
    if (tx.hasReference()) {
      reference = await store.findTransactionByExternalId(tx.providerId, tx.referenceExternalTransactionId!);
      const check = reference ? tx.checkReference(reference) : ({ outcome: 'wait' } as const);
      if (check.outcome === 'wait') {
        tx.markPendingReference({ nextAttemptAt: nextReferenceAttemptAt(now, 0), at: now, currentBalance: wallet.balance });
        return undefined;
      }
      if (check.outcome === 'reject') return reject(check.code);
      if (tx.isReversal() && await store.hasProcessedReversal(reference!.id)) {
        return reject(FailureCode.ReferenceAlreadyReversed);
      }
    }

    return this.apply(tx, wallet, reference, now, reject);
  }

  /** Movimenta a wallet. Usado também pelo worker de referências pendentes. */
  apply(
    tx: WagerTransaction,
    wallet: Wallet,
    reference: WagerTransaction | undefined,
    now: Date,
    reject: (code: FailureCode) => undefined,
  ): WalletLedgerEntry | undefined {
    if (!tx.affectsBalance()) {
      tx.markProcessed({ referenceTransactionId: reference?.id, at: now, resultingBalance: wallet.balance });
      return undefined;
    }
    const movement = { transactionId: tx.id, entryId: this.ids.next(), at: now };
    try {
      const entry = tx.ledgerDirectionFor(reference) === LedgerDirection.Debit
        ? wallet.debit(tx.money, movement)
        : wallet.credit(tx.money, movement);
      tx.markProcessed({ referenceTransactionId: reference?.id, at: now, resultingBalance: wallet.balance });
      return entry;
    } catch (error) {
      if (error instanceof InsufficientFundsError) {
        return reject(tx.isReversal() ? FailureCode.ReversalInsufficientFunds : FailureCode.InsufficientFunds);
      }
      throw error;
    }
  }

  enqueueEvents(
    store: WalletStore,
    tx: WagerTransaction,
    wallet: Wallet,
    entry: WalletLedgerEntry | undefined,
    base: Omit<EventContext, 'eventId'>,
  ): void {
    const ctx = (): EventContext => ({ ...base, eventId: this.ids.next() });
    switch (tx.status) {
      case WagerTransactionStatus.Processed:
        store.enqueue(OutboxMessage.enqueue(WagerTransactionProcessed.from(tx, ctx())));
        if (entry) store.enqueue(OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, entry, ctx())));
        break;
      case WagerTransactionStatus.Rejected:
        store.enqueue(OutboxMessage.enqueue(WagerTransactionRejected.from(tx, ctx())));
        break;
      case WagerTransactionStatus.PendingReference:
        store.enqueue(OutboxMessage.enqueue(WagerTransactionPendingReference.from(tx, ctx())));
        break;
    }
  }
}
