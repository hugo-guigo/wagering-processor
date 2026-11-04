import { SQL, type TransactionSQL } from 'bun';
import { MikroORM } from '@mikro-orm/postgresql';
import config, { databaseUrl } from '../../../src/infra/database/mikro-orm.config';

/**
 * Cliente SQL cru (Bun.SQL) para montar cenários e quebrar regras de propósito. É compartilhado por
 * todos os arquivos de teste do processo: nenhum arquivo o fecha.
 */
export const sql = new SQL({ url: databaseUrl(), max: 10, bigint: true });

export const HASH = 'a'.repeat(64);

/** Derruba e recria o schema pelas migrations (testa o down e o up de todas). */
export async function resetSchema(): Promise<void> {
  const orm = await MikroORM.init({ ...config, debug: false });
  try {
    await orm.migrator.down({ to: 0 });
    await orm.migrator.up();
  } finally {
    await orm.close();
  }
}

type Tx = TransactionSQL;

/** Wallet com saldo de abertura, como o caso de uso fará: wallet + OPENING + lançamento. */
export async function seedWallet(balanceMinor: bigint, currency = 'BRL') {
  const walletId = crypto.randomUUID();
  const playerId = `player-${walletId.slice(0, 8)}`;
  await sql.begin(async (tx) => {
    await tx`insert into wallets (id, player_id, currency, balance_minor, version, created_at, updated_at)
             values (${walletId}, ${playerId}, ${currency}, ${balanceMinor}, 1, now(), now())`;
    if (balanceMinor > 0n) {
      const txId = crypto.randomUUID();
      await tx`insert into wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
                 wallet_id, player_id, kind, amount_minor, currency, status, result_balance_minor, created_at, updated_at, processed_at)
               values (${txId}, 'system', ${`opening:${walletId}`}, ${`opening:${walletId}`}, ${HASH},
                 ${walletId}, ${playerId}, 'OPENING', ${balanceMinor}, ${currency}, 'PROCESSED', ${balanceMinor}, now(), now(), now())`;
      await tx`insert into wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount_minor, currency,
                 balance_before_minor, balance_after_minor, created_at)
               values (${crypto.randomUUID()}, ${walletId}, ${txId}, 'CREDIT', ${balanceMinor}, ${currency}, 0, ${balanceMinor}, now())`;
    }
  });
  return { walletId, playerId, currency };
}

export interface Movement {
  kind: 'BET' | 'WIN' | 'REFUND' | 'ROLLBACK';
  amountMinor: bigint;
  direction: 'DEBIT' | 'CREDIT';
  referenceTransactionId?: string;
}

/** Aplica uma movimentação PROCESSED do jeito certo, dentro de `tx`: lock, transação, lançamento e saldo. */
export async function applyMovement(tx: Tx, wallet: { walletId: string; playerId: string; currency: string }, m: Movement) {
  const [atual] = await tx`select balance_minor, version from wallets where id = ${wallet.walletId} for update`;
  const before = BigInt(atual.balance_minor);
  const after = m.direction === 'CREDIT' ? before + m.amountMinor : before - m.amountMinor;
  const txId = crypto.randomUUID();
  const external = `ext-${txId}`;
  await tx`insert into wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
             wallet_id, player_id, round_id, game_id, kind, amount_minor, currency, reference_external_transaction_id,
             reference_transaction_id, status, result_balance_minor, created_at, updated_at, processed_at)
           values (${txId}, 'provider-a', ${external}, ${`provider-a:${external}`}, ${HASH},
             ${wallet.walletId}, ${wallet.playerId}, 'r1', 'g1', ${m.kind}, ${m.amountMinor}, ${wallet.currency},
             ${m.referenceTransactionId ? 'ref' : null}, ${m.referenceTransactionId ?? null},
             'PROCESSED', ${after}, now(), now(), now())`;
  await tx`insert into wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount_minor, currency,
             balance_before_minor, balance_after_minor, created_at)
           values (${crypto.randomUUID()}, ${wallet.walletId}, ${txId}, ${m.direction}, ${m.amountMinor}, ${wallet.currency},
             ${before}, ${after}, now())`;
  await tx`update wallets set balance_minor = ${after}, version = version + 1, updated_at = now() where id = ${wallet.walletId}`;
  return txId;
}
