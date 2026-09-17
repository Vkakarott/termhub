import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Repositories } from '../db/repositories/index.js';
import { notFound } from '../lib/errors.js';
import { killTmuxSession } from '../terminal/machine-exec.js';

const idParam = z.object({ id: z.string().min(1).max(64) });
const renameBody = z.object({ name: z.string().trim().min(1).max(60) });

export async function tabRoutes(app: FastifyInstance, repos: Repositories) {
  app.patch('/:id', async (request) => {
    const { id } = idParam.parse(request.params);
    if (!(await repos.tabs.findById(id))) throw notFound('Tab não encontrada');
    const { name } = renameBody.parse(request.body);
    return { tab: await repos.tabs.rename(id, name) };
  });

  app.delete('/:id', async (request) => {
    const { id } = idParam.parse(request.params);
    const tab = await repos.tabs.findById(id);
    if (!tab) throw notFound('Tab não encontrada');
    const project = await repos.projects.findById(tab.project_id);
    const machine = project && (await repos.machines.findById(project.machine_id));
    let killed = false;
    if (machine && tab.tmux_session) {
      try {
        killed = await killTmuxSession(machine, tab.tmux_session);
      } catch {
        killed = false;
      }
    }
    await repos.tabs.delete(id);
    return { ok: true, killed };
  });
}
