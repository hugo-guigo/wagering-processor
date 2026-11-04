import type { WagerOutcome } from '../../application/process-wager-transaction';
import type { WagerPayload } from '../../application/payload-hash';
import { log } from './logger';
import { metrics } from './metrics';

/**
 * Métricas e log de uma transação recebida (HTTP ou fila). O log leva só identificadores e o
 * resultado: nada de valor nem saldo.
 */
export function recordOutcome(
  outcome: WagerOutcome,
  payload: WagerPayload,
  source: 'http' | 'sqs',
  ids: { correlationId: string; messageId?: string },
  timer: (labels?: { outcome: string }) => number,
): void {
  const status = outcome.type === 'walletNotFound' ? 'REJECTED' : outcome.transaction.status;
  const replay = outcome.type === 'transaction' && outcome.replay;
  const seconds = timer({ outcome: replay ? 'replay' : status });
  if (replay) metrics.duplicates.inc({ type: 'idempotent_replay' });
  else metrics.transactions.inc({ status, kind: payload.kind, source });
  log.info(
    {
      event: 'wager.result',
      source,
      ...ids,
      transactionId: outcome.type === 'transaction' ? outcome.transaction.id : undefined,
      walletId: payload.walletId,
      providerId: payload.providerId,
      externalTransactionId: payload.externalTransactionId,
      kind: payload.kind,
      status,
      failureCode: outcome.type === 'transaction' ? outcome.transaction.failureCode : 'WALLET_NOT_FOUND',
      idempotentReplay: replay,
      durationMs: Math.round(seconds * 1000),
    },
    'wager transaction handled',
  );
}
