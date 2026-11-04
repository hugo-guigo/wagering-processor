import { Migration } from '@mikro-orm/migrations';

export class Migration20261104000001Wallets extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table wallets (
        id uuid primary key,
        player_id text not null,
        currency char(3) not null check (currency ~ '^[A-Z]{3}$'),
        balance_minor bigint not null check (balance_minor >= 0),
        version integer not null check (version >= 1),
        created_at timestamptz not null,
        updated_at timestamptz not null,
        constraint wallets_player_currency_uq unique (player_id, currency)
      )`);
  }

  override async down(): Promise<void> {
    this.addSql('drop table wallets');
  }
}
