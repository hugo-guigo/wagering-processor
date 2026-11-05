# Wagering Processor

Processador distribuído de transações de apostas, feito para o desafio técnico da Jungle Gaming.
Provedores enviam BET, WIN, LOSS, REFUND e ROLLBACK por HTTP ou por SQS; o serviço mantém wallet
com saldo materializado, ledger imutável, idempotência persistente, inbox e outbox, e continua
correto com mensagens duplicadas, fora de ordem e com várias instâncias ao mesmo tempo.

Stack: Bun 1.4, TypeScript estrito, NestJS 12, MikroORM 7, PostgreSQL 17, SQS emulado pelo
MiniStack, Docker Compose.

As decisões, os trade-offs e as limitações estão em [ARCHITECTURE.md](ARCHITECTURE.md).

## Como foi feito

O projeto foi feito com o Claude Code, no fluxo especificação, execução e revisão. Cada bloco
começou por uma especificação curta do que seria feito e por quê. Depois veio a implementação em
passos pequenos, com testes contra PostgreSQL e SQS reais. Por último, a minha revisão antes do
bloco seguinte. As decisões ficaram registradas com a alternativa recusada e o motivo.

Alguns problemas que os testes e a revisão pegaram no caminho:

- REFUND sem referência numa wallet inexistente respondia 422 em vez de 400; a validação passou a
  acontecer antes de tocar o banco.
- O hash do payload era calculado fora do tratamento de erro do consumidor: uma mensagem com valor
  inválido só iria para a DLQ depois de 5 entregas, em vez de ir na hora.
- Uma pendência que dava erro em toda tentativa voltava para a frente da fila e travava o worker
  de referências em todas as instâncias; agora o erro conta como tentativa e, no limite, vira
  FAILED.
- O teste de SIGTERM dependia de timing da fila FIFO e passou a enfileirar antes de o container
  subir.
- Faltavam o teste de atomicidade com falha no COMMIT e a conferência da invariante saldo ==
  ledger depois de cada teste; os dois foram adicionados.

## Requisitos

- Bun 1.x
- Docker com Compose v2

## Subir

```bash
bun install
docker compose up -d --wait   # PostgreSQL (porta 5434) e MiniStack (4566) com as filas criadas
bun run migrate               # aplica as migrations ("bun run migrate down" desfaz a última)
bun run start                 # http://localhost:3000
```

Três instâncias do app em containers, contra o mesmo banco e a mesma fila:

```bash
docker compose --profile app up -d --build --wait   # app-1, app-2, app-3 em 3001, 3002, 3003
docker compose --profile app down
```

No perfil `app`, um serviço `migrate` roda as migrations uma vez antes das instâncias.

## Testes

```bash
bun test                    # unidade (98)
bun run test:integration    # integração (89): PostgreSQL e MiniStack reais
bun run test:concurrency    # concorrência (10): processos separados e SIGTERM em container
bun run test:load           # carga: 3 instâncias, ~1 min; resultado em docs/carga-resultado.md
bun run typecheck
```

- As suítes de integração e de concorrência precisam do `docker compose up -d --wait` e **apagam e
  recriam o schema** do banco local.
- A suíte de concorrência leva cerca de 1 minuto: sobe instâncias do app como processos separados
  (portas 3200 a 3699) e constrói a imagem Docker para o teste de SIGTERM (porta 3001).
- Nenhum teste troca o PostgreSQL ou o SQS por mock.
- O teste de carga também apaga o schema. Metodologia, números e análise na seção 17 do
  ARCHITECTURE.md.
- Depois de cada teste de integração e de concorrência, um hook global confere, para todas as
  wallets do banco, que o saldo gravado é igual ao saldo reconstruído pelo ledger.

### Mapa dos testes obrigatórios (seção 13)

| Exigência | Onde |
| --- | --- |
| Money, Wallet, regras por kind, conflito de moeda, payload divergente | `test/unit/*` |
| migrations e constraints | `test/integration/esqueleto.test.ts` (down e up), `schema.test.ts` |
| atomicidade entre wallet, ledger, inbox e outbox | `consumer.test.ts` (falha no COMMIT) |
| inbox e redelivery | `consumer.test.ts` |
| publishers concorrentes sobre a mesma outbox | `outbox.test.ts`; `multi-instancia.test.ts` (3 processos) |
| retry e DLQ | `consumer.test.ts`, `outbox.test.ts` |
| recuperação após reinicialização | `multi-instancia.test.ts` (reinício), `outbox.test.ts` (morte antes do COMMIT) |
| 1. a mesma aposta 50 vezes em paralelo | `mesma-instancia.test.ts` |
| 2. disputa pelo saldo (seção 8) | `mesma-instancia.test.ts` (20 wallets), `multi-instancia.test.ts` |
| 3. wallets distintas em paralelo | `mesma-instancia.test.ts` |
| 4. 3 ou mais processos | `multi-instancia.test.ts` |
| 5. worker morto depois do commit e antes do ack | `multi-instancia.test.ts` (`FAIL_AFTER_COMMIT=1`) |
| 6. dois publishers | `outbox.test.ts`, `multi-instancia.test.ts` |
| 7. REFUND ou ROLLBACK antes da referência | `reversals.test.ts`, `multi-instancia.test.ts` |
| 8. reinício com consistência final | `multi-instancia.test.ts`, `sigterm.test.ts` |

