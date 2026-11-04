import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { JsonNestLogger, log } from './infra/observability/logger';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { logger: new JsonNestLogger() });
  // SIGTERM/SIGINT disparam beforeApplicationShutdown: o consumidor para de buscar e termina o que
  // estava em andamento antes de o banco ser fechado.
  app.enableShutdownHooks();
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  log.info({ event: 'app.started', port }, 'wagering processor listening');
}

void bootstrap();
