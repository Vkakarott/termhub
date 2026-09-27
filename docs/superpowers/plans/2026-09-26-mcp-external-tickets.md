# MCP external tickets — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The concierge and personal API tokens can list, read, sync, import and push external tickets (Linear, Jira, GitHub issues) through the termhub MCP, with several ticket sources per project, open tickets only, paginated up to 500 per source.

**Architecture:**
- The provider layer paginates and returns `{ tickets, truncated }`.
- The project setup moves from one `tickets` source to `ticket_sources[]`, keeping `tickets` as a mirror of the first source for the previous release.
- The sync runs per source and prunes by `(integration_id, scope)`.
- A new `control/tickets.ts` holds list/get/sync/import/push logic shared by the REST routes and five new MCP tools.
- The chat gate classifies the tools, and the action cards read them as sentences.
- The web shows ticket title + key subtitle and edits a list of sources.

**Tech Stack:** Fastify, Prisma 6 (Postgres, generated client committed under `apps/server/src/generated/prisma`), zod, vitest, React + Testing Library (web).

**Spec:** `docs/superpowers/specs/2026-09-26-mcp-external-tickets-design.md`

## Global Constraints

- "ref" is always the termhub card (`TER-12`); "key" is always the ticket (`EI-123`, `PROJ-45`, `owner/repo#12`).
- Database column names do not change: `tickets.identifier`, `tickets.external_key`, `tasks.external_ref`, `tasks.external_key`. New names live in Prisma (`@map`) and in TypeScript.
- Migrations are additive only: the previous container keeps serving while the new one migrates.
- The saved setup keeps a `tickets` field mirroring `ticket_sources[0]` (with `include_done: false`) or `null`.
- The `tasks.external_ref` JSON keeps writing `identifier` (= key) and `id` (= provider id) next to the new `key`/`provider_id`/`integration_id`: the previous release reads `identifier` and `id`.
- Open tickets only: GitHub `state=open`; Linear state type not in `completed`, `canceled`; Jira `statusCategory != Done`.
- `MAX_TICKETS_PER_SOURCE = 500`; hitting it sets `truncated: true`.
- Sync throttle for the tool/route: 60 s per project, in memory.
- `list_tickets`: `limit` default 50, max 200; descriptions cut to 500 characters in lists, full in `get_ticket`.
- Import: max 200 per call; creates cards in the default epic's backlog; the card title is the ticket title with **no** key prefix; cards imported before are not rewritten.
- Gate classes:
  - `list_tickets` and `get_ticket` are read;
  - `sync_tickets` and `import_tickets` are write;
  - `push_ticket_status` is irreversible.
- Grants and token scopes:

  | Tool | Token scope | Grant |
  |---|---|---|
  | `list_tickets` | `read` | `tickets:read` |
  | `get_ticket` | `read` | `tickets:read` |
  | `sync_tickets` | `tasks` | `tickets:update` |
  | `import_tickets` | `tasks` | `tasks:create` |
  | `push_ticket_status` | `tasks` | `tasks:update` |

- Errors are `HttpError` (`apps/server/src/lib/errors.ts`) with these codes:

  | Code | Status |
  |---|---|
  | `NO_TICKET_SOURCE` | 400 |
  | `TICKET_NOT_FOUND` | 404 |
  | `TICKET_AMBIGUOUS` | 409 |
  | `NOT_LINKED` | 400 |
  | `SOURCE_NOT_FOUND` | 400 |
  | `PROVIDER_ERROR` | 502 |
  | `DUPLICATE_SOURCE` | 400 |

  Messages are pt-BR. The spec says `ControlError`. `HttpError` is used instead because the REST error handler already maps it and the MCP route already catches both. That is the same contract, and `scoped.*` already throws `HttpError`.
- Ticket content (titles, descriptions) is never logged. Logs carry projectId, provider, scope and counts.
- UI copy in pt-BR; code, comments, commits in English.
- Routes never import Prisma; data access goes through `apps/server/src/db/repositories`.

## Review Focus

1. **Two sources on the same integration**, for example one GitHub token with two repos, or one Linear workspace with two teams. Syncing one source must not delete the other source's non-imported tickets. This is pinned in Task 5 (`tickets-sync.test.ts`, "two sources on one integration").
2. **A setup saved by the previous release after this one**: the old zod strips `ticket_sources`, so the setup has `tickets` only. Normalize must rebuild `ticket_sources` from `tickets` and lose nothing. This is pinned in Task 4 (`schema.test.ts`, "rebuilds sources when only tickets is present").
3. **`#12` typed while two repos have an issue 12**: the answer must be `TICKET_AMBIGUOUS` listing both keys, never an import of the wrong one. The same key in two projects without a `project_id` must be ambiguous too. This is pinned in Task 6.
4. **Cards imported before the change**:
   - GitHub cards carry `identifier: '#12'` and no `key`, and must still show `owner/repo#12`.
   - Their push-status must find the source by `provider + scope` when `integration_id` is missing.

   This is pinned in Task 2 (`readTicketLink`) and Task 6 (`pushTicketStatus` legacy link).
5. **Linear with a state-name filter**: today the name filter overwrites the open-only filter (both write `state`), which would pull closed tickets. It must combine the two. This is pinned in Task 3 (`linear.test.ts`, "keeps open-only with a name filter").

---

## How to run things

This checkout's host may lack Node, so run everything through Docker from the worktree root.

```bash
cd /home/pedrogoiania/termhub/.claude/worktrees/mcp-external-tickets
NODE() { docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/w" -w /w node:20 sh -c "$1"; }
NODE 'npm ci && npm run build:packages'     # once
```

- Server unit tests: `NODE 'npm test -w @termhub/server -- <file>'`
- Web tests: `NODE 'npm test -w @termhub/web -- <file>'`
- Typecheck: `NODE 'npm run typecheck -w @termhub/server'`
- After each session: `rm -rf .npm`

DB tests (Task 1 only) need a throwaway Postgres. Container and network names are `th-*` only (see CLAUDE.md):

```bash
docker network create th-net-tickets
docker run -d --name th-test-db-tickets --network th-net-tickets -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=termhub postgres:16-alpine
until docker exec th-test-db-tickets pg_isready -U postgres -d termhub >/dev/null 2>&1; do sleep 1; done
NODEDB() { docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp --network th-net-tickets \
  -e DATABASE_URL=postgresql://postgres:postgres@th-test-db-tickets:5432/termhub -v "$PWD:/w" -w /w node:20 sh -c "$1"; }
```

Teardown in Task 10: `docker rm -f th-test-db-tickets && docker network rm th-net-tickets`.

## File Structure

| File | Responsibility |
|---|---|
| `apps/server/prisma/schema.prisma` | `Ticket`: `key @map("identifier")`, `syncKey @map("external_key")`, new `scope String?` |
| `apps/server/prisma/migrations/20260927000000_tickets_scope/migration.sql` | add `tickets.scope`, backfill from `meta->>'scope'`, index |
| `apps/server/src/db/repositories/types.ts` | `Ticket` type (`key`, `sync_key`, `scope`), `mapTicket` |
| `apps/server/src/db/repositories/tickets.ts` | upsert with scope, prune by source, key lookup, `findByTaskId` |
| `apps/server/src/db/repositories/tasks.ts` | `createFromTicket` unchanged signature; new `findByIds` |
| `apps/server/src/integrations/types.ts` | `ExternalTicket` (`sync_key`, `provider_id`, `key`), `TicketSourceConfig` (no `include_done`), `TicketPage`, `MAX_TICKETS_PER_SOURCE` |
| `apps/server/src/integrations/paginate.ts` | `collectPages` (cap + truncated) |
| `apps/server/src/integrations/{github,linear,jira}.ts` | open-only, paginated, new names; GitHub key `owner/repo#12` |
| `apps/server/src/integrations/ticket-link.ts` | `ticketLinkJson` (writer) and `readTicketLink` (reader, handles legacy) |
| `apps/server/src/setup/schema.ts` | `ticketSourceSchema`, `ticket_sources`, `setupInputSchema` (duplicates), `normalizeSetup` v2, `withLegacyMirror` |
| `apps/server/src/db/repositories/project-setup.ts` | save with mirror; `listWithAutoSync` returns sources |
| `apps/server/src/setup/tickets-sync.ts` | `syncSource`, `syncProjectTickets(sources)`, last-sync memory, per-source scheduler |
| `apps/server/src/control/context.ts` | `controlContextForRequest` (routes honour "view as") |
| `apps/server/src/control/tickets.ts` | `listTickets`, `getTicket`, `syncTickets`, `importTickets`, `pushTicketStatus`, `TicketOut` |
| `apps/server/src/routes/tickets.ts`, `routes/setup.ts` | thin: zod + control calls; setup save prunes removed sources |
| `apps/server/src/control/tasks.ts` | `TaskOut.ticket` replaces `external_key` |
| `apps/server/src/control/inventory.ts` | `find` kind `ticket` |
| `apps/server/src/mcp/tools.ts` | five tools, `find` kinds |
| `apps/server/src/chat/gate.ts` | classes |
| `apps/server/src/db/repositories/chat-actions-view.ts` | card sentences |
| `apps/server/src/chat/project-prompt.ts` | one line about tickets |
| `apps/web/src/lib/types.ts`, `lib/api.ts`, `lib/ticket-link.ts` | new names, sources, `ticketKey` |
| `apps/web/src/components/SetupForm.tsx` | sources list |
| `apps/web/src/components/TicketsView.tsx` | source filter, title + key subtitle, truncated banner |
| `apps/web/src/components/TasksBoard.tsx`, `TaskEditor.tsx` | key as subtitle line |

---

### Task 1: Ticket columns — `scope`, new names in Prisma and the repository

**Files:**
- Modify: `apps/server/prisma/schema.prisma` (model `Ticket`)
- Create: `apps/server/prisma/migrations/20260927000000_tickets_scope/migration.sql`
- Regenerate: `apps/server/src/generated/prisma/**`
- Modify: `apps/server/src/db/repositories/types.ts` (`Ticket`, `mapTicket`)
- Modify: `apps/server/src/db/repositories/tickets.ts`
- Modify: `apps/server/src/db/repositories/tasks.ts` (add `findByIds`)
- Modify callers so the server typechecks: `apps/server/src/setup/tickets-sync.ts`, `apps/server/src/routes/tickets.ts` (rename only; logic moves in later tasks)
- Test: `apps/server/src/db/repositories/tickets.db.test.ts` (new)

**Interfaces:**
- Produces:
  ```ts
  // types.ts
  export interface Ticket {
    id: string; project_id: string; integration_id: string; scope: string | null;
    provider: 'github' | 'linear' | 'jira';
    sync_key: string; key: string; title: string; description: string | null; url: string;
    state: string; status: TaskStatus; meta: Record<string, unknown>;
    task_id: string | null; synced_at: string; created_at: string;
  }
  // tickets.ts
  export interface TicketSource { integration_id: string; scope: string }
  export interface TicketUpsert { integration_id: string; scope: string; provider: 'github'|'linear'|'jira'; sync_key: string; key: string;
    title: string; description: string | null; url: string; state: string; status: TaskStatus; meta: Record<string, unknown> }
  class TicketsRepository {
    listByProject(projectId: string, filter?: { integration_id?: string; scope?: string }): Promise<Ticket[]>;
    findByIds(projectId: string, ids: string[]): Promise<Ticket[]>;
    findByTaskId(taskId: string): Promise<Ticket | undefined>;
    /** exact key or URL (case-insensitive), or a key suffix ("/repo#12", "#12") — within these projects */
    findByKeyish(projectIds: string[], q: { key?: string; url?: string; suffix?: string }): Promise<Ticket[]>;
    upsertMany(projectId: string, items: TicketUpsert[]): Promise<{ created: number; updated: number; linked: Ticket[] }>;
    linkTask(ticketId: string, taskId: string): Promise<void>;
    unlinkTask(taskId: string): Promise<void>;
    /** non-imported tickets of this source not in keepSyncKeys; also null-scope rows of the integration when legacyNullScope */
    pruneMissing(projectId: string, source: TicketSource, keepSyncKeys: string[], legacyNullScope: boolean): Promise<number>;
    /** every non-imported ticket of a source removed from the setup */
    pruneSource(projectId: string, source: TicketSource): Promise<number>;
  }
  // tasks.ts
  findByIds(ids: string[]): Promise<Task[]>;
  ```

- [ ] **Step 1: Write the failing DB test** — `apps/server/src/db/repositories/tickets.db.test.ts`

```ts
import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../generated/prisma/client.js';
import { newId } from '../../lib/ids.js';
import { TicketsRepository, type TicketUpsert } from './tickets.js';

// Needs a migrated Postgres: TERMHUB_DB_TESTS=1 DATABASE_URL=…
describe.skipIf(process.env.TERMHUB_DB_TESTS !== '1')('TicketsRepository (Postgres)', () => {
  let db: PrismaClient;
  let repo: TicketsRepository;
  let userId: string;
  let projectId: string;
  const integ = 'integ-1';

  const t = (n: number, scope: string, over: Partial<TicketUpsert> = {}): TicketUpsert => ({
    integration_id: integ, scope, provider: 'github', sync_key: `github:${scope}#${n}`, key: `${scope}#${n}`,
    title: `Issue ${n}`, description: null, url: `https://github.com/${scope}/issues/${n}`, state: 'open', status: 'backlog', meta: {}, ...over,
  });

  beforeAll(async () => {
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
    repo = new TicketsRepository(db);
    userId = newId();
    projectId = newId();
    await db.user.create({ data: { id: userId, email: `${userId}@test.local`, name: 'test' } });
    await db.project.create({ data: { id: projectId, name: 'p', key: `T${Date.now() % 100000}`, ownerId: userId } });
  });

  afterAll(async () => {
    await db.project.deleteMany({ where: { id: projectId } });
    await db.user.deleteMany({ where: { id: userId } });
    await db.$disconnect();
  });

  it('stores scope, key and sync_key, and prunes one source without touching the other on the same integration', async () => {
    // Project/user fixtures: if the models need more required fields, copy them from chat-grants.db.test.ts.
    await repo.upsertMany(projectId, [t(1, 'acme/api'), t(2, 'acme/api'), t(1, 'acme/web')]);
    const all = await repo.listByProject(projectId);
    expect(all.map((x) => [x.scope, x.key]).sort()).toEqual([['acme/api', 'acme/api#1'], ['acme/api', 'acme/api#2'], ['acme/web', 'acme/web#1']]);
    const removed = await repo.pruneMissing(projectId, { integration_id: integ, scope: 'acme/api' }, ['github:acme/api#1'], false);
    expect(removed).toBe(1);
    expect((await repo.listByProject(projectId)).map((x) => x.key).sort()).toEqual(['acme/api#1', 'acme/web#1']);
  });

  it('finds by exact key, URL and suffix, case-insensitively', async () => {
    expect((await repo.findByKeyish([projectId], { key: 'ACME/API#1' })).map((x) => x.key)).toEqual(['acme/api#1']);
    expect((await repo.findByKeyish([projectId], { url: 'https://github.com/acme/web/issues/1' })).map((x) => x.key)).toEqual(['acme/web#1']);
    expect((await repo.findByKeyish([projectId], { suffix: '#1' })).map((x) => x.key).sort()).toEqual(['acme/api#1', 'acme/web#1']);
  });

  it('pruneSource deletes only non-imported tickets of that source', async () => {
    expect(await repo.pruneSource(projectId, { integration_id: integ, scope: 'acme/web' })).toBe(1);
    expect((await repo.listByProject(projectId)).map((x) => x.key)).toEqual(['acme/api#1']);
  });

  it('pruneMissing with legacyNullScope also clears rows written before the scope column', async () => {
    await db.ticket.create({ data: { id: newId(), projectId, integrationId: integ, provider: 'github', syncKey: 'github:old#9', key: '#9', title: 'old', url: 'u', state: 'open', status: 'backlog' } });
    expect(await repo.pruneMissing(projectId, { integration_id: integ, scope: 'acme/api' }, ['github:acme/api#1'], true)).toBe(1);
  });
});
```

- [ ] **Step 2: Change the Prisma model.** In `model Ticket` of `apps/server/prisma/schema.prisma`:

```prisma
  /// "linear:<id>" | "jira:<KEY>" | "github:<owner/repo>#<n>" — the sync's dedup key, never shown
  syncKey       String              @map("external_key")
  /// what people type and see: EI-123, PROJ-45, owner/repo#12
  key           String              @map("identifier")
  /// the setup source it came from (Linear team, Jira project, GitHub owner/repo); null only on rows
  /// written before 2026-09-26 whose meta lacked it
  scope         String?
