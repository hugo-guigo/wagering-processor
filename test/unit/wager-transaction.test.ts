import { describe, expect, test } from 'bun:test';
import { Money } from '../../src/domain/money';
import {
  WagerTransaction, WagerTransactionKind as Kind, WagerTransactionStatus as Status,
  type CreateWagerTransactionProps,
} from '../../src/domain/wager-transaction';
import { LedgerDirection } from '../../src/domain/wallet-ledger-entry';
import { FailureCode } from '../../src/domain/failure-code';
import { InvalidTransactionStateError, InvalidWagerTransactionError } from '../../src/domain/errors';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const at = new Date('2026-11-04T12:00:00Z');
const HASH_A = 'a'.repeat(64);
let n = 0;

function tx(over: Partial<CreateWagerTransactionProps> = {}): WagerTransaction {
  n += 1;
  return WagerTransaction.create({
    id: `id-${n}`, providerId: 'provider-a', externalTransactionId: `ext-${n}`, idempotencyKey: `provider-a:ext-${n}`,
    payloadHash: HASH_A, walletId: 'w1', playerId: 'p1', roundId: 'r1', gameId: 'g1',
    kind: Kind.Bet, money: brl('25.00'), createdAt: at, ...over,
  });
}

function processado(over: Partial<CreateWagerTransactionProps> = {}): WagerTransaction {
  const t = tx(over);
  t.markProcessed({ at, resultingBalance: brl('100'), referenceTransactionId: t.requiresReference() ? 'ref' : undefined });
  return t;
}

describe('WagerTransaction.create', () => {
  test('nasce PENDING', () => {
    expect(tx().status).toBe(Status.Pending);
  });

  test('OPENING não pode ser submetido', () => {
    expect(() => tx({ kind: Kind.Opening })).toThrow(InvalidWagerTransactionError);
  });

  test.each([Kind.Refund, Kind.Rollback])('%s sem referência é payload inválido', (kind) => {
    expect(() => tx({ kind })).toThrow(InvalidWagerTransactionError);
  });

  test('BET não referencia nada', () => {
    expect(() => tx({ kind: Kind.Bet, referenceExternalTransactionId: 'x' })).toThrow(InvalidWagerTransactionError);
  });

  test('não pode referenciar a si mesma', () => {
    expect(() => tx({ kind: Kind.Refund, externalTransactionId: 'e', referenceExternalTransactionId: 'e' })).toThrow(InvalidWagerTransactionError);
  });

  test('valor zero só em LOSS', () => {
    expect(tx({ kind: Kind.Loss, money: brl('0') }).affectsBalance()).toBe(false);
    for (const kind of [Kind.Bet, Kind.Win]) {
      expect(() => tx({ kind, money: brl('0') })).toThrow(InvalidWagerTransactionError);
    }
  });

  test('campos obrigatórios e hash no formato SHA-256', () => {
    expect(() => tx({ roundId: '' })).toThrow(InvalidWagerTransactionError);
    expect(() => tx({ payloadHash: 'abc' })).toThrow(InvalidWagerTransactionError);
  });
});

describe('transições', () => {
  test('PROCESSED, REJECTED e FAILED são terminais: qualquer nova transição é erro de programação', () => {
    const p = processado();
    const r = tx(); r.reject(FailureCode.InsufficientFunds, { at });
    const f = tx(); f.fail(FailureCode.PermanentProcessingError, { at });
    for (const t of [p, r, f]) {
      expect(t.isTerminal()).toBe(true);
      expect(() => t.markProcessed({ at, resultingBalance: brl('1') })).toThrow(InvalidTransactionStateError);
      expect(() => t.reject(FailureCode.InsufficientFunds, { at })).toThrow(InvalidTransactionStateError);
      expect(() => t.fail(FailureCode.PermanentProcessingError, { at })).toThrow(InvalidTransactionStateError);
    }
  });

  test('processada guarda o saldo observado, que o replay devolve', () => {
    const t = tx();
    t.markProcessed({ at, resultingBalance: brl('975.00') });
    expect(t.resultingBalance?.toString()).toBe('975.00');
    expect(t.processedAt).toEqual(at);
  });

  test('rejeitada guarda o failureCode', () => {
    const t = tx();
    t.reject(FailureCode.InsufficientFunds, { at, currentBalance: brl('20') });
    expect(t.status).toBe(Status.Rejected);
    expect(t.failureCode).toBe(FailureCode.InsufficientFunds);
  });

  test('REFUND não vira PROCESSED sem o id interno da referência', () => {
    const t = tx({ kind: Kind.Refund, referenceExternalTransactionId: 'bet-1' });
    expect(() => t.markProcessed({ at, resultingBalance: brl('1') })).toThrow(InvalidTransactionStateError);
  });

  test('PENDING_REFERENCE: agenda, reagenda contando tentativas e depois termina', () => {
    const t = tx({ kind: Kind.Refund, referenceExternalTransactionId: 'bet-1' });
    const depois = new Date(at.getTime() + 1000);
    t.markPendingReference({ nextAttemptAt: depois, at });
    expect(t.status).toBe(Status.PendingReference);
    expect(t.referenceAttempts).toBe(0);
    t.scheduleReferenceRetry({ nextAttemptAt: new Date(depois.getTime() + 2000), at: depois });
    expect(t.referenceAttempts).toBe(1);
    t.reject(FailureCode.ReferenceNotFound, { at: depois });
    expect(t.nextReferenceAttemptAt).toBeUndefined();
    expect(() => t.scheduleReferenceRetry({ nextAttemptAt: depois, at })).toThrow(InvalidTransactionStateError);
  });

  test('só fica PENDING_REFERENCE quem tem referência, e só a partir de PENDING', () => {
    expect(() => tx().markPendingReference({ nextAttemptAt: at, at })).toThrow(InvalidTransactionStateError);
  });
});

