import { InsufficientFundsError } from '../domain/errors';
import { FailureCode } from '../domain/failure-code';
import type { Wallet } from '../domain/wallet';
import { WagerTransactionStatus, type WagerTransaction } from '../domain/wager-transaction';
import { LedgerDirection, type WalletLedgerEntry } from '../domain/wallet-ledger-entry';
import type { EventContext } from '../domain/events/integration-event';
import {
  WagerTransactionPendingReference, WagerTransactionProcessed, WagerTransactionRejected, WalletBalanceChanged,
} from '../domain/events/wagering-events';
import { OutboxMessage } from '../domain/messaging/outbox-message';
import type { ReferenceRetryPolicy } from './reference-retry-policy';
import type { IdGenerator, WalletStore } from './ports';

/**
 * As regras que decidem o destino de uma transação, com a wallet já travada. Usadas na chegada
 * (ProcessWagerTransaction) e pelo worker de referências pendentes (ResolvePendingReferences).
 */
export class WagerSettlement {
  constructor(
    private readonly ids: IdGenerator,
    private readonly retry: ReferenceRetryPolicy,
  ) {}

  /**
   * Leva a transação a PROCESSED, REJECTED ou PENDING_REFERENCE (ou agenda nova tentativa, se já
   * estava pendente). Devolve o lançamento quando o saldo muda; quem chama grava tudo.
   */
  async decide(store: WalletStore, tx: WagerTransaction, wallet: Wallet, now: Date): Promise<WalletLedgerEntry | undefined> {
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
        this.wait(tx, reference, wallet, now, reject);
        return undefined;
      }
      if (check.outcome === 'reject') return reject(check.code);
      if (tx.isReversal() && await store.hasProcessedReversal(reference!.id)) {
        return reject(FailureCode.ReferenceAlreadyReversed);
      }
    }

    return this.apply(tx, wallet, reference, now, reject);
  }

  /** Referência ausente (ou ainda pendente): primeira espera, nova tentativa ou desistência. */
  private wait(
    tx: WagerTransaction,
    reference: WagerTransaction | undefined,
    wallet: Wallet,
    now: Date,
    reject: (code: FailureCode) => undefined,
  ): void {
    if (tx.status === WagerTransactionStatus.Pending) {
      tx.markPendingReference({ nextAttemptAt: this.retry.nextAttemptAt(now, 0), at: now, currentBalance: wallet.balance });
      return;
    }
    const attempts = tx.referenceAttempts + 1;
    if (this.retry.exhausted(attempts)) {
      // Existe mas nunca terminou (outra transação também pendente) é diferente de não existir.
      reject(reference ? FailureCode.ReferenceNotProcessed : FailureCode.ReferenceNotFound);
      return;
    }
    tx.scheduleReferenceRetry({ nextAttemptAt: this.retry.nextAttemptAt(now, attempts), at: now });
  }

  private apply(
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

  /**
   * Eventos do novo estado, na mesma transação SQL. Uma nova tentativa de referência que continua
   * pendente não gera evento: o provedor já soube da pendência na primeira vez.
   */
  enqueueEvents(
    store: WalletStore,
    tx: WagerTransaction,
    wallet: Wallet,
    entry: WalletLedgerEntry | undefined,
    base: Omit<EventContext, 'eventId'>,
    previousStatus: WagerTransactionStatus,
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
        if (previousStatus !== WagerTransactionStatus.PendingReference) {
          store.enqueue(OutboxMessage.enqueue(WagerTransactionPendingReference.from(tx, ctx())));
        }
        break;
    }
  }
}
