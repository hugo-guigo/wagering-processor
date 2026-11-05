# Arquitetura

Este documento explica as decisões do processador de apostas, as alternativas recusadas e o que
ficou de fora. As seções citadas (por exemplo "seção 7") são as do enunciado do desafio.

## 1. Visão geral

```text
 provedor ──HTTP──▶ TransactionsController ─┐
                                            ├──▶ ProcessWagerTransaction ──▶ PostgreSQL
 provedor ──SQS───▶ SqsWagerConsumer ───────┘     (mesmo caso de uso)        wallet, transação,
                     wager-transactions.fifo                                 ledger, inbox, outbox
                     (DLQ: wager-transactions-dlq.fifo)                      numa transação SQL
                                                                                   │
 ResolvePendingReferences (worker) ◀── PENDING_REFERENCE vencidas ─────────────────┤
 RelayOutbox (worker) ◀── eventos não publicados ──────────────────────────────────┘
        │
        └──▶ wagering-events.fifo
```

- Toda decisão sobre dinheiro acontece numa única transação SQL, com a linha da wallet travada.
- O banco é a última barreira: as invariantes da seção 6 estão no schema (CHECK, UNIQUE, índice
  parcial, triggers), não só no código.
- Qualquer instância pode fazer qualquer trabalho. Não há estado em memória que importe para a
  correção: lock, idempotência, inbox, outbox e pendências vivem no PostgreSQL.

### Camadas

| Pasta | Conteúdo | Depende de |
| --- | --- | --- |
| `src/domain` | Money, Wallet, WagerTransaction, WalletLedgerEntry, InboxMessage, OutboxMessage, eventos | nada (nem Nest, nem ORM) |
| `src/application` | casos de uso, regra de decisão (WagerSettlement), portas | domínio |
| `src/infra` | MikroORM, SQS, workers, logs e métricas | aplicação e domínio |
| `src/http`, `src/health` | controllers, filtro de erros, guard, health | aplicação |

As portas (`WalletStore`, `TransactionRunner`, `EventPublisher`, `IdGenerator`, `Clock`) são
classes abstratas, que servem de token de injeção do Nest. Os casos de uso são classes comuns,
montadas por factory no `AppModule`, sem decorators.

## 2. Stack

- Bun 1.4.4, TypeScript 7 estrito (`strict`, `noUncheckedIndexedAccess`), NestJS 12 (Express),
  MikroORM 7.2, PostgreSQL 17.
- SQS emulado pelo **MiniStack** 1.5.37, não pelo LocalStack. Em 04/11/2026 a imagem do
  LocalStack saía com "License activation failed" sem token, e o enunciado aceita MiniStack.
  Antes de escrever código, conferi no MiniStack o que o projeto usa: deduplicação da FIFO pelo
  MessageDeduplicationId, bloqueio do grupo enquanto uma mensagem está em voo, redrive para a
  DLQ pelo maxReceiveCount e ChangeMessageVisibility.
- Migrations escritas à mão em SQL, cada uma com `down()`. O teste de integração desfaz e refaz
  todas. As garantias que valem pontos ficam legíveis no SQL; o gerador do ORM não cria trigger
  nem índice parcial.

## 3. ORM, mapeamento do Money e estratégia transacional

**Por que MikroORM.** Unit of Work e Identity Map explícitos, `em.transactional()` e `LockMode`
cobrem o que o desenho precisa: uma transação por operação, lock pessimista e `SKIP LOCKED`.

**Mapeamento.** As tabelas são descritas com `defineEntity` em classes `*Record` na infra. Um
mapper converte registro em agregado (`Wallet.rehydrate`, `WagerTransaction.rehydrate`) e de
volta. O domínio não tem decorators: o construtor privado das classes de domínio não combina com
o ORM, e misturar regra com coluna dificultaria ler as duas.

**Money no banco.** Duas colunas: `*_minor bigint` (centavos) e `currency text`. Reidratado com
`Money.fromMinor`. Recusado `numeric(20,2)`: o driver devolve string, e a aritmética de CHECK do
ledger em inteiros é exata e simples (`balance_after_minor = balance_before_minor ± amount_minor`).

**Transação.** Cada operação roda em `orm.em.fork().transactional(...)`:

