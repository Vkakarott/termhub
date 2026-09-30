import { isReplyable, replyRefOf } from './reply';
import type { ChatMessage } from './types';

const m = (over: Partial<ChatMessage> = {}): ChatMessage => ({ id: 'm1', conversation_id: 'c1', role: 'assistant', text: 'Feito', usage: null, error_code: null, created_at: '', ...over });

it('a stored message with something in it can be answered', () => {
  expect(isReplyable(m())).toBe(true);
  expect(isReplyable(m({ text: '' }))).toBe(false);
  expect(isReplyable(m({ role: 'user', text: 'oi', local: 'sending' }))).toBe(false);
  expect(isReplyable(m({ role: 'user', text: 'oi', local: 'failed' }))).toBe(false);
  expect(isReplyable(m({ role: 'user', text: '', attachments: [{ name: 'a.pdf' } as never] }))).toBe(true);
});

it('the reference carries the excerpt the server will cut too', () => {
  expect(replyRefOf(m({ text: '**Feito**, abri a aba' }))).toEqual({ id: 'm1', role: 'assistant', excerpt: 'Feito, abri a aba' });
  expect(replyRefOf(m({ role: 'user', text: '', attachments: [{ name: 'a.pdf' } as never] }))).toEqual({ id: 'm1', role: 'user', excerpt: '📎 a.pdf' });
});
