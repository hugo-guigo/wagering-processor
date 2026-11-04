/**
 * Quanto esperar pela referência de um REFUND/ROLLBACK que chegou antes dela.
 * Backoff exponencial: 1 s, 2 s, 4 s, ..., limitado a 60 s por espera, por no máximo 10 novas
 * tentativas. Somando, a referência tem cerca de 5 minutos para chegar; depois disso a transação é
 * REJECTED com REFERENCE_NOT_FOUND. Justificativa em ARCHITECTURE.md.
 */
export const REFERENCE_RETRY = { baseMs: 1_000, maxDelayMs: 60_000, maxAttempts: 10 } as const;

/** Momento da próxima tentativa, dado quantas já foram feitas. */
export function nextReferenceAttemptAt(now: Date, attemptsSoFar: number): Date {
  const delay = Math.min(REFERENCE_RETRY.baseMs * 2 ** attemptsSoFar, REFERENCE_RETRY.maxDelayMs);
  return new Date(now.getTime() + delay);
}

export function referenceRetriesExhausted(attemptsSoFar: number): boolean {
  return attemptsSoFar >= REFERENCE_RETRY.maxAttempts;
}
