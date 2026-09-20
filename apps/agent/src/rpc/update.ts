import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { RpcParams, RpcResult } from '@termhub/agent-protocol';
import { RpcFailure, run, type RunResult } from '../exec.js';
import { resolveScriptPath } from '../paths.js';
import * as service from '../service/index.js';
import { AGENT_VERSION } from '../version.js';

/**
 * Self-update, driven by the server: `npm install -g @termhub/agent@<version>` (argv form — the
 * version is validated by the RPC schema and never reaches a shell), then, when this process
 * runs under launchd/systemd, exit 1 so the service relaunches the freshly installed code.
 * `npm i -g` overwrites the same directory the service file points at, so the restart picks
 * the new version up without touching the service definition.
 */
const PACKAGE = '@termhub/agent';
const NPM_TIMEOUT_MS = 150_000;
/** Enough for the rpc_result frame to leave the socket before the process goes away. */
const EXIT_DELAY_MS = 750;

export interface UpdateDeps {
  run: (file: string, args: string[], opts?: { timeoutMs?: number }) => Promise<RunResult>;
  npmPath: () => string;
  installedVersion: () => Promise<string | null>;
  serviceInstalled: () => Promise<boolean>;
  exit: (code: number) => void;
  log: (msg: string, meta?: object) => void;
}

/** The `npm` shipped next to the running node (nvm, Homebrew and the official installer all do that); PATH lookup otherwise. */
export function npmBesideNode(execPath = process.execPath): string {
  const beside = path.join(path.dirname(execPath), 'npm');
  return existsSync(beside) ? beside : 'npm';
}

/** Version of the package this process was started from: <pkg>/dist/cli.js → <pkg>/package.json. */
export async function installedAgentVersion(argv1 = process.argv[1]): Promise<string | null> {
  const script = resolveScriptPath(argv1);
  if (!script) return null;
  try {
    const pkg = JSON.parse(await readFile(path.join(path.dirname(script), '..', 'package.json'), 'utf8')) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : null;
  } catch {
    return null;
  }
}

const defaultDeps: UpdateDeps = {
  run,
  npmPath: npmBesideNode,
  installedVersion: installedAgentVersion,
  serviceInstalled: () => service.status(),
  exit: (code) => process.exit(code),
  log: (msg, meta) => console.error(meta ? `[termhub-agent] ${msg} ${JSON.stringify(meta)}` : `[termhub-agent] ${msg}`),
};

let inFlight: Promise<RpcResult<'agent.update'>> | null = null;

export async function updateAgent(params: RpcParams<'agent.update'>, deps: UpdateDeps = defaultDeps): Promise<RpcResult<'agent.update'>> {
  if (inFlight) throw new RpcFailure('failed', 'update already running');
  inFlight = doUpdate(params.version, deps);
  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}

async function doUpdate(version: string, deps: UpdateDeps): Promise<RpcResult<'agent.update'>> {
  deps.log('update starting', { from: AGENT_VERSION, to: version });
  // npm's own output is never logged: it can echo paths and registry details.
  const r = await deps.run(deps.npmPath(), ['install', '-g', '--no-fund', '--no-audit', `${PACKAGE}@${version}`], { timeoutMs: NPM_TIMEOUT_MS });
  if (r.error === 'enoent') throw new RpcFailure('notfound', 'npm not found on this machine');
  if (r.timedOut) throw new RpcFailure('timeout', 'npm install timed out');
  if (r.code !== 0) {
    deps.log('update failed', { to: version, code: r.code });
    throw new RpcFailure('failed', `npm exited with code ${r.code ?? 'unknown'}`);
  }
  const installed = await deps.installedVersion();
  if (installed !== version) throw new RpcFailure('failed', `installed version mismatch (${installed ?? 'unknown'})`);
  const restart = (await deps.serviceInstalled()) ? 'service' : 'manual';
  deps.log('update installed', { from: AGENT_VERSION, to: version, restart });
  if (restart === 'service') {
    // Reply first; exit 1 (never 78, which would stop the restart loop) so launchd/systemd relaunch us.
    setTimeout(() => deps.exit(1), EXIT_DELAY_MS);
  }
  return { installed_version: installed, restart };
}

export const update = (params: RpcParams<'agent.update'>): Promise<RpcResult<'agent.update'>> => updateAgent(params);