## Exemplos

```bash
# Wallet com saldo inicial (gera a transação interna OPENING e o lançamento de crédito)
curl -s -X POST localhost:3000/wallets -H 'content-type: application/json' \
  -d '{"playerId":"player-1","initialBalance":{"amount":"1000.00","currency":"BRL"}}'

# Aposta (troque WALLET_ID pelo id devolvido acima)
curl -s -X POST localhost:3000/wagering/transactions -H 'content-type: application/json' \
  -H 'Idempotency-Key: provider-a:transaction-123' \
  -d '{"providerId":"provider-a","externalTransactionId":"transaction-123","playerId":"player-1",
       "walletId":"WALLET_ID","roundId":"round-987","gameId":"fortune-chimp","kind":"BET",
       "money":{"amount":"25.00","currency":"BRL"}}'

curl -s localhost:3000/wallets/WALLET_ID
curl -s 'localhost:3000/wallets/WALLET_ID/ledger?limit=50'
curl -s -X POST localhost:3000/wallets/WALLET_ID/reconciliation
curl -s localhost:3000/health/ready
curl -s localhost:3000/metrics
```

Repetir a aposta com a mesma `Idempotency-Key` devolve a mesma resposta com
`"idempotentReplay": true`; mudar o valor com a mesma key devolve 409.

Mensagem para a fila `wager-transactions.fifo` (com `MessageGroupId` = walletId):

```json
{
  "messageId": "msg-123",
  "type": "WagerTransactionRequested",
  "occurredAt": "2026-07-29T15:00:00.000Z",
  "data": { "providerId": "provider-a", "externalTransactionId": "transaction-124",
            "idempotencyKey": "provider-a:transaction-124", "playerId": "player-1",
            "walletId": "WALLET_ID", "roundId": "round-987", "gameId": "fortune-chimp",
            "kind": "WIN", "money": { "amount": "50.00", "currency": "BRL" } }
}
```

## Endpoints

| Método e rota | Descrição |
| --- | --- |
| `POST /wallets` | cria a wallet (409 se o player já tem uma na moeda) |
| `GET /wallets/:walletId` | saldo e versão |
| `GET /wallets/:walletId/ledger?cursor=&limit=` | extrato do mais novo para o mais antigo, cursor opaco |
| `POST /wallets/:walletId/reconciliation` | compara saldo e ledger, sem corrigir |
| `POST /wagering/transactions` | submete uma operação (header `Idempotency-Key` obrigatório) |
| `GET /wagering/transactions/:transactionId` | transação pelo id interno |
| `GET /providers/:providerId/wagering/transactions/:externalTransactionId` | transação pelo id do provedor |
| `GET /health/live`, `GET /health/ready` | liveness e readiness (PostgreSQL e SQS) |
| `GET /metrics` | métricas Prometheus |

## Configuração

| Variável | Padrão | Uso |
| --- | --- | --- |
| `DATABASE_URL` | `postgres://wagering:wagering@localhost:5434/wagering` | PostgreSQL |
| `SQS_ENDPOINT` | `http://localhost:4566` | MiniStack |
| `PORT` | `3000` | HTTP |
| `WORKERS` | `consumer,publisher,references` | trabalhos de fundo desta instância (vazio desliga) |
| `LOCK_TIMEOUT` | `5s` | espera máxima pelo lock da wallet |
| `DB_POOL_MAX` | `10` | conexões por instância |
| `CONSUMER_BACKOFF_BASE_SECONDS` | `2` | backoff do erro transitório na fila (2, 4, 8, 16 s) |
| `CONSUMER_VISIBILITY_TIMEOUT` | `30` | visibilidade das mensagens recebidas |
| `REFERENCE_RETRY_BASE_MS`, `REFERENCE_RETRY_MAX_DELAY_MS`, `REFERENCE_RETRY_MAX_ATTEMPTS` | `1000`, `60000`, `10` | worker de referências pendentes |
| `LOG_LEVEL` | `info` | nível do log JSON |
| `FAIL_AFTER_COMMIT` | vazio | só para teste: `1` mata o processo depois do commit e antes do ack |

## Estrutura

```text
src/domain        Money, Wallet, WagerTransaction, ledger, inbox, outbox, eventos (sem Nest nem ORM)
src/application   casos de uso, regra de decisão, portas
src/infra         MikroORM e migrations, SQS, workers, logs e métricas
src/http          controllers, filtro de erros, AuthGuard no-op
src/health        health checks e /metrics
test/             unit, integration, concurrency e apoio
infra/ministack   script que cria as filas no start do MiniStack
```
