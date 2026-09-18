import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Repositories } from '../db/repositories/index.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { scoped } from '../auth/scope.js';
import { killTmuxSession } from '../terminal/machine-exec.js';
import type { SimulatorSessionManager } from '../simulator/session-manager.js';
import { PASTE_MAX_BYTES, saveFileOnMachine } from '../terminal/paste-file.js';

const idParam = z.object({ id: z.string().min(1).max(64) });
const pasteQuery = z.object({ name: z.string().max(255).optional() });
const patchBody = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  simulator_udid: z.string().regex(/^[A-Fa-f0-9-]{8,64}$/).nullable().optional(),
});

export async function tabRoutes(
  app: FastifyInstance,
  repos: Repositories,
  deps: { simulators: SimulatorSessionManager; closeSimulatorTab: (tabId: string) => void },
) {
  // Binary bodies for pasted/dropped files (this plugin only). JSON keeps its own parser.
  app.addContentTypeParser(['application/octet-stream'], { parseAs: 'buffer', bodyLimit: PASTE_MAX_BYTES }, (_req, body, done) => done(null, body));
  app.addContentTypeParser(/^(image|text|audio|video)\/.+/, { parseAs: 'buffer', bodyLimit: PASTE_MAX_BYTES }, (_req, body, done) => done(null, body));

  app.patch('/:id', async (request) => {
    const { id } = idParam.parse(request.params);
    const { tab } = await scoped(repos, request).tab(id);
    const body = patchBody.parse(request.body);
    if (body.simulator_udid !== undefined && tab.kind !== 'simulator') throw badRequest('Só tabs de simulador têm aparelho');
    const updated = await repos.tabs.update(id, body);
    if (body.simulator_udid !== undefined && body.simulator_udid !== tab.simulator_udid) deps.closeSimulatorTab(id);
    return { tab: updated };
  });

  app.get('/:id/simulator/screenshot', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const { tab, project } = await scoped(repos, request).tab(id);
    if (tab.kind !== 'simulator') throw notFound('Tab não encontrada');
    if (!tab.simulator_udid) throw conflict('Simulador não está conectado');
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
    const { tab, machine } = await scoped(repos, request).tab(id);
    let killed = false;
    if (tab.tmux_session) {
      try {
        killed = await killTmuxSession(machine, tab.tmux_session);
      } catch {
        killed = false;
      }
    }
    await repos.tabs.delete(id);
    return { ok: true, killed };
  });

  /**
   * File pasted (Cmd+V) or dropped on the terminal: written to ~/.cache/termhub/paste/ on the tab's
   * machine; the returned path is what the frontend pastes into the terminal as text.
   */
  app.post('/:id/paste-file', { bodyLimit: PASTE_MAX_BYTES, config: { action: 'update' } }, async (request) => {
    const { id } = idParam.parse(request.params);
    const { name } = pasteQuery.parse(request.query);
    const { machine } = await scoped(repos, request).tab(id);
    if (!Buffer.isBuffer(request.body)) throw badRequest('Envie o arquivo como corpo binário (content-type application/octet-stream)');
    const file = await saveFileOnMachine(machine, request.body, name);
    request.log.info({ tabId: id, machineId: machine.id, bytes: file.bytes, mime: file.mime }, 'file pasted');
    return file;
  });
}
