# Chat (TER-1) and machine agent / tab monitor (TER-407) Roadmap Plan

> **For agentic workers:** this is a roadmap, not a task-by-task plan. Each front below is one pull request with its own implementation plan under `docs/superpowers/plans/`. Write that plan with superpowers:writing-plans when the front starts (the code moves between fronts, so a plan written earlier would go stale), then execute it with superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the 19 open cards of the epics TER-1 (Chat) and TER-407 (machine agent and tab monitor) in eleven fronts that can each be verified and deployed alone.

**Architecture:** Cards are grouped by the code they change. Fronts that share a file, a migration sequence or the agent version run one after the other; the rest are independent. Every front ends in production: pull request, green `check`, merge, deploy followed to the health check.

**Tech Stack:** TypeScript, Fastify, Prisma/Postgres, React (web), React Native/Expo (mobile), vitest, jest, tmux, GitHub Actions, Docker blue/green.

**Spec:** `docs/superpowers/specs/2026-09-29-chat-and-machine-agent-roadmap-design.md`

## Global Constraints

- Checked against `main` at `498c6f0a`. Re-read the files a front touches before writing its plan.
- One worktree and one branch per front, from `origin/main`. Never edit the main checkout.
- This host shares Docker with production. Never stop, remove, kill or prune a container; throwaway containers are named `th-<something>`.
- Tests, typecheck and builds run in `node:22` before every push. The command in `CLAUDE.md` runs no test.
- Commits, pull requests, code comments and docs in English. UI copy and error messages shown to the person stay in Portuguese (pt-BR).
- Routes never import Prisma; every request input is validated with zod; data is loaded through `scoped(repos, request)`.
- Terminal content, hook payloads, answers and prompts are never logged. Only metadata.
- Migrations are backward compatible with the previous release: new columns are nullable or have a default.
- `@termhub/agent` is released by bumping `apps/agent/package.json`, `apps/agent/src/version.ts` and `package-lock.json` in the pull request. Never run `npm publish`.
- Every chat feature also lands in the mobile app (`packages/mobile-api`, the mobile routes, the screens).
- Each task of a front's plan becomes a subtask of its card on the board, moved to `doing` and `done` as it runs.

## Order

| Order | Front | Cards | Depends on | Agent release | Migration |
|---|---|---|---|---|---|
| 1 | Agent resilience and hook file safety | TER-408, TER-409, TER-410, TER-412, TER-413 | — | 0.10.1 | No |
| 2 | Stable web test suite | TER-373 | — | No | No |
| 3 | Monitor: one wait, one alert | TER-411, TER-422, TER-414 | — | No | No |
| 4 | Chat: run state and decisions that answer at once | TER-416, TER-415 | — | No | No |
| 5 | Concierge: project groups | TER-419 | — | No | No |
| 6 | Concierge: read the last answer | TER-417 | 3, 5 | No | Yes |
| 7 | Concierge: input that really submits | TER-418 | 1, 3 | Yes | No |
| 8 | Tab questions per subagent | TER-179 | 6, 7 | Yes | Yes |
| 9 | Cursor: approval prompts and unmonitored tabs | TER-421, TER-420 | 3, 8 | Yes | No |
| 10 | Landing: comparison with herdr | TER-403 | delivered by #209 | No | No |
| 11 | Mobile: hardware keyboard | TER-368 | a Mac with Xcode | No | No |

Fronts 2, 3, 4 and 5 have no dependency, and neither has what is left of front 10. They are ordered by what they unblock and by what the person feels first.

---

### Front 1: Agent resilience and hook file safety

