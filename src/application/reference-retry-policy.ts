export interface ReferenceRetryConfig {
  baseMs: number;
  maxDelayMs: number;
  maxAttempts: number;
}

/**
 * Padrão: backoff exponencial 1 s, 2 s, 4 s, ..., limitado a 60 s por espera, por no máximo 10
 * novas tentativas. Somando, a referência tem cerca de 5 minutos para chegar; depois disso a
 * transação é REJECTED (REFERENCE_NOT_FOUND). Justificativa em ARCHITECTURE.md.
 */
export const DEFAULT_REFERENCE_RETRY: ReferenceRetryConfig = { baseMs: 1_000, maxDelayMs: 60_000, maxAttempts: 10 };

export class ReferenceRetryPolicy {
  constructor(readonly config: ReferenceRetryConfig = DEFAULT_REFERENCE_RETRY) {}

  /** Momento da próxima tentativa, dado quantas novas tentativas já foram feitas. */
  nextAttemptAt(now: Date, attemptsSoFar: number): Date {
    const delay = Math.min(this.config.baseMs * 2 ** attemptsSoFar, this.config.maxDelayMs);
    return new Date(now.getTime() + delay);
  }

  exhausted(attemptsSoFar: number): boolean {
    return attemptsSoFar >= this.config.maxAttempts;
  }

  /** Configuração por variável de ambiente (os testes usam esperas curtas). */
  static fromEnv(env: Record<string, string | undefined> = process.env): ReferenceRetryPolicy {
    const number = (name: string, fallback: number) => (env[name] ? Number(env[name]) : fallback);
    return new ReferenceRetryPolicy({
      baseMs: number('REFERENCE_RETRY_BASE_MS', DEFAULT_REFERENCE_RETRY.baseMs),
      maxDelayMs: number('REFERENCE_RETRY_MAX_DELAY_MS', DEFAULT_REFERENCE_RETRY.maxDelayMs),
      maxAttempts: number('REFERENCE_RETRY_MAX_ATTEMPTS', DEFAULT_REFERENCE_RETRY.maxAttempts),
    });
  }
}
