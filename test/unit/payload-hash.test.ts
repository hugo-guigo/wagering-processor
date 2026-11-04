import { expect, test } from 'bun:test';
import { canonicalJson, payloadHash, type WagerPayload } from '../../src/application/payload-hash';

const base: WagerPayload = {
  providerId: 'provider-a', externalTransactionId: 'transaction-123', playerId: 'p1', walletId: 'w1',
  roundId: 'round-987', gameId: 'fortune-chimp', kind: 'BET', money: { amount: '25.00', currency: 'BRL' },
};

test('JSON canônico ordena as chaves em todos os níveis e omite undefined', () => {
  expect(canonicalJson({ b: 1, a: { d: 'x', c: [2, { f: 1, e: 0 }] }, z: undefined }))
    .toBe('{"a":{"c":[2,{"e":0,"f":1}],"d":"x"},"b":1}');
});

test('a ordem das chaves do pedido não muda o hash', () => {
  const invertido = Object.fromEntries(Object.entries(base).reverse()) as unknown as WagerPayload;
  expect(payloadHash(invertido)).toBe(payloadHash(base));
});

test('"25.5" e "25.50" são o mesmo pedido', () => {
  const curto = payloadHash({ ...base, money: { amount: '25.5', currency: 'BRL' } });
  expect(curto).toBe(payloadHash({ ...base, money: { amount: '25.50', currency: 'BRL' } }));
  expect(curto).not.toBe(payloadHash(base)); // base é 25.00
});

test('qualquer campo de negócio diferente muda o hash', () => {
  const original = payloadHash(base);
  expect(payloadHash({ ...base, money: { amount: '25.01', currency: 'BRL' } })).not.toBe(original);
  expect(payloadHash({ ...base, roundId: 'round-988' })).not.toBe(original);
  expect(payloadHash({ ...base, referenceExternalTransactionId: 'x' })).not.toBe(original);
});

test('campos fora do subconjunto de negócio (idempotencyKey, metadados) não entram', () => {
  const comExtras = { ...base, idempotencyKey: 'outra', messageId: 'msg-1', occurredAt: 'agora' } as WagerPayload;
  expect(payloadHash(comExtras)).toBe(payloadHash(base));
});

test('é SHA-256 em hex', () => {
  expect(payloadHash(base)).toMatch(/^[0-9a-f]{64}$/);
});
