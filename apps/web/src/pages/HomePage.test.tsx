// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Machine, Project, ProjectGroup, Tab } from '../lib/types';

const state = vi.hoisted(() => ({
  loading: false,
  machines: [] as Machine[],
  projects: [] as Project[],
  openTabs: [] as Tab[],
  openTabsLoaded: true,
  openTabsFailed: false,
  machinesError: false,
  projectsError: false,
  machinesReadable: true,
  projectsReadable: true,
  reloadMonitor: vi.fn(async () => {}),
  groups: [] as ProjectGroup[],
  user: { id: 'u1', nickname: null as string | null },
  denied: new Set<string>(),
  refresh: vi.fn(async () => {}),
}));

vi.mock('../lib/auth', () => ({
  useAuth: () => ({
    user: state.user,
    can: (resource: string, action = 'read') => !state.denied.has(`${resource}:${action}`),
  }),
}));
vi.mock('../lib/data', () => ({
  useData: () => ({
    statuses: {},
    projects: state.projects,
    machines: state.machines,
    loading: state.loading,
    refresh: state.refresh,
    machinesError: state.machinesError,
    projectsError: state.projectsError,
    machinesReadable: state.machinesReadable,
    projectsReadable: state.projectsReadable,
  }),
}));
vi.mock('../lib/monitor', () => ({
  useMonitor: () => ({ openTabs: state.openTabs, openTabsLoaded: state.openTabsLoaded, openTabsFailed: state.openTabsFailed, reload: state.reloadMonitor }),
}));
vi.mock('../lib/project-groups', () => ({ useProjectGroups: () => ({ groups: state.groups }) }));
vi.mock('../lib/api', () => ({ api: { dashboard: () => new Promise(() => {}) } }));
vi.mock('../components/NeedsYouList', () => ({ NeedsYouList: () => null }));
vi.mock('../components/ProjectCards', () => ({ ProjectCards: () => null }));
// the real connection flow (create + enrollment) and project walkthrough, stubbed to what opened them
vi.mock('../components/MachineForm', () => ({
  MachineForm: ({ machine, onClose }: { machine?: Machine | null; onClose: () => void }) => (
    <div role="dialog" aria-label="machine-form">
      {machine ? `editar ${machine.name}` : 'nova máquina'}
      <button onClick={onClose}>fechar máquina</button>
    </div>
  ),
}));
vi.mock('../components/ProjectForm', () => ({
  ProjectForm: ({ onClose }: { onClose: () => void }) => (
    <div role="dialog" aria-label="project-form">
      <button onClick={onClose}>fechar projeto</button>
    </div>
  ),
}));

import { HomePage } from './HomePage';

const machine = (id: string, over: Partial<Machine> = {}) =>
  ({ id, name: `máquina ${id}`, type: 'agent', is_local: false, hooks_installed_at: '2026-09-01T00:00:00.000Z', ...over }) as Machine;
const project = (id: string, over: Partial<Project> = {}) =>
  ({ id, key: id.toUpperCase(), name: `Projeto ${id}`, status: 'active', machines: [], is_public: true, ...over }) as Project;
const tab = (id: string) => ({ id, project_id: 'p1', machine_id: 'm1', name: id, kind: 'terminal' }) as Tab;
const favorites = (project_ids: string[] = []): ProjectGroup => ({ id: 'fav', name: 'Favoritos', kind: 'favorites', position: 0, project_ids });

function ui() {
  return (
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route path="*" element={<HomePage />} />
      </Routes>
    </MemoryRouter>
  );
}
const mount = () => render(ui());

/** an account that went through every required step and every optional one */
function everythingDone() {
  state.machines = [machine('m1')];
  state.projects = [project('p1')];
  state.openTabs = [tab('t1')];
  state.groups = [favorites(['p1'])];
  state.user = { id: 'u1', nickname: 'pedro' };
}

