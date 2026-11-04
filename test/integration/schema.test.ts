// Garantias do schema (seção 5, item 9): cada teste quebra uma regra de propósito e confere que o
// PostgreSQL recusa, sem depender do código da aplicação.
import { beforeAll, describe, expect, test } from 'bun:test';
import { applyMovement, HASH, resetSchema, seedWallet, sql } from './support/database';

beforeAll(resetSchema);

async function saldoEVersao(walletId: string) {
  const [w] = await sql`select balance_minor, version from wallets where id = ${walletId}`;
  return { saldo: BigInt(w.balance_minor), versao: Number(w.version) };
}

describe('wallet ↔ ledger (conferido no COMMIT)', () => {
  test('cenário válido: abertura e aposta fecham com o ledger', async () => {
    const w = await seedWallet(10_000n);
    await sql.begin((tx) => applyMovement(tx, w, { kind: 'BET', amountMinor: 8_000n, direction: 'DEBIT' }));
    await expect(await saldoEVersao(w.walletId)).toEqual({ saldo: 2_000n, versao: 2 });
  });

  test('wallet nascendo com saldo e sem lançamento é recusada', async () => {
    const id = crypto.randomUUID();
    const insert = sql`insert into wallets values (${id}, 'p-x', 'BRL', 500, 1, now(), now())`;
    await expect(insert).rejects.toThrow(/differs from ledger/);
  });

  test('mudar o saldo sem lançamento é recusado', async () => {
    const w = await seedWallet(10_000n);
    const update = sql`update wallets set balance_minor = 20000, version = version + 1 where id = ${w.walletId}`;
    await expect(update).rejects.toThrow(/differs from ledger/);
    await expect(await saldoEVersao(w.walletId)).toEqual({ saldo: 10_000n, versao: 1 });
  });

  test('lançamento sem mudar o saldo é recusado', async () => {
    const w = await seedWallet(10_000n);
    const tentativa = sql.begin(async (tx) => {
      await applyMovement(tx, w, { kind: 'WIN', amountMinor: 100n, direction: 'CREDIT' });
      await tx`update wallets set balance_minor = 10000, version = version + 1 where id = ${w.walletId}`;
    });
    await expect(tentativa).rejects.toThrow(/differs from ledger/);
  });

  test('saldo muda só com version + 1, e version não muda sozinha', async () => {
    const w = await seedWallet(10_000n);
    await expect(sql`update wallets set balance_minor = 0 where id = ${w.walletId}`).rejects.toThrow(/without version \+ 1/);
    await expect(sql`update wallets set version = 9 where id = ${w.walletId}`).rejects.toThrow(/without a balance change/);
  });

  test('saldo negativo é recusado pelo CHECK', async () => {
    const w = await seedWallet(100n);
    await expect(sql`update wallets set balance_minor = -1, version = version + 1 where id = ${w.walletId}`)
      .rejects.toThrow(/balance_minor_check/);
  });

  test('wallet não pode ser apagada nem mudar de dono ou moeda', async () => {
    const w = await seedWallet(0n);
    await expect(sql`delete from wallets where id = ${w.walletId}`).rejects.toThrow(/DELETE on wallets is not allowed/);
    await expect(sql`update wallets set player_id = 'outro' where id = ${w.walletId}`).rejects.toThrow(/immutable/);
  });
});

