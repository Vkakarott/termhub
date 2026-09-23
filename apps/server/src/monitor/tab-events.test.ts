import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Repositories } from '../db/repositories/index.js';
import type { Tab } from '../db/repositories/types.js';
import { monitorBus, type TabLifecycle } from './bus.js';
import { publishTabOpened, publishTabRemoved, publishTabsRemoved } from './tab-events.js';

const tab = (id: string, machine_id = 'm1', project_id = 'p1') => ({ id, project_id, machine_id, name: id, kind: 'terminal' }) as Tab;

let events: TabLifecycle[] = [];
const off = monitorBus.subscribeLifecycle((e) => events.push(e));
afterEach(() => {
  events = [];
});
process.on('exit', off);

describe('tab lifecycle events', () => {
  it('publishes an opened tab with its machine owner (the scope filter the monitor WS applies)', () => {
    publishTabOpened(tab('t1'), { id: 'm1', owner_id: 'u1' });
    expect(events).toEqual([{ kind: 'upsert', tab: tab('t1'), project_id: 'p1', machine_id: 'm1', owner_id: 'u1' }]);
  });

  it('publishes a removed tab', () => {
    publishTabRemoved(tab('t1'), { id: 'm1', owner_id: null });
    expect(events).toEqual([{ kind: 'removed', tab_id: 't1', project_id: 'p1', machine_id: 'm1', owner_id: null }]);
  });

  it('publishes a batch removal, resolving each machine owner once (a cascade across machines)', async () => {
    const findById = vi.fn(async (id: string) => (id === 'gone' ? undefined : { id, owner_id: id === 'm1' ? 'u1' : 'u2' }));
    const repos = { machines: { findById } } as unknown as Repositories;
    await publishTabsRemoved(repos, [tab('t1', 'm1'), tab('t2', 'm2'), tab('t3', 'm1'), tab('t4', 'gone')]);
    expect(findById).toHaveBeenCalledTimes(3);
    expect(events.map((e) => (e.kind === 'removed' ? [e.tab_id, e.owner_id] : null))).toEqual([
      ['t1', 'u1'],
      ['t2', 'u2'],
      ['t3', 'u1'],
      ['t4', null],
    ]);
  });

  it('uses the machines the caller already has before asking the repository', async () => {
    const findById = vi.fn();
    await publishTabsRemoved({ machines: { findById } } as unknown as Repositories, [tab('t1', 'm1')], [{ id: 'm1', owner_id: 'u9' }]);
    expect(findById).not.toHaveBeenCalled();
    expect(events).toEqual([{ kind: 'removed', tab_id: 't1', project_id: 'p1', machine_id: 'm1', owner_id: 'u9' }]);
  });
});
