import { Migration } from '@mikro-orm/migrations';

const FOREIGN_KEYS = [
  ['wager_transactions', 'wager_transactions_wallet_id_fkey'],
  ['wager_transactions', 'wager_transactions_reference_transaction_id_fkey'],
  ['wallet_ledger_entries', 'ledger_wallet_fk'],
  ['wallet_ledger_entries', 'ledger_transaction_fk'],
  ['inbox_messages', 'inbox_messages_transaction_id_fkey'],
] as const;

/**
 * Chaves estrangeiras conferidas no COMMIT. O Unit of Work do MikroORM grava tudo num único flush e
 * não conhece a ordem entre wallet, transação e lançamento (os registros não declaram relações).
 * Com a FK adiada, a ordem dos INSERTs deixa de importar e a garantia continua no banco.
 */
export class Migration20261104000004DeferrableForeignKeys extends Migration {
  override async up(): Promise<void> {
    for (const [table, constraint] of FOREIGN_KEYS) {
      this.addSql(`alter table ${table} alter constraint ${constraint} deferrable initially deferred`);
    }
  }

  override async down(): Promise<void> {
    for (const [table, constraint] of FOREIGN_KEYS) {
      this.addSql(`alter table ${table} alter constraint ${constraint} not deferrable`);
    }
  }
}
