import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config.js', () => ({ config: { publicUrl: 'https://app.test' } }));
const syncProjectTickets = vi.fn();
let last: unknown = null;
// The wrapper (not `syncProjectTickets` itself) is what the hoisted factory reads eagerly; a direct
// shorthand reference here would hit the TDZ (imports run before this file's own top-level `const`).
vi.mock('../setup/tickets-sync.js', () => ({ syncProjectTickets: (...args: unknown[]) => syncProjectTickets(...args), lastSync: () => last }));
const updateStatus = vi.fn();
vi.mock('../integrations/index.js', () => ({ getProvider: () => ({ updateStatus }) }));

import type { Repositories } from '../db/repositories/index.js';
import type { Project, Task, Ticket } from '../db/repositories/types.js';
import { Scoped } from '../auth/scope.js';
import type { ControlContext } from './context.js';
import { getTicket, importTickets, listTickets, pushTicketStatus, syncTickets } from './tickets.js';

const project = (id: string, owner: string): Project => ({ id, owner_id: owner, key: id.toUpperCase(), next_task_number: 1, name: id, status: 'active', description: null, last_terminal_at: null, created_at: '' });
const ticket = (over: Partial<Ticket> & { id: string; key: string }): Ticket => ({
  project_id: 'p1', integration_id: 'g', scope: 'acme/api', provider: 'github', sync_key: `s-${over.id}`, title: `T ${over.id}`,
  description: 'x'.repeat(800), url: `https://github.com/${over.key.replace('#', '/issues/')}`, state: 'open', status: 'backlog',
  meta: { labels: ['bug'], assignee: 'ana' }, task_id: null, synced_at: '2026-09-26T10:00:00.000Z', created_at: '', ...over,
});
const task = (over: Partial<Task> & { id: string }): Task => ({
  project_id: 'p1', type: 'task', number: 7, ref: 'P1-7', title: 't', description: null, status: 'doing', position: 0, external_ref: null, external_key: null,
  tab_id: null, parent_id: null, epic_id: 'e1', column_id: 'c2', created_at: '', updated_at: '', ...over,
});

let tickets: Ticket[];
let tasks: Task[];
function ctxFor(user = 'u1'): ControlContext {
  const projects = [project('p1', 'u1'), project('p2', 'u1'), project('px', 'u2')];
  const repos = {
    projects: { findById: vi.fn(async (id: string) => projects.find((p) => p.id === id)), list: vi.fn(async () => projects.filter((p) => p.owner_id === user)) },
    projectSetup: { get: vi.fn(async () => ({ data: { ticket_sources: [{ provider: 'github', integration_id: 'g', scope: 'acme/api', filter: null, sync_minutes: 0 }] } })) },
    tickets: {
      listByProject: vi.fn(async (pid: string) => tickets.filter((t) => t.project_id === pid)),
      findByIds: vi.fn(async (pid: string, ids: string[]) => tickets.filter((t) => t.project_id === pid && ids.includes(t.id))),
      findByKeyish: vi.fn(async (pids: string[], q: { key?: string; url?: string; suffix?: string }) =>
        tickets.filter((t) => pids.includes(t.project_id) && (q.url ? t.url === q.url : q.key ? t.key.toLowerCase() === q.key.toLowerCase() : t.key.toLowerCase().endsWith(q.suffix!.toLowerCase())))),
      findByTaskId: vi.fn(async (id: string) => tickets.find((t) => t.task_id === id)),
      linkTask: vi.fn(async (tid: string, taskId: string) => { tickets = tickets.map((t) => (t.id === tid ? { ...t, task_id: taskId } : t)); }),
    },
    tasks: {
      findById: vi.fn(async (id: string) => tasks.find((t) => t.id === id)),
      findByIds: vi.fn(async (ids: string[]) => tasks.filter((t) => ids.includes(t.id))),
      createFromTicket: vi.fn(async (pid: string, input: { title: string; ref: Record<string, unknown> }) => { const t = task({ id: `new-${tasks.length}`, project_id: pid, title: input.title, external_ref: input.ref }); tasks.push(t); return t; }),
      setExternalRef: vi.fn(async () => undefined),
    },
    integrations: { findById: vi.fn(async () => ({ id: 'g', owner_id: 'u1', provider: 'github', config: {} })), getSecret: vi.fn(async () => 'tok') },
  } as unknown as Repositories;
  const scope = { user: { id: user } as never, viewAs: { kind: 'self' as const }, ownerId: user, createAs: user };
  return { repos, scope, scoped: new Scoped(repos, scope), can: async () => true };
}

beforeEach(() => {
  vi.clearAllMocks();
  last = null;
  tickets = [
    ticket({ id: 'a', key: 'acme/api#12' }),
    ticket({ id: 'b', key: 'acme/web#12', scope: 'acme/web' }),
    ticket({ id: 'c', key: 'acme/api#13', task_id: 'k1', status: 'doing' }),
    ticket({ id: 'd', key: 'EI-5', provider: 'linear', project_id: 'p2', scope: 'EI', url: 'https://linear.app/x/issue/EI-5' }),
    ticket({ id: 'e', key: 'EI-5', provider: 'linear', project_id: 'p1', scope: 'EI', url: 'https://linear.app/y/issue/EI-5' }),
  ];
  tasks = [task({ id: 'k1', external_ref: { provider: 'github', id: '13', identifier: '#13', url: 'u', state: 'open', status: 'backlog', scope: 'acme/api' } })];
});

