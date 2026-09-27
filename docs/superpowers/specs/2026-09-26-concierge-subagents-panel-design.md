# Concierge subagents: panel with cancel, gate origin, resume after restart — design

Card: **TER-301** (story, what TER-59 left open: TER-63, TER-64/65, TER-66). It builds on scope A of
`2026-09-26-concierge-always-free-design.md` (PR #165): a project chat runs as one long-lived
`claude` process with streamed input, and delegated work goes to background subagents.

Project rule: everything the chat does works in the mobile app too, in the same delivery.

## 1. What is missing today

1. **Gate origin (TER-63).** A confirmation card says what will run and where. It does not say
   whether the concierge asked or one of its subagents did, nor which subagent.
2. **Subagent panel with cancel (TER-64/65).** The server reads `background_tasks_changed` only to
   count background tasks, so it knows when to close the input. The person cannot see what is
   running, for how long, or stop a subagent that went the wrong way.
3. **Resume (TER-66).** When the agent's WebSocket drops, the agent kills every claude channel
   (`claude.closeAll()` in `apps/agent/src/run.ts`). A server restart or a blue/green deploy drops
   that socket, so the live process dies. Open turns fail with `HOST_GONE`/`RUNNER_FAILED`, and the
   background subagents are lost without a word.

## 2. What the CLI gives us (Claude Code 2.1.283)

| Fact | Evidence |
|---|---|
| Every MCP `tools/call` carries `params._meta["claudecode/toolUseId"]`, the id of the `tool_use` block that made the call. This holds for the main thread and for subagents. | Probe on 2026-09-26: a stdio MCP server logged `{"name":"ping","arguments":{"who":"sub"},"_meta":{"claudecode/toolUseId":"toolu_01JW…"}}`. |
| A subagent's `assistant` frames carry `parent_tool_use_id` = the `id` of the `Agent` `tool_use` that launched it. Their `tool_use` blocks carry the ids that reach the MCP server. | The same probe: the `ping` from the subagent had `toolu_01JW…`, found in an `assistant` frame with `parent_tool_use_id` = the `Agent` call. |
| `system/task_started` → `{task_id, tool_use_id, description, subagent_type, is_backgrounded}`. `tool_use_id` is the `Agent` call. | Fixture `stream-background.ndjson` (TER-59). |
| `system/task_updated` → `{task_id, patch: {status, end_time}}`. `system/task_notification` → `{task_id, tool_use_id, status, summary}`. Statuses seen in the CLI: `completed`, `failed`, `killed`, `stopped`, `cancelled`. | Fixture, and the CLI's own strings. |
| Stopping a task is a control request on stdin: `{"type":"control_request","request_id":…,"request":{"subtype":"stop_task","task_id":…}}`. It is answered with `{"type":"control_response","response":{"subtype":"success"\|"error","request_id":…,"error"?}}`. | The CLI's control schema ("Stops a running task.") and its `stop_task` handler. That handler answers an error when no stop callback is registered in the running context. **Not probed live:** driving a real CLI session from this host was refused by the session's safety classifier. The plan's final smoke covers it, and §7 covers the failure. |
| The agent writes any input line to the CLI's stdin as is, except `STREAM_END_INPUT_LINE` (`apps/agent/src/claude/run.ts`). | Code. **So cancel needs no new agent version.** |

## 3. Decisions

| Topic | Decision | Why |
|---|---|---|
| Who asked (gate) | The MCP route passes `extra._meta["claudecode/toolUseId"]` to the gate. The gate stores it on the action (`chat_actions.tool_use_id`) and resolves which subagent made it. The card shows "Pedido pelo subagente «descrição»". With no subagent, it shows nothing new (the concierge asked, as today). | The only link between an MCP call and a subagent that the CLI gives. It is exact, not a guess by arguments. |
| Resolving the subagent | Two sources, whichever comes first. (1) An in-memory map `tool_use_id → subagent`, filled by the live run from the subagent's `tool_use` frames (termhub tools only). (2) When the frame arrives after the MCP call, the live run fills `chat_actions.subagent_id` by `tool_use_id` and re-publishes the `confirmation` event. | The frame travels over the agent's WebSocket and the MCP call over HTTPS. Neither order is guaranteed. |
| Clients and a repeated `confirmation` | Web and app merge `subagent` into an action they already have, instead of ignoring the repeat. Old app builds keep ignoring it and simply show no origin. | No new event type is needed for the late case. |
| Subagent registry | New table `chat_subagents`, one row per `task_started` of a conversation, updated by `task_updated`/`task_notification`. The subagent's prompt is **not** stored: the CLI transcript already has it, and the database keeps only what the panel shows. | It survives a reload and a restart, and the card and the panel read one source. |
| Status | `running`, `stopping` (cancel asked), `completed`, `failed`, `stopped` (cancelled; CLI `killed`/`stopped`/`cancelled`), `interrupted` (the process died with it running). | The panel needs "cancelando…" between the click and the CLI's answer. |
| Panel content | Subagents that are running or stopping, plus those that ended in the last 10 minutes (at most 20), each with its description, status, and time running or taken. "Cancelar" is shown on running ones. | "What each one does, status, for how long" (the card). Recent endings explain why a line vanished. The result itself arrives as the concierge's message, as today. |
| Cancel | `POST /api/chat/subagents/:id/cancel` (web) and `POST /api/m/v1/chat/subagents/:id/cancel` (app), owner-scoped through the conversation. The service writes the `stop_task` control line into the live process and marks the row `stopping`. `task_updated` then marks it `stopped`. A `control_response` error puts it back to `running` and publishes `subagent_cancel_failed`, which the screens show as "Não foi possível cancelar". | Deterministic: it does not depend on the model calling `TaskStop`, which TER-127's `--tools Agent` removes anyway. No PIN in the app, because cancelling runs nothing on a machine. |
| Cancel with no live process | 409 `SUBAGENT_GONE`, and the row is marked `interrupted`. | A row still `running` with no process behind it is stale. |
| Resume model | Server-side. The agent keeping the process alive across a reconnect was rejected (§8). | The CLI session is on disk (`--resume`), so the thread survives a process death. Only the in-flight turns and the subagents are lost, and both can be put back. |
| What resume persists | New table `chat_live_runs`, one row per conversation with a live streamed process. It holds the owning server instance, a heartbeat, `released_at`, and the open turns (question id, answer id, the text written to the CLI). It is written when the run starts and whenever its turns change, and deleted when the run ends normally. | Deploys (graceful) and crashes (stale heartbeat) take the same path. |
| Graceful shutdown | A `preClose` hook calls `ChatService.suspendAll()`. It marks this instance's rows `released_at = now()` (queued turns included), marks their running subagents `interrupted`, and flags the live runs as suspending. Their end then leaves the turns open, with no `RUNNER_FAILED` and no deleted row. | Blue/green stops the old color 30 s after the switch. Its live processes die then, and the new color must take over. |
| Who resumes, and when | A sweep in every instance: once at boot, then every 30 s. It takes rows that are released, or whose heartbeat is older than 90 s, and that belong to another instance. For each one whose host is ready and streams, it claims the row with a conditional update and starts the run. A row older than 15 minutes closes its turns with `HOST_GONE` and is deleted. | Blue/green, a crash and a host that reconnects late all fit one loop. A 30 s sweep is cheap: one indexed query. |
| Resumed run | Same session (`resume: true`). The first line is a server note (pt-BR, like decision injections). It says the server restarted, lists the interrupted subagents by description, and says to relaunch in the background the ones still worth doing, and that the unanswered messages follow. Then each open turn goes again, with a fresh uuid, into its **existing** answer row. `missing_session` → one fresh-session retry (existing path). | The person's bubbles keep "pensando…" and are answered where they are. The concierge knows what was lost. |
| Server note turn | A "silent" line: written to the CLI and counted as pending until its replay. It has no question row, and its answer becomes a message of its own (the path a notification turn already takes). | No fake user bubble. The concierge's reply ("Relancei a busca…") is visible. |
| One-shot runs (old agents) | Unchanged: not resumed. | Only a streamed host can take the note plus the turns in one process. Old agents are going away (auto-update). |
| Agent version | None needed. | §2: control lines already pass through the agent. |

## 4. Data model (additive migration, `20260927150000_chat_subagents_resume`)

```prisma
model ChatSubagent {
  id             String           @id
  conversationId String           @map("conversation_id")
  conversation   ChatConversation @relation(fields: [conversationId], references: [id], onDelete: Cascade)
  taskId         String           @map("task_id")        // the CLI's task id (stop_task target)
  toolUseId      String           @map("tool_use_id")    // the Agent call; parent_tool_use_id of its frames
  description    String                                  // ≤ 200 chars, as the concierge wrote it
  subagentType   String?          @map("subagent_type")
  /// running | stopping | completed | failed | stopped | interrupted
  status         String
  startedAt      DateTime         @default(now()) @map("started_at")
  endedAt        DateTime?        @map("ended_at")
  @@unique([conversationId, taskId])
  @@index([conversationId, startedAt])
  @@map("chat_subagents")
}

model ChatLiveRun {
  conversationId String           @id @map("conversation_id")
  conversation   ChatConversation @relation(fields: [conversationId], references: [id], onDelete: Cascade)
  userId         String           @map("user_id")
  instanceId     String           @map("instance_id")
  heartbeatAt    DateTime         @default(now()) @map("heartbeat_at")
  releasedAt     DateTime?        @map("released_at")
  /// [{question_id, answer_id, text}] — the turns written or waiting, in order
  turns          Json
  createdAt      DateTime         @default(now()) @map("created_at")
  @@index([heartbeatAt])
  @@map("chat_live_runs")
}
```

`chat_actions` gains `tool_use_id TEXT NULL` and `subagent_id TEXT NULL`, with no FK: a subagent row
goes with its conversation, and so does the action. It also gets an index on
`(conversation_id, tool_use_id)`.

Backward compatibility: the previous release never reads these tables or columns. `ADD COLUMN`
nullable and `CREATE TABLE` are safe while it keeps serving.

`turns[].text` is chat content: the person's words plus the context the server added. It sits beside
`chat_messages`, which already stores the same content. It is never logged.

## 5. Components

### 5.1 Stream parsing (`stream.ts`)

New frames. Everything else stays ignored.

- `system/task_started` → `{type:'subagent_started', task_id, tool_use_id, description, subagent_type}`.
- `system/task_updated` with `patch.status`, and `system/task_notification` →
  `{type:'subagent_status', task_id, status}`. The status is mapped to §3's set; an unknown status is
  dropped.
- An `assistant` frame with a non-null `parent_tool_use_id` and a `tool_use` block named
  `mcp__termhub__*` → `{type:'subagent_tool', parent_tool_use_id, tool_use_id}`. It is still not shown
  in the chat.
- `control_response` → `{type:'control_response', request_id, ok, error?}`. The error text is the
  CLI's and is never stored or shown, only logged by request id.

### 5.2 Origin map (`subagent-origin.ts`)

A module singleton, like `chatBus`: `remember(toolUseId, {conversationId, subagentId})` and
`originOf(toolUseId)`. Entries are bounded (5000, oldest first out) and expire after one hour.

### 5.3 `LiveRun`

- Owns the conversation's subagents while it lives: `task_id → row`, plus `tool_use_id (Agent) → row`.
- `subagent_started`: insert the row (`running`), publish `subagent`.
- `subagent_status`: update the row (`ended_at` for final states), publish `subagent`.
- `subagent_tool`: `remember(...)`. If the tool is one the gate may ask about, call
  `chatActions.setSubagentByToolUse(conversationId, toolUseId, subagentId)`. When a row changed,
  re-publish its `confirmation` with the subagent (through the same `describeActions`).
- `stopTask(taskId, requestId)`: writes the control line. It returns false when the input is closed.
- `control_response` for a pending stop that failed: the row goes back to `running`, and
  `subagent_cancel_failed` is published.
- `addNote(text)`: the silent line of §3.
- At the end of the stream: rows still `running`/`stopping` become `interrupted` (published).
- Turn changes call an `onTurnsChanged` hook, which `ChatService` uses to persist `chat_live_runs`.

### 5.4 Gate (`mcp/route.ts`, `gate-runtime.ts`, `chat-actions-view.ts`)

- `GatedCall.tool_use_id?: string`, read from `extra._meta?.['claudecode/toolUseId']`, kept only if
  it matches `^[A-Za-z0-9_-]{1,128}$`.
- `insertPending`/`insertApproved` store `tool_use_id` and `subagent_id = originOf(id)?.subagentId`.
  The origin counts only when its conversation is the call's own.
- `ChatActionCard.subagent: {id, description} | null`, resolved in `describeActions` with one
  batched read of `chat_subagents` scoped to the conversations of the cards.
- The `confirmation` bus event carries `subagent`.

### 5.5 `ChatService`

- `subagentsFor(conversationId)`: the panel list (§3).
- `cancelSubagent(user, subagentId)`: owner check through the conversation; `running` only (409
  `SUBAGENT_NOT_RUNNING` otherwise); live run accepting → `stopTask`, row `stopping`, publish; no
  live run or input closed → 409 `SUBAGENT_GONE`, row `interrupted`.
- Live-run persistence:
  - `runLive` upserts `chat_live_runs` (this instance) on start and on every turn change;
  - a 30 s heartbeat updates this instance's rows;
  - a normal end deletes the row;
  - `suspendAll()` (§3);
  - `resumeSweep()` (§3). A resumed run goes through `runLive` with its turns rebuilt from the stored
    rows (question and answer re-read by id, an answer that already has text or an `error_code` is
    skipped) and its `settle` a no-op, since nobody awaits them any more.
- `instanceId`: a random id per process.

### 5.6 Routes and contract

- Web `GET /api/chat` and app `GET /api/m/v1/chat` add `subagents: SubagentView[]`, where
  `SubagentView = {id, description, subagent_type, status, started_at, ended_at}`.
- `POST …/subagents/:id/cancel` → 202 `{subagent}`. The id is validated with zod, and the route is
  registered under the `chat` resource (POST → `create`, like sending a message).
- New bus events: `subagent` `{conversation_id, subagent}` and `subagent_cancel_failed`
  `{conversation_id, subagent_id}`. They are added to `chatEventSchema` in `@termhub/mobile-api` and
  to the parity test. The app's socket drops a frame that fails `safeParse`, so old builds ignore
  them.
- `chatActionSchema` and `confirmation` gain `subagent` (optional, nullable).

### 5.7 Web

- `ChatPanel` keeps `subagents` from `GET /api/chat` and applies `subagent` events (upsert by id).
- The toolbar gets a "Subagentes (n)" button when anything is running. It opens `ChatSubagents`, a
  small list:
  - each line shows the description, the status in pt-BR ("rodando", "cancelando…", "concluído",
    "falhou", "cancelado", "interrompido") and the elapsed time ("há 3 min" / "levou 2 min");
  - running lines have "Cancelar";
  - a failed cancel shows "Não foi possível cancelar" on the line.
- `ChatActionCard` and `ChatActionGroup` show "Pedido pelo subagente «X»" under the summary when
  `subagent` is set.
- A repeated `confirmation` merges `subagent` into the existing action.

### 5.8 App

The same features in `createChatStore`/`events.ts`, `conversation-screen.tsx` (a header button and a
sheet with the list), `action-card.tsx`/`action-group-card.tsx`, the API client (`cancelSubagent`)
and the mock backend. The copy is the same as on the web.

### 5.9 Orchestrator prompt

The prompt gains two lines:

- the person can cancel a subagent from the chat, and a cancelled subagent's notification says so:
  acknowledge it briefly, without relaunching unless asked;
- after a server note about a restart, relaunch in the background only what is still worth doing,
  then answer the messages that follow.

## 6. Security and logging

- Cancel and the panel are owner-scoped through the conversation, like every other chat route. A
  foreign id is a 404.
- `tool_use_id` is shape-checked before it is stored. It is an id, not content.
- Logs carry ids and labels only: `conversation_id`, `subagent_id`, `task_id`, the `request_id` of a
  control response. They never carry a description, a prompt or `turns[].text`.
- A gated token cannot forge an origin that shows another conversation's subagent. The origin map is
  keyed by `tool_use_id` and checked against the call's conversation.

## 7. Error handling

| Case | Result |
|---|---|
| The CLI refuses `stop_task` (control error, e.g. callback not registered) | The row goes back to `running`; "Não foi possível cancelar" is shown. |
| No `control_response` and no status 30 s after a cancel | The row goes back to `running` and the same message is shown. |
| The frame with the subagent's tool arrives after the gate asked | The late binding re-publishes the card with the origin. |
| The frame never arrives (e.g. an old container during a switch) | The card shows no origin, as today. |
| Crash (no `preClose`) | The heartbeat goes stale after 90 s and the sweep resumes. |
| Host not back within 15 min | Open turns are closed with `HOST_GONE`, the row is deleted and the subagents stay `interrupted`. |
| An answer already finished when the resume starts (a race with the old instance) | It is skipped. |
| Two instances sweep at once | The conditional claim lets one through. |
| The resumed session is missing | One fresh retry (existing), with the note saying the session is new. |

## 8. Rejected alternatives

- **The agent keeps the claude process alive across a reconnect and reattaches the channel.** Running
  subagents would survive. It would need a new channel-reattach message, output buffering on the
  agent while disconnected, and the server rebuilding all live state from the database anyway. It
  also does nothing for an agent restart (auto-update) or a crash of the process's host. It could be
  a later card if losing subagent work on deploys proves costly.
- **Match a gated call to a subagent by its arguments.** Two subagents can propose the same action,
  and this guesses where `_meta` is exact.
- **Cancel by asking the concierge to call `TaskStop`.** The model may not comply, it costs a turn,
  and TER-127 restricts the tools to `Agent`.
- **Store the subagent's prompt for relaunch.** The resumed transcript already carries it. Storing it
  duplicates content for no gain.

## 9. Testing

- `stream.ts`: every new frame from real shapes (fixture), unknown statuses, subagent tool frames only
  for `mcp__termhub__*`.
- Repositories (Postgres, `.db.test`): subagents insert/update/list window, `setSubagentByToolUse`,
  live-run upsert/heartbeat/claim race/stale/released, migration applies on a copy of the previous
  schema.
- `LiveRun`: registry and events, interrupted at end, stopTask writes the control line and fails
  closed, control error rolls back, late origin re-publishes the confirmation, silent note line.
- Gate: `tool_use_id` stored, origin resolved from the map, a foreign-conversation origin ignored, a
  bad `_meta` shape dropped, card carries `subagent`.
- `ChatService`: cancel happy path / not running / gone / not the owner; suspend leaves turns open and
  row released; sweep resumes with the note first and turns into their own rows, skips finished
  answers, gives up after 15 min, claim race.
- Routes: web and app cancel (202, 404 foreign, 409), GET carries `subagents`, zod on the id.
- Web (vitest + testing-library): panel shows lines, elapsed time, cancel calls the API, failed cancel
  message, card origin line, merge of a repeated confirmation.
- App (jest): store folds `subagent`/`subagent_cancel_failed`, repeated confirmation merges, header
  button and sheet, card origin line, mock backend.
- Verification: typecheck and builds through Docker (`CLAUDE.md`), suites on node:22 with Postgres,
  and a smoke with the real CLI for `stop_task` and `_meta` if this host allows it (see §2).
