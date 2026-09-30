---
symptom: "Chat RUN_FAILED (\"O Claude parou no meio da resposta\") on every message with an account whose config_dir starts with ~; claude exits 1 with empty stderr and a literal `~` directory appears in the agent's cwd"
tags: [agent, concierge, chat, claude-cli, config-dir, spawn]
evidence: fixed
card: TER-613
pr: https://github.com/engenhariainversa/termhub/pull/255
agent: claude
date: 2026-09-30
---
## Cause

`ai_accounts.config_dir` is stored as the person typed it, often `~/.claude_x`. Tabs work because
their command line goes through a shell (`configDirPrefix` expands `~` there). The chat runs the CLI
with `spawn` and no shell (`apps/agent/src/claude/run.ts`, `apps/concierge/src/run.ts`), so
`CLAUDE_CONFIG_DIR=~/.claude_x` reached the CLI unexpanded. The CLI read it as a path relative to its
cwd, created `./~/.claude_x` with no login in it, and exited 1 without stderr, which classifies as the
generic `run_failed`. Reproduce: `echo oi | CLAUDE_CONFIG_DIR='~/.claude_x' claude -p` from `$HOME`.

## Fix

`resolveConfigDir(dir, home)` in `@termhub/claude-cli` expands `~`, `~/…`, `$HOME` and `${HOME}`
against the run's HOME. Both runners pass `CLAUDE_CONFIG_DIR` through it. Agent released as 0.12.2.
Any env value handed to `spawn` without a shell must be expanded by the code, never left to a shell.

## How to check

`npm test -w @termhub/agent` and `-w @termhub/concierge` (the fake CLI records `CLAUDE_CONFIG_DIR`),
then send a chat message with the `~/…` account on a machine running agent 0.12.2 or newer: it answers
and no new `~` directory appears in the agent's home.
