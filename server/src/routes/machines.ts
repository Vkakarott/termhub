import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Repositories } from '../db/repositories/index.js';
import { badRequest, notFound } from '../lib/errors.js';
import { machineStatus } from '../terminal/machine-exec.js';
import { browseMachine, makeDirectory } from '../terminal/machine-fs.js';

const idParam = z.object({ id: z.string().min(1).max(64) });
const fsQuery = z.object({ path: z.string().max(4096).optional() });
const mkdirBody = z.object({ parent: z.string().min(1).max(4096), name: z.string().trim().min(1).max(255) });

const machineBody = z
  .object({
    name: z.string().trim().min(1).max(80),
    type: z.enum(['local', 'ssh']),
    host: z.string().trim().min(1).max(253).optional().nullable(),
    ssh_user: z.string().trim().min(1).max(64).optional().nullable(),
    ssh_port: z.coerce.number().int().min(1).max(65535).optional(),
  })
  .superRefine((m, ctx) => {
    if (m.type === 'ssh' && !m.host) ctx.addIssue({ code: 'custom', path: ['host'], message: 'host é obrigatório para SSH' });
  });

export async function machineRoutes(app: FastifyInstance, repos: Repositories) {
  app.get('/', async () => ({ machines: await repos.machines.list() }));

  app.post('/', async (request, reply) => {
    const body = machineBody.parse(request.body);
    const machine = await repos.machines.create(body);
    return reply.code(201).send({ machine });
  });

  app.get('/:id', async (request) => {
    const { id } = idParam.parse(request.params);
    const machine = await repos.machines.findById(id);
    if (!machine) throw notFound('Máquina não encontrada');
    return { machine };
  });

  app.patch('/:id', async (request) => {
    const { id } = idParam.parse(request.params);
    const current = await repos.machines.findById(id);
    if (!current) throw notFound('Máquina não encontrada');
    const merged = machineBody.parse({ ...current, ...(request.body as object) });
    return { machine: await repos.machines.update(id, merged) };
  });

  app.delete('/:id', async (request) => {
    const { id } = idParam.parse(request.params);
    const machine = await repos.machines.findById(id);
    if (!machine) throw notFound('Máquina não encontrada');
    if ((await repos.projects.list({ machine_id: id })).length > 0) {
      throw badRequest('Remova os projetos desta máquina antes de excluí-la');
    }
    await repos.machines.delete(id);
    return { ok: true };
  });

  app.get('/:id/status', async (request) => {
    const { id } = idParam.parse(request.params);
    const machine = await repos.machines.findById(id);
    if (!machine) throw notFound('Máquina não encontrada');
    const status = await machineStatus(machine);
    if (status.online) await repos.machines.setDetected(id, status.os, status.capabilities);
    return { id, ...status, checked_at: new Date().toISOString() };
  });

  /** Navegador de diretórios: subpastas de ?path (padrão $HOME) + discos/mounts da máquina. */
  app.get('/:id/fs', async (request) => {
    const { id } = idParam.parse(request.params);
    const { path } = fsQuery.parse(request.query);
    const machine = await repos.machines.findById(id);
    if (!machine) throw notFound('Máquina não encontrada');
    return await browseMachine(machine, path);
  });

  /** Cria uma subpasta em `parent` na máquina e devolve o caminho absoluto. */
  app.post('/:id/fs/mkdir', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const { parent, name } = mkdirBody.parse(request.body);
    const machine = await repos.machines.findById(id);
    if (!machine) throw notFound('Máquina não encontrada');
    const path = await makeDirectory(machine, parent, name);
    return reply.code(201).send({ path });
  });
}
