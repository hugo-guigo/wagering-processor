import { InvalidTransactionStateError, InvalidWagerTransactionError } from './errors';
import { FailureCode } from './failure-code';
import type { Money } from './money';
import { LedgerDirection } from './wallet-ledger-entry';

export enum WagerTransactionKind {
  Opening = 'OPENING',
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  Pending = 'PENDING',
  PendingReference = 'PENDING_REFERENCE',
  Processed = 'PROCESSED',
  Rejected = 'REJECTED',
  Failed = 'FAILED',
}

const TERMINAL = new Set([WagerTransactionStatus.Processed, WagerTransactionStatus.Rejected, WagerTransactionStatus.Failed]);

/** Que tipo de transação cada kind pode referenciar. BET e OPENING não referenciam nada. */
const ALLOWED_REFERENCES: Partial<Record<WagerTransactionKind, readonly WagerTransactionKind[]>> = {
  [WagerTransactionKind.Win]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Loss]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Refund]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Rollback]: [WagerTransactionKind.Bet, WagerTransactionKind.Win, WagerTransactionKind.Refund],
};

const HASH = /^[0-9a-f]{64}$/;
export const SYSTEM_PROVIDER_ID = 'system';

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt: Date;
}

export interface WagerTransactionState extends Omit<CreateWagerTransactionProps, 'roundId' | 'gameId'> {
  roundId: string | undefined;
  gameId: string | undefined;
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date;
  resultingBalance?: Money;
  referenceAttempts: number;
  nextReferenceAttemptAt?: Date;
  updatedAt: Date;
}

/** Resultado da checagem de uma referência encontrada. */
export type ReferenceCheck =
  | { outcome: 'ok' }
  | { outcome: 'wait' }
  | { outcome: 'reject'; code: FailureCode };

/**
 * Uma operação do provedor (ou a abertura interna da wallet).
 *
 * Transições válidas:
 *   PENDING → PROCESSED | REJECTED | FAILED | PENDING_REFERENCE
 *   PENDING_REFERENCE → PENDING_REFERENCE (nova tentativa) | PROCESSED | REJECTED | FAILED
 *   PROCESSED, REJECTED e FAILED são terminais.
 */
