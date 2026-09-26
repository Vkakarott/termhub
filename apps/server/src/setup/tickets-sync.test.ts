import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Repositories } from '../db/repositories/index.js';
import type { ExternalTicket } from '../integrations/types.js';

const listTickets = vi.fn();
vi.mock('../integrations/index.js', () => ({ getProvider: () => ({ listTickets }) }));

const { lastSync, syncProjectTickets } = await import('./tickets-sync.js');

const ext = (scope: string, n: number): ExternalTicket => ({
  sync_key: `github:${scope}#${n}`, provider: 'github', provider_id: String(n), key: `${scope}#${n}`, title: 't', description: null,
  url: 'u', state: 'open', status: 'backlog', updatedAt: 'x',
});
const src = (scope: string) => ({ provider: 'github' as const, integration_id: 'g', scope, filter: null, sync_minutes: 0 });

function makeRepos() {
  const upsertMany = vi.fn(async () => ({ created: 1, updated: 0, linked: [{ id: 'tk', sync_key: 'github:acme/api#1', task_id: 'task1' }] }));
  const pruneMissing = vi.fn(async () => 0);
  const setExternalRef = vi.fn(async () => undefined);
  const repos = {
    integrations: { findById: vi.fn(async () => ({ id: 'g', provider: 'github', config: {} })), getSecret: vi.fn(async () => 'tok') },
    tickets: { upsertMany, pruneMissing },
    tasks: { setExternalRef },
  } as unknown as Repositories;
  return { repos, upsertMany, pruneMissing, setExternalRef };
}

// Block body: an arrow returning the mock itself would be treated as an implicit teardown callback by Vitest.
beforeEach(() => {
  listTickets.mockReset();
});

describe('syncProjectTickets', () => {
  it('syncs every source; two sources on one integration prune only their own scope', async () => {
    listTickets.mockImplementation(async (_s: string, _c: unknown, source: { scope: string }) => ({ tickets: [ext(source.scope, 1)], truncated: source.scope === 'acme/web' }));
    const { repos, pruneMissing, upsertMany } = makeRepos();
    const r = await syncProjectTickets(repos, 'p1', [src('acme/api'), src('acme/web')]);
    expect(pruneMissing).toHaveBeenNthCalledWith(1, 'p1', { integration_id: 'g', scope: 'acme/api' }, ['github:acme/api#1'], false);
    expect(pruneMissing).toHaveBeenNthCalledWith(2, 'p1', { integration_id: 'g', scope: 'acme/web' }, ['github:acme/web#1'], false);
    expect(upsertMany.mock.calls[0][1][0]).toMatchObject({ scope: 'acme/api', key: 'acme/api#1', sync_key: 'github:acme/api#1' });
    expect(r.sources.map((s) => [s.scope, s.truncated])).toEqual([['acme/api', false], ['acme/web', true]]);
    expect(lastSync('p1')?.sources).toHaveLength(2);
  });

  it('a failing source does not stop the others', async () => {
    listTickets.mockRejectedValueOnce(new Error('GitHub 401: bad token')).mockResolvedValueOnce({ tickets: [ext('acme/web', 1)], truncated: false });
    const { repos } = makeRepos();
    const r = await syncProjectTickets(repos, 'p1', [src('acme/api'), src('acme/web')]);
    expect(r.sources[0]).toMatchObject({ scope: 'acme/api', error: 'Falha ao consultar github: GitHub 401: bad token' });
    expect(r.sources[1]).toMatchObject({ scope: 'acme/web', fetched: 1 });
  });

  it('one source on its integration also clears pre-scope rows', async () => {
    listTickets.mockResolvedValue({ tickets: [], truncated: false });
    const { repos, pruneMissing } = makeRepos();
    await syncProjectTickets(repos, 'p1', [src('acme/api')]);
    expect(pruneMissing).toHaveBeenCalledWith('p1', { integration_id: 'g', scope: 'acme/api' }, [], true);
  });

  it('refreshes the link of imported cards with integration_id', async () => {
    listTickets.mockResolvedValue({ tickets: [ext('acme/api', 1)], truncated: false });
    const { repos, setExternalRef } = makeRepos();
    await syncProjectTickets(repos, 'p1', [src('acme/api')]);
    expect(setExternalRef).toHaveBeenCalledWith('task1', expect.objectContaining({ key: 'acme/api#1', integration_id: 'g', scope: 'acme/api' }));
  });
});
