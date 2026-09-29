# Monitor: one wait, one alert — design

Cards: **TER-422** (#208), **TER-411** (#106), **TER-414** (#109), epic TER-407. Front 3 of the roadmap
(`2026-09-29-chat-and-machine-agent-roadmap-design.md`). Server, with one small change in the web.

Every decision below was taken without the user (2026-09-29, asked to plan and execute by recommendation);
the reason is written next to each one.

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
| 1 | The tab goes to `working` with no turn (Claude `SessionStart` on `/clear`, `/resume` or after a compaction; `PreCompact`; a reply typed from termhub that was a slash command), and about a minute later `idle_prompt` finds it `working` | No | Fixed (4.1) |
| 2 | `idle_prompt` arrives while the tab is `waiting_permission` | No: the prompt is still the same one | Fixed (4.1) |
| 3 | A `Stop`, a `Notification` or a Cursor `stop` lands after the session ended (the hook posts in the background, so order is not guaranteed) | No: the agent is closed | Fixed (4.2) |
| 4 | After a usage limit, the automatic account swap writes its own `waiting_input` | Yes: the resumed session may ask whether to trust the folder, and that answer is the person's | Kept (4.3) |
| 5 | A Claude turn that nobody prompted: a background task ends, Claude wakes and answers | Yes: there is a new answer | Kept (4.3) |
| 6 | `PermissionRequest` and `Notification(permission_prompt)` of one prompt, with the person looking in between | No | Kept (4.3) |
| 7 | The per-agent dot of the sidebar is not cleared by the optimistic seen mark | No | Fixed (4.4) |

## 3. Decisions

| Topic | Decision | Why |
|---|---|---|
| A reminder never opens an alert | An event that is only a reminder of a wait (Claude's `idle_prompt`, the one event with `keepsWaitText`) alerts only when it is the first sign that a turn ended: the tab is `working` and a turn was really running. | `idle_prompt` says "still waiting". It is news only when the `Stop` before it was lost. |
| Reminder on a permission wait | Dropped: no state change, no event row. | The tab must keep saying `waiting_permission`; turning it into `waiting_input` would hide what kind of answer is pending. |
| Reminder with no turn running | The tab goes to `waiting_input`, born seen (`state_seen_at = state_at`). | The state is true (the tool is at its prompt) and there is nothing new to look at. |
| What proves a turn | The last event row is not a quiet one, or the tab has an activity (a tool call went through the light path, which writes no row). Quiet events: `SessionStart`, `PreCompact`, and termhub's own `input`. | The light path keeps no history, so the activity column is the only trace of a tool call after a quiet event. |
| Late event after the session ended | Dropped, when the tab is `idle`, its last event is `SessionEnd` or `sessionEnd`, and the event is a wait that came from a tool's hook. | A new session always starts with a session start or a prompt, which are not waits and go through. termhub's own events are never late: the account swap waits for the session to end and then writes its wait on purpose. |
| Account swap | Unchanged: both of its events alert. | `account-swap.ts` records the wait before it types the resume line, because the resumed Claude may ask whether to trust the folder. It is a request. |
| Turn nobody prompted | Still alerts. | It carries a new answer. Hiding it would hide that the agent finished. |
| Permission pair | Unchanged; `tabs.db.test.ts` keeps pinning that every permission event re-arms. | Two prompts in a row can come with no `working` between them (parallel tool calls). Treating the second event as an echo could hide a real prompt, which is worse than a dot that comes back for a moment. When the tab is on screen the web marks it seen again by itself. |
| Cursor `sessionStart` | Maps to `idle`. Claude's `SessionStart` stays `working`. | `idle` is "a tool is here and nothing is pending", which is what a session with no prompt is. Claude is left alone because `start_agent` types the prompt with the launch: between `SessionStart` and `UserPromptSubmit` a `wait_for_state` would read `idle` as "finished". Cursor has the same window, accepted: it is the only state that does not read as busy, and the window exists today for a tab with no state yet. |
| Evidence for the next round | One log line, metadata only, each time a seen wait is re-armed: tab id, tool, the event before and the event that re-armed. | Paths 4 and 5 are product questions, and 5 is the one most likely to be what the person sees. The log says how often each path happens, which this design could not measure. |
| TER-414 | One web test: stop, seen, answer, through the same listener the toasts use. No server change. | The server side is fixed and pinned. |
| No migration | The rules read `tabs` and the last row of `tab_events`, both already there. | — |

## 4. Rules

### 4.1 Reminder events

`recordEvent` decides under the tab's row lock, from the current row and the last event row.

| Tab is | A turn was running | Outcome |
|---|---|---|
| `waiting_input` | — | Continuation, as today: the seen mark is carried when there is one, the wait's text is kept |
| `waiting_permission` | — | Dropped |
| `working` | yes | New wait, unseen: the `Stop` was lost and this is what ends the turn |
| `working` | no | `waiting_input`, born seen |
| `idle` | — | `waiting_input`, born seen |
| `error`, or no state | — | New wait, unseen, as today |

### 4.2 Late events

Before anything else: the event came from a hook, the tab is `idle`, the last event row is a session
end, and the incoming event is `waiting_input` or `waiting_permission`. The event is dropped.

Events termhub writes itself (the reply route, the account swap) are never treated as late.

### 4.3 Kept as they are

Paths 4, 5 and 6 of section 2. The log of 4.5 counts them.

### 4.4 Web

`markSeen` writes the optimistic `state_seen_at` to the open-tab list too, which is what the sidebar's
per-agent dot reads. The server's push still confirms it.

### 4.5 Log

`monitor: seen wait re-armed`, at `info`, with `tabId`, `tool`, `previous` and `event` (hook event names).
Never the text.

## 5. Shape

```ts
// apps/server/src/monitor/wait-decision.ts — pure, no database
export type WaitOutcome =
  | { action: 'drop'; reason: 'late_after_session_end' | 'reminder_on_permission' }
  | { action: 'record'; seen: 'carry' | 'born' | 'none'; keepText: boolean; rearmed: boolean };

export function decideWait(
  current: { state: TabState | null; seen: boolean; hasActivity: boolean },
  previousEvent: string | null,          // meta.event of the last event row
  event: { kind: TabState; continuesWait: boolean; keepsWaitText: boolean; hasText: boolean; fromHook: boolean },
): WaitOutcome;
```

`recordEvent` calls it inside its transaction and answers `{ tab, event: null, rearmed: false }` for a
drop. `applyState` publishes nothing for a drop and writes the log line when `rearmed`. A dropped hook
event ends `ingestHookEvent` as `ignored`: no question card is opened or closed by it, and no suggestion
check is scheduled.

## 6. Tests

- `wait-decision.test.ts`: every row of 4.1 and 4.2, and that every case `tabs.db.test.ts` pins today gives
  the outcome it has today.
- `tabs.db.test.ts`: `/clear` then `idle_prompt` on a seen wait stays seen; `idle_prompt` on a seen
  permission wait changes nothing; a `Stop` after `SessionEnd` changes nothing; a lost `Stop` still alerts.
- `state.test.ts`: Cursor `sessionStart` is `idle`.
- `tabs.db.test.ts`: termhub's own wait after a session end (the account swap) is recorded and alerts.
- Web: the open-tab list gets the optimistic mark; stop, seen, answer fires one toast.

## 7. Out of scope

- Whether an answer nobody asked for should alert (path 5). Decide with the log of 4.5.
- `BUSY_STATES` counting the waiting states, and `clearState` with no caller: recorded in the roadmap.
- A mark of seen from the phone: the app never calls `/seen`.
