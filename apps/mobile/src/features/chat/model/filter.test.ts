import type { ChatEvent } from './types';
import { belongsTo } from './filter';

const T0 = '2026-01-01T00:00:00.000Z';

function messageEvent(conversationId: string): ChatEvent {
  return {
    type: 'message',
    user_id: 'u1',
    conversation_id: conversationId,
    message: { id: 'm1', conversation_id: conversationId, role: 'assistant', text: 'oi', usage: null, error_code: null, created_at: T0 },
  };
}

const hello: ChatEvent = { type: 'hello', protocol: 1, server_time: T0 };

describe('belongsTo', () => {
  it('keeps an event tagged with the open conversation', () => {
    expect(belongsTo('c1')(messageEvent('c1'))).toBe(true);
  });

  it('drops an event tagged with a different conversation', () => {
    expect(belongsTo('c1')(messageEvent('c2'))).toBe(false);
  });

  it('drops every event when nothing is open yet, even one tagged with a real conversation', () => {
    expect(belongsTo(null)(messageEvent('c1'))).toBe(false);
  });

  it('drops the hello event, which carries no conversation_id at all', () => {
    expect(belongsTo('c1')(hello)).toBe(false);
    expect(belongsTo(null)(hello)).toBe(false);
  });

  it('returns a reusable predicate, usable directly with Array#filter', () => {
    const mine = belongsTo('c1');
    const events = [messageEvent('c1'), messageEvent('c2'), messageEvent('c1')];
    expect(events.filter(mine)).toHaveLength(2);
  });
});
