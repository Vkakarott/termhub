import { applyEvent, LIVE_CAP, type EventSlice } from './events';
import type { ChatAction, ChatEvent, ChatMessage } from './types';

const at = '2026-09-24T12:00:00.000Z';
const base = { user_id: 'u1', conversation_id: 'c1' };
const row = (id: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({ id, conversation_id: 'c1', role: 'assistant', text: '', usage: null, error_code: null, created_at: at, ...extra });
const action = (id: string, status: ChatAction['status'] = 'pending'): ChatAction => ({ id, tool: 't', args: {}, class: 'write', status, machine_id: null, project_id: null, tab_id: null, summary: 's', created_at: at });
const delta = (messageId: string, text: string): ChatEvent => ({ type: 'delta', ...base, message_id: messageId, delta: text });
const empty: EventSlice = { messages: [], actions: [], live: [] };

it('an announced assistant row stays in live; its final row replaces it and clears its deltas, and both ask for a re-read', () => {
  const announced = applyEvent(empty, { type: 'message', ...base, message: row('m1') });
  expect(announced.reread).toBe(true);
  expect(announced.slice.messages).toEqual([row('m1')]);
  expect(announced.slice.live).toHaveLength(1);

  const streaming = applyEvent(announced.slice, delta('m1', 'oi'));
  expect(streaming.reread).toBe(false);
  expect(streaming.slice.live).toHaveLength(2);

  const final = applyEvent(streaming.slice, { type: 'message', ...base, message: row('m1', { text: 'oi' }) });
  expect(final.slice.messages).toEqual([row('m1', { text: 'oi' })]);
  expect(final.slice.live).toEqual([]);
});

it('confirmations and decisions are idempotent', () => {
  const confirmation: ChatEvent = { type: 'confirmation', ...base, action_id: 'a1', tool: 't', args: {}, class: 'write', machine_id: null, project_id: null, tab_id: null, summary: 's', created_at: at };
  const once = applyEvent(empty, confirmation).slice;
  expect(applyEvent(once, confirmation).slice).toBe(once);
  expect(once.actions).toEqual([action('a1')]);

  const decided = applyEvent(once, { type: 'decision', ...base, action_id: 'a1', status: 'approved' }).slice;
  expect(decided.actions).toEqual([action('a1', 'approved')]);
  expect(applyEvent(decided, { type: 'decision', ...base, action_id: 'a1', status: 'approved' }).slice.actions).toBe(decided.actions);
});

it(`keeps at most ${LIVE_CAP} live events, dropping the oldest`, () => {
  let slice = empty;
  for (let i = 0; i < LIVE_CAP + 10; i++) slice = applyEvent(slice, delta('m1', String(i))).slice;
  expect(slice.live).toHaveLength(LIVE_CAP);
  expect(slice.live[0]).toEqual(delta('m1', '10'));
});

it('leaves the slice untouched for events that change nothing here', () => {
  expect(applyEvent(empty, { type: 'hello', protocol: 1, server_time: at }).slice).toBe(empty);
  expect(applyEvent(empty, { type: 'action_result', ...base, message_id: 'm1', tool_use_id: 'x', ok: true }).slice).toBe(empty);
});
