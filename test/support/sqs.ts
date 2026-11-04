import {
  DeleteMessageCommand, GetQueueUrlCommand, PurgeQueueCommand, ReceiveMessageCommand, SendMessageCommand, type Message,
} from '@aws-sdk/client-sqs';
import { createSqsClient, QUEUES } from '../../src/infra/messaging/sqs';

export const sqs = createSqsClient();

export async function queueUrl(name: string): Promise<string> {
  return (await sqs.send(new GetQueueUrlCommand({ QueueName: name }))).QueueUrl!;
}

/** Esvazia as filas do desafio (o PurgeQueue do emulador é imediato). */
export async function purgeQueues(): Promise<void> {
  for (const name of Object.values(QUEUES)) {
    await sqs.send(new PurgeQueueCommand({ QueueUrl: await queueUrl(name) }));
  }
}

/** Lê e apaga tudo o que está visível na fila. */
export async function drain(name: string, rounds = 20): Promise<Message[]> {
  const url = await queueUrl(name);
  const all: Message[] = [];
  for (let i = 0; i < rounds; i++) {
    const { Messages = [] } = await sqs.send(new ReceiveMessageCommand({
      QueueUrl: url, MaxNumberOfMessages: 10, WaitTimeSeconds: 0,
      MessageSystemAttributeNames: ['MessageGroupId', 'ApproximateReceiveCount'], MessageAttributeNames: ['All'],
    }));
    if (Messages.length === 0) break;
    all.push(...Messages);
    for (const m of Messages) await sqs.send(new DeleteMessageCommand({ QueueUrl: url, ReceiptHandle: m.ReceiptHandle }));
  }
  return all;
}

/** Publica uma WagerTransactionRequested como um provedor faria (formato da seção 10). */
export async function sendWagerMessage(
  data: Record<string, unknown>,
  opts: { messageId?: string; dedupId?: string; body?: string } = {},
): Promise<string> {
  const messageId = opts.messageId ?? `msg-${crypto.randomUUID()}`;
  const body = opts.body ?? JSON.stringify({
    messageId, type: 'WagerTransactionRequested', occurredAt: new Date().toISOString(), data,
  });
  await sqs.send(new SendMessageCommand({
    QueueUrl: await queueUrl(QUEUES.wagers),
    MessageBody: body,
    MessageGroupId: String(data.walletId ?? 'sem-wallet'),
    MessageDeduplicationId: opts.dedupId ?? messageId,
  }));
  return messageId;
}
