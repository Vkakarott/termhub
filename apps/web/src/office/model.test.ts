import { describe, expect, it } from 'vitest';
import type { OfficeRoom, OfficeSnapshot, OfficeTab, Project, Tab } from '../lib/types';
import { buildCityModel, buildModel, lookOf, missingTabIds, resolveFocus, sameFocus, truncateLabel, type MachineEntry } from './model';

const tab = (id: string, over: Partial<OfficeTab> = {}): OfficeTab =>
  ({ id, project_id: 'p1', name: id, kind: 'terminal', position: 0, state: null, state_text: null, state_tool: null, state_at: null, state_seen_at: null, alive: true, progress: null, ...over }) as OfficeTab;
const room = (id: string, tabs: OfficeTab[], over: Partial<OfficeRoom> = {}): OfficeRoom => ({ project: { id, name: id, status: 'active' } as Project, tabs, tasks: null, ...over });
const snap = (rooms: OfficeRoom[], machineId = 'm1', over: Partial<OfficeSnapshot> = {}): OfficeSnapshot => ({ machine: { id: machineId, name: machineId } as never, reachable: true, rooms, ...over });
const none = () => undefined;

describe('buildModel', () => {
  it('maps each tab state to a pose and a marker', () => {
    const at = '2026-09-21T10:00:00.000Z';
    const m = buildModel(
      snap([room('p1', [
        tab('w', { state: 'working', state_at: at }),
        tab('i', { state: 'waiting_input', state_at: at }),
        tab('p', { state: 'waiting_permission', state_at: at }),
        tab('z', { state: 'idle', state_at: at }),
        tab('e', { state: 'error', state_at: at }),
        tab('n'),
      ])]),
      none,
    );
    expect(m.rooms[0].desks.map((d) => [d.id, d.pose, d.marker, d.dimmed, d.screenOn])).toEqual([
      ['w', 'type', null, false, true],
      ['i', 'raise', 'input', false, false],
      ['p', 'raise', 'permission', false, false],
      ['z', 'sleep', null, false, false],
      ['e', 'shake', 'error', false, false],
      ['n', 'sit', null, true, false],
    ]);
    expect(m.rooms[0].needsYou).toBe(2);
    expect(m.needsYou).toBe(2);
  });

  it('keeps the hand up but drops the marker once the tab was seen', () => {
    const seen = tab('i', { state: 'waiting_input', state_at: '2026-09-21T10:00:00.000Z', state_seen_at: '2026-09-21T10:05:00.000Z' });
    const d = buildModel(snap([room('p1', [seen])]), none).rooms[0].desks[0];
    expect([d.pose, d.marker]).toEqual(['raise', null]);
    expect(buildModel(snap([room('p1', [seen])]), none).needsYou).toBe(0);
  });

  it('lets the live monitor state override the snapshot, and a tab the monitor never saw stay as it is', () => {
    const live = (id: string) => (id === 'a' ? ({ ...tab('a'), state: 'working', state_at: '2026-09-21T10:00:00.000Z' } as Tab) : undefined);
    const desks = buildModel(snap([room('p1', [tab('a'), tab('b')])]), live).rooms[0].desks;
    expect(desks.map((d) => d.pose)).toEqual(['type', 'sit']);
  });

  it('takes only the live state from the monitor tab, keeping the snapshot identity fields and ordering', () => {
    const snapshotTab = tab('a', { name: 'new name', position: 1, kind: 'terminal' });
    const other = tab('b', { name: 'b', position: 0 });
    const live = (id: string) =>
      id === 'a'
        ? ({ ...tab('a'), name: 'old name', position: 0, kind: 'simulator', state: 'working', state_at: '2026-09-21T10:00:00.000Z' } as Tab)
        : undefined;
    const desks = buildModel(snap([room('p1', [snapshotTab, other])]), live).rooms[0].desks;
    expect(desks.map((d) => d.id)).toEqual(['b', 'a']);
    const desk = desks[1];
    expect(desk.name).toBe('new name');
    expect(desk.kind).toBe('person');
    expect(desk.pose).toBe('type');
  });

  it('shows an empty chair for a dead terminal tab and a phone for a simulator tab', () => {
    const desks = buildModel(snap([room('p1', [tab('dead', { alive: false, state: 'working', state_at: 'x' }), tab('sim', { kind: 'simulator', alive: true })])]), none).rooms[0].desks;
    expect([desks[0].pose, desks[0].marker, desks[0].screenOn]).toEqual(['empty', null, false]);
    expect([desks[1].kind, desks[1].screenOn]).toEqual(['phone', true]);
  });

  it('keeps people, markers and needsYou when the snapshot could not ask the machine', () => {
    // reachable: false means the tmux listing failed, so `alive: false` is not evidence of anything:
    // emptying the chairs there would erase every raised hand for up to a minute
    const desks = buildModel(
      snap([room('p1', [tab('a', { alive: false, state: 'waiting_input', state_at: '2026-09-21T10:00:00.000Z' }), tab('sim', { kind: 'simulator', alive: false })])], 'm1', { reachable: false }),
      none,
    ).rooms[0].desks;
    expect([desks[0].pose, desks[0].marker]).toEqual(['raise', 'input']);
    // a simulator's `alive` comes from the simulator manager, not from tmux: it still holds
    expect([desks[1].kind, desks[1].screenOn]).toEqual(['phone', false]);
    expect(buildModel(snap([room('p1', [tab('a', { alive: false, state: 'waiting_input', state_at: '2026-09-21T10:00:00.000Z' })])], 'm1', { reachable: false }), none).needsYou).toBe(1);
  });

  it('takes the state fields from whichever side saw them last', () => {
    const older = '2026-09-21T10:00:00.000Z';
    const newer = '2026-09-21T10:05:00.000Z';
    const liveWith = (over: Partial<Tab>) => (id: string) => (id === 'a' ? ({ ...tab('a'), ...over } as Tab) : undefined);

    // a monitor push newer than the snapshot wins (the normal case: the WebSocket is ahead)
    const fresh = buildModel(snap([room('p1', [tab('a', { state: 'idle', state_at: older })])]), liveWith({ state: 'working', state_at: newer })).rooms[0].desks[0];
    expect([fresh.state, fresh.pose]).toEqual(['working', 'type']);

    // with the WebSocket down the monitor goes stale (it resyncs every 3 min): the snapshot wins
    const stale = buildModel(snap([room('p1', [tab('a', { state: 'working', state_at: newer })])]), liveWith({ state: 'idle', state_at: older })).rooms[0].desks[0];
    expect([stale.state, stale.pose]).toEqual(['working', 'type']);

    // same state_at: only a fresher "seen" (the hand was lowered in another browser tab) wins
    const seen = buildModel(snap([room('p1', [tab('a', { state: 'waiting_input', state_at: older })])]), liveWith({ state: 'waiting_input', state_at: older, state_seen_at: newer })).rooms[0].desks[0];
    expect(seen.marker).toBeNull();
  });

  it('draws progress only from a bound task, and a bar only when it has subtasks', () => {
    const desks = buildModel(
      snap([room('p1', [tab('a', { progress: { task_id: 'k', title: 'Ship', done: 1, total: 3 } }), tab('b', { progress: { task_id: 'k2', title: 'Solo', done: 0, total: 0 } }), tab('c')])]),
      none,
    ).rooms[0].desks;
    expect(desks.map((d) => d.progress)).toEqual([{ done: 1, total: 3, title: 'Ship' }, { done: 0, total: 0, title: 'Solo' }, null]);
  });

  it('gives a room its board progress, none when the board is empty or unreadable, and lights by project status', () => {
    const m = buildModel(
      snap([
        room('a', [], { tasks: { todo: 1, doing: 1, done: 2 } }),
        room('b', [], { tasks: { todo: 0, doing: 0, done: 0 } }),
        room('c', [], { tasks: null }),
        room('d', [], { project: { id: 'd', name: 'd', status: 'paused' } as Project }),
      ]),
      none,
    );
    expect(m.rooms.map((r) => r.progress)).toEqual([{ done: 2, total: 4 }, null, null, null]);
    expect(m.rooms.map((r) => r.lit)).toEqual([true, true, true, false]);
  });

  it('orders desks by tab position and truncates labels without touching names', () => {
    const long = 'x'.repeat(120);
    const m = buildModel(snap([room(long, [tab('second', { position: 1 }), tab('first', { position: 0, name: long })])]), none);
    expect(m.rooms[0].desks.map((d) => d.id)).toEqual(['first', 'second']);
    expect(m.rooms[0].desks[0].name).toBe(long);
    expect(m.rooms[0].desks[0].label.length).toBeLessThanOrEqual(18);
    expect(m.rooms[0].label.length).toBeLessThanOrEqual(28);
  });
});

