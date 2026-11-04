import { describe, expect, test } from 'bun:test';
import { Money } from '../../src/domain/money';
import { Wallet } from '../../src/domain/wallet';
import { LedgerDirection } from '../../src/domain/wallet-ledger-entry';
import { CurrencyMismatchError, InsufficientFundsError, InvalidWalletError } from '../../src/domain/errors';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const t0 = new Date('2026-11-04T12:00:00Z');
const t1 = new Date('2026-11-04T12:00:01Z');
let seq = 0;
const ctx = () => ({ transactionId: `tx-${++seq}`, entryId: `entry-${seq}`, at: t1 });

function abrir(saldo: string) {
  return Wallet.open({ id: 'w1', playerId: 'p1', initialBalance: brl(saldo), at: t0, openingTransactionId: 'tx-open', openingEntryId: 'entry-open' });
}

describe('Wallet.open', () => {
  test('sem saldo inicial: versão 1 e nenhum lançamento', () => {
    const { wallet, openingEntry } = abrir('0.00');
    expect(wallet.version).toBe(1);
    expect(wallet.balance.toString()).toBe('0.00');
    expect(openingEntry).toBeUndefined();
  });

  test('com saldo inicial: crédito de abertura 0 → 1000 e a abertura inteira é a versão 1', () => {
    const { wallet, openingEntry } = abrir('1000.00');
    expect(wallet.version).toBe(1);
    expect(wallet.balance.toString()).toBe('1000.00');
    expect(openingEntry?.direction).toBe(LedgerDirection.Credit);
    expect(openingEntry?.balanceBefore.toString()).toBe('0.00');
    expect(openingEntry?.balanceAfter.toString()).toBe('1000.00');
    expect(openingEntry?.transactionId).toBe('tx-open');
  });

  test('recusa playerId vazio', () => {
    expect(() => Wallet.open({ id: 'w', playerId: ' ', initialBalance: brl('1'), at: t0, openingTransactionId: 'a', openingEntryId: 'b' }))
      .toThrow(InvalidWalletError);
  });
});

describe('Wallet: débito e crédito', () => {
  test('débito gera lançamento, muda o saldo e incrementa a versão', () => {
    const { wallet } = abrir('100.00');
    const entry = wallet.debit(brl('80.00'), ctx());
    expect(wallet.balance.toString()).toBe('20.00');
    expect(wallet.version).toBe(2);
    expect(wallet.updatedAt).toEqual(t1);
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.balanceBefore.toString()).toBe('100.00');
    expect(entry.balanceAfter.toString()).toBe('20.00');
    expect(entry.isBalanced()).toBe(true);
  });

  test('débito sem saldo lança erro e não muda nada (nem saldo, nem versão)', () => {
    const { wallet } = abrir('100.00');
    wallet.debit(brl('80.00'), ctx());
    expect(() => wallet.debit(brl('80.00'), ctx())).toThrow(InsufficientFundsError);
    expect(wallet.balance.toString()).toBe('20.00');
    expect(wallet.version).toBe(2);
  });

  test('débito do saldo exato deixa zero', () => {
    const { wallet } = abrir('80.00');
    wallet.debit(brl('80.00'), ctx());
    expect(wallet.balance.isZero()).toBe(true);
  });

  test('crédito soma e incrementa a versão', () => {
    const { wallet } = abrir('0.00');
    wallet.credit(brl('0.01'), ctx());
    expect(wallet.balance.toString()).toBe('0.01');
    expect(wallet.version).toBe(2);
  });

  test('conflito de moeda em débito e crédito', () => {
    const { wallet } = abrir('100.00');
    const usd = Money.from({ amount: '1.00', currency: 'USD' });
    expect(() => wallet.debit(usd, ctx())).toThrow(CurrencyMismatchError);
    expect(() => wallet.credit(usd, ctx())).toThrow(CurrencyMismatchError);
    expect(wallet.version).toBe(1);
  });

  test('movimentação de valor zero é recusada (não pode haver lançamento sem efeito)', () => {
    const { wallet } = abrir('100.00');
    expect(() => wallet.credit(brl('0'), ctx())).toThrow(InvalidWalletError);
    expect(() => wallet.debit(brl('0'), ctx())).toThrow(InvalidWalletError);
  });

  test('rehydrate reconstrói o estado sem revalidar', () => {
    const wallet = Wallet.rehydrate({
      id: 'w9', playerId: 'p9', currency: 'BRL', balance: brl('42.00'), version: 7, createdAt: t0, updatedAt: t1,
    });
    expect(wallet.version).toBe(7);
    expect(wallet.balance.toString()).toBe('42.00');
  });
});
