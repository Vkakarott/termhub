# Sidebar project groups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-user project groups in the sidebar (Favoritos by default, user groups, Outros), with a pin toggle, a "Grupos…" popover and native drag-and-drop to add, move, copy and reorder.

**Architecture:** Two new Prisma tables (`project_groups`, `project_group_items`) behind a `ProjectGroupsRepository` and `/project-groups` routes that always act on the real logged-in user. The web keeps groups in a `ProjectGroupsProvider` with optimistic writes; pure functions (`buildSections`, `applyDrop`) decide sections and drag results so they can be tested without React; the sidebar renders them with the existing `ProjectRow`.

**Tech Stack:** Fastify + zod + Prisma 7 (Postgres) on the server; React 18 + react-router 7 + Tailwind + vitest/testing-library on the web.

**Spec:** `docs/superpowers/specs/2026-09-23-sidebar-project-groups-design.md`

## Global Constraints

- Work in `/home/pedrogoiania/termhub-wt-groups-spec` (branch `feat/sidebar-project-groups`, based on `feat/sidebar-agents-pins`). Run `npm ci` at the root once if `node_modules` is missing, then `npm run db:generate -w @termhub/server` (or the prisma generate command CLAUDE.md names).
- Never touch any Docker container or image you did not create, the deploy directory `/mnt/hd2tb/projetos/termhub`, or `deploy/blue-green.sh`. DB tests use a throwaway Postgres container you create with a unique name (`groups-pg-<random>`) and remove afterwards. Never push, open PRs or merge.
- Code, comments, commit messages in English; UI copy in pt-BR. Commit subjects imperative, area-prefixed (`Server: …`, `Web: …`). Every commit message ends with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- Groups belong to `request.user.id` (the real user), never `request.scope.ownerId`.
- Favoritos: `system_key = 'favorites'`, name `Favoritos`, cannot be renamed or deleted (409 `SYSTEM_GROUP`).
- Group name: 1–40 chars after trim. Limits: 50 groups per user, 500 items per group (400 `LIMIT`).
- All `/project-groups` routes require only `projects:read`.
- `project_ids` returned by `GET` are filtered to projects visible in the current scope; `memberships` keeps hidden members after the visible ones, in prior relative order.
- DB tests: `TERMHUB_DB_TESTS=1 DATABASE_URL=postgresql://… npm test -w @termhub/server`, after `npx prisma migrate deploy` on the throwaway DB. CI also runs the drift check in `.github/workflows` — run the same command before the last server commit.

## Review Focus

- **Admin in view-as rewrites a group:** the admin's group holds projects of their own scope that are invisible while viewing another user; a drag must not drop them. → Task 1 repository test "hidden members survive" and Task 2 route test with `ownerId` ≠ user.
- **Two tabs race creating Favoritos:** two concurrent first `GET`s must not create two Favoritos. → Task 1 test runs `ensureFavorites` twice in `Promise.all`.
- **Drop on the same place / onto a group that already has the project:** must be a no-op or a reorder, never a duplicate or a 400. → Task 3 `applyDrop` tests.
- **Request fails after an optimistic change:** the sidebar must return to the exact previous state (order included). → Task 4 provider rollback test.
- **Deleting a group whose projects are in no other group:** they must show in Outros immediately, not vanish. → Task 3 `buildSections` test + Task 5 delete test.

---

### Task 1: Schema, migration and repository

**Files:**
- Modify: `apps/server/prisma/schema.prisma` (add two models; back-relations on `User` and `Project`)
- Create: `apps/server/prisma/migrations/20260923120000_project_groups/migration.sql`
- Create: `apps/server/src/db/repositories/project-groups.ts`
- Modify: `apps/server/src/db/repositories/index.ts` (register `projectGroups`)
- Test: `apps/server/src/db/repositories/project-groups.db.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface ProjectGroup { id: string; name: string; kind: 'favorites' | 'custom'; position: number; project_ids: string[] }
  export class ProjectGroupRuleError extends Error { code: 'SYSTEM_GROUP' | 'BAD_ORDER' | 'LIMIT' | 'NOT_FOUND' | 'DUPLICATE' }
  class ProjectGroupsRepository {
    list(userId: string): Promise<ProjectGroup[]>                       // ensures Favoritos first; all items, unfiltered
    create(userId: string, name: string): Promise<ProjectGroup>
    rename(userId: string, groupId: string, name: string): Promise<ProjectGroup>
    delete(userId: string, groupId: string): Promise<void>
    reorder(userId: string, ids: string[]): Promise<ProjectGroup[]>
    setMemberships(userId: string, changes: { id: string; project_ids: string[] }[], visible: (projectId: string) => boolean): Promise<ProjectGroup[]>
  }
  ```

- [ ] **Step 1: Schema.** Add to `schema.prisma`:

```prisma
/// A user's own grouping of projects in the sidebar. system_key 'favorites' = the default
/// Favoritos group (one per user: NULLs are distinct in the unique index, so any number of
/// custom groups with a null key).
model ProjectGroup {
  id        String   @id
  userId    String   @map("user_id")
  name      String
  systemKey String?  @map("system_key")
  position  Int      @default(0)
  createdAt DateTime @default(now()) @map("created_at")
  user      User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  items     ProjectGroupItem[]

  @@unique([userId, systemKey])
  @@map("project_groups")
}

model ProjectGroupItem {
  groupId   String       @map("group_id")
  projectId String       @map("project_id")
  position  Int          @default(0)
  createdAt DateTime     @default(now()) @map("created_at")
  group     ProjectGroup @relation(fields: [groupId], references: [id], onDelete: Cascade)
  project   Project      @relation(fields: [projectId], references: [id], onDelete: Cascade)

  @@id([groupId, projectId])
  @@index([projectId])
  @@map("project_group_items")
}
```

Add `projectGroups ProjectGroup[]` to `model User` and `groupItems ProjectGroupItem[]` to `model Project`.

- [ ] **Step 2: Migration.** Generate the SQL from the schema so it matches exactly:

```bash
cd apps/server
mkdir -p prisma/migrations/20260923120000_project_groups
npx prisma migrate diff --from-migrations prisma/migrations --to-schema prisma/schema.prisma --script --config prisma.config.ts > /tmp/pg.sql
```

(If this Prisma version needs a shadow DB for `--from-migrations`, point it at the throwaway container.) Put the output into `migration.sql`, prefixed with a comment in the style of the previous migration:

```sql
-- Sidebar project groups (Favoritos + the user's own). Additive: two new tables the previous
-- container never reads, so both colors of a blue/green switch run against it safely.
```

Expected content: two `CREATE TABLE`, the unique index `project_groups_user_id_system_key_key`, index `project_group_items_project_id_idx`, three FKs with `ON DELETE CASCADE`. Then `npx prisma generate`.

- [ ] **Step 3: Write the failing repository tests** in `project-groups.db.test.ts`, same harness as `project-machines.db.test.ts` (skipIf `TERMHUB_DB_TESTS !== '1'`, PrismaPg client, fresh user + projects per test, cleanup):

```ts
import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../generated/prisma/client.js';
import { newId } from '../../lib/ids.js';
import { ProjectGroupsRepository, ProjectGroupRuleError } from './project-groups.js';

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
    await db.user.delete({ where: { id: otherId } });
  });

  it('enforces the group limit', async () => {
    await db.projectGroup.createMany({ data: Array.from({ length: 50 }, (_, i) => ({ id: newId(), userId, name: `g${i}`, position: i + 1 })) });
    await expect(repo.create(userId, 'one more')).rejects.toBeInstanceOf(ProjectGroupRuleError);
  });
});
```

- [ ] **Step 4: Run and see them fail.** Start the throwaway DB and migrate:

```bash
docker run -d --name groups-pg-$RANDOM_SUFFIX -e POSTGRES_PASSWORD=pg -e POSTGRES_DB=termhub -p 127.0.0.1:55451:5432 postgres:16-alpine
export DATABASE_URL=postgresql://postgres:pg@127.0.0.1:55451/termhub TERMHUB_DB_TESTS=1
(cd apps/server && npx prisma migrate deploy --config prisma.config.ts)
npx vitest run --root apps/server src/db/repositories/project-groups.db.test.ts
```

Expected: FAIL — module `./project-groups.js` not found.

- [ ] **Step 5: Implement `project-groups.ts`.**

