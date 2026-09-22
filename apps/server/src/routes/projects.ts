import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Repositories } from '../db/repositories/index.js';
import type { Machine } from '../db/repositories/types.js';
import { badRequest } from '../lib/errors.js';
import { nextTerminalName } from '../lib/tab-names.js';
import { scoped } from '../auth/scope.js';
import { killTmuxSession, listTmuxSessions } from '../terminal/machine-exec.js';
import type { SimulatorSessionManager } from '../simulator/session-manager.js';
import { ensureDirectory } from '../terminal/machine-fs.js';
import { publicBus } from '../public/bus.js';

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
  /** published: readable by anyone with the /city/@nickname link */
  is_public: z.boolean().optional(),
});

const patchBody = createBody.omit({ machine_id: true }).partial();

/** Caminhos Windows (C:\\...) não passam pelo sh: ficam sem verificação. */
const isPosixPath = (p: string) => p.startsWith('/') || p.startsWith('~');

/** Confere a pasta na máquina (cria se pedido) e devolve o caminho absoluto resolvido. */
async function resolveCwd(machine: Machine, cwd: string, createDir: boolean | undefined): Promise<string> {
  if (!isPosixPath(cwd)) return cwd;
  return (await ensureDirectory(machine, cwd, createDir ?? false)).path;
}

const tabBody = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  kind: z.enum(['terminal', 'simulator']).optional(),
  simulator_udid: z.string().regex(/^[A-Fa-f0-9-]{8,64}$/).optional(),
});

export async function projectRoutes(app: FastifyInstance, repos: Repositories, deps: { simulators: SimulatorSessionManager }) {
  app.get('/', async (request) => {
    const q = z.object({ status: z.enum(['active', 'paused', 'archived']).optional() }).parse(request.query);
    const [projects, openCounts] = await Promise.all([repos.projects.list({ status: q.status, owner: request.scope.ownerId }), repos.tasks.openCountByProject()]);
    return { projects: projects.map((p) => ({ ...p, open_tasks: openCounts[p.id] ?? 0 })) };
  });

  app.post('/', async (request, reply) => {
    // is_public is accepted on the schema only so patchBody (derived from it) can take it — a new
    // project is never born public, publishing is a deliberate later step guarded on PATCH.
    const { create_dir, is_public: _is_public, ...body } = createBody.parse(request.body);
    const machine = await scoped(repos, request).machine(body.machine_id).catch(() => {
      throw badRequest('Máquina inexistente');
    });
    body.cwd = await resolveCwd(machine, body.cwd, create_dir);
    const project = await repos.projects.create(body);
    return reply.code(201).send({ project });
  });

  app.get('/:id', async (request) => {
    const { id } = idParam.parse(request.params);
    const { project } = await scoped(repos, request).project(id);
    return { project };
  });

  app.patch('/:id', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const { project: current, machine } = await scoped(repos, request).project(id);
    const { create_dir, ...patch } = patchBody.parse(request.body);
    if (patch.cwd !== undefined && patch.cwd !== current.cwd) {
      patch.cwd = await resolveCwd(machine, patch.cwd, create_dir);
    }
    if (patch.is_public === true && !current.is_public) {
      if (!machine.owner_id) return reply.code(409).send({ error: 'Essa máquina não tem dono', code: 'MACHINE_UNOWNED' });
      if (machine.owner_id !== request.user!.id) return reply.code(403).send({ error: 'Só quem é dono da máquina pode publicar', code: 'NOT_OWNER' });
      if (!request.user!.nickname) return reply.code(409).send({ error: 'Escolha seu apelido antes de publicar', code: 'NICKNAME_REQUIRED' });
    }
    const project = await repos.projects.update(id, patch);
    // The public bus fans this out to any `/ws/public/:nickname` socket watching this room: a
    // publish opens it up, an unpublish drops the connection at once (see public/ws.ts). Archiving
    // takes the room out of the snapshot's filter too (`status !== 'archived'`), so it counts as
    // "no longer publicly visible" here as well — the two surfaces must not disagree.
    if (patch.is_public !== undefined && patch.is_public !== current.is_public) {
      publicBus.publish({ project_id: id, is_public: patch.is_public });
    }
    if (patch.status === 'archived' && current.status !== 'archived') {
      publicBus.publish({ project_id: id, is_public: false });
    }
    return { project };
  });

  app.delete('/:id', async (request) => {
    const { id } = idParam.parse(request.params);
    const { machine } = await scoped(repos, request).project(id);
    // Melhor esforço: mata as sessões tmux das tabs antes de apagar (máquina pode estar offline).
    await Promise.allSettled(
      (await repos.tabs.listByProject(id)).filter((t) => t.tmux_session).map((t) => killTmuxSession(machine, t.tmux_session!)),
    );
    await repos.projects.delete(id);
    // A deleted room can never be publicly visible again either — tell the public bus regardless
    // of whether this project was ever published; a socket that never had it just no-ops.
    publicBus.publish({ project_id: id, is_public: false });
    return { ok: true };
  });

  // --- Tabs ---
  app.get('/:id/tabs', async (request) => {
    const { id } = idParam.parse(request.params);
    const { machine } = await scoped(repos, request).project(id);
    const tabs = await repos.tabs.listByProject(id);
    let alive = new Set<string>();
    let reachable = false;
    const terminalTabs = tabs.filter((t) => t.kind === 'terminal');
    if (terminalTabs.length > 0) {
      try {
        alive = await listTmuxSessions(machine);
        reachable = true;
      } catch {
        reachable = false;
      }
    } else {
      reachable = true;
    }
    return {
      reachable,
      tabs: tabs.map((t) => ({
        ...t,
        alive:
          t.kind === 'simulator'
            ? !!t.simulator_udid && deps.simulators.isReady(machine.id, t.simulator_udid)
            : !!t.tmux_session && alive.has(t.tmux_session),
      })),
    };
  });

  app.post('/:id/tabs', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const { machine } = await scoped(repos, request).project(id);
    const body = tabBody.parse(request.body ?? {});
    const kind = body.kind ?? 'terminal';
    const existing = await repos.tabs.listByProject(id);
    const count = existing.filter((t) => t.kind === kind).length + 1;
    const name =
      body.name ??
      (kind === 'simulator' ? `Simulador ${count}` : nextTerminalName(existing.map((t) => t.name)));
    if (kind === 'simulator' && !machine.capabilities.includes('wda')) throw badRequest('Prepare o WDA nesta máquina antes de abrir um simulador');
    const tab = await repos.tabs.create(id, name, { kind, simulator_udid: body.simulator_udid ?? null });
    return reply.code(201).send({ tab: { ...tab, alive: false } });
  });
}
