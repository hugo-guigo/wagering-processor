import type { Wallet } from '../domain/wallet';
import type { WagerTransaction } from '../domain/wager-transaction';
import type { WalletLedgerEntry } from '../domain/wallet-ledger-entry';
import type { OutboxMessage } from '../domain/messaging/outbox-message';
import type { InboxMessage } from '../domain/messaging/inbox-message';

/**
 * Acesso ao banco dentro de UMA transação SQL. Tudo o que é adicionado aqui é gravado junto no
 * COMMIT, ou nada é. As portas são classes abstratas para servirem de token de injeção no Nest.
 */
export abstract class WalletStore {
  /** SELECT ... FOR UPDATE na linha da wallet: serializa as operações da mesma wallet. */
  abstract lockWallet(walletId: string): Promise<Wallet | undefined>;
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
  abstract enqueue(message: OutboxMessage): void;
  abstract addInboxMessage(message: InboxMessage, transactionId?: string): void;
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
