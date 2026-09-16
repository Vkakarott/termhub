#!/usr/bin/env bash
# Deploy por rsync + docker compose no servidor.
#   npm run deploy                       (usa DEPLOY_TARGET/DEPLOY_PATH do .env ou os padrões abaixo)
#   DEPLOY_TARGET=user@host npm run deploy
set -euo pipefail
cd "$(dirname "$0")/.."
envval() { [ -f .env ] && grep -E "^$1=" .env | tail -1 | cut -d= -f2- || true; }
TARGET="${DEPLOY_TARGET:-$(envval DEPLOY_TARGET)}"; TARGET="${TARGET:-pedrogoiania@192.168.71.10}"
DEST="${DEPLOY_PATH:-$(envval DEPLOY_PATH)}"; DEST="${DEST:-termhub}"

echo "→ sincronizando para $TARGET:$DEST"
rsync -az --delete \
  --exclude node_modules --exclude dist --exclude data --exclude .env --exclude .git \
  --exclude 'server/src/generated' --exclude '.DS_Store' \
  ./ "$TARGET:$DEST/"

echo "→ build + up (perfil prod)"
ssh "$TARGET" "cd $DEST && docker compose --profile prod up -d --build 2>&1 | tail -3 && sleep 5 && docker compose ps --format '{{.Name}} {{.Status}}'"
