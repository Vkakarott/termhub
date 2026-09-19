import { describe, expect, it } from 'vitest';
import { STATE_TEXT_MAX, interpretHookEvent, needsYou } from './state.js';

describe('interpretHookEvent — claude', () => {
  it('maps permission and idle notifications to waiting states with the message', () => {
    expect(interpretHookEvent('claude', { hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' })).toEqual({
      kind: 'waiting_permission',
      text: 'Claude needs your permission to use Bash',
      meta: { event: 'Notification', type: 'permission_prompt' },
    });
    expect(interpretHookEvent('claude', { hook_event_name: 'Notification', notification_type: 'idle_prompt', message: 'Claude is waiting for your input' })?.kind).toBe('waiting_input');
  });

  it('ignores notifications nobody has to act on', () => {
    expect(interpretHookEvent('claude', { hook_event_name: 'Notification', notification_type: 'auth_success', message: 'ok' })).toBeNull();
  });

  it('marks the tab busy on prompt submit without keeping the prompt', () => {
    expect(interpretHookEvent('claude', { hook_event_name: 'UserPromptSubmit', prompt: 'secret plans' })).toEqual({ kind: 'working', text: null, meta: { event: 'UserPromptSubmit' } });
  });

  it('treats a finished turn as waiting for the person, like Codex', () => {
    expect(interpretHookEvent('claude', { hook_event_name: 'Stop', stop_hook_active: false })).toEqual({ kind: 'waiting_input', text: null, meta: { event: 'Stop' } });
    expect(interpretHookEvent('claude', { hook_event_name: 'Stop', last_assistant_message: '  Pronto. Posso seguir?  ' })?.text).toBe('Pronto. Posso seguir?');
  });

  it('marks the tab idle when the session ends', () => {
    expect(interpretHookEvent('claude', { hook_event_name: 'SessionEnd', reason: 'exit' })).toEqual({ kind: 'idle', text: null, meta: { event: 'SessionEnd', reason: 'exit' } });
  });

  it('caps the message', () => {
    const r = interpretHookEvent('claude', { hook_event_name: 'Notification', notification_type: 'idle_prompt', message: 'x'.repeat(5000) });
    expect(r?.text?.length).toBe(STATE_TEXT_MAX);
  });

  it('returns null for unknown events and non-objects', () => {
    expect(interpretHookEvent('claude', { hook_event_name: 'SubagentStop' })).toBeNull();
    expect(interpretHookEvent('claude', 'nope')).toBeNull();
  });
});

describe('interpretHookEvent — codex', () => {
  it('maps agent-turn-complete to waiting_input (its only "needs you" signal) with the last assistant message', () => {
    expect(interpretHookEvent('codex', { type: 'agent-turn-complete', 'last-assistant-message': 'Done. Want me to run the tests?', 'input-messages': ['private'] })).toEqual({
      kind: 'waiting_input',
      text: 'Done. Want me to run the tests?',
      meta: { event: 'agent-turn-complete' },
    });
  });

  it('ignores other notify types', () => {
    expect(interpretHookEvent('codex', { type: 'something-else' })).toBeNull();
  });
});

describe('needsYou', () => {
  it('is true while waiting and never seen', () => {
    expect(needsYou({ state: 'waiting_input', state_at: '2026-01-01T00:00:00.000Z', state_seen_at: null })).toBe(true);
    expect(needsYou({ state: 'waiting_permission', state_at: '2026-01-01T00:00:00.000Z', state_seen_at: null })).toBe(true);
  });

  it('is false once seen at or after the state started', () => {
    expect(needsYou({ state: 'waiting_input', state_at: '2026-01-01T00:00:00.000Z', state_seen_at: '2026-01-01T00:00:00.000Z' })).toBe(false);
    expect(needsYou({ state: 'waiting_input', state_at: '2026-01-01T00:00:00.000Z', state_seen_at: '2026-01-01T00:01:00.000Z' })).toBe(false);
  });

  it('is true again when seen before the (newer) state_at — a new event re-arms it', () => {
    expect(needsYou({ state: 'waiting_input', state_at: '2026-01-01T00:02:00.000Z', state_seen_at: '2026-01-01T00:01:00.000Z' })).toBe(true);
  });

  it('is false outside NEEDS_YOU states, and when state_at is null', () => {
    expect(needsYou({ state: 'working', state_at: '2026-01-01T00:00:00.000Z', state_seen_at: null })).toBe(false);
    expect(needsYou({ state: 'idle', state_at: '2026-01-01T00:00:00.000Z', state_seen_at: null })).toBe(false);
    expect(needsYou({ state: null, state_at: null, state_seen_at: null })).toBe(false);
    expect(needsYou({ state: 'waiting_input', state_at: null, state_seen_at: null })).toBe(false);
  });
});