```ts
import type { PrismaClient } from '../prisma.js';
import { newId } from '../../lib/ids.js';

export const FAVORITES_KEY = 'favorites';
export const MAX_GROUPS = 50;
export const MAX_ITEMS = 500;

export type ProjectGroupRuleCode = 'SYSTEM_GROUP' | 'BAD_ORDER' | 'LIMIT' | 'NOT_FOUND' | 'DUPLICATE';

export class ProjectGroupRuleError extends Error {
  constructor(readonly code: ProjectGroupRuleCode, message: string) {
    super(message);
    this.name = 'ProjectGroupRuleError';
  }
}

export interface ProjectGroup {
  id: string;
  name: string;
  kind: 'favorites' | 'custom';
  position: number;
  project_ids: string[];
}

type Row = { id: string; name: string; systemKey: string | null; position: number; items: { projectId: string }[] };
const view = (g: Row): ProjectGroup => ({ id: g.id, name: g.name, kind: g.systemKey === FAVORITES_KEY ? 'favorites' : 'custom', position: g.position, project_ids: g.items.map((i) => i.projectId) });
const INCLUDE = { items: { orderBy: [{ position: 'asc' as const }, { createdAt: 'asc' as const }], select: { projectId: true } } };

/** A user's sidebar groups. Always keyed by the real signed-in user, never the view-as owner. */
export class ProjectGroupsRepository {
  constructor(private db: PrismaClient) {}

  /** Favoritos exists for every user: created on first use, the unique (user, system_key) index makes racing creates converge. */
  private async ensureFavorites(userId: string): Promise<void> {
    const agg = await this.db.projectGroup.aggregate({ where: { userId }, _max: { position: true } });
    try {
      await this.db.projectGroup.upsert({
        where: { userId_systemKey: { userId, systemKey: FAVORITES_KEY } },
        create: { id: newId(), userId, systemKey: FAVORITES_KEY, name: 'Favoritos', position: (agg._max.position ?? -1) + 1 },
        update: {},
      });
    } catch (e) {
      // the other racer inserted first: the row is there, which is all we wanted
      if ((e as { code?: string }).code !== 'P2002') throw e;
    }
  }

  async list(userId: string): Promise<ProjectGroup[]> {
    await this.ensureFavorites(userId);
    const rows = await this.db.projectGroup.findMany({ where: { userId }, orderBy: [{ position: 'asc' }, { createdAt: 'asc' }], include: INCLUDE });
    return rows.map(view);
  }

  private async own(userId: string, groupId: string): Promise<Row> {
    const g = await this.db.projectGroup.findFirst({ where: { id: groupId, userId }, include: INCLUDE });
    if (!g) throw new ProjectGroupRuleError('NOT_FOUND', 'Grupo não encontrado');
    return g;
  }

  async create(userId: string, name: string): Promise<ProjectGroup> {
    await this.ensureFavorites(userId);
    const count = await this.db.projectGroup.count({ where: { userId } });
    if (count >= MAX_GROUPS) throw new ProjectGroupRuleError('LIMIT', `Limite de ${MAX_GROUPS} grupos`);
    const agg = await this.db.projectGroup.aggregate({ where: { userId }, _max: { position: true } });
    const g = await this.db.projectGroup.create({ data: { id: newId(), userId, name: name.trim(), position: (agg._max.position ?? -1) + 1 }, include: INCLUDE });
    return view(g);
  }

  async rename(userId: string, groupId: string, name: string): Promise<ProjectGroup> {
    const g = await this.own(userId, groupId);
    if (g.systemKey) throw new ProjectGroupRuleError('SYSTEM_GROUP', 'Favoritos não pode ser renomeado');
    return view(await this.db.projectGroup.update({ where: { id: groupId }, data: { name: name.trim() }, include: INCLUDE }));
  }

  async delete(userId: string, groupId: string): Promise<void> {
    const g = await this.own(userId, groupId);
    if (g.systemKey) throw new ProjectGroupRuleError('SYSTEM_GROUP', 'Favoritos não pode ser excluído');
    await this.db.projectGroup.delete({ where: { id: groupId } });
  }

  async reorder(userId: string, ids: string[]): Promise<ProjectGroup[]> {
    await this.ensureFavorites(userId);
    const mine = await this.db.projectGroup.findMany({ where: { userId }, select: { id: true } });
    const set = new Set(ids);
    if (set.size !== ids.length || ids.length !== mine.length || mine.some((g) => !set.has(g.id))) {
      throw new ProjectGroupRuleError('BAD_ORDER', 'A ordem precisa conter todos os seus grupos, uma vez cada');
    }
    await this.db.$transaction(ids.map((id, position) => this.db.projectGroup.update({ where: { id }, data: { position } })));
    return this.list(userId);
  }

  /**
   * Replaces the ordered members of each listed group in one transaction. `visible` says which
   * projects the caller can see right now: members it cannot see are not in the client's list,
   * so they are kept, after the visible ones, in their previous order.
   */
  async setMemberships(userId: string, changes: { id: string; project_ids: string[] }[], visible: (projectId: string) => boolean): Promise<ProjectGroup[]> {
    for (const c of changes) {
      if (new Set(c.project_ids).size !== c.project_ids.length) throw new ProjectGroupRuleError('DUPLICATE', 'Projeto repetido no mesmo grupo');
    }
    const groups = await Promise.all(changes.map((c) => this.own(userId, c.id)));
    await this.db.$transaction(async (tx) => {
      for (const [i, c] of changes.entries()) {
        const hidden = groups[i].items.map((it) => it.projectId).filter((id) => !visible(id) && !c.project_ids.includes(id));
        const next = [...c.project_ids, ...hidden];
        if (next.length > MAX_ITEMS) throw new ProjectGroupRuleError('LIMIT', `Limite de ${MAX_ITEMS} projetos por grupo`);
        await tx.projectGroupItem.deleteMany({ where: { groupId: c.id } });
        if (next.length) await tx.projectGroupItem.createMany({ data: next.map((projectId, position) => ({ groupId: c.id, projectId, position })) });
      }
    });
    return this.list(userId);
  }
}
```

Register in `index.ts`: import, `projectGroups: ProjectGroupsRepository;` in the interface, `projectGroups: new ProjectGroupsRepository(db),` in `createRepositories`. If `PrismaClient`'s interactive `$transaction` is not typed on the project's `PrismaClient` alias, follow how other repositories run transactions (`grep -rn '\$transaction' apps/server/src/db`).

- [ ] **Step 6: Run the tests until green,** then the whole server suite (`npm test -w @termhub/server` with the DB env) and `npm run typecheck -w @termhub/server`. Fix mocks of `Repositories` in other tests only if the typecheck requires it.

- [ ] **Step 7: Commit.**

```bash
git add apps/server/prisma apps/server/src/db/repositories
git commit -m "Server: project groups table and repository (Favoritos by default)" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `/project-groups` routes

**Files:**
- Create: `apps/server/src/routes/project-groups.ts`
- Modify: `apps/server/src/app.ts` (register next to `/projects`)
- Test: `apps/server/src/routes/project-groups.test.ts`

**Interfaces:**
- Consumes: `repos.projectGroups` (Task 1), `repos.projects.list({ owner })`.
- Produces (HTTP, consumed by Task 3's client):
  - `GET /project-groups` → `{ groups: ProjectGroup[] }` (project_ids filtered to the current scope)
  - `POST /project-groups` `{ name }` → 201 `{ group }`
  - `PATCH /project-groups/:id` `{ name }` → `{ group }`
  - `DELETE /project-groups/:id` → 204
  - `PUT /project-groups/order` `{ ids }` → `{ groups }`
  - `PUT /project-groups/memberships` `{ groups: [{ id, project_ids }] }` → `{ groups }`
  - Errors: `{ error, code }`; SYSTEM_GROUP 409, NOT_FOUND 404, PROJECT_NOT_FOUND 404, BAD_ORDER/LIMIT/DUPLICATE 400.

- [ ] **Step 1: Write the failing route tests** (Fastify + stubbed repos, same shape as `routes/dashboard.test.ts`):

```ts
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { Repositories } from '../db/repositories/index.js';
import { ProjectGroupRuleError } from '../db/repositories/project-groups.js';
import { applyErrorHandler } from '../lib/errors.js';
import { projectGroupRoutes } from './project-groups.js';

const fav = { id: 'g0', name: 'Favoritos', kind: 'favorites', position: 0, project_ids: ['p1', 'hidden'] };

function build(opts: { ownerId?: string | null } = {}) {
  const app = Fastify();
  applyErrorHandler(app);
  app.addHook('preHandler', async (request) => {
    request.user = { id: 'me' } as never;
    request.scope = { user: { id: 'me' } as never, viewAs: { kind: 'self' }, ownerId: opts.ownerId === undefined ? 'me' : opts.ownerId, createAs: 'me' };
  });
  const projectGroups = {
    list: vi.fn(async () => [fav]),
    create: vi.fn(async (_u: string, name: string) => ({ id: 'g1', name, kind: 'custom', position: 1, project_ids: [] })),
    rename: vi.fn(async () => ({ ...fav })),
    delete: vi.fn(async () => {}),
    reorder: vi.fn(async () => [fav]),
    setMemberships: vi.fn(async () => [fav]),
  };
  const projects = { list: vi.fn(async () => [{ id: 'p1' }, { id: 'p2' }]) };
  app.register((a) => projectGroupRoutes(a, { projectGroups, projects } as unknown as Repositories), { prefix: '/project-groups' });
  return { app, projectGroups, projects };
}

