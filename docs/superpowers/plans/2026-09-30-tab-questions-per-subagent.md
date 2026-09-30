# Tab Questions Per Subagent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Answering a subagent's permission in the terminal closes that subagent's card, and no card can ever answer another subagent's dialog.

**Architecture:** The hook script forwards the subagent's `agent_id` and a hint of the tool's input; the server stores the id on the card and closes cards per agent; the live check requires the tool's title and the hint on screen. The queue rule is unchanged.

**Tech Stack:** POSIX sh (the hook script, in `packages/machine-ops`), Fastify, Prisma (one migration), zod, vitest; React (web) and Expo (phone) for one line of the card.

**Spec:** `docs/superpowers/specs/2026-09-30-tab-questions-per-subagent-design.md`. Read it before any task: sections 2, 3, 4 and 5 are the rules, the measurements and the shapes.

## Global Constraints

- Code comments, identifiers, commit messages and pull request texts in English; UI copy in pt-BR.
- Commit subject: imperative, at most 72 characters, prefixed by the area (`Hooks:`, `Monitor:`, `Chat:`, `Web:`, `Mobile:`, `Docs:`). A short body says why.
- Terminal content is never logged: `agent_id` may be logged; the hint never is.
- Routes never import Prisma. Every input is validated with zod.
- The migration adds a nullable column and an index only.
- The hint, verbatim rules: the first 60 characters of `tool_input.command`, else of `tool_input.file_path`, else nothing; only `A-Za-z0-9 ._/=-` kept, other characters dropped; cut at the first `"` of the payload after the key, a trailing `\` dropped; sent only when at least one character is left.
- `agent_id` is forwarded only when it is 1 to 64 characters of `A-Za-z0-9_-`.
- Closing scope (spec §5): null for an event that opens a question, a `Notification`, a `PermissionRequest`, or an event with `subagent: true` and no `agent_id`; `'all'` for `SessionEnd`; `{ agent: id }` for an event with `agent_id`; `{ agent: null }` for any other event.
- The old script (no `agent_id`) keeps today's behaviour in every path.
- `@termhub/agent` is published by CI when its version changes: bump `apps/agent/package.json` and `apps/agent/src/version.ts` together, never run `npm publish`.
- In a pull request or commit text, never write close, fix or resolve next to an issue number. Cite with `Part of TER-179`.
- One commit per step that says "Commit". Never amend a commit that was already pushed.

### Running things on this machine (hulk, macOS)

```bash
export DATABASE_URL=postgresql://postgres:postgres@localhost:5432/termhub   # only parsed
npm test -w @termhub/machine-ops
npm run build -w @termhub/machine-ops        # the server and the agent import the built package
npm run prisma:generate -w @termhub/server   # after the schema change
npm test -w @termhub/server -- <paths>
npm run typecheck -w @termhub/server
npm test -w @termhub/agent
```

- `grep` and `cat` are aliased in the interactive shell; in scripts use `/usr/bin/grep` and `/bin/cat`. The hook script is POSIX sh: test it with `/bin/sh`, as its tests do.
- No Postgres here: `*.db.test.ts` are skipped without `TERMHUB_DB_TESTS=1`; CI runs them.
- Known failures on this machine, not yours: xlsx and docx tests in `apps/server/src/chat/attachments`, and the codex case of `src/mcp/start-agent.e2e.test.ts`.

---

### Task 1: The hooks name the subagent

**Files:**
- Modify: `packages/machine-ops/src/hooks.ts` (`HOOK_SCRIPT`)
- Test: `packages/machine-ops/src/hook-script.test.ts` (or `hooks.test.ts`, whichever runs the script under `/bin/sh` today)
- Modify: `apps/server/src/monitor/state.ts`, `apps/server/src/chat/tab-question-payload.ts`
- Test: `apps/server/src/monitor/state.test.ts`, `apps/server/src/chat/tab-question-payload.test.ts`
- Modify: `apps/agent/package.json`, `apps/agent/src/version.ts` (patch bump), `package-lock.json` if it records the version

**Interfaces:**
- Produces, for Task 2: `Interpreted.meta.agent_id?: string`; `PermissionPayload.hint?: string`; `parsePermissionTool(name, hint?)`.

- [ ] **Step 1: Write the failing tests of the script**

Read the script's test file first: it runs `HOOK_SCRIPT` under `/bin/sh` with a fake `curl` (or captures the body another way) and a fake `tmux`. Add cases, feeding a Claude payload like the one measured (spec §3):

1. A subagent's `PermissionRequest` for `Bash` with `agent_id: 'ac5724783efd1ee13'` and `tool_input.command: 'touch /tmp/th-f8/a-done && sleep 3'` posts `{"hook_event_name":"PermissionRequest","tool_name":"Bash","subagent":true,"agent_id":"ac5724783efd1ee13","hint":"touch /tmp/th-f8/a-done  sleep 3"}` (the `&&` dropped, two spaces left).
2. A subagent's `PreToolUse` and `PostToolUse` carry `agent_id` and no hint.
3. The main thread's `PermissionRequest` carries the hint and neither `subagent` nor `agent_id`.
4. An `agent_id` with a quote, or 65 characters long, is dropped (no key), `subagent` stays.
5. A command with `"` inside (`echo \"a\" && ls`) gives the hint cut before it, with no trailing backslash: `echo `; a command over 60 characters is cut at 60 before the filter.
6. No command but a `file_path`: the hint is the path. Neither: no `hint` key.
7. A `tool_input` whose command holds the text `"file_path":` does not confuse the extraction (the command wins, being searched first).

