import { describe, expect, it, vi } from 'vitest';
import type { ProjectGroup } from '../db/repositories/project-groups.js';
import type { ControlContext } from './context.js';
import { groupsOf, listProjectGroups } from './groups.js';

const project = (id: string, over: { name?: string; status?: string; owner_id?: string } = {}) => ({ id, key: id.toUpperCase(), name: over.name ?? id, status: over.status ?? 'active', owner_id: over.owner_id ?? 'u1' });
const projects = [project('p1', { name: 'notify' }), project('p2', { name: 'painel-triunfo' }), project('p3', { name: 'Velho', status: 'archived' }), project('p4', { name: 'Escreva+' }), project('px', { name: 'alheio', owner_id: 'u2' })];
const group = (id: string, name: string, project_ids: string[], kind: 'favorites' | 'custom' = 'custom', position = 0): ProjectGroup => ({ id, name, kind, position, project_ids });

function ctx(groups: ProjectGroup[], scope: { userId?: string; ownerId?: string } = {}): ControlContext {
  const userId = scope.userId ?? 'u1';
  const ownerId = scope.ownerId ?? userId;
  const read = vi.fn(async (id: string) => (id === 'u1' ? groups : []));
  const list = vi.fn(async (f: { owner?: string | null }) => projects.filter((p) => f.owner == null || p.owner_id === f.owner));
  return { repos: { projectGroups: { read }, projects: { list } }, scope: { user: { id: userId }, viewAs: { kind: 'self' }, ownerId, createAs: ownerId } } as unknown as ControlContext;
}

describe('groupsOf', () => {
  it('answers the custom groups in sidebar order, members in the group order, Favoritos apart', async () => {
    const c = ctx([group('gf', 'Favoritos', ['p4', 'p1'], 'favorites', 0), group('g1', 'Triunfo', ['p2', 'p1'], 'custom', 1), group('g2', 'Faculdade', ['p4'], 'custom', 2)]);
    const { groups, favorites } = await groupsOf(c);
    expect(groups).toEqual([
      { id: 'g1', name: 'Triunfo', projects: [{ id: 'p2', key: 'P2', name: 'painel-triunfo', status: 'active' }, { id: 'p1', key: 'P1', name: 'notify', status: 'active' }] },
      { id: 'g2', name: 'Faculdade', projects: [{ id: 'p4', key: 'P4', name: 'Escreva+', status: 'active' }] },
    ]);
    expect([...favorites].sort()).toEqual(['p1', 'p4']);
  });

  it('leaves out a project outside the scope and an archived one', async () => {
    const { groups, favorites } = await groupsOf(ctx([group('gf', 'Favoritos', ['px', 'p3'], 'favorites'), group('g1', 'Triunfo', ['px', 'p3', 'p1'])]));
    expect(groups[0].projects.map((p) => p.id)).toEqual(['p1']);
    expect(favorites.size).toBe(0);
  });

  it('keeps archived members when asked to', async () => {
    const { groups, favorites } = await groupsOf(ctx([group('gf', 'Favoritos', ['p3'], 'favorites'), group('g1', 'Triunfo', ['p3', 'p1'])]), { archived: true });
    expect(groups[0].projects.map((p) => p.id)).toEqual(['p3', 'p1']);
    expect([...favorites]).toEqual(['p3']);
  });

  it('lists a group with no visible project, empty: it exists in the sidebar', async () => {
    expect((await groupsOf(ctx([group('g1', 'Vazio', []), group('g2', 'Só alheio', ['px'])]))).groups).toEqual([
      { id: 'g1', name: 'Vazio', projects: [] },
      { id: 'g2', name: 'Só alheio', projects: [] },
    ]);
  });

  it('reads the groups of the user and the projects of the scope', async () => {
    const c = ctx([group('g1', 'Triunfo', ['p1'])], { userId: 'u1', ownerId: 'u2' });
    const { groups } = await groupsOf(c);
    expect(c.repos.projectGroups.read).toHaveBeenCalledWith('u1');
    expect(c.repos.projects.list).toHaveBeenCalledWith({ owner: 'u2' });
    // p1 is not a project of u2: the group is there, its member is not.
    expect(groups).toEqual([{ id: 'g1', name: 'Triunfo', projects: [] }]);
  });
});

describe('listProjectGroups', () => {
  it('answers the groups, and nothing about favourites', async () => {
    expect(await listProjectGroups(ctx([group('gf', 'Favoritos', ['p1'], 'favorites'), group('g1', 'Triunfo', ['p1'])]))).toEqual({
      groups: [{ id: 'g1', name: 'Triunfo', projects: [{ id: 'p1', key: 'P1', name: 'notify', status: 'active' }] }],
    });
  });
});
