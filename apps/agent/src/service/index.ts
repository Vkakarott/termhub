import path from 'node:path';
import { agentHome } from '../config.js';
import * as launchd from './launchd.js';
import * as systemd from './systemd.js';

export interface ServiceFileOptions {
  node: string;
  script: string;
  logPath: string;
}

/**
 * `script` must be the path to the running `dist/cli.js`, not `import.meta.url` — tsup bundles
 * the CLI into a single file, so `import.meta.url` inside any module of that bundle already
 * points at the bundle itself, but `process.argv[1]` is the more direct source of truth for
 * "the file node was invoked with" and works the same whether this runs from `dist/cli.js` or
 * (in dev) `tsx src/cli.ts`.
 */
export function serviceFileOptions(): ServiceFileOptions {
  return {
    node: process.execPath,
    script: path.resolve(process.argv[1] ?? ''),
    logPath: path.join(agentHome(), 'agent.log'),
  };
}

export type ServicePlatform = 'darwin' | 'linux';

function assertSupported(platform: NodeJS.Platform): asserts platform is ServicePlatform {
  if (platform !== 'darwin' && platform !== 'linux') throw new Error('Sistema não suportado');
}

export async function install(): Promise<void> {
  const platform = process.platform;
  assertSupported(platform);
  const opts = serviceFileOptions();
  if (platform === 'darwin') await launchd.install(opts);
  else await systemd.install(opts);
}

export async function uninstall(): Promise<void> {
  const platform = process.platform;
  assertSupported(platform);
  if (platform === 'darwin') await launchd.uninstall();
  else await systemd.uninstall();
}

export async function status(): Promise<boolean> {
  const platform = process.platform;
  assertSupported(platform);
  if (platform === 'darwin') return launchd.status();
  return systemd.status();
}
