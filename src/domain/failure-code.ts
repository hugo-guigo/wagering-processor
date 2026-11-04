/**
 * Motivo de uma transação REJECTED ou FAILED. Estável e legível por máquina: o provedor decide pelo
 * código, nunca pela mensagem. A ação esperada de cada um está em ARCHITECTURE.md.
 */
export enum FailureCode {
  /** BET maior que o saldo. Reenviar não adianta; só uma nova aposta menor. */
  InsufficientFunds = 'INSUFFICIENT_FUNDS',
  /** ROLLBACK de WIN ou REFUND que deixaria o saldo negativo (o jogador já gastou o crédito). */
  ReversalInsufficientFunds = 'REVERSAL_INSUFFICIENT_FUNDS',
  /** Moeda da operação diferente da moeda da wallet. */
  CurrencyMismatch = 'CURRENCY_MISMATCH',
  /** A wallet não existe. Não gera transação gravada (ver ARCHITECTURE.md). */
  WalletNotFound = 'WALLET_NOT_FOUND',
  /** A wallet existe, mas pertence a outro playerId. */
  WalletPlayerMismatch = 'WALLET_PLAYER_MISMATCH',
  /** A referência não chegou dentro do limite de tentativas do worker. */
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  /** A referência é de outro player, wallet, moeda ou rodada. */
  ReferenceMismatch = 'REFERENCE_MISMATCH',
  /** Tipo de referência não permitido (ex.: REFUND de um WIN). */
  ReferenceKindNotAllowed = 'REFERENCE_KIND_NOT_ALLOWED',
  /** A referência existe, mas foi REJECTED ou FAILED: não há o que reverter. */
  ReferenceNotProcessed = 'REFERENCE_NOT_PROCESSED',
  /** REFUND ou ROLLBACK com valor diferente da referência (reversão parcial está fora de escopo). */
  ReferenceAmountMismatch = 'REFERENCE_AMOUNT_MISMATCH',
  /** A referência já foi revertida. */
  ReferenceAlreadyReversed = 'REFERENCE_ALREADY_REVERSED',
  /** Erro permanente de infraestrutura (estado FAILED). */
  PermanentProcessingError = 'PERMANENT_PROCESSING_ERROR',
}
