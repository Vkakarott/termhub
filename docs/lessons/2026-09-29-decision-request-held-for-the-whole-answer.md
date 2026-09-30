---
symptom: "\"Não foi possível registrar a decisão\" on a card that was approved, when the answer takes longer than about 100 seconds"
tags: [chat, decisions, edge-timeout]
evidence: fixed
card: TER-416
pr: https://github.com/engenhariainversa/termhub/pull/230
agent: claude
date: 2026-09-29
---
## Cause

`POST /api/chat/actions/:id/decision` and `POST /api/chat/actions/decisions` awaited
`ChatService.resumeAfterDecision`, which resolves only when the injected run has **ended**. An answer
longer than the edge allows (about 100 s) made the edge cut the request, and the page showed the error
— but the decision was already stored and published before the run began, so the card was in fact
approved (or denied) and the answer kept streaming.

## Fix

The web's decision routes now await `ChatService.startAfterDecision`, which resolves once the injected
turn is stored and handed to a process, and attaches its own `catch` to `done` (it logs the failure's
label only). The answer, and a failure to start (`run_finished` with no `message_id`), reach the page
over `/ws/chat`. `resumeAfterDecision` is `startAfterDecision` followed by `done`, for callers that want
the answer (the phone's background resume). `POST /api/chat/messages` lost its path that awaited the
whole answer too: it always answers 202 with the three ids.

Rule of thumb: a route that starts work which can outlive the edge's limit answers when the work has
**started**, and the rejection of the promise it no longer awaits gets a `catch`, or it becomes an
unhandled rejection.

## How to check

`npm test -w @termhub/server -- src/routes/chat.test.ts src/chat/service.test.ts`: the tests
`a decision answers while the run it started is still being written` (and its batch twin) answer 200
with a `done` that never settles, and `startAfterDecision resolves when the run has started, not when it
ends` resolves while the runner is held.