1. `set local lock_timeout` (padrão 5 s);
2. leituras e `SELECT ... FOR UPDATE` na wallet (`LockMode.PESSIMISTIC_WRITE`);
3. as escritas só entram no Unit of Work;
4. um único flush grava tudo antes do COMMIT.

Os registros não declaram relações, então o ORM não sabe a ordem entre wallet, transação e
lançamento. Por isso as FKs são `DEFERRABLE INITIALLY DEFERRED` (migration 4) e conferidas no
COMMIT. Os workers usam `LockMode.PESSIMISTIC_PARTIAL_WRITE` (`FOR UPDATE SKIP LOCKED`).

Exceções do driver viram erros da aplicação num só lugar (`translate`): violação de unicidade
vira `UniqueViolationError`; lock_timeout, deadlock e conexão perdida viram
`TransientInfrastructureError` (503 no HTTP, retry na fila).

## 4. Money

- `bigint` em centavos, imutável, construtor privado, `from`/`zero`/`fromMinor`.
- Entrada: string decimal. Recusa NaN, Infinity, notação científica, vazio, mais de 2 casas,
  negativo, zero à esquerda, sinal "+", espaço, vírgula e `number` no JSON. Aceita "25" e "25.5"
  e serializa sempre com 2 casas ("25.50").
- Não há arredondamento em lugar nenhum. "10.005" é recusado, não vira 10.01. Soma e subtração de
  inteiros são exatas, então não existe ponto em que arredondar.
- Operações entre moedas diferentes lançam erro de domínio. O modelo é multi-moeda (wallet única
  por `playerId + currency`, conflito de moeda testado), mas só BRL foi exercitado de ponta a
  ponta, como o enunciado permite. Toda moeda usa 2 casas.

## 5. Concorrência

**Escolha: lock pessimista na linha da wallet.** `SELECT ... FOR UPDATE` dentro da transação,
antes de qualquer leitura que decida o resultado. Operações da mesma wallet passam uma de cada
vez; wallets diferentes não se esperam (não há lock global). Funciona com várias instâncias
porque o lock é do PostgreSQL.

**Recusado: optimistic locking com retry.** Numa wallet quente (uma rodada com muitas apostas
simultâneas) quase toda tentativa colidiria e refaria o trabalho; com o lock, elas esperam na
fila do PostgreSQL. O optimistic ganha quando conflito é raro, o que não descreve uma wallet de
jogo. A `version` existe mesmo assim: começa em 1 e sobe só quando o saldo muda, e um trigger
recusa mudança de saldo sem `version + 1`.

**Trade-off assumido.** Uma wallet processa uma operação por vez. A espera tem teto
(`lock_timeout`, 5 s): passado o teto, a operação desiste com 503 e o provedor reenvia. A espera
é medida (`wagering_wallet_lock_wait_seconds`) e os estouros contados
(`wagering_lock_conflicts_total`).

**O banco como última barreira.** Para conferir que o lock é o que mantém o saldo certo, tirei o
lock e rodei o teste da seção 8 três vezes: falhou nas três. O saldo não ficou errado: o trigger
adiado recusou no COMMIT o lançamento que não continuava o saldo anterior. O lock dá a resposta
certa; o schema impede que um bug corrompa o dinheiro.

**Broker.** `MessageGroupId = walletId` na FIFO mantém a ordem por wallet e evita disputa de
lock entre consumidores, mas é otimização. A correção não depende dele: a mesma mensagem
entregue duas vezes com ids de deduplicação diferentes (a FIFO não descarta a segunda) e a mesma
operação enviada pelo HTTP e pela fila continuam com um débito só.

## 6. Idempotência

- `Idempotency-Key` obrigatório no HTTP; na fila, o campo `data.idempotencyKey`.
- No schema: `UNIQUE (idempotency_key)` e `UNIQUE (provider_id, external_transaction_id)`.
- `payloadHash` = SHA-256 (hex) do JSON canônico dos campos de negócio: `providerId`,
  `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind`, `money` (valor
  normalizado com 2 casas) e `referenceExternalTransactionId`. Canônico: chaves em ordem
  alfabética em todos os níveis, sem espaços, campos ausentes omitidos. A key, o messageId, o
  occurredAt e campos extras não entram.
