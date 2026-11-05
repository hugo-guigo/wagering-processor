import { WagerTransactionStatus } from '../domain/wager-transaction';
import type { Clock, TransactionRunner } from './ports';
import type { WagerSettlement } from './wager-settlement';

export interface ResolveResult {
  handled: number;
  processed: number;
  rejected: number;
  rescheduled: number;
  failed: number;
  /** Estado e tipo de cada transação tratada, para as métricas. */
  outcomes: { status: string; kind: string }[];
  /** Tentativas que terminaram em erro, para o log. */
  errors: { transactionId: string; error: string }[];
}

type Handled = { status: string; kind: string };

/**
 * Worker agendado das transações que chegaram antes da referência. Cada transação pendente é
 * tratada na sua própria transação SQL: trava a linha dela (SKIP LOCKED), trava a wallet e aplica
 * as mesmas regras da chegada. Se a referência ainda não existe, agenda a próxima tentativa com
 * backoff; esgotado o limite, rejeita com REFERENCE_NOT_FOUND e publica o evento.
 *
 * Se a tentativa der erro (bug, constraint, lock_timeout), a transação SQL é desfeita e a
 * pendência voltaria igual para a frente da fila, travando as outras. Por isso o erro é registrado
 * numa transação separada como tentativa gasta, com backoff; esgotado o limite, vira FAILED.
 */
export class ResolvePendingReferences {
  constructor(
    private readonly runner: TransactionRunner,
    private readonly clock: Clock,
    private readonly settlement: WagerSettlement,
  ) {}

  async runOnce(limit = 50): Promise<ResolveResult> {
    const result: ResolveResult = {
      handled: 0, processed: 0, rejected: 0, rescheduled: 0, failed: 0, outcomes: [], errors: [],
    };
    while (result.handled < limit) {
      const claim: { id?: string } = {};
      let handled: Handled | undefined;
      try {
        handled = await this.resolveNext(claim);
        if (handled === undefined) break; // nada vencido
      } catch (error) {
        // Sem pendência travada (banco fora, por exemplo): não há o que registrar; o laço tenta depois.
        if (claim.id === undefined) throw error;
        result.errors.push({ transactionId: claim.id, error: describe(error) });
        handled = await this.recordFailedAttempt(claim.id);
        if (handled === undefined) continue; // outro worker já resolveu essa pendência
      }
      result.outcomes.push(handled);
      result.handled += 1;
      if (handled.status === WagerTransactionStatus.Processed) result.processed += 1;
      else if (handled.status === WagerTransactionStatus.Rejected) result.rejected += 1;
      else if (handled.status === WagerTransactionStatus.Failed) result.failed += 1;
      else result.rescheduled += 1;
    }
    return result;
  }

  private resolveNext(claim: { id?: string }): Promise<Handled | undefined> {
    return this.runner.run(async (store) => {
      const now = this.clock.now();
      const tx = await store.claimDuePendingReference(now);
      if (!tx) return undefined;
      claim.id = tx.id;
      const wallet = await store.lockWallet(tx.walletId);
      if (!wallet) throw new Error(`wallet ${tx.walletId} of pending transaction ${tx.id} not found`);

      const previousStatus = tx.status;
      const entry = await this.settlement.decide(store, tx, wallet, now);
      store.saveTransaction(tx);
      if (entry) {
        store.addLedgerEntry(entry);
        store.saveWallet(wallet);
      }
      // A correlação original não é guardada; o worker usa o id da transação como causa.
      this.settlement.enqueueEvents(
        store, tx, wallet, entry, { correlationId: tx.id, causationId: tx.id, occurredAt: now }, previousStatus,
      );
      return { status: tx.status, kind: tx.kind };
    });
  }

  private recordFailedAttempt(transactionId: string): Promise<Handled | undefined> {
    return this.runner.run(async (store) => {
      const now = this.clock.now();
      const tx = await store.lockTransaction(transactionId);
      if (!tx || tx.status !== WagerTransactionStatus.PendingReference) return undefined;
      const wallet = await store.findWallet(tx.walletId);
      if (!wallet) throw new Error(`wallet ${tx.walletId} of pending transaction ${tx.id} not found`);

      const previousStatus = tx.status;
      this.settlement.recordFailedAttempt(tx, now);
      store.saveTransaction(tx);
      this.settlement.enqueueEvents(
        store, tx, wallet, undefined, { correlationId: tx.id, causationId: tx.id, occurredAt: now }, previousStatus,
      );
      return { status: tx.status, kind: tx.kind };
    });
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
