import { Injectable, Logger, type BeforeApplicationShutdown, type OnApplicationBootstrap } from '@nestjs/common';
import { RelayOutbox } from '../../application/relay-outbox';
import { ResolvePendingReferences } from '../../application/resolve-pending-references';
import { SqsWagerConsumer } from '../messaging/sqs-wager-consumer';
import { BackgroundLoop } from './background-loop';
import { log } from '../observability/logger';
import { metrics } from '../observability/metrics';

/** Quais trabalhos de fundo esta instância roda. Padrão: todos. WORKERS="" desliga (testes). */
export function enabledWorkers(env: Record<string, string | undefined> = process.env): Set<string> {
  const value = env.WORKERS ?? 'consumer,publisher,references';
  return new Set(value.split(',').map((s) => s.trim()).filter(Boolean));
}

@Injectable()
export class WorkersService implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(WorkersService.name);
  private readonly loops: BackgroundLoop[] = [];

  constructor(
    private readonly consumer: SqsWagerConsumer,
    private readonly relay: RelayOutbox,
    private readonly references: ResolvePendingReferences,
  ) {}

  onApplicationBootstrap(): void {
    const enabled = enabledWorkers();
    if (enabled.has('publisher')) {
      this.loops.push(new BackgroundLoop('outbox-relay', async () => {
        const { published, failed } = await this.relay.runOnce();
        if (failed > 0) metrics.retries.inc({ component: 'outbox' }, failed);
        return published;
      }, 200));
    }
    if (enabled.has('references')) {
      this.loops.push(new BackgroundLoop('pending-references', async () => {
        const result = await this.references.runOnce();
        if (result.rescheduled > 0) metrics.retries.inc({ component: 'reference' }, result.rescheduled);
        for (const { transactionId, error } of result.errors) {
          log.error({ event: 'reference.attempt_failed', transactionId, error }, 'pending reference attempt failed');
        }
        for (const { status, kind } of result.outcomes) {
          if (status !== 'PENDING_REFERENCE') metrics.transactions.inc({ status, kind, source: 'worker' });
        }
        return result.handled - result.rescheduled;
      }, 500));
    }
    for (const loop of this.loops) loop.start();
    if (enabled.has('consumer')) this.consumer.start();
    this.logger.log(`workers: ${[...enabled].join(', ') || 'none'}`);
  }

  /** Primeiro para a entrada (fila), depois os laços internos, e só então o Nest fecha o banco. */
  async beforeApplicationShutdown(signal?: string): Promise<void> {
    this.logger.log(`shutting down workers (${signal ?? 'close'})`);
    await this.consumer.stop();
    await Promise.all(this.loops.map((loop) => loop.stop()));
  }
}
