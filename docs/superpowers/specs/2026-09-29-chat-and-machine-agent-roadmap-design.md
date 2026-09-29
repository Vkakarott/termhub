# Chat (TER-1) and machine agent / tab monitor (TER-407): roadmap — design

Epics: **TER-1 · Chat** and **TER-407 · Agente de máquina e monitor de estado das abas**. This document covers
the 19 open cards of both epics, groups them into work fronts, and fixes the order and the dependencies.
Each front gets its own spec (when it has decisions to take), its own plan, and its own pull request.

Every decision below was taken without the user (2026-09-29, asked to plan and start executing); the reason
is written next to each one.

Checked against `main` at `498c6f0a`. The cards were written against older commits, so every claim was
re-read in the code before it went into this document.

## 1. What the code says today

| Card | Issue | Verdict | Evidence |
|---|---|---|---|
| TER-408 | #103 | Still valid | `apps/agent/src/client.ts:120` builds the `WebSocket` with no `handshakeTimeout`; nothing times out before `open` |
| TER-409 | #104 | Still valid on ssh/local, wider than the card | `apps/server/src/monitor/install.ts:72-75` reads with `cat … 2>/dev/null`; the same loss hits Claude `settings.json` and Codex `config.toml` |
| TER-410 | #105 | Still valid, agent and ssh/local | `stripCursorHooks` leaves `{ "version": 1 }`; `apps/agent/src/rpc/hooks.ts:306-309` and `install.ts:241` write it back |
| TER-412 | #107 | **Already fixed** by `90024e01` | `logHealSkip` in each per-item `catch`, deduped by file (`apps/agent/src/rpc/hooks.ts:197-207`) |
| TER-413 | #108 | **Already fixed** by `90024e01` | The test has the second Claude dir (`apps/agent/src/rpc/hooks.test.ts:270-289`) |
| TER-411 | #106 | Still valid; one premise is wrong | `state.ts:226-229` maps Cursor `sessionStart` to `working`. `BUSY_STATES` also counts the waiting states, so Claude is not "rescued" for auto-update either |
| TER-414 | #109 | **Already fixed** by `90024e01` | `afterAgentResponse` carries `continuesWait`; `tabs.db.test.ts:248-255` pins the case the card describes |
| TER-422 | #208 | Still valid | Every event that is not a continuation pushes `state_at` past `state_seen_at` (`tabs.ts:163-174`) |
| TER-421 | #206 | Still valid | Cursor's `before*` hooks are not subscribed on purpose; no screen detection for a `working` tab |
| TER-420 | #189 | Still valid, partly in place | `machine_hooks.installed_at` and the "sessões abertas a partir de agora" note exist; no pane-process RPC, no "unmonitored" tab state |
| TER-415 | #156 | **Already fixed** by `902b0055` | `POST /api/chat/messages` answers 202 when `wait === false`, which the web always sends |
| TER-416 | #157 | Symptom is gone; two real defects remain | A typed message is injected or queued, never refused. The decision routes still await the injected run, and a page opened mid-run does not know a run is active |
| TER-417 | #160 | Still valid | `STATE_TEXT_MAX = 2000` caps the only stored copy of the answer |
| TER-418 | #161 | Still valid | Enter goes by key name on every path; the result is the literal `{ sent: true }` |
| TER-419 | #170 | Still valid; nothing of the MVP exists | Groups exist in the model, the REST API and the sidebar only |
| TER-179 | — | Still valid | The subagent flag is a boolean; `TabQuestion` has no `agent_id` |
| TER-373 | — | Still valid | `asyncUtilTimeout` (5 s) equals vitest's `testTimeout` (5 s), and the test chains four waits |
| TER-368 | — | In progress, blocked on hardware | A throwaway spike exists on `spike/ter-368-key-commands`; it was never compiled |
| TER-403 | — | **Delivered** by #209 while this roadmap was being written | The comparison has a herdr column; its pull request says some cells of the older columns on the new rows are inferred, not checked |

