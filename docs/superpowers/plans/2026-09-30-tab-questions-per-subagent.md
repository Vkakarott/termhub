# Tab Questions Per Subagent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Answering a subagent's permission in the terminal closes that subagent's card on its next event, the main thread no longer closes a running subagent's card, and one agent's event can never end a queue another agent is still in.

**Architecture:** The hook script forwards the subagent's `agent_id` and its `SubagentStop`; the server stores the id on the card, closes cards per agent and keeps the agents of a permission queue on its mark. The live check refuses a card when the dialog on screen is another tool's.

**Tech Stack:** POSIX sh (the hook script, a TypeScript template string in `packages/machine-ops`), Fastify, Prisma (one migration), zod, vitest.

**Spec:** `docs/superpowers/specs/2026-09-30-tab-questions-per-subagent-design.md`. Read it before any task: section 2 is the decisions, 3 the measurements, 4 the shapes, 5 the rules, 6 the tests.

## Global Constraints

- Code comments, identifiers, commit messages and pull request texts in English; UI copy in pt-BR (none changes here).
- Commit subject: imperative, at most 72 characters, prefixed by the area (`Hooks:`, `Monitor:`, `Chat:`, `Docs:`). A short body says why. End the message with the attribution line your own session's instructions give.
- Terminal content is never logged, and a tool's input never leaves the machine: the reduced bodies carry names and ids only. `agent_id` may be logged.
- `agent_id` is forwarded only for Claude Code, and only when it is 1 to 64 characters of `A-Za-z0-9_-`.
- Routes never import Prisma. Every input is validated.
- The migration adds two columns only, both safe for the previous release (nullable, or with a default).
- An old script (no `agent_id`) keeps today's behaviour on every path: its subagent events close nothing, its main-thread events close the rows with no agent, which are all of them.
- `@termhub/agent` is published by CI when its version changes: bump `apps/agent/package.json` and `apps/agent/src/version.ts` together, never run `npm publish`.
- In a pull request or commit text, never write close, fix or resolve next to an issue number. Cite with `Part of TER-179`.
- One commit per step that says "Commit". Never amend a commit that was already pushed. Never push: the controller does.
- Do not dispatch subagents. Do not touch files outside the task's list without saying why in the report.

### Running things on this machine (hulk, macOS)

```bash
export DATABASE_URL=postgresql://postgres:postgres@localhost:5432/termhub   # only parsed
npm test -w @termhub/machine-ops
npm run build -w @termhub/machine-ops        # the server and the agent import the built package
npm run prisma:generate -w @termhub/server   # after the schema change
npm test -w @termhub/server -- <paths>
npm run typecheck -w @termhub/server
npm test -w @termhub/agent -- version   # never the agent's whole suite on this machine: CI runs it
```

- `grep` and `cat` are aliased in the interactive shell; in scripts use `/usr/bin/grep` and `/bin/cat`. The hook script is POSIX sh: its tests run it under `/bin/sh`.
- No Postgres here: `*.db.test.ts` are skipped without `TERMHUB_DB_TESTS=1`; the controller runs them on another machine and CI runs them too. Write them carefully: you cannot run them.
- Known failures on this machine, not yours: xlsx and docx tests in `apps/server/src/chat/attachments`, and the codex case of `src/mcp/start-agent.e2e.test.ts`.

---

### Task 1: The hooks name the subagent and report its end

**Files:**
- Modify: `packages/machine-ops/src/hooks.ts` (`CLAUDE_HOOK_EVENTS`, `HOOK_SCRIPT`, their comments)
- Test: `packages/machine-ops/src/hook-script.test.ts`, `packages/machine-ops/src/hooks.test.ts`
- Modify: `apps/server/src/monitor/state.ts`, `apps/server/src/monitor/ingest.ts`
- Test: `apps/server/src/monitor/state.test.ts`, `apps/server/src/monitor/ingest.test.ts`, `apps/server/src/routes/hooks.test.ts`
- Modify: `apps/agent/package.json`, `apps/agent/src/version.ts` (patch bump), `package-lock.json` if it records the version; any agent test that pins the list of Claude events
- Modify: `README.md` or a doc only if it lists the Claude hook events (search for `StopFailure`)

