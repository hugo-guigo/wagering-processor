import { Injectable, Logger } from '@nestjs/common';
import {
  ChangeMessageVisibilityCommand, DeleteMessageCommand, ReceiveMessageCommand, SendMessageCommand, type Message,
} from '@aws-sdk/client-sqs';
import { ProcessWagerTransaction } from '../../application/process-wager-transaction';
import { TransactionRunner } from '../../application/ports';
import { IdempotencyConflictError, InvalidRequestError } from '../../application/errors';
import { asObject, parseWagerPayload, requireString } from '../../application/input-validation';
import { payloadHash, type WagerPayload } from '../../application/payload-hash';
import { InvalidMoneyError, InvalidWagerTransactionError } from '../../domain/errors';
import { QUEUES, SqsQueues } from './sqs';

export const CONSUMER_NAME = 'wager-transactions-consumer';

interface WagerMessage {
  messageId: string;
  idempotencyKey: string;
  payload: WagerPayload;
}

/** Formato da seção 10: { messageId, type: "WagerTransactionRequested", occurredAt, data }. */
export function parseWagerMessage(body: string | undefined): WagerMessage {
  let json: unknown;
  try {
    json = JSON.parse(body ?? '');
  } catch {
    throw new InvalidRequestError('message body is not JSON');
  }
  const envelope = asObject(json, 'message');
  if (envelope.type !== 'WagerTransactionRequested') {
    throw new InvalidRequestError('type must be WagerTransactionRequested', 'type');
  }
  const data = asObject(envelope.data, 'data');
  return {
    messageId: requireString(envelope, 'messageId'),
    idempotencyKey: requireString(data, 'idempotencyKey'),
    payload: parseWagerPayload(data),
  };
}

/** Erro que nunca vai passar tentando de novo: a mensagem vai direto para a DLQ. */
function isPermanent(error: unknown): boolean {
  return error instanceof InvalidRequestError
    || error instanceof InvalidMoneyError
    || error instanceof InvalidWagerTransactionError
    || error instanceof IdempotencyConflictError;
}

/**
 * Consumidor da fila de transações. Para cada mensagem:
 * - deduplica pelo inbox (consumerName, messageId);
 * - chama o MESMO caso de uso da entrada HTTP, que grava o inbox na mesma transação SQL;
 * - só apaga a mensagem (ack) depois do COMMIT;
 * - erro de negócio (REJECTED) é resultado, não erro: ack;
 * - erro transitório: devolve a mensagem com backoff (ChangeMessageVisibility); depois de
 *   maxReceiveCount entregas, a redrive policy da fila a manda para a DLQ;
 * - erro permanente (mensagem inválida, conflito de idempotência): direto para a DLQ.
 */
@Injectable()
export class SqsWagerConsumer {
  private readonly logger = new Logger(SqsWagerConsumer.name);
  private running = false;
  private poll?: AbortController;
  private loop?: Promise<void>;
  /** Base do backoff em segundos: 2, 4, 8, 16... até 60 (variável para os testes). */
  private readonly backoffBaseSeconds = Number(process.env.CONSUMER_BACKOFF_BASE_SECONDS ?? 2);

  constructor(
    private readonly queues: SqsQueues,
    private readonly processWager: ProcessWagerTransaction,
    private readonly runner: TransactionRunner,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.pollLoop();
  }

