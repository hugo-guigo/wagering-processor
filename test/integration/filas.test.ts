// As filas do compose existem com a configuração que o consumidor espera.
import { expect, test } from 'bun:test';
import { GetQueueAttributesCommand, GetQueueUrlCommand, SQSClient } from '@aws-sdk/client-sqs';

const sqs = new SQSClient({
  endpoint: process.env.SQS_ENDPOINT ?? 'http://localhost:4566',
  region: 'us-east-1',
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
});

async function atributos(nome: string): Promise<Record<string, string>> {
  const { QueueUrl } = await sqs.send(new GetQueueUrlCommand({ QueueName: nome }));
  const { Attributes } = await sqs.send(new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ['All'] }));
  return Attributes ?? {};
}

test('fila principal é FIFO, sem deduplicação por conteúdo, e manda para a DLQ depois de 5 entregas', async () => {
  const principal = await atributos('wager-transactions.fifo');
  const dlq = await atributos('wager-transactions-dlq.fifo');

  expect(principal.FifoQueue).toBe('true');
  expect(principal.ContentBasedDeduplication).toBe('false');
  expect(dlq.FifoQueue).toBe('true');

  const redrive = JSON.parse(principal.RedrivePolicy ?? '{}');
  expect(redrive.deadLetterTargetArn).toBe(dlq.QueueArn);
  expect(Number(redrive.maxReceiveCount)).toBe(5);
});