describe('truncateLabel', () => {
  it('cuts by code point so an emoji is never split, and leaves short text alone', () => {
    expect(truncateLabel('api', 10)).toBe('api');
    expect(truncateLabel('🚀🚀🚀🚀🚀', 3)).toBe('🚀🚀…');
    expect(truncateLabel('  spaced   name  ', 20)).toBe('spaced name');
    expect(truncateLabel('', 5)).toBe('');
  });
});

describe('lookOf', () => {
  it('is stable for an id and spread over the variants', () => {
    expect(lookOf('tab-1', 6)).toBe(lookOf('tab-1', 6));
    const seen = new Set(Array.from({ length: 60 }, (_, i) => lookOf(`tab-${i}`, 6)));
    expect(seen.size).toBe(6);
    expect([...seen].every((n) => n >= 0 && n < 6)).toBe(true);
  });
});

describe('missingTabIds', () => {
  const s = snap([room('p1', [tab('a')])]);
  const projects = new Set(['p1']);
  const projectOf = (id: string) => ({ a: 'p1', b: 'p1', other: 'p9' })[id];
  it('returns the ids of this machine that the monitor knows and the snapshot lacks', () => {
    expect(missingTabIds(s, ['a', 'b'], projects, projectOf)).toEqual(['b']);
  });
  it('leaves out tabs of other machines and tabs the snapshot already knows', () => {
    expect(missingTabIds(s, ['a', 'other'], projects, projectOf)).toEqual([]);
  });
  it('returns [] before the first snapshot', () => {
    expect(missingTabIds(null, ['b'], projects, projectOf)).toEqual([]);
  });
});

