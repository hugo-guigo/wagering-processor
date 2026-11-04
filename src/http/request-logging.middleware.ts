import { Injectable, type NestMiddleware } from '@nestjs/common';
import { log } from '../infra/observability/logger';

interface Request {
  method: string;
  originalUrl: string;
  headers: Record<string, string | string[] | undefined>;
}

interface Response {
  statusCode: number;
  setHeader(name: string, value: string): void;
  on(event: 'finish', listener: () => void): void;
}

/**
 * Garante um x-correlation-id em toda requisição (o do chamador ou um novo), devolve no cabeçalho
 * da resposta e registra uma linha JSON quando a resposta termina. Não loga corpo nem cabeçalhos.
 */
@Injectable()
export class RequestLoggingMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: () => void): void {
    const header = req.headers['x-correlation-id'];
    const correlationId = typeof header === 'string' && header.length <= 200 ? header : crypto.randomUUID();
    req.headers['x-correlation-id'] = correlationId;
    res.setHeader('x-correlation-id', correlationId);
    const started = performance.now();
    res.on('finish', () => {
      if (req.originalUrl.startsWith('/health') || req.originalUrl.startsWith('/metrics')) return;
      log.info(
        {
          event: 'http.request',
          correlationId,
          method: req.method,
          path: req.originalUrl.split('?')[0],
          status: res.statusCode,
          durationMs: Math.round(performance.now() - started),
        },
        'request handled',
      );
    });
    next();
  }
}