- Fluxo: (1) busca pela key sem lock, para o replay rápido; (2) trava a wallet; (3) busca de novo
  sob o lock, porque quem esperava enxerga o que a anterior gravou; (4) grava. Se ainda assim dois
  INSERTs disputarem (a mesma key apontando para wallets diferentes, que não compartilham lock),
  o índice único recusa o segundo, que relê e vira replay ou conflito. A garantia é o índice; as
  buscas são otimização.
- Mesma key e mesmo hash: replay, com o status HTTP e o saldo gravados naquele momento
  (`idempotentReplay: true`). Mesma key com outro hash: 409. Mesmo `externalTransactionId` com
  outra key: 409.
- Na fila, há uma segunda camada: o inbox `(consumer_name, message_id)`, gravado na mesma
  transação SQL da operação.

## 7. Garantias no schema

| Tabela | O banco recusa |
| --- | --- |
| `wallets` | saldo negativo (CHECK); segunda wallet do mesmo player e moeda (UNIQUE); trocar dono ou moeda; DELETE; mudar saldo sem `version + 1`; mudar `version` sem mudar saldo |
| `wager_transactions` | key ou (provider, id externo) repetidos (UNIQUE); valor não positivo (zero só em LOSS); REFUND/ROLLBACK sem referência; `failure_code` fora de REJECTED/FAILED ou ausente neles; mudar coluna de negócio; sair de estado terminal; DELETE; segunda reversão da mesma referência (índice único parcial) |
| `wallet_ledger_entries` | UPDATE, DELETE e TRUNCATE (só INSERT); aritmética errada (CHECK); dois lançamentos da mesma transação na wallet (UNIQUE); valor ou moeda diferentes da transação (FK composta) |
| `inbox_messages` | a mesma mensagem duas vezes para o mesmo consumidor (PK) |
| `outbox_messages` | envelope que não bate com a linha; mudar o conteúdo; "despublicar" |

Conferidas no COMMIT por constraint triggers adiados, porque no meio da transação o estado está
incompleto:

- saldo da wallet = `balance_after` do último lançamento;
- cada lançamento continua o saldo do anterior;
- a direção bate com o kind (ROLLBACK: o inverso da referência);
- transação PROCESSED que move saldo tem exatamente 1 lançamento; as outras, nenhum.

Os testes de schema quebram cada regra de propósito e conferem o nome da constraint ou do trigger
no erro, para não passar por acaso com outro erro.

## 8. Regras de negócio e interpretações

| Operação | Saldo | Ledger | Referência |
| --- | --- | --- | --- |
| BET | débito | 1 DEBIT | não aceita |
| WIN | crédito | 1 CREDIT | opcional, só BET |
| LOSS | nenhum | nenhum | opcional, só BET; valor pode ser 0 |
| REFUND | crédito | 1 CREDIT | obrigatória, só BET |
| ROLLBACK | inverso da referência | 1 invertido | obrigatória: BET, WIN ou REFUND |

A referência é buscada por `(providerId, referenceExternalTransactionId)` e precisa ser do mesmo
provider, player, wallet, moeda e rodada. REFUND e ROLLBACK exigem valor igual ao da referência.

Interpretações adotadas:

- **Uma reversão por referência, qualquer que seja o tipo.** O enunciado diz "não pode ser
  revertida duas vezes pelo mesmo tipo de operação". Ao pé da letra, uma BET poderia receber
  REFUND e depois ROLLBACK e o jogador ganharia o crédito duas vezes, o que fere a invariante
  global de não duplicar créditos. O índice único parcial é por referência, para REFUND e
  ROLLBACK juntos. Desfazer um REFUND continua possível: o ROLLBACK aponta para o REFUND.
- **WIN e LOSS com referência** são conferidos como os outros e também podem esperar a BET
  (PENDING_REFERENCE).
- **OPENING** é interno: recusado pela API (400) e pela fila (direto para a DLQ). Abertura com saldo grava wallet,
  transação OPENING e lançamento CREDIT na mesma transação SQL. Saldo inicial zero não gera
  OPENING.
- **Wallet inexistente** responde 422 `WALLET_NOT_FOUND` sem gravar transação, porque a FK exige
  a wallet. Os ids de wallet são gerados pelo servidor, então o provedor não tem como mandar um id
  que passe a existir depois. Ver limitações.