describe('buildCityModel', () => {
  const entry = (id: string, over: Partial<MachineEntry> = {}): MachineEntry => ({ id, name: id, online: true, snapshot: snap([room(`${id}-p`, [tab(`${id}-t`)])], id), failed: false, ...over });

  it('orders machines by name and leaves out the ones still loading', () => {
    const city = buildCityModel([entry('zeta'), entry('alpha'), entry('mid', { snapshot: null })], none);
    expect(city.machines.map((m) => m.id)).toEqual(['alpha', 'zeta']);
  });
  it('turns a failed machine into an empty error block and keeps the rest', () => {
    const city = buildCityModel([entry('a'), entry('b', { snapshot: null, failed: true })], none);
    expect(city.machines.map((m) => [m.id, m.notice, m.floor.rooms.length])).toEqual([['a', null, 1], ['b', 'error', 0]]);
  });
  it('tells offline from silent, offline winning, and darkens only an offline block', () => {
    const silent = snap([room('p', [tab('t')])], 's');
    silent.reachable = false;
    const city = buildCityModel([entry('o', { online: false }), entry('s', { snapshot: silent }), entry('k')], none);
    expect(city.machines.map((m) => [m.id, m.notice, m.lit])).toEqual([['k', null, true], ['o', 'offline', false], ['s', 'silent', true]]);
  });
  it('sums who needs you per machine and for the city', () => {
    const at = '2026-09-21T10:00:00.000Z';
    const waiting = (id: string) => tab(id, { state: 'waiting_input', state_at: at });
    const city = buildCityModel([entry('a', { snapshot: snap([room('p', [waiting('t1'), waiting('t2')])], 'a') }), entry('b', { snapshot: snap([room('q', [waiting('t3')])], 'b') })], none);
    expect(city.machines.map((m) => m.needsYou)).toEqual([2, 1]);
    expect(city.needsYou).toBe(3);
  });
  it('ignores a snapshot that belongs to another machine', () => {
    expect(buildCityModel([entry('a', { snapshot: snap([], 'someone-else') })], none).machines).toEqual([]);
  });
  it('truncates the label and keeps the name', () => {
    const long = 'm'.repeat(80);
    const m = buildCityModel([entry('a', { name: long })], none).machines[0];
    expect(m.name).toBe(long);
    expect(m.label.length).toBeLessThanOrEqual(28);
  });
});

describe('resolveFocus', () => {
  const city = buildCityModel(
    [{ id: 'm1', name: 'm1', online: true, failed: false, snapshot: snap([room('p1', [tab('t')])], 'm1') }, { id: 'm2', name: 'm2', online: true, failed: false, snapshot: snap([room('p2', [])], 'm2') }],
    none,
  );
  it('frames the city with no machine, an unknown machine, or before anything loaded', () => {
    expect(resolveFocus(city, undefined, null)).toEqual({ kind: 'city' });
    expect(resolveFocus(city, 'ghost', 'p1')).toEqual({ kind: 'city' });
    expect(resolveFocus(null, 'm1', 'p1')).toEqual({ kind: 'city' });
  });
  it('frames a machine, and a room only when it belongs to that machine', () => {
    expect(resolveFocus(city, 'm1', null)).toEqual({ kind: 'machine', machineId: 'm1' });
    expect(resolveFocus(city, 'm1', 'p1')).toEqual({ kind: 'room', machineId: 'm1', roomId: 'p1' });
    expect(resolveFocus(city, 'm1', 'p2')).toEqual({ kind: 'machine', machineId: 'm1' });
  });
  it('compares targets by value', () => {
    expect(sameFocus({ kind: 'room', machineId: 'a', roomId: 'r' }, { kind: 'room', machineId: 'a', roomId: 'r' })).toBe(true);
    expect(sameFocus({ kind: 'machine', machineId: 'a' }, { kind: 'city' })).toBe(false);
  });
});
