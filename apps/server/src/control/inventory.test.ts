import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../terminal/machine-exec.js', () => ({ listTmuxSessions: vi.fn() }));
vi.mock('../agent/registry.js', () => ({ agents: { isOnline: vi.fn() } }));

import { agents } from '../agent/registry.js';
import type { Repositories } from '../db/repositories/index.js';
import type { AiAccount, Machine, Project, Tab } from '../db/repositories/types.js';
import { listTmuxSessions } from '../terminal/machine-exec.js';
import { Scoped } from '../auth/scope.js';
import type { ControlContext } from './context.js';
import { find, listAiAccounts, listMachines, listProjects, listTabs, normalizeName } from './inventory.js';

const machine = (over: Partial<Machine> & { id: string }): Machine => ({
  name: over.id, host: null, ssh_user: null, ssh_port: 22, type: 'agent', os: 'macos', capabilities: ['tmux', 'claude'], checked_at: null,
  agent_version: '0.2.0', agent_last_seen_at: null, agent_auto_update: false, is_local: false, owner_id: 'u1', owner_name: null, created_at: '', ...over,
});
const project = (over: Partial<Project> & { id: string }): Project => ({
  owner_id: 'u1', key: over.id.toUpperCase(), next_task_number: 1, name: over.id, status: 'active', description: null, last_terminal_at: null, created_at: '', ...over,
});
const tab = (over: Partial<Tab> & { id: string; project_id: string }): Tab => ({
  name: over.id, kind: 'terminal', machine_id: 'm1', tmux_session: 'th-' + over.id, simulator_udid: null, position: 0,
  state: null, state_text: null, state_tool: null, state_at: null, state_seen_at: null, created_at: '', ...over,
});
const account = (over: Partial<AiAccount> & { id: string; machine_id: string }): AiAccount => ({
  provider: 'claude', label: over.id, config_dir: '/home/x/.claude-secret', created_at: '', ...over,
});
const l = (p: string, m: string) => ({ id: p + m, project_id: p, machine_id: m, cwd: '/src/' + p, position: 0, created_at: '' });

/** Data of two users; u1 is the token's user. */
const machines = [machine({ id: 'm1', name: 'MacBook Pro M4' }), machine({ id: 'm2', name: 'jarvis', type: 'local' }), machine({ id: 'mx', name: 'MacBook do Outro', owner_id: 'u2' })];
const projects = [
  project({ id: 'p1', name: 'Hub Community' }),
  project({ id: 'p2', name: 'termhub' }),
  project({ id: 'p3', name: 'Velho', status: 'archived' }),
  project({ id: 'px', name: 'Hub Community', owner_id: 'u2' }),
];
const links = [l('p1', 'm1'), l('p2', 'm2'), l('p3', 'm1'), l('px', 'mx')];
const tabs = [tab({ id: 't1', project_id: 'p1', state: 'waiting_input', state_text: 'Posso seguir?', state_at: '2026-09-19T10:00:00.000Z' }), tab({ id: 't2', project_id: 'p1' }), tab({ id: 'ts', project_id: 'p1', kind: 'simulator', tmux_session: null })];
const accounts = [account({ id: 'a1', label: 'pedrogoiania', machine_id: 'm1' }), account({ id: 'ax', label: 'pedrogoiania', machine_id: 'mx' })];