describe('ledger', () => {
  test('só aceita INSERT: UPDATE, DELETE e TRUNCATE são recusados', async () => {
    const w = await seedWallet(10_000n);
    const [entry] = await sql`select id from wallet_ledger_entries where wallet_id = ${w.walletId}`;
    await expect(sql`update wallet_ledger_entries set amount_minor = 1 where id = ${entry.id}`).rejects.toThrow(/UPDATE on wallet_ledger_entries/);
    await expect(sql`delete from wallet_ledger_entries where id = ${entry.id}`).rejects.toThrow(/DELETE on wallet_ledger_entries/);
    await expect(sql`truncate wallet_ledger_entries cascade`).rejects.toThrow(/TRUNCATE on wallet_ledger_entries/);
  });

  test('aritmética errada é recusada pelo CHECK', async () => {
    const w = await seedWallet(10_000n);
    const tentativa = sql.begin(async (tx) => {
      const txId = await applyMovement(tx, w, { kind: 'WIN', amountMinor: 100n, direction: 'CREDIT' });
      await tx`insert into wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount_minor, currency,
                 balance_before_minor, balance_after_minor, created_at)
               values (${crypto.randomUUID()}, ${w.walletId}, ${txId}, 'CREDIT', 100, 'BRL', 10100, 10150, now())`;
    });
    await expect(tentativa).rejects.toThrow(/ledger_arithmetic/);
  });

  test('um lançamento por transação e wallet', async () => {
    const w = await seedWallet(10_000n);
    const tentativa = sql.begin(async (tx) => {
      const txId = await applyMovement(tx, w, { kind: 'WIN', amountMinor: 100n, direction: 'CREDIT' });
      await tx`insert into wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount_minor, currency,
                 balance_before_minor, balance_after_minor, created_at)
               values (${crypto.randomUUID()}, ${w.walletId}, ${txId}, 'CREDIT', 100, 'BRL', 10100, 10200, now())`;
    });
    await expect(tentativa).rejects.toThrow(/ledger_one_entry_per_transaction_wallet/);
  });

  test('lançamento com valor diferente da transação é recusado pela FK composta', async () => {
    const w = await seedWallet(10_000n);
    const tentativa = sql.begin(async (tx) => {
      const txId = crypto.randomUUID();
      await tx`insert into wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
                 wallet_id, player_id, round_id, game_id, kind, amount_minor, currency, status, created_at, updated_at, processed_at)
               values (${txId}, 'provider-a', ${txId}, ${txId}, ${HASH}, ${w.walletId}, ${w.playerId}, 'r', 'g',
                 'WIN', 100, 'BRL', 'PROCESSED', now(), now(), now())`;
      await tx`insert into wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount_minor, currency,
                 balance_before_minor, balance_after_minor, created_at)
               values (${crypto.randomUUID()}, ${w.walletId}, ${txId}, 'CREDIT', 999, 'BRL', 10000, 10999, now())`;
    });
    await expect(tentativa).rejects.toThrow(/ledger_transaction_fk/);
  });

  test('BET com lançamento de crédito é recusada (direção pelo kind)', async () => {
    const w = await seedWallet(10_000n);
    const tentativa = sql.begin((tx) => applyMovement(tx, w, { kind: 'BET', amountMinor: 100n, direction: 'CREDIT' }));
    await expect(tentativa).rejects.toThrow(/must be DEBIT/);
  });
});

