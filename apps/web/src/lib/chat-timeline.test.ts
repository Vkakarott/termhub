import { describe, expect, it } from 'vitest';
import type { ChatAction, ChatMessage } from './types';
import { chatTimeline } from './chat-timeline';

const T0 = '2026-01-01T00:00:00.000Z';
const T1 = '2026-01-01T00:01:00.000Z';
const T2 = '2026-01-01T00:02:00.000Z';

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'm1',
    conversation_id: 'c1',
    role: 'assistant',
    text: 'oi',
    error_code: null,
    created_at: T0,
    ...overrides,
  };
}

function action(overrides: Partial<ChatAction> = {}): ChatAction {
  return {
    id: 'a1',
    tool: 'Bash',
    args: {},
    class: 'write',
    status: 'pending',
    machine_id: null,
    project_id: null,
    tab_id: null,
    summary: 'digitar `npm test` na aba Terminal 2',
    created_at: T0,
    ...overrides,
  };
}

describe('chatTimeline', () => {
  it('interleaves messages and actions by created_at', () => {
    const messages = [message({ id: 'm1', created_at: T0 }), message({ id: 'm2', created_at: T2 })];
    const actions = [action({ id: 'a1', created_at: T1 })];

    const result = chatTimeline(messages, actions);

    expect(result.map((e) => (e.kind === 'message' ? e.message.id : e.action.id))).toEqual(['m1', 'a1', 'm2']);
  });

  it('breaks a tie by putting the message before the action, regardless of the arrays\' own order', () => {
    const tiedMessage = message({ id: 'm1', created_at: T0 });
    const tiedAction = action({ id: 'a1', created_at: T0 });

    // Baseline: the tied pair alone.
    expect(chatTimeline([tiedMessage], [tiedAction]).map((e) => e.kind)).toEqual(['message', 'action']);

    // A stable sort with no explicit tiebreak just preserves concatenation order, so the tie's
    // outcome would flip depending on how the implementation concatenates the two inputs. Padding
    // each array with an earlier and a later entry — so the tied element sits at a different index
    // in each array — must not change which side of the tie wins.
    const paddedMessages = [message({ id: 'm0', created_at: '2025-12-31T00:00:00.000Z' }), tiedMessage, message({ id: 'm2', created_at: T2 })];
    const paddedActions = [action({ id: 'a0', created_at: '2025-12-31T00:00:00.000Z' }), tiedAction, action({ id: 'a2', created_at: T2 })];

    const result = chatTimeline(paddedMessages, paddedActions);
    const tiedPair = result.filter((e) => e.at === T0);
    expect(tiedPair.map((e) => e.kind)).toEqual(['message', 'action']);
  });

  it('does not depend on input order: shuffled inputs produce the same result', () => {
    const messages = [message({ id: 'm1', created_at: T0 }), message({ id: 'm2', created_at: T2 })];
    const actions = [action({ id: 'a1', created_at: T1 })];

    const forward = chatTimeline(messages, actions);
    const shuffledMessages = [messages[1], messages[0]];
    const backward = chatTimeline(shuffledMessages, actions);

    const idsOf = (entries: typeof forward) => entries.map((e) => (e.kind === 'message' ? e.message.id : e.action.id));
    expect(idsOf(backward)).toEqual(idsOf(forward));
  });

  it('does not mutate its inputs', () => {
    const messages = [message({ id: 'm2', created_at: T2 }), message({ id: 'm1', created_at: T0 })];
    const actions = [action({ id: 'a2', created_at: T2 }), action({ id: 'a1', created_at: T0 })];

    chatTimeline(messages, actions);

    expect(messages.map((m) => m.id)).toEqual(['m2', 'm1']);
    expect(actions.map((a) => a.id)).toEqual(['a2', 'a1']);
  });

  it('returns an empty array for an empty conversation', () => {
    expect(chatTimeline([], [])).toEqual([]);
  });

  it('carries the row\'s own created_at as the entry\'s at', () => {
    const messages = [message({ id: 'm1', created_at: T0 })];
    const actions = [action({ id: 'a1', created_at: T1 })];

    const result = chatTimeline(messages, actions);

    expect(result[0].at).toBe(T0);
    expect(result[1].at).toBe(T1);
  });
});