Run: `npm test -w @termhub/machine-ops -- hook-script`
Expected: FAIL.

- [ ] **Step 2: Change the script**

In `HOOK_SCRIPT`, right after `SUB` is computed:

```sh
# The subagent's id, as a value (spec 2026-09-30 tab questions per subagent §2): what lets the server
# close one subagent's card and not another's. Only 1–64 characters of A-Za-z0-9_- travel; anything
# else is dropped and the boolean flag alone remains, which the server reads as today.
AGENT=
case "$BEFORE_KIND" in
  *'"agent_id":"'*)
    AGENT=\${BEFORE_KIND#*'"agent_id":"'}
    AGENT=\${AGENT%%'"'*}
    case "$AGENT" in '' | *[!A-Za-z0-9_-]*) AGENT= ;; esac
    [ "\${#AGENT}" -le 64 ] || AGENT=
    ;;
esac
[ -z "$AGENT" ] || SUB="$SUB,\\"agent_id\\":\\"$AGENT\\""
```

(Mind the template literal: the file is a TypeScript template string, so `${` must be written `\${` and backslashes doubled as the surrounding code does.)

In the `PermissionRequest` branch, for Claude only, compute the hint before the reduced body:

```sh
    HINT=
    if [ "$TOOL" = claude ]; then
      case "$EVENT" in
        *'"tool_input":'*)
          INPUT=\${EVENT#*'"tool_input":'}
          case "$INPUT" in
            *'"command":"'*) HINT=\${INPUT#*'"command":"'} ;;
            *'"file_path":"'*) HINT=\${INPUT#*'"file_path":"'} ;;
          esac
          HINT=\${HINT%%'"'*}
          HINT=\${HINT%\\\\}
          HINT=$(printf '%s' "$HINT" | LC_ALL=C cut -c1-60 | LC_ALL=C tr -cd 'A-Za-z0-9 ._/=-')
          ;;
      esac
    fi
```

and the reduced body becomes `{"hook_event_name":"PermissionRequest","tool_name":"%s"%s%s}` with `$SUB` and, when `HINT` is not empty, `,"hint":"$HINT"`. The hint holds only characters that need no JSON escaping. Update the comment of the branch.

Run: `npm test -w @termhub/machine-ops && npm run build -w @termhub/machine-ops`
Expected: PASS.

- [ ] **Step 3: Write the failing tests of the interpreter and the payload**

In `apps/server/src/monitor/state.test.ts`: a subagent's `PreToolUse`, `PostToolUse` and `PermissionRequest` with `agent_id: 'ac5724783efd1ee13'` give `meta.subagent === true` and `meta.agent_id === 'ac5724783efd1ee13'`; the `PermissionRequest` with `hint: 'touch /tmp/th-f8/a-done  sleep 3'` gives `question.payload.hint` equal to it; an event with `subagent: true` and no `agent_id` gives no `meta.agent_id`; the main thread's events give neither; an `agent_id` with a `"` or over 64 characters is ignored; a hint with a character outside the allowed set, or over 60 characters, is ignored (no `hint`).

