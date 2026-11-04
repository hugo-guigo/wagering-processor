import { Migration } from '@mikro-orm/migrations';

/**
 * Transações, ledger e as invariantes que ligam os dois à wallet. Tudo o que a seção 6 pede como
 * garantia fica no schema: unicidade, imutabilidade, não negatividade e "toda mudança de saldo tem
 * lançamento e vice-versa".
 */
export class Migration20261104000002Transactions extends Migration {
  override async up(): Promise<void> {
    // Função genérica para tabelas (ou operações) que não podem ser alteradas.
    this.addSql(`
      create function reject_change() returns trigger language plpgsql as $$
      begin
        raise exception '% on % is not allowed', tg_op, tg_table_name using errcode = 'restrict_violation';
      end $$`);

    // ---- wallets: alvo das FKs compostas e guarda das colunas de identidade e da versão
    this.addSql(`alter table wallets add constraint wallets_id_currency_uq unique (id, currency)`);
    this.addSql(`
      create function wallets_guard_update() returns trigger language plpgsql as $$
      begin
        if (new.id, new.player_id, new.currency, new.created_at)
           is distinct from (old.id, old.player_id, old.currency, old.created_at) then
          raise exception 'wallet % identity columns are immutable', old.id using errcode = 'restrict_violation';
        end if;
        if new.balance_minor <> old.balance_minor and new.version <> old.version + 1 then
          raise exception 'wallet % balance changed without version + 1', old.id using errcode = 'check_violation';
        end if;
        if new.balance_minor = old.balance_minor and new.version <> old.version then
          raise exception 'wallet % version changed without a balance change', old.id using errcode = 'check_violation';
        end if;
        return new;
      end $$`);
    this.addSql(`create trigger wallets_guard before update on wallets for each row execute function wallets_guard_update()`);
    this.addSql(`create trigger wallets_no_delete before delete on wallets for each row execute function reject_change()`);

    // ---- transações
    this.addSql(`
      create table wager_transactions (
        id uuid primary key,
        provider_id text not null check (provider_id <> ''),
        external_transaction_id text not null check (external_transaction_id <> ''),
        idempotency_key text not null check (idempotency_key <> ''),
        payload_hash char(64) not null check (payload_hash ~ '^[0-9a-f]{64}$'),
        wallet_id uuid not null references wallets (id),
        player_id text not null,
        round_id text,
        game_id text,
        kind text not null check (kind in ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        amount_minor bigint not null check (amount_minor >= 0),
        currency char(3) not null check (currency ~ '^[A-Z]{3}$'),
        reference_external_transaction_id text,
        reference_transaction_id uuid references wager_transactions (id),
        status text not null check (status in ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
        failure_code text,
        result_balance_minor bigint check (result_balance_minor >= 0),
        reference_attempts integer not null default 0 check (reference_attempts >= 0),
        next_reference_attempt_at timestamptz,
        created_at timestamptz not null,
        updated_at timestamptz not null,
        processed_at timestamptz,

        constraint wager_tx_idempotency_key_uq unique (idempotency_key),
        constraint wager_tx_provider_external_uq unique (provider_id, external_transaction_id),
        -- alvo da FK composta do ledger: o lançamento tem a mesma wallet, moeda e valor da transação
        constraint wager_tx_ledger_target_uq unique (id, wallet_id, currency, amount_minor),
        constraint wager_tx_amount_positive check (kind = 'LOSS' or amount_minor > 0),
        constraint wager_tx_reference_required check (kind not in ('REFUND', 'ROLLBACK') or reference_external_transaction_id is not null),
        constraint wager_tx_round_required check (kind = 'OPENING' or (round_id is not null and game_id is not null)),
        constraint wager_tx_failure_code check ((status in ('REJECTED', 'FAILED')) = (failure_code is not null)),
        constraint wager_tx_processed_at check ((status = 'PROCESSED') = (processed_at is not null)),
        constraint wager_tx_reversal_resolved check (
          status <> 'PROCESSED' or kind not in ('REFUND', 'ROLLBACK') or reference_transaction_id is not null),
        constraint wager_tx_pending_schedule check (status <> 'PENDING_REFERENCE' or next_reference_attempt_at is not null)
      )`);
    // Uma referência só pode ser revertida uma vez, por REFUND ou por ROLLBACK (ver ARCHITECTURE.md).
    this.addSql(`
      create unique index wager_tx_single_reversal_uq on wager_transactions (reference_transaction_id)
      where kind in ('REFUND', 'ROLLBACK') and status = 'PROCESSED'`);
    this.addSql(`
      create index wager_tx_pending_reference_idx on wager_transactions (next_reference_attempt_at)
      where status = 'PENDING_REFERENCE'`);
    this.addSql(`
      create function wager_tx_guard_update() returns trigger language plpgsql as $$
      begin
        if (new.id, new.provider_id, new.external_transaction_id, new.idempotency_key, new.payload_hash,
            new.wallet_id, new.player_id, new.round_id, new.game_id, new.kind, new.amount_minor, new.currency,
            new.reference_external_transaction_id, new.created_at)
           is distinct from
           (old.id, old.provider_id, old.external_transaction_id, old.idempotency_key, old.payload_hash,
            old.wallet_id, old.player_id, old.round_id, old.game_id, old.kind, old.amount_minor, old.currency,
            old.reference_external_transaction_id, old.created_at) then
          raise exception 'wager transaction % business columns are immutable', old.id using errcode = 'restrict_violation';
        end if;
        if old.status in ('PROCESSED', 'REJECTED', 'FAILED') then
          raise exception 'wager transaction % is terminal (%)', old.id, old.status using errcode = 'restrict_violation';
        end if;
        if old.status = 'PENDING_REFERENCE' and new.status = 'PENDING' then
          raise exception 'wager transaction % cannot go back to PENDING', old.id using errcode = 'check_violation';
        end if;
        return new;
      end $$`);
    this.addSql(`create trigger wager_tx_guard before update on wager_transactions for each row execute function wager_tx_guard_update()`);
    this.addSql(`create trigger wager_tx_no_delete before delete on wager_transactions for each row execute function reject_change()`);

    // ---- ledger
    this.addSql(`
      create table wallet_ledger_entries (
        id uuid primary key,
        -- ordem de inserção: cursor estável da paginação e "último lançamento" das checagens
        seq bigint generated always as identity,
        wallet_id uuid not null,
        transaction_id uuid not null,
        direction text not null check (direction in ('DEBIT', 'CREDIT')),
        amount_minor bigint not null check (amount_minor > 0),
        currency char(3) not null,
        balance_before_minor bigint not null check (balance_before_minor >= 0),
        balance_after_minor bigint not null check (balance_after_minor >= 0),
        created_at timestamptz not null,

        constraint ledger_arithmetic check (balance_after_minor = case direction
          when 'CREDIT' then balance_before_minor + amount_minor
          else balance_before_minor - amount_minor end),
        constraint ledger_one_entry_per_transaction_wallet unique (transaction_id, wallet_id),
        constraint ledger_wallet_fk foreign key (wallet_id, currency) references wallets (id, currency),
        constraint ledger_transaction_fk foreign key (transaction_id, wallet_id, currency, amount_minor)
          references wager_transactions (id, wallet_id, currency, amount_minor)
      )`);
    this.addSql(`create unique index ledger_wallet_seq_uq on wallet_ledger_entries (wallet_id, seq)`);
    this.addSql(`create trigger ledger_append_only before update or delete on wallet_ledger_entries for each row execute function reject_change()`);
    this.addSql(`create trigger ledger_no_truncate before truncate on wallet_ledger_entries for each statement execute function reject_change()`);

    // ---- invariantes conferidas no COMMIT (constraint triggers adiados)

    // Saldo materializado == saldo depois do último lançamento (zero se não há lançamento).
    this.addSql(`
      create function assert_wallet_matches_ledger(p_wallet uuid) returns void language plpgsql as $$
      declare
        v_balance bigint;
        v_ledger bigint;
      begin
        select balance_minor into v_balance from wallets where id = p_wallet;
        select balance_after_minor into v_ledger from wallet_ledger_entries
         where wallet_id = p_wallet order by seq desc limit 1;
        if v_balance <> coalesce(v_ledger, 0) then
          raise exception 'wallet % balance % differs from ledger %', p_wallet, v_balance, coalesce(v_ledger, 0)
            using errcode = 'check_violation';
        end if;
      end $$`);
    this.addSql(`
      create function wallets_match_ledger() returns trigger language plpgsql as $$
      begin
        perform assert_wallet_matches_ledger(new.id);
        return null;
      end $$`);
    this.addSql(`
      create constraint trigger wallets_match_ledger after insert or update on wallets
      deferrable initially deferred for each row execute function wallets_match_ledger()`);

    // Cada lançamento: continua o saldo do anterior, pertence a uma transação PROCESSED que move
    // saldo, e tem a direção que o kind manda (ROLLBACK: o inverso do lançamento da referência).
    this.addSql(`
      create function ledger_entry_consistent() returns trigger language plpgsql as $$
      declare
        v_previous bigint;
        v_status text;
        v_kind text;
        v_reference uuid;
        v_expected text;
      begin
        select balance_after_minor into v_previous from wallet_ledger_entries
         where wallet_id = new.wallet_id and seq < new.seq order by seq desc limit 1;
        if coalesce(v_previous, 0) <> new.balance_before_minor then
          raise exception 'ledger entry % does not continue the previous balance %', new.id, coalesce(v_previous, 0)
            using errcode = 'check_violation';
        end if;

        select status, kind, reference_transaction_id into v_status, v_kind, v_reference
          from wager_transactions where id = new.transaction_id;
        if v_status <> 'PROCESSED' or v_kind = 'LOSS' then
          raise exception 'ledger entry % belongs to a % % transaction', new.id, v_status, v_kind
            using errcode = 'check_violation';
        end if;
        v_expected := case v_kind
          when 'BET' then 'DEBIT'
          when 'ROLLBACK' then (select case direction when 'DEBIT' then 'CREDIT' else 'DEBIT' end
                                  from wallet_ledger_entries where transaction_id = v_reference)
          else 'CREDIT' end;
        if v_expected is distinct from new.direction then
          raise exception 'ledger entry % of a % must be %', new.id, v_kind, v_expected using errcode = 'check_violation';
        end if;

        perform assert_wallet_matches_ledger(new.wallet_id);
        return null;
      end $$`);
    this.addSql(`
      create constraint trigger ledger_entry_consistent after insert on wallet_ledger_entries
      deferrable initially deferred for each row execute function ledger_entry_consistent()`);

    // E o caminho inverso: transação PROCESSED que move saldo tem exatamente 1 lançamento; as demais, nenhum.
    this.addSql(`
      create function wager_tx_ledger_consistent() returns trigger language plpgsql as $$
      declare
        v_entries integer;
        v_expected integer;
      begin
        select count(*) into v_entries from wallet_ledger_entries where transaction_id = new.id;
        v_expected := case when new.status = 'PROCESSED' and new.kind <> 'LOSS' then 1 else 0 end;
        if v_entries <> v_expected then
          raise exception 'wager transaction % (% %) has % ledger entries, expected %',
            new.id, new.status, new.kind, v_entries, v_expected using errcode = 'check_violation';
        end if;
        return null;
      end $$`);
    this.addSql(`
      create constraint trigger wager_tx_ledger_consistent after insert or update on wager_transactions
      deferrable initially deferred for each row execute function wager_tx_ledger_consistent()`);
  }

  override async down(): Promise<void> {
    this.addSql('drop table wallet_ledger_entries');
    this.addSql('drop table wager_transactions');
    this.addSql('drop trigger wallets_match_ledger on wallets');
    this.addSql('drop trigger wallets_no_delete on wallets');
    this.addSql('drop trigger wallets_guard on wallets');
    this.addSql('alter table wallets drop constraint wallets_id_currency_uq');
    this.addSql('drop function wager_tx_ledger_consistent()');
    this.addSql('drop function ledger_entry_consistent()');
    this.addSql('drop function wallets_match_ledger()');
    this.addSql('drop function assert_wallet_matches_ledger(uuid)');
    this.addSql('drop function wager_tx_guard_update()');
    this.addSql('drop function wallets_guard_update()');
    this.addSql('drop function reject_change()');
  }
}
