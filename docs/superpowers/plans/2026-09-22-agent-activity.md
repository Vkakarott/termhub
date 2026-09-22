# Agent Activity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Under each working agent on the office floor, show what it is doing — `codando`, `lendo arquivos`, `pesquisando`, `planejando`, `no terminal` — from the tool name Claude Code reports in its `PreToolUse` hook, which termhub starts installing; only the tool name travels, and only when it changed.

**Architecture:** The shared hook script (`@termhub/machine-ops`, installed by the agent and over ssh) gains a `PreToolUse` entry and, for that event only, cuts the payload down to the tool name and posts only on change, using a marker file per tmux session. The server maps the tool name to one of six categories (a data table), stores it in one nullable column on `Tab` through a light `UPDATE` path (no event row for a mere tool change), and the existing `/ws/monitor` push carries it to the browser. The office model merges it like the other state fields and the desk overlay shows the label in place of the tab name while the person is working.

**Tech Stack:** POSIX sh (hook script), Fastify + Prisma + zod (server), React 18 + PixiJS 8 (web), Vitest.

**Spec:** `docs/superpowers/specs/2026-09-22-agent-activity-design.md`

## Global Constraints

- Code, comments, commit messages and docs in English; **UI copy in Portuguese (pt-BR)**.
- The host has no Node. Run everything through Docker from the repo root:
  `docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/w" -w /w node:20 sh -c '<cmd>'`, then `rm -rf .npm`. Below, `DOCKER '<cmd>'` means exactly that. Never pipe a test/typecheck/build command through `tail`/`head` in a way that hides its exit code.
