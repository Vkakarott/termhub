import { expect, it, vi } from 'vitest';
import type { Repositories } from '../db/repositories/index.js';
import { API_TOKEN_RE } from '../auth/api-tokens.js';
import { CONCIERGE_TOKEN_NAME, mintConciergeToken } from './token.js';

function repos(existing: { id: string; name: string; revoked_at: string | null; chat_conversation_id: string | null }[] = []) {
  const apiTokens = {
    listByUser: vi.fn(async () => existing),
    create: vi.fn(async (userId: string, input: unknown, hash: string) => ({ id: 'tok_new', userId, input, hash })),
    revoke: vi.fn(async () => undefined),
  };
  return { apiTokens } as unknown as Repositories & { apiTokens: typeof apiTokens };
}

it('creates a token that looks like an API token and never returns the hash', async () => {
  const r = repos();
  const token = await mintConciergeToken(r, 'u1', 'c1', ['read']);
  expect(token).toMatch(API_TOKEN_RE);
  const [, input, hash] = r.apiTokens.create.mock.calls[0];
  expect(input).toMatchObject({ name: CONCIERGE_TOKEN_NAME, scopes: ['read'] });
  expect((input as { expiresAt: Date }).expiresAt.getTime()).toBeGreaterThan(Date.now());
  expect(hash).not.toContain(token);
});

it('mints with the concierge\'s write scopes and the gate flag together, never one without the other', async () => {
  const r = repos();
  await mintConciergeToken(r, 'u1', 'c1', ['read', 'tasks', 'terminals']);
  const [, input] = r.apiTokens.create.mock.calls[0];
  expect(input).toMatchObject({ scopes: ['read', 'tasks', 'terminals'], gated: true });
});

it('gates the token even when asked to mint a narrower scope list', async () => {
  // gated:true is hardcoded in mintConciergeToken itself, not derived from the scopes it is given —
  // the dangerous combination (wide scopes, no gate) must be structurally impossible, not just untested.
  const r = repos();
  await mintConciergeToken(r, 'u1', 'c1', ['read']);
  const [, input] = r.apiTokens.create.mock.calls[0];
  expect((input as { gated: boolean }).gated).toBe(true);
});

it('revokes only the previous token of the same conversation', async () => {
  const r = repos([
    { id: 'tok_old', name: CONCIERGE_TOKEN_NAME, revoked_at: null, chat_conversation_id: 'c1' },
    { id: 'tok_other_chat', name: CONCIERGE_TOKEN_NAME, revoked_at: null, chat_conversation_id: 'c2' },
    { id: 'tok_mine', name: 'meu notebook', revoked_at: null, chat_conversation_id: null },
    { id: 'tok_dead', name: CONCIERGE_TOKEN_NAME, revoked_at: '2026-09-01T00:00:00.000Z', chat_conversation_id: 'c1' },
  ]);
  await mintConciergeToken(r, 'u1', 'c1', ['read']);
  expect(r.apiTokens.revoke.mock.calls).toEqual([['tok_old', 'u1']]);
});

it('revokes a pre-migration concierge token (no conversation) only from the account-wide chat', async () => {
  const r = repos([{ id: 'tok_legacy', name: CONCIERGE_TOKEN_NAME, revoked_at: null, chat_conversation_id: null }]);
  await mintConciergeToken(r, 'u1', 'c_project', ['read'], { accountWide: false });
  expect(r.apiTokens.revoke).not.toHaveBeenCalled();
  await mintConciergeToken(r, 'u1', 'c_wide', ['read'], { accountWide: true });
  expect(r.apiTokens.revoke.mock.calls).toEqual([['tok_legacy', 'u1']]);
});

it('stores the conversation on the token', async () => {
  const r = repos();
  await mintConciergeToken(r, 'u1', 'c1', ['read']);
  const [, input] = r.apiTokens.create.mock.calls[0];
  expect(input).toMatchObject({ gated: true, chatConversationId: 'c1' });
});
