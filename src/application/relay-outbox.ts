import type { Clock, EventPublisher, TransactionRunner } from './ports';

export interface RelayResult {
  published: number;
  failed: number;
}

/**
 * Publica os eventos da outbox. Cada lote é travado com FOR UPDATE SKIP LOCKED, publicado e marcado
 * como publicado na mesma transação SQL. Vários relays (em várias instâncias) pegam lotes
 * diferentes.
 *
 * Garantia: at-least-once. Se o processo morrer depois de publicar e antes do COMMIT, o lote volta
 * a ficar disponível e é publicado de novo. O consumidor deduplica pelo eventId (que também é o
 * MessageDeduplicationId da fila FIFO).
 */
export class RelayOutbox {
  constructor(
    private readonly runner: TransactionRunner,
    private readonly publisher: EventPublisher,
    private readonly clock: Clock,
  ) {}

  async runOnce(batchSize = 10): Promise<RelayResult> {
    return this.runner.run(async (store) => {
      const now = this.clock.now();
      const batch = await store.claimDueOutbox(now, batchSize);
      if (batch.length === 0) return { published: 0, failed: 0 };

      const failures = await this.publisher.publish(batch);
      for (const message of batch) {
        const error = failures.get(message.id);
        if (error === undefined) {
          message.markPublished(this.clock.now());
        } else {
          message.scheduleRetry(this.clock.now());
        }
        store.saveOutbox(message, error);
      }
      return { published: batch.length - failures.size, failed: failures.size };
    });
  }
}
