// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Machine, MonitorItem, Project, Tab } from '../lib/types';

const state = vi.hoisted(() => ({
  projects: [] as Project[],
  machines: [] as Machine[],
  /** every open terminal tab (the sidebar's source) */
  openTabs: [] as Tab[],
  /** tabs that reported a state (what the sidebar used to read): must not drive it */
  items: [] as MonitorItem[],
}));

vi.mock('../lib/auth', () => ({
  useAuth: () => ({
    user: { id: 'u1', name: 'Pedro', avatar_url: null, email: 'pedro@example.com' },
    logout: vi.fn(),
    can: () => true,
    viewAs: 'self',
  }),
}));
vi.mock('../lib/monitor', () => ({ useMonitor: () => ({ items: state.items, openTabs: state.openTabs, needsYou: [] }) }));
vi.mock('../lib/data', () => ({
  useData: () => ({
    machines: state.machines,
    projects: state.projects,
    hiddenLocal: [],
    claimLocal: vi.fn(),
    statuses: {},
    missingTmux: {},
    loading: false,
    deleteProject: vi.fn(),
    checkStatus: vi.fn(),
    machinesOf: (p: Project) => p.machines.map((l) => state.machines.find((m) => m.id === l.machine_id)).filter(Boolean),
  }),
}));

import { Sidebar } from './Sidebar';

const machine = (id: string, name: string) => ({ id, name, type: 'agent', capabilities: [], is_local: false, os: null, owner_name: null }) as unknown as Machine;
const project = (id: string, name: string, over: Partial<Project> = {}): Project =>
  ({ id, key: name.toUpperCase(), name, status: 'active', machines: [{ machine_id: 'm1', cwd: '/a', position: 0 }], ...over }) as Project;
const openTab = (id: string, name: string, p: Project, machineId: string, over: Partial<Tab> = {}): Tab =>
  ({ id, name, project_id: p.id, machine_id: machineId, kind: 'terminal', position: 0, state: 'working', state_at: '2026-09-23T10:00:00.000Z', state_seen_at: null, ...over }) as Tab;

const TWO_MACHINES = [
  { machine_id: 'm1', cwd: '/a', position: 0 },
  { machine_id: 'm2', cwd: '/a', position: 1 },
];

/** alpha: running (two machines) · beta: running (one machine) · gamma: idle · omega: archived. */
function seed() {
  state.machines = [machine('m1', 'mac'), machine('m2', 'jarvis')];
  const alpha = project('p1', 'alpha', { machines: TWO_MACHINES });
  const beta = project('p2', 'beta');
  const gamma = project('p3', 'gamma');
  const omega = project('p5', 'omega', { status: 'archived' });
  state.projects = [alpha, beta, gamma, omega];
  state.openTabs = [
    // out of position order on purpose: rows follow tab.position
    openTab('t2', 'Bia', alpha, 'm1', { position: 1 }),
    openTab('t1', 'Ana', alpha, 'm2', { position: 0, state: 'waiting_input' }),
    // never reported a state (no monitor hooks, or nothing ran yet): still an open agent
    openTab('t3', 'Caio', beta, 'm1', { state: null, state_at: null }),
  ];
  state.items = [];
}

function renderSidebar() {
  return render(
    <MemoryRouter>
      <Sidebar />
    </MemoryRouter>,
  );
}

const section = (name: string) => screen.getByRole('region', { name });
/** A project's agent list inside a section; the list is named after both, since a running project shows in two. */
const agentsOf = (container: HTMLElement, projectName: string) =>
  within(container).queryByRole('list', { name: `Agentes de ${projectName} · ${container.getAttribute('aria-label')}` });

beforeEach(() => {
  seed();
  localStorage.clear();
});
afterEach(() => cleanup());

