import { defineEntity, p } from '@mikro-orm/postgresql';

// A coluna `seq` (identity) não é mapeada: o banco a gera e ela só é lida em consultas de extrato.
export const LedgerEntryRecordSchema = defineEntity({
  name: 'LedgerEntryRecord',
  tableName: 'wallet_ledger_entries',
  properties: {
    id: p.uuid().primary(),
    walletId: p.uuid(),
    transactionId: p.uuid(),
    direction: p.string(),
    amountMinor: p.bigint('bigint'),
    currency: p.string(),
    balanceBeforeMinor: p.bigint('bigint'),
    balanceAfterMinor: p.bigint('bigint'),
    createdAt: p.datetime(),
  },
});

export class LedgerEntryRecord extends LedgerEntryRecordSchema.class {}
LedgerEntryRecordSchema.setClass(LedgerEntryRecord);
