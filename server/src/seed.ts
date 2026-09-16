import os from 'node:os';
import type { Repositories } from './db/repositories/index.js';

/** Primeiro boot: garante que exista a máquina "local". */
export function seed(repos: Repositories, log: (msg: string) => void): void {
  if (repos.machines.findByType('local').length === 0) {
    const m = repos.machines.create({ name: os.hostname().replace(/\.local$/, '') || 'local', type: 'local' });
    log(`máquina local criada: ${m.name} (${m.id})`);
  }
}
