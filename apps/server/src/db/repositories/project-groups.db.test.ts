import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../generated/prisma/client.js';
import { newId } from '../../lib/ids.js';
import { ProjectGroupsRepository, ProjectGroupRuleError } from './project-groups.js';

// Needs a migrated Postgres: TERMHUB_DB_TESTS=1 DATABASE_URL=… (CI sets both; see README → Development).
describe.skipIf(process.env.TERMHUB_DB_TESTS !== '1')('ProjectGroupsRepository (Postgres)', () => {
  let db: PrismaClient;
  let repo: ProjectGroupsRepository;
  let userId: string;
  let otherId: string;
  let p: string[];
  const all = () => true;

  beforeAll(() => {
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
    repo = new ProjectGroupsRepository(db);
  });

  beforeEach(async () => {
    userId = newId();
    otherId = newId();
    p = [newId(), newId(), newId()];
    await db.user.createMany({ data: [{ id: userId, email: `${userId}@t.local`, name: 'u' }, { id: otherId, email: `${otherId}@t.local`, name: 'o' }] });
    await db.project.createMany({ data: p.map((id, i) => ({ id, ownerId: userId, key: 'G' + id.replace(/[^a-z0-9]/gi, '').slice(0, 7).toUpperCase() + i, name: `p${i}` })) });
    return async () => {
      await db.project.deleteMany({ where: { id: { in: p } } });
      await db.user.deleteMany({ where: { id: { in: [userId, otherId] } } });
    };
  });

  afterAll(async () => { await db?.$disconnect(); });

  it('creates Favoritos once, even when two first reads race', async () => {
    const [a, b] = await Promise.all([repo.list(userId), repo.list(userId)]);
    expect(a.map((g) => g.kind)).toEqual(['favorites']);
    expect(b[0].id).toBe(a[0].id);
    expect(await db.projectGroup.count({ where: { userId } })).toBe(1);
  });

  it('creates, renames and deletes custom groups; Favoritos refuses both', async () => {
    const g = await repo.create(userId, '  Clientes ');
    expect(g).toMatchObject({ name: 'Clientes', kind: 'custom', position: 1, project_ids: [] });
    expect((await repo.rename(userId, g.id, 'Trabalho')).name).toBe('Trabalho');
    const fav = (await repo.list(userId))[0];
    await expect(repo.rename(userId, fav.id, 'x')).rejects.toMatchObject({ code: 'SYSTEM_GROUP' });
    await expect(repo.delete(userId, fav.id)).rejects.toMatchObject({ code: 'SYSTEM_GROUP' });
    await repo.delete(userId, g.id);
    expect((await repo.list(userId)).map((x) => x.kind)).toEqual(['favorites']);
  });

  it("another user's group is NOT_FOUND", async () => {
    const g = await repo.create(userId, 'A');
    await expect(repo.rename(otherId, g.id, 'B')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(repo.delete(otherId, g.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('reorders groups only with exactly the user ids', async () => {
    const a = await repo.create(userId, 'A');
    const fav = (await repo.list(userId))[0];
    expect((await repo.reorder(userId, [a.id, fav.id])).map((g) => g.id)).toEqual([a.id, fav.id]);
    await expect(repo.reorder(userId, [a.id])).rejects.toMatchObject({ code: 'BAD_ORDER' });
    await expect(repo.reorder(userId, [a.id, fav.id, 'x'])).rejects.toMatchObject({ code: 'BAD_ORDER' });
  });

  it('replaces memberships of two groups atomically (a move) with dense positions', async () => {
    const a = await repo.create(userId, 'A');
    const b = await repo.create(userId, 'B');
    await repo.setMemberships(userId, [{ id: a.id, project_ids: [p[0], p[1]] }], all);
    const out = await repo.setMemberships(userId, [{ id: a.id, project_ids: [p[1]] }, { id: b.id, project_ids: [p[0]] }], all);
    expect(out.find((g) => g.id === a.id)!.project_ids).toEqual([p[1]]);
    expect(out.find((g) => g.id === b.id)!.project_ids).toEqual([p[0]]);
    const rows = await db.projectGroupItem.findMany({ where: { groupId: a.id } });
    expect(rows.map((r) => r.position)).toEqual([0]);
  });

  it('a project can be in several groups (tags)', async () => {
    const a = await repo.create(userId, 'A');
    const fav = (await repo.list(userId))[0];
    const out = await repo.setMemberships(userId, [{ id: fav.id, project_ids: [p[0]] }, { id: a.id, project_ids: [p[0]] }], all);
    expect(out.filter((g) => g.project_ids.includes(p[0]))).toHaveLength(2);
  });

  it('hidden members survive a replace, after the visible ones, in their order', async () => {
    const a = await repo.create(userId, 'A');
    await repo.setMemberships(userId, [{ id: a.id, project_ids: [p[0], p[1], p[2]] }], all);
    const visible = (id: string) => id !== p[1];
    const out = await repo.setMemberships(userId, [{ id: a.id, project_ids: [p[2], p[0]] }], visible);
    expect(out.find((g) => g.id === a.id)!.project_ids).toEqual([p[2], p[0], p[1]]);
  });

  it('refuses duplicates, another user group, and nothing is written', async () => {
    const a = await repo.create(userId, 'A');
    const theirs = await repo.create(otherId, 'T');
    await expect(repo.setMemberships(userId, [{ id: a.id, project_ids: [p[0], p[0]] }], all)).rejects.toMatchObject({ code: 'DUPLICATE' });
    await expect(repo.setMemberships(userId, [{ id: a.id, project_ids: [p[0]] }, { id: theirs.id, project_ids: [p[1]] }], all)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await repo.list(userId)).find((g) => g.id === a.id)!.project_ids).toEqual([]);
  });

  it('deleting a project drops it from every group; deleting the user drops the groups', async () => {
    const a = await repo.create(userId, 'A');
    await repo.setMemberships(userId, [{ id: a.id, project_ids: [p[0], p[1]] }], all);
    await db.project.delete({ where: { id: p[0] } });
    expect((await repo.list(userId)).find((g) => g.id === a.id)!.project_ids).toEqual([p[1]]);
    await repo.create(otherId, 'OtherGroup');
    await db.user.delete({ where: { id: otherId } });
    expect(await db.projectGroup.count({ where: { userId: otherId } })).toBe(0);
  });

  it('refuses a payload that lists the same group twice, and nothing is written', async () => {
    const a = await repo.create(userId, 'A');
    await expect(repo.setMemberships(userId, [{ id: a.id, project_ids: [p[0]] }, { id: a.id, project_ids: [p[1]] }], all)).rejects.toMatchObject({ code: 'DUPLICATE' });
    expect((await repo.list(userId)).find((g) => g.id === a.id)!.project_ids).toEqual([]);
  });

  it('deleting a group renumbers the remaining ones densely', async () => {
    const a = await repo.create(userId, 'A');
    const b = await repo.create(userId, 'B');
    const c = await repo.create(userId, 'C');
    await repo.delete(userId, b.id);
    const rest = await repo.list(userId);
    expect(rest.map((g) => g.name)).toEqual(['Favoritos', 'A', 'C']);
    expect(rest.map((g) => g.position)).toEqual([0, 1, 2]);
    expect([a.id, c.id].every((id) => rest.some((g) => g.id === id))).toBe(true);
  });

  it('enforces the group limit', async () => {
    await db.projectGroup.createMany({ data: Array.from({ length: 50 }, (_, i) => ({ id: newId(), userId, name: `g${i}`, position: i + 1 })) });
    await expect(repo.create(userId, 'one more')).rejects.toBeInstanceOf(ProjectGroupRuleError);
  });
});
