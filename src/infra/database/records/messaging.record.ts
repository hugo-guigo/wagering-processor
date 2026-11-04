import { defineEntity, p } from '@mikro-orm/postgresql';

export const OutboxMessageRecordSchema = defineEntity({
  name: 'OutboxMessageRecord',
  tableName: 'outbox_messages',
  properties: {
    id: p.uuid().primary(),
    aggregateId: p.uuid(),
    eventType: p.string(),
    payload: p.json<Record<string, unknown>>(),
    occurredAt: p.datetime(),
    attempts: p.integer(),
    nextAttemptAt: p.datetime(),
    publishedAt: p.datetime().nullable(),
    lastError: p.string().nullable(),
  },
});

export class OutboxMessageRecord extends OutboxMessageRecordSchema.class {}
OutboxMessageRecordSchema.setClass(OutboxMessageRecord);

export const InboxMessageRecordSchema = defineEntity({
  name: 'InboxMessageRecord',
  tableName: 'inbox_messages',
  properties: {
    consumerName: p.string().primary(),
    messageId: p.string().primary(),
    payloadHash: p.string(),
    transactionId: p.uuid().nullable(),
    receivedAt: p.datetime(),
    processedAt: p.datetime().nullable(),
  },
});

export class InboxMessageRecord extends InboxMessageRecordSchema.class {}
InboxMessageRecordSchema.setClass(InboxMessageRecord);