```

Replace the old `externalKey`/`identifier` lines, and change the unique/index lines to:

```prisma
  @@unique([projectId, syncKey])
  @@index([projectId, integrationId, scope])
```

(`@@unique` on the renamed field keeps the same DB columns, so the constraint name `tickets_project_id_external_key_key` does not change.)

- [ ] **Step 3: Write the migration** — `apps/server/prisma/migrations/20260927000000_tickets_scope/migration.sql`

```sql
-- Additive only (spec 2026-09-26 mcp-external-tickets): the previous release ignores the new column.
ALTER TABLE "tickets" ADD COLUMN "scope" TEXT;

-- Rows synced so far carry their source's scope in meta.
UPDATE "tickets" SET "scope" = "meta"->>'scope' WHERE "scope" IS NULL AND "meta" ? 'scope';

DROP INDEX IF EXISTS "tickets_project_id_integration_id_idx";
CREATE INDEX "tickets_project_id_integration_id_scope_idx" ON "tickets"("project_id", "integration_id", "scope");
```

- [ ] **Step 4: Regenerate the client and check the migration matches the schema**

Run:

```bash
NODEDB 'cd apps/server && npx prisma generate && npx prisma migrate deploy && npx prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel prisma/schema.prisma --exit-code'
```

Expected: generate succeeds, the migration applies, and diff exits 0 ("No difference detected").

- [ ] **Step 5: Update the type and mapper** in `apps/server/src/db/repositories/types.ts`: replace the `Ticket` interface with the one in **Interfaces**, and `mapTicket` with:

```ts
export const mapTicket = (t: PrismaTicket): Ticket => ({
  id: t.id,
  project_id: t.projectId,
  integration_id: t.integrationId,
  scope: t.scope,
  provider: t.provider,
  sync_key: t.syncKey,
  key: t.key,
  title: t.title,
  description: t.description,
  url: t.url,
  state: t.state,
  status: t.status,
  meta: (t.meta ?? {}) as Record<string, unknown>,
  task_id: t.taskId,
  synced_at: t.syncedAt.toISOString(),
  created_at: t.createdAt.toISOString(),
});
```

- [ ] **Step 6: Rewrite `apps/server/src/db/repositories/tickets.ts`**

```ts
import type { PrismaClient } from '../prisma.js';
import { newId } from '../../lib/ids.js';
import { mapTicket, type Ticket, type TaskStatus } from './types.js';

/** A setup ticket source's identity: the same integration may serve several scopes. */
export interface TicketSource {
  integration_id: string;
  scope: string;
}

export interface TicketUpsert {
  integration_id: string;
  scope: string;
  provider: 'github' | 'linear' | 'jira';
  sync_key: string;
  key: string;
  title: string;
  description: string | null;
  url: string;
  state: string;
  status: TaskStatus;
  meta: Record<string, unknown>;
}

/** Staging of synced tickets. They become cards only through an explicit import. */
export class TicketsRepository {
  constructor(private db: PrismaClient) {}

  async listByProject(projectId: string, filter: { integration_id?: string; scope?: string } = {}): Promise<Ticket[]> {
    const rows = await this.db.ticket.findMany({
      where: { projectId, ...(filter.integration_id ? { integrationId: filter.integration_id } : {}), ...(filter.scope ? { scope: filter.scope } : {}) },
      orderBy: [{ status: 'asc' }, { syncedAt: 'desc' }],
    });
    return rows.map(mapTicket);
  }

  async findByIds(projectId: string, ids: string[]): Promise<Ticket[]> {
    return (await this.db.ticket.findMany({ where: { projectId, id: { in: ids } } })).map(mapTicket);
  }

  async findByTaskId(taskId: string): Promise<Ticket | undefined> {
    const row = await this.db.ticket.findUnique({ where: { taskId } });
    return row ? mapTicket(row) : undefined;
  }

  /** Exact key or URL (case-insensitive), or a key suffix ("/repo#12", "#12"), within these projects. */
  async findByKeyish(projectIds: string[], q: { key?: string; url?: string; suffix?: string }): Promise<Ticket[]> {
    if (projectIds.length === 0) return [];
    const where = q.url
      ? { url: { equals: q.url, mode: 'insensitive' as const } }
      : q.key
        ? { key: { equals: q.key, mode: 'insensitive' as const } }
        : { key: { endsWith: q.suffix ?? '', mode: 'insensitive' as const } };
    const rows = await this.db.ticket.findMany({ where: { projectId: { in: projectIds }, ...where }, orderBy: { key: 'asc' }, take: 20 });
    return rows.map(mapTicket);
  }

  /** Batch upsert; returns the tickets that already have a card (to refresh the mirror). */
  async upsertMany(projectId: string, items: TicketUpsert[]): Promise<{ created: number; updated: number; linked: Ticket[] }> {
    let created = 0;
    let updated = 0;
    const linked: Ticket[] = [];
    const now = new Date();
    for (const t of items) {
      const existing = await this.db.ticket.findUnique({ where: { projectId_syncKey: { projectId, syncKey: t.sync_key } } });
      const data = {
        integrationId: t.integration_id,
        scope: t.scope,
        provider: t.provider,
        key: t.key,
        title: t.title,
        description: t.description,
        url: t.url,
        state: t.state,
        status: t.status,
        meta: t.meta as object,
        syncedAt: now,
      };
      if (!existing) {
        await this.db.ticket.create({ data: { id: newId(), projectId, syncKey: t.sync_key, ...data } });
        created++;
        continue;
      }
      const changed =
        existing.title !== t.title || (existing.description ?? null) !== t.description || existing.state !== t.state || existing.url !== t.url || existing.key !== t.key;
      const row = await this.db.ticket.update({ where: { id: existing.id }, data });
      if (changed) updated++;
      if (row.taskId) linked.push(mapTicket(row));
    }
    return { created, updated, linked };
  }

  async linkTask(ticketId: string, taskId: string): Promise<void> {
    await this.db.ticket.update({ where: { id: ticketId }, data: { taskId } });
  }

  async unlinkTask(taskId: string): Promise<void> {
    await this.db.ticket.updateMany({ where: { taskId }, data: { taskId: null } });
  }

  /** Non-imported tickets of this source that left it; with legacyNullScope, also the integration's pre-scope rows. */
  async pruneMissing(projectId: string, source: TicketSource, keepSyncKeys: string[], legacyNullScope: boolean): Promise<number> {
    const r = await this.db.ticket.deleteMany({
      where: {
        projectId,
        integrationId: source.integration_id,
        taskId: null,
        syncKey: { notIn: keepSyncKeys },
        ...(legacyNullScope ? { OR: [{ scope: source.scope }, { scope: null }] } : { scope: source.scope }),
      },
    });
    return r.count;
  }

  /** A source removed from the setup: its non-imported tickets go; imported cards keep their link. */
  async pruneSource(projectId: string, source: TicketSource): Promise<number> {
    const r = await this.db.ticket.deleteMany({ where: { projectId, integrationId: source.integration_id, scope: source.scope, taskId: null } });
    return r.count;
  }
}
```

- [ ] **Step 7: Add `findByIds` to `TasksRepository`** (`apps/server/src/db/repositories/tasks.ts`, next to `findById`):

```ts
  async findByIds(ids: string[]): Promise<Task[]> {
    if (ids.length === 0) return [];
    const rows = await this.db.task.findMany({ where: { id: { in: ids } }, include: KEY });
    return rows.map(toTask);
  }
```

- [ ] **Step 8: Keep the callers compiling.** Make the smallest rename-only edits:
  - `setup/tickets-sync.ts`: `upsertMany` items use `scope: source.scope`, `sync_key: t.key`, `key: t.identifier`. The call becomes `pruneMissing(projectId, { integration_id: source.integration_id, scope: source.scope }, tickets.map((t) => t.key), true)`, and `linked.external_key` becomes `linked.sync_key`.
  - `routes/tickets.ts`: `t.external_key` becomes `t.sync_key` and `t.identifier` becomes `t.key`.

  Tasks 2 and 5 replace these lines properly.

- [ ] **Step 9: Run the DB test and the server typecheck**

Run:

```bash
NODEDB 'TERMHUB_DB_TESTS=1 npm test -w @termhub/server -- src/db/repositories/tickets.db.test.ts' && NODE 'npm run typecheck -w @termhub/server'
```

Expected: 4 passed; typecheck clean.

- [ ] **Step 10: Commit**

```bash
git add apps/server/prisma apps/server/src/generated/prisma apps/server/src/db/repositories apps/server/src/setup/tickets-sync.ts apps/server/src/routes/tickets.ts
git commit -m "Tickets: store the source scope and name key and sync_key apart

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: The ticket link on a card — writer and reader

**Files:**
- Create: `apps/server/src/integrations/ticket-link.ts`
- Test: `apps/server/src/integrations/ticket-link.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface TicketLink {
    provider: 'github' | 'linear' | 'jira'; key: string; provider_id: string; url: string;
    state: string; status: TaskStatus; scope: string | null; integration_id: string | null;
  }
  export function ticketLinkJson(t: { provider: TicketLink['provider']; provider_id: string; key: string; url: string; state: string; status: TaskStatus; updated_at?: string; meta?: Record<string, unknown> },
    source: { integration_id: string; scope: string }): Record<string, unknown>;
  export function readTicketLink(ref: unknown): TicketLink | null;
  ```

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { readTicketLink, ticketLinkJson } from './ticket-link.js';

describe('ticket link', () => {
  it('writes the new names and the legacy ones the previous release reads', () => {
    const json = ticketLinkJson(
      { provider: 'github', provider_id: '12', key: 'acme/api#12', url: 'u', state: 'open', status: 'backlog', updated_at: 'x', meta: { labels: ['bug'], key: 'meta must not win' } },
      { integration_id: 'i1', scope: 'acme/api' },
    );
    expect(json).toMatchObject({ provider: 'github', key: 'acme/api#12', identifier: 'acme/api#12', provider_id: '12', id: '12', integration_id: 'i1', scope: 'acme/api', labels: ['bug'], updated_at: 'x' });
  });

  it('reads a link written by this release', () => {
    expect(readTicketLink({ provider: 'linear', key: 'EI-1', provider_id: 'uuid', url: 'u', state: 'Todo', status: 'todo', scope: 'EI', integration_id: 'i1' }))
      .toEqual({ provider: 'linear', key: 'EI-1', provider_id: 'uuid', url: 'u', state: 'Todo', status: 'todo', scope: 'EI', integration_id: 'i1' });
  });

  it('reads a legacy GitHub link: #12 + scope becomes owner/repo#12, id becomes provider_id, no integration_id', () => {
    expect(readTicketLink({ provider: 'github', id: '12', identifier: '#12', url: 'u', state: 'open', status: 'backlog', scope: 'acme/api' }))
      .toEqual({ provider: 'github', key: 'acme/api#12', provider_id: '12', url: 'u', state: 'open', status: 'backlog', scope: 'acme/api', integration_id: null });
  });

  it('returns null for anything that is not a link', () => {
    expect(readTicketLink(null)).toBeNull();
    expect(readTicketLink({ provider: 'gitlab', key: 'x' })).toBeNull();
    expect(readTicketLink('EI-1')).toBeNull();
  });
});
```

- [ ] **Step 2: Run it** — `NODE 'npm test -w @termhub/server -- src/integrations/ticket-link.test.ts'` → FAIL (module not found).

- [ ] **Step 3: Implement** `apps/server/src/integrations/ticket-link.ts`

```ts
import type { TaskStatus } from '../db/repositories/types.js';

const PROVIDERS = new Set(['github', 'linear', 'jira']);

/** A card's link to its external ticket, as read from `tasks.external_ref`. */
export interface TicketLink {
  provider: 'github' | 'linear' | 'jira';
  key: string;
  provider_id: string;
  url: string;
  state: string;
  status: TaskStatus;
  scope: string | null;
  integration_id: string | null;
}

/**
 * The JSON stored in `tasks.external_ref`. `identifier` and `id` repeat `key` and `provider_id`
 * because the previous release reads those names (deploy window and rollback).
 */
