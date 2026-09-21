import { expect, it, vi } from 'vitest';
import type { Repositories } from '../db/repositories/index.js';
import { API_TOKEN_RE } from '../auth/api-tokens.js';
import { CONCIERGE_TOKEN_NAME, mintConciergeToken } from './token.js';

function repos(existing: { id: string; name: string; revoked_at: string | null }[] = []) {
  const apiTokens = {
    listByUser: vi.fn(async () => existing),
    create: vi.fn(async (userId: string, input: unknown, hash: string) => ({ id: 'tok_new', userId, input, hash })),
    revoke: vi.fn(async () => undefined),
  };
  return { apiTokens } as unknown as Repositories & { apiTokens: typeof apiTokens };
}

it('creates a token that looks like an API token and never returns the hash', async () => {
  const r = repos();
  const token = await mintConciergeToken(r, 'u1', ['read']);
  expect(token).toMatch(API_TOKEN_RE);
  const [, input, hash] = r.apiTokens.create.mock.calls[0];
  expect(input).toMatchObject({ name: CONCIERGE_TOKEN_NAME, scopes: ['read'] });
  expect((input as { expiresAt: Date }).expiresAt.getTime()).toBeGreaterThan(Date.now());
  expect(hash).not.toContain(token);
});

it('revokes the previous concierge token and leaves the user other tokens alone', async () => {
  const r = repos([
    { id: 'tok_old', name: CONCIERGE_TOKEN_NAME, revoked_at: null },
    { id: 'tok_mine', name: 'meu notebook', revoked_at: null },
    { id: 'tok_dead', name: CONCIERGE_TOKEN_NAME, revoked_at: '2026-09-01T00:00:00.000Z' },
  ]);
  await mintConciergeToken(r, 'u1', ['read']);
  expect(r.apiTokens.revoke.mock.calls).toEqual([['tok_old', 'u1']]);
});
