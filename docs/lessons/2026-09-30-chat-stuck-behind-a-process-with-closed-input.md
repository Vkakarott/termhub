---
symptom: "\"Nova conversa\" answers 409 CHAT_BUSY (\"O concierge ainda está respondendo a mensagem anterior\"), new messages stay unanswered and an answer bubble stays empty, for as long as the concierge's background subagents keep relaunching"
tags: [chat, live-run, subagents, claude-cli, stream-json]
evidence: fixed
card: TER-498
pr: https://github.com/engenhariainversa/termhub/pull/246
agent: claude
date: 2026-09-30
---
## Cause

Three behaviours of `claude -p --input-format stream-json` (seen on Claude Code 2.1.285) that
`LiveRun` (`apps/server/src/chat/live-run.ts`) did not know about:

1. **After its stdin is closed, the CLI holds every `result` back while a background subagent runs.**
   It writes them all at once when a turn ends with nothing left in the background. With stdin open
   each turn ends with its own `result`.
2. **A subagent that ended is reported in a turn of the CLI's own**, after `background_tasks_changed`
   (count 0), `task_updated` and `task_notification`: the next turn when nothing was being answered,
   the turn after the running one otherwise. That turn can start another subagent (a monitor that
   relaunches itself).
3. **A session resumed after its last process died with a subagent running starts with
   `task_notification` (stopped) and a `result` with `num_turns: 0`**, before it replays any message.

`LiveRun` ended the input as soon as the background count reached 0, that is before the report turn
of (2). When that turn relaunched a subagent the process lived on with its input closed, and by (1)
its turn never ended for the server: `busy` stayed true (409 on reset), messages were queued until the
process exited (up to the 60-minute run limit), a cancel could not reach the subagent
(`SUBAGENT_GONE`), and the row of the turn stayed empty because its text is only stored at `result`.
By (3), the no-replay safety net took the leftover `result` of a resumed session for a CLI that never
echoes uuids: it failed every waiting turn with `RUN_FAILED` and closed the input at once, which led
to the same state right after a deploy.

## Fix

- The input ends only at the end of a turn, with nothing in the background **and no report turn still
  owed** (`reportsOwed`), never on the `background` frame.
- The no-replay safety net fires only when the turn that ended had said something.
- A process that takes no input answers nobody, so it no longer blocks anyone: `reset` ends it
  (`LiveRun.stop` → `RunStream.close`, which closes the agent channel and kills the CLI), a queued
  message or decision asks it to `giveWay` (ended when a subagent is all that keeps it alive), and a
  cancel it cannot forward ends it too. What its turn had said is stored as a plain message.
- A shutdown stores what a turn the CLI started had said, instead of leaving its row empty.

Rule of thumb: how a CLI frames its output depends on the state of its **input**. Record a real run
for each state (stdin open, stdin closed, resumed) before relying on a frame as a turn boundary.

## How to check

`npm test -w @termhub/server -- src/chat/live-run.test.ts src/chat/service.test.ts src/chat/agent-runner.test.ts -t TER-498`.
To see the CLI's side, feed one `{"type":"user",…}` line that launches a background subagent to
`claude -p --input-format stream-json --output-format stream-json --verbose --replay-user-messages`,
once keeping stdin open and once closing it right after the line, and compare where the `result`
frames land.
