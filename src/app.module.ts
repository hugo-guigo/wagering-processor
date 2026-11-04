import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import config from './infra/database/mikro-orm.config';
import { HealthController } from './health/health.controller';
import { WageringController, WalletsController } from './http/controllers';
import { HttpErrorFilter } from './http/http-error.filter';
import { Clock, IdGenerator, TransactionRunner } from './application/ports';
import { OpenWallet } from './application/open-wallet';
import { ProcessWagerTransaction } from './application/process-wager-transaction';
import { ReferenceRetryPolicy } from './application/reference-retry-policy';
import { ResolvePendingReferences } from './application/resolve-pending-references';
import { WagerSettlement } from './application/wager-settlement';
import { MikroOrmTransactionRunner } from './infra/database/mikro-orm-wallet-store';
import { SystemClock, UuidV7Generator } from './infra/system';

// Os casos de uso não têm decorators do Nest: são montados aqui por factory, a partir das portas.
@Module({
  imports: [MikroOrmModule.forRoot(config)],
  controllers: [HealthController, WalletsController, WageringController],
  providers: [
    { provide: TransactionRunner, useClass: MikroOrmTransactionRunner },
    { provide: IdGenerator, useClass: UuidV7Generator },
    { provide: Clock, useClass: SystemClock },
    { provide: ReferenceRetryPolicy, useFactory: () => ReferenceRetryPolicy.fromEnv() },
    {
      provide: WagerSettlement,
      useFactory: (ids: IdGenerator, retry: ReferenceRetryPolicy) => new WagerSettlement(ids, retry),
      inject: [IdGenerator, ReferenceRetryPolicy],
    },
    {
      provide: OpenWallet,
      useFactory: (runner: TransactionRunner, ids: IdGenerator, clock: Clock) => new OpenWallet(runner, ids, clock),
      inject: [TransactionRunner, IdGenerator, Clock],
    },
    {
      provide: ProcessWagerTransaction,
      useFactory: (runner: TransactionRunner, ids: IdGenerator, clock: Clock, settlement: WagerSettlement) =>
        new ProcessWagerTransaction(runner, ids, clock, settlement),
      inject: [TransactionRunner, IdGenerator, Clock, WagerSettlement],
    },
    {
      provide: ResolvePendingReferences,
      useFactory: (runner: TransactionRunner, clock: Clock, settlement: WagerSettlement) =>
        new ResolvePendingReferences(runner, clock, settlement),
      inject: [TransactionRunner, Clock, WagerSettlement],
    },
    { provide: APP_FILTER, useClass: HttpErrorFilter },
  ],
})
export class AppModule {}
