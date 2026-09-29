# Monitor: one wait, one alert (TER-422, TER-411, TER-414) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A wait the person has already seen lights the dot again only for a new request, and a Cursor session that was never prompted stops reading as busy.

**Architecture:** One pure function, `decideWait`, says what an incoming wait is: a continuation, a reminder with nothing new, a late echo of a session that ended, or a new request. `recordEvent` calls it under the tab's row lock and either drops the event or records it with the right seen mark. The interpreter, the web's seen rule and the alert rule do not change; Cursor's `sessionStart` becomes `idle`, and the web's optimistic seen mark reaches the open-tab list too.

**Tech Stack:** TypeScript, Fastify, Prisma/Postgres, vitest, React 19 (`@termhub/server`, `@termhub/web`).

**Spec:** `docs/superpowers/specs/2026-09-29-monitor-one-wait-one-alert-design.md`

## Global Constraints

- Work only inside the worktree `/home/pedrogoiania/termhub/.claude/worktrees/ter-1-407-roadmap`, branch `fix/ter-422-one-wait-one-alert`. Never `cd` to `/home/pedrogoiania/termhub`, never switch branches.
- This host shares Docker with production. Never stop, remove, kill or prune a container, image, volume or network. Every container you start has a fixed name that begins with `th-f3-` and runs with `--rm`. Do not build a name with `$RANDOM`. The database container `th-f3-db` is started and stopped by the controller: never touch it.
- Run git as plain, separate commands: one git command per shell call, no `&&`, no `;`, no pipes.
- Docker only, Node 22. `D <name> '<cmd>'` means:
  ```bash
  docker run --rm --name "<name>" --network host -u "$(id -u):$(id -g)" -e HOME=/tmp -e npm_config_update_notifier=false -e TERMHUB_DB_TESTS=1 -e DATABASE_URL=postgresql://termhub:termhub@127.0.0.1:55432/termhub_test -v "/home/pedrogoiania/termhub/.claude/worktrees/ter-1-407-roadmap:/w" -w /w node:22 sh -c '<cmd>'
  ```
  The database is a throwaway Postgres, already migrated. Dependencies are installed and the packages are built. After each run: `rm -rf /home/pedrogoiania/termhub/.claude/worktrees/ter-1-407-roadmap/.npm`.
- Vitest file paths are relative to the workspace: `npm test -w @termhub/server -- src/monitor/wait-decision.test.ts`.
- Code, comments and commit messages in English. UI copy stays in Portuguese.
- Terminal content, hook payloads and the text of a state are never logged. Only metadata: tab id, tool, event names, sizes.
- No migration. No change to `@termhub/agent`, to the hook script, or to `apps/server/src/monitor/state.ts` other than Cursor's `sessionStart`.
- Exact values: quiet events are `SessionStart`, `PreCompact` and `input`; session-end events are `SessionEnd` and `sessionEnd`.
- Every case `apps/server/src/db/repositories/tabs.db.test.ts` pins today keeps its result. If one of them fails, stop and report it; do not change it.
- The account swap's events and the permission events are not changed: they alert as they do today.
- Commit subject: imperative, at most 72 characters. The commit body ends with a `Co-Authored-By:` line that names the model writing the commit.

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `apps/server/src/monitor/wait-decision.ts` | New. Pure: what an incoming wait is, from the tab's current state and its last event | 1 |
| `apps/server/src/monitor/wait-decision.test.ts` | New. Its cases, no database | 1 |
| `apps/server/src/db/repositories/tabs.ts` | `recordEvent` asks `decideWait`, drops or records, says when a seen wait was re-armed | 2 |
| `apps/server/src/db/repositories/tabs.db.test.ts` | The same rules against Postgres | 2 |
| `apps/server/src/monitor/ingest.ts` | Tells `recordEvent` the event came from a hook; a dropped event ends as `ignored`; the re-arm log line | 2 |
| `apps/server/src/monitor/ingest.test.ts` | A dropped event opens no card and publishes nothing | 2 |
| `apps/server/src/monitor/state.ts`, `state.test.ts` | Cursor `sessionStart` is `idle` | 3 |
| `apps/web/src/lib/monitor.tsx`, `monitor.test.tsx` | The optimistic seen mark reaches the open-tab list | 4 |
| `apps/web/src/lib/needs-you.test.ts` | Stop, seen, answer alerts once | 4 |

---

### Task 1: `decideWait`, the rule in one pure function

**Files:**
- Create: `apps/server/src/monitor/wait-decision.ts`
- Test: `apps/server/src/monitor/wait-decision.test.ts`

**Interfaces:**
- Consumes: `TabState` from `apps/server/src/db/repositories/types.ts` (`'working' | 'waiting_input' | 'waiting_permission' | 'idle' | 'error'`).
- Produces, for Task 2:
  - `decideWait(current: WaitCurrent, previousEvent: string | null, event: WaitEvent): WaitOutcome`
  - `interface WaitCurrent { state: TabState | null; seen: boolean; hasActivity: boolean }`
  - `interface WaitEvent { kind: TabState; continuesWait: boolean; keepsWaitText: boolean; fromHook: boolean }`
  - `type WaitOutcome = { action: 'drop'; reason: 'late_after_session_end' | 'reminder_on_permission' } | { action: 'record'; seen: 'carry' | 'born' | 'none'; continuing: boolean }`
  - `QUIET_EVENTS` and `SESSION_END_EVENTS`, both `ReadonlySet<string>`
  - `promptedByPerson(previousEvent: string | null): boolean`

- [ ] **Step 1: Write the failing tests**

