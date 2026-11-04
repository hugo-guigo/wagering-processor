import type { Wallet } from '../domain/wallet';
import type { WagerTransaction } from '../domain/wager-transaction';
import type { WalletLedgerEntry } from '../domain/wallet-ledger-entry';
import type { OutboxMessage } from '../domain/messaging/outbox-message';
import type { InboxMessage } from '../domain/messaging/inbox-message';

export interface LedgerPageItem {
  entry: WalletLedgerEntry;
  /** Posição estável no ledger (identity), usada no cursor. */
  seq: bigint;
}

/**
 * Acesso ao banco dentro de UMA transação SQL. Tudo o que é adicionado aqui é gravado junto no
 * COMMIT, ou nada é. As portas são classes abstratas para servirem de token de injeção no Nest.
 */
export abstract class WalletStore {
  /** SELECT ... FOR UPDATE na linha da wallet: serializa as operações da mesma wallet. */
  abstract lockWallet(walletId: string): Promise<Wallet | undefined>;
  /** Leitura sem trava (consultas). */
  abstract findWallet(walletId: string): Promise<Wallet | undefined>;
  abstract addWallet(wallet: Wallet): void;
  abstract saveWallet(wallet: Wallet): void;

  abstract findTransactionById(id: string): Promise<WagerTransaction | undefined>;
  abstract findTransactionByIdempotencyKey(key: string): Promise<WagerTransaction | undefined>;
  abstract findTransactionByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined>;
  /** Já existe REFUND ou ROLLBACK PROCESSED apontando para essa transação? */
  abstract hasProcessedReversal(referenceTransactionId: string): Promise<boolean>;
  abstract addTransaction(tx: WagerTransaction): void;
  abstract saveTransaction(tx: WagerTransaction): void;

  abstract addLedgerEntry(entry: WalletLedgerEntry): void;
  /** Extrato do mais novo para o mais antigo, a partir de um `seq` exclusivo. */
  abstract listLedger(walletId: string, beforeSeq: bigint | undefined, limit: number): Promise<LedgerPageItem[]>;
  /** Soma com sinal (créditos menos débitos) e quantidade de lançamentos da wallet. */
  abstract ledgerTotals(walletId: string): Promise<{ netMinor: bigint; entries: number }>;
  abstract enqueue(message: OutboxMessage): void;
  abstract addInboxMessage(message: InboxMessage, transactionId?: string): void;
  abstract findInboxMessage(consumerName: string, messageId: string): Promise<InboxMessage | undefined>;

  /**
   * Uma transação PENDING_REFERENCE vencida, travada com FOR UPDATE SKIP LOCKED: vários workers
   * (em várias instâncias) pegam linhas diferentes sem se esperar.
   */
  abstract claimDuePendingReference(now: Date): Promise<WagerTransaction | undefined>;
  /** Lote de eventos não publicados e vencidos, travados com FOR UPDATE SKIP LOCKED. */
  abstract claimDueOutbox(now: Date, limit: number): Promise<OutboxMessage[]>;
  abstract saveOutbox(message: OutboxMessage, lastError?: string): void;
}

/** Envia eventos para o broker. Devolve, por id, o erro dos que falharam. */
export abstract class EventPublisher {
  abstract publish(messages: OutboxMessage[]): Promise<Map<string, string>>;
}

export abstract class TransactionRunner {
  /** Abre uma transação SQL, entrega o `WalletStore` dela e faz COMMIT no fim (ROLLBACK se lançar). */
  abstract run<T>(work: (store: WalletStore) => Promise<T>): Promise<T>;
}

export abstract class IdGenerator {
  abstract next(): string;
}

export abstract class Clock {
  abstract now(): Date;
}
