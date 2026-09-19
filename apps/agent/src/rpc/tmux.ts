import type { RpcParams, RpcResult } from '@termhub/agent-protocol';
import { RpcFailure, run, tmuxPath, type RunResult } from '../exec.js';

/** Pause between the typed text and the Enter that submits it (same value the server used before). */
export const ENTER_PAUSE_MS = 300;

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

/** Target-pane form: tmux only resolves an exact ('=') target-pane when it is colon-qualified (see capture). */
const pane = (session: string) => `=${session}:`;

/** The message tmux printed, first line, for an error meant for the user. */
const why = (stderr: string, fallback: string) => stderr.trim().split('\n')[0] || fallback;

export async function ensure(params: RpcParams<'tmux.ensure'>): Promise<RpcResult<'tmux.ensure'>> {
  const has = await run(tmuxPath(), ['has-session', '-t', `=${params.session}`]);
  const hasFailure = processFailure(has);
  if (hasFailure) throw hasFailure;
  if (has.code === 0) return { created: false };

  const made = await run(tmuxPath(), ['new-session', '-d', '-s', params.session, '-c', params.cwd]);
  const madeFailure = processFailure(made);
  if (madeFailure) throw madeFailure;
  // A bad cwd is the usual reason, and the user is the one who can fix it.
  if (made.code !== 0) throw new RpcFailure('failed', why(made.stderr, 'tmux new-session falhou'), params.cwd);
  return { created: true };
}

export async function sendText(params: RpcParams<'tmux.sendText'>): Promise<RpcResult<'tmux.sendText'>> {
  if (params.text) {
    const typed = await run(tmuxPath(), ['send-keys', '-t', pane(params.session), '-l', '--', params.text]);
    const failure = processFailure(typed);
    if (failure) throw failure;
    if (typed.code !== 0) throw new RpcFailure('notfound', why(typed.stderr, 'session not found'));
    // TUIs read a burst of bytes as a paste, so Enter has to arrive on its own.
    if (params.enter) await new Promise((r) => setTimeout(r, ENTER_PAUSE_MS));
  }
  if (params.enter) {
    const entered = await run(tmuxPath(), ['send-keys', '-t', pane(params.session), 'Enter']);
    const failure = processFailure(entered);
    if (failure) throw failure;
    if (entered.code !== 0) throw new RpcFailure('notfound', why(entered.stderr, 'session not found'));
  }
  return { sent: true };
}

export async function sendKey(params: RpcParams<'tmux.sendKey'>): Promise<RpcResult<'tmux.sendKey'>> {
  const r = await run(tmuxPath(), ['send-keys', '-t', pane(params.session), params.key]);
  const failure = processFailure(r);
  if (failure) throw failure;
  if (r.code !== 0) throw new RpcFailure('notfound', why(r.stderr, 'session not found'));
  return { sent: true };
}
