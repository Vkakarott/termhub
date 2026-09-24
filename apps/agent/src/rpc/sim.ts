import type { RpcParams, RpcResult } from '@termhub/agent-protocol';
import { SIMCTL_BOOT_SCRIPT, SIMCTL_LIST_SCRIPT, UDID_RE } from '@termhub/machine-ops';
import { RpcFailure, agentEnv, sh, type RunResult } from '../exec.js';

/** Re-validated here even though zod already did: the shell only ever sees a udid this regex passed. */
export function checkUdid(udid: string): void {
  if (!UDID_RE.test(udid)) throw new RpcFailure('invalid', 'invalid udid');
}

/** A timeout is a timeout; anything else non-zero is reported with the machine's own first stderr line. */
export function scriptFailure(r: RunResult, what: string): RpcFailure | null {
  if (r.timedOut) return new RpcFailure('timeout', `${what} timed out`);
  if (r.error === 'enoent') return new RpcFailure('internal', '/bin/sh not found');
  if (r.code !== 0) {
    const why = r.stderr.trim().split('\n')[0] || r.stdout.trim().split('\n')[0] || `${what} exited with code ${r.code}`;
    return /tmux: (command )?not found/.test(r.stderr) ? new RpcFailure('no_tmux', 'tmux not found') : new RpcFailure('failed', why);
  }
  return null;
}

export async function list(_params: RpcParams<'sim.list'>): Promise<RpcResult<'sim.list'>> {
  // 14 s: under the server's 15 s so the agent reports the timeout itself.
  const r = await sh(SIMCTL_LIST_SCRIPT, { timeoutMs: 14_000 });
  const failure = scriptFailure(r, 'sim.list');
  if (failure) throw failure;
  return { stdout: r.stdout };
}

export async function boot(params: RpcParams<'sim.boot'>): Promise<RpcResult<'sim.boot'>> {
  checkUdid(params.udid);
  const r = await sh(SIMCTL_BOOT_SCRIPT, { timeoutMs: 59_000, env: { ...agentEnv(), UDID: params.udid } });
  const failure = scriptFailure(r, 'sim.boot');
  if (failure) throw failure;
  // The script ends with `|| true`, so "already booted" arrives here as text; the server reads it.
  return { stdout: r.stdout + r.stderr };
}
