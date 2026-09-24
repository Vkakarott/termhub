// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MonitorItem, Tab } from './types';

const tab = (id: string, over: Partial<Tab> = {}) => ({ id, project_id: 'p1', machine_id: 'm1', name: id, kind: 'terminal', position: 0, state: null, state_at: null, state_seen_at: null, ...over }) as Tab;
const item = (t: Tab) => ({ tab: t, project: { id: t.project_id }, machine: { id: t.machine_id } }) as MonitorItem;

const api = vi.hoisted(() => ({ tabs: vi.fn(), openTabs: vi.fn() }));
vi.mock('./api', () => ({ api: { monitor: api, tabs: {} } }));
vi.mock('./auth', () => ({ useAuth: () => ({ can: () => true }) }));

import { MonitorProvider, useMonitor } from './monitor';

class FakeSocket {
  static last: FakeSocket | null = null;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
    FakeSocket.last = this;
  }
  close() {}
  push(frame: object) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

type Monitor = ReturnType<typeof useMonitor>;
function mount() {
  let m!: Monitor;
  function Probe() {
    m = useMonitor();
    return null;
  }
  render(
    <MonitorProvider>
      <Probe />
    </MonitorProvider>,
  );
  return () => m;
}

beforeEach(() => {
  vi.stubGlobal('WebSocket', FakeSocket);
  api.tabs.mockResolvedValue({ items: [item(tab('t1', { state: 'working', state_at: '2026-09-23T10:00:00.000Z' }))] });
  api.openTabs.mockResolvedValue({ items: [item(tab('t1', { state: 'working', state_at: '2026-09-23T10:00:00.000Z' })), item(tab('t2'))] });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('MonitorProvider open tabs', () => {
  it('loads every open terminal tab, not only those that reported a state', async () => {
    const m = mount();
    await waitFor(() => expect(m().openTabs.map((t) => t.id)).toEqual(['t1', 't2']));
    expect(m().items.map((i) => i.tab.id)).toEqual(['t1']);
  });

  it('adds, renames and drops tabs from the monitor pushes, leaving the state items alone', async () => {
    const m = mount();
    await waitFor(() => expect(m().openTabs).toHaveLength(2));
    const ws = FakeSocket.last!;
    act(() => ws.push({ type: 'tab_upsert', tab: tab('t3', { name: 'Caio' }), project_id: 'p1', machine_id: 'm1' }));
    act(() => ws.push({ type: 'tab_upsert', tab: tab('t2', { name: 'Bia' }), project_id: 'p1', machine_id: 'm1' }));
    act(() => ws.push({ type: 'tab_removed', tab_id: 't1', project_id: 'p1', machine_id: 'm1' }));
    expect(m().openTabs.map((t) => [t.id, t.name])).toEqual([
      ['t2', 'Bia'],
      ['t3', 'Caio'],
    ]);
    expect(m().items.map((i) => i.tab.id)).toEqual(['t1']); // the state list keeps its own rules
  });

  it('follows state pushes on an open tab, so its dot changes live', async () => {
    const m = mount();
    await waitFor(() => expect(m().openTabs).toHaveLength(2));
    act(() => FakeSocket.last!.push({ type: 'tab', tab: { ...tab('t2'), state: 'waiting_input', state_at: '2026-09-23T11:00:00.000Z' }, project_id: 'p1', machine_id: 'm1' }));
    expect(m().openTabs.find((t) => t.id === 't2')?.state).toBe('waiting_input');
  });
});

describe('MonitorProvider open tabs vs a snapshot in flight', () => {
  it('keeps pushes that arrive while a reload is in flight: the older snapshot does not undo them', async () => {
    const m = mount();
    await waitFor(() => expect(m().openTabs).toHaveLength(2));
    // the next snapshot was read before t1 closed and before t3 opened, and lands after both pushes
    let land!: () => void;
    api.openTabs.mockReturnValueOnce(
      new Promise((resolve) => {
        land = () => resolve({ items: [item(tab('t1')), item(tab('t2'))] });
      }),
    );
    let reloading!: Promise<void>;
    act(() => {
      reloading = m().reload();
    });
    const ws = FakeSocket.last!;
    act(() => ws.push({ type: 'tab_removed', tab_id: 't1', project_id: 'p1', machine_id: 'm1' }));
    act(() => ws.push({ type: 'tab_upsert', tab: tab('t3'), project_id: 'p1', machine_id: 'm1' }));
    await act(async () => {
      land();
      await reloading;
    });
    expect(m().openTabs.map((t) => t.id)).toEqual(['t2', 't3']);

    // once applied, the frames are forgotten: the next snapshot is the truth again
    api.openTabs.mockResolvedValueOnce({ items: [item(tab('t1')), item(tab('t2'))] });
    await act(async () => {
      await m().reload();
    });
    expect(m().openTabs.map((t) => t.id)).toEqual(['t1', 't2']);
  });
});

describe('MonitorProvider openTabsLoaded', () => {
  it('is false until the first open-tabs snapshot arrives, then true', async () => {
    let resolve!: (v: { items: MonitorItem[] }) => void;
    api.openTabs.mockReturnValue(new Promise((r) => (resolve = r)));
    const m = mount();
    expect(m().openTabsLoaded).toBe(false);
    await act(async () => resolve({ items: [] }));
    await waitFor(() => expect(m().openTabsLoaded).toBe(true));
    expect(m().openTabsFailed).toBe(false);
  });

  it('stays false when the first snapshot fails, flagging the failure instead', async () => {
    api.openTabs.mockRejectedValue(new Error('offline'));
    const m = mount();
    await waitFor(() => expect(m().openTabsFailed).toBe(true));
    expect(m().openTabsLoaded).toBe(false);
  });

  it('a later successful read (resync, reconnect) marks the tabs loaded and clears the failure', async () => {
    api.openTabs.mockRejectedValue(new Error('offline'));
    const m = mount();
    await waitFor(() => expect(m().openTabsFailed).toBe(true));
    api.openTabs.mockResolvedValue({ items: [] });
    await act(async () => {
      await m().reload();
    });
    expect(m().openTabsLoaded).toBe(true);
    expect(m().openTabsFailed).toBe(false);
  });
});
