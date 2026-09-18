import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CLOSE } from '@termhub/agent-protocol';
import type { Repositories } from '../db/repositories/index.js';
import { badRequest, conflict, forbidden } from '../lib/errors.js';
import { scoped } from '../auth/scope.js';
import { isAdmin } from '../auth/permissions.js';
import { diagnoseSsh, machineStatus } from '../terminal/machine-exec.js';
import { listSimulators } from '../simulator/machine.js';
import { startWdaSetup, wdaSetupState } from '../simulator/setup.js';
import { browseMachine, makeDirectory } from '../terminal/machine-fs.js';
import { collectHardware } from '../system/hardware.js';
import { newAgentToken } from '../agent/token.js';
import { agents } from '../agent/registry.js';
import { config } from '../config.js';
import { installHooks, uninstallHooks } from '../monitor/install.js';
import { newHookToken } from '../monitor/token.js';

const idParam = z.object({ id: z.string().min(1).max(64) });
const fsQuery = z.object({ path: z.string().max(4096).optional() });
const mkdirBody = z.object({ parent: z.string().min(1).max(4096), name: z.string().trim().min(1).max(255) });

const machineBody = z
  .object({
    name: z.string().trim().min(1).max(80),
    type: z.enum(['local', 'ssh', 'agent']),
    host: z.string().trim().min(1).max(253).optional().nullable(),
    ssh_user: z.string().trim().min(1).max(64).optional().nullable(),
    ssh_port: z.coerce.number().int().min(1).max(65535).optional(),
  })
  .superRefine((m, ctx) => {
    if (m.type === 'ssh' && !m.host) ctx.addIssue({ code: 'custom', path: ['host'], message: 'host é obrigatório para SSH' });
    if (m.type === 'agent' && m.host) ctx.addIssue({ code: 'custom', path: ['host'], message: 'máquina com agente não tem host' });
  });

/** Hook install/uninstall runs shell on the machine, which agent machines do not do (no RPC for it yet). */
const HOOKS_ON_AGENT = 'Instalação de hooks ainda não disponível em máquinas com agente';

const ownerPatch = z.object({ owner_id: z.string().min(1).max(64).nullable().optional() });

const testBody = z.object({
  host: z.string().trim().min(1).max(253),
  ssh_user: z.string().trim().min(1).max(64).optional().nullable(),
  ssh_port: z.coerce.number().int().min(1).max(65535).optional(),
});

