import pino from 'pino';
import type { LoggerService } from '@nestjs/common';

/**
 * Logs em JSON, uma linha por evento. Os campos de correlação (correlationId, messageId,
 * transactionId, walletId, providerId) vão como propriedades, nunca no texto. Valores e payloads
 * financeiros não são logados; o `redact` é uma segunda barreira caso alguém passe por engano.
 */
export const log = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { service: 'wagering-processor', pid: process.pid },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: ['money', 'balance', 'payload', 'body', '*.money', '*.balance', '*.payload', '*.body', 'amount', '*.amount'],
    censor: '[redacted]',
  },
});

/** Faz o logger interno do Nest (inicialização, erros) também sair em JSON. */
export class JsonNestLogger implements LoggerService {
  log(message: unknown, context?: string): void {
    log.info({ context }, String(message));
  }
  error(message: unknown, trace?: string, context?: string): void {
    log.error({ context, trace }, String(message));
  }
  warn(message: unknown, context?: string): void {
    log.warn({ context }, String(message));
  }
  debug(message: unknown, context?: string): void {
    log.debug({ context }, String(message));
  }
  verbose(message: unknown, context?: string): void {
    log.trace({ context }, String(message));
  }
}
