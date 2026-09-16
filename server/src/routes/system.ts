import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';

/** Informações do servidor úteis para configurar máquinas (ex.: chave pública SSH a autorizar). */
export async function systemRoutes(app: FastifyInstance) {
  app.get('/ssh-key', async () => {
    const dir = path.join(os.homedir(), '.ssh');
    for (const name of ['id_ed25519.pub', 'id_rsa.pub', 'id_ecdsa.pub']) {
      try {
        const key = (await fs.readFile(path.join(dir, name), 'utf8')).trim();
        if (key) return { public_key: key, file: name };
      } catch {
        /* próxima */
      }
    }
    return { public_key: null, file: null };
  });
}
