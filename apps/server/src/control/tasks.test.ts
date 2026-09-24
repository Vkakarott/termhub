import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config.js', () => ({ config: { publicUrl: 'https://app.test' } }));

import type { Repositories } from '../db/repositories/index.js';
import { TaskRuleError } from '../db/repositories/tasks.js';
import type { Project, Task, TaskWithSubtasks } from '../db/repositories/types.js';
import { Scoped } from '../auth/scope.js';
import type { ControlContext } from './context.js';
import { ControlError } from './context.js';
import { addSubtasks, boardUrl, createTask, deleteTask, listTasks, moveTask, updateTask } from './tasks.js';

const project = (over: Partial<Project> & { id: string; owner_id: string }): Project => ({
  key: over.id.toUpperCase(), next_task_number: 1, name: over.id, status: 'active', description: null, last_terminal_at: null, created_at: '', ...over,
});
const task = (over: Partial<Task> & { id: string; project_id: string }): Task => ({
  title: over.id, description: null, status: 'todo', position: 0, external_ref: null, external_key: null, tab_id: null, parent_id: null,
  created_at: '2026-09-20T10:00:00.000Z', updated_at: '2026-09-20T10:00:00.000Z', ...over,
});
const tree = (t: Task, subtasks: Task[] = []): TaskWithSubtasks => ({ ...t, subtasks, subtask_counts: { done: subtasks.filter((s) => s.status === 'done').length, total: subtasks.length } });

/** u1 owns p1; u2 owns px. */
const projects = [project({ id: 'p1', owner_id: 'u1' }), project({ id: 'px', owner_id: 'u2' })];
const k1 = task({ id: 'k1', project_id: 'p1', title: 'Spec', status: 'doing', external_ref: { provider: 'linear' }, external_key: 'LIN-1' });
const s1 = task({ id: 's1', project_id: 'p1', title: 'Write it', parent_id: 'k1', status: 'done' });
const k2 = task({ id: 'k2', project_id: 'p1', title: 'Plan', status: 'todo', position: 1 });
const kx = task({ id: 'kx', project_id: 'px', title: 'Not yours' });
const tasks = [k1, s1, k2, kx];

function ctx() {
  const repos = {
    projects: { findById: vi.fn(async (id: string) => projects.find((p) => p.id === id)) },
    tasks: {
      findById: vi.fn(async (id: string) => tasks.find((t) => t.id === id)),
      listByProject: vi.fn(async (pid: string) => (pid === 'p1' ? [tree(k1, [s1]), tree(k2)] : [])),
      createWithSubtasks: vi.fn(),
      createSubtasks: vi.fn(),
      update: vi.fn(),
      move: vi.fn(),
      childIds: vi.fn(async () => [] as string[]),
      delete: vi.fn(async () => true),
    },
    tickets: { unlinkTask: vi.fn(async () => {}) },
  };
  const scope = { user: { id: 'u1' } as never, viewAs: { kind: 'self' } as const, ownerId: 'u1', createAs: 'u1' };
  const c: ControlContext = { repos: repos as unknown as Repositories, scope, scoped: new Scoped(repos as unknown as Repositories, scope), can: async () => true };
  return { c, repos };
}

beforeEach(() => vi.clearAllMocks());

describe('boardUrl', () => {
  it('points at the tasks section of the project in the app', () => {
    expect(boardUrl('p1')).toBe('https://app.test/projects/p1/tasks');
  });
});

describe('listTasks', () => {
  it('returns the nested board without external_ref, plus the board url', async () => {
    const { c } = ctx();
    const r = await listTasks(c, { project_id: 'p1' });
    expect(r.board_url).toBe('https://app.test/projects/p1/tasks');
    expect(r.tasks.map((t) => t.id)).toEqual(['k1', 'k2']);
    expect(r.tasks[0]).toMatchObject({ id: 'k1', project_id: 'p1', title: 'Spec', status: 'doing', external_key: 'LIN-1', subtask_counts: { done: 1, total: 1 } });
    expect(r.tasks[0].subtasks[0]).toMatchObject({ id: 's1', parent_id: 'k1', status: 'done' });
    expect(r.tasks[0]).not.toHaveProperty('external_ref');
  });

  it('filters top-level tasks by status, keeping their subtasks', async () => {
    const { c } = ctx();
    const r = await listTasks(c, { project_id: 'p1', status: 'doing' });
    expect(r.tasks.map((t) => t.id)).toEqual(['k1']);
    expect(r.tasks[0].subtasks).toHaveLength(1);
  });

  it('404s a project of another user', async () => {
    const { c, repos } = ctx();
    await expect(listTasks(c, { project_id: 'px' })).rejects.toMatchObject({ statusCode: 404 });
    expect(repos.tasks.listByProject).not.toHaveBeenCalled();
  });
});

