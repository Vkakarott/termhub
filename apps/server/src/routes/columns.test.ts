import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { Repositories } from '../db/repositories/index.js';
import { TaskRuleError } from '../db/repositories/task-rules.js';
import type { TaskColumn } from '../db/repositories/types.js';
import { applyErrorHandler } from '../lib/errors.js';
import { columnRoutes, projectColumnRoutes } from './columns.js';

const col = (over: Partial<TaskColumn> & { id: string }): TaskColumn => ({ project_id: 'p1', name: over.id, category: 'todo', position: 0, created_at: '', ...over });
const columns = [col({ id: 'c1', name: 'A fazer' }), col({ id: 'c2', name: 'Fazendo', category: 'doing', position: 1 }), col({ id: 'cx', project_id: 'px', name: 'Deles' })];
const projects: Record<string, unknown> = { p1: { id: 'p1', owner_id: 'u1', agent_column_id: null }, px: { id: 'px', owner_id: 'u2', agent_column_id: null } };

/** u1 owns p1 (c1, c2); u2 owns px (cx). */
function buildApp() {
  const app = Fastify();
  applyErrorHandler(app);
  app.addHook('preHandler', async (request) => {
    request.scope = { user: { id: 'u1' } as never, viewAs: { kind: 'self' }, ownerId: 'u1', createAs: 'u1' };
    request.user = { id: 'u1' } as never;
  });
  const taskColumns = {
    list: vi.fn(async (pid: string) => columns.filter((c) => c.project_id === pid)),
    findById: vi.fn(async (id: string) => columns.find((c) => c.id === id)),
    ensureDefaults: vi.fn(async () => {}),
    create: vi.fn(async (pid: string, input: { name: string; category: 'todo' | 'doing' | 'done' }) => col({ id: 'new', project_id: pid, ...input })),
    rename: vi.fn(async (id: string, name: string) => ({ ...columns.find((c) => c.id === id)!, name })),
    setCategory: vi.fn(async (id: string, category: 'todo' | 'doing' | 'done') => ({ ...columns.find((c) => c.id === id)!, category })),
    move: vi.fn(async () => [columns[1], columns[0]]),
    delete: vi.fn(async () => ({ moved_tasks: 2 })),
    setAgentColumn: vi.fn(async () => {}),
  };
  const repos = { taskColumns, projects: { findById: vi.fn(async (id: string) => projects[id]) } } as unknown as Repositories;
  app.register((a) => projectColumnRoutes(a, repos), { prefix: '/projects' });
  app.register((a) => columnRoutes(a, repos), { prefix: '/columns' });
  return { app, taskColumns };
}

