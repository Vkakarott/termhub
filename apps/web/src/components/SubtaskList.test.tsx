// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SubtaskList } from './SubtaskList';
import type { Task } from '../lib/types';

const updateMock = vi.fn();
const addMock = vi.fn();
const removeMock = vi.fn();
const reorderMock = vi.fn();

vi.mock('../lib/api', () => {
  class ApiError extends Error {}
  return {
    ApiError,
    api: {
      tasks: {
        update: (...a: unknown[]) => updateMock(...a),
        addSubtasks: (...a: unknown[]) => addMock(...a),
        remove: (...a: unknown[]) => removeMock(...a),
        reorder: (...a: unknown[]) => reorderMock(...a),
      },
    },
  };
});

const task = (over: Partial<Task> & { id: string }): Task => ({
  project_id: 'p1',
  title: over.id,
  description: null,
  status: 'todo',
  position: 0,
  external_ref: null,
  external_key: null,
  tab_id: null,
  parent_id: null,
  created_at: '2026-09-18T00:00:00.000Z',
  updated_at: '2026-09-18T00:00:00.000Z',
  ...over,
});

const parentWith = (subtasks?: Task[]): Task => ({ ...task({ id: 'parent' }), subtasks });

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('SubtaskList', () => {
  it('renders without subtasks when the server sent none', () => {
    render(<SubtaskList parent={parentWith(undefined)} onChange={vi.fn()} onError={vi.fn()} />);
    expect(screen.getByPlaceholderText('Adicionar subtarefa (Enter)')).toBeTruthy();
    expect(screen.queryByText(/concluídas/)).toBeNull();
  });

  it('shows progress and orders by position', () => {
    const subs = [task({ id: 'b', parent_id: 'parent', position: 1 }), task({ id: 'a', parent_id: 'parent', position: 0, status: 'done' })];
    render(<SubtaskList parent={parentWith(subs)} onChange={vi.fn()} onError={vi.fn()} />);
    expect(screen.getByText('1 de 2 concluídas')).toBeTruthy();
    expect(screen.getAllByRole('checkbox').map((c) => c.getAttribute('aria-label'))).toEqual(['a', 'b']);
  });

  it('toggles todo → done optimistically and persists', async () => {
    updateMock.mockResolvedValue({ task: {} });
    const onChange = vi.fn();
    render(<SubtaskList parent={parentWith([task({ id: 'a', parent_id: 'parent' })])} onChange={onChange} onError={vi.fn()} />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'a' }));
    expect(onChange.mock.calls[0][0][0].status).toBe('done');
    await waitFor(() => expect(updateMock).toHaveBeenCalledWith('a', { status: 'done' }));
  });

  it('marks a subtask an agent left in "doing", and checking it off completes it', () => {
    updateMock.mockResolvedValue({ task: {} });
    const onChange = vi.fn();
    render(<SubtaskList parent={parentWith([task({ id: 'a', parent_id: 'parent', status: 'doing' })])} onChange={onChange} onError={vi.fn()} />);
    expect(screen.getByText('em andamento')).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox', { name: 'a' }));
    expect(onChange.mock.calls[0][0][0].status).toBe('done');
  });

  it('reports a failed save without writing a stale snapshot', async () => {
    updateMock.mockRejectedValue(new Error('boom'));
    const onChange = vi.fn();
    const onError = vi.fn();
    const subs = [task({ id: 'a', parent_id: 'parent' })];
    render(<SubtaskList parent={parentWith(subs)} onChange={onChange} onError={onError} />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'a' }));
    await waitFor(() => expect(onError).toHaveBeenCalledWith('Erro ao salvar subtarefa'));
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('adds a subtask with Enter and ignores a blank title', async () => {
    addMock.mockResolvedValue({ subtasks: [task({ id: 'n', title: 'nova', parent_id: 'parent' })] });
    const onChange = vi.fn();
    render(<SubtaskList parent={parentWith([])} onChange={onChange} onError={vi.fn()} />);
    const input = screen.getByPlaceholderText('Adicionar subtarefa (Enter)');
    fireEvent.submit(input.closest('form')!);
    expect(addMock).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: '  nova  ' } });
    fireEvent.submit(input.closest('form')!);
    await waitFor(() => expect(addMock).toHaveBeenCalledWith('parent', [{ title: 'nova' }]));
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    // `add` reports an updater (see the next test for why); apply it to the current (empty) list.
    const updater = onChange.mock.calls.at(-1)![0];
    const result = typeof updater === 'function' ? updater([]) : updater;
    expect(result.map((s: Task) => s.id)).toEqual(['n']);
  });

  it('add applies to whatever list exists when the response lands, not the one at submit time', async () => {
    updateMock.mockResolvedValue({ task: {} });
    let resolveAdd: (v: { subtasks: Task[] }) => void = () => {};
    addMock.mockImplementation(() => new Promise<{ subtasks: Task[] }>((resolve) => (resolveAdd = resolve)));
    const onChange = vi.fn();
    const subs = [task({ id: 'a', parent_id: 'parent' })];
    render(<SubtaskList parent={parentWith(subs)} onChange={onChange} onError={vi.fn()} />);
    const input = screen.getByPlaceholderText('Adicionar subtarefa (Enter)');
    fireEvent.change(input, { target: { value: 'nova' } });
    fireEvent.submit(input.closest('form')!);
    await waitFor(() => expect(addMock).toHaveBeenCalled());

    // A toggle lands (and its own onChange fires) while the add round trip is still pending.
    fireEvent.click(screen.getByRole('checkbox', { name: 'a' }));
    const toggledList = onChange.mock.calls.at(-1)![0];
    expect(Array.isArray(toggledList)).toBe(true);
    expect(toggledList[0].status).toBe('done');

    resolveAdd({ subtasks: [task({ id: 'n', title: 'nova', parent_id: 'parent' })] });
    await waitFor(() => expect(typeof onChange.mock.calls.at(-1)![0]).toBe('function'));
    const updater = onChange.mock.calls.at(-1)![0] as (prev: Task[]) => Task[];
    // Applying the updater to the list that already carries the toggle: both survive.
    const result = updater(toggledList);
    expect(result.map((s: Task) => [s.id, s.status])).toEqual([
      ['a', 'done'],
      ['n', 'todo'],
    ]);
  });

  it('removes a subtask and reindexes the rest', async () => {
    removeMock.mockResolvedValue({ ok: true, deleted_subtasks: 0 });
    const onChange = vi.fn();
    const subs = [task({ id: 'a', parent_id: 'parent', position: 0 }), task({ id: 'b', parent_id: 'parent', position: 1 })];
    render(<SubtaskList parent={parentWith(subs)} onChange={onChange} onError={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Excluir subtarefa a' }));
    expect(onChange.mock.calls[0][0]).toMatchObject([{ id: 'b', position: 0 }]);
    await waitFor(() => expect(removeMock).toHaveBeenCalledWith('a'));
  });

  it('renames a subtask on Enter and persists', async () => {
    updateMock.mockResolvedValue({ task: {} });
    const onChange = vi.fn();
    const subs = [task({ id: 'a', parent_id: 'parent' })];
    render(<SubtaskList parent={parentWith(subs)} onChange={onChange} onError={vi.fn()} />);
    fireEvent.click(screen.getByText('a'));
    const input = screen.getByDisplayValue('a');
    fireEvent.change(input, { target: { value: '  renomeada  ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange.mock.calls.at(-1)![0][0].title).toBe('renomeada');
    await waitFor(() => expect(updateMock).toHaveBeenCalledWith('a', { title: 'renomeada' }));
  });

  it('cancels a rename on Escape without saving', () => {
    const onChange = vi.fn();
    const subs = [task({ id: 'a', parent_id: 'parent' })];
    render(<SubtaskList parent={parentWith(subs)} onChange={onChange} onError={vi.fn()} />);
    fireEvent.click(screen.getByText('a'));
    const input = screen.getByDisplayValue('a');
    fireEvent.change(input, { target: { value: 'renomeada' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(updateMock).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('a blur that fires after Escape does not resurrect the cancelled edit', () => {
    const onChange = vi.fn();
    const subs = [task({ id: 'a', parent_id: 'parent' })];
    render(<SubtaskList parent={parentWith(subs)} onChange={onChange} onError={vi.fn()} />);
    fireEvent.click(screen.getByText('a'));
    const input = screen.getByDisplayValue('a');
    fireEvent.change(input, { target: { value: 'renomeada' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    // Escape unmounts the input synchronously; blur is only meaningful if it's still attached.
    if (document.body.contains(input)) fireEvent.blur(input);
    expect(updateMock).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('a blur that fires after Enter does not re-save the already-committed rename', async () => {
    updateMock.mockResolvedValue({ task: {} });
    const onChange = vi.fn();
    const subs = [task({ id: 'a', parent_id: 'parent' })];
    render(<SubtaskList parent={parentWith(subs)} onChange={onChange} onError={vi.fn()} />);
    fireEvent.click(screen.getByText('a'));
    const input = screen.getByDisplayValue('a');
    fireEvent.change(input, { target: { value: 'renomeada' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    if (document.body.contains(input)) fireEvent.blur(input);
    await waitFor(() => expect(updateMock).toHaveBeenCalledTimes(1));
    expect(updateMock).toHaveBeenCalledWith('a', { title: 'renomeada' });
  });

  it('reorders on drag and drop and persists', async () => {
    reorderMock.mockResolvedValue({ task: {} });
    const onChange = vi.fn();
    const subs = [task({ id: 'a', parent_id: 'parent', position: 0 }), task({ id: 'b', parent_id: 'parent', position: 1 })];
    render(<SubtaskList parent={parentWith(subs)} onChange={onChange} onError={vi.fn()} />);
    const rows = screen.getAllByRole('checkbox').map((c) => c.closest('li')!);
    const dataTransfer = { effectAllowed: '', setData: () => {} };
    fireEvent.dragStart(rows[1], { dataTransfer });
    fireEvent.dragOver(rows[0], { dataTransfer });
    fireEvent.drop(rows[0], { dataTransfer });
    expect(onChange.mock.calls.at(-1)![0].map((s: Task) => s.id)).toEqual(['b', 'a']);
    expect(onChange.mock.calls.at(-1)![0].map((s: Task) => s.position)).toEqual([0, 1]);
    await waitFor(() => expect(reorderMock).toHaveBeenCalledWith('b', 0));
  });
});