- **Validação antes do banco.** A transação é montada e validada inteira antes de abrir a
  transação SQL: payload inválido é 400 mesmo que a wallet não exista.

### Transições de estado

```text
PENDING ──▶ PROCESSED | REJECTED | FAILED | PENDING_REFERENCE
PENDING_REFERENCE ──▶ PENDING_REFERENCE (nova tentativa) | PROCESSED | REJECTED | FAILED
PROCESSED, REJECTED, FAILED: terminais
```

Transicionar uma transação terminal lança `InvalidTransactionStateError` (erro de programação),
e o trigger do banco também recusa. `PENDING` só existe dentro da transação SQL: a decisão
acontece antes do COMMIT.

### Referências fora de ordem

- A transação fica PENDING_REFERENCE (HTTP 202) e o evento `WagerTransactionPendingReference` é
  publicado.
- O worker pega as vencidas com `FOR UPDATE SKIP LOCKED`, uma transação SQL por pendência, e
  aplica a mesma regra da chegada (`WagerSettlement`).
- Backoff 1 s, 2 s, 4 s ... teto de 60 s, até 10 novas tentativas: cerca de 5 minutos. Uma BET
  atrasada por retry do provedor ou pela fila chega em segundos; se não chegou em minutos, é erro
  do provedor, e segurar mais só atrasa a resposta. Configurável (`REFERENCE_RETRY_*`).
- Esgotado: REJECTED com `REFERENCE_NOT_FOUND` (ou `REFERENCE_NOT_PROCESSED`, se a referência
  existe mas nunca terminou) e `WagerTransactionRejected`.
- Se a tentativa der erro (bug, constraint, lock_timeout), o erro conta como tentativa gasta,
  gravado numa transação separada com o mesmo backoff. Sem isso, a pendência voltaria igual para
  a frente da fila e travaria as outras. Esgotado: FAILED com `PERMANENT_PROCESSING_ERROR` e
  `WagerTransactionFailed`.

## 9. failureCode

Toda rejeição carrega um código estável. O provedor decide pelo código, nunca pela mensagem.

| failureCode | Quando | O que o provedor faz |
| --- | --- | --- |
| `INSUFFICIENT_FUNDS` | BET maior que o saldo | não reenviar; só uma nova aposta |
| `REVERSAL_INSUFFICIENT_FUNDS` | ROLLBACK de WIN ou REFUND deixaria saldo negativo | não reenviar; tratar manualmente (o jogador já gastou o crédito) |
| `CURRENCY_MISMATCH` | moeda da operação diferente da wallet | corrigir o payload |
| `WALLET_NOT_FOUND` | wallet não existe | corrigir o walletId |
| `WALLET_PLAYER_MISMATCH` | wallet de outro player | corrigir o payload |
| `REFERENCE_NOT_FOUND` | referência não chegou no limite do worker | enviar a referência e, depois, a reversão com um novo id |
| `REFERENCE_MISMATCH` | referência de outro player, wallet, moeda ou rodada | corrigir o payload |
| `REFERENCE_KIND_NOT_ALLOWED` | tipo de referência não permitido (ex.: REFUND de WIN) | corrigir o payload |
| `REFERENCE_NOT_PROCESSED` | referência REJECTED ou FAILED | desistir: não há o que reverter |
| `REFERENCE_AMOUNT_MISMATCH` | valor diferente da referência | corrigir o valor (reversão parcial está fora de escopo) |
| `REFERENCE_ALREADY_REVERSED` | referência já revertida | desistir: já foi feito |
| `PERMANENT_PROCESSING_ERROR` | FAILED: erro nosso, repetido até o limite | falar com a operação; não é regra de negócio |

## 10. Status HTTP

Iguais em todos os endpoints, e o replay devolve o mesmo status da resposta original.

| Status | Significado | Pode reenviar? |
| --- | --- | --- |
| 201 | processada (`status: PROCESSED`); também wallet criada | é replay |
| 202 | aceita, aguardando a referência (`PENDING_REFERENCE`) | é replay |
| 400 | payload inválido (formato, Money, OPENING, header ausente, cursor) | só corrigido |
| 404 | wallet ou transação inexistente nas consultas | não |
| 409 | conflito de idempotência (com `existingTransactionId`) ou wallet duplicada | não com o mesmo payload |
| 422 | rejeição de negócio, sempre com `failureCode` | não |
| 503 | transitória: banco fora, lock_timeout, deadlock; com `Retry-After` | sim, com a mesma key |
| 500 | FAILED (com `failureCode`) ou erro inesperado | falar com a operação |