describe('createTask', () => {
  it('creates the task with its subtasks in one repository call and returns the board url', async () => {
    const { c, repos } = ctx();
    const created = tree(task({ id: 'k9', project_id: 'p1', title: 'New' }), [task({ id: 's9', project_id: 'p1', parent_id: 'k9', title: 'a' })]);
    repos.tasks.createWithSubtasks.mockResolvedValue(created);
    const r = await createTask(c, { project_id: 'p1', title: 'New', subtasks: [{ title: 'a' }] });
    expect(repos.tasks.createWithSubtasks).toHaveBeenCalledWith('p1', { title: 'New', description: undefined, status: undefined }, [{ title: 'a' }]);
    expect(r.task).toMatchObject({ id: 'k9', subtasks: [{ id: 's9' }], subtask_counts: { done: 0, total: 1 } });
    expect(r.board_url).toBe('https://app.test/projects/p1/tasks');
  });

  it('passes an empty subtask list when none are given', async () => {
    const { c, repos } = ctx();
    repos.tasks.createWithSubtasks.mockResolvedValue(tree(task({ id: 'k9', project_id: 'p1' })));
    await createTask(c, { project_id: 'p1', title: 'New', status: 'backlog' });
    expect(repos.tasks.createWithSubtasks).toHaveBeenCalledWith('p1', { title: 'New', description: undefined, status: 'backlog' }, []);
  });

  it('turns a repository rule into a ControlError with its pt-BR message', async () => {
    const { c, repos } = ctx();
    repos.tasks.createWithSubtasks.mockRejectedValue(new TaskRuleError('TOO_MANY_SUBTASKS', 'No máximo 50 subtarefas por vez'));
    await expect(createTask(c, { project_id: 'p1', title: 'x', subtasks: [] })).rejects.toEqual(new ControlError('TOO_MANY_SUBTASKS', 'No máximo 50 subtarefas por vez'));
  });

  it('404s a project of another user before creating anything', async () => {
    const { c, repos } = ctx();
    await expect(createTask(c, { project_id: 'px', title: 'x' })).rejects.toMatchObject({ statusCode: 404 });
    expect(repos.tasks.createWithSubtasks).not.toHaveBeenCalled();
  });
});

describe('addSubtasks', () => {
  it('appends to a task of the owner, pinning the project', async () => {
    const { c, repos } = ctx();
    repos.tasks.createSubtasks.mockResolvedValue([task({ id: 's2', project_id: 'p1', parent_id: 'k1', title: 'b', position: 1 })]);
    const r = await addSubtasks(c, { task_id: 'k1', subtasks: [{ title: 'b' }] });
    expect(repos.tasks.createSubtasks).toHaveBeenCalledWith('k1', [{ title: 'b' }], 'p1');
    expect(r).toMatchObject({ task_id: 'k1', subtasks: [{ id: 's2', position: 1 }], board_url: 'https://app.test/projects/p1/tasks' });
  });

  it('refuses a subtask as parent with the repository message', async () => {
    const { c, repos } = ctx();
    repos.tasks.createSubtasks.mockRejectedValue(new TaskRuleError('PARENT_IS_SUBTASK', 'Uma subtarefa não pode ter subtarefas'));
    await expect(addSubtasks(c, { task_id: 's1', subtasks: [{ title: 'c' }] })).rejects.toEqual(new ControlError('PARENT_IS_SUBTASK', 'Uma subtarefa não pode ter subtarefas'));
  });

  it('404s a task of another user', async () => {
    const { c, repos } = ctx();
    await expect(addSubtasks(c, { task_id: 'kx', subtasks: [{ title: 'c' }] })).rejects.toMatchObject({ statusCode: 404 });
    expect(repos.tasks.createSubtasks).not.toHaveBeenCalled();
  });
});

