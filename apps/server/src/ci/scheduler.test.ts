import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Repositories } from '../db/repositories/index.js';
import { GithubCiError, type GithubCiClient } from '../integrations/github-ci.js';

const sync = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock('./sync.js', () => ({ syncProjectCi: (...a: unknown[]) => sync.fn(...a) }));

import { ciTick, startCiSyncScheduler, type CiTickState } from './scheduler.js';

const NOW = new Date('2026-09-27T12:00:00Z');
const log = { info: vi.fn(), warn: vi.fn() };

function setup(doing: Record<string, boolean>, watched: Record<string, number>, deployWorkflow: string | null = 'deploy.yml') {
  const repos = {
    projectSetup: {
      listWithRepo: vi.fn(async () =>
        Object.keys(doing).map((id) => ({ project_id: id, data: { repo: { integration_id: 'i1', full_name: `acme/${id}`, deploy_workflow: deployWorkflow } } })),
      ),
    },
    tasks: { hasDoing: vi.fn(async (id: string) => doing[id]) },
    taskPullRequests: { listWatched: vi.fn(async (id: string) => Array.from({ length: watched[id] ?? 0 }, () => ({}))) },
  } as unknown as Repositories;
  const state: CiTickState = { etags: new Map(), pausedUntil: new Map() };
  return { deps: { repos, github: {} as GithubCiClient, log, now: () => NOW }, state };
}

beforeEach(() => {
  sync.fn.mockReset().mockResolvedValue({ pulls: 0, checked: 0 });
});

describe('ciTick', () => {
  it('syncs projects with a card in doing or a watched PR, and skips the others', async () => {
    const { deps, state } = setup({ p1: true, p2: false, p3: false }, { p2: 1 });
    await ciTick(deps, state);
    expect(sync.fn.mock.calls.map((c) => c[1])).toEqual(['p1', 'p2']);
  });

  it('pauses a rate-limited project until the reset, and keeps going with the others', async () => {
    const { deps, state } = setup({ p1: true, p2: true }, {});
    sync.fn.mockImplementation(async (_d: unknown, id: string) => {
      if (id === 'p1') throw new GithubCiError('rate_limited', 403, new Date('2026-09-27T12:30:00Z'));
      return { pulls: 0, checked: 0 };
    });
    await ciTick(deps, state);
    expect(state.pausedUntil.get('p1')).toBe(Date.parse('2026-09-27T12:30:00Z'));
    sync.fn.mockClear();
    await ciTick(deps, state);
    expect(sync.fn.mock.calls.map((c) => c[1])).toEqual(['p2']);
  });

  it('asks the busy check for the current repo, and for merged PRs only with a deploy workflow', async () => {
    const withDeploy = setup({ p1: false }, {});
    await ciTick(withDeploy.deps, withDeploy.state);
    expect(withDeploy.deps.repos.taskPullRequests.listWatched).toHaveBeenCalledWith('p1', { repo: 'acme/p1', includeMerged: true }, NOW);
    const noDeploy = setup({ p1: false }, {}, null);
    await ciTick(noDeploy.deps, noDeploy.state);
    expect(noDeploy.deps.repos.taskPullRequests.listWatched).toHaveBeenCalledWith('p1', { repo: 'acme/p1', includeMerged: false }, NOW);
  });

  it('logs a failing busy check and keeps going, never throwing out of the tick', async () => {
    const { deps, state } = setup({ p1: true, p2: true }, {});
    vi.mocked(deps.repos.tasks.hasDoing).mockRejectedValueOnce(new Error('db down'));
    await expect(ciTick(deps, state)).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith({ projectId: 'p1', err: 'db down' }, 'ci sync failed');
    expect(sync.fn.mock.calls.map((c) => c[1])).toEqual(['p2']);
  });

  it('logs other failures without the token and continues', async () => {
    const { deps, state } = setup({ p1: true, p2: true }, {});
    sync.fn.mockRejectedValueOnce(new GithubCiError('auth', 401));
    await ciTick(deps, state);
    expect(sync.fn).toHaveBeenCalledTimes(2);
    expect(log.warn).toHaveBeenCalledWith({ projectId: 'p1', err: 'GitHub 401 (auth)' }, 'ci sync failed');
  });

  it('logs a pass that throws instead of leaving an unhandled rejection', async () => {
    vi.useFakeTimers();
    try {
      const repos = { projectSetup: { listWithRepo: vi.fn(async () => null) } } as unknown as Repositories; // iterating null throws
      const stop = startCiSyncScheduler(repos, log, {} as GithubCiClient);
      await vi.advanceTimersByTimeAsync(10_000);
      stop();
      expect(log.warn).toHaveBeenCalledWith({ err: expect.any(String) }, 'ci tick failed');
    } finally {
      vi.useRealTimers();
    }
  });
});