In `apps/server/src/chat/tab-question-payload.test.ts`: `parsePermissionTool('Bash', 'touch a')` gives `{ tool_name: 'Bash', hint: 'touch a' }`; with a bad hint gives `{ tool_name: 'Bash' }`; with none gives `{ tool_name: 'Bash' }`.

Run: `npm test -w @termhub/server -- src/monitor/state.test.ts src/chat/tab-question-payload.test.ts`
Expected: FAIL.

- [ ] **Step 4: Change the interpreter and the payload**

In `apps/server/src/chat/tab-question-payload.ts`:

```ts
export interface PermissionPayload {
  tool_name: string;
  /** The first characters of the tool's input, as the hook script forwards them (spec 2026-09-30 tab
   *  questions per subagent §2): what the live check finds on screen when two dialogs share a tool. */
  hint?: string;
}
/** The characters the hook script lets through for a hint, checked again here. */
const HINT = z.string().regex(/^[A-Za-z0-9 ._/=-]{1,60}$/);

export function parsePermissionTool(name: unknown, hint?: unknown): PermissionPayload | null {
  const r = TOOL_NAME.safeParse(name);
  if (!r.success) return null;
  const h = HINT.safeParse(hint);
  return h.success ? { tool_name: r.data, hint: h.data } : { tool_name: r.data };
}
```

In `apps/server/src/monitor/state.ts`: `const AGENT_ID = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);` and `agentIdOf(ev)`; `asSubagent(out, ev)` adds `meta.agent_id` when `agentIdOf` accepts it; the Claude `PermissionRequest` case passes `ev.hint` to `parsePermissionTool`. Codex's `PermissionRequest` (whole payload) passes nothing new.

Run: `npm test -w @termhub/server -- src/monitor src/chat/tab-question-payload.test.ts && npm run typecheck -w @termhub/server`
Expected: PASS.

- [ ] **Step 5: Bump the agent**

`apps/agent/package.json` and `apps/agent/src/version.ts`: the next patch version (read the current one; `0.11.0` becomes `0.11.1`). Run `npm install --package-lock-only` at the root if the lock records the workspace version, and `npm test -w @termhub/agent -- version`.

- [ ] **Step 6: Commit**

```bash
git add packages/machine-ops apps/server/src apps/agent package-lock.json
git commit -m "Hooks: name the subagent and hint at its input" -m "The script collapsed a subagent's agent_id into a boolean, so the server could not tell one subagent from another and never let a subagent's event close a card. The reduced bodies now carry the id, and a permission carries the first characters of the command or path, which is what tells two dialogs of the same tool apart on screen."
```

---

### Task 2: Cards close per agent, and answer only their own dialog

**Files:**
- Modify: `apps/server/prisma/schema.prisma`; create `apps/server/prisma/migrations/20260930050000_tab_questions_agent_id/migration.sql`
- Modify: `apps/server/src/db/repositories/tab-questions.ts`
- Test: `apps/server/src/db/repositories/tab-questions.db.test.ts`
- Modify: `apps/server/src/chat/tab-questions.ts` (`closingScope` replaces `closesOpenQuestion`)
- Test: `apps/server/src/chat/tab-questions.test.ts`
- Modify: `apps/server/src/chat/permission-dialog.ts`
- Test: `apps/server/src/chat/permission-dialog.test.ts`
- Test: `apps/server/src/monitor/ingest.test.ts` (the parallel sequence)
- Modify: `apps/server/src/db/repositories/tab-questions-view.ts` and the contract if the view carries the payload (it passes it through)

**Interfaces:**
- Consumes: `meta.agent_id`, `PermissionPayload.hint` of Task 1.
- Produces: `closingScope(next: Interpreted): { agent: string | null } | 'all' | null`; `TabQuestionsRepository.closeForTab(tabId, status, scope = 'all')`; `OpenTabQuestionInput.agent_id`.

- [ ] **Step 1: The schema and the migration**

