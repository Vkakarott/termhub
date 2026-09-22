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

  it('marks only idle_prompt as continuing the wait the Stop before it opened', () => {
    expect(interpretHookEvent('claude', { hook_event_name: 'Notification', notification_type: 'idle_prompt', message: 'Claude is waiting for your input' })?.continuesWait).toBe(true);
    expect(interpretHookEvent('claude', { hook_event_name: 'Stop' })?.continuesWait).toBeUndefined();
    expect(interpretHookEvent('claude', { hook_event_name: 'Notification', notification_type: 'elicitation_dialog', message: 'Pick one' })?.continuesWait).toBeUndefined();
    expect(interpretHookEvent('claude', { hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Allow?' })?.continuesWait).toBeUndefined();
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

  it('ignores the turn Codex runs on a side thread to title the conversation', () => {
    const title = { type: 'agent-turn-complete', 'thread-id': 'side', 'input-messages': ['Generate a concise, single-line task title…'], 'last-assistant-message': '{"title":"Responder apenas um"}' };
    expect(interpretHookEvent('codex', title)).toBeNull();
    expect(interpretHookEvent('codex', { ...title, 'last-assistant-message': ' { "title" : "x" } ' })).toBeNull();
  });

  it('keeps an answer that only looks like JSON', () => {
    for (const answer of ['{"title":"x","body":"y"}', '{"title":1}', '{"title":', '["title"]', '{}']) {
      expect(interpretHookEvent('codex', { type: 'agent-turn-complete', 'last-assistant-message': answer })?.text).toBe(answer);
    }
  });

  it('treats every finished turn as a new wait: Codex has no working signal between turns', () => {
    expect(interpretHookEvent('codex', { type: 'agent-turn-complete', 'last-assistant-message': 'dois' })?.continuesWait).toBeUndefined();
  });
});

describe('interpretHookEvent — cursor', () => {
  // shapes captured from cursor-agent 2026.09.18 (ids shortened, personal fields dropped)
  const base = { conversation_id: 'c1', generation_id: 'g1', cursor_version: '2026.09.18', user_email: 'someone@example.com', workspace_roots: ['/w'] };

  it('marks the tab busy on session start and on each prompt, without keeping the prompt', () => {
    expect(interpretHookEvent('cursor', { ...base, hook_event_name: 'sessionStart', is_background_agent: false })).toEqual({ kind: 'working', text: null, meta: { event: 'sessionStart' } });
    expect(interpretHookEvent('cursor', { ...base, hook_event_name: 'beforeSubmitPrompt', prompt: 'secret plans', attachments: [] })).toEqual({
      kind: 'working',
      text: null,
      meta: { event: 'beforeSubmitPrompt' },
    });
  });

  it('treats the final answer of a turn as waiting for the person, with the answer as the question', () => {
    expect(interpretHookEvent('cursor', { ...base, hook_event_name: 'afterAgentResponse', text: '  Pronto. Posso seguir?  ' })).toEqual({
      kind: 'waiting_input',
      text: 'Pronto. Posso seguir?',
      meta: { event: 'afterAgentResponse' },
    });
    expect(interpretHookEvent('cursor', { ...base, hook_event_name: 'afterAgentResponse', text: 'x'.repeat(5000) })?.text?.length).toBe(STATE_TEXT_MAX);
  });

  it('ignores a completed stop: the answer that came right before it already opened the wait', () => {
    expect(interpretHookEvent('cursor', { ...base, hook_event_name: 'stop', status: 'completed', loop_count: 0 })).toBeNull();
  });

  it('opens a wait on a stop that ended without an answer (aborted with Esc, or an error)', () => {
    expect(interpretHookEvent('cursor', { ...base, hook_event_name: 'stop', status: 'aborted', loop_count: 0 })).toEqual({ kind: 'waiting_input', text: null, meta: { event: 'stop', status: 'aborted' } });
    expect(interpretHookEvent('cursor', { ...base, hook_event_name: 'stop', status: 'error', loop_count: 0 })?.kind).toBe('waiting_input');
  });

  it('marks the tab idle when the session ends', () => {
    expect(interpretHookEvent('cursor', { ...base, hook_event_name: 'sessionEnd', reason: 'completed', final_status: 'completed' })).toEqual({ kind: 'idle', text: null, meta: { event: 'sessionEnd', reason: 'completed' } });
  });

  it('returns null for events it does not subscribe to and for non-objects', () => {
    expect(interpretHookEvent('cursor', { ...base, hook_event_name: 'beforeShellExecution', command: 'pwd' })).toBeNull();
    expect(interpretHookEvent('cursor', 'nope')).toBeNull();
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
