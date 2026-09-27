import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../lib/errors.js';
import { chatBus } from './bus.js';
import { assertProjectGrantableAction, decodeGrantCursor, encodeGrantCursor, grantProject, listGrants, revokeGrant } from './grants.js';

it('round-trips a cursor', () => {
  const c = { created_at: '2026-09-25T10:00:00.000Z', id: 'abc123' };
  expect(decodeGrantCursor(encodeGrantCursor(c))).toEqual(c);
});

it('refuses a cursor that is not one of ours with a 400', () => {
  const bad = ['nope', Buffer.from('no-separator').toString('base64url'), Buffer.from('yesterday|g1').toString('base64url'), Buffer.from('2026-09-25T10:00:00.000Z|').toString('base64url'), Buffer.from('2026-09-25|g1').toString('base64url')];
  for (const s of bad) {
    expect(() => decodeGrantCursor(s)).toThrow(HttpError);
    try {
      decodeGrantCursor(s);
    } catch (e) {
      expect((e as HttpError).code).toBe('INVALID_CURSOR');
    }
  }
});

it('listGrants passes the decoded cursor and encodes the next one', async () => {
  const listForUser = vi.fn(async () => ({ grants: [], next: { created_at: '2026-09-25T10:00:00.000Z', id: 'g9' } }));
  const repos = { chatGrants: { listForUser }, tabs: { findByIdsForOwner: vi.fn(async () => []) }, projects: { findByIdsForOwner: vi.fn(async () => []) } } as never;
  const cursor = encodeGrantCursor({ created_at: '2026-09-24T10:00:00.000Z', id: 'g1' });
  const now = new Date('2026-09-25T12:00:00.000Z');
  const res = await listGrants(repos, 'u1', { state: 'ended', cursor, limit: 20 }, now);
  expect(listForUser).toHaveBeenCalledWith('u1', { state: 'ended', cursor: { created_at: '2026-09-24T10:00:00.000Z', id: 'g1' }, limit: 20 }, now);
  expect(decodeGrantCursor(res.next_cursor!)).toEqual({ created_at: '2026-09-25T10:00:00.000Z', id: 'g9' });
});

it('listGrants with { state: "active", limit: 50 } always asks the repository for GRANT_LIST_MAX, since active is not paged and the query default must never silently truncate it', async () => {
  const listForUser = vi.fn(async () => ({ grants: [], next: null }));
  const repos = { chatGrants: { listForUser }, tabs: { findByIdsForOwner: vi.fn(async () => []) }, projects: { findByIdsForOwner: vi.fn(async () => []) } } as never;
  const now = new Date('2026-09-25T12:00:00.000Z');
  await listGrants(repos, 'u1', { state: 'active', limit: 50 }, now);
  expect(listForUser).toHaveBeenCalledWith('u1', { state: 'active', cursor: null, limit: 100 }, now);
});