Model `TabQuestion` gains `agentId String? @map("agent_id")` with the comment "The subagent whose dialog this is (spec 2026-09-30 tab questions per subagent); null for the main thread and for a hook script that predates the id." and `@@index([tabId, agentId])`.

```sql
-- TER-179: which subagent a card belongs to (spec 2026-09-30 tab questions per subagent §2). Nullable:
-- the previous release keeps serving and never names it.
ALTER TABLE "tab_questions" ADD COLUMN "agent_id" TEXT;
CREATE INDEX "tab_questions_tab_id_agent_id_idx" ON "tab_questions"("tab_id", "agent_id");
```

Run: `npm run prisma:generate -w @termhub/server && npm run typecheck -w @termhub/server`
Expected: PASS.

- [ ] **Step 2: Write the failing tests of `closingScope`**

In `apps/server/src/chat/tab-questions.test.ts`, replace the `closesOpenQuestion` table by one for `closingScope`, with these rows: an event carrying `question` → null; `Notification` → null; `PermissionRequest` (any tool) → null; `{ subagent: true }` without id → null; `SessionEnd` → `'all'`; `PostToolUse` with `agent_id: 'A'` → `{ agent: 'A' }`; `SubagentStop` with `agent_id: 'A'` → `{ agent: 'A' }`; `Stop` with `backgroundTasks: 2` and no id → `{ agent: null }`; `PreToolUse` no id → `{ agent: null }`; `Stop` no id → `{ agent: null }`.

Run: `npm test -w @termhub/server -- src/chat/tab-questions.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write `closingScope`**

```ts
/** Which rows a hook event closes (spec 2026-09-30 tab questions per subagent §5). */
export type ClosingScope = { agent: string | null } | 'all' | null;

export function closingScope(next: Interpreted): ClosingScope {
  if (next.question) return null;
  if (next.meta.event === 'Notification' || next.meta.event === 'PermissionRequest') return null;
  if (next.meta.event === 'SessionEnd') return 'all';
  const agent = typeof next.meta.agent_id === 'string' ? next.meta.agent_id : null;
  // An old script flags a subagent without naming it: nothing of it may close anything (spec 2026-09-26 §4.5).
  if (next.meta.subagent === true && agent === null) return null;
  return { agent };
}
```

`noteHookEvent` calls `closeTabQuestions(repos, tab.id, 'answered_in_tab', scope)` when the scope is not null. Keep `closesOpenQuestion` only if something else imports it; otherwise remove it and its tests.

Run: `npm test -w @termhub/server -- src/chat/tab-questions.test.ts`
Expected: PASS, apart from the repository call signature (next step).

- [ ] **Step 4: Write the failing database tests and the repository change**

In `tab-questions.db.test.ts`, with the file's helpers: open a permission card with `agent_id: 'A'`; open a `choice` card of the main thread on another tab (or after closing) as needed; then:

1. `closeForTab(tab, 'answered_in_tab', { agent: 'A' })` closes A's card, leaves a main-thread card of the same tab open, and clears a queue mark.
2. `closeForTab(tab, status, { agent: null })` closes the main thread's card and leaves A's.
3. `closeForTab(tab, status)` (`'all'`) closes both.
4. `open` stores `agent_id` and the mapped row carries it.

In `tab-questions.ts` (repository): `OpenTabQuestionInput` gains `agent_id: string | null`; `open` writes `agentId`; `closeIn(tx, tabId, status, now, scope)` filters `agentId: scope.agent` when the scope is an object (Prisma: `{ agentId: null }` for the main thread); `closeForTab(tabId, status, scope: ClosingScope | 'all' = 'all', now = new Date())` — its pre-check outside the transaction keeps the same filter. `TabQuestion` gains `agent_id: string | null` and `mapQuestion` maps it.

`openTabQuestion` (service) passes `agent_id: typeof next.meta.agent_id === 'string' ? next.meta.agent_id : null` — thread it from `noteHookEvent`, which has `next`.

Run: `npm run typecheck -w @termhub/server && npm test -w @termhub/server -- src/chat src/db`
Expected: PASS (db tests skipped here).

- [ ] **Step 5: The live check**

In `permission-dialog.test.ts`, with the measured dialog of spec §3 as the screen (title line "Bash command · from the general-purpose agent", the command, "Do you want to proceed?", the options, the footer):

1. A's card `{ tool_name: 'Bash', hint: 'touch /tmp/th-f8/a-done  sleep 3' }` passes against A's dialog and fails against B's (`b-done`).
2. A card with no hint passes on the title alone; a card for `Edit` fails against a Bash dialog.
3. The footer and "Do you want" are still required.

In `permission-dialog.ts`, `promptVisible` for a permission row:

```ts
  const payload = row.payload as PermissionPayload;
  const title = payload.tool_name === 'Bash' ? 'Bash command' : payload.tool_name;
  if (!shown.includes(squash('Do you want')) || !shown.includes(squash(title))) return false;
  return payload.hint === undefined || shown.includes(squash(payload.hint));
