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

  it('rolls back and reports when the save fails', async () => {
    updateMock.mockRejectedValue(new Error('boom'));
    const onChange = vi.fn();
    const onError = vi.fn();
    const subs = [task({ id: 'a', parent_id: 'parent' })];
    render(<SubtaskList parent={parentWith(subs)} onChange={onChange} onError={onError} />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'a' }));
    await waitFor(() => expect(onError).toHaveBeenCalledWith('Erro ao salvar subtarefa'));
    expect(onChange.mock.calls.at(-1)![0][0].status).toBe('todo');
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
    await waitFor(() => expect(onChange.mock.calls.at(-1)![0].map((s: Task) => s.id)).toEqual(['n']));
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
});
