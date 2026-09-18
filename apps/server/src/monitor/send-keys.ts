import type { Machine } from '../db/repositories/types.js';
import { REMOTE_PATH_PREFIX, assertSessionName, runOnMachine, shellQuote } from '../terminal/machine-exec.js';

export const INPUT_MAX_CHARS = 4000;

/**
 * Types `text` into the tab's tmux session (literal keys) and, with `enter`, presses Enter after a
 * short pause — TUIs like Claude Code treat a burst of bytes as a paste, so the Enter must arrive
 * on its own. Works with or without a terminal attached in the browser.
 */
export async function sendKeysToSession(machine: Machine, session: string, text: string, enter: boolean): Promise<{ ok: boolean; error: string | null }> {
  assertSessionName(session);
  if (text.length > INPUT_MAX_CHARS) throw new Error('Texto longo demais');
  const target = shellQuote(`=${session}`);
  const parts: string[] = [];
  if (text) parts.push(`tmux send-keys -t ${target} -l -- ${shellQuote(text)}`);
  if (enter) {
    if (text) parts.push('sleep 0.3');
    parts.push(`tmux send-keys -t ${target} Enter`);
  }
  if (parts.length === 0) return { ok: true, error: null };
  const script = parts.join(' && ');
  const r = await runOnMachine(machine, { file: 'sh', args: ['-c', script] }, `${REMOTE_PATH_PREFIX}${script}`, 10_000);
  if (r.code !== 0) return { ok: false, error: r.timedOut ? 'A máquina não respondeu a tempo' : r.stderr.trim().split('\n').pop() || 'tmux send-keys falhou' };
  return { ok: true, error: null };
}
