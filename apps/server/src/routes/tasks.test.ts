import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Repositories } from '../db/repositories/index.js';
import { TaskRuleError } from '../db/repositories/tasks.js';
import type { Task } from '../db/repositories/types.js';
import { applyErrorHandler } from '../lib/errors.js';
import { projectTaskRoutes, taskRoutes } from './tasks.js';

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
  created_at: '',
  updated_at: '',
  ...over,
});

/** Routes over stubbed repositories and a fixed request scope, like machines.test.ts. */
function buildApp(tasks: Record<string, Task>) {
  const app = Fastify();
  applyErrorHandler(app);
  app.addHook('preHandler', async (request) => {
    request.scope = { user: { id: 'u1' } as never, viewAs: { kind: 'self' }, ownerId: null, createAs: 'u1' };
    request.user = { id: 'u1' } as never;
  });
  const tasksRepo = {
    findById: vi.fn(async (id: string) => tasks[id]),
    listByProject: vi.fn(async () => []),
    create: vi.fn(async (_p: string, input: { title: string; parent_id?: string | null }) => task({ id: 'new', title: input.title, parent_id: input.parent_id ?? null })),
    createSubtasks: vi.fn(async (parentId: string, items: { title: string }[]) => items.map((it, i) => task({ id: `s${i}`, title: it.title, parent_id: parentId, position: i }))),
    reorder: vi.fn(async (id: string, position: number) => ({ ...tasks[id], position })),
    childIds: vi.fn(async (id: string) => Object.values(tasks).filter((t) => t.parent_id === id).map((t) => t.id)),
    update: vi.fn(async (id: string, patch: Partial<Task>) => ({ ...tasks[id], ...patch })),
    move: vi.fn(),
    delete: vi.fn(async () => true),
  };
  const unlinkTask = vi.fn(async () => {});
  const repos = {
    tasks: tasksRepo,
    tickets: { unlinkTask },
    projects: { findById: vi.fn(async (id: string) => (id === 'p1' ? { id: 'p1', machine_id: 'm1' } : undefined)) },
    machines: { findById: vi.fn(async () => ({ id: 'm1', owner_id: 'u1' })) },
  } as unknown as Repositories;
  app.register((a) => projectTaskRoutes(a, repos), { prefix: '/projects' });
  app.register((a) => taskRoutes(a, repos), { prefix: '/tasks' });
  return { app, tasksRepo, unlinkTask };
}

describe('task routes: subtasks', () => {
  let store: Record<string, Task>;
  beforeEach(() => {
    store = { t1: task({ id: 't1' }), c1: task({ id: 'c1', parent_id: 't1' }), c2: task({ id: 'c2', parent_id: 't1', position: 1 }) };
  });

  it('creates subtasks in bulk, scoped to the parent project', async () => {
    const { app, tasksRepo } = buildApp(store);
    const r = await app.inject({ method: 'POST', url: '/tasks/t1/subtasks', payload: { items: [{ title: ' a ' }, { title: 'b', description: 'd' }] } });
    expect(r.statusCode).toBe(201);
    expect(r.json().subtasks.map((s: Task) => s.title)).toEqual(['a', 'b']);
    expect(tasksRepo.createSubtasks).toHaveBeenCalledWith('t1', [{ title: 'a' }, { title: 'b', description: 'd' }], 'p1');
  });

  it.each([
    ['no items', { items: [] }],
    ['51 items', { items: Array.from({ length: 51 }, (_, i) => ({ title: `t${i}` })) }],
    ['a whitespace-only title', { items: [{ title: 'ok' }, { title: '   ' }] }],
    ['a missing body', undefined],
  ])('rejects %s with 400 and creates nothing', async (_name, payload) => {
    const { app, tasksRepo } = buildApp(store);
    const r = await app.inject({ method: 'POST', url: '/tasks/t1/subtasks', payload });
    expect(r.statusCode).toBe(400);
    expect(tasksRepo.createSubtasks).not.toHaveBeenCalled();
  });

  it('answers 404 for a parent outside the scope, without calling the repository', async () => {
    const { app, tasksRepo } = buildApp(store);
    const r = await app.inject({ method: 'POST', url: '/tasks/missing/subtasks', payload: { items: [{ title: 'a' }] } });
    expect(r.statusCode).toBe(404);
    expect(tasksRepo.createSubtasks).not.toHaveBeenCalled();
  });

  it('turns a repository rule error into a 400 with its message', async () => {
    const { app, tasksRepo } = buildApp(store);
    tasksRepo.createSubtasks.mockRejectedValueOnce(new TaskRuleError('PARENT_IS_SUBTASK', 'Uma subtarefa não pode ter subtarefas'));
    const r = await app.inject({ method: 'POST', url: '/tasks/c1/subtasks', payload: { items: [{ title: 'a' }] } });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toEqual({ error: 'Uma subtarefa não pode ter subtarefas', code: 'BAD_REQUEST' });
  });

  it('passes parent_id through on the project create route', async () => {
    const { app, tasksRepo } = buildApp(store);
    const r = await app.inject({ method: 'POST', url: '/projects/p1/tasks', payload: { title: 'child', parent_id: 't1' } });
    expect(r.statusCode).toBe(201);
    expect(tasksRepo.create).toHaveBeenCalledWith('p1', { title: 'child', parent_id: 't1' });
  });

  it('does not let PATCH reparent a task', async () => {
    const { app, tasksRepo } = buildApp(store);
    const r = await app.inject({ method: 'PATCH', url: '/tasks/c1', payload: { status: 'done', parent_id: 'other' } });
    expect(r.statusCode).toBe(200);
    expect(tasksRepo.update).toHaveBeenCalledWith('c1', { status: 'done' });
  });

  it('reorders a subtask and validates the position', async () => {
    const { app, tasksRepo } = buildApp(store);
    expect((await app.inject({ method: 'POST', url: '/tasks/c2/reorder', payload: { position: 0 } })).statusCode).toBe(200);
    expect(tasksRepo.reorder).toHaveBeenCalledWith('c2', 0);
    expect((await app.inject({ method: 'POST', url: '/tasks/c2/reorder', payload: { position: -1 } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/tasks/c2/reorder', payload: { position: 1.5 } })).statusCode).toBe(400);
  });

  it('maps a move of a subtask to 400', async () => {
    const { app, tasksRepo } = buildApp(store);
    tasksRepo.move.mockRejectedValueOnce(new TaskRuleError('SUBTASK_CANNOT_MOVE', 'Subtarefas não ficam em colunas; mude o status ou reordene'));
    const r = await app.inject({ method: 'POST', url: '/tasks/c1/move', payload: { status: 'done', position: 0 } });
    expect(r.statusCode).toBe(400);
  });

  it('unlinks the tickets of the parent and of every child before deleting', async () => {
    const { app, tasksRepo, unlinkTask } = buildApp(store);
    const r = await app.inject({ method: 'DELETE', url: '/tasks/t1' });
    expect(r.json()).toEqual({ ok: true, deleted_subtasks: 2 });
    expect(unlinkTask.mock.calls.map((c) => c[0]).sort()).toEqual(['c1', 'c2', 't1']);
    expect(unlinkTask.mock.invocationCallOrder.every((n) => n < tasksRepo.delete.mock.invocationCallOrder[0])).toBe(true);
  });
});