function ctx(grants: string[] = ['machines:read', 'projects:read', 'terminals:read', 'ai_accounts:read']): ControlContext {
  const repos = {
    machines: {
      list: vi.fn(async (owner: string | null) => machines.filter((m) => owner === null || m.owner_id === owner)),
      findById: vi.fn(async (id: string) => machines.find((m) => m.id === id)),
    },
    projects: {
      list: vi.fn(async (f: { machine_id?: string; owner?: string | null }) =>
        projects.filter((p) => (f.owner == null || p.owner_id === f.owner) && (!f.machine_id || links.some((l) => l.project_id === p.id && l.machine_id === f.machine_id))),
      ),
      findById: vi.fn(async (id: string) => projects.find((p) => p.id === id)),
      findByKey: vi.fn(async (key: string) => projects.find((p) => p.key === key)),
    },
    projectMachines: {
      listByProjects: vi.fn(async (ids: string[]) => links.filter((l) => ids.includes(l.project_id))),
      listByProject: vi.fn(async (p: string) => links.filter((l) => l.project_id === p)),
      find: vi.fn(async (p: string, m: string) => links.find((l) => l.project_id === p && l.machine_id === m)),
    },
    tabs: {
      listByProject: vi.fn(async (pid: string) => tabs.filter((t) => t.project_id === pid)),
      listByProjectsOnMachine: vi.fn(async (pids: string[], mid: string) => tabs.filter((t) => pids.includes(t.project_id) && t.machine_id === mid)),
      findById: vi.fn(async (id: string) => tabs.find((t) => t.id === id)),
    },
    aiAccounts: { list: vi.fn(async (owner: string | null) => accounts.filter((a) => owner === null || machines.find((m) => m.id === a.machine_id)!.owner_id === owner)) },
    tasks: {
      listByProject: vi.fn(async (pid: string) => (pid === 'p1' ? [{ id: 'k1', title: 'XPTO', status: 'doing', tab_id: 't1', subtasks: [] }] : [])),
      findByRef: vi.fn(async (pid: string, n: number) =>
        pid === 'p1' && n === 12 ? { id: 'k12', project_id: 'p1', ref: 'P1-12', title: 'Checkout' } : pid === 'px' && n === 1 ? { id: 'kx1', project_id: 'px', ref: 'PX-1', title: 'Deles' } : undefined,
      ),
    },
  } as unknown as Repositories;
  const scope = { user: { id: 'u1' } as never, viewAs: { kind: 'self' } as const, ownerId: 'u1', createAs: 'u1' };
  return { repos, scope, scoped: new Scoped(repos, scope), can: async (r, a) => grants.includes(`${r}:${a}`) };
}

beforeEach(() => {
  vi.mocked(agents.isOnline).mockImplementation((id: string) => id === 'm1');
  vi.mocked(listTmuxSessions).mockClear().mockResolvedValue(new Set(['th-t1']));
});

describe('normalizeName', () => {
  it('lowercases and strips diacritics and extra spaces', () => {
    expect(normalizeName('  Hub   Comunicação ')).toBe('hub comunicacao');
  });
});