- After a fresh `npm ci`, the server typecheck needs `npm run prisma:generate && npm run build:packages` first. **After changing `packages/machine-ops`, run `npm run build:packages` before server or agent typecheck/tests** — they consume the built package.
- Address workspaces by package name (`-w @termhub/machine-ops`, `-w @termhub/server`, `-w @termhub/web`, `-w @termhub/agent`), never by path.
- Routes never import Prisma; go through repositories. Every request input validated with zod. Log metadata only — never a tool's input, never terminal content.
- **Privacy rule of this feature:** for a `PreToolUse` event, the server must never receive `tool_input`; the script cuts the event down to `{ hook_event_name, tool_name }` before posting. The server ignores anything else a `PreToolUse` payload might carry.
- The migration is additive (one nullable column + one enum) and backward compatible: the previous container keeps serving during the blue/green switch.
- The agent updates itself and CI publishes it (`.github/workflows/publish-agent.yml`: a bump of `apps/agent/package.json`'s version landing on `main` is the release). Never instruct the person to run npm on a machine.
- PixiJS is imported only under `apps/web/src/office/scene/` and `apps/web/src/office/pack/`.
- Work on branch `feat/agent-activity`, cut from `docs/agent-activity-spec` (origin/main + spec and plan). Do not push to `main`; open a PR at the end.

## Review Focus

1. **A `PreToolUse` payload that carries `tool_input`** (an old script, or a hand-made request) — the server must produce the same result as without it and store/log nothing of it. Pinned in Task 2 (`state.test.ts`).
2. **A tool name that is not a string** (missing, number, object) — `activityOf` returns `working`, the script posts nothing when it cannot extract a name. Pinned in Tasks 1 and 2.
3. **A tab that leaves `working`** (waiting, idle, error) — `activity` must be cleared, so a waiting person never reads `codando`. Pinned in Task 3 (repository DB test) and Task 6 (model).
4. **A tmux session name with characters that are not filename-safe** — the marker file path must not break or escape `/tmp` (`tmux` session names can contain `.` and `-`, and termhub's are `th-<id>`; still, sanitise). Pinned in Task 1.
5. **Two Claude Code sessions in the same tmux session, one after the other** — a stale marker must not swallow the first event of the new session; `SessionStart` and `UserPromptSubmit` reset the marker. Pinned in Task 1.

---

## File Structure

```
packages/machine-ops/src/hooks.ts                 CLAUDE_HOOK_EVENTS + PreToolUse; HOOK_SCRIPT with the tool-name path
packages/machine-ops/src/hooks.test.ts            settings merge covers the sixth event
packages/machine-ops/src/hook-script.test.ts      NEW: runs HOOK_SCRIPT under sh with a fake curl/tmux

apps/server/prisma/schema.prisma                  enum TabActivity; Tab.activity
apps/server/prisma/migrations/<ts>_tab_activity/migration.sql
apps/server/src/db/repositories/types.ts          TabActivity type; Tab.activity; mapTab
apps/server/src/db/repositories/tabs.ts           recordEvent stores activity; clears it off working; + setActivity
apps/server/src/db/repositories/tabs.db.test.ts
apps/server/src/monitor/activity.ts               NEW: TAB_ACTIVITIES, activityOf
apps/server/src/monitor/activity.test.ts          NEW
apps/server/src/monitor/state.ts                  Interpreted.activity; PreToolUse case
apps/server/src/monitor/state.test.ts
apps/server/src/monitor/ingest.ts                 the light path
apps/server/src/monitor/ingest.test.ts            NEW

apps/agent/package.json                           version bump (release)

apps/web/src/lib/types.ts                         TabActivity; Tab.activity
apps/web/src/office/model.ts                      DeskModel.activity; merge; activityLabel
apps/web/src/office/model.test.ts
apps/web/src/office/scene/Overlay.ts              label swap while typing
apps/web/src/office/harness.ts                    ?activity=
```

---

### Task 1: The hook script — `PreToolUse`, tool name only, only on change

**Files:**
- Modify: `packages/machine-ops/src/hooks.ts` (`CLAUDE_HOOK_EVENTS`, `HOOK_SCRIPT`)
- Modify: `packages/machine-ops/src/hooks.test.ts`
- Create: `packages/machine-ops/src/hook-script.test.ts`

**Interfaces:**
- Produces: `CLAUDE_HOOK_EVENTS` includes `'PreToolUse'`; `HOOK_SCRIPT` posts, for `PreToolUse`, the body `{"tool":"claude","session":"<s>","event":{"hook_event_name":"PreToolUse","tool_name":"<name>"}}` and only when `<name>` differs from the last one posted for that session; deletes the marker on `SessionStart`/`UserPromptSubmit`; every other event posted whole as today.

- [ ] **Step 1: Write the failing script test.** `packages/machine-ops/src/hook-script.test.ts` runs the real script under `sh` in a temp `HOME`, with a fake `curl` and a fake `tmux` first on `PATH`, and `TMUX_PANE` set. The fake `curl` appends its stdin (the request body) to a log file; the fake `tmux` prints a fixed session name.

```ts
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HOOK_ENV_REL, HOOK_SCRIPT } from './hooks.js';

let home: string;
let bin: string;
let log: string;
let tmp: string;

/** Runs the script as Claude Code would: event JSON on stdin, `claude` as $1. Returns the bodies curl received. */
function run(event: unknown): string[] {
  execFileSync('sh', [join(bin, 'termhub-hook'), 'claude'], {
    input: JSON.stringify(event),
    env: { HOME: home, PATH: `${bin}:/usr/bin:/bin`, TMUX_PANE: '%1', TMPDIR: tmp },
    timeout: 5000,
  });
  // the script posts in the background: wait for the fake curl to finish
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    /* spin briefly; the fake curl writes synchronously */
    if (existsSync(log)) break;
  }
  return existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'hook-home-'));
  tmp = mkdtempSync(join(tmpdir(), 'hook-tmp-'));
  bin = join(home, 'bin');
  log = join(home, 'curl.log');
  mkdirSync(join(home, '.termhub'), { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(home, HOOK_ENV_REL), `TERMHUB_HOOK_URL='http://x/api/hooks/events'\nTERMHUB_HOOK_TOKEN='thk_test'\n`);
  writeFileSync(join(bin, 'termhub-hook'), HOOK_SCRIPT);
  writeFileSync(join(bin, 'tmux'), `#!/bin/sh\necho th-abc\n`);
  // a synchronous fake: reads the body from stdin (--data-binary @-) and appends it as one line
  writeFileSync(join(bin, 'curl'), `#!/bin/sh\ncat >> "${log}"; printf '\\n' >> "${log}"\n`);
  for (const f of ['termhub-hook', 'tmux', 'curl']) chmodSync(join(bin, f), 0o755);
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(tmp, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('termhub-hook script', () => {
  it('posts a PreToolUse event with the tool name and nothing else', async () => {
    run({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: '/secret', new_string: 'x' }, session_id: 's' });
    await sleep(300);
    const bodies = readFileSync(log, 'utf8').split('\n').filter(Boolean);
    expect(bodies).toHaveLength(1);
    expect(JSON.parse(bodies[0])).toEqual({ tool: 'claude', session: 'th-abc', event: { hook_event_name: 'PreToolUse', tool_name: 'Edit' } });
    expect(bodies[0]).not.toContain('secret');
  });

  it('posts the same tool once and a different tool again', async () => {
    run({ hook_event_name: 'PreToolUse', tool_name: 'Edit' });
    run({ hook_event_name: 'PreToolUse', tool_name: 'Edit' });
    run({ hook_event_name: 'PreToolUse', tool_name: 'Read' });
    await sleep(300);
    const names = readFileSync(log, 'utf8').split('\n').filter(Boolean).map((b) => (JSON.parse(b) as { event: { tool_name: string } }).event.tool_name);
    expect(names).toEqual(['Edit', 'Read']);
  });

  it('resets on UserPromptSubmit and SessionStart, so the first tool of a new turn is sent', async () => {
    run({ hook_event_name: 'PreToolUse', tool_name: 'Edit' });
    run({ hook_event_name: 'UserPromptSubmit', prompt: 'do it' });
    run({ hook_event_name: 'PreToolUse', tool_name: 'Edit' });
    run({ hook_event_name: 'SessionStart' });
    run({ hook_event_name: 'PreToolUse', tool_name: 'Edit' });
    await sleep(300);
    const events = readFileSync(log, 'utf8').split('\n').filter(Boolean).map((b) => (JSON.parse(b) as { event: { hook_event_name: string } }).event.hook_event_name);
    expect(events).toEqual(['PreToolUse', 'UserPromptSubmit', 'PreToolUse', 'SessionStart', 'PreToolUse']);
  });

  it('posts nothing for a PreToolUse without a string tool name', async () => {
    run({ hook_event_name: 'PreToolUse' });
    run({ hook_event_name: 'PreToolUse', tool_name: 42 });
    await sleep(300);
    expect(existsSync(log)).toBe(false);
  });

  it('still posts the other events whole', async () => {
    run({ hook_event_name: 'Stop', last_assistant_message: 'Pronto?' });
    await sleep(300);
    const bodies = readFileSync(log, 'utf8').split('\n').filter(Boolean);
    expect(JSON.parse(bodies[0])).toEqual({ tool: 'claude', session: 'th-abc', event: { hook_event_name: 'Stop', last_assistant_message: 'Pronto?' } });
  });

  it('keeps the marker inside TMPDIR whatever the session name contains', async () => {
    writeFileSync(join(bin, 'tmux'), `#!/bin/sh\necho '../evil name'\n`);
    run({ hook_event_name: 'PreToolUse', tool_name: 'Edit' });
    await sleep(300);
    expect(existsSync(join(tmp, '..', 'evil name'))).toBe(false);
    expect(existsSync(join(home, 'evil name'))).toBe(false);
  });
});
```

Simplify the `run` helper's busy-wait as you see fit (the `sleep(300)` after the calls is what actually waits for the background curl); keep the tests' assertions. If `vitest` in this package has no Node environment quirks, the file needs no pragma (it is a Node test); check `packages/machine-ops/package.json`/vitest config for the environment used by the other tests.

Also extend `packages/machine-ops/src/hooks.test.ts`: the first `mergeClaudeSettings` test already asserts the event set equals `CLAUDE_HOOK_EVENTS` — add an assertion that `'PreToolUse'` is in `CLAUDE_HOOK_EVENTS`, and that when the user already has their own `PreToolUse` entry (the existing "keeps the user's own settings" test has one with matcher `Bash`), ours is ADDED alongside it with `matcher: '*'` and theirs is kept.

- [ ] **Step 2: Run them.** `DOCKER 'npx -w @termhub/machine-ops vitest run'` — Expected: the script tests FAIL (PreToolUse posts the whole payload; no de-dup), and the settings assertion for `PreToolUse` fails.

- [ ] **Step 3: Implement.** In `packages/machine-ops/src/hooks.ts`:

```ts
export const CLAUDE_HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'Notification', 'Stop', 'SessionEnd'] as const;
```

In `mergeClaudeSettings`, give our `PreToolUse` entry `matcher: '*'` (Claude Code requires a matcher for tool events; the others take none):

```ts
    const entry: HookEntry = { hooks: [{ type: 'command', command: `${scriptPath} claude`, timeout: 10 } as { type: string; command: string }] };
    if (event === 'PreToolUse') entry.matcher = '*';
    others.push(entry);
```

Replace the tail of `HOOK_SCRIPT` (from `if [ "$TOOL" = codex ]` to the end) with:

```sh
if [ "$TOOL" = codex ]; then EVENT="$2"; else EVENT=$(cat 2>/dev/null); fi
[ -n "$EVENT" ] || EVENT='{}'
# Tool calls: only the tool's name travels (never its input), and only when it changed since the
# last one for this session — twenty edits in a row are one request. The marker is per tmux
# session, under TMPDIR, with the session name reduced to filename-safe characters.
case "$EVENT" in
  *'"hook_event_name":"PreToolUse"'*|*'"hook_event_name": "PreToolUse"'*)
    NAME=$(printf '%s' "$EVENT" | sed -n 's/.*"tool_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)
    [ -n "$NAME" ] || exit 0
    MARK="${TMPDIR:-/tmp}/termhub-hook-$(printf '%s' "$SESSION" | tr -c 'A-Za-z0-9_-' '_')"
    [ "$(cat "$MARK" 2>/dev/null)" = "$NAME" ] && exit 0
    printf '%s' "$NAME" > "$MARK"
    EVENT=$(printf '{"hook_event_name":"PreToolUse","tool_name":"%s"}' "$NAME")
    ;;
  *'"hook_event_name":"SessionStart"'*|*'"hook_event_name": "SessionStart"'*|*'"hook_event_name":"UserPromptSubmit"'*|*'"hook_event_name": "UserPromptSubmit"'*)
    rm -f "${TMPDIR:-/tmp}/termhub-hook-$(printf '%s' "$SESSION" | tr -c 'A-Za-z0-9_-' '_')"
    ;;
