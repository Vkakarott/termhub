---
symptom: "Codex tab never reports working or waiting_permission (Codex shows \"Hooks need review\" on launch)"
tags: [codex, hooks, monitor]
evidence: fixed
card: TER-356
agent: claude
date: 2026-09-29
---
## Cause

Codex runs a hook only after the person trusts it (the trust is recorded as `hooks.state.*.trusted_hash`
in Codex's `config.toml`). The monitor installs its entries in `~/.codex/hooks.json`, but until the next
time Codex opens and the person reviews them ("Hooks need review"), Codex runs none of them, so the tab
never goes `working` nor `waiting_permission`.

## Fix

Open Codex once on that machine and choose "Trust all" (or review them later with `/hooks`).

## How to check

Send a prompt in the Codex tab: it goes `working` in termhub, and `waiting_permission` when Codex asks for approval.
