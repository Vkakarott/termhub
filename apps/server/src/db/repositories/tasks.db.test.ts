import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../generated/prisma/client.js';
import { newId } from '../../lib/ids.js';
import { MAX_SUBTASKS_PER_CALL, TaskRuleError, TasksRepository } from './tasks.js';

const keyOf = (id: string) => 'K' + id.replace(/[^a-z0-9]/gi, '').slice(0, 8).toUpperCase();

// Needs a migrated Postgres: TERMHUB_DB_TESTS=1 DATABASE_URL=… (CI sets both; see the plan/README for the local Docker recipe).
describe.skipIf(process.env.TERMHUB_DB_TESTS !== '1')('TasksRepository (Postgres)', () => {
  let db: PrismaClient;
  let repo: TasksRepository;
  let machineId: string;
  let projectId: string;
  let otherProjectId: string;
  let key: string;

  beforeAll(() => {
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
    repo = new TasksRepository(db);
  });

  beforeEach(async () => {
    machineId = newId();
    projectId = newId();
    otherProjectId = newId();
    key = keyOf(projectId);
    await db.machine.create({ data: { id: machineId, name: 'test', type: 'agent' } });
    await db.project.createMany({
      data: [
        { id: projectId, key, name: 'p' },
        { id: otherProjectId, key: keyOf(otherProjectId), name: 'other' },
      ],
    });
    return async () => {
      await db.project.deleteMany({ where: { id: { in: [projectId, otherProjectId] } } }); // cascades tasks and columns
      await db.machine.delete({ where: { id: machineId } });
    };
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  const titles = (ts: { title: string }[]) => ts.map((t) => t.title);
  /** A board column of the project (the defaults exist after the first write). */
  const column = async (category: 'todo' | 'doing' | 'done', pid = projectId) =>
    (await db.taskColumn.findFirst({ where: { projectId: pid, category }, orderBy: { position: 'asc' } }))!;
  const epics = async (pid = projectId) => db.task.findMany({ where: { projectId: pid, type: 'epic' }, orderBy: { number: 'asc' } });
  const inColumn = async (columnId: string) => titles(await db.task.findMany({ where: { columnId }, orderBy: { position: 'asc' } }));
  const inBacklog = async (epicId: string) => titles(await db.task.findMany({ where: { epicId, status: 'backlog' }, orderBy: { position: 'asc' } }));
  const addColumn = async (name: string, category: 'todo' | 'doing' | 'done', position: number) =>
    db.taskColumn.create({ data: { id: newId(), projectId, name, category, position } });

  it('finds tasks by id in one query, filtered to one owner — another owner\'s task does not resolve', async () => {
    const ownerId = newId();
    const otherOwnerId = newId();
    const otherMachineId = newId();
    const foreignProjectId = newId();
    await db.user.createMany({ data: [
      { id: ownerId, email: `${ownerId}@test.local`, name: 'owner' },
      { id: otherOwnerId, email: `${otherOwnerId}@test.local`, name: 'other' },
    ] });
    try {
      await db.project.update({ where: { id: projectId }, data: { ownerId } });
      await db.machine.create({ data: { id: otherMachineId, name: 'theirs', type: 'agent', ownerId: otherOwnerId } });
      await db.project.create({ data: { id: foreignProjectId, ownerId: otherOwnerId, key: keyOf(foreignProjectId), name: 'p2' } });

      const mine = await repo.create(projectId, { title: 'mine' });
      const theirs = await repo.create(foreignProjectId, { title: 'theirs' });

      const found = await repo.findByIdsForOwner([mine.id, theirs.id, 'nope'], ownerId);
      expect(titles(found)).toEqual(['mine']);
      expect(found[0].ref).toBe(`${key}-${mine.number}`);
      expect(await repo.findByIdsForOwner([], ownerId)).toEqual([]);
    } finally {
      await db.project.deleteMany({ where: { id: foreignProjectId } });
      await db.machine.deleteMany({ where: { id: otherMachineId } });
      await db.user.deleteMany({ where: { id: { in: [ownerId, otherOwnerId] } } });
    }
  });

  describe('numbers, refs and the default epic', () => {
    it('creates the default epic "Geral" with the first card, numbers cards in order and builds the ref', async () => {
      const a = await repo.create(projectId, { title: 'a' });
      const b = await repo.create(projectId, { title: 'b' });
      const [epic] = await epics();
      expect(epic).toMatchObject({ title: 'Geral', number: 1, status: 'backlog', columnId: null, epicId: null });
      expect([a.number, b.number]).toEqual([2, 3]);
      expect(a).toMatchObject({ type: 'task', ref: `${key}-2`, epic_id: epic.id, column_id: (await column('todo')).id, status: 'todo' });
      expect((await db.project.findUniqueOrThrow({ where: { id: projectId } })).nextTaskNumber).toBe(4);
    });

    it('never reuses a number after a delete', async () => {
      await repo.create(projectId, { title: 'a' });
      const b = await repo.create(projectId, { title: 'b' });
      await repo.delete(b.id);
      expect((await repo.create(projectId, { title: 'c' })).number).toBe(4);
    });

    it('creates the default epic once and numbers cards uniquely under concurrency', async () => {
      const made = await Promise.all(Array.from({ length: 8 }, (_, i) => repo.create(projectId, { title: `c${i}` })));
      const all = await epics();
      expect(all).toHaveLength(1);
      expect(new Set(made.map((t) => t.epic_id))).toEqual(new Set([all[0].id]));
      expect(made.map((t) => t.number).sort((x, y) => x - y)).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
      const positions = (await db.task.findMany({ where: { columnId: (await column('todo')).id } })).map((t) => t.position);
      expect(positions.sort((x, y) => x - y)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    });

    it('finds a card by its number, only in its own project', async () => {
      const a = await repo.create(projectId, { title: 'a' });
      expect((await repo.findByRef(projectId, a.number))?.id).toBe(a.id);
      expect(await repo.findByRef(otherProjectId, a.number)).toBeUndefined();
      expect(await repo.findByRef(projectId, 999)).toBeUndefined();
    });
  });

  describe('hierarchy and placement on create', () => {
    it('an epic has no epic and starts in the backlog; other types start in the first todo column', async () => {
      const epic = await repo.create(projectId, { title: 'Checkout', type: 'epic' });
      expect(epic).toMatchObject({ type: 'epic', epic_id: null, column_id: null, status: 'backlog' });
      const bug = await repo.create(projectId, { title: 'crash', type: 'bug' });
      expect(bug).toMatchObject({ type: 'bug', status: 'todo', column_id: (await column('todo')).id });
      // "Checkout" is the lowest-numbered epic, so it is the default one: no "Geral" appears
      expect(bug.epic_id).toBe(epic.id);
      expect(titles(await epics())).toEqual(['Checkout']);
    });

    it('puts a card under the epic it names, and refuses an epic of another project or a card that is not an epic', async () => {
      await repo.create(projectId, { title: 'first' });
      const checkout = await repo.create(projectId, { title: 'Checkout', type: 'epic' });
      const story = await repo.create(projectId, { title: 'pay', type: 'story', epic_id: checkout.id });
      expect(story.epic_id).toBe(checkout.id);
      const foreign = await repo.create(otherProjectId, { title: 'theirs', type: 'epic' });
      await expect(repo.create(projectId, { title: 'x', epic_id: foreign.id })).rejects.toMatchObject({ code: 'EPIC_NOT_FOUND', message: 'Épico não encontrado' });
      await expect(repo.create(projectId, { title: 'x', epic_id: story.id })).rejects.toMatchObject({ code: 'EPIC_NOT_FOUND' });
    });

    it('column_id wins over status and sets the category; a column of another project is refused', async () => {
      await repo.create(projectId, { title: 'first' });
      const qa = await addColumn('QA', 'doing', 3);
      expect(await repo.create(projectId, { title: 'in qa', column_id: qa.id, status: 'todo' })).toMatchObject({ column_id: qa.id, status: 'doing' });
      await repo.create(otherProjectId, { title: 'there' });
      const theirs = await column('todo', otherProjectId);
      await expect(repo.create(projectId, { title: 'x', column_id: theirs.id })).rejects.toMatchObject({ code: 'COLUMN_NOT_FOUND' });
    });

    it('a new card goes to the top of its column, a backlog item to the top of its epic backlog', async () => {
      await repo.create(projectId, { title: 't1' });
      await repo.create(projectId, { title: 't2' });
      const b1 = await repo.create(projectId, { title: 'b1', status: 'backlog' });
      await repo.create(projectId, { title: 'b2', status: 'backlog' });
      const other = await repo.create(projectId, { title: 'Other', type: 'epic' });
      await repo.create(projectId, { title: 'o1', status: 'backlog', epic_id: other.id });
      expect(await inColumn((await column('todo')).id)).toEqual(['t2', 't1']);
      expect(await inBacklog(b1.epic_id!)).toEqual(['b2', 'b1']);
      expect(await inBacklog(other.id)).toEqual(['o1']);
    });
  });

  describe('subtasks', () => {
    it('appends subtasks in call order and nests them in the list', async () => {
      const parent = await repo.create(projectId, { title: 'parent' });
      await repo.createSubtasks(parent.id, [{ title: 's1' }, { title: 's2' }]);
      await repo.create(projectId, { title: 's3', parent_id: parent.id });

      const list = (await repo.listByProject(projectId)).filter((t) => t.type !== 'epic');
      expect(titles(list)).toEqual(['parent']);
      expect(titles(list[0].subtasks)).toEqual(['s1', 's2', 's3']);
      expect(list[0].subtasks.map((s) => s.position)).toEqual([0, 1, 2]);
      expect(list[0].subtasks.every((s) => s.type === 'subtask' && s.epic_id === null && s.column_id === null && s.project_id === projectId && s.external_key === null)).toBe(true);
      expect(list[0].subtask_counts).toEqual({ done: 0, total: 3 });
    });

    it('only a story or a task holds subtasks', async () => {
      const bug = await repo.create(projectId, { title: 'bug', type: 'bug' });
      const epic = await repo.create(projectId, { title: 'E', type: 'epic' });
      const story = await repo.create(projectId, { title: 's', type: 'story' });
      const [child] = await repo.createSubtasks(story.id, [{ title: 'c' }]);
      await expect(repo.createSubtasks(bug.id, [{ title: 'x' }])).rejects.toMatchObject({ code: 'PARENT_TYPE', message: 'Subtarefa só pode ficar em uma história ou tarefa' });
      await expect(repo.createSubtasks(epic.id, [{ title: 'x' }])).rejects.toMatchObject({ code: 'PARENT_TYPE' });
      await expect(repo.createSubtasks(child.id, [{ title: 'x' }])).rejects.toMatchObject({ code: 'PARENT_IS_SUBTASK' });
      await expect(repo.createWithSubtasks(projectId, { title: 'b', type: 'spike' }, [{ title: 'x' }])).rejects.toMatchObject({ code: 'PARENT_TYPE' });
      await expect(repo.create(projectId, { title: 'orphan', type: 'subtask' })).rejects.toMatchObject({ code: 'PARENT_NOT_FOUND' });
    });

    it('creates a task with its subtasks in one call, at the top of its column', async () => {
      const older = await repo.create(projectId, { title: 'older' });
      const t = await repo.createWithSubtasks(projectId, { title: 'spec', description: 'd', status: 'todo' }, [{ title: 'a' }, { title: 'b', description: 'bd' }]);
      expect(t).toMatchObject({ title: 'spec', description: 'd', status: 'todo', position: 0, parent_id: null, type: 'task', subtask_counts: { done: 0, total: 2 } });
      expect(t.subtasks.map((s) => [s.title, s.position, s.parent_id, s.project_id, s.type])).toEqual([['a', 0, t.id, projectId, 'subtask'], ['b', 1, t.id, projectId, 'subtask']]);
      expect((await repo.findById(older.id))?.position).toBe(1);
    });

    it('creates a task with no subtasks through the same call', async () => {
      const t = await repo.createWithSubtasks(projectId, { title: 'alone' }, []);
      expect(t).toMatchObject({ title: 'alone', status: 'todo', subtasks: [], subtask_counts: { done: 0, total: 0 } });
    });

    it('rejects too many subtasks in createWithSubtasks, creating nothing', async () => {
      const many = Array.from({ length: MAX_SUBTASKS_PER_CALL + 1 }, (_, i) => ({ title: `s${i}` }));
      await expect(repo.createWithSubtasks(projectId, { title: 'x' }, many)).rejects.toMatchObject({ code: 'TOO_MANY_SUBTASKS' } satisfies Partial<TaskRuleError>);
      expect(await db.task.count({ where: { projectId } })).toBe(0);
    });

    it('rejects a call over the per-call cap, creating nothing', async () => {
      const parent = await repo.create(projectId, { title: 'parent' });
      const items = Array.from({ length: MAX_SUBTASKS_PER_CALL + 1 }, (_, i) => ({ title: `s${i}` }));
      await expect(repo.createSubtasks(parent.id, items)).rejects.toMatchObject({ code: 'TOO_MANY_SUBTASKS' });
      expect(await repo.childIds(parent.id)).toEqual([]);
    });

    it('keeps sibling positions distinct under concurrent createSubtasks calls on the same parent', async () => {
      const parent = await repo.create(projectId, { title: 'parent' });
      await Promise.all([
        repo.createSubtasks(parent.id, [{ title: 'a1' }, { title: 'a2' }]),
        repo.createSubtasks(parent.id, [{ title: 'b1' }, { title: 'b2' }]),
      ]);
      const positions = (await db.task.findMany({ where: { parentId: parent.id } })).map((s) => s.position).sort((a, b) => a - b);
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
      expect(first.position).toBe(1);
    });

    it('changes a subtask status in place, without touching positions or the parent', async () => {
      const parent = await repo.create(projectId, { title: 'parent' });
      const [s1, s2] = await repo.createSubtasks(parent.id, [{ title: 's1' }, { title: 's2' }]);
      const updated = await repo.update(s2.id, { status: 'done', title: 's2 renamed' });
      expect(updated).toMatchObject({ status: 'done', title: 's2 renamed', position: 1, parent_id: parent.id, column_id: null });
      expect((await repo.findById(s1.id))?.position).toBe(0);
      expect((await repo.findById(parent.id))?.status).toBe('todo');
    });

    it('reorders siblings and clamps an out-of-range position', async () => {
      const parent = await repo.create(projectId, { title: 'parent' });
      const [a, , c] = await repo.createSubtasks(parent.id, [{ title: 'a' }, { title: 'b' }, { title: 'c' }]);
      await repo.reorder(c.id, 0);
      await repo.reorder(a.id, 999);
      const subs = await db.task.findMany({ where: { parentId: parent.id }, orderBy: { position: 'asc' } });
      expect(titles(subs)).toEqual(['c', 'b', 'a']);
      expect(subs.map((s) => s.position)).toEqual([0, 1, 2]);
    });

    it('refuses to reorder a top-level task', async () => {
      const parent = await repo.create(projectId, { title: 'parent' });
      await expect(repo.reorder(parent.id, 0)).rejects.toMatchObject({ code: 'NOT_A_SUBTASK' });
      expect(await repo.reorder('missing', 0)).toBeUndefined();
    });
  });

  describe('moves', () => {
    it('moves by column and by status, closing the gap it leaves and opening one where it lands', async () => {
      await repo.create(projectId, { title: 'a' });
      const b = await repo.create(projectId, { title: 'b' });
      const c = await repo.create(projectId, { title: 'c' }); // todo: c, b, a
      const doing = await column('doing');
      expect(await repo.move(b.id, { column_id: doing.id }, 0)).toMatchObject({ column_id: doing.id, status: 'doing', position: 0 });
      expect(await inColumn((await column('todo')).id)).toEqual(['c', 'a']);
      expect(await repo.move(c.id, { status: 'done' }, 99)).toMatchObject({ column_id: (await column('done')).id, status: 'done', position: 0 });
      expect(await repo.move(b.id, { status: 'backlog' }, 0)).toMatchObject({ column_id: null, status: 'backlog', position: 0, epic_id: b.epic_id });
      expect(await inColumn(doing.id)).toEqual([]);
    });

    it('reorders inside one column, keeping positions compact', async () => {
      const a = await repo.create(projectId, { title: 'a' });
      await repo.create(projectId, { title: 'b' });
      await repo.create(projectId, { title: 'c' }); // c, b, a
      const todo = await column('todo');
      await repo.move(a.id, { status: 'todo' }, 0);
      expect(await inColumn(todo.id)).toEqual(['a', 'c', 'b']);
      await repo.move(a.id, { column_id: todo.id }, 2);
      expect(await inColumn(todo.id)).toEqual(['c', 'b', 'a']);
      expect((await db.task.findMany({ where: { columnId: todo.id }, orderBy: { position: 'asc' } })).map((t) => t.position)).toEqual([0, 1, 2]);
    });

    it('refuses to move a subtask, and to an unknown column', async () => {
      const parent = await repo.create(projectId, { title: 'parent' });
      const [s1] = await repo.createSubtasks(parent.id, [{ title: 's1' }]);
      await expect(repo.move(s1.id, { status: 'done' }, 0)).rejects.toMatchObject({ code: 'SUBTASK_CANNOT_MOVE' });
      await expect(repo.move(parent.id, { column_id: 'nope' }, 0)).rejects.toMatchObject({ code: 'COLUMN_NOT_FOUND' });
      expect(await repo.move('missing', { status: 'done' }, 0)).toBeUndefined();
    });
  });

  describe('update', () => {
    it('a status change lands at the top of the first column of that category', async () => {
      const a = await repo.create(projectId, { title: 'a', status: 'doing' });
      const b = await repo.create(projectId, { title: 'b' });
      expect(await repo.update(b.id, { status: 'doing', title: 'b2' })).toMatchObject({ title: 'b2', status: 'doing', column_id: (await column('doing')).id, position: 0 });
      expect((await repo.findById(a.id))?.position).toBe(1);
    });

    it('changes type among story/task/bug/spike and keeps epics, subtasks and cards with subtasks in their lane', async () => {
      const t = await repo.create(projectId, { title: 't' });
      expect((await repo.update(t.id, { type: 'bug' }))?.type).toBe('bug');
      const story = await repo.create(projectId, { title: 's', type: 'story' });
      const [sub] = await repo.createSubtasks(story.id, [{ title: 'c' }]);
      await expect(repo.update(story.id, { type: 'spike' })).rejects.toMatchObject({ code: 'HAS_SUBTASKS' });
      expect((await repo.update(story.id, { type: 'task' }))?.type).toBe('task');
      const [epic] = await epics();
      await expect(repo.update(epic.id, { type: 'story' })).rejects.toMatchObject({ code: 'TYPE_LOCKED' });
      await expect(repo.update(sub.id, { type: 'task' })).rejects.toMatchObject({ code: 'TYPE_LOCKED' });
    });

    it('moves a card to another epic; a backlog item lands at the top of the new epic backlog', async () => {
      const onBoard = await repo.create(projectId, { title: 'board' });
      const x = await repo.create(projectId, { title: 'x', status: 'backlog' });
      const y = await repo.create(projectId, { title: 'y', status: 'backlog' });
      const other = await repo.create(projectId, { title: 'Other', type: 'epic' });
      await repo.create(projectId, { title: 'o', status: 'backlog', epic_id: other.id });
      expect(await repo.update(x.id, { epic_id: other.id })).toMatchObject({ epic_id: other.id, position: 0, status: 'backlog' });
      expect(await inBacklog(other.id)).toEqual(['x', 'o']);
      expect(await inBacklog(y.epic_id!)).toEqual(['y']);
      expect(await repo.update(onBoard.id, { epic_id: other.id })).toMatchObject({ epic_id: other.id, column_id: onBoard.column_id, position: onBoard.position });
      await expect(repo.update(x.id, { epic_id: null })).rejects.toMatchObject({ code: 'EPIC_REQUIRED', message: 'Escolha um épico' });
      await expect(repo.update(x.id, { epic_id: onBoard.id })).rejects.toMatchObject({ code: 'EPIC_NOT_FOUND' });
    });

    it('answers undefined for a missing card', async () => {
      expect(await repo.update('missing', { title: 'x' })).toBeUndefined();
    });
  });

  describe('startWork', () => {
    it('sends a card to the first doing column, or to the agent column when the project sets one', async () => {
      const a = await repo.create(projectId, { title: 'a' });
      expect(await repo.startWork(a.id)).toMatchObject({ status: 'doing', column_id: (await column('doing')).id, position: 0 });
      const review = await addColumn('Revisão', 'doing', 3);
      await db.project.update({ where: { id: projectId }, data: { agentColumnId: review.id } });
      const b = await repo.create(projectId, { title: 'b' });
      expect(await repo.startWork(b.id)).toMatchObject({ status: 'doing', column_id: review.id });
    });

    it('leaves a card already in a doing column where it is, and marks a subtask doing', async () => {
      const doing = await repo.create(projectId, { title: 'd', status: 'doing' });
      const review = await addColumn('Revisão', 'doing', 3);
      await db.project.update({ where: { id: projectId }, data: { agentColumnId: review.id } });
      expect((await repo.startWork(doing.id))?.column_id).toBe(doing.column_id);
      const parent = await repo.create(projectId, { title: 'p', type: 'story' });
      const [s] = await repo.createSubtasks(parent.id, [{ title: 's' }]);
      expect(await repo.startWork(s.id)).toMatchObject({ status: 'doing', column_id: null, parent_id: parent.id });
      expect(await repo.startWork('missing')).toBeUndefined();
    });
  });

  describe('delete', () => {
    it('refuses to delete an epic that still has cards; an empty epic goes', async () => {
      const card = await repo.create(projectId, { title: 'c' });
      const epicId = card.epic_id!;
      await expect(repo.delete(epicId)).rejects.toMatchObject({ code: 'EPIC_HAS_CHILDREN', message: 'Este épico ainda tem cards' });
      await repo.delete(card.id);
      expect(await repo.delete(epicId)).toBe(true);
    });

    it('deleting a parent cascades and closes the gap in its column', async () => {
      const below = await repo.create(projectId, { title: 'below' });
      const parent = await repo.create(projectId, { title: 'parent' });
      const subs = await repo.createSubtasks(parent.id, [{ title: 's1' }, { title: 's2' }]);
      expect((await repo.childIds(parent.id)).sort()).toEqual(subs.map((s) => s.id).sort());
      expect(await repo.delete(parent.id)).toBe(true);
      expect(await db.task.count({ where: { projectId, type: { not: 'epic' } } })).toBe(1);
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

    it('deleting a backlog item closes the gap in its epic backlog', async () => {
      const a = await repo.create(projectId, { title: 'a', status: 'backlog' });
      const b = await repo.create(projectId, { title: 'b', status: 'backlog' });
      await repo.create(projectId, { title: 'c', status: 'backlog' }); // c, b, a
      await repo.delete(b.id);
      expect(await inBacklog(a.epic_id!)).toEqual(['c', 'a']);
      expect((await repo.findById(a.id))?.position).toBe(1);
    });
  });

  it('imports a ticket as a task at the end of the default epic backlog, ignoring subtask positions', async () => {
    const parent = await repo.create(projectId, { title: 'parent', status: 'backlog' });
    const subs = await repo.createSubtasks(parent.id, [{ title: 's1' }, { title: 's2' }, { title: 's3' }]);
    await Promise.all(subs.map((s) => repo.update(s.id, { status: 'backlog' })));
    const imported = await repo.createFromTicket(projectId, { key: 'linear:1', title: 'T', description: null, ref: {} });
    expect(imported).toMatchObject({ type: 'task', status: 'backlog', column_id: null, epic_id: parent.epic_id, position: 1, parent_id: null, external_key: 'linear:1' });
  });

  it('keeps subtasks out of open counts and the dashboard "doing" list', async () => {
    const parent = await repo.create(projectId, { title: 'parent', status: 'doing' });
    const [s1] = await repo.createSubtasks(parent.id, [{ title: 's1' }, { title: 's2' }]);
    await repo.update(s1.id, { status: 'doing' });
    expect((await repo.openCountByProject())[projectId]).toBe(1);
    expect(titles((await repo.listDoing()).filter((t) => t.project_id === projectId))).toEqual(['parent']);
  });

  describe('officeProgress', () => {
    it('counts top-level todo/doing/done per project and leaves the backlog and subtasks out', async () => {
      await repo.create(projectId, { title: 'b', status: 'backlog' });
      await repo.create(projectId, { title: 't', status: 'todo' });
      const doing = await repo.create(projectId, { title: 'd', status: 'doing' });
      await repo.create(projectId, { title: 'x', status: 'done' });
      await repo.createSubtasks(doing.id, [{ title: 's1' }, { title: 's2' }]);
      const { counts } = await repo.officeProgress([projectId]);
      expect(counts[projectId]).toEqual({ todo: 1, doing: 1, done: 1 });
    });

    it('reports the doing task bound to a tab with its subtask counts', async () => {
      const tabId = newId();
      await db.tab.create({ data: { id: tabId, projectId, machineId, name: 't', tmuxSession: `th-${tabId}` } });
      const doing = await repo.create(projectId, { title: 'Ship it', status: 'doing' });
      await repo.setTab(doing.id, tabId);
      const subs = await repo.createSubtasks(doing.id, [{ title: 's1' }, { title: 's2' }, { title: 's3' }]);
      await repo.update(subs[0].id, { status: 'done' });
      const { byTab } = await repo.officeProgress([projectId]);
      expect(byTab[tabId]).toEqual({ task_id: doing.id, title: 'Ship it', done: 1, total: 3 });
    });

    it('ignores a bound task that is not in doing, and picks the first by position when two are', async () => {
      const tabId = newId();
      await db.tab.create({ data: { id: tabId, projectId, machineId, name: 't', tmuxSession: `th-${tabId}` } });
      const todo = await repo.create(projectId, { title: 'not doing', status: 'todo' });
      await repo.setTab(todo.id, tabId);
      expect((await repo.officeProgress([projectId])).byTab[tabId]).toBeUndefined();
      const earlier = await repo.create(projectId, { title: 'earlier', status: 'doing' });
      const later = await repo.create(projectId, { title: 'later', status: 'doing' });
      await repo.setTab(earlier.id, tabId);
      await repo.setTab(later.id, tabId);
      expect((await repo.officeProgress([projectId])).byTab[tabId].title).toBe('later');
    });

    it('answers empty for no projects without touching the database', async () => {
      expect(await repo.officeProgress([])).toEqual({ counts: {}, byTab: {} });
    });
  });
});