esac
{ printf '{"tool":"%s","session":"%s","event":' "$TOOL" "$SESSION"; printf '%s' "$EVENT"; printf '}'; } |
  curl -s -m 5 -o /dev/null -X POST "$TERMHUB_HOOK_URL" \
    -H "authorization: Bearer $TERMHUB_HOOK_TOKEN" -H 'content-type: application/json' --data-binary @- >/dev/null 2>&1 &
exit 0
```

Mind the template literal: `HOOK_SCRIPT` is a JS template string, so every `\` in the shell must be written `\\` and `${` must not appear unescaped (write `"$\{TMPDIR:-/tmp}"` as `"\${TMPDIR:-/tmp}"`). The existing script already does this for `\\n`. The `sed` extracts the FIRST `"tool_name":"…"` in the payload; a tool name is a bare identifier in Claude Code (letters, digits, `_`), so a quoted string inside `tool_input` cannot precede it (Claude Code serialises `tool_name` before `tool_input`) — state this assumption in a comment. `tr -c 'A-Za-z0-9_-' '_'` maps every other character (including `/`, `.`, spaces) to `_`, so the marker can never leave `TMPDIR`.

- [ ] **Step 4: Run the package tests and build.** `DOCKER 'npx -w @termhub/machine-ops vitest run && npm run build:packages'` — Expected: PASS.

- [ ] **Step 5: Run the consumers' typechecks** (they import the built package): `DOCKER 'npm run typecheck -w @termhub/agent && npm run typecheck -w @termhub/server && npx -w @termhub/agent vitest run src/rpc/hooks.test.ts'` — Expected: PASS (the agent's hook test may assert the event list; if it does, update its expectation to include `PreToolUse`).

- [ ] **Step 6: Commit** — `git commit -m "Hooks: install PreToolUse; post only the tool name, only when it changed"`

---

### Task 2: The category table and the `PreToolUse` interpretation

**Files:**
- Create: `apps/server/src/monitor/activity.ts`, `apps/server/src/monitor/activity.test.ts`
- Modify: `apps/server/src/monitor/state.ts`, `apps/server/src/monitor/state.test.ts`
- Modify: `apps/server/src/db/repositories/types.ts` (the `TabActivity` type only; the column comes in Task 3)

**Interfaces:**
- Produces:

```ts
// types.ts
export type TabActivity = 'coding' | 'reading' | 'researching' | 'planning' | 'terminal' | 'working';
export const TAB_ACTIVITIES: readonly TabActivity[];
// activity.ts
export function activityOf(toolName: unknown): TabActivity;
// state.ts
export interface Interpreted { kind: TabState; text: string | null; meta: Record<string, unknown>; activity?: TabActivity }
```

- [ ] **Step 1: Write the failing tests.** `apps/server/src/monitor/activity.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { activityOf } from './activity.js';

describe('activityOf', () => {
  it.each([
    ['Edit', 'coding'], ['Write', 'coding'], ['MultiEdit', 'coding'], ['NotebookEdit', 'coding'],
    ['Read', 'reading'], ['Grep', 'reading'], ['Glob', 'reading'], ['LS', 'reading'],
    ['WebSearch', 'researching'], ['WebFetch', 'researching'],
    ['EnterPlanMode', 'planning'], ['ExitPlanMode', 'planning'], ['AskUserQuestion', 'planning'], ['TodoWrite', 'planning'], ['TaskCreate', 'planning'], ['TaskUpdate', 'planning'],
    ['Bash', 'terminal'],
  ])('%s → %s', (tool, activity) => {
    expect(activityOf(tool)).toBe(activity);
  });

  it('is exact: case, prefixes and MCP tools fall back to working', () => {
    expect(activityOf('edit')).toBe('working');
    expect(activityOf('Editor')).toBe('working');
    expect(activityOf('mcp__termhub__read_screen')).toBe('working');
    expect(activityOf('Agent')).toBe('working');
    expect(activityOf('Skill')).toBe('working');
  });

  it('reads working for anything that is not a string', () => {
    for (const v of [null, undefined, 42, {}, [], '']) expect(activityOf(v)).toBe('working');
  });
});
```

Append to `apps/server/src/monitor/state.test.ts`, in the claude describe:

```ts
  it('maps PreToolUse to working with the tool\'s activity, keeping nothing of the tool input', () => {
    const withInput = interpretHookEvent('claude', { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: '/secret', new_string: 'x' } });
    const without = interpretHookEvent('claude', { hook_event_name: 'PreToolUse', tool_name: 'Edit' });
    expect(withInput).toEqual({ kind: 'working', text: null, activity: 'coding', meta: { event: 'PreToolUse', tool: 'Edit' } });
    expect(withInput).toEqual(without);
    expect(JSON.stringify(withInput)).not.toContain('secret');
  });

  it('maps a PreToolUse without a tool name to plain working', () => {
    expect(interpretHookEvent('claude', { hook_event_name: 'PreToolUse' })).toEqual({ kind: 'working', text: null, activity: 'working', meta: { event: 'PreToolUse', tool: null } });
  });

  it('leaves activity undefined on every other event', () => {
    expect(interpretHookEvent('claude', { hook_event_name: 'UserPromptSubmit' })?.activity).toBeUndefined();
    expect(interpretHookEvent('claude', { hook_event_name: 'Stop' })?.activity).toBeUndefined();
    expect(interpretHookEvent('codex', { type: 'agent-turn-complete' })?.activity).toBeUndefined();
  });