describe('updateTask', () => {
  it('patches title, description and status of a task or subtask', async () => {
    const { c, repos } = ctx();
    repos.tasks.update.mockResolvedValue({ ...s1, title: 'Renamed', status: 'todo' });
    const r = await updateTask(c, { task_id: 's1', title: 'Renamed', status: 'todo' });
    expect(repos.tasks.update).toHaveBeenCalledWith('s1', { title: 'Renamed', description: undefined, status: 'todo' });
    expect(r.task).toMatchObject({ id: 's1', title: 'Renamed', status: 'todo' });
    expect(r.board_url).toBe('https://app.test/projects/p1/tasks');
  });

  it('requires at least one field', async () => {
    const { c, repos } = ctx();
    await expect(updateTask(c, { task_id: 'k1' })).rejects.toEqual(new ControlError('BAD_REQUEST', 'Informe title, description ou status'));
    expect(repos.tasks.update).not.toHaveBeenCalled();
  });

  it('clears the description with null', async () => {
    const { c, repos } = ctx();
    repos.tasks.update.mockResolvedValue({ ...k1, description: null });
    await updateTask(c, { task_id: 'k1', description: null });
    expect(repos.tasks.update).toHaveBeenCalledWith('k1', { title: undefined, description: null, status: undefined });
  });

  it('404s a task of another user', async () => {
    const { c, repos } = ctx();
    await expect(updateTask(c, { task_id: 'kx', title: 'x' })).rejects.toMatchObject({ statusCode: 404 });
    expect(repos.tasks.update).not.toHaveBeenCalled();
  });
});

describe('moveTask', () => {
  it('moves a top-level task to a column, position 0 by default', async () => {
    const { c, repos } = ctx();
    repos.tasks.move.mockResolvedValue({ ...k2, status: 'doing', position: 0 });
    const r = await moveTask(c, { task_id: 'k2', status: 'doing' });
    expect(repos.tasks.move).toHaveBeenCalledWith('k2', { status: 'doing' }, 0);
    expect(r.task).toMatchObject({ id: 'k2', status: 'doing', position: 0 });
  });

  it('passes an explicit position through', async () => {
    const { c, repos } = ctx();
    repos.tasks.move.mockResolvedValue({ ...k2, status: 'done', position: 3 });
    await moveTask(c, { task_id: 'k2', status: 'done', position: 3 });
    expect(repos.tasks.move).toHaveBeenCalledWith('k2', { status: 'done' }, 3);
  });

  it('refuses a subtask with the repository message', async () => {
    const { c, repos } = ctx();
    repos.tasks.move.mockRejectedValue(new TaskRuleError('SUBTASK_CANNOT_MOVE', 'Subtarefas não ficam em colunas; mude o status ou reordene'));
    await expect(moveTask(c, { task_id: 's1', status: 'done' })).rejects.toEqual(new ControlError('SUBTASK_CANNOT_MOVE', 'Subtarefas não ficam em colunas; mude o status ou reordene'));
  });
});

describe('deleteTask', () => {
  it('without confirm, says what would be deleted and deletes nothing', async () => {
    const { c, repos } = ctx();
    repos.tasks.childIds.mockResolvedValue(['s1']);
    await expect(deleteTask(c, { task_id: 'k1' })).rejects.toEqual(new ControlError('CONFIRM_REQUIRED', 'Isso exclui a tarefa "Spec" e 1 subtarefa; repita com confirm: true para confirmar'));
    expect(repos.tasks.delete).not.toHaveBeenCalled();
    expect(repos.tickets.unlinkTask).not.toHaveBeenCalled();
  });

  it('with confirm, unlinks the tickets of the subtree and reports the cascade', async () => {
    const { c, repos } = ctx();
    repos.tasks.childIds.mockResolvedValue(['s1']);
    const r = await deleteTask(c, { task_id: 'k1', confirm: true });
    expect(repos.tickets.unlinkTask.mock.calls.map((a) => a[0])).toEqual(['k1', 's1']);
    expect(repos.tasks.delete).toHaveBeenCalledWith('k1');
    expect(r).toEqual({ deleted: true, task_id: 'k1', deleted_subtasks: 1, board_url: 'https://app.test/projects/p1/tasks' });
  });

  it('pluralizes the confirmation for several subtasks and none', async () => {
    const { c, repos } = ctx();
    repos.tasks.childIds.mockResolvedValue(['a', 'b']);
    await expect(deleteTask(c, { task_id: 'k1' })).rejects.toMatchObject({ message: 'Isso exclui a tarefa "Spec" e 2 subtarefas; repita com confirm: true para confirmar' });
    repos.tasks.childIds.mockResolvedValue([]);
    await expect(deleteTask(c, { task_id: 'k2' })).rejects.toMatchObject({ message: 'Isso exclui a tarefa "Plan"; repita com confirm: true para confirmar' });
    await expect(deleteTask(c, { task_id: 's1' })).rejects.toMatchObject({ message: 'Isso exclui a subtarefa "Write it"; repita com confirm: true para confirmar' });
  });

  it('404s a task of another user', async () => {
    const { c, repos } = ctx();
    await expect(deleteTask(c, { task_id: 'kx', confirm: true })).rejects.toMatchObject({ statusCode: 404 });
    expect(repos.tasks.delete).not.toHaveBeenCalled();
  });
});
