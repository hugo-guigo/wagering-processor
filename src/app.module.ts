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
import { MikroOrmTransactionRunner } from './infra/database/mikro-orm-wallet-store';
import { SystemClock, UuidV7Generator } from './infra/system';

// Os casos de uso não têm decorators do Nest: são montados aqui por factory, a partir das portas.
const useCase = <T>(UseCase: new (runner: TransactionRunner, ids: IdGenerator, clock: Clock) => T) => ({
  provide: UseCase,
  useFactory: (runner: TransactionRunner, ids: IdGenerator, clock: Clock) => new UseCase(runner, ids, clock),
  inject: [TransactionRunner, IdGenerator, Clock],
});

@Module({
  imports: [MikroOrmModule.forRoot(config)],
  controllers: [HealthController, WalletsController, WageringController],
  providers: [
    { provide: TransactionRunner, useClass: MikroOrmTransactionRunner },
    { provide: IdGenerator, useClass: UuidV7Generator },
    { provide: Clock, useClass: SystemClock },
    useCase(OpenWallet),
    useCase(ProcessWagerTransaction),
    { provide: APP_FILTER, useClass: HttpErrorFilter },
  ],
})
export class AppModule {}
