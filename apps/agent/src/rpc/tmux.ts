import type { RpcParams, RpcResult } from '@termhub/agent-protocol';
import { RpcFailure, run, tmuxPath, type RunResult } from '../exec.js';

/**
 * Turns a process-level tmux failure into the right RpcFailure: a timeout is always a timeout;
 * `error: 'enoent'` means execFile could not even spawn the binary, which we report as
 * `no_tmux`; `error: 'maxbuffer'` means tmux ran but produced more output than the 8 MiB cap
 * (e.g. an enormous `capture-pane`) — a real (if unusual) failure, but not "tmux missing", so
 * it gets `internal` instead of being folded into `no_tmux` alongside ENOENT.
 */
function processFailure(r: Pick<RunResult, 'error' | 'timedOut'>): RpcFailure | null {
  if (r.timedOut) return new RpcFailure('timeout', 'tmux timed out');
  if (r.error === 'enoent') return new RpcFailure('no_tmux', 'tmux not found');
  if (r.error === 'maxbuffer') return new RpcFailure('internal', 'output too large');
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
  // Trailing ':' matters: '-t =name' alone is a target-pane, and tmux only resolves an exact
  // ('=') target-pane string as a session name when it's colon-qualified — with no client
  // attached (as here, run from execFile) a bare '=name' fails with "can't find pane:
  // =name" instead of defaulting to that session's active window/pane. kill-session takes a
  // target-session, which resolves a bare '=name' fine, so it doesn't need this.
  const r = await run(tmuxPath(), ['capture-pane', '-p', '-S', `-${params.lines}`, '-t', `=${params.session}:`]);
  const failure = processFailure(r);
  if (failure) throw failure;
  if (r.code !== 0) throw new RpcFailure('notfound', 'session not found');
  return { text: r.stdout };
}
