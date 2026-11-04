import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { AppModule } from '../../src/app.module';
import { sql } from '../integration/support/database';

const TUNABLES = [
  'WORKERS', 'LOCK_TIMEOUT', 'CONSUMER_BACKOFF_BASE_SECONDS', 'CONSUMER_VISIBILITY_TIMEOUT', 'FAIL_AFTER_COMMIT',
  'REFERENCE_RETRY_BASE_MS', 'REFERENCE_RETRY_MAX_DELAY_MS', 'REFERENCE_RETRY_MAX_ATTEMPTS',
];

/** Sobe o app de verdade (Nest + Postgres do compose) numa porta livre. */
export async function startApp(env: Record<string, string> = {}): Promise<{ app: INestApplication; url: string }> {
  // Por padrão sem trabalhos de fundo: cada teste chama o worker que quer, na hora que quer.
  // As variáveis de ajuste são zeradas a cada app, para um arquivo de teste não vazar para o outro.
  for (const name of TUNABLES) delete process.env[name];
  Object.assign(process.env, { WORKERS: '', ...env });
  const app = await NestFactory.create(AppModule, { logger: ['error'] });
  await app.listen(0);
  return { app, url: (await app.getUrl()).replace('[::1]', 'localhost') };
}

export interface ApiResponse<T = any> {
  status: number;
  body: T;
}

export function api(url: string) {
  return {
    async post<T = any>(path: string, body: unknown, headers: Record<string, string> = {}): Promise<ApiResponse<T>> {
      const response = await fetch(`${url}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      });
      return { status: response.status, body: (await response.json()) as T };
    },
  };
}

let player = 0;

/** Cria uma wallet pela API e devolve o que os testes precisam para apostar nela. */
export async function createWallet(url: string, amount: string, currency = 'BRL') {
  const playerId = `player-${Date.now()}-${++player}-${Math.random().toString(36).slice(2, 8)}`;
  const response = await api(url).post('/wallets', { playerId, initialBalance: { amount, currency } });
  if (response.status !== 201) throw new Error(`createWallet: ${response.status} ${JSON.stringify(response.body)}`);
  return { walletId: response.body.id as string, playerId };
}

let external = 0;

/** Monta uma operação do provedor. A idempotency key segue o padrão recomendado provider:external. */
export function wager(wallet: { walletId: string; playerId: string }, over: Record<string, unknown> = {}) {
  const externalTransactionId = `tx-${Date.now()}-${++external}`;
  const body = {
    providerId: 'provider-a',
    externalTransactionId,
    playerId: wallet.playerId,
    walletId: wallet.walletId,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount: '10.00', currency: 'BRL' },
    ...over,
  };
  return { body, key: `${body.providerId}:${body.externalTransactionId}` };
}

export function submit(url: string, op: { body: unknown; key: string }) {
  return api(url).post('/wagering/transactions', op.body, { 'Idempotency-Key': op.key });
}

/** Invariante final de todo teste: saldo da wallet == saldo reconstruído pelo ledger. */
export async function ledgerSnapshot(walletId: string) {
  const [w] = await sql`select balance_minor, version from wallets where id = ${walletId}`;
  const [l] = await sql`
    select coalesce(sum(case direction when 'CREDIT' then amount_minor else -amount_minor end), 0)::bigint as rebuilt,
           count(*) filter (where direction = 'DEBIT')::int as debits,
           count(*) filter (where direction = 'CREDIT')::int as credits
      from wallet_ledger_entries where wallet_id = ${walletId}`;
  return {
    balance: BigInt(w.balance_minor),
    rebuilt: BigInt(l.rebuilt),
    version: Number(w.version),
    debits: Number(l.debits),
    credits: Number(l.credits),
  };
}
