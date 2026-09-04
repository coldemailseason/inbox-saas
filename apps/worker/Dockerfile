FROM node:24-slim AS builder
RUN npm install -g pnpm@11
WORKDIR /app
ENV SKIP_ENV_VALIDATION=1

COPY . .
RUN --mount=type=cache,target=/pnpm-store pnpm install --store-dir /pnpm-store
RUN pnpm --filter worker build
RUN pnpm --filter worker --prod deploy --legacy /worker-runtime

FROM node:24-slim AS runner
WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder /worker-runtime /app

CMD ["node", "dist/main.mjs"]