describe('Sidebar sections', () => {
  it('puts running projects in "Em execução" and every project in the list below it — a running project in both', () => {
    renderSidebar();
    const running = section('Em execução');
    expect(within(running).getByRole('link', { name: /alpha/ })).toBeInTheDocument();
    expect(within(running).getByRole('link', { name: /beta/ })).toBeInTheDocument();
    expect(within(running).queryByRole('link', { name: /gamma/ })).not.toBeInTheDocument();

    const all = section('Todos os projetos');
    expect(within(all).getAllByRole('link', { name: /^[A-Z]+ [a-z]+/ }).map((l) => l.textContent)).toEqual(['ALPHAalpha', 'BETAbeta', 'GAMMAgamma']);
    expect(within(all).queryByRole('link', { name: /omega/ })).not.toBeInTheDocument(); // archived, hidden by default
  });

  it('hides "Em execução" (and the list\'s own label) when nothing is running', () => {
    state.openTabs = [];
    renderSidebar();
    expect(screen.queryByRole('region', { name: 'Em execução' })).not.toBeInTheDocument();
    expect(within(section('Todos os projetos')).getByRole('link', { name: /alpha/ })).toBeInTheDocument();
    expect(screen.queryByText('Todos os projetos')).not.toBeInTheDocument(); // "Projetos" above already says it
    expect(screen.getByText('Projetos')).toBeInTheDocument();
  });

  it('shows the empty state when there are no projects', () => {
    state.projects = [];
    state.openTabs = [];
    renderSidebar();
    expect(screen.getByRole('button', { name: '+ novo projeto' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Todos os projetos' })).not.toBeInTheDocument();
  });

  it('"Mostrar arquivados" applies to every section', () => {
    state.openTabs = [...state.openTabs, openTab('t9', 'Duda', state.projects[3], 'm1')]; // an archived project with a running tab
    renderSidebar();
    expect(screen.queryByRole('link', { name: /omega/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Mostrar arquivados' }));
    expect(within(section('Todos os projetos')).getByRole('link', { name: /omega/ })).toBeInTheDocument();
    expect(within(section('Em execução')).getByRole('link', { name: /omega/ })).toBeInTheDocument();
  });

  it('keeps the project actions: edit and delete, and no pin yet', () => {
    renderSidebar();
    const all = section('Todos os projetos');
    expect(within(all).getAllByTitle('Editar projeto')).toHaveLength(3);
    expect(within(all).getAllByTitle(/Excluir projeto/)).toHaveLength(3);
    expect(screen.queryByRole('button', { name: /Fixar projeto/ })).not.toBeInTheDocument();
  });
});

describe('Sidebar agent rows', () => {
  it('nests each open tab under its project, ordered by position, with the machine only when the project has several', () => {
    renderSidebar();
    const running = section('Em execução');
    const alpha = agentsOf(running, 'alpha')!;
    const rows = within(alpha).getAllByRole('link');
    expect(rows.map((r) => r.textContent)).toEqual(['Ana · jarvis', 'Bia · mac']);

    const beta = agentsOf(running, 'beta')!;
    expect(within(beta).getByRole('link').textContent).toBe('Caio'); // one machine: no suffix
    expect(within(beta).queryByText(/mac/)).not.toBeInTheDocument();
  });

  it('names each agent list after its section too, so a running project\'s two lists are told apart', () => {
    renderSidebar();
    const names = screen.getAllByRole('list', { name: /^Agentes de alpha/ }).map((l) => l.getAttribute('aria-label'));
    expect(names).toEqual(['Agentes de alpha · Em execução', 'Agentes de alpha · Todos os projetos']);
    const toggles = screen.getAllByRole('button', { name: 'Recolher agentes de alpha' });
    expect(toggles.map((b) => document.getElementById(b.getAttribute('aria-controls')!)?.getAttribute('aria-label'))).toEqual(names);
  });

  it('links each agent to its tab in the project view', () => {
    renderSidebar();
    const alpha = agentsOf(section('Em execução'), 'alpha')!;
    expect(within(alpha).getByRole('link', { name: /Ana/ })).toHaveAttribute('href', '/projects/p1?tab=t1');
    expect(within(alpha).getByRole('link', { name: /Bia/ })).toHaveAttribute('href', '/projects/p1?tab=t2');
  });

  it('colours the dot with the tab state: the pulsing attention colour when it needs you', () => {
    renderSidebar();
    const alpha = agentsOf(section('Em execução'), 'alpha')!;
    const dot = (name: RegExp) => within(alpha).getByRole('link', { name }).querySelector('[data-dot]')!;
    expect(dot(/Ana/)).toHaveClass('bg-attention', 'animate-pulse');
    expect(dot(/Bia/)).toHaveClass('bg-ok');
    expect(dot(/Bia/)).not.toHaveClass('bg-attention');
    const caio = within(agentsOf(section('Em execução'), 'beta')!).getByRole('link', { name: /Caio/ }).querySelector('[data-dot]')!;
    expect(caio).toHaveClass('bg-ok'); // no state reported: the neutral dot the tab bar shows for a live tab
  });

  it('reads the open tabs, not the tabs that reported a state', () => {
    state.openTabs = [];
    state.items = [{ tab: openTab('t1', 'Ana', state.projects[0], 'm1'), project: state.projects[0], machine: state.machines[0] }];
    renderSidebar();
    expect(screen.queryByRole('region', { name: 'Em execução' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Ana/ })).not.toBeInTheDocument();
  });

  it('a project without open tabs has no agent list and no chevron', () => {
    renderSidebar();
    const all = section('Todos os projetos');
    expect(agentsOf(all, 'gamma')).toBeNull();
    expect(within(all).queryByRole('button', { name: /agentes de gamma/ })).not.toBeInTheDocument();
    expect(within(all).getByRole('button', { name: 'Recolher agentes de alpha' })).toBeInTheDocument();
  });

  it('collapsing a project collapses it in every section, and it is remembered', () => {
    renderSidebar();
    fireEvent.click(within(section('Todos os projetos')).getByRole('button', { name: 'Recolher agentes de alpha' }));
    expect(agentsOf(section('Todos os projetos'), 'alpha')).toBeNull();
    expect(agentsOf(section('Em execução'), 'alpha')).toBeNull();
    expect(agentsOf(section('Em execução'), 'beta')).not.toBeNull();

    cleanup();
    renderSidebar();
    expect(agentsOf(section('Em execução'), 'alpha')).toBeNull();
    expect(within(section('Em execução')).getByRole('button', { name: 'Expandir agentes de alpha' })).toHaveAttribute('aria-expanded', 'false');
  });

  it('still works when browser storage throws (private mode, blocked site data)', () => {
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    try {
      renderSidebar();
      expect(agentsOf(section('Em execução'), 'alpha')).not.toBeNull(); // default: expanded
      fireEvent.click(within(section('Em execução')).getByRole('button', { name: 'Recolher agentes de alpha' }));
      expect(agentsOf(section('Em execução'), 'alpha')).toBeNull();
    } finally {
      get.mockRestore();
      set.mockRestore();
    }
  });

  it('no longer lists machines under projects', () => {
    renderSidebar();
    expect(screen.queryByText(/sem máquina/)).not.toBeInTheDocument();
    expect(screen.queryByTitle('Editar')).not.toBeInTheDocument();
  });
});

describe('Sidebar collapse/expand all', () => {
  it('collapses every project with agents when any is expanded, then expands them all', () => {
    renderSidebar();
    const running = () => section('Em execução');
    // one already collapsed, the other expanded: "any expanded" still means collapse all
    fireEvent.click(within(running()).getByRole('button', { name: 'Recolher agentes de beta' }));
    const all = screen.getByRole('button', { name: 'Recolher todos' });
    expect(all).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(all);
    expect(screen.getByRole('button', { name: 'Expandir todos' })).toHaveAttribute('aria-expanded', 'false');
    expect(agentsOf(running(), 'alpha')).toBeNull();
    expect(agentsOf(running(), 'beta')).toBeNull();
    expect(agentsOf(section('Todos os projetos'), 'alpha')).toBeNull(); // the same project, collapsed everywhere

    fireEvent.click(screen.getByRole('button', { name: 'Expandir todos' }));
    expect(agentsOf(running(), 'alpha')).not.toBeNull();
    expect(agentsOf(running(), 'beta')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Recolher todos' })).toHaveAttribute('title', 'Recolher todos');
  });

  it('is hidden when no project has agents', () => {
    state.openTabs = [];
    renderSidebar();
    expect(screen.queryByRole('button', { name: /(Recolher|Expandir) todos/ })).not.toBeInTheDocument();
  });
});

describe('Sidebar footer', () => {
  it('has a "Máquinas" nav link to /machines and a single "Novo projeto" add button', () => {
    renderSidebar();
    const machinesLink = screen.getByRole('link', { name: /Máquinas/ });
    expect(machinesLink).toHaveAttribute('href', '/machines');
    expect(screen.getByTitle('Novo projeto')).toBeInTheDocument();
    expect(screen.queryByText('+ máquina')).not.toBeInTheDocument();
  });
});
