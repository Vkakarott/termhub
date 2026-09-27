import type { RpcParams, RpcResult } from '@termhub/agent-protocol';
import { buildDocsReadScript, buildDocsScanScript, shellQuote } from '@termhub/machine-ops';
import { RpcFailure, sh } from '../exec.js';

/**
 * Both scripts always exit 0 and report expected failures (missing cwd, a skipped file, …) as
 * tagged lines in stdout — the server is the one that reads those tags, so handlers here return
 * stdout unchanged. Only a process-level failure (timeout, or a non-zero exit the script itself
 * never produces) becomes an RpcFailure — same split as fs.ts.
 */
function processFailure(method: string, r: { code: number | null; timedOut: boolean }): RpcFailure | null {
  if (r.timedOut) return new RpcFailure('timeout', `${method} timed out`);
  if (r.code !== 0) return new RpcFailure('internal', `${method} exited with code ${r.code}`);
  return null;
}

export async function scan(params: RpcParams<'docs.scan'>): Promise<RpcResult<'docs.scan'>> {
  const r = await sh(buildDocsScanScript(shellQuote(params.cwd)));
  const failure = processFailure('docs.scan', r);
  if (failure) throw failure;
  return { stdout: r.stdout };
}

export async function read(params: RpcParams<'docs.read'>): Promise<RpcResult<'docs.read'>> {
  const r = await sh(buildDocsReadScript(shellQuote(params.cwd), params.paths.map(shellQuote)));
  const failure = processFailure('docs.read', r);
  if (failure) throw failure;
  return { stdout: r.stdout };
}