```

Check the existing `state.test.ts` for a test that asserts the old `PreToolUse` shape (`meta: { event: 'PreToolUse' }` without `tool`); update it to the new shape rather than leaving two contradictory expectations.

- [ ] **Step 2: Run.** `DOCKER 'npx -w @termhub/server vitest run src/monitor/activity.test.ts src/monitor/state.test.ts'` — Expected: FAIL (module missing; shape differs).

- [ ] **Step 3: Implement.** In `types.ts`, next to `TabState`:

```ts
/** What a working agent is doing, from the tool it is about to call (monitor/activity.ts). */
export type TabActivity = 'coding' | 'reading' | 'researching' | 'planning' | 'terminal' | 'working';
export const TAB_ACTIVITIES: readonly TabActivity[] = ['coding', 'reading', 'researching', 'planning', 'terminal', 'working'];
```

`apps/server/src/monitor/activity.ts`:

```ts
import type { TabActivity } from '../db/repositories/types.js';

/**
 * Claude Code tool name → what the person on the floor is doing. Exact names: a tool Claude Code
 * adds tomorrow reads `working` until it is classified here, never something wrong. Only the
 * name is ever looked at — the tool's input never reaches the server for this event.
 */
const BY_TOOL: Record<string, TabActivity> = {
  Edit: 'coding', Write: 'coding', MultiEdit: 'coding', NotebookEdit: 'coding',
  Read: 'reading', Grep: 'reading', Glob: 'reading', LS: 'reading',
  WebSearch: 'researching', WebFetch: 'researching',
  EnterPlanMode: 'planning', ExitPlanMode: 'planning', AskUserQuestion: 'planning', TodoWrite: 'planning', TaskCreate: 'planning', TaskUpdate: 'planning',
  Bash: 'terminal',
};

