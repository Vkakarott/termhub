# syntax=docker/dockerfile:1
# ── Headless Claude Code for the chat concierge (spec §4) ──
# Debian, not alpine: the CLI ships prebuilt binaries that expect glibc. The image builds the
# workspace itself, because the blue/green deploy builds with `docker compose up --build` and never
# runs a workspace build first. It holds no credential: the account config dirs are mounted.
FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY apps/landing/package.json apps/landing/
COPY apps/agent/package.json apps/agent/
COPY apps/concierge/package.json apps/concierge/
COPY packages/agent-protocol/package.json packages/agent-protocol/
COPY packages/machine-ops/package.json packages/machine-ops/
COPY scripts/postinstall.mjs scripts/
# --ignore-scripts: this image needs no native module (node-pty, argon2 are the server's)
RUN npm ci --ignore-scripts

FROM deps AS build
COPY apps/concierge apps/concierge
RUN npm run build -w @termhub/concierge

FROM node:22-slim AS runner
WORKDIR /srv
ENV NODE_ENV=production
# The CLI version is pinned: the runner's argv contract depends on its flags, and an unpinned
# rebuild is what once dropped --verbose and broke every run. Bump it deliberately, with the
# exact-argv test in apps/concierge/src/run.test.ts as the check.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g @anthropic-ai/claude-code@2.1.278
COPY --from=build /app/apps/concierge/dist ./dist
COPY apps/concierge/package.json ./
RUN npm install --omit=dev --no-audit --no-fund
EXPOSE 4100
# Runs as a non-root user (compose pins it to the host user's uid:gid, see docker-compose.yml): root
# writing in the mounted ~/.claude* dirs would leave them root-owned and break the host user's own
# `claude`. Nothing under /srv is written at runtime, and the CLI needs a writable HOME for its own
# caches, which it never gets as an arbitrary uid — /tmp is the one path always writable here.
ENV HOME=/tmp
USER node
HEALTHCHECK --interval=15s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4100/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
