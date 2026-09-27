import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startMemorySweeper } from './sweeper.js';

const log = () => ({ info: vi.fn(), warn: vi.fn() });
const embedder = () => ({ embed: vi.fn(async (texts: string[]) => ({ model: 'm', vectors: texts.map(() => [1, 0]) })) });

function fakeRepos(opts: { owners?: string[]; tasks?: { id: string; project_id: string; updated_at: string }[]; toEmbed?: { id: string; title: string; text: string }[] } = {}) {
  const listOwnersWithTasks = vi.fn(async () => opts.owners ?? []);
  const listChangedForOwner = vi.fn(async () => opts.tasks ?? []);
  const findByIdsForOwner = vi.fn(async () => []);
  const listSourceAt = vi.fn(async () => new Map<string, string>());
  const upsertMany = vi.fn(async (items: { title: string; text: string }[]) => items.map((it, i) => ({ id: `m${i + 1}`, ...it })));
  const listToEmbed = vi.fn(async () => opts.toEmbed ?? []);
  const setEmbedding = vi.fn(async () => {});
  const deleteBySource = vi.fn(async () => 0);
  return {
    tasks: { listChangedForOwner, findByIdsForOwner },
    memoryItems: { listSourceAt, upsertMany, listToEmbed, setEmbedding, deleteBySource },
    listOwnersWithTasksMock: listOwnersWithTasks,
    build() {
      return { tasks: { listChangedForOwner, findByIdsForOwner, listOwnersWithTasks }, memoryItems: { listSourceAt, upsertMany, listToEmbed, setEmbedding, deleteBySource } };
    },
  };
}

