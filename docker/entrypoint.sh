#!/bin/sh
set -e
cd /app

# Chave SSH própria do container (volume "sshkeys"). Autorize a pública nas máquinas de destino.
SSH_DIR="${HOME:-/home/app}/.ssh"
mkdir -p "$SSH_DIR" && chmod 700 "$SSH_DIR"
if [ ! -f "$SSH_DIR/id_ed25519" ]; then
  echo "[termhub] gerando chave SSH do container em $SSH_DIR/id_ed25519"
  ssh-keygen -t ed25519 -N "" -C "termhub@$(hostname)" -f "$SSH_DIR/id_ed25519" >/dev/null
fi
echo "[termhub] chave pública SSH: $(cat "$SSH_DIR/id_ed25519.pub")"

echo "[termhub] aplicando migrations..."
npx --prefix server prisma migrate deploy --config server/prisma.config.ts
echo "[termhub] iniciando servidor"
exec node server/dist/index.js