describe('regras por kind', () => {
  test('direção do lançamento: BET débito; WIN, REFUND e OPENING crédito; LOSS nenhum', () => {
    expect(tx({ kind: Kind.Bet }).ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(tx({ kind: Kind.Win }).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(tx({ kind: Kind.Refund, referenceExternalTransactionId: 'b' }).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(() => tx({ kind: Kind.Loss }).ledgerDirectionFor()).toThrow(InvalidTransactionStateError);
    expect(tx({ kind: Kind.Loss }).affectsBalance()).toBe(false);
  });

  test('ROLLBACK inverte a referência: de BET vira crédito, de WIN ou REFUND vira débito', () => {
    const rollback = tx({ kind: Kind.Rollback, referenceExternalTransactionId: 'x' });
    expect(rollback.ledgerDirectionFor(processado({ kind: Kind.Bet }))).toBe(LedgerDirection.Credit);
    expect(rollback.ledgerDirectionFor(processado({ kind: Kind.Win }))).toBe(LedgerDirection.Debit);
    expect(rollback.ledgerDirectionFor(processado({ kind: Kind.Refund, referenceExternalTransactionId: 'b' }))).toBe(LedgerDirection.Debit);
    expect(() => rollback.ledgerDirectionFor()).toThrow(InvalidTransactionStateError);
  });

  test('requiresReference só em REFUND e ROLLBACK', () => {
    expect(tx({ kind: Kind.Refund, referenceExternalTransactionId: 'b' }).requiresReference()).toBe(true);
    expect(tx({ kind: Kind.Rollback, referenceExternalTransactionId: 'b' }).requiresReference()).toBe(true);
    expect(tx({ kind: Kind.Win }).requiresReference()).toBe(false);
  });

  test('idempotency key com payload divergente não casa com a transação gravada', () => {
    const gravada = tx();
    expect(gravada.matchesPayload(HASH_A)).toBe(true);
    expect(gravada.matchesPayload('b'.repeat(64))).toBe(false);
  });
});

describe('checkReference', () => {
  const refund = () => tx({ kind: Kind.Refund, referenceExternalTransactionId: 'bet' });
  const rollback = () => tx({ kind: Kind.Rollback, referenceExternalTransactionId: 'x' });

  test('REFUND de BET processada com o mesmo valor: ok', () => {
    expect(refund().checkReference(processado({ kind: Kind.Bet }))).toEqual({ outcome: 'ok' });
  });

  test('REFUND só referencia BET; ROLLBACK aceita BET, WIN e REFUND, mas não LOSS', () => {
    expect(refund().checkReference(processado({ kind: Kind.Win })))
      .toEqual({ outcome: 'reject', code: FailureCode.ReferenceKindNotAllowed });
    expect(rollback().checkReference(processado({ kind: Kind.Win }))).toEqual({ outcome: 'ok' });
    expect(rollback().checkReference(processado({ kind: Kind.Loss })))
      .toEqual({ outcome: 'reject', code: FailureCode.ReferenceKindNotAllowed });
  });

  test.each([
    ['player', { playerId: 'outro' }],
    ['wallet', { walletId: 'outra' }],
    ['rodada', { roundId: 'outra' }],
    ['moeda', { money: Money.from({ amount: '25.00', currency: 'USD' }) }],
    ['provider', { providerId: 'provider-b' }],
  ])('referência de outro(a) %s: REFERENCE_MISMATCH', (_, diferente) => {
    expect(refund().checkReference(processado({ kind: Kind.Bet, ...diferente })))
      .toEqual({ outcome: 'reject', code: FailureCode.ReferenceMismatch });
  });

  test('referência ainda pendente: espera', () => {
    expect(refund().checkReference(tx({ kind: Kind.Bet }))).toEqual({ outcome: 'wait' });
  });

  test('referência rejeitada: não há o que reverter', () => {
    const bet = tx({ kind: Kind.Bet });
    bet.reject(FailureCode.InsufficientFunds, { at });
    expect(refund().checkReference(bet)).toEqual({ outcome: 'reject', code: FailureCode.ReferenceNotProcessed });
  });

  test('reversão parcial é recusada', () => {
    expect(refund().checkReference(processado({ kind: Kind.Bet, money: brl('10.00') })))
      .toEqual({ outcome: 'reject', code: FailureCode.ReferenceAmountMismatch });
  });
});

test('OPENING interno nasce PROCESSED com o saldo de abertura', () => {
  const opening = WagerTransaction.opening({ id: 'o1', walletId: 'w1', playerId: 'p1', money: brl('1000'), payloadHash: HASH_A, at });
  expect(opening.status).toBe(Status.Processed);
  expect(opening.kind).toBe(Kind.Opening);
  expect(opening.idempotencyKey).toBe('opening:w1');
  expect(opening.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
});