describe('listMachines', () => {
  it('lists only the owner\'s machines with online status per transport', async () => {
    const r = await listMachines(ctx());
    expect(r.machines.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(r.machines[0]).toMatchObject({ id: 'm1', name: 'MacBook Pro M4', type: 'agent', online: true, os: 'macos', capabilities: ['tmux', 'claude'] });
    expect(r.machines[1]).toMatchObject({ id: 'm2', type: 'local', online: true });
  });

  it('carries the machine\'s subtitle, null when it has none', async () => {
    const c = ctx();
    vi.mocked(c.repos.machines.list).mockResolvedValue([machine({ id: 'm1', subtitle: 'MacBook do escritório' }), machine({ id: 'm2', subtitle: null })]);
    const r = await listMachines(c);
    expect(r.machines.map((m) => m.subtitle)).toEqual(['MacBook do escritório', null]);
  });

  it('reports an offline agent and an unchecked ssh machine', async () => {
    vi.mocked(agents.isOnline).mockReturnValue(false);
    const c = ctx();
    vi.mocked(c.repos.machines.list).mockResolvedValue([machine({ id: 'm1' }), machine({ id: 'm3', type: 'ssh', host: 'box' })]);
    const r = await listMachines(c);
    expect(r.machines.map((m) => m.online)).toEqual([false, null]);
  });
});

describe('listProjects', () => {
  it('hides archived projects unless asked, and names the machine', async () => {
    const r = await listProjects(ctx(), {});
    expect(r.projects.map((p) => p.id)).toEqual(['p1', 'p2']);
    expect(r.projects[0]).toMatchObject({ id: 'p1', key: 'P1', name: 'Hub Community', machines: [{ machine_id: 'm1', machine_name: 'MacBook Pro M4', cwd: '/src/p1' }] });
    expect((await listProjects(ctx(), { include_archived: true })).projects.map((p) => p.id)).toEqual(['p1', 'p2', 'p3']);
  });

  it('filters by a machine of the owner and refuses a foreign one', async () => {
    expect((await listProjects(ctx(), { machine_id: 'm1' })).projects.map((p) => p.id)).toEqual(['p1']);
    await expect(listProjects(ctx(), { machine_id: 'mx' })).rejects.toThrow('Máquina não encontrada');
  });
});

describe('listTabs', () => {
  it('lists a project\'s tabs with liveness, monitor state and the linked task', async () => {
    const r = await listTabs(ctx(), { project_id: 'p1' });
    expect(r.tabs.map((t) => t.id)).toEqual(['t1', 't2', 'ts']);
    expect(r.tabs[0]).toMatchObject({ id: 't1', kind: 'terminal', alive: true, state: 'waiting_input', state_text: 'Posso seguir?', task: { id: 'k1', title: 'XPTO', status: 'doing' } });
    expect(r.tabs[1]).toMatchObject({ id: 't2', alive: false, state: null, task: null });
    expect(r.tabs[2]).toMatchObject({ id: 'ts', kind: 'simulator', alive: null });
  });

  it('says liveness is unknown when the agent machine is offline, without asking it', async () => {
    // listTmuxSessions answers an empty Set (not a rejection) for an offline agent: asking would read every tab as dead
    vi.mocked(agents.isOnline).mockReturnValue(false);
    vi.mocked(listTmuxSessions).mockResolvedValue(new Set());
    const r = await listTabs(ctx(), { project_id: 'p1' });
    expect(r.tabs.map((t) => t.alive)).toEqual([null, null, null]);
    expect(listTmuxSessions).not.toHaveBeenCalled();
  });

  it('says liveness is unknown when listing the sessions fails', async () => {
    vi.mocked(listTmuxSessions).mockRejectedValueOnce(new Error('ssh: connect timed out'));
    const r = await listTabs(ctx(), { project_id: 'p1' });
    expect(r.tabs[0].alive).toBeNull();
  });

  it('lists every project of a machine, requires a filter and refuses foreign ids', async () => {
    expect((await listTabs(ctx(), { machine_id: 'm1' })).tabs.map((t) => t.id)).toEqual(['t1', 't2', 'ts']);
    await expect(listTabs(ctx(), {})).rejects.toThrow('Informe project_id ou machine_id');
    await expect(listTabs(ctx(), { project_id: 'px' })).rejects.toThrow('Projeto não encontrado');
  });
});

describe('listAiAccounts', () => {
  it('lists the owner\'s accounts without the config dir', async () => {
    const r = await listAiAccounts(ctx(), {});
    expect(r.accounts).toEqual([{ id: 'a1', provider: 'claude', label: 'pedrogoiania', machine_id: 'm1', machine_name: 'MacBook Pro M4' }]);
    expect(JSON.stringify(r)).not.toContain('claude-secret');
  });
});

describe('find', () => {
  it('resolves names across kinds, ignoring case and accents, only in the owner\'s data', async () => {
    const r = await find(ctx(), { query: 'hub community' });
    expect(r.matches).toEqual([{ kind: 'project', id: 'p1', name: 'Hub Community', machine_id: null, machine_name: null, score: 3 }]);

    const mac = await find(ctx(), { query: 'macbook' });
    expect(mac.matches.map((m) => m.id)).toEqual(['m1']);

    const acc = await find(ctx(), { query: 'PEDROGOIANIA', kinds: ['ai_account'] });
    expect(acc.matches.map((m) => `${m.kind}:${m.id}`)).toEqual(['ai_account:a1']);

    expect((await find(ctx(), { query: 'p2' })).matches[0]).toMatchObject({ kind: 'project', id: 'p2' });
  });

  it('ranks exact > prefix > contains > all words', async () => {
    const c = ctx();
    vi.mocked(c.repos.machines.list).mockResolvedValue([
      machine({ id: 'a', name: 'Pro M4 MacBook' }),
      machine({ id: 'b', name: 'MacBook Pro M4 (casa)' }),
      machine({ id: 'c', name: 'macbook pro m4' }),
      machine({ id: 'd', name: 'Meu MacBook Pro M4' }),
    ]);
    const r = await find(c, { query: 'MacBook Pro M4', kinds: ['machine'] });
    expect(r.matches.map((m) => [m.id, m.score])).toEqual([['c', 3], ['b', 2], ['d', 1.5], ['a', 1]]);
  });

  it('skips kinds the token cannot read', async () => {
    const r = await find(ctx(['machines:read', 'projects:read']), { query: 'pedrogoiania' });
    expect(r.matches).toEqual([]);
  });

  it('finds a card by its exact ref, only in the owner\'s projects and with tasks:read', async () => {
    const grants = ['machines:read', 'projects:read', 'ai_accounts:read', 'tasks:read'];
    expect((await find(ctx(grants), { query: 'p1-12' })).matches).toEqual([{ kind: 'task', id: 'k12', name: 'P1-12 Checkout', machine_id: null, machine_name: null, score: 3 }]);
    expect((await find(ctx(grants), { query: 'PX-1', kinds: ['task'] })).matches).toEqual([]); // another user's project
    expect((await find(ctx(grants), { query: 'P1-99', kinds: ['task'] })).matches).toEqual([]);
    expect((await find(ctx(), { query: 'P1-12', kinds: ['task'] })).matches).toEqual([]); // no tasks:read
  });
});