## 11. Outbox

- O evento é gravado na mesma transação SQL da operação. Nada é publicado antes do COMMIT.
- O relay pega lotes com `FOR UPDATE SKIP LOCKED`, publica com SendMessageBatch e marca como
  publicado na mesma transação. Vários publishers pegam lotes diferentes.
- Se o processo morrer depois de publicar e antes do COMMIT, o lote volta e sai de novo:
  at-least-once. Para isso ser seguro, `MessageDeduplicationId = eventId` (a FIFO descarta a
  repetição dentro de 5 minutos) e todo evento leva `eventId` para quem consome deduplicar fora
  dessa janela.
- Falha de publicação: tentativa contada, erro guardado em `last_error`, próxima com backoff de
  1 s a 5 min. Nunca desiste: evento confirmado não pode ser perdido.
- O cliente SQS não tem retry próprio (`maxAttempts: 1`): o retry é o da outbox, registrado no
  banco. Dois níveis multiplicariam as tentativas.
- Destino: `wagering-events.fifo`, com `MessageGroupId = walletId`. O enunciado não define para
  onde os eventos vão.
- Eventos: `WagerTransactionProcessed` (inclusive LOSS), `WagerTransactionRejected`,
  `WalletBalanceChanged` (só quando o saldo muda), `WagerTransactionPendingReference` e
  `WagerTransactionFailed`. Envelope `IntegrationEvent` abstrato, com `eventType` e `version` no
  tipo de cada subclasse, `aggregateId = walletId` e `data` com `MoneyProps`.

## 12. Consumidor SQS

- Chama o mesmo `ProcessWagerTransaction` do HTTP.
- O inbox é gravado na transação da operação; a mensagem só é apagada (ack) depois do COMMIT.
- Classificação:
  - **negócio** (REJECTED, `WALLET_NOT_FOUND`): é resultado, ack;
  - **transitório** (lock_timeout, banco fora, erro inesperado): `ChangeMessageVisibility` com
    2, 4, 8, 16 s; na 6ª entrega a redrive policy (`maxReceiveCount: 5`) manda para a DLQ;
  - **permanente** (mensagem inválida, conflito de idempotência, messageId reutilizado com outro
    conteúdo): direto para a DLQ, com o motivo no atributo `reason`.
- Grupos diferentes em paralelo; mensagens do mesmo grupo em sequência.
- SIGTERM: para de buscar (aborta o long poll), termina a mensagem em andamento e devolve com
  visibilidade 0 as recebidas que não começaram. O compose dá 30 s antes do SIGKILL.

## 13. Observabilidade

- Logs JSON (pino), inclusive os do Nest, com `correlationId`, `messageId`, `transactionId`,
  `walletId` e `providerId`. Valores não são logados; o `redact` de money, balance, amount,
  payload e body é a segunda barreira.
- `x-correlation-id`: usa o do chamador ou cria um, devolve no header e grava nos eventos. Na
  fila, a correlação é o messageId.
- Métricas Prometheus em `/metrics`:

| Pedido da seção 12 | Métrica |
| --- | --- |
| transações por status | `wagering_transactions_total{status,kind,source}` |
| duplicatas detectadas | `wagering_duplicates_detected_total{type}` (replay, conflito, mensagem repetida) |
| retries | `wagering_retries_total{component}` (consumer, outbox, reference) |
| mensagens em DLQ | `wagering_dlq_messages_total{reason}` e `wagering_dlq_depth` |
| conflitos de lock | `wagering_lock_conflicts_total{type}` e `wagering_wallet_lock_wait_seconds` |
| outbox lag | `wagering_outbox_lag_seconds` e `wagering_outbox_pending` |
| latência de processamento | `wagering_processing_duration_seconds` |
| reconciliação | `wagering_reconciliation_divergences_total` |

  Lag e pendências da outbox e profundidade da DLQ são lidos na hora do scrape (banco e
  GetQueueAttributes), para não divergirem entre instâncias.
- `/health/live`: o processo responde. `/health/ready`: PostgreSQL e SQS alcançáveis, senão 503.

