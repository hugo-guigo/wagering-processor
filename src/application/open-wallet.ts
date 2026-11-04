import { Money, type MoneyProps } from '../domain/money';
import { Wallet } from '../domain/wallet';
import { WagerTransaction } from '../domain/wager-transaction';
import { WalletBalanceChanged } from '../domain/events/wagering-events';
import { OutboxMessage } from '../domain/messaging/outbox-message';
import { WalletAlreadyExistsError, UniqueViolationError } from './errors';
import { canonicalJson } from './payload-hash';
import { createHash } from 'node:crypto';
import type { Clock, IdGenerator, TransactionRunner } from './ports';

export interface OpenWalletCommand {
  playerId: string;
  initialBalance: MoneyProps;
}

export interface OperationContext {
  correlationId: string;
  causationId?: string;
}

/**
 * Cria a wallet. Saldo inicial positivo gera, na mesma transação SQL, a transação interna OPENING,
 * o crédito no ledger e o evento WalletBalanceChanged na outbox.
 */
export class OpenWallet {
  constructor(
    private readonly runner: TransactionRunner,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  async execute(command: OpenWalletCommand, ctx: OperationContext): Promise<Wallet> {
    const initialBalance = Money.from(command.initialBalance);
    const at = this.clock.now();
    const openingTransactionId = this.ids.next();
    const { wallet, openingEntry } = Wallet.open({
      id: this.ids.next(),
      playerId: command.playerId,
      initialBalance,
      at,
      openingTransactionId,
      openingEntryId: this.ids.next(),
    });

    try {
      await this.runner.run(async (store) => {
        store.addWallet(wallet);
        if (!openingEntry) return;
        const hash = createHash('sha256')
          .update(canonicalJson({ walletId: wallet.id, playerId: wallet.playerId, money: initialBalance.toJSON() }))
          .digest('hex');
        store.addTransaction(WagerTransaction.opening({
          id: openingTransactionId, walletId: wallet.id, playerId: wallet.playerId, money: initialBalance, payloadHash: hash, at,
        }));
        store.addLedgerEntry(openingEntry);
        store.enqueue(OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, openingEntry, {
          eventId: this.ids.next(), correlationId: ctx.correlationId, causationId: ctx.causationId, occurredAt: at,
        })));
      });
    } catch (error) {
      if (error instanceof UniqueViolationError && error.constraint === 'wallets_player_currency_uq') {
        throw new WalletAlreadyExistsError(wallet.playerId, wallet.currency);
      }
      throw error;
    }
    return wallet;
  }
}
