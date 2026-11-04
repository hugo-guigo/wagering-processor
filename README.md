# Wagering Processor

Processador de transações de apostas (desafio técnico da Jungle Gaming).
Em construção: este commit é só o esqueleto (NestJS + MikroORM + PostgreSQL rodando no Bun).

## Rodar

```bash
bun install
docker compose up -d --wait
bun run migrate
bun run start                # http://localhost:3000/health/live
bun run test:integration
```