  /**
   * SIGTERM: para de buscar, termina as mensagens já em andamento e devolve a visibilidade das que
   * foram recebidas mas não começaram (outra instância pega na hora).
   */
  async stop(): Promise<void> {
    this.running = false;
    this.poll?.abort();
    await this.loop;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Uma rodada de leitura e processamento. Usado pelo laço e pelos testes. */
  async consumeOnce(waitTimeSeconds = 1): Promise<number> {
    this.poll = new AbortController();
    const { Messages = [] } = await this.queues.client.send(
      new ReceiveMessageCommand({
        QueueUrl: await this.queues.url(QUEUES.wagers),
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: waitTimeSeconds,
        MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
      }),
      { abortSignal: this.poll.signal },
    );
    await this.handleBatch(Messages);
    return Messages.length;
  }

  private async pollLoop(): Promise<void> {
    while (this.running) {
      try {
        await this.consumeOnce(5);
      } catch (error) {
        if (!this.running) break; // long poll abortado pelo stop()
        this.logger.error(`receive failed: ${error instanceof Error ? error.message : String(error)}`);
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    }
  }

  /** Grupos (wallets) em paralelo; dentro do grupo, em ordem, como a FIFO entregou. */
  private async handleBatch(messages: Message[]): Promise<void> {
    const groups = new Map<string, Message[]>();
    for (const message of messages) {
      const group = message.Attributes?.MessageGroupId ?? 'default';
      groups.set(group, [...(groups.get(group) ?? []), message]);
    }
    await Promise.all([...groups.values()].map(async (group) => {
      for (const message of group) {
        if (this.stopping) {
          await this.release(message);
          continue;
        }
        await this.handle(message);
      }
    }));
  }

  /** Parado por stop() enquanto o laço está rodando (consumeOnce isolado nos testes não conta). */
  private get stopping(): boolean {
    return this.loop !== undefined && !this.running;
  }

  async handle(message: Message): Promise<void> {
    let parsed: WagerMessage;
    let hash: string;
    try {
      parsed = parseWagerMessage(message.Body);
      hash = payloadHash(parsed.payload); // valida o valor (Money) também
    } catch (error) {
      return this.deadLetter(message, error);
    }

    try {
      const seen = await this.runner.run((store) => store.findInboxMessage(CONSUMER_NAME, parsed.messageId));
      if (seen) {
        if (seen.payloadHash !== hash) {
          return this.deadLetter(message, new Error(`messageId ${parsed.messageId} reused with a different payload`));
        }
        this.logger.log(`duplicate message ${parsed.messageId} ignored`);
        return this.ack(message);
      }

      await this.processWager.execute(
        {
          idempotencyKey: parsed.idempotencyKey,
          payload: parsed.payload,
          inbox: { consumerName: CONSUMER_NAME, messageId: parsed.messageId, payloadHash: hash },
        },
        { correlationId: parsed.messageId, causationId: parsed.messageId },
      );

      // Falha injetada para o teste "worker morto depois do commit e antes do ack".
      if (process.env.FAIL_AFTER_COMMIT === '1') {
        this.logger.error(`FAIL_AFTER_COMMIT: exiting after committing ${parsed.messageId}, before the ack`);
        process.exit(1);
      }
      return this.ack(message);
    } catch (error) {
      if (isPermanent(error)) return this.deadLetter(message, error);
      return this.retryLater(message, error);
    }
  }

  private async ack(message: Message): Promise<void> {
    await this.queues.client.send(new DeleteMessageCommand({
      QueueUrl: await this.queues.url(QUEUES.wagers),
      ReceiptHandle: message.ReceiptHandle,
    }));
  }

  /** Erro transitório: a mensagem volta depois de 2^n segundos (n = entregas até agora). */
  private async retryLater(message: Message, error: unknown): Promise<void> {
    const receives = Number(message.Attributes?.ApproximateReceiveCount ?? 1);
    const delay = Math.min(this.backoffBaseSeconds * 2 ** (receives - 1), 60);
    this.logger.warn(`message ${message.MessageId} will be retried in ${delay}s (receive ${receives}): ${describe(error)}`);
    await this.setVisibility(message, delay);
  }

  private async release(message: Message): Promise<void> {
    await this.setVisibility(message, 0);
  }

  private async setVisibility(message: Message, seconds: number): Promise<void> {
    try {
      await this.queues.client.send(new ChangeMessageVisibilityCommand({
        QueueUrl: await this.queues.url(QUEUES.wagers),
        ReceiptHandle: message.ReceiptHandle,
        VisibilityTimeout: seconds,
      }));
    } catch (error) {
      // Sem o ChangeMessageVisibility, a mensagem volta sozinha quando o VisibilityTimeout vencer.
      this.logger.warn(`could not change visibility of ${message.MessageId}: ${describe(error)}`);
    }
  }

  /** Copia para a DLQ com o motivo e só então apaga da fila principal. */
  private async deadLetter(message: Message, error: unknown): Promise<void> {
    this.logger.warn(`message ${message.MessageId} sent to the DLQ: ${describe(error)}`);
    await this.queues.client.send(new SendMessageCommand({
      QueueUrl: await this.queues.url(QUEUES.wagersDeadLetter),
      MessageBody: message.Body ?? '',
      MessageGroupId: message.Attributes?.MessageGroupId ?? 'dead-letter',
      MessageDeduplicationId: message.MessageId,
      MessageAttributes: { reason: { DataType: 'String', StringValue: describe(error).slice(0, 256) } },
    }));
    await this.ack(message);
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