Four cards are already fixed on `main` and were never closed on the board: TER-412, TER-413, TER-414 and
TER-415. Each one is closed by the front that owns it, with the leftover it still has. A fifth, TER-403, was
delivered by another session (#209) on the same day.

## 2. Fronts

A front is a set of cards that changes the same code, ships in one pull request and can be verified alone.

| # | Front | Cards | Touches | Agent release | Migration | Size |
|---|---|---|---|---|---|---|
| 1 | Agent resilience and hook file safety | TER-408, TER-409, TER-410, TER-412, TER-413 | `apps/agent`, `packages/machine-ops`, `apps/server/src/monitor/install.ts` | Yes | No | M |
| 2 | Stable web test suite | TER-373 | `apps/web` tests | No | No | S |
| 3 | Monitor: one wait, one alert | TER-411, TER-422, TER-414 | `apps/server/src/monitor`, `tabs.ts`, a little `apps/web` | No | No | M |
| 4 | Chat: run state and decisions that answer at once | TER-416, TER-415 | `apps/server/src/chat`, `routes/chat.ts`, `apps/web`, `apps/mobile`, `packages/mobile-api` | No | No | M |
| 5 | Concierge: project groups | TER-419 | `apps/server/src/control`, `mcp`, `chat` | No | No | M |
| 6 | Concierge: read the last answer | TER-417 | `monitor`, `tabs.ts`, `mcp`, Prisma | No | Yes | M |
| 7 | Concierge: input that really submits | TER-418 | `apps/agent`, `agent-protocol`, `terminal/session-ops.ts`, `control/terminals.ts` | Yes | No | M |
| 8 | Tab questions per subagent | TER-179 | hook script, `monitor`, `chat/tab-questions`, Prisma | Yes | Yes | M–L |
| 9 | Cursor: approval prompts and unmonitored tabs | TER-421, TER-420 | `monitor`, `chat/permission-dialog.ts`, `apps/agent`, `apps/web` | Yes (TER-420) | No | L |
| 10 | Landing: comparison with herdr | TER-403 | `apps/landing` | No | No | Delivered by #209; S left |
| 11 | Mobile: hardware keyboard | TER-368 | `apps/mobile` | No | No | M, blocked |

## 3. Order and dependencies

```
1 ──────────────────────────────► 7 ──► 8 ──► 9
2
3 ──► 6 ──► 8
3 ──► 7
3 ──► 9
4
5 ──► 6        (both edit the same tool lists; never in parallel)
10
11             (blocked: needs a Mac with Xcode)
```

Execution order: **1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11**.

| Rule | Why |
|---|---|
| Front 1 goes first | TER-408 took a machine offline for about 11 hours, and TER-409 overwrites a person's own config. It has no dependency. |
| Front 2 goes second | A flaky test in `check` can block any later merge. It is small and independent. |
| Front 3 before 6, 7 and 9 | They all read or write the monitor state machine. TER-418 confirms a submission by the tab entering `working`; TER-421 must not re-arm an alert on every screen read; TER-417 writes in `recordEvent` next to the continuation rule. |
| Front 5 before 6 | Both add a read tool to `mcp/tools.ts`, `chat/gate.ts` (`readTools`), `mcp/route.test.ts:108` and the README. Sequential edits avoid a merge conflict in three lists. |
| Fronts 1, 7, 8 and 9 in sequence | Each bumps `@termhub/agent`. The version lives in `apps/agent/package.json`, `apps/agent/src/version.ts` and `package-lock.json`; parallel bumps would collide, and `publish-agent.yml` releases on every merge that changes it. |
| Fronts 6 and 8 in sequence | Both add a migration and both change `state.ts` / `ingest.ts`. |
| Migrations stay backward compatible | The old container keeps serving while the new one migrates (blue/green). New columns are nullable or have a default. |

## 4. Decisions

| Topic | Decision | Why |
|---|---|---|
| Cards already fixed | Closed by their front, with the commit that fixed them and the leftover handled in the same pull request. | A card closed with no evidence is a claim; a card left open is noise on the board. |
| TER-416 scope | Rewritten to the two defects that still exist: decision routes answer at once, and the page learns the run state from the server (`run_started` on the bus, an active-run field in `GET /api/chat`). | The symptom in the card (409 `CHAT_BUSY` on a typed message) was removed by the queue/inject work of 2026-09-26. |
| TER-415 leftover | The legacy 201 path (`wait` absent) is removed in front 4. | Only tests use it, and it keeps the defect alive for any caller that forgets the flag. |
| TER-409 scope | The probe reports `absent`, `present` or `unreadable` for Claude, Codex and Cursor files alike; install refuses an unreadable one before writing anything. | It is one function. Fixing Cursor alone would leave the same data loss for the other two. |
| TER-409 uninstall | Unchanged: an unreadable file is skipped. | The card asks for the install to refuse. Uninstall loses nothing today. |
| TER-410 scope | Cursor `hooks.json` only. A file is deleted on uninstall when what is left is an object with no key other than `version`. | That is the card. Nothing records who created the file, so "nothing of the person's is left" is the only test available; a file with only `version` has no content to lose. The same leftover for Claude (`{}`) and Codex (empty file) is recorded in section 6. |
| TER-417 phases | Phase 1 only: store the last full answer and add `read_last_answer`. Reading the session transcript through the agent is left for a later card. | Phase 1 needs no agent release and solves the reported case. |
| TER-418 old agents | A version gate (the `TERMINAL_PASTE_MIN_AGENT_VERSION` pattern); an older agent keeps the key-name Enter and answers `submitted: 'unknown'`. | The agent strips unknown params silently, so the server cannot tell whether a new field was honoured. |
| TER-179 live check | Closing per `agent_id` ships together with a stronger live check (the tool name must be on screen). | The spec of 2026-09-26 §10 reverted the first attempt because one subagent's card could approve another's dialog. |
| TER-421 detector | A new detector biased to "no dialog", with Cursor fixtures captured from a real `cursor-agent`. | `permissionDialogVisible` is biased to "yes" for the gate's safety; that bias would raise false alerts. |
| TER-368 | The Linux part (rebase, cleanup, jest tests) is planned; the native build, the nine manual cases and TestFlight stay blocked until someone runs them on the Mac. | The spike was never compiled. jarvis has no Xcode. |
| TER-403 | Delivered by #209. What is left is to check, against each product's public pages, the cells that pull request marked as inferred. | The comparison note says it is based on the products' public pages; an inferred cell makes that false until it is checked. |
| Local verification | Tests run in `node:22` before every push, in a container named `th-<something>`. | The command in `CLAUDE.md` runs no test and uses `node:20`; CI runs Node 22 and every suite. |

## 5. Per front: what changes

### Front 1 — Agent resilience and hook file safety

Plan: `docs/superpowers/plans/2026-09-29-agent-resilience-hook-files.md`.

- **TER-408.** `ClientOptions.handshakeTimeoutMs` (default 15 s) is passed to `ws` as `handshakeTimeout`.
  The timeout surfaces as the `error` event, which already rejects `connectOnce`; `runForever` retries with
  its backoff. Tests use a TCP server that accepts and never answers.
- **TER-409.** `readMachineConfigs` adds one status word per file. `installHooks` throws before building the
  script when any file it would write is `unreadable`. On the agent, read failures in `install` and
  `uninstall` become an `RpcFailure` that names the file, instead of the generic "internal error".
- **TER-410.** `isBareCursorHooks` in `@termhub/machine-ops`; both uninstall paths delete the file when it is
  true.
- **TER-412 leftover.** The failure at the top of `heal` is logged once per distinct message.
- **TER-413 leftover.** `discoverClaudeDirs` sorts the names it lists, so the two sibling tests discriminate
  on every filesystem.
- **From the review of the front.** The agent refuses a config file that is a symlink to nothing, as
  ssh/local does, and `heal` leaves the link alone. A read refused by permission answers `failed`, the code
  whose message reaches the person, so the file is named. Uninstall skips Cursor when `~/.cursor` is not a
  directory.
- `@termhub/agent` 0.10.1.

### Front 2 — Stable web test suite

- Split `renames on blur, changes a category and moves a column` into three tests.
- Each test waits for the reload (`mocks.list` called again) before it ends.
- `asyncUtilTimeout` goes below `testTimeout`, so a slow wait reports its own error.

### Front 3 — Monitor: one wait, one alert

- Cursor `sessionStart` stops reading as `working`.
- A wait that the person has seen is re-armed only by a new request: a real turn, or a permission prompt
  that was not on screen before. The quiet `working` → `idle_prompt` path, a late event after the session
  ended, and the `PermissionRequest` + `Notification` pair of one prompt stop re-arming.
- The reply route and `SessionStart` stop forcing a state that the next `idle_prompt` turns into an alert.
- TER-414 gets the web test that proves a single toast for stop → seen → answer.
- Needs its own spec: the "same wait" rule changes behaviour that `tabs.db.test.ts:272-284` pins on purpose.

### Front 4 — Chat: run state and decisions that answer at once

- `run_started` on the bus; `GET /api/chat` and the mobile `GET` carry the active run.
- Web decision and batch routes answer at once, as the mobile routes already do.
- Web and mobile seed "answering" from the server and follow `run_started` / `run_finished`.
- `apps/server/src/mobile/events-parity.test.ts` does not compile until the mobile contract accepts the new
  event, which enforces the parity rule.
- The legacy 201 path of `POST /api/chat/messages` is removed.

### Front 5 — Concierge: project groups

- `list_projects` returns `groups` and `favorite`, and takes `group`.
- New read tool `list_project_groups`, registered in `readTools`.
- `find` takes kind `group`.
- The project prompt names the group and its sibling projects, inside the 4000-character budget.
- The general chat gets a short index only on the streamed path; the one-shot path stays `null`, which
  three existing tests pin.
- A read-only repository method, so a read does not create the Favoritos row.

### Front 6 — Concierge: read the last answer

- A nullable column (or 1:1 table) holds the uncapped answer; `state_text` stays capped for the UI.
- The write follows the continuation rule, so `idle_prompt` never replaces the answer.
- `read_last_answer(tab_id)`, scoped through `ctx.scoped.tab`, registered in `readTools`.
- `read_screen` adds a note for full-screen agents. The text is never logged.

### Front 7 — Concierge: input that really submits

- Enter as the raw byte (`send-keys -H 0d`) on the agent and on ssh/local, after the difference is confirmed
  on a real Cursor CLI and the tmux version and `extended-keys` value are recorded.
- The five other callers that send text with Enter are covered by tests.
- `submitted: true | false | 'unknown'` with a note; one retry of `\r` inside the same approved call.

### Front 8 — Tab questions per subagent

- The hook script forwards a sanitised `agent_id` value in the reduced bodies.
- `TabQuestion.agent_id`; close and queue per agent.
- The live check also requires the tool name on screen.

### Front 9 — Cursor: approval prompts and unmonitored tabs

- TER-421: screen detection for a quiet `working` Cursor tab, with real fixtures.
- TER-420: a pane-process RPC, an "unmonitored" reason on the tab, shown in the monitor, the Office,
  `list_tabs` and `wait_for_state`.

### Front 10 — Landing: comparison with herdr

- Delivered by #209: a "terminal agent runtime (e.g. herdr)" column and four new rows.
- Left: check the cells #209 marked as inferred (agent state for Orca, Maestri and Cursor; API/MCP for Orca
  and Maestri; chat for Cursor), then close the card.

