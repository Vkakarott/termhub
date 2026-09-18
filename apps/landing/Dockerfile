# syntax=docker/dockerfile:1
# ── Landing (termhub.dev): static build served by nginx ──
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY apps/landing/package.json apps/landing/
COPY scripts/postinstall.mjs scripts/
# --ignore-scripts: the other workspaces' native modules (node-pty, argon2) are not needed here
RUN npm ci --ignore-scripts
COPY apps/landing apps/landing
RUN npm run build -w @termhub/landing

FROM nginx:1.27-alpine AS runner
COPY apps/landing/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/landing/dist /usr/share/nginx/html
EXPOSE 80
