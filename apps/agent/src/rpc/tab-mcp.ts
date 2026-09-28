import os from 'node:os';
import type { RpcParams, RpcResult } from '@termhub/agent-protocol';
import { buildTabMcpRemoveScript, buildTabMcpWriteScript } from '@termhub/machine-ops';
import { RpcFailure, agentEnv, sh } from '../exec.js';

/**
 * Writes a tab's private MCP config file (~/.termhub/tabs/<tab_id>/<file>, spec D7). `body` is
 * piped to the script on stdin only — never part of the script text, an argv or a log line.
 * `home` is only ever overridden by tests (production always uses os.homedir()).
 */
export async function write(params: RpcParams<'tab.mcp.write'>, home = os.homedir()): Promise<RpcResult<'tab.mcp.write'>> {
  const r = await sh(buildTabMcpWriteScript(params.tab_id, params.file), {
    input: Buffer.from(params.body),
    timeoutMs: 10_000,
    env: agentEnv({ ...process.env, HOME: home }),
  });
  if (r.timedOut) throw new RpcFailure('timeout', 'tab.mcp.write timed out');
  if (r.code !== 0) throw new RpcFailure('internal', `tab.mcp.write exited with code ${r.code}`);
  return { ok: true };
}

/** Deletes a tab's whole MCP config dir on close (spec D12). Best effort: a missing dir is not an error. */
export async function remove(params: RpcParams<'tab.mcp.remove'>, home = os.homedir()): Promise<RpcResult<'tab.mcp.remove'>> {
  const r = await sh(buildTabMcpRemoveScript(params.tab_id), {
    timeoutMs: 10_000,
    env: agentEnv({ ...process.env, HOME: home }),
  });
  if (r.timedOut) throw new RpcFailure('timeout', 'tab.mcp.remove timed out');
  if (r.code !== 0) throw new RpcFailure('internal', `tab.mcp.remove exited with code ${r.code}`);
  return { ok: true };
}
