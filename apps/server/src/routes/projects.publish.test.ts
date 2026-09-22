import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Repositories } from '../db/repositories/index.js';
import { applyErrorHandler } from '../lib/errors.js';
import { projectRoutes } from './projects.js';

const update = vi.fn();

const PROJECTS: Record<string, unknown> = {
  p1: { id: 'p1', machine_id: 'm1', name: 'Engage Easy', cwd: '/w', status: 'active', description: null, is_public: false },
  p2: { id: 'p2', machine_id: 'm2', name: 'Órfão', cwd: '/w', status: 'active', description: null, is_public: false },
  p3: { id: 'p3', machine_id: 'm1', name: 'Já público', cwd: '/w', status: 'active', description: null, is_public: true },
};
const MACHINES: Record<string, unknown> = {
  m1: { id: 'm1', name: 'Jarvis', owner_id: 'u1' },
  m2: { id: 'm2', name: 'Sem dono', owner_id: null },
};

/** `ownerId: null` mirrors an admin "view as all" scope: the only scope under which `scoped(...)`
 *  lets a project on an orphan (unowned) machine through at all — see Scoped.owns in auth/scope.ts. */
function buildApp(user: { id: string; nickname: string | null }, ownerId: string | null = user.id) {
  const app = Fastify();
  applyErrorHandler(app);
  app.addHook('preHandler', async (request) => {
    request.user = user as never;
    request.scope = { user, viewAs: ownerId === null ? { kind: 'all' } : { kind: 'self' }, ownerId, createAs: user.id } as never;
  });
  const repos = {
    projects: { findById: vi.fn(async (id: string) => PROJECTS[id]), update },
    machines: { findById: vi.fn(async (id: string) => MACHINES[id]) },
  } as unknown as Repositories;
  app.register((a) => projectRoutes(a, repos, { simulators: { isReady: () => false } as never }), { prefix: '/projects' });
  return app;
}

const owner = { id: 'u1', nickname: 'pedro' };
const ownerNoNick = { id: 'u1', nickname: null };
const stranger = { id: 'u2', nickname: 'outro' };
const patch = (user: { id: string; nickname: string | null }, id: string, body: unknown) =>
  buildApp(user).inject({ method: 'PATCH', url: `/projects/${id}`, payload: body });

describe('PATCH /projects/:id is_public', () => {
  beforeEach(() => update.mockReset().mockImplementation(async (id: string, p: Record<string, unknown>) => ({ ...(PROJECTS[id] as object), ...p })));

  it('publishes when the caller owns the machine and has a nickname', async () => {
    const res = await patch(owner, 'p1', { is_public: true });
    expect(res.statusCode).toBe(200);
    expect(res.json().project.is_public).toBe(true);
    expect(update).toHaveBeenCalledWith('p1', expect.objectContaining({ is_public: true }));
  });

  // scoped(...).project(id) hides a project on a machine the caller cannot see behind a 404
  // before the publish guard is ever reached, so the stranger sees "not found", not "forbidden".
  it('refuses a caller who does not own the machine', async () => {
    const res = await patch(stranger, 'p1', { is_public: true });
    expect(res.statusCode).toBe(404);
    expect(update).not.toHaveBeenCalled();
  });

  it('refuses when the owner has no nickname yet', async () => {
    const res = await patch(ownerNoNick, 'p1', { is_public: true });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('NICKNAME_REQUIRED');
    expect(update).not.toHaveBeenCalled();
  });

  // A self-scoped caller can never reach this branch: an orphan machine's project answers 404
  // before the guard runs (scoped() hides orphans from non-admins), same as the stranger case.
  // Only "view as all" lets scoped() through to the project, so that is the scope this exercises.
  it('refuses on a machine with no owner', async () => {
    const res = await buildApp(owner, null).inject({ method: 'PATCH', url: '/projects/p2', payload: { is_public: true } });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('MACHINE_UNOWNED');
  });

  it('unpublishing needs none of that', async () => {
    const res = await patch(ownerNoNick, 'p3', { is_public: false });
    expect(res.statusCode).toBe(200);
    expect(update).toHaveBeenCalledWith('p3', expect.objectContaining({ is_public: false }));
  });
});
