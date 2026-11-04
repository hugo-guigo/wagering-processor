import { defineEntity, p } from '@mikro-orm/postgresql';

// Registro de persistência, não o agregado do domínio. O mapper converte um no outro.
export const WalletRecordSchema = defineEntity({
  name: 'WalletRecord',
  tableName: 'wallets',
  properties: {
    id: p.uuid().primary(),
    playerId: p.string(),
    currency: p.string(),
    balanceMinor: p.bigint('bigint'),
    version: p.integer(),
    createdAt: p.datetime(),
    updatedAt: p.datetime(),
  },
});

export class WalletRecord extends WalletRecordSchema.class {}
WalletRecordSchema.setClass(WalletRecord);