export function ticketLinkJson(
  t: { provider: TicketLink['provider']; provider_id: string; key: string; url: string; state: string; status: TaskStatus; updated_at?: string; meta?: Record<string, unknown> },
  source: { integration_id: string; scope: string },
): Record<string, unknown> {
  return {
    ...(t.meta ?? {}),
    provider: t.provider,
    key: t.key,
    identifier: t.key,
    provider_id: t.provider_id,
    id: t.provider_id,
    url: t.url,
    state: t.state,
    status: t.status,
    scope: source.scope,
    integration_id: source.integration_id,
    ...(t.updated_at ? { updated_at: t.updated_at } : {}),
  };
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

/** Reads links from both releases; a legacy GitHub `#12` becomes `owner/repo#12` from its scope. */
export function readTicketLink(ref: unknown): TicketLink | null {
  if (!ref || typeof ref !== 'object') return null;
  const r = ref as Record<string, unknown>;
  const provider = str(r.provider);
  if (!provider || !PROVIDERS.has(provider)) return null;
  const scope = str(r.scope);
  const legacy = str(r.identifier);
  const key = str(r.key) ?? (provider === 'github' && legacy?.startsWith('#') && scope ? `${scope}${legacy}` : legacy);
  const providerId = str(r.provider_id) ?? str(r.id);
  if (!key || !providerId) return null;
  return {
    provider: provider as TicketLink['provider'],
    key,
    provider_id: providerId,
    url: str(r.url) ?? '',
    state: str(r.state) ?? '',
    status: (str(r.status) ?? 'backlog') as TaskStatus,
    scope,
    integration_id: str(r.integration_id),
  };
}
```

- [ ] **Step 4: Run it** — same command → 4 passed.

- [ ] **Step 5: Commit** — `git add apps/server/src/integrations/ticket-link*` and commit `Tickets: one reader and one writer for a card's ticket link`, with the Co-Authored-By trailer.

---

### Task 3: Providers — open only, paginated, new names

**Files:**
- Modify: `apps/server/src/integrations/types.ts`
- Create: `apps/server/src/integrations/paginate.ts`
- Modify: `apps/server/src/integrations/github.ts`, `linear.ts`, `jira.ts`
- Test: `apps/server/src/integrations/paginate.test.ts`, `github.test.ts`, `linear.test.ts`, `jira.test.ts` (new)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  ```ts
  export const MAX_TICKETS_PER_SOURCE = 500;
  export interface ExternalTicket { sync_key: string; provider: IntegrationProvider; provider_id: string; key: string; title: string;
    description: string | null; url: string; state: string; status: KanbanStatus; updatedAt: string; meta?: Record<string, unknown> }
  export interface TicketSourceConfig { provider: IntegrationProvider; integration_id: string; scope: string; filter?: string | null }
  export interface TicketPage { tickets: ExternalTicket[]; truncated: boolean }
  interface TicketProvider {
    listTickets(secret, config, source: TicketSourceConfig): Promise<TicketPage>;
    updateStatus(secret, config, ticket: { provider_id: string; key: string; scope: string }, status: KanbanStatus): Promise<string>;
  }
  // paginate.ts
  export async function collectPages<T, C>(fetchPage: (cursor: C | null) => Promise<{ items: T[]; next: C | null }>, max?: number): Promise<{ items: T[]; truncated: boolean }>;
  ```

- [ ] **Step 1: Write the failing tests.**

`paginate.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { collectPages } from './paginate.js';

const pages = (sizes: number[]) => async (cursor: number | null) => {
  const i = cursor ?? 0;
  return { items: Array.from({ length: sizes[i] }, (_, k) => `${i}-${k}`), next: i + 1 < sizes.length ? i + 1 : null };
};

describe('collectPages', () => {
  it('follows cursors until the last page', async () => {
    expect(await collectPages(pages([2, 2, 1]), 10)).toEqual({ items: ['0-0', '0-1', '1-0', '1-1', '2-0'], truncated: false });
  });
  it('stops at the cap and says truncated when more exists', async () => {
    const r = await collectPages(pages([3, 3, 3]), 5);
    expect(r.items).toHaveLength(5);
    expect(r.truncated).toBe(true);
  });
  it('exactly the cap on the last page is not truncated', async () => {
    expect((await collectPages(pages([3, 2]), 5)).truncated).toBe(false);
  });
});
```

`github.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { github } from './github.js';

const issue = (n: number, extra: Record<string, unknown> = {}) => ({
  number: n, title: `T${n}`, body: null, html_url: `https://github.com/acme/api/issues/${n}`, state: 'open', updated_at: 'x', labels: [], assignee: null, ...extra,
});
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

afterEach(() => vi.unstubAllGlobals());

describe('github.listTickets', () => {
  it('pulls open issues only, pages until a short page, skips PRs, keys as owner/repo#n', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(json(Array.from({ length: 100 }, (_, i) => issue(i + 1, i === 0 ? { pull_request: {} } : {}))))
      .mockResolvedValueOnce(json([issue(101)]));
    vi.stubGlobal('fetch', fetch);
    const r = await github.listTickets('tok', {}, { provider: 'github', integration_id: 'i', scope: 'acme/api', filter: null });
    expect(fetch.mock.calls[0][0]).toContain('/repos/acme/api/issues?state=open&per_page=100&page=1');
    expect(fetch.mock.calls[1][0]).toContain('page=2');
    expect(r.truncated).toBe(false);
    expect(r.tickets).toHaveLength(100);
    expect(r.tickets[0]).toMatchObject({ sync_key: 'github:acme/api#2', key: 'acme/api#2', provider_id: '2' });
  });

  it('stops at 500 and reports truncated', async () => {
    const fetch = vi.fn(async (url: string) => {
      const page = Number(new URL(url).searchParams.get('page'));
      return json(Array.from({ length: 100 }, (_, i) => issue((page - 1) * 100 + i + 1)));
    });
    vi.stubGlobal('fetch', fetch);
    const r = await github.listTickets('tok', {}, { provider: 'github', integration_id: 'i', scope: 'acme/api' });
    expect(r.tickets).toHaveLength(500);
    expect(r.truncated).toBe(true);
  });
});
```

`linear.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { linear } from './linear.js';

const node = (i: number) => ({ id: `u${i}`, identifier: `EI-${i}`, title: 't', description: null, url: 'u', updatedAt: 'x', priority: 0, state: { name: 'Todo', type: 'unstarted' }, assignee: null, labels: { nodes: [] } });
const page = (nodes: unknown[], next: string | null) =>
  new Response(JSON.stringify({ data: { issues: { nodes, pageInfo: { hasNextPage: next !== null, endCursor: next } } } }), { status: 200 });

afterEach(() => vi.unstubAllGlobals());

describe('linear.listTickets', () => {
  it('follows endCursor and names key/provider_id/sync_key', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(page([node(1)], 'c1')).mockResolvedValueOnce(page([node(2)], null));
    vi.stubGlobal('fetch', fetch);
    const r = await linear.listTickets('k', {}, { provider: 'linear', integration_id: 'i', scope: 'EI' });
    expect(JSON.parse(fetch.mock.calls[1][1].body).variables.after).toBe('c1');
    expect(r.tickets.map((t) => [t.key, t.provider_id, t.sync_key])).toEqual([['EI-1', 'u1', 'linear:u1'], ['EI-2', 'u2', 'linear:u2']]);
    expect(r.truncated).toBe(false);
  });

  it('keeps open-only with a name filter', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(page([], null));
    vi.stubGlobal('fetch', fetch);
    await linear.listTickets('k', {}, { provider: 'linear', integration_id: 'i', scope: 'EI', filter: 'Todo, In Progress' });
    const filter = JSON.parse(fetch.mock.calls[0][1].body).variables.filter;
    expect(filter.state).toEqual({ type: { nin: ['completed', 'canceled'] }, name: { in: ['Todo', 'In Progress'] } });
  });
});
```

`jira.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { jiraProvider } from './jira.js';

const issue = (k: string) => ({ id: `id-${k}`, key: k, fields: { summary: 's', description: null, updated: 'x', status: { name: 'To Do', statusCategory: { key: 'new' } } } });
const res = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const cfg = { baseUrl: 'https://acme.atlassian.net', email: 'a@b' };

afterEach(() => vi.unstubAllGlobals());

describe('jira.listTickets', () => {
  it('is open-only and follows nextPageToken', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(res({ issues: [issue('P-1')], nextPageToken: 'n1' }))
      .mockResolvedValueOnce(res({ issues: [issue('P-2')], isLast: true }));
    vi.stubGlobal('fetch', fetch);
    const r = await jiraProvider.listTickets('t', cfg, { provider: 'jira', integration_id: 'i', scope: 'P' });
    const first = JSON.parse(fetch.mock.calls[0][1].body);
    expect(first.jql).toContain('statusCategory != Done');
    expect(JSON.parse(fetch.mock.calls[1][1].body).nextPageToken).toBe('n1');
    expect(r.tickets.map((t) => [t.key, t.provider_id, t.sync_key])).toEqual([['P-1', 'id-P-1', 'jira:P-1'], ['P-2', 'id-P-2', 'jira:P-2']]);
  });
});
```

- [ ] **Step 2: Run them** — `NODE 'npm test -w @termhub/server -- src/integrations'` → FAIL.

- [ ] **Step 3: Update `types.ts`.** Replace `ExternalTicket`, `TicketSourceConfig` and `TicketProvider` with the **Interfaces** above, and add `MAX_TICKETS_PER_SOURCE` and `TicketPage`. The doc comment on `sync_key` stays: "stable key: linear:<id> | jira:<KEY> | github:<owner/repo>#<n>". `key` gets: "what people type: EI-123, PROJ-45, owner/repo#12".

- [ ] **Step 4: Create `paginate.ts`**

```ts
import { MAX_TICKETS_PER_SOURCE } from './types.js';

/** Follows a provider's cursor until it runs out or the cap is hit (then `truncated` says more exists). */
export async function collectPages<T, C>(
  fetchPage: (cursor: C | null) => Promise<{ items: T[]; next: C | null }>,
  max = MAX_TICKETS_PER_SOURCE,
): Promise<{ items: T[]; truncated: boolean }> {
  const items: T[] = [];
  let cursor: C | null = null;
  for (;;) {
    const page = await fetchPage(cursor);
    items.push(...page.items);
    if (items.length >= max) return { items: items.slice(0, max), truncated: items.length > max || page.next !== null };
    if (page.next === null) return { items, truncated: false };
    cursor = page.next;
  }
}
```

- [ ] **Step 5: GitHub** — replace `listTickets` and `updateStatus` in `github.ts`. Imports gain `collectPages`; `TicketSourceConfig` import stays.

```ts
  async listTickets(secret, _config, source) {
    const [owner, repo] = source.scope.split('/');
    if (!owner || !repo) throw new Error('scope do GitHub deve ser owner/repo');
    const labels = source.filter ? `&labels=${encodeURIComponent(source.filter)}` : '';
    type Issue = { number: number; title: string; body: string | null; html_url: string; state: string; updated_at: string; pull_request?: unknown; labels: { name: string }[]; assignee: { login: string } | null };
    const { items, truncated } = await collectPages<Issue, number>(async (page) => {
      const p = page ?? 1;
      const raw = await gh<Issue[]>(secret, `/repos/${owner}/${repo}/issues?state=open&per_page=100&page=${p}${labels}`);
      return { items: raw.filter((i) => !i.pull_request), next: raw.length === 100 ? p + 1 : null };
    });
    return {
      truncated,
      tickets: items.map<ExternalTicket>((i) => ({
        sync_key: `github:${owner}/${repo}#${i.number}`,
        provider: 'github',
        provider_id: String(i.number),
        key: `${owner}/${repo}#${i.number}`,
        title: i.title,
        description: i.body,
        url: i.html_url,
        state: i.state,
        status: i.assignee ? 'doing' : 'backlog',
        updatedAt: i.updated_at,
        meta: { labels: i.labels.map((l) => l.name), assignee: i.assignee?.login ?? null },
      })),
    };
  },

  async updateStatus(secret, _config, ticket, status) {
    const [owner, repo] = ticket.scope.split('/');
    const state = status === 'done' ? 'closed' : 'open';
    await gh(secret, `/repos/${owner}/${repo}/issues/${ticket.provider_id}`, { method: 'PATCH', body: JSON.stringify({ state }) });
    return state;
  },
