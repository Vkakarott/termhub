---
symptom: "real ~/.codex/hooks.json / ~/.termhub/bin/termhub-hook rewritten after running the server tests locally"
tags: [tests, agent, hooks, home, vitest]
evidence: fixed
card: TER-491
agent: claude
date: 2026-09-30
---
## Cause

`apps/server/src/agent/e2e.test.ts` and `apps/server/src/simulator/agent-tunnel.e2e.test.ts` run the
real agent in-process (`runAgent`). On startup and on every session `runAgent` calls `heal()`
(`apps/agent/src/rpc/hooks.ts`), whose `home` defaults to `os.homedir()`: the developer's real HOME.
On a machine with termhub hooks installed, heal rewrites `~/.termhub/bin/termhub-hook` when it differs
and merges our entries into `~/.codex/hooks.json`, `~/.cursor/hooks.json` and the Claude settings.
It only writes when the content differs, so nothing failed and it was not visible on every run.

## Fix

- Both e2e files set `process.env.HOME` to a temp dir in `beforeAll` (restored and removed in
  `afterAll`); `e2e.test.ts` also asserts that heal ran against that temp HOME.
- `apps/server/test/setup.ts` (vitest `setupFiles`) points HOME at a fresh temp dir for every test
  file and snapshots the watched real-home files (`apps/server/test/real-home-guard.ts`); a change to
  any of them fails the file with "a test wrote to the real HOME: ...", which also catches code that
  bypasses `$HOME`.

## How to check

`cd apps/server && DATABASE_URL=postgresql://x:x@localhost:5432/x npx vitest run` and `stat` the files listed in `real-home-guard.ts` before and
after: nothing changes. A test that writes to the real home now fails its file.
