import { readConfig } from '../config.js';
import { runForegroundUntilSignal } from './connect.js';
import type { Logger } from './types.js';

/** No config → `exit(78)` (EX_CONFIG) rather than `exitCode = 78`, so a service manager sees a hard, immediate exit and stops retrying (`RestartPreventExitStatus=78`). */
export async function runCommand(log: Logger): Promise<void> {
  const config = readConfig();
  if (!config) {
    console.error('Nenhuma configuração. Rode: termhub-agent connect --url <url>');
    process.exit(78);
  }
  await runForegroundUntilSignal(config, log);
}
