import type { RpcParams, RpcResult } from '@termhub/agent-protocol';
import { DETECT_SCRIPT, parseDetect } from '@termhub/machine-ops';
import { RpcFailure, sh } from '../exec.js';

export async function detect(_params: RpcParams<'tools.detect'>): Promise<RpcResult<'tools.detect'>> {
  const r = await sh(DETECT_SCRIPT);
  if (r.timedOut) throw new RpcFailure('timeout', 'tools.detect timed out');
  if (r.code !== 0) throw new RpcFailure('internal', `tools.detect exited with code ${r.code}`);
  const { os, capabilities } = parseDetect(r.stdout);
  return { os, tools: capabilities };
}