```

- [ ] **Step 6: Linear** — in `linear.ts`, replace `listTickets`, and in `updateStatus` use `id: ticket.provider_id`:

```ts
  async listTickets(secret, _config, source: TicketSourceConfig) {
    const names = source.filter ? source.filter.split(',').map((s) => s.trim()).filter(Boolean) : [];
    // one `state` object: a separate name filter would overwrite the open-only one
    const state = { type: { nin: ['completed', 'canceled'] }, ...(names.length ? { name: { in: names } } : {}) };
    type Node = { id: string; identifier: string; title: string; description: string | null; url: string; updatedAt: string; priority: number; state: { name: string; type: string }; assignee: { name: string } | null; labels: { nodes: { name: string }[] } };
    const { items, truncated } = await collectPages<Node, string>(async (after) => {
      const data = await gql<{ issues: { nodes: Node[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } }>(
        secret,
        `query($filter: IssueFilter, $after: String) {
          issues(filter: $filter, first: 100, after: $after, orderBy: updatedAt) {
            nodes { id identifier title description url updatedAt priority state { name type } assignee { name } labels { nodes { name } } }
            pageInfo { hasNextPage endCursor }
          }
        }`,
        { filter: { team: { key: { eq: source.scope } }, state }, after },
      );
      return { items: data.issues.nodes, next: data.issues.pageInfo.hasNextPage ? data.issues.pageInfo.endCursor : null };
    });
    return {
      truncated,
      tickets: items.map<ExternalTicket>((i) => ({
        sync_key: `linear:${i.id}`,
        provider: 'linear',
        provider_id: i.id,
        key: i.identifier,
        title: i.title,
        description: i.description,
        url: i.url,
        state: i.state.name,
        status: mapState(i.state.type),
        updatedAt: i.updatedAt,
        meta: { priority: i.priority, assignee: i.assignee?.name ?? null, labels: i.labels.nodes.map((l) => l.name) },
      })),
    };
  },
```

- [ ] **Step 7: Jira** — in `jira.ts`, replace `listTickets`, and in `updateStatus` use `ticket.key` where it read `ticket.identifier`, in both URLs:

```ts
  async listTickets(secret, config, source: TicketSourceConfig) {
    const parts = [`project = "${source.scope}"`, 'statusCategory != Done'];
    if (source.filter) parts.push(`(${source.filter})`);
    const jql = parts.join(' AND ') + ' ORDER BY updated DESC';
    type Issue = { id: string; key: string; fields: { summary: string; description: unknown; updated: string; status: { name: string; statusCategory: { key: string } }; priority?: { name: string } | null; assignee?: { displayName: string } | null; labels?: string[] } };
    const { items, truncated } = await collectPages<Issue, string>(async (token) => {
      const data = await jira<{ issues: Issue[]; nextPageToken?: string; isLast?: boolean }>(config, secret, '/rest/api/3/search/jql', {
        method: 'POST',
        body: JSON.stringify({ jql, maxResults: 100, ...(token ? { nextPageToken: token } : {}), fields: ['summary', 'description', 'updated', 'status', 'priority', 'assignee', 'labels'] }),
      });
      return { items: data.issues, next: data.isLast === true ? null : (data.nextPageToken ?? null) };
    });
    return {
      truncated,
      tickets: items.map<ExternalTicket>((i) => ({
        sync_key: `jira:${i.key}`,
        provider: 'jira',
        provider_id: i.id,
        key: i.key,
        title: i.fields.summary,
        description: i.fields.description ? adfToText(i.fields.description).trim() || null : null,
        url: `${base(config)}/browse/${i.key}`,
        state: i.fields.status.name,
        status: mapCategory(i.fields.status.statusCategory.key),
        updatedAt: i.fields.updated,
        meta: { priority: i.fields.priority?.name ?? null, assignee: i.fields.assignee?.displayName ?? null, labels: i.fields.labels ?? [] },
      })),
    };
  },
```

- [ ] **Step 8: Run** `NODE 'npm test -w @termhub/server -- src/integrations'`. Expected: all pass. The server typecheck will fail in `tickets-sync.ts` and `routes/tickets.ts` until Tasks 5 and 7; that is expected here. Do not patch them twice.

- [ ] **Step 9: Commit** `Ticket providers: open only, paginated up to 500, key and provider_id` (with trailer).

---

### Task 4: Setup — several ticket sources with a legacy mirror

**Files:**
- Modify: `apps/server/src/setup/schema.ts`
- Modify: `apps/server/src/db/repositories/project-setup.ts`
- Test: `apps/server/src/setup/schema.test.ts` (create, or extend if present)

**Interfaces:**
- Produces:
  ```ts
  export const SETUP_VERSION = 2;
  export const ticketSourceSchema: z.ZodObject<...>; export type TicketSource = z.infer<typeof ticketSourceSchema>;
  // { provider, integration_id, scope, filter: string|null, sync_minutes: number }
  export const setupSchema;            // gains ticket_sources: TicketSource[] (default []), keeps tickets
  export const setupInputSchema;       // setupSchema + duplicate (integration_id, scope) refusal, message 'Fonte de tickets repetida'
  export function sourceIdentity(s: { integration_id: string; scope: string }): string;
  export function withLegacyMirror(data: ProjectSetupData): ProjectSetupData;   // tickets = first source + include_done:false, or null
  // ProjectSetupRepository.listWithAutoSync(): Promise<{ project_id: string; sources: TicketSource[] }[]>
  ```

- [ ] **Step 1: Write the failing test** `apps/server/src/setup/schema.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { normalizeSetup, setupInputSchema, withLegacyMirror } from './schema.js';

const legacy = { provider: 'linear', integration_id: 'i1', scope: 'EI', filter: null, include_done: true, sync_minutes: 15 };

describe('setup ticket sources', () => {
  it('rebuilds sources when only tickets is present (saved by the previous release)', () => {
    const d = normalizeSetup({ tickets: legacy }, 1);
    expect(d.ticket_sources).toEqual([{ provider: 'linear', integration_id: 'i1', scope: 'EI', filter: null, sync_minutes: 15 }]);
    expect(d.tickets).toEqual({ provider: 'linear', integration_id: 'i1', scope: 'EI', filter: null, include_done: false, sync_minutes: 15 });
  });

  it('keeps explicit sources and mirrors the first into tickets', () => {
    const d = normalizeSetup({ tickets: null, ticket_sources: [
      { provider: 'github', integration_id: 'g', scope: 'acme/api', filter: null, sync_minutes: 0 },
      { provider: 'github', integration_id: 'g', scope: 'acme/web', filter: null, sync_minutes: 0 },
    ] }, 2);
    expect(d.ticket_sources).toHaveLength(2);
    expect(d.tickets?.scope).toBe('acme/api');
  });

  it('an explicit empty list stays empty even with a stale tickets', () => {
    expect(normalizeSetup({ tickets: legacy, ticket_sources: [] }, 2).ticket_sources).toEqual([]);
  });

  it('withLegacyMirror writes null when there is no source', () => {
    expect(withLegacyMirror(normalizeSetup({}, 2)).tickets).toBeNull();
  });

  it('refuses the same integration and scope twice', () => {
    const src = { provider: 'github', integration_id: 'g', scope: 'acme/api' };
    const r = setupInputSchema.safeParse({ ticket_sources: [src, { ...src, scope: ' acme/api ' }] });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0].message).toBe('Fonte de tickets repetida');
  });
});
```

- [ ] **Step 2: Run it** — `NODE 'npm test -w @termhub/server -- src/setup/schema.test.ts'` → FAIL.

- [ ] **Step 3: Implement** in `setup/schema.ts`. Bump `SETUP_VERSION` to 2, then replace the `ticketsSchema` block with:

```ts
/** One ticket source of a project. Identity: (integration_id, scope). Open tickets only. */
export const ticketSourceSchema = z.object({
  provider: providerEnum,
  integration_id: z.string().min(1),
  /** Linear: team key; Jira: project key; GitHub: owner/repo */
  scope: z.string().trim().min(1).max(200),
  /** Linear: state names; Jira: extra JQL; GitHub: labels */
  filter: z.string().trim().max(500).nullable().default(null),
  /** sync automatically every N minutes (0 = manual) */
  sync_minutes: z.number().int().min(0).max(1440).default(0),
});
export type TicketSource = z.infer<typeof ticketSourceSchema>;

/** The single source of setup v1. Kept as a mirror of ticket_sources[0] for the previous release. */
export const ticketsSchema = ticketSourceSchema.extend({ include_done: z.boolean().default(false) });

export const sourceIdentity = (s: { integration_id: string; scope: string }) => `${s.integration_id}\u0000${s.scope.trim()}`;
```

In `setupSchema`, add `ticket_sources: z.array(ticketSourceSchema).max(20).default([]),` after `tickets`. Then add:

```ts
/** What PUT /setup accepts: the same shape, and no source twice. */
export const setupInputSchema = setupSchema.superRefine((d, ctx) => {
  const seen = new Set<string>();
  d.ticket_sources.forEach((s, i) => {
    const id = sourceIdentity(s);
    if (seen.has(id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['ticket_sources', i], message: 'Fonte de tickets repetida' });
    seen.add(id);
  });
});

/** `tickets` = the first source (include_done false) or null, so the previous release keeps syncing it. */
export function withLegacyMirror(data: ProjectSetupData): ProjectSetupData {
  const first = data.ticket_sources[0];
  return { ...data, tickets: first ? { ...first, include_done: false } : null };
}
```

Replace `normalizeSetup` with:

```ts
/** Applies defaults/migrations to a saved JSON (may come from an earlier version or the previous release). */
export function normalizeSetup(raw: unknown, _version: number): ProjectSetupData {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const parsed = setupSchema.safeParse(obj);
  let data: ProjectSetupData;
  if (parsed.success) data = parsed.data;
  else {
    // unknown/corrupt format: back to defaults without losing what is valid field by field
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(setupSchema.shape) as (keyof typeof setupSchema.shape)[]) {
      const r = setupSchema.shape[key].safeParse(obj[key]);
      out[key] = r.success ? r.data : setupSchema.shape[key].parse(undefined);
    }
    data = out as ProjectSetupData;
  }
  // v1, or saved by the previous release (its zod strips ticket_sources): rebuild from tickets
  if (!('ticket_sources' in obj) && data.tickets) {
    const { include_done: _dropped, ...source } = data.tickets;
    data = { ...data, ticket_sources: [source] };
  }
  return withLegacyMirror(data);
}
```

- [ ] **Step 4: Repository.** In `project-setup.ts`:
  - `save` writes `withLegacyMirror(data)`. Import it from the schema.
  - `listWithAutoSync` becomes:

```ts
  /** Projects with at least one source on automatic sync, and those sources. */
  async listWithAutoSync(): Promise<{ project_id: string; sources: TicketSource[] }[]> {
    const rows = await this.db.projectSetup.findMany();
    return rows
      .map((r) => ({ project_id: r.projectId, sources: normalizeSetup(r.data, r.version).ticket_sources.filter((s) => s.sync_minutes > 0) }))
      .filter((r) => r.sources.length > 0);
  }
```

- [ ] **Step 5: Run** the schema test → 5 passed.

- [ ] **Step 6: Commit** `Setup: several ticket sources, mirrored into tickets for the previous release` (with trailer).

---

### Task 5: Sync per source, with last-sync memory and a per-source scheduler

**Files:**
- Modify: `apps/server/src/setup/tickets-sync.ts`
- Test: `apps/server/src/setup/tickets-sync.test.ts` (new)

**Interfaces:**
- Consumes:
  - from Task 1: `TicketsRepository.upsertMany`, `.pruneMissing`, `TicketUpsert`;
  - from Task 2: `ticketLinkJson`;
  - from Task 3: `TicketPage`, `getProvider`;
  - from Task 4: `TicketSource`, `listWithAutoSync`, `sourceIdentity`.
- Produces:
  ```ts
  export interface SourceSyncResult { provider: IntegrationProvider; integration_id: string; scope: string;
    fetched?: number; created?: number; updated?: number; removed?: number; truncated?: boolean; error?: string }
  export interface SyncResult { sources: SourceSyncResult[]; synced_at: string }
  export async function syncSource(repos: Repositories, projectId: string, source: TicketSource, legacyNullScope: boolean): Promise<SourceSyncResult>;
  export async function syncProjectTickets(repos: Repositories, projectId: string, sources: TicketSource[]): Promise<SyncResult>;
  export function lastSync(projectId: string): SyncResult | null;
  export function startTicketSyncScheduler(repos, log): () => void;   // unchanged signature
  ```

- [ ] **Step 1: Write the failing test** `apps/server/src/setup/tickets-sync.test.ts`

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Repositories } from '../db/repositories/index.js';
import type { ExternalTicket } from '../integrations/types.js';

const listTickets = vi.fn();
vi.mock('../integrations/index.js', () => ({ getProvider: () => ({ listTickets }) }));

const { lastSync, syncProjectTickets } = await import('./tickets-sync.js');

const ext = (scope: string, n: number): ExternalTicket => ({
  sync_key: `github:${scope}#${n}`, provider: 'github', provider_id: String(n), key: `${scope}#${n}`, title: 't', description: null,
  url: 'u', state: 'open', status: 'backlog', updatedAt: 'x',
});
const src = (scope: string) => ({ provider: 'github' as const, integration_id: 'g', scope, filter: null, sync_minutes: 0 });

function makeRepos() {
  const upsertMany = vi.fn(async () => ({ created: 1, updated: 0, linked: [{ id: 'tk', sync_key: 'github:acme/api#1', task_id: 'task1' }] }));
  const pruneMissing = vi.fn(async () => 0);
  const setExternalRef = vi.fn(async () => undefined);
  const repos = {
    integrations: { findById: vi.fn(async () => ({ id: 'g', provider: 'github', config: {} })), getSecret: vi.fn(async () => 'tok') },
    tickets: { upsertMany, pruneMissing },
    tasks: { setExternalRef },
  } as unknown as Repositories;
  return { repos, upsertMany, pruneMissing, setExternalRef };
}

beforeEach(() => listTickets.mockReset());

describe('syncProjectTickets', () => {
  it('syncs every source; two sources on one integration prune only their own scope', async () => {
    listTickets.mockImplementation(async (_s: string, _c: unknown, source: { scope: string }) => ({ tickets: [ext(source.scope, 1)], truncated: source.scope === 'acme/web' }));
    const { repos, pruneMissing, upsertMany } = makeRepos();
    const r = await syncProjectTickets(repos, 'p1', [src('acme/api'), src('acme/web')]);
    expect(pruneMissing).toHaveBeenNthCalledWith(1, 'p1', { integration_id: 'g', scope: 'acme/api' }, ['github:acme/api#1'], false);
    expect(pruneMissing).toHaveBeenNthCalledWith(2, 'p1', { integration_id: 'g', scope: 'acme/web' }, ['github:acme/web#1'], false);
    expect(upsertMany.mock.calls[0][1][0]).toMatchObject({ scope: 'acme/api', key: 'acme/api#1', sync_key: 'github:acme/api#1' });
    expect(r.sources.map((s) => [s.scope, s.truncated])).toEqual([['acme/api', false], ['acme/web', true]]);
    expect(lastSync('p1')?.sources).toHaveLength(2);
  });

  it('a failing source does not stop the others', async () => {
    listTickets.mockRejectedValueOnce(new Error('GitHub 401: bad token')).mockResolvedValueOnce({ tickets: [ext('acme/web', 1)], truncated: false });
    const { repos } = makeRepos();
    const r = await syncProjectTickets(repos, 'p1', [src('acme/api'), src('acme/web')]);
    expect(r.sources[0]).toMatchObject({ scope: 'acme/api', error: 'Falha ao consultar github: GitHub 401: bad token' });
    expect(r.sources[1]).toMatchObject({ scope: 'acme/web', fetched: 1 });
  });

  it('one source on its integration also clears pre-scope rows', async () => {
    listTickets.mockResolvedValue({ tickets: [], truncated: false });
    const { repos, pruneMissing } = makeRepos();
    await syncProjectTickets(repos, 'p1', [src('acme/api')]);
    expect(pruneMissing).toHaveBeenCalledWith('p1', { integration_id: 'g', scope: 'acme/api' }, [], true);
  });

  it('refreshes the link of imported cards with integration_id', async () => {
    listTickets.mockResolvedValue({ tickets: [ext('acme/api', 1)], truncated: false });
    const { repos, setExternalRef } = makeRepos();
    await syncProjectTickets(repos, 'p1', [src('acme/api')]);
    expect(setExternalRef).toHaveBeenCalledWith('task1', expect.objectContaining({ key: 'acme/api#1', integration_id: 'g', scope: 'acme/api' }));
  });
});
```

- [ ] **Step 2: Run it** → FAIL.

- [ ] **Step 3: Rewrite `setup/tickets-sync.ts`**

```ts
import type { Repositories } from '../db/repositories/index.js';
import { getProvider, type IntegrationProvider } from '../integrations/index.js';
import { ticketLinkJson } from '../integrations/ticket-link.js';
import { sourceIdentity, type TicketSource } from './schema.js';

export interface SourceSyncResult {
  provider: IntegrationProvider;
  integration_id: string;
  scope: string;
  fetched?: number;
  created?: number;
  updated?: number;
  removed?: number;
  truncated?: boolean;
  error?: string;
}

export interface SyncResult {
  sources: SourceSyncResult[];
  synced_at: string;
}

/** Last full sync per project (in memory; one active container). Feeds the tool throttle and `last_sync`. */
const lastByProject = new Map<string, SyncResult>();
export const lastSync = (projectId: string): SyncResult | null => lastByProject.get(projectId) ?? null;

/**
 * Fetches one source into the staging table. Imported cards only get their ticket link refreshed —
 * column and title stay. Never throws for a provider failure: it comes back as `error`.
 */
export async function syncSource(repos: Repositories, projectId: string, source: TicketSource, legacyNullScope: boolean): Promise<SourceSyncResult> {
  const base = { provider: source.provider, integration_id: source.integration_id, scope: source.scope };
  const integration = await repos.integrations.findById(source.integration_id);
  const secret = await repos.integrations.getSecret(source.integration_id);
  if (!integration || !secret) return { ...base, error: 'Integração de tickets não encontrada' };
  if (integration.provider !== source.provider) return { ...base, error: 'Provedor da fonte não bate com a integração' };

  let page;
  try {
    page = await getProvider(source.provider).listTickets(secret, integration.config, source);
  } catch (e) {
    return { ...base, error: `Falha ao consultar ${source.provider}: ${(e as Error).message}` };
  }
  const where = { integration_id: source.integration_id, scope: source.scope };
  const r = await repos.tickets.upsertMany(
    projectId,
    page.tickets.map((t) => ({
      ...where,
      provider: t.provider,
      sync_key: t.sync_key,
      key: t.key,
      title: t.title,
      description: t.description,
      url: t.url,
      state: t.state,
      status: t.status,
      meta: { ...(t.meta ?? {}), updated_at: t.updatedAt, scope: source.scope },
    })),
  );
  for (const linked of r.linked) {
    const t = page.tickets.find((x) => x.sync_key === linked.sync_key);
    if (t && linked.task_id) await repos.tasks.setExternalRef(linked.task_id, ticketLinkJson({ ...t, updated_at: t.updatedAt }, where));
  }
  // tickets that left the source (filter, closed) and were never imported leave the list
  const removed = await repos.tickets.pruneMissing(projectId, where, page.tickets.map((t) => t.sync_key), legacyNullScope);
  return { ...base, fetched: page.tickets.length, created: r.created, updated: r.updated, removed, truncated: page.truncated };
}