**Cards:** TER-408 (#103), TER-409 (#104), TER-410 (#105), TER-412 (#107), TER-413 (#108)
**Plan:** `docs/superpowers/plans/2026-09-29-agent-resilience-hook-files.md`
**Branch:** `fix/ter-408-agent-resilience`

- [ ] Task 1: handshake timeout in the agent client (TER-408)
- [ ] Task 2: uninstall deletes a Cursor `hooks.json` that holds nothing of the person (TER-410)
- [ ] Task 3: ssh/local install refuses a file it cannot read (TER-409)
- [ ] Task 4: the agent names the file it could not read (TER-409)
- [ ] Task 5: name-ordered discovery and a heal failure logged once (TER-413, TER-412)
- [ ] Task 6: release 0.10.1 and verify the whole change
- [ ] Review of the front: the agent refuses a dangling link, names the file on a permission failure, and uninstall skips Cursor when `~/.cursor` is not a directory
- [ ] One pull request per task, stacked, merged in sequence on green, each deploy followed to the health check
- [ ] "Publish @termhub/agent" followed; the tarball of 0.10.1 holds `handshakeTimeout`

**Done when:** an upgrade request that gets no answer is retried after 15 s; install on ssh/local stops with the file's name when a config file cannot be read; uninstall leaves no `hooks.json` that termhub created; the five cards are in "Feito".

### Front 2: Stable web test suite

**Cards:** TER-373
**Files:** `apps/web/src/components/BoardColumnsSettings.test.tsx`, `apps/web/src/test-setup.ts`, `apps/web/vite.config.ts`

- [ ] Split `renames on blur, changes a category and moves a column` into three tests, one action and one wait each
- [ ] Each test waits for the reload (`mocks.list` called a second time) before it ends, so no state update lands after `cleanup()`
- [ ] Set `testTimeout` explicitly in `vite.config.ts` and put `asyncUtilTimeout` below it, so a slow wait fails with testing-library's own message
- [ ] Stress the file: `vitest run src/components/BoardColumnsSettings.test.tsx --repeat 30` with the worker count CI has
- [ ] Pull request, merge on green, deploy followed to the health check

**Done when:** thirty repeated runs pass, and no test in the file has more than one action.

### Front 3: Monitor: one wait, one alert

**Cards:** TER-411 (#106), TER-422 (#208), TER-414 (#109)
**Files:** `apps/server/src/monitor/state.ts`, `apps/server/src/monitor/ingest.ts`, `apps/server/src/db/repositories/tabs.ts`, `apps/server/src/routes/tabs.ts`, `apps/web/src/lib/needs-you.ts`, `apps/web/src/lib/monitor.tsx`, and their tests
**Needs its own spec:** yes. The "same wait" rule changes what `tabs.db.test.ts:272-284` pins on purpose, so the rule is decided in writing first.

- [ ] Spec: define "same wait" (which events open a new request and which continue one), with the six causes found for TER-422 as cases
- [ ] Cursor `sessionStart` stops reading as `working` (TER-411)
- [ ] A continuation carries the seen mark from `waiting_permission` and from a `working` that no real turn started (TER-422, causes 1 and 3)
- [ ] The reply route and Claude `SessionStart` stop producing the `working` that the next `idle_prompt` turns into an alert (TER-422, cause 1)
- [ ] An event that lands after the session ended does not open a wait (TER-422, cause 5)
- [ ] The account swap after a rate limit continues the alert it follows (TER-422, cause 4)
- [ ] Web: the optimistic seen mark also clears the per-agent dot in the sidebar (TER-422, cause 6)
- [ ] Web test: stop, seen, answer pushed through `entersNeedsYou` fires one toast (TER-414)
- [ ] Pull request, merge on green, deploy followed to the health check

**Spec and plan:** `docs/superpowers/specs/2026-09-29-monitor-one-wait-one-alert-design.md`, `docs/superpowers/plans/2026-09-29-monitor-one-wait-one-alert.md`.

**What the front's own design changed from the list above.** A review of the first design found that some of these items were unsafe or were real requests. Late events after a session end, the account swap and an answer nobody asked for are kept as they are; the reply route and Claude's `SessionStart` are not changed (a reminder that finds no turn running is born seen instead). A log line counts what still re-arms a seen wait.

**Done when:** a reminder of a wait the person has seen does not light it again, TER-411 and TER-414 are in "Feito", and the log has been read. TER-422 stays open until the log says which path the person is seeing: the design expects this front not to close it by itself.

### Front 4: Chat: run state and decisions that answer at once

**Cards:** TER-416 (#157), TER-415 (#156)
**Files:** `apps/server/src/chat/bus.ts`, `apps/server/src/chat/service.ts`, `apps/server/src/chat/live-run.ts`, `apps/server/src/routes/chat.ts`, `apps/server/src/routes/m-chat.ts`, `apps/server/src/mobile/events-parity.test.ts`, `apps/web/src/lib/types.ts`, `apps/web/src/lib/api.ts`, `apps/web/src/lib/chat-live.ts`, `apps/web/src/components/chat/ChatPanel.tsx`, `packages/mobile-api/src/events.ts`, `apps/mobile/src/services/api/contract/local.ts`, `apps/mobile/src/features/chat/model/live.ts`, `apps/mobile/src/features/chat/viewmodel/createChatStore.ts`, and their tests
**Needs its own spec:** yes, a short one: what counts as an active run when only subagents hold the lock.
**Spec:** `docs/superpowers/specs/2026-09-29-chat-run-state-design.md`
**Plan:** `docs/superpowers/plans/2026-09-29-chat-run-state.md`
**Delivered by:** #228, #229, #230 and #231; the phone goes in the next pull request.

- [x] Spec: the shape of `run_started`, the active-run field, and the subagent-only case (the field is `open_answer_ids`; a process kept alive only by subagents is not an active run)
- [x] Server: `run_started` on the bus, published wherever a turn starts
- [x] Server: `GET /api/chat` and the mobile `GET` carry the active run and its open answer ids
- [x] Server: the web decision and batch routes answer at once, as `m-chat.ts:303-306` does
- [x] Server: `POST /api/chat/messages` always answers 202; the 201 path and `ChatService.send` are removed (TER-415 leftover). The 201 path went; `ChatService.send` was kept (see below)
- [x] Contract: `run_started` in `packages/mobile-api`, with its sample in `events-parity.test.ts` (and `message_removed`)
- [x] Web: "answering" is seeded from the server and follows `run_started` / `run_finished`; a row opened mid-run shows as answering, not as failed
- [x] Mobile: the same, in the store and the live model
- [ ] Pull request, merge on green, deploy followed to the health check (#228, #229, #230 and #231 for the server and the web; the phone in the next one)

**Done when:** approving an action with an answer longer than 100 s shows no error; a page opened in the middle of a run shows the answer as in progress; web and mobile behave the same.

**What changed against this roadmap:**

- `ChatService.send` was kept: 67 tests of `service.test.ts` use it as "run a whole turn", and it is one line over `start`. The route's 201 path is what went.
- `message_removed` was added: the server publishes it at every deletion of an answer row, and both screens drop the row and never bring it back.
- The null `run_finished` (a run that could not even start) is handled by both screens: they re-read the conversation and show "O concierge não conseguiu começar a resposta. Tente de novo."
- A row alive in the other instance is not listed in `open_answer_ids`: the bus is in-process, so only turns this instance will publish the end of are listed.
- Rule 3 of a re-read changed after the review of Task 4: a row the snapshot lacks is kept only when its `message` event reached the screen while the read was in flight, not when its `created_at` is newer than the snapshot's newest row (an answer is always newer than its question, so a deleted answer stayed on screen). The rows a merge drops are closed.

### Front 5: Concierge: project groups

**Cards:** TER-419 (#170)
**Files:** `apps/server/src/control/inventory.ts`, `apps/server/src/mcp/tools.ts`, `apps/server/src/chat/gate.ts`, `apps/server/src/chat/project-prompt.ts`, `apps/server/src/chat/concierge-prompt.ts`, `apps/server/src/chat/service.ts`, `apps/server/src/db/repositories/project-groups.ts`, `README.md`, and their tests

- [ ] Repository: a read that does not create the Favoritos row
- [ ] `list_projects` returns `groups` and `favorite`, and takes `group` (id or name)
- [ ] `list_project_groups`, registered in `TOOLS`, in `readTools` and in the exact list of `mcp/route.test.ts:108`
- [ ] `find` takes kind `group`
- [ ] The project prompt names the group and its sibling projects, counted in the 4000-character budget
- [ ] The general chat gets the groups index on the streamed path only; the three tests that pin a `null` prompt on the one-shot path stay green
- [ ] README: the tool list
- [ ] Pull request, merge on green, deploy followed to the health check

**Done when:** the six acceptance criteria of the card hold, and no group of another user or project out of scope appears in a tool result or a prompt.

### Front 6: Concierge: read the last answer

**Cards:** TER-417 (#160)
**Depends on:** fronts 3 and 5
**Files:** `apps/server/prisma/schema.prisma`, a new migration, `apps/server/src/monitor/state.ts`, `apps/server/src/monitor/ingest.ts`, `apps/server/src/db/repositories/tabs.ts`, `apps/server/src/control/screen.ts`, `apps/server/src/mcp/tools.ts`, `apps/server/src/chat/gate.ts`, `apps/server/src/chat/project-prompt.ts`, `README.md`, and their tests

**Plan:** `docs/superpowers/plans/2026-09-30-concierge-last-answer.md`. **Spec:** `docs/superpowers/specs/2026-09-30-concierge-last-answer-design.md`.

- [x] Migration: the answer, whole, with the tool and the time it arrived — a table of its own, `tab_last_answers` (one row per tab), not columns on `tabs`
- [x] `Interpreted` carries the uncapped answer (`answer`, cut at 100 000 characters); `recordEvent` stores it under the continuation rule
- [x] `read_last_answer(tab_id, offset?, max_chars?)`, scoped through `ctx.scoped.tab`, registered in `TOOLS`, `readTools` and the exact list of `mcp/route.test.ts`
- [x] `read_screen` adds a note for full-screen agents and for tabs with no monitor state; the concierge prompt says when to use which
- [x] Tests: an answer of 10 000 characters arrives whole in `answer` and capped in `text`, for Claude, Codex and Cursor; paging, `stale`, `cut` and the notes in `control/screen.test.ts`
- [ ] Pull request, merge on green, deploy followed to the health check, `prisma migrate status` clean

**Done when:** the concierge reads a long answer with no key sent to the terminal and no approval card.

**Left out:** the session transcript as a second source (the issue's "evolução"): it needs a new RPC in the agent and a path check on the machine. `source: 'hook'` leaves room for it.

**What the review of the design changed:** a table of its own instead of columns on `tabs` (Prisma selects every column, so every hook and every tab list would have fetched the answer); paging with `offset`, `max_chars` and `next_offset` (Claude Code caps a tool result at about 25 000 tokens), never splitting a surrogate pair; `stale`, `state` and `state_at`, so an answer from an earlier turn can be told apart; no answer on Claude's `StopFailure`; the `read_screen` note on tabs with no state too, worded as a condition.

### Front 7: Concierge: input that really submits

**Cards:** TER-418 (#161)
**Depends on:** fronts 1 and 3
**Files:** `packages/agent-protocol/src/rpc.ts`, `apps/agent/src/rpc/tmux.ts`, `apps/server/src/terminal/session-ops.ts`, `apps/server/src/control/terminals.ts`, `apps/server/src/mcp/tools.ts`, `apps/server/src/chat/project-prompt.ts`, the agent version files, and their tests

- [ ] Evidence first: on one machine, compare `send-keys Enter`, `send-keys C-m`, `send-keys -H 0d` and the browser's Enter on a Cursor CLI with a summarised paste; record the tmux version and the value of `extended-keys`
- [ ] Agent and ssh/local: Enter goes as the raw byte, behind a minimum agent version
- [ ] The five other callers that send text with Enter are covered: the monitor's reply route, the account swap, `start_agent`, `run_command`
- [ ] `send_input` and `send_key` wait for the tab to enter `working` (hooks) or for the screen to change, and answer `submitted: true | false | 'unknown'` with a note
- [ ] One retry of `\r` inside the same approved call, never two
- [ ] Agent release
- [ ] Pull request, merge on green, deploy and publish followed

**Done when:** a twelve-line `send_input` to a Cursor CLI tab is submitted, and a text left in the box answers `submitted: false`.

### Front 8: Tab questions per subagent

**Cards:** TER-179
**Depends on:** fronts 6 and 7
**Files:** `packages/machine-ops/src/hooks.ts`, `apps/server/prisma/schema.prisma`, a new migration, `apps/server/src/monitor/state.ts`, `apps/server/src/chat/tab-questions.ts`, `apps/server/src/db/repositories/tab-questions.ts`, `apps/server/src/chat/permission-dialog.ts`, the agent version files, and their tests
**Needs its own spec:** yes. The first attempt was reverted (spec of 2026-09-26, section 10).

- [ ] Spec: closing and queueing per `agent_id`, and the live check that ties a card to the dialog on screen
- [ ] Hook script: a sanitised `agent_id` value in the reduced `PreToolUse` and `PermissionRequest` bodies
- [ ] Migration: `agent_id` on `tab_questions`, nullable, with its index
- [ ] Close and queue per agent; an old script (no value) keeps today's behaviour
- [ ] `promptVisible` also requires the tool name on screen
- [ ] Test: two subagents in parallel; B's event never closes A's card, and A's card never answers B's dialog
- [ ] Agent release
- [ ] Pull request, merge on green, deploy and publish followed

**Done when:** answering a subagent's permission in the terminal closes that subagent's card, and the parallel test passes.

### Front 9: Cursor: approval prompts and unmonitored tabs

**Cards:** TER-421 (#206), TER-420 (#189)
**Depends on:** fronts 3 and 8
**Files:** `apps/server/src/monitor/ingest.ts`, a new detector next to `apps/server/src/chat/permission-dialog.ts`, new fixtures, `packages/agent-protocol/src/rpc.ts`, `apps/agent/src/rpc/tmux.ts`, `apps/server/src/control/inventory.ts`, `apps/server/src/control/screen.ts`, `apps/web/src/office/model.ts`, `apps/web/src/components/MonitorHooksCard.tsx`, the agent version files, and their tests
**Needs its own spec:** yes.
**Needs from the person:** screens of a real `cursor-agent` approval prompt, captured on a machine that runs it.

- [ ] Spec: the detector's bias, the timers, and what "unmonitored" means
- [ ] Check the current `cursor-agent` for an observation-only event that says an approval is pending; prefer it to the screen
- [ ] Fixtures of the approval prompt, by `cursor-agent` version
- [ ] TER-421: a quiet `working` Cursor tab is read once it has been quiet for a few seconds; a prompt on screen becomes `waiting_permission`, and the next event or a changed screen takes it back
- [ ] TER-420: an RPC that answers the pane's foreground process, behind a minimum agent version
- [ ] TER-420: a tab whose tool runs but never reported gets the reason "unmonitored", shown in the monitor, the Office, `list_tabs` and `wait_for_state`
- [ ] TER-420: after install or repair, Máquinas lists the open sessions that need a restart
- [ ] Agent release
- [ ] Pull request, merge on green, deploy and publish followed

**Done when:** a Cursor approval prompt lights the alert once, and a tab started before the hooks shows why it has no state.

### Front 10: Landing: comparison with herdr

**Cards:** TER-403
**Delivered by:** #209 (another session, 2026-09-29): a "terminal agent runtime (e.g. herdr)" column and four new rows in `apps/landing/src/i18n.ts`.
**Files:** `apps/landing/src/i18n.ts` (the `compare` block in pt and in en)

- [x] Research and the herdr column, in pt and en (#209)
- [ ] Check, against each product's public pages, the cells #209 marked as inferred: agent state (Orca, Maestri, Cursor), API/MCP (Orca, Maestri), chat (Cursor)
- [ ] Correct what the check finds, in both languages, and update the note with the date
- [ ] Pull request, merge on green, deploy followed to the health check

**Done when:** every cell of the table can be traced to a public page, and both languages hold the same cells.

### Front 11: Mobile: hardware keyboard

**Cards:** TER-368
**Blocked on:** a Mac with Xcode, for everything native.
**Files:** `apps/mobile/modules/key-commands/`, `apps/mobile/src/features/chat/view/composer.tsx`, jest setup, and their tests

- [ ] Linux: rebase `spike/ter-368-key-commands` on `main` and remove the spike markers
- [ ] Linux: mock the native view in jest; test that the submit key calls the same path as the send button, that it does nothing while recording, with an empty draft or with an attachment uploading, and that other platforms render a plain view
- [ ] Mac: `expo prebuild`, compile the module, confirm that `keyCommands` is consulted while the text view has focus
- [ ] Mac: the nine manual cases of `SPIKE.md`, on the iPad simulator with a hardware keyboard
- [ ] Mac: a TestFlight build (a native module means a new binary)

**Done when:** on an iPad with a keyboard, Enter sends and Shift+Enter breaks the line, and the on-screen keyboard behaves as it does today.

---

## Self-Review

**Spec coverage.** Each of the 19 cards of the spec's section 1 has a front: TER-408, 409, 410, 412, 413 (front 1); TER-373 (2); TER-411, 422, 414 (3); TER-416, 415 (4); TER-419 (5); TER-417 (6); TER-418 (7); TER-179 (8); TER-421, 420 (9); TER-403 (10); TER-368 (11). Every decision of section 4 appears in the front that carries it out. Section 6 (out of scope) has no task on purpose.

**What this plan does not hold.** Step-by-step code for fronts 2 to 11. It is written when each front starts, against the code of that day.

**Consistency.** The dependencies of the table match the diagram of the spec's section 3. Agent releases happen in fronts 1, 7, 8 and 9, in that order, never in parallel.
