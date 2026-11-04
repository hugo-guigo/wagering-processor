// Teste do esqueleto: Nest + MikroORM rodando no Bun contra o Postgres do compose.
import 'reflect-metadata';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import config from '../../src/infra/database/mikro-orm.config';
import { AppModule } from '../../src/app.module';
import { WalletRecord } from '../../src/infra/database/records/wallet.record';

let orm: MikroORM;
let app: INestApplication;

beforeAll(async () => {
  orm = await MikroORM.init(config);
  await orm.migrator.down({ to: 0 });
  await orm.migrator.up();
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

test('bigint vai e volta do banco como bigint, sem passar por number', async () => {
  const em = orm.em.fork();
  const agora = new Date();
  const id = crypto.randomUUID();
  em.create(WalletRecord, {
    id, playerId: 'p1', currency: 'BRL', balanceMinor: 9_007_199_254_740_993n, version: 1, createdAt: agora, updatedAt: agora,
  });
  await em.flush();

  const lido = await orm.em.fork().findOneOrFail(WalletRecord, id);
  expect(typeof lido.balanceMinor).toBe('bigint');
  expect(lido.balanceMinor).toBe(9_007_199_254_740_993n); // acima de Number.MAX_SAFE_INTEGER
});

test('o schema recusa saldo negativo e wallet duplicada', async () => {
  const conexao = orm.em.getConnection();
  const linha = (saldo: number, jogador: string) =>
    `insert into wallets values ('${crypto.randomUUID()}', '${jogador}', 'BRL', ${saldo}, 1, now(), now())`;
  await expect(conexao.execute(linha(-1, 'p2'))).rejects.toThrow(/balance_minor_check/);
  await conexao.execute(linha(0, 'p3'));
  await expect(conexao.execute(linha(0, 'p3'))).rejects.toThrow(/wallets_player_currency_uq/);
});

test('a migration é reversível', async () => {
  await orm.migrator.down();
  const tabela = await orm.em.getConnection().execute(`select to_regclass('wallets') as t`);
  expect(tabela[0]?.t).toBeNull();
  await orm.migrator.up();
});
