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