/** Every source of the project, one after the other; one failing source does not stop the rest. */
export async function syncProjectTickets(repos: Repositories, projectId: string, sources: TicketSource[]): Promise<SyncResult> {
  const perIntegration = new Map<string, number>();
  for (const s of sources) perIntegration.set(s.integration_id, (perIntegration.get(s.integration_id) ?? 0) + 1);
  const results: SourceSyncResult[] = [];
  for (const s of sources) results.push(await syncSource(repos, projectId, s, perIntegration.get(s.integration_id) === 1));
  const result = { sources: results, synced_at: new Date().toISOString() };
  lastByProject.set(projectId, result);
  return result;
}

/** Periodic sync: each source on its own sync_minutes. */
export function startTicketSyncScheduler(repos: Repositories, log: { info: (o: object, m: string) => void; warn: (o: object, m: string) => void }) {
  const lastRun = new Map<string, number>();
  const tick = async () => {
    const items = await repos.projectSetup.listWithAutoSync().catch(() => []);
    for (const item of items) {
      const all = (await repos.projectSetup.get(item.project_id)).data.ticket_sources;
      for (const source of item.sources) {
        const runKey = `${item.project_id}\u0000${sourceIdentity(source)}`;
        if (Date.now() - (lastRun.get(runKey) ?? 0) < source.sync_minutes * 60_000) continue;
        lastRun.set(runKey, Date.now());
        const onIntegration = all.filter((s) => s.integration_id === source.integration_id).length;
        const r = await syncSource(repos, item.project_id, source, onIntegration === 1);
        const { error, ...counts } = r;
        if (error) log.warn({ projectId: item.project_id, provider: r.provider, scope: r.scope, err: error }, 'falha no sync de tickets');
        else log.info({ projectId: item.project_id, ...counts }, 'tickets sincronizados');
      }
    }
  };
```

Keep the rest of the scheduler function (the interval, the first run and the returned stop function) exactly as it is today below `tick`. Remove `externalId` and `ticketRef`; Task 7 removes their last caller.

- [ ] **Step 4: Run it** → 4 passed.

- [ ] **Step 5: Commit** `Ticket sync: every source on its own, pruning only its own scope` (with trailer).

---

### Task 6: `control/tickets.ts` — the shared operations

**Files:**
- Modify: `apps/server/src/control/context.ts` (add `controlContextForRequest`)
- Create: `apps/server/src/control/tickets.ts`
- Test: `apps/server/src/control/tickets.test.ts`

**Interfaces:**
- Consumes:
  - from Task 1: `TicketsRepository.listByProject`, `.findByKeyish`, `.findByIds`, `.findByTaskId`, `.linkTask`, and `TasksRepository.findByIds`;
  - from Task 2: `ticketLinkJson`, `readTicketLink`;
  - from Task 4: `sourceIdentity`;
  - from Task 5: `syncProjectTickets`, `lastSync`, `SyncResult`.
- Produces:
  ```ts
  // context.ts
  export function controlContextForRequest(repos: Repositories, request: FastifyRequest): ControlContext;
  // tickets.ts
  export const TICKET_LIST_DEFAULT = 50, TICKET_LIST_MAX = 200, TICKET_IMPORT_MAX = 200, TICKET_DESCRIPTION_CUT = 500, SYNC_THROTTLE_MS = 60_000;
  export interface TicketOut { id: string; key: string; title: string; description: string | null; state: string; status: TaskStatus; url: string;
    source: { provider: IntegrationProvider; scope: string | null }; priority: unknown; labels: string[]; assignee: string | null;
    synced_at: string; card: { ref: string; url: string } | null }
  export function listTickets(ctx, input: { project_id: string; source?: string; status?: TaskStatus; imported?: boolean; query?: string; limit?: number }):
    Promise<{ tickets: TicketOut[]; total: number; last_sync: { at: string; sources: { provider: string; scope: string; truncated: boolean; error: string | null }[] } | null }>;
  export function getTicket(ctx, input: { key: string; project_id?: string }): Promise<{ ticket: TicketOut; project_id: string }>;
  export function syncTickets(ctx, input: { project_id: string }, now?: number): Promise<SyncResult & { cached: boolean }>;
  export function importTickets(ctx, input: { project_id: string; keys?: string[]; ticket_ids?: string[] }): Promise<{ cards: { ticket_key: string; card: TaskOut; task: Task; created: boolean }[] }>;
  export function pushTicketStatus(ctx, input: { task_id: string }): Promise<{ card: TaskOut; task: Task; ticket_key: string; state: string }>;
  export function resolveTickets(ctx, key: string, projectIds: string[]): Promise<Ticket[]>;  // used by find (Task 8)
  ```

- [ ] **Step 1: Add `controlContextForRequest`** to `control/context.ts`:

```ts
import type { FastifyRequest } from 'fastify';

/** A route's control context: the request's own scope, "view as" included (routes, unlike tokens, honour it). */
export function controlContextForRequest(repos: Repositories, request: FastifyRequest): ControlContext {
  const scope = request.scope;
  return { repos, scope, scoped: new Scoped(repos, scope), can: (resource, action) => canAccess(repos, scope.user, resource, action) };
}
```

- [ ] **Step 2: Write the failing test** `apps/server/src/control/tickets.test.ts`

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config.js', () => ({ config: { publicUrl: 'https://app.test' } }));
const syncProjectTickets = vi.fn();
let last: unknown = null;
vi.mock('../setup/tickets-sync.js', () => ({ syncProjectTickets, lastSync: () => last }));
const updateStatus = vi.fn();
vi.mock('../integrations/index.js', () => ({ getProvider: () => ({ updateStatus }) }));

import type { Repositories } from '../db/repositories/index.js';
import type { Project, Task, Ticket } from '../db/repositories/types.js';
import { Scoped } from '../auth/scope.js';
import type { ControlContext } from './context.js';
import { getTicket, importTickets, listTickets, pushTicketStatus, syncTickets } from './tickets.js';

const project = (id: string, owner: string): Project => ({ id, owner_id: owner, key: id.toUpperCase(), next_task_number: 1, name: id, status: 'active', description: null, last_terminal_at: null, created_at: '' });
const ticket = (over: Partial<Ticket> & { id: string; key: string }): Ticket => ({
  project_id: 'p1', integration_id: 'g', scope: 'acme/api', provider: 'github', sync_key: `s-${over.id}`, title: `T ${over.id}`,
  description: 'x'.repeat(800), url: `https://github.com/${over.key.replace('#', '/issues/')}`, state: 'open', status: 'backlog',
  meta: { labels: ['bug'], assignee: 'ana' }, task_id: null, synced_at: '2026-09-26T10:00:00.000Z', created_at: '', ...over,
});
const task = (over: Partial<Task> & { id: string }): Task => ({
  project_id: 'p1', type: 'task', number: 7, ref: 'P1-7', title: 't', description: null, status: 'doing', position: 0, external_ref: null, external_key: null,
  tab_id: null, parent_id: null, epic_id: 'e1', column_id: 'c2', created_at: '', updated_at: '', ...over,
});

let tickets: Ticket[];
let tasks: Task[];
function ctxFor(user = 'u1'): ControlContext {
  const projects = [project('p1', 'u1'), project('p2', 'u1'), project('px', 'u2')];
  const repos = {
    projects: { findById: vi.fn(async (id: string) => projects.find((p) => p.id === id)), list: vi.fn(async () => projects.filter((p) => p.owner_id === user)) },
    projectSetup: { get: vi.fn(async () => ({ data: { ticket_sources: [{ provider: 'github', integration_id: 'g', scope: 'acme/api', filter: null, sync_minutes: 0 }] } })) },
    tickets: {
      listByProject: vi.fn(async (pid: string) => tickets.filter((t) => t.project_id === pid)),
      findByIds: vi.fn(async (pid: string, ids: string[]) => tickets.filter((t) => t.project_id === pid && ids.includes(t.id))),
      findByKeyish: vi.fn(async (pids: string[], q: { key?: string; url?: string; suffix?: string }) =>
        tickets.filter((t) => pids.includes(t.project_id) && (q.url ? t.url === q.url : q.key ? t.key.toLowerCase() === q.key.toLowerCase() : t.key.toLowerCase().endsWith(q.suffix!.toLowerCase())))),
      findByTaskId: vi.fn(async (id: string) => tickets.find((t) => t.task_id === id)),
      linkTask: vi.fn(async (tid: string, taskId: string) => { tickets = tickets.map((t) => (t.id === tid ? { ...t, task_id: taskId } : t)); }),
    },
    tasks: {
      findById: vi.fn(async (id: string) => tasks.find((t) => t.id === id)),
      findByIds: vi.fn(async (ids: string[]) => tasks.filter((t) => ids.includes(t.id))),
      createFromTicket: vi.fn(async (pid: string, input: { title: string; ref: Record<string, unknown> }) => { const t = task({ id: `new-${tasks.length}`, project_id: pid, title: input.title, external_ref: input.ref }); tasks.push(t); return t; }),
      setExternalRef: vi.fn(async () => undefined),
    },
    integrations: { findById: vi.fn(async () => ({ id: 'g', owner_id: 'u1', provider: 'github', config: {} })), getSecret: vi.fn(async () => 'tok') },
  } as unknown as Repositories;
  const scope = { user: { id: user } as never, viewAs: { kind: 'self' as const }, ownerId: user, createAs: user };
  return { repos, scope, scoped: new Scoped(repos, scope), can: async () => true };
}

beforeEach(() => {
  vi.clearAllMocks();
  last = null;
  tickets = [
    ticket({ id: 'a', key: 'acme/api#12' }),
    ticket({ id: 'b', key: 'acme/web#12', scope: 'acme/web' }),
    ticket({ id: 'c', key: 'acme/api#13', task_id: 'k1', status: 'doing' }),
    ticket({ id: 'd', key: 'EI-5', provider: 'linear', project_id: 'p2', scope: 'EI', url: 'https://linear.app/x/issue/EI-5' }),
    ticket({ id: 'e', key: 'EI-5', provider: 'linear', project_id: 'p1', scope: 'EI', url: 'https://linear.app/y/issue/EI-5' }),
  ];
  tasks = [task({ id: 'k1', external_ref: { provider: 'github', id: '13', identifier: '#13', url: 'u', state: 'open', status: 'backlog', scope: 'acme/api' } })];
});

