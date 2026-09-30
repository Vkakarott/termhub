# Concierge Last Answer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The concierge reads an agent's last answer in full, from what the hooks already deliver, without touching the terminal.

**Architecture:** The hook interpreter separates the whole answer (`answer`) from the capped text (`text`); `recordEvent` stores it in three new nullable columns of `tabs`; a read tool `read_last_answer` answers it through the scoped tab, and `read_screen` points to it on full-screen agents.

**Tech Stack:** Fastify, Prisma (one migration), zod, vitest (`apps/server`).

**Spec:** `docs/superpowers/specs/2026-09-30-concierge-last-answer-design.md`. Read it before any task: sections 2 and 3 are the rules and the shapes.

## Global Constraints

- Code comments, identifiers, commit messages and pull request texts are in English. Notes and error messages shown to the person or to the concierge as tool notes stay in Portuguese (pt-BR). Prompts told to the model are in English.
- Commit subject: imperative, at most 72 characters, prefixed by the area (`Monitor:`, `Concierge:`, `Docs:`). A short body says why.
- Terminal content is never logged: the answer never reaches a log line; log ids and lengths.
- Routes never import Prisma. Every tool input is validated with zod. The tab is loaded through `ctx.scoped.tab`.
- The migration adds nullable columns only, so the previous release keeps serving during the deploy.
- `Tab` and every list of tabs stay as they are: the answer travels only through `readLastAnswer`.
- The cap, verbatim: `LAST_ANSWER_MAX = 100_000`, cut as `${s.slice(0, LAST_ANSWER_MAX - 1)}…`.
- The notes, verbatim:
  - no answer: `Esta aba não tem resposta registrada pelos hooks (hooks não instalados na máquina, ou nenhum turno terminou). Use read_screen para ver o terminal.`
  - full screen: `Esta aba roda um agente de tela cheia: o que saiu do topo não está no histórico do tmux. Para a última resposta completa, use read_last_answer.`
- The prompt sentence, verbatim: `For an agent's last answer in full, use read_last_answer: read_screen shows only what is on the screen.`
- In a pull request or commit text, never write close, fix or resolve (in any form) next to an issue number unless the issue must close. Cite with `Part of #160`.
- One commit per step that says "Commit". Never amend a commit that was already pushed.

### Running things on this machine (hulk, macOS)

```bash
export DATABASE_URL=postgresql://postgres:postgres@localhost:5432/termhub   # only parsed, no database is needed
npm run prisma:generate -w @termhub/server                                    # after the schema change
npm test -w @termhub/server -- <paths>
npm run typecheck -w @termhub/server
```

- `grep` and `cat` are aliased in the interactive shell; in scripts use `/usr/bin/grep` and `/bin/cat`.
- There is no Postgres here. Tests named `*.db.test.ts` are skipped without `TERMHUB_DB_TESTS=1`; CI runs them. Write them with care, with the helpers of their file.
- **Known failures of the baseline on this machine, not caused by this plan:** three or four tests about `xlsx` and `docx` in `apps/server/src/chat/attachments`, and the codex case of `src/mcp/start-agent.e2e.test.ts`. They pass in CI. Any other failure is yours.

---

### Task 1: The answer is kept whole

**Files:**
- Modify: `apps/server/prisma/schema.prisma` (model `Tab`)
- Create: `apps/server/prisma/migrations/20260930040000_tab_last_answer/migration.sql`
- Modify: `apps/server/src/monitor/state.ts`
- Test: `apps/server/src/monitor/state.test.ts`
- Modify: `apps/server/src/db/repositories/tabs.ts`
- Test: `apps/server/src/db/repositories/tabs.db.test.ts`
- Modify: `apps/server/src/monitor/ingest.ts` (`recordState` passes `answer`)

**Interfaces:**
- Consumes: `Interpreted`, `recordEvent`, which exist.
- Produces, for Task 2: `TabsRepository.readLastAnswer(tabId: string): Promise<LastAnswer | null>` with `LastAnswer = { text: string; at: string; tool: string }`; `LAST_ANSWER_MAX` from `monitor/state.ts`.

- [ ] **Step 1: The schema and the migration**

In `apps/server/prisma/schema.prisma`, model `Tab`, after `activityVerb`:

```prisma
  /// The agent's last whole answer, from its hooks (spec 2026-09-30 last answer): read by the concierge's
  /// read_last_answer only, never part of a tab list. stateText keeps the capped copy for the UI.
  lastAnswer     String?   @map("last_answer")
  lastAnswerAt   DateTime? @map("last_answer_at")
  lastAnswerTool String?   @map("last_answer_tool")
```

