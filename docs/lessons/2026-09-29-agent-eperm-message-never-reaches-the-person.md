---
symptom: "Sem acesso à pasta na máquina (Acesso Total ao Disco?)"
tags: [agent, rpc, errors, hooks]
evidence: fixed
card: TER-409
pr: https://github.com/engenhariainversa/termhub/pull/218
agent: claude
date: 2026-09-29
---
## Cause

An agent RPC throws `RpcFailure('eperm', '<a message that names the file>', path)` and the person still
sees the fixed sentence above, with no file name.

`toHttpError` (`apps/server/src/agent/errors.ts`) maps every `eperm` of the agent to that one sentence
and drops the message and the path. It is on purpose: for the file browser, the agent's own message
must not reach the person, and `apps/server/src/agent/ops.test.ts` pins it. Only the code `failed`
carries its message to the person ("the operation ran on the machine and reported why it failed").

## Fix

When the message has to reach the person, answer `failed`, not `eperm`. The read side of the monitor
hooks does it (`readFailure` in `apps/agent/src/rpc/hooks.ts`): a config file that cannot be read by
permission answers `failed` with `sem permissão para ler ~/.claude/settings.json`.

Do not change the mapping of `eperm` on the server to fix one caller: every `fs.*` RPC shares it.

## How to check

Install the monitor hooks on an agent machine whose `~/.claude/settings.json` belongs to another user
(left by `sudo claude`, say): the error names the file. In the tests: `npm test -w @termhub/agent --
src/rpc/hooks.test.ts`, the case "names a settings.json it has no permission to read".
