import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Repositories } from '../db/repositories/index.js';
import { toPublicUser } from '../db/repositories/types.js';
import { badRequest, notFound } from '../lib/errors.js';

const idParam = z.object({ id: z.string().min(1).max(64) });
const patchBody = z.object({ role_id: z.string().min(1).max(64) });

/** User administration. Guarded as resource "users" (see app.ts). */
export async function userRoutes(app: FastifyInstance, repos: Repositories) {
  app.get('/', async () => {
    const [users, roles] = await Promise.all([repos.users.list(), repos.roles.list()]);
    const byId = new Map(roles.map((r) => [r.id, r]));
    return {
      users: users.map((u) => {
        const r = u.role_id ? byId.get(u.role_id) : undefined;
        return { ...toPublicUser(u), role_info: r ? { id: r.id, name: r.name, label: r.label, is_admin: r.is_admin } : null };
      }),
    };
  });

  app.patch('/:id', async (request) => {
    const { id } = idParam.parse(request.params);
    const { role_id } = patchBody.parse(request.body);
    const user = await repos.users.findById(id);
    if (!user) throw notFound('Usuário não encontrado');
    const role = await repos.roles.findById(role_id);
    if (!role) throw badRequest('Role inexistente');
    // never leave the system without an admin
    if (!role.is_admin && user.role_id) {
      const current = await repos.roles.findById(user.role_id);
      if (current?.is_admin && (await repos.users.countAdmins()) <= 1) throw badRequest('Este é o único administrador; promova outro antes');
    }
    const updated = await repos.users.setRole(id, role.id, role.is_admin ? 'owner' : 'member');
    return { user: updated && { ...toPublicUser(updated), role_info: { id: role.id, name: role.name, label: role.label, is_admin: role.is_admin } } };
  });

  app.delete('/:id', async (request) => {
    const { id } = idParam.parse(request.params);
    if (id === request.user?.id) throw badRequest('Você não pode excluir a si mesmo');
    const user = await repos.users.findById(id);
    if (!user) throw notFound('Usuário não encontrado');
    if (user.role_id) {
      const role = await repos.roles.findById(user.role_id);
      if (role?.is_admin && (await repos.users.countAdmins()) <= 1) throw badRequest('Este é o único administrador');
    }
    await repos.users.delete(id);
    return { ok: true };
  });
}
