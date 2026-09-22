// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Machine, Project, Task } from '../lib/types';

const listMock = vi.fn();
const openTerminalMock = vi.fn();
vi.mock('../lib/api', () => {
  class ApiError extends Error {}
  return {
    ApiError,
    api: {
      tasks: {
        list: (...a: unknown[]) => listMock(...a),
        openTerminal: (...a: unknown[]) => openTerminalMock(...a),
      },
    },
  };
});

const machines = [{ id: 'm1', name: 'mac', capabilities: [] }, { id: 'm2', name: 'jarvis', capabilities: [] }] as Machine[];
let project: Project;
vi.mock('../lib/data', () => ({
  useData: () => ({
    projects: [project],
    machinesOf: (p: Project) => p.machines.map((l) => machines.find((m) => m.id === l.machine_id)!),
    setOpenTasks: () => {},
  }),
}));

import { TasksBoard } from './TasksBoard';

const task = (over: Partial<Task> & { id: string }): Task => ({
  project_id: 'p1', title: over.id, description: null, status: 'backlog', position: 0, external_ref: null, external_key: null,
  tab_id: null, parent_id: null, created_at: '', updated_at: '', ...over,
});

function mount() {
  return render(
    <MemoryRouter>
      <TasksBoard projectId="p1" />
    </MemoryRouter>,
  );
}

/** Opens the task editor and clicks "Abrir terminal para esta task". */
async function requestTerminal(taskTitle = 't1') {
  await screen.findByText(taskTitle);
  fireEvent.click(screen.getByTitle('Detalhes (descrição, status, excluir)'));
  fireEvent.click(await screen.findByRole('button', { name: /Abrir terminal para esta task/ }));
}

beforeEach(() => {
  localStorage.clear();
  listMock.mockResolvedValue({ tasks: [task({ id: 't1' })] });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('TasksBoard — choosing a machine to open a task terminal', () => {
  it('opens directly on the only linked machine, without a picker', async () => {
    project = { id: 'p1', key: 'P1', name: 'p1', machines: [{ machine_id: 'm1', cwd: '/a', position: 0 }] } as Project;
    openTerminalMock.mockResolvedValue({ task: task({ id: 't1', tab_id: 'tab1' }), tab: { id: 'tab1' }, created: true });
    mount();
    await requestTerminal();
    await waitFor(() => expect(openTerminalMock).toHaveBeenCalledWith('t1', 'm1'));
    expect(screen.queryByText('Abrir em qual máquina?')).not.toBeInTheDocument();
  });

  it('shows a picker with several machines when none was used before, and remembers the pick', async () => {
    project = { id: 'p1', key: 'P1', name: 'p1', machines: [{ machine_id: 'm1', cwd: '/a', position: 0 }, { machine_id: 'm2', cwd: '/b', position: 1 }] } as Project;
    openTerminalMock.mockResolvedValue({ task: task({ id: 't1', tab_id: 'tab1' }), tab: { id: 'tab1' }, created: true });
    mount();
    await requestTerminal();
    expect(await screen.findByText('Abrir em qual máquina?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /jarvis/ }));
    await waitFor(() => expect(openTerminalMock).toHaveBeenCalledWith('t1', 'm2'));
    expect(localStorage.getItem('termhub:last-machine:p1')).toBe('m2');
  });

  it('skips the picker and reuses the last machine when it is still linked', async () => {
    localStorage.setItem('termhub:last-machine:p1', 'm2');
    project = { id: 'p1', key: 'P1', name: 'p1', machines: [{ machine_id: 'm1', cwd: '/a', position: 0 }, { machine_id: 'm2', cwd: '/b', position: 1 }] } as Project;
    openTerminalMock.mockResolvedValue({ task: task({ id: 't1', tab_id: 'tab1' }), tab: { id: 'tab1' }, created: true });
    mount();
    await requestTerminal();
    await waitFor(() => expect(openTerminalMock).toHaveBeenCalledWith('t1', 'm2'));
    expect(screen.queryByText('Abrir em qual máquina?')).not.toBeInTheDocument();
  });

  it('shows the no-machine error and never calls the API when the project has no linked machine', async () => {
    project = { id: 'p1', key: 'P1', name: 'p1', machines: [] } as unknown as Project;
    mount();
    await requestTerminal();
    expect(await screen.findByText('Vincule uma máquina ao projeto em Setup → Máquinas para abrir terminais.')).toBeInTheDocument();
    expect(openTerminalMock).not.toHaveBeenCalled();
  });
});