Create `apps/server/src/monitor/wait-decision.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { decideWait, promptedByPerson, type WaitCurrent, type WaitEvent } from './wait-decision.js';

const current = (over: Partial<WaitCurrent> = {}): WaitCurrent => ({ state: null, seen: false, hasActivity: false, ...over });
const event = (over: Partial<WaitEvent> = {}): WaitEvent => ({ kind: 'waiting_input', continuesWait: false, keepsWaitText: false, fromHook: true, ...over });
/** Claude's idle_prompt: the one event that is only a reminder. */
const reminder = event({ continuesWait: true, keepsWaitText: true });
/** Cursor's stop or afterAgentResponse: continues a wait, and may bring the answer. */
const continuation = event({ continuesWait: true });

describe('decideWait — events that are not a wait', () => {
  it('records working, idle and error as they come, with no seen mark', () => {
    for (const kind of ['working', 'idle', 'error'] as const) {
      expect(decideWait(current({ state: 'waiting_input', seen: true }), 'Stop', event({ kind }))).toEqual({ action: 'record', seen: 'none', continuing: false });
    }
  });

  it('records a session start after a session end: only a wait can be late', () => {
    expect(decideWait(current({ state: 'idle' }), 'SessionEnd', event({ kind: 'working' }))).toEqual({ action: 'record', seen: 'none', continuing: false });
  });
});

describe('decideWait — what tabs.db.test.ts pins today', () => {
  it('a continuation of a seen waiting_input carries the seen mark', () => {
    expect(decideWait(current({ state: 'waiting_input', seen: true }), 'Stop', continuation)).toEqual({ action: 'record', seen: 'carry', continuing: true });
    expect(decideWait(current({ state: 'waiting_input', seen: true }), 'Stop', reminder)).toEqual({ action: 'record', seen: 'carry', continuing: true });
  });

  it('a continuation of an unseen waiting_input stays unseen', () => {
    expect(decideWait(current({ state: 'waiting_input', seen: false }), 'Stop', continuation)).toEqual({ action: 'record', seen: 'none', continuing: true });
  });

  it('a wait that does not say it continues is a new one, even right after a seen wait (the next Codex turn)', () => {
    expect(decideWait(current({ state: 'waiting_input', seen: true }), 'agent-turn-complete', event())).toEqual({ action: 'record', seen: 'none', continuing: false });
  });

  it('a permission prompt is always a new request', () => {
    expect(decideWait(current({ state: 'waiting_input', seen: true }), 'Stop', event({ kind: 'waiting_permission' }))).toEqual({ action: 'record', seen: 'none', continuing: false });
    expect(decideWait(current({ state: 'waiting_permission', seen: true }), 'PermissionRequest', event({ kind: 'waiting_permission' }))).toEqual({ action: 'record', seen: 'none', continuing: false });
  });

  it('a continuation that finds the tab working opens the wait (Cursor: a lost answer, then stop)', () => {
    expect(decideWait(current({ state: 'working' }), 'beforeSubmitPrompt', continuation)).toEqual({ action: 'record', seen: 'none', continuing: false });
    expect(decideWait(current({ state: 'working' }), null, continuation)).toEqual({ action: 'record', seen: 'none', continuing: false });
  });
});

describe('decideWait — a reminder never opens an alert by itself', () => {
  it('is dropped on a permission wait: the prompt is still the same one', () => {
    expect(decideWait(current({ state: 'waiting_permission', seen: true }), 'Notification', reminder)).toEqual({ action: 'drop', reason: 'reminder_on_permission' });
    expect(decideWait(current({ state: 'waiting_permission', seen: false }), 'PermissionRequest', reminder)).toEqual({ action: 'drop', reason: 'reminder_on_permission' });
  });

  it('is born seen when the tab went to working with no turn behind it', () => {
    for (const quiet of ['SessionStart', 'PreCompact', 'input']) {
      expect(decideWait(current({ state: 'working' }), quiet, reminder)).toEqual({ action: 'record', seen: 'born', continuing: false });
    }
  });

  it('alerts when a turn was really running: the Stop was lost and this is what ends it', () => {
    expect(decideWait(current({ state: 'working' }), 'UserPromptSubmit', reminder)).toEqual({ action: 'record', seen: 'none', continuing: false });
    expect(decideWait(current({ state: 'working' }), 'PreToolUse', reminder)).toEqual({ action: 'record', seen: 'none', continuing: false });
  });

  it('alerts when tool calls followed a quiet event: the light path leaves no row, only the activity', () => {
    expect(decideWait(current({ state: 'working', hasActivity: true }), 'SessionStart', reminder)).toEqual({ action: 'record', seen: 'none', continuing: false });
  });

  it('alerts when nothing is known about the working state (no event row)', () => {
    expect(decideWait(current({ state: 'working' }), null, reminder)).toEqual({ action: 'record', seen: 'none', continuing: false });
  });

  it('is born seen on an idle tab that did not just end its session', () => {
    expect(decideWait(current({ state: 'idle' }), 'sessionStart', reminder)).toEqual({ action: 'record', seen: 'born', continuing: false });
  });

  it('alerts on a tab in error or with no state, as today', () => {
    expect(decideWait(current({ state: 'error' }), 'StopFailure', reminder)).toEqual({ action: 'record', seen: 'none', continuing: false });
    expect(decideWait(current({ state: null }), null, reminder)).toEqual({ action: 'record', seen: 'none', continuing: false });
  });

  it('only a reminder is born seen: a Cursor continuation after a quiet start is a new wait', () => {
    expect(decideWait(current({ state: 'working' }), 'SessionStart', continuation)).toEqual({ action: 'record', seen: 'none', continuing: false });
  });
});

describe('decideWait — a wait that lands after the session ended', () => {
  it('is dropped when it came from a hook', () => {
    for (const end of ['SessionEnd', 'sessionEnd']) {
      expect(decideWait(current({ state: 'idle' }), end, event())).toEqual({ action: 'drop', reason: 'late_after_session_end' });
      expect(decideWait(current({ state: 'idle' }), end, event({ kind: 'waiting_permission' }))).toEqual({ action: 'drop', reason: 'late_after_session_end' });
      expect(decideWait(current({ state: 'idle' }), end, reminder)).toEqual({ action: 'drop', reason: 'late_after_session_end' });
      expect(decideWait(current({ state: 'idle' }), end, continuation)).toEqual({ action: 'drop', reason: 'late_after_session_end' });
    }
  });

  it('is recorded when termhub wrote it: the account swap waits for the session to end, then asks for the person', () => {
    expect(decideWait(current({ state: 'idle' }), 'SessionEnd', event({ fromHook: false }))).toEqual({ action: 'record', seen: 'none', continuing: false });
  });

  it('is recorded when the tab is idle for another reason', () => {
    expect(decideWait(current({ state: 'idle' }), 'sessionStart', event())).toEqual({ action: 'record', seen: 'none', continuing: false });
    expect(decideWait(current({ state: 'idle' }), null, event())).toEqual({ action: 'record', seen: 'none', continuing: false });
  });
});

describe('promptedByPerson', () => {
  it('is true for the events that prove the person asked for the turn', () => {
    for (const name of ['UserPromptSubmit', 'beforeSubmitPrompt', 'input']) expect(promptedByPerson(name)).toBe(true);
  });

  it('is false for everything else, and for no event', () => {
    for (const name of ['PreToolUse', 'Stop', 'SessionStart', 'agent-turn-complete']) expect(promptedByPerson(name)).toBe(false);
    expect(promptedByPerson(null)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `D th-f3-t1-red 'npm test -w @termhub/server -- src/monitor/wait-decision.test.ts'`
Expected: FAIL, the module `./wait-decision.js` cannot be found.

- [ ] **Step 3: Write the implementation**

Create `apps/server/src/monitor/wait-decision.ts`:

```ts
import type { TabState } from '../db/repositories/types.js';

