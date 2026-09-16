# syntax=docker/dockerfile:1
# ── Produção: build do web + server, imagem final enxuta com tmux/ssh ──
FROM node:22-alpine AS base
WORKDIR /app

# Dependências (node-pty e argon2 compilam nativo → toolchain no build)
FROM base AS deps
RUN apk add --no-cache python3 make g++ openssl
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
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
COPY --from=build --chown=app:app /app/server/package.json ./server/
COPY --from=build --chown=app:app /app/server/dist ./server/dist
COPY --from=build --chown=app:app /app/server/prisma ./server/prisma
COPY --from=build --chown=app:app /app/server/prisma.config.ts ./server/
COPY --from=build --chown=app:app /app/web/dist ./web/dist
COPY --chown=app:app docker/entrypoint.sh /app/docker/entrypoint.sh
RUN chmod +x /app/docker/entrypoint.sh
USER app
EXPOSE 3000
ENTRYPOINT ["/sbin/tini", "--"]
# entrypoint roda "prisma migrate deploy" antes de subir o servidor
CMD ["/app/docker/entrypoint.sh"]
