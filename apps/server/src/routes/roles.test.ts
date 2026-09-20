import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { Repositories } from '../db/repositories/index.js';
import type { Role } from '../db/repositories/roles.js';
import { applyErrorHandler } from '../lib/errors.js';
import { roleRoutes } from './roles.js';

const role: Role = { id: 'r1', name: 'MANAGER', label: 'Gerente', description: null, is_system: false, is_admin: false, created_at: '' };

function build() {
  const toggle = vi.fn(async () => true);
  const repos = {
    roles: {
      findById: vi.fn(async (id: string) => (id === role.id ? role : undefined)),
      permissionsOf: vi.fn(async () => []),
      toggle,
    },
  } as unknown as Repositories;
  const app = Fastify();
  applyErrorHandler(app);
  app.register((a) => roleRoutes(a, repos));
  return { app, toggle };
}

const post = (app: ReturnType<typeof Fastify>, id: string, body: object) =>
  app.inject({ method: 'POST', url: `/${id}/permissions/toggle`, headers: { 'content-type': 'application/json' }, payload: body });

describe('POST /:id/permissions/toggle', () => {
  it('toggles terminals:write, the one resource that grant is valid for', async () => {
    const { app, toggle } = build();
    const r = await post(app, role.id, { resource: 'terminals', action: 'write' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ granted: true });
    expect(toggle).toHaveBeenCalledWith(role.id, 'terminals', 'write');
  });

  it("refuses write on a resource other than terminals, without touching the repository", async () => {
    const { app, toggle } = build();
    const r = await post(app, role.id, { resource: 'machines', action: 'write' });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toEqual({ error: 'Recurso ou ação inválidos', code: 'BAD_REQUEST' });
    expect(toggle).not.toHaveBeenCalled();
  });

  it('still toggles ordinary CRUD grants on any resource', async () => {
    const { app, toggle } = build();
    const r = await post(app, role.id, { resource: 'machines', action: 'read' });
    expect(r.statusCode).toBe(200);
    expect(toggle).toHaveBeenCalledWith(role.id, 'machines', 'read');
  });
});
