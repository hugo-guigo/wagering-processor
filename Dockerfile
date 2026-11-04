# O Bun roda TypeScript direto: não há etapa de build, só as dependências de produção.
FROM oven/bun:1.4.4-alpine
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
USER bun
EXPOSE 3000
# O Nest trata SIGTERM (enableShutdownHooks): o consumidor termina o que está em andamento e devolve o resto.
CMD ["bun", "run", "src/main.ts"]
