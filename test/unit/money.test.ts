import { describe, expect, test } from 'bun:test';
import { Money } from '../../src/domain/money';
import { CurrencyMismatchError, InvalidMoneyError } from '../../src/domain/errors';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

describe('Money.from: entrada', () => {
  test.each([
    ['25.00', '25.00', 2500n],
    ['25', '25.00', 2500n],
    ['25.5', '25.50', 2550n],
    ['0.01', '0.01', 1n],
    ['0', '0.00', 0n],
    ['999999999999999.99', '999999999999999.99', 99999999999999999n],
  ])('aceita %p e serializa %p', (entrada, saida, centavos) => {
    const money = brl(entrada);
    expect(money.toString()).toBe(saida);
    expect(money.toMinorUnits()).toBe(centavos);
    expect(money.toJSON()).toEqual({ amount: saida, currency: 'BRL' });
  });

  test.each([
    'NaN', 'Infinity', '-Infinity', '', ' ', '1e3', '1E-2', '-1.00', '-0.01', '+1.00',
    '1.001', '10.005', '0.001', '01.00', '1.', '.5', '1,00', ' 1.00', '1.00 ', '0x10',
    '1000000000000000.00',
  ])('recusa %p', (entrada) => {
    expect(() => brl(entrada)).toThrow(InvalidMoneyError);
  });

  test('não arredonda: 10.005 é recusado, não vira 10.01 nem 10.00', () => {
    expect(() => brl('10.005')).toThrow(InvalidMoneyError);
  });

  test.each([25, 25.5, null, undefined, {}])('recusa amount que não é string: %p', (amount) => {
    expect(() => Money.from({ amount: amount as unknown as string, currency: 'BRL' })).toThrow(InvalidMoneyError);
  });

  test.each(['brl', 'BR', 'BRLL', '', 'R$'])('recusa moeda inválida %p', (currency) => {
    expect(() => Money.from({ amount: '1.00', currency })).toThrow(InvalidMoneyError);
  });

  test('recusa props que não são objeto', () => {
    expect(() => Money.from(null as unknown as { amount: string; currency: string })).toThrow(InvalidMoneyError);
  });
});

describe('Money: operações', () => {
  test('soma e subtração exatas, sem erro de ponto flutuante', () => {
    expect(brl('0.10').add(brl('0.20')).toString()).toBe('0.30');
    expect(brl('999999999999999.99').add(brl('0.01')).toString()).toBe('1000000000000000.00');
    expect(brl('100.00').subtract(brl('80.00')).toString()).toBe('20.00');
  });

  test('subtração pode ficar negativa dentro do domínio; negate inverte', () => {
    const negativo = brl('20.00').subtract(brl('80.00'));
    expect(negativo.isNegative()).toBe(true);
    expect(negativo.toString()).toBe('-60.00');
    expect(negativo.negate().toString()).toBe('60.00');
  });

  test('é imutável: operações devolvem nova instância e a original não muda', () => {
    const a = brl('10.00');
    const b = a.add(brl('5.00'));
    expect(a.toString()).toBe('10.00');
    expect(b).not.toBe(a);
    expect(Object.isFrozen(a)).toBe(true);
  });

  test('predicados', () => {
    expect(Money.zero('BRL').isZero()).toBe(true);
    expect(brl('0.01').isPositive()).toBe(true);
    expect(brl('0.01').isNegative()).toBe(false);
    expect(brl('1.00').isLessThan(brl('1.01'))).toBe(true);
    expect(brl('1.00').equals(brl('1'))).toBe(true);
  });

  test('conflito de moeda: soma, subtração e comparação lançam erro; equals só diz que é diferente', () => {
    const usd = Money.from({ amount: '1.00', currency: 'USD' });
    expect(() => brl('1.00').add(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl('1.00').subtract(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl('1.00').isLessThan(usd)).toThrow(CurrencyMismatchError);
    expect(brl('1.00').equals(usd)).toBe(false);
  });

  test('fromMinor reconstrói da persistência', () => {
    expect(Money.fromMinor(9_007_199_254_740_993n, 'BRL').toString()).toBe('90071992547409.93');
  });
});