export async function machineRoutes(app: FastifyInstance, repos: Repositories) {
  /** Connection test for the machine form (before saving): explains refused / unreachable / auth / missing tmux. */
  app.post('/test', async (request) => {
    const b = testBody.parse(request.body);
    return await diagnoseSsh({ host: b.host, ssh_user: b.ssh_user ?? null, ssh_port: b.ssh_port ?? 22 });
  });

  /** Machines in the caller's scope (own, or the "view as" target / all for admins). */
  app.get('/', async (request) => ({ machines: await repos.machines.list(request.scope.ownerId) }));

  app.post('/', async (request, reply) => {
    const body = machineBody.parse(request.body);
    if (body.type === 'agent') {
      const { token, hash } = newAgentToken();
      const machine = await repos.machines.create({ ...body, host: null, ssh_user: null, owner_id: request.scope.createAs });
      await repos.machines.rotateAgentToken(machine.id, hash);
      return reply.code(201).send({ machine, agent_token: token });
    }
    const machine = await repos.machines.create({ ...body, owner_id: request.scope.createAs });
    return reply.code(201).send({ machine });
  });

  /** Rotates an agent machine's enrollment token and kicks the current connection (if any). */
  app.post('/:id/agent-token', { config: { action: 'update' } }, async (request) => {
    const { id } = idParam.parse(request.params);
    const machine = await scoped(repos, request).machine(id);
    if (machine.type !== 'agent') throw badRequest('Máquina não usa agente');
    const { token, hash } = newAgentToken();
    await repos.machines.rotateAgentToken(id, hash);
    agents.disconnect(id, CLOSE.UNAUTHORIZED, 'rotated');
    return { agent_token: token };
  });

  app.get('/:id', async (request) => {
    const { id } = idParam.parse(request.params);
    return { machine: await scoped(repos, request).machine(id) };
  });

  app.patch('/:id', async (request) => {
    const { id } = idParam.parse(request.params);
    const current = await scoped(repos, request).machine(id);
    const patchType = (request.body as { type?: string } | undefined)?.type;
    if (patchType !== undefined && patchType !== current.type && (patchType === 'agent' || current.type === 'agent')) {
      throw badRequest('tipo de transporte não pode ser alterado');
    }
    const merged = machineBody.parse({ ...current, ...(request.body as object) });
    // owner transfer is an admin-only field (any admin scope, including "all")
    const { owner_id } = ownerPatch.parse(request.body ?? {});
    if (owner_id !== undefined) {
      if (!(await isAdmin(repos, request.user))) throw forbidden('Só administradores transferem máquinas');
      if (owner_id && !(await repos.users.findById(owner_id))) throw badRequest('Usuário inexistente');
    }
    return { machine: await repos.machines.update(id, { ...merged, ...(owner_id !== undefined ? { owner_id } : {}) }) };
  });

  app.delete('/:id', async (request) => {
    const { id } = idParam.parse(request.params);
    await scoped(repos, request).machine(id);
    if ((await repos.projects.list({ machine_id: id })).length > 0) {
      throw badRequest('Remova os projetos desta máquina antes de excluí-la');
    }
    await repos.machines.delete(id);
    agents.disconnect(id, CLOSE.UNAUTHORIZED, 'deleted');
    return { ok: true };
  });

  app.get('/:id/status', async (request) => {
    const { id } = idParam.parse(request.params);
    const machine = await scoped(repos, request).machine(id);
    const status = await machineStatus(machine);
    const checked_at = new Date().toISOString();
    if (machine.type === 'agent') {
      const info = agents.info(id);
      return { id, ...status, agent_version: info?.agent_version ?? machine.agent_version, last_seen_at: machine.agent_last_seen_at, checked_at };
    }
    if (status.online) await repos.machines.setDetected(id, status.os, status.capabilities);
    return { id, ...status, checked_at };
  });

  const requireMac = (m: { os: string | null; capabilities: string[] }) => {
    if (m.os !== 'macos' || !m.capabilities.includes('xcodebuild')) throw badRequest('Esta máquina não é um Mac com Xcode');
  };

  app.get('/:id/simulators', async (request) => {
    const { id } = idParam.parse(request.params);
    const machine = await scoped(repos, request).machine(id);
    if (machine.type === 'agent') throw conflict('Simulador indisponível em máquinas com agente');
    requireMac(machine);
    return { simulators: await listSimulators(machine) };
  });

  app.get('/:id/simulator/setup', async (request) => {
    const { id } = idParam.parse(request.params);
    const machine = await scoped(repos, request).machine(id);
    if (machine.type === 'agent') throw conflict('Simulador indisponível em máquinas com agente');
    const state = await wdaSetupState(machine);
    if (state.state === 'ok' && !machine.capabilities.includes('wda')) {
      const status = await machineStatus(machine);
      if (status.online) await repos.machines.setDetected(id, status.os, status.capabilities);
    }
    return state;
  });

  app.post('/:id/simulator/setup', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const machine = await scoped(repos, request).machine(id);
    if (machine.type === 'agent') throw conflict('Simulador indisponível em máquinas com agente');
    requireMac(machine);
    await startWdaSetup(machine);
    return reply.code(202).send({ ok: true });
  });

  /** Monitor hooks on the machine: installed or not, and where they post. */
  app.get('/:id/hooks', async (request) => {
    const { id } = idParam.parse(request.params);
    const machine = await scoped(repos, request).machine(id);
    const hook = await repos.machineHooks.findByMachine(machine.id);
    return { installed_at: hook?.installed_at ?? null, hooks_url: config.hooksUrl };
  });

  /**
   * Installs (or reinstalls with a fresh token) the monitor hooks on the machine: the script under
   * ~/.termhub/bin, the entries in ~/.claude/settings.json and, when Codex is there, config.toml.
   * Only the token's hash is kept here; the plain token lives in ~/.termhub/hook.env on the machine.
   */
  app.post('/:id/hooks', { config: { action: 'update' } }, async (request) => {
    const { id } = idParam.parse(request.params);
    const machine = await scoped(repos, request).machine(id);
    // installHooks runs shell on the machine; agents only answer named RPCs and have none for this yet
    if (machine.type === 'agent') throw conflict(HOOKS_ON_AGENT);
    const { token, hash } = newHookToken();
    let report;
    try {
      report = await installHooks(machine, token, config.hooksUrl);
    } catch (err) {
      throw conflict(err instanceof Error ? err.message : 'Instalação falhou');
    }
    const hook = await repos.machineHooks.upsert(machine.id, hash);
    request.log.info({ machineId: machine.id, claude: report.claude, codex: report.codex }, 'monitor: hooks installed');
    return { installed_at: hook.installed_at, hooks_url: report.hooks_url, claude: report.claude, codex: report.codex };
  });

  /** Removes the hooks from the machine and revokes its token. */
  app.delete('/:id/hooks', { config: { action: 'update' } }, async (request) => {
    const { id } = idParam.parse(request.params);
    const machine = await scoped(repos, request).machine(id);
    if (machine.type === 'agent') throw conflict(HOOKS_ON_AGENT);
    try {
      await uninstallHooks(machine);
    } catch (err) {
      throw conflict(err instanceof Error ? err.message : 'Remoção falhou');
    }
    await repos.machineHooks.delete(machine.id);
    request.log.info({ machineId: machine.id }, 'monitor: hooks removed');
    return { ok: true };
  });

  /** Navegador de diretórios: subpastas de ?path (padrão $HOME) + discos/mounts da máquina. */
  app.get('/:id/fs', async (request) => {
    const { id } = idParam.parse(request.params);
    const { path } = fsQuery.parse(request.query);
    const machine = await scoped(repos, request).machine(id);
    return await browseMachine(machine, path);
  });

  /** Cria uma subpasta em `parent` na máquina e devolve o caminho absoluto. */
  app.post('/:id/fs/mkdir', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const { parent, name } = mkdirBody.parse(request.body);
    const machine = await scoped(repos, request).machine(id);
    const path = await makeDirectory(machine, parent, name);
    return reply.code(201).send({ path });
  });

  /**
   * Hardware snapshot (CPU, memory, disks, temps, GPU, top processes) for the Home "Hardware" tab.
   * Guarded as hardware:read (route config below).
   */
  app.get('/:id/hardware', { config: { resource: 'hardware', action: 'read' } }, async (request) => {
    const { id } = idParam.parse(request.params);
    const machine = await scoped(repos, request).machine(id);
    return { hardware: await collectHardware(machine) };
  });
}
