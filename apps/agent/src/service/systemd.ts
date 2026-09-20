import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { agentEnv, run } from '../exec.js';

export const UNIT_NAME = 'termhub-agent';

export interface UnitOptions {
  node: string;
  script: string;
  logPath?: string;
}

/** A systemd user unit that runs `<node> <script> run`, restarting on failure but never after a clean exit(78). */
export function renderUnit({ node, script, logPath }: UnitOptions): string {
  const lines = [
    '[Unit]',
    'Description=termhub agent',
    'After=network-online.target',
    '',
    '[Service]',
    `ExecStart=${node} ${script} run`,
    'Restart=on-failure',
    'RestartSec=2',
    'RestartPreventExitStatus=78',
    `Environment=PATH=${agentEnv().PATH ?? ''}`,
  ];
  if (logPath) {
    lines.push(`StandardOutput=append:${logPath}`, `StandardError=append:${logPath}`);
  }
  lines.push('', '[Install]', 'WantedBy=default.target', '');
  return lines.join('\n');
}

export interface ServiceFileOptions {
  node: string;
  script: string;
  logPath: string;
}

export interface SystemdDeps {
  run?: typeof run;
  /** Home the unit lives under; defaults to the real one. Tests pass a temp dir so they never touch the developer's own service file. */
  home?: string;
}

function unitPath(home = os.homedir()): string {
  return path.join(home, '.config', 'systemd', 'user', `${UNIT_NAME}.service`);
}

export async function install(opts: ServiceFileOptions, deps: SystemdDeps = {}): Promise<void> {
  const runFn = deps.run ?? run;
  const file = unitPath(deps.home);
  const unit = renderUnit({ node: opts.node, script: opts.script, logPath: opts.logPath });

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, unit, 'utf8');

  const reload = await runFn('systemctl', ['--user', 'daemon-reload']);
  if (reload.code !== 0) throw new Error(`systemctl daemon-reload failed (code ${reload.code}): ${reload.stderr.trim()}`);

  const enable = await runFn('systemctl', ['--user', 'enable', '--now', UNIT_NAME]);
  if (enable.code !== 0) throw new Error(`systemctl enable --now failed (code ${enable.code}): ${enable.stderr.trim()}`);

  console.log('Para o agente continuar após o logout: loginctl enable-linger $USER');
}

export async function uninstall(deps: SystemdDeps = {}): Promise<void> {
  const runFn = deps.run ?? run;
  await runFn('systemctl', ['--user', 'disable', '--now', UNIT_NAME]);
  try {
    fs.unlinkSync(unitPath(deps.home));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  await runFn('systemctl', ['--user', 'daemon-reload']);
}

/** True when systemd reports the unit as active. */
export async function status(deps: SystemdDeps = {}): Promise<boolean> {
  const runFn = deps.run ?? run;
  const result = await runFn('systemctl', ['--user', 'is-active', UNIT_NAME]);
  return result.code === 0;
}
