// Teste de carga (diferencial da seção 14): bun run test:load
//
// Metodologia:
// - 3 instâncias do app como processos separados, todas com consumer, publisher e references,
//   contra o mesmo PostgreSQL e o mesmo MiniStack do docker compose.
// - Um gerador neste processo mantém N requisições em voo (usuários virtuais em laço fechado:
//   cada um manda a próxima quando a anterior responde), distribuídas entre as 3 instâncias.
// - Cada requisição é uma BET de 1,00 com idempotency key única, em wallets com saldo de sobra:
//   o esperado é 201 em todas. Não 201 conta como erro.
// - Cenário "distribuído": 200 wallets, cada requisição numa wallet sorteada.
//   Cenário "wallet quente": todas as requisições na mesma wallet (o pior caso do lock por wallet).
// - Aquecimento antes de cada cenário (fora da medição). Durante a medição, a outbox é lida a
//   cada 250 ms (lag do evento mais antigo não publicado). Depois, mede quanto tempo a outbox leva
//   para esvaziar.
// - No fim: invariante saldo == ledger em todas as wallets e reconciliação da wallet quente.
//
// ATENÇÃO: apaga e recria o schema do banco local, como as suítes de integração.
// Variáveis: LOAD_DURATION_MS (padrão 20000), LOAD_CONCURRENCY (padrão 32), LOAD_WARMUP_MS (3000),
// LOAD_OUTPUT (padrão docs/carga-resultado.md).
import os from 'node:os';
import { resetSchema, sql } from '../integration/support/database';
import { purgeQueues } from '../support/sqs';
import { spawnInstance, type Instance } from '../support/instances';

const DURATION_MS = Number(process.env.LOAD_DURATION_MS ?? 20_000);
const CONCURRENCY = Number(process.env.LOAD_CONCURRENCY ?? 32);
const WARMUP_MS = Number(process.env.LOAD_WARMUP_MS ?? 3_000);
const WALLETS = 200;
const OUTPUT = process.env.LOAD_OUTPUT ?? 'docs/carga-resultado.md';

interface Wallet { walletId: string; playerId: string }

interface ScenarioResult {
  name: string;
  requests: number;
  ok: number;
  byStatus: Record<string, number>;
  seconds: number;
  throughput: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  errorRate: number;
  lockConflicts: number;
  lockWaitMeanMs: number;
  outboxLagMaxSeconds: number;
  outboxPendingMax: number;
  outboxDrainSeconds: number;
}

let seq = 0;

async function createWallet(url: string, amount: string): Promise<Wallet> {
  const playerId = `load-${Date.now()}-${++seq}`;
  const r = await fetch(`${url}/wallets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ playerId, initialBalance: { amount, currency: 'BRL' } }),
  });
  if (r.status !== 201) throw new Error(`createWallet ${r.status}: ${await r.text()}`);
  return { walletId: ((await r.json()) as { id: string }).id, playerId };
}

async function bet(url: string, w: Wallet): Promise<{ status: number; ms: number }> {
  const externalTransactionId = `load-${process.pid}-${++seq}`;
  const body = {
    providerId: 'provider-load', externalTransactionId, playerId: w.playerId, walletId: w.walletId,
    roundId: 'round-load', gameId: 'game-load', kind: 'BET', money: { amount: '1.00', currency: 'BRL' },
  };
  const start = performance.now();
  try {
    const r = await fetch(`${url}/wagering/transactions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'Idempotency-Key': `provider-load:${externalTransactionId}` },
      body: JSON.stringify(body),
    });
    await r.arrayBuffer();
    return { status: r.status, ms: performance.now() - start };
  } catch {
    return { status: 0, ms: performance.now() - start }; // erro de rede
  }
}

/** Mantém CONCURRENCY requisições em voo por `ms`. */
async function drive(urls: string[], pick: () => Wallet, ms: number, record?: (s: number, ms: number) => void) {
  const end = Date.now() + ms;
  let next = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (Date.now() < end) {
      const r = await bet(urls[next++ % urls.length]!, pick());
      record?.(r.status, r.ms);
    }
  }));
}

async function outboxState(): Promise<{ lag: number; pending: number }> {
  const [row] = await sql`select count(*)::int as pending,
      coalesce(extract(epoch from now() - min(occurred_at)), 0)::float8 as lag
    from outbox_messages where published_at is null`;
  return { lag: Number(row.lag), pending: Number(row.pending) };
}

