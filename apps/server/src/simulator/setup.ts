import { WDA_SETUP_SESSION, WDA_SETUP_SH, WDA_SETUP_START_SCRIPT, WDA_SETUP_STATE_SCRIPT } from '@termhub/machine-ops';
import type { Machine } from '../db/repositories/types.js';
import { conflict } from '../lib/errors.js';
import { runScript } from './machine.js';

export { WDA_SETUP_SESSION };

export interface WdaSetupState {
  state: 'idle' | 'running' | 'ok' | 'failed';
  tail: string[];
  version: string | null;
}

/** Kept for callers/tests: the file the machine runs inside tmux. */
export function wdaSetupScript(): string {
  return WDA_SETUP_SH;
}

export function parseSetupOutput(stdout: string): WdaSetupState {
  const lines = stdout.split('\n');
  let state: WdaSetupState['state'] = 'failed';
  let version: string | null = null;
  const tail: string[] = [];
  let inTail = false;
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    if (inTail) {
      if (line.trim()) tail.push(line);
      continue;
    }
    if (line.startsWith('STATE:')) {
      const s = line.slice(6).trim();
      if (s === 'idle' || s === 'running' || s === 'ok' || s === 'failed') state = s;
    } else if (line.startsWith('VERSION:')) {
      version = line.slice(8).trim() || null;
    } else if (line.startsWith('TAIL:')) {
      inTail = true;
    }
  }
  return { state, tail, version };
}

export async function wdaSetupState(machine: Machine): Promise<WdaSetupState> {
  const r = await runScript(machine, WDA_SETUP_STATE_SCRIPT);
  if (r.code !== 0 && !r.stdout) throw new Error(r.stderr.trim() || 'máquina inacessível');
  return parseSetupOutput(r.stdout);
}

export async function startWdaSetup(machine: Machine): Promise<void> {
  const current = await wdaSetupState(machine);
  if (current.state === 'running') throw conflict('Preparação do WDA já está em andamento');
  // One script: writes ~/.termhub/wda-setup.sh and starts it in tmux so it survives an ssh/server drop.
  const r = await runScript(machine, WDA_SETUP_START_SCRIPT);
  if (r.code !== 0 || !r.stdout.includes('STARTED:')) throw new Error(r.stderr.trim() || 'falha ao iniciar o setup no tmux');
}