beforeEach(() => {
  state.loading = false;
  state.machines = [];
  state.projects = [];
  state.openTabs = [];
  state.openTabsLoaded = true;
  state.openTabsFailed = false;
  state.machinesError = false;
  state.projectsError = false;
  state.machinesReadable = true;
  state.projectsReadable = true;
  state.reloadMonitor.mockClear();
  state.groups = [favorites()];
  state.user = { id: 'u1', nickname: null };
  state.denied = new Set();
  state.refresh.mockClear();
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('HomePage while loading', () => {
  it('shows the loading state and no step while the account data is loading', () => {
    state.loading = true;
    mount();
    expect(screen.getByText('Carregando…')).toBeInTheDocument();
    expect(screen.queryByText(/Passo \d de 3/)).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 2 })).not.toBeInTheDocument();
  });

  it('waits for the open tabs too, so step 3 never flashes before the terminals arrive', () => {
    state.machines = [machine('m1')];
    state.projects = [project('p1')];
    state.openTabsLoaded = false;
    mount();
    expect(screen.getByText('Carregando…')).toBeInTheDocument();
    expect(screen.queryByText(/Passo \d de 3/)).not.toBeInTheDocument();
  });
});

describe('HomePage step 1: no machine', () => {
  it('guides the connection of the first machine through the existing machine form', () => {
    mount();
    expect(screen.getAllByRole('heading', { level: 1 }).map((h) => h.textContent)).toEqual(['Início']);
    expect(screen.getByRole('heading', { level: 2, name: 'Conecte sua primeira máquina' })).toBeInTheDocument();
    expect(screen.getByText('Passo 1 de 3')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'O que estou fazendo' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Conectar máquina' }));
    expect(screen.getByRole('dialog', { name: 'machine-form' })).toHaveTextContent('nova máquina');
  });

  it('asks for an administrator when the user cannot create machines', () => {
    state.denied = new Set(['machines:create']);
    mount();
    expect(screen.getByText('Passo 1 de 3')).toBeInTheDocument();
    expect(screen.getByText('Peça a um administrador para conectar uma máquina à sua conta.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Conectar máquina' })).not.toBeInTheDocument();
  });

  it('advances by itself when a machine appears, keeping the enrollment open', () => {
    const { rerender } = mount();
    fireEvent.click(screen.getByRole('button', { name: 'Conectar máquina' }));
    state.machines = [machine('m1')]; // the form refreshes the data right after creating it
    rerender(ui());
    expect(screen.getByRole('heading', { level: 2, name: 'Crie seu primeiro projeto' })).toBeInTheDocument();
    expect(screen.getByText('Passo 2 de 3')).toBeInTheDocument();
    // the one-time token lives in that form: the step change must not close it
    expect(screen.getByRole('dialog', { name: 'machine-form' })).toBeInTheDocument();
  });

  it('re-reads the account while waiting, so a machine connected elsewhere shows up', () => {
    vi.useFakeTimers();
    mount();
    expect(state.refresh).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(15_000));
    expect(state.refresh).toHaveBeenCalledTimes(1);
  });
});

describe('HomePage step 2: machines, no project', () => {
  beforeEach(() => {
    state.machines = [machine('m1')];
  });

  it('opens the project walkthrough', () => {
    mount();
    expect(screen.getByRole('heading', { level: 2, name: 'Crie seu primeiro projeto' })).toBeInTheDocument();
    expect(screen.getByText('Passo 2 de 3')).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'project-form' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Criar projeto' }));
    expect(screen.getByRole('dialog', { name: 'project-form' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'fechar projeto' }));
    expect(screen.queryByRole('dialog', { name: 'project-form' })).not.toBeInTheDocument();
  });

  it('re-reads the account while waiting, so a project created elsewhere shows up', () => {
    vi.useFakeTimers();
    const { unmount } = mount();
    act(() => vi.advanceTimersByTime(15_000));
    expect(state.refresh).toHaveBeenCalledTimes(1);
    unmount();
    act(() => vi.advanceTimersByTime(30_000));
    expect(state.refresh).toHaveBeenCalledTimes(1);
  });

  it('explains instead of offering the button when the user cannot create projects', () => {
    state.denied = new Set(['projects:create']);
    mount();
    expect(screen.getByText('Passo 2 de 3')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Criar projeto' })).not.toBeInTheDocument();
    expect(screen.getByText(/Peça a um administrador para criar um projeto/)).toBeInTheDocument();
  });
});

describe('HomePage step 3: projects, no open terminal', () => {
  it('links up to three projects to their Terminais tab', () => {
    state.machines = [machine('m1')];
    state.projects = [project('p1'), project('p2'), project('p3'), project('p4')];
    mount();
    expect(screen.getByRole('heading', { level: 2, name: 'Abra seu primeiro terminal' })).toBeInTheDocument();
    expect(screen.getByText('Passo 3 de 3')).toBeInTheDocument();
    const links = within(screen.getByRole('list', { name: 'Projetos' })).getAllByRole('link');
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['/projects/p1', '/projects/p2', '/projects/p3']);
  });

  it('prefers projects that are not archived', () => {
    state.machines = [machine('m1')];
    state.projects = [project('old', { status: 'archived' }), project('p1')];
    mount();
    const links = within(screen.getByRole('list', { name: 'Projetos' })).getAllByRole('link');
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['/projects/p1']);
  });
});