describe('startMemorySweeper', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('one tick indexes tasks per owner, then embeds the pending backlog', async () => {
    const owners = ['u1', 'u2'];
    const task = { id: 't1', project_id: 'p1', updated_at: '2026-09-26T09:00:00.000Z' };
    const repos = fakeRepos({ owners, tasks: [task], toEmbed: [{ id: 'm1', title: 'Mensagem', text: 'oi' }] });
    const e = embedder();
    const built = { tasks: { listChangedForOwner: repos.tasks.listChangedForOwner, findByIdsForOwner: repos.tasks.findByIdsForOwner, listOwnersWithTasks: repos.listOwnersWithTasksMock }, memoryItems: repos.memoryItems };
    const stop = startMemorySweeper(built as never, log(), e, 1000);
    await vi.advanceTimersByTimeAsync(0);

    expect(repos.listOwnersWithTasksMock).toHaveBeenCalledTimes(1);
    // Indexed once per owner: `listSourceAt` (the per-owner comparison) is called for each.
    expect(repos.memoryItems.listSourceAt).toHaveBeenCalledTimes(owners.length);
    expect(repos.memoryItems.listSourceAt).toHaveBeenCalledWith('task', 'u1');
    expect(repos.memoryItems.listSourceAt).toHaveBeenCalledWith('task', 'u2');
    // Then one embed batch of (up to) 32, one embed() call for the whole backlog.
    expect(repos.memoryItems.listToEmbed).toHaveBeenCalledWith(32);
    expect(e.embed).toHaveBeenCalledTimes(1);
    expect(repos.memoryItems.setEmbedding).toHaveBeenCalledWith('m1', [1, 0], 'm');
    stop();
  });

  it('with embedder: null only the indexing step runs', async () => {
    const repos = fakeRepos({ owners: ['u1'] });
    const built = { tasks: { listChangedForOwner: repos.tasks.listChangedForOwner, findByIdsForOwner: repos.tasks.findByIdsForOwner, listOwnersWithTasks: repos.listOwnersWithTasksMock }, memoryItems: repos.memoryItems };
    const stop = startMemorySweeper(built as never, log(), null, 1000);
    await vi.advanceTimersByTimeAsync(0);
    expect(repos.listOwnersWithTasksMock).toHaveBeenCalledTimes(1);
    expect(repos.memoryItems.listToEmbed).not.toHaveBeenCalled();
    stop();
  });

  it('runs once immediately and again after intervalMs; the returned stop clears the timer', async () => {
    const repos = fakeRepos({ owners: ['u1'] });
    const built = { tasks: { listChangedForOwner: repos.tasks.listChangedForOwner, findByIdsForOwner: repos.tasks.findByIdsForOwner, listOwnersWithTasks: repos.listOwnersWithTasksMock }, memoryItems: repos.memoryItems };
    const stop = startMemorySweeper(built as never, log(), null, 1000);
    await vi.advanceTimersByTimeAsync(0);
    expect(repos.listOwnersWithTasksMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(repos.listOwnersWithTasksMock).toHaveBeenCalledTimes(2);
    stop();
    await vi.advanceTimersByTimeAsync(2000);
    expect(repos.listOwnersWithTasksMock).toHaveBeenCalledTimes(2);
  });

  it('an overlapping tick is skipped: a slow tick blocks the next scheduled one', async () => {
    let resolveFirst!: () => void;
    const gate = new Promise<void>((r) => {
      resolveFirst = r;
    });
    const listOwnersWithTasks = vi.fn(async () => {
      await gate;
      return [];
    });
    const repos = fakeRepos();
    const built = { tasks: { listChangedForOwner: repos.tasks.listChangedForOwner, findByIdsForOwner: repos.tasks.findByIdsForOwner, listOwnersWithTasks }, memoryItems: repos.memoryItems };
    const stop = startMemorySweeper(built as never, log(), null, 1000);
    await vi.advanceTimersByTimeAsync(0);
    expect(listOwnersWithTasks).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(listOwnersWithTasks).toHaveBeenCalledTimes(1); // skipped: `running` was still true
    resolveFirst();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(listOwnersWithTasks).toHaveBeenCalledTimes(2);
    stop();
  });

  it('an indexing failure still lets the embed step run, and logs only a code', async () => {
    const listOwnersWithTasks = vi.fn(async () => {
      throw Object.assign(new Error('db down'), { code: 'P2024' });
    });
    const repos = fakeRepos({ toEmbed: [{ id: 'm1', title: 'Mensagem', text: 'oi' }] });
    const built = { tasks: { listChangedForOwner: repos.tasks.listChangedForOwner, findByIdsForOwner: repos.tasks.findByIdsForOwner, listOwnersWithTasks }, memoryItems: repos.memoryItems };
    const e = embedder();
    const l = log();
    const stop = startMemorySweeper(built as never, l, e, 1000);
    await vi.advanceTimersByTimeAsync(0);
    expect(repos.memoryItems.listToEmbed).toHaveBeenCalledTimes(1);
    expect(l.warn).toHaveBeenCalledWith({ code: 'P2024' }, expect.any(String));
    stop();
  });

  it('a failure indexing one owner does not stop the next owner from being indexed', async () => {
    const listSourceAt = vi.fn(async (_kind: 'task', ownerId: string) => {
      if (ownerId === 'u1') throw Object.assign(new Error('db down'), { code: 'P2024' });
      return new Map<string, string>();
    });
    const repos = fakeRepos({ owners: ['u1', 'u2'] });
    const built = {
      tasks: { listChangedForOwner: repos.tasks.listChangedForOwner, findByIdsForOwner: repos.tasks.findByIdsForOwner, listOwnersWithTasks: repos.listOwnersWithTasksMock },
      memoryItems: { ...repos.memoryItems, listSourceAt },
    };
    const l = log();
    const stop = startMemorySweeper(built as never, l, null, 1000);
    await vi.advanceTimersByTimeAsync(0);
    expect(listSourceAt).toHaveBeenCalledWith('task', 'u1');
    expect(listSourceAt).toHaveBeenCalledWith('task', 'u2');
    stop();
  });

  it('uses the default interval when none is given', async () => {
    const repos = fakeRepos();
    const built = { tasks: { listChangedForOwner: repos.tasks.listChangedForOwner, findByIdsForOwner: repos.tasks.findByIdsForOwner, listOwnersWithTasks: repos.listOwnersWithTasksMock }, memoryItems: repos.memoryItems };
    const { MEMORY_SWEEP_INTERVAL_MS } = await import('./sweeper.js');
    const stop = startMemorySweeper(built as never, log(), null);
    await vi.advanceTimersByTimeAsync(0);
    expect(repos.listOwnersWithTasksMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(MEMORY_SWEEP_INTERVAL_MS - 1);
    expect(repos.listOwnersWithTasksMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(repos.listOwnersWithTasksMock).toHaveBeenCalledTimes(2);
    stop();
  });

  it('the timer is unref’d, so it never keeps the process alive', async () => {
    const repos = fakeRepos();
    const built = { tasks: { listChangedForOwner: repos.tasks.listChangedForOwner, findByIdsForOwner: repos.tasks.findByIdsForOwner, listOwnersWithTasks: repos.listOwnersWithTasksMock }, memoryItems: repos.memoryItems };
    vi.useRealTimers();
    const spy = vi.spyOn(globalThis, 'setInterval');
    const stop = startMemorySweeper(built as never, log(), null, 50000);
    const timer = spy.mock.results[0]!.value as { unref?: () => void };
    expect(typeof timer.unref).toBe('function');
    stop();
    spy.mockRestore();
    vi.useFakeTimers();
  });

  it('runs the docs pass on the first tick and every third tick after, one call per link', async () => {
    const repos = fakeRepos();
    const listAllWithOwner = vi.fn(async () => [
      { id: 'L1', project_id: 'p1', owner_id: 'u1', cwd: '/a', machine: { id: 'm1', type: 'agent' } },
      { id: 'L2', project_id: 'p2', owner_id: 'u2', cwd: '/b', machine: { id: 'm2', type: 'ssh' } },
    ]);
    const built = {
      tasks: { listChangedForOwner: repos.tasks.listChangedForOwner, findByIdsForOwner: repos.tasks.findByIdsForOwner, listOwnersWithTasks: repos.listOwnersWithTasksMock },
      memoryItems: { ...repos.memoryItems, listSourceHashes: vi.fn(async () => new Map()), deleteChunksFrom: vi.fn(async () => 0) },
      projectMachines: { listAllWithOwner },
    };
    const exec = { scan: vi.fn(async () => ''), read: vi.fn(async () => '') };
    const stop = startMemorySweeper(built as never, log(), null, 1000, exec);
    await vi.advanceTimersByTimeAsync(0);
    expect(listAllWithOwner).toHaveBeenCalledTimes(1);
    expect(exec.scan.mock.calls.map((c) => (c[0] as { id: string }).id)).toEqual(['m1', 'm2']);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(listAllWithOwner).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(listAllWithOwner).toHaveBeenCalledTimes(2);
    expect(repos.listOwnersWithTasksMock).toHaveBeenCalledTimes(4);
    stop();
  });

  it('a failing link does not stop the next one, and logs only the link id and a code', async () => {
    const repos = fakeRepos();
    const listSourceHashes = vi.fn(async (_k: string, prefix: string) => {
      if (prefix === 'L1:') throw Object.assign(new Error('db down'), { code: 'P2024' });
      return new Map();
    });
    const built = {
      tasks: { listChangedForOwner: repos.tasks.listChangedForOwner, findByIdsForOwner: repos.tasks.findByIdsForOwner, listOwnersWithTasks: repos.listOwnersWithTasksMock },
      memoryItems: { ...repos.memoryItems, listSourceHashes, deleteChunksFrom: vi.fn(async () => 0) },
      projectMachines: {
        listAllWithOwner: vi.fn(async () => [
          { id: 'L1', project_id: 'p1', owner_id: 'u1', cwd: '/a', machine: { id: 'm1', type: 'agent' } },
          { id: 'L2', project_id: 'p2', owner_id: 'u2', cwd: '/b', machine: { id: 'm2', type: 'agent' } },
        ]),
      },
    };
    const exec = { scan: vi.fn(async () => ''), read: vi.fn(async () => '') };
    const l = log();
    const stop = startMemorySweeper(built as never, l, null, 1000, exec);
    await vi.advanceTimersByTimeAsync(0);
    expect(listSourceHashes).toHaveBeenCalledWith('doc', 'L2:');
    expect(l.warn).toHaveBeenCalledWith({ linkId: 'L1', code: 'P2024' }, expect.any(String));
    stop();
  });

  it('a failing link listing still lets the embed step run', async () => {
    const repos = fakeRepos({ toEmbed: [{ id: 'm1', title: 'Mensagem', text: 'oi' }] });
    const built = {
      tasks: { listChangedForOwner: repos.tasks.listChangedForOwner, findByIdsForOwner: repos.tasks.findByIdsForOwner, listOwnersWithTasks: repos.listOwnersWithTasksMock },
      memoryItems: repos.memoryItems,
      projectMachines: { listAllWithOwner: vi.fn(async () => Promise.reject(Object.assign(new Error('x'), { code: 'P1001' }))) },
    };
    const e = embedder();
    const l = log();
    const stop = startMemorySweeper(built as never, l, e, 1000);
    await vi.advanceTimersByTimeAsync(0);
    expect(l.warn).toHaveBeenCalledWith({ code: 'P1001' }, expect.any(String));
    expect(e.embed).toHaveBeenCalledTimes(1);
    stop();
  });
});