**Interfaces:**
- Produces, for Task 2: `Interpreted.meta.agent_id?: string` (Claude only), `Interpreted.closeOnly?: true`, and the fact that a `closeOnly` event reaches `noteHookEvent(repos, log, tab, interpreted, waker)`.

- [ ] **Step 1: Write the failing tests of the script**

Read `hook-script.test.ts` first: it runs `HOOK_SCRIPT` under `/bin/sh` with stand-ins for `curl` and `tmux` and reads the posted body. Feed Claude payloads shaped like the measured ones (spec §3): the keys before `hook_event_name` are `session_id`, `transcript_path`, `cwd`, `prompt_id`, `permission_mode`, then `agent_id` and `agent_type` for a subagent. Cases:

1. A subagent's `PreToolUse` for `Bash` with `agent_id: 'ac5724783efd1ee13'` posts `{"hook_event_name":"PreToolUse","tool_name":"Bash","subagent":true,"agent_id":"ac5724783efd1ee13"}` (with `"verb"` before `"subagent"` when the fake screen has a spinner).
2. A subagent's `PermissionRequest` posts `{"hook_event_name":"PermissionRequest","tool_name":"Bash","subagent":true,"agent_id":"ac5724783efd1ee13"}`.
3. The main thread's `PreToolUse` and `PermissionRequest` carry neither `subagent` nor `agent_id`, byte for byte as today.
4. An `agent_id` of 65 characters, or one holding a character outside `A-Za-z0-9_-` (use `a.b`), is dropped: the body carries `"subagent":true` and no `agent_id`.
5. With `codex` as the tool, a payload with `agent_id` before `hook_event_name` posts `"subagent":true` and no `agent_id`.
6. `SubagentStop` with `agent_id` and a `last_assistant_message` posts exactly `{"hook_event_name":"SubagentStop","subagent":true,"agent_id":"ac5724783efd1ee13"}`; the posted body does not contain the message's text.
7. `SubagentStop` whose id was dropped (case 4's ids), or with none, posts nothing.
8. The marker: agent A's `PreToolUse Bash`, then agent B's `PreToolUse Bash`, then A's again: three posts. A's twice in a row: one post. The main thread's twice in a row: one post, and its marker file holds the same text as today (`Bash`, or `Bash <verb>`).
9. A Claude `PermissionRequest` removes the marker: A's `PreToolUse Bash`, A's `PermissionRequest Bash`, A's `PreToolUse Bash` again: three posts. The same for the main thread.

In `hooks.test.ts`: `mergeClaudeSettings('', script)` installs `SubagentStop` with no matcher (the existing key comparison against `CLAUDE_HOOK_EVENTS` covers the presence; add the matcher assertion).

Run: `npm test -w @termhub/machine-ops`
Expected: FAIL on the new cases.

- [ ] **Step 2: Change the script**

`CLAUDE_HOOK_EVENTS` gains `'SubagentStop'` (not in `CLAUDE_TOOL_EVENTS`). Its doc comment gains: "`SubagentStop` is taken for the subagent's id only (spec 2026-09-30 tab questions per subagent): it is what closes the card of a subagent that ends after its dialog."

In `HOOK_SCRIPT` (a template string: write `\${` for a shell `${`, and double every backslash, as the surrounding lines do), right after `SUB` is computed:

```sh
# The subagent's id, as a value (spec 2026-09-30 tab questions per subagent §2): what lets the server
# close one subagent's card and not another's. Claude only. The id is the first "agent_id" of that
# same prefix; only 1 to 64 characters of A-Za-z0-9_- travel — anything else is dropped and the flag
# alone remains, which the server reads as it always did.
AGENT=
if [ "$TOOL" = claude ] && [ -n "$SUB" ]; then
  AGENT=\${BEFORE_KIND#*'"agent_id":"'}
  [ "$AGENT" != "$BEFORE_KIND" ] || AGENT=
  AGENT=\${AGENT%%'"'*}
  case "$AGENT" in *[!A-Za-z0-9_-]*) AGENT= ;; esac
  [ "\${#AGENT}" -le 64 ] || AGENT=
  [ -z "$AGENT" ] || SUB="$SUB,\\"agent_id\\":\\"$AGENT\\""
fi
```

The marker's key, where `KEY` is set: `KEY="\${AGENT:+$AGENT:}$NAME\${VERB:+ $VERB}"`. Update the comment above `MARK` ("The dedupe marker ignores it" no longer holds: say the key carries the subagent's id, so one agent's tool call never swallows another's).