export function activityOf(toolName: unknown): TabActivity {
  return typeof toolName === 'string' ? (BY_TOOL[toolName] ?? 'working') : 'working';
}
```

In `state.ts`: import `activityOf` and `TabActivity`; add `activity?: TabActivity` to `Interpreted`; split the `PreToolUse` case out of the shared `working` group:

```ts
    case 'PreToolUse': {
      // the script already reduced this event to the tool's name; whatever else arrives is ignored
      const tool = str(ev.tool_name);
      return { kind: 'working', text: null, activity: activityOf(tool), meta: { event: name, tool } };
    }
```

(`str()` returns `null` for a non-string or empty value, which is what the second test expects.)

- [ ] **Step 4: Run tests + typecheck.** `DOCKER 'npx -w @termhub/server vitest run src/monitor && npm run typecheck -w @termhub/server'` — Expected: PASS.

- [ ] **Step 5: Commit** — `git commit -m "Monitor: read the agent's activity from the PreToolUse tool name"`

---

### Task 3: Schema, repository and the light ingestion path

**Files:**
- Modify: `apps/server/prisma/schema.prisma`; Create: `apps/server/prisma/migrations/20260922120000_tab_activity/migration.sql`
- Modify: `apps/server/src/db/repositories/types.ts` (`Tab.activity`, `mapTab`), `apps/server/src/db/repositories/tabs.ts`, `apps/server/src/db/repositories/tabs.db.test.ts`
- Modify: `apps/server/src/monitor/ingest.ts`; Create: `apps/server/src/monitor/ingest.test.ts`

**Interfaces:**
- Consumes: `Interpreted.activity`, `TabActivity` (Task 2).
- Produces: `Tab.activity: TabActivity | null` (API and web); `TabsRepository.recordEvent(tabId, { kind, tool, text, meta?, activity? })` stores `activity` when `kind === 'working'` and clears it otherwise; `TabsRepository.setActivity(tabId, activity): Promise<Tab | undefined>` — one `UPDATE` of `activity` and `state_at`, no event row; `ingestHookEvent` takes the light path for an activity-only change.

- [ ] **Step 1: Schema and migration.** In `schema.prisma`, after `enum TabState`:

```prisma
/// What a working agent is doing, from the tool it is about to call (monitor/activity.ts).
enum TabActivity {
  coding
  reading
  researching
  planning
  terminal
  working
}
```

and on `model Tab`, after `stateSeenAt`:

```prisma
  /// Set while `state` is working; cleared when the tab leaves it. null = not working or never reported.
  activity      TabActivity? 
```

Migration `20260922120000_tab_activity/migration.sql`:

```sql
-- CreateEnum
CREATE TYPE "TabActivity" AS ENUM ('coding', 'reading', 'researching', 'planning', 'terminal', 'working');

