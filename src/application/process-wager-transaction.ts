import { Money } from '../domain/money';
import { WagerTransaction, WagerTransactionKind } from '../domain/wager-transaction';
import { InboxMessage } from '../domain/messaging/inbox-message';
import { IdempotencyConflictError, InvalidRequestError, UniqueViolationError } from './errors';
import { payloadHash, type WagerPayload } from './payload-hash';
import type { OperationContext } from './open-wallet';
import type { Clock, IdGenerator, TransactionRunner, WalletStore } from './ports';
import type { WagerSettlement } from './wager-settlement';

const SUBMITTABLE = new Set<string>([
  WagerTransactionKind.Bet, WagerTransactionKind.Win, WagerTransactionKind.Loss,
  WagerTransactionKind.Refund, WagerTransactionKind.Rollback,
]);

export interface SubmitWagerCommand {
  idempotencyKey: string;
  payload: WagerPayload;
  /** Presente quando a entrada é a fila: o registro do inbox entra na mesma transação SQL. */
  inbox?: { consumerName: string; messageId: string; payloadHash: string };
}

interface Draft {
  hash: string;
  tx: WagerTransaction;
}

export type WagerOutcome =
  | { type: 'transaction'; transaction: WagerTransaction; replay: boolean }
  | { type: 'walletNotFound' };

/**
 * O caso de uso único de entrada de transações: HTTP e fila chamam este mesmo `execute`.
 *
 * Concorrência: a linha da wallet é travada (FOR UPDATE) antes de qualquer leitura que decida o
 * resultado. Duas operações da mesma wallet nunca se intercalam; wallets diferentes não se esperam.
 * Idempotência: a idempotency key é única no banco. A checagem é refeita depois do lock, e se duas
 * requisições com a mesma key ainda assim disputarem o INSERT, a perdedora relê e vira replay.
 */
export class ProcessWagerTransaction {
  constructor(
    private readonly runner: TransactionRunner,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly settlement: WagerSettlement,
  ) {}

  async execute(command: SubmitWagerCommand, ctx: OperationContext): Promise<WagerOutcome> {
    const draft = this.validate(command);

    // Caminho rápido do replay: sem travar a wallet.
    const known = await this.runner.run((store) => store.findTransactionByIdempotencyKey(command.idempotencyKey));
    if (known) return this.replay(known, draft.hash);

    try {
      return await this.runner.run((store) => this.process(store, command, draft, ctx));
    } catch (error) {
      if (error instanceof UniqueViolationError) {
        // Outra instância gravou a mesma key ou o mesmo id externo entre a nossa checagem e o COMMIT.
        const winner = await this.runner.run(async (store) =>
          (await store.findTransactionByIdempotencyKey(command.idempotencyKey))
          ?? store.findTransactionByExternalId(command.payload.providerId, command.payload.externalTransactionId));
        if (winner) {
          if (winner.idempotencyKey !== command.idempotencyKey) throw this.externalIdConflict(winner);
          return this.replay(winner, draft.hash);
        }
      }
      throw error;
    }
  }

  /**
   * Monta a transação antes de tocar no banco: payload inválido é 400 mesmo que a wallet não exista.
   * A transação só é gravada se passar pelo lock e pela checagem de idempotência.
   */
  private validate(command: SubmitWagerCommand): Draft {
    const { payload } = command;
    if (!SUBMITTABLE.has(payload.kind)) {
      throw new InvalidRequestError(`kind must be one of ${[...SUBMITTABLE].join(', ')}`, 'kind');
    }
    const hash = payloadHash(payload);
    const tx = WagerTransaction.create({
      id: this.ids.next(),
      providerId: payload.providerId,
      externalTransactionId: payload.externalTransactionId,
      idempotencyKey: command.idempotencyKey,
      payloadHash: hash,
      walletId: payload.walletId,
      playerId: payload.playerId,
      roundId: payload.roundId,
      gameId: payload.gameId,
      kind: payload.kind as WagerTransactionKind,
      money: Money.from(payload.money),
      referenceExternalTransactionId: payload.referenceExternalTransactionId,
      createdAt: this.clock.now(),
    });
    return { hash, tx };
  }

  private replay(existing: WagerTransaction, hash: string): WagerOutcome {
    if (!existing.matchesPayload(hash)) {
      throw new IdempotencyConflictError('idempotency key already used with a different payload', existing.id);
    }
    return { type: 'transaction', transaction: existing, replay: true };
  }

  private externalIdConflict(existing: WagerTransaction): IdempotencyConflictError {
    return new IdempotencyConflictError('externalTransactionId already used with a different idempotency key', existing.id);
  }

  private async process(
    store: WalletStore,
    command: SubmitWagerCommand,
    draft: Draft,
    ctx: OperationContext,
  ): Promise<WagerOutcome> {
    const { payload } = command;
    const wallet = await store.lockWallet(payload.walletId);
    if (!wallet) return { type: 'walletNotFound' };

    // Refeito sob o lock: quem esperava a mesma wallet enxerga o que a anterior gravou.
    const again = await store.findTransactionByIdempotencyKey(command.idempotencyKey);
    if (again) return this.replay(again, draft.hash);
    const sameExternal = await store.findTransactionByExternalId(payload.providerId, payload.externalTransactionId);
    if (sameExternal) throw this.externalIdConflict(sameExternal);

    const now = this.clock.now();
    const { tx } = draft;

    const previousStatus = tx.status;
    const entry = await this.settlement.decide(store, tx, wallet, now);
    store.addTransaction(tx);
    if (entry) {
      store.addLedgerEntry(entry);
      store.saveWallet(wallet);
    }
    this.settlement.enqueueEvents(
      store, tx, wallet, entry, { correlationId: ctx.correlationId, causationId: ctx.causationId, occurredAt: now }, previousStatus,
    );
    if (command.inbox) {
      const inbox = InboxMessage.receive({ ...command.inbox, receivedAt: now });
      inbox.markProcessed(now);
      store.addInboxMessage(inbox, tx.id);
    }
    return { type: 'transaction', transaction: tx, replay: false };
  }
}
