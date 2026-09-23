import { describe, expect, it } from 'vitest';
import type { Tab } from '../db/repositories/types.js';
import { lifecycleFrame, stateFrame } from './ws.js';

const tab = { id: 't1', project_id: 'p1', machine_id: 'm1', name: 'Ana', kind: 'terminal' } as Tab;

describe('monitor WS frames', () => {
  it('keeps the state frame as it was', () => {
    expect(stateFrame('u1', { tab, project_id: 'p1', machine_id: 'm1', owner_id: 'u1' })).toEqual({ type: 'tab', tab, project_id: 'p1', machine_id: 'm1' });
    expect(stateFrame('u1', { tab, project_id: 'p1', machine_id: 'm1', owner_id: 'u2' })).toBeNull();
  });

  it('sends an opened/renamed tab as tab_upsert and a closed one as tab_removed', () => {
    expect(lifecycleFrame('u1', { kind: 'upsert', tab, project_id: 'p1', machine_id: 'm1', owner_id: 'u1' })).toEqual({ type: 'tab_upsert', tab, project_id: 'p1', machine_id: 'm1' });
    expect(lifecycleFrame('u1', { kind: 'removed', tab_id: 't1', project_id: 'p1', machine_id: 'm1', owner_id: 'u1' })).toEqual({ type: 'tab_removed', tab_id: 't1', project_id: 'p1', machine_id: 'm1' });
  });

  it('filters lifecycle events by the machine owner, like state changes; "all" (null) sees everything', () => {
    const removed = { kind: 'removed' as const, tab_id: 't1', project_id: 'p1', machine_id: 'm1', owner_id: 'u2' };
    expect(lifecycleFrame('u1', removed)).toBeNull();
    expect(lifecycleFrame('u1', { kind: 'upsert', tab, project_id: 'p1', machine_id: 'm1', owner_id: null })).toBeNull();
    expect(lifecycleFrame(null, removed)).toMatchObject({ type: 'tab_removed' });
  });
});
