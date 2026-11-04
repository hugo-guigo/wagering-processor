import { Catch, HttpException, Logger, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import {
  IdempotencyConflictError, InvalidRequestError, NotFoundError, TransientInfrastructureError, WalletAlreadyExistsError,
} from '../application/errors';
import { metrics } from '../infra/observability/metrics';
import { InvalidMoneyError, InvalidWagerTransactionError, InvalidWalletError } from '../domain/errors';

interface HttpResponse {
  status(code: number): HttpResponse;
  setHeader(name: string, value: string): void;
  json(body: unknown): void;
}

/**
 * Traduz erros em status HTTP. Cada situação tem um código próprio, para o provedor decidir se
 * reenvia sem ler a mensagem: 400 payload inválido, 409 conflito, 503 transitório, 500 bug.
 */
@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpErrorFilter.name);

  catch(error: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<HttpResponse>();
    const { status, body } = this.map(error);
    if (status === 503) response.setHeader('Retry-After', '1');
    response.status(status).json(body);
  }

  private map(error: unknown): { status: number; body: unknown } {
    if (error instanceof InvalidRequestError) {
      return { status: 400, body: { error: { code: error.code, message: error.message, field: error.field } } };
    }
    if (error instanceof InvalidMoneyError || error instanceof InvalidWagerTransactionError || error instanceof InvalidWalletError) {
      return { status: 400, body: { error: { code: error.code, message: error.message } } };
    }
    if (error instanceof NotFoundError) {
      return { status: 404, body: { error: { code: error.code, message: error.message } } };
    }
    if (error instanceof IdempotencyConflictError) {
      metrics.duplicates.inc({ type: 'idempotency_conflict' });
      return {
        status: 409,
        body: { error: { code: error.code, message: error.message, existingTransactionId: error.existingTransactionId } },
      };
    }
    if (error instanceof WalletAlreadyExistsError) {
      return { status: 409, body: { error: { code: error.code, message: error.message } } };
    }
    if (error instanceof TransientInfrastructureError) {
      this.logger.warn(`transient failure: ${error.message}`);
      return { status: 503, body: { error: { code: error.code, message: 'temporarily unavailable, retry later' } } };
    }
    if (error instanceof HttpException) {
      // Erros do próprio Nest, como JSON malformado (400) ou rota inexistente (404).
      return { status: error.getStatus(), body: { error: { code: 'HTTP_ERROR', message: error.message } } };
    }
    this.logger.error(error instanceof Error ? error.stack : String(error));
    return { status: 500, body: { error: { code: 'INTERNAL_ERROR', message: 'unexpected error' } } };
  }
}