-- AlterTable
ALTER TABLE "tabs" ADD COLUMN "activity" "TabActivity";
```

Check the real table name of `Tab` in the schema (`@@map`) and the naming style of the last migrations; match them. Run `DOCKER 'npm run prisma:generate'` after editing.

- [ ] **Step 2: Types and mapper.** In `types.ts`: `activity: TabActivity | null;` on `Tab` (after `state_seen_at`), and `activity: t.activity,` in `mapTab`. Grep the server for object literals typed as `Tab` in tests (`state_seen_at: null` fixtures) and add `activity: null` where the typecheck demands it.

- [ ] **Step 3: Write the failing DB tests.** Append to `tabs.db.test.ts`, inside the existing describe (reuse `db`, `repo`, `tabId`):

```ts
  it('recordEvent stores the activity of a working event and clears it when the tab leaves working', async () => {
    const { tab } = await repo.recordEvent(tabId, { kind: 'working', tool: 'claude', text: null, activity: 'coding' });
    expect(tab.activity).toBe('coding');
    const waiting = await repo.recordEvent(tabId, { kind: 'waiting_input', tool: 'claude', text: 'q?' });
    expect(waiting.tab.activity).toBeNull();
    const again = await repo.recordEvent(tabId, { kind: 'working', tool: 'claude', text: null });
    expect(again.tab.activity).toBeNull(); // working with no activity known
  });

  it('setActivity changes only the activity and the time, with no event row', async () => {
    await repo.recordEvent(tabId, { kind: 'working', tool: 'claude', text: null, activity: 'coding' });
    const before = await db.tabEvent.count({ where: { tabId } });
    const updated = await repo.setActivity(tabId, 'reading');
    expect(updated?.activity).toBe('reading');
    expect(updated?.state).toBe('working');
    expect(await db.tabEvent.count({ where: { tabId } })).toBe(before);
    expect(new Date(updated!.state_at!).getTime()).toBeGreaterThanOrEqual(new Date(before ? updated!.state_at! : 0).getTime());
  });

  it('clearState clears the activity too', async () => {
    await repo.recordEvent(tabId, { kind: 'working', tool: 'claude', text: null, activity: 'terminal' });
    await repo.clearState(tabId);
    expect((await repo.findById(tabId))?.activity).toBeNull();
  });
```

(Tidy the `state_at` assertion in the second test: capture the previous `state_at` from the first `recordEvent` result and assert the new one is `>=` it.)

- [ ] **Step 4: Run** with the throwaway Postgres (the recipe from v1: container `office-pg` on 127.0.0.1:55432, `TERMHUB_DB_TESTS=1`, `DATABASE_URL=postgresql://postgres:pw@127.0.0.1:55432/termhub_test`, `npx prisma migrate deploy` from `apps/server` first): `npx -w @termhub/server vitest run src/db/repositories/tabs.db.test.ts` — Expected: FAIL (`setActivity` missing; `activity` not stored).

- [ ] **Step 5: Implement the repository.** In `tabs.ts`:
  - `recordEvent`'s `event` gains `activity?: TabActivity`; in the `tx.tab.update` data add `activity: event.kind === 'working' ? (event.activity ?? null) : null`.
  - `clearState` adds `activity: null`.
  - New method after `clearState`:

```ts
  /**
   * A tool change on a tab that is already working: the activity and the time move, nothing else,
   * and no event row is written — an active agent changes tool several times a minute, and the
   * event table is for state changes.
   */
  async setActivity(tabId: string, activity: TabActivity): Promise<Tab | undefined> {
    const t = await this.db.tab.update({ where: { id: tabId }, data: { activity, stateAt: new Date() } }).catch(() => null);
    return t ? mapTab(t) : undefined;
  }
```

Check how the file handles "row not found" elsewhere (`update` on a missing id throws in Prisma) and match its idiom instead of the `.catch(() => null)` if the file has one.

