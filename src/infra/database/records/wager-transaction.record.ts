import { defineEntity, p } from '@mikro-orm/postgresql';

export const WagerTransactionRecordSchema = defineEntity({
  name: 'WagerTransactionRecord',
  tableName: 'wager_transactions',
  properties: {
    id: p.uuid().primary(),
    providerId: p.string(),
    externalTransactionId: p.string(),
    idempotencyKey: p.string(),
    payloadHash: p.string(),
    walletId: p.uuid(),
    playerId: p.string(),
    roundId: p.string().nullable(),
    gameId: p.string().nullable(),
    kind: p.string(),
    amountMinor: p.bigint('bigint'),
    currency: p.string(),
    referenceExternalTransactionId: p.string().nullable(),
    referenceTransactionId: p.uuid().nullable(),
    status: p.string(),
    failureCode: p.string().nullable(),
    resultBalanceMinor: p.bigint('bigint').nullable(),
    referenceAttempts: p.integer(),
    nextReferenceAttemptAt: p.datetime().nullable(),
    createdAt: p.datetime(),
    updatedAt: p.datetime(),
    processedAt: p.datetime().nullable(),
  },
});

export class WagerTransactionRecord extends WagerTransactionRecordSchema.class {}
WagerTransactionRecordSchema.setClass(WagerTransactionRecord);
