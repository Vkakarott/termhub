import { describe, expect, it } from 'vitest';
import type { Project, ProjectGroup } from './types';
import { applyDrop, buildSections, moveGroup } from './project-groups-model';

const proj = (id: string, status: Project['status'] = 'active') => ({ id, name: id, key: id.toUpperCase(), status }) as Project;
const P = [proj('a'), proj('b'), proj('c'), proj('z', 'archived')];
const G = (): ProjectGroup[] => [
  { id: 'fav', name: 'Favoritos', kind: 'favorites', position: 0, project_ids: ['a'] },
  { id: 'g1', name: 'Clientes', kind: 'custom', position: 1, project_ids: ['a', 'b'] },
  { id: 'g2', name: 'Vazio', kind: 'custom', position: 2, project_ids: [] },
];
const ids = (s: { projects: Project[] }) => s.projects.map((p) => p.id);

describe('buildSections', () => {
  it('orders running, groups by position, others; tags repeat projects', () => {
    const s = buildSections(P, G(), new Set(['a']), false);
    expect(s.map((x) => x.id)).toEqual(['running', 'fav', 'g1', 'g2', 'others']);
    expect(ids(s[0])).toEqual(['a']);
    expect(ids(s[1])).toEqual(['a']);
    expect(ids(s[2])).toEqual(['a', 'b']);
    expect(ids(s[4])).toEqual(['c']);
  });

  it('drops the running section when nothing runs; keeps empty user groups', () => {
    const s = buildSections(P, G(), new Set(), false);
    expect(s.map((x) => x.id)).toEqual(['fav', 'g1', 'g2', 'others']);
  });

  it('applies the archived filter everywhere', () => {
    const groups = G();
    groups[1].project_ids.push('z');
    expect(ids(buildSections(P, groups, new Set(['z']), false).find((x) => x.id === 'g1')!)).toEqual(['a', 'b']);
    const shown = buildSections(P, groups, new Set(['z']), true);
    expect(ids(shown[0])).toEqual(['z']);
  });

  it('a project whose only group was deleted lands in Outros', () => {
    const groups = G().filter((g) => g.id !== 'g1');
    expect(ids(buildSections(P, groups, new Set(), false).at(-1)!)).toEqual(['b', 'c']);
  });

  it('ignores member ids of projects not in the list', () => {
    const groups = G();
    groups[0].project_ids.push('gone');
    expect(ids(buildSections(P, groups, new Set(), false)[0])).toEqual(['a']);
  });
});

describe('applyDrop', () => {
  it('Outros → group adds at the index', () => {
    const r = applyDrop(G(), { projectId: 'c', from: 'others' }, { to: 'g1', index: 1 }, { copy: false })!;
    expect(r.changes).toEqual([{ id: 'g1', project_ids: ['a', 'c', 'b'] }]);
  });

  it('running → group that already has it reorders, never duplicates', () => {
    const r = applyDrop(G(), { projectId: 'b', from: 'running' }, { to: 'g1', index: 0 }, { copy: false })!;
    expect(r.changes).toEqual([{ id: 'g1', project_ids: ['b', 'a'] }]);
  });

  it('group → other group moves; with copy keeps the source', () => {
    const move = applyDrop(G(), { projectId: 'b', from: 'g1' }, { to: 'fav', index: 1 }, { copy: false })!;
    expect(move.changes).toEqual([{ id: 'g1', project_ids: ['a'] }, { id: 'fav', project_ids: ['a', 'b'] }]);
    const copy = applyDrop(G(), { projectId: 'b', from: 'g1' }, { to: 'fav', index: 1 }, { copy: true })!;
    expect(copy.changes).toEqual([{ id: 'fav', project_ids: ['a', 'b'] }]);
  });

  it('moving onto a group that already has it removes from the source and reorders the target', () => {
    const r = applyDrop(G(), { projectId: 'a', from: 'fav' }, { to: 'g1', index: 2 }, { copy: false })!;
    expect(r.changes).toEqual([{ id: 'fav', project_ids: [] }, { id: 'g1', project_ids: ['b', 'a'] }]);
  });

  it('same group reorders; index counts the list before removal', () => {
    const r = applyDrop(G(), { projectId: 'a', from: 'g1' }, { to: 'g1', index: 2 }, { copy: false })!;
    expect(r.changes).toEqual([{ id: 'g1', project_ids: ['b', 'a'] }]);
  });

  it('same place is a no-op', () => {
    expect(applyDrop(G(), { projectId: 'a', from: 'g1' }, { to: 'g1', index: 0 }, { copy: false })).toBeNull();
    expect(applyDrop(G(), { projectId: 'a', from: 'g1' }, { to: 'g1', index: 1 }, { copy: false })).toBeNull();
  });

  it('group → Outros removes from that group only', () => {
    const r = applyDrop(G(), { projectId: 'a', from: 'g1' }, { to: 'others', index: 0 }, { copy: false })!;
    expect(r.changes).toEqual([{ id: 'g1', project_ids: ['b'] }]);
    expect(r.next.find((g) => g.id === 'fav')!.project_ids).toEqual(['a']);
  });

  it('nothing drops on running, and Outros → Outros is a no-op', () => {
    expect(applyDrop(G(), { projectId: 'a', from: 'g1' }, { to: 'running', index: 0 }, { copy: false })).toBeNull();
    expect(applyDrop(G(), { projectId: 'c', from: 'others' }, { to: 'others', index: 0 }, { copy: false })).toBeNull();
  });

  it('next mirrors changes', () => {
    const r = applyDrop(G(), { projectId: 'c', from: 'others' }, { to: 'g2', index: 0 }, { copy: false })!;
    expect(r.next.find((g) => g.id === 'g2')!.project_ids).toEqual(['c']);
  });
});

describe('moveGroup', () => {
  it('moves and renumbers positions', () => {
    const r = moveGroup(G(), 'g2', 0);
    expect(r.map((g) => [g.id, g.position])).toEqual([['g2', 0], ['fav', 1], ['g1', 2]]);
  });
});
