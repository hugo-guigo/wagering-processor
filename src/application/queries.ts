import { Money } from '../domain/money';
import type { Wallet } from '../domain/wallet';
import type { WagerTransaction } from '../domain/wager-transaction';
import { InvalidRequestError, NotFoundError } from './errors';
import type { LedgerPageItem, TransactionRunner } from './ports';

export interface LedgerPage {
  items: LedgerPageItem[];
  nextCursor: string | null;
}

export const LEDGER_PAGE = { default: 50, max: 200 } as const;

/**
 * Cursor opaco: base64url de `{"v":1,"seq":"<seq>"}`. Estável porque `seq` é a ordem de inserção
 * e o ledger só recebe INSERT: um lançamento novo nunca muda o que já foi paginado.
 */
export function encodeCursor(seq: bigint): string {
  return Buffer.from(JSON.stringify({ v: 1, seq: seq.toString() })).toString('base64url');
}

export function decodeCursor(cursor: string): bigint {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { v?: number; seq?: string };
    if (parsed.v !== 1 || typeof parsed.seq !== 'string' || !/^\d{1,19}$/.test(parsed.seq)) throw new Error('bad cursor');
    return BigInt(parsed.seq);
  } catch {
    throw new InvalidRequestError('invalid cursor', 'cursor');
  }
}

export class WalletQueries {
  constructor(private readonly runner: TransactionRunner) {}

  async wallet(walletId: string): Promise<Wallet> {
    const wallet = await this.runner.run((store) => store.findWallet(walletId));
    if (!wallet) throw new NotFoundError('wallet', walletId);
    return wallet;
  }

  async transaction(transactionId: string): Promise<WagerTransaction> {
    const tx = await this.runner.run((store) => store.findTransactionById(transactionId));
    if (!tx) throw new NotFoundError('transaction', transactionId);
    return tx;
  }

  async transactionByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction> {
    const tx = await this.runner.run((store) => store.findTransactionByExternalId(providerId, externalTransactionId));
    if (!tx) throw new NotFoundError('transaction', `${providerId}/${externalTransactionId}`);
    return tx;
  }

  async ledger(walletId: string, cursor: string | undefined, limit: number = LEDGER_PAGE.default): Promise<LedgerPage> {
    if (!Number.isInteger(limit) || limit < 1 || limit > LEDGER_PAGE.max) {
      throw new InvalidRequestError(`limit must be between 1 and ${LEDGER_PAGE.max}`, 'limit');
    }
    const before = cursor === undefined ? undefined : decodeCursor(cursor);
    return this.runner.run(async (store) => {
      if (!(await store.findWallet(walletId))) throw new NotFoundError('wallet', walletId);
      // Pede um a mais para saber se existe próxima página sem uma consulta extra.
      const rows = await store.listLedger(walletId, before, limit + 1);
      const items = rows.slice(0, limit);
      const last = items.at(-1);
      return { items, nextCursor: rows.length > limit && last ? encodeCursor(last.seq) : null };
    });
  }
}

export interface ReconciliationResult {
  walletId: string;
  storedBalance: Money;
  calculatedBalance: Money;
  difference: Money;
  consistent: boolean;
  checkedEntries: number;
}

/**
 * Compara o saldo materializado com o saldo reconstruído pelo ledger. A wallet é travada durante a
 * leitura para que nenhuma operação entre entre as duas somas. Divergência é relatada, nunca
 * corrigida aqui: corrigir esconderia o bug que a causou.
 */
export class ReconcileWallet {
  constructor(private readonly runner: TransactionRunner) {}

  async execute(walletId: string): Promise<ReconciliationResult> {
    return this.runner.run(async (store) => {
      const wallet = await store.lockWallet(walletId);
      if (!wallet) throw new NotFoundError('wallet', walletId);
      const { netMinor, entries } = await store.ledgerTotals(walletId);
      const calculated = Money.fromMinor(netMinor, wallet.currency);
      const difference = wallet.balance.subtract(calculated);
      return {
        walletId,
        storedBalance: wallet.balance,
        calculatedBalance: calculated,
        difference,
        consistent: difference.isZero(),
        checkedEntries: entries,
      };
    });
  }
}
