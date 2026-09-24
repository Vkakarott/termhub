import { describe, expect, it, vi } from 'vitest';
import type { Machine, Project, Tab } from '../db/repositories/types.js';
import type { TmuxProbe } from '../terminal/machine-exec.js';
import { buildOfficeCity, buildOfficeSnapshot } from './snapshot.js';
import { publicId, publicRoomId } from '../public/public-id.js';

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

  // The share button builds a room's public link from this: the id the owner's public city gives
  // the (project, this machine) room, never the project alone.
  it('carries each room\'s public city id, derived from the project and this machine', () => {
    const snap = buildOfficeSnapshot({ machine, projects: [project('a')], tabs: [], aliveSessions: new Set(), reachable: true, simulatorReady: () => false, progress: null });
    expect(snap.rooms[0].public_id).toBe(publicRoomId('a', 'm1'));
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

describe('buildOfficeCity', () => {
  const m = (id: string, over: Partial<Machine> = {}): Machine => ({ id, name: id, subtitle: null, type: 'agent', host: null, ssh_user: null, ...over }) as Machine;
  const probe = (sessions: string[], reachable = true): TmuxProbe => ({ reachable, sessions: new Set(sessions) });
  const base = { machines: [m('m1'), m('m2')], probes: new Map<string, TmuxProbe>(), agentOnline: () => true, simulatorReady: () => false, progress: null };

  it('makes a building per non-archived project, in the order given, empty ones kept, with every tab of the project whatever its machine', () => {
    const city = buildOfficeCity({
      ...base,
      projects: [project('b'), project('a'), project('z', { status: 'archived' })],
      tabs: [tab('t1', 'a'), tab('t2', 'a', { machine_id: 'm2' }), tab('t9', 'z')],
    });
    expect(city.projects.map((b) => b.project.id)).toEqual(['b', 'a']);
    expect(city.projects[0].tabs).toEqual([]);
    expect(city.projects[1].tabs.map((t) => [t.id, t.machine_id])).toEqual([['t1', 'm1'], ['t2', 'm2']]);
  });

  // The share button builds a building's link from this: the project's own public id, the same
  // whichever machines its desks run on.
  it("carries each building's public city id, derived from the project alone", () => {
    const city = buildOfficeCity({ ...base, projects: [project('a')], tabs: [] });
    expect(city.projects[0].public_id).toBe(publicId('project', 'a'));
  });

  it("reads a terminal tab alive from its own machine's probe", () => {
    const city = buildOfficeCity({
      ...base,
      projects: [project('a')],
      tabs: [tab('t1', 'a'), tab('t2', 'a', { machine_id: 'm2' }), tab('t3', 'a')],
      probes: new Map([['m1', probe(['th-t1', 'th-t2'])], ['m2', probe(['th-t2'], false)]]),
    });
    // t2's session is in m1's list, but t2 runs on m2, which could not be asked
    expect(city.projects[0].tabs.map((t) => [t.id, t.alive])).toEqual([['t1', true], ['t2', false], ['t3', false]]);
  });

  it('gives a machine nobody probed no reachable answer, and its terminal tabs read as not alive', () => {
    const city = buildOfficeCity({ ...base, projects: [project('a')], tabs: [tab('t1', 'a')] });
    expect(city.projects[0].tabs[0].alive).toBe(false);
    expect(city.machines.map((x) => [x.id, x.reachable])).toEqual([['m1', null], ['m2', null]]);
  });

  it("asks the simulator manager for simulator tabs, on the tab's own machine", () => {
    const sim = tab('s1', 'a', { kind: 'simulator', tmux_session: null, simulator_udid: 'UDID', machine_id: 'm2' });
    const ready = vi.fn((machineId: string, udid: string) => machineId === 'm2' && udid === 'UDID');
    const city = buildOfficeCity({ ...base, projects: [project('a')], tabs: [sim], simulatorReady: ready });
    expect(city.projects[0].tabs[0].alive).toBe(true);
    expect(ready).toHaveBeenCalledWith('m2', 'UDID');
  });

  it('says whether each machine is up: an agent by its connection, local always, ssh by its probe', () => {
    const city = buildOfficeCity({
      ...base,
      machines: [m('a1'), m('l1', { type: 'local' }), m('s1', { type: 'ssh' }), m('s2', { type: 'ssh' })],
      projects: [],
      tabs: [],
      probes: new Map([['s1', probe([], false)]]),
      agentOnline: (id) => id !== 'a1',
    });
    expect(city.machines.map((x) => [x.id, x.online])).toEqual([['a1', false], ['l1', true], ['s1', false], ['s2', true]]);
  });

  it('describes each machine field by field, never the whole record', () => {
    const city = buildOfficeCity({
      ...base,
      machines: [m('m1', { name: 'jarvis', subtitle: 'MacBook do escritório', host: '10.0.0.9', ssh_user: 'pedro' })],
      projects: [],
      tabs: [],
      probes: new Map([['m1', probe([])]]),
    });
    expect(city.machines[0]).toEqual({ id: 'm1', name: 'jarvis', subtitle: 'MacBook do escritório', type: 'agent', online: true, reachable: true });
    expect(JSON.stringify(city)).not.toContain('10.0.0.9');
  });

  it('carries progress when given and nulls when the person cannot read tasks', () => {
    const progress = { counts: { a: { todo: 1, doing: 1, done: 2 } }, byTab: { t1: { task_id: 'k', title: 'Ship', done: 1, total: 3 } } };
    const input = { ...base, projects: [project('a'), project('b')], tabs: [tab('t1', 'a')] };
    const withTasks = buildOfficeCity({ ...input, progress });
    expect(withTasks.projects[0].tasks).toEqual({ todo: 1, doing: 1, done: 2 });
    expect(withTasks.projects[0].tabs[0].progress).toEqual({ task_id: 'k', title: 'Ship', done: 1, total: 3 });
    expect(withTasks.projects[1].tasks).toEqual({ todo: 0, doing: 0, done: 0 });
    const without = buildOfficeCity({ ...input, progress: null });
    expect(without.projects[0].tasks).toBeNull();
    expect(without.projects[0].tabs[0].progress).toBeNull();
  });
});
