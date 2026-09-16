import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Repositories } from '../db/repositories/index.js';
import { badRequest, notFound } from '../lib/errors.js';
import { machineOnline } from '../terminal/machine-exec.js';

const idParam = z.object({ id: z.string().min(1).max(64) });

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
  app.get('/', async () => ({ machines: repos.machines.list() }));

  app.post('/', async (request, reply) => {
    const body = machineBody.parse(request.body);
    const machine = repos.machines.create(body);
    return reply.code(201).send({ machine });
  });

  app.get('/:id', async (request) => {
    const { id } = idParam.parse(request.params);
    const machine = repos.machines.findById(id);
    if (!machine) throw notFound('Máquina não encontrada');
    return { machine };
  });

  app.patch('/:id', async (request) => {
    const { id } = idParam.parse(request.params);
    const current = repos.machines.findById(id);
    if (!current) throw notFound('Máquina não encontrada');
    const merged = machineBody.parse({ ...current, ...(request.body as object) });
    return { machine: repos.machines.update(id, merged) };
  });

  app.delete('/:id', async (request) => {
    const { id } = idParam.parse(request.params);
    const machine = repos.machines.findById(id);
    if (!machine) throw notFound('Máquina não encontrada');
    if (repos.projects.list({ machine_id: id }).length > 0) {
      throw badRequest('Remova os projetos desta máquina antes de excluí-la');
    }
    repos.machines.delete(id);
    return { ok: true };
  });

  app.get('/:id/status', async (request) => {
    const { id } = idParam.parse(request.params);
    const machine = repos.machines.findById(id);
    if (!machine) throw notFound('Máquina não encontrada');
    const online = await machineOnline(machine);
    return { id, online, checked_at: new Date().toISOString() };
  });
}
