import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Repositories } from '../db/repositories/index.js';
import { badRequest, notFound } from '../lib/errors.js';
import { forgetAccountUsage, getAccountUsage } from '../ai/index.js';

const idParam = z.object({ id: z.string().min(1).max(64) });
const usageQuery = z.object({ refresh: z.coerce.boolean().optional() });

const accountBody = z.object({
  provider: z.enum(['claude', 'chatgpt', 'gemini']),
  label: z.string().trim().min(1).max(60),
  machine_id: z.string().min(1).max(64),
  config_dir: z.string().trim().max(512).nullable().optional(),
});

export async function aiAccountRoutes(app: FastifyInstance, repos: Repositories) {
  app.get('/', async () => ({ accounts: await repos.aiAccounts.list() }));

  app.post('/', async (request, reply) => {
    const body = accountBody.parse(request.body);
    if (!(await repos.machines.findById(body.machine_id))) throw badRequest('Machine does not exist');
    const account = await repos.aiAccounts.create({ ...body, config_dir: body.config_dir || null });
    return reply.code(201).send({ account });
  });

  app.patch('/:id', async (request) => {
    const { id } = idParam.parse(request.params);
    if (!(await repos.aiAccounts.findById(id))) throw notFound('Account not found');
    const patch = accountBody.omit({ provider: true }).partial().parse(request.body);
    if (patch.machine_id && !(await repos.machines.findById(patch.machine_id))) throw badRequest('Machine does not exist');
    forgetAccountUsage(id);
    return { account: await repos.aiAccounts.update(id, { ...patch, config_dir: patch.config_dir === undefined ? undefined : patch.config_dir || null }) };
  });

  app.delete('/:id', async (request) => {
    const { id } = idParam.parse(request.params);
    if (!(await repos.aiAccounts.findById(id))) throw notFound('Account not found');
    await repos.aiAccounts.delete(id);
    forgetAccountUsage(id);
    return { ok: true };
  });

  /** Usage of every account (cached 60 s; ?refresh=1 forces a new read). Accounts are queried in parallel. */
  app.get('/usage', async (request) => {
    const { refresh } = usageQuery.parse(request.query);
    const [accounts, machines] = await Promise.all([repos.aiAccounts.list(), repos.machines.list()]);
    const byId = new Map(machines.map((m) => [m.id, m]));
    const usage = await Promise.all(accounts.map((a) => getAccountUsage(a, byId.get(a.machine_id), !!refresh)));
    return { usage };
  });

  app.get('/:id/usage', async (request) => {
    const { id } = idParam.parse(request.params);
    const { refresh } = usageQuery.parse(request.query);
    const account = await repos.aiAccounts.findById(id);
    if (!account) throw notFound('Account not found');
    const machine = await repos.machines.findById(account.machine_id);
    return { usage: await getAccountUsage(account, machine, !!refresh) };
  });
}