### Front 11 — Mobile: hardware keyboard

- Linux: rebase the spike, remove the spike markers, mock the native view in jest, test the send logic.
- Mac: compile, run the nine manual cases in `SPIKE.md`, build for TestFlight.

## 6. Out of scope, recorded

- Uninstall leaves `{}` in a Claude `settings.json` and an empty Codex `config.toml` that termhub created.
- `clearState` has no caller: a tab whose tmux session died keeps its last state, and counts as busy for the
  agent auto-update.
- `BUSY_STATES` counts the waiting states, so any session sitting after a turn holds the auto-update back.
- The mobile `GET` has no `compacting` field and no `/compact` route.
- Reading the session transcript through the agent (TER-417 phase 2).
- `machine_hooks.installed_at` is not updated when the agent repairs the hooks by itself.
- On an agent machine, a config file that cannot be read refuses the whole uninstall, so the hook token is
  not revoked until the file is fixed; ssh/local skips the file. Found by the review of front 1; it belongs
  with TER-420, which changes the same screen.
- ssh/local install can stop half way when a parent directory is not searchable: the probe says `absent` and
  the write fails after earlier files were written. Nothing of the person is overwritten.

## 7. Delivery per front

1. A worktree and a branch from `origin/main`.
2. The plan's tasks become subtasks of the front's cards on the board.
3. Test-first, one subagent per task, review between tasks.
4. Tests, typecheck and builds in `node:22` before the push.
5. One pull request; merge when `check` is green.
6. Follow "CI e Deploy" to the end, then `docker ps --filter name=termhub-app` and the two `curl` checks
   through the local proxy. When the agent version changed, also follow "Publish @termhub/agent" and open
   the published tarball.
7. Cards to "Feito", issues closed by the pull request.
