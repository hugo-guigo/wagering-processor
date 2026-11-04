import { Body, Controller, Headers, HttpCode, Post, Res } from '@nestjs/common';
import { OpenWallet } from '../application/open-wallet';
import { ProcessWagerTransaction } from '../application/process-wager-transaction';
import { asObject, parseWagerPayload, requireIdempotencyKey, requireMoney, requireString } from './request-validation';
import { wagerResponse, type WagerResponseBody } from './responses';

interface StatusResponse {
  status(code: number): unknown;
}

/** Usa o id de correlação do chamador, ou cria um. Vai para os eventos e para os logs. */
export function correlationId(header: string | undefined): string {
  return header && header.length <= 200 ? header : crypto.randomUUID();
}

@Controller('wallets')
export class WalletsController {
  constructor(private readonly openWallet: OpenWallet) {}

  @Post()
  @HttpCode(201)
  async create(@Body() body: unknown, @Headers('x-correlation-id') correlation?: string) {
    const b = asObject(body);
    const wallet = await this.openWallet.execute(
      { playerId: requireString(b, 'playerId'), initialBalance: requireMoney(b, 'initialBalance') },
      { correlationId: correlationId(correlation) },
    );
    return { id: wallet.id, playerId: wallet.playerId, balance: wallet.balance.toJSON(), version: wallet.version };
  }
}

@Controller('wagering')
export class WageringController {
  constructor(private readonly processWager: ProcessWagerTransaction) {}

  @Post('transactions')
  async submit(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-correlation-id') correlation: string | undefined,
    @Res({ passthrough: true }) response: StatusResponse,
  ): Promise<WagerResponseBody> {
    const key = requireIdempotencyKey(idempotencyKey);
    const payload = parseWagerPayload(body);
    const outcome = await this.processWager.execute(
      { idempotencyKey: key, payload },
      { correlationId: correlationId(correlation), causationId: key },
    );
    const { status, body: responseBody } = wagerResponse(outcome);
    response.status(status);
    return responseBody;
  }
}