describe('listTickets', () => {
  it('filters by imported and query, cuts descriptions, names the card', async () => {
    const r = await listTickets(ctxFor(), { project_id: 'p1', imported: true });
    expect(r.tickets.map((t) => t.key)).toEqual(['acme/api#13']);
    expect(r.tickets[0].card).toEqual({ ref: 'P1-7', url: 'https://app.test/project/P1-7' });
    expect(r.tickets[0].description).toHaveLength(501); // 500 + "…"
    expect(r.tickets[0]).toMatchObject({ labels: ['bug'], assignee: 'ana', source: { provider: 'github', scope: 'acme/api' } });
    expect((await listTickets(ctxFor(), { project_id: 'p1', query: 'WEB#12' })).tickets.map((t) => t.key)).toEqual(['acme/web#12']);
  });

  it('is a 404 on another owner\'s project', async () => {
    await expect(listTickets(ctxFor('u2'), { project_id: 'p1' })).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('getTicket', () => {
  it('resolves exact key, URL and repo#n, with the full description', async () => {
    const ctx = ctxFor();
    expect((await getTicket(ctx, { project_id: 'p1', key: 'ACME/API#12' })).ticket.description).toHaveLength(800);
    expect((await getTicket(ctx, { project_id: 'p1', key: 'https://github.com/acme/web/issues/12' })).ticket.key).toBe('acme/web#12');
    expect((await getTicket(ctx, { project_id: 'p1', key: 'api#13' })).ticket.key).toBe('acme/api#13');
  });

  it('#12 matching two repos is TICKET_AMBIGUOUS naming both keys', async () => {
    await expect(getTicket(ctxFor(), { project_id: 'p1', key: '#12' })).rejects.toMatchObject({ code: 'TICKET_AMBIGUOUS', message: expect.stringContaining('acme/api#12, acme/web#12') });
  });

  it('without project: exact keys only, and the same key in two projects is ambiguous', async () => {
    await expect(getTicket(ctxFor(), { key: 'EI-5' })).rejects.toMatchObject({ code: 'TICKET_AMBIGUOUS' });
    await expect(getTicket(ctxFor(), { key: '#12' })).rejects.toMatchObject({ code: 'TICKET_NOT_FOUND' });
  });
});

describe('syncTickets', () => {
  it('reuses a sync younger than 60 s', async () => {
    last = { sources: [], synced_at: new Date(1_000_000).toISOString() };
    const r = await syncTickets(ctxFor(), { project_id: 'p1' }, 1_000_000 + 30_000);
    expect(r.cached).toBe(true);
    expect(syncProjectTickets).not.toHaveBeenCalled();
  });

  it('syncs when older, and says NO_TICKET_SOURCE without sources', async () => {
    syncProjectTickets.mockResolvedValue({ sources: [], synced_at: 'now' });
    last = { sources: [], synced_at: new Date(0).toISOString() };
    expect((await syncTickets(ctxFor(), { project_id: 'p1' }, 120_000)).cached).toBe(false);
    const ctx = ctxFor();
    (ctx.repos.projectSetup.get as ReturnType<typeof vi.fn>).mockResolvedValue({ data: { ticket_sources: [] } });
    await expect(syncTickets(ctx, { project_id: 'p1' })).rejects.toMatchObject({ code: 'NO_TICKET_SOURCE' });
  });
});

describe('importTickets', () => {
  it('imports by key with the plain title, and is idempotent', async () => {
    const ctx = ctxFor();
    const r = await importTickets(ctx, { project_id: 'p1', keys: ['acme/api#12', 'acme/api#13'] });
    expect(r.cards.map((c) => [c.ticket_key, c.created])).toEqual([['acme/api#12', true], ['acme/api#13', false]]);
    expect(ctx.repos.tasks.createFromTicket).toHaveBeenCalledWith('p1', expect.objectContaining({ title: 'T a', key: 's-a', ref: expect.objectContaining({ key: 'acme/api#12', integration_id: 'g' }) }));
  });
});

describe('pushTicketStatus', () => {
  it('finds the source of a legacy link by provider + scope and pushes the card status', async () => {
    updateStatus.mockResolvedValue('open');
    const r = await pushTicketStatus(ctxFor(), { task_id: 'k1' });
    expect(updateStatus).toHaveBeenCalledWith('tok', {}, { provider_id: '13', key: 'acme/api#13', scope: 'acme/api' }, 'doing');
    expect(r.ticket_key).toBe('acme/api#13');
  });

  it('a card without a ticket is NOT_LINKED', async () => {
    tasks.push(task({ id: 'k2' }));
    await expect(pushTicketStatus(ctxFor(), { task_id: 'k2' })).rejects.toMatchObject({ code: 'NOT_LINKED' });
  });
});
