import { CurrencyMismatchError, InsufficientFundsError, InvalidWalletError } from './errors';
import { Money } from './money';
import { LedgerDirection, WalletLedgerEntry } from './wallet-ledger-entry';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

/** Identificação do lançamento que uma movimentação vai gerar. */
export interface MovementContext {
  transactionId: string;
  entryId: string;
  at: Date;
}

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
  at: Date;
  /** Usados só se o saldo inicial for maior que zero (transação OPENING e seu lançamento). */
  openingTransactionId: string;
  openingEntryId: string;
}

export interface OpenedWallet {
  wallet: Wallet;
  openingEntry?: WalletLedgerEntry;
}

/**
 * Aggregate root da carteira. O saldo só muda por `debit` e `credit`, e cada mudança devolve o
 * lançamento correspondente: não há como mexer no saldo sem gerar ledger.
 */
export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  /**
   * Abre a carteira com `version` 1. Saldo inicial positivo vira um crédito de abertura no ledger
   * (0 → saldo inicial), e a abertura inteira conta como a versão 1.
   */
  static open(props: OpenWalletProps): OpenedWallet {
    if (props.playerId.trim() === '') {
      throw new InvalidWalletError('playerId is required');
    }
    if (props.initialBalance.isNegative()) {
      throw new InvalidWalletError('initial balance cannot be negative');
    }
    const currency = props.initialBalance.currency;
    if (props.initialBalance.isZero()) {
      return { wallet: new Wallet(props.id, props.playerId, currency, Money.zero(currency), 1, props.at, props.at) };
    }
    // Nasce na versão 0 só dentro desta função: o crédito de abertura a leva para 1.
    const wallet = new Wallet(props.id, props.playerId, currency, Money.zero(currency), 0, props.at, props.at);
    const openingEntry = wallet.move(LedgerDirection.Credit, props.initialBalance, {
      transactionId: props.openingTransactionId,
      entryId: props.openingEntryId,
      at: props.at,
    });
    return { wallet, openingEntry };
  }

  /** Reconstrução a partir da persistência; não revalida transições. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      new Date(state.createdAt),
      new Date(state.updatedAt),
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  /** Débito. Saldo insuficiente lança `InsufficientFundsError` sem mudar nada. */
  debit(money: Money, ctx: MovementContext): WalletLedgerEntry {
    this.assertMovable(money);
    if (this._balance.isLessThan(money)) {
      throw new InsufficientFundsError(`wallet ${this.id} has insufficient funds`);
    }
    return this.move(LedgerDirection.Debit, money, ctx);
  }

  credit(money: Money, ctx: MovementContext): WalletLedgerEntry {
    this.assertMovable(money);
    return this.move(LedgerDirection.Credit, money, ctx);
  }

  /** Aplica a movimentação. O lançamento é criado antes de mudar o estado: se ele falhar, nada muda. */
  private move(direction: LedgerDirection, money: Money, ctx: MovementContext): WalletLedgerEntry {
    const before = this._balance;
    const after = direction === LedgerDirection.Credit ? before.add(money) : before.subtract(money);
    const entry = WalletLedgerEntry.create({
      id: ctx.entryId,
      walletId: this.id,
      transactionId: ctx.transactionId,
      direction,
      money,
      balanceBefore: before,
      balanceAfter: after,
      createdAt: ctx.at,
    });
    this._balance = after;
    this._version += 1;
    this._updatedAt = ctx.at;
    return entry;
  }

  private assertMovable(money: Money): void {
    this.assertSameCurrency(money);
    if (!money.isPositive()) {
      throw new InvalidWalletError('movement amount must be positive');
    }
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }
}
