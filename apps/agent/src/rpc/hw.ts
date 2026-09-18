import type { RpcParams, RpcResult } from '@termhub/agent-protocol';
import { HARDWARE_SCRIPT } from '@termhub/machine-ops';
import { RpcFailure, sh } from '../exec.js';

export async function probe(_params: RpcParams<'hw.probe'>): Promise<RpcResult<'hw.probe'>> {
  // 14s: a hair under the server's 15s RPC timeout, so the agent reports "timeout" itself
  // instead of the server timing out the whole call first.
  const r = await sh(HARDWARE_SCRIPT, { timeoutMs: 14000 });
  if (r.timedOut) throw new RpcFailure('timeout', 'hw.probe timed out');
  if (r.code !== 0) throw new RpcFailure('internal', `hw.probe exited with code ${r.code}`);
  return { stdout: r.stdout };
}
