# syntax=docker/dockerfile:1
# ── Produção: build do web + server, imagem final enxuta com tmux/ssh ──
FROM node:22-alpine AS base
WORKDIR /app

# Dependências (node-pty e argon2 compilam nativo → toolchain no build)
FROM base AS deps
RUN apk add --no-cache python3 make g++ openssl
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY apps/landing/package.json apps/landing/
COPY apps/agent/package.json apps/agent/
COPY packages/agent-protocol/package.json packages/agent-protocol/
COPY packages/machine-ops/package.json packages/machine-ops/
COPY scripts/postinstall.mjs scripts/
RUN npm ci

# Build
FROM deps AS build
COPY . .
RUN npm run prisma:generate && npm run build
# Só dependências de produção na imagem final
RUN npm prune --omit=dev

# Runtime
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
RUN apk add --no-cache tmux openssh-client bash tini \
 && addgroup -S app && adduser -S app -G app -h /home/app -s /bin/bash \
 && mkdir -p /home/app/.ssh && chown app:app /home/app/.ssh && chmod 700 /home/app/.ssh
COPY --from=build --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /app/package.json ./
COPY --from=build --chown=app:app /app/apps/server/package.json ./apps/server/
COPY --from=build --chown=app:app /app/apps/server/dist ./apps/server/dist
COPY --from=build --chown=app:app /app/apps/server/prisma ./apps/server/prisma
COPY --from=build --chown=app:app /app/apps/server/prisma.config.ts ./apps/server/
COPY --from=build --chown=app:app /app/apps/web/dist ./apps/web/dist
COPY --chown=app:app docker/entrypoint.sh /app/docker/entrypoint.sh
RUN chmod +x /app/docker/entrypoint.sh
USER app
EXPOSE 3000
ENTRYPOINT ["/sbin/tini", "--"]
# entrypoint roda "prisma migrate deploy" antes de subir o servidor
CMD ["/app/docker/entrypoint.sh"]
