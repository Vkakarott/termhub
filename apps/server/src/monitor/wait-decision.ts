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
