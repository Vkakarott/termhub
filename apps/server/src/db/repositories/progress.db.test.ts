import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../generated/prisma/client.js';
import { newId } from '../../lib/ids.js';
import { ProgressRepository } from './progress.js';

const keyOf = (id: string) => 'G' + id.replace(/[^a-z0-9]/gi, '').slice(0, 8).toUpperCase();

// Needs a migrated Postgres: TERMHUB_DB_TESTS=1 DATABASE_URL=… (CI sets both).
describe.skipIf(process.env.TERMHUB_DB_TESTS !== '1')('tasks progress trigger (Postgres)', () => {
  let db: PrismaClient;
  let projectId: string;

  beforeAll(() => {
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
  });
  afterAll(async () => db.$disconnect());

  beforeEach(async () => {
    projectId = newId();
    await db.project.create({ data: { id: projectId, key: keyOf(projectId), name: 'p' } });
    return async () => {
      await db.project.delete({ where: { id: projectId } });
    };
  });

  const card = (status: 'backlog' | 'todo' | 'doing' | 'done' = 'todo') =>
    db.task.create({ data: { id: newId(), projectId, title: 't', type: 'task', status } });

  it('stamps started_at the first time a card goes to doing and keeps it afterwards', async () => {
    const t = await card();
    expect(t.startedAt).toBeNull();
    const doing = await db.task.update({ where: { id: t.id }, data: { status: 'doing' } });
    expect(doing.startedAt).toBeInstanceOf(Date);
    const back = await db.task.update({ where: { id: t.id }, data: { status: 'todo' } });
    expect(back.startedAt).toEqual(doing.startedAt);
  });

  it('stamps done_at when a row becomes done, clears it when reopened, stamps again when redone', async () => {
    const t = await card('doing');
    const done = await db.task.update({ where: { id: t.id }, data: { status: 'done' } });
    expect(done.doneAt).toBeInstanceOf(Date);
    const reopened = await db.task.update({ where: { id: t.id }, data: { status: 'todo' } });
    expect(reopened.doneAt).toBeNull();
    const again = await db.task.update({ where: { id: t.id }, data: { status: 'done' } });
    expect(again.doneAt).toBeInstanceOf(Date);
  });

  it('keeps done_at when a done row is written with status done again', async () => {
    const t = await card('done');
    expect(t.doneAt).toBeInstanceOf(Date);
    await db.$executeRaw`UPDATE "tasks" SET "done_at" = '2026-01-01T00:00:00Z' WHERE "id" = ${t.id}`;
    const same = await db.task.update({ where: { id: t.id }, data: { status: 'done', title: 'renamed' } });
    expect(same.doneAt?.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  it('defaults active_seconds to 0', async () => {
    expect((await card()).activeSeconds).toBe(0);
  });
});

describe.skipIf(process.env.TERMHUB_DB_TESTS !== '1')('ProgressRepository.list (Postgres)', () => {
  let db: PrismaClient;
  let repo: ProgressRepository;
  let ownerId: string;
  let otherOwnerId: string;
  let machineId: string;
  let projectId: string;
  let otherProjectId: string;
  let key: string;

  beforeAll(() => {
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
    repo = new ProgressRepository(db);
  });
  afterAll(async () => db.$disconnect());

  beforeEach(async () => {
    [ownerId, otherOwnerId, machineId, projectId, otherProjectId] = [newId(), newId(), newId(), newId(), newId()];
    key = keyOf(projectId);
    await db.user.createMany({
      data: [
        { id: ownerId, email: `${ownerId}@t.dev`, name: 'Owner' },
        { id: otherOwnerId, email: `${otherOwnerId}@t.dev`, name: 'Other' },
      ],
    });
    await db.machine.create({ data: { id: machineId, name: 'jarvis', type: 'agent', ownerId } });
    await db.project.createMany({ data: [{ id: projectId, key, name: 'mine', ownerId }, { id: otherProjectId, key: keyOf(otherProjectId), name: 'theirs', ownerId: otherOwnerId }] });
    return async () => {
      await db.project.deleteMany({ where: { id: { in: [projectId, otherProjectId] } } });
      await db.machine.delete({ where: { id: machineId } });
      await db.user.deleteMany({ where: { id: { in: [ownerId, otherOwnerId] } } });
    };
  });

  it('returns epics with cards, subtasks, column names and linked tabs, scoped by owner', async () => {
    const epicId = newId();
    const cardId = newId();
    const tabId = newId();
    await db.task.create({ data: { id: epicId, projectId, title: 'Épico', type: 'epic', status: 'backlog' } });
    await db.tab.create({ data: { id: tabId, projectId, machineId, name: 'agent', state: 'waiting_input', stateAt: new Date() } });
    await db.task.create({ data: { id: cardId, projectId, title: 'Card', type: 'story', status: 'doing', epicId, tabId } });
    await db.task.create({ data: { id: newId(), projectId, title: 'Sub', type: 'subtask', status: 'done', parentId: cardId } });
    await db.task.create({ data: { id: newId(), projectId: otherProjectId, title: 'Outro', type: 'epic', status: 'backlog' } });

    const rows = await repo.list({ owner: ownerId, projectId: null });
    expect(rows.map((e) => e.title)).toEqual(['Épico']);
    const [card] = rows[0].cards;
    expect(card).toMatchObject({ id: cardId, status: 'doing', active_seconds: 0, tab: { id: tabId, machine_name: 'jarvis', state: 'waiting_input' } });
    expect(card.ref).toMatch(new RegExp(`^${key}-\\d+$`));
    expect(card.started_at).toBeInstanceOf(Date);
    expect(card.subtasks).toHaveLength(1);
    expect(card.subtasks[0].done_at).toBeInstanceOf(Date);
    expect(rows[0].project).toEqual({ id: projectId, key, name: 'mine' });
  });

  it('filters by project and skips archived projects', async () => {
    await db.task.create({ data: { id: newId(), projectId, title: 'Épico', type: 'epic', status: 'backlog' } });
    expect(await repo.list({ owner: null, projectId: otherProjectId })).toEqual([]);
    await db.project.update({ where: { id: projectId }, data: { status: 'archived' } });
    expect(await repo.list({ owner: ownerId, projectId })).toEqual([]);
  });
});
