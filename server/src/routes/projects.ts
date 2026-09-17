import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Repositories } from '../db/repositories/index.js';
import type { Machine } from '../db/repositories/types.js';
import { badRequest, notFound } from '../lib/errors.js';
import { killTmuxSession, listTmuxSessions } from '../terminal/machine-exec.js';
import { ensureDirectory } from '../terminal/machine-fs.js';

const idParam = z.object({ id: z.string().min(1).max(64) });

const createBody = z.object({
  machine_id: z.string().min(1).max(64),
  name: z.string().trim().min(1).max(120),
  cwd: z.string().trim().min(1).max(1024).refine((p) => p.startsWith('/') || /^[A-Za-z]:\\/.test(p) || p.startsWith('~'), {
    message: 'cwd deve ser um caminho absoluto',
  }),
  status: z.enum(['active', 'paused', 'archived']).optional(),
  description: z.string().trim().max(2000).optional().nullable(),
  /** cria a pasta na máquina (mkdir -p) se ela não existir */
  create_dir: z.boolean().optional(),
});

const patchBody = createBody.omit({ machine_id: true }).partial();

/** Caminhos Windows (C:\\...) não passam pelo sh: ficam sem verificação. */
const isPosixPath = (p: string) => p.startsWith('/') || p.startsWith('~');

/** Confere a pasta na máquina (cria se pedido) e devolve o caminho absoluto resolvido. */
async function resolveCwd(machine: Machine, cwd: string, createDir: boolean | undefined): Promise<string> {
  if (!isPosixPath(cwd)) return cwd;
  return (await ensureDirectory(machine, cwd, createDir ?? false)).path;
}

const tabBody = z.object({ name: z.string().trim().min(1).max(60).optional() });

export async function projectRoutes(app: FastifyInstance, repos: Repositories) {
  app.get('/', async (request) => {
    const q = z.object({ status: z.enum(['active', 'paused', 'archived']).optional() }).parse(request.query);
    const [projects, openCounts] = await Promise.all([repos.projects.list({ status: q.status }), repos.tasks.openCountByProject()]);
    return { projects: projects.map((p) => ({ ...p, open_tasks: openCounts[p.id] ?? 0 })) };
  });

  app.post('/', async (request, reply) => {
    const { create_dir, ...body } = createBody.parse(request.body);
    const machine = await repos.machines.findById(body.machine_id);
    if (!machine) throw badRequest('Máquina inexistente');
    body.cwd = await resolveCwd(machine, body.cwd, create_dir);
    const project = await repos.projects.create(body);
    return reply.code(201).send({ project });
  });

  app.get('/:id', async (request) => {
    const { id } = idParam.parse(request.params);
    const project = await repos.projects.findById(id);
    if (!project) throw notFound('Projeto não encontrado');
    return { project };
  });

  app.patch('/:id', async (request) => {
    const { id } = idParam.parse(request.params);
    const current = await repos.projects.findById(id);
    if (!current) throw notFound('Projeto não encontrado');
    const { create_dir, ...patch } = patchBody.parse(request.body);
    if (patch.cwd !== undefined && patch.cwd !== current.cwd) {
      const machine = await repos.machines.findById(current.machine_id);
      if (!machine) throw badRequest('Máquina inexistente');
      patch.cwd = await resolveCwd(machine, patch.cwd, create_dir);
    }
    return { project: await repos.projects.update(id, patch) };
  });

  app.delete('/:id', async (request) => {
    const { id } = idParam.parse(request.params);
    const project = await repos.projects.findById(id);
    if (!project) throw notFound('Projeto não encontrado');
    const machine = await repos.machines.findById(project.machine_id);
    // Melhor esforço: mata as sessões tmux das tabs antes de apagar (máquina pode estar offline).
    if (machine) {
      await Promise.allSettled((await repos.tabs.listByProject(id)).map((t) => killTmuxSession(machine, t.tmux_session)));
    }
    await repos.projects.delete(id);
    return { ok: true };
  });

  // --- Tabs ---
  app.get('/:id/tabs', async (request) => {
    const { id } = idParam.parse(request.params);
    const project = await repos.projects.findById(id);
    if (!project) throw notFound('Projeto não encontrado');
    const machine = await repos.machines.findById(project.machine_id);
    const tabs = await repos.tabs.listByProject(id);
    let alive = new Set<string>();
    let reachable = false;
    if (machine && tabs.length > 0) {
      try {
        alive = await listTmuxSessions(machine);
        reachable = true;
      } catch {
        reachable = false;
      }
    } else if (tabs.length === 0) {
      reachable = true;
    }
    return {
      reachable,
      tabs: tabs.map((t) => ({ ...t, alive: alive.has(t.tmux_session) })),
    };
  });

  app.post('/:id/tabs', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const project = await repos.projects.findById(id);
    if (!project) throw notFound('Projeto não encontrado');
    const body = tabBody.parse(request.body ?? {});
    const name = body.name ?? `Terminal ${(await repos.tabs.listByProject(id)).length + 1}`;
    const tab = await repos.tabs.create(id, name);
    return reply.code(201).send({ tab: { ...tab, alive: false } });
  });
}
