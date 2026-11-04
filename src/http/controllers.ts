import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query, Res } from '@nestjs/common';
import { OpenWallet } from '../application/open-wallet';
import { ProcessWagerTransaction } from '../application/process-wager-transaction';
import { ReconcileWallet, WalletQueries } from '../application/queries';
import { InvalidRequestError } from '../application/errors';
import {
  asObject, parseWagerPayload, requireIdempotencyKey, requireMoney, requireString, requireUuid,
} from '../application/input-validation';
import { log } from '../infra/observability/logger';
import { metrics } from '../infra/observability/metrics';
import { recordOutcome } from '../infra/observability/record-outcome';
import { wagerResponse, type WagerResponseBody } from './responses';
import { ledgerItemView, reconciliationView, transactionView, walletView } from './views';

interface StatusResponse {
  status(code: number): unknown;
}

/** Usa o id de correlação do chamador, ou cria um. Vai para os eventos e para os logs. */
export function correlationId(header: string | undefined): string {
  return header && header.length <= 200 ? header : crypto.randomUUID();
}

const uuid = (value: string, field: string) => requireUuid({ [field]: value }, field);

@Controller('wallets')
export class WalletsController {
  constructor(
    private readonly openWallet: OpenWallet,
    private readonly queries: WalletQueries,
    private readonly reconcile: ReconcileWallet,
  ) {}

  @Post()
  @HttpCode(201)
  async create(@Body() body: unknown, @Headers('x-correlation-id') correlation?: string) {
    const b = asObject(body);
    const wallet = await this.openWallet.execute(
      { playerId: requireString(b, 'playerId'), initialBalance: requireMoney(b, 'initialBalance') },
      { correlationId: correlationId(correlation) },
    );
    log.info({ event: 'wallet.opened', correlationId: correlation, walletId: wallet.id }, 'wallet opened');
    return { id: wallet.id, playerId: wallet.playerId, balance: wallet.balance.toJSON(), version: wallet.version };
  }

  @Get(':walletId')
  async get(@Param('walletId') walletId: string) {
    return walletView(await this.queries.wallet(uuid(walletId, 'walletId')));
  }

  @Get(':walletId/ledger')
  async ledger(@Param('walletId') walletId: string, @Query('cursor') cursor?: string, @Query('limit') limit?: string) {
    if (limit !== undefined && !/^\d+$/.test(limit)) throw new InvalidRequestError('limit must be an integer', 'limit');
    const page = await this.queries.ledger(uuid(walletId, 'walletId'), cursor || undefined, limit ? Number(limit) : undefined);
    return { items: page.items.map(ledgerItemView), nextCursor: page.nextCursor };
  }

  /** Divergência é relatada (log de erro, métrica e consistent: false), nunca corrigida. */
  @Post(':walletId/reconciliation')
  @HttpCode(200)
  async reconciliation(@Param('walletId') walletId: string, @Headers('x-correlation-id') correlation?: string) {
    const result = await this.reconcile.execute(uuid(walletId, 'walletId'));
    if (!result.consistent) {
      metrics.reconciliationDivergences.inc();
      log.error(
        { event: 'reconciliation.divergence', correlationId: correlation, walletId, checkedEntries: result.checkedEntries },
        'wallet balance differs from the ledger',
      );
    }
    return reconciliationView(result);
  }
}

@Controller()
export class TransactionsController {
  constructor(
    private readonly processWager: ProcessWagerTransaction,
    private readonly queries: WalletQueries,
  ) {}

  @Post('wagering/transactions')
  async submit(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-correlation-id') correlation: string | undefined,
    @Res({ passthrough: true }) response: StatusResponse,
  ): Promise<WagerResponseBody> {
    const key = requireIdempotencyKey(idempotencyKey);
    const payload = parseWagerPayload(body);
    const corr = correlationId(correlation);
    const timer = metrics.processing.startTimer({ source: 'http' });
    const outcome = await this.processWager.execute({ idempotencyKey: key, payload }, { correlationId: corr, causationId: key });
    recordOutcome(outcome, payload, 'http', { correlationId: corr }, timer);
    const { status, body: responseBody } = wagerResponse(outcome);
    response.status(status);
    return responseBody;
  }

  @Get('wagering/transactions/:transactionId')
  async get(@Param('transactionId') transactionId: string) {
    return transactionView(await this.queries.transaction(uuid(transactionId, 'transactionId')));
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  async byExternalId(@Param('providerId') providerId: string, @Param('externalTransactionId') externalTransactionId: string) {
    return transactionView(await this.queries.transactionByExternalId(providerId, externalTransactionId));
  }
}
