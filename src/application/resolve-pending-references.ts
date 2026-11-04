import type { Clock, TransactionRunner } from './ports';
import type { WagerSettlement } from './wager-settlement';

export interface ResolveResult {
  handled: number;
  processed: number;
  rejected: number;
  rescheduled: number;
  /** Estado e tipo de cada transação tratada, para as métricas. */
  outcomes: { status: string; kind: string }[];
}

/**
 * Worker agendado das transações que chegaram antes da referência. Cada transação pendente é
 * tratada na sua própria transação SQL: trava a linha dela (SKIP LOCKED), trava a wallet e aplica
 * as mesmas regras da chegada. Se a referência ainda não existe, agenda a próxima tentativa com
 * backoff; esgotado o limite, rejeita com REFERENCE_NOT_FOUND e publica o evento.
 */
export class ResolvePendingReferences {
  constructor(
    private readonly runner: TransactionRunner,
    private readonly clock: Clock,
    private readonly settlement: WagerSettlement,
  ) {}

  async runOnce(limit = 50): Promise<ResolveResult> {
    const result: ResolveResult = { handled: 0, processed: 0, rejected: 0, rescheduled: 0, outcomes: [] };
    while (result.handled < limit) {
      const handled = await this.runner.run(async (store) => {
        const now = this.clock.now();
        const tx = await store.claimDuePendingReference(now);
        if (!tx) return undefined;
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
      if (handled === undefined) break;
      const { status } = handled;
      result.outcomes.push(handled);
      result.handled += 1;
      if (status === 'PROCESSED') result.processed += 1;
      else if (status === 'REJECTED') result.rejected += 1;
      else result.rescheduled += 1;
    }
    return result;
  }
}
