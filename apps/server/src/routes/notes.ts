import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Repositories } from '../db/repositories/index.js';
import { notFound } from '../lib/errors.js';
import { scoped } from '../auth/scope.js';

const idParam = z.object({ id: z.string().min(1).max(64) });
const putBody = z.object({ content: z.string().max(200_000) });

/** Nota (markdown) do projeto — uma por projeto. Montado em /projects/:id/note. */
export async function noteRoutes(app: FastifyInstance, repos: Repositories) {
  app.get('/:id/note', async (request) => {
    const { id } = idParam.parse(request.params);
    await scoped(repos, request).project(id);
    return { note: await repos.notes.getByProject(id) };
  });

  app.put('/:id/note', async (request) => {
    const { id } = idParam.parse(request.params);
    await scoped(repos, request).project(id);
    const { content } = putBody.parse(request.body);
    return { note: await repos.notes.upsert(id, content) };
  });
}
