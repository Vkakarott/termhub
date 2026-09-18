import { describe, expect, it } from 'vitest';
import { STATE_TEXT_MAX, interpretHookEvent } from './state.js';

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

  it('marks the tab idle when the turn or the session ends', () => {
    expect(interpretHookEvent('claude', { hook_event_name: 'Stop', stop_hook_active: false })?.kind).toBe('idle');
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
  it('maps agent-turn-complete to idle with the last assistant message', () => {
    expect(interpretHookEvent('codex', { type: 'agent-turn-complete', 'last-assistant-message': 'Done. Want me to run the tests?', 'input-messages': ['private'] })).toEqual({
      kind: 'idle',
      text: 'Done. Want me to run the tests?',
      meta: { event: 'agent-turn-complete' },
    });
  });

  it('ignores other notify types', () => {
    expect(interpretHookEvent('codex', { type: 'something-else' })).toBeNull();
  });
});
