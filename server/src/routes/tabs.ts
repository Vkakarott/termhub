import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Repositories } from '../db/repositories/index.js';
import { badRequest, notFound } from '../lib/errors.js';
import { killTmuxSession } from '../terminal/machine-exec.js';
import { PASTE_IMAGE_MAX_BYTES, saveImageOnMachine } from '../terminal/paste-image.js';

const idParam = z.object({ id: z.string().min(1).max(64) });
const renameBody = z.object({ name: z.string().trim().min(1).max(60) });

export async function tabRoutes(app: FastifyInstance, repos: Repositories) {
  // Corpo binário das imagens coladas (só neste plugin).
  app.addContentTypeParser(/^image\/.+/, { parseAs: 'buffer', bodyLimit: PASTE_IMAGE_MAX_BYTES }, (_req, body, done) => done(null, body));

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
    if (machine) {
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
   * Imagem colada no terminal (Cmd+V no navegador): grava em ~/.cache/termhub/paste/ na máquina da tab
   * e devolve o caminho, que o front cola no terminal como texto.
   */
  app.post('/:id/paste-image', { bodyLimit: PASTE_IMAGE_MAX_BYTES }, async (request) => {
    const { id } = idParam.parse(request.params);
    const tab = await repos.tabs.findById(id);
    if (!tab) throw notFound('Tab não encontrada');
    const project = await repos.projects.findById(tab.project_id);
    const machine = project && (await repos.machines.findById(project.machine_id));
    if (!project || !machine) throw notFound('Projeto ou máquina não encontrados');
    if (!Buffer.isBuffer(request.body)) throw badRequest('Envie a imagem como corpo binário (content-type image/*)');
    const image = await saveImageOnMachine(machine, request.body);
    request.log.info({ tabId: id, machineId: machine.id, bytes: image.bytes, mime: image.mime }, 'imagem colada');
    return image;
  });
}
