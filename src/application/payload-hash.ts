import { createHash } from 'node:crypto';
import { Money, type MoneyProps } from '../domain/money';

/** Campos de negócio de uma operação. A idempotency key e os metadados de transporte ficam de fora. */
export interface WagerPayload {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}

/**
 * JSON canônico: chaves em ordem alfabética em todos os níveis, sem espaços, campos `undefined`
 * omitidos. O mesmo objeto em qualquer ordem de chaves gera a mesma string.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * payloadHash = SHA-256 (hex) do JSON canônico do subconjunto de negócio. O valor é normalizado
 * antes ("25.5" e "25.50" são o mesmo pedido). Campos extras do payload não entram.
 */
export function payloadHash(payload: WagerPayload): string {
  const business = {
    providerId: payload.providerId,
    externalTransactionId: payload.externalTransactionId,
    playerId: payload.playerId,
    walletId: payload.walletId,
    roundId: payload.roundId,
    gameId: payload.gameId,
    kind: payload.kind,
    money: Money.from(payload.money).toJSON(),
    referenceExternalTransactionId: payload.referenceExternalTransactionId,
  };
  return createHash('sha256').update(canonicalJson(business)).digest('hex');
}
