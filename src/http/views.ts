import type { Wallet } from '../domain/wallet';
import type { WagerTransaction } from '../domain/wager-transaction';
import type { LedgerPageItem } from '../application/ports';
import type { ReconciliationResult } from '../application/queries';

// Formatos de resposta das consultas. Dinheiro sempre como { amount: "25.00", currency: "BRL" }.

export function walletView(w: Wallet) {
  return {
    id: w.id,
    playerId: w.playerId,
    balance: w.balance.toJSON(),
    version: w.version,
    createdAt: w.createdAt.toISOString(),
    updatedAt: w.updatedAt.toISOString(),
  };
}

export function transactionView(tx: WagerTransaction) {
  return {
    transactionId: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId ?? null,
    gameId: tx.gameId ?? null,
    kind: tx.kind,
    money: tx.money.toJSON(),
    status: tx.status,
    failureCode: tx.failureCode ?? null,
    referenceExternalTransactionId: tx.referenceExternalTransactionId ?? null,
    referenceTransactionId: tx.referenceTransactionId ?? null,
    balance: tx.resultingBalance?.toJSON() ?? null,
    createdAt: tx.createdAt.toISOString(),
    processedAt: tx.processedAt?.toISOString() ?? null,
  };
}

export function ledgerItemView({ entry }: LedgerPageItem) {
  return {
    id: entry.id,
    transactionId: entry.transactionId,
    direction: entry.direction,
    money: entry.money.toJSON(),
    balanceBefore: entry.balanceBefore.toJSON(),
    balanceAfter: entry.balanceAfter.toJSON(),
    createdAt: entry.createdAt.toISOString(),
  };
}

export function reconciliationView(r: ReconciliationResult) {
  return {
    walletId: r.walletId,
    storedBalance: r.storedBalance.toJSON(),
    calculatedBalance: r.calculatedBalance.toJSON(),
    difference: r.difference.toJSON(),
    consistent: r.consistent,
    checkedEntries: r.checkedEntries,
  };
}
