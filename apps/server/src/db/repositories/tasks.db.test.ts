import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../generated/prisma/client.js';
import { newId } from '../../lib/ids.js';
import { MAX_SUBTASKS_PER_CALL, TaskRuleError, TasksRepository } from './tasks.js';

// Needs a migrated Postgres: TERMHUB_DB_TESTS=1 DATABASE_URL=… (CI sets both; see the plan/README for the local Docker recipe).
describe.skipIf(process.env.TERMHUB_DB_TESTS !== '1')('TasksRepository (Postgres)', () => {
  let db: PrismaClient;
  let repo: TasksRepository;
  let machineId: string;
  let projectId: string;
  let otherProjectId: string;

  beforeAll(() => {
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
    repo = new TasksRepository(db);
  });

  beforeEach(async () => {
    machineId = newId();
    projectId = newId();
    otherProjectId = newId();
    await db.machine.create({ data: { id: machineId, name: 'test', type: 'agent' } });
    await db.project.createMany({
      data: [
        { id: projectId, machineId, name: 'p', cwd: '/tmp' },
        { id: otherProjectId, machineId, name: 'other', cwd: '/tmp' },
      ],
    });
    return async () => {
      await db.machine.delete({ where: { id: machineId } }); // cascades projects and tasks
    };
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  const titles = (ts: { title: string }[]) => ts.map((t) => t.title);

  it('appends subtasks in call order and nests them in the list', async () => {
    const parent = await repo.create(projectId, { title: 'parent' });
    await repo.createSubtasks(parent.id, [{ title: 's1' }, { title: 's2' }]);
    await repo.create(projectId, { title: 's3', parent_id: parent.id });

    const list = await repo.listByProject(projectId);
    expect(titles(list)).toEqual(['parent']);
    expect(titles(list[0].subtasks)).toEqual(['s1', 's2', 's3']);
    expect(list[0].subtasks.map((s) => s.position)).toEqual([0, 1, 2]);
    expect(list[0].subtasks.every((s) => s.project_id === projectId && s.external_key === null)).toBe(true);
    expect(list[0].subtask_counts).toEqual({ done: 0, total: 3 });
  });

  it('creates a task with its subtasks in one call, at the top of its column', async () => {
    const older = await repo.create(projectId, { title: 'older' });
    const t = await repo.createWithSubtasks(projectId, { title: 'spec', description: 'd', status: 'todo' }, [{ title: 'a' }, { title: 'b', description: 'bd' }]);
    expect(t).toMatchObject({ title: 'spec', description: 'd', status: 'todo', position: 0, parent_id: null, subtask_counts: { done: 0, total: 2 } });
    expect(t.subtasks.map((s) => [s.title, s.position, s.parent_id, s.project_id])).toEqual([['a', 0, t.id, projectId], ['b', 1, t.id, projectId]]);
    expect((await repo.findById(older.id))?.position).toBe(1);
    const listed = await repo.listByProject(projectId);
    expect(titles(listed)).toEqual(['spec', 'older']);
    expect(titles(listed[0].subtasks)).toEqual(['a', 'b']);
  });

  it('creates a task with no subtasks through the same call', async () => {
    const t = await repo.createWithSubtasks(projectId, { title: 'alone' }, []);
    expect(t).toMatchObject({ title: 'alone', status: 'todo', subtasks: [], subtask_counts: { done: 0, total: 0 } });
  });

  it('rejects too many subtasks in createWithSubtasks, creating nothing', async () => {
    const many = Array.from({ length: MAX_SUBTASKS_PER_CALL + 1 }, (_, i) => ({ title: `s${i}` }));
    await expect(repo.createWithSubtasks(projectId, { title: 'x' }, many)).rejects.toMatchObject({ code: 'TOO_MANY_SUBTASKS' } satisfies Partial<TaskRuleError>);
    expect(await repo.listByProject(projectId)).toEqual([]);
  });

  it('rejects a call over the per-call cap, creating nothing', async () => {
    const parent = await repo.create(projectId, { title: 'parent' });
    const items = Array.from({ length: MAX_SUBTASKS_PER_CALL + 1 }, (_, i) => ({ title: `s${i}` }));
    await expect(repo.createSubtasks(parent.id, items)).rejects.toMatchObject({ code: 'TOO_MANY_SUBTASKS' });
    expect(await repo.childIds(parent.id)).toEqual([]);
  });

  it('rejects a subtask of a subtask', async () => {
    const parent = await repo.create(projectId, { title: 'parent' });
    const [child] = await repo.createSubtasks(parent.id, [{ title: 'child' }]);
    await expect(repo.createSubtasks(child.id, [{ title: 'grandchild' }])).rejects.toMatchObject({ code: 'PARENT_IS_SUBTASK' });
    await expect(repo.createSubtasks(child.id, [{ title: 'x' }])).rejects.toBeInstanceOf(TaskRuleError);
  });

  it('keeps sibling positions distinct under concurrent createSubtasks calls on the same parent', async () => {
    const parent = await repo.create(projectId, { title: 'parent' });
    await Promise.all([
      repo.createSubtasks(parent.id, [{ title: 'a1' }, { title: 'a2' }]),
      repo.createSubtasks(parent.id, [{ title: 'b1' }, { title: 'b2' }]),
    ]);

    const list = await repo.listByProject(projectId);
    const positions = list[0].subtasks.map((s) => s.position).sort((a, b) => a - b);
    expect(positions).toEqual([0, 1, 2, 3]);
  });

  it('rejects an unknown parent and a parent from another project, creating nothing', async () => {
    const foreign = await repo.create(otherProjectId, { title: 'foreign' });
    await expect(repo.createSubtasks('nope', [{ title: 'x' }])).rejects.toMatchObject({ code: 'PARENT_NOT_FOUND' });
    await expect(repo.create(projectId, { title: 'x', parent_id: foreign.id })).rejects.toMatchObject({ code: 'PARENT_NOT_FOUND' });
    expect(await db.task.count({ where: { projectId } })).toBe(0);
  });

  it('creating a top-level task does not shift subtask positions', async () => {
    const parent = await repo.create(projectId, { title: 'parent' });
    await repo.createSubtasks(parent.id, [{ title: 's1' }, { title: 's2' }]);
    await repo.create(projectId, { title: 'another top-level todo' });

    const [first] = (await repo.listByProject(projectId)).filter((t) => t.id === parent.id);
    expect(first.subtasks.map((s) => s.position)).toEqual([0, 1]);
    expect(first.position).toBe(1); // pushed down by the new top-of-column task, as before
  });

  it('keeps subtasks out of open counts and the dashboard "doing" list', async () => {
    const parent = await repo.create(projectId, { title: 'parent', status: 'doing' });
    const [s1] = await repo.createSubtasks(parent.id, [{ title: 's1' }, { title: 's2' }]);
    await repo.update(s1.id, { status: 'doing' });

    expect((await repo.openCountByProject())[projectId]).toBe(1);
    expect(titles((await repo.listDoing()).filter((t) => t.project_id === projectId))).toEqual(['parent']);
  });

  it('changes a subtask status in place, without touching positions or the parent', async () => {
    const parent = await repo.create(projectId, { title: 'parent' });
    const [s1, s2] = await repo.createSubtasks(parent.id, [{ title: 's1' }, { title: 's2' }]);
    const updated = await repo.update(s2.id, { status: 'done', title: 's2 renamed' });

    expect(updated).toMatchObject({ status: 'done', title: 's2 renamed', position: 1, parent_id: parent.id });
    expect((await repo.findById(s1.id))?.position).toBe(0);
    expect((await repo.findById(parent.id))?.status).toBe('todo');
  });

  it('refuses to move a subtask between columns', async () => {
    const parent = await repo.create(projectId, { title: 'parent' });
    const [s1] = await repo.createSubtasks(parent.id, [{ title: 's1' }]);
    await expect(repo.move(s1.id, 'done', 0)).rejects.toMatchObject({ code: 'SUBTASK_CANNOT_MOVE' });
  });

  it('reorders siblings and clamps an out-of-range position', async () => {
    const parent = await repo.create(projectId, { title: 'parent' });
    const [a, , c] = await repo.createSubtasks(parent.id, [{ title: 'a' }, { title: 'b' }, { title: 'c' }]);

    await repo.reorder(c.id, 0);
    expect(titles((await repo.listByProject(projectId))[0].subtasks)).toEqual(['c', 'a', 'b']);

    await repo.reorder(a.id, 999);
    const subs = (await repo.listByProject(projectId))[0].subtasks;
    expect(titles(subs)).toEqual(['c', 'b', 'a']);
    expect(subs.map((s) => s.position)).toEqual([0, 1, 2]);
  });

  it('refuses to reorder a top-level task', async () => {
    const parent = await repo.create(projectId, { title: 'parent' });
    await expect(repo.reorder(parent.id, 0)).rejects.toMatchObject({ code: 'NOT_A_SUBTASK' });
    expect(await repo.reorder('missing', 0)).toBeUndefined();
  });

  it('deleting a parent cascades and closes the gap in its column', async () => {
    const below = await repo.create(projectId, { title: 'below' });
    const parent = await repo.create(projectId, { title: 'parent' }); // position 0, pushes "below" to 1
    const subs = await repo.createSubtasks(parent.id, [{ title: 's1' }, { title: 's2' }]);

    expect((await repo.childIds(parent.id)).sort()).toEqual(subs.map((s) => s.id).sort());
    expect(await repo.delete(parent.id)).toBe(true);
    expect(await db.task.count({ where: { projectId } })).toBe(1);
    expect((await repo.findById(below.id))?.position).toBe(0);
  });

  it('deleting a subtask closes the gap among its siblings only', async () => {
    const other = await repo.create(projectId, { title: 'other top-level' });
    const parent = await repo.create(projectId, { title: 'parent' });
    const [s1, s2, s3] = await repo.createSubtasks(parent.id, [{ title: 's1' }, { title: 's2' }, { title: 's3' }]);

    await repo.delete(s1.id);
    expect((await repo.findById(s2.id))?.position).toBe(0);
    expect((await repo.findById(s3.id))?.position).toBe(1);
    expect((await repo.findById(other.id))?.position).toBe(1);
    expect((await repo.findById(parent.id))?.position).toBe(0);
  });

  it('imports a ticket at the end of the backlog, ignoring subtask positions', async () => {
    const parent = await repo.create(projectId, { title: 'parent', status: 'backlog' });
    const subs = await repo.createSubtasks(parent.id, [{ title: 's1' }, { title: 's2' }, { title: 's3' }]);
    await Promise.all(subs.map((s) => repo.update(s.id, { status: 'backlog' })));

    const imported = await repo.createFromTicket(projectId, { key: 'linear:1', title: 'T', description: null, ref: {} });
    expect(imported.position).toBe(1);
    expect(imported.parent_id).toBeNull();
  });
});