```

`permissionDialogVisible` keeps calling it with `{ tool_name: '' }`: an empty title squashes to `''`, which every screen includes, so its behaviour is unchanged; say so in its comment.

Run: `npm test -w @termhub/server -- src/chat/permission-dialog.test.ts src/chat/tab-question-answer.test.ts src/chat/gate*`
Expected: PASS.

- [ ] **Step 6: The parallel test**

In `apps/server/src/monitor/ingest.test.ts`, with its harness, feed the sequence of spec §3 as interpreted events (through `ingestHookEvent` with the reduced bodies Task 1's script would post) and assert, with the repository stand-in or spies on `closeForTab` and `open`: A's `PermissionRequest` opens a card with `agent_id` A; B's marks the queue and opens nothing; the main thread's `Stop` calls `closeForTab` with `{ agent: null }` and A's card stays; A's `PostToolUse` calls it with `{ agent: A }`; B's `Notification` calls nothing; `SessionEnd` calls it with `'all'`. If the file works against real repositories only through mocks, assert the calls.

Run: `npm test -w @termhub/server -- src/monitor src/chat src/db src/routes && npm run typecheck -w @termhub/server`
Expected: PASS, except the known failures.

- [ ] **Step 7: Commit**

```bash
git add apps/server/prisma apps/server/src
git commit -m "Chat: a subagent's card closes with its own agent, and answers only its dialog" -m "A subagent's event never closed a card since the first attempt was reverted: with a boolean flag, B's event closed A's card and A's card could approve B's dialog. Cards now carry the agent's id, an event closes its own agent's rows only, the main thread's Stop leaves subagents' cards alone, and the live check requires the tool's title and the input's hint on screen."
```

---

### Task 3: The card shows the hint

**Files:**
- Modify: `packages/mobile-api/src/events.ts` (the permission payload gains `hint: z.string().optional()`), its test
- Modify: `apps/web/src/lib/types.ts` (`TabQuestionPermission` payload), `apps/web/src/components/chat/TabQuestionCard.tsx`, its test
- Modify: `apps/mobile/src/features/chat/view/tab-question-card.tsx`, its test
- Modify: `docs/superpowers/plans/2026-09-29-chat-and-machine-agent-roadmap.md` (Front 8)

- [ ] **Step 1: Contract and screens**

The contract's permission payload accepts `hint` (optional; an older server never sends it). On the web card and on the phone card, under the line that names the tool, one line with the hint in a monospace style when present, nothing otherwise. One test each: the line shows with a hint and is absent without.

Run: `npm run build -w @termhub/mobile-api && npm test -w @termhub/mobile-api && npm test -w @termhub/web -- src/components/chat/TabQuestionCard && npm run typecheck -w @termhub/web && npm test -w @termhub/mobile -- tab-question-card && npm run typecheck -w @termhub/mobile`
Expected: PASS.

- [ ] **Step 2: Roadmap and commit**

Front 8 of the roadmap: tick its items, name this plan and its spec, record what was left out (cards for queued dialogs).

```bash
git add packages/mobile-api apps/web/src apps/mobile/src docs/superpowers/plans/2026-09-29-chat-and-machine-agent-roadmap.md
git commit -m "Web, Mobile: the permission card shows what it approves" -m "With two subagents asking for the same tool, the tool's name alone does not say which dialog a card is for. The hint the hooks forward is shown under it."
```
