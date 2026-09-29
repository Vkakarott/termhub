# Chat: run state and decisions that answer at once — design

Cards: **TER-416** (#157), **TER-415** (#156), epic TER-1. Front 4 of the roadmap
(`2026-09-29-chat-and-machine-agent-roadmap-design.md`). Server, web, mobile contract and mobile app.

Every decision below was taken without the user (2026-09-29, asked to plan and execute by
recommendation); the reason is written next to each one.

## 1. Problem

Read from the code at `016fe02a`.

1. **A decision holds its request open for the whole answer.** `POST /api/chat/actions/:id/decision` and
   `POST /api/chat/actions/decisions` await `ChatService.resumeAfterDecision`, which resolves when the
   injected run has ended. An answer longer than the edge allows (100 s) cuts the request: the page
   shows "Não foi possível registrar a decisão" for a decision that was recorded. The mobile routes
   already answer at once (`routes/m-chat.ts`, the two `void Promise.resolve().then(...)` blocks).
2. **A screen opened in the middle of a run does not know a run is active.** "Answering" is inferred
   from events the screen saw: a row counts as started only after its announcement, a delta or a tool
   call reached this screen. A page loaded, or a phone that reconnected, while the answer is still
   thinking shows the empty row as failed until the next delta. The same happens to a turn carried over
   a deploy: its row already exists, so nothing announces it again.
3. **On the web, a retried run looks failed.** A `reset` event drops the row from the live fold, and
   with it the started mark. The phone keeps the mark.
4. **TER-415 leftover.** `POST /api/chat/messages` still has the path that awaits the whole run and
   answers 201, taken when the body has no `wait: false`. The web always sends it, so only tests take
   that path, and it keeps the defect alive for any caller that forgets the flag.

## 2. Decisions

| Topic | Decision | Why |
|---|---|---|
| Unit of "a run" for the screens | One open answer row. `run_started` names a row, as `run_finished` already does. | A live process answers many turns, and several rows can be open at once (injected and queued messages). A flag per conversation cannot say which rows wait. |
| What opens a row | The row gets an owner: a live process takes the turn, a one-shot run starts, or the queue holds it for the next process. Also a turn the CLI starts on its own, and every turn that waits again after a retry on a fresh session. | These are all the places where an answer will come, including a turn carried over a restart, which no `message` event announces. |
| `run_started` is idempotent | A row queued and later taken by a process is announced twice. Screens add the id to a set. | One rule on the server ("announce when the row gets an owner") instead of tracking what was already said. |
| Order | `run_started` is published after the `message` event of its row, never before. | The screen must have the row before it is told the row is open. |
| What `GET` carries | `open_answer_ids: string[]`, in `GET /api/chat` and in the mobile `GET`. Only ids of rows the same response lists as empty assistant rows with no error. | The screen needs exactly the rows to show as "pensando…". A flat list is enough; nothing reads a richer object. |
| Process kept alive only by subagents | **Not an active run for the screens.** It holds the conversation's lock and has no open answer: `open_answer_ids` is empty, nothing shows "pensando…", "Nova conversa" stays enabled, a typed message is injected into it. | It answers nothing. The server already treats it so: `reset` does not refuse a detached process, and `startWhileBusy` injects. The subagents panel is what shows that work. |
| The sidebar's busy mark | Not changed: `projectStatuses` keeps reading the lock. | It says the concierge is at work in the project, which is true with subagents running. |
| "Compactar" during a subagent-only process | Not changed: the button is enabled and the server refuses with its own sentence. | The screen has no event for the end of a process, so a flag read at load time would go stale. The refusal is clear. |
| A run alive in another instance | Counted. The conversation's row in `chat_live_runs`, when this instance does not own it, contributes the answer ids of its turns. | During the blue/green overlap, and between a restart and the sweep that resumes the run, the process or its open turns are not in this instance's memory. Such a row is either resumed or closed with an error, and both are published. |
| Seeding is add-only | A screen adds the ids of `open_answer_ids` to its started set. It never clears a started mark because the list lacks the id. | An event can arrive between the server's read and the screen's processing of it. Clearing would hide a row that just opened. A row is closed by its final `message`. |
| Decisions on the web | The routes await the **start** of the injected run, not its end. `ChatService.startAfterDecision` resolves once the turn is stored and handed to a process. Its longest wait is the 15 s a host moving between instances is given (`MOVING_WAIT_MS`). | The refusals the page relies on stay synchronous: a host that cannot run (409 with its code), an archived conversation, a busy one-shot run (`queued: true` with the note). Only the wait for the answer goes. |
| Response of a decision | `message` is no longer sent. `action`, `grant`, `project_grant`, `standing_grant`, `queued` and `note` are as today. The batch route likewise. | The page never read `message`: the answer reaches it over `/ws/chat`. |
| Mobile decision routes | Not changed. | They already answer at once, and apps in the field parse their response. |
| `POST /api/chat/messages` | Always 202 with the three ids. `wait` is still accepted in the body and ignored. | A page loaded before the deploy keeps sending it. |
| `ChatService.send` | **Kept**, against the roadmap. | 67 tests of `service.test.ts` use it as "run a whole turn". It is one line over `start`. The defect was the route, and the route's path goes. |
| Contract | `run_started` is added to `chatEventSchema`; `open_answer_ids` is added to the app's `chatResponse` with `.default([])`. No `MOBILE_API_VERSION` bump. | An older app drops a frame it cannot parse and ignores a field it does not know. An older server never sends the field. |
| No migration | Run state is in memory; the cross-instance part reads a table that exists. | — |

## 3. Shapes

```ts
// apps/server/src/chat/bus.ts — added to ChatEvent
/** An answer row is open: a process has its turn, or the queue holds it for the next one. Published
 * after the row's own `message` event, and again when a queued row is taken: screens keep a set.
 * Metadata only. */
| { type: 'run_started'; user_id: string; conversation_id: string; message_id: string }

// apps/server/src/chat/live-run.ts
/** The answer rows this process still owes: the one being written (a turn of the person's or one the
 *  CLI started on its own), then the waiting ones. */
openAnswerIds(): string[]

// apps/server/src/db/repositories/chat-live-runs.ts
/** The conversation's row when another instance owns it, whatever its state (alive there, released,
 *  stale or handed back). Null when there is none or it is this instance's. */
findElsewhere(conversationId: string, instanceId: string): Promise<ChatLiveRun | null>

// apps/server/src/chat/service.ts
/** The answer rows of a conversation that are still to be answered, by this instance or another. */
openAnswerIds(conversationId: string): Promise<string[]>
/** `resumeAfterDecision` up to the start of the run. Undefined when there was nothing to inject. */
startAfterDecision(user: User, action: ChatAction): Promise<StartedRun | undefined>

// apps/server/src/chat/open-answers.ts — pure
/** The ids of `open` that `messages` lists as an assistant row with no text and no error, in the
 *  order of `messages`. */
export function openAnswersIn(messages: readonly { id: string; role: string; text: string; error_code: string | null }[], open: readonly string[]): string[]
```

`GET /api/chat` and the mobile `GET` answer `open_answer_ids: openAnswersIn(messages, await service.openAnswerIds(conversation.id))`.

## 4. Where `run_started` is published

| Place | When |
|---|---|
| `LiveRun.add` | The turn was accepted (returned true). Covers the first turns of a process, an injected message, the queue launched into a process, and turns carried over a restart. |
| `LiveRun.answering` | A row was created for a turn the CLI started on its own, after its `message`. |
| `LiveRun.restart` | For each waiting turn, after its `reset`; for a merged turn, after the `message` of its new row. |
| `ChatService.finishRun` | First statement: a one-shot run owns the row. |
| `ChatService.startWhileBusy` | The turn was queued (not injected). |

`ChatService` keeps the rows of one-shot runs in `oneShot: Map<conversationId, answerId>`, set at the
start of `finishRun` and deleted in its `finally`.

## 5. Screens

**Web** (`apps/web`).

- `ChatEvent` gains `run_started` and `run_finished`.
- The fold (`lib/chat-live.ts`): `run_started` marks the row started, creating it when missing;
  `seed(ids)` does the same for a list. `reset` keeps the started mark and drops the text and the
  tools.
- `ChatPanel.load` calls `seed(open_answer_ids ?? [])` after `setMessages`.
- `answering` is true while sending, or while any listed message is an assistant row with no text, no
  error and a started mark. It no longer looks only at the newest row.

**Mobile** (`apps/mobile`).

- `applyLive` handles `run_started` as a started mark. `seedLive(fold, ids)` adds a list, and returns
  the same fold when nothing is new.
- The store's refresh seeds the open conversation's fold from `res.open_answer_ids`, after
  `pruneLive`.
- `run_finished` keeps its one effect (the storage flush).

Rows render as today: an empty row with a started mark shows "pensando…", an empty row without one
shows as failed.

## 6. Tests

- `open-answers.test.ts`: filters by role, text and error; keeps the order of `messages`; ignores
  unknown ids.
- `live-run.test.ts`: `add` publishes `run_started` after a successful add and not after a refused one;
  a turn the CLI starts publishes `message` then `run_started`; `restart` publishes `reset` then
  `run_started`; `openAnswerIds` lists the current row (with and without a turn) and the waiting ones.
- `service.test.ts`: a one-shot run publishes `run_started` before its first delta and
  `openAnswerIds` lists its row until it ends; a queued turn is listed and announced; a process with no
  open turn lists nothing; a row of another instance contributes its answer ids; `startAfterDecision`
  resolves while the run is still streaming, and refuses as `resumeAfterDecision` does.
- The repository's database test: `findElsewhere`.
- `routes/chat.test.ts`: `GET` carries `open_answer_ids`; a decision answers while the run is held
  open by the test's runner; `CHAT_BUSY` still answers `queued`; a host refusal still answers 409;
  `POST /messages` answers 202 with and without `wait`.
- `routes/m-chat.test.ts`: `GET` carries `open_answer_ids`.
- `events-parity.test.ts`: the sample of `run_started`.
- Web: fold (`run_started`, `seed`, `reset` keeps the mark); panel (a row listed in
  `open_answer_ids` shows "pensando…" on load; an empty row not listed shows as failed; "Nova
  conversa" is disabled while an older row is open).
- Mobile: `applyLive` and `seedLive`; the store seeds on refresh.

## 7. Out of scope

- An event for the end of a process, and a "Compactar" that knows about a subagent-only process.
- One-shot runs that die with the server: their row stays empty. Only streamed runs are resumed.
- The mobile decision routes and their note.
- Removing `ChatService.send`.

## 8. Not verified

| Assumption | Where it matters | How to check |
|---|---|---|
| The edge cuts a request at about 100 s | Problem 1. The change is right whatever the limit is. | Approve an action whose answer takes longer than two minutes, in production, and watch the card. |