## 14. Reconciliação

`POST /wallets/:id/reconciliation` trava a wallet, soma o ledger e compara com o saldo gravado.
Divergência é logada, contada em métrica e sinalizada (`consistent: false`, `difference`). Não é
corrigida: corrigir esconderia o bug que a causou, e um ajuste precisa virar lançamento auditável
decidido por uma pessoa. O teste simula corrupção vinda de fora da aplicação desligando os
triggers (`session_replication_role = replica`, só superusuário).

## 15. Autenticação

Não implementada, por decisão de escopo (a seção 2 aceita e ela não pontua). O ponto de extensão
é o `ProviderAuthGuard` (`src/http/provider-auth.guard.ts`), aplicado aos controllers de wallets
e transações, que hoje deixa tudo passar. Health e métricas ficam fora dele.

Desenho com Keycloak:

1. Um realm para os provedores; cada provedor é um client OIDC confidencial que obtém token por
   **client credentials**. Nada de usuário e senha guardados no serviço.
2. O guard lê o Bearer token e valida assinatura, emissor, audiência e validade com as chaves
   públicas (JWKS) do realm, em cache. Token ausente ou inválido: 401.
3. Um mapper do Keycloak põe a claim `providerId` no token. O guard compara com o `providerId` da
   operação (corpo ou URL). Diferente: 403. Assim um provedor não opera em nome de outro.
4. Mensagens da fila são canal interno confiável (seção 2), mas o `providerId` delas passa pelas
   mesmas validações de domínio.

## 16. Testes

Todos contra PostgreSQL e MiniStack reais em containers. Nenhum teste substitui banco ou fila
por mock. Depois de cada teste de integração e de concorrência, um hook global confere a
invariante `saldo da wallet == saldo reconstruído pelo ledger` para todas as wallets do banco.
O mapa dos testes obrigatórios está no README.

## 17. Teste de carga

`bun run test:load` (script em `test/load/run.ts`, metodologia no topo dele). Resultado da última
rodada em [docs/carga-resultado.md](docs/carga-resultado.md).

**Ambiente.** i3-9100F (4 núcleos), 16 GB, Windows 10, Docker Desktop. O gerador de carga, as 3
instâncias do app, o PostgreSQL e o MiniStack rodam na mesma máquina e disputam os mesmos 4
núcleos. Os números descrevem esse conjunto; não são o limite do serviço numa máquina dedicada.

**Metodologia.** 3 instâncias como processos separados, com todos os workers ligados. O gerador
mantém N requisições em voo (laço fechado), alternando entre as instâncias. Cada requisição é
uma BET de 1,00 com idempotency key nova, em wallets com saldo de sobra: tudo que não for 201
conta como erro. Dois cenários de 20 s, depois de 3 s de aquecimento: 200 wallets sorteadas
(distribuído) e uma wallet só (quente). A outbox é lida a cada 250 ms durante a medição. No fim,
a invariante saldo == ledger é conferida em todas as wallets, a wallet quente é reconciliada e
procura-se transação com mais de um lançamento.

**Resultados** (duas rodadas, com 8 e com 32 requisições em voo):

| Cenário | Em voo | req/s | p50 (ms) | p95 (ms) | p99 (ms) | Erros | Lag máx. da outbox |
| --- | --- | --- | --- | --- | --- | --- | --- |
| distribuído | 8 | 95 | 78 | 151 | 188 | 0% | 1,1 s |
| distribuído | 32 | 150 | 200 | 359 | 470 | 0% | 14,6 s |
| wallet quente | 8 | 61 | 125 | 223 | 309 | 0% | 0,2 s |
| wallet quente | 32 | 49 | 595 | 1364 | 2166 | 0% | 0,7 s |

Nas duas rodadas: nenhum conflito de lock (lock_timeout ou deadlock), nenhuma divergência entre
saldo e ledger, reconciliação consistente e nenhuma transação com dois lançamentos.

**Análise.**

- **Distribuído.** De 8 para 32 em voo, o throughput sobe 58% (95 para 150 req/s) e o p50 quase
  triplica (78 para 200 ms). A espera pelo lock continua pequena (média de 16 ms), então o tempo
  a mais é fila por CPU e por conexão do pool, não disputa por wallet. Com 4 núcleos para tudo, a
  máquina satura perto de 150 req/s.
