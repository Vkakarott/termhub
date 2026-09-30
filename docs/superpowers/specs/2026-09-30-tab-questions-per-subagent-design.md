# Tab questions per subagent — design

Card: **TER-179**, epic TER-407. Front 8 of the roadmap
(`2026-09-29-chat-and-machine-agent-roadmap-design.md`). Hook script (`@termhub/machine-ops`, shipped by
`@termhub/agent`), server, one migration.

Every decision below was taken without the user (2026-09-30, asked to plan and execute by
recommendation); the reason is written next to each one. Section 3 is what was measured on a real
Claude Code before any of it was designed.

## 1. Problem

The first attempt at closing a subagent's card was reverted (spec 2026-09-26 tab questions hardening,
§10): the hook script collapses a subagent's `agent_id` into `subagent: true`, so the server cannot tell
one subagent from another, and B's closing event closed A's card, whose next answer could then approve
B's dialog. The rule since then: a subagent's event never closes a card, its own included. After the
person answers a subagent's permission in the terminal, that card stays open and pending until the main
thread's next closing event, and later permissions of the run are answered in the terminal with no card.

## 2. Decisions

| Topic | Decision | Why |
|---|---|---|
| The hook script forwards the id | The reduced `PreToolUse`, `PostToolUse` and `PermissionRequest` bodies carry `agent_id` as a value, next to `subagent: true`: the id as Claude Code sends it, kept only when it is 1 to 64 characters of `A-Za-z0-9_-`, dropped otherwise. | The id is what tells subagents apart. The boolean stays so an older server keeps today's behaviour with a newer script. |
| The hook script forwards a hint of the input | The reduced `PermissionRequest` body of Claude Code carries `hint`: the first 60 characters of `tool_input.command`, else of `tool_input.file_path`, else nothing, kept only in `A-Za-z0-9 ._/=-`, other characters dropped; cut at the first `"` of the payload, a trailing `\` dropped. | Two subagents asking for the same tool draw the same dialog title ("Bash command · from the general-purpose agent"); only the input tells them apart on screen. Letters and digits are what the live check compares, so the rest can go. |
| `TabQuestion.agent_id` | A nullable column with an index on `(tab_id, agent_id)`. Set from the opening event's `agent_id`; null for the main thread and for an old script. | The card must know whose dialog it is. |
| What closes a card | An event closes the rows of its own agent only: an event with `agent_id` X closes X's rows; an event with none closes the main thread's rows (`agent_id` null). `PermissionRequest`, `Notification` and an event that opens a question never close (as today). `SessionEnd` closes every row of the tab. | This is the whole fix. The main thread's `Stop` fires while subagents run (measured, section 3) and must not close their cards; a subagent's `PostToolUse` after the person answered its dialog is what closes its card. |
| An old script | An event with `subagent: true` and no `agent_id` never closes anything, as today; an event with neither closes the main thread's rows, as today. | Nothing changes until the machine's agent updates. |
| Queue | As today: a permission that arrives while a permission card of the tab is open marks the queue, opens nothing, and every permission until the next close is answered in the terminal. A close scoped to an agent clears the mark, as `closeForTab` does. | Claude Code shows one dialog at a time and the next one right after an answer (measured). Cards for queued dialogs are a change of their own, not this one. |
| Live check | For a permission card, `promptVisible` also requires, inside the dialog block, the tool's name (`Bash command` for `Bash`, the name itself otherwise) and, when the row has a `hint`, the hint; both reduced to letters and digits, as the rest. | The footer and "Do you want" are the same for every dialog of the run. With the name and the hint, a card can only answer the dialog it was opened for. |
| The card's text | `hint` is stored in the permission payload and shown on the card, under the tool's name, in the web and the phone, when the card already shows the payload. | The person sees what they approve. |
| Interpreted | `meta.agent_id` (string) next to `meta.subagent`. | The interpreter is the one place that reads the payload. |
| Logs | Ids only: `agent_id` may be logged; the hint never is. | The hint is terminal content. |
| Agent release | A patch version of `@termhub/agent`, published by CI. `heal()` rewrites the script on reconnect; ssh machines on "Reinstalar hooks". | The script ships with the agent. |
| Migration | `ALTER TABLE "tab_questions" ADD COLUMN "agent_id" TEXT; CREATE INDEX "tab_questions_tab_id_agent_id_idx" ON "tab_questions"("tab_id", "agent_id");` | Nullable: the previous release keeps serving and never names it. |

## 3. What was measured (2026-09-30, Claude Code 2.1.285 on hulk, `--permission-mode default`)

One prompt launched two background subagents, A and B, each running one `Bash` command that needs a
permission. Every hook payload was written to a file next to the termhub script. In order:

| Event | `agent_id` | Notes |
|---|---|---|
| `PreToolUse` Agent, `PostToolUse` Agent, twice | none | the main thread launches A and B |
| `Stop` | none | the main thread's turn ends; `background_tasks` lists A and B |
| `PreToolUse` Bash, `PermissionRequest` Bash | A | the command in `tool_input.command`; A's dialog is drawn |
| `PreToolUse` Bash, `PermissionRequest` Bash | B | while A's dialog is still on screen; no dialog for B yet |
| `SubagentStop` | other ids, `agent_type` empty | helper agents of the run; nothing to do with the dialogs |
| `Notification` permission_prompt, twice | none | for A's dialog |
| the person answers A in the terminal | | |
| `PostToolUse` Bash, `SubagentStop` | A | what closes A's card |
| `Notification` permission_prompt | none | B's dialog is now on screen |
| `Stop` | none | the main thread relays A's result; `background_tasks` lists B. **Today this closes B's card.** |
| the person answers B | | |
| `PostToolUse` Bash, `SubagentStop` | B | |
| `Stop` | none | `background_tasks` empty |

The dialog reads "Bash command · from the general-purpose agent", then the command and its description,
"Do you want to proceed?", the options, "Esc to cancel · Tab to amend". `PermissionRequest` carries
`agent_id` (17 hex characters), `agent_type`, `tool_name` and `tool_input`. `Notification` carries no
`agent_id`.

## 4. Shapes

```ts
// packages/machine-ops/src/hooks.ts — reduced bodies gain
{"hook_event_name":"PermissionRequest","tool_name":"Bash","subagent":true,"agent_id":"ac5724783efd1ee13","hint":"touch /tmp/th-f8/a-done  sleep 3"}
{"hook_event_name":"PostToolUse","tool_name":"Bash","subagent":true,"agent_id":"ac5724783efd1ee13"}

