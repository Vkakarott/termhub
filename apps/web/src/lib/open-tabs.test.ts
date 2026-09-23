import { describe, expect, it } from 'vitest';
import { applyOpenTabFrame } from './open-tabs';
import type { Tab } from './types';

const tab = (id: string, over: Partial<Tab> = {}) => ({ id, project_id: 'p1', machine_id: 'm1', name: id, kind: 'terminal', position: 0, state: null, state_at: null, state_seen_at: null, ...over }) as Tab;

describe('applyOpenTabFrame', () => {
  it('adds a tab opened elsewhere, and replaces one it already has (a rename)', () => {
    const list = [tab('t1')];
    expect(applyOpenTabFrame(list, { type: 'tab_upsert', tab: tab('t2') }).map((t) => t.id)).toEqual(['t1', 't2']);
    expect(applyOpenTabFrame(list, { type: 'tab_upsert', tab: tab('t1', { name: 'Ana' }) })).toEqual([tab('t1', { name: 'Ana' })]);
  });

  it('ignores a simulator tab: only terminals count as agents', () => {
    const list = [tab('t1')];
    expect(applyOpenTabFrame(list, { type: 'tab_upsert', tab: tab('s1', { kind: 'simulator' }) })).toBe(list);
  });

  it('drops a closed tab at once', () => {
    expect(applyOpenTabFrame([tab('t1'), tab('t2')], { type: 'tab_removed', tab_id: 't1' }).map((t) => t.id)).toEqual(['t2']);
  });

  it('merges a state change into the tab it has, so the dot follows live; an unknown tab changes nothing', () => {
    const list = [tab('t1')];
    expect(applyOpenTabFrame(list, { type: 'tab', tab: { ...tab('t1'), state: 'waiting_input', state_at: '2026-09-23T10:00:00.000Z' } })[0]).toMatchObject({ state: 'waiting_input' });
    expect(applyOpenTabFrame(list, { type: 'tab', tab: tab('zz', { state: 'working' }) })).toBe(list);
    expect(applyOpenTabFrame(list, { type: 'tab_removed', tab_id: 'zz' })).toBe(list);
  });
});
