# Chat: run state and decisions that answer at once — design

Cards: **TER-416** (#157), **TER-415** (#156), epic TER-1. Front 4 of the roadmap
(`2026-09-29-chat-and-machine-agent-roadmap-design.md`). Server, web, mobile contract and mobile app.

Every decision below was taken without the user (2026-09-29, asked to plan and execute by
recommendation); the reason is written next to each one. The first version of this design was reviewed
against the code before any of it was written; section 9 says what that review changed.

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
4. **A deleted answer row stays on screen.** The server deletes an empty answer row in five places (a
   turn merged into the next, `abandon`, a turn the CLI started and ended silently, two setup failures
   of a one-shot run) and re-publishes the question, expecting screens to re-read. They do not:
   `mergeMessage` on both screens only adds or replaces. The row shows "pensando…" until a reload.
5. **A failure to start is silent when nobody awaits the run.** A run that could not be attempted ends
   with `run_finished`, `message_id: null` and `SETUP_FAILED`. Both screens ignore it. It already
   happens to a typed message (the 202 path) and to every decision taken on the phone.
6. **TER-415 leftover.** `POST /api/chat/messages` still has the path that awaits the whole run and
   answers 201, taken when the body has no `wait: false`. The web always sends it, so only tests take
   that path, and it keeps the defect alive for any caller that forgets the flag.

## 2. Decisions

| Topic | Decision | Why |
|---|---|---|
| Unit of "a run" for the screens | One open answer row. `run_started` names a row, as `run_finished` already does. | A live process answers many turns, and several rows can be open at once (injected and queued messages). A flag per conversation cannot say which rows wait. |
| What opens a row | The row gets an owner: a live process takes the turn, a one-shot run starts, or the queue holds it for the next process. Also a turn the CLI starts on its own, and every turn that waits again after a retry on a fresh session. | These are all the places where an answer will come, including a turn carried over a restart, which no `message` event announces. |
| What closes a row | Its final `message` (text or an error code), or `message_removed`. Nothing else. A closed row never opens again. | `carryOver` skips answered rows and `restart` gives merged turns new rows, so an id that closed is closed for good. Screens can therefore refuse to reopen it. |
| `message_removed` | A new event, published at every deletion of an answer row. Screens drop the row from the thread. | The server comments already assume screens learn of a deletion. An explicit event is cheaper than a re-read and cannot be missed by a screen that is not reading. |
| `run_started` is idempotent | A row queued and later taken by a process is announced twice. Screens add the id to a set. | One rule on the server ("announce when the row gets an owner") instead of tracking what was already said. |
| Order | `run_started` is published after the `message` event of its row, never before. In `startWhileBusy` it is published right after `enqueue` and before `launchQueued` is called. | The screen must have the row before it is told the row is open, and the queue may close a turn as soon as it runs. |
| What `GET` carries | `open_answer_ids: string[]`, in `GET /api/chat` and in the mobile `GET`. Only ids of rows the same response lists as empty assistant rows with no error. | The screen needs exactly the rows to show as "pensando…". A flat list is enough; nothing reads a richer object. |
| Process kept alive only by subagents | **Not an active run for the screens.** It holds the conversation's lock and has no open answer: `open_answer_ids` is empty, nothing shows "pensando…", "Nova conversa" stays enabled, a typed message is injected into it. | It answers nothing. The server already treats it so: `reset` does not refuse a detached process, and `startWhileBusy` injects. The subagents panel is what shows that work. |
| The sidebar's busy mark | Not changed: `projectStatuses` keeps reading the lock. | It says the concierge is at work in the project, which is true with subagents running. |
| "Compactar" during a subagent-only process | Not changed: the button is enabled and the server refuses with its own sentence. | The screen has no event for the end of a process, so a flag read at load time would go stale. The refusal is clear. |
| A run in another instance | Its open turns are listed only when its row in `chat_live_runs` is released or stale (`findResumable`). A row alive elsewhere is left out. | The bus is in-process: a turn that finishes in the other instance is never announced to a screen connected to this one. A released or stale row is exactly what this instance will resume or close, and both are published here. Every listed row is closed by an event this screen receives. |
| Seeding | A screen adds the ids of `open_answer_ids` to its started set, except ids it knows are closed. It never clears a started mark because the list lacks the id. | An event can arrive between the server's read and the screen's processing of it, in either direction. Adding a closed id would show "pensando…" for ever; clearing an open one would hide a row that just opened. |
| A re-read never regresses a row | When a snapshot lists as empty a row the screen holds as final, the screen keeps its own. A row the screen saw removed is dropped from the snapshot. | Same race: the snapshot is older than the event. |
| A run that could not start | Both screens handle `run_finished` with `message_id: null`: they re-read the conversation and show one pt-BR line. | With the decision no longer awaiting the answer, this event is the only place the failure is said. |
| Decisions on the web | The routes await the **start** of the injected run, not its end. `ChatService.startAfterDecision` resolves once the turn is stored and handed to a process, and attaches its own `catch` to `done`, which logs the failure's label. It waits on nothing but database reads and the host; the host wait is at most `MOVING_WAIT_MS` (15 s). | The refusals the page relies on stay synchronous: a host that cannot run (409 with its code), an archived conversation, a busy one-shot run (`queued: true` with the note). Only the wait for the answer goes. |
| `resumeAfterDecision` | Kept, defined as `startAfterDecision` followed by `done`. | The mobile routes and the tests use it. One implementation, so the two paths cannot diverge. |
| Response of a decision | `message` is no longer sent. `action`, `grant`, `project_grant`, `standing_grant`, `queued` and `note` are as today. The batch route likewise. | The page never read `message`: the answer reaches it over `/ws/chat`. |
| Mobile decision routes | Not changed. | They already answer at once, and apps in the field parse their response. |
| `POST /api/chat/messages` | Always 202 with the three ids. `wait` is still accepted in the body and ignored. | A page loaded before the deploy keeps sending it. |
| `ChatService.send` | **Kept**, against the roadmap. | 67 tests of `service.test.ts` use it as "run a whole turn". It is one line over `start`. The defect was the route, and the route's path goes. |
| Contract | `run_started` and `message_removed` are added to `chatEventSchema`; `open_answer_ids` is added to the app's `chatResponse` with `.default([])`. No `MOBILE_API_VERSION` bump. | An older app drops a frame it cannot parse and ignores a field it does not know. An older server never sends the field. |
| No migration | Run state is in memory; the cross-instance part reads a table that exists. | — |

## 3. Shapes

```ts
// apps/server/src/chat/bus.ts — added to ChatEvent
/** An answer row is open: a process has its turn, or the queue holds it for the next one. Published
 * after the row's own `message` event, and again when a queued row is taken: screens keep a set.
 * Metadata only. */
| { type: 'run_started'; user_id: string; conversation_id: string; message_id: string }
/** An answer row was deleted: nothing will be written into it. Screens drop the row. */
| { type: 'message_removed'; user_id: string; conversation_id: string; message_id: string }

// apps/server/src/chat/live-run.ts
/** The answer rows this process still owes: the one being written (a turn of the person's or one the
 *  CLI started on its own), then the waiting ones. */
openAnswerIds(): string[]

// apps/server/src/chat/service.ts
/** The answer rows of a conversation that are still to be answered. The union of: the live process's
 *  `openAnswerIds()`, the row of a one-shot run, the rows of queued turns, and the turns of the
 *  conversation's row in `chat_live_runs` when another instance released it or left it stale. */
openAnswerIds(conversationId: string): Promise<string[]>
/** `resumeAfterDecision` up to the start of the run. Undefined when there was nothing to inject. The
 *  returned `done` already has a catch: a caller may ignore it. */
startAfterDecision(user: User, action: ChatAction): Promise<StartedRun | undefined>

// apps/server/src/chat/open-answers.ts — pure
/** The ids of `open` that `messages` lists as an assistant row with no text and no error, in the
 *  order of `messages`. */
export function openAnswersIn(messages: readonly { id: string; role: string; text: string; error_code: string | null }[], open: readonly string[]): string[]
```

`GET /api/chat` and the mobile `GET` answer
`open_answer_ids: openAnswersIn(messages, await service.openAnswerIds(conversation.id))`. The ids are
read in the same `Promise.all` as the messages; the filter makes either order safe.

## 4. Where rows open and close

**`run_started`.**

| Place | When |
|---|---|
| `LiveRun.add` | The turn was accepted (returned true). Covers the first turns of a process, an injected message, the queue launched into a process, and turns carried over a restart. A refused turn publishes nothing. |
| `LiveRun.answering` | A row was created for a turn the CLI started on its own, after its `message`. |
| `LiveRun.restart` | For each waiting turn, after its `reset`; for a merged turn, after the `message` of its new row. |
| `ChatService.finishRun` | First statement: a one-shot run owns the row. Its retry on a fresh session keeps the owner and announces nothing more. |
| `ChatService.startWhileBusy` | The turn was queued (not injected): right after `enqueue`, before `launchQueued`. |

`ChatService` keeps the rows of one-shot runs in `oneShot: Map<conversationId, answerId>`, set at the
start of `finishRun` and deleted in its `finally`.

**`message_removed`**, right after each `deleteMessage` of an answer row.

| Place | Row |
|---|---|
| `LiveRun.consume`, `turn_started` | The empty answer of a turn merged into the next one. |
| `LiveRun.abandon` | The answer of every open turn. |
| `LiveRun.finishTurn` | The row of a turn the CLI started that said nothing. |
| `LiveRun.restart` | **New deletion.** The row of a turn the CLI started on its own that was being written when the session was found missing. Today it is left open for ever; its partial text is dropped like the others'. |
| `ChatService.finishRun` | The answer of a one-shot run that could not be attempted, in both places it is deleted. |

The re-publication of the question that goes with each deletion stays as it is.

The deletion in `restart` is the last step before `setCliSession`: the person's turns are back in the
waiting list, and their `reset` and `run_started` are published, before it is tried. It is best
effort. A failure is logged by its label, the row is left as it is, and the restart goes on: a turn of
the person's must never be stranded by the row of a turn nobody asked for. The question re-published
with it is `lastQuestion`, as in `finishTurn`.

A closed row is closed for good. `run_finished` with an id always follows the final `message` of that
id; a merged turn closes through `message_removed`; a queued turn that was closed has a final row,
which `carryOver` skips. A future path that writes into a closed row would be invisible to the
screens: the comment on `openAnswerIds` says so.

## 5. Screens

Both screens keep, for the open conversation, a **started** set and a **closed** set of message ids.

| Event | Effect |
|---|---|
| `message`, assistant, empty, no error | Started, unless closed. |
| `message`, assistant, final | Closed. What streamed for it is let go. |
| `delta`, `action` | Started, as today. |
| `reset` | What streamed is dropped. The started mark stays. A reset of an unknown id changes nothing. |
| `run_started` | Started, unless closed. |
| `run_finished` with a message id | Closed. |
| `run_finished` with `message_id: null` | The screen re-reads the conversation and shows "O concierge não conseguiu começar a resposta. Tente de novo." |
| `message_removed` | Closed, and the row leaves the thread. |
| A re-read of the same conversation | The four rules below, then `open_answer_ids` are started, unless closed. |
| A re-read of another conversation (a reset, another project) | The snapshot replaces the thread. The started, closed and removed sets are emptied, then seeded. |

A re-read of the same conversation merges the snapshot into the thread by id:

1. A row the snapshot lists as empty and the screen holds as final keeps the screen's version.
2. A row the screen saw removed is left out of the snapshot.
3. A row the snapshot lacks is dropped, unless its `message` event reached the screen while the
   read was in flight. A dropped row is closed. This is what closes a row whose `message_removed`
   was missed while the socket was down, and what keeps the page right against a server that
   predates the event.
4. Every other row takes the snapshot's version.

The phone compares `created_at` with the snapshot's newest row today, and the first version of
this design copied it. That keeps a deleted answer for ever: an answer is always newer than its
question. Both screens use rule 3 as written above. The web replaces the list wholesale today,
and gets the same four rules.

A `message_removed` for a row the screen never had is harmless: the id is remembered, so a later
snapshot that still lists the row leaves it out. The null `run_finished` belongs to one conversation:
only the screen, or the phone's slot, of its `conversation_id` re-reads and shows the line.

**Web** (`apps/web`).

- `ChatEvent` gains `run_started`, `run_finished` and `message_removed`.
- `lib/chat-live.ts`: the fold gains the closed set, `seed(ids)`, `clear()`, `isClosed(id)`,
  `removed()` and `closeRows(ids)` (closes the rows a merge dropped, without marking them removed). On `reset` the row keeps `started` and takes `text: ''` and the shared empty tools
  array.
- `lib/chat-merge.ts`: `mergeThread(current, server, removed, arrived)` applies the four rules, where
  `arrived` is the set of ids whose `message` event reached the panel while the read was in flight.
  `ChatPanel.load` uses it when the conversation is the one on screen, replaces the list and clears the
  fold otherwise, then seeds.
- Events held before the panel knows its conversation are replayed through the same path as live
  ones, so a held final `message` or `message_removed` also reaches the thread, not only the fold.
- `answering` is true while sending, or while any listed message is an assistant row with no text, no
  error and a started mark. It no longer looks only at the newest row.

**Mobile** (`apps/mobile`).

- `model/live.ts`: `LiveFold` gains `closed` and `removed`; `applyLive` handles the three events;
  `seedLive(fold, ids)` adds a list and returns the same fold when nothing is new.
- `model/events.ts`: `mergeMessage` keeps a final row over an empty one; `mergeThread` leaves out
  removed rows; `applyEvent` drops the row on `message_removed`.
- The store's refresh seeds the open conversation's fold from `res.open_answer_ids`, after
  `pruneLive`. `run_finished` keeps its storage flush, and with a null id also refreshes and sets the
  screen's error line.

Rows render as today: an empty row with a started mark shows "pensando…", an empty row without one
shows as failed.

## 6. Tests

- `open-answers.test.ts`: filters by role, text and error; keeps the order of `messages`; ignores
  unknown ids.
- `live-run.test.ts`: `add` publishes `run_started` after a successful add and not after a refused one;
  a turn the CLI starts publishes `message` then `run_started`; `restart` publishes `reset` then
  `run_started`, and removes the row of a turn the CLI started; every deletion publishes
  `message_removed`; `openAnswerIds` lists the current row (with and without a turn) and the waiting
  ones.
- `service.test.ts`: a one-shot run publishes `run_started` before its first delta and
  `openAnswerIds` lists its row until it ends; a queued turn is listed and announced, also when it
  waits behind a subagent-only process that ended its input; a process with no open turn lists
  nothing; a released row of another instance contributes its answer ids and a row alive elsewhere
  does not; a setup failure publishes `message_removed`; `startAfterDecision` resolves while the run
  is still streaming, refuses as `resumeAfterDecision` does, and a rejection of `done` is never
  unhandled.
- `routes/chat.test.ts`: `GET` carries `open_answer_ids`; a decision answers while `done` is pending;
  `CHAT_BUSY` still answers `queued`; a host refusal still answers 409; a setup failure after a
  decision answers 200; `POST /messages` answers 202 with and without `wait`.
- `routes/m-chat.test.ts`: `GET` carries `open_answer_ids`.
- `events-parity.test.ts`: the samples of `run_started` and `message_removed`.
- Web: the fold (every row of the table in section 5); `mergeThread`; the panel (a row listed in
  `open_answer_ids` shows "pensando…" on load; an empty row not listed shows as failed; a row that
  finished while the read was in flight stays final; after a merge, "Nova conversa" is enabled again;
  a run that could not start re-reads and shows the line).
- Mobile: `applyLive`, `seedLive`, `mergeMessage`, `mergeThread`; the store seeds on refresh and
  handles the two new events and the null `run_finished`.

## 7. Out of scope

- An event for the end of a process, and a "Compactar" that knows about a subagent-only process.
- One-shot runs that die with the server: their row stays empty. Only streamed runs are resumed.
- A bus that reaches the other instance. Until then a turn that finishes in the other colour during
  the overlap shows as failed on a screen connected to this one, until a re-read. It is so today.
  Likewise a stale row this instance listed and the old instance claimed first: the old instance sweeps
  until it is told to stop, and what it then publishes stays on its own bus. The window is a crash row
  that goes stale during a deploy.
- The mobile decision routes and their note.
- Removing `ChatService.send`.

## 8. Not verified, and known gaps

| Item | Where it matters | How to check, or why it is accepted |
|---|---|---|
| The edge cuts a request at about 100 s | Problem 1. The change is right whatever the limit is. | Approve an action whose answer takes longer than two minutes, in production, and watch the card. |
| A row this instance owns in `chat_live_runs` with no process in memory | Between a claim and `runLive`, a row in `orphans`, a row whose final delete failed. It is not listed. | The row shows as failed until the `run_started` that `add` publishes. An orphan waits for the next sweep (30 s). |
| A page loaded before the deploy | It keeps the old fold: after a retry it shows the row as failed until the next delta, and it ignores the new events. | Harmless, and gone on reload. |

## 9. What the review of the first version changed

| First version | Problem found | Now |
|---|---|---|
| Deleted rows were not mentioned | Screens never learn of a deletion. With `answering` reading every row, a deleted row would disable "Nova conversa" until a reload, after every message typed during a tool call | `message_removed`, at every deletion |
| Seeding is add-only, with no memory of closed rows | A snapshot older than the final `message` brings the row back empty, and the seed marks it started for ever | A closed set; a re-read never regresses a row |
| `startAfterDecision` said nothing of `done` | A setup failure, a failed final write or a restart would be an unhandled rejection, and the page would show nothing | `done` is caught and logged; both screens handle the null `run_finished` |
| A row of another instance is listed whatever its state | A turn that finishes in the other instance is never announced here | Only a released or stale row is listed |
| `openAnswerIds` did not name its sources | A queued turn behind a process that ended its input is in neither the process nor the one-shot map | The union is written in section 3 |
| The order in `startWhileBusy` was not stated | `launchQueued` may close the turn at once | After `enqueue`, before `launchQueued` |
| `restart` was listed only as a place that opens rows | It leaves the row of a turn the CLI started open for ever | It deletes that row and says so |
| `findElsewhere`, a new repository method | Not needed once only released or stale rows count | `findResumable`, which exists |
| The web merges a re-read "by the two rules" | A merge that never drops a row keeps the archived thread on screen after "Nova conversa", and keeps a row whose removal was missed | The phone's two other rules, and a replace when the conversation changes |
| The new deletion in `restart` had no place in the order | A deletion that throws before the turns are re-queued strands the person's turns | Last step, best effort |
| Held events feed only the fold | A held final `message` or removal leaves the thread with the snapshot's row | Held events take the same path as live ones |
| Rule 3 compared `created_at` with the snapshot's newest row | A deleted answer is always newer than its question, so the merge kept it, started, until a reload | A row is kept only when its `message` arrived during the read |
