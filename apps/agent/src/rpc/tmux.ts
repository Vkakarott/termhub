import type { RpcParams, RpcResult } from '@termhub/agent-protocol';
import { RpcFailure, run, tmuxPath } from '../exec.js';

/**
 * Turns a process-level tmux failure into the right RpcFailure: a timeout is always a timeout,
 * and — once that's ruled out — `code === null` means execFile could not even spawn the binary
 * (ENOENT), which we report as `no_tmux` rather than a generic internal error.
 */
function processFailure(r: { code: number | null; timedOut: boolean }): RpcFailure | null {
  if (r.timedOut) return new RpcFailure('timeout', 'tmux timed out');
  if (r.code === null) return new RpcFailure('no_tmux', 'tmux not found');
  return null;
}

export async function list(_params: RpcParams<'tmux.list'>): Promise<RpcResult<'tmux.list'>> {
  const r = await run(tmuxPath(), ['list-sessions', '-F', '#{session_name}']);
  const failure = processFailure(r);
  if (failure) throw failure;
  // Non-zero here just means "no tmux server running" — same as the server's own runOnMachine path.
  if (r.code !== 0) return { sessions: [] };
  const sessions = r.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  return { sessions };
}

export async function kill(params: RpcParams<'tmux.kill'>): Promise<RpcResult<'tmux.kill'>> {
  const r = await run(tmuxPath(), ['kill-session', '-t', `=${params.session}`]);
  const failure = processFailure(r);
  if (failure) throw failure;
  return { killed: r.code === 0 };
}

export async function capture(params: RpcParams<'tmux.capture'>): Promise<RpcResult<'tmux.capture'>> {
  const r = await run(tmuxPath(), ['capture-pane', '-p', '-S', `-${params.lines}`, '-t', `=${params.session}`]);
  const failure = processFailure(r);
  if (failure) throw failure;
  if (r.code !== 0) throw new RpcFailure('notfound', 'session not found');
  return { text: r.stdout };
}
