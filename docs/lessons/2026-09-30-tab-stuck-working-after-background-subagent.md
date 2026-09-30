---
symptom: "a Claude Code tab stays working for hours while the screen shows an empty prompt or a question; no card reaches the chat"
tags: [monitor, hooks, subagent, background, claude-code]
evidence: fixed
card: TER-615
agent: claude
date: 2026-09-30
---
## Cause

When a Claude Code turn ends and leaves subagents running in the background, the `Stop` hook is
followed by more hook events from those subagents: every one of their tool calls fires a
`PreToolUse` that carries `agent_id` (or, from an older hook script, only `subagent: true`). The
server recorded each one as `working`, which took the tab out of the wait the `Stop` had opened.
The same thing happened when the main thread was waiting on a question or a permission dialog: a
`PreToolUse` from a subagent (`SubagentHandback` in the case we saw) replaced `waiting_permission`
with `working`. Nothing from the main thread arrives after that, so the tab stayed in `working`
until the next prompt.

Found in the `tab_events` rows of the hulk tab: each `Stop` with `background_tasks: 2` was followed
about a second later by `{"event":"PreToolUse","subagent":true}`. It reproduces with Claude Code
2.1.285: ask for a background subagent, end the turn, then log the hook payloads.

Also seen: from Claude Code 2.1.285 on, the spinner line no longer says "esc to interrupt"
(`✢ Catapulting… (14s · ↓ 145 tokens)`), and the input box stays on screen during a turn. Only a
spinner glyph followed by an ellipsis shows that a turn is still running.

## Fix

- `monitor/wait-decision.ts`: when the tab is waiting, a subagent's `working` event is dropped
  (`subagent_during_wait`), unless the wait is that subagent's own permission prompt. It still
  closes that subagent's own card (`monitor/ingest.ts`).
- `monitor/stale-working.ts`: a Claude tab with no event for 3 minutes while `working` gets its
  screen read (`monitor/screen-state.ts`). A dialog becomes `waiting_permission` and the input box
  with no spinner becomes `waiting_input`. The write is conditional on the `state_at` that was
  read, and it is recorded as a `ScreenCheck` event.

## How to check

Look at the tab's last `tab_events` rows. After a `Stop` with `background_tasks`, no subagent
`PreToolUse` row should follow. A tab that the hooks left behind shows a `ScreenCheck` row, and the
server log shows `monitor: stale working tab read from the screen`.