describe('transações', () => {
  test('PROCESSED que move saldo sem lançamento é recusada no COMMIT', async () => {
    const w = await seedWallet(10_000n);
    const txId = crypto.randomUUID();
    const insert = sql`insert into wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
        wallet_id, player_id, round_id, game_id, kind, amount_minor, currency, status, created_at, updated_at, processed_at)
      values (${txId}, 'provider-a', ${txId}, ${txId}, ${HASH}, ${w.walletId}, ${w.playerId}, 'r', 'g',
        'BET', 100, 'BRL', 'PROCESSED', now(), now(), now())`;
    await expect(insert).rejects.toThrow(/has 0 ledger entries, expected 1/);
  });

  test('idempotency key e (providerId, externalTransactionId) são únicos', async () => {
    const w = await seedWallet(10_000n);
    const inserir = (id: string, external: string, key: string) => sql`insert into wager_transactions (id, provider_id,
        external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, round_id, game_id, kind, amount_minor,
        currency, status, failure_code, created_at, updated_at)
      values (${id}, 'provider-a', ${external}, ${key}, ${HASH}, ${w.walletId}, ${w.playerId}, 'r', 'g',
        'BET', 100, 'BRL', 'REJECTED', 'INSUFFICIENT_FUNDS', now(), now())`;
    const ext = `ext-${crypto.randomUUID()}`;
    await inserir(crypto.randomUUID(), ext, `k-${ext}`);
    await expect(inserir(crypto.randomUUID(), `${ext}-2`, `k-${ext}`)).rejects.toThrow(/wager_tx_idempotency_key_uq/);
    await expect(inserir(crypto.randomUUID(), ext, `k-${ext}-2`)).rejects.toThrow(/wager_tx_provider_external_uq/);
  });

  test('REJECTED exige failureCode, e PROCESSED não pode ter um', async () => {
    const w = await seedWallet(0n);
    const id = crypto.randomUUID();
    await expect(sql`insert into wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
        wallet_id, player_id, round_id, game_id, kind, amount_minor, currency, status, created_at, updated_at)
      values (${id}, 'provider-a', ${id}, ${id}, ${HASH}, ${w.walletId}, ${w.playerId}, 'r', 'g', 'BET', 100, 'BRL',
        'REJECTED', now(), now())`).rejects.toThrow(/wager_tx_failure_code/);
  });

  test('REFUND e ROLLBACK exigem referência', async () => {
    const w = await seedWallet(0n);
    const id = crypto.randomUUID();
    await expect(sql`insert into wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
        wallet_id, player_id, round_id, game_id, kind, amount_minor, currency, status, failure_code, created_at, updated_at)
      values (${id}, 'provider-a', ${id}, ${id}, ${HASH}, ${w.walletId}, ${w.playerId}, 'r', 'g', 'REFUND', 100, 'BRL',
        'REJECTED', 'REFERENCE_NOT_FOUND', now(), now())`).rejects.toThrow(/wager_tx_reference_required/);
  });

  test('transação terminal não muda mais de estado, e colunas de negócio são imutáveis', async () => {
    const w = await seedWallet(10_000n);
    const txId = await sql.begin((tx) => applyMovement(tx, w, { kind: 'BET', amountMinor: 100n, direction: 'DEBIT' }));
    await expect(sql`update wager_transactions set status = 'REJECTED', failure_code = 'INSUFFICIENT_FUNDS', processed_at = null
               where id = ${txId}`).rejects.toThrow(/is terminal/);
    await expect(sql`update wager_transactions set amount_minor = 1 where id = ${txId}`).rejects.toThrow(/immutable/);
    await expect(sql`delete from wager_transactions where id = ${txId}`).rejects.toThrow(/DELETE on wager_transactions/);
  });

  test('uma referência só pode ser revertida uma vez, mesmo por kinds diferentes', async () => {
    const w = await seedWallet(10_000n);
    const bet = await sql.begin((tx) => applyMovement(tx, w, { kind: 'BET', amountMinor: 1_000n, direction: 'DEBIT' }));
    await sql.begin((tx) => applyMovement(tx, w, { kind: 'REFUND', amountMinor: 1_000n, direction: 'CREDIT', referenceTransactionId: bet }));

    const outroRefund = sql.begin((tx) => applyMovement(tx, w, { kind: 'REFUND', amountMinor: 1_000n, direction: 'CREDIT', referenceTransactionId: bet }));
    await expect(outroRefund).rejects.toThrow(/wager_tx_single_reversal_uq/);
    const rollback = sql.begin((tx) => applyMovement(tx, w, { kind: 'ROLLBACK', amountMinor: 1_000n, direction: 'CREDIT', referenceTransactionId: bet }));
    await expect(rollback).rejects.toThrow(/wager_tx_single_reversal_uq/);
    await expect((await saldoEVersao(w.walletId)).saldo).toBe(10_000n);
  });

  test('ROLLBACK de WIN tem de ser débito', async () => {
    const w = await seedWallet(10_000n);
    const win = await sql.begin((tx) => applyMovement(tx, w, { kind: 'WIN', amountMinor: 500n, direction: 'CREDIT' }));
    const errado = sql.begin((tx) => applyMovement(tx, w, { kind: 'ROLLBACK', amountMinor: 500n, direction: 'CREDIT', referenceTransactionId: win }));
    await expect(errado).rejects.toThrow(/must be DEBIT/);
    await sql.begin((tx) => applyMovement(tx, w, { kind: 'ROLLBACK', amountMinor: 500n, direction: 'DEBIT', referenceTransactionId: win }));
    await expect((await saldoEVersao(w.walletId)).saldo).toBe(10_000n);
  });
});

describe('inbox e outbox', () => {
  test('a mesma mensagem não entra duas vezes no inbox do mesmo consumidor', async () => {
    const msg = `msg-${crypto.randomUUID()}`;
    const inserir = (consumidor: string) =>
      sql`insert into inbox_messages (consumer_name, message_id, payload_hash, received_at) values (${consumidor}, ${msg}, ${HASH}, now())`;
    await inserir('wager-consumer');
    await expect(inserir('wager-consumer')).rejects.toThrow(/inbox_messages_pkey/);
    await inserir('outro-consumer');
  });

  test('outbox: o envelope bate com a linha, o conteúdo é imutável e publicado não volta atrás', async () => {
    const id = crypto.randomUUID();
    const payload = { eventId: id, eventType: 'WalletBalanceChanged', data: {} };
    await sql`insert into outbox_messages (id, aggregate_id, event_type, payload, occurred_at, next_attempt_at)
              values (${id}, ${id}, 'WalletBalanceChanged', ${payload}, now(), now())`;
    await expect(sql`insert into outbox_messages (id, aggregate_id, event_type, payload, occurred_at, next_attempt_at)
               values (${crypto.randomUUID()}, ${id}, 'WalletBalanceChanged', ${payload}, now(), now())`)
      .rejects.toThrow(/outbox_payload_envelope/);
    await expect(sql`update outbox_messages set payload = '{}' where id = ${id}`).rejects.toThrow(/immutable/);
    await sql`update outbox_messages set published_at = now() where id = ${id}`;
    await expect(sql`update outbox_messages set published_at = null where id = ${id}`).rejects.toThrow(/already published/);
  });
});
