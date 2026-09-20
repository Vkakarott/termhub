// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import type { DashboardItem, Machine, Task } from '../lib/types';
import type { MachineStatus } from '../lib/data';
import { ProjectsByMachine, groupByMachine } from './ProjectsByMachine';

afterEach(() => {
  cleanup();
  localStorage.clear();
});

function machine(id: string, name: string): Machine {
  return {
    id,
    name,
    host: null,
    ssh_user: null,
    ssh_port: 22,
    type: 'agent',
    os: 'macos',
    capabilities: ['tmux'],
    checked_at: null,
    agent_version: '0.1.0',
    agent_last_seen_at: null,
    agent_auto_update: false,
    is_local: false,
    owner_id: 'u1',
    owner_name: null,
    created_at: '2026-01-01T00:00:00Z',
  };
}

function item(id: string, name: string, m: Machine | null, doing = 0, open = 0): DashboardItem {
  return {
    project: { id, machine_id: m?.id ?? '', name, cwd: `/p/${name}`, status: 'active', description: null, last_terminal_at: null, created_at: '2026-01-01T00:00:00Z' },
    machine: m,
    doing: Array.from({ length: doing }, (_, n) => ({ id: `${id}-t${n}`, project_id: id, title: `task ${n}` }) as Task),
    open_tasks: open,
  };
}

const mini = machine('m-mini', 'mac mini');
const jarvis = machine('m-jarvis', 'jarvis');
const m3 = machine('m-m3', 'macbook m3');

function renderList(items: DashboardItem[], statuses: Record<string, MachineStatus> = {}) {
  return render(
    <MemoryRouter>
      <ProjectsByMachine items={items} statuses={statuses} />
    </MemoryRouter>,
  );
}

describe('groupByMachine', () => {
  it('puts each project under its machine, keeping the incoming order', () => {
    const groups = groupByMachine([item('a', 'alpha', mini), item('b', 'beta', jarvis), item('c', 'gamma', mini)], {});
    const byName = Object.fromEntries(groups.map((g) => [g.machine?.name, g.items.map((i) => i.project.name)]));
    expect(byName).toEqual({ 'mac mini': ['alpha', 'gamma'], jarvis: ['beta'] });
  });

  it('lists online machines first, then by name', () => {
    const groups = groupByMachine([item('a', 'alpha', mini), item('b', 'beta', jarvis), item('c', 'gamma', m3)], { 'm-mini': 'offline', 'm-jarvis': 'offline', 'm-m3': 'online' });
    expect(groups.map((g) => g.machine?.name)).toEqual(['macbook m3', 'jarvis', 'mac mini']);
  });

  it('collects projects without a machine in a last group', () => {
    const groups = groupByMachine([item('x', 'orphan', null), item('a', 'alpha', mini)], {});
    expect(groups.map((g) => g.machine?.name ?? null)).toEqual(['mac mini', null]);
  });
});

describe('ProjectsByMachine', () => {
  it('shows one section per machine with its counts, open by default', () => {
    renderList([item('a', 'alpha', mini, 2, 3), item('c', 'gamma', mini, 0, 1), item('b', 'beta', jarvis)]);
    const header = screen.getByRole('button', { name: /mac mini/ });
    expect(header.getAttribute('aria-expanded')).toBe('true');
    expect(header.textContent).toContain('2 projetos · 2 em andamento · 4 abertas');
    expect(screen.getByRole('button', { name: /jarvis/ }).textContent).toContain('1 projeto · 0 em andamento · 0 abertas');
    expect(screen.getByRole('link', { name: 'alpha' })).toBeTruthy();
  });

  it('hides a machine\'s projects when its header is clicked, leaving the others', () => {
    renderList([item('a', 'alpha', mini), item('b', 'beta', jarvis)]);
    fireEvent.click(screen.getByRole('button', { name: /mac mini/ }));
    expect(screen.getByRole('button', { name: /mac mini/ }).getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('link', { name: 'alpha' })).toBeNull();
    expect(screen.getByRole('link', { name: 'beta' })).toBeTruthy();
  });

  it('remembers collapsed machines across mounts', () => {
    const items = [item('a', 'alpha', mini), item('b', 'beta', jarvis)];
    const first = renderList(items);
    fireEvent.click(screen.getByRole('button', { name: /mac mini/ }));
    first.unmount();
    renderList(items);
    expect(screen.queryByRole('link', { name: 'alpha' })).toBeNull();
    expect(screen.getByRole('link', { name: 'beta' })).toBeTruthy();
  });

  it('labels the group of projects without a machine', () => {
    renderList([item('x', 'orphan', null)]);
    const section = screen.getByRole('button', { name: /sem máquina/ }).closest('li') as HTMLElement;
    expect(within(section).getByRole('link', { name: 'orphan' })).toBeTruthy();
  });
});