describe('HomePage dashboard and next steps', () => {
  it('shows the dashboard with no step indicator and no card when nothing is missing', () => {
    everythingDone();
    mount();
    expect(screen.getByRole('heading', { level: 2, name: 'O que estou fazendo' })).toBeInTheDocument();
    expect(screen.queryByText(/Passo \d de 3/)).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Próximos passos' })).not.toBeInTheDocument();
  });

  it('lists the monitor hooks for an agent machine that lacks them, and opens that machine', () => {
    everythingDone();
    state.machines = [machine('m1'), machine('m2', { name: 'servidor', hooks_installed_at: null })];
    const { rerender } = mount();
    const card = screen.getByRole('region', { name: 'Próximos passos' });
    expect(within(card).getAllByRole('listitem')).toHaveLength(1);
    expect(card).toHaveTextContent('servidor');
    fireEvent.click(within(card).getByRole('button', { name: 'Instalar hooks' }));
    expect(screen.getByRole('dialog', { name: 'machine-form' })).toHaveTextContent('editar servidor');

    state.machines = [machine('m1'), machine('m2', { name: 'servidor' })];
    rerender(ui());
    expect(screen.queryByRole('region', { name: 'Próximos passos' })).not.toBeInTheDocument();
  });

  it('leaves the hooks out when the user cannot update machines, or the server does not say', () => {
    everythingDone();
    state.machines = [machine('m1', { hooks_installed_at: undefined })];
    const { rerender } = mount();
    expect(screen.queryByRole('region', { name: 'Próximos passos' })).not.toBeInTheDocument();

    state.machines = [machine('m1', { hooks_installed_at: null })];
    state.denied = new Set(['machines:update']);
    rerender(ui());
    expect(screen.queryByRole('region', { name: 'Próximos passos' })).not.toBeInTheDocument();
  });

  it('asks for the nickname and the city until one project is published', () => {
    everythingDone();
    state.user = { id: 'u1', nickname: null };
    const { rerender } = mount();
    const link = within(screen.getByRole('region', { name: 'Próximos passos' })).getByRole('link', { name: /apelido/ });
    expect(link).toHaveAttribute('href', '/settings/city');

    state.user = { id: 'u1', nickname: 'pedro' };
    state.projects = [project('p1', { is_public: false })];
    rerender(ui());
    expect(within(screen.getByRole('region', { name: 'Próximos passos' })).getByRole('link', { name: /Publique sua cidade/ })).toHaveAttribute('href', '/settings/city');

    state.projects = [project('p1', { is_public: true })];
    rerender(ui());
    expect(screen.queryByRole('region', { name: 'Próximos passos' })).not.toBeInTheDocument();
  });

  it('suggests pinning a project while Favoritos is empty', () => {
    everythingDone();
    state.groups = [favorites()];
    const { rerender } = mount();
    expect(screen.getByRole('region', { name: 'Próximos passos' })).toHaveTextContent(/Favoritos/);

    state.groups = [favorites(['p1'])];
    rerender(ui());
    expect(screen.queryByRole('region', { name: 'Próximos passos' })).not.toBeInTheDocument();
  });

  it('does not suggest Favoritos when the groups did not load', () => {
    everythingDone();
    state.groups = [];
    mount();
    expect(screen.queryByRole('region', { name: 'Próximos passos' })).not.toBeInTheDocument();
  });

  it('remembers "Dispensar" per user', () => {
    everythingDone();
    state.groups = [favorites()];
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Dispensar' }));
    expect(screen.queryByRole('region', { name: 'Próximos passos' })).not.toBeInTheDocument();

    cleanup();
    mount();
    expect(screen.queryByRole('region', { name: 'Próximos passos' })).not.toBeInTheDocument();

    cleanup();
    state.user = { id: 'u2', nickname: 'bia' };
    mount();
    expect(screen.getByRole('region', { name: 'Próximos passos' })).toBeInTheDocument();
  });

  it('still renders and dismisses when the storage throws', () => {
    everythingDone();
    state.groups = [favorites()];
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    mount();
    expect(screen.getByRole('region', { name: 'Próximos passos' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Dispensar' }));
    expect(screen.queryByRole('region', { name: 'Próximos passos' })).not.toBeInTheDocument();
  });
});

describe('HomePage when a list could not be read', () => {
  const notice = () => screen.queryByRole('status', { name: 'Aviso de carregamento' });

  it('never shows step 1 from a machine list it could not read', () => {
    state.machinesError = true;
    state.projects = [project('p1')];
    mount();
    expect(screen.queryByText(/Passo \d de 3/)).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'O que estou fazendo' })).toBeInTheDocument();
    expect(notice()).toBeInTheDocument();
  });

  it('never shows step 2 from a project list it could not read', () => {
    state.machines = [machine('m1')];
    state.projectsError = true;
    mount();
    expect(screen.queryByText(/Passo \d de 3/)).not.toBeInTheDocument();
    expect(notice()).toBeInTheDocument();
  });

  it('never shows step 3 when no open-tabs read succeeded', () => {
    state.machines = [machine('m1')];
    state.projects = [project('p1')];
    state.openTabsLoaded = false;
    state.openTabsFailed = true;
    mount();
    expect(screen.queryByText(/Passo \d de 3/)).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'O que estou fazendo' })).toBeInTheDocument();
    expect(notice()).toBeInTheDocument();
  });

  it('retries every list from the notice', () => {
    state.machinesError = true;
    mount();
    fireEvent.click(within(notice()!).getByRole('button', { name: 'Tentar de novo' }));
    expect(state.refresh).toHaveBeenCalledTimes(1);
    expect(state.reloadMonitor).toHaveBeenCalledTimes(1);
  });

  it('shows no notice when every list was read', () => {
    everythingDone();
    mount();
    expect(notice()).not.toBeInTheDocument();
  });
});

