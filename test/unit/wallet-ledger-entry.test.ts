import { expect, test } from 'bun:test';
import { Money } from '../../src/domain/money';
import { LedgerDirection, WalletLedgerEntry } from '../../src/domain/wallet-ledger-entry';
import { InvalidLedgerEntryError } from '../../src/domain/errors';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const base = {
  id: 'e1', walletId: 'w1', transactionId: 't1', createdAt: new Date('2026-11-04T12:00:00Z'),
};

test('create aceita aritmética certa nas duas direções', () => {
  const debito = WalletLedgerEntry.create({ ...base, direction: LedgerDirection.Debit, money: brl('30'), balanceBefore: brl('100'), balanceAfter: brl('70') });
  const credito = WalletLedgerEntry.create({ ...base, direction: LedgerDirection.Credit, money: brl('30'), balanceBefore: brl('100'), balanceAfter: brl('130') });
  expect(debito.isBalanced()).toBe(true);
  expect(credito.isBalanced()).toBe(true);
});

test('create recusa aritmética errada, valor zero, saldo negativo e moedas misturadas', () => {
  const casos = [
    { direction: LedgerDirection.Debit, money: brl('30'), balanceBefore: brl('100'), balanceAfter: brl('80') },
    { direction: LedgerDirection.Credit, money: brl('0'), balanceBefore: brl('100'), balanceAfter: brl('100') },
    { direction: LedgerDirection.Debit, money: brl('30'), balanceBefore: brl('10'), balanceAfter: brl('10').subtract(brl('30')) },
    { direction: LedgerDirection.Credit, money: Money.from({ amount: '1', currency: 'USD' }), balanceBefore: brl('1'), balanceAfter: brl('2') },
  ];
  for (const caso of casos) {
    expect(() => WalletLedgerEntry.create({ ...base, ...caso })).toThrow(InvalidLedgerEntryError);
  }
});

test('é imutável na estrutura: objeto congelado, sem setters nem transições', () => {
  const entry = WalletLedgerEntry.create({ ...base, direction: LedgerDirection.Credit, money: brl('1'), balanceBefore: brl('0'), balanceAfter: brl('1') });
  expect(Object.isFrozen(entry)).toBe(true);
  expect(() => { (entry as unknown as { money: Money }).money = brl('999'); }).toThrow(TypeError);
});
