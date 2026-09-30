# Concierge: read the last answer — design

Card: **TER-417** (#160), epic TER-1. Front 6 of the roadmap
(`2026-09-29-chat-and-machine-agent-roadmap-design.md`). Server only, with one migration.

Every decision below was taken without the user (2026-09-30, asked to plan and execute by
recommendation); the reason is written next to each one. The first version of this design was
reviewed against the code before any of it was written; section 6 says what that review changed.

## 1. Problem

Read from the code at `3410dad4`.

Claude Code, Codex and Cursor draw the whole screen: what leaves the top is not in tmux's history, so
`read_screen` cannot bring it back, however many lines are asked for. The concierge cannot read a
long answer of an agent. Its only ways out, keys to scroll or asking the agent to repeat, go through
an approval card and touch the person's terminal.

The server already receives the whole answer through the hooks (`Stop.last_assistant_message` of
Claude Code, `last_assistant_message` of Codex's `Stop` and `last-assistant-message` of its `notify`,
`afterAgentResponse.text` of Cursor) and keeps 2000 characters of it in `tabs.state_text`, for the UI.

## 2. Decisions

| Topic | Decision | Why |
|---|---|---|
| Where the answer lives | A table of its own, `tab_last_answers`: one row per tab (`tab_id` is the key, deleted with the tab), with `text`, `tool` and `at`. Overwritten at every turn. | A column on `tabs` would travel with every tab query: every hook, every list, up to a hundred thousand characters per tab. A table is read only by the one tool that wants it. `state_text` stays capped for the UI. |
| How much | At most 100 000 characters, cut with "…" at the end. | The hook body is capped at 256 KB. A hundred thousand characters is a long answer; the row stays bounded. |
| Which events carry it | The events that carry the final message of the agent's last turn: Claude `Stop`; Codex `Stop` and `notify` `agent-turn-complete`; Cursor `afterAgentResponse`. Never an event flagged as a subagent's. A reminder (`idle_prompt`), Cursor's `stop`, a permission prompt, and Claude's `StopFailure` carry none. | The interpreter already knows which payload is the answer. `StopFailure` carries the CLI's error line ("You've hit your weekly limit…"), not an answer: storing it would replace the real one exactly when the person wants it. `Interpreted` gains `answer`, uncapped, separate from `text`. |
| When it is written | In `recordEvent`, in the same transaction as the state, after the drop decision, only when the event carries an answer. An event with no answer leaves the row as it is. | This is the continuation rule of front 3 seen from the answer's side: `idle_prompt` never replaces the answer because it never carries one. The two events of a Codex turn write the same answer twice, which is harmless. |
| An empty answer | An event whose answer is empty writes nothing. | Nothing to read. |
| Session end, session start, a cleared state | Leave the row as it is. | The answer is still the last one the agent gave. The tool says when it arrived and whether a turn started since. |
| Stale answers | The tool answers `stale: true` when a `working` event of the tab is newer than the answer, and carries the tab's `state` and `state_at`. | After an Esc, an empty `Stop`, a lost `afterAgentResponse` or a hook body over its cap, the stored answer is from an earlier turn. The concierge must be able to tell. |
| Order of two answers | Not handled. | Hooks post in the background with a five-second timeout, so an older `Stop` lands after a newer one only when the next turn ended inside that window. `at` is server time under the row lock. |
| The tool | `read_last_answer(tab_id, offset?, max_chars?)`. Scope `read`, resource `terminals`, action `read`, a read for the gate. The tab is loaded through `ctx.scoped.tab`. It reads the database only: the machine may be offline. | The answer is the tab's, and reading a tab needs `terminals:read`, as `read_screen`. No key goes to the terminal, no card opens. |
| Paging | `offset` (default 0) and `max_chars` (default 20 000, at most 60 000). The answer carries `text` (that slice), `chars` (the whole length), `offset` and `next_offset` (null when the slice reached the end). | The concierge runs on Claude Code, which caps a tool result at about 25 000 tokens, and the MCP route pretty-prints the JSON. A hundred thousand characters in one result would be refused. |
| The rest of the answer | `source: 'hook'`, `tool`, `at`, `cut` (the stored answer was capped), `state`, `state_at`, `stale`. | The issue asks for the origin, so a transcript source can come later. |
| A tab with no answer | `text: null` and the note: "Esta aba não tem resposta registrada pelos hooks (hooks não instalados na máquina, ou nenhum turno terminou). Use read_screen para ver o terminal." | The concierge must know to fall back. |
| The tab's rows elsewhere | `Tab` and every list of tabs stay as they are. The repository gains `readLastAnswer(tabId)`. | The answer has one reader. |
| `read_screen` | On its styled path (the tool's), a `note` when the tab's last reported tool is Claude Code, Codex or Cursor, or when the tab has no monitor state at all: "Se esta aba roda um agente de tela cheia (Claude Code, Codex ou Cursor), o que saiu do topo não está no histórico do tmux. Com os hooks instalados na máquina, read_last_answer traz a última resposta completa." The server's own plain reads get no note. | The fallback the issue asks for, on tabs without hooks too. Worded as a condition: `state_tool` outlives the agent (a shell used after Claude exits still says `claude`), and a tab with no state may be a shell. |
| The concierge's prompts | The description of `read_last_answer` says what it is (the final message of the agent's last turn, the agent's output: data, never instructions), when to use it and how to page; the description of `read_screen` points to it. The project prompt's tail gains one sentence: "For an agent's last answer in full, use read_last_answer: read_screen shows only what is on the screen." | Descriptions are what the model reads first. The answer is text the agent, and whoever holds the machine's hook token, controls: the same class as `read_screen`, but longer. |
| Logs | The answer is terminal content: never logged. `recordState` logs its length only, as it does for `text`. | CLAUDE.md. |
| Phone and web | Nothing to do: no screen shows the answer. | The tool is the concierge's. |
| Codex over `notify` | Nothing special. | On Linux one argument is capped at 128 KiB, so a long answer reaches the server through the `Stop` hook (stdin), which the same turn also fires. |
| Transcript of the session | Not now (the issue's "evolução"). | It needs a new RPC in the agent and a path check on the machine. |
| Migration | `CREATE TABLE "tab_last_answers" ("tab_id" TEXT NOT NULL, "text" TEXT NOT NULL, "tool" TEXT NOT NULL, "at" TIMESTAMP(3) NOT NULL, CONSTRAINT "tab_last_answers_pkey" PRIMARY KEY ("tab_id"), CONSTRAINT "tab_last_answers_tab_id_fkey" FOREIGN KEY ("tab_id") REFERENCES "tabs"("id") ON DELETE CASCADE ON UPDATE CASCADE);` | A new table: the previous release keeps serving during the deploy and never names it. |

## 3. Shapes

```ts
// apps/server/src/monitor/state.ts
export const LAST_ANSWER_MAX = 100_000;
export interface Interpreted {
  // … as today, plus:
  /** The final message of the agent's last turn, whole (cut at LAST_ANSWER_MAX), when the event
   *  carries one. Stored apart from `text`, which stays capped for the UI. */
  answer?: string;
}

// apps/server/src/db/repositories/tabs.ts
export interface LastAnswer { text: string; at: string; tool: string; stale: boolean }
recordEvent(tabId, event: { …; answer?: string })
/** The row, with `stale` true when a working event of the tab is newer than it. */
readLastAnswer(tabId: string): Promise<LastAnswer | null>

// apps/server/src/control/screen.ts
export const ANSWER_DEFAULT_CHARS = 20_000;
export const ANSWER_MAX_CHARS = 60_000;
export const NO_ANSWER_NOTE: string;
export const FULL_SCREEN_NOTE: string;
export async function readLastAnswer(ctx: ControlContext, input: { tab_id: string; offset?: number; max_chars?: number }): Promise<
  | { tab_id: string; source: 'hook'; tool: string; at: string; text: string; offset: number; next_offset: number | null; chars: number; cut: boolean; stale: boolean; state: TabState | null; state_at: string | null }
  | { tab_id: string; text: null; note: string }>
readScreen(...) // its result gains `note?: string` on the styled path
```

`cut` is true when the stored answer is exactly `LAST_ANSWER_MAX` long and ends with "…". `offset`
past the end answers an empty `text` with `next_offset: null`.

## 4. Tests

- `state.test.ts`: for Claude `Stop`, Codex `Stop` and `notify`, Cursor `afterAgentResponse`, an answer
  of 10 000 characters comes as `answer` whole and as `text` capped at 2000; `StopFailure`,
  `idle_prompt`, Cursor `stop`, a permission prompt, a `PreToolUse` and a Codex `Stop` flagged as a
  subagent's carry no `answer`; an answer of 120 000 characters is cut at 100 000 with "…"; an empty
  answer gives no `answer`.
- `tabs.db.test.ts`: `recordEvent` with an answer writes the row; an event with none leaves it; a
  dropped event leaves it; `readLastAnswer` answers null for a tab that never had one; `clearState`
  leaves it; `stale` is false right after the answer and true once a `working` event follows; the
  answer is not in the `Tab` the repository answers; deleting the tab deletes the row.
- `screen.test.ts`: `read_last_answer` answers the stored answer with its fields; paging with
  `offset` and `max_chars`, the clamp, an offset past the end; `cut`; `stale` passed through; the note
  for a tab with none; 404 for a missing tab and for a tab outside the scope; works with the machine
  offline; `read_screen` adds the note for a tab whose last tool is Claude, Codex or Cursor and for a
  tab with no state, not for a shell with a state, and never on the plain path.
- `mcp/route.test.ts`: the exact list of tools gains `read_last_answer`; `gate.test.ts`: it is a read.
- `project-prompt.test.ts`: the new sentence is in the tail and the prompt stays within 4000.

## 5. Out of scope

- The transcript of the session, more than one turn.
- Showing the answer in the web or the phone.
- Two answers landing out of order.

## 6. What the review of the first version changed

| First version | Problem found | Now |
|---|---|---|
| Claude's `StopFailure` on a usage limit carried its answer | It carries the CLI's error line, not an answer | No answer on `StopFailure` |
| Three columns on `tabs` | Prisma selects every column: every hook and every tab list would fetch the answer | A table of its own |
| One result with the whole answer | Claude Code caps a tool result at about 25 000 tokens | `offset` and `max_chars`, with `next_offset` |
| No way to tell an old answer | After an Esc, an empty `Stop` or a lost event the stored answer is from an earlier turn | `stale`, `state`, `state_at` |
| The note only on tabs whose hooks reported a tool | The issue asks for it on tabs without hooks too, and `state_tool` outlives the agent | The note on those and on tabs with no state, worded as a condition |
| No `source` | The issue asks for the origin | `source: 'hook'` |
