// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Machine, Project, Task, TaskColumn } from '../lib/types';

const listMock = vi.fn();
const openTerminalMock = vi.fn();
const createMock = vi.fn();
const moveMock = vi.fn();
vi.mock('../lib/api', () => {
  class ApiError extends Error {}
  return {
    ApiError,
    api: {
      tasks: {
        list: (...a: unknown[]) => listMock(...a),
        openTerminal: (...a: unknown[]) => openTerminalMock(...a),
        create: (...a: unknown[]) => createMock(...a),
        move: (...a: unknown[]) => moveMock(...a),
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
  project_id: 'p1', type: 'task', number: 2, ref: `P1-${over.id}`, title: over.id, description: null, status: 'todo', position: 0,
  external_ref: null, external_key: null, tab_id: null, parent_id: null, epic_id: 'e1', column_id: 'c1', created_at: '', updated_at: '', ...over,
});
const epic = (id: string, title: string, number: number) => task({ id, title, number, ref: `P1-${number}`, type: 'epic', epic_id: null, column_id: null, status: 'backlog' });
const col = (id: string, name: string, category: TaskColumn['category'], position: number): TaskColumn => ({ id, project_id: 'p1', name, category, position, created_at: '' });
const columns = [col('c3', 'Feito', 'done', 2), col('c1', 'A fazer', 'todo', 0), col('c2', 'Em revisão', 'doing', 1)];
const board = (tasks: Task[]) => ({ tasks, columns, agent_column_id: null });

function LocationProbe() {
  const l = useLocation();
  return <output data-testid="location">{`${l.pathname}|${(l.state as { from?: string } | null)?.from ?? ''}`}</output>;
}

type Entry = string | { pathname: string; state: unknown };

function mount(openTaskId?: string, entry: Entry = '/projects/p1/tasks') {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <TasksBoard projectId="p1" openTaskId={openTaskId} />
      <LocationProbe />
    </MemoryRouter>,
  );
}

/** With the card's editor open (its URL), clicks "Abrir terminal para esta task". */
async function requestTerminal() {
  fireEvent.click(await screen.findByRole('button', { name: /Abrir terminal para esta task/ }));
}

beforeEach(() => {
  localStorage.clear();
  project = { id: 'p1', key: 'P1', name: 'p1', machines: [{ machine_id: 'm1', cwd: '/a', position: 0 }] } as Project;
  listMock.mockResolvedValue(board([epic('e1', 'Geral', 1), task({ id: 't1' })]));
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('TasksBoard — columns, cards and filter', () => {
  it('renders one column per project column, in order, with each card\'s ref and epic', async () => {
    listMock.mockResolvedValue(board([epic('e1', 'Geral', 1), task({ id: 'a' }), task({ id: 'r', column_id: 'c2', status: 'doing' })]));
    mount();
    await screen.findByText('a');
    expect(screen.getAllByRole('region').map((r) => r.getAttribute('aria-label'))).toEqual(['A fazer', 'Em revisão', 'Feito']);
    expect(within(screen.getByRole('region', { name: 'Em revisão' })).getByText('r')).toBeInTheDocument();
    expect(screen.getByText('P1-a')).toBeInTheDocument();
    expect(screen.getAllByText('Geral')).toHaveLength(2);
    expect(within(screen.getByRole('region', { name: 'A fazer' })).getByRole('img', { name: 'Tarefa' })).toBeInTheDocument();
  });

  it('hides epics by default; the Épico chip shows them and is remembered', async () => {
    listMock.mockResolvedValue(board([epic('e1', 'Geral', 1), task({ id: 'epic on board', type: 'epic', epic_id: null, number: 3 }), task({ id: 'a' })]));
    mount();
    await screen.findByText('a');
    expect(screen.queryByText('epic on board')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Épico' }));
    expect(screen.getByText('epic on board')).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem('termhub:board-filter:p1')!).types).toContain('epic');
  });

  it('filters by epic', async () => {
    listMock.mockResolvedValue(board([epic('e1', 'Geral', 1), epic('e2', 'Checkout', 4), task({ id: 'a' }), task({ id: 'b', epic_id: 'e2' })]));
    mount();
    await screen.findByText('a');
    fireEvent.change(screen.getByLabelText('Filtrar por épico'), { target: { value: 'e2' } });
    expect(screen.queryByText('a')).not.toBeInTheDocument();
    expect(screen.getByText('b')).toBeInTheDocument();
  });

  it('quick add creates a card in that column', async () => {
    createMock.mockResolvedValue({ task: task({ id: 'nova', column_id: 'c2', status: 'doing' }) });
    mount();
    await screen.findByText('t1');
    const input = within(screen.getByRole('region', { name: 'Em revisão' })).getByPlaceholderText('+ novo card (Enter)');
    fireEvent.change(input, { target: { value: 'nova' } });
    fireEvent.submit(input.closest('form')!);
    await waitFor(() => expect(createMock).toHaveBeenCalledWith('p1', { title: 'nova', column_id: 'c2' }));
    expect(await within(screen.getByRole('region', { name: 'Em revisão' })).findByText('nova')).toBeInTheDocument();
  });

  it('the → button moves a card to the next column', async () => {
    moveMock.mockResolvedValue({ task: task({ id: 't1', column_id: 'c2', status: 'doing' }) });
    mount();
    await screen.findByText('t1');
    fireEvent.click(screen.getByTitle('Mover para Em revisão'));
    await waitFor(() => expect(moveMock).toHaveBeenCalledWith('t1', { column_id: 'c2' }, 0));
    expect(within(screen.getByRole('region', { name: 'Em revisão' })).getByText('t1')).toBeInTheDocument();
  });
});

describe('TasksBoard — choosing a machine to open a task terminal', () => {
  it('opens directly on the only linked machine, without a picker', async () => {
    openTerminalMock.mockResolvedValue({ task: task({ id: 't1', tab_id: 'tab1' }), tab: { id: 'tab1' }, created: true });
    mount('t1');
    await requestTerminal();
    await waitFor(() => expect(openTerminalMock).toHaveBeenCalledWith('t1', 'm1'));
    expect(screen.queryByText('Abrir em qual máquina?')).not.toBeInTheDocument();
  });

  it('shows a picker with several machines when none was used before, and remembers the pick', async () => {
    project = { id: 'p1', key: 'P1', name: 'p1', machines: [{ machine_id: 'm1', cwd: '/a', position: 0 }, { machine_id: 'm2', cwd: '/b', position: 1 }] } as Project;
    openTerminalMock.mockResolvedValue({ task: task({ id: 't1', tab_id: 'tab1' }), tab: { id: 'tab1' }, created: true });
    mount('t1');
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
    mount('t1');
    await requestTerminal();
    await waitFor(() => expect(openTerminalMock).toHaveBeenCalledWith('t1', 'm2'));
    expect(screen.queryByText('Abrir em qual máquina?')).not.toBeInTheDocument();
  });

  it('shows the no-machine error and never calls the API when the project has no linked machine', async () => {
    project = { id: 'p1', key: 'P1', name: 'p1', machines: [] } as unknown as Project;
    mount('t1');
    await requestTerminal();
    expect(await screen.findByText('Vincule uma máquina ao projeto em Setup → Máquinas para abrir terminais.')).toBeInTheDocument();
    expect(openTerminalMock).not.toHaveBeenCalled();
  });
});

describe('TasksBoard — card URLs', () => {
  it('opening a card goes to /project/<ref>, remembering the section', async () => {
    mount();
    await screen.findByText('t1');
    fireEvent.click(screen.getByTitle('Abrir card'));
    expect(screen.getByTestId('location').textContent).toBe('/project/P1-t1|/projects/p1/tasks');
  });

  it('shows the editor of the card in the URL; closing goes back to the section it came from', async () => {
    mount('t1', { pathname: '/project/P1-t1', state: { from: '/projects/p1/backlog' } });
    expect(await screen.findByRole('heading', { name: 'P1-t1' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Fechar' }));
    expect(screen.getByTestId('location').textContent).toBe('/projects/p1/backlog|');
  });

  it('closing a card opened from a pasted link goes to the board', async () => {
    mount('t1', '/project/P1-t1');
    fireEvent.click(await screen.findByRole('button', { name: 'Fechar' }));
    expect(screen.getByTestId('location').textContent).toBe('/projects/p1/tasks|');
  });
});
