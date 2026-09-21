import { describe, expect, it } from 'vitest';
import type { OfficeRoom, OfficeSnapshot, OfficeTab, Project, Tab } from '../lib/types';
import { buildModel, lookOf, missingTabIds, truncateLabel } from './model';

const tab = (id: string, over: Partial<OfficeTab> = {}): OfficeTab =>
  ({ id, project_id: 'p1', name: id, kind: 'terminal', position: 0, state: null, state_text: null, state_tool: null, state_at: null, state_seen_at: null, alive: true, progress: null, ...over }) as OfficeTab;
const room = (id: string, tabs: OfficeTab[], over: Partial<OfficeRoom> = {}): OfficeRoom => ({ project: { id, name: id, status: 'active' } as Project, tabs, tasks: null, ...over });
const snap = (rooms: OfficeRoom[]): OfficeSnapshot => ({ machine: { id: 'm1', name: 'jarvis' } as never, reachable: true, rooms });
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
