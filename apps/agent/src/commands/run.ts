import { readConfig } from '../config.js';
import { exitWithoutRestart } from '../run.js';
import * as service from '../service/index.js';
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
  // A self-update replaces the code but never the service definition, so this is the only place
  // a unit written by an older agent gets fixed. Never fatal: the agent must connect regardless.
  try {
    if (await service.refresh()) log('service definition refreshed');
  } catch (err) {
    log('service definition could not be refreshed', { error: err instanceof Error ? err.message : String(err) });
  }
  await runForegroundUntilSignal(config, log);
}
