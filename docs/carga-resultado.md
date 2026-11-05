# Teste de carga: resultado

Gerado por `bun run test:load` em 2026-11-05T23:14:08.524Z. Metodologia no topo de `test/load/run.ts`;
análise em ARCHITECTURE.md (seção "Teste de carga").

## Ambiente

- Máquina: Intel(R) Core(TM) i3-9100F CPU @ 3.60GHz, 4 threads, 16 GB de RAM, Windows_NT 10.0.19045.
- Bun 1.4.4. PostgreSQL 17 e MiniStack no Docker Desktop da mesma máquina.
- Tudo na mesma máquina: o gerador de carga, as 3 instâncias, o banco e o emulador de SQS disputam
  os mesmos núcleos. Os números medem este conjunto, não o limite do serviço.
- 32 requisições em voo, 20 s de medição por cenário, 3 s de aquecimento.
- Instâncias com `LOG_LEVEL=warn`, `DB_POOL_MAX=10` e `LOCK_TIMEOUT=5s`.

## Resultados

| Cenário | Requisições | Throughput (req/s) | p50 (ms) | p95 (ms) | p99 (ms) | máx (ms) | Taxa de erro | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| distribuído (200 wallets) | 3009 | 150 | 199.8 | 358.9 | 469.9 | 624.0 | 0.00% | 201: 3009 |
| wallet quente (1 wallet) | 1016 | 49 | 594.9 | 1364.2 | 2165.8 | 3101.3 | 0.00% | 201: 1016 |

| Cenário | Conflitos de lock (timeout ou deadlock) | Espera média pelo lock (ms) | Lag máximo da outbox (s) | Eventos pendentes (máx) | Outbox vazia depois de (s) |
| --- | --- | --- | --- | --- | --- |
| distribuído (200 wallets) | 0 | 15.6 | 14.63 | 4546 | 23.88 |
| wallet quente (1 wallet) | 0 | 497.9 | 0.74 | 66 | 0.00 |

## Conferências depois da carga

- Invariante saldo == ledger: 0 divergentes em 201 wallets.
- Reconciliação da wallet quente: consistent=true, 1207 lançamentos conferidos.
- Transações com mais de um lançamento: 0.
