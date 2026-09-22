import { describe, expect, it } from 'vitest';
import type { Machine, Project, Tab } from '../db/repositories/types.js';
import { buildOfficeSnapshot } from './snapshot.js';

const machine = { id: 'm1', name: 'jarvis' } as Machine;
const project = (id: string, over: Partial<Project> = {}): Project => ({ id, owner_id: 'u1', key: id.toUpperCase(), name: id, status: 'active', ...over }) as Project;
const tab = (id: string, projectId: string, over: Partial<Tab> = {}): Tab =>
  ({ id, project_id: projectId, machine_id: 'm1', name: id, kind: 'terminal', tmux_session: `th-${id}`, simulator_udid: null, position: 0, state: null, ...over }) as Tab;

describe('buildOfficeSnapshot', () => {
  it('groups tabs into their project rooms, drops archived projects and keeps empty rooms', () => {
    const snap = buildOfficeSnapshot({
      machine,
      projects: [project('b'), project('a'), project('z', { status: 'archived' })],
      tabs: [tab('t1', 'a'), tab('t2', 'a'), tab('t9', 'z')],
      aliveSessions: new Set(['th-t1']),
      reachable: true,
      simulatorReady: () => false,
      progress: null,
    });
    expect(snap.rooms.map((r) => r.project.id)).toEqual(['b', 'a']);
    expect(snap.rooms[1].tabs.map((t) => [t.id, t.alive])).toEqual([['t1', true], ['t2', false]]);
    expect(snap.rooms[0].tabs).toEqual([]);
  });

  it('marks every terminal tab dead when the machine was unreachable', () => {
    const snap = buildOfficeSnapshot({ machine, projects: [project('a')], tabs: [tab('t1', 'a')], aliveSessions: new Set(), reachable: false, simulatorReady: () => true, progress: null });
    expect(snap.reachable).toBe(false);
    expect(snap.rooms[0].tabs[0].alive).toBe(false);
  });

  it('asks the simulator manager for simulator tabs', () => {
    const sim = tab('s1', 'a', { kind: 'simulator', tmux_session: null, simulator_udid: 'UDID' });
    const snap = buildOfficeSnapshot({ machine, projects: [project('a')], tabs: [sim], aliveSessions: new Set(), reachable: true, simulatorReady: (udid) => udid === 'UDID', progress: null });
    expect(snap.rooms[0].tabs[0].alive).toBe(true);
  });

  it('carries progress when given and nulls when the person cannot read tasks', () => {
    const progress = { counts: { a: { todo: 1, doing: 1, done: 2 } }, byTab: { t1: { task_id: 'k', title: 'Ship', done: 1, total: 3 } } };
    const base = { machine, projects: [project('a'), project('b')], tabs: [tab('t1', 'a')], aliveSessions: new Set<string>(), reachable: true, simulatorReady: () => false };
    const withTasks = buildOfficeSnapshot({ ...base, progress });
    expect(withTasks.rooms[0].tasks).toEqual({ todo: 1, doing: 1, done: 2 });
    expect(withTasks.rooms[0].tabs[0].progress).toEqual({ task_id: 'k', title: 'Ship', done: 1, total: 3 });
    expect(withTasks.rooms[1].tasks).toEqual({ todo: 0, doing: 0, done: 0 });
    const without = buildOfficeSnapshot({ ...base, progress: null });
    expect(without.rooms[0].tasks).toBeNull();
    expect(without.rooms[0].tabs[0].progress).toBeNull();
  });
});