/**
 * What an incoming wait is, for the "needs you" rule (spec 2026-09-29 one wait, one alert).
 *
 * A tab needs the person when it waits and the wait is newer than the last time they looked. Every
 * recorded event moves the wait's time, so an event that brings nothing new has to say so, or a wait
 * the person already saw lights up again. The interpreters know part of it (`continuesWait`,
 * `keepsWaitText`); the rest depends on where the tab is, which only the tab's own row and its last
 * event can tell. Pure: `recordEvent` reads the row under its lock and asks here.
 */

/** Events that put a tab in `working` with no turn of the agent behind them. */
export const QUIET_EVENTS: ReadonlySet<string> = new Set(['SessionStart', 'PreCompact', 'input']);

/** Events that say the tool's session ended. */
export const SESSION_END_EVENTS: ReadonlySet<string> = new Set(['SessionEnd', 'sessionEnd']);

/** Events that prove the person asked for the turn that followed. */
const PROMPT_EVENTS: ReadonlySet<string> = new Set(['UserPromptSubmit', 'beforeSubmitPrompt', 'input']);

export interface WaitCurrent {
  state: TabState | null;
  /** the person has seen the tab's current state (`state_seen_at >= state_at`) */
  seen: boolean;
  /** the tab has an activity: a tool call went through the light path, which writes no event row */
  hasActivity: boolean;
}

export interface WaitEvent {
  kind: TabState;
  continuesWait: boolean;
  keepsWaitText: boolean;
  /** false for what termhub writes itself (the reply route, the account swap) */
  fromHook: boolean;
}

export type WaitOutcome =
  | { action: 'drop'; reason: 'late_after_session_end' | 'reminder_on_permission' }
  /**
   * `carry`: the wait goes on and the person had seen it. `born`: a wait with nothing new in it,
   * seen from its first moment. `none`: a request the person has not seen.
   * `continuing`: the wait's own text is kept when the event has none or brings only a reminder.
   */
  | { action: 'record'; seen: 'carry' | 'born' | 'none'; continuing: boolean };

const NEW: WaitOutcome = { action: 'record', seen: 'none', continuing: false };

/** `previousEvent` is the hook event name of the tab's last event row, or null when there is none. */
export function decideWait(current: WaitCurrent, previousEvent: string | null, event: WaitEvent): WaitOutcome {
  if (event.kind !== 'waiting_input' && event.kind !== 'waiting_permission') return NEW;

  // The hook posts in the background, so a Stop can land after the SessionEnd of its own session.
  // A new session always begins with a session start or a prompt, and neither is a wait.
  const sessionEnded = current.state === 'idle' && previousEvent !== null && SESSION_END_EVENTS.has(previousEvent);
  if (event.fromHook && sessionEnded) return { action: 'drop', reason: 'late_after_session_end' };

  if (event.continuesWait && event.kind === 'waiting_input' && current.state === 'waiting_input') {
    return { action: 'record', seen: current.seen ? 'carry' : 'none', continuing: true };
  }

  // A reminder (Claude's idle_prompt) is news only when it is the first sign that a turn ended.
  if (event.continuesWait && event.keepsWaitText) {
    if (current.state === 'waiting_permission') return { action: 'drop', reason: 'reminder_on_permission' };
    const quiet = current.state === 'working' && !current.hasActivity && previousEvent !== null && QUIET_EVENTS.has(previousEvent);
    if (quiet || current.state === 'idle') return { action: 'record', seen: 'born', continuing: false };
  }

  return NEW;
}