- **Wallet quente.** É o custo esperado do lock por wallet: as operações passam uma de cada vez.
  O throughput não cresce com mais concorrência (61 para 49 req/s) e a espera média pelo lock vai
  de 108 para 498 ms. O p99 de 2,2 s ainda fica abaixo do `lock_timeout` de 5 s, por isso nenhum
  503. Com mais concorrência numa wallet só, a espera passaria do teto e as operações
  receberiam 503 (transitório, o provedor reenvia). É o trade-off da seção 5: correção primeiro,
  com a espera medida e com teto.
- **Outbox.** O achado principal. Com 150 apostas/s entram cerca de 300 eventos/s (Processed e
  WalletBalanceChanged), e os 3 publishers, publicando um lote de 10 por vez em série, esvaziaram
  cerca de 190 eventos/s nesta máquina. O lag chegou a 14,6 s, com 4.546 eventos pendentes, e a
  outbox levou 24 s para esvaziar depois que a carga parou. Nenhum evento foi perdido: o atraso é
  medido (`wagering_outbox_lag_seconds`) e se recupera sozinho. Com 95 req/s o lag ficou em 1,1 s.
  Para aguentar mais, o próximo passo seria publicar vários lotes em paralelo em cada instância
  (cada lote já trava linhas diferentes com `SKIP LOCKED`), ou lotes maiores divididos em vários
  SendMessageBatch simultâneos. Não fiz essa mudança.

## 18. Limitações

- **Correlação no worker.** A transação não guarda o correlationId original; os eventos que o
  worker de pendências gera usam o id da transação como correlationId e causationId.
- **WALLET_NOT_FOUND não é gravado.** Sem a wallet, a FK impede a linha. O replay responde de
  novo `WALLET_NOT_FOUND`, mas não há registro auditável nem evento dessa tentativa.
- **FAILED responde 500** no HTTP, inclusive no replay, com `failureCode`. Só o worker de
  pendências produz FAILED. Na chegada (HTTP ou fila), um erro inesperado desfaz a transação
  inteira e nada é gravado: o HTTP responde 500 e a fila tenta de novo até a DLQ.
- **Erro no worker conta como tentativa.** Um lock_timeout que se repetisse por cerca de 5
  minutos na mesma wallet levaria a pendência a FAILED, mesmo sendo transitório.
- **Lock pessimista serializa a wallet.** Uma wallet muito quente processa uma operação por vez
  (cerca de 50 a 60 por segundo no teste de carga, nesta máquina), e acima do `lock_timeout` as
  operações recebem 503.
- **Publisher da outbox mais lento que a entrada sob carga sustentada.** No teste de carga, a
  150 req/s o lag chegou a 14,6 s (seção 17). Sem perda, mas com atraso.
- **Teste de carga numa máquina só**, com gerador, app, banco e emulador disputando 4 núcleos.
- **Interpretação de reversão** mais estrita que o texto (seção 8 deste documento).
- **Deduplicação de eventos fora da janela da FIFO** fica com quem consome (`eventId`). Este
  repositório não tem consumidor de eventos.
- **SIGTERM real só no Linux.** No Windows não há SIGTERM para processo de console; o teste com
  sinal real roda no container (`test/concurrency/sigterm.test.ts`). O teste de integração da
  parada chama `consumer.stop()`, o mesmo método que o desligamento do Nest chama.
- **O teste de reinício** mata processos com SIGKILL quando as respostas HTTP já voltaram; o
  trabalho interrompido é o da fila, da outbox e das pendências. Uma requisição HTTP morta no
  meio é o caso do rollback da transação, coberto pelos testes de atomicidade.
- **MiniStack é um emulador.** Conferi os comportamentos de FIFO, DLQ e visibilidade que o
  projeto usa, mas não rodei contra o SQS da AWS.
- **Multi-moeda** só no modelo e nos testes de conflito; toda moeda usa 2 casas (moedas sem
  centavos, como JPY, não estão previstas).
- **Reconciliação** só sob demanda, por wallet. Não há varredura agendada.
- **Autenticação** não implementada (seção 15).
- **Double-entry, OpenTelemetry e dashboard** ficaram de fora (opcionais no enunciado).
