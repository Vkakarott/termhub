---
symptom: "account swap: auto skipped (limit no longer current) — tabs stay on \"Usage limit reached · continuing automatically\" and rate_limited_at is null"
tags: [claude, hooks, account-swap, monitor]
evidence: fixed
card: TER-587
pr: https://github.com/engenhariainversa/termhub/pull/257
agent: claude
date: 2026-09-30
---
## Cause

Three problems stacked up, so no tab was moved to another account:

- `machines.claude_auto_swap` was opt-in and off on every machine. The only place to turn it on
  (Contas de IA → Troca automática) listed only machines with two *registered* Claude accounts. A
  machine whose default login (`~/.claude`, no config dir) is not registered never showed up there.
- Right after a `StopFailure` with `error: rate_limit`, Claude Code dequeues a queued prompt within
  ~20 ms. That prompt is a background task's `task-notification`, and the transcript shows it as a
  `user` entry with `origin.kind: "task-notification"` right after the API error. Subagents also keep
  calling tools. `ingest.ts` treated `UserPromptSubmit`, `SessionStart` and `PreToolUse` as "running
  again" and cleared `rate_limited_at`. The hooks are posted in the background (`curl … &`), so they
  can also reach the server after the `StopFailure`. `autoSwapOnLimit` re-reads the tab after 3 s,
  found the limit gone and gave up.
- When the queued prompt failed too, its second `StopFailure` wrote a new `rate_limited_at`. The first
  call then saw a "newer limit" and stopped, and the second call was inside the 10 min cooldown that
  the first call had already started. Neither call swapped.

## Fix

- `rate_limited_at` is cleared only by these events:
  - a normal `Stop` of the main thread;
  - the Claude leaving (`SessionEnd`);
  - a `SessionStart` of a *different* session.

  Prompts, tool calls, a subagent's `Stop` and a resume of the same session no longer clear it.
- `rate_limited_at` is when the incident began, so a second `StopFailure` keeps it.
- `autoSwapOnLimit` skips a second call while the first one waits, and starts the cooldown only when it
  actually attempts a swap.
- `claude_auto_swap` is on by default (migration `20260930070000_claude_auto_swap_default_on`).
  `autoSwapOnLimit` stays silent on a machine with a single Claude login.
- The unregistered default login counts as a second account in the settings.

## How to check

`ingest.test.ts` ("… does not clear rate_limited_at", "a second rate_limit StopFailure keeps the time
of the first") and `account-swap.test.ts` ("a second limit of the same incident …", "a call that found
the limit over starts no cooldown …"). In production, the server log shows `account swap: done` with
`auto: true` for the tab, not `auto skipped (limit no longer current)`.
