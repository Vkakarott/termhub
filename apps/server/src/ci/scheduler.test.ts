import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Repositories } from '../db/repositories/index.js';
import { GithubCiError, type GithubCiClient } from '../integrations/github-ci.js';

const sync = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock('./sync.js', () => ({ syncProjectCi: (...a: unknown[]) => sync.fn(...a) }));

import { ciTick, type CiTickState } from './scheduler.js';

const NOW = new Date('2026-09-27T12:00:00Z');
const log = { info: vi.fn(), warn: vi.fn() };

function setup(doing: Record<string, boolean>, watched: Record<string, number>) {
  const repos = {
    projectSetup: { listWithRepo: vi.fn(async () => Object.keys(doing).map((id) => ({ project_id: id, data: {} }))) },
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

  it('logs other failures without the token and continues', async () => {
    const { deps, state } = setup({ p1: true, p2: true }, {});
    sync.fn.mockRejectedValueOnce(new GithubCiError('auth', 401));
    await ciTick(deps, state);
    expect(sync.fn).toHaveBeenCalledTimes(2);
    expect(log.warn).toHaveBeenCalledWith({ projectId: 'p1', err: 'GitHub 401 (auth)' }, 'ci sync failed');
  });
});
