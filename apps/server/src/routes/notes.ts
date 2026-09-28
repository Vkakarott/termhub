import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Repositories } from '../db/repositories/index.js';
import { NOTE_MAX, NoteTooLargeError } from '../db/repositories/notes.js';
import { HttpError, notFound } from '../lib/errors.js';
import { scoped } from '../auth/scope.js';

const idParam = z.object({ id: z.string().min(1).max(64) });
const putBody = z.object({ content: z.string().max(NOTE_MAX), base_updated_at: z.string().datetime().optional() });

/** Nota (markdown) do projeto — uma por projeto. Montado em /projects/:id/note. */
export async function noteRoutes(app: FastifyInstance, repos: Repositories) {
  app.get('/:id/note', async (request) => {
    const { id } = idParam.parse(request.params);
    await scoped(repos, request).project(id);
    return { note: await repos.notes.getByProject(id) };
  });

  /** Without `base_updated_at` (an old client): a plain upsert, exactly as before this feature existed.
   *  With it: `saveMerged` reconciles the submission against anything a concierge appended concurrently
   *  (spec D9) — a merge can push an already-valid submission over NOTE_MAX, hence the 413 here. */
  app.put('/:id/note', async (request) => {
    const { id } = idParam.parse(request.params);
    await scoped(repos, request).project(id);
    const { content, base_updated_at } = putBody.parse(request.body);
    try {
      const note = await repos.notes.saveMerged(id, content, base_updated_at ? new Date(base_updated_at) : null);
      return { note };
    } catch (e) {
      if (e instanceof NoteTooLargeError) throw new HttpError(413, 'A anotação passou do limite de 200 000 caracteres', 'NOTE_TOO_LARGE');
      throw e;
    }
  });
}