`apps/server/prisma/migrations/20260930040000_tab_last_answer/migration.sql`:

```sql
-- TER-417: the agent's last whole answer, as the hooks deliver it (spec 2026-09-30 last answer §2).
-- Nullable columns only: the previous release keeps serving during the deploy and never selects them.
ALTER TABLE "tabs" ADD COLUMN "last_answer" TEXT, ADD COLUMN "last_answer_at" TIMESTAMP(3), ADD COLUMN "last_answer_tool" TEXT;
```

Run: `npm run prisma:generate -w @termhub/server && npm run typecheck -w @termhub/server`
Expected: PASS.

- [ ] **Step 2: Write the failing tests of the interpreter**

In `apps/server/src/monitor/state.test.ts`, with the file's own way of calling `interpretHookEvent(tool, event)`:

```ts
describe('the whole answer (spec 2026-09-30 last answer)', () => {
  const long = 'x'.repeat(10_000);

  it.each([
    ['claude', { hook_event_name: 'Stop', last_assistant_message: long }],
    ['codex', { hook_event_name: 'Stop', last_assistant_message: long }],
    ['codex', { type: 'agent-turn-complete', 'last-assistant-message': long }],
    ['cursor', { hook_event_name: 'afterAgentResponse', text: long }],
  ] as const)('%s keeps the answer whole and the text capped', (tool, event) => {
    const out = interpretHookEvent(tool, event)!;
    expect(out.answer).toBe(long);
    expect(out.text!.length).toBe(STATE_TEXT_MAX);
    expect(out.text!.endsWith('…')).toBe(true);
  });

  it('a StopFailure on a usage limit keeps the answer it carries', () => {
    const out = interpretHookEvent('claude', { hook_event_name: 'StopFailure', error: 'rate_limit', last_assistant_message: long })!;
    expect(out.answer).toBe(long);
  });

  it.each([
    ['claude', { hook_event_name: 'Notification', notification_type: 'idle_prompt', message: 'Claude is waiting for your input' }],
    ['claude', { hook_event_name: 'PreToolUse', tool_name: 'Bash' }],
    ['claude', { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: {} }],
    ['cursor', { hook_event_name: 'stop', status: 'completed' }],
  ] as const)('%s events that carry no answer have none', (tool, event) => {
    expect(interpretHookEvent(tool, event)?.answer).toBeUndefined();
  });

  it('cuts an answer longer than LAST_ANSWER_MAX', () => {
    const out = interpretHookEvent('claude', { hook_event_name: 'Stop', last_assistant_message: 'y'.repeat(120_000) })!;
    expect(out.answer!.length).toBe(LAST_ANSWER_MAX);
    expect(out.answer!.endsWith('…')).toBe(true);
  });

  it('an empty answer is no answer', () => {
    expect(interpretHookEvent('claude', { hook_event_name: 'Stop', last_assistant_message: '   ' })?.answer).toBeUndefined();
  });
});
```

