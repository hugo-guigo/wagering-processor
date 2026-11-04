/** Erros da camada de aplicação. A camada HTTP traduz cada um num status. */

/** Payload que nunca seria aceito (400). */
export class InvalidRequestError extends Error {
  readonly code = 'INVALID_REQUEST';

  constructor(message: string, readonly field?: string) {
    super(message);
    this.name = 'InvalidRequestError';
  }
}

/** Mesma idempotency key com outro payload, ou o mesmo id externo sob outra key (409). */
export class IdempotencyConflictError extends Error {
  readonly code = 'IDEMPOTENCY_CONFLICT';

  constructor(message: string, readonly existingTransactionId: string) {
    super(message);
    this.name = 'IdempotencyConflictError';
  }
}

/** Já existe wallet para o playerId nessa moeda (409). */
export class WalletAlreadyExistsError extends Error {
  readonly code = 'WALLET_ALREADY_EXISTS';

  constructor(playerId: string, currency: string) {
    super(`player ${playerId} already has a ${currency} wallet`);
    this.name = 'WalletAlreadyExistsError';
  }
}

/** Unicidade violada no banco. Traduzida da exceção do ORM pela infra, com o nome da constraint. */
export class UniqueViolationError extends Error {
  constructor(readonly constraint: string | undefined, cause?: unknown) {
    super(`unique constraint violated: ${constraint ?? 'unknown'}`, { cause });
    this.name = 'UniqueViolationError';
  }
}

/** Falha que pode passar se tentar de novo: banco fora, timeout de lock, deadlock (503). */
export class TransientInfrastructureError extends Error {
  readonly code = 'TRANSIENT_INFRASTRUCTURE_ERROR';

  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'TransientInfrastructureError';
  }
}

/** Recurso consultado não existe (404). */
export class NotFoundError extends Error {
  readonly code: string;

  constructor(resource: string, id: string) {
    super(`${resource} ${id} not found`);
    this.name = 'NotFoundError';
    this.code = `${resource.toUpperCase()}_NOT_FOUND`;
  }
}