describe('column routes', () => {
  it('lists a project\'s columns (creating the defaults when missing) and its agent column', async () => {
    const { app, taskColumns } = buildApp();
    const r = await app.inject({ method: 'GET', url: '/projects/p1/columns' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ columns: [columns[0], columns[1]], agent_column_id: null });
    expect(taskColumns.ensureDefaults).toHaveBeenCalledWith('p1');
    expect((await app.inject({ method: 'GET', url: '/projects/px/columns' })).statusCode).toBe(404);
  });

  it('creates a column with a trimmed name', async () => {
    const { app, taskColumns } = buildApp();
    const r = await app.inject({ method: 'POST', url: '/projects/p1/columns', payload: { name: '  QA ', category: 'doing' } });
    expect(r.statusCode).toBe(201);
    expect(taskColumns.create).toHaveBeenCalledWith('p1', { name: 'QA', category: 'doing' });
  });

  it.each([
    ['an empty name', { name: '   ', category: 'todo' }],
    ['a 41-char name', { name: 'x'.repeat(41), category: 'todo' }],
    ['the backlog as category', { name: 'B', category: 'backlog' }],
  ])('refuses %s', async (_name, payload) => {
    const { app, taskColumns } = buildApp();
    expect((await app.inject({ method: 'POST', url: '/projects/p1/columns', payload })).statusCode).toBe(400);
    expect(taskColumns.create).not.toHaveBeenCalled();
  });

  it('says the limit when the project already has 12 columns', async () => {
    const { app, taskColumns } = buildApp();
    taskColumns.create.mockRejectedValueOnce(new TaskRuleError('TOO_MANY_COLUMNS'));
    const r = await app.inject({ method: 'POST', url: '/projects/p1/columns', payload: { name: 'x', category: 'todo' } });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe('Limite de 12 colunas');
  });

  it('renames and re-categorizes; needs at least one field; 404 outside the scope', async () => {
    const { app, taskColumns } = buildApp();
    const r = await app.inject({ method: 'PATCH', url: '/columns/c1', payload: { name: 'Em revisão', category: 'doing' } });
    expect(r.statusCode).toBe(200);
    expect(taskColumns.setCategory).toHaveBeenCalledWith('c1', 'doing');
    expect(taskColumns.rename).toHaveBeenCalledWith('c1', 'Em revisão');
    expect(r.json().column.name).toBe('Em revisão');
    expect((await app.inject({ method: 'PATCH', url: '/columns/c1', payload: {} })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PATCH', url: '/columns/cx', payload: { name: 'x' } })).statusCode).toBe(404);
    expect(taskColumns.rename).toHaveBeenCalledTimes(1);
  });

  it('answers 409 when the last column of a category would change or go', async () => {
    const { app, taskColumns } = buildApp();
    taskColumns.setCategory.mockRejectedValueOnce(new TaskRuleError('COLUMN_LAST_OF_CATEGORY'));
    const r = await app.inject({ method: 'PATCH', url: '/columns/c1', payload: { category: 'done' } });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toEqual({ error: 'O board precisa de ao menos uma coluna de cada tipo', code: 'CONFLICT' });
    taskColumns.delete.mockRejectedValueOnce(new TaskRuleError('COLUMN_LAST_OF_CATEGORY'));
    expect((await app.inject({ method: 'DELETE', url: '/columns/c2' })).statusCode).toBe(409);
  });

  it('moves a column and answers the new order', async () => {
    const { app, taskColumns } = buildApp();
    const r = await app.inject({ method: 'POST', url: '/columns/c2/move', payload: { position: 0 } });
    expect(r.statusCode).toBe(200);
    expect(r.json().columns.map((c: TaskColumn) => c.id)).toEqual(['c2', 'c1']);
    expect(taskColumns.move).toHaveBeenCalledWith('c2', 0);
    expect((await app.inject({ method: 'POST', url: '/columns/c2/move', payload: { position: -1 } })).statusCode).toBe(400);
  });

  it('deletes a column and says how many cards moved', async () => {
    const { app } = buildApp();
    const r = await app.inject({ method: 'DELETE', url: '/columns/c2' });
    expect(r.json()).toEqual({ ok: true, moved_tasks: 2 });
    expect((await app.inject({ method: 'DELETE', url: '/columns/cx' })).statusCode).toBe(404);
  });

  it('sets and clears the agent column', async () => {
    const { app, taskColumns } = buildApp();
    const r = await app.inject({ method: 'PUT', url: '/projects/p1/agent-column', payload: { column_id: 'c2' } });
    expect(r.json()).toEqual({ agent_column_id: 'c2' });
    expect(taskColumns.setAgentColumn).toHaveBeenCalledWith('p1', 'c2');
    expect((await app.inject({ method: 'PUT', url: '/projects/p1/agent-column', payload: { column_id: null } })).json()).toEqual({ agent_column_id: null });
    expect((await app.inject({ method: 'PUT', url: '/projects/p1/agent-column', payload: {} })).statusCode).toBe(400);
    taskColumns.setAgentColumn.mockRejectedValueOnce(new TaskRuleError('COLUMN_NOT_FOUND'));
    expect((await app.inject({ method: 'PUT', url: '/projects/p1/agent-column', payload: { column_id: 'cx' } })).statusCode).toBe(400);
  });
});
