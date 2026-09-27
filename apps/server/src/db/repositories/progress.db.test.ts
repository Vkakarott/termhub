import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../generated/prisma/client.js';
import { newId } from '../../lib/ids.js';

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
