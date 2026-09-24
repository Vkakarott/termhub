import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Repositories } from '../db/repositories/index.js';
import { MAX_SUBTASKS_PER_CALL, TaskRuleError } from '../db/repositories/tasks.js';
import { badRequest, notFound } from '../lib/errors.js';
import { scoped } from '../auth/scope.js';

const idParam = z.object({ id: z.string().min(1).max(64) });
const statusSchema = z.enum(['backlog', 'todo', 'doing', 'done']);

const taskFields = {
  title: z.string().trim().min(1).max(300),
  description: z.string().trim().max(5000).optional().nullable(),
  status: statusSchema.optional(),
};
const createBody = z.object({ ...taskFields, parent_id: z.string().min(1).max(64).optional().nullable() });
/** No parent_id here: a task is never reparented (zod strips the unknown key). */
const patchBody = z.object(taskFields).partial();
const moveBody = z.object({ status: statusSchema, position: z.number().int().min(0).max(10_000) });
const subtasksBody = z.object({
  items: z
    .array(z.object({ title: taskFields.title, description: taskFields.description }))
    .min(1)
    .max(MAX_SUBTASKS_PER_CALL),
});
const reorderBody = z.object({ position: z.number().int().min(0).max(10_000) });

/** Subtask rules live in the repository; a broken one is the client's mistake. */
async function rules<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    if (e instanceof TaskRuleError) throw badRequest(e.message);
    throw e;
  }
}

/** Rotas de tasks montadas em /projects/:id/tasks (listar/criar) e /tasks/:id (editar/mover/excluir). */
export async function projectTaskRoutes(app: FastifyInstance, repos: Repositories) {
  app.get('/:id/tasks', async (request) => {
    const { id } = idParam.parse(request.params);
    await scoped(repos, request).project(id);
    return { tasks: await repos.tasks.listByProject(id) };
  });

  app.post('/:id/tasks', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    await scoped(repos, request).project(id);
    const body = createBody.parse(request.body);
    return reply.code(201).send({ task: await rules(() => repos.tasks.create(id, body)) });
  });
}

export async function taskRoutes(app: FastifyInstance, repos: Repositories) {
  app.patch('/:id', async (request) => {
    const { id } = idParam.parse(request.params);
    await scoped(repos, request).task(id);
    const task = await repos.tasks.update(id, patchBody.parse(request.body));
    if (!task) throw notFound('Task não encontrada');
    return { task };
  });

  app.post('/:id/move', { config: { action: 'update' } }, async (request) => {
    const { id } = idParam.parse(request.params);
    const body = moveBody.parse(request.body);
    await scoped(repos, request).task(id);
    const task = await rules(() => repos.tasks.move(id, { status: body.status }, body.position));
    if (!task) throw notFound('Task não encontrada');
    return { task };
  });

  app.post('/:id/subtasks', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const body = subtasksBody.parse(request.body ?? {});
    const { task } = await scoped(repos, request).task(id);
    return reply.code(201).send({ subtasks: await rules(() => repos.tasks.createSubtasks(id, body.items, task.project_id)) });
  });

  app.post('/:id/reorder', { config: { action: 'update' } }, async (request) => {
    const { id } = idParam.parse(request.params);
    const body = reorderBody.parse(request.body ?? {});
    await scoped(repos, request).task(id);
    const task = await rules(() => repos.tasks.reorder(id, body.position));
    if (!task) throw notFound('Task não encontrada');
    return { task };
  });

  app.delete('/:id', async (request) => {
    const { id } = idParam.parse(request.params);
    await scoped(repos, request).task(id);
    const children = await repos.tasks.childIds(id);
    // tickets point at tasks by id with no FK: unlink the whole subtree so they show as "não importado" again
    for (const taskId of [id, ...children]) await repos.tickets.unlinkTask(taskId);
    if (!(await repos.tasks.delete(id))) throw notFound('Task não encontrada');
    return { ok: true, deleted_subtasks: children.length };
  });
}