- [ ] **Step 6: Write the failing ingest test.** `apps/server/src/monitor/ingest.test.ts`, over stubbed repositories (follow `routes/office.test.ts`'s stub style; `monitorBus.publish` can be spied through `vi.mock('./bus.js', …)`):

```ts
import { describe, expect, it, vi } from 'vitest';
import type { Repositories } from '../db/repositories/index.js';
import type { Tab } from '../db/repositories/types.js';

const publish = vi.fn();
vi.mock('./bus.js', () => ({ monitorBus: { publish: (...a: unknown[]) => publish(...a) } }));
const { ingestHookEvent } = await import('./ingest.js');

const tab = (over: Partial<Tab>): Tab => ({ id: 't1', project_id: 'p1', name: 't', kind: 'terminal', tmux_session: 'th-t1', simulator_udid: null, created_by_token_id: null, position: 0, state: null, state_text: null, state_tool: null, state_at: null, state_seen_at: null, activity: null, created_at: '' , ...over }) as Tab;
const log = { info: vi.fn(), debug: vi.fn(), warn: vi.fn() } as never;

function repos(current: Tab) {
  const recordEvent = vi.fn(async (_id: string, ev: { kind: string; activity?: string }) => ({ tab: tab({ ...current, state: ev.kind as Tab['state'], activity: (ev.activity as Tab['activity']) ?? null }), event: {} }));
  const setActivity = vi.fn(async (_id: string, activity: Tab['activity']) => tab({ ...current, activity }));
  return {
    r: { tabs: { findByTmuxSession: vi.fn(async () => current), recordEvent, setActivity }, projects: { findById: vi.fn(async () => ({ id: 'p1', machine_id: 'm1' })) }, machines: { findById: vi.fn(async () => ({ id: 'm1', owner_id: 'u1' })) } } as unknown as Repositories,
    recordEvent,
    setActivity,
  };
}
const pre = (tool_name: string) => ({ machineId: 'm1', tool: 'claude' as const, session: 'th-t1', event: { hook_event_name: 'PreToolUse', tool_name } });

describe('ingestHookEvent — activity', () => {
  it('records an event when the state changes, carrying the activity', async () => {
    const { r, recordEvent, setActivity } = repos(tab({ state: 'waiting_input' }));
    const res = await ingestHookEvent(r, log, pre('Edit'));
    expect(res).toMatchObject({ ok: true, tab: { state: 'working', activity: 'coding' } });
    expect(recordEvent).toHaveBeenCalledWith('t1', expect.objectContaining({ kind: 'working', activity: 'coding' }));
    expect(setActivity).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalled();
  });

  it('takes the light path when only the activity changes on a working tab', async () => {
    publish.mockClear();
    const { r, recordEvent, setActivity } = repos(tab({ state: 'working', activity: 'coding' }));
    const res = await ingestHookEvent(r, log, pre('Read'));
    expect(res).toMatchObject({ ok: true, tab: { activity: 'reading' } });
    expect(setActivity).toHaveBeenCalledWith('t1', 'reading');
    expect(recordEvent).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it('writes nothing when the activity is already stored', async () => {
    publish.mockClear();
    const { r, recordEvent, setActivity } = repos(tab({ state: 'working', activity: 'coding' }));
    const res = await ingestHookEvent(r, log, pre('Write'));
    expect(res).toMatchObject({ ok: true });
    expect(setActivity).not.toHaveBeenCalled();
    expect(recordEvent).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it('never logs the tool input', async () => {
    const { r } = repos(tab({ state: 'waiting_input' }));
    await ingestHookEvent(r, log, { ...pre('Edit'), event: { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: '/secret' } } });
    const logged = JSON.stringify((log as { info: { mock: { calls: unknown[] } } }).info.mock.calls);
    expect(logged).not.toContain('secret');
  });
});
```

- [ ] **Step 7: Run.** `DOCKER 'npx -w @termhub/server vitest run src/monitor/ingest.test.ts'` — Expected: FAIL (light path not taken).

- [ ] **Step 8: Implement the ingestion.** In `ingest.ts`, `ingestHookEvent` after `interpreted`:

```ts
  // A tool change on a tab already working is not a state change: the light path moves only the
  // activity (no event row) and still tells the subscribers. The script already posts only on a
  // change; the equality check here is a defensive no-op for anything else that reaches us.
  if (interpreted.activity !== undefined && tab.state === 'working' && interpreted.kind === 'working') {
    if (tab.activity === interpreted.activity) return { ok: true, tab };
    const updated = await repos.tabs.setActivity(tab.id, interpreted.activity);
    if (!updated) return { ok: false, reason: 'unknown_session' };
    const project = await repos.projects.findById(tab.project_id);
    const machine = project ? await repos.machines.findById(project.machine_id) : undefined;
    log.debug({ tabId: tab.id, machineId: machine?.id, activity: interpreted.activity }, 'monitor: tab activity');
    publishTabChange(updated, tab.project_id, machine);
    return { ok: true, tab: updated };
  }
  return { ok: true, tab: await applyState(repos, log, tab, input.tool, interpreted) };
```

and in `applyState`, pass `activity: next.activity` to `recordEvent`. The existing `log.info` in `applyState` logs `tool`, `kind`, `textLen` — leave it; it never sees the tool input because `interpretClaude` dropped it.

- [ ] **Step 9: Run everything for the server** with Postgres: `npx -w @termhub/server vitest run src/monitor src/db/repositories/tabs.db.test.ts && npm run typecheck -w @termhub/server` — Expected: PASS.

- [ ] **Step 10: Commit** — `git commit -m "Monitor: store the agent's activity on the tab, off the event path"`

---

### Task 4: Release the agent

**Files:**
- Modify: `apps/agent/package.json` (version), and `apps/agent/src/version.ts` if `AGENT_VERSION` is a literal there (check; a previous fix kept them in sync by hand — `fix/agent-version-0-2-4`).

- [ ] **Step 1:** Bump `apps/agent/package.json` from `0.4.0` to `0.4.1` and keep `AGENT_VERSION` in sync the way the repo does it (read `apps/agent/src/version.ts`; if it reads `package.json` at build time, nothing else to do). Add one line to the agent's changelog if one exists (`grep -ril changelog apps/agent`).
- [ ] **Step 2:** `DOCKER 'npm run build:packages && npm run typecheck -w @termhub/agent && npm test -w @termhub/agent'` — Expected: PASS.
- [ ] **Step 3: Commit** — `git commit -m "Agent: 0.4.1 — the monitor hook reports the tool being called"`

Note: CI publishes the agent when this version lands on `main`; enrolled machines update themselves. Nothing to run on a machine by hand.

---

### Task 5: The label on the floor

**Files:**
- Modify: `apps/web/src/lib/types.ts`, `apps/web/src/office/model.ts`, `apps/web/src/office/model.test.ts`, `apps/web/src/office/scene/Overlay.ts`, `apps/web/src/office/harness.ts`

**Interfaces:**
- Consumes: `Tab.activity` from the API (Task 3).
- Produces: `type TabActivity` and `Tab.activity: TabActivity | null` in `lib/types.ts`; `DeskModel.activity: TabActivity | null`; `activityLabel(activity: TabActivity | null): string | null` (pt-BR table, `null` for `null`); `DeskOverlay` shows the activity label in place of the short tab name while `pose === 'type'` and `activity !== null`.

- [ ] **Step 1: Types.** In `apps/web/src/lib/types.ts`, next to `TabState`: `export type TabActivity = 'coding' | 'reading' | 'researching' | 'planning' | 'terminal' | 'working';` and `activity: TabActivity | null;` on `Tab` after `state_seen_at`. Fix the test fixtures the typecheck flags (`model.test.ts`, `OfficePage.test.tsx`, `NeedsYouList.test.tsx`, …) by adding `activity: null`.

- [ ] **Step 2: Write the failing model tests.** Append to `model.test.ts`:

```ts
describe('activity', () => {
  const at = '2026-09-22T10:00:00.000Z';
  it('reaches the desk from the snapshot and from a newer monitor push', () => {
    const snapOnly = buildModel(snap([room('p1', [tab('a', { state: 'working', state_at: at, activity: 'coding' })])]), none).rooms[0].desks[0];
    expect(snapOnly.activity).toBe('coding');
    const live = (id: string) => (id === 'a' ? ({ ...tab('a'), state: 'working', state_at: '2026-09-22T10:01:00.000Z', activity: 'reading' } as Tab) : undefined);
    const merged = buildModel(snap([room('p1', [tab('a', { state: 'working', state_at: at, activity: 'coding' })])]), live).rooms[0].desks[0];
    expect(merged.activity).toBe('reading');
  });
  it('is null when the tab is not working, whatever the snapshot says', () => {
    const d = buildModel(snap([room('p1', [tab('a', { state: 'waiting_input', state_at: at, activity: 'coding' })])]), none).rooms[0].desks[0];
    expect(d.activity).toBeNull();
  });
  it('labels every category in pt-BR and nothing for null', () => {
    expect(activityLabel('coding')).toBe('codando');
    expect(activityLabel('reading')).toBe('lendo arquivos');
    expect(activityLabel('researching')).toBe('pesquisando');
    expect(activityLabel('planning')).toBe('planejando');
    expect(activityLabel('terminal')).toBe('no terminal');
    expect(activityLabel('working')).toBe('trabalhando');
    expect(activityLabel(null)).toBeNull();
  });
});
```

- [ ] **Step 3: Run.** `DOCKER 'npx -w @termhub/web vitest run src/office/model.test.ts'` — Expected: FAIL.

- [ ] **Step 4: Implement.** In `model.ts`: `activity: TabActivity | null` on `DeskModel`; in `withLiveState`'s `fromLive()` add `activity: live.activity`; in `deskOf` set `activity: t.state === 'working' ? t.activity : null` on the person branch (and `null` for phone/empty); and

```ts
const ACTIVITY_LABEL: Record<TabActivity, string> = { coding: 'codando', reading: 'lendo arquivos', researching: 'pesquisando', planning: 'planejando', terminal: 'no terminal', working: 'trabalhando' };
/** What a working person is doing, under them on the floor — pt-BR, or null when nothing is known. */
export function activityLabel(activity: TabActivity | null): string | null {
  return activity ? ACTIVITY_LABEL[activity] : null;
}
```

In `Overlay.ts` (`DeskOverlay.apply`): `this.short = (model.pose === 'type' && activityLabel(model.activity)) || model.label;` — the hovered `full` (name + task title) is unchanged, so the tab's name stays one hover away. Style the activity label a shade dimmer than a name if the style helper makes that a one-liner; otherwise leave the style.

In `harness.ts`: `?activity=<category>` sets that activity on every `working` desk (and `?activity=mix` cycles through the six), so a screenshot shows the labels.

- [ ] **Step 5: Verify.** `DOCKER 'npx -w @termhub/web vitest run && npm run typecheck -w @termhub/web && npm run build -w @termhub/web'` and the pixi-import grep. Then one screenshot of `office-harness.html?still=1&machines=1&room=0&activity=mix` (the Task-5-of-v2 procedure: Vite container on 127.0.0.1:5199, Playwright image, removed afterwards) — LOOK at it: working desks read `codando` / `lendo arquivos` / … under the person, waiting and idle desks still show their tab name, nothing overlaps.

- [ ] **Step 6: Commit** — `git commit -m "Office: say what each working agent is doing, under its person"`

---

### Task 6: Spec truth, full verification, pull request

- [ ] **Step 1:** Make the spec's Status line say the design is implemented on `feat/agent-activity`, pending review and merge; record anything the implementation settled differently (e.g. how `matcher` was set, the marker sanitisation, the exact light-path condition).
- [ ] **Step 2: Full verification** with a throwaway Postgres (the v1 recipe): `npm ci`, `prisma:generate`, `build:packages`, machine-ops tests, agent typecheck + tests, server typecheck + tests, web typecheck + tests, web build, landing build. Capture output to a file under `/tmp/office-verify/`; report exit codes and counts. Baseline on `origin/main`: server 723 passed / 6 skipped, web 433 passed.
- [ ] **Step 3 (controller, after the whole-branch review):** merge `origin/main` if it moved, re-verify, push, open the PR. The PR description must say the agent release is `0.4.1` and that machines update themselves.
- [ ] **Step 4 (after merge and deploy):** wait for the publish-agent workflow to release 0.4.1; on a machine whose agent has updated, run an agent in a tab and watch `/office`: the label under its person follows the tool it uses within a second or two; a machine still on 0.4.0 reads `trabalhando`.