describe('listTickets', () => {
  it('filters by imported and query, cuts descriptions, names the card', async () => {
    const r = await listTickets(ctxFor(), { project_id: 'p1', imported: true });
    expect(r.tickets.map((t) => t.key)).toEqual(['acme/api#13']);
    expect(r.tickets[0].card).toEqual({ ref: 'P1-7', url: 'https://app.test/project/P1-7' });
    expect(r.tickets[0].description).toHaveLength(501); // 500 + "…"
    expect(r.tickets[0]).toMatchObject({ labels: ['bug'], assignee: 'ana', source: { provider: 'github', scope: 'acme/api' } });
    expect((await listTickets(ctxFor(), { project_id: 'p1', query: 'WEB#12' })).tickets.map((t) => t.key)).toEqual(['acme/web#12']);
  });

  it('is a 404 on another owner\'s project', async () => {
    await expect(listTickets(ctxFor('u2'), { project_id: 'p1' })).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('getTicket', () => {
  it('resolves exact key, URL and repo#n, with the full description', async () => {
    const ctx = ctxFor();
    expect((await getTicket(ctx, { project_id: 'p1', key: 'ACME/API#12' })).ticket.description).toHaveLength(800);
    expect((await getTicket(ctx, { project_id: 'p1', key: 'https://github.com/acme/web/issues/12' })).ticket.key).toBe('acme/web#12');
    expect((await getTicket(ctx, { project_id: 'p1', key: 'api#13' })).ticket.key).toBe('acme/api#13');
  });

  it('#12 matching two repos is TICKET_AMBIGUOUS naming both keys', async () => {
    await expect(getTicket(ctxFor(), { project_id: 'p1', key: '#12' })).rejects.toMatchObject({ code: 'TICKET_AMBIGUOUS', message: expect.stringContaining('acme/api#12, acme/web#12') });
  });

  it('without project: exact keys only, and the same key in two projects is ambiguous', async () => {
    await expect(getTicket(ctxFor(), { key: 'EI-5' })).rejects.toMatchObject({ code: 'TICKET_AMBIGUOUS' });
    await expect(getTicket(ctxFor(), { key: '#12' })).rejects.toMatchObject({ code: 'TICKET_NOT_FOUND' });
  });
});

describe('syncTickets', () => {
  it('reuses a sync younger than 60 s', async () => {
    last = { sources: [], synced_at: new Date(1_000_000).toISOString() };
    const r = await syncTickets(ctxFor(), { project_id: 'p1' }, 1_000_000 + 30_000);
    expect(r.cached).toBe(true);
    expect(syncProjectTickets).not.toHaveBeenCalled();
  });

  it('syncs when older, and says NO_TICKET_SOURCE without sources', async () => {
    syncProjectTickets.mockResolvedValue({ sources: [], synced_at: 'now' });
    last = { sources: [], synced_at: new Date(0).toISOString() };
    expect((await syncTickets(ctxFor(), { project_id: 'p1' }, 120_000)).cached).toBe(false);
    const ctx = ctxFor();
    (ctx.repos.projectSetup.get as ReturnType<typeof vi.fn>).mockResolvedValue({ data: { ticket_sources: [] } });
    await expect(syncTickets(ctx, { project_id: 'p1' })).rejects.toMatchObject({ code: 'NO_TICKET_SOURCE' });
  });
});

describe('importTickets', () => {
  it('imports by key with the plain title, and is idempotent', async () => {
    const ctx = ctxFor();
    const r = await importTickets(ctx, { project_id: 'p1', keys: ['acme/api#12', 'acme/api#13'] });
    expect(r.cards.map((c) => [c.ticket_key, c.created])).toEqual([['acme/api#12', true], ['acme/api#13', false]]);
    expect(ctx.repos.tasks.createFromTicket).toHaveBeenCalledWith('p1', expect.objectContaining({ title: 'T a', key: 's-a', ref: expect.objectContaining({ key: 'acme/api#12', integration_id: 'g' }) }));
  });
});

describe('pushTicketStatus', () => {
  it('finds the source of a legacy link by provider + scope and pushes the card status', async () => {
    updateStatus.mockResolvedValue('open');
    const r = await pushTicketStatus(ctxFor(), { task_id: 'k1' });
    expect(updateStatus).toHaveBeenCalledWith('tok', {}, { provider_id: '13', key: 'acme/api#13', scope: 'acme/api' }, 'doing');
    expect(r.ticket_key).toBe('acme/api#13');
  });

  it('a card without a ticket is NOT_LINKED', async () => {
    tasks.push(task({ id: 'k2' }));
    await expect(pushTicketStatus(ctxFor(), { task_id: 'k2' })).rejects.toMatchObject({ code: 'NOT_LINKED' });
  });
});
```

- [ ] **Step 3: Run it** → FAIL (module not found).

- [ ] **Step 4: Implement `apps/server/src/control/tickets.ts`**

```ts
import type { Task, TaskStatus, Ticket } from '../db/repositories/types.js';
import { getProvider, type IntegrationProvider } from '../integrations/index.js';
import { readTicketLink, ticketLinkJson } from '../integrations/ticket-link.js';
import { HttpError } from '../lib/errors.js';
import { lastSync, syncProjectTickets, type SyncResult } from '../setup/tickets-sync.js';
import type { ControlContext } from './context.js';
import { cardUrl, taskOut, type TaskOut } from './tasks.js';

// Same rule as inventory's normalizeName, kept local: inventory imports this module (find → resolveTickets).
const normalizeName = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();

export const TICKET_LIST_DEFAULT = 50;
export const TICKET_LIST_MAX = 200;
export const TICKET_IMPORT_MAX = 200;
export const TICKET_DESCRIPTION_CUT = 500;
export const SYNC_THROTTLE_MS = 60_000;

/** A ticket as the tools return it: no raw meta, no sync_key. */
export interface TicketOut {
  id: string;
  key: string;
  title: string;
  description: string | null;
  state: string;
  status: TaskStatus;
  url: string;
  source: { provider: IntegrationProvider; scope: string | null };
  priority: unknown;
  labels: string[];
  assignee: string | null;
  synced_at: string;
  card: { ref: string; url: string } | null;
}

const cut = (s: string | null, full: boolean) => (s && !full && s.length > TICKET_DESCRIPTION_CUT ? `${s.slice(0, TICKET_DESCRIPTION_CUT)}…` : s);

function toOut(t: Ticket, card: Task | undefined, full: boolean): TicketOut {
  const labels = Array.isArray(t.meta.labels) ? t.meta.labels.filter((l): l is string => typeof l === 'string') : [];
  return {
    id: t.id,
    key: t.key,
    title: t.title,
    description: cut(t.description, full),
    state: t.state,
    status: t.status,
    url: t.url,
    source: { provider: t.provider, scope: t.scope },
    priority: t.meta.priority ?? null,
    labels,
    assignee: typeof t.meta.assignee === 'string' ? t.meta.assignee : null,
    synced_at: t.synced_at,
    card: card ? { ref: card.ref, url: cardUrl(card.ref) } : null,
  };
}

async function cardsOf(ctx: ControlContext, tickets: Ticket[]): Promise<Map<string, Task>> {
  const ids = tickets.map((t) => t.task_id).filter((v): v is string => v !== null);
  return new Map((await ctx.repos.tasks.findByIds(ids)).map((t) => [t.id, t]));
}

export async function listTickets(
  ctx: ControlContext,
  input: { project_id: string; source?: string; status?: TaskStatus; imported?: boolean; query?: string; limit?: number },
) {
  await ctx.scoped.project(input.project_id);
  const q = input.query ? normalizeName(input.query) : '';
  const all = (await ctx.repos.tickets.listByProject(input.project_id)).filter(
    (t) =>
      (!input.source || t.scope === input.source.trim()) &&
      (!input.status || t.status === input.status) &&
      (input.imported === undefined || (t.task_id !== null) === input.imported) &&
      (!q || normalizeName(t.key).includes(q) || normalizeName(t.title).includes(q)),
  );
  const page = all.slice(0, Math.min(input.limit ?? TICKET_LIST_DEFAULT, TICKET_LIST_MAX));
  const cards = await cardsOf(ctx, page);
  const last = lastSync(input.project_id);
  return {
    tickets: page.map((t) => toOut(t, t.task_id ? cards.get(t.task_id) : undefined, false)),
    total: all.length,
    last_sync: last
      ? { at: last.synced_at, sources: last.sources.map((s) => ({ provider: s.provider, scope: s.scope, truncated: s.truncated ?? false, error: s.error ?? null })) }
      : null,
  };
}

const GITHUB_SHORT = /^(?:[\w.-]+\/)?([\w.-]+)?#(\d+)$/;

/**
 * Tickets a typed key names. Exact key or URL anywhere in `projectIds`; inside one project also
 * `repo#12` and `#12` (GitHub). Callers decide what several matches mean.
 */
export async function resolveTickets(ctx: ControlContext, key: string, projectIds: string[]): Promise<Ticket[]> {
  const k = key.trim();
  if (/^https?:\/\//i.test(k)) return ctx.repos.tickets.findByKeyish(projectIds, { url: k.replace(/\/$/, '') });
  const exact = await ctx.repos.tickets.findByKeyish(projectIds, { key: k });
  if (exact.length > 0 || projectIds.length !== 1) return exact;
  const m = GITHUB_SHORT.exec(k);
  if (!m) return [];
  return ctx.repos.tickets.findByKeyish(projectIds, { suffix: m[1] ? `/${m[1]}#${m[2]}` : `#${m[2]}` });
}

function one(key: string, found: Ticket[], projectNames: Map<string, string>): Ticket {
  if (found.length === 0) throw new HttpError(404, `Ticket ${key} não encontrado. Rode sync_tickets se ele for novo.`, 'TICKET_NOT_FOUND');
  if (found.length > 1) {
    const multiProject = new Set(found.map((t) => t.project_id)).size > 1;
    const names = found.map((t) => (multiProject ? `${projectNames.get(t.project_id) ?? t.project_id} / ${t.key}` : t.key)).join(', ');
    throw new HttpError(409, `${key} é ambíguo: ${names}. Use a chave completa.`, 'TICKET_AMBIGUOUS');
  }
  return found[0];
}

export async function getTicket(ctx: ControlContext, input: { key: string; project_id?: string }) {
  const projects = input.project_id ? [(await ctx.scoped.project(input.project_id)).project] : await ctx.repos.projects.list({ owner: ctx.scope.ownerId });
  const found = await resolveTickets(ctx, input.key, projects.map((p) => p.id));
  const t = one(input.key, found, new Map(projects.map((p) => [p.id, p.name])));
  const cards = await cardsOf(ctx, [t]);
  return { ticket: toOut(t, t.task_id ? cards.get(t.task_id) : undefined, true), project_id: t.project_id };
}

async function sourcesOf(ctx: ControlContext, projectId: string) {
  const sources = (await ctx.repos.projectSetup.get(projectId)).data.ticket_sources;
  if (sources.length === 0) throw new HttpError(400, 'Configure uma fonte de tickets no setup do projeto', 'NO_TICKET_SOURCE');
  return sources;
}

export async function syncTickets(ctx: ControlContext, input: { project_id: string }, now = Date.now()): Promise<SyncResult & { cached: boolean }> {
  await ctx.scoped.project(input.project_id);
  const sources = await sourcesOf(ctx, input.project_id);
  const last = lastSync(input.project_id);
  if (last && now - Date.parse(last.synced_at) < SYNC_THROTTLE_MS) return { ...last, cached: true };
  return { ...(await syncProjectTickets(ctx.repos, input.project_id, sources)), cached: false };
}

export async function importTickets(ctx: ControlContext, input: { project_id: string; keys?: string[]; ticket_ids?: string[] }) {
  const { project } = await ctx.scoped.project(input.project_id);
  if (!input.keys === !input.ticket_ids) throw new HttpError(400, 'Informe keys ou ticket_ids (um dos dois)', 'BAD_REQUEST');
  const names = new Map([[project.id, project.name]]);
  const picked: Ticket[] = input.ticket_ids
    ? await ctx.repos.tickets.findByIds(project.id, input.ticket_ids.slice(0, TICKET_IMPORT_MAX))
    : await Promise.all(input.keys!.slice(0, TICKET_IMPORT_MAX).map(async (k) => one(k, await resolveTickets(ctx, k, [project.id]), names)));
  const existing = await cardsOf(ctx, picked);
  const cards: { ticket_key: string; card: TaskOut; task: Task; created: boolean }[] = [];
  for (const t of picked) {
    const old = t.task_id ? existing.get(t.task_id) : undefined;
    if (old) {
      cards.push({ ticket_key: t.key, card: taskOut(old), task: old, created: false });
      continue;
    }
    const link = ticketLinkJson(
      { provider: t.provider, provider_id: providerIdOf(t), key: t.key, url: t.url, state: t.state, status: t.status, updated_at: String(t.meta.updated_at ?? ''), meta: t.meta },
      { integration_id: t.integration_id, scope: t.scope ?? String(t.meta.scope ?? '') },
    );
    const task = await ctx.repos.tasks.createFromTicket(project.id, { key: t.sync_key, title: t.title, description: t.description, ref: link });
    await ctx.repos.tickets.linkTask(t.id, task.id);
    cards.push({ ticket_key: t.key, card: taskOut(task), task, created: true });
  }
  return { cards };
}

/** The provider API id from the sync key: "linear:<uuid>", "jira:<KEY>", "github:<owner/repo>#<n>". */
function providerIdOf(t: Ticket): string {
  if (t.provider === 'github') return t.sync_key.split('#').pop() ?? t.sync_key;
  return t.sync_key.slice(t.sync_key.indexOf(':') + 1);
}

export async function pushTicketStatus(ctx: ControlContext, input: { task_id: string }) {
  const { task } = await ctx.scoped.task(input.task_id);
  const link = readTicketLink(task.external_ref);
  if (!link) throw new HttpError(400, 'Este card não está ligado a um ticket externo', 'NOT_LINKED');
  const sources = (await ctx.repos.projectSetup.get(task.project_id)).data.ticket_sources;
  const source =
    sources.find((s) => link.integration_id !== null && s.integration_id === link.integration_id && s.scope === link.scope) ??
    sources.find((s) => s.provider === link.provider && s.scope === link.scope);
  if (!source) throw new HttpError(400, `A fonte de ${link.key} não está mais no setup do projeto`, 'SOURCE_NOT_FOUND');
  const integration = await ctx.scoped.integration(source.integration_id);
  const secret = await ctx.repos.integrations.getSecret(source.integration_id);
  if (!secret) throw new HttpError(400, 'Integração sem credencial', 'SOURCE_NOT_FOUND');
  let state: string;
  try {
    state = await getProvider(link.provider).updateStatus(secret, integration.config, { provider_id: link.provider_id, key: link.key, scope: source.scope }, task.status);
  } catch (e) {
    throw new HttpError(502, (e as Error).message, 'PROVIDER_ERROR');
  }
  const next = { ...(task.external_ref as object), state, status: task.status, integration_id: source.integration_id, pushed_at: new Date().toISOString() };
  await ctx.repos.tasks.setExternalRef(task.id, next);
  const updated = { ...task, external_ref: next };
  return { card: taskOut(updated), task: updated, ticket_key: link.key, state };
}
```

This needs `taskOut` exported from `control/tasks.ts`. Today it is the private `out`; rename it to `export const taskOut` and replace its internal uses. Task 8 changes its `external_key` field.

- [ ] **Step 5: Run** `NODE 'npm test -w @termhub/server -- src/control/tickets.test.ts src/control/tasks.test.ts'` → all pass.

- [ ] **Step 6: Commit** `Tickets: list, get, sync, import and push as shared control operations` (with trailer).

---

### Task 7: Routes go through `control/tickets.ts`; setup save cleans removed sources

**Files:**
- Modify: `apps/server/src/routes/tickets.ts`, `apps/server/src/routes/setup.ts`
- Test: `apps/server/src/routes/tickets.test.ts` (extend), `apps/server/src/routes/setup.test.ts` (new)

**Interfaces:**
- Consumes:
  - from Task 6: `controlContextForRequest`, `listTickets`, `importTickets`, `syncTickets`, `pushTicketStatus`;
  - from Task 4: `setupInputSchema`, `sourceIdentity`;
  - from Task 1: `pruneSource`;
  - from Task 2: `readTicketLink`.
- Produces the REST shapes the web uses (Task 9):
  - `GET /projects/:id/tickets` → `{ tickets: Ticket[] }`: the repository rows, unchanged in spirit, with the new field names.
  - `POST /projects/:id/tickets/import` `{ ticket_ids }` → `{ tasks: Task[] }`.
  - `POST /projects/:id/tickets/sync` → `SyncResult & { cached: boolean }`. It answers 200 if any source succeeded and 502 `PROVIDER_ERROR` (message = first error) if all failed.
  - `POST /tasks/:id/push-status` → `{ task: Task, state }`.

- [ ] **Step 1: Write the failing tests.**

Append to `routes/tickets.test.ts`:

```ts
describe('POST /tasks/:id/terminal names the tab by the ticket key', () => {
  it('uses the key of a legacy GitHub link', async () => {
    const { app, createTab } = buildApp([link('p1', 'm1')]);
    const res = await app.inject({ method: 'POST', url: '/tasks/t2/terminal' });
    expect(res.statusCode).toBe(200);
    expect(createTab).toHaveBeenCalledWith('p1', 'm1', 'acme/api#4');
  });
});
```

In `buildApp`, add `t2: task({ id: 't2', project_id: 'p1', external_ref: { provider: 'github', id: '4', identifier: '#4', url: 'u', state: 'open', status: 'backlog', scope: 'acme/api' } }),` to `tasks`.

Create `routes/setup.test.ts`:

```ts
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { Repositories } from '../db/repositories/index.js';
import { applyErrorHandler } from '../lib/errors.js';
import { setupRoutes } from './setup.js';

vi.mock('../setup/tickets-sync.js', () => ({
  syncProjectTickets: vi.fn(async () => ({ sources: [{ provider: 'github', integration_id: 'g', scope: 'a/b', error: 'Falha ao consultar github: 401' }], synced_at: 'now' })),
  lastSync: () => null,
}));

function build(saved: unknown[]) {
  const app = Fastify();
  applyErrorHandler(app);
  app.addHook('preHandler', async (request) => {
    request.scope = { user: { id: 'u1', role: 'admin' } as never, viewAs: { kind: 'self' }, ownerId: 'u1', createAs: 'u1' };
    request.user = { id: 'u1' } as never;
  });
  const pruneSource = vi.fn(async () => 2);
  const repos = {
    projects: { findById: vi.fn(async () => ({ id: 'p1', owner_id: 'u1' })) },
    integrations: { findById: vi.fn(async (id: string) => ({ id, owner_id: 'u1', provider: 'github', config: {} })) },
    machines: { findById: vi.fn() },
    projectSetup: {
      get: vi.fn(async () => ({ data: { ticket_sources: saved } })),
      save: vi.fn(async (_p: string, data: unknown) => ({ data })),
    },
    tickets: { pruneSource },
  } as unknown as Repositories;
  app.register((a) => setupRoutes(a, repos), { prefix: '/projects' });
  return { app, pruneSource };
}

const src = (scope: string) => ({ provider: 'github', integration_id: 'g', scope, filter: null, sync_minutes: 0 });

describe('setup routes', () => {
  it('saving without a source prunes that source\'s non-imported tickets', async () => {
    const { app, pruneSource } = build([src('a/b'), src('a/c')]);
    const res = await app.inject({ method: 'PUT', url: '/projects/p1/setup', payload: { ticket_sources: [src('a/b')] } });
    expect(res.statusCode).toBe(200);
    expect(pruneSource).toHaveBeenCalledExactlyOnceWith('p1', { integration_id: 'g', scope: 'a/c' });
  });

  it('refuses a duplicate source', async () => {
    const { app } = build([]);
    const res = await app.inject({ method: 'PUT', url: '/projects/p1/setup', payload: { ticket_sources: [src('a/b'), src('a/b')] } });
    expect(res.statusCode).toBe(400);
  });

  it('sync answers 502 when every source failed', async () => {
    const { app } = build([src('a/b')]);
    const res = await app.inject({ method: 'POST', url: '/projects/p1/tickets/sync' });
    expect(res.statusCode).toBe(502);
    expect(res.json().code).toBe('PROVIDER_ERROR');
  });
});
```

(`canAccess` is not reached by these routes' handlers; if the test's `admin` role shape does not satisfy `Scoped`, mirror the user fixture of `routes/projects.test.ts`.)

- [ ] **Step 2: Run them** → FAIL.

- [ ] **Step 3: Rewrite `routes/setup.ts` handlers**

```ts
import { controlContextForRequest } from '../control/context.js';
import { syncTickets } from '../control/tickets.js';
import { HttpError } from '../lib/errors.js';
import { setupInputSchema, sourceIdentity } from '../setup/schema.js';

  app.put('/:id/setup', async (request) => {
    const { id } = idParam.parse(request.params);
    await scoped(repos, request).project(id);
    const data = setupInputSchema.parse(request.body);
    const s = scoped(repos, request);
    const exists = (p: Promise<unknown>) => p.then(() => true, () => false);
    for (const src of data.ticket_sources) {
      if (!(await exists(s.integration(src.integration_id)))) throw badRequest('Integração de tickets inexistente');
    }
    if (data.repo?.integration_id && !(await exists(s.integration(data.repo.integration_id)))) throw badRequest('Integração do repositório inexistente');
    if (data.runner.machine_id && !(await exists(s.machine(data.runner.machine_id)))) throw badRequest('Máquina do runner inexistente');
    const before = (await repos.projectSetup.get(id)).data.ticket_sources;
    const kept = new Set(data.ticket_sources.map(sourceIdentity));
    const saved = await repos.projectSetup.save(id, data);
    for (const gone of before.filter((b) => !kept.has(sourceIdentity(b)))) {
      await repos.tickets.pruneSource(id, { integration_id: gone.integration_id, scope: gone.scope });
    }
    return { setup: saved };
  });

  app.post('/:id/tickets/sync', { config: { resource: 'tickets', action: 'update' } }, async (request) => {
    const { id } = idParam.parse(request.params);
    const result = await syncTickets(controlContextForRequest(repos, request), { project_id: id });
    const failed = result.sources.filter((x) => x.error);
    if (result.sources.length > 0 && failed.length === result.sources.length) throw new HttpError(502, failed[0].error!, 'PROVIDER_ERROR');
    return { ok: true, ...result };
  });
```

Drop the `setupSchema` and `syncProjectTickets` imports from this file.

- [ ] **Step 4: Rewrite `routes/tickets.ts`.** The import handler becomes:

```ts
  app.post('/:id/tickets/import', { config: { resource: 'tasks', action: 'create' } }, async (request) => {
    const { id } = idParam.parse(request.params);
    const { ticket_ids } = importBody.parse(request.body);
    const { cards } = await importTickets(controlContextForRequest(repos, request), { project_id: id, ticket_ids });
    // the control operation already loaded everything through the scope (CLAUDE.md: no findById in handlers)
    return { tasks: cards.filter((c) => c.created).map((c) => c.task) };
  });
```

The push-status handler becomes:

```ts
  app.post('/:id/push-status', { config: { action: 'update' } }, async (request) => {
    const { id } = idParam.parse(request.params);
    const { task, state } = await pushTicketStatus(controlContextForRequest(repos, request), { task_id: id });
    return { task, state };
  });
```

In `POST /:id/terminal`, the tab name becomes `(readTicketLink(task.external_ref)?.key ?? task.title).slice(0, 40)`. Remove the `getProvider`, `externalId`, `ticketRef` and `badRequest` imports that are now unused, and import `controlContextForRequest`, `importTickets`, `pushTicketStatus` and `readTicketLink`.

- [ ] **Step 5: Run** `NODE 'npm test -w @termhub/server -- src/routes/tickets.test.ts src/routes/setup.test.ts' && NODE 'npm run typecheck -w @termhub/server'` → pass, typecheck clean (this is the first point where the server typechecks again after Task 3).

- [ ] **Step 6: Commit** `Ticket routes: thin handlers over the control operations` (with trailer).

---

### Task 8: MCP tools, `find`, `TaskOut.ticket`, gate classes, card sentences, prompt

**Files:**
- Modify: `apps/server/src/control/tasks.ts` (`TaskOut`)
- Modify: `apps/server/src/control/inventory.ts` (`find` kind `ticket`)
- Modify: `apps/server/src/mcp/tools.ts`
- Modify: `apps/server/src/chat/gate.ts`
- Modify: `apps/server/src/db/repositories/chat-actions-view.ts`
- Modify: `apps/server/src/chat/project-prompt.ts`
- Test: `apps/server/src/mcp/tools.test.ts`, `apps/server/src/chat/gate.test.ts`, `apps/server/src/db/repositories/chat-actions-view.test.ts`, `apps/server/src/control/inventory.test.ts`, `apps/server/src/control/tasks.test.ts`, `apps/server/src/chat/project-prompt.test.ts`

**Interfaces:**
- Consumes:
  - from Task 6: `listTickets`, `getTicket`, `syncTickets`, `importTickets`, `pushTicketStatus`, `resolveTickets`, `TICKET_LIST_MAX`, `TICKET_IMPORT_MAX`;
  - from Task 2: `readTicketLink`.
- Produces:
  - `TaskOut.ticket: { key: string; url: string; state: string; provider: string } | null`, which replaces `external_key`;
  - `FindKind` gains `'ticket'`.

- [ ] **Step 1: Write the failing tests.**

`mcp/tools.test.ts` (append):

```ts
it('ticket tools carry the right scope, grant and inputs', () => {
  const by = (n: string) => TOOLS.find((t) => t.name === n)!;
  expect([by('list_tickets').scope, by('list_tickets').resource, by('list_tickets').action]).toEqual(['read', 'tickets', 'read']);
  expect([by('get_ticket').scope, by('get_ticket').resource, by('get_ticket').action]).toEqual(['read', 'tickets', 'read']);
  expect([by('sync_tickets').scope, by('sync_tickets').resource, by('sync_tickets').action]).toEqual(['tasks', 'tickets', 'update']);
  expect([by('import_tickets').scope, by('import_tickets').resource, by('import_tickets').action]).toEqual(['tasks', 'tasks', 'create']);
  expect([by('push_ticket_status').scope, by('push_ticket_status').resource, by('push_ticket_status').action]).toEqual(['tasks', 'tasks', 'update']);
  expect(parseArgs(by('list_tickets'), { project_id: 'p', limit: 201 }).ok).toBe(false);
  expect(parseArgs(by('import_tickets'), { project_id: 'p', keys: ['EI-1'] }).ok).toBe(true);
  expect(parseArgs(by('get_ticket'), { key: 'EI-1' }).ok).toBe(true);
  expect(parseArgs(by('find'), { query: 'EI-1', kinds: ['ticket'] }).ok).toBe(true);
});
```

(Add `parseArgs` to that file's import from `./tools.js` if it is not there.)

`chat/gate.test.ts` (append):

```ts
it('classifies the ticket tools', () => {
  expect(actionClass('list_tickets', {})).toBe('read');
  expect(actionClass('get_ticket', {})).toBe('read');
  expect(actionClass('sync_tickets', {})).toBe('write');
  expect(actionClass('import_tickets', {})).toBe('write');
  expect(actionClass('push_ticket_status', {})).toBe('irreversible');
});
```

In `chat-actions-view.test.ts`, follow the file's fixture helpers. Add one case per tool asserting the summary:
- `import_tickets` with `{ project_id, keys: ['EI-1', 'EI-2'] }` → starts with `importar 2 tickets para o backlog: EI-1, EI-2`;
- `sync_tickets` → starts with `sincronizar os tickets de todas as fontes`;
- `push_ticket_status` on a task whose `external_ref` is `{ provider: 'linear', key: 'EI-1', provider_id: 'u', status: 'done' }` → contains `levar a coluna da tarefa` and `para o EI-1 no Linear`.

In `inventory.test.ts`, following its fixtures: `find(ctx, { query: 'EI-5', kinds: ['ticket'] })` with one ticket → a match `{ kind: 'ticket', id, name: 'EI-5 <title>', score: 3 }`. With no `tickets:read` grant → no ticket match.

In `tasks.test.ts`, update the existing `listTasks` expectation for `k1`: `ticket` is `readTicketLink`'s `{ key, url, state, provider }` or `null`, and there is no `external_key`. Its fixture `external_ref: { provider: 'linear' }` has no key, so `ticket` is `null`. Add a fixture with `external_ref: { provider: 'linear', key: 'LIN-1', provider_id: 'u', url: 'x', state: 'Todo', status: 'todo' }` and assert `ticket: { key: 'LIN-1', url: 'x', state: 'Todo', provider: 'linear' }`.

In `project-prompt.test.ts`, assert the prompt contains `list_tickets` and stays ≤ 4000 characters with a long link list (the existing length test covers the cap).

- [ ] **Step 2: Run them** → FAIL.

- [ ] **Step 3: `TaskOut`.** In `control/tasks.ts`, replace `external_key: string | null;` with:

```ts
  /** the external ticket this card came from (Linear/Jira/GitHub), or null */
  ticket: { key: string; url: string; state: string; provider: string } | null;
```

In `taskOut`, replace `external_key: t.external_key` with:

```ts
ticket: (() => { const l = readTicketLink(t.external_ref); return l ? { key: l.key, url: l.url, state: l.state, provider: l.provider } : null; })(),
```

Import `readTicketLink`.

- [ ] **Step 4: `find` tickets.** In `control/inventory.ts`:
  - `FindKind` gains `'ticket'`.
  - The default kinds stay `['machine', 'project', 'ai_account', 'task']`, because tickets are opt-in: a machine named like a key must not drown in tickets.
  - Add `ctx.can('tickets', 'read')` to the `Promise.all`.
  - Add after the task block:

```ts
  // A ticket only by its exact key or URL ("EI-123", "owner/repo#12"), across the user's projects.
  if (kinds.has('ticket') && canTickets) {
    const projectIds = (await ctx.repos.projects.list({ owner: ctx.scope.ownerId })).map((p) => p.id);
    for (const t of await resolveTickets(ctx, input.query, projectIds)) {
      matches.push({ kind: 'ticket', id: t.id, name: `${t.key} ${t.title}`, machine_id: null, machine_name: null, score: 3 });
    }
  }
```

Import `resolveTickets` from `./tickets.js`. `resolveTickets` only takes short GitHub forms when given one project, so here only exact keys and URLs match, as the spec says.

- [ ] **Step 5: Tools.** In `mcp/tools.ts`, import the five operations and constants, and add after `delete_task`:

```ts
  {
    name: 'list_tickets',
    description: `List the external tickets (Linear, Jira, GitHub issues) synced into a project — open tickets only, from every source in the project setup. These are not cards: a ticket becomes a card only through import_tickets (card: null until then). source: a scope ("EI", "PROJ", "owner/repo"); imported: false = still to triage; query: key or title. limit default 50, max ${TICKET_LIST_MAX}; total counts all matches. last_sync.sources[].truncated = that source has more than 500 open tickets and the list is partial. Call sync_tickets first when freshness matters.`,
    scope: 'read', resource: 'tickets', action: 'read',
    input: { project_id: id, source: z.string().trim().min(1).max(200).optional(), status: taskStatus.optional(), imported: z.boolean().optional(), query: z.string().trim().min(1).max(200).optional(), limit: z.number().int().min(1).max(TICKET_LIST_MAX).optional() },
    run: (ctx, a) => listTickets(ctx, a as { project_id: string; source?: string; status?: TaskStatus; imported?: boolean; query?: string; limit?: number }),
  },
  {
    name: 'get_ticket',
    description: 'One external ticket with its full description. key: "EI-123", "PROJ-45", "owner/repo#12" or the ticket URL; with project_id also "repo#12" or "#12". An ambiguous key answers with the candidates. To work on it: import_tickets, then start_agent with the card\'s task id.',
    scope: 'read', resource: 'tickets', action: 'read',
    input: { key: z.string().trim().min(1).max(300), project_id: id.optional() },
    run: (ctx, a) => getTicket(ctx, a as { key: string; project_id?: string }),
  },
  {
    name: 'sync_tickets',
    description: 'Fetch the open tickets of every source of the project now (Linear, Jira, GitHub). A sync younger than 60 s is reused (cached: true). One failing source does not stop the others: see sources[].error.',
    scope: 'tasks', resource: 'tickets', action: 'update',
    input: { project_id: id },
    run: (ctx, a) => syncTickets(ctx, a as { project_id: string }),
  },
  {
    name: 'import_tickets',
    description: `Send external tickets to the project backlog as cards linked to them (default epic). keys (same forms as get_ticket) or ticket_ids — exactly one — max ${TICKET_IMPORT_MAX}. A ticket already imported returns its card with created: false.`,
    scope: 'tasks', resource: 'tasks', action: 'create',
    input: { project_id: id, keys: z.array(z.string().trim().min(1).max(300)).min(1).max(TICKET_IMPORT_MAX).optional(), ticket_ids: z.array(id).min(1).max(TICKET_IMPORT_MAX).optional() },
    run: (ctx, a) => importTickets(ctx, a as { project_id: string; keys?: string[]; ticket_ids?: string[] }),
  },
  {
    name: 'push_ticket_status',
    description: "Change the external ticket's state (Linear/Jira/GitHub) to match its card's current column. It writes to a third-party system and notifies people there: the person always confirms it.",
    scope: 'tasks', resource: 'tasks', action: 'update',
    input: { task_id: id },
    run: (ctx, a) => pushTicketStatus(ctx, a as { task_id: string }),
  },
```

In `find`:
- the description gains ", and external tickets by exact key or URL (kinds: ['ticket'])";
- `kinds` enum gains `'ticket'`;
- `allowedIf` adds `ctx.can('tickets', 'read')`;
- `grantText` becomes `'de leitura de máquinas, projetos, tarefas, tickets ou contas de IA'`.

In `list_tasks`, the description sentence about each card gains: "and its ticket ({ key, url, state, provider } when it came from Linear/Jira/GitHub)".

- [ ] **Step 6: Gate.** In `chat/gate.ts`:
  - `readTools` gains `'list_tickets'` and `'get_ticket'`;
  - `writeTools` gains `'sync_tickets'` and `'import_tickets'`;
  - `irreversibleTools` becomes `new Set(['close_tab', 'delete_task', 'push_ticket_status'])`.

- [ ] **Step 7: Card sentences.** In `chat-actions-view.ts` `verbPhrase`, before `default`:

```ts
    case 'sync_tickets':
      return 'sincronizar os tickets de todas as fontes';
    case 'import_tickets': {
      const keys = Array.isArray(args.keys) ? args.keys.filter((k): k is string => typeof k === 'string') : [];
      const ids = Array.isArray(args.ticket_ids) ? args.ticket_ids.length : 0;
      const n = keys.length || ids;
      return `importar ${n} ${n === 1 ? 'ticket' : 'tickets'} para o backlog${keys.length ? `: ${keys.join(', ')}` : ''}`;
    }
    case 'push_ticket_status': {
      const link = task ? readTicketLink(task.external_ref) : null;
      if (!task) return 'atualizar o ticket de uma tarefa que não existe mais';
      return link
        ? `levar a coluna da tarefa ${named(task)} para o ${link.key} no ${PROVIDER_NAME[link.provider]}`
        : `atualizar o ticket da tarefa ${named(task)}`;
    }
```

Add `const PROVIDER_NAME = { github: 'GitHub', linear: 'Linear', jira: 'Jira' } as const;` near `named`, and import `readTicketLink`. `taskIdOf` already reads `args.task_id`, so the task resolves with no other change.

- [ ] **Step 8: Prompt.** In `chat/project-prompt.ts` `tail`, after the "Enquanto isso" line, add:

```ts
    'External tickets (Linear, Jira, GitHub issues) are not cards: find them with list_tickets / get_ticket, bring them in with import_tickets.\n' +
```

- [ ] **Step 9: Run** `NODE 'npm test -w @termhub/server' && NODE 'npm run typecheck -w @termhub/server'`. Expected: the whole server suite passes and the typecheck is clean.

- [ ] **Step 10: Commit** `MCP: list, read, sync, import and push external tickets` (with trailer).

---

### Task 9: Web — sources in the setup, title + key subtitle, source filter

**Files:**
- Modify: `apps/web/src/lib/types.ts`, `apps/web/src/lib/api.ts`
- Create: `apps/web/src/lib/ticket-link.ts`, `apps/web/src/lib/ticket-link.test.ts`
- Modify: `apps/web/src/components/SetupForm.tsx`, `TicketsView.tsx`, `TasksBoard.tsx`, `TaskEditor.tsx`
- Test: `apps/web/src/components/SetupForm.test.tsx` (new), `TicketsView.test.tsx` (new), `TasksBoard.test.tsx` (extend)

**Interfaces:**
- Consumes (REST, from Task 7):
  - `Ticket` rows now carry `key`, `sync_key` and `scope`, and no longer `identifier`/`external_key`;
  - sync returns `{ ok, sources: SourceSync[], synced_at, cached }`;
  - the setup has `ticket_sources`.
- Produces:
  ```ts
  // types.ts
  export interface TicketSource { provider: IntegrationProvider; integration_id: string; scope: string; filter: string | null; sync_minutes: number }
  export interface SourceSync { provider: IntegrationProvider; integration_id: string; scope: string; fetched?: number; created?: number; updated?: number; removed?: number; truncated?: boolean; error?: string }
  // ProjectSetupData gains ticket_sources: TicketSource[]; tickets keeps its type (server-owned mirror)
  // ExternalRef gains key?: string; provider_id?: string; integration_id?: string
  // lib/ticket-link.ts
  export function ticketKey(ref: ExternalRef): string;   // key ?? (github '#n' + scope → 'scope#n') ?? identifier
  ```

- [ ] **Step 1: Write the failing tests.**

`lib/ticket-link.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ticketKey } from './ticket-link';

describe('ticketKey', () => {
  it('prefers key, rebuilds a legacy GitHub #n with its scope, falls back to identifier', () => {
    expect(ticketKey({ provider: 'linear', id: 'u', identifier: 'EI-1', key: 'EI-1', url: '', state: '', status: 'todo' })).toBe('EI-1');
    expect(ticketKey({ provider: 'github', id: '4', identifier: '#4', url: '', state: '', status: 'backlog', scope: 'acme/api' })).toBe('acme/api#4');
    expect(ticketKey({ provider: 'jira', id: '1', identifier: 'P-1', url: '', state: '', status: 'todo' })).toBe('P-1');
  });
});
```

`TasksBoard.test.tsx` (extend, using its `task()` helper): a card with `title: 'Login quebra'` and `external_ref: { provider: 'github', id: '4', identifier: '#4', url: 'https://x', state: 'open', status: 'todo', scope: 'acme/api' }` renders the text `Login quebra`. It also renders a link named `acme/api#4` with `href="https://x"` in the subtitle line, and the title is not repeated inside that link.

`SetupForm.test.tsx`: mock `api` the same way `IntegrationsView.test.tsx` does, with `api.setup.get` → a setup with one source (`github`/`g`/`acme/api`) and `api.integrations.list` → one GitHub integration `g`. Then:
- clicking **Adicionar fonte** and picking integration `g` adds a second source row;
- typing `acme/api` into its scope shows `Fonte repetida` and disables **Salvar**;
- clicking **Remover** on the second row removes it;
- saving calls `api.setup.save` with `ticket_sources` of length 1.

`TicketsView.test.tsx`: mock `api.tickets.list` → two tickets, `acme/api#1` (scope `acme/api`) and `EI-2` (scope `EI`). Mock `api.setup.get` → two sources. Assert:
- each row shows the title and, under it, the key;
- choosing `EI` in the source select leaves only `EI-2`;
- after `api.setup.syncTickets` resolves with `sources: [{ scope: 'EI', truncated: true, fetched: 500 }]`, the text `EI tem mais de 500 tickets abertos; a lista está incompleta.` appears.

- [ ] **Step 2: Run** `NODE 'npm test -w @termhub/web -- src/lib/ticket-link.test.ts src/components/SetupForm.test.tsx src/components/TicketsView.test.tsx src/components/TasksBoard.test.tsx'` → FAIL.

- [ ] **Step 3: Types and API.** In `lib/types.ts`:
  - `Ticket`: replace `external_key`/`identifier` with `sync_key: string; key: string; scope: string | null;`.
  - Add `TicketSource` and `SourceSync` as in **Interfaces**.
  - `ProjectSetupData` gains `ticket_sources: TicketSource[];`.
  - `ExternalRef` gains `key?: string; provider_id?: string; integration_id?: string;`.

In `lib/api.ts`, `syncTickets` becomes:

```ts
request<{ ok: true; sources: SourceSync[]; synced_at: string; cached: boolean }>('POST', `/projects/${projectId}/tickets/sync`, {}),
```

Create `lib/ticket-link.ts`:

```ts
import type { ExternalRef } from './types';

/** The ticket key a card shows: new links carry `key`; legacy GitHub links carry "#12" and a scope. */
export function ticketKey(ref: ExternalRef): string {
  if (ref.key) return ref.key;
  if (ref.provider === 'github' && ref.identifier.startsWith('#') && ref.scope) return `${ref.scope}${ref.identifier}`;
  return ref.identifier;
}
```

- [ ] **Step 4: Board card.** In `TasksBoard.tsx`, remove the key chip from the title line: the whole `task.external_ref && (<a …>{task.external_ref.identifier}</a>)` block. The title line becomes `{task.title}`, which drops the `.replace(...)` trick. Right under the title row's closing `</div>`, add:

```tsx
      {task.external_ref && (
        <a
          href={task.external_ref.url}
          target="_blank"
          rel="noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="mt-0.5 block truncate font-mono text-[10px] text-accent hover:underline"
          title={`${PROVIDER_LABEL[task.external_ref.provider]}: ${task.external_ref.state}`}
        >
          {ticketKey(task.external_ref)}
        </a>
      )}
```

In `TaskEditor.tsx`, the chip text `{ref.identifier}` becomes `{ticketKey(ref)}`.

- [ ] **Step 5: TicketsView.**
  - State: add `const [source, setSource] = useState<string>('all');` and `const [truncated, setTruncated] = useState<SourceSync[]>([]);`.
  - Filter: add `(source === 'all' || t.scope === source)` to `filtered`. The query matches `t.key` instead of `t.identifier`.
  - Group by source: `bySource` groups by `` `${t.integration_id}\u0000${t.scope ?? ''}` ``. The header shows `PROVIDER_LABEL · integration name` and the group's own `scope`, not `setup.data.tickets.scope`. The per-group "select all" checkbox selects only that group's selectable tickets.
  - Toolbar: after the status select, add

```tsx
{sources.length > 1 && (
  <select className="input w-auto py-1" value={source} onChange={(e) => setSource(e.target.value)}>
    <option value="all">todas as fontes</option>
    {sources.map((s) => (
      <option key={`${s.integration_id}:${s.scope}`} value={s.scope}>{s.scope}</option>
    ))}
  </select>
)}
```

  with `const sources = setup?.data.ticket_sources ?? [];`. Replace every `source` / `!source` check on `setup.data.tickets` with `sources.length > 0`. Rename the old local `const source = setup?.data.tickets` away.
  - Row: the title goes on the first line, and the key is a mono link on the second line, before the state:

```tsx
<div className="min-w-0 flex-1">
  <span className="block truncate">{t.title}</span>
  <div className="mt-0.5 flex flex-wrap gap-x-3 text-[11px] text-fg-dim">
    <a href={t.url} target="_blank" rel="noreferrer" className="font-mono text-accent hover:underline">{t.key}</a>
    <span>{t.state}</span>
    …existing assignee / labels / "no board →" …
  </div>
</div>
```

  - Sync message:

```ts
const r = await api.setup.syncTickets(project.id);
const ok = r.sources.filter((s) => !s.error);
const sum = (k: 'fetched' | 'created' | 'updated' | 'removed') => ok.reduce((n, s) => n + (s[k] ?? 0), 0);
const errors = r.sources.filter((s) => s.error).map((s) => `${s.scope}: ${s.error}`);
setMsg([`${sum('fetched')} ticket(s) nas fontes · ${sum('created')} novo(s) · ${sum('updated')} atualizado(s) · ${sum('removed')} removido(s)`, ...errors].join(' · '));
setTruncated(r.sources.filter((s) => s.truncated));
```

  - Above the list, add:

```tsx
{truncated.map((s) => (
  <p key={s.scope} className="mb-2 rounded border border-warn/40 bg-warn/10 px-2 py-1 text-xs text-warn">
    {s.scope} tem mais de 500 tickets abertos; a lista está incompleta.
  </p>
))}
```

- [ ] **Step 6: SetupForm sources list.** Replace the whole `<Card title="Tickets" …>` body with a list over `data.ticket_sources`. Helpers inside the component:

```ts
const sources = data.ticket_sources;
const setSources = (next: TicketSource[]) => patch('ticket_sources', next);
const updateSource = (i: number, p: Partial<TicketSource>) => setSources(sources.map((s, j) => (j === i ? { ...s, ...p } : s)));
const identity = (s: TicketSource) => `${s.integration_id}\u0000${s.scope.trim()}`;
const duplicate = (i: number) => sources.some((s, j) => j < i && identity(s) === identity(sources[i]) && sources[i].scope.trim() !== '');
const anyDuplicate = sources.some((_, i) => duplicate(i));
```

The card hint becomes "Fontes das tarefas: tickets abertos de cada fonte aparecem em Tickets; os que você escolher entram no backlog do épico padrão." For each source `s` at index `i`, render a bordered block (`rounded-md border border-line p-3 space-y-2`) with:
- **Integração**: a `<select>` over `integrations`, whose `onChange` sets `provider` and `integration_id` and clears `scope`.
- **Scope**: the existing `SCOPE_LABEL[s.provider]` input with its datalist `scope-${project.id}-${i}` and the "listar" button (`loadOptions(s.integration_id)`, options from `conn[s.integration_id]`). When `duplicate(i)`, it shows `<p className="mt-1 text-xs text-danger">Fonte repetida</p>`.
- **Filter**: the existing filter input (`SCOPE_LABEL[s.provider].filterLabel` / `filterHint`).
- **Sync**: the existing "Sync automático a cada … min" input bound to `s.sync_minutes`.
- A `btn-ghost text-xs text-danger` button **Remover**: `setSources(sources.filter((_, j) => j !== i))`.

The "Incluir concluídos" checkbox is removed.

Below the list:
- a `btn-ghost border border-line text-xs` button **Adicionar fonte**, disabled when `integrations.length === 0`, which appends `{ provider: integrations[0].provider, integration_id: integrations[0].id, scope: '', filter: null, sync_minutes: 0 }`;
- the existing "Sincronizar agora" row, shown when `sources.length > 0`, with its message built as in TicketsView (sum and errors).

The form's Save button gets `disabled={… || anyDuplicate}`. When `integrations.length === 0`, show `<Empty>Cadastre uma integração em Integrações.</Empty>` instead of the button.

- [ ] **Step 7: Run** `NODE 'npm test -w @termhub/web' && NODE 'npm run build -w @termhub/web'` → all pass, build ok.

- [ ] **Step 8: Commit** `Web: several ticket sources, ticket key as the card subtitle` (with trailer).

---

### Task 10: Final verification

- [ ] **Step 1: Full checks** (from the worktree root):

```bash
NODE 'npm test -w @termhub/server && npm test -w @termhub/web && npm run typecheck -w @termhub/server && npm run build -w @termhub/web && npm run build -w @termhub/landing'
NODEDB 'cd apps/server && npx prisma migrate deploy && cd ../.. && TERMHUB_DB_TESTS=1 npm test -w @termhub/server -- src/db/repositories/tickets.db.test.ts'
rm -rf .npm
```

Expected: everything green. If the mobile workspace imports server types that changed (`grep -rn "external_key\|identifier" apps/mobile/src` finds none today), run `npm test -w @termhub/mobile` too.

- [ ] **Step 2: Migration against a copy of the previous release's data.** On the throwaway DB:
  1. Insert a ticket with `meta = '{"scope":"acme/api"}'` and no `scope`, then run the migration and check that `scope` was backfilled.
  2. Save a setup JSON with only `tickets` (the previous release's shape) and read it back through `ProjectSetupRepository.get`. `ticket_sources` must have one source.

- [ ] **Step 3: Teardown** — `docker rm -f th-test-db-tickets && docker network rm th-net-tickets`.

- [ ] **Step 4: Commit** any fix-ups, and stop there. Pushing and opening the PR is the person's call.
