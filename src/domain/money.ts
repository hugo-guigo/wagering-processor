import { CurrencyMismatchError, InvalidMoneyError } from './errors';

/** Contrato de entrada e saída: valor como string decimal, nunca number. */
export interface MoneyProps {
  amount: string;
  currency: string;
}

// Até 15 dígitos inteiros e no máximo 2 casas. Sem sinal, sem expoente, sem espaço, sem zero à esquerda.
// Recusa por construção: "", "NaN", "Infinity", "1e3", "-1.00", "1.001", "01.00", "1.", ".5", "1,00".
const AMOUNT = /^(0|[1-9]\d{0,14})(?:\.(\d{1,2}))?$/;
const CURRENCY = /^[A-Z]{3}$/;

/**
 * Valor monetário imutável em centavos (`bigint`), com escala fixa de 2 casas.
 * Não existe arredondamento: entrada com mais de 2 casas é recusada, e soma e subtração de inteiros
 * são exatas.
 */
export class Money {
  private constructor(
    private readonly minor: bigint,
    public readonly currency: string,
  ) {
    Object.freeze(this);
  }

  /** Lê um contrato de entrada. Aceita "25", "25.5" e "25.50"; serializa sempre "25.50". */
  static from(props: MoneyProps): Money {
    if (props === null || typeof props !== 'object') {
      throw new InvalidMoneyError('money must be an object with amount and currency');
    }
    const { amount, currency } = props;
    if (typeof amount !== 'string') {
      throw new InvalidMoneyError('amount must be a decimal string');
    }
    const match = AMOUNT.exec(amount);
    if (!match) {
      throw new InvalidMoneyError('amount must be a non-negative decimal with at most 2 decimal places');
    }
    const units = BigInt(match[1] ?? '0');
    const cents = BigInt((match[2] ?? '').padEnd(2, '0'));
    return new Money(units * 100n + cents, Money.validCurrency(currency));
  }

  /** Reconstrói a partir da persistência (centavos). Aceita qualquer sinal: é estado já calculado. */
  static fromMinor(minor: bigint, currency: string): Money {
    return new Money(minor, Money.validCurrency(currency));
  }

  static zero(currency: string): Money {
    return new Money(0n, Money.validCurrency(currency));
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minor + other.minor, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minor - other.minor, this.currency);
  }

  negate(): Money {
    return new Money(-this.minor, this.currency);
  }

  isZero(): boolean {
    return this.minor === 0n;
  }

  isPositive(): boolean {
    return this.minor > 0n;
  }

  isNegative(): boolean {
    return this.minor < 0n;
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.minor < other.minor;
  }

  /** Moedas diferentes não são iguais (não é erro: é uma comparação). */
  equals(other: Money): boolean {
    return this.currency === other.currency && this.minor === other.minor;
  }

  /** Centavos, para a persistência. */
  toMinorUnits(): bigint {
    return this.minor;
  }

  toJSON(): MoneyProps {
    return { amount: this.toString(), currency: this.currency };
  }

  toString(): string {
    const negative = this.minor < 0n;
    const abs = negative ? -this.minor : this.minor;
    const cents = (abs % 100n).toString().padStart(2, '0');
    return `${negative ? '-' : ''}${abs / 100n}.${cents}`;
  }

  private assertSameCurrency(other: Money): void {
    if (other.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }

  private static validCurrency(currency: unknown): string {
    if (typeof currency !== 'string' || !CURRENCY.test(currency)) {
      throw new InvalidMoneyError('currency must be an ISO-4217 code in upper case');
    }
    return currency;
  }
}
