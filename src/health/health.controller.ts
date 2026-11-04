import { Controller, Get, Res } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { GetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import { QUEUES, SqsQueues } from '../infra/messaging/sqs';
import { metrics, registry } from '../infra/observability/metrics';

interface RawResponse {
  status(code: number): unknown;
  setHeader(name: string, value: string): void;
}

const CHECK_TIMEOUT_MS = 2_000;

function withTimeout<T>(promise: Promise<T>): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timeout')), CHECK_TIMEOUT_MS)),
  ]);
}

/** Health e métricas: sem autenticação (seção 2). */
@Controller()
export class HealthController {
  constructor(
    private readonly orm: MikroORM,
    private readonly queues: SqsQueues,
  ) {}

  /** Processo vivo. Não toca em dependência: se o banco cair, a instância não deve ser reiniciada por isso. */
  @Get('health/live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /** Pronto para receber tráfego: PostgreSQL e SQS respondem. */
  @Get('health/ready')
  async ready(@Res({ passthrough: true }) response: RawResponse) {
    const [postgres, sqs] = await Promise.all([
      this.check(() => this.orm.em.fork().execute('select 1')),
      this.check(async () => this.queues.client.send(new GetQueueAttributesCommand({
        QueueUrl: await this.queues.url(QUEUES.wagers), AttributeNames: ['QueueArn'],
      }))),
    ]);
    const ok = postgres === 'up' && sqs === 'up';
    response.status(ok ? 200 : 503);
    return { status: ok ? 'ok' : 'unavailable', checks: { postgres, sqs } };
  }

  /** Formato Prometheus. Os gauges que dependem do banco e do SQS são lidos na hora do scrape. */
  @Get('metrics')
  async metrics(@Res({ passthrough: true }) response: RawResponse): Promise<string> {
    await Promise.allSettled([this.refreshOutboxGauges(), this.refreshDeadLetterDepth()]);
    response.setHeader('Content-Type', registry.contentType);
    return registry.metrics();
  }

  private async check(probe: () => Promise<unknown>): Promise<'up' | 'down'> {
    try {
      await withTimeout(probe());
      return 'up';
    } catch {
      return 'down';
    }
  }

  private async refreshOutboxGauges(): Promise<void> {
    const [row] = await this.orm.em.fork().execute<{ pending: string; lag: string | null }[]>(
      `select count(*)::text as pending,
              extract(epoch from now() - min(occurred_at))::text as lag
         from outbox_messages where published_at is null`,
    );
    metrics.outboxPending.set(Number(row?.pending ?? 0));
    metrics.outboxLag.set(row?.lag ? Number(row.lag) : 0);
  }

  private async refreshDeadLetterDepth(): Promise<void> {
    const { Attributes } = await this.queues.client.send(new GetQueueAttributesCommand({
      QueueUrl: await this.queues.url(QUEUES.wagersDeadLetter), AttributeNames: ['ApproximateNumberOfMessages'],
    }));
    metrics.deadLetterDepth.set(Number(Attributes?.ApproximateNumberOfMessages ?? 0));
  }
}
