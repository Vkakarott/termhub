---
symptom: "No conversation found with session ID after an account swap of a Claude session that ran in a worktree; agent_transcript_path no longer exists"
tags: [claude, worktree, account-swap, transcript]
evidence: fixed
card: TER-587
agent: claude
date: 2026-09-30
---
## Cause

When a Claude Code session runs in a worktree (`.claude/worktrees/<name>`) that has no changes,
leaving it (`/exit`) removes the worktree. Claude Code then moves the transcript from
`<config>/projects/<worktree slug>/<id>.jsonl` to the main repository's project dir,
`<config>/projects/<repo slug>/<id>.jsonl`, and appends `{"type":"relocated","relocatedCwd":…}` to it.
The account swap linked the transcript into the other account *before* `/exit`, so after the exit the
link pointed at a file that no longer existed. `claude --resume <id>`, typed in the tab's shell (the
main repository), looks for the session under the repo slug, where nothing was linked. The path the
hook had reported (`tabs.agent_transcript_path`) also went stale.

A second, unrelated conflict came up on the same night: a session that had passed through the target
account before left a plain copy of its `.jsonl` there. That copy is a prefix of the current
transcript, and the link script answered `conflict`.

## Fix

- `swapAccount` links again after Claude exits, and fails with `RELINK_FAILED` if that link fails.
- `claudeLinkScript` (machine-ops, run by the agent) looks the transcript up by session id in the
  account's other project dirs when the reported path is gone, and links it under that slug.
- The script replaces a link that points nowhere.
- The script moves an older prefix copy aside (`<id>.jsonl.termhub-old-<epoch>`, never deleted) and
  links in its place. Any other file is still `conflict`.
- Agent machines need the new `@termhub/agent` for the script part.

## How to check

`packages/machine-ops/src/claude-session.test.ts` runs the script on a temporary HOME. The relevant
tests are "finds the transcript moved …", "replaces a link it left dangling …" and "moves aside an
older copy …". On a machine, `grep -l '"type":"relocated"' <config>/projects/*/<id>.jsonl` shows where
a moved transcript ended up.
