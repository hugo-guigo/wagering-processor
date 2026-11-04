// SIGTERM de verdade, num container Linux (no Windows não existe SIGTERM para processo de console).
// Sobe o app-1 do compose, deixa uma mensagem em andamento e manda `docker compose stop`.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { GetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import { resetSchema, sql } from '../integration/support/database';
import { createWallet, ledgerSnapshot, wager } from '../support/app';
import { drain, purgeQueues, queueUrl, sendWagerMessage, sqs } from '../support/sqs';
import { waitUntil } from '../support/instances';
import { QUEUES } from '../../src/infra/messaging/sqs';

setDefaultTimeout(300_000);

const APP_URL = 'http://localhost:3001';

async function compose(...args: string[]): Promise<string> {
  const proc = Bun.spawn(['docker', 'compose', '--profile', 'app', ...args], {
    env: { ...process.env, APP_WORKERS: 'consumer', APP_LOCK_TIMEOUT: '20s' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  if ((await proc.exited) !== 0) throw new Error(`docker compose ${args.join(' ')} failed:\n${err}`);
  return out + err;
}

beforeAll(async () => {
  await resetSchema();
  await purgeQueues();
  await compose('up', '-d', '--build', '--wait', 'app-1');
});

afterAll(async () => {
  await compose('rm', '-s', '-f', 'app-1', 'migrate');
});

test('SIGTERM: termina a mensagem em andamento, devolve as outras e sai com código 0', async () => {
  const w = await createWallet(APP_URL, '100.00');
  for (const valor of ['10.00', '20.00', '30.00']) {
    const op = wager(w, { money: { amount: valor, currency: 'BRL' } });
    await sendWagerMessage({ ...op.body, idempotencyKey: op.key });
  }

  // Segura a wallet: a 1ª mensagem fica esperando o lock dentro do container.
  let soltar!: () => void;
  const liberada = new Promise<void>((resolve) => { soltar = resolve; });
  let travou!: () => void;
  const travada = new Promise<void>((resolve) => { travou = resolve; });
  const trava = sql.begin(async (tx) => {
    await tx`select id from wallets where id = ${w.walletId} for update`;
    travou();
    await liberada;
  });
  await travada;
  await waitUntil('mensagens em processamento no container', async () => {
    const { Attributes } = await sqs.send(new GetQueueAttributesCommand({
      QueueUrl: await queueUrl(QUEUES.wagers), AttributeNames: ['ApproximateNumberOfMessagesNotVisible'],
    }));
    return Number(Attributes?.ApproximateNumberOfMessagesNotVisible) === 3;
  });

  const parando = compose('stop', '-t', '30', 'app-1'); // envia SIGTERM e espera o processo sair
  await Bun.sleep(1_000);
  soltar();
  await trava;
  await parando;

  const exitCode = (await Bun.$`docker inspect -f {{.State.ExitCode}} wagering-processor-app-1-1`.text()).trim();
  expect(exitCode).toBe('0');
  const logs = await compose('logs', 'app-1');
  expect(logs).toContain('shutting down workers (SIGTERM)');

  // A mensagem em andamento terminou (commit + ack); as outras duas voltaram para a fila na hora.
  expect(await ledgerSnapshot(w.walletId)).toMatchObject({ balance: 9_000n, debits: 1 });
  const devolvidas = await drain(QUEUES.wagers);
  expect(devolvidas.map((m) => JSON.parse(m.Body!).data.money.amount)).toEqual(['20.00', '30.00']);
});
