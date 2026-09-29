---
symptom: "the orange needs-you dot comes back on a tab the person already looked at, with no new prompt and no toast"
tags: [monitor, hooks, needs-you, notifications]
evidence: observed
card: TER-422
pr: https://github.com/engenhariainversa/termhub/pull/224
agent: claude
date: 2026-09-29
---
## Cause

A tab needs the person when it waits and `state_seen_at` is older than `state_at`. Every recorded
hook event sets `state_at` to now, so any event that lands on a wait the person has seen lights it
again unless it is told to carry the seen mark. No toast comes with it while the tab is on screen,
which is why the dot seems to return by itself.

Paths found in the code, none of them measured in production:

- Claude's `idle_prompt` about a minute after the tab went to `working` with no turn behind it
  (`SessionStart` on `/clear` or `/resume`, a slash command typed from termhub), or while the tab
  was waiting for a permission. Fixed.
- The time of an event taken before the row lock: a look that commits while the event waits makes
  the wait it opens read as seen (the opposite symptom: a missed alert). Fixed.
- An answer nobody asked for (a background task woke the agent), the account swap, and a wait that
  lands after the session ended. Kept on purpose: they carry something new, or dropping them could
  silence a live agent.

`evidence` is `observed`, not `fixed`: the paths that were kept are the ones that best fit the report.

## Fix

`recordEvent` reads the tab's last ten events under its row lock and asks `decideWait`
(`apps/server/src/monitor/wait-decision.ts`): a reminder with nothing new in it is born seen or
carries the mark. Design and the reasons for what was kept:
`docs/superpowers/specs/2026-09-29-monitor-one-wait-one-alert-design.md`.

Two rules of thumb from the review of the first design:

- Never drop an event because "the session ended". Codex sends nothing but waits, and a second
  session in the same tmux session can end while the first still works.
- An event row is not the whole history: tool calls go through a light path that writes no row and
  only sets the tab's activity.

## How to check

The server log says what still re-arms a wait the person had seen, with names and flags only:

```
monitor: seen wait re-armed { tabId, tool, previous, event, background, afterSessionEnd }
```

Filter out `tool: codex` (it has no prompt event, so every turn counts). `background: true` is an
answer nobody asked for; `afterSessionEnd: true` is a wait that landed after the session ended.
