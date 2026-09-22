// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import type { DashboardItem, Machine, Task } from '../lib/types';
import { ProjectCards } from './ProjectCards';

afterEach(cleanup);

const machine = (id: string, name: string) => ({ id, name, type: 'agent', capabilities: [], owner_id: 'u1' }) as unknown as Machine;
const item = (id: string, name: string, machines: Machine[], doing = 0, open = 0): DashboardItem => ({
  project: { id, key: id.toUpperCase(), owner_id: 'u1', next_task_number: 1, name, status: 'active', description: null, last_terminal_at: null, created_at: '2026-01-01T00:00:00Z', machines: machines.map((m, i) => ({ machine_id: m.id, cwd: `/p/${name}`, position: i })) },
  machines,
  doing: Array.from({ length: doing }, (_, n) => ({ id: `${id}-t${n}`, project_id: id, title: `task ${n}` }) as Task),
  open_tasks: open,
});

describe('ProjectCards', () => {
  it('renders one card per project with its key, machines and tasks in progress', () => {
    const mini = machine('m1', 'mac mini');
    const jarvis = machine('m2', 'jarvis');
    render(
      <MemoryRouter>
        <ProjectCards items={[item('p1', 'hub', [mini, jarvis], 2, 5), item('p2', 'solo', [], 0, 0)]} statuses={{ m1: 'online', m2: 'offline' }} />
      </MemoryRouter>,
    );
    expect(screen.getByText('P1')).toBeInTheDocument();
    expect(screen.getByText('mac mini')).toBeInTheDocument();
    expect(screen.getByText('jarvis')).toBeInTheDocument();
    expect(screen.getByText('task 0')).toBeInTheDocument();
    expect(screen.getByText('5 abertas →')).toBeInTheDocument();
    expect(screen.getByText('sem máquina')).toBeInTheDocument();
  });
});
