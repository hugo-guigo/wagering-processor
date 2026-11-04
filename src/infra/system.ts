import { Injectable } from '@nestjs/common';
import { Clock, IdGenerator } from '../application/ports';

/** UUIDv7: ordenado pelo tempo, o que mantém os índices de chave primária compactos. */
@Injectable()
export class UuidV7Generator extends IdGenerator {
  next(): string {
    return Bun.randomUUIDv7();
  }
}

@Injectable()
export class SystemClock extends Clock {
  now(): Date {
    return new Date();
  }
}
