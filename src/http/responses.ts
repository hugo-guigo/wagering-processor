import { WagerTransactionStatus, type WagerTransaction } from '../domain/wager-transaction';
import { FailureCode } from '../domain/failure-code';
import type { MoneyProps } from '../domain/money';
import type { WagerOutcome } from '../application/process-wager-transaction';

/**
 * Status HTTP por resultado, igual em todos os endpoints e nas repetições:
 * 201 processada, 202 aceita aguardando referência, 422 rejeitada por regra de negócio (com
 * failureCode), 500 FAILED. 400, 409 e 503 vêm do filtro de erros.
 */
const STATUS_BY_TRANSACTION: Record<WagerTransactionStatus, number> = {
  [WagerTransactionStatus.Processed]: 201,
  [WagerTransactionStatus.PendingReference]: 202,
  [WagerTransactionStatus.Pending]: 202,
  [WagerTransactionStatus.Rejected]: 422,
  [WagerTransactionStatus.Failed]: 500,
};

export interface WagerResponseBody {
  transactionId: string | null;
  status: string;
  balance: MoneyProps | null;
  failureCode?: string;
  idempotentReplay: boolean;
}

export function wagerResponse(outcome: WagerOutcome): { status: number; body: WagerResponseBody } {
  if (outcome.type === 'walletNotFound') {
    return {
      status: 422,
      body: { transactionId: null, status: WagerTransactionStatus.Rejected, balance: null, failureCode: FailureCode.WalletNotFound, idempotentReplay: false },
    };
  }
  return { status: STATUS_BY_TRANSACTION[outcome.transaction.status], body: transactionBody(outcome.transaction, outcome.replay) };
}

/** O replay devolve o estado gravado, incluindo o saldo observado naquele momento. */
export function transactionBody(tx: WagerTransaction, replay: boolean): WagerResponseBody {
  return {
    transactionId: tx.id,
    status: tx.status,
    balance: tx.resultingBalance?.toJSON() ?? null,
    ...(tx.failureCode === undefined ? {} : { failureCode: tx.failureCode }),
    idempotentReplay: replay,
  };
}