export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string | undefined,
    public readonly gameId: string | undefined,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    /** id no provedor, não o id interno */
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _updatedAt: Date,
    private _referenceAttempts: number,
    private _referenceTransactionId?: string,
    private _failureCode?: FailureCode,
    private _processedAt?: Date,
    private _resultingBalance?: Money,
    private _nextReferenceAttemptAt?: Date,
  ) {}

  /** Operação vinda do provedor. Nasce em PENDING. Valida o formato, não as regras que dependem do saldo. */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (props.kind === WagerTransactionKind.Opening) {
      throw new InvalidWagerTransactionError('OPENING is internal and cannot be submitted');
    }
    for (const field of ['providerId', 'externalTransactionId', 'idempotencyKey', 'walletId', 'playerId', 'roundId', 'gameId'] as const) {
      if (props[field].trim() === '') {
        throw new InvalidWagerTransactionError(`${field} is required`);
      }
    }
    if (!HASH.test(props.payloadHash)) {
      throw new InvalidWagerTransactionError('payloadHash must be a hex SHA-256');
    }
    if (props.money.isNegative() || (props.money.isZero() && props.kind !== WagerTransactionKind.Loss)) {
      throw new InvalidWagerTransactionError(`${props.kind} amount must be positive`);
    }
    const reference = props.referenceExternalTransactionId;
    const requires = props.kind === WagerTransactionKind.Refund || props.kind === WagerTransactionKind.Rollback;
    if (requires && !reference) {
      throw new InvalidWagerTransactionError(`${props.kind} requires referenceExternalTransactionId`);
    }
    if (reference !== undefined && ALLOWED_REFERENCES[props.kind] === undefined) {
      throw new InvalidWagerTransactionError(`${props.kind} cannot reference another transaction`);
    }
    if (reference !== undefined && reference === props.externalTransactionId) {
      throw new InvalidWagerTransactionError('a transaction cannot reference itself');
    }
    return new WagerTransaction(
      props.id, props.providerId, props.externalTransactionId, props.idempotencyKey, props.payloadHash,
      props.walletId, props.playerId, props.roundId, props.gameId, props.kind, props.money,
      reference, props.createdAt, WagerTransactionStatus.Pending, props.createdAt, 0,
    );
  }

  /** Transação interna de abertura da wallet, já PROCESSED junto com a criação. */
  static opening(props: {
    id: string;
    walletId: string;
    playerId: string;
    money: Money;
    payloadHash: string;
    at: Date;
  }): WagerTransaction {
    const key = `opening:${props.walletId}`;
    return new WagerTransaction(
      props.id, SYSTEM_PROVIDER_ID, key, key, props.payloadHash, props.walletId, props.playerId,
      undefined, undefined, WagerTransactionKind.Opening, props.money, undefined, props.at,
      WagerTransactionStatus.Processed, props.at, 0, undefined, undefined, props.at, props.money,
    );
  }

  /** Reconstrução a partir da persistência; não revalida transições. */
  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id, state.providerId, state.externalTransactionId, state.idempotencyKey, state.payloadHash,
      state.walletId, state.playerId, state.roundId, state.gameId, state.kind, state.money,
      state.referenceExternalTransactionId, new Date(state.createdAt), state.status, new Date(state.updatedAt),
      state.referenceAttempts, state.referenceTransactionId, state.failureCode, state.processedAt,
      state.resultingBalance, state.nextReferenceAttemptAt,
    );
  }

  get status(): WagerTransactionStatus { return this._status; }
  get referenceTransactionId(): string | undefined { return this._referenceTransactionId; }
  get failureCode(): FailureCode | undefined { return this._failureCode; }
  get processedAt(): Date | undefined { return this._processedAt; }
  get updatedAt(): Date { return this._updatedAt; }
  /** Saldo da wallet observado quando a transação chegou ao estado atual. É o que o replay devolve. */
  get resultingBalance(): Money | undefined { return this._resultingBalance; }
  get referenceAttempts(): number { return this._referenceAttempts; }
  get nextReferenceAttemptAt(): Date | undefined { return this._nextReferenceAttemptAt; }

  // ---- transições

  markProcessed(props: { referenceTransactionId?: string; at: Date; resultingBalance: Money }): void {
    this.assertNotTerminal('markProcessed');
    if (this.requiresReference() && !props.referenceTransactionId) {
      throw new InvalidTransactionStateError(`${this.kind} cannot be processed without its reference`);
    }
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = props.referenceTransactionId;
    this._processedAt = props.at;
    this._resultingBalance = props.resultingBalance;
    this._nextReferenceAttemptAt = undefined;
    this._updatedAt = props.at;
  }

  /** Primeira vez que a referência não foi encontrada. */
  markPendingReference(props: { nextAttemptAt: Date; at: Date; currentBalance?: Money }): void {
    if (this._status !== WagerTransactionStatus.Pending) {
      throw new InvalidTransactionStateError(`markPendingReference from ${this._status}`);
    }
    if (!this.hasReference()) {
      throw new InvalidTransactionStateError(`${this.kind} has no reference to wait for`);
    }
    this._status = WagerTransactionStatus.PendingReference;
    this._nextReferenceAttemptAt = props.nextAttemptAt;
    this._resultingBalance = props.currentBalance;
    this._updatedAt = props.at;
  }

  /** O worker tentou de novo e a referência ainda não existe. */
  scheduleReferenceRetry(props: { nextAttemptAt: Date; at: Date }): void {
    if (this._status !== WagerTransactionStatus.PendingReference) {
      throw new InvalidTransactionStateError(`scheduleReferenceRetry from ${this._status}`);
    }
    this._referenceAttempts += 1;
    this._nextReferenceAttemptAt = props.nextAttemptAt;
    this._updatedAt = props.at;
  }

  reject(code: FailureCode, props: { at: Date; currentBalance?: Money }): void {
    this.assertNotTerminal('reject');
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
    this._resultingBalance = props.currentBalance;
    this._nextReferenceAttemptAt = undefined;
    this._updatedAt = props.at;
  }

  fail(code: FailureCode, props: { at: Date }): void {
    this.assertNotTerminal('fail');
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
    this._nextReferenceAttemptAt = undefined;
    this._updatedAt = props.at;
  }

  // ---- consultas

  isTerminal(): boolean {
    return TERMINAL.has(this._status);
  }

  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback;
  }

  hasReference(): boolean {
    return this.referenceExternalTransactionId !== undefined;
  }

  isReversal(): boolean {
    return this.requiresReference();
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /**
   * Direção do lançamento. ROLLBACK inverte a direção da referência: desfaz um débito (BET) com
   * crédito e um crédito (WIN, REFUND) com débito. LOSS não gera lançamento.
   */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Opening:
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Rollback: {
        if (!reference) {
          throw new InvalidTransactionStateError('ROLLBACK needs its reference to know the direction');
        }
        return reference.ledgerDirectionFor() === LedgerDirection.Debit ? LedgerDirection.Credit : LedgerDirection.Debit;
      }
      case WagerTransactionKind.Loss:
        throw new InvalidTransactionStateError('LOSS does not produce a ledger entry');
    }
  }

  /**
   * Confere uma referência já encontrada por (providerId, referenceExternalTransactionId).
   * "wait" quando a referência ainda não terminou: a transação fica PENDING_REFERENCE.
   * "Já revertida" não é checado aqui: depende de outras linhas do banco (caso de uso + índice único).
   */
  checkReference(reference: WagerTransaction): ReferenceCheck {
    const allowed = ALLOWED_REFERENCES[this.kind];
    if (!allowed || !this.hasReference()) {
      throw new InvalidTransactionStateError(`${this.kind} has no reference to check`);
    }
    if (!allowed.includes(reference.kind)) {
      return { outcome: 'reject', code: FailureCode.ReferenceKindNotAllowed };
    }
    const sameContext = reference.providerId === this.providerId
      && reference.playerId === this.playerId
      && reference.walletId === this.walletId
      && reference.roundId === this.roundId
      && reference.money.currency === this.money.currency;
    if (!sameContext) {
      return { outcome: 'reject', code: FailureCode.ReferenceMismatch };
    }
    if (reference.status === WagerTransactionStatus.Pending || reference.status === WagerTransactionStatus.PendingReference) {
      return { outcome: 'wait' };
    }
    if (reference.status !== WagerTransactionStatus.Processed) {
      return { outcome: 'reject', code: FailureCode.ReferenceNotProcessed };
    }
    if (this.isReversal() && !reference.money.equals(this.money)) {
      return { outcome: 'reject', code: FailureCode.ReferenceAmountMismatch };
    }
    return { outcome: 'ok' };
  }

  private assertNotTerminal(transition: string): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(`${transition} on terminal transaction ${this.id} (${this._status})`);
    }
  }
}