/** Soma um contador do /metrics nas instâncias (todas as séries com esse nome). */
async function scrape(urls: string[], name: string): Promise<number> {
  let total = 0;
  for (const url of urls) {
    const text = await (await fetch(`${url}/metrics`)).text();
    for (const line of text.split('\n')) {
      if (line.startsWith(name) && (line[name.length] === ' ' || line[name.length] === '{')) {
        total += Number(line.slice(line.lastIndexOf(' ') + 1));
      }
    }
  }
  return total;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

async function scenario(name: string, urls: string[], pick: () => Wallet): Promise<ScenarioResult> {
  console.log(`\n${name}: aquecimento ${WARMUP_MS} ms`);
  await drive(urls, pick, WARMUP_MS);
  await waitOutboxEmpty(60_000);

  const conflictsBefore = await scrape(urls, 'wagering_lock_conflicts_total');
  const waitSumBefore = await scrape(urls, 'wagering_wallet_lock_wait_seconds_sum');
  const waitCountBefore = await scrape(urls, 'wagering_wallet_lock_wait_seconds_count');

  const latencies: number[] = [];
  const byStatus: Record<string, number> = {};
  let lagMax = 0;
  let pendingMax = 0;
  let measuring = true;
  const poller = (async () => {
    while (measuring) {
      const s = await outboxState();
      lagMax = Math.max(lagMax, s.lag);
      pendingMax = Math.max(pendingMax, s.pending);
      await Bun.sleep(250);
    }
  })();

  console.log(`${name}: medindo ${DURATION_MS} ms com ${CONCURRENCY} requisições em voo`);
  const start = performance.now();
  await drive(urls, pick, DURATION_MS, (status, ms) => {
    latencies.push(ms);
    byStatus[status] = (byStatus[status] ?? 0) + 1;
  });
  const seconds = (performance.now() - start) / 1000;
  measuring = false;
  await poller;

  const drainStart = performance.now();
  await waitOutboxEmpty(120_000);
  const drainSeconds = (performance.now() - drainStart) / 1000;

  const conflicts = (await scrape(urls, 'wagering_lock_conflicts_total')) - conflictsBefore;
  const waitSum = (await scrape(urls, 'wagering_wallet_lock_wait_seconds_sum')) - waitSumBefore;
  const waitCount = (await scrape(urls, 'wagering_wallet_lock_wait_seconds_count')) - waitCountBefore;

  latencies.sort((a, b) => a - b);
  const ok = byStatus['201'] ?? 0;
  return {
    name,
    requests: latencies.length,
    ok,
    byStatus,
    seconds,
    throughput: latencies.length / seconds,
    p50: percentile(latencies, 50),
    p95: percentile(latencies, 95),
    p99: percentile(latencies, 99),
    max: latencies.at(-1) ?? 0,
    errorRate: latencies.length === 0 ? 0 : (latencies.length - ok) / latencies.length,
    lockConflicts: conflicts,
    lockWaitMeanMs: waitCount === 0 ? 0 : (waitSum / waitCount) * 1000,
    outboxLagMaxSeconds: lagMax,
    outboxPendingMax: pendingMax,
    outboxDrainSeconds: drainSeconds,
  };
}

async function waitOutboxEmpty(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await outboxState()).pending === 0) return;
    await Bun.sleep(100);
  }
  throw new Error('a outbox não esvaziou a tempo');
}

async function invariant(): Promise<{ wallets: number; divergent: number }> {
  const [row] = await sql`
    select count(*)::int as wallets,
           count(*) filter (where w.balance_minor <> coalesce(l.net, 0))::int as divergent
      from wallets w
      left join (select wallet_id, sum(case direction when 'CREDIT' then amount_minor else -amount_minor end) as net
                   from wallet_ledger_entries group by wallet_id) l on l.wallet_id = w.id`;
  return { wallets: Number(row.wallets), divergent: Number(row.divergent) };
}

