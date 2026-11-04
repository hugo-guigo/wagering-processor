import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

/** Registro único das métricas do processo, exposto em GET /metrics. */
export const registry = new Registry();
collectDefaultMetrics({ register: registry, prefix: 'wagering_process_' });

export const metrics = {
  /** Transações por estado final, tipo e entrada (http, sqs, worker). */
  transactions: new Counter({
    name: 'wagering_transactions_total',
    help: 'Wager transactions by resulting status',
    labelNames: ['status', 'kind', 'source'] as const,
    registers: [registry],
  }),
  /** Duplicatas detectadas: replay pela idempotency key ou mensagem repetida pelo inbox. */
  duplicates: new Counter({
    name: 'wagering_duplicates_detected_total',
    help: 'Duplicate requests or messages detected',
    labelNames: ['type'] as const,
    registers: [registry],
  }),
  /** Novas tentativas: consumidor (erro transitório), outbox (publicação) e referência pendente. */
  retries: new Counter({
    name: 'wagering_retries_total',
    help: 'Retries scheduled',
    labelNames: ['component'] as const,
    registers: [registry],
  }),
  /** Mensagens que o consumidor mandou para a DLQ (as da redrive policy aparecem no gauge abaixo). */
  deadLettered: new Counter({
    name: 'wagering_dlq_messages_total',
    help: 'Messages sent to the DLQ by the consumer',
    labelNames: ['reason'] as const,
    registers: [registry],
  }),
  /** Mensagens na DLQ agora (inclui as que a redrive policy moveu). Lido do SQS a cada scrape. */
  deadLetterDepth: new Gauge({
    name: 'wagering_dlq_depth',
    help: 'Approximate number of messages in the DLQ',
    registers: [registry],
  }),
  /** Conflitos de lock: lock_timeout ou deadlock (a operação virou falha transitória). */
  lockConflicts: new Counter({
    name: 'wagering_lock_conflicts_total',
    help: 'Lock timeouts and deadlocks',
    labelNames: ['type'] as const,
    registers: [registry],
  }),
  /** Quanto se esperou pela trava da wallet. Fila alta aqui é wallet quente. */
  lockWait: new Histogram({
    name: 'wagering_wallet_lock_wait_seconds',
    help: 'Time waiting for the wallet row lock',
    buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5],
    registers: [registry],
  }),
  /** Idade do evento mais antigo ainda não publicado. Lido do banco a cada scrape. */
  outboxLag: new Gauge({
    name: 'wagering_outbox_lag_seconds',
    help: 'Age of the oldest unpublished outbox message',
    registers: [registry],
  }),
  outboxPending: new Gauge({
    name: 'wagering_outbox_pending',
    help: 'Unpublished outbox messages',
    registers: [registry],
  }),
  /** Latência de processamento de uma transação, por entrada e resultado. */
  processing: new Histogram({
    name: 'wagering_processing_duration_seconds',
    help: 'Time to process a wager transaction',
    labelNames: ['source', 'outcome'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [registry],
  }),
  /** Divergências entre saldo e ledger encontradas pela reconciliação (nunca corrigidas sozinhas). */
  reconciliationDivergences: new Counter({
    name: 'wagering_reconciliation_divergences_total',
    help: 'Wallets whose stored balance differs from the ledger',
    registers: [registry],
  }),
};
