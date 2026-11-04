/** Erro de regra do domínio. `code` é estável e legível por máquina. */
export abstract class DomainError extends Error {
  abstract readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Valor monetário inválido na entrada (formato, escala, sinal, moeda). */
export class InvalidMoneyError extends DomainError {
  readonly code = 'INVALID_MONEY';
}

/** Operação entre moedas diferentes. */
export class CurrencyMismatchError extends DomainError {
  readonly code = 'CURRENCY_MISMATCH';

  constructor(expected: string, received: string) {
    super(`currency mismatch: expected ${expected}, received ${received}`);
  }
}

/** Débito maior que o saldo. O caso de uso decide o failureCode (aposta ou reversão). */
export class InsufficientFundsError extends DomainError {
  readonly code = 'INSUFFICIENT_FUNDS';
}

/** Dados que nunca formariam uma transação válida (payload inválido, não regra de negócio). */
export class InvalidWagerTransactionError extends DomainError {
  readonly code = 'INVALID_WAGER_TRANSACTION';
}

export class InvalidWalletError extends DomainError {
  readonly code = 'INVALID_WALLET';
}

export class InvalidLedgerEntryError extends DomainError {
  readonly code = 'INVALID_LEDGER_ENTRY';
}

/** Transição a partir de estado terminal: erro de programação, não caminho de negócio. */
export class InvalidTransactionStateError extends DomainError {
  readonly code = 'INVALID_TRANSACTION_STATE';
}
