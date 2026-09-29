# Monitor: one wait, one alert — design

Cards: **TER-422** (#208), **TER-411** (#106), **TER-414** (#109), epic TER-407. Front 3 of the roadmap
(`2026-09-29-chat-and-machine-agent-roadmap-design.md`). Server, with one small change in the web.

Every decision below was taken without the user (2026-09-29, asked to plan and execute by recommendation);
the reason is written next to each one. The first version of this design was reviewed before any of it
was wired in; section 8 says what that review changed.

## 1. Problem

A tab "needs you" when its tool is waiting and the wait is newer than the last time the person looked
(`state_seen_at < state_at`). Every recorded event moves `state_at`, so the seen mark survives only when
the event is told to carry it (`continuesWait`, and only from `waiting_input` to `waiting_input`).

Three things follow from that.

1. **TER-422.** A wait the person has already seen lights the orange dot again with no new request. No
   toast comes with it when the tab is on screen, so the dot seems to return by itself.
2. **TER-411.** Cursor's `sessionStart` reads as `working`, and nothing takes a session that was never
   prompted out of it. The tab looks busy, and `wait_for_state` waits its whole timeout on it.
3. **TER-414.** Already fixed by `90024e01`: `afterAgentResponse` carries `continuesWait`, and
   `tabs.db.test.ts` pins the case. What is missing is the proof, on the web side, that stop → seen →
   answer fires one toast.

## 2. What re-arms a seen wait today

Read from the code at `e435250a`. Nothing here was measured in production: the event history of a tab
that re-armed is in `tab_events`, and this work had no access to that database.

| # | Path | New request? | Decision |
|---|---|---|---|
| 1 | The tab goes to `working` with no turn (Claude `SessionStart` on `/clear` or `/resume`; a reply typed from termhub that was a slash command), and about a minute later `idle_prompt` finds it `working` | No | Fixed (4.1) |
| 2 | `idle_prompt` arrives while the tab is `waiting_permission` | No | Fixed (4.1) |
| 3 | A `Stop`, a `Notification` or a Cursor `stop` lands after the session ended (the hook posts in the background, so order is not guaranteed) | No: the agent is closed | Kept, counted (4.3) |
| 4 | After a usage limit, the automatic account swap writes its own `waiting_input` | Yes: the resumed session may ask whether to trust the folder | Kept (4.3) |
| 5 | A Claude turn that nobody prompted: a background task ends, Claude wakes and answers | Yes: there is a new answer | Kept, counted (4.3) |
| 6 | `PermissionRequest` and `Notification(permission_prompt)` of one prompt, with the person looking in between | No | Kept (4.3) |
| 7 | The per-agent dot of the sidebar is not cleared by the optimistic seen mark | No | Fixed (4.4) |

Paths 4 and 5 are the ones that best fit the report ("some time later", "sometimes the agent is already
closed"). Both are real requests. **This change probably does not close #208 by itself**: it removes the
paths that are wrong for certain, and it adds the log that says which of the others the person is seeing.

## 3. Decisions

| Topic | Decision | Why |
|---|---|---|
| A reminder never opens an alert by itself | An event that is only a reminder of a wait (Claude's `idle_prompt`, the one event with `keepsWaitText`) alerts only when it is the first sign that a turn ended: the tab is `working` and a turn was really running. | `idle_prompt` says "still waiting". It is news only when the `Stop` before it was lost. |
| Reminder on a permission wait | Recorded as `waiting_input`, with the seen mark carried when the prompt had been seen. | The reminder means the dialog is gone and Claude is back at its prompt: an Esc on the dialog sends no `Stop`, so nothing else would take the tab out of `waiting_permission`, and `send_input` and `run_command` refuse on that state. Carrying the mark keeps it from alerting again. |
| Reminder with no turn running | The tab goes to `waiting_input`, born seen (`state_seen_at = state_at`). | The state is true (the tool is at its prompt) and there is nothing new to look at. |
| What "no turn running" means | The tab is `working` with no activity, its last event row is quiet, and every row between that one and the last wait is quiet or `idle`. Quiet events: `SessionStart` and termhub's own `input`. | `SessionStart` also fires when a compaction happens in the middle of a turn, and it clears the activity: only what came before it tells the two apart. After `/clear` the rows are a wait, a session end, a session start. In the middle of a turn a prompt or a tool call sits between the wait and the session start. |
| Late event after the session ended | Not changed. | Dropping it needs proof that the event belongs to the session that ended. Codex sends nothing but waits, so "a new session always announces itself" is false for it, and a second Claude in the same tmux session ends while the first is still working. A rule that can silence a live agent is worse than a dot on a closed one. |
| Account swap | Not changed: both of its events alert. | `account-swap.ts` records the wait before it types the resume line, because the resumed Claude may ask whether to trust the folder. |
| Turn nobody prompted | Still alerts. | It carries a new answer. Hiding it would hide that the agent finished. |
| Permission pair | Not changed; `tabs.db.test.ts` keeps pinning that every permission event re-arms. | Two prompts in a row can come with no `working` between them (parallel tool calls). Treating the second event as an echo could hide a real prompt. When the tab is on screen the web marks it seen again by itself. |
| Cursor `sessionStart` | Maps to `idle`. One that finds the tab `working` by a `beforeSubmitPrompt` less than 10 s old is dropped. Claude's `SessionStart` stays `working`. | `idle` is "a tool is here and nothing is pending". The two hooks of a launch with a prompt are posted in the background within milliseconds and can arrive in either order: without the guard the tab would read `idle` for the whole first turn, and `wait_for_state` would answer "finished". 10 s is twice the 5 s after which the hook's `curl` gives up. Claude is left alone because its launch has the same race and `idle_prompt` already takes an unprompted session out of `working`. |
| Evidence for the next round | One log line, metadata only, each time a wait alerts although the last `waiting_input` had been seen and no prompt of the person came after it: tab id, tool, the event before, the event that alerted, whether the seen wait had background tasks running, whether the last row is a session end. | Paths 3, 4 and 5 are left as they are on purpose. The log says how often each one happens, which this design could not measure. |
| TER-414 | One web test: stop, seen, answer, through the rule the toasts use. No server change. | The server side is fixed and pinned. |
| No migration | The rules read `tabs` and the last rows of `tab_events`, both already there. | — |

## 4. Rules

### 4.1 Reminder events

`recordEvent` decides under the tab's row lock, from the current row and its last ten event rows.

| Tab is | A turn was running | Outcome |
|---|---|---|
| `waiting_input` | — | Continuation, as today: the seen mark is carried when there is one, the wait's text is kept |
| `waiting_permission` | — | `waiting_input`; the seen mark is carried when there is one |
| `working` | yes | New wait, unseen: the `Stop` was lost and this is what ends the turn |
| `working` | no | `waiting_input`, born seen |
| `idle` | — | `waiting_input`, born seen |
| `error`, or no state | — | New wait, unseen, as today |

### 4.2 Cursor session start

`sessionStart` is `idle`. It is dropped (no row, no change) when the tab is `working` and its last event
row is a `beforeSubmitPrompt` less than 10 s old.

### 4.3 Kept as they are

Paths 3, 4, 5 and 6 of section 2. The log of 4.5 counts 3 and 5.

### 4.4 Web

`markSeen` writes the optimistic `state_seen_at` to the open-tab list too, which is what the sidebar's
per-agent dot reads. The server's push still confirms it.

### 4.5 Log

`monitor: seen wait re-armed`, at `info`, with `tabId`, `tool`, `previous`, `event`, `background` and
`afterSessionEnd`. Never the text.

## 5. Shape

```ts
// apps/server/src/monitor/wait-decision.ts — pure, no database
export interface WaitCurrent { state: TabState | null; seen: boolean; hasActivity: boolean; seenAgeMs: number | null }
export interface HistoryRow { kind: TabState; event: string | null; ageMs: number; backgroundTasks: boolean }
export interface WaitEvent { kind: TabState; name: string | null; continuesWait: boolean; keepsWaitText: boolean }

export type WaitOutcome =
  | { action: 'drop'; reason: 'session_start_during_turn' }
  | { action: 'record'; seen: 'carry' | 'born' | 'none'; continuing: boolean };

export function decideWait(current: WaitCurrent, history: HistoryRow[], event: WaitEvent): WaitOutcome;
export function rearmOf(current: WaitCurrent, history: HistoryRow[], event: WaitEvent, outcome: WaitOutcome): Rearm | null;
```

`history` is newest first. `recordEvent` answers `{ tab, event: null, rearm: null }` for a drop. A dropped
hook event ends `ingestHookEvent` as `ignored`.

## 6. Tests

- `wait-decision.test.ts`: every row of 4.1, rule 4.2 with its age bound, the quiet test with `/clear`
  and with a compaction in the middle of a turn, the re-arm report, and that every case
  `tabs.db.test.ts` pins today gives the outcome it has today.
- `tabs.db.test.ts`: the same sequences against Postgres.
- `state.test.ts`: Cursor `sessionStart` is `idle`.
- Web: the open-tab list gets the optimistic mark; stop, seen, answer alerts once.

## 7. Out of scope

- Whether an answer nobody asked for should alert (path 5), and late events (path 3). Decide with the log.
- `BUSY_STATES` counting the waiting states, and `clearState` with no caller: recorded in the roadmap.
- A mark of seen from the phone: the app never calls `/seen`.

## 8. What the review of the first version changed

| First version | Problem found | Now |
|---|---|---|
| A wait that lands on an `idle` tab whose last row is a session end is dropped | Codex sends only waits: after a Claude or Cursor session ends in the tab, every Codex turn would be dropped, for ever, because a drop writes no row. The `Stop` of a live Claude would be dropped when a second Claude in the same tmux session ends | Rule removed |
| `idle_prompt` over a permission wait is dropped | After an Esc on the dialog nothing else takes the tab out of `waiting_permission` | Recorded as `waiting_input`, seen mark carried |
| A quiet row is judged by itself | A compaction in the middle of a turn sends `SessionStart` and clears the activity | Everything back to the last wait must be quiet or idle |
| `PreCompact` is a quiet event | The hook script does not subscribe to it | Removed from the list |
| Re-arm is judged by the last row | A normal turn with an approved permission counts as a re-arm | Judged from the last `waiting_input` row, with the prompts after it |
| Cursor `sessionStart` is `idle`, always | The two hooks of a launch can arrive in either order | Dropped when a prompt less than 10 s old is the last row |
| The account swap's success event continues the wait | It is a request: the resumed Claude may ask to trust the folder | Not changed |
