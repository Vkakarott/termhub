import type { RpcParams, RpcResult } from '@termhub/agent-protocol';
import { buildFsListScript, buildMkdirScript, shellQuote } from '@termhub/machine-ops';
import { RpcFailure, sh } from '../exec.js';

/**
 * `buildFsListScript`/`buildMkdirScript` always exit 0 and report expected failures (missing
 * path, permission denied, …) as `ERR:` lines in stdout — the server (task 8) is the one that
 * maps those tags to an HTTP error, so handlers here return stdout unchanged. Only a
 * process-level failure (timeout, or a non-zero exit the script itself never produces) becomes
 * an RpcFailure.
 */
function processFailure(method: string, r: { code: number | null; timedOut: boolean }): RpcFailure | null {
  if (r.timedOut) return new RpcFailure('timeout', `${method} timed out`);
  if (r.code !== 0) return new RpcFailure('internal', `${method} exited with code ${r.code}`);
  return null;
}

export async function list(params: RpcParams<'fs.list'>): Promise<RpcResult<'fs.list'>> {
  const r = await sh(buildFsListScript(shellQuote(params.path)));
  const failure = processFailure('fs.list', r);
  if (failure) throw failure;
  return { stdout: r.stdout };
}

export async function mkdir(params: RpcParams<'fs.mkdir'>): Promise<RpcResult<'fs.mkdir'>> {
  const r = await sh(buildMkdirScript(shellQuote(params.parent), shellQuote(params.name)));
  const failure = processFailure('fs.mkdir', r);
  if (failure) throw failure;
  return { stdout: r.stdout };
}
