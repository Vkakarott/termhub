# Concierge: read the last answer — design

Card: **TER-417** (#160), epic TER-1. Front 6 of the roadmap
(`2026-09-29-chat-and-machine-agent-roadmap-design.md`). Server only, with one migration.

Every decision below was taken without the user (2026-09-30, asked to plan and execute by
recommendation); the reason is written next to each one.

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
| Where the answer lives | Three nullable columns on `tabs`: `last_answer`, `last_answer_at`, `last_answer_tool`. Overwritten at every turn. | One row per tab, one answer per tab: a column, not a table. `state_text` stays capped for the UI. |
| How much | At most 100 000 characters, cut with "…" at the end. | The hook body is capped at 256 KB. A hundred thousand characters is a long answer; the row stays bounded. |
| Which events carry it | The events that carry the agent's answer: Claude `Stop` and `StopFailure` with a `last_assistant_message`; Codex `Stop` and `notify` `agent-turn-complete`; Cursor `afterAgentResponse`. A reminder (`idle_prompt`), a `stop` of Cursor, a permission prompt carry none. | The interpreter already knows which payload is the answer. `Interpreted` gains `answer`, uncapped, separate from `text`. |
| When it is written | In `recordEvent`, in the same transaction as the state, only when the event carries an answer and is not dropped. An event with no answer leaves the columns as they are. | This is the continuation rule of front 3 seen from the answer's side: `idle_prompt` never replaces the answer because it never carries one. The two events of a Codex turn write the same answer twice, which is harmless. |
| An empty answer | An event whose answer is empty writes nothing. | Nothing to read. |
| Session end, session start, a cleared state | Leave the columns as they are. | The answer is still the last one the agent gave. `read_last_answer` says when it arrived. |
| The tool | `read_last_answer(tab_id)`: `{ tab_id, tool, at, text, chars, cut }` or `{ tab_id, text: null, note }`. Scope `read`, resource `terminals`, action `read`, a read for the gate. The tab is loaded through `ctx.scoped.tab`. It reads the database only: the machine may be offline. | The answer is the tab's, and reading a tab needs `terminals:read`, as `read_screen`. No key goes to the terminal, no card opens. |
| A tab with no answer | `text: null` and the note: "Esta aba não tem resposta registrada pelos hooks (hooks não instalados na máquina, ou nenhum turno terminou). Use read_screen para ver o terminal." | The concierge must know to fall back. |
| The tab's rows elsewhere | `Tab` and every list of tabs stay as they are: the answer is not part of them. The repository gains `readLastAnswer(tabId)`. | A hundred thousand characters in every tab of every list would be a cost with no reader. |
| `read_screen` | Answers a `note` when the tab's last reported tool is Claude Code, Codex or Cursor: "Esta aba roda um agente de tela cheia: o que saiu do topo não está no histórico do tmux. Para a última resposta completa, use read_last_answer." | The fallback the issue asks for, and the pointer to the new tool. |
| The concierge's prompts | The description of `read_last_answer` says when to use it; the description of `read_screen` points to it. The project prompt's tail gains one sentence: "For an agent's last answer in full, use read_last_answer: read_screen shows only what is on the screen." | Descriptions are what the model reads first. |
| Logs | The answer is terminal content: never logged. `recordState` logs its length only, as it does for `text`. | CLAUDE.md. |
| Phone and web | Nothing to do: no screen shows the answer. | The tool is the concierge's. |
| Transcript of the session | Not now (the issue's "evolução"). | It needs a new RPC in the agent and a path check on the machine. |
| Migration | `ALTER TABLE "tabs" ADD COLUMN "last_answer" TEXT, ADD COLUMN "last_answer_at" TIMESTAMP(3), ADD COLUMN "last_answer_tool" TEXT;` | Nullable columns: the previous release keeps serving during the deploy, and its Prisma client never selects them. |

## 3. Shapes

```ts
// apps/server/src/monitor/state.ts
export const LAST_ANSWER_MAX = 100_000;
export interface Interpreted {
  // … as today, plus:
  /** The agent's whole answer, when the event carries one (cut at LAST_ANSWER_MAX). Stored apart from
   *  `text`, which stays capped for the UI. */
  answer?: string;
}

// apps/server/src/db/repositories/tabs.ts
export interface LastAnswer { text: string; at: string; tool: string }
recordEvent(tabId, event: { …; answer?: string })
readLastAnswer(tabId: string): Promise<LastAnswer | null>

// apps/server/src/control/screen.ts
export const NO_ANSWER_NOTE: string;
export const FULL_SCREEN_NOTE: string;
export async function readLastAnswer(ctx: ControlContext, input: { tab_id: string }):
  Promise<{ tab_id: string; tool: string; at: string; text: string; chars: number; cut: boolean } | { tab_id: string; text: null; note: string }>
readScreen(...) // its result gains `note?: string`
```

`cut` is true when the stored answer ends with "…" placed by the cap; `chars` is the stored length.

## 4. Tests

- `state.test.ts`: for Claude `Stop`, Codex `Stop` and `notify`, Cursor `afterAgentResponse`, an answer
  of 10 000 characters comes as `answer` whole and as `text` capped at 2000; `idle_prompt`, Cursor
  `stop`, a permission prompt and a `PreToolUse` carry no `answer`; an answer of 120 000 characters is
  cut at 100 000 with "…"; an empty answer gives no `answer`.
- `tabs.db.test.ts`: `recordEvent` with an answer writes the three columns; an event with none leaves
  them; a dropped event leaves them; `readLastAnswer` answers null for a tab that never had one;
  `clearState` leaves them; the answer is not in the `Tab` the repository answers.
- `screen.test.ts`: `read_last_answer` answers the stored answer with its time and tool; the note for a
  tab with none; 404 for a tab outside the scope; works with the machine offline; `read_screen` adds
  the note for a tab whose last tool is Claude, Codex or Cursor, and not for a shell.
- `mcp/route.test.ts`: the exact list of tools gains `read_last_answer`; `gate.test.ts`: it is a read.
- `project-prompt.test.ts`: the new sentence is in the tail and the prompt stays within 4000.

## 5. Out of scope

- The transcript of the session, more than one turn.
- Showing the answer in the web or the phone.
