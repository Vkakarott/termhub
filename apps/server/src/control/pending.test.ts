import { beforeEach, expect, it, vi } from 'vitest';
import type { ControlContext } from './context.js';

const resurfaceCards = vi.fn();
vi.mock('../chat/resurface.js', () => ({ resurfaceCards: (...a: unknown[]) => resurfaceCards(...a) }));
const { recapPendingCards } = await import('./pending.js');

const findByIdForUser = vi.fn();
const ctxWith = (token?: ControlContext['token']) => ({ repos: { chat: { findByIdForUser } }, scope: { user: { id: 'u1' } }, token }) as unknown as ControlContext;

beforeEach(() => {
  resurfaceCards.mockReset();
  findByIdForUser.mockReset();
});

it('brings the conversation\'s pending cards back and lists them for the concierge (TER-477)', async () => {
  findByIdForUser.mockResolvedValue({ id: 'c1' });
  resurfaceCards.mockResolvedValue({
    actions: [{ id: 'a1', summary: 'digitar `npm test` na aba api', class: 'write', tool: 'send_input' }],
    questions: [{ id: 'q1', tab_id: 't1', tab_name: 'api', kind: 'choice', payload: { questions: [{ question: 'Qual cor?' }] } }, { id: 'q2', tab_id: 't2', tab_name: null, kind: 'permission', payload: { tool_name: 'Bash' } }],
  });
  const out = await recapPendingCards(ctxWith({ id: 'tok', scopes: ['read'], gated: true, chat_conversation_id: 'c1' }));
  expect(findByIdForUser).toHaveBeenCalledWith('c1', 'u1');
  expect(resurfaceCards).toHaveBeenCalledWith(expect.anything(), 'u1', 'c1');
  expect(out).toMatchObject({
    brought_back: 3,
    confirmations: [{ id: 'a1', summary: 'digitar `npm test` na aba api', irreversible: false }],
    tab_questions: [
      { id: 'q1', tab: 'api', kind: 'choice', question: 'Qual cor?' },
      { id: 'q2', tab: null, kind: 'permission', question: 'permissão para usar Bash' },
    ],
  });
  expect(out.note).toMatch(/fim da conversa/);
});

it('says so when nothing waits on the person', async () => {
  findByIdForUser.mockResolvedValue({ id: 'c1' });
  resurfaceCards.mockResolvedValue({ actions: [], questions: [] });
  const out = await recapPendingCards(ctxWith({ id: 'tok', scopes: ['read'], gated: true, chat_conversation_id: 'c1' }));
  expect(out).toMatchObject({ brought_back: 0, confirmations: [], tab_questions: [] });
  expect(out.note).toMatch(/nada/i);
});

it('refuses outside a chat conversation of this person', async () => {
  await expect(recapPendingCards(ctxWith({ id: 'tok', scopes: ['read'] }))).rejects.toMatchObject({ code: 'NOT_IN_CHAT' });
  await expect(recapPendingCards(ctxWith(undefined))).rejects.toMatchObject({ code: 'NOT_IN_CHAT' });
  findByIdForUser.mockResolvedValue(undefined);
  await expect(recapPendingCards(ctxWith({ id: 'tok', scopes: ['read'], gated: true, chat_conversation_id: 'c_other' }))).rejects.toMatchObject({ code: 'NOT_IN_CHAT' });
  expect(resurfaceCards).not.toHaveBeenCalled();
});