describe('project grants', () => {
  beforeEach(() => {
    vi.spyOn(chatBus, 'publish').mockImplementation(() => undefined);
  });

  const pending = { id: 'a1', conversation_id: 'c1', tool: 'move_task', args: { task_id: 'k1', status: 'done' }, status: 'pending', tab_id: null } as never;
  const base = () => ({
    chatActions: { findByIdForUser: vi.fn(async () => pending) },
    tasks: { findByIdsForOwner: vi.fn(async () => [{ id: 'k1', project_id: 'p1' }]) },
    projects: { findByIdsForOwner: vi.fn(async () => [{ id: 'p1', name: 'App' }]) },
    chatProjectGrants: {
      grant: vi.fn(async () => ({ id: 'pg1', conversation_id: 'c1', project_id: 'p1', source_action_id: 'a1', granted_by: 'u1', created_at: 'x', expires_at: 'y', revoked_at: null, revoked_by: null })),
      revoke: vi.fn(async () => undefined), findByIdForUser: vi.fn(async () => undefined),
    },
    chatGrants: { revoke: vi.fn(async () => undefined), findByIdForUser: vi.fn(async () => undefined) },
  });

  it('assertProjectGrantableAction returns the resolved project', async () => {
    expect(await assertProjectGrantableAction(base() as never, 'u1', 'a1')).toEqual({ action: pending, projectId: 'p1' });
  });

  it('refuses a tool outside the four and an unresolved project with GRANT_NOT_ALLOWED', async () => {
    const r = base();
    r.chatActions.findByIdForUser.mockResolvedValueOnce({ ...pending, tool: 'delete_task' });
    await expect(assertProjectGrantableAction(r as never, 'u1', 'a1')).rejects.toMatchObject({ statusCode: 400, code: 'GRANT_NOT_ALLOWED' });
    r.tasks.findByIdsForOwner.mockResolvedValueOnce([]);
    await expect(assertProjectGrantableAction(r as never, 'u1', 'a1')).rejects.toMatchObject({ code: 'GRANT_NOT_ALLOWED' });
  });

  it('grantProject creates, names the project and publishes project_grant', async () => {
    const r = base();
    const g = await grantProject(r as never, 'u1', pending, 'p1');
    expect(g).toMatchObject({ id: 'pg1', project_id: 'p1', project_name: 'App' });
    expect(chatBus.publish).toHaveBeenCalledWith(expect.objectContaining({ type: 'project_grant', conversation_id: 'c1' }));
  });

  it('revokeGrant falls through to project grants and publishes project_grant_revoked', async () => {
    const r = base();
    r.chatProjectGrants.revoke.mockResolvedValueOnce({ id: 'pg1', conversation_id: 'c1', project_id: 'p1' } as never);
    await revokeGrant(r as never, 'u1', 'pg1');
    expect(chatBus.publish).toHaveBeenCalledWith(expect.objectContaining({ type: 'project_grant_revoked', grant_id: 'pg1' }));
  });

  it('revokeGrant 409 for an already revoked project grant', async () => {
    const r = base();
    r.chatProjectGrants.findByIdForUser.mockResolvedValueOnce({ id: 'pg1' } as never);
    await expect(revokeGrant(r as never, 'u1', 'pg1')).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe('listGrants kinds', () => {
  const tab = (id: string, at: string) => ({ id, conversation_id: 'c1', tab_id: 't1', tool: 'send_input', source_action_id: null, granted_by: 'u1', created_at: at, expires_at: at, revoked_at: at, revoked_by: 'u1', conversation_project_id: null, conversation_archived: false });
  const proj = (id: string, at: string) => ({ id, conversation_id: 'c1', project_id: 'p1', source_action_id: null, granted_by: 'u1', created_at: at, expires_at: at, revoked_at: at, revoked_by: 'u1', conversation_project_id: null, conversation_archived: false });
  const repos = (tabs: unknown[], projects: unknown[]) => ({
    chatGrants: { listForUser: vi.fn(async () => ({ grants: tabs, next: null })) },
    chatProjectGrants: { listForUser: vi.fn(async () => ({ grants: projects, next: null })) },
    tabs: { findByIdsForOwner: vi.fn(async () => []) },
    projects: { findByIdsForOwner: vi.fn(async () => [{ id: 'p1', name: 'App' }]) },
  }) as never;

  it('default kinds stays tab-only', async () => {
    const r = repos([tab('g1', '2026-01-02T00:00:00.000Z')], [proj('pg1', '2026-01-03T00:00:00.000Z')]);
    const out = await listGrants(r, 'u1', { state: 'ended', limit: 50, kinds: 'tab' });
    expect(out.grants.map((g) => g.id)).toEqual(['g1']);
  });

  it('kinds=all merges newest first, cuts to limit and returns the cut row as cursor', async () => {
    const r = repos([tab('g1', '2026-01-02T00:00:00.000Z'), tab('g0', '2026-01-01T00:00:00.000Z')], [proj('pg1', '2026-01-03T00:00:00.000Z')]);
    const out = await listGrants(r, 'u1', { state: 'ended', limit: 2, kinds: 'all' });
    expect(out.grants.map((g) => [g.id, g.kind])).toEqual([['pg1', 'project'], ['g1', 'tab']]);
    expect(out.next_cursor).toBe(encodeGrantCursor({ created_at: '2026-01-02T00:00:00.000Z', id: 'g1' }));
  });
});
