import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Repositories } from '../db/repositories/index.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { killTmuxSession } from '../terminal/machine-exec.js';
import type { SimulatorSessionManager } from '../simulator/session-manager.js';

const idParam = z.object({ id: z.string().min(1).max(64) });
const patchBody = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  simulator_udid: z.string().regex(/^[A-Fa-f0-9-]{8,64}$/).nullable().optional(),
});

export async function tabRoutes(
  app: FastifyInstance,
  repos: Repositories,
  deps: { simulators: SimulatorSessionManager; closeSimulatorTab: (tabId: string) => void },
) {
  app.patch('/:id', async (request) => {
    const { id } = idParam.parse(request.params);
    const tab = await repos.tabs.findById(id);
    if (!tab) throw notFound('Tab não encontrada');
    const body = patchBody.parse(request.body);
    if (body.simulator_udid !== undefined && tab.kind !== 'simulator') throw badRequest('Só tabs de simulador têm aparelho');
    const updated = await repos.tabs.update(id, body);
    if (body.simulator_udid !== undefined && body.simulator_udid !== tab.simulator_udid) deps.closeSimulatorTab(id);
    return { tab: updated };
  });

  app.get('/:id/simulator/screenshot', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const tab = await repos.tabs.findById(id);
    if (!tab || tab.kind !== 'simulator') throw notFound('Tab não encontrada');
    const project = await repos.projects.findById(tab.project_id);
    if (!project || !tab.simulator_udid) throw conflict('Simulador não está conectado');
    const client = deps.simulators.getClient(project.machine_id, tab.simulator_udid);
    if (!client) throw conflict('Simulador não está conectado');
    const png = await client.screenshotPng();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    return reply
      .header('content-type', 'image/png')
      .header('content-disposition', `attachment; filename="simulador-${stamp}.png"`)
      .send(png);
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
