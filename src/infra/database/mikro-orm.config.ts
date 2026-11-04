import { defineConfig } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import { WalletRecord } from './records/wallet.record';
import { WagerTransactionRecord } from './records/wager-transaction.record';
import { LedgerEntryRecord } from './records/ledger-entry.record';
import { InboxMessageRecord, OutboxMessageRecord } from './records/messaging.record';
import { Migration20261104000001Wallets } from './migrations/Migration20261104000001Wallets';
import { Migration20261104000002Transactions } from './migrations/Migration20261104000002Transactions';
import { Migration20261104000003InboxOutbox } from './migrations/Migration20261104000003InboxOutbox';
import { Migration20261104000004DeferrableForeignKeys } from './migrations/Migration20261104000004DeferrableForeignKeys';

export function databaseUrl(): string {
  return process.env.DATABASE_URL ?? 'postgres://wagering:wagering@localhost:5434/wagering';
}

export default defineConfig({
  clientUrl: databaseUrl(),
  entities: [WalletRecord, WagerTransactionRecord, LedgerEntryRecord, OutboxMessageRecord, InboxMessageRecord],
  // Cada instância abre no máximo isto de conexões. Com 3 instâncias, 3 x 10 = 30 (o Postgres aceita 100).
  pool: { min: 0, max: Number(process.env.DB_POOL_MAX ?? 10) },
  extensions: [Migrator],
  migrations: {
    // Lista explícita: a ordem é a do código, sem depender de glob no disco.
    migrationsList: [
      { name: 'Migration20261104000001Wallets', class: Migration20261104000001Wallets },
      { name: 'Migration20261104000002Transactions', class: Migration20261104000002Transactions },
      { name: 'Migration20261104000003InboxOutbox', class: Migration20261104000003InboxOutbox },
      { name: 'Migration20261104000004DeferrableForeignKeys', class: Migration20261104000004DeferrableForeignKeys },
    ],
    transactional: true,
    allOrNothing: true,
    // As migrations são SQL escrito à mão; o snapshot do schema gerado pelo ORM não é usado.
    snapshot: false,
    snapshotOnMigrate: false,
  },
  debug: false,
});
