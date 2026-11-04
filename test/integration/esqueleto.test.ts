// Teste do esqueleto: Nest + MikroORM rodando no Bun contra o Postgres do compose.
import 'reflect-metadata';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import config from '../../src/infra/database/mikro-orm.config';
import { AppModule } from '../../src/app.module';
import { WalletRecord } from '../../src/infra/database/records/wallet.record';
import { resetSchema, seedWallet, sql } from './support/database';

let orm: MikroORM;
let app: INestApplication;

beforeAll(async () => {
  await resetSchema();
  orm = await MikroORM.init(config);
  app = await NestFactory.create(AppModule, { logger: false });
  await app.listen(0);
});

afterAll(async () => {
  await app?.close();
  await orm?.close();
});

test('GET /health/live responde pelo Nest', async () => {
  const resposta = await fetch(`${await app.getUrl()}/health/live`);
  expect(resposta.status).toBe(200);
  expect(await resposta.json()).toEqual({ status: 'ok' });
});

test('bigint vai e volta do banco pelo ORM como bigint, sem passar por number', async () => {
  const { walletId } = await seedWallet(9_007_199_254_740_993n); // acima de Number.MAX_SAFE_INTEGER
  const lido = await orm.em.fork().findOneOrFail(WalletRecord, walletId);
  expect(typeof lido.balanceMinor).toBe('bigint');
  expect(lido.balanceMinor).toBe(9_007_199_254_740_993n);
});

test('todas as migrations desfazem e refazem', async () => {
  await orm.migrator.down({ to: 0 });
  const [vazio] = await sql`select count(*)::int as n from pg_tables where schemaname = 'public' and tablename <> 'mikro_orm_migrations'`;
  expect(vazio.n).toBe(0);
  await orm.migrator.up();
  const tabelas = await sql`select tablename from pg_tables where schemaname = 'public' order by tablename`;
  expect(tabelas.map((t: { tablename: string }) => t.tablename)).toEqual([
    'inbox_messages', 'mikro_orm_migrations', 'outbox_messages', 'wager_transactions', 'wallet_ledger_entries', 'wallets',
  ]);
});
