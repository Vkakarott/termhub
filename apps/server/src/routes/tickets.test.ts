import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Repositories } from '../db/repositories/index.js';
import type { Machine, Project, ProjectMachine, Tab, Task } from '../db/repositories/types.js';
import { applyErrorHandler } from '../lib/errors.js';
import { taskTicketRoutes } from './tickets.js';

/**
 * Covers only `POST /tasks/:id/terminal`, in the style of `routes/projects.test.ts`. u1 owns machines
 * m1 and m2 and project p1; task t1 belongs to p1 and has no tab yet, task t9 already has a live tab.
 */
const machine = (over: Partial<Machine> & { id: string }): Machine => ({
  name: over.id, host: null, ssh_user: null, ssh_port: 22, type: 'agent', os: null, capabilities: ['tmux'], checked_at: null,
  agent_version: null, agent_last_seen_at: null, agent_auto_update: false, is_local: false, owner_id: 'u1', owner_name: null, created_at: '', ...over,
});
const project = (over: Partial<Project> & { id: string }): Project => ({
  owner_id: 'u1', key: over.id.toUpperCase(), next_task_number: 1, name: over.id, status: 'active', description: null, last_terminal_at: null, created_at: '', ...over,
});
const link = (project_id: string, machine_id: string, cwd = `/src/${project_id}`): ProjectMachine => ({ id: `${project_id}-${machine_id}`, project_id, machine_id, cwd, position: 0, created_at: '' });
const task = (over: Partial<Task> & { id: string; project_id: string }): Task => ({
  title: over.id, description: null, status: 'todo', position: 0, external_ref: null, external_key: null, tab_id: null, parent_id: null,
  created_at: '', updated_at: '', ...over,
});
const tab = (over: Partial<Tab> & { id: string; project_id: string; machine_id: string }): Tab => ({
  name: over.id, kind: 'terminal', tmux_session: `th-${over.id}`, simulator_udid: null, created_by_token_id: null, position: 0,
  state: null, state_text: null, state_tool: null, state_at: null, state_seen_at: null, created_at: '', ...over,
});

function buildApp(links: ProjectMachine[]) {
  const machines: Record<string, Machine> = { m1: machine({ id: 'm1' }), m2: machine({ id: 'm2' }) };
  const projects: Record<string, Project> = { p1: project({ id: 'p1' }) };
  const liveTab = tab({ id: 'live', project_id: 'p1', machine_id: 'm1' });
  const tasks: Record<string, Task> = {
    t1: task({ id: 't1', project_id: 'p1', title: 'Corrigir o build' }),
    t9: task({ id: 't9', project_id: 'p1', title: 'Já tem terminal', tab_id: 'live' }),
  };
  let tabs: Tab[] = [liveTab];

  const app = Fastify();
  applyErrorHandler(app);
  app.addHook('preHandler', async (request) => {
    request.scope = { user: { id: 'u1' } as never, viewAs: { kind: 'self' }, ownerId: 'u1', createAs: 'u1' };
    request.user = { id: 'u1' } as never;
  });

  const setTab = vi.fn(async (id: string, tabId: string | null) => (tasks[id] = { ...tasks[id], tab_id: tabId }));
  const createTab = vi.fn(async (project_id: string, machine_id: string, name: string) => {
    const t = tab({ id: `new-${machine_id}`, project_id, machine_id, name });
    tabs.push(t);
    return t;
  });
  const repos = {
    tasks: { findById: vi.fn(async (id: string) => tasks[id]), setTab },
    projects: { findById: vi.fn(async (id: string) => projects[id]) },
    projectMachines: {
      listByProject: vi.fn(async (id: string) => links.filter((l) => l.project_id === id)),
      find: vi.fn(async (p: string, m: string) => links.find((l) => l.project_id === p && l.machine_id === m)),
    },
    machines: { findById: vi.fn(async (id: string) => machines[id]) },
    tabs: { findById: vi.fn(async (id: string) => tabs.find((t) => t.id === id)), create: createTab },
  } as unknown as Repositories;

  app.register((a) => taskTicketRoutes(a, repos), { prefix: '/tasks' });
  return { app, repos, createTab, setTab };
}

beforeEach(() => vi.clearAllMocks());

describe('POST /tasks/:id/terminal', () => {
  it('opens a terminal on the project\'s one linked machine and links the task to it', async () => {
    const { app, createTab, setTab } = buildApp([link('p1', 'm1')]);
    const res = await app.inject({ method: 'POST', url: '/tasks/t1/terminal' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.created).toBe(true);
    expect(body.tab.machine_id).toBe('m1');
    expect(createTab).toHaveBeenCalledWith('p1', 'm1', 'Corrigir o build');
    expect(setTab).toHaveBeenCalledWith('t1', body.tab.id);
  });

  it('requires machine_id when the project has several linked machines', async () => {
    const { app, createTab } = buildApp([link('p1', 'm1'), link('p1', 'm2')]);
    const res = await app.inject({ method: 'POST', url: '/tasks/t1/terminal' });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('MACHINE_REQUIRED');
    expect(createTab).not.toHaveBeenCalled();
  });

  it('opens the terminal on the machine named in the body when the project has several', async () => {
    const { app, createTab } = buildApp([link('p1', 'm1'), link('p1', 'm2')]);
    const res = await app.inject({ method: 'POST', url: '/tasks/t1/terminal', payload: { machine_id: 'm2' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().tab.machine_id).toBe('m2');
    expect(createTab).toHaveBeenCalledWith('p1', 'm2', 'Corrigir o build');
  });

  it('reuses the task\'s live tab instead of creating a new one', async () => {
    const { app, createTab, setTab } = buildApp([link('p1', 'm1')]);
    const res = await app.inject({ method: 'POST', url: '/tasks/t9/terminal' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.created).toBe(false);
    expect(body.tab.id).toBe('live');
    expect(createTab).not.toHaveBeenCalled();
    expect(setTab).not.toHaveBeenCalled();
  });

  it('400s with NO_MACHINE when the project has no linked machine', async () => {
    const { app, createTab } = buildApp([]);
    const res = await app.inject({ method: 'POST', url: '/tasks/t1/terminal' });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('NO_MACHINE');
    expect(createTab).not.toHaveBeenCalled();
  });
});
