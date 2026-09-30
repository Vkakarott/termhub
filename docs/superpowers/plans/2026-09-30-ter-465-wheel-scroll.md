# TER-465 — the mouse wheel scrolls the pane, not the prompt history

## Root cause (verified)

- termhub never configures tmux: every tab runs `tmux -u new-session -A` with tmux defaults (`mouse off`,
  `alternate-screen on`). The tmux client puts the browser's xterm.js in the **alternate buffer**
  (`ESC[?1049h`), so xterm.js never has scrollback of its own.
- xterm.js 5.5 (`src/browser/Terminal.ts:800`): with no scrollback and no mouse tracking, a wheel tick
  becomes `ESC[A`/`ESC[B` (`ESC O A`/`ESC O B` in application-cursor mode).
- tmux forwards a pane's mouse-tracking request to the outer terminal even with `mouse off`: Claude Code
  (and Cursor) turn on 1000/1002/1003/1006, so xterm.js sends them real wheel events — they scroll.
- Codex 0.159 runs in the alternate screen, does **not** turn mouse tracking on (it asks for `?1007h`,
  "wheel = arrows"), so the wheel reaches its composer as ↑/↓ = prompt history. Reproduced: one wheel
  tick up filled the composer with the previous prompt. Codex's main view has no scroll of its own in the
  alt screen (only the Ctrl+T transcript overlay); with `--no-alt-screen` its transcript goes to the pane's
  history (verified: `history_size` 76 after one answer).
- A plain shell has the same problem today: the wheel walks the shell's command history.

## Behaviour after the fix

Wheel over a terminal tab:

| pane state (asked to tmux at scroll time)          | wheel up                                   | wheel down                    |
|----------------------------------------------------|--------------------------------------------|-------------------------------|
| app turned mouse tracking on (Claude, Cursor)      | unchanged: xterm.js sends mouse events     | unchanged                     |
| pane already in a tmux mode (copy-mode)            | `send -X -N n scroll-up`                   | `send -X -N n scroll-down` (copy-mode `-e` leaves at the bottom) |
| alternate screen, foreground is Codex              | nothing (never walk the prompt history)    | nothing                       |
| alternate screen, anything else (less, vim, man)   | `send-keys -N n Up` (today's behaviour)    | `send-keys -N n Down`         |
| normal screen (shell, Codex `--no-alt-screen`)     | `copy-mode -e` + `send -X -N n scroll-up`  | nothing                       |

The first key typed after a wheel scroll leaves copy-mode first (`if -F '#{pane_in_mode}' 'send -X cancel'`),
then the keys go to the app — like a terminal that snaps back to the bottom on input.

Codex started by termhub (`control/agents.ts`, provider `chatgpt`) gets `--no-alt-screen`, so its messages
land in the pane history and the wheel scrolls them.

## Pieces

1. `@termhub/machine-ops`: `scroll-script.ts` — one POSIX `sh` script (single source of truth for agent and
   ssh/local) taking `<session> <lines>` (signed int, negative = up/older, 0 = "leave copy-mode") that
   implements the table above against target `=<session>:`. Codex detection only in the alt-screen branch:
   a process on `#{pane_tty}` whose `ps -o comm=` basename is `codex`. Test it against a real tmux on a
   private socket (`tmux -L th-test-…`, `-f /dev/null`), skipped when tmux is missing; kill that server in
   `afterAll`. Never touch the default tmux socket.
2. `@termhub/agent-protocol` `rpc.ts`: `tmux.scroll` `{ session, lines: int, -500..500 }` → `{ done: true }`.
3. Agent: handler in `rpc/tmux.ts`, registered in `rpc/index.ts`; runs the script with `sh -c`. Bump the agent
   to **0.12.0** (`apps/agent/package.json`, `apps/agent/src/version.ts`, root `package-lock.json`).
4. Server: `session-ops.ts` `scrollSession(machine, session, lines)` (agent → `tmux.scroll`; ssh/local → the
   same script through `runOnMachine`, shell-quoted). `TERMINAL_SCROLL_MIN_AGENT_VERSION = '0.12.0'`.
   `terminal/ws.ts`: control message `{ type: 'scroll', lines }` (zod, int, -500..500, not 0); one call in
   flight per connection, later deltas coalesced; remembers it scrolled and, on the next binary input, awaits
   `scrollSession(…, 0)` before writing (inputs queued in order meanwhile; errors swallowed, logged as
   metadata only). `ready` gains `scroll: boolean` — true for ssh/local, and for an agent at ≥ 0.12.0.
5. Web: `terminal-connection.ts` keeps `canScroll` from `ready` and gets `sendScroll(lines)`. `Terminal.tsx`
   `term.attachCustomWheelEventHandler`: when `canScroll` and `term.modes.mouseTrackingMode === 'none'`,
   turn the wheel into lines (pure helper in `lib/wheel-lines.ts` with tests: deltaMode pixel/line/page,
   fractional carry), send them coalesced (one message per animation frame), `preventDefault`, return false;
   otherwise return true (xterm.js as today). An older server (no `scroll` in `ready`) keeps today's behaviour.
6. `control/agents.ts`: `--no-alt-screen` for Codex launches (+ tests).
7. `docs/lessons/2026-09-30-wheel-in-tmux-sends-arrows.md`.
