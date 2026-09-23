import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Repositories } from '../db/repositories/index.js';

vi.mock('../terminal/machine-exec.js', () => ({ cachedTmuxProbe: () => undefined }));

const { PUBLIC_CITY_MEMO_MAX, PUBLIC_CITY_MEMO_MS, clearPublicCityMemo, readPublicCityCached } = await import('./read.js');
const { publicBus } = await import('./bus.js');

function stubRepos() {
  const findByNickname = vi.fn(async (nickname: string) => ({ id: `u-${nickname}`, name: nickname }));
  const repos = {
    users: { findByNickname },
    machines: { list: vi.fn(async () => [{ id: 'm1', name: 'M' }]) },
    projects: { list: vi.fn(async () => [{ id: 'p1', name: 'P', is_public: true, status: 'active' }]) },
    tabs: { listByProjects: vi.fn(async () => []) },
  } as unknown as Repositories;
  return { repos, findByNickname };
}

describe('readPublicCityCached', () => {
  beforeEach(() => clearPublicCityMemo());

  // Every anonymous surface (snapshot, city page, card) reads through this: one link click or one
  // crawler unfurl must not cost a full read per request.
  it('answers repeated reads of a nickname from one database read while it is fresh', async () => {
    const { repos, findByNickname } = stubRepos();
    let t = 1_000;
    const now = () => t;
    const a = await readPublicCityCached(repos, 'pedro', { now });
    t += PUBLIC_CITY_MEMO_MS - 1;
    const b = await readPublicCityCached(repos, 'pedro', { now });
    expect(b).toBe(a);
    expect(findByNickname).toHaveBeenCalledTimes(1);
    t += 2;
    await readPublicCityCached(repos, 'pedro', { now });
    expect(findByNickname).toHaveBeenCalledTimes(2);
  });

  it('shares one in-flight read between concurrent callers', async () => {
    const { repos, findByNickname } = stubRepos();
    await Promise.all([readPublicCityCached(repos, 'pedro'), readPublicCityCached(repos, 'pedro'), readPublicCityCached(repos, 'pedro')]);
    expect(findByNickname).toHaveBeenCalledTimes(1);
  });

  // Unpublishing must stay immediate for every new read, memo or not.
  it('forgets everything the moment a project is published or unpublished', async () => {
    const { repos, findByNickname } = stubRepos();
    await readPublicCityCached(repos, 'pedro');
    publicBus.publish({ project_id: 'p1', is_public: false });
    await readPublicCityCached(repos, 'pedro');
    expect(findByNickname).toHaveBeenCalledTimes(2);
  });

  it('never keeps a failed read', async () => {
    const { repos, findByNickname } = stubRepos();
    findByNickname.mockRejectedValueOnce(new Error('db down'));
    await expect(readPublicCityCached(repos, 'pedro')).rejects.toThrow('db down');
    expect(await readPublicCityCached(repos, 'pedro')).toBeDefined();
    expect(findByNickname).toHaveBeenCalledTimes(2);
  });

  it('stays bounded however many different nicknames are asked for', async () => {
    const { repos, findByNickname } = stubRepos();
    for (let i = 0; i <= PUBLIC_CITY_MEMO_MAX; i++) await readPublicCityCached(repos, `n${i}`);
    // the oldest entry was evicted to make room for the last one
    await readPublicCityCached(repos, 'n0');
    expect(findByNickname).toHaveBeenCalledTimes(PUBLIC_CITY_MEMO_MAX + 2);
    await readPublicCityCached(repos, `n${PUBLIC_CITY_MEMO_MAX}`);
    expect(findByNickname).toHaveBeenCalledTimes(PUBLIC_CITY_MEMO_MAX + 2);
  });
});