describe('project group routes', () => {
  it('GET lists the real user groups, members filtered to the current scope', async () => {
    const { app, projectGroups, projects } = build({ ownerId: 'someone-else' });
    const r = await app.inject({ method: 'GET', url: '/project-groups' });
    expect(r.statusCode).toBe(200);
    expect(projectGroups.list).toHaveBeenCalledWith('me');
    expect(projects.list).toHaveBeenCalledWith({ owner: 'someone-else' });
    expect(r.json().groups[0].project_ids).toEqual(['p1']);
  });

  it('POST validates the name and creates', async () => {
    const { app, projectGroups } = build();
    expect((await app.inject({ method: 'POST', url: '/project-groups', payload: { name: '   ' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/project-groups', payload: { name: 'x'.repeat(41) } })).statusCode).toBe(400);
    const r = await app.inject({ method: 'POST', url: '/project-groups', payload: { name: 'Clientes' } });
    expect(r.statusCode).toBe(201);
    expect(projectGroups.create).toHaveBeenCalledWith('me', 'Clientes');
  });

  it('maps rule errors: SYSTEM_GROUP 409, NOT_FOUND 404', async () => {
    const { app, projectGroups } = build();
    projectGroups.rename.mockRejectedValueOnce(new ProjectGroupRuleError('SYSTEM_GROUP', 'Favoritos não pode ser renomeado'));
    const r1 = await app.inject({ method: 'PATCH', url: '/project-groups/g0', payload: { name: 'x' } });
    expect(r1.statusCode).toBe(409);
    expect(r1.json().code).toBe('SYSTEM_GROUP');
    projectGroups.delete.mockRejectedValueOnce(new ProjectGroupRuleError('NOT_FOUND', 'Grupo não encontrado'));
    expect((await app.inject({ method: 'DELETE', url: '/project-groups/zz' })).statusCode).toBe(404);
  });

  it('DELETE answers 204', async () => {
    const { app } = build();
    expect((await app.inject({ method: 'DELETE', url: '/project-groups/g1' })).statusCode).toBe(204);
  });

  it('PUT memberships refuses a project outside the scope and writes nothing', async () => {
    const { app, projectGroups } = build();
    const r = await app.inject({ method: 'PUT', url: '/project-groups/memberships', payload: { groups: [{ id: 'g0', project_ids: ['p1', 'nope'] }] } });
    expect(r.statusCode).toBe(404);
    expect(r.json().code).toBe('PROJECT_NOT_FOUND');
    expect(projectGroups.setMemberships).not.toHaveBeenCalled();
  });

  it('PUT memberships passes the scope visibility to the repository', async () => {
    const { app, projectGroups } = build();
    const r = await app.inject({ method: 'PUT', url: '/project-groups/memberships', payload: { groups: [{ id: 'g0', project_ids: ['p2'] }] } });
    expect(r.statusCode).toBe(200);
    const [user, changes, visible] = projectGroups.setMemberships.mock.calls[0] as unknown as [string, unknown, (id: string) => boolean];
    expect(user).toBe('me');
    expect(changes).toEqual([{ id: 'g0', project_ids: ['p2'] }]);
    expect(visible('p1')).toBe(true);
    expect(visible('hidden')).toBe(false);
  });

  it('PUT order forwards the ids', async () => {
    const { app, projectGroups } = build();
    await app.inject({ method: 'PUT', url: '/project-groups/order', payload: { ids: ['g0'] } });
    expect(projectGroups.reorder).toHaveBeenCalledWith('me', ['g0']);
  });
});
```

- [ ] **Step 2: Run:** `npx vitest run --root apps/server src/routes/project-groups.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement `routes/project-groups.ts`.**

```ts
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Repositories } from '../db/repositories/index.js';
import { ProjectGroupRuleError, type ProjectGroup } from '../db/repositories/project-groups.js';
import { HttpError } from '../lib/errors.js';

const idParam = z.object({ id: z.string().min(1).max(64) });
const nameBody = z.object({ name: z.string().trim().min(1).max(40) });
const orderBody = z.object({ ids: z.array(z.string().min(1).max(64)).max(100) });
const membershipsBody = z.object({
  groups: z.array(z.object({ id: z.string().min(1).max(64), project_ids: z.array(z.string().min(1).max(64)).max(500) })).min(1).max(100),
});

/** A group is a personal view: every route only needs to read projects. */
const READ = { config: { action: 'read' } };

async function rule<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (e) {
    if (e instanceof ProjectGroupRuleError) {
      const status = e.code === 'SYSTEM_GROUP' ? 409 : e.code === 'NOT_FOUND' ? 404 : 400;
      throw new HttpError(status, e.message, e.code);
    }
    throw e;
  }
}

/** Sidebar groups of the signed-in user (never the view-as owner); members shown are the ones the current scope can see. */
export async function projectGroupRoutes(app: FastifyInstance, repos: Repositories) {
  const visibleIds = async (request: FastifyRequest) => new Set((await repos.projects.list({ owner: request.scope.ownerId })).map((p) => p.id));
  const filtered = (groups: ProjectGroup[], visible: Set<string>) => groups.map((g) => ({ ...g, project_ids: g.project_ids.filter((id) => visible.has(id)) }));

  app.get('/', READ, async (request) => {
    const [groups, visible] = await Promise.all([repos.projectGroups.list(request.user!.id), visibleIds(request)]);
    return { groups: filtered(groups, visible) };
  });

  app.post('/', READ, async (request, reply) => {
    const { name } = nameBody.parse(request.body);
    const group = await rule(() => repos.projectGroups.create(request.user!.id, name));
    return reply.code(201).send({ group });
  });

  app.patch('/:id', READ, async (request) => {
    const { id } = idParam.parse(request.params);
    const { name } = nameBody.parse(request.body);
    const group = await rule(() => repos.projectGroups.rename(request.user!.id, id, name));
    return { group: filtered([group], await visibleIds(request))[0] };
  });

  app.delete('/:id', READ, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    await rule(() => repos.projectGroups.delete(request.user!.id, id));
    return reply.code(204).send();
  });

  app.put('/order', READ, async (request) => {
    const { ids } = orderBody.parse(request.body);
    const groups = await rule(() => repos.projectGroups.reorder(request.user!.id, ids));
    return { groups: filtered(groups, await visibleIds(request)) };
  });

  app.put('/memberships', READ, async (request) => {
    const { groups: changes } = membershipsBody.parse(request.body);
    const visible = await visibleIds(request);
    if (changes.some((c) => c.project_ids.some((id) => !visible.has(id)))) throw new HttpError(404, 'Projeto não encontrado', 'PROJECT_NOT_FOUND');
    const groups = await rule(() => repos.projectGroups.setMemberships(request.user!.id, changes, (id) => visible.has(id)));
    return { groups: filtered(groups, visible) };
  });
}
```

Check `HttpError`'s constructor signature in `lib/errors.ts` (`statusCode, message, code?`) and that `applyErrorHandler` turns zod errors into 400 (the dashboard test relies on it). If `request.user` is typed non-optional, drop the `!`.

In `app.ts`, next to `await guarded('projects', (a) => projectRoutes(…), '/projects');` add:

```ts
      await guarded('projects', (a) => projectGroupRoutes(a, repos), '/project-groups');
```

`guarded` keeps a route's own `config.action`, so `READ` makes every route need only `projects:read`. Add a test in the existing permissions/app test file if there is one covering `guarded` actions (grep `actionForMethod` tests); otherwise rely on the explicit `config` and mention it in the report.

- [ ] **Step 4: Run** the route test → PASS; full server suite + typecheck + the CI drift check command from `.github/workflows` → clean.

- [ ] **Step 5: Commit.**

```bash
git add apps/server/src/routes/project-groups.ts apps/server/src/routes/project-groups.test.ts apps/server/src/app.ts
git commit -m "Server: /project-groups routes for the signed-in user's sidebar groups" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Web model — API client, `buildSections`, `applyDrop`

**Files:**
- Modify: `apps/web/src/lib/types.ts` (add `ProjectGroup`)
- Modify: `apps/web/src/lib/api.ts` (add `projectGroups` client)
- Create: `apps/web/src/lib/project-groups-model.ts`
- Test: `apps/web/src/lib/project-groups-model.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // types.ts
  export interface ProjectGroup { id: string; name: string; kind: 'favorites' | 'custom'; position: number; project_ids: string[] }
  // api.ts, inside `api`
  projectGroups: {
    list(): Promise<{ groups: ProjectGroup[] }>;
    create(name: string): Promise<{ group: ProjectGroup }>;
    rename(id: string, name: string): Promise<{ group: ProjectGroup }>;
    remove(id: string): Promise<void>;
    reorder(ids: string[]): Promise<{ groups: ProjectGroup[] }>;
    setMemberships(groups: { id: string; project_ids: string[] }[]): Promise<{ groups: ProjectGroup[] }>;
  }
  // project-groups-model.ts
  export type SectionId = 'running' | 'others' | string;           // string = group id
  export interface Section { id: SectionId; kind: 'running' | 'favorites' | 'custom' | 'others'; label: string; projects: Project[] }
  export function buildSections(projects: Project[], groups: ProjectGroup[], runningIds: Set<string>, showArchived: boolean): Section[];
  export type DragSource = { projectId: string; from: SectionId };
  export interface DropTarget { to: SectionId; index: number }   // index in the target's visible list
  export function applyDrop(groups: ProjectGroup[], drag: DragSource, drop: DropTarget, opts: { copy: boolean }): { next: ProjectGroup[]; changes: { id: string; project_ids: string[] }[] } | null;
  export function moveGroup(groups: ProjectGroup[], groupId: string, toIndex: number): ProjectGroup[];
  ```

- [ ] **Step 1: API client.** In `api.ts`, after `projects: {…}`, add (use the file's `request` helper; check how DELETE with 204 is handled by an existing call, e.g. `projects.remove`, and mirror it):

```ts
  projectGroups: {
    list: () => request<{ groups: ProjectGroup[] }>('GET', '/project-groups'),
    create: (name: string) => request<{ group: ProjectGroup }>('POST', '/project-groups', { name }),
    rename: (id: string, name: string) => request<{ group: ProjectGroup }>('PATCH', `/project-groups/${id}`, { name }),
    remove: (id: string) => request<void>('DELETE', `/project-groups/${id}`),
    reorder: (ids: string[]) => request<{ groups: ProjectGroup[] }>('PUT', '/project-groups/order', { ids }),
    setMemberships: (groups: { id: string; project_ids: string[] }[]) => request<{ groups: ProjectGroup[] }>('PUT', '/project-groups/memberships', { groups }),
  },
```

- [ ] **Step 2: Write the failing model tests:**

```ts
import { describe, expect, it } from 'vitest';
import type { Project, ProjectGroup } from './types';
import { applyDrop, buildSections, moveGroup } from './project-groups-model';

const proj = (id: string, status: Project['status'] = 'active') => ({ id, name: id, key: id.toUpperCase(), status }) as Project;
const P = [proj('a'), proj('b'), proj('c'), proj('z', 'archived')];
const G = (): ProjectGroup[] => [
  { id: 'fav', name: 'Favoritos', kind: 'favorites', position: 0, project_ids: ['a'] },
  { id: 'g1', name: 'Clientes', kind: 'custom', position: 1, project_ids: ['a', 'b'] },
  { id: 'g2', name: 'Vazio', kind: 'custom', position: 2, project_ids: [] },
];
const ids = (s: { projects: Project[] }) => s.projects.map((p) => p.id);

describe('buildSections', () => {
  it('orders running, groups by position, others; tags repeat projects', () => {
    const s = buildSections(P, G(), new Set(['a']), false);
    expect(s.map((x) => x.id)).toEqual(['running', 'fav', 'g1', 'g2', 'others']);
    expect(ids(s[0])).toEqual(['a']);
    expect(ids(s[1])).toEqual(['a']);
    expect(ids(s[2])).toEqual(['a', 'b']);
    expect(ids(s[4])).toEqual(['c']);
  });

  it('drops the running section when nothing runs; keeps empty user groups', () => {
    const s = buildSections(P, G(), new Set(), false);
    expect(s.map((x) => x.id)).toEqual(['fav', 'g1', 'g2', 'others']);
  });

  it('applies the archived filter everywhere', () => {
    const groups = G();
    groups[1].project_ids.push('z');
    expect(ids(buildSections(P, groups, new Set(['z']), false).find((x) => x.id === 'g1')!)).toEqual(['a', 'b']);
    const shown = buildSections(P, groups, new Set(['z']), true);
    expect(ids(shown[0])).toEqual(['z']);
  });

  it('a project whose only group was deleted lands in Outros', () => {
    const groups = G().filter((g) => g.id !== 'g1');
    expect(ids(buildSections(P, groups, new Set(), false).at(-1)!)).toEqual(['b', 'c']);
  });

  it('ignores member ids of projects not in the list', () => {
    const groups = G();
    groups[0].project_ids.push('gone');
    expect(ids(buildSections(P, groups, new Set(), false)[0])).toEqual(['a']);
  });
});

describe('applyDrop', () => {
  it('Outros → group adds at the index', () => {
    const r = applyDrop(G(), { projectId: 'c', from: 'others' }, { to: 'g1', index: 1 }, { copy: false })!;
    expect(r.changes).toEqual([{ id: 'g1', project_ids: ['a', 'c', 'b'] }]);
  });

  it('running → group that already has it reorders, never duplicates', () => {
    const r = applyDrop(G(), { projectId: 'b', from: 'running' }, { to: 'g1', index: 0 }, { copy: false })!;
    expect(r.changes).toEqual([{ id: 'g1', project_ids: ['b', 'a'] }]);
  });

  it('group → other group moves; with copy keeps the source', () => {
    const move = applyDrop(G(), { projectId: 'b', from: 'g1' }, { to: 'fav', index: 1 }, { copy: false })!;
    expect(move.changes).toEqual([{ id: 'g1', project_ids: ['a'] }, { id: 'fav', project_ids: ['a', 'b'] }]);
    const copy = applyDrop(G(), { projectId: 'b', from: 'g1' }, { to: 'fav', index: 1 }, { copy: true })!;
    expect(copy.changes).toEqual([{ id: 'fav', project_ids: ['a', 'b'] }]);
  });

  it('moving onto a group that already has it removes from the source and reorders the target', () => {
    const r = applyDrop(G(), { projectId: 'a', from: 'fav' }, { to: 'g1', index: 2 }, { copy: false })!;
    expect(r.changes).toEqual([{ id: 'fav', project_ids: [] }, { id: 'g1', project_ids: ['b', 'a'] }]);
  });

  it('same group reorders; index counts the list before removal', () => {
    const r = applyDrop(G(), { projectId: 'a', from: 'g1' }, { to: 'g1', index: 2 }, { copy: false })!;
    expect(r.changes).toEqual([{ id: 'g1', project_ids: ['b', 'a'] }]);
  });

  it('same place is a no-op', () => {
    expect(applyDrop(G(), { projectId: 'a', from: 'g1' }, { to: 'g1', index: 0 }, { copy: false })).toBeNull();
    expect(applyDrop(G(), { projectId: 'a', from: 'g1' }, { to: 'g1', index: 1 }, { copy: false })).toBeNull();
  });

  it('group → Outros removes from that group only', () => {
    const r = applyDrop(G(), { projectId: 'a', from: 'g1' }, { to: 'others', index: 0 }, { copy: false })!;
    expect(r.changes).toEqual([{ id: 'g1', project_ids: ['b'] }]);
    expect(r.next.find((g) => g.id === 'fav')!.project_ids).toEqual(['a']);
  });

  it('nothing drops on running, and Outros → Outros is a no-op', () => {
    expect(applyDrop(G(), { projectId: 'a', from: 'g1' }, { to: 'running', index: 0 }, { copy: false })).toBeNull();
    expect(applyDrop(G(), { projectId: 'c', from: 'others' }, { to: 'others', index: 0 }, { copy: false })).toBeNull();
  });

  it('next mirrors changes', () => {
    const r = applyDrop(G(), { projectId: 'c', from: 'others' }, { to: 'g2', index: 0 }, { copy: false })!;
    expect(r.next.find((g) => g.id === 'g2')!.project_ids).toEqual(['c']);
  });
});

describe('moveGroup', () => {
  it('moves and renumbers positions', () => {
    const r = moveGroup(G(), 'g2', 0);
    expect(r.map((g) => [g.id, g.position])).toEqual([['g2', 0], ['fav', 1], ['g1', 2]]);
  });
});
```

Note: `index` in `DropTarget` is the insertion slot in the target's list **as rendered before the drag** (0 = before first row, n = after last). For a same-group move, removing the dragged item first shifts later slots by one — the tests above pin that.

- [ ] **Step 3: Run** `npx vitest run --root apps/web src/lib/project-groups-model.test.ts` → FAIL (module missing).

- [ ] **Step 4: Implement `project-groups-model.ts`.**

```ts
import type { Project, ProjectGroup } from './types';

export type SectionId = string; // 'running' | 'others' | a group id
export interface Section { id: SectionId; kind: 'running' | 'favorites' | 'custom' | 'others'; label: string; projects: Project[] }
export type DragSource = { projectId: string; from: SectionId };
export interface DropTarget { to: SectionId; index: number }
type Change = { id: string; project_ids: string[] };

/** The sidebar's sections, top to bottom: Em execução (when anything runs), the groups by position, Outros. */
export function buildSections(projects: Project[], groups: ProjectGroup[], runningIds: Set<string>, showArchived: boolean): Section[] {
  const visible = projects.filter((p) => showArchived || p.status !== 'archived');
  const byId = new Map(visible.map((p) => [p.id, p]));
  const pick = (ids: string[]) => ids.map((id) => byId.get(id)).filter((p): p is Project => !!p);
  const sorted = [...groups].sort((a, b) => a.position - b.position);
  const grouped = new Set(sorted.flatMap((g) => g.project_ids));
  const out: Section[] = [];
  const running = visible.filter((p) => runningIds.has(p.id));
  if (running.length) out.push({ id: 'running', kind: 'running', label: 'Em execução', projects: running });
  for (const g of sorted) out.push({ id: g.id, kind: g.kind, label: g.name, projects: pick(g.project_ids) });
  out.push({ id: 'others', kind: 'others', label: 'Outros', projects: visible.filter((p) => !grouped.has(p.id)) });
  return out;
}

const insertAt = (list: string[], id: string, index: number) => {
  const next = [...list];
  next.splice(Math.max(0, Math.min(index, next.length)), 0, id);
  return next;
};
const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/** The result of dropping a project: the groups' next state and the membership writes, or null when nothing changes. */
export function applyDrop(groups: ProjectGroup[], drag: DragSource, drop: DropTarget, opts: { copy: boolean }): { next: ProjectGroup[]; changes: Change[] } | null {
  if (drop.to === 'running') return null;
  const byId = new Map(groups.map((g) => [g.id, g]));
  const source = byId.get(drag.from);
  const target = byId.get(drop.to);
  const changes: Change[] = [];

  if (drop.to === 'others') {
    if (!source) return null;
    changes.push({ id: source.id, project_ids: source.project_ids.filter((id) => id !== drag.projectId) });
  } else if (target) {
    if (source && source.id === target.id) {
      const from = target.project_ids.indexOf(drag.projectId);
      const without = target.project_ids.filter((id) => id !== drag.projectId);
      const index = from !== -1 && drop.index > from ? drop.index - 1 : drop.index;
      const next = insertAt(without, drag.projectId, index);
      if (same(next, target.project_ids)) return null;
      changes.push({ id: target.id, project_ids: next });
    } else {
      if (source && !opts.copy) changes.push({ id: source.id, project_ids: source.project_ids.filter((id) => id !== drag.projectId) });
      const from = target.project_ids.indexOf(drag.projectId);
      const without = target.project_ids.filter((id) => id !== drag.projectId);
      const index = from !== -1 && drop.index > from ? drop.index - 1 : drop.index;
      const next = insertAt(without, drag.projectId, index);
      if (!same(next, target.project_ids)) changes.push({ id: target.id, project_ids: next });
    }
  } else {
    return null;
  }

  const real = changes.filter((c) => !same(c.project_ids, byId.get(c.id)!.project_ids));
  if (!real.length) return null;
  const patch = new Map(real.map((c) => [c.id, c.project_ids]));
  return { next: groups.map((g) => (patch.has(g.id) ? { ...g, project_ids: patch.get(g.id)! } : g)), changes: real };
}

/** Moves a group to `toIndex` in position order and renumbers positions densely. */
export function moveGroup(groups: ProjectGroup[], groupId: string, toIndex: number): ProjectGroup[] {
  const sorted = [...groups].sort((a, b) => a.position - b.position);
  const from = sorted.findIndex((g) => g.id === groupId);
  if (from === -1) return groups;
  const [g] = sorted.splice(from, 1);
  sorted.splice(Math.max(0, Math.min(toIndex, sorted.length)), 0, g);
  return sorted.map((x, position) => ({ ...x, position }));
}
```

Add `ProjectGroup` to `types.ts` exactly as in Interfaces.

- [ ] **Step 5: Run** the model tests → PASS; `npm run typecheck -w @termhub/web`.

- [ ] **Step 6: Commit.**

```bash
git add apps/web/src/lib/types.ts apps/web/src/lib/api.ts apps/web/src/lib/project-groups-model.ts apps/web/src/lib/project-groups-model.test.ts
git commit -m "Web: project group sections and drop rules" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: `ProjectGroupsProvider` with optimistic writes

**Files:**
- Create: `apps/web/src/lib/project-groups.tsx`
- Modify: `apps/web/src/components/Layout.tsx` (wrap inside `DataProvider`, next to `MonitorProvider`)
- Test: `apps/web/src/lib/project-groups.test.tsx`

**Interfaces:**
- Consumes: `api.projectGroups` and `moveGroup` (Task 3); `useAuth()` for `viewAs` (reload when it changes — check the name `useAuth` exposes, `Sidebar` already destructures `viewAs` in `main`).
- Produces:
  ```ts
  interface ProjectGroupsState {
    groups: ProjectGroup[];
    error: string | null;               // last failed write, pt-BR; cleared by the next successful one
    reload(): Promise<void>;
    createGroup(name: string): Promise<ProjectGroup | null>;
    renameGroup(id: string, name: string): Promise<void>;
    deleteGroup(id: string): Promise<void>;
    reorderGroups(groupId: string, toIndex: number): Promise<void>;
    setMemberships(next: ProjectGroup[], changes: { id: string; project_ids: string[] }[]): Promise<void>;
    isFavorite(projectId: string): boolean;
    toggleFavorite(projectId: string): Promise<void>;
  }
  export function ProjectGroupsProvider({ children }): JSX.Element;
  export function useProjectGroups(): ProjectGroupsState;
  ```

- [ ] **Step 1: Write the failing tests** (mock `./api`; render a probe component inside the provider):

```tsx
// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  list: vi.fn(), create: vi.fn(), rename: vi.fn(), remove: vi.fn(), reorder: vi.fn(), setMemberships: vi.fn(),
}));
vi.mock('./api', async (orig) => ({ ...(await orig<typeof import('./api')>()), api: { projectGroups: api } }));
vi.mock('./auth', () => ({ useAuth: () => ({ viewAs: { kind: 'self' } }) }));

import { ProjectGroupsProvider, useProjectGroups } from './project-groups';

const fav = { id: 'fav', name: 'Favoritos', kind: 'favorites' as const, position: 0, project_ids: ['a'] };
const g1 = { id: 'g1', name: 'Clientes', kind: 'custom' as const, position: 1, project_ids: [] as string[] };
let state: ReturnType<typeof useProjectGroups>;
function Probe() {
  state = useProjectGroups();
  return <p data-testid="out">{state.groups.map((g) => `${g.name}:${g.project_ids.join(',')}`).join('|')}{state.error ? ` !${state.error}` : ''}</p>;
}
const mount = async () => {
  api.list.mockResolvedValue({ groups: [fav, g1] });
  render(<ProjectGroupsProvider><Probe /></ProjectGroupsProvider>);
  await screen.findByText('Favoritos:a|Clientes:');
};

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('ProjectGroupsProvider', () => {
  it('toggleFavorite adds then removes, optimistically', async () => {
    await mount();
    let resolve!: (v: unknown) => void;
    api.setMemberships.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    act(() => { void state.toggleFavorite('b'); });
    expect(screen.getByTestId('out')).toHaveTextContent('Favoritos:a,b|Clientes:');
    expect(api.setMemberships).toHaveBeenCalledWith([{ id: 'fav', project_ids: ['a', 'b'] }]);
    await act(async () => resolve({ groups: [{ ...fav, project_ids: ['a', 'b'] }, g1] }));
    expect(state.isFavorite('b')).toBe(true);
  });

  it('rolls back to the exact previous state when a write fails', async () => {
    await mount();
    api.setMemberships.mockRejectedValueOnce(new Error('boom'));
    await act(async () => { await state.setMemberships([{ ...fav, project_ids: [] }, { ...g1, project_ids: ['a'] }], [{ id: 'fav', project_ids: [] }, { id: 'g1', project_ids: ['a'] }]); });
    expect(screen.getByTestId('out')).toHaveTextContent('Favoritos:a|Clientes:');
    expect(screen.getByTestId('out')).toHaveTextContent('!');
  });

  it('create, rename, delete and reorder hit the API and update the list', async () => {
    await mount();
    api.create.mockResolvedValueOnce({ group: { id: 'g2', name: 'Novo grupo', kind: 'custom', position: 2, project_ids: [] } });
    await act(async () => { await state.createGroup('Novo grupo'); });
    expect(screen.getByTestId('out')).toHaveTextContent('Novo grupo:');
    api.rename.mockResolvedValueOnce({ group: { id: 'g2', name: 'Outro nome', kind: 'custom', position: 2, project_ids: [] } });
    await act(async () => { await state.renameGroup('g2', 'Outro nome'); });
    expect(screen.getByTestId('out')).toHaveTextContent('Outro nome:');
    api.remove.mockResolvedValueOnce(undefined);
    await act(async () => { await state.deleteGroup('g2'); });
    expect(screen.getByTestId('out')).not.toHaveTextContent('Outro nome');
    api.reorder.mockResolvedValueOnce({ groups: [{ ...g1, position: 0 }, { ...fav, position: 1 }] });
    await act(async () => { await state.reorderGroups('g1', 0); });
    expect(api.reorder).toHaveBeenCalledWith(['g1', 'fav']);
    expect(screen.getByTestId('out')).toHaveTextContent('Clientes:|Favoritos:a');
  });
});
```

- [ ] **Step 2: Run** → FAIL (module missing).

- [ ] **Step 3: Implement `project-groups.tsx`.**

```tsx
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api } from './api';
import { useAuth } from './auth';
import { moveGroup } from './project-groups-model';
import type { ProjectGroup } from './types';

interface ProjectGroupsState { /* as in Interfaces */ }

const Ctx = createContext<ProjectGroupsState | null>(null);
const FAILED = 'Não foi possível salvar os grupos. Tente de novo.';

/** The signed-in user's sidebar groups. Writes show at once and roll back when the server refuses them. */
export function ProjectGroupsProvider({ children }: { children: ReactNode }) {
  const { viewAs } = useAuth();
  const [groups, setGroupsState] = useState<ProjectGroup[]>([]);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef(groups);
  const setGroups = (g: ProjectGroup[]) => {
    ref.current = g;
    setGroupsState(g);
  };

  const reload = useCallback(async () => {
    try {
      setGroups((await api.projectGroups.list()).groups);
    } catch {
      /* sidebar still works without groups: everything shows in Outros */
    }
  }, []);
  // members are filtered by the current scope, so a view-as switch changes them
  useEffect(() => { void reload(); }, [reload, viewAs]);

  /** Applies `next` now, runs the request, keeps the server's answer or restores the previous state. */
  const optimistic = useCallback(async (next: ProjectGroup[], send: () => Promise<ProjectGroup[] | null>) => {
    const prev = ref.current;
    setGroups(next);
    try {
      const fromServer = await send();
      if (fromServer) setGroups(fromServer);
      setError(null);
    } catch {
      setGroups(prev);
      setError(FAILED);
    }
  }, []);

  const value = useMemo<ProjectGroupsState>(() => {
    const favorites = () => ref.current.find((g) => g.kind === 'favorites');
    return {
      groups,
      error,
      reload,
      createGroup: async (name) => {
        try {
          const { group } = await api.projectGroups.create(name);
          setGroups([...ref.current, group]);
          setError(null);
          return group;
        } catch {
          setError(FAILED);
          return null;
        }
      },
      renameGroup: (id, name) =>
        optimistic(ref.current.map((g) => (g.id === id ? { ...g, name } : g)), async () => {
          const { group } = await api.projectGroups.rename(id, name);
          return ref.current.map((g) => (g.id === id ? group : g));
        }),
      deleteGroup: (id) =>
        optimistic(ref.current.filter((g) => g.id !== id), async () => {
          await api.projectGroups.remove(id);
          return null;
        }),
      reorderGroups: (groupId, toIndex) => {
        const next = moveGroup(ref.current, groupId, toIndex);
        return optimistic(next, async () => (await api.projectGroups.reorder(next.map((g) => g.id))).groups);
      },
      setMemberships: (next, changes) => optimistic(next, async () => (await api.projectGroups.setMemberships(changes)).groups),
      isFavorite: (projectId) => !!favorites()?.project_ids.includes(projectId),
      toggleFavorite: (projectId) => {
        const fav = favorites();
        if (!fav) return Promise.resolve();
        const project_ids = fav.project_ids.includes(projectId) ? fav.project_ids.filter((id) => id !== projectId) : [...fav.project_ids, projectId];
        const next = ref.current.map((g) => (g.id === fav.id ? { ...g, project_ids } : g));
        return optimistic(next, async () => (await api.projectGroups.setMemberships([{ id: fav.id, project_ids }])).groups);
      },
    };
  }, [groups, error, reload, optimistic]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useProjectGroups(): ProjectGroupsState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useProjectGroups fora do ProjectGroupsProvider');
  return ctx;
}
```

Note: `isFavorite` reads `ref.current`, which is updated synchronously by `setGroups`, so it is correct right after a write. In `Layout.tsx`, wrap `<ProjectGroupsProvider>` just inside `<MonitorProvider>` so the Sidebar and everything it renders can use it. Existing tests that render `Sidebar` must then mock `../lib/project-groups` (done in Task 5).

- [ ] **Step 4: Run** → PASS; web typecheck.

- [ ] **Step 5: Commit.**

```bash
git add apps/web/src/lib/project-groups.tsx apps/web/src/lib/project-groups.test.tsx apps/web/src/components/Layout.tsx
git commit -m "Web: project groups provider with optimistic writes" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Sidebar sections, pin, "Grupos…" popover, group header actions

**Files:**
- Modify: `apps/web/src/components/Sidebar.tsx`
- Modify: `apps/web/src/components/ProjectRow.tsx` (pin + Grupos… actions)
- Create: `apps/web/src/components/GroupHeader.tsx`
- Create: `apps/web/src/components/ProjectGroupsMenu.tsx`
- Modify: `apps/web/src/lib/sidebar-prefs.ts` (collapsed groups + Outros open)
- Test: `apps/web/src/components/Sidebar.test.tsx` (extend), `apps/web/src/components/ProjectGroupsMenu.test.tsx`

**Interfaces:**
- Consumes: `buildSections` (Task 3), `useProjectGroups()` (Task 4), existing `ProjectRow`, `useMonitor().openTabs`, `loadCollapsedProjects/saveCollapsedProjects`.
- Produces:
  ```ts
  // sidebar-prefs.ts
  export function loadCollapsedGroups(): Set<string>;   // section ids ('others' included) that are collapsed
  export function saveCollapsedGroups(ids: Set<string>): void;
  // ProjectRow new props
  favorite: boolean; onToggleFavorite: () => void; onOpenGroups: (anchor: HTMLElement) => void;
  dragProps?: React.HTMLAttributes<HTMLLIElement>;        // Task 6 fills this
  // GroupHeader
  export function GroupHeader(props: { section: Section; collapsed: boolean; onToggle(): void; editable: boolean; onRename(name: string): void; onDelete(): void; startEditing?: boolean; headerDragProps?: React.HTMLAttributes<HTMLDivElement> }): JSX.Element;
  // ProjectGroupsMenu
  export function ProjectGroupsMenu(props: { projectId: string; anchor: HTMLElement; onClose(): void }): JSX.Element;
  ```

Behaviour (copy is pt-BR, exact strings):

- Sections from `buildSections(projects, groups, runningIds, showArchived)` where `runningIds` = project ids with at least one tab in `openTabs` (the existing `agentsByProject`).
- **Em execução** header: plain label like today (not collapsible, no actions).
- **Group header** (`GroupHeader`): chevron button (`aria-expanded`, label `Recolher {name}` / `Expandir {name}`), name, count `· n`. For custom groups, hover actions: ✎ (`title="Renomear grupo"`) turns the name into an input (Enter saves if trimmed non-empty ≤40 chars, Esc cancels, blur saves); ✕ (`title="Excluir grupo"`) opens the sidebar's `ConfirmDialog` with title `Excluir grupo`, message `Excluir o grupo "{name}"? Os projetos não são apagados.`, confirm label `Excluir`. Favoritos has no ✎/✕. An empty group (and not collapsed) shows `<p>` "arraste projetos para cá" in a dashed box.
- **Outros**: a `GroupHeader`-like accordion (chevron + "Outros · n"), collapsed state stored under id `'others'` in `loadCollapsedGroups`; the "mostrar arquivados"/"ocultar arquivados" toggle moves inside it, below its rows.
- Header row: "Projetos" label, then the existing collapse-all button, then a `+ grupo` button (`title="Novo grupo"`, visible to everyone who sees the sidebar) that calls `createGroup('Novo grupo')` and puts that group's header into rename mode (`startEditing`).
- `ProjectRow` hover actions become: 📌 pin, `⋯` Grupos, ✎, ✕. The pin button: `aria-pressed={favorite}`, `aria-label`/`title` "Tirar de Favoritos" when favorite else "Fixar em Favoritos"; when `favorite`, the pin is **always visible** (render it outside the hover-only span, dimmed accent), otherwise only on hover. The `⋯` button: `title="Grupos…"`, `aria-haspopup="menu"`, calls `onOpenGroups(e.currentTarget)`.
- `ProjectGroupsMenu`: an absolutely positioned popover under the anchor (`role="menu"`), one `role="menuitemcheckbox"` per group (Favoritos first, then by position) with `aria-checked`; toggling one calls `setMemberships` with that group's list plus/minus the project (appended at the end when added). A last item "Novo grupo…" shows an inline input; Enter creates the group and adds the project to it. Closes on Esc and on outside mousedown.
- `error` from `useProjectGroups()` renders once under the header row as `<p role="alert" className="px-3 text-[11px] text-danger">`.
- Collapse-all acts on projects with agents across every section (unchanged rule: any expanded → collapse all).

- [ ] **Step 1: Write failing tests.** In `Sidebar.test.tsx`, add a mock for the provider next to the existing mocks, controlled per test:

```tsx
const groupsState = vi.hoisted(() => ({
  groups: [] as import('../lib/types').ProjectGroup[],
  error: null as string | null,
  createGroup: vi.fn(async () => null), renameGroup: vi.fn(async () => {}), deleteGroup: vi.fn(async () => {}),
  reorderGroups: vi.fn(async () => {}), setMemberships: vi.fn(async () => {}), reload: vi.fn(async () => {}),
  toggleFavorite: vi.fn(async () => {}),
  isFavorite: (id: string) => groupsState.groups.some((g) => g.kind === 'favorites' && g.project_ids.includes(id)),
}));
vi.mock('../lib/project-groups', () => ({ useProjectGroups: () => groupsState }));
```

Reset `groupsState.groups = []` and the mocks in `afterEach`. Tests (use the file's existing project/tab fixtures and `within`):

```tsx
it('renders sections in order: Em execução, Favoritos, custom groups, Outros', () => {
  groupsState.groups = [
    { id: 'fav', name: 'Favoritos', kind: 'favorites', position: 0, project_ids: ['p1'] },
    { id: 'g1', name: 'Clientes', kind: 'custom', position: 1, project_ids: ['p1', 'p2'] },
  ];
  // p1 has an open tab in the monitor fixture
  mount();
  const labels = screen.getAllByRole('region').map((r) => r.getAttribute('aria-label'));
  expect(labels).toEqual(['Em execução', 'Favoritos', 'Clientes', 'Outros']);
  expect(within(screen.getByRole('region', { name: 'Clientes' })).getAllByRole('link', { name: /p1|p2/ }).length).toBeGreaterThanOrEqual(2);
  expect(within(screen.getByRole('region', { name: 'Outros' })).queryByText('p1')).toBeNull();
});

it('the pin toggles Favoritos and is pressed for favorites', () => {
  groupsState.groups = [{ id: 'fav', name: 'Favoritos', kind: 'favorites', position: 0, project_ids: ['p1'] }];
  mount();
  const favRegion = screen.getByRole('region', { name: 'Favoritos' });
  expect(within(favRegion).getByRole('button', { name: 'Tirar de Favoritos' })).toHaveAttribute('aria-pressed', 'true');
  fireEvent.click(within(screen.getByRole('region', { name: 'Outros' })).getAllByRole('button', { name: 'Fixar em Favoritos' })[0]);
  expect(groupsState.toggleFavorite).toHaveBeenCalled();
});

it('Outros is an accordion and keeps its state', () => {
  mount();
  const toggle = within(screen.getByRole('region', { name: 'Outros' })).getByRole('button', { name: 'Recolher Outros' });
  fireEvent.click(toggle);
  expect(localStorage.getItem('termhub:sidebar:collapsed-groups')).toContain('others');
});

it('renames and deletes a custom group, never Favoritos', async () => {
  groupsState.groups = [
    { id: 'fav', name: 'Favoritos', kind: 'favorites', position: 0, project_ids: [] },
    { id: 'g1', name: 'Clientes', kind: 'custom', position: 1, project_ids: [] },
  ];
  mount();
  expect(within(screen.getByRole('region', { name: 'Favoritos' })).queryByTitle('Renomear grupo')).toBeNull();
  const g1 = screen.getByRole('region', { name: 'Clientes' });
  fireEvent.click(within(g1).getByTitle('Renomear grupo'));
  const input = within(g1).getByRole('textbox');
  fireEvent.change(input, { target: { value: 'Trabalho' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(groupsState.renameGroup).toHaveBeenCalledWith('g1', 'Trabalho');
  fireEvent.click(within(g1).getByTitle('Excluir grupo'));
  fireEvent.click(screen.getByRole('button', { name: 'Excluir' }));
  await waitFor(() => expect(groupsState.deleteGroup).toHaveBeenCalledWith('g1'));
});

it('an empty group shows the drop hint', () => {
  groupsState.groups = [{ id: 'g1', name: 'Vazio', kind: 'custom', position: 0, project_ids: [] }];
  mount();
  expect(within(screen.getByRole('region', { name: 'Vazio' })).getByText('arraste projetos para cá')).toBeInTheDocument();
});

it('+ grupo creates "Novo grupo"', () => {
  mount();
  fireEvent.click(screen.getByTitle('Novo grupo'));
  expect(groupsState.createGroup).toHaveBeenCalledWith('Novo grupo');
});

it('shows the groups error', () => {
  groupsState.error = 'Não foi possível salvar os grupos. Tente de novo.';
  mount();
  expect(screen.getByRole('alert')).toHaveTextContent('Não foi possível salvar');
});
```

Adapt existing Sidebar tests whose section names changed (the old unlabeled "Todos os projetos" region becomes "Outros"; projects in groups no longer show there). Keep every existing assertion about agents, collapse-all and archived.

`ProjectGroupsMenu.test.tsx`:

```tsx
// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  groups: [
    { id: 'g1', name: 'Clientes', kind: 'custom', position: 1, project_ids: ['p1'] },
    { id: 'fav', name: 'Favoritos', kind: 'favorites', position: 0, project_ids: [] },
  ],
  setMemberships: vi.fn(async () => {}),
  createGroup: vi.fn(async (name: string) => ({ id: 'g9', name, kind: 'custom', position: 2, project_ids: [] })),
}));
vi.mock('../lib/project-groups', () => ({ useProjectGroups: () => state }));
import { ProjectGroupsMenu } from './ProjectGroupsMenu';

afterEach(() => { cleanup(); vi.clearAllMocks(); });
const mount = (onClose = vi.fn()) => { const a = document.createElement('button'); document.body.appendChild(a); render(<ProjectGroupsMenu projectId="p1" anchor={a} onClose={onClose} />); return onClose; };

describe('ProjectGroupsMenu', () => {
  it('lists Favoritos first with the checked state', () => {
    mount();
    const items = screen.getAllByRole('menuitemcheckbox');
    expect(items.map((i) => i.textContent)).toEqual([expect.stringContaining('Favoritos'), expect.stringContaining('Clientes')]);
    expect(items[1]).toHaveAttribute('aria-checked', 'true');
  });

  it('checking adds at the end, unchecking removes', () => {
    mount();
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: /Favoritos/ }));
    expect(state.setMemberships).toHaveBeenLastCalledWith(expect.anything(), [{ id: 'fav', project_ids: ['p1'] }]);
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: /Clientes/ }));
    expect(state.setMemberships).toHaveBeenLastCalledWith(expect.anything(), [{ id: 'g1', project_ids: [] }]);
  });

  it('"Novo grupo…" creates the group and adds the project to it', async () => {
    mount();
    fireEvent.click(screen.getByText('Novo grupo…'));
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'Pessoal' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await vi.waitFor(() => expect(state.setMemberships).toHaveBeenLastCalledWith(expect.anything(), [{ id: 'g9', project_ids: ['p1'] }]));
  });

  it('Esc closes', () => {
    const onClose = mount();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
});
```

(`setMemberships(next, changes)`: build `next` by replacing that group's `project_ids` in `state.groups`.)

- [ ] **Step 2: Run** both files → FAIL.

- [ ] **Step 3: Implement.** Add to `sidebar-prefs.ts`:

```ts
const GROUPS_KEY = 'termhub:sidebar:collapsed-groups';

