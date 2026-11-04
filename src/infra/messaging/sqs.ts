import { Injectable } from '@nestjs/common';
import { GetQueueUrlCommand, SQSClient } from '@aws-sdk/client-sqs';

export const QUEUES = {
  wagers: 'wager-transactions.fifo',
  wagersDeadLetter: 'wager-transactions-dlq.fifo',
  events: 'wagering-events.fifo',
} as const;

export function createSqsClient(endpoint = process.env.SQS_ENDPOINT ?? 'http://localhost:4566'): SQSClient {
  return new SQSClient({
    endpoint,
    region: process.env.AWS_REGION ?? 'us-east-1',
    credentials: { accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test', secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test' },
    maxAttempts: 1, // o retry é nosso (outbox e consumidor), com backoff próprio
  });
}

/** Cliente SQS e resolução (com cache) da URL de cada fila. */
@Injectable()
export class SqsQueues {
  readonly client: SQSClient;
  private readonly urls = new Map<string, string>();

  constructor() {
    this.client = createSqsClient();
  }

  async url(name: string): Promise<string> {
    const cached = this.urls.get(name);
    if (cached) return cached;
    const { QueueUrl } = await this.client.send(new GetQueueUrlCommand({ QueueName: name }));
    if (!QueueUrl) throw new Error(`queue ${name} not found`);
    this.urls.set(name, QueueUrl);
    return QueueUrl;
  }
}
