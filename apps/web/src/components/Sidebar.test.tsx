// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Machine } from '../lib/types';

let canChat = true;
vi.mock('../lib/auth', () => ({
  useAuth: () => ({
    user: { id: 'u1', name: 'Pedro', avatar_url: null, email: 'pedro@example.com' },
    logout: vi.fn(),
    can: (resource: string) => (resource === 'chat' ? canChat : true),
    viewAs: 'self',
  }),
}));

const chat = vi.hoisted(() => ({ toggle: vi.fn(), status: vi.fn(() => ({ busy: false, pending: 0 })) }));
vi.mock('../lib/project-chat', () => ({ useProjectChat: () => ({ openProjectId: null, close: vi.fn(), ...chat }) }));
vi.mock('../lib/monitor', () => ({ useMonitor: () => ({ items: [], needsYou: [] }) }));
vi.mock('../lib/data', () => {
  const machines = [
    { id: 'm1', name: 'mac', type: 'agent', capabilities: [], is_local: false, os: null, owner_name: null, hooks_installed_at: new Date().toISOString() },
    { id: 'm2', name: 'jarvis', type: 'agent', capabilities: [], is_local: false, os: null, owner_name: null, hooks_installed_at: new Date().toISOString() },
  ];
  const projects = [
    { id: 'p1', key: 'ALPHA', name: 'alpha', status: 'active', machines: [{ machine_id: 'm1', cwd: '/a', position: 0 }, { machine_id: 'm2', cwd: '/a', position: 1 }] },
    { id: 'p2', key: 'BETA', name: 'beta', status: 'active', machines: [] },
  ];
  return {
    useData: () => ({
      machines,
      projects,
      hiddenLocal: [],
      claimLocal: vi.fn(),
      statuses: {},
      missingTmux: {},
      loading: false,
      deleteMachine: vi.fn(),
      deleteProject: vi.fn(),
      checkStatus: vi.fn(),
      machinesOf: (p: { machines: { machine_id: string }[] }) => p.machines.map((l) => machines.find((m) => m.id === l.machine_id)).filter(Boolean),
    }),
  };
});

import { Sidebar, agentVersionBadge, machineTitle } from './Sidebar';

function agentMachine(overrides: Partial<Machine> = {}): Machine {
  return {
    id: 'm1',
    name: 'mini',
    host: null,
    ssh_user: null,
    ssh_port: 22,
    type: 'agent',
    os: 'macos',
    capabilities: ['tmux'],
    checked_at: null,
    agent_version: '0.1.0',
    agent_last_seen_at: new Date(Date.now() - 3 * 60_000).toISOString(),
    agent_auto_update: false,
    is_local: false,
    owner_id: 'u1',
    owner_name: null,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

describe('machineTitle', () => {
  it('says "visto há N min" once for an offline agent (relativeTime already carries the "há")', () => {
    const title = machineTitle(agentMachine(), 'offline');
    expect(title).toBe('agente · macos · tmux · visto há 3 min');
    expect(title).not.toContain('há há');
  });

  it('omits the last-seen part while the agent is online', () => {
    expect(machineTitle(agentMachine(), 'online')).toBe('agente · macos · tmux');
  });

  it('names the user\'s own computer', () => {
    expect(machineTitle(agentMachine({ is_local: true }), 'online')).toBe('este computador (agente) · macos · tmux');
  });

  it('describes ssh machines by user@host:port', () => {
    const m = agentMachine({ type: 'ssh', host: 'box', ssh_user: 'pedro', ssh_port: 2222, os: null, capabilities: [] });
    expect(machineTitle(m, 'online')).toBe('pedro@box:2222');
  });
});

describe('agentVersionBadge', () => {
  it('shows the version, and marks it when a newer agent is available', () => {
    expect(agentVersionBadge(agentMachine({ agent_version: '0.2.1' }))).toEqual({ text: 'v0.2.1', title: 'agente v0.2.1', outdated: false });
    expect(agentVersionBadge(agentMachine({ agent_version: '0.2.1', update_available: true }))).toEqual({ text: 'v0.2.1 ↑', title: 'Nova versão do agente disponível — abra a máquina para atualizar', outdated: true });
  });
  it('is null without a reported version or for non-agent machines', () => {
    expect(agentVersionBadge(agentMachine({ agent_version: null }))).toBeNull();
    expect(agentVersionBadge(agentMachine({ type: 'ssh', host: 'h' }))).toBeNull();
  });
});

const PROJECT_NAME = 'alpha';
const PROJECT_ID = 'p1';

function renderSidebar() {
  return render(
    <MemoryRouter>
      <Sidebar />
    </MemoryRouter>,
  );
}

describe('Sidebar', () => {
  afterEach(() => {
    cleanup();
    canChat = true;
    chat.toggle.mockClear();
    chat.status.mockReset().mockReturnValue({ busy: false, pending: 0 });
  });

  it('lists projects with their machines nested, and no top-level machine list', () => {
    renderSidebar();
    expect(screen.getByText('alpha')).toBeInTheDocument();
    expect(screen.getAllByText('mac')).toHaveLength(1);
    expect(screen.getAllByText('jarvis')).toHaveLength(1);
    expect(screen.getByText(/sem máquina/)).toBeInTheDocument();
  });

  it('has a "Máquinas" nav link to /machines and a single "Novo projeto" add button', () => {
    renderSidebar();
    const machinesLink = screen.getByRole('link', { name: /Máquinas/ });
    expect(machinesLink).toHaveAttribute('href', '/machines');
    expect(screen.getByTitle('Novo projeto')).toBeInTheDocument();
    expect(screen.queryByText('+ máquina')).not.toBeInTheDocument();
  });

  it('a project row has chat and edit, and no delete', () => {
    renderSidebar();
    const row = screen.getByText(PROJECT_NAME).closest('li')!;
    expect(within(row).getByRole('button', { name: 'Chat do projeto' })).toBeTruthy();
    expect(within(row).getByTitle('Editar projeto')).toBeTruthy();
    expect(within(row).queryByTitle(/Excluir projeto/)).toBeNull();
  });

  it('💬 toggles that project chat', () => {
    renderSidebar();
    fireEvent.click(within(screen.getByText(PROJECT_NAME).closest('li')!).getByRole('button', { name: 'Chat do projeto' }));
    expect(chat.toggle).toHaveBeenCalledWith(PROJECT_ID);
  });

  it('shows the 💬 without hover, with a dot, while that chat is answering or waiting', () => {
    chat.status.mockReturnValue({ busy: false, pending: 1 });
    renderSidebar();
    const button = within(screen.getByText(PROJECT_NAME).closest('li')!).getByRole('button', { name: 'Chat do projeto' });
    expect(button.getAttribute('data-active')).toBe('true');
  });

  it('no chat button without the chat permission', () => {
    canChat = false;
    renderSidebar();
    expect(screen.queryByRole('button', { name: 'Chat do projeto' })).toBeNull();
  });
});
