import { defineConfig } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import { WalletRecord } from './records/wallet.record';
import { Migration20261104000001Wallets } from './migrations/Migration20261104000001Wallets';
import { Migration20261104000002Transactions } from './migrations/Migration20261104000002Transactions';
import { Migration20261104000003InboxOutbox } from './migrations/Migration20261104000003InboxOutbox';

export function databaseUrl(): string {
  return process.env.DATABASE_URL ?? 'postgres://wagering:wagering@localhost:5434/wagering';
}

export default defineConfig({
  clientUrl: databaseUrl(),
  entities: [WalletRecord],
  extensions: [Migrator],
  migrations: {
    // Lista explícita: a ordem é a do código, sem depender de glob no disco.
    migrationsList: [
      { name: 'Migration20261104000001Wallets', class: Migration20261104000001Wallets },
      { name: 'Migration20261104000002Transactions', class: Migration20261104000002Transactions },
      { name: 'Migration20261104000003InboxOutbox', class: Migration20261104000003InboxOutbox },
    ],
    transactional: true,
    allOrNothing: true,
    // As migrations são SQL escrito à mão; o snapshot do schema gerado pelo ORM não é usado.
    snapshot: false,
    snapshotOnMigrate: false,
  },
  debug: false,
});
