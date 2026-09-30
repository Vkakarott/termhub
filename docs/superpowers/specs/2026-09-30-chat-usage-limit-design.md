# Chat: usage limit, named CLI errors and automatic account fallback (TER-588)

## Problem

When the Claude account a chat runs on hits its usage limit, every message answered
"O Claude parou no meio da resposta. Mande a mensagem de novo." (`RUN_FAILED`). The CLI says why, but
on stdout, in the stream the server already reads — stderr is empty, so `classifyFailure` (stderr
only) has nothing to go on, and the server's `parseFrame` turned every `result` with `is_error` into
`run_failed`.

## What the CLI sends (Claude Code 2.1.285, `-p --output-format stream-json --verbose`)

Captured on jarvis on 2026-09-30 (fixtures in `apps/server/src/chat/fixtures/stream-*.ndjson`):

| case | frames |
|---|---|
| usage limit | `rate_limit_event` with `rate_limit_info.status: "rejected"`, `resetsAt` (epoch s), `rateLimitType`; a synthetic `assistant` with `error: "rate_limit"`; `result` with `is_error: true`, `api_error_status: 429`, `terminal_reason: "api_error"` |
| unknown model | synthetic `assistant` with `error: "model_not_found"`; `result` `is_error`, `api_error_status: 404` (stderr has `[claude-code:unrecognized_model]`) |
| not logged in | synthetic `assistant` with `error: "authentication_failed"`; `result` `is_error` |

The `system/init` frame carries `memory_paths.auto` = `<config dir>/projects/<cwd slug>/memory/`,
an absolute path: the session's transcript is `<that dir>/../<session id>.jsonl`.

## Design

1. **Classification in `parseFrame`** (server). New reasons `usage_limit`, `model_unavailable`,
   `auth_failed` (codes `USAGE_LIMIT`, `MODEL_UNAVAILABLE`, `AUTH_FAILED`). The synthetic assistant's
   `error` names the turn's failure; the `result` frame's own `api_error_status` (429/401) is the
   fallback for a CLI that omits it. `rate_limit_event` rejected gives the reset time; `init` gives
   the session dir. `classifyFailure` stays stderr-only: nothing about this needs an agent release.
2. **Notice on the message.** `chat_messages.notice` (jsonb, nullable, additive migration):
   - `{ kind: 'usage_limit', account, resets_at, fallback: 'none_free' | 'no_other_account' }` on
     a `USAGE_LIMIT` answer;
   - `{ kind: 'account_swap', from, to, resets_at }` on an answer another account gave.
3. **Automatic fallback, per run.** A turn that hit the limit before saying anything is put back in
   the queue, the process ends, and the run picks another Claude account of the host machine
   (`chat/account-fallback.ts`: same machine and owner, not tried yet in this run, ranked by
   `rankCandidates` — TER-589 replaces the ranking with the project's priority), links the session
   into it with `claude.linkSession` (so the context is kept) and resumes there. Every candidate is
   tried at most once per run; with none left the turn is stored as `USAGE_LIMIT`.
   The swap is **not** written to the conversation: the next run starts on the configured account
   again, so project chats keep their sessions and the chat goes back to the chosen account by
   itself after the reset. A turn that already streamed text or called a tool is not re-run (what it
   said is kept, and an action is never taken twice), and is stored as `USAGE_LIMIT`. Turns the
   limited process had already read stay queued in their order for the next account. A 429 without a
   rejected `rate_limit_event` is a transient rate limit, not the usage limit: it stays `RUN_FAILED`.
4. **Copy, web and app.** One sentence per new code; the reset time in the viewer's clock
   ("volta às 03:20", "volta em 01/10 às 03:20"); the swap notice above the answer. An older app
   shows its generic line for the new codes and ignores `notice` (zod strips it).

## Impact on other users

- Every chat's stream goes through the new classification; only turns that already failed change.
- The fallback only uses Claude accounts registered on the same machine by that machine's owner — the
  same pool the tab account swap (TER-55) uses. Nobody's run moves to an account of someone else.
- Usage is read (Anthropic OAuth usage endpoint) only when a limit is hit, one call per candidate.
- The migration adds a nullable column: the previous release keeps working while the new one migrates.