A new branch of the `case "$KIND"`, before the `SessionStart | UserPromptSubmit | Notification` one:

```sh
  SubagentStop)
    # Claude only. A subagent ended: only its id travels (its payload carries the subagent's last
    # message), and only when there is one — the server uses it to close that subagent's card and
    # nothing else (spec 2026-09-30 tab questions per subagent §2).
    [ -n "$AGENT" ] || exit 0
    EVENT=$(printf '{"hook_event_name":"SubagentStop"%s}' "$SUB")
    ;;
```

In the `PermissionRequest` branch, Claude's side gains `rm -f "$MARK"` before its reduced body, as Codex's side has, with a comment: the tool call after an answered dialog is what closes its card, and must never be deduped against the call before the dialog.

Rewrite the comment block above `BEFORE_KIND` so it no longer says the server never lets a subagent's event close a card: it now says the reduced bodies carry the flag and, for Claude, the id.

Run: `npm test -w @termhub/machine-ops && npm run build -w @termhub/machine-ops`
Expected: PASS.

- [ ] **Step 3: Write the failing tests of the interpreter and the ingest**

`apps/server/src/monitor/state.test.ts`:
- a Claude `PreToolUse` and a `PermissionRequest` with `subagent: true, agent_id: 'ac5724783efd1ee13'` give `meta.subagent === true` and `meta.agent_id === 'ac5724783efd1ee13'`;
- a whole AskUserQuestion `PreToolUse` with its own `agent_id` gives `meta.agent_id` and still carries `question`;
- `subagent: true` with no `agent_id`, and an `agent_id` of `'a.b'` or 65 characters, give `meta.subagent === true` and no `agent_id` key;
- the main thread's events give neither key;
- a Codex event with `agent_id` gives `meta.subagent === true` and no `meta.agent_id`;
- `{ hook_event_name: 'SubagentStop', subagent: true, agent_id: 'ac5724783efd1ee13' }` gives `{ kind: 'working', text: null, closeOnly: true, meta: { event: 'SubagentStop', subagent: true, agent_id: 'ac5724783efd1ee13' } }`;
- `SubagentStop` with no usable id is null. The existing assertion at "returns null for unknown events and non-objects" uses a bare `SubagentStop`, which stays null: keep it, and add an unknown name such as `PostToolBatch`.

`apps/server/src/monitor/ingest.test.ts` (it mocks `../chat/tab-questions.js` and `../chat/tab-suggestions.js`): for a Claude `SubagentStop` with an id, `recordEvent` and `setActivity` are not called, `cancelTabSuggestion` is not called, `noteHookEvent` is called once with the tab as found and the interpreted event, and the result is `{ ok: true, tab }`.

`apps/server/src/routes/hooks.test.ts`: the existing "ignored" case keeps its bare `SubagentStop` (no id: still ignored). Add nothing else there.

Run: `npm test -w @termhub/server -- src/monitor`
Expected: FAIL.

- [ ] **Step 4: Change the interpreter and the ingest**

`apps/server/src/monitor/state.ts`:

```ts
// Interpreted gains
  /**
   * The event says nothing about the tab's state: it only runs the card bookkeeping (Claude's
   * `SubagentStop`, which closes that subagent's card; spec 2026-09-30 tab questions per subagent).
   * The ingest records nothing for it.
   */
  closeOnly?: true;

/** A subagent's id as the hook script forwards it, checked again here. */
const AGENT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const agentIdOf = (ev: Record<string, unknown>): string | null => {
  const id = str(ev.agent_id);
  return id !== null && AGENT_ID.test(id) ? id : null;
};
```

In `interpretClaudeEvent`, a case before `default`:

```ts
    case 'SubagentStop':
      // Reduced to the subagent's id on the machine. No state: the tab is wherever its main thread is.
      return agentIdOf(ev) === null ? null : { kind: 'working', text: null, meta: { event: name }, closeOnly: true };
```

