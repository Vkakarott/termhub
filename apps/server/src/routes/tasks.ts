import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Repositories } from '../db/repositories/index.js';
import { notFound } from '../lib/errors.js';

const idParam = z.object({ id: z.string().min(1).max(64) });
const statusSchema = z.enum(['backlog', 'todo', 'doing', 'done']);

const createBody = z.object({
  title: z.string().trim().min(1).max(300),
  description: z.string().trim().max(5000).optional().nullable(),
  status: statusSchema.optional(),
});
const patchBody = createBody.partial();
const moveBody = z.object({ status: statusSchema, position: z.number().int().min(0).max(10_000) });

/** Rotas de tasks montadas em /projects/:id/tasks (listar/criar) e /tasks/:id (editar/mover/excluir). */
export async function projectTaskRoutes(app: FastifyInstance, repos: Repositories) {
  app.get('/:id/tasks', async (request) => {
    const { id } = idParam.parse(request.params);
    if (!(await repos.projects.findById(id))) throw notFound('Projeto não encontrado');
    return { tasks: await repos.tasks.listByProject(id) };
  });

  app.post('/:id/tasks', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    if (!(await repos.projects.findById(id))) throw notFound('Projeto não encontrado');
    const body = createBody.parse(request.body);
    return reply.code(201).send({ task: await repos.tasks.create(id, body) });
  });
}

export async function taskRoutes(app: FastifyInstance, repos: Repositories) {
  app.patch('/:id', async (request) => {
    const { id } = idParam.parse(request.params);
    const task = await repos.tasks.update(id, patchBody.parse(request.body));
    if (!task) throw notFound('Task não encontrada');
    return { task };
  });

  app.post('/:id/move', { config: { action: 'update' } }, async (request) => {
    const { id } = idParam.parse(request.params);
    const body = moveBody.parse(request.body);
    const task = await repos.tasks.move(id, body.status, body.position);
    if (!task) throw notFound('Task não encontrada');
    return { task };
  });

  app.delete('/:id', async (request) => {
    const { id } = idParam.parse(request.params);
    await repos.tickets.unlinkTask(id); // o ticket volta a aparecer como "não importado"
    if (!(await repos.tasks.delete(id))) throw notFound('Task não encontrada');
    return { ok: true };
  });
}
