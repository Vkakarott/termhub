import { SESSION_RE, shellQuote } from './shell.js';

/**
 * What a tab's pane is running in front (TER-643), as one word on stdout:
 *
 * - `shell`: the pane's own process (its shell) holds the terminal — whatever the tab ran on top of it
 *   (Claude Code, Codex) is gone;
 * - `busy`: another process group is in front, the agent or anything else the person started;
 * - `dead`: the pane's process exited and tmux keeps the pane (`remain-on-exit`).
 *
 * The test is the terminal's foreground process group (`tpgid`) against the pane's pid, so it does not
 * depend on how a CLI names itself: Codex installed through npm shows up as `node` in
 * `#{pane_current_command}`. `ps -o tpgid=` answers the same on Linux and macOS. A missing session or
 * pane exits non-zero.
 *
 * `tmux` is the command that runs tmux, trusted and already quoted by the caller (the agent's
 * `TMUX_PATH`, a test's private `-L` socket). The session name is checked and quoted here.
 */
export type PaneForeground = 'shell' | 'busy' | 'dead';

export function buildPaneForegroundScript(session: string, tmux = 'tmux'): string {
  if (!SESSION_RE.test(session) || session.length > 128) throw new Error('invalid tmux session name');
  return [
    `st=$(${tmux} display-message -p -t ${shellQuote(`=${session}:`)} '#{pane_pid} #{pane_dead}') || exit 1`,
    'set -f; set -- $st; set +f',
    'if [ "$2" = 1 ]; then echo dead; exit 0; fi',
    `fg=$(ps -o tpgid= -p "$1" 2>/dev/null | tr -d ' ')`,
    '[ -n "$fg" ] || exit 1',
    'if [ "$fg" = "$1" ]; then echo shell; else echo busy; fi',
  ].join('\n');
}

/** The script's answer, or null for anything else (an older tmux, a stray line). */
export function parsePaneForeground(stdout: string): PaneForeground | null {
  const word = stdout.trim();
  return word === 'shell' || word === 'busy' || word === 'dead' ? word : null;
}