`interpretClaude`:

```ts
function interpretClaude(ev: Record<string, unknown>): Interpreted | null {
  const out = interpretClaudeEvent(ev);
  if (!out || !isSubagent(ev)) return out;
  const sub = asSubagent(out);
  const id = agentIdOf(ev);
  return id === null ? sub : { ...sub, meta: { ...sub.meta, agent_id: id } };
}
```

Codex's path (`asSubagent` at its own call site) is untouched. Update the doc comment of `isSubagent`/`asSubagent` to say Claude's events also carry the id in `meta.agent_id`.

`apps/server/src/monitor/ingest.ts`, in `ingestHookEvent`: interpret before the suggestion cancel, and leave early for a close-only event.

```ts
  const interpreted = interpretHookEvent(input.tool, input.event);
  // A subagent ended (spec 2026-09-30 tab questions per subagent §5): the tab's screen and state are
  // its main thread's, so nothing is recorded and a suggestion check still waiting is left alone.
  if (interpreted?.closeOnly) {
    await noteHookEvent(repos, log, tab, interpreted, waker);
    return { ok: true, tab };
  }
  cancelTabSuggestion(tab.id);
```

The rest of the function follows as it is (it no longer calls `interpretHookEvent` a second time).

Run: `npm test -w @termhub/server -- src/monitor src/routes/hooks.test.ts && npm run typecheck -w @termhub/server`
Expected: PASS.

- [ ] **Step 5: Bump the agent**

`apps/agent/package.json` and `apps/agent/src/version.ts`: the next patch version (`0.11.0` becomes `0.11.1`; read the current one). If `package-lock.json` records the workspace's version, run `npm install --package-lock-only` at the root and check the diff touches that version only. Search the agent's tests for a pinned list of Claude events or a pinned version and update them.

Run: `npm test -w @termhub/agent -- version`, plus by path the one test file that pins the Claude events if the search found one, and the agent's typecheck script if it has one. Never the agent's whole suite on this machine (it has killed the local agent before); CI runs it.
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/machine-ops apps/server/src apps/agent package-lock.json
git commit -m "Hooks: name the subagent and report its end" -m "The script collapsed a subagent's agent_id into a boolean, so the server could not tell one subagent from another and never let a subagent's event close a card. Claude's reduced bodies now carry the id, the dedupe marker is per agent, and SubagentStop is forwarded as its id alone. The server reads both and does nothing with them yet.

Part of TER-179."
```

---

### Task 2: Cards close per agent, and a queue ends when its agents left

**Files:**
- Modify: `apps/server/prisma/schema.prisma`; create `apps/server/prisma/migrations/20260930050000_tab_questions_agent/migration.sql`
- Modify: `apps/server/src/db/repositories/tab-questions.ts`
- Test: `apps/server/src/db/repositories/tab-questions.db.test.ts`
- Modify: `apps/server/src/chat/tab-questions.ts` (`closingScope` replaces `closesOpenQuestion`; `closeTabQuestions`; `openTabQuestion`; `noteHookEvent`)
- Test: `apps/server/src/chat/tab-questions.test.ts`
- Modify: comments elsewhere that say a subagent's event never closes a card (search for `4.5` and `never lets a subagent`)

**Interfaces:**
- Consumes: `meta.agent_id`, `closeOnly` of Task 1.
- Produces: `CloseScope`, `closeForTab(tabId, status, scope = 'all', now = new Date())`, `closingScope(next)`, `closeTabQuestions(repos, tabId, status, scope = 'all')`.

- [ ] **Step 1: The schema and the migration**

Model `TabQuestion` gains, after `errorCode`:

```prisma
  /// The subagent whose dialog this is (spec 2026-09-30 tab questions per subagent); null for the main
  /// thread, for Codex and Cursor, and for a hook script that predates the id.
  agentId        String?          @map("agent_id")
  /// On a row marked `QUEUED`: the agents in that permission queue ('' is the main thread). The queue
  /// ends when the list is empty. A mark of the previous release has none and ends on the first close.
  queueAgents    String[]         @default([]) @map("queue_agents")
