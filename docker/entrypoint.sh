#!/bin/sh
set -e
cd /app

# The container's own SSH key ("sshkeys" volume). Authorize the public key on the target machines.
SSH_DIR="${HOME:-/home/app}/.ssh"
mkdir -p "$SSH_DIR" && chmod 700 "$SSH_DIR"
if [ ! -f "$SSH_DIR/id_ed25519" ]; then
  echo "[termhub] generating the container SSH key at $SSH_DIR/id_ed25519"
  ssh-keygen -t ed25519 -N "" -C "termhub@$(hostname)" -f "$SSH_DIR/id_ed25519" >/dev/null
fi
echo "[termhub] SSH public key: $(cat "$SSH_DIR/id_ed25519.pub")"

echo "[termhub] applying migrations..."
npx --prefix server prisma migrate deploy --config server/prisma.config.ts
echo "[termhub] starting server"
exec node server/dist/index.js