export function loadCollapsedGroups(): Set<string> {
  try {
    const raw = localStorage.getItem(GROUPS_KEY);
    const ids: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

export function saveCollapsedGroups(ids: Set<string>): void {
  try {
    localStorage.setItem(GROUPS_KEY, JSON.stringify([...ids]));
  } catch {
    /* not persisted: the in-memory state still works */
  }
}
```

Then build `GroupHeader`, `ProjectGroupsMenu`, the new `ProjectRow` props and the Sidebar section loop per the behaviour list above. Each section renders `<section aria-label={label}>` with its header and `<ul>` of `row(p, section.id)`; React keys for rows are `${section.id}:${p.id}` because a project can repeat. The Grupos popover is rendered once by the Sidebar (`menuFor: { projectId, anchor } | null`).

- [ ] **Step 4: Run** the two test files, then the whole web suite, typecheck, build → green.

- [ ] **Step 5: Commit.**

```bash
git add apps/web/src
git commit -m "Web: sidebar groups — Favoritos pin, user groups, Outros accordion" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Drag and drop

**Files:**
- Create: `apps/web/src/lib/sidebar-dnd.ts` (drag payload + drop-index helpers)
- Modify: `apps/web/src/components/Sidebar.tsx`, `ProjectRow.tsx`, `GroupHeader.tsx`
- Test: `apps/web/src/components/Sidebar.dnd.test.tsx`

**Interfaces:**
- Consumes: `applyDrop`, `moveGroup` semantics (Task 3), `setMemberships`, `reorderGroups` (Task 4), `ProjectRow.dragProps`, `GroupHeader.headerDragProps` (Task 5).
- Produces:
  ```ts
  // sidebar-dnd.ts
  export const PROJECT_MIME = 'application/x-termhub-project';
  export const GROUP_MIME = 'application/x-termhub-group';
  export function encodeProjectDrag(d: DragSource): string;   // JSON
  export function decodeProjectDrag(raw: string): DragSource | null;
  /** slot for a drop on a row: before it when the pointer is in its top half, after otherwise */
  export function slotFor(rowIndex: number, clientY: number, rect: { top: number; height: number }): number;
  ```

Behaviour:

- Every `ProjectRow` `<li>` is `draggable`; `onDragStart` sets `effectAllowed = 'copyMove'` and `setData(PROJECT_MIME, encodeProjectDrag({ projectId, from: section.id }))`, and remembers the drag in a ref (jsdom's `dataTransfer` is limited, like `TasksBoard` does with `drag?.taskId`).
- Drop targets: each row (slot via `slotFor`), each group's `<ul>`/empty hint (slot = list length), each group header (slot = end), the Outros section. `onDragOver` calls `preventDefault()` only when the target accepts (never for Em execução) and sets `dropEffect` to `copy` when `e.altKey` and the source is a group, else `move`; it stores `{ to, index }` to draw a 2px accent line (`border-t-2 border-accent` on the row at that slot, or at the list end).
- `onDrop`: `applyDrop(groups, drag, { to, index }, { copy: e.altKey })`; when non-null, `setMemberships(result.next, result.changes)`. Clear the indicator on drop, `dragend` and `dragleave` of the section.
- Group headers of Favoritos and custom groups are `draggable` with `GROUP_MIME`; dropping a group on another group's header puts it at that header's index (`reorderGroups(id, index)`); Em execução/Outros headers are not draggable and not group-drop targets. A project drag over a header never reorders groups, and a group drag over rows is ignored.
- Rows in Em execução and Outros are draggable too (sources `running` / `others`).

- [ ] **Step 1: Write failing tests** in `Sidebar.dnd.test.tsx` (same mocks as `Sidebar.test.tsx`; `fireEvent.dragStart/dragOver/drop` with a fake `dataTransfer`):

```tsx
const dt = () => { const store: Record<string, string> = {}; return { setData: (k: string, v: string) => (store[k] = v), getData: (k: string) => store[k] ?? '', effectAllowed: '', dropEffect: '', types: [] as string[] }; };
const rowIn = (region: string, name: string) => within(screen.getByRole('region', { name: region })).getByRole('link', { name: new RegExp(name) }).closest('li')!;

it('Outros → group adds the project', () => {
  groupsState.groups = [{ id: 'g1', name: 'Clientes', kind: 'custom', position: 0, project_ids: [] }];
  mount();
  const data = dt();
  fireEvent.dragStart(rowIn('Outros', 'p2'), { dataTransfer: data });
  const target = within(screen.getByRole('region', { name: 'Clientes' })).getByText('arraste projetos para cá');
  fireEvent.dragOver(target, { dataTransfer: data });
  fireEvent.drop(target, { dataTransfer: data });
  expect(groupsState.setMemberships).toHaveBeenCalledWith(expect.anything(), [{ id: 'g1', project_ids: ['p2'] }]);
});

it('group → group moves, and with Alt copies', () => {
  groupsState.groups = [
    { id: 'fav', name: 'Favoritos', kind: 'favorites', position: 0, project_ids: [] },
    { id: 'g1', name: 'Clientes', kind: 'custom', position: 1, project_ids: ['p2'] },
  ];
  mount();
  let data = dt();
  fireEvent.dragStart(rowIn('Clientes', 'p2'), { dataTransfer: data });
  const favHint = within(screen.getByRole('region', { name: 'Favoritos' })).getByText('arraste projetos para cá');
  fireEvent.dragOver(favHint, { dataTransfer: data });
  fireEvent.drop(favHint, { dataTransfer: data });
  expect(groupsState.setMemberships).toHaveBeenLastCalledWith(expect.anything(), [{ id: 'g1', project_ids: [] }, { id: 'fav', project_ids: ['p2'] }]);
  data = dt();
  fireEvent.dragStart(rowIn('Clientes', 'p2'), { dataTransfer: data });
  fireEvent.dragOver(favHint, { dataTransfer: data, altKey: true });
  fireEvent.drop(favHint, { dataTransfer: data, altKey: true });
  expect(groupsState.setMemberships).toHaveBeenLastCalledWith(expect.anything(), [{ id: 'fav', project_ids: ['p2'] }]);
});

it('group → Outros removes from that group', () => {
  groupsState.groups = [{ id: 'g1', name: 'Clientes', kind: 'custom', position: 0, project_ids: ['p2'] }];
  mount();
  const data = dt();
  fireEvent.dragStart(rowIn('Clientes', 'p2'), { dataTransfer: data });
  const outros = screen.getByRole('region', { name: 'Outros' });
  fireEvent.dragOver(outros, { dataTransfer: data });
  fireEvent.drop(outros, { dataTransfer: data });
  expect(groupsState.setMemberships).toHaveBeenCalledWith(expect.anything(), [{ id: 'g1', project_ids: [] }]);
});

it('Em execução is not a drop target', () => {
  groupsState.groups = [{ id: 'g1', name: 'Clientes', kind: 'custom', position: 0, project_ids: ['p1'] }];
  mount(); // p1 running
  const data = dt();
  fireEvent.dragStart(rowIn('Clientes', 'p1'), { dataTransfer: data });
  const running = screen.getByRole('region', { name: 'Em execução' });
  fireEvent.drop(running, { dataTransfer: data });
  expect(groupsState.setMemberships).not.toHaveBeenCalled();
});

it('dragging a group header onto another reorders groups', () => {
  groupsState.groups = [
    { id: 'fav', name: 'Favoritos', kind: 'favorites', position: 0, project_ids: [] },
    { id: 'g1', name: 'Clientes', kind: 'custom', position: 1, project_ids: [] },
  ];
  mount();
  const data = dt();
  fireEvent.dragStart(within(screen.getByRole('region', { name: 'Clientes' })).getByText('Clientes'), { dataTransfer: data });
  const favHeader = within(screen.getByRole('region', { name: 'Favoritos' })).getByText('Favoritos');
  fireEvent.dragOver(favHeader, { dataTransfer: data });
  fireEvent.drop(favHeader, { dataTransfer: data });
  expect(groupsState.reorderGroups).toHaveBeenCalledWith('g1', 0);
});
```

Plus unit tests for `sidebar-dnd.ts`: `decodeProjectDrag` rejects garbage (`'{'`, `'{}'`, `'{"projectId":1}'`), `slotFor(3, y, rect)` → 3 in the top half, 4 in the bottom half.

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement** `sidebar-dnd.ts` and the handlers per the behaviour list. Keep the drag state in the Sidebar (`useRef<DragSource | { groupId: string } | null>`), reading `dataTransfer` first and falling back to the ref.

- [ ] **Step 4: Run** the new tests, the full web suite, typecheck and build → green.

- [ ] **Step 5: Commit.**

```bash
git add apps/web/src
git commit -m "Web: drag projects between sidebar groups and reorder groups" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```