```

```sql
-- TER-179: which subagent a card belongs to, and which agents are in a permission queue (spec
-- 2026-09-30 tab questions per subagent §2). The previous release keeps serving and names neither.
ALTER TABLE "tab_questions"
  ADD COLUMN "agent_id" TEXT,
  ADD COLUMN "queue_agents" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
```

Run: `npm run prisma:generate -w @termhub/server && npm run typecheck -w @termhub/server`
Expected: PASS. Compare the SQL with how an earlier migration of this repository wrote a `TEXT[]` column with a default (search the migrations for `TEXT[]`), and follow it.

- [ ] **Step 2: Write the failing tests of `closingScope`**

In `apps/server/src/chat/tab-questions.test.ts`, replace the `closesOpenQuestion` cases by a table for `closingScope` (build each `Interpreted` by hand):

| Event | Expected |
|---|---|
| any event with `question` | `null` |
| `Notification` | `null` |
| `PermissionRequest`, tool `AskUserQuestion` | `null` |
| `PreToolUse`, `meta.subagent: true`, no `agent_id` | `null` |
| `PreToolUse`, `meta.subagent: true`, `agent_id: 'A'` | `{ agent: 'A', leavesQueue: false }` |
| `SubagentStop`, `closeOnly`, `agent_id: 'A'` | `{ agent: 'A', leavesQueue: true }` |
| `PermissionRequest`, tool `ExitPlanMode`, `agent_id: 'A'`, no question | `{ agent: 'A', leavesQueue: false }` |
| `PermissionRequest`, tool `ExitPlanMode`, main thread | `{ agent: null, leavesQueue: true }` |
| `PreToolUse`, main thread | `{ agent: null, leavesQueue: true }` |
| `Stop` with `backgroundTasks: 2` | `{ agent: null, leavesQueue: true }` |
| `StopFailure` | `{ agent: null, leavesQueue: true }` |
| `Stop` with no `backgroundTasks` | `'all'` |
| `UserPromptSubmit` | `{ agent: null, leavesQueue: true }` |
| `SessionEnd` | `'all'` |
| Codex `agent-turn-complete` (no agent) | `{ agent: null, leavesQueue: true }` |

Then the measured sequence (spec §3) through `noteHookEvent`, with the file's repository stand-in (it already spies on `closeForTab` and `open`): for each event in order assert the call it makes.

| Event | Call |
|---|---|
| main `PreToolUse` Agent | `closeForTab(tab, 'answered_in_tab', { agent: null, leavesQueue: true })` |
| main `Stop`, 2 background tasks | `closeForTab(…, { agent: null, leavesQueue: true })` |
| A `PreToolUse` Bash | `closeForTab(…, { agent: 'A', leavesQueue: false })` |
| A `PermissionRequest` Bash | `open` with `agent_id: 'A'` |
| B `PreToolUse` Bash | `closeForTab(…, { agent: 'B', leavesQueue: false })` |
| B `PermissionRequest` Bash | `open` with `agent_id: 'B'` |
| helper `SubagentStop`, id `H` | `closeForTab(…, { agent: 'H', leavesQueue: true })` |
| `Notification` permission_prompt | nothing |
| A `SubagentStop` | `closeForTab(…, { agent: 'A', leavesQueue: true })` |
| main `Stop`, 1 background task | `closeForTab(…, { agent: null, leavesQueue: true })` |
| B `SubagentStop` | `closeForTab(…, { agent: 'B', leavesQueue: true })` |
| main `Stop`, none | `closeForTab(…, 'all')` |

Two existing assertions in this file call `closeForTab` with exact arguments (search `toHaveBeenCalledWith('t1'`): update them for the third argument.

Run: `npm test -w @termhub/server -- src/chat/tab-questions.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write `closingScope` and thread the scope and the agent**

`apps/server/src/db/repositories/tab-questions.ts` (types only in this step):

```ts
/**
 * Which rows a close reaches: one agent's (null is the main thread), or every row of the tab.
 * `leavesQueue`: the agent has no dialog pending any more, so it also leaves the tab's permission queue.
 */
export type CloseScope = { agent: string | null; leavesQueue: boolean } | 'all';
```

`OpenTabQuestionInput` gains `/** The subagent that asked, or null for the main thread. */ agent_id: string | null;`.

`apps/server/src/chat/tab-questions.ts`:

```ts
/**
 * Which rows a hook event closes, or null when it closes nothing (spec 2026-09-30 tab questions per
 * subagent §5). An event closes its own agent's rows: a subagent's next tool call or its end closes that
 * subagent's card and nobody else's, and the main thread's events leave a running subagent's card alone.
 * Two main-thread events close every row, being proof that nothing runs: a session end, and a Stop with
 * nothing left in the background. A subagent leaves the permission queue only when it ends: a tool call of
 * its own may be a parallel call's, landing while its dialog is still pending.
 * What never closes: an event that opens a question (it closes the previous one itself, `open`); a
 * `Notification`, which only says the tab is still waiting; AskUserQuestion's own `PermissionRequest`, the
 * question's companion; and a subagent's event from a script that does not name it (spec 2026-09-26 §4.5).
 */
export function closingScope(next: Interpreted): CloseScope | null {
  if (next.question) return null;
  const event = next.meta.event;
  if (event === 'Notification') return null;
  if (event === 'PermissionRequest' && next.meta.tool === 'AskUserQuestion') return null;
  if (next.meta.subagent === true) {
    return typeof next.meta.agent_id === 'string' ? { agent: next.meta.agent_id, leavesQueue: event === 'SubagentStop' } : null;
  }
  if (event === 'SessionEnd') return 'all';
  if (event === 'Stop' && !next.backgroundTasks) return 'all';
  return { agent: null, leavesQueue: true };
}
```

`closeTabQuestions(repos, tabId, status, scope: CloseScope = 'all')` passes the scope on. `noteHookEvent` asks `closingScope(next)` and closes when it is not null. `openTabQuestion` takes the agent in its `deps` (`agentId?: string | null`, default null) and passes `agent_id` to `repos.tabQuestions.open`; `noteHookEvent` gives it `typeof next.meta.agent_id === 'string' ? next.meta.agent_id : null`. Every other caller of `open` (search `tabQuestions.open(`, the suggestion path included) passes `agent_id: null`. Remove `closesOpenQuestion` (search for other importers first).

Run: `npm test -w @termhub/server -- src/chat/tab-questions.test.ts`
Expected: PASS. The typecheck passes after Step 5.

- [ ] **Step 4: Write the database tests**

In `apps/server/src/db/repositories/tab-questions.db.test.ts`, with the file's own helpers (a tab, a conversation, `open`):

Below, `tool(X)` is `{ agent: X, leavesQueue: false }` (a subagent's tool call), `ended(X)` is `{ agent: X, leavesQueue: true }` and `main` is `{ agent: null, leavesQueue: true }`.

1. **Scoped close.** Open a permission card for agent `A` on tab 1 and a choice card of the main thread on tab 2 of the same project. On tab 1, `main` closes nothing; `tool('B')` closes nothing; `tool('A')` closes A's card with status `answered_in_tab`. On tab 2, `tool('A')` closes nothing and `main` closes the choice.
2. **The queue with two agents.** Open A's permission (a card). Open B's permission: no card, A's card is closed, and the marked row's `queue_agents` is `['A', 'B']` (read the row with the test's Prisma client). `tool('A')` and `tool('B')`: the mark and the list stay. `ended('A')`: the mark stays, the list is `['B']`. A permission of a new agent `C`: no card (still queued), the list is `['B', 'C']`. `main`: nothing changes. `ended('B')` then `ended('C')`: the mark is cleared and the list empty. A permission now opens a card.
3. **`'all'` ends it at once.** Case 2 up to the queue, then `closeForTab(tab, 'answered_in_tab')`: mark cleared, list empty.
4. **The main thread's own queue.** Two main-thread permissions: the list is `['']`. `main` clears it, as today.
5. **A mark of the previous release.** Set `error_code = 'QUEUED'` on a closed permission row with an empty list by hand; `tool('A')` leaves it, `ended('A')` clears it (so does `main`, in a second copy of the case).
6. **A choice ends the queue.** Case 2 up to the queue, then a choice opens: the card opens, and no row of the tab keeps the mark or a list.
7. **`open` stores the agent.** The created row's `agent_id` is `'A'`; a main-thread one's is null.

- [ ] **Step 5: The repository**

```ts
const queueKey = (agent: string | null): string => agent ?? '';
```

- `closeIn(tx, tabId, status, now, scope: CloseScope = 'all')`: the first `findMany` gains `...(scope === 'all' ? {} : { agentId: scope.agent })`.
- `open`: the `newest` select gains `agentId` and `queueAgents`. When the newest row is an open permission: `data: { errorCode: PERMISSION_QUEUED, queueAgents: [...new Set([queueKey(newest.agentId), queueKey(input.agent_id)])] }`. When it is already marked: add `queueKey(input.agent_id)` when absent (one `update`, only then). `create` writes `agentId: input.agent_id`. The `closeIn` call in `open` keeps the scope `'all'`. A choice clears the mark and `queueAgents` of every row of the tab, in the path with a conversation too (today only the no-conversation path clears the mark): move that `updateMany` above the branch.
- `closeForTab(tabId, status, scope: CloseScope = 'all', now = new Date())`. Check every caller that passes `now` as the third argument (search `closeForTab(`, tests included). The pre-check outside the transaction keeps its shape, with the agent filter on its first branch when the scope is an agent, and its second branch (a marked row) only when the scope is `'all'` or `leavesQueue`. Inside the transaction, after `closeIn(tx, tabId, status, now, scope)`:

```ts
      if (scope === 'all') {
        await tx.tabQuestion.updateMany({ where: { tabId, errorCode: PERMISSION_QUEUED }, data: { errorCode: null, queueAgents: [] } });
      } else if (scope.leavesQueue) {
        // The queue ends when every agent in it has left (spec 2026-09-30 tab questions per subagent §5):
        // one agent's close must not end a queue another agent's dialog is still in.
        const marked = await tx.tabQuestion.findMany({ where: { tabId, errorCode: PERMISSION_QUEUED }, select: { id: true, queueAgents: true } });
        for (const row of marked) {
          const left = row.queueAgents.filter((a) => a !== queueKey(scope.agent));
          await tx.tabQuestion.update({ where: { id: row.id }, data: left.length === 0 ? { errorCode: null, queueAgents: [] } : { queueAgents: left } });
        }
      }
```

Rewrite the doc comments of `open`, `closeForTab` and `PERMISSION_QUEUED` to say what is now true (the queue's members, the scoped close). `TabQuestion` (the mapped type) does not gain the columns: nothing outside the repository reads them.

Run: `npm run typecheck -w @termhub/server && npm test -w @termhub/server -- src/chat src/db src/monitor src/routes`
Expected: PASS, except the known failures (the db tests are skipped here).

- [ ] **Step 6: Commit**

```bash
git add apps/server/prisma apps/server/src
git commit -m "Chat: a subagent's card closes with its own agent" -m "A subagent's event never closed a card since the first attempt was reverted: with a boolean flag, B's event closed A's card and ended the queue A was in. Cards now carry the agent's id and an event closes its own agent's rows only, so a subagent's next tool call or its end closes its card, and the main thread's Stop with background tasks leaves it alone. A permission queue keeps its members and ends when all of them left.

Part of TER-179."
```

---

### Task 3: A card never answers another tool's dialog

**Files:**
- Modify: `apps/server/src/chat/permission-dialog.ts`
- Test: `apps/server/src/chat/permission-dialog.test.ts`, and a new fixture `apps/server/src/chat/fixtures/permission-dialogs/claude-bash-subagent.txt`
- Modify: `docs/superpowers/plans/2026-09-29-chat-and-machine-agent-roadmap.md` (Front 8); `README.md` if it describes when a subagent's card closes (search `subagent`)

**Interfaces:**
- Produces: `dialogTool(screen: string): string | null`; `promptVisible` keeps its signature.

- [ ] **Step 1: The fixture and the failing tests**

`claude-bash-subagent.txt`, the dialog measured on Claude Code 2.1.285 (spec §3), in the layout of `fixtures/tab-questions/screen-permission.txt`: a transcript line above, a box rule of `─`, ` Bash command · from the general-purpose agent`, the command `   touch /tmp/th-f8/a-done && sleep 3`, its description, ` Do you want to proceed?`, the options (` ❯ 1. Yes`, `   2. Yes, and always allow access to /tmp/th-f8 from this project`, `   3. No`), ` Esc to cancel · Tab to amend`.

In `permission-dialog.test.ts`:

1. `dialogTool`: `screen-permission.txt` → `'Bash'`; `claude-bash-subagent.txt` → `'Bash'`; `claude-edit.txt` → `'Edit'`; `claude-webfetch.txt` → `'WebFetch'`; `claude-skill.txt` → null; a capture with no box rule → null; a rule followed by `Fetching the page…` → null (a title is the whole line, or is followed by a space); a capture with a rule and ` Edit file` in the transcript above a Skill dialog's own rule → null (only the lowest rule is read).
2. `promptVisible` for a permission row: a `Bash` card passes on both Bash fixtures and is refused on the Edit and WebFetch ones; an `Edit` card passes on the Edit fixture and is refused on the Bash one; a `Skill` card is refused on the Bash fixture, and on a screen with no known title it answers what today's rule answers; a `Bash` card on a Bash dialog with its box rule cut off the top of the capture passes (as today).
3. `permissionDialogVisible` answers for every file of `fixtures/permission-dialogs` exactly what it answered before the change: the test file's existing table must pass untouched.

Some fixtures may lack the footer today's rule needs (`claude-webfetch.txt` ends at its options): where a case needs a full dialog, append the footer line in the test rather than editing a fixture other tests read.

Run: `npm test -w @termhub/server -- src/chat/permission-dialog.test.ts`
Expected: FAIL.

- [ ] **Step 2: The check**

In `permission-dialog.ts` (move `RULE` above its first use if needed):

```ts
/**
 * The first line of Claude Code's permission dialog for the tools whose title is known from a real
 * capture (fixtures/permission-dialogs, and spec 2026-09-30 tab questions per subagent §3), lower-cased.
 * A subagent's dialog adds " · from the <type> agent" after it.
 */
const DIALOG_TITLES: readonly (readonly [title: string, tool: string])[] = [
  ['bash command', 'Bash'],
  ['edit file', 'Edit'],
  ['fetch', 'WebFetch'],
];

/**
 * The tool whose dialog the capture shows, when its title is one the server knows: the line under the
 * lowest box rule. Null for a dialog with another title, and for a capture with no rule. Only that one
 * rule is read: above it is the transcript, where a rule and a line that looks like a title may be
 * anybody's text. Used to refuse a card whose dialog is not the one on screen; never to accept one.
 */
export function dialogTool(screen: string): string | null {
  const lines = screen.split('\n').filter((l) => l.trim() !== '');
  for (let i = lines.length - 2; i >= 0; i--) {
    if (!RULE.test(lines[i]!)) continue;
    const under = lines[i + 1]!.trim().toLowerCase();
    return DIALOG_TITLES.find(([title]) => under === title || under.startsWith(`${title} `))?.[1] ?? null;
  }
  return null;
}
```

`promptVisible`: keep today's body as a private `dialogShown(screen, row)`; `promptVisible` is `dialogShown` and, for a permission row, `dialogTool(screen)` null or equal to the row's `tool_name`. `permissionDialogVisible` calls `dialogShown` (not `promptVisible`), so the gate's rule does not change. Extend the doc comment of `promptVisible`: the check fails open on purpose (a renamed title makes it a no-op, not a refusal of every card).

Run: `npm test -w @termhub/server -- src/chat && npm run typecheck -w @termhub/server`
Expected: PASS, except the known failures.

- [ ] **Step 3: Roadmap, README, commit**

Front 8 of the roadmap: tick its items, name this plan and its spec, and record what was left out (cards for queued dialogs; the hint of the tool's input, a decision for the person). If the README says when a tab's card closes, say it per agent.

```bash
git add apps/server/src docs/superpowers/plans/2026-09-29-chat-and-machine-agent-roadmap.md README.md
git commit -m "Chat: a permission card never answers another tool's dialog" -m "The live check saw the footer and \"Do you want\", which every dialog has. When the capture shows a title the server knows and it is another tool's, the answer is now refused. It fails open: an unknown or renamed title leaves the check as it was.

Part of TER-179."
```
