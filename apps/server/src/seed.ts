import os from 'node:os';
import { config } from './config.js';
import type { Repositories } from './db/repositories/index.js';

/** Primeiro boot: garante que exista a máquina "local" (desligável com SEED_LOCAL_MACHINE=false, ex.: Docker). */
export async function seed(repos: Repositories, log: (msg: string) => void): Promise<void> {
  if (!config.seedLocalMachine) return;
  if ((await repos.machines.findByType('local')).length === 0) {
    const m = await repos.machines.create({ name: os.hostname().replace(/\.local$/, '') || 'local', type: 'local' });
    log(`máquina local criada: ${m.name} (${m.id})`);
  }
}