// apps/server/src/monitor/state.ts
meta: { event, tool, subagent?: true, agent_id?: string }
// apps/server/src/chat/tab-question-payload.ts
export interface PermissionPayload { tool_name: string; hint?: string }   // hint: 1–60 chars of A-Za-z0-9 ._/=-

// apps/server/src/chat/tab-questions.ts
/** Which rows an event closes: its own agent's, the main thread's, every one (a session end), or none. */
export function closingScope(next: Interpreted): { agent: string | null } | 'all' | null

// apps/server/src/db/repositories/tab-questions.ts
open(input: OpenTabQuestionInput & { agent_id: string | null })
closeForTab(tabId, status, scope: { agent: string | null } | 'all' = 'all')
```

## 5. Rules

- `closingScope`: null for an event that opens a question, a `Notification`, a `PermissionRequest`, or an
  event with `subagent: true` and no `agent_id`; `'all'` for `SessionEnd`; `{ agent: id }` for an event
  with `agent_id`; `{ agent: null }` for any other event.
- `closeForTab` with a scope closes only rows whose `agent_id` matches, and clears the queue mark of the
  tab. `'all'` is today's behaviour. The tab's lock is taken as today.
- `open` stores `agent_id`. The queue rule is unchanged.
- `promptVisible` for a permission row: the footer, "Do you want", the tool's title (`Bash command` when
  `tool_name` is `Bash`, else `tool_name`) and, when present, the hint; every one inside the dialog block.
- `answerTabQuestion` is unchanged: the stronger `promptVisible` is what refuses a stale card (409
  `TAB_PROMPT_CHANGED`).

## 6. Tests

- Hook script (`packages/machine-ops`): the reduced bodies carry `agent_id` and `hint`; an id with a
  quote or over 64 characters is dropped; a command with a `"` inside is cut before it; `file_path` when
  there is no command; nothing when neither.
- `state.test.ts`: `meta.agent_id` on a subagent's `PreToolUse`, `PostToolUse` and `PermissionRequest`;
  `hint` in the permission payload; none of it on the main thread's events.
- `tab-questions.test.ts` (`closingScope`): the table of section 5.
- `tab-questions.db.test.ts`: two open cards of different agents; a close scoped to A closes A's only
  and clears the queue mark; a close scoped to null closes the main thread's only; `'all'` closes both;
  the old-script case closes nothing.
- `permission-dialog.test.ts`: A's card with A's hint against B's dialog is refused; against A's dialog
  it passes; a card with no hint passes on the tool's title alone; the old footer and "Do you want" still
  required.
- The parallel test (`ingest` level, with the measured sequence of section 3 as fixtures): B's
  `PermissionRequest` queues; the main thread's `Stop` with background tasks closes nothing of A's;
  A's `PostToolUse` closes A's card; B's `Notification` closes nothing; B's `PostToolUse` closes nothing
  (no card); `SessionEnd` closes what is left.
- Web and phone: the card shows the hint when present (a snapshot each).

## 7. Out of scope

- Cards for queued dialogs (a queued permission opens nothing, as today).
- Codex and Cursor subagents.
- Answering a subagent's dialog from the chat when the dialog on screen is another's: the live check
  refuses it, and the person answers in the terminal.
