import { config } from '../config.js';
import type { Machine } from '../db/repositories/types.js';
import { REMOTE_PATH_PREFIX, assertSessionName, runOnMachine } from '../terminal/machine-exec.js';
import { agentRpc } from './errors.js';

const tmux = () => config.terminal.tmuxPath;

/**
 * Captures the last `lines` of a tmux pane's output as plain text. Internal helper only
 * (no HTTP route) — used wherever the server needs a snapshot of what's on screen.
 * Returns '' on any local/ssh failure instead of throwing, matching the pre-agent behaviour.
 */
export async function captureScreen(machine: Machine, session: string, lines = 500): Promise<string> {
  assertSessionName(session);
  const n = Math.max(1, Math.min(5000, Math.trunc(lines)));

  if (machine.type === 'agent') {
    const { text } = await agentRpc(machine, 'tmux.capture', { session, lines: n });
    return text;
  }

  const r = await runOnMachine(
    machine,
    { file: tmux(), args: ['capture-pane', '-p', '-S', `-${n}`, '-t', `=${session}`] },
    `${REMOTE_PATH_PREFIX}tmux capture-pane -p -S -${n} -t '=${session}'`,
  );
  return r.code === 0 ? r.stdout : '';
}