Adapt the event shapes to the ones the file already uses for these events (the Codex `notify` payload, Cursor's fields, the Claude field names). If the file's Cursor `stop` needs a `conversation_id` or such, add it.

Run: `npm test -w @termhub/server -- src/monitor/state.test.ts`
Expected: FAIL.

- [ ] **Step 3: Separate the answer in the interpreter**

In `apps/server/src/monitor/state.ts`:

```ts
/** The most of an agent's answer that is kept whole (spec 2026-09-30 last answer): the hook body is
 *  capped at 256 KB, and a hundred thousand characters is a long answer. */
export const LAST_ANSWER_MAX = 100_000;
const whole = (v: string | null): string | undefined => (v === null ? undefined : v.length > LAST_ANSWER_MAX ? `${v.slice(0, LAST_ANSWER_MAX - 1)}…` : v);
```

`Interpreted` gains `answer?: string` with the comment of the spec's section 3. Then, at each event that carries the answer, compute it once and set both fields:

- Claude `Stop`: `const raw = str(ev.last_assistant_message); const text = cap(raw);` and the two returns gain `...(whole(raw) === undefined ? {} : { answer: whole(raw) })`. Write a small helper to avoid repeating that spread: `const withAnswer = (out: Interpreted, raw: string | null): Interpreted => { const a = whole(raw); return a === undefined ? out : { ...out, answer: a }; }`.
- Claude `StopFailure` on `rate_limit`: the same with `line`.
- Codex `Stop`: with `str(ev.last_assistant_message)`.
- Codex `notify` `agent-turn-complete`: with `str(ev['last-assistant-message'])`.
- Cursor `afterAgentResponse`: with `str(ev.text)`.

Nothing else gains it.

Run: `npm test -w @termhub/server -- src/monitor`
Expected: PASS.

- [ ] **Step 4: Write the failing database tests**

In `apps/server/src/db/repositories/tabs.db.test.ts`, with the file's own helpers to make a tab and to read rows:

```ts
describe('the last answer (spec 2026-09-30)', () => {
  it('recordEvent stores the answer an event carries, and leaves it when an event carries none', async () => {
    const tab = await makeTab();                                   // the file's helper
    await repos.tabs.recordEvent(tab.id, { kind: 'working', tool: 'claude', text: null, meta: { event: 'UserPromptSubmit' } });
    expect(await repos.tabs.readLastAnswer(tab.id)).toBeNull();

    await repos.tabs.recordEvent(tab.id, { kind: 'waiting_input', tool: 'claude', text: 'resposta…', meta: { event: 'Stop' }, answer: 'resposta inteira, de verdade' });
    const first = await repos.tabs.readLastAnswer(tab.id);
    expect(first).toMatchObject({ text: 'resposta inteira, de verdade', tool: 'claude' });
    expect(Date.parse(first!.at)).toBeGreaterThan(0);

    // A reminder carries no answer: the stored one stays, time included.
    await repos.tabs.recordEvent(tab.id, { kind: 'waiting_input', tool: 'claude', text: 'Claude is waiting for your input', meta: { event: 'Notification', type: 'idle_prompt' }, continuesWait: true, keepsWaitText: true });
    expect(await repos.tabs.readLastAnswer(tab.id)).toEqual(first);

    // The next answer replaces it.
    await repos.tabs.recordEvent(tab.id, { kind: 'working', tool: 'claude', text: null, meta: { event: 'UserPromptSubmit' } });
    await repos.tabs.recordEvent(tab.id, { kind: 'waiting_input', tool: 'claude', text: 'outra', meta: { event: 'Stop' }, answer: 'outra resposta' });
    expect((await repos.tabs.readLastAnswer(tab.id))!.text).toBe('outra resposta');
  });

  it('a dropped event and clearState leave the answer as it is, and the Tab row never carries it', async () => {
    const tab = await makeTab();
    await repos.tabs.recordEvent(tab.id, { kind: 'waiting_input', tool: 'cursor', text: 'r', meta: { event: 'afterAgentResponse' }, answer: 'r inteira' });
    await repos.tabs.clearState(tab.id);
    expect((await repos.tabs.readLastAnswer(tab.id))!.text).toBe('r inteira');
    const row = await repos.tabs.findById(tab.id);
    expect(row).not.toHaveProperty('last_answer');
    expect(JSON.stringify(row)).not.toContain('r inteira');
  });
});
```

For the dropped event, use the sequence the file already pins as dropped (a Cursor `sessionStart` right after a `beforeSubmitPrompt`), with an `answer` on the dropped event, and expect the stored answer unchanged.

They cannot run here: CI runs them.

- [ ] **Step 5: Store and read the answer**

In `apps/server/src/db/repositories/tabs.ts`:

```ts
/** An agent's last whole answer, as the hooks delivered it (spec 2026-09-30 last answer). */
export interface LastAnswer {
  text: string;
  at: string;
  tool: string;
}
```

`recordEvent`'s `event` gains `answer?: string`. In the `tx.tab.update` data, after `activityVerb`:

```ts
          // The whole answer, when the event carries one (spec 2026-09-30 last answer). An event with
          // none — a reminder, a permission prompt, a tool call — leaves the last one as it is.
          ...(event.answer === undefined ? {} : { lastAnswer: event.answer, lastAnswerAt: at, lastAnswerTool: event.tool }),
```

And, after `clearState` (which does not touch the three columns):

```ts
  /** The agent's last whole answer of a tab, or null when none was ever recorded. Read on its own:
   *  it is never part of a `Tab` row, which every list carries. */
  async readLastAnswer(tabId: string): Promise<LastAnswer | null> {
    const row = await this.db.tab.findUnique({ where: { id: tabId }, select: { lastAnswer: true, lastAnswerAt: true, lastAnswerTool: true } });
    if (!row?.lastAnswer || !row.lastAnswerAt || !row.lastAnswerTool) return null;
    return { text: row.lastAnswer, at: row.lastAnswerAt.toISOString(), tool: row.lastAnswerTool };
  }
```

`mapTab` in `types.ts` is not changed: it never reads the three columns.

In `apps/server/src/monitor/ingest.ts`, `recordState` passes `...(next.answer === undefined ? {} : { answer: next.answer })` to `recordEvent`. Its log line keeps logging `textLen` only; add `answerLen: next.answer?.length ?? 0`, never the answer.

Run: `npm run typecheck -w @termhub/server && npm test -w @termhub/server -- src/monitor src/db`
Expected: PASS (the database tests are skipped here).

- [ ] **Step 6: Commit**

```bash
git add apps/server/prisma apps/server/src/monitor apps/server/src/db
git commit -m "Monitor: keep the agent's last answer whole" -m "The hooks deliver the whole answer and the tab kept 2000 characters of it, for the UI. Three nullable columns now hold the last answer as it came, written only by the events that carry one, so a reminder never replaces it."
```

---

### Task 2: The concierge reads it

**Files:**
- Modify: `apps/server/src/control/screen.ts`
- Test: `apps/server/src/control/screen.test.ts`
- Modify: `apps/server/src/mcp/tools.ts`, `apps/server/src/chat/gate.ts`
- Test: `apps/server/src/mcp/route.test.ts`, `apps/server/src/chat/gate.test.ts`
- Modify: `apps/server/src/chat/project-prompt.ts`
- Test: `apps/server/src/chat/project-prompt.test.ts`
- Modify: `README.md`, `docs/superpowers/plans/2026-09-29-chat-and-machine-agent-roadmap.md` (Front 6)

**Interfaces:**
- Consumes: `TabsRepository.readLastAnswer`, `LastAnswer`, `HOOK_TOOLS` of `monitor/state.ts`.
- Produces: the tool `read_last_answer`.

- [ ] **Step 1: Write the failing tests of the control**

In `apps/server/src/control/screen.test.ts`, the `repos.tabs` of `ctx` gains `readLastAnswer: vi.fn(async () => answer)`, where `answer` is a parameter of `ctx` (default `null`). Then:

```ts
describe('readLastAnswer', () => {
  const stored = { text: 'a'.repeat(10_000), at: '2026-09-30T03:00:00.000Z', tool: 'claude' };

  it('answers the stored answer with its time and tool, and does not need the machine', async () => {
    vi.spyOn(agents, 'awaitAgent').mockResolvedValue(false);
    const r = await readLastAnswer(ctx(baseTab(), stored), { tab_id: 't1' });
    expect(r).toEqual({ tab_id: 't1', tool: 'claude', at: stored.at, text: stored.text, chars: 10_000, cut: false });
  });

  it('says when the stored answer was cut', async () => {
    const r = await readLastAnswer(ctx(baseTab(), { ...stored, text: `${'b'.repeat(99_999)}…` }), { tab_id: 't1' });
    expect(r).toMatchObject({ chars: 100_000, cut: true });
  });

  it('a tab with no answer gets the note', async () => {
    const r = await readLastAnswer(ctx(baseTab(), null), { tab_id: 't1' });
    expect(r).toEqual({ tab_id: 't1', text: null, note: NO_ANSWER_NOTE });
  });

  it('404 for a tab outside the scope', async () => {
    await expect(readLastAnswer(ctx(undefined, stored), { tab_id: 't1' })).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('readScreen and full-screen agents', () => {
  it.each(['claude', 'codex', 'cursor'])('adds the note when the last tool is %s', async (tool) => {
    vi.mocked(captureStyledScreen).mockResolvedValue({ text: 'x\n', styled: true });
    const r = await readScreen(ctx(baseTab({ state_tool: tool })), { tab_id: 't1' });
    expect(r.note).toBe(FULL_SCREEN_NOTE);
  });

  it('adds no note for a plain shell', async () => {
    vi.mocked(captureStyledScreen).mockResolvedValue({ text: 'x\n', styled: true });
    const r = await readScreen(ctx(baseTab({ state_tool: null })), { tab_id: 't1' });
    expect(r).not.toHaveProperty('note');
  });
});
```

The existing test `captures the default 200 lines…` uses a tab whose `state_tool` is `claude`: its `toEqual` gains `note: FULL_SCREEN_NOTE`, or the tab gets `state_tool: null`; say which in the report.

Run: `npm test -w @termhub/server -- src/control/screen.test.ts`
Expected: FAIL.

- [ ] **Step 2: Write the control**

In `apps/server/src/control/screen.ts`:

```ts
import { HOOK_TOOLS } from '../monitor/state.js';

export const NO_ANSWER_NOTE = 'Esta aba não tem resposta registrada pelos hooks (hooks não instalados na máquina, ou nenhum turno terminou). Use read_screen para ver o terminal.';
export const FULL_SCREEN_NOTE = 'Esta aba roda um agente de tela cheia: o que saiu do topo não está no histórico do tmux. Para a última resposta completa, use read_last_answer.';

const fullScreen = (tab: Tab): boolean => (HOOK_TOOLS as readonly string[]).includes(tab.state_tool ?? '');

/**
 * The agent's last whole answer of a tab (spec 2026-09-30 last answer), as its hooks delivered it. A
 * read of the database only: no key to the terminal, no card, and the machine may be offline. Never
 * logged. `cut` says the stored answer was capped.
 */
export async function readLastAnswer(
  ctx: ControlContext,
  input: { tab_id: string },
): Promise<{ tab_id: string; tool: string; at: string; text: string; chars: number; cut: boolean } | { tab_id: string; text: null; note: string }> {
  const { tab } = await ctx.scoped.tab(input.tab_id);
  const answer = await ctx.repos.tabs.readLastAnswer(tab.id);
  if (!answer) return { tab_id: tab.id, text: null, note: NO_ANSWER_NOTE };
  return { tab_id: tab.id, tool: answer.tool, at: answer.at, text: answer.text, chars: answer.text.length, cut: answer.text.length === LAST_ANSWER_MAX && answer.text.endsWith('…') };
}
```

`readScreen`'s return type gains `note?: string`, and both of its returns add `...(fullScreen(tab) ? { note: FULL_SCREEN_NOTE } : {})`. Import `LAST_ANSWER_MAX` too.

Run: `npm test -w @termhub/server -- src/control/screen.test.ts`
Expected: PASS.

- [ ] **Step 3: Register the tool and tell the concierge**

In `apps/server/src/mcp/tools.ts`, right after `read_screen`:

```ts
  {
    name: 'read_last_answer',
    description:
      "Read the last whole answer the agent in a tab gave (Claude Code, Codex or Cursor), as its hooks delivered it, with the tool and when it arrived. Use it for a long answer: read_screen shows only what is on the screen, and these agents keep nothing above it. It reads nothing from the terminal and sends no key. A tab whose hooks never reported an answer says so in note; then use read_screen.",
    scope: 'read', resource: 'terminals', action: 'read',
    input: { tab_id: id },
    run: (ctx, a) => readLastAnswer(ctx, a as { tab_id: string }),
  },
```

and `read_screen`'s description gains, at its end: `On a tab running Claude Code, Codex or Cursor the answer carries a note: what left the top of the screen is not in the history; use read_last_answer for the agent's last answer in full.`

In `apps/server/src/chat/gate.ts`, `readTools` gains `'read_last_answer'` after `'read_screen'`. In `apps/server/src/mcp/route.test.ts`, the exact list gains it in sorted place; in `apps/server/src/chat/gate.test.ts`, an explicit case. The token of a tab does not get it.

In `apps/server/src/chat/project-prompt.ts`, the tail gains, after the sentence on `read_screen`'s dimmed text, the sentence of the Global Constraints. In `project-prompt.test.ts`, assert it is there and the prompt stays within 4000 in the long case.

In `README.md`, the paragraph "Tools available today": after `read_screen`, `read_last_answer` ("the agent's last whole answer of a tab, as its hooks delivered it; `read_screen` says when to use it").

Run: `npm test -w @termhub/server -- src/control src/mcp src/chat && npm run typecheck -w @termhub/server`
Expected: PASS, except the known failures.

- [ ] **Step 4: Update the roadmap**

In `docs/superpowers/plans/2026-09-29-chat-and-machine-agent-roadmap.md`, Front 6: tick its items, name this plan and its spec, and record what was left out (the transcript).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src README.md docs/superpowers/plans/2026-09-29-chat-and-machine-agent-roadmap.md
git commit -m "Concierge: read the agent's last answer in full" -m "read_screen cannot bring back what left the top of a full-screen agent, and the only ways out touched the person's terminal. read_last_answer answers the whole answer the hooks delivered, and read_screen points to it."
```
