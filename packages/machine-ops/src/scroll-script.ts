import { SESSION_RE, shellQuote } from './shell.js';

/** The most lines one wheel call may scroll, either way (the `tmux.scroll` RPC and the terminal WS cap it too). */
export const SCROLL_MAX_LINES = 500;

/**
 * The script behind a mouse-wheel scroll over a terminal tab (TER-465), the single source for the
 * agent (`tmux.scroll`) and for ssh/local machines (`runOnMachine`). `lines` < 0 scrolls up (older
 * output), > 0 down, and 0 means "leave copy-mode" (sent before the first key typed after a scroll).
 *
 * tmux runs with its defaults (`mouse off`, `alternate-screen on`), so the browser's xterm.js sits in
 * the alternate buffer with no scrollback and turns a wheel tick into Up/Down — which walks a shell's
 * or Codex's prompt history. The server now asks tmux what the pane is doing at scroll time:
 *
 * - already in a mode (copy-mode): scroll it; copy-mode `-e` leaves by itself at the bottom;
 * - alternate screen with Codex in front: nothing — its composer would read Up as "previous prompt";
 * - alternate screen, anything else (less, vim, man): Up/Down, as before;
 * - normal screen with history: `copy-mode -e` and scroll up; down does nothing.
 *
 * Codex is found by the processes on the pane's tty, not `#{pane_current_command}`: installed through
 * npm, that says `node`. `ps -o comm=` prints a full path on macOS and the name on Linux, so only its
 * basename is compared. `ps -t` takes `ttys003` / `pts/3`, so the `/dev/` tmux prints is dropped.
 *
 * `tmux` is the command that runs tmux, trusted and already quoted by the caller (the agent's
 * `TMUX_PATH`, a test's private `-L` socket). Every other value is checked and quoted here.
 */
export function buildScrollScript(session: string, lines: number, tmux = 'tmux'): string {
  if (!SESSION_RE.test(session) || session.length > 128) throw new Error('invalid tmux session name');
  if (!Number.isInteger(lines) || Math.abs(lines) > SCROLL_MAX_LINES) throw new Error('invalid scroll line count');
  const n = Math.abs(lines);
  const head = [
    `tm() { ${tmux} "$@"; }`,
    `p=${shellQuote(`=${session}:`)}`,
    // one query: in a mode, alternate screen, history lines, tty — no space can appear in any of them
    `st=$(tm display-message -p -t "$p" '#{pane_in_mode} #{alternate_on} #{history_size} #{pane_tty}') || exit 1`,
    'set -f; set -- $st; set +f',
  ];
  const codex = `ps -o comm= -t "\${4#/dev/}" 2>/dev/null | sed 's#.*/##' | grep -qx codex`;
  let body: string;
  if (lines === 0) {
    body = `if [ "$1" = 1 ]; then tm send -X -t "$p" cancel; fi`;
  } else if (lines < 0) {
    body = [
      `if [ "$1" = 1 ]; then tm send -X -t "$p" -N ${n} scroll-up`,
      `elif [ "$2" = 1 ]; then if ! ${codex}; then tm send-keys -t "$p" -N ${n} Up; fi`,
      `elif [ "$3" -gt 0 ]; then tm copy-mode -e -t "$p" && tm send -X -t "$p" -N ${n} scroll-up`,
      'fi',
    ].join('\n');
  } else {
    body = [
      `if [ "$1" = 1 ]; then tm send -X -t "$p" -N ${n} scroll-down`,
      `elif [ "$2" = 1 ]; then if ! ${codex}; then tm send-keys -t "$p" -N ${n} Down; fi`,
      'fi',
    ].join('\n');
  }
  return `${head.join('\n')}\n${body}\n`;
}
