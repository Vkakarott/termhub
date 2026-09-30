---
symptom: "Chat answers \"O Claude parou no meio da resposta. Mande a mensagem de novo.\" (RUN_FAILED) on every message; agent.log shows `claude run ended {\"code\":1,\"stderrBytes\":0}`"
tags: [chat, claude-cli, usage-limit, stream-json, rate-limit]
evidence: fixed
card: TER-588
agent: claude
date: 2026-09-30
---
## Cause

Claude Code reports a usage limit, an unknown model and a missing login **on stdout**, in the
`stream-json` frames, and exits 1 with an **empty stderr**. `classifyFailure` (packages/claude-cli)
only reads stderr, and the server's `parseFrame` turned every `result` with `is_error: true` into
`run_failed`, so all three reached the person as the generic RUN_FAILED. What the CLI does send
(2.1.285):

- a `rate_limit_event` with `rate_limit_info.status: "rejected"` and `resetsAt` (epoch seconds);
- a synthetic `assistant` message (`model: "<synthetic>"`) with a top-level `error`:
  `rate_limit`, `model_not_found` or `authentication_failed`, and the human text in its content;
- a `result` with `is_error: true`, `terminal_reason: "api_error"` and `api_error_status`
  (429 for the limit, 404 for the model, null for the login).

The `[claude-code:unrecognized_model]` line is on stderr, but the chat only ever sees the frames.

## Fix

Classify in `parseFrame` (apps/server/src/chat/stream.ts), not in `classifyFailure`: the assistant's
`error` names the turn's failure (`usage_limit`, `model_unavailable`, `auth_failed`, stored as
USAGE_LIMIT / MODEL_UNAVAILABLE / AUTH_FAILED), `api_error_status` is the fallback. Both runners
(`finishRun`, `LiveRun.consume`) keep the assistant's reason over the process exit that follows.
No agent release is needed: the frames already travel to the server. Recorded fixtures:
`apps/server/src/chat/fixtures/stream-{usage-limit,model-not-found,not-logged-in}.ndjson`.

## How to check

With an account at its limit: `claude -p --output-format stream-json --verbose "oi"` prints the
three frames above; stderr is empty. In the chat, the answer reads "A conta … atingiu o limite de
uso e volta às HH:MM", and `chat_messages.error_code` is `USAGE_LIMIT` with the reset time in
`chat_messages.notice`.
