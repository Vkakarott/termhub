# Monitor: one wait, one alert (TER-422, TER-411, TER-414) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A reminder of a wait the person has already seen stops lighting the dot again, a Cursor session that was never prompted stops reading as busy, and the log says what else re-arms a seen wait.

**Architecture:** Two pure functions in one module. `decideWait` says what an incoming event is, from the tab's current row and its last ten event rows: a continuation, a reminder with nothing new, a session start that arrived after its own prompt, or a new request. `rearmOf` says when a wait alerts although the person had seen the one before it and asked for nothing since. `recordEvent` loads the rows under the tab's row lock and follows both. The interpreter changes in one place (Cursor's `sessionStart`), and the web's optimistic seen mark reaches the open-tab list.

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
- No migration. No change to `@termhub/agent` or to the hook script. `apps/server/src/monitor/state.ts` changes only in Cursor's `sessionStart`.
- Exact values: quiet events are `SessionStart` and `input`; prompt events are `UserPromptSubmit`, `beforeSubmitPrompt` and `input`; session-end events are `SessionEnd` and `sessionEnd`; the reorder window is `10_000` ms; the history is the last `10` event rows.
- Nothing is ever dropped because a session ended. The only dropped event is a Cursor `sessionStart` that finds the tab `working` by a `beforeSubmitPrompt` at most 10 s old.
- Every case `apps/server/src/db/repositories/tabs.db.test.ts` pins today keeps its result. If one of them fails, stop and report it; do not change it.
- The account swap's events and the permission events are not changed: they alert as they do today.
- Commit subject: imperative, at most 72 characters. The commit body ends with a `Co-Authored-By:` line that names the model writing the commit.

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `apps/server/src/monitor/wait-decision.ts` | Pure: what an incoming event is, and when a seen wait is re-armed | 1 |
| `apps/server/src/monitor/wait-decision.test.ts` | Its cases, no database | 1 |
| `apps/server/src/db/repositories/tabs.ts` | `recordEvent` loads the history, asks `decideWait`, drops or records, reports a re-arm | 2 |
| `apps/server/src/db/repositories/tabs.db.test.ts` | The same rules against Postgres | 2 |
| `apps/server/src/monitor/ingest.ts` | A dropped event ends as `ignored`; the re-arm log line | 2 |
| `apps/server/src/monitor/ingest.test.ts` | A dropped event opens no card and publishes nothing; the log carries names only | 2 |
| `apps/server/src/monitor/state.ts`, `state.test.ts` | Cursor `sessionStart` is `idle` | 3 |
| `apps/web/src/lib/monitor.tsx`, `monitor.test.tsx` | The optimistic seen mark reaches the open-tab list | 4 |
| `apps/web/src/lib/needs-you.test.ts` | Stop, seen, answer alerts once | 4 |

---

### Task 1: The rule, in one pure module

**Files:**
- Replace the whole content of: `apps/server/src/monitor/wait-decision.ts`
- Replace the whole content of: `apps/server/src/monitor/wait-decision.test.ts`

Both files exist, from a first version of this task (commit `c9a10b21`) that followed a design a review then changed. Nothing imports them yet. Do not keep anything of the first version: its function took other arguments and had a rule that is gone.

**Interfaces:**
- Consumes: `TabState` from `apps/server/src/db/repositories/types.ts` (`'working' | 'waiting_input' | 'waiting_permission' | 'idle' | 'error'`).
- Produces, for Task 2:
  - `decideWait(current: WaitCurrent, history: HistoryRow[], event: WaitEvent): WaitOutcome`
  - `rearmOf(current: WaitCurrent, history: HistoryRow[], event: WaitEvent, outcome: WaitOutcome): Rearm | null`
  - `interface WaitCurrent { state: TabState | null; seen: boolean; hasActivity: boolean; seenAgeMs: number | null }`
  - `interface HistoryRow { kind: TabState; event: string | null; ageMs: number; backgroundTasks: boolean }`
  - `interface WaitEvent { kind: TabState; name: string | null; continuesWait: boolean; keepsWaitText: boolean }`
  - `type WaitOutcome = { action: 'drop'; reason: 'session_start_during_turn' } | { action: 'record'; seen: 'carry' | 'born' | 'none'; continuing: boolean }`
  - `interface Rearm { previous: string | null; background: boolean; afterSessionEnd: boolean }`
  - `HISTORY_ROWS = 10`, `REORDER_WINDOW_MS = 10_000`

- [ ] **Step 1: Write the failing tests**

Replace the whole content of `apps/server/src/monitor/wait-decision.test.ts` with:

```ts
import { describe, expect, it } from 'vitest';
import { REORDER_WINDOW_MS, decideWait, rearmOf, type HistoryRow, type WaitCurrent, type WaitEvent, type WaitOutcome } from './wait-decision.js';

const current = (over: Partial<WaitCurrent> = {}): WaitCurrent => ({ state: null, seen: false, hasActivity: false, seenAgeMs: null, ...over });
const event = (over: Partial<WaitEvent> = {}): WaitEvent => ({ kind: 'waiting_input', name: 'Stop', continuesWait: false, keepsWaitText: false, ...over });
/** One event row. `ageMs` is how long ago it was written; the history is newest first. */
const row = (kind: HistoryRow['kind'], name: string | null, ageMs = 1_000, backgroundTasks = false): HistoryRow => ({ kind, event: name, ageMs, backgroundTasks });

/** Claude's idle_prompt: the one event that is only a reminder. */
const reminder = event({ name: 'Notification', continuesWait: true, keepsWaitText: true });
/** Cursor's stop or afterAgentResponse: continues a wait, and may bring the answer. */
const continuation = event({ name: 'stop', continuesWait: true });

const NEW: WaitOutcome = { action: 'record', seen: 'none', continuing: false };
const BORN: WaitOutcome = { action: 'record', seen: 'born', continuing: false };

describe('decideWait — events that are not a wait', () => {
  it('records working, idle and error as they come, with no seen mark', () => {
    for (const kind of ['working', 'idle', 'error'] as const) {
      expect(decideWait(current({ state: 'waiting_input', seen: true }), [row('waiting_input', 'Stop')], event({ kind, name: 'UserPromptSubmit' }))).toEqual(NEW);
    }
  });

  it('never drops anything because a session ended', () => {
    const ended = [row('idle', 'SessionEnd'), row('working', 'UserPromptSubmit', 5_000)];
    expect(decideWait(current({ state: 'idle' }), ended, event())).toEqual(NEW);
    expect(decideWait(current({ state: 'idle' }), ended, event({ kind: 'waiting_permission', name: 'PermissionRequest' }))).toEqual(NEW);
    expect(decideWait(current({ state: 'idle' }), [row('idle', 'sessionEnd')], continuation)).toEqual(NEW);
    // Codex in a tab where Claude ended: its only event is a wait
    expect(decideWait(current({ state: 'idle' }), ended, event({ name: 'agent-turn-complete' }))).toEqual(NEW);
  });
});

describe('decideWait — what tabs.db.test.ts pins today', () => {
  it('a continuation of a seen waiting_input carries the seen mark', () => {
    expect(decideWait(current({ state: 'waiting_input', seen: true }), [row('waiting_input', 'afterAgentResponse')], continuation)).toEqual({ action: 'record', seen: 'carry', continuing: true });
    expect(decideWait(current({ state: 'waiting_input', seen: true }), [row('waiting_input', 'Stop')], reminder)).toEqual({ action: 'record', seen: 'carry', continuing: true });
  });

  it('a continuation of an unseen waiting_input stays unseen', () => {
    expect(decideWait(current({ state: 'waiting_input' }), [row('waiting_input', 'Stop')], continuation)).toEqual({ action: 'record', seen: 'none', continuing: true });
  });

  it('a wait that does not say it continues is a new one, even right after a seen wait (the next Codex turn)', () => {
    expect(decideWait(current({ state: 'waiting_input', seen: true }), [row('waiting_input', 'agent-turn-complete')], event({ name: 'agent-turn-complete' }))).toEqual(NEW);
  });

  it('a permission prompt is always a new request', () => {
    expect(decideWait(current({ state: 'waiting_input', seen: true }), [row('waiting_input', 'Stop')], event({ kind: 'waiting_permission', name: 'PermissionRequest' }))).toEqual(NEW);
    expect(decideWait(current({ state: 'waiting_permission', seen: true }), [row('waiting_permission', 'PermissionRequest')], event({ kind: 'waiting_permission', name: 'Notification' }))).toEqual(NEW);
  });

  it('a continuation that finds the tab working opens the wait (Cursor: a lost answer, then stop)', () => {
    expect(decideWait(current({ state: 'working' }), [row('working', 'beforeSubmitPrompt')], continuation)).toEqual(NEW);
    expect(decideWait(current({ state: 'working' }), [row('working', null)], continuation)).toEqual(NEW);
    expect(decideWait(current({ state: 'working' }), [], continuation)).toEqual(NEW);
  });
});

describe('decideWait — a reminder never opens an alert by itself', () => {
  it('over a permission wait, it takes the tab to waiting_input and carries the seen mark', () => {
    // an Esc on the dialog sends no Stop: the reminder is what says Claude is back at its prompt
    expect(decideWait(current({ state: 'waiting_permission', seen: true }), [row('waiting_permission', 'Notification')], reminder)).toEqual({ action: 'record', seen: 'carry', continuing: false });
  });

  it('over a permission wait the person has not seen, it stays unseen', () => {
    expect(decideWait(current({ state: 'waiting_permission' }), [row('waiting_permission', 'PermissionRequest')], reminder)).toEqual(NEW);
  });

  it('is born seen after /clear: a wait, the session end, the session start', () => {
    const cleared = [row('working', 'SessionStart'), row('idle', 'SessionEnd', 1_100), row('waiting_input', 'Stop', 90_000)];
    expect(decideWait(current({ state: 'working' }), cleared, reminder)).toEqual(BORN);
  });

  it('is born seen after a reply typed from termhub that started no turn', () => {
    expect(decideWait(current({ state: 'working' }), [row('working', 'input'), row('waiting_input', 'Stop', 5_000)], reminder)).toEqual(BORN);
  });

  it('is born seen on a session that was never asked anything', () => {
    expect(decideWait(current({ state: 'working' }), [row('working', 'SessionStart')], reminder)).toEqual(BORN);
  });

  it('alerts when a turn was running: the Stop was lost and this is what ends it', () => {
    expect(decideWait(current({ state: 'working' }), [row('working', 'UserPromptSubmit'), row('waiting_input', 'Stop', 9_000)], reminder)).toEqual(NEW);
    expect(decideWait(current({ state: 'working' }), [row('working', 'PreToolUse'), row('waiting_input', 'Stop', 9_000)], reminder)).toEqual(NEW);
  });

  it('alerts after a compaction in the middle of a turn: the session start is quiet, what came before it is not', () => {
    const compacted = [row('working', 'SessionStart'), row('working', 'UserPromptSubmit', 60_000), row('waiting_input', 'Stop', 90_000)];
    expect(decideWait(current({ state: 'working' }), compacted, reminder)).toEqual(NEW);
    const afterTools = [row('working', 'SessionStart'), row('working', 'PreToolUse', 60_000), row('waiting_input', 'Stop', 90_000)];
    expect(decideWait(current({ state: 'working' }), afterTools, reminder)).toEqual(NEW);
  });

  it('alerts when tool calls followed a quiet event: the light path leaves no row, only the activity', () => {
    expect(decideWait(current({ state: 'working', hasActivity: true }), [row('working', 'SessionStart'), row('waiting_input', 'Stop', 9_000)], reminder)).toEqual(NEW);
  });

  it('alerts when nothing is known about the working state', () => {
    expect(decideWait(current({ state: 'working' }), [], reminder)).toEqual(NEW);
    expect(decideWait(current({ state: 'working' }), [row('working', null)], reminder)).toEqual(NEW);
  });

  it('alerts when an error sits between the quiet row and the last wait', () => {
    expect(decideWait(current({ state: 'working' }), [row('working', 'SessionStart'), row('error', 'StopFailure', 5_000), row('waiting_input', 'Stop', 9_000)], reminder)).toEqual(NEW);
  });

  it('is born seen on an idle tab', () => {
    expect(decideWait(current({ state: 'idle' }), [row('idle', 'SessionEnd')], reminder)).toEqual(BORN);
  });

  it('alerts on a tab in error or with no state, as today', () => {
    expect(decideWait(current({ state: 'error' }), [row('error', 'StopFailure')], reminder)).toEqual(NEW);
    expect(decideWait(current({ state: null }), [], reminder)).toEqual(NEW);
  });

  it('only a reminder is born seen: a Cursor continuation after a quiet start is a new wait', () => {
    expect(decideWait(current({ state: 'working' }), [row('working', 'SessionStart')], continuation)).toEqual(NEW);
  });
});

describe('decideWait — a Cursor session start that arrives after its own prompt', () => {
  const sessionStart = event({ kind: 'idle', name: 'sessionStart' });

  it('is dropped while the prompt is fresh: the two hooks were posted together', () => {
    expect(decideWait(current({ state: 'working' }), [row('working', 'beforeSubmitPrompt', 200)], sessionStart)).toEqual({ action: 'drop', reason: 'session_start_during_turn' });
    expect(decideWait(current({ state: 'working' }), [row('working', 'beforeSubmitPrompt', REORDER_WINDOW_MS)], sessionStart)).toEqual({ action: 'drop', reason: 'session_start_during_turn' });
  });

  it('is recorded once the prompt is older than the window: that session is a new one', () => {
    expect(decideWait(current({ state: 'working' }), [row('working', 'beforeSubmitPrompt', REORDER_WINDOW_MS + 1)], sessionStart)).toEqual(NEW);
  });

  it('is recorded when the tab is not working, or works for another reason', () => {
    expect(decideWait(current({ state: 'waiting_input', seen: true }), [row('waiting_input', 'stop')], sessionStart)).toEqual(NEW);
    expect(decideWait(current({ state: 'working' }), [row('working', 'PreToolUse', 200)], sessionStart)).toEqual(NEW);
    expect(decideWait(current({ state: null }), [], sessionStart)).toEqual(NEW);
  });

  it("does not touch Claude's SessionStart, which is a working event", () => {
    expect(decideWait(current({ state: 'working' }), [row('working', 'beforeSubmitPrompt', 200)], event({ kind: 'working', name: 'SessionStart' }))).toEqual(NEW);
  });
});

describe('rearmOf — a wait alerts although the person had seen the last one and asked for nothing since', () => {
  it('reports an answer nobody asked for, and that the seen wait had background tasks', () => {
    const history = [row('working', 'PreToolUse', 1_000), row('waiting_input', 'Stop', 60_000, true)];
    expect(rearmOf(current({ state: 'working', seenAgeMs: 30_000 }), history, event(), NEW)).toEqual({ previous: 'PreToolUse', background: true, afterSessionEnd: false });
  });

  it('reports a wait that follows a seen wait directly (the next Codex turn)', () => {
    const history = [row('waiting_input', 'agent-turn-complete', 60_000)];
    expect(rearmOf(current({ state: 'waiting_input', seen: true, seenAgeMs: 30_000 }), history, event({ name: 'agent-turn-complete' }), NEW)).toEqual({ previous: 'agent-turn-complete', background: false, afterSessionEnd: false });
  });

  it('reports a wait that lands after the session ended', () => {
    const history = [row('idle', 'SessionEnd', 2_000), row('waiting_input', 'Stop', 60_000)];
    expect(rearmOf(current({ state: 'idle', seenAgeMs: 30_000 }), history, event(), NEW)).toEqual({ previous: 'SessionEnd', background: false, afterSessionEnd: true });
  });

  it('is silent when the person asked for the turn', () => {
    for (const prompt of ['UserPromptSubmit', 'beforeSubmitPrompt', 'input']) {
      const history = [row('working', prompt, 5_000), row('waiting_input', 'Stop', 60_000)];
      expect(rearmOf(current({ state: 'working', seenAgeMs: 30_000 }), history, event(), NEW)).toBeNull();
    }
  });

  it('is silent for a turn of the person that had a permission prompt approved on the way', () => {
    const history = [row('working', 'PreToolUse', 1_000), row('waiting_permission', 'Notification', 4_000), row('waiting_permission', 'PermissionRequest', 4_100), row('working', 'UserPromptSubmit', 9_000), row('waiting_input', 'Stop', 60_000)];
    expect(rearmOf(current({ state: 'working', seenAgeMs: 3_000 }), history, event(), NEW)).toBeNull();
  });

  it('is silent when the last wait had not been seen', () => {
    const history = [row('waiting_input', 'agent-turn-complete', 60_000)];
    expect(rearmOf(current({ state: 'waiting_input', seenAgeMs: 90_000 }), history, event(), NEW)).toBeNull();
    expect(rearmOf(current({ state: 'waiting_input', seenAgeMs: null }), history, event(), NEW)).toBeNull();
  });

  it('counts a look at the very moment of the wait as seen', () => {
    expect(rearmOf(current({ state: 'waiting_input', seen: true, seenAgeMs: 60_000 }), [row('waiting_input', 'Stop', 60_000)], event(), NEW)).not.toBeNull();
  });

  it('is silent for the first wait of a tab, and when no wait is in the rows that are kept', () => {
    expect(rearmOf(current({ seenAgeMs: null }), [], event(), NEW)).toBeNull();
    expect(rearmOf(current({ state: 'working', seenAgeMs: 1_000 }), [row('working', 'PreToolUse')], event(), NEW)).toBeNull();
  });

  it('is silent when the event does not alert: not a wait, seen from the start, or dropped', () => {
    const history = [row('waiting_input', 'Stop', 60_000)];
    const seen = current({ state: 'waiting_input', seen: true, seenAgeMs: 30_000 });
    expect(rearmOf(seen, history, event({ kind: 'working', name: 'PreToolUse' }), NEW)).toBeNull();
    expect(rearmOf(seen, history, reminder, { action: 'record', seen: 'carry', continuing: true })).toBeNull();
    expect(rearmOf(seen, history, reminder, BORN)).toBeNull();
    expect(rearmOf(seen, history, event({ kind: 'idle', name: 'sessionStart' }), { action: 'drop', reason: 'session_start_during_turn' })).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `D th-f3-t1-red 'npm test -w @termhub/server -- src/monitor/wait-decision.test.ts'`
Expected: FAIL. The module still exports the first version: `rearmOf` and `REORDER_WINDOW_MS` are not exported, and `decideWait` takes other arguments.

- [ ] **Step 3: Write the implementation**

Replace the whole content of `apps/server/src/monitor/wait-decision.ts` with:

```ts
import type { TabState } from '../db/repositories/types.js';

/**
 * What an incoming event is, for the "needs you" rule (spec 2026-09-29 one wait, one alert).
 *
 * A tab needs the person when it waits and the wait is newer than the last time they looked. Every
 * recorded event moves the wait's time, so an event that brings nothing new has to say so, or a wait
 * the person already saw lights up again. The interpreters know part of it (`continuesWait`,
 * `keepsWaitText`); the rest depends on where the tab is and how it got there, which only its own
 * row and its last events can tell. Pure: `recordEvent` reads both under its lock and asks here.
 *
 * Nothing is ever dropped because a session ended. Codex sends nothing but waits, and a second
 * session in the same tmux session can end while the first still works: a rule that guessed which
 * session an event belongs to could silence a live agent.
 */

/** Events that put a tab in `working` with no turn of the agent behind them. */
const QUIET_EVENTS: ReadonlySet<string> = new Set(['SessionStart', 'input']);

/** Events that prove the person asked for the turn that followed. */
const PROMPT_EVENTS: ReadonlySet<string> = new Set(['UserPromptSubmit', 'beforeSubmitPrompt', 'input']);

/** Events that say the tool's session ended. */
const SESSION_END_EVENTS: ReadonlySet<string> = new Set(['SessionEnd', 'sessionEnd']);

/** How many event rows, newest first, the decision reads. */
export const HISTORY_ROWS = 10;

/**
 * Two hooks fired together can arrive in either order: each is posted in the background, and the
 * hook's curl gives up after 5 s. Twice that is how late the first of a pair can be.
 */
export const REORDER_WINDOW_MS = 10_000;

export interface WaitCurrent {
  state: TabState | null;
  /** the person has seen the tab's current state (`state_seen_at >= state_at`) */
  seen: boolean;
  /** the tab has an activity: a tool call went through the light path, which writes no event row */
  hasActivity: boolean;
  /** how long ago the person last looked, or null when they never did */
  seenAgeMs: number | null;
}

/** One event row of the tab. The rows are given newest first. */
export interface HistoryRow {
  kind: TabState;
  /** the hook event name in the row's meta, or null */
  event: string | null;
  /** how long ago the row was written */
  ageMs: number;
  /** a Claude Stop that left background tasks running */
  backgroundTasks: boolean;
}

export interface WaitEvent {
  kind: TabState;
  /** the hook event name in the event's meta, or null */
  name: string | null;
  continuesWait: boolean;
  keepsWaitText: boolean;
}

export type WaitOutcome =
  | { action: 'drop'; reason: 'session_start_during_turn' }
  /**
   * `carry`: the person had seen the wait this one follows. `born`: a wait with nothing new in it,
   * seen from its first moment. `none`: a request the person has not seen.
   * `continuing`: the wait's own text is kept when the event has none or brings only a reminder.
   */
  | { action: 'record'; seen: 'carry' | 'born' | 'none'; continuing: boolean };

/** What the log says when a wait the person had seen is re-armed with no prompt of theirs. */
export interface Rearm {
  /** the event name of the tab's last row */
  previous: string | null;
  /** the wait the person had seen was a Stop with background tasks running */
  background: boolean;
  /** the tab's last row is a session end: the event landed after it */
  afterSessionEnd: boolean;
}

const NEW: WaitOutcome = { action: 'record', seen: 'none', continuing: false };

const isWait = (kind: TabState | null): boolean => kind === 'waiting_input' || kind === 'waiting_permission';
const isQuiet = (row: HistoryRow): boolean => row.kind === 'working' && row.event !== null && QUIET_EVENTS.has(row.event);

/**
 * The tab went to `working` with no turn behind it: its last row is quiet, and so is everything
 * back to the last wait (a session end in between is `idle`, and counts as nothing). A prompt or a
 * tool call on the way means a turn was running — a session start in the middle of a turn is what
 * a compaction sends.
 */
function noTurnSinceLastWait(history: HistoryRow[]): boolean {
  const last = history[0];
  if (!last || !isQuiet(last)) return false;
  for (const row of history) {
    if (isQuiet(row) || row.kind === 'idle') continue;
    return isWait(row.kind);
  }
  return true; // nothing but quiet rows in what is kept: a session nobody asked anything
}

export function decideWait(current: WaitCurrent, history: HistoryRow[], event: WaitEvent): WaitOutcome {
  const last = history[0] ?? null;

  // Cursor's launch with a prompt fires sessionStart and beforeSubmitPrompt together. When the
  // prompt lands first, the session start must not take the tab out of the turn it announces.
  if (event.kind === 'idle' && event.name === 'sessionStart' && current.state === 'working' && last?.event === 'beforeSubmitPrompt' && last.ageMs <= REORDER_WINDOW_MS) {
    return { action: 'drop', reason: 'session_start_during_turn' };
  }

  if (!isWait(event.kind)) return NEW;

  if (event.continuesWait && event.kind === 'waiting_input' && current.state === 'waiting_input') {
    return { action: 'record', seen: current.seen ? 'carry' : 'none', continuing: true };
  }

  // A reminder (Claude's idle_prompt) is news only when it is the first sign that a turn ended.
  if (event.continuesWait && event.keepsWaitText) {
    // The dialog is gone and Claude is back at its prompt (an Esc sends no Stop): the state is
    // corrected, and a prompt the person had seen does not alert again.
    if (current.state === 'waiting_permission') return { action: 'record', seen: current.seen ? 'carry' : 'none', continuing: false };
    if (current.state === 'idle') return { action: 'record', seen: 'born', continuing: false };
    if (current.state === 'working' && !current.hasActivity && noTurnSinceLastWait(history)) return { action: 'record', seen: 'born', continuing: false };
  }

  return NEW;
}

/**
 * Whether this event re-arms a wait the person had seen, with no prompt of theirs since: the last
 * `waiting_input` row is at or before their last look, and no prompt event came after it. Permission
 * rows are passed over — a turn of the person with a prompt approved on the way is not a re-arm.
 */
export function rearmOf(current: WaitCurrent, history: HistoryRow[], event: WaitEvent, outcome: WaitOutcome): Rearm | null {
  if (outcome.action !== 'record' || outcome.seen !== 'none' || !isWait(event.kind)) return null;
  if (current.seenAgeMs === null) return null;
  const last = history[0] ?? null;
  for (const row of history) {
    if (row.event !== null && PROMPT_EVENTS.has(row.event)) return null;
    if (row.kind !== 'waiting_input') continue;
    if (current.seenAgeMs > row.ageMs) return null; // their last look is older than that wait
    return { previous: last?.event ?? null, background: row.backgroundTasks, afterSessionEnd: last !== null && last.event !== null && SESSION_END_EVENTS.has(last.event) };
  }
  return null;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `D th-f3-t1-green 'npm test -w @termhub/server -- src/monitor/wait-decision.test.ts'`
Expected: every test passes, 0 failed.

Run: `D th-f3-t1-types 'npm run typecheck -w @termhub/server'`
Expected: exit code 0.

If a test case and the implementation of this brief disagree, do not bend either one: report the case, what the code answers and what the test expects.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/monitor/wait-decision.ts apps/server/src/monitor/wait-decision.test.ts
```
```bash
git commit -m "Monitor: read the tab's last events to decide what a wait is" -m "A review of the first version found that dropping a wait after a session end would silence Codex in a tab where Claude had ended, and that a session start is not quiet when a compaction sends it in the middle of a turn. The rule now reads the last ten rows: nothing is dropped because a session ended, a reminder over a permission prompt corrects the state and carries the seen mark, and a re-arm is judged from the last waiting_input and the prompts after it. Nothing calls it yet (TER-422)." -m "Co-Authored-By: <the model writing this commit> <noreply@anthropic.com>"
```

---

### Task 2: `recordEvent` follows the rule

**Files:**
- Modify: `apps/server/src/db/repositories/tabs.ts` (`recordEvent`, lines 135-180, and the import block)
- Modify: `apps/server/src/monitor/ingest.ts` (`ingestHookEvent`, `recordInterpretation`, `applyState`)
- Test: `apps/server/src/db/repositories/tabs.db.test.ts`, `apps/server/src/monitor/ingest.test.ts`

**Interfaces:**
- Consumes, from Task 1, exactly as listed there: `decideWait`, `rearmOf`, `HISTORY_ROWS`, `HistoryRow`, `Rearm`.
- Produces:
  - `TabsRepository.recordEvent(tabId, event)` takes the same event as today and answers `{ tab: Tab; event: TabEvent | null; rearm: Rearm | null }`. `event` is null when the event was dropped; the tab is then the row as it was.
  - `applyState(repos, log, tab, tool, next): Promise<Tab>` keeps its signature. Its callers (`routes/tabs.ts`, `control/account-swap.ts`) do not change.

- [ ] **Step 1: Write the failing database tests**

In `apps/server/src/db/repositories/tabs.db.test.ts`, add this block right after the `describe('recordEvent — the same wait …')` block (before `describe('activity', …)`):

```ts
  describe('recordEvent — a reminder with nothing new in it does not alert (spec 2026-09-29)', () => {
    const idlePrompt = { kind: 'waiting_input' as const, tool: 'claude', text: 'Claude is waiting for your input', meta: { event: 'Notification', type: 'idle_prompt' }, continuesWait: true, keepsWaitText: true };
    const stop = (text: string) => ({ kind: 'waiting_input' as const, tool: 'claude', text, meta: { event: 'Stop' } });
    const working = (name: string) => ({ kind: 'working' as const, tool: 'claude', text: null, meta: { event: name } });

    it('/clear on a seen wait, then idle_prompt: the tab waits again, already seen', async () => {
      await repo.recordEvent(tabId, stop('Pronto.'));
      await repo.markSeen(tabId);
      await repo.recordEvent(tabId, { kind: 'idle', tool: 'claude', text: null, meta: { event: 'SessionEnd', reason: 'clear' } });
      await repo.recordEvent(tabId, working('SessionStart'));
      const { tab, event, rearm } = await repo.recordEvent(tabId, idlePrompt);
      expect(event).not.toBeNull();
      expect(tab.state).toBe('waiting_input');
      expect(needsYou(tab)).toBe(false);
      expect(tab.state_seen_at).toBe(tab.state_at);
      expect(rearm).toBeNull();
    });

    it('a reply typed from termhub that started no turn, then idle_prompt: no alert', async () => {
      await repo.recordEvent(tabId, stop('Pronto.'));
      await repo.recordEvent(tabId, { kind: 'working', tool: 'claude', text: null, meta: { event: 'input', via: 'termhub' } });
      const { tab } = await repo.recordEvent(tabId, idlePrompt);
      expect(tab.state).toBe('waiting_input');
      expect(needsYou(tab)).toBe(false);
    });

    it('a turn whose Stop was lost: idle_prompt is what ends it, and it alerts', async () => {
      await repo.recordEvent(tabId, stop('antes'));
      await repo.markSeen(tabId);
      await repo.recordEvent(tabId, working('UserPromptSubmit'));
      const { tab } = await repo.recordEvent(tabId, idlePrompt);
      expect(tab.state).toBe('waiting_input');
      expect(needsYou(tab)).toBe(true);
    });

    it('a compaction in the middle of a turn, then a lost Stop: idle_prompt still alerts', async () => {
      await repo.recordEvent(tabId, stop('antes'));
      await repo.markSeen(tabId);
      await repo.recordEvent(tabId, working('UserPromptSubmit'));
      await repo.recordEvent(tabId, working('SessionStart'));
      const { tab } = await repo.recordEvent(tabId, idlePrompt);
      expect(needsYou(tab)).toBe(true);
    });

    it('tool calls after a quiet start leave no row, only the activity: idle_prompt alerts', async () => {
      await repo.recordEvent(tabId, working('SessionStart'));
      await repo.setActivity(tabId, 'coding', null);
      const { tab } = await repo.recordEvent(tabId, idlePrompt);
      expect(needsYou(tab)).toBe(true);
    });

    it('idle_prompt over a permission prompt the person saw: the tab waits for input, still seen', async () => {
      await repo.recordEvent(tabId, { kind: 'waiting_permission', tool: 'claude', text: 'Allow Bash?', meta: { event: 'Notification', type: 'permission_prompt' } });
      await repo.markSeen(tabId);
      const { tab, event } = await repo.recordEvent(tabId, idlePrompt);
      expect(event).not.toBeNull();
      expect(tab.state).toBe('waiting_input');
      expect(tab.state_text).toBe('Claude is waiting for your input');
      expect(needsYou(tab)).toBe(false);
    });

    it('idle_prompt over a permission prompt the person did not see: still needs them', async () => {
      await repo.recordEvent(tabId, { kind: 'waiting_permission', tool: 'claude', text: 'Allow Bash?', meta: { event: 'Notification', type: 'permission_prompt' } });
      const { tab } = await repo.recordEvent(tabId, idlePrompt);
      expect(tab.state).toBe('waiting_input');
      expect(needsYou(tab)).toBe(true);
    });

    it('nothing is dropped because a session ended: Codex in a tab where Claude ended still alerts, turn after turn', async () => {
      await repo.recordEvent(tabId, working('UserPromptSubmit'));
      await repo.recordEvent(tabId, { kind: 'idle', tool: 'claude', text: null, meta: { event: 'SessionEnd', reason: 'exit' } });
      const codex = (text: string) => ({ kind: 'waiting_input' as const, tool: 'codex', text, meta: { event: 'agent-turn-complete' } });
      const first = await repo.recordEvent(tabId, codex('um'));
      expect(first.event).not.toBeNull();
      expect(needsYou(first.tab)).toBe(true);
      await repo.markSeen(tabId);
      const second = await repo.recordEvent(tabId, codex('dois'));
      expect(second.event).not.toBeNull();
      expect(needsYou(second.tab)).toBe(true);
      expect(second.tab.state_text).toBe('dois');
    });

    it("the account swap's own wait after the session ended is recorded and alerts", async () => {
      await repo.recordEvent(tabId, { kind: 'idle', tool: 'claude', text: null, meta: { event: 'SessionEnd' } });
      const { tab, event } = await repo.recordEvent(tabId, { kind: 'waiting_input', tool: 'claude', text: 'Conta trocada', meta: { event: 'AccountSwap' } });
      expect(event).not.toBeNull();
      expect(needsYou(tab)).toBe(true);
    });
  });

  describe('recordEvent — a Cursor session start that arrives after its own prompt', () => {
    it('is dropped: no row, the tab keeps working, and the working interval is not credited twice', async () => {
      const { tab: prompted } = await repo.recordEvent(tabId, { kind: 'working', tool: 'cursor', text: null, meta: { event: 'beforeSubmitPrompt' } });
      const before = await repo.listEvents(tabId);
      const { tab, event, rearm } = await repo.recordEvent(tabId, { kind: 'idle', tool: 'cursor', text: null, meta: { event: 'sessionStart' } });
      expect(event).toBeNull();
      expect(rearm).toBeNull();
      expect(tab.state).toBe('working');
      expect(tab.state_at).toBe(prompted.state_at);
      expect((await repo.listEvents(tabId)).map((e) => e.id)).toEqual(before.map((e) => e.id));
    });

    it('is recorded on a tab that is not in a fresh turn', async () => {
      await repo.recordEvent(tabId, { kind: 'waiting_input', tool: 'cursor', text: 'Pronto.', meta: { event: 'afterAgentResponse' }, continuesWait: true });
      const { tab, event } = await repo.recordEvent(tabId, { kind: 'idle', tool: 'cursor', text: null, meta: { event: 'sessionStart' } });
      expect(event).not.toBeNull();
      expect(tab.state).toBe('idle');
    });
  });

  describe('recordEvent — reports a wait the person had seen that alerts again with no prompt of theirs', () => {
    const stop = (text: string, background = 0) => ({ kind: 'waiting_input' as const, tool: 'claude', text, meta: background > 0 ? { event: 'Stop', background_tasks: background } : { event: 'Stop' } });

    it('an answer nobody asked for, after a Stop that left background tasks running', async () => {
      await repo.recordEvent(tabId, stop('um', 2));
      await repo.markSeen(tabId);
      await repo.recordEvent(tabId, { kind: 'working', tool: 'claude', text: null, meta: { event: 'PreToolUse', tool: 'Bash' } });
      const { rearm, tab } = await repo.recordEvent(tabId, stop('dois'));
      expect(needsYou(tab)).toBe(true);
      expect(rearm).toEqual({ previous: 'PreToolUse', background: true, afterSessionEnd: false });
    });

    it('a wait that lands after the session ended', async () => {
      await repo.recordEvent(tabId, stop('um'));
      await repo.markSeen(tabId);
      await repo.recordEvent(tabId, { kind: 'idle', tool: 'claude', text: null, meta: { event: 'SessionEnd' } });
      const { rearm, tab } = await repo.recordEvent(tabId, stop('dois'));
      expect(needsYou(tab)).toBe(true);
      expect(rearm).toEqual({ previous: 'SessionEnd', background: false, afterSessionEnd: true });
    });

    it('is null when the person asked for the turn', async () => {
      await repo.recordEvent(tabId, stop('um'));
      await repo.markSeen(tabId);
      await repo.recordEvent(tabId, { kind: 'working', tool: 'claude', text: null, meta: { event: 'UserPromptSubmit' } });
      const { rearm, tab } = await repo.recordEvent(tabId, stop('dois'));
      expect(needsYou(tab)).toBe(true);
      expect(rearm).toBeNull();
    });

    it('is null when the wait before it had not been seen, and for the first wait of a tab', async () => {
      const first = await repo.recordEvent(tabId, stop('um'));
      expect(first.rearm).toBeNull();
      const second = await repo.recordEvent(tabId, stop('dois'));
      expect(second.rearm).toBeNull();
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
    const current = tab({ state: 'working', state_tool: 'cursor' });
    const { r } = repos(current);
    (r.tabs.recordEvent as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ tab: current, event: null, rearm: null });

    const res = await ingestHookEvent(r, log, { machineId: 'm1', tool: 'cursor', session: 'th-t1', event: { hook_event_name: 'sessionStart' } });

    expect(res).toEqual({ ok: false, reason: 'ignored' });
    expect(publish).not.toHaveBeenCalled();
    expect(note).not.toHaveBeenCalled();
    expect(schedule).not.toHaveBeenCalled();
  });
});

describe('ingestHookEvent — a seen wait that alerts again', () => {
  it('is logged with event names and flags, never the text', async () => {
    const info = vi.fn();
    const current = tab({ state: 'working' });
    const { r } = repos(current);
    (r.tabs.recordEvent as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      tab: tab({ ...current, state: 'waiting_input' }),
      event: {},
      rearm: { previous: 'PreToolUse', background: true, afterSessionEnd: false },
    });

    await ingestHookEvent(r, { info, debug: vi.fn(), warn: vi.fn() } as never, { machineId: 'm1', tool: 'claude', session: 'th-t1', event: { hook_event_name: 'Stop', last_assistant_message: 'segredo do terminal' } });

    expect(info).toHaveBeenCalledWith({ tabId: 't1', tool: 'claude', previous: 'PreToolUse', event: 'Stop', background: true, afterSessionEnd: false }, 'monitor: seen wait re-armed');
    expect(JSON.stringify(info.mock.calls)).not.toContain('segredo do terminal');
  });

  it('is not logged for an event that re-armed nothing', async () => {
    const info = vi.fn();
    const { r } = repos(tab({ state: 'working' }));
    await ingestHookEvent(r, { info, debug: vi.fn(), warn: vi.fn() } as never, { machineId: 'm1', tool: 'claude', session: 'th-t1', event: { hook_event_name: 'Stop', last_assistant_message: 'Pronto.' } });
    expect(info.mock.calls.some((c) => c[1] === 'monitor: seen wait re-armed')).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `D th-f3-t2-red 'npm test -w @termhub/server -- src/db/repositories/tabs.db.test.ts src/monitor/ingest.test.ts'`
Expected: new cases fail and every case that existed passes.
- `tabs.db.test.ts`: the `/clear`, the termhub reply and the "person saw" permission cases fail on `needsYou`; the dropped session start fails on `event` not being null; the `rearm` cases fail because `rearm` is `undefined`. The cases that say "still alerts", "still needs them", "nothing is dropped" and "is recorded" pass already: they pin what must not change.
- `ingest.test.ts`: the "ends as ignored" case and the "is logged" case fail.

If the database tests are reported as skipped, `TERMHUB_DB_TESTS` or `DATABASE_URL` did not reach the container: stop and report it.

- [ ] **Step 3: Implement in the repository**

In `apps/server/src/db/repositories/tabs.ts`, add to the imports:

```ts
import { HISTORY_ROWS, decideWait, rearmOf, type HistoryRow, type Rearm } from '../../monitor/wait-decision.js';
```

Add these helpers next to the other module-level helpers of the file (above the class):

```ts
const metaOf = (meta: unknown): Record<string, unknown> => (meta && typeof meta === 'object' && !Array.isArray(meta) ? (meta as Record<string, unknown>) : {});

/** The hook event name an event row carries in its meta (`{ event: 'Stop', … }`), or null. */
function eventName(meta: unknown): string | null {
  const name = metaOf(meta).event;
  return typeof name === 'string' && name ? name : null;
}

/** A Claude Stop that left background tasks running writes their count in its meta. */
function hasBackgroundTasks(meta: unknown): boolean {
  const count = metaOf(meta).background_tasks;
  return typeof count === 'number' && count > 0;
}
```

Replace the JSDoc and the whole `recordEvent` method with:

```ts
  /**
   * Monitor: records the event and makes it the tab's current state; keeps only the newest events
   * per tab. Whether the event alerts is `decideWait`'s call (monitor/wait-decision.ts, spec
   * 2026-09-29), from the tab's row and its last events, read here under the row lock: a wait the
   * person already saw stays seen when the event continues it or brings nothing new. The text
   * follows the same decision: a continuation with no text of its own, or whose own text is only a
   * reminder (`keepsWaitText`), keeps the wait's text.
   *
   * A dropped event (a Cursor session start that arrived after its own prompt) writes no row and
   * changes nothing: `event` is null and the tab is the row as it was.
   *
   * `rearm` is for the log: the wait alerts although the person had seen the one before it and
   * asked for nothing since.
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
    },
  ): Promise<{ tab: Tab; event: TabEvent | null; rearm: Rearm | null }> {
    const at = new Date();
    const [e, t, rearm] = await this.db.$transaction(async (tx) => {
      // One event per tab at a time: two hooks fired together (PermissionRequest and
      // Notification(permission_prompt)) would otherwise both see the same `working` event as the
      // previous one and credit its interval twice. The second waits here and reads the first's event.
      await tx.$queryRaw`SELECT 1 FROM "tabs" WHERE "id" = ${tabId} FOR UPDATE`;
      const current = await tx.tab.findUnique({ where: { id: tabId }, select: { state: true, stateAt: true, stateSeenAt: true, stateText: true, activity: true } });
      const rows = await tx.tabEvent.findMany({ where: { tabId }, orderBy: { createdAt: 'desc' }, take: HISTORY_ROWS, select: { kind: true, createdAt: true, meta: true } });
      const previous = rows[0];
      const history: HistoryRow[] = rows.map((r) => ({ kind: r.kind as TabState, event: eventName(r.meta), ageMs: at.getTime() - r.createdAt.getTime(), backgroundTasks: hasBackgroundTasks(r.meta) }));
      const now = {
        state: (current?.state ?? null) as TabState | null,
        seen: !!current?.stateSeenAt && !!current.stateAt && current.stateSeenAt >= current.stateAt,
        hasActivity: !!current?.activity,
        seenAgeMs: current?.stateSeenAt ? at.getTime() - current.stateSeenAt.getTime() : null,
      };
      const incoming = { kind: event.kind, name: eventName(event.meta), continuesWait: !!event.continuesWait, keepsWaitText: !!event.keepsWaitText };
      const outcome = decideWait(now, history, incoming);
      if (outcome.action === 'drop') {
        return [null, await tx.tab.findUniqueOrThrow({ where: { id: tabId } }), null] as const;
      }

      // A working interval ends here: credit it to the card this tab works on (a subtask's parent), once.
      if (previous?.kind === 'working') {
        const seconds = Math.min(MAX_WORKING_INTERVAL_S, Math.round((at.getTime() - previous.createdAt.getTime()) / 1000));
        if (seconds > 0) {
          await tx.$executeRaw`UPDATE "tasks" SET "active_seconds" = "active_seconds" + ${seconds} WHERE "id" IN (SELECT DISTINCT COALESCE("parent_id", "id") FROM "tasks" WHERE "tab_id" = ${tabId})`;
        }
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
      return [ev, updated, rearmOf(now, history, incoming, outcome)] as const;
    });
    return { tab: mapTab(t), event: e ? mapTabEvent(e) : null, rearm };
  }
```

If the file already has a helper that does what `metaOf` or `eventName` does, use it instead of adding a second one, and say so in your report.

- [ ] **Step 4: Implement in the ingest path**

In `apps/server/src/monitor/ingest.ts`:

Replace, in `ingestHookEvent`, the lines from `const updated = await recordInterpretation(…)` to the `return { ok: true, tab: updated };` with:

```ts
  const recorded = await recordInterpretation(repos, log, current, input.tool, interpreted);
  // Dropped by the wait rule (a Cursor session start that arrived after its own prompt): nothing
  // changed, so no card opens or closes and no suggestion check is scheduled.
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
  return recordState(repos, log, tab, tool, interpreted);
}

/** Records the event for the tab, updates its state and publishes the change. */
export async function applyState(repos: Repositories, log: FastifyBaseLogger, tab: Tab, tool: string, next: Interpreted): Promise<Tab> {
  return (await recordState(repos, log, tab, tool, next)).tab;
}

async function recordState(repos: Repositories, log: FastifyBaseLogger, tab: Tab, tool: string, next: Interpreted): Promise<Recorded> {
  const { tab: updated, event, rearm } = await repos.tabs.recordEvent(tab.id, {
    kind: next.kind,
    tool,
    text: next.text,
    meta: next.meta,
    activity: next.activity,
    activityVerb: next.verb,
    ...(next.continuesWait ? { continuesWait: true } : {}),
    ...(next.keepsWaitText ? { keepsWaitText: true } : {}),
  });
  const name = typeof next.meta.event === 'string' ? next.meta.event : null;
  if (!event) {
    log.debug({ tabId: tab.id, tool, kind: next.kind, event: name }, 'monitor: event dropped');
    return { tab: updated, dropped: true };
  }
  const machine = await repos.machines.findById(tab.machine_id);
  log.info({ tabId: tab.id, machineId: machine?.id, tool, kind: next.kind, textLen: next.text?.length ?? 0 }, 'monitor: tab state');
  // What re-arms a wait the person had seen, counted: names and flags only (spec 2026-09-29 §4.5).
  if (rearm) log.info({ tabId: tab.id, tool, previous: rearm.previous, event: name, background: rearm.background, afterSessionEnd: rearm.afterSessionEnd }, 'monitor: seen wait re-armed');
  publishTabChange(updated, tab.project_id, machine);
  return { tab: updated, dropped: false };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `D th-f3-t2-green 'npm test -w @termhub/server -- src/db/repositories/tabs.db.test.ts src/monitor src/routes/tabs.test.ts src/routes/hooks.test.ts src/control src/chat/tab-questions.test.ts'`
Expected: 0 failed, and the database tests are not skipped.

If a test that existed before this task fails, stop and report its name and output. Do not change it.

Run: `D th-f3-t2-types 'npm run typecheck -w @termhub/server'`
Expected: exit code 0. If a caller of `recordEvent` outside `ingest.ts` reads `.event` as never null, the typecheck names it: report it rather than casting.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/db/repositories/tabs.ts apps/server/src/db/repositories/tabs.db.test.ts apps/server/src/monitor/ingest.ts apps/server/src/monitor/ingest.test.ts
```
```bash
git commit -m "Monitor: a reminder with nothing new in it does not alert again" -m "recordEvent reads the tab's last ten events under its row lock and asks decideWait. Claude's idle_prompt no longer lights a wait the person had seen: after /clear or a reply that started no turn the wait is born seen, and over a permission prompt it takes the tab back to waiting_input with the seen mark carried. A turn whose Stop was lost still alerts. One log line, names and flags only, counts what else re-arms a wait the person had seen (TER-422, #208)." -m "Co-Authored-By: <the model writing this commit> <noreply@anthropic.com>"
```

---

### Task 3: A Cursor session that was never prompted is idle (TER-411)

**Files:**
- Modify: `apps/server/src/monitor/state.ts` (`interpretCursor`, the `sessionStart` case, and the JSDoc above the function)
- Test: `apps/server/src/monitor/state.test.ts` (the case at line 163)

**Interfaces:**
- Consumes: the drop of Task 2. `recordEvent` drops an `idle` event named `sessionStart` that finds the tab `working` by a `beforeSubmitPrompt` at most 10 s old, so the two hooks of a Cursor launch can arrive in either order.
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
      // One that arrives after its own prompt is dropped by recordEvent (monitor/wait-decision.ts).
      return { kind: 'idle', text: null, meta: { event: name } };
    case 'beforeSubmitPrompt':
      // the prompt is the user's content: only the fact that it is busy is kept
      return { kind: 'working', text: null, meta: { event: name } };
```

In the JSDoc above `interpretCursor`, add as its last sentence: `A session starts idle: only \`beforeSubmitPrompt\` says a turn is running.`

Claude's `SessionStart` is not changed.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `D th-f3-t3-green 'npm test -w @termhub/server -- src/monitor src/routes/hooks.test.ts src/control src/agent src/db/repositories/tabs.db.test.ts'`
Expected: 0 failed. These are the suites that read a tab's state: the interpreter, the hooks route, `wait_for_state`, the agent's update check, and the repository.

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

This task uses the web Docker command, without the database variables:

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
6. Moves TER-411 and TER-414 to "Feito". TER-422 stays open until the log says which path the person is seeing: the spec expects this change not to close it by itself.
