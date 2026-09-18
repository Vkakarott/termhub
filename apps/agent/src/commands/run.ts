import { readConfig } from '../config.js';
import { exitWithoutRestart } from '../run.js';
import { runForegroundUntilSignal } from './connect.js';
import type { Logger } from './types.js';

/**
 * No config → `exit(78)` (EX_CONFIG) rather than `exitCode = 78`, so a service manager sees a
 * hard, immediate exit and stops retrying (systemd `RestartPreventExitStatus=78`; launchd needs
 * the job booted out, which `exitWithoutRestart` does).
 */
export async function runCommand(log: Logger): Promise<void> {
  const config = readConfig();
  if (!config) {
    return exitWithoutRestart('Nenhuma configuração. Rode: termhub-agent connect --url <url>');
  }
  await runForegroundUntilSignal(config, log);
}
