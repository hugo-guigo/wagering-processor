// Validação de formato da entrada HTTP. Regras de valor (Money) e de negócio ficam no domínio.
import { InvalidRequestError } from '../application/errors';
import type { MoneyProps } from '../domain/money';
import type { WagerPayload } from '../application/payload-hash';

const MAX_ID_LENGTH = 200;

export function asObject(value: unknown, field = 'body'): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidRequestError(`${field} must be a JSON object`, field);
  }
  return value as Record<string, unknown>;
}

export function requireString(source: Record<string, unknown>, field: string): string {
  const value = source[field];
  if (typeof value !== 'string' || value.trim() === '' || value.length > MAX_ID_LENGTH) {
    throw new InvalidRequestError(`${field} must be a non-empty string up to ${MAX_ID_LENGTH} characters`, field);
  }
  return value;
}

export function optionalString(source: Record<string, unknown>, field: string): string | undefined {
  return source[field] === undefined || source[field] === null ? undefined : requireString(source, field);
}

/** Só o formato do objeto. Escala, sinal e moeda são conferidos por `Money.from`. */
export function requireMoney(source: Record<string, unknown>, field: string): MoneyProps {
  const money = asObject(source[field], field);
  if (typeof money.amount !== 'string' || typeof money.currency !== 'string') {
    throw new InvalidRequestError(`${field} must be { amount: string, currency: string }`, field);
  }
  return { amount: money.amount, currency: money.currency };
}

export function parseWagerPayload(body: unknown): WagerPayload {
  const b = asObject(body);
  return {
    providerId: requireString(b, 'providerId'),
    externalTransactionId: requireString(b, 'externalTransactionId'),
    playerId: requireString(b, 'playerId'),
    walletId: requireUuid(b, 'walletId'),
    roundId: requireString(b, 'roundId'),
    gameId: requireString(b, 'gameId'),
    kind: requireString(b, 'kind'),
    money: requireMoney(b, 'money'),
    referenceExternalTransactionId: optionalString(b, 'referenceExternalTransactionId'),
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function requireUuid(source: Record<string, unknown>, field: string): string {
  const value = requireString(source, field);
  if (!UUID.test(value)) throw new InvalidRequestError(`${field} must be a UUID`, field);
  return value.toLowerCase();
}

export function requireIdempotencyKey(header: string | undefined): string {
  if (header === undefined || header.trim() === '' || header.length > MAX_ID_LENGTH) {
    throw new InvalidRequestError(`Idempotency-Key header is required (1 to ${MAX_ID_LENGTH} characters)`, 'Idempotency-Key');
  }
  return header;
}
