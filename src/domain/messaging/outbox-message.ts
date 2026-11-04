import type { IntegrationEvent } from '../events/integration-event';

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt?: Date;
  publishedAt?: Date;
}

/** Backoff exponencial da publicação: 1 s, 2 s, 4 s... até 5 min entre tentativas. Não desiste. */
export const OUTBOX_BACKOFF = { baseMs: 1_000, maxMs: 300_000 } as const;

/** Evento de integração esperando publicação. Gravado na mesma transação SQL da operação. */
export class OutboxMessage {
  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    public readonly payload: Readonly<Record<string, unknown>>,
    public readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt?: Date,
    private _publishedAt?: Date,
  ) {}

  /** O id da mensagem é o eventId: o consumidor deduplica por ele. */
  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    const payload = event.toJSON() as unknown as Record<string, unknown>;
    return new OutboxMessage(event.eventId, event.aggregateId, event.eventType, payload, event.occurredAt, 0, event.occurredAt);
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      state.id, state.aggregateId, state.eventType, state.payload, state.occurredAt,
      state.attempts, state.nextAttemptAt, state.publishedAt,
    );
  }

  get attempts(): number { return this._attempts; }
  get nextAttemptAt(): Date | undefined { return this._nextAttemptAt; }
  get publishedAt(): Date | undefined { return this._publishedAt; }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    return this.isPending() && (this._nextAttemptAt === undefined || this._nextAttemptAt <= now);
  }

  markPublished(at: Date): void {
    if (!this.isPending()) return; // publicar de novo é seguro; a primeira data fica
    this._publishedAt = at;
    this._nextAttemptAt = undefined;
  }

  /** Incrementa as tentativas e agenda a próxima com backoff exponencial. */
  scheduleRetry(now: Date): void {
    this._attempts += 1;
    const delay = Math.min(OUTBOX_BACKOFF.baseMs * 2 ** (this._attempts - 1), OUTBOX_BACKOFF.maxMs);
    this._nextAttemptAt = new Date(now.getTime() + delay);
  }
}
