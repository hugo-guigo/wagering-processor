import { Migration } from '@mikro-orm/migrations';

/** Inbox (deduplicação do consumidor SQS) e outbox (eventos gravados na mesma transação). */
export class Migration20261104000003InboxOutbox extends Migration {
  override async up(): Promise<void> {
    // A chave primária é a deduplicação: a mesma mensagem não entra duas vezes para o mesmo consumidor.
    this.addSql(`
      create table inbox_messages (
        consumer_name text not null,
        message_id text not null,
        payload_hash char(64) not null check (payload_hash ~ '^[0-9a-f]{64}$'),
        transaction_id uuid references wager_transactions (id),
        received_at timestamptz not null,
        processed_at timestamptz,
        primary key (consumer_name, message_id)
      )`);

    this.addSql(`
      create table outbox_messages (
        id uuid primary key,
        seq bigint generated always as identity,
        aggregate_id uuid not null,
        event_type text not null,
        payload jsonb not null,
        occurred_at timestamptz not null,
        attempts integer not null default 0 check (attempts >= 0),
        next_attempt_at timestamptz not null,
        published_at timestamptz,
        last_error text,
        -- o envelope gravado é o do próprio evento (id da linha = eventId do payload)
        constraint outbox_payload_envelope check (
          payload->>'eventId' = id::text and payload->>'eventType' = event_type)
      )`);
    // O publisher busca só o que falta publicar e já venceu o backoff.
    this.addSql(`
      create index outbox_due_idx on outbox_messages (next_attempt_at, seq) where published_at is null`);
    this.addSql(`
      create function outbox_guard_update() returns trigger language plpgsql as $$
      begin
        if (new.id, new.aggregate_id, new.event_type, new.payload, new.occurred_at)
           is distinct from (old.id, old.aggregate_id, old.event_type, old.payload, old.occurred_at) then
          raise exception 'outbox message % content is immutable', old.id using errcode = 'restrict_violation';
        end if;
        if old.published_at is not null and new.published_at is distinct from old.published_at then
          raise exception 'outbox message % was already published', old.id using errcode = 'restrict_violation';
        end if;
        return new;
      end $$`);
    this.addSql(`create trigger outbox_guard before update on outbox_messages for each row execute function outbox_guard_update()`);
  }

  override async down(): Promise<void> {
    this.addSql('drop table outbox_messages');
    this.addSql('drop function outbox_guard_update()');
    this.addSql('drop table inbox_messages');
  }
}
