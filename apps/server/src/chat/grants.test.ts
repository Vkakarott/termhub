import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../lib/errors.js';
import { chatBus } from './bus.js';
import { assertProjectAllGrantableAction, assertProjectGrantableAction, assertTabTerminalGrantableAction, decodeGrantCursor, encodeGrantCursor, grantProject, grantTabTerminal, listGrants, revokeGrant } from './grants.js';

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

describe('terminal grants (TER-325)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(chatBus, 'publish').mockImplementation(() => undefined);
  });

  const keyCard = { id: 'a1', conversation_id: 'c1', tool: 'send_key', args: { tab_id: 't1', key: 'enter' }, status: 'pending', tab_id: 't1' };
  const boardCard = { id: 'a2', conversation_id: 'c1', tool: 'move_task', args: { task_id: 'k1', status: 'done' }, status: 'pending', tab_id: null };
  const narrow = { id: 'g-narrow', conversation_id: 'c1', tab_id: 't1', tool: 'send_input', source_action_id: 'a0', granted_by: 'u1', created_at: 'x', expires_at: 'y', revoked_at: null, revoked_by: null };
  const repos = (row: unknown = keyCard) => ({
    chatActions: { findByIdForUser: vi.fn(async () => row) },
    tabs: { findByIdsForOwner: vi.fn(async (ids: string[]) => (ids.includes('t1') ? [{ id: 't1', name: 'api', project_id: 'p1' }] : [])) },
    tasks: { findByIdsForOwner: vi.fn(async () => [{ id: 'k1', project_id: 'p2' }]) },
    projects: { findByIdsForOwner: vi.fn(async () => [{ id: 'p1', name: 'App' }]) },
    chatGrants: {
      findActive: vi.fn(async (): Promise<unknown> => undefined),
      revokeTool: vi.fn(async () => 0),
      grant: vi.fn(async (input: { tool: string }) => ({ id: 'g-term', conversation_id: 'c1', tab_id: 't1', tool: input.tool, source_action_id: 'a1', granted_by: 'u1', created_at: 'x', expires_at: 'y', revoked_at: null, revoked_by: null })),
    },
    chatProjectGrants: {
      grant: vi.fn(async (input: { scope?: string }) => ({ id: 'pg1', conversation_id: 'c1', project_id: 'p1', scope: input.scope ?? 'board', source_action_id: 'a1', granted_by: 'u1', created_at: 'x', expires_at: 'y', revoked_at: null, revoked_by: null })),
    },
  });

  it('assertTabTerminalGrantableAction accepts a pending send_key on an owned tab', async () => {
    const r = repos();
    expect(await assertTabTerminalGrantableAction(r as never, 'u1', 'a1')).toBe(keyCard);
    expect(r.tabs.findByIdsForOwner).toHaveBeenCalledWith(['t1'], 'u1');
  });

  it('assertTabTerminalGrantableAction refuses run_command, answering_permission and a foreign tab with 400, a decided row with 409, an unknown one with 404', async () => {
    const refused = { statusCode: 400, code: 'GRANT_NOT_ALLOWED', message: 'Só dá para liberar teclas e shell numa ação de terminal de uma aba sua' };
    await expect(assertTabTerminalGrantableAction(repos({ ...keyCard, tool: 'run_command', args: { tab_id: 't1', command: 'ls' } }) as never, 'u1', 'a1')).rejects.toMatchObject(refused);
    await expect(assertTabTerminalGrantableAction(repos({ ...keyCard, args: { tab_id: 't1', key: '1', answering_permission: true } }) as never, 'u1', 'a1')).rejects.toMatchObject(refused);
    await expect(assertTabTerminalGrantableAction(repos({ ...keyCard, tab_id: 't9', args: { tab_id: 't9', key: 'enter' } }) as never, 'u1', 'a1')).rejects.toMatchObject(refused);
    await expect(assertTabTerminalGrantableAction(repos({ ...keyCard, status: 'executed' }) as never, 'u1', 'a1')).rejects.toMatchObject({ statusCode: 409 });
    const gone = repos();
    gone.chatActions.findByIdForUser.mockResolvedValueOnce(undefined as never);
    await expect(assertTabTerminalGrantableAction(gone as never, 'u1', 'a1')).rejects.toMatchObject({ statusCode: 404 });
  });

  it('grantTabTerminal writes a terminal grant and publishes grant', async () => {
    const r = repos();
    const g = await grantTabTerminal(r as never, 'u1', keyCard as never);
    expect(r.chatGrants.grant).toHaveBeenCalledWith({ conversation_id: 'c1', tab_id: 't1', tool: 'terminal', source_action_id: 'a1', granted_by: 'u1' });
    expect(g).toMatchObject({ id: 'g-term', tool: 'terminal', tab_name: 'api' });
    expect(vi.mocked(chatBus.publish).mock.calls.map(([e]) => e.type)).toEqual(['grant']);
  });

  it('grantTabTerminal revokes an active narrow grant of the same tab first: grant_revoked, then grant', async () => {
    const r = repos();
    r.chatGrants.findActive.mockResolvedValueOnce(narrow);
    r.chatGrants.revokeTool.mockResolvedValueOnce(1);
    await grantTabTerminal(r as never, 'u1', keyCard as never);
    expect(r.chatGrants.findActive).toHaveBeenCalledWith('c1', 't1', 'send_input');
    expect(r.chatGrants.revokeTool).toHaveBeenCalledWith('c1', 't1', 'send_input', 'u1');
    const events = vi.mocked(chatBus.publish).mock.calls.map(([e]) => e);
    expect(events.map((e) => e.type)).toEqual(['grant_revoked', 'grant']);
    expect(events[0]).toMatchObject({ user_id: 'u1', conversation_id: 'c1', grant_id: 'g-narrow' });
    expect(r.chatGrants.revokeTool.mock.invocationCallOrder[0]).toBeLessThan(r.chatGrants.grant.mock.invocationCallOrder[0]!);
  });

  it('assertProjectAllGrantableAction resolves the project from a board card and from a terminal card\'s tab', async () => {
    expect(await assertProjectAllGrantableAction(repos(boardCard) as never, 'u1', 'a2')).toEqual({ action: boardCard, projectId: 'p2' });
    expect(await assertProjectAllGrantableAction(repos(keyCard) as never, 'u1', 'a1')).toEqual({ action: keyCard, projectId: 'p1' });
  });

  it('assertProjectAllGrantableAction refuses a foreign tab and delete_task with 400', async () => {
    const refused = { statusCode: 400, code: 'GRANT_NOT_ALLOWED', message: 'Só dá para liberar tudo neste projeto numa ação de quadro ou de terminal de um projeto seu' };
    await expect(assertProjectAllGrantableAction(repos({ ...keyCard, tab_id: 't9', args: { tab_id: 't9', key: 'enter' } }) as never, 'u1', 'a1')).rejects.toMatchObject(refused);
    await expect(assertProjectAllGrantableAction(repos({ ...boardCard, tool: 'delete_task' }) as never, 'u1', 'a2')).rejects.toMatchObject(refused);
    await expect(assertProjectAllGrantableAction(repos({ ...keyCard, status: 'denied' }) as never, 'u1', 'a1')).rejects.toMatchObject({ statusCode: 409 });
  });

  it('grantProject(..., "all") writes scope all and the view carries it', async () => {
    const r = repos(boardCard);
    const g = await grantProject(r as never, 'u1', boardCard as never, 'p1', 'all');
    expect(r.chatProjectGrants.grant).toHaveBeenCalledWith(expect.objectContaining({ project_id: 'p1', scope: 'all' }));
    expect(g.scope).toBe('all');
  });

  it('grantProject defaults to board', async () => {
    const r = repos(boardCard);
    await grantProject(r as never, 'u1', boardCard as never, 'p1');
    expect(r.chatProjectGrants.grant).toHaveBeenCalledWith(expect.objectContaining({ scope: 'board' }));
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

  // A cursor-aware fake, unlike `repos` above (which ignores its cursor entirely): filters to rows
  // strictly after the given (created_at, id) in desc order, exactly like the real repositories'
  // `listForUser`, so a genuine two-page round trip can be driven through `listGrants` itself.
  function cursoredTable(rows: { id: string; created_at: string }[]) {
    const sorted = [...rows].sort((a, b) => (a.created_at === b.created_at ? (a.id < b.id ? 1 : -1) : a.created_at < b.created_at ? 1 : -1));
    return vi.fn(async (_userId: string, opts: { cursor: { created_at: string; id: string } | null; limit: number }) => {
      const after = opts.cursor
        ? sorted.filter((r) => r.created_at < opts.cursor!.created_at || (r.created_at === opts.cursor!.created_at && r.id < opts.cursor!.id))
        : sorted;
      const page = after.slice(0, opts.limit);
      const last = page[page.length - 1];
      return { grants: page, next: after.length > opts.limit && last ? { created_at: last.created_at, id: last.id } : null };
    });
  }

  it('kinds=all: a two-page round trip skips nothing and repeats nothing when both tables still have rows after the cut', async () => {
    const r = {
      chatGrants: { listForUser: cursoredTable([tab('g2', '2026-01-04T00:00:00.000Z'), tab('g1', '2026-01-02T00:00:00.000Z')]) },
      chatProjectGrants: { listForUser: cursoredTable([proj('pg2', '2026-01-03T00:00:00.000Z'), proj('pg1', '2026-01-01T00:00:00.000Z')]) },
      tabs: { findByIdsForOwner: vi.fn(async () => []) },
      projects: { findByIdsForOwner: vi.fn(async () => [{ id: 'p1', name: 'App' }]) },
    } as never;

    const page1 = await listGrants(r, 'u1', { state: 'ended', limit: 2, kinds: 'all' });
    expect(page1.grants.map((g) => g.id)).toEqual(['g2', 'pg2']);
    expect(page1.next_cursor).not.toBeNull();

    const page2 = await listGrants(r, 'u1', { state: 'ended', limit: 2, kinds: 'all', cursor: page1.next_cursor! });
    expect(page2.grants.map((g) => g.id)).toEqual(['g1', 'pg1']);
    expect(page2.next_cursor).toBeNull();

    // Every row of both tables appears exactly once across the two pages, oldest-to-newest order kept.
    expect([...page1.grants, ...page2.grants].map((g) => g.id)).toEqual(['g2', 'pg2', 'g1', 'pg1']);
  });
});
