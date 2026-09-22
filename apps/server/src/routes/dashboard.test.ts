import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { Repositories } from '../db/repositories/index.js';
import { applyErrorHandler } from '../lib/errors.js';
import { dashboardRoutes } from './dashboard.js';

function buildApp() {
  const app = Fastify();
  applyErrorHandler(app);
  app.addHook('preHandler', async (request) => {
    request.scope = { user: { id: 'u1' } as never, viewAs: { kind: 'self' }, ownerId: 'u1', createAs: 'u1' };
    request.user = { id: 'u1' } as never;
  });
  const repos = {
    projects: { list: vi.fn(async () => [{ id: 'p1', owner_id: 'u1', key: 'P1', name: 'p1', status: 'active', last_terminal_at: null }, { id: 'p2', owner_id: 'u1', key: 'P2', name: 'p2', status: 'active', last_terminal_at: null }]) },
    machines: { list: vi.fn(async () => [{ id: 'm1', name: 'mac', owner_id: 'u1' }]) },
    tasks: { listDoing: vi.fn(async () => [{ id: 'k1', project_id: 'p1', title: 'doing' }]), openCountByProject: vi.fn(async () => ({ p1: 3 })) },
    projectMachines: {
      listByProjects: vi.fn(async () => [
        { id: 'l1', project_id: 'p1', machine_id: 'm1', cwd: '/src/p1', position: 0, created_at: '' },
        { id: 'l2', project_id: 'p1', machine_id: 'gone', cwd: '/x', position: 1, created_at: '' },
      ]),
    },
  } as unknown as Repositories;
  app.register((a) => dashboardRoutes(a, repos), { prefix: '/dashboard' });
  return app;
}

describe('GET /dashboard', () => {
  it('serves each project with its links (the same shape as /projects) plus the resolved machines', async () => {
    const body = (await buildApp().inject({ method: 'GET', url: '/dashboard' })).json();
    const p1 = body.items.find((i: { project: { id: string } }) => i.project.id === 'p1');
    expect(p1.project.machines).toEqual([
      { machine_id: 'm1', cwd: '/src/p1', position: 0 },
      { machine_id: 'gone', cwd: '/x', position: 1 },
    ]);
    expect(p1.machines.map((m: { id: string }) => m.id)).toEqual(['m1']); // an unknown machine is dropped from the resolved list only
    expect(p1.doing.map((t: { id: string }) => t.id)).toEqual(['k1']);
    expect(p1.open_tasks).toBe(3);
    const p2 = body.items.find((i: { project: { id: string } }) => i.project.id === 'p2');
    expect(p2.project.machines).toEqual([]);
    expect(p2.machines).toEqual([]);
    expect(p2.open_tasks).toBe(0);
  });
});