/** Whether the turn that ended was asked for by the person: the re-arm log leaves those out. */
export function promptedByPerson(previousEvent: string | null): boolean {
  return previousEvent !== null && PROMPT_EVENTS.has(previousEvent);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `D th-f3-t1-green 'npm test -w @termhub/server -- src/monitor/wait-decision.test.ts'`
Expected: every test passes, 0 failed.

Run: `D th-f3-t1-types 'npm run typecheck -w @termhub/server'`
Expected: exit code 0.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/monitor/wait-decision.ts apps/server/src/monitor/wait-decision.test.ts
```
```bash
git commit -m "Monitor: decide what an incoming wait is, in one pure function" -m "A continuation, a reminder with nothing new, a late echo of a session that ended, or a new request: recordEvent will ask this under the tab's row lock. Nothing calls it yet (TER-422)." -m "Co-Authored-By: <the model writing this commit> <noreply@anthropic.com>"
```

---

### Task 2: `recordEvent` follows the rule

**Files:**
- Modify: `apps/server/src/db/repositories/tabs.ts` (`recordEvent`, lines 135-180, and the import block)
- Modify: `apps/server/src/monitor/ingest.ts` (`ingestHookEvent`, `recordInterpretation`, `applyState`)
- Test: `apps/server/src/db/repositories/tabs.db.test.ts`, `apps/server/src/monitor/ingest.test.ts`

**Interfaces:**
- Consumes, from Task 1: `decideWait`, `promptedByPerson`, `WaitOutcome`, exactly as listed there.
- Produces:
  - `TabsRepository.recordEvent(tabId, event)` takes one more optional field, `fromHook?: boolean`, and answers `{ tab: Tab; event: TabEvent | null; rearmed: boolean; previousEvent: string | null }`. `event` is null when the event was dropped; the tab is then the row as it was.
  - `applyState(repos, log, tab, tool, next, opts?: { fromHook?: boolean }): Promise<Tab>` keeps its signature for the callers that exist (`routes/tabs.ts`, `control/account-swap.ts`), which pass no `opts`.

- [ ] **Step 1: Write the failing database tests**

In `apps/server/src/db/repositories/tabs.db.test.ts`, add this block right after the `describe('recordEvent — the same wait …')` block (before `describe('activity', …)`):

```ts
  describe('recordEvent — a wait with nothing new in it does not alert (spec 2026-09-29)', () => {
    const idlePrompt = { kind: 'waiting_input' as const, tool: 'claude', text: 'Claude is waiting for your input', meta: { event: 'Notification', type: 'idle_prompt' }, continuesWait: true, keepsWaitText: true, fromHook: true };

    it('/clear on a seen wait, then idle_prompt: the tab waits again, already seen', async () => {
      await repo.recordEvent(tabId, { kind: 'waiting_input', tool: 'claude', text: 'Pronto.', meta: { event: 'Stop' }, fromHook: true });
      await repo.markSeen(tabId);
      await repo.recordEvent(tabId, { kind: 'working', tool: 'claude', text: null, meta: { event: 'SessionStart' }, fromHook: true });
      const { tab, event, rearmed } = await repo.recordEvent(tabId, idlePrompt);
      expect(event).not.toBeNull();
      expect(tab.state).toBe('waiting_input');
      expect(needsYou(tab)).toBe(false);
      expect(tab.state_seen_at).toBe(tab.state_at);
      expect(rearmed).toBe(false);
    });

    it('a reply typed from termhub that started no turn, then idle_prompt: no alert', async () => {
      await repo.recordEvent(tabId, { kind: 'waiting_input', tool: 'claude', text: 'Pronto.', meta: { event: 'Stop' }, fromHook: true });
      await repo.recordEvent(tabId, { kind: 'working', tool: 'claude', text: null, meta: { event: 'input', via: 'termhub' } });
      const { tab } = await repo.recordEvent(tabId, idlePrompt);
      expect(needsYou(tab)).toBe(false);
    });

    it('a turn whose Stop was lost: idle_prompt is what ends it, and it alerts', async () => {
      await repo.recordEvent(tabId, { kind: 'working', tool: 'claude', text: null, meta: { event: 'UserPromptSubmit' }, fromHook: true });
      const { tab } = await repo.recordEvent(tabId, idlePrompt);
      expect(tab.state).toBe('waiting_input');
      expect(needsYou(tab)).toBe(true);
    });

    it('tool calls after a quiet start leave no row, only the activity: idle_prompt alerts', async () => {
      await repo.recordEvent(tabId, { kind: 'working', tool: 'claude', text: null, meta: { event: 'SessionStart' }, fromHook: true });
      await repo.setActivity(tabId, 'coding', null);
      const { tab } = await repo.recordEvent(tabId, idlePrompt);
      expect(needsYou(tab)).toBe(true);
    });

    it('idle_prompt on a permission wait changes nothing: no row, same state, same times', async () => {
      const { tab: asked } = await repo.recordEvent(tabId, { kind: 'waiting_permission', tool: 'claude', text: 'Allow Bash?', meta: { event: 'Notification', type: 'permission_prompt' }, fromHook: true });
      await repo.markSeen(tabId);
      const before = await repo.listEvents(tabId);
      const { tab, event, rearmed } = await repo.recordEvent(tabId, idlePrompt);
      expect(event).toBeNull();
      expect(rearmed).toBe(false);
      expect(tab.state).toBe('waiting_permission');
      expect(tab.state_text).toBe('Allow Bash?');
      expect(tab.state_at).toBe(asked.state_at);
      expect(needsYou(tab)).toBe(false);
      expect(await repo.listEvents(tabId)).toHaveLength(before.length);
    });

    it('a Stop that lands after the session ended is dropped', async () => {
      await repo.recordEvent(tabId, { kind: 'working', tool: 'claude', text: null, meta: { event: 'UserPromptSubmit' }, fromHook: true });
      const { tab: ended } = await repo.recordEvent(tabId, { kind: 'idle', tool: 'claude', text: null, meta: { event: 'SessionEnd', reason: 'exit' }, fromHook: true });
      const { tab, event } = await repo.recordEvent(tabId, { kind: 'waiting_input', tool: 'claude', text: 'Pronto.', meta: { event: 'Stop' }, fromHook: true });
      expect(event).toBeNull();
      expect(tab.state).toBe('idle');
      expect(tab.state_at).toBe(ended.state_at);
    });

    it('a dropped event credits no working time to the card', async () => {
      // the working interval was closed by the SessionEnd; the late Stop must not touch the counters
      await repo.recordEvent(tabId, { kind: 'working', tool: 'claude', text: null, meta: { event: 'UserPromptSubmit' }, fromHook: true });
      await repo.recordEvent(tabId, { kind: 'idle', tool: 'claude', text: null, meta: { event: 'SessionEnd' }, fromHook: true });
      const before = await repo.listEvents(tabId);
      await repo.recordEvent(tabId, { kind: 'waiting_input', tool: 'claude', text: 'Pronto.', meta: { event: 'Stop' }, fromHook: true });
      expect((await repo.listEvents(tabId)).map((e) => e.id)).toEqual(before.map((e) => e.id));
    });

    it("termhub's own wait after a session end is recorded and alerts (the account swap)", async () => {
      await repo.recordEvent(tabId, { kind: 'idle', tool: 'claude', text: null, meta: { event: 'SessionEnd' }, fromHook: true });
      const { tab, event } = await repo.recordEvent(tabId, { kind: 'waiting_input', tool: 'claude', text: 'Conta trocada', meta: { event: 'AccountSwap' } });
      expect(event).not.toBeNull();
      expect(tab.state).toBe('waiting_input');
      expect(needsYou(tab)).toBe(true);
    });

    it('a new session after the end goes through: only a wait can be late', async () => {
      await repo.recordEvent(tabId, { kind: 'idle', tool: 'claude', text: null, meta: { event: 'SessionEnd' }, fromHook: true });
      const { tab, event } = await repo.recordEvent(tabId, { kind: 'working', tool: 'claude', text: null, meta: { event: 'SessionStart' }, fromHook: true });
      expect(event).not.toBeNull();
      expect(tab.state).toBe('working');
    });
  });

  describe('recordEvent — says when a wait the person had seen is re-armed with no prompt of theirs', () => {
    it('is true for an answer nobody asked for (a background task woke the agent)', async () => {
      await repo.recordEvent(tabId, { kind: 'waiting_input', tool: 'claude', text: 'um', meta: { event: 'Stop' }, fromHook: true });
      await repo.markSeen(tabId);
      await repo.recordEvent(tabId, { kind: 'working', tool: 'claude', text: null, meta: { event: 'PreToolUse', tool: 'Bash' }, fromHook: true });
      const { rearmed, previousEvent } = await repo.recordEvent(tabId, { kind: 'waiting_input', tool: 'claude', text: 'dois', meta: { event: 'Stop' }, fromHook: true });
      expect(rearmed).toBe(true);
      expect(previousEvent).toBe('PreToolUse');
    });

    it('is true for a wait that follows a seen wait directly (the next Codex turn)', async () => {
      await repo.recordEvent(tabId, { kind: 'waiting_input', tool: 'codex', text: 'um', meta: { event: 'agent-turn-complete' }, fromHook: true });
      await repo.markSeen(tabId);
      const { rearmed, previousEvent } = await repo.recordEvent(tabId, { kind: 'waiting_input', tool: 'codex', text: 'dois', meta: { event: 'agent-turn-complete' }, fromHook: true });
      expect(rearmed).toBe(true);
      expect(previousEvent).toBe('agent-turn-complete');
    });

    it('is false when the person asked for the turn', async () => {
      await repo.recordEvent(tabId, { kind: 'waiting_input', tool: 'claude', text: 'um', meta: { event: 'Stop' }, fromHook: true });
      await repo.markSeen(tabId);
      await repo.recordEvent(tabId, { kind: 'working', tool: 'claude', text: null, meta: { event: 'UserPromptSubmit' }, fromHook: true });
      const { rearmed } = await repo.recordEvent(tabId, { kind: 'waiting_input', tool: 'claude', text: 'dois', meta: { event: 'Stop' }, fromHook: true });
      expect(rearmed).toBe(false);
    });

    it('is false when the wait before it had not been seen', async () => {
      await repo.recordEvent(tabId, { kind: 'waiting_input', tool: 'codex', text: 'um', meta: { event: 'agent-turn-complete' }, fromHook: true });
      const { rearmed } = await repo.recordEvent(tabId, { kind: 'waiting_input', tool: 'codex', text: 'dois', meta: { event: 'agent-turn-complete' }, fromHook: true });
      expect(rearmed).toBe(false);
    });

    it('is false for the first wait of a tab', async () => {
      const { rearmed } = await repo.recordEvent(tabId, { kind: 'waiting_input', tool: 'claude', text: 'um', meta: { event: 'Stop' }, fromHook: true });
      expect(rearmed).toBe(false);
    });
  });
```

In `apps/server/src/monitor/ingest.test.ts`, add at the end of the file:

```ts
describe('ingestHookEvent — an event the repository dropped', () => {
  it('ends as ignored: nothing is published, no card is touched, no suggestion check is scheduled', async () => {
    publish.mockClear();
    note.mockClear();
    schedule.mockClear();
    const current = tab({ state: 'idle', state_tool: 'claude' });
    const { r } = repos(current);
    (r.tabs.recordEvent as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ tab: current, event: null, rearmed: false, previousEvent: 'SessionEnd' });

    const res = await ingestHookEvent(r, log, { machineId: 'm1', tool: 'claude', session: 'th-t1', event: { hook_event_name: 'Stop', last_assistant_message: 'Pronto.' } });

    expect(res).toEqual({ ok: false, reason: 'ignored' });
    expect(publish).not.toHaveBeenCalled();
    expect(note).not.toHaveBeenCalled();
    expect(schedule).not.toHaveBeenCalled();
  });

  it('tells the repository the event came from a hook', async () => {
    const { r, recordEvent } = repos(tab({ state: 'working' }));
    await ingestHookEvent(r, log, { machineId: 'm1', tool: 'claude', session: 'th-t1', event: { hook_event_name: 'Stop', last_assistant_message: 'Pronto.' } });
    expect(recordEvent).toHaveBeenCalledWith('t1', expect.objectContaining({ kind: 'waiting_input', fromHook: true }));
  });

  it('logs a re-armed wait with the two event names and never the text', async () => {
    const info = vi.fn();
    const current = tab({ state: 'working' });
    const { r } = repos(current);
    (r.tabs.recordEvent as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ tab: tab({ ...current, state: 'waiting_input' }), event: {}, rearmed: true, previousEvent: 'PreToolUse' });

    await ingestHookEvent(r, { info, debug: vi.fn(), warn: vi.fn() } as never, { machineId: 'm1', tool: 'claude', session: 'th-t1', event: { hook_event_name: 'Stop', last_assistant_message: 'segredo do terminal' } });

    expect(info).toHaveBeenCalledWith({ tabId: 't1', tool: 'claude', previous: 'PreToolUse', event: 'Stop' }, 'monitor: seen wait re-armed');
    expect(JSON.stringify(info.mock.calls)).not.toContain('segredo do terminal');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `D th-f3-t2-red 'npm test -w @termhub/server -- src/db/repositories/tabs.db.test.ts src/monitor/ingest.test.ts'`
Expected: the new cases fail and every case that existed passes. In `tabs.db.test.ts`: the two "no alert" cases fail on `needsYou`, the two drop cases fail on `event` not being null, and the `rearmed` cases fail because `rearmed` is `undefined`. In `ingest.test.ts`: the three new cases fail.

If the database tests are reported as skipped, `TERMHUB_DB_TESTS` or `DATABASE_URL` did not reach the container: stop and report it.

- [ ] **Step 3: Implement in the repository**

In `apps/server/src/db/repositories/tabs.ts`, add to the imports:

```ts
import { decideWait, promptedByPerson } from '../../monitor/wait-decision.js';
```

Replace the JSDoc and the whole `recordEvent` method with:

```ts
  /**
   * Monitor: records the event and makes it the tab's current state; keeps only the newest events
   * per tab. Whether the event alerts is `decideWait`'s call (monitor/wait-decision.ts, spec
   * 2026-09-29): a wait the person already saw stays seen when the event continues it or brings
   * nothing new, and an event that is a late echo, or a reminder over a permission prompt, is
   * dropped — no row, no change, `event: null`. The text follows the same decision: a continuation
   * with no text of its own, or whose own text is only a reminder (`keepsWaitText`), keeps the
   * wait's text.
   *
   * `rearmed` says the wait alerts again although the person had seen the one before it and did not
   * ask for the turn in between: metadata for the log, so what re-arms in practice can be counted.
   */
  async recordEvent(
    tabId: string,
    event: {
      kind: TabState;
      tool: string;
      text: string | null;
      meta?: Record<string, unknown>;
      activity?: TabActivity;
      activityVerb?: string | null;
      continuesWait?: boolean;
      keepsWaitText?: boolean;
      /** the event came from a tool's hook; absent for what termhub writes itself */
      fromHook?: boolean;
    },
  ): Promise<{ tab: Tab; event: TabEvent | null; rearmed: boolean; previousEvent: string | null }> {
    const at = new Date();
    const [e, t, rearmed, previousEvent] = await this.db.$transaction(async (tx) => {
      // One event per tab at a time: two hooks fired together (PermissionRequest and
      // Notification(permission_prompt)) would otherwise both see the same `working` event as the
      // previous one and credit its interval twice. The second waits here and reads the first's event.
      await tx.$queryRaw`SELECT 1 FROM "tabs" WHERE "id" = ${tabId} FOR UPDATE`;
      const current = await tx.tab.findUnique({ where: { id: tabId }, select: { state: true, stateAt: true, stateSeenAt: true, stateText: true, activity: true } });
      const previous = await tx.tabEvent.findFirst({ where: { tabId }, orderBy: { createdAt: 'desc' }, select: { kind: true, createdAt: true, meta: true } });
      const previousName = eventName(previous?.meta);
      const currentlySeen = !!current?.stateSeenAt && !!current.stateAt && current.stateSeenAt >= current.stateAt;
      const outcome = decideWait(
        { state: current?.state ?? null, seen: currentlySeen, hasActivity: !!current?.activity },
        previousName,
        { kind: event.kind, continuesWait: !!event.continuesWait, keepsWaitText: !!event.keepsWaitText, fromHook: !!event.fromHook },
      );
      if (outcome.action === 'drop') {
        return [null, await tx.tab.findUniqueOrThrow({ where: { id: tabId } }), false, previousName] as const;
      }

      // A working interval ends here: credit it to the card this tab works on (a subtask's parent), once.
      if (previous?.kind === 'working') {
        const seconds = Math.min(MAX_WORKING_INTERVAL_S, Math.round((at.getTime() - previous.createdAt.getTime()) / 1000));
        if (seconds > 0) {
          await tx.$executeRaw`UPDATE "tasks" SET "active_seconds" = "active_seconds" + ${seconds} WHERE "id" IN (SELECT DISTINCT COALESCE("parent_id", "id") FROM "tasks" WHERE "tab_id" = ${tabId})`;
        }
      }
      // An unseen wait over one the person had seen, with no prompt of theirs in between.
      let rearmedNow = false;
      const isWait = event.kind === 'waiting_input' || event.kind === 'waiting_permission';
      if (isWait && outcome.seen === 'none' && !promptedByPerson(previousName) && current?.stateSeenAt) {
        const lastWait = await tx.tabEvent.findFirst({ where: { tabId, kind: { in: ['waiting_input', 'waiting_permission'] } }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
        rearmedNow = !!lastWait && current.stateSeenAt >= lastWait.createdAt;
      }
      // A continuation keeps the wait's own text when it has none of its own, or when its own text is
      // never the answer (`keepsWaitText`: Claude's idle_prompt, "Claude is waiting for your input", which
      // must not replace the Stop's last_assistant_message). Any other continuation's text — Cursor's
      // afterAgentResponse — replaces the wait's own, including a stale one from an earlier turn.
      const text = outcome.continuing && (event.text === null || event.keepsWaitText) ? (current?.stateText ?? event.text) : event.text;
      const ev = await tx.tabEvent.create({ data: { id: newId(), tabId, kind: event.kind, tool: event.tool, text: event.text, meta: (event.meta ?? {}) as object, createdAt: at } });
      const updated = await tx.tab.update({
        where: { id: tabId },
        data: {
          state: event.kind,
          stateText: text,
          stateTool: event.tool,
          stateAt: at,
          activity: event.kind === 'working' ? (event.activity ?? null) : null,
          activityVerb: event.kind === 'working' ? (event.activityVerb ?? null) : null,
          ...(outcome.seen === 'none' ? {} : { stateSeenAt: at }),
        },
      });
      await tx.$executeRaw`DELETE FROM "tab_events" WHERE "tab_id" = ${tabId} AND "id" NOT IN (SELECT "id" FROM "tab_events" WHERE "tab_id" = ${tabId} ORDER BY "created_at" DESC LIMIT ${EVENTS_KEPT_PER_TAB})`;
      return [ev, updated, rearmedNow, previousName] as const;
    });
    return { tab: mapTab(t), event: e ? mapTabEvent(e) : null, rearmed, previousEvent };
  }
```

Add this helper next to the other module-level helpers of the file (above the class):

```ts
/** The hook event name an event row carries in its meta (`{ event: 'Stop', … }`), or null. */
function eventName(meta: unknown): string | null {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null;
  const name = (meta as Record<string, unknown>).event;
  return typeof name === 'string' && name ? name : null;
}
```

- [ ] **Step 4: Implement in the ingest path**

In `apps/server/src/monitor/ingest.ts`:

Replace, in `ingestHookEvent`, the lines from `const updated = await recordInterpretation(…)` to the `return { ok: true, tab: updated };` with:

```ts
  const recorded = await recordInterpretation(repos, log, current, input.tool, interpreted);
  // Dropped by the wait rule (a late echo of a session that ended, a reminder over a permission
  // prompt): nothing changed, so no card opens or closes and no suggestion check is scheduled.
  if (recorded.dropped) return { ok: false, reason: 'ignored' };
  const updated = recorded.tab;
  // After the tab row (spec 2026-09-25 §4.2): a question opens a card in the project's chat, any
  // other event closes the one on screen. Never throws.
  await noteHookEvent(repos, log, updated, interpreted, waker);
  // Claude Code draws its suggested next prompt shortly after the turn ends: look in a few seconds, with the
  // Stop's own message and background count (spec 2026-09-26 TER-203 §4.2).
  if (input.tool === 'claude' && interpreted.meta.event === 'Stop') scheduleTabSuggestion(repos, log, updated.id, { context: interpreted.text, backgroundTasks: interpreted.backgroundTasks ?? 0 });
  if (isRateLimit(interpreted)) autoSwapOnLimit(repos, log, updated);
  return { ok: true, tab: updated };
```

Replace `recordInterpretation` and `applyState` with:

```ts
interface Recorded {
  tab: Tab;
  /** the wait rule dropped the event: the tab is as it was and nothing was published */
  dropped: boolean;
}

/** The tab's side of an interpreted event: the light activity path, or a recorded state. */
async function recordInterpretation(repos: Repositories, log: FastifyBaseLogger, tab: Tab, tool: HookTool, interpreted: Interpreted): Promise<Recorded> {
  // A tool (or spinner verb) change on a tab already working is not a state change: the light path
  // moves only the activity and its verb (no event row) and still tells the subscribers. The script
  // already posts only on a change; the equality check here is a defensive no-op for anything else.
  if (interpreted.activity !== undefined && tab.state === 'working' && interpreted.kind === 'working') {
    const verb = interpreted.verb ?? null;
    if (tab.activity === interpreted.activity && tab.activity_verb === verb) return { tab, dropped: false };
    // Nothing updated: the tab stopped working (or is gone) between the read above and this write —
    // the conditional UPDATE is what decides, not the row we read. The full path takes it from here.
    const updated = await repos.tabs.setActivity(tab.id, interpreted.activity, verb);
    if (updated) {
      const machine = await repos.machines.findById(tab.machine_id);
      // the verb came off the person's screen: only whether there was one is logged
      log.debug({ tabId: tab.id, machineId: machine?.id, activity: interpreted.activity, hasVerb: verb !== null }, 'monitor: tab activity');
      publishTabChange(updated, tab.project_id, machine);
      return { tab: updated, dropped: false };
    }
  }
  return recordState(repos, log, tab, tool, interpreted, true);
}

/**
 * Records the event for the tab, updates its state and publishes the change. For what termhub
 * writes itself (the reply route, the account swap): those are never dropped by the wait rule.
 */
export async function applyState(repos: Repositories, log: FastifyBaseLogger, tab: Tab, tool: string, next: Interpreted): Promise<Tab> {
  return (await recordState(repos, log, tab, tool, next, false)).tab;
}

async function recordState(repos: Repositories, log: FastifyBaseLogger, tab: Tab, tool: string, next: Interpreted, fromHook: boolean): Promise<Recorded> {
  const { tab: updated, event, rearmed, previousEvent } = await repos.tabs.recordEvent(tab.id, {
    kind: next.kind,
    tool,
    text: next.text,
    meta: next.meta,
    activity: next.activity,
    activityVerb: next.verb,
    ...(next.continuesWait ? { continuesWait: true } : {}),
    ...(next.keepsWaitText ? { keepsWaitText: true } : {}),
    ...(fromHook ? { fromHook: true } : {}),
  });
  if (!event) {
    log.debug({ tabId: tab.id, tool, kind: next.kind, previous: previousEvent }, 'monitor: event dropped');
    return { tab: updated, dropped: true };
  }
  const machine = await repos.machines.findById(tab.machine_id);
  log.info({ tabId: tab.id, machineId: machine?.id, tool, kind: next.kind, textLen: next.text?.length ?? 0 }, 'monitor: tab state');
  // What re-arms a wait the person had seen, counted: event names only (spec 2026-09-29 §4.5).
  if (rearmed) log.info({ tabId: tab.id, tool, previous: previousEvent, event: typeof next.meta.event === 'string' ? next.meta.event : null }, 'monitor: seen wait re-armed');
  publishTabChange(updated, tab.project_id, machine);
  return { tab: updated, dropped: false };
}
```

The `fromHook` key is sent only when true, so the existing assertions of `ingest.test.ts` that use `objectContaining` keep passing, and an exact match on the arguments of a call made by `applyState` does too.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `D th-f3-t2-green 'npm test -w @termhub/server -- src/db/repositories/tabs.db.test.ts src/monitor src/routes/tabs.test.ts src/routes/hooks.test.ts src/control'`
Expected: 0 failed, and the database tests are not skipped.

If a test that existed before this task fails, stop and report its name and output. Do not change it.

Run: `D th-f3-t2-types 'npm run typecheck -w @termhub/server'`
Expected: exit code 0. If a caller of `recordEvent` outside `ingest.ts` reads `.event` as never null, the typecheck names it: report it rather than casting.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/db/repositories/tabs.ts apps/server/src/db/repositories/tabs.db.test.ts apps/server/src/monitor/ingest.ts apps/server/src/monitor/ingest.test.ts
```
```bash
git commit -m "Monitor: a wait with nothing new in it does not alert again" -m "recordEvent asks decideWait under the tab's row lock. A reminder that finds no turn running is born seen; one over a permission prompt, and a wait that lands after the session ended, are dropped with no row and no change. A dropped hook event ends as ignored, so no card opens or closes for it. One log line, event names only, counts what still re-arms a wait the person had seen (TER-422, #208)." -m "Co-Authored-By: <the model writing this commit> <noreply@anthropic.com>"
```

---

### Task 3: A Cursor session that was never prompted is idle (TER-411)

**Files:**
- Modify: `apps/server/src/monitor/state.ts` (`interpretCursor`, the `sessionStart` case, and the JSDoc above the function)
- Test: `apps/server/src/monitor/state.test.ts` (the case at line 163)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `interpretHookEvent('cursor', { hook_event_name: 'sessionStart', … })` answers `{ kind: 'idle', text: null, meta: { event: 'sessionStart' } }`.

- [ ] **Step 1: Change the test first**

In `apps/server/src/monitor/state.test.ts`, find the assertion that expects Cursor's `sessionStart` to be `working` (line 163):

```ts
    expect(interpretHookEvent('cursor', { ...base, hook_event_name: 'sessionStart', is_background_agent: false })).toEqual({ kind: 'working', text: null, meta: { event: 'sessionStart' } });
```

Replace it with:

```ts
    // A session nobody prompted is not busy: nothing of Cursor's would ever take it out of working
    // (it has no idle notification), and a busy tab holds `wait_for_state` and the agent's update.
    expect(interpretHookEvent('cursor', { ...base, hook_event_name: 'sessionStart', is_background_agent: false })).toEqual({ kind: 'idle', text: null, meta: { event: 'sessionStart' } });
    expect(interpretHookEvent('cursor', { ...base, hook_event_name: 'beforeSubmitPrompt' })).toMatchObject({ kind: 'working', meta: { event: 'beforeSubmitPrompt' } });
```

If the title of the `it` that holds it says `sessionStart` is working, change the title to match.

- [ ] **Step 2: Run the test to verify it fails**

Run: `D th-f3-t3-red 'npm test -w @termhub/server -- src/monitor/state.test.ts'`
Expected: 1 failed: `kind` is `'working'`, expected `'idle'`.

- [ ] **Step 3: Implement**

In `apps/server/src/monitor/state.ts`, inside `interpretCursor`, replace:

```ts
    case 'sessionStart':
    case 'beforeSubmitPrompt':
      // the prompt is the user's content: only the fact that it is busy is kept
      return { kind: 'working', text: null, meta: { event: name } };
```

with:

```ts
    case 'sessionStart':
      // Not busy yet: a session nobody prompted would otherwise read as working for ever (Cursor has
      // no idle notification to take it out), holding `wait_for_state` and the agent's own update.
      return { kind: 'idle', text: null, meta: { event: name } };
    case 'beforeSubmitPrompt':
      // the prompt is the user's content: only the fact that it is busy is kept
      return { kind: 'working', text: null, meta: { event: name } };
```

In the JSDoc above `interpretCursor`, add as its last sentence: `A session starts idle: only \`beforeSubmitPrompt\` says a turn is running.`

Claude's `SessionStart` is not changed.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `D th-f3-t3-green 'npm test -w @termhub/server -- src/monitor src/routes/hooks.test.ts src/control src/agent'`
Expected: 0 failed. These are the suites that read a tab's state: the interpreter, the hooks route, `wait_for_state`, and the agent's update check.

If a test fails because it fed a Cursor `sessionStart` and expected `working`, update that expectation to `idle` and name the test in the commit body. Any other failure: stop and report.

Run: `D th-f3-t3-types 'npm run typecheck -w @termhub/server'`
Expected: exit code 0.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/monitor/state.ts apps/server/src/monitor/state.test.ts
```
```bash
git commit -m "Monitor: a Cursor session nobody prompted is idle, not working" -m "sessionStart read as working and none of Cursor's events took an unprompted session out of it, so the tab looked busy until a prompt or the exit, held wait_for_state for its whole timeout and counted as busy for the agent's update. Claude's SessionStart is unchanged. Closes #106 (TER-411)." -m "Co-Authored-By: <the model writing this commit> <noreply@anthropic.com>"
```

If Step 4 changed an expectation in another test file, add that file to the `git add` line.

---

### Task 4: The web clears both dots at once, and alerts once (TER-422, TER-414)

**Files:**
- Modify: `apps/web/src/lib/monitor.tsx` (`markSeen`, inside the `value` of `MonitorProvider`)
- Test: `apps/web/src/lib/monitor.test.tsx`, `apps/web/src/lib/needs-you.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks. `optimisticSeenAt(tab, now?)` and `entersNeedsYou(prev, next)` from `apps/web/src/lib/needs-you.ts`, unchanged.
- Produces: nothing other code uses.

Context. The monitor keeps two lists: `items` (tabs that reported a state, which the "precisando de você" list and the project count read) and `openTabs` (every open terminal tab, which the sidebar's per-agent dot reads). `markSeen` writes the optimistic `state_seen_at` to `items` only, so the per-agent dot stays orange until the server's push arrives, and for good when that push is lost.

This task uses the web Docker command without the database variables:

```bash
docker run --rm --name "<name>" -u "$(id -u):$(id -g)" -e HOME=/tmp -e npm_config_update_notifier=false -v "/home/pedrogoiania/termhub/.claude/worktrees/ter-1-407-roadmap:/w" -w /w node:22 sh -c '<cmd>'
```

- [ ] **Step 1: Write the failing tests**

In `apps/web/src/lib/monitor.test.tsx`, replace the two lines that mock the API:

```ts
const api = vi.hoisted(() => ({ tabs: vi.fn(), openTabs: vi.fn() }));
vi.mock('./api', () => ({ api: { monitor: api, tabs: {} } }));
```

with:

```ts
const api = vi.hoisted(() => ({ tabs: vi.fn(), openTabs: vi.fn(), seen: vi.fn() }));
vi.mock('./api', () => ({ api: { monitor: api, tabs: { seen: api.seen } } }));
```

Add at the end of the file:

```tsx
describe('MonitorProvider markSeen', () => {
  const waiting = (id: string) => tab(id, { state: 'waiting_input', state_at: '2026-09-23T10:00:00.000Z', state_seen_at: null });

  it('clears the dot in both lists at once, before the server answers', async () => {
    api.tabs.mockResolvedValue({ items: [item(waiting('t1'))] });
    api.openTabs.mockResolvedValue({ items: [item(waiting('t1')), item(tab('t2'))] });
    let release!: () => void;
    api.seen.mockReturnValue(new Promise<void>((resolve) => (release = () => resolve())));
    const m = mount();
    await waitFor(() => expect(m().openTabs).toHaveLength(2));
    await waitFor(() => expect(m().needsYou).toHaveLength(1));

    let pending!: Promise<void>;
    act(() => {
      pending = m().markSeen('t1');
    });

    const seenAt = m().items[0].tab.state_seen_at;
    expect(seenAt).not.toBeNull();
    expect(m().needsYou).toHaveLength(0);
    expect(m().openTabs.find((t) => t.id === 't1')?.state_seen_at).toBe(seenAt);
    expect(m().openTabs.find((t) => t.id === 't2')?.state_seen_at).toBeNull();

    await act(async () => {
      release();
      await pending;
    });
    expect(api.seen).toHaveBeenCalledWith('t1');
  });
});
```

In `apps/web/src/lib/needs-you.test.ts`, add inside the `describe` that holds the `entersNeedsYou` cases (the one with `'fires again when a new event re-arms a seen tab'`), as its last test:

```ts
  it('alerts once for a Cursor turn whose stop came before its answer, with the person looking in between', () => {
    // the three pushes the server sends (spec 2026-09-29 §6): the stop opens the wait, the seen mark
    // lands, and the answer continues the wait with the seen mark carried to its own time
    const stop = { state: 'waiting_input' as const, state_at: '2026-09-23T10:00:00.000Z', state_seen_at: null };
    const seen = { ...stop, state_seen_at: '2026-09-23T10:00:01.000Z' };
    const answer = { state: 'waiting_input' as const, state_at: '2026-09-23T10:00:02.000Z', state_seen_at: '2026-09-23T10:00:02.000Z' };
    const alerts = [entersNeedsYou({ state: 'working', state_at: '2026-09-23T09:59:00.000Z', state_seen_at: null }, stop), entersNeedsYou(stop, seen), entersNeedsYou(seen, answer)];
    expect(alerts).toEqual([true, false, false]);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `docker run --rm --name "th-f3-t4-red" -u "$(id -u):$(id -g)" -e HOME=/tmp -e npm_config_update_notifier=false -v "/home/pedrogoiania/termhub/.claude/worktrees/ter-1-407-roadmap:/w" -w /w node:22 sh -c 'npm test -w @termhub/web -- src/lib/monitor.test.tsx src/lib/needs-you.test.ts'`
Expected: 1 failed, `'clears the dot in both lists at once…'`: the open tab's `state_seen_at` is `null`. The `needs-you` case passes already: it pins, on the web side, what the server fix of `90024e01` made true.

- [ ] **Step 3: Implement**

In `apps/web/src/lib/monitor.tsx`, inside `markSeen`, right after the line that calls `setItems(…)`, add:

```ts
        // the sidebar's per-agent dot reads the open-tab list, not the state items
        setOpenTabs((list) => (list.some((t) => t.id === tabId) ? list.map((t) => (t.id === tabId ? { ...t, state_seen_at: seenAt } : t)) : list));
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `docker run --rm --name "th-f3-t4-green" -u "$(id -u):$(id -g)" -e HOME=/tmp -e npm_config_update_notifier=false -v "/home/pedrogoiania/termhub/.claude/worktrees/ter-1-407-roadmap:/w" -w /w node:22 sh -c 'npm test -w @termhub/web -- src/lib src/components/Sidebar src/components/ProjectRow && npm run typecheck -w @termhub/web'`
Expected: 0 failed, typecheck exit code 0. If a path of that command matches no test file, vitest says so and goes on; that is not a failure.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/monitor.tsx apps/web/src/lib/monitor.test.tsx apps/web/src/lib/needs-you.test.ts
```
```bash
git commit -m "Web: a seen tab clears its sidebar dot at once" -m "The optimistic seen mark went to the state items only, and the sidebar's per-agent dot reads the open-tab list: it stayed orange until the server's push, and for good when the push was lost. Also pins that a Cursor turn whose stop came before its answer alerts once on the web side (TER-422; closes #109, TER-414)." -m "Co-Authored-By: <the model writing this commit> <noreply@anthropic.com>"
```

---

## After the last task

The controller does what follows:

1. Runs the whole server suite against the throwaway database, the whole web suite, the typechecks and the builds, in Node 22.
2. Dispatches the whole-branch review.
3. Opens one pull request per task, stacked, and merges them in sequence as each `check` turns green, following every deploy to the health check.
4. Stops the database container `th-f3-db`.
5. After the deploy: reads the server log for `monitor: seen wait re-armed` and `monitor: event dropped`, which is the evidence the spec could not have.
6. Moves TER-411, TER-414 and TER-422 to "Feito".
