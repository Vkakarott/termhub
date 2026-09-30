---
symptom: "Mouse wheel over a Codex (or shell) tab fills the composer with the previous prompt instead of scrolling"
tags: [terminal, tmux, xterm, codex, wheel]
evidence: fixed
card: TER-465
agent: claude
date: 2026-09-30
---
## Cause

termhub never configures tmux: every tab runs `tmux -u new-session -A` with tmux's defaults (`mouse off`,
`alternate-screen on`). The tmux client puts the browser's xterm.js in the **alternate buffer**
(`ESC[?1049h`), so xterm.js has no scrollback of its own, and xterm.js 5.5 turns a wheel tick with no
scrollback and no mouse tracking into `ESC[A` / `ESC[B` (Up/Down).

tmux forwards a pane's mouse-tracking request to the outer terminal even with `mouse off`, so Claude Code
(and Cursor), which turn on `?1000/1002/1003/1006`, get real wheel events and scroll. Codex 0.159 does not
turn mouse tracking on (it asks for `?1007h`, "wheel = arrows"), so the wheel reached its composer as
Up/Down = prompt history. A plain shell had the same problem: the wheel walked its command history.
`#{pane_current_command}` says `node` for an npm-installed Codex, so it cannot tell Codex apart.

## Fix

The wheel scrolls the tmux pane from the server instead of reaching the program:

- `buildScrollScript` (`packages/machine-ops/src/scroll-script.ts`) asks tmux what the pane is doing and
  scrolls copy-mode (`copy-mode -e` + `send -X -N n scroll-up` on the normal screen), keeps Up/Down for
  other alternate-screen programs (less, vim), and sends nothing when a process named `codex` runs on
  `#{pane_tty}` (`ps -o comm= -t <tty>`). The agent runs it as `tmux.scroll` (agent 0.12.0), ssh/local
  through `runOnMachine`.
- The terminal WebSocket takes `{ type: 'scroll', lines }`; the first key after a scroll first leaves
  copy-mode (`send -X cancel`) so it reaches the program. `ready` carries `scroll: true|false`.
- The web terminal (`attachCustomWheelEventHandler`) sends the wheel as lines when `scroll` is true and
  the app has no mouse tracking on; otherwise xterm.js handles it as before.
- Codex started by termhub gets `--no-alt-screen`, so its transcript lands in the pane history and the
  wheel has something to scroll.

## How to check

On a tab running a shell with some output, wheel up: the pane shows tmux's copy-mode position indicator
and older lines, not the previous command. Typing a key goes back to the bottom and types it. In a Codex tab
the wheel never changes the composer. `npx vitest run src/scroll-script.test.ts` in
`packages/machine-ops` exercises the script against a real tmux on a private socket.
