# Suggestion cards: never without the agent's message, never while the tab runs something in the background — design

Card: **TER-203** (bug, epic TER-1 · Chat). Follows TER-82 (`2026-09-25-tab-suggestions-design.md`), TER-83 and
TER-96 (`2026-09-26-tab-questions-hardening-design.md`). Subtasks are listed in the implementation plan
(`docs/superpowers/plans/2026-09-26-suggestion-card-context-and-background.md`).

Project rule: everything the chat does must work in the mobile app too, in the same delivery.

## 1. Problem

Reported by Pedro on 2026-09-26, after TER-83/TER-96 (PR #164) reached production:

1. **No message.** Suggestion cards keep arriving with only the text Claude Code suggests («como está o CI?», «e agora,
   o CI passou?», «e agora, terminou?», «e o deploy, terminou?»), without the agent's message they answer. Around the
   same time `list_tabs` returned the tab's full `state_text` ("I merged PR #169 as commit 3bf6bc1. I'm now watching
   the CI e Deploy run…").
2. **Not waiting.** In those cases the tab ("TER-57 memória decisões") was not waiting for a decision: it was idle,
   watching a background monitor, and the suggestion was Claude Code's own follow-up question. The card ("«X» está
   esperando sua resposta") makes it look like the tab needs an answer; the person answers and spends turns for nothing.

## 2. Investigation (2026-09-26, Claude Code 2.1.283 on jarvis)

Done with superpowers:systematic-debugging. Production data was **not** read: the session's permission mode refused a
read-only query on `termhub-db-1`, so the per-row evidence is left to §8.

### 2.1 The code path carries the context end to end

Read on `origin/main` (d3fb69c):

| Layer | Where | Carries `context`? |
|---|---|---|
| Hook script | `packages/machine-ops/src/hooks.ts` `HOOK_SCRIPT` | Yes: `Stop` is posted whole (only `PreToolUse` / `PermissionRequest` are reduced). |
| Hook route | `routes/hooks.ts` (body ≤ 256 KiB) | Yes. |
| Interpreter | `monitor/state.ts` `Stop` → `text = last_assistant_message` | Yes, when Claude Code sends it. |
| Tab row | `TabsRepository.recordEvent` (§6.1 of TER-96: `idle_prompt` keeps the wait's text) | Yes. |
| Suggestion row | `chat/tab-suggestions.ts` `checkTabSuggestion`: `context = cleanContext(tab.state_text)` read 5 s after the `Stop` | Yes, **if** `state_text` holds the message at that moment. |
| View / events | `toTabQuestionView` (always sends `context`, null for old rows), `publishTabQuestions` → `tab_suggestion` | Yes. |
| Web | `TabSuggestionCard` renders it; the bundle served by production (`/assets/index-CgqptiNu.js`, fetched through the local proxy) contains "Ver mensagem inteira" | Yes. |
| App | `tab-suggestion-card.tsx` renders it; `tabSuggestionSchema.payload.context` optional | Yes **from build 0.2.0**. An older build's zod object strips the unknown key. |

No layer drops a non-empty context. So the card shows no message when (a) the row was stored with `context: null`, or
(b) the client is an app build older than TER-96.

### 2.2 Live probes (isolated tmux `-L th-probe203`, a logging-only hook through `--settings`)

- **Prompt suggestions are paused in long-used accounts.** Claude Code drew no suggestion in a normal session; with
  `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=1` it drew one ~1.5 s after every `Stop` (`❯ ESC[2myes, commit itESC[0m`).
  The binary carries `promptSuggestionUnusedStreak` / `prompt_suggestions_paused`, consistent with suggestions pausing
  after a streak of unused ones. This is why TER-83's E2E "could not run because Claude Code drew no suggestion".
- **The suggestion generator is a subagent.** Each generated suggestion ends with a `SubagentStop` (empty
  `agent_type`) whose `last_assistant_message` is the suggested text; when it decides on nothing, the message is empty.
  We do not subscribe to `SubagentStop` (§9).
- **A background task wakes the session as a prompt.** With `Bash run_in_background` or `Monitor`, the turn's `Stop`
  carries `background_tasks: [{ id, type, status: "running", description, command }]`. When the task emits or ends,
  Claude Code fires `UserPromptSubmit` (prompt `<task-notification>…`), runs a turn, then a new `Stop`. After the last
  event, `background_tasks` is `[]`. Every `Stop` in the probes carried a non-empty `last_assistant_message`.
- The suggestion also appears while background tasks run ("yes, commit it" after a Monitor turn), so a suggestion card
  can open between two task notifications, exactly the reported scenario.

### 2.3 Production state seen through the MCP (`list_tabs`, 2026-09-27 00:50 UTC)

"TER-57 memória decisões" and "Pedro" (both on jarvis) were `waiting_input` with `state_text` = `Claude is waiting for
your input`. With TER-96's §6.1 in production, that text only survives when the wait being continued had **no text of
its own** (a `Stop` without `last_assistant_message`) or when the `idle_prompt` did not continue a wait (the tab was
`working`: interrupted turn, compaction, input typed through termhub). So in that tab `state_text` is not a reliable
source for "the message the suggestion answers" at every `Stop`.

### 2.4 Cause

- **Confirmed, problem 2:** nothing in the trigger looks at the tab's background work. A `Stop` with running
  `background_tasks` schedules the check like any other, and the card's open title claims the tab "está esperando sua
  resposta".
- **Confirmed, contributing to problem 1:** the context is read from the tab row (`state_text`), not from the `Stop`
  that scheduled the check, and a card opens even when that context is null. Any `Stop` without text yields a
  suggestion card with no message.
- **Likely, problem 1 on the phone:** the build with TER-96's card (0.2.0) was uploaded to App Store Connect on
  2026-09-26 16:35 but, per TER-104, still waited for processing and release to the testers group; an app older than
  0.2.0 strips `context` and shows the old title.
- **Not confirmed:** whether the reported rows were stored with `context: null`. §8 lists the two log reads that settle
  it; the design below fixes the server side either way.

## 3. Decisions

Decided by the implementer on the requester's instruction ("decida sozinho pela sua recomendação e registre as decisões
e o motivo"), 2026-09-26.

| Topic | Decision | Why |
|---|---|---|
| Context source | The `Stop` that schedules the check hands its own `last_assistant_message` to the check. The tab's `state_text` is no longer read. | It is exactly "the message the suggestion answers", immune to whatever the tab row went through in the 5 s. |
| No context | **No card.** A `Stop` without a usable message schedules nothing. | A card without the message is the reported defect: the person cannot tell what they approve. Claude Code ≥ 2.1.47 always sends the message on a normal turn end. |
| Background work | **No card** when the `Stop` reports any `background_tasks` entry with `status: "running"`. | The tab is not blocked: it resumes by itself on the next task notification. The follow-up it suggests ("e agora, o CI passou?") is the noise that spends turns. Once the last task ends, the final `Stop` has `[]` and a card may open as usual. |
| Follow-up question heuristic | Not done. | Text rules over the suggestion (pt/en, "terminou?", "passou?") are fragile; the background signal covers the reported case. |
| Card copy (web + app) | Open title "«X» terminou — o Claude Code sugere:" ("Uma aba terminou — o Claude Code sugere:"), plus a muted line "Não precisa responder." Neutral border instead of the accent. Closed titles, field label, buttons unchanged. | The remaining cards are suggestions for a tab that finished, not a question: the copy must not claim it waits for an answer. |
| Older Claude Code without `background_tasks` | Treated as no background work (today's behaviour). | Nothing to read; the field exists in 2.1.283. |
| Hook script / agent | Unchanged. No new `@termhub/agent` release. | `Stop` already travels whole. |
| `state_text` / `list_tabs` | Unchanged. | Out of this card's scope (§9). |
| Diagnostics | One `info` log per skipped check with a reason code, and the running-task count in the `Stop`'s event meta. Metadata only. | So the next report can be settled from logs without reading rows. |

## 4. Server

### 4.1 Interpreter (`monitor/state.ts`)

- `Interpreted` gains `backgroundTasks?: number`: on a Claude `Stop` only, the number of `background_tasks` entries
  whose `status` is the string `running`, set only when it is > 0. Anything that is not an array counts as 0.
- The same count goes into the event's `meta` as `background_tasks` (number, only when > 0), so `tab_events` keeps it.
  No description or command ever leaves the interpreter (they can hold the person's command lines).

### 4.2 Scheduling (`monitor/ingest.ts`, `chat/tab-suggestions.ts`)

- `ingestHookEvent` still cancels a pending check on every event, then, for a Claude `Stop`, calls
  `scheduleTabSuggestion(repos, log, tabId, { context: interpreted.text, backgroundTasks: interpreted.backgroundTasks ?? 0 })`.
- `scheduleTabSuggestion` decides before any timer:
  - `backgroundTasks > 0` → log `{ tabId, reason: 'background', count }` "tab suggestion skipped", schedule nothing;
  - `cleanContext(context) === null` → log `{ tabId, reason: 'no_context' }`, schedule nothing;
  - otherwise the 5 s timer runs `checkTabSuggestion(repos, log, tabId, cleanedContext, still)`.
- `checkTabSuggestion` takes the context as a parameter and stores it as `payload.context`; it no longer reads
  `tab.state_text` / `tab.state_tool`. Everything else (conversation, machine, agent version, styled capture, `/`/`!`
  rule, `still()`, repository re-check under the tab lock) is unchanged.
- `cleanContext` keeps its rules (including the idle message → null, now only defensive).

### 4.3 Contract

Unchanged: `payload: { text, context }`. New rows always have a non-null `context`; old rows keep `null`.

## 5. Clients (web and app, same copy)

- `suggestionTitle` (web `tab-suggestion-text.ts`, app `model/tab-suggestion-text.ts`): open →
  `«X» terminou — o Claude Code sugere:` / `Uma aba terminou — o Claude Code sugere:`; closed unchanged
  (`«X» sugere:` / `Uma aba sugere:`).
- New exported constant `SUGGESTION_HINT = 'Não precisa responder.'`, rendered muted under the title while open.
- Border: web `border-line` (was `border-accent/40`); app `border-app-border` (was `border-app-accent`).
- Tests that match the old title (web `TabSuggestionCard`, `ChatPanel`, `tab-suggestion-text`; app
  `tab-suggestion-text`, `conversation-screen`) move to the new one.
- The app change reaches phones only with the next TestFlight build (§7).

## 6. Testing

- **Interpreter:** `background_tasks` running / completed / mixed / absent / not an array → count and meta; the
  existing `toEqual` for a bare `Stop` stays valid (no field when 0).
- **Ingest:** a `Stop` schedules with its own text and count; other events only cancel.
- **Suggestions:** skip on background (no timer, no capture, log reason), skip on no context (null, blank, idle
  message), open with the `Stop`'s context even when the tab row's `state_text` differs, no log carries text.
- **Web / app:** title, hint, closed titles, context still collapsed/expanded.
- **Live, real Claude Code** (isolated tmux, throwaway Postgres `th-*`, dev server on 127.0.0.1, as TER-83's Task 12),
  started with `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=1` so a suggestion is drawn reliably:
  1. a normal turn ending in a question → a card whose `context` is that `Stop`'s message;
  2. a `Monitor` / background task running → the `Stop` has `background_tasks` running → no card, log reason
     `background`; when the task ends, the final `Stop` → a card with the final message;
  3. a hand-posted `Stop` without `last_assistant_message` while a suggestion is on screen → no card, reason
     `no_context`;
  4. logs carry no message or suggestion text.

## 7. Risks

- **Fewer cards.** Tabs on Claude Code < 2.1.47 (no `last_assistant_message`) get no suggestion cards at all. Accepted:
  those cards could not say what they approved.
- **A tab that is genuinely waiting while a background task runs** (the agent asked a question and also left a monitor
  running) gets no suggestion card; the concierge and the tab still show the question. Accepted: the suggestion card is
  an optional shortcut, and questions proper (`AskUserQuestion`, permissions) are separate cards, not affected.
- **Phones on a build older than 0.2.0** keep showing context-less cards with the old title until they update; the new
  copy needs a build after this change.
- **Prompt suggestions paused** in Pedro's accounts would make the whole feature rarely fire; not ours to change, noted
  for expectations.
- The cause of the rows reported on 2026-09-26 is not proven row by row (§8).

## 8. Evidence to collect (read-only, metadata only)

Run on jarvis by Pedro (or by a session allowed to read production logs), before or after the fix:

```bash
C=$(docker ps --filter name=termhub-app --filter health=healthy --format '{{.Names}}' | head -1)
# Each suggestion opened for the "TER-57 memória decisões" tab and how long its stored context was
docker logs "$C" --since 12h 2>&1 | grep '"tab suggestion opened"' | grep bimdrmpzvvmu
# The Stop events of that tab and the length of their text (textLen 0 = a Stop without message)
docker logs "$C" --since 12h 2>&1 | grep '"monitor: tab state"' | grep bimdrmpzvvmu | grep '"kind":"waiting_input"'
```

`contextChars: 0` on the opened rows confirms the server-side cause; `contextChars > 0` points at the client (app build).
The retired color's logs (`docker logs` on the stopped color) cover the time before the last deploy.

## 9. Out of scope

- Taking the suggestion from the generator's `SubagentStop` instead of the screen (needs a new hook event, script and
  agent release).
- Keeping a textless `Stop` from blanking `state_text` for `list_tabs` / `wait_for_state`.
- Suggestions for Codex / Cursor.
- A per-`agent_id` close rule for subagents (TER-83 §10 follow-up).
