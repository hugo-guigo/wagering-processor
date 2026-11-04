import { Injectable } from '@nestjs/common';
import { SendMessageBatchCommand } from '@aws-sdk/client-sqs';
import { EventPublisher } from '../../application/ports';
import type { OutboxMessage } from '../../domain/messaging/outbox-message';
import { QUEUES, SqsQueues } from './sqs';

/**
 * Publica eventos na fila FIFO de eventos. MessageGroupId = aggregateId (walletId) mantém a ordem
 * por wallet; MessageDeduplicationId = eventId faz o próprio SQS descartar uma republicação dentro
 * de 5 minutos. Fora dessa janela, quem deduplica é o consumidor, pelo eventId.
 */
@Injectable()
export class SqsEventPublisher extends EventPublisher {
  constructor(private readonly queues: SqsQueues) {
    super();
  }

  async publish(messages: OutboxMessage[]): Promise<Map<string, string>> {
    const failures = new Map<string, string>();
    for (let i = 0; i < messages.length; i += 10) {
      const batch = messages.slice(i, i + 10);
      try {
        const result = await this.queues.client.send(new SendMessageBatchCommand({
          QueueUrl: await this.queues.url(QUEUES.events),
          Entries: batch.map((m, index) => ({
            Id: String(index),
            MessageBody: JSON.stringify(m.payload),
            MessageGroupId: m.aggregateId,
            MessageDeduplicationId: m.id,
            MessageAttributes: { eventType: { DataType: 'String', StringValue: m.eventType } },
          })),
        }));
        for (const failed of result.Failed ?? []) {
          const message = batch[Number(failed.Id)];
          if (message) failures.set(message.id, `${failed.Code}: ${failed.Message ?? ''}`);
        }
      } catch (error) {
        // Erro de conexão pode vir com message vazia: o nome e o código ajudam no diagnóstico.
        const reason = error instanceof Error
          ? [error.name, (error as { code?: string }).code, error.message].filter(Boolean).join(': ')
          : String(error);
        for (const message of batch) failures.set(message.id, reason);
      }
    }
    return failures;
  }
}