function report(results: ScenarioResult[], checks: string[]): string {
  const cpu = os.cpus()[0]?.model.trim() ?? 'desconhecida';
  const ms = (n: number) => n.toFixed(1);
  const lines = [
    '# Teste de carga: resultado',
    '',
    `Gerado por \`bun run test:load\` em ${new Date().toISOString()}. Metodologia no topo de \`test/load/run.ts\`;`,
    'análise em ARCHITECTURE.md (seção "Teste de carga").',
    '',
    '## Ambiente',
    '',
    `- Máquina: ${cpu}, ${os.cpus().length} threads, ${(os.totalmem() / 2 ** 30).toFixed(0)} GB de RAM, ${os.type()} ${os.release()}.`,
    `- Bun ${Bun.version}. PostgreSQL 17 e MiniStack no Docker Desktop da mesma máquina.`,
    '- Tudo na mesma máquina: o gerador de carga, as 3 instâncias, o banco e o emulador de SQS disputam',
    '  os mesmos núcleos. Os números medem este conjunto, não o limite do serviço.',
    `- ${CONCURRENCY} requisições em voo, ${DURATION_MS / 1000} s de medição por cenário, ${WARMUP_MS / 1000} s de aquecimento.`,
    '- Instâncias com `LOG_LEVEL=warn`, `DB_POOL_MAX=10` e `LOCK_TIMEOUT=5s`.',
    '',
    '## Resultados',
    '',
    '| Cenário | Requisições | Throughput (req/s) | p50 (ms) | p95 (ms) | p99 (ms) | máx (ms) | Taxa de erro | Status |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...results.map((r) => `| ${r.name} | ${r.requests} | ${r.throughput.toFixed(0)} | ${ms(r.p50)} | ${ms(r.p95)} | ${ms(r.p99)} | ${ms(r.max)} | ${(r.errorRate * 100).toFixed(2)}% | ${Object.entries(r.byStatus).map(([s, n]) => `${s}: ${n}`).join(', ')} |`),
    '',
    '| Cenário | Conflitos de lock (timeout ou deadlock) | Espera média pelo lock (ms) | Lag máximo da outbox (s) | Eventos pendentes (máx) | Outbox vazia depois de (s) |',
    '| --- | --- | --- | --- | --- | --- |',
    ...results.map((r) => `| ${r.name} | ${r.lockConflicts} | ${ms(r.lockWaitMeanMs)} | ${r.outboxLagMaxSeconds.toFixed(2)} | ${r.outboxPendingMax} | ${r.outboxDrainSeconds.toFixed(2)} |`),
    '',
    '## Conferências depois da carga',
    '',
    ...checks.map((c) => `- ${c}`),
    '',
  ];
  return lines.join('\n');
}

async function main() {
  console.log('preparando: schema recriado, filas vazias, 3 instâncias');
  await resetSchema();
  await purgeQueues();
  const instances: Instance[] = await Promise.all([1, 2, 3].map((i) => spawnInstance(`carga-${i}`, {
    WORKERS: 'consumer,publisher,references', LOG_LEVEL: 'warn',
  })));
  try {
    const urls = instances.map((i) => i.url);
    const wallets = await Promise.all(Array.from({ length: WALLETS }, (_, i) => createWallet(urls[i % 3]!, '1000000.00')));
    const quente = await createWallet(urls[0]!, '1000000.00');

    const results = [
      await scenario(`distribuído (${WALLETS} wallets)`, urls, () => wallets[Math.floor(Math.random() * WALLETS)]!),
      await scenario('wallet quente (1 wallet)', urls, () => quente),
    ];

    const inv = await invariant();
    const recon = await (await fetch(`${urls[0]}/wallets/${quente.walletId}/reconciliation`, { method: 'POST' })).json() as {
      consistent: boolean; checkedEntries: number;
    };
    const [dup] = await sql`select count(*)::int as n from (
        select transaction_id from wallet_ledger_entries group by transaction_id having count(*) > 1) d`;
    const checks = [
      `Invariante saldo == ledger: ${inv.divergent} divergentes em ${inv.wallets} wallets.`,
      `Reconciliação da wallet quente: consistent=${recon.consistent}, ${recon.checkedEntries} lançamentos conferidos.`,
      `Transações com mais de um lançamento: ${Number(dup.n)}.`,
    ];

    const text = report(results, checks);
    await Bun.write(OUTPUT, text);
    console.log(`\n${text}`);
    console.log(`resultado gravado em ${OUTPUT}`);
    if (inv.divergent > 0 || !recon.consistent || Number(dup.n) > 0) process.exitCode = 1;
  } finally {
    await Promise.all(instances.map((i) => i.kill()));
    await sql.close();
  }
}

await main();
