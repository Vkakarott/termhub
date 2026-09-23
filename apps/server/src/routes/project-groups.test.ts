import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { Repositories } from '../db/repositories/index.js';
import { ProjectGroupRuleError } from '../db/repositories/project-groups.js';
import { applyErrorHandler } from '../lib/errors.js';
import { projectGroupRoutes } from './project-groups.js';

const fav = { id: 'g0', name: 'Favoritos', kind: 'favorites', position: 0, project_ids: ['p1', 'hidden'] };

function build(opts: { ownerId?: string | null } = {}) {
  const app = Fastify();
  applyErrorHandler(app);
  app.addHook('preHandler', async (request) => {
    request.user = { id: 'me' } as never;
    request.scope = { user: { id: 'me' } as never, viewAs: { kind: 'self' }, ownerId: opts.ownerId === undefined ? 'me' : opts.ownerId, createAs: 'me' };
  });
  const projectGroups = {
    list: vi.fn(async () => [fav]),
    create: vi.fn(async (_u: string, name: string) => ({ id: 'g1', name, kind: 'custom', position: 1, project_ids: [] })),
    rename: vi.fn(async () => ({ ...fav })),
    delete: vi.fn(async () => {}),
    reorder: vi.fn(async () => [fav]),
    setMemberships: vi.fn(async () => [fav]),
  };
  const projects = { list: vi.fn(async () => [{ id: 'p1' }, { id: 'p2' }]) };
  app.register((a) => projectGroupRoutes(a, { projectGroups, projects } as unknown as Repositories), { prefix: '/project-groups' });
  return { app, projectGroups, projects };
}

describe('project group routes', () => {
  it('GET lists the real user groups, members filtered to the current scope', async () => {
    const { app, projectGroups, projects } = build({ ownerId: 'someone-else' });
    const r = await app.inject({ method: 'GET', url: '/project-groups' });
    expect(r.statusCode).toBe(200);
    expect(projectGroups.list).toHaveBeenCalledWith('me');
    expect(projects.list).toHaveBeenCalledWith({ owner: 'someone-else' });
    expect(r.json().groups[0].project_ids).toEqual(['p1']);
  });

  it('POST validates the name and creates', async () => {
    const { app, projectGroups } = build();
    expect((await app.inject({ method: 'POST', url: '/project-groups', payload: { name: '   ' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/project-groups', payload: { name: 'x'.repeat(41) } })).statusCode).toBe(400);
    const r = await app.inject({ method: 'POST', url: '/project-groups', payload: { name: 'Clientes' } });
    expect(r.statusCode).toBe(201);
    expect(projectGroups.create).toHaveBeenCalledWith('me', 'Clientes');
  });

  it('maps rule errors: SYSTEM_GROUP 409, NOT_FOUND 404', async () => {
    const { app, projectGroups } = build();
    projectGroups.rename.mockRejectedValueOnce(new ProjectGroupRuleError('SYSTEM_GROUP', 'Favoritos não pode ser renomeado'));
    const r1 = await app.inject({ method: 'PATCH', url: '/project-groups/g0', payload: { name: 'x' } });
    expect(r1.statusCode).toBe(409);
    expect(r1.json().code).toBe('SYSTEM_GROUP');
    projectGroups.delete.mockRejectedValueOnce(new ProjectGroupRuleError('NOT_FOUND', 'Grupo não encontrado'));
    expect((await app.inject({ method: 'DELETE', url: '/project-groups/zz' })).statusCode).toBe(404);
  });

  it('DELETE answers 204', async () => {
    const { app } = build();
    expect((await app.inject({ method: 'DELETE', url: '/project-groups/g1' })).statusCode).toBe(204);
  });

  it('PUT memberships refuses a project outside the scope and writes nothing', async () => {
    const { app, projectGroups } = build();
    const r = await app.inject({ method: 'PUT', url: '/project-groups/memberships', payload: { groups: [{ id: 'g0', project_ids: ['p1', 'nope'] }] } });
    expect(r.statusCode).toBe(404);
    expect(r.json().code).toBe('PROJECT_NOT_FOUND');
    expect(projectGroups.setMemberships).not.toHaveBeenCalled();
  });

  it('PUT memberships passes the scope visibility to the repository', async () => {
    const { app, projectGroups } = build();
    const r = await app.inject({ method: 'PUT', url: '/project-groups/memberships', payload: { groups: [{ id: 'g0', project_ids: ['p2'] }] } });
    expect(r.statusCode).toBe(200);
    const [user, changes, visible] = projectGroups.setMemberships.mock.calls[0] as unknown as [string, unknown, (id: string) => boolean];
    expect(user).toBe('me');
    expect(changes).toEqual([{ id: 'g0', project_ids: ['p2'] }]);
    expect(visible('p1')).toBe(true);
    expect(visible('hidden')).toBe(false);
  });

  it('PUT order forwards the ids', async () => {
    const { app, projectGroups } = build();
    await app.inject({ method: 'PUT', url: '/project-groups/order', payload: { ids: ['g0'] } });
    expect(projectGroups.reorder).toHaveBeenCalledWith('me', ['g0']);
  });
});