describe('HomePage next-step links', () => {
  it('look like links: the city item ends with an arrow', () => {
    everythingDone();
    state.user = { id: 'u1', nickname: null };
    mount();
    const link = within(screen.getByRole('region', { name: 'Próximos passos' })).getByRole('link', { name: /apelido/ });
    expect(link).toHaveTextContent('→');
    expect(link.className).toMatch(/text-accent/);
  });
});

describe('HomePage for a role that cannot read a list', () => {
  const notice = () => screen.queryByRole('status', { name: 'Aviso de carregamento' });

  it('without machines:read, skips step 1 and shows no failure notice', () => {
    state.machinesReadable = false;
    mount();
    expect(screen.queryByText('Passo 1 de 3')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'Crie seu primeiro projeto' })).toBeInTheDocument();
    expect(notice()).not.toBeInTheDocument();
  });

  it('without machines:read, still guides to the first terminal', () => {
    state.machinesReadable = false;
    state.projects = [project('p1')];
    mount();
    expect(screen.getByText('Passo 3 de 3')).toBeInTheDocument();
    expect(notice()).not.toBeInTheDocument();
  });

  it('without projects:read, shows the dashboard with no step and no failure notice', () => {
    state.machines = [machine('m1')];
    state.projectsReadable = false;
    mount();
    expect(screen.queryByText(/Passo \d de 3/)).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'O que estou fazendo' })).toBeInTheDocument();
    expect(notice()).not.toBeInTheDocument();
  });

  it('with neither list readable, shows the dashboard and no notice', () => {
    state.machinesReadable = false;
    state.projectsReadable = false;
    mount();
    expect(screen.queryByText(/Passo \d de 3/)).not.toBeInTheDocument();
    expect(notice()).not.toBeInTheDocument();
  });
});
