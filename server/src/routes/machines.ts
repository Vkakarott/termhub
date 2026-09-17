import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Repositories } from '../db/repositories/index.js';
import { badRequest, notFound } from '../lib/errors.js';
import { machineStatus } from '../terminal/machine-exec.js';
import { listSimulators } from '../simulator/machine.js';
import { startWdaSetup, wdaSetupState } from '../simulator/setup.js';

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

  const requireMac = (m: { os: string | null; capabilities: string[] }) => {
    if (m.os !== 'macos' || !m.capabilities.includes('xcodebuild')) throw badRequest('Esta máquina não é um Mac com Xcode');
  };

  app.get('/:id/simulators', async (request) => {
    const { id } = idParam.parse(request.params);
    const machine = await repos.machines.findById(id);
    if (!machine) throw notFound('Máquina não encontrada');
    requireMac(machine);
    return { simulators: await listSimulators(machine) };
  });

  app.get('/:id/simulator/setup', async (request) => {
    const { id } = idParam.parse(request.params);
    const machine = await repos.machines.findById(id);
    if (!machine) throw notFound('Máquina não encontrada');
    const state = await wdaSetupState(machine);
    if (state.state === 'ok' && !machine.capabilities.includes('wda')) {
      const status = await machineStatus(machine);
      if (status.online) await repos.machines.setDetected(id, status.os, status.capabilities);
    }
    return state;
  });

  app.post('/:id/simulator/setup', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const machine = await repos.machines.findById(id);
    if (!machine) throw notFound('Máquina não encontrada');
    requireMac(machine);
    await startWdaSetup(machine);
    return reply.code(202).send({ ok: true });
  });
}
