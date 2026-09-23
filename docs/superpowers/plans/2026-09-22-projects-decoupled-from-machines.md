# Projects Decoupled From Machines Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a project a user-owned entity with a unique short key, linked to zero or more machines (each with its own working directory), so deleting a machine never deletes a project and a tab knows which machine it runs on.

**Architecture:** `projects` loses `machine_id`/`cwd` and gains `owner_id`, `key`, `next_task_number`; a new `project_machines` link table carries the per-machine `cwd`; `tabs` gains `machine_id`. Ownership scoping reads `project.owner_id` directly and resolves a tab's machine through `tab.machine_id`. Every place that used `project.machine_id` / `project.cwd` (terminal spawn, MCP control, monitor, office, dashboard, web) is moved to the link or the tab.

**Tech Stack:** Fastify 5 + zod, Prisma 7 (`@prisma/adapter-pg`, Postgres 16), vitest; React 18 + Vite + react-router 7 + Tailwind; npm workspaces (`-w @termhub/server`, `-w @termhub/web`). Node runs only inside Docker on this host.

**Spec:** `docs/superpowers/specs/2026-09-22-projects-decoupled-from-machines-design.md`

## Global Constraints

- Repo: `/home/pedrogoiania/termhub`, branch `feat/projects-decoupled-from-machines` (already created, holds the spec commit).
- Commit messages in English, imperative subject ≤ 72 chars (CLAUDE.md). UI copy stays pt-BR. Code/comments in English.
- Routes never import Prisma; go through `apps/server/src/db/repositories`. Every request input validated with zod. In handlers, load projects/tabs/machines through `scoped(repos, request).<kind>()`, never `repos.*.findById`.
- Project key: `^[A-Z][A-Z0-9]{1,9}$`, globally unique, immutable after creation.
- No backward compatibility with the previous release is required for this migration (spec §1, §11). CI still runs `prisma migrate deploy` then `prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code`, so the migration SQL must produce exactly the schema.
- The host has no Node. Run every npm/npx command through Docker. Define once per shell:

```bash
cd /home/pedrogoiania/termhub
# plain node (typecheck, unit tests, prisma generate)
th() { docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/w" -w /w node:20 sh -c "$*"; }
# node + disposable Postgres (repository *.db.test.ts, migrations)
thdb() { docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp --network th-test -e DATABASE_URL=postgresql://postgres:postgres@th-test-db:5432/termhub -e TERMHUB_DB_TESTS=1 -v "$PWD:/w" -w /w node:20 sh -c "$*"; }
```

  One-time test database (recreate it whenever you need a clean slate):

```bash
docker network create th-test 2>/dev/null || true
docker rm -f th-test-db 2>/dev/null; docker run -d --name th-test-db --network th-test -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=termhub postgres:16
sleep 3 && thdb 'npm ci --no-audit --no-fund >/dev/null && cd apps/server && npx prisma migrate deploy'
```

  After any Docker run: `rm -rf .npm` (cache the container leaves behind).
- Existing tests that build a project with `machine_id`/`cwd` must be updated in the task that changes the code they cover; the full list is in Task 8's checklist. `npm test -w @termhub/server` and `npm test -w @termhub/web` must be green at the end of every task.

## Deviations from the spec (deliberate, small)

- Link reordering (`PATCH /projects/:id/machines/:machineId { position }` and `ProjectMachinesRepository.reorder`) is not built: `position` is assigned at link time and lists follow it. Nothing in the UI reorders links yet.
- `GET /projects/:id/machines` returns `machine: { id, name, type }` without `online`: the web already holds live machine statuses in its data provider and renders them from there.
- The migration is verified by a scripted run against old-shape rows (Task 1 Step 4) rather than an automated vitest case: Prisma offers no clean way to run one migration from inside a test.

## File map

Server (`apps/server`):
- `prisma/schema.prisma` — Project, ProjectMachine (new), Tab, Machine, User relations.
- `prisma/migrations/20260923000000_projects_decoupled_from_machines/migration.sql` — new.
- `src/lib/project-key.ts` (+ test) — key validation and suggestion; pure.
- `src/db/repositories/types.ts` — `Project`, `ProjectMachine`, `Tab`, mappers.
- `src/db/repositories/projects.ts` (+ `projects.db.test.ts`) — owner filter, key, `ProjectRuleError`.
- `src/db/repositories/project-machines.ts` (+ `project-machines.db.test.ts`) — new.
- `src/db/repositories/tabs.ts` (+ `tabs.db.test.ts`) — `machineId` on tabs.
- `src/db/repositories/index.ts` — register `projectMachines`.
- `src/auth/scope.ts` (+ `scope.test.ts`) — `project`, `projectMachine`, `projectMachines`, `projectMachineFor`, `tab`, `task`.
- `src/routes/projects.ts` (+ new `projects.test.ts`) — CRUD, key-available, machine links, tabs.
- `src/routes/machines.ts` (+ test) — delete no longer blocked by projects.
- `src/routes/tabs.ts`, `src/routes/monitor.ts`, `src/monitor/ingest.ts` — machine from the tab.
- `src/terminal/pty-session.ts`, `src/agent/pty.ts`, `src/terminal/ws.ts`, `src/simulator/ws.ts` — `cwd` instead of `project`.
- `src/control/terminals.ts`, `src/control/agents.ts`, `src/control/inventory.ts`, `src/mcp/tools.ts` (+ tests) — `machine_id` input, links in output.
- `src/routes/dashboard.ts`, `src/routes/office.ts` (+ tests) — links and `tab.machine_id`.

Web (`apps/web/src`):
- `lib/types.ts`, `lib/api.ts`, `lib/data.tsx`, `lib/project-key.ts` (+ test) — model and client.
- `components/Sidebar.tsx`, `components/ProjectForm.tsx` — two sections, key field, optional machine.
- `components/ProjectMachines.tsx` (new), `components/ProjectSettings.tsx`, `components/SetupForm.tsx` — link management.
- `components/TerminalsView.tsx`, `pages/ProjectPage.tsx` — machine choice per tab, badge, empty state.
- `components/ProjectCards.tsx` (new, replaces `ProjectsByMachine.tsx`), `pages/HomePage.tsx`, `pages/OfficePage.tsx`, `office/harness.ts`, `components/NeedsYouList.test.tsx`.

---

### Task 1: Schema and migration

**Files:**
- Modify: `apps/server/prisma/schema.prisma`
- Create: `apps/server/prisma/migrations/20260923000000_projects_decoupled_from_machines/migration.sql`

**Interfaces:**
- Produces: Prisma models `Project { ownerId, key, nextTaskNumber, machines: ProjectMachine[] }`, `ProjectMachine { id, projectId, machineId, cwd, position, createdAt }`, `Tab { machineId, machine }`, `Machine { projectLinks, tabs }`, `User { projects }`. Everything after this task compiles against the regenerated client in `apps/server/src/generated/prisma`.

- [ ] **Step 1: Edit the Prisma schema**

In `apps/server/prisma/schema.prisma`:

Replace the whole `model Project` block with:

```prisma
model Project {
  id             String        @id
  /// Owner: the project and everything under it (tasks, notes, tickets, setup, tabs) is visible
  /// only to them (and to admins viewing as them or as "all"). Null = orphan (owner deleted).
  ownerId        String?       @map("owner_id")
  /// Short key shown in URLs and card numbers (TERMHUB-42): 2–10 chars, ^[A-Z][A-Z0-9]{1,9}$,
  /// unique across the instance, never changed after creation.
  key            String        @unique
  /// Next card number for this project (used by the task-hierarchy spec; untouched here).
  nextTaskNumber Int           @default(1) @map("next_task_number")
  name           String
  status         ProjectStatus @default(active)
  description    String?
  lastTerminalAt DateTime?     @map("last_terminal_at")
  createdAt      DateTime      @default(now()) @map("created_at")
  owner          User?         @relation("ProjectOwner", fields: [ownerId], references: [id], onDelete: SetNull)
  /// Machines this project runs on, each with its own working directory.
  machines       ProjectMachine[]
  tabs           Tab[]
  tasks          Task[]
  note           Note?
  setup          ProjectSetup?
  tickets        Ticket[]

  @@index([ownerId])
  @@map("projects")
}

/// A project linked to a machine: where its terminals run and in which directory.
model ProjectMachine {
  id        String   @id
  projectId String   @map("project_id")
  machineId String   @map("machine_id")
  /// absolute path on that machine
  cwd       String
  position  Int      @default(0)
  createdAt DateTime @default(now()) @map("created_at")
  project   Project  @relation(fields: [projectId], references: [id], onDelete: Cascade)
  machine   Machine  @relation(fields: [machineId], references: [id], onDelete: Cascade)

  @@unique([projectId, machineId])
  @@index([machineId])
  @@map("project_machines")
}
```

In `model Tab`, after `projectId     String   @map("project_id")` add:

```prisma
  /// The machine this tab's tmux session runs on (one of the project's linked machines).
  machineId     String   @map("machine_id")
```

and after `project       Project  @relation(fields: [projectId], references: [id], onDelete: Cascade)` add:

```prisma
  machine       Machine  @relation(fields: [machineId], references: [id], onDelete: Cascade)
```

and after `@@index([projectId])` add `@@index([machineId])`.

In `model Machine`, replace `projects   Project[]` with:

```prisma
  projectLinks ProjectMachine[]
  tabs         Tab[]
```

In `model User`, after `machines     Machine[]     @relation("MachineOwner")` add:

```prisma
  projects     Project[]     @relation("ProjectOwner")
```

- [ ] **Step 2: Generate the DDL skeleton from Prisma (to get the exact constraint names)**

```bash
mkdir -p apps/server/prisma/migrations/20260923000000_projects_decoupled_from_machines
thdb 'cd apps/server && npx prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --shadow-database-url postgresql://postgres:postgres@th-test-db:5432/postgres --script' > /tmp/ddl.sql
cat /tmp/ddl.sql
```

Expected: `ALTER TABLE "projects" DROP COLUMN "cwd", DROP COLUMN "machine_id", ADD COLUMN "key" TEXT NOT NULL, ...`, `CREATE TABLE "project_machines"`, `ALTER TABLE "tabs" ADD COLUMN "machine_id" TEXT NOT NULL`, and the `CREATE INDEX` / `ADD CONSTRAINT` statements. Copy the exact index and constraint names from this output into Step 3 if any differ from what is written there.

- [ ] **Step 3: Write the migration with the backfill between the DDL steps**

`apps/server/prisma/migrations/20260923000000_projects_decoupled_from_machines/migration.sql`:

```sql
-- Projects become user-owned and linked to machines through project_machines; tabs know their machine.
-- Not backward compatible with the previous release (accepted, spec §11).

-- 1. New columns and table (nullable first so the backfill can run)
ALTER TABLE "projects" ADD COLUMN "owner_id" TEXT,
                       ADD COLUMN "key" TEXT,
                       ADD COLUMN "next_task_number" INTEGER NOT NULL DEFAULT 1;

CREATE TABLE "project_machines" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "machine_id" TEXT NOT NULL,
    "cwd" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_machines_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "tabs" ADD COLUMN "machine_id" TEXT;

-- 2. Backfill from the old machine_id / cwd
UPDATE "projects" p SET "owner_id" = m."owner_id" FROM "machines" m WHERE m."id" = p."machine_id";

INSERT INTO "project_machines" ("id", "project_id", "machine_id", "cwd", "position")
SELECT 'pm' || p."id", p."id", p."machine_id", p."cwd", 0 FROM "projects" p;

UPDATE "tabs" t SET "machine_id" = p."machine_id" FROM "projects" p WHERE p."id" = t."project_id";

-- Keys: initials of the name's words (letters/digits), else its first 3 letters, uppercased,
-- prefixed with P when it would start with a digit, suffixed with 2, 3, … on collision.
DO $$
DECLARE
  r RECORD;
  base TEXT;
  candidate TEXT;
  n INT;
BEGIN
  FOR r IN SELECT "id", "name" FROM "projects" ORDER BY "created_at", "id" LOOP
    SELECT string_agg(upper(left(w, 1)), '') INTO base
      FROM regexp_split_to_table(regexp_replace(r."name", '[^A-Za-z0-9 ]', ' ', 'g'), '\s+') AS w
     WHERE w <> '';
    IF base IS NULL OR length(base) < 2 THEN
      base := upper(left(regexp_replace(r."name", '[^A-Za-z0-9]', '', 'g'), 3));
    END IF;
    IF base IS NULL OR length(base) < 2 THEN
      base := 'PRJ';
    END IF;
    base := left(base, 10);
    IF base !~ '^[A-Z]' THEN
      base := 'P' || left(base, 9);
    END IF;
    candidate := base;
    n := 1;
    WHILE EXISTS (SELECT 1 FROM "projects" WHERE "key" = candidate) LOOP
      n := n + 1;
      candidate := left(base, 10 - length(n::text)) || n::text;
    END LOOP;
    UPDATE "projects" SET "key" = candidate WHERE "id" = r."id";
  END LOOP;
END $$;

-- 3. Constraints
ALTER TABLE "tabs" ALTER COLUMN "machine_id" SET NOT NULL;
ALTER TABLE "projects" ALTER COLUMN "key" SET NOT NULL;

CREATE UNIQUE INDEX "projects_key_key" ON "projects"("key");
CREATE INDEX "projects_owner_id_idx" ON "projects"("owner_id");
CREATE UNIQUE INDEX "project_machines_project_id_machine_id_key" ON "project_machines"("project_id", "machine_id");
CREATE INDEX "project_machines_machine_id_idx" ON "project_machines"("machine_id");
CREATE INDEX "tabs_machine_id_idx" ON "tabs"("machine_id");

ALTER TABLE "projects" ADD CONSTRAINT "projects_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "project_machines" ADD CONSTRAINT "project_machines_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "project_machines" ADD CONSTRAINT "project_machines_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machines"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "tabs" ADD CONSTRAINT "tabs_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 4. Drop the old columns
ALTER TABLE "projects" DROP CONSTRAINT "projects_machine_id_fkey";
DROP INDEX "projects_machine_id_idx";
ALTER TABLE "projects" DROP COLUMN "machine_id", DROP COLUMN "cwd";
```

- [ ] **Step 4: Verify the migration against old-shape data**

Recreate the test DB at the previous migration, seed old-shape rows, run the new migration, check the result and that the schema now matches exactly:

```bash
docker rm -f th-test-db; docker run -d --name th-test-db --network th-test -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=termhub postgres:16; sleep 3
mv apps/server/prisma/migrations/20260923000000_projects_decoupled_from_machines /tmp/newmig
thdb 'cd apps/server && npx prisma migrate deploy'
docker exec -i th-test-db psql -U postgres termhub <<'SQL'
INSERT INTO users (id, email, name) VALUES ('u1','u1@t','U1');
INSERT INTO machines (id, name, type, owner_id) VALUES ('m1','mac','agent','u1'), ('m2','orphan','agent',NULL);
INSERT INTO projects (id, machine_id, name, cwd) VALUES ('p1','m1','Hub Community','/src/hub'), ('p2','m1','Hub Community','/src/hub2'), ('p3','m2','termhub','/src/th'), ('p4','m1','42 things','/x');
INSERT INTO tabs (id, project_id, name) VALUES ('t1','p1','main');
SQL
mv /tmp/newmig apps/server/prisma/migrations/20260923000000_projects_decoupled_from_machines
thdb 'cd apps/server && npx prisma migrate deploy && npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code'
docker exec -i th-test-db psql -U postgres termhub -c 'SELECT id, key, owner_id FROM projects ORDER BY id;' -c 'SELECT project_id, machine_id, cwd FROM project_machines ORDER BY project_id;' -c 'SELECT id, machine_id FROM tabs;'
```

Expected: `migrate diff` exits 0 (no output). Rows: p1 `HC`/u1, p2 `HC2`/u1, p3 `TER`/NULL, p4 `P4T`/u1; four links with the old cwd; tab t1 with machine_id m1.

- [ ] **Step 5: Regenerate the client and typecheck (expect failures in code that still uses the old fields)**

```bash
th 'npm ci --no-audit --no-fund >/dev/null; cd apps/server && npx prisma generate && npm run typecheck' ; rm -rf .npm
```

Expected: typecheck FAILS in `types.ts`, `projects.ts`, `tabs.ts`, `scope.ts`, `routes/projects.ts`, etc. (the old fields are gone). That is the work of the next tasks. Do not fix anything here.

- [ ] **Step 6: Commit**

```bash
git add apps/server/prisma
git commit -m "Prisma: projects owned by users, linked to machines; tabs carry machine_id"
```

---

### Task 2: Project key helpers (server)

**Files:**
- Create: `apps/server/src/lib/project-key.ts`
- Test: `apps/server/src/lib/project-key.test.ts`

**Interfaces:**
- Produces: `PROJECT_KEY_RE: RegExp`, `isValidProjectKey(key: string): boolean`, `suggestProjectKey(name: string): string` (always returns a valid key, `PRJ` when nothing usable is left).

- [ ] **Step 1: Write the failing test**

`apps/server/src/lib/project-key.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { isValidProjectKey, suggestProjectKey } from './project-key.js';

describe('isValidProjectKey', () => {
  it.each(['HC', 'TERMHUB', 'A1', 'ABCDEFGHIJ'])('accepts %s', (k) => expect(isValidProjectKey(k)).toBe(true));
  it.each(['h', 'hc', '1A', 'A', 'ABCDEFGHIJK', 'A-B', 'A B', '', 'Ç1'])('rejects %j', (k) => expect(isValidProjectKey(k)).toBe(false));
});

describe('suggestProjectKey', () => {
  it('uses the initials of a multi-word name', () => {
    expect(suggestProjectKey('Hub Community')).toBe('HC');
    expect(suggestProjectKey('meu app legal')).toBe('MAL');
  });
  it('uses the first three letters of a single word', () => {
    expect(suggestProjectKey('termhub')).toBe('TER');
    expect(suggestProjectKey('io')).toBe('IO');
  });
  it('strips accents and symbols, prefixes P when it would start with a digit', () => {
    expect(suggestProjectKey('Ação Ágil')).toBe('AA');
    expect(suggestProjectKey('42 things')).toBe('P4T');
    expect(suggestProjectKey('my-app')).toBe('MA');
  });
  it('caps at 10 chars and falls back to PRJ', () => {
    expect(suggestProjectKey('a b c d e f g h i j k l')).toBe('ABCDEFGHIJ');
    expect(suggestProjectKey('!!!')).toBe('PRJ');
    expect(suggestProjectKey('x')).toBe('PRJ');
  });
});
```

- [ ] **Step 2: Run it to see it fail**

```bash
th 'npx vitest run apps/server/src/lib/project-key.test.ts'
```

Expected: FAIL — cannot find module `./project-key.js`.

- [ ] **Step 3: Implement**

`apps/server/src/lib/project-key.ts`:

```ts
/** Project key: 2–10 uppercase letters/digits, starting with a letter (TERMHUB, HC, A1). */
export const PROJECT_KEY_RE = /^[A-Z][A-Z0-9]{1,9}$/;

export const PROJECT_KEY_MAX = 10;

export function isValidProjectKey(key: string): boolean {
  return PROJECT_KEY_RE.test(key);
}

/** ASCII letters and digits of a name, accents stripped ("Ação" → "Acao"), everything else → space. */
function words(name: string): string[] {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

/**
 * A key suggestion from a project name: initials of a multi-word name, the first three characters
 * of a single word, uppercased; `P` in front when it would start with a digit; never longer than 10.
 * Falls back to `PRJ` when nothing usable is left. The result is always a valid key.
 */
export function suggestProjectKey(name: string): string {
  const ws = words(name);
  let base = ws.length > 1 ? ws.map((w) => w[0]).join('') : (ws[0] ?? '').slice(0, 3);
  base = base.toUpperCase().slice(0, PROJECT_KEY_MAX);
  if (/^[0-9]/.test(base)) base = ('P' + base).slice(0, PROJECT_KEY_MAX);
  return isValidProjectKey(base) ? base : 'PRJ';
}
```

- [ ] **Step 4: Run the test**

```bash
th 'npx vitest run apps/server/src/lib/project-key.test.ts'
```

Expected: PASS (4 test groups).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/lib/project-key.ts apps/server/src/lib/project-key.test.ts
git commit -m "Add project key validation and suggestion helpers"
```

---

### Task 3: Repository types, ProjectsRepository, ProjectMachinesRepository, TabsRepository

**Files:**
- Modify: `apps/server/src/db/repositories/types.ts` (Project/Tab interfaces at ~75–105, `mapProject` ~230, `mapTab` ~241)
- Modify: `apps/server/src/db/repositories/projects.ts`
- Create: `apps/server/src/db/repositories/project-machines.ts`
- Modify: `apps/server/src/db/repositories/tabs.ts`
- Modify: `apps/server/src/db/repositories/index.ts`
- Test: `apps/server/src/db/repositories/projects.db.test.ts` (rewrite), `project-machines.db.test.ts` (new), `tabs.db.test.ts` (fixture only)

**Interfaces:**
- Produces (types.ts):
  ```ts
  interface Project { id; owner_id: string | null; key: string; next_task_number: number; name; status: ProjectStatus; description: string | null; last_terminal_at: string | null; created_at: string }
  interface ProjectMachine { id; project_id; machine_id; cwd; position: number; created_at: string }
  interface Tab { ...existing; machine_id: string }
  ```
- Produces (projects.ts): `ProjectInput { owner_id: string | null; key: string; name: string; status?: ProjectStatus; description?: string | null }`, `ProjectPatch = Partial<Pick<ProjectInput, 'name' | 'status' | 'description'>>`, `class ProjectRuleError extends Error { code: ProjectRuleCode }` with `ProjectRuleCode = 'KEY_INVALID' | 'KEY_TAKEN' | 'MACHINE_ALREADY_LINKED' | 'MACHINE_NOT_LINKED' | 'MACHINE_REQUIRED' | 'NO_MACHINE'`; methods `list({ machine_id?, status?, owner? })`, `findById`, `findByKey(key)`, `findByIdsForOwner(ids, ownerId)`, `isKeyAvailable(key)`, `create(input)` (throws `KEY_INVALID` / `KEY_TAKEN`), `update(id, patch)`, `touchTerminal`, `delete`.
- Produces (project-machines.ts): `class ProjectMachinesRepository` with `listByProject(projectId)`, `listByProjects(projectIds)`, `listByMachine(machineId)`, `find(projectId, machineId)`, `link({ project_id, machine_id, cwd })` (throws `MACHINE_ALREADY_LINKED`), `updateCwd(projectId, machineId, cwd)`, `unlink(projectId, machineId): Promise<boolean>`.
- Produces (tabs.ts): `create(projectId, machineId, name, opts)`, `listByProjectMachine(projectId, machineId)`, `listByProjectsOnMachine(projectIds, machineId)`; owner filters through `machine.ownerId`.
- Produces (index.ts): `Repositories.projectMachines`.

- [ ] **Step 1: Update the shared types**

In `apps/server/src/db/repositories/types.ts`, add `ProjectMachine as PrismaProjectMachine,` to the import list from the generated client, then replace `export interface Project { ... }` with:

```ts
export interface Project {
  id: string;
  /** null = orphan (owner deleted), visible only to admins viewing "all" */
  owner_id: string | null;
  /** short key used in URLs and card numbers (TERMHUB); unique, immutable */
  key: string;
  next_task_number: number;
  name: string;
  status: ProjectStatus;
  description: string | null;
  last_terminal_at: string | null;
  created_at: string;
}

/** A project's link to one machine: where its terminals run there. */
export interface ProjectMachine {
  id: string;
  project_id: string;
  machine_id: string;
  cwd: string;
  position: number;
  created_at: string;
}
```

In `export interface Tab`, after `project_id: string;` add:

```ts
  /** the machine this tab's tmux session runs on */
  machine_id: string;
```

Replace `mapProject` with:

```ts
export const mapProject = (p: PrismaProject): Project => ({
  id: p.id,
  owner_id: p.ownerId,
  key: p.key,
  next_task_number: p.nextTaskNumber,
  name: p.name,
  status: p.status,
  description: p.description,
  last_terminal_at: iso(p.lastTerminalAt),
  created_at: p.createdAt.toISOString(),
});

export const mapProjectMachine = (l: PrismaProjectMachine): ProjectMachine => ({
  id: l.id,
  project_id: l.projectId,
  machine_id: l.machineId,
  cwd: l.cwd,
  position: l.position,
  created_at: l.createdAt.toISOString(),
});
```

In `mapTab`, after `project_id: t.projectId,` add `machine_id: t.machineId,`.

- [ ] **Step 2: Write the failing repository tests**

Replace `apps/server/src/db/repositories/projects.db.test.ts` with:

```ts
import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../generated/prisma/client.js';
import { newId } from '../../lib/ids.js';
import { ProjectRuleError, ProjectsRepository } from './projects.js';
import { ProjectMachinesRepository } from './project-machines.js';

// Needs a migrated Postgres: TERMHUB_DB_TESTS=1 DATABASE_URL=… (CI sets both; see README → Development).
describe.skipIf(process.env.TERMHUB_DB_TESTS !== '1')('ProjectsRepository (Postgres)', () => {
  let db: PrismaClient;
  let repo: ProjectsRepository;
  let links: ProjectMachinesRepository;
  let ownerId: string;
  let otherId: string;
  let machineId: string;

  beforeAll(() => {
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
    repo = new ProjectsRepository(db);
    links = new ProjectMachinesRepository(db);
  });

  beforeEach(async () => {
    ownerId = newId();
    otherId = newId();
    machineId = newId();
    await db.user.createMany({ data: [
      { id: ownerId, email: `${ownerId}@test.local`, name: 'owner' },
      { id: otherId, email: `${otherId}@test.local`, name: 'other' },
    ] });
    await db.machine.create({ data: { id: machineId, name: 'mine', type: 'agent', ownerId } });
    return async () => {
      await db.project.deleteMany({ where: { ownerId: { in: [ownerId, otherId] } } });
      await db.machine.deleteMany({ where: { id: machineId } });
      await db.user.deleteMany({ where: { id: { in: [ownerId, otherId] } } });
    };
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  const key = () => 'T' + newId().replace(/[^a-z0-9]/gi, '').slice(0, 8).toUpperCase();

  it('creates a project owned by a user with a valid unique key', async () => {
    const k = key();
    const p = await repo.create({ owner_id: ownerId, key: k, name: 'mine' });
    expect(p).toMatchObject({ owner_id: ownerId, key: k, next_task_number: 1, status: 'active' });
    expect(await repo.findByKey(k)).toMatchObject({ id: p.id });
    expect(await repo.isKeyAvailable(k)).toBe(false);
    expect(await repo.isKeyAvailable(key())).toBe(true);
  });

  it('rejects an invalid or taken key with a rule error', async () => {
    const k = key();
    await repo.create({ owner_id: ownerId, key: k, name: 'a' });
    await expect(repo.create({ owner_id: ownerId, key: k, name: 'b' })).rejects.toMatchObject({ code: 'KEY_TAKEN' } satisfies Partial<ProjectRuleError>);
    await expect(repo.create({ owner_id: ownerId, key: 'bad key', name: 'c' })).rejects.toMatchObject({ code: 'KEY_INVALID' });
    expect(await repo.isKeyAvailable('bad key')).toBe(false);
  });

  it('lists by owner directly and by linked machine', async () => {
    const mine = await repo.create({ owner_id: ownerId, key: key(), name: 'mine' });
    const theirs = await repo.create({ owner_id: otherId, key: key(), name: 'theirs' });
    await links.link({ project_id: mine.id, machine_id: machineId, cwd: '/src/mine' });

    expect((await repo.list({ owner: ownerId })).map((p) => p.id)).toEqual([mine.id]);
    expect((await repo.list({ owner: otherId })).map((p) => p.id)).toEqual([theirs.id]);
    expect((await repo.list({ machine_id: machineId })).map((p) => p.id)).toEqual([mine.id]);
    expect((await repo.findByIdsForOwner([mine.id, theirs.id, 'nope'], ownerId)).map((p) => p.id)).toEqual([mine.id]);
  });

  it('update changes name/status/description only; the key never changes', async () => {
    const p = await repo.create({ owner_id: ownerId, key: key(), name: 'a' });
    const u = await repo.update(p.id, { name: 'b', status: 'paused', description: 'd' });
    expect(u).toMatchObject({ key: p.key, name: 'b', status: 'paused', description: 'd' });
  });
});
```

Create `apps/server/src/db/repositories/project-machines.db.test.ts`:

```ts
import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../generated/prisma/client.js';
import { newId } from '../../lib/ids.js';
import { ProjectMachinesRepository } from './project-machines.js';
import { TabsRepository } from './tabs.js';

// Needs a migrated Postgres: TERMHUB_DB_TESTS=1 DATABASE_URL=… (CI sets both; see README → Development).
describe.skipIf(process.env.TERMHUB_DB_TESTS !== '1')('ProjectMachinesRepository (Postgres)', () => {
  let db: PrismaClient;
  let repo: ProjectMachinesRepository;
  let tabs: TabsRepository;
  let ownerId: string;
  let m1: string;
  let m2: string;
  let projectId: string;

  beforeAll(() => {
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
    repo = new ProjectMachinesRepository(db);
    tabs = new TabsRepository(db);
  });

  beforeEach(async () => {
    ownerId = newId();
    m1 = newId();
    m2 = newId();
    projectId = newId();
    await db.user.create({ data: { id: ownerId, email: `${ownerId}@test.local`, name: 'o' } });
    await db.machine.createMany({ data: [{ id: m1, name: 'one', type: 'agent', ownerId }, { id: m2, name: 'two', type: 'agent', ownerId }] });
    await db.project.create({ data: { id: projectId, ownerId, key: 'K' + projectId.replace(/[^a-z0-9]/gi, '').slice(0, 8).toUpperCase(), name: 'p' } });
    return async () => {
      await db.project.deleteMany({ where: { id: projectId } });
      await db.machine.deleteMany({ where: { id: { in: [m1, m2] } } });
      await db.user.deleteMany({ where: { id: ownerId } });
    };
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  it('links machines in order, finds and lists them, and refuses a second link to the same machine', async () => {
    const a = await repo.link({ project_id: projectId, machine_id: m1, cwd: '/a' });
    const b = await repo.link({ project_id: projectId, machine_id: m2, cwd: '/b' });
    expect([a.position, b.position]).toEqual([0, 1]);
    expect((await repo.listByProject(projectId)).map((l) => l.machine_id)).toEqual([m1, m2]);
    expect((await repo.listByMachine(m2)).map((l) => l.project_id)).toEqual([projectId]);
    expect((await repo.listByProjects([projectId, 'nope'])).length).toBe(2);
    expect(await repo.find(projectId, m1)).toMatchObject({ cwd: '/a' });
    expect(await repo.find(projectId, 'nope')).toBeUndefined();
    await expect(repo.link({ project_id: projectId, machine_id: m1, cwd: '/again' })).rejects.toMatchObject({ code: 'MACHINE_ALREADY_LINKED' });
  });

  it('updates the cwd and unlinks', async () => {
    await repo.link({ project_id: projectId, machine_id: m1, cwd: '/a' });
    expect(await repo.updateCwd(projectId, m1, '/z')).toMatchObject({ cwd: '/z' });
    expect(await repo.updateCwd(projectId, m2, '/z')).toBeUndefined();
    expect(await repo.unlink(projectId, m1)).toBe(true);
    expect(await repo.unlink(projectId, m1)).toBe(false);
    expect(await repo.listByProject(projectId)).toEqual([]);
  });

  it('deleting a machine removes its link and tabs but keeps the project; deleting the project removes links', async () => {
    await repo.link({ project_id: projectId, machine_id: m1, cwd: '/a' });
    await repo.link({ project_id: projectId, machine_id: m2, cwd: '/b' });
    const t1 = await tabs.create(projectId, m1, 'on one');
    const t2 = await tabs.create(projectId, m2, 'on two');
    expect(t1.machine_id).toBe(m1);
    expect((await tabs.listByProjectMachine(projectId, m2)).map((t) => t.id)).toEqual([t2.id]);
    expect((await tabs.listByProjectsOnMachine([projectId], m1)).map((t) => t.id)).toEqual([t1.id]);

    await db.machine.delete({ where: { id: m1 } });
    expect(await db.project.findUnique({ where: { id: projectId } })).not.toBeNull();
    expect((await repo.listByProject(projectId)).map((l) => l.machine_id)).toEqual([m2]);
    expect((await tabs.listByProject(projectId)).map((t) => t.id)).toEqual([t2.id]);
    expect(await tabs.countsByMachine(ownerId)).toEqual({ [m2]: { tabs: 1, reporting: 0 } });
    expect(await tabs.findByTmuxSession(m2, t2.tmux_session!)).toMatchObject({ id: t2.id });
    expect((await tabs.findByIdsForOwner([t2.id], ownerId)).length).toBe(1);
    expect((await tabs.findByIdsForOwner([t2.id], 'someone-else')).length).toBe(0);
  });
});
```

In `apps/server/src/db/repositories/tabs.db.test.ts` `beforeEach`, replace the project and tab creation with:

```ts
    await db.project.create({ data: { id: projectId, key: 'K' + projectId.replace(/[^a-z0-9]/gi, '').slice(0, 8).toUpperCase(), name: 'p' } });
    await db.projectMachine.create({ data: { id: newId(), projectId, machineId, cwd: '/tmp' } });
    await db.tab.create({ data: { id: tabId, projectId, machineId, name: 't', tmuxSession: `th-${tabId}` } });
    return async () => {
      await db.project.delete({ where: { id: projectId } }); // cascades link and tab
      await db.machine.delete({ where: { id: machineId } });
    };
```

Do the same in `apps/server/src/db/repositories/tasks.db.test.ts` (every `db.project.create` there: drop `machineId`/`cwd`, add a unique `key`; cleanup already deletes the machine — add `await db.project.deleteMany({ where: { id: { in: [projectId, otherProjectId] } } })` before it).

- [ ] **Step 3: Run the tests to see them fail**

```bash
thdb 'npx vitest run apps/server/src/db/repositories/projects.db.test.ts apps/server/src/db/repositories/project-machines.db.test.ts'
```

Expected: FAIL (module `./project-machines.js` not found; `create` signature mismatch).

- [ ] **Step 4: Rewrite `ProjectsRepository`**

`apps/server/src/db/repositories/projects.ts`:

```ts
import type { PrismaClient } from '../prisma.js';
import { newId } from '../../lib/ids.js';
import { isValidProjectKey } from '../../lib/project-key.js';
import { mapProject, type Project, type ProjectStatus } from './types.js';

export interface ProjectInput {
  owner_id: string | null;
  key: string;
  name: string;
  status?: ProjectStatus;
  description?: string | null;
}

export type ProjectPatch = Partial<Pick<ProjectInput, 'name' | 'status' | 'description'>>;

export type ProjectRuleCode = 'KEY_INVALID' | 'KEY_TAKEN' | 'MACHINE_ALREADY_LINKED' | 'MACHINE_NOT_LINKED' | 'MACHINE_REQUIRED' | 'NO_MACHINE';

/** A project rule broken by the caller (pt-BR message, shown as is by the routes). */
export class ProjectRuleError extends Error {
  constructor(
    readonly code: ProjectRuleCode,
    message: string,
  ) {
    super(message);
    this.name = 'ProjectRuleError';
  }
}

export class ProjectsRepository {
  constructor(private db: PrismaClient) {}

  /** `owner`: only that user's projects (undefined/null = no filter). `machine_id`: only projects linked to it. */
  async list(filter?: { machine_id?: string; status?: ProjectStatus; owner?: string | null }): Promise<Project[]> {
    const rows = await this.db.project.findMany({
      where: {
        ...(filter?.machine_id ? { machines: { some: { machineId: filter.machine_id } } } : {}),
        ...(filter?.status ? { status: filter.status } : {}),
        ...(filter?.owner ? { ownerId: filter.owner } : {}),
      },
      orderBy: { name: 'asc' },
    });
    return rows.map(mapProject);
  }

  async findById(id: string): Promise<Project | undefined> {
    const p = await this.db.project.findUnique({ where: { id } });
    return p ? mapProject(p) : undefined;
  }

  async findByKey(key: string): Promise<Project | undefined> {
    const p = await this.db.project.findUnique({ where: { key } });
    return p ? mapProject(p) : undefined;
  }

  /**
   * Batched by id, one query regardless of how many ids are asked for, filtered to one owner —
   * never "no filter": a caller that resolves names for one person's screen (e.g. the chat action
   * trail) must not be able to pass `null` and see everyone's. Another owner's project id is simply
   * absent from the result, like a row that does not exist.
   */
  async findByIdsForOwner(ids: string[], ownerId: string): Promise<Project[]> {
    if (ids.length === 0) return [];
    return (await this.db.project.findMany({ where: { id: { in: ids }, ownerId } })).map(mapProject);
  }

  /** false for an invalid key too, so the create form can show one answer for both. */
  async isKeyAvailable(key: string): Promise<boolean> {
    if (!isValidProjectKey(key)) return false;
    return (await this.db.project.count({ where: { key } })) === 0;
  }

  async create(input: ProjectInput): Promise<Project> {
    if (!isValidProjectKey(input.key)) throw new ProjectRuleError('KEY_INVALID', 'Chave inválida: 2 a 10 letras maiúsculas ou dígitos, começando com letra');
    if ((await this.db.project.count({ where: { key: input.key } })) > 0) throw new ProjectRuleError('KEY_TAKEN', `A chave ${input.key} já está em uso`);
    const p = await this.db.project.create({
      data: {
        id: newId(),
        ownerId: input.owner_id,
        key: input.key,
        name: input.name,
        status: input.status ?? 'active',
        description: input.description ?? null,
      },
    });
    return mapProject(p);
  }

  async update(id: string, patch: ProjectPatch): Promise<Project | undefined> {
    const current = await this.findById(id);
    if (!current) return undefined;
    const next = { ...current, ...patch };
    const p = await this.db.project.update({
      where: { id },
      data: { name: next.name, status: next.status, description: next.description ?? null },
    });
    return mapProject(p);
  }

  async touchTerminal(id: string): Promise<void> {
    await this.db.project.updateMany({ where: { id }, data: { lastTerminalAt: new Date() } });
  }

  async delete(id: string): Promise<boolean> {
    const r = await this.db.project.deleteMany({ where: { id } });
    return r.count > 0;
  }
}
```

- [ ] **Step 5: Create `ProjectMachinesRepository`**

`apps/server/src/db/repositories/project-machines.ts`:

```ts
import type { PrismaClient } from '../prisma.js';
import { newId } from '../../lib/ids.js';
import { ProjectRuleError } from './projects.js';
import { mapProjectMachine, type ProjectMachine } from './types.js';

const ORDER = [{ position: 'asc' as const }, { createdAt: 'asc' as const }];

/** The project ↔ machine links: where a project's terminals run and in which directory. */
export class ProjectMachinesRepository {
  constructor(private db: PrismaClient) {}

  async listByProject(projectId: string): Promise<ProjectMachine[]> {
    return (await this.db.projectMachine.findMany({ where: { projectId }, orderBy: ORDER })).map(mapProjectMachine);
  }

  /** Links of many projects in one query (the project list attaches them). */
  async listByProjects(projectIds: string[]): Promise<ProjectMachine[]> {
    if (projectIds.length === 0) return [];
    return (await this.db.projectMachine.findMany({ where: { projectId: { in: projectIds } }, orderBy: ORDER })).map(mapProjectMachine);
  }

  async listByMachine(machineId: string): Promise<ProjectMachine[]> {
    return (await this.db.projectMachine.findMany({ where: { machineId }, orderBy: ORDER })).map(mapProjectMachine);
  }

  async find(projectId: string, machineId: string): Promise<ProjectMachine | undefined> {
    const l = await this.db.projectMachine.findUnique({ where: { projectId_machineId: { projectId, machineId } } });
    return l ? mapProjectMachine(l) : undefined;
  }

  async link(input: { project_id: string; machine_id: string; cwd: string }): Promise<ProjectMachine> {
    if (await this.find(input.project_id, input.machine_id)) throw new ProjectRuleError('MACHINE_ALREADY_LINKED', 'Esta máquina já está vinculada ao projeto');
    const agg = await this.db.projectMachine.aggregate({ where: { projectId: input.project_id }, _max: { position: true } });
    const l = await this.db.projectMachine.create({
      data: { id: newId(), projectId: input.project_id, machineId: input.machine_id, cwd: input.cwd, position: (agg._max.position ?? -1) + 1 },
    });
    return mapProjectMachine(l);
  }

  async updateCwd(projectId: string, machineId: string, cwd: string): Promise<ProjectMachine | undefined> {
    const r = await this.db.projectMachine.updateMany({ where: { projectId, machineId }, data: { cwd } });
    return r.count > 0 ? this.find(projectId, machineId) : undefined;
  }

  async unlink(projectId: string, machineId: string): Promise<boolean> {
    const r = await this.db.projectMachine.deleteMany({ where: { projectId, machineId } });
    return r.count > 0;
  }
}
```

- [ ] **Step 6: Update `TabsRepository`**

In `apps/server/src/db/repositories/tabs.ts`:

After `listByProject`, add:

```ts
  /** Tabs of one project on one machine (closed when the machine is unlinked). */
  async listByProjectMachine(projectId: string, machineId: string): Promise<Tab[]> {
    const rows = await this.db.tab.findMany({ where: { projectId, machineId }, orderBy: [{ position: 'asc' }, { createdAt: 'asc' }] });
    return rows.map(mapTab);
  }

  /** Every tab of the given projects that runs on this machine (the office floor of one machine). */
  async listByProjectsOnMachine(projectIds: string[], machineId: string): Promise<Tab[]> {
    if (projectIds.length === 0) return [];
    const rows = await this.db.tab.findMany({ where: { projectId: { in: projectIds }, machineId }, orderBy: [{ position: 'asc' }, { createdAt: 'asc' }] });
    return rows.map(mapTab);
  }
```

Then change the owner/machine filters:

```ts
  // findByIdsForOwner
  return (await this.db.tab.findMany({ where: { id: { in: ids }, machine: { ownerId } } })).map(mapTab);
  // findByTmuxSession
  const t = await this.db.tab.findFirst({ where: { tmuxSession: session, machineId } });
  // listWithState
  where: { state: { not: null }, ...(owner ? { machine: { ownerId: owner } } : {}) },
  // countsByMachine
  where: { kind: 'terminal', ...(owner ? { machine: { ownerId: owner } } : {}) },
  select: { state: true, machineId: true },
  // and in the loop:
  const counts = (out[row.machineId] ??= { tabs: 0, reporting: 0 });
  // countBusyByMachine
  return this.db.tab.count({ where: { state: { in: BUSY_STATES }, machineId } });
```

Update the `findByIdsForOwner` doc comment: "filtered to one owner's tabs through their machine". Change `create`:

```ts
  async create(projectId: string, machineId: string, name: string, opts: { kind?: TabKind; simulator_udid?: string | null; created_by_token_id?: string | null } = {}): Promise<Tab> {
    const id = newId();
    const kind = opts.kind ?? 'terminal';
    const agg = await this.db.tab.aggregate({ where: { projectId }, _max: { position: true } });
    const t = await this.db.tab.create({
      data: {
        id,
        projectId,
        machineId,
        name,
        kind,
        tmuxSession: kind === 'terminal' ? `termhub-${projectId}-${id}` : null,
        simulatorUdid: kind === 'simulator' ? (opts.simulator_udid ?? null) : null,
        createdByTokenId: opts.created_by_token_id ?? null,
        position: (agg._max.position ?? -1) + 1,
      },
    });
    return mapTab(t);
  }
```

- [ ] **Step 7: Register the repository**

In `apps/server/src/db/repositories/index.ts`: import `ProjectMachinesRepository` from `./project-machines.js`, add `projectMachines: ProjectMachinesRepository;` to the interface (after `projects`), `projectMachines: new ProjectMachinesRepository(db),` to `createRepositories`, and `export { ProjectRuleError } from './projects.js'; export type { ProjectRuleCode } from './projects.js';` at the bottom.

- [ ] **Step 8: Run the repository tests**

```bash
thdb 'npx vitest run apps/server/src/db/repositories/projects.db.test.ts apps/server/src/db/repositories/project-machines.db.test.ts apps/server/src/db/repositories/tabs.db.test.ts apps/server/src/db/repositories/tasks.db.test.ts'
```

Expected: PASS. (`npm run typecheck` still fails elsewhere — scope and routes come next.)

- [ ] **Step 9: Commit**

```bash
git add apps/server/src/db
git commit -m "Repositories: project owner and key, project_machines links, tab machine_id"
```

---

### Task 4: Ownership scoping

**Files:**
- Modify: `apps/server/src/auth/scope.ts`
- Test: `apps/server/src/auth/scope.test.ts`

**Interfaces:**
- Produces on `Scoped`:
  ```ts
  project(id): Promise<{ project: Project }>
  projectMachine(projectId, machineId): Promise<{ project: Project; machine: Machine; link: ProjectMachine }>
  projectMachines(projectId): Promise<{ project: Project; machines: Array<{ machine: Machine; link: ProjectMachine }> }>
  /** the machine a tab should open on: the given one, or the only linked one; 400 MACHINE_REQUIRED / NO_MACHINE otherwise */
  projectMachineFor(projectId, machineId?: string): Promise<{ project: Project; machine: Machine; link: ProjectMachine }>
  tab(id): Promise<{ tab: Tab; project: Project; machine: Machine; cwd: string }>
  task(id): Promise<{ task: Task; project: Project }>
  ```

- [ ] **Step 1: Update the scope tests**

In `apps/server/src/auth/scope.test.ts`, replace `fakeRepos()`'s data and the `Scoped` describe with:

```ts
/** alice owns m1 and project p1 (linked to m1, tab t1 on m1, task k1); bob owns m2; m3 is an orphan; p2 is alice's project with two machines; p3 has none. */
function fakeRepos(): Repositories {
  const users = [admin, alice, bob];
  const roles = { role_admin: { id: 'role_admin', is_admin: true }, role_auth: { id: 'role_auth', is_admin: false } };
  const machines = [
    { id: 'm1', owner_id: 'alice' },
    { id: 'm2', owner_id: 'bob' },
    { id: 'm3', owner_id: null },
    { id: 'm4', owner_id: 'alice' },
  ];
  const projects = [
    { id: 'p1', owner_id: 'alice' },
    { id: 'p2', owner_id: 'alice' },
    { id: 'p3', owner_id: 'alice' },
    { id: 'p9', owner_id: null },
  ];
  const links = [
    { id: 'l1', project_id: 'p1', machine_id: 'm1', cwd: '/p1' },
    { id: 'l2', project_id: 'p2', machine_id: 'm1', cwd: '/p2-m1' },
    { id: 'l3', project_id: 'p2', machine_id: 'm4', cwd: '/p2-m4' },
    { id: 'l4', project_id: 'p1', machine_id: 'm2', cwd: '/bobs' }, // a link to a machine alice does not own
  ];
  const tabs = [{ id: 't1', project_id: 'p1', machine_id: 'm1' }, { id: 't2', project_id: 'p1', machine_id: 'm2' }];
  const tasks = [{ id: 'k1', project_id: 'p1' }];
  const integrations = [{ id: 'i1', owner_id: 'alice' }];
  const accounts = [{ id: 'a1', machine_id: 'm2' }];
  const find = <T extends { id: string }>(rows: T[]) => async (id: string) => rows.find((r) => r.id === id);
  return {
    users: { findById: find(users) },
    roles: { findById: async (id: string) => (roles as Record<string, unknown>)[id], permissionsOf: async () => [] },
    machines: { findById: find(machines) },
    projects: { findById: find(projects) },
    projectMachines: {
      find: async (p: string, m: string) => links.find((l) => l.project_id === p && l.machine_id === m),
      listByProject: async (p: string) => links.filter((l) => l.project_id === p),
    },
    tabs: { findById: find(tabs) },
    tasks: { findById: find(tasks) },
    integrations: { findById: find(integrations) },
    aiAccounts: { findById: find(accounts) },
  } as unknown as Repositories;
}
```

```ts
describe('Scoped', () => {
  const repos = fakeRepos();
  const as = (ownerId: string | null) => new Scoped(repos, { user: alice, viewAs: { kind: 'self' }, ownerId, createAs: ownerId ?? 'adm' });

  it('resolves rows of the owner: projects by owner_id, tabs through their machine link', async () => {
    const s = as('alice');
    expect((await s.machine('m1')).id).toBe('m1');
    expect((await s.project('p1')).project.owner_id).toBe('alice');
    const tab = await s.tab('t1');
    expect([tab.project.id, tab.machine.id, tab.cwd]).toEqual(['p1', 'm1', '/p1']);
    expect((await s.task('k1')).project.id).toBe('p1');
    expect((await s.integration('i1')).id).toBe('i1');
    expect((await s.projectMachine('p2', 'm4')).link.cwd).toBe('/p2-m4');
  });

  it('projectMachines lists only linked machines the owner can see', async () => {
    const r = await as('alice').projectMachines('p1');
    expect(r.machines.map((x) => x.machine.id)).toEqual(['m1']); // m2 is bob's: left out
    expect((await as(null).projectMachines('p1')).machines.map((x) => x.machine.id)).toEqual(['m1', 'm2']);
  });

  it('projectMachineFor picks the only machine, requires one when there are several, refuses when there are none', async () => {
    const s = as('alice');
    expect((await s.projectMachineFor('p1')).machine.id).toBe('m1');
    expect((await s.projectMachineFor('p2', 'm4')).link.cwd).toBe('/p2-m4');
    await expect(s.projectMachineFor('p2')).rejects.toMatchObject({ statusCode: 400, code: 'MACHINE_REQUIRED' });
    await expect(s.projectMachineFor('p3')).rejects.toMatchObject({ statusCode: 400, code: 'NO_MACHINE' });
    await expect(s.projectMachineFor('p1', 'm4')).rejects.toMatchObject({ statusCode: 404 }); // not linked
    await expect(s.projectMachineFor('p1', 'm2')).rejects.toMatchObject({ statusCode: 404 }); // linked, but bob's machine
  });

  it("answers 404 for another user's rows, orphans and missing ids alike", async () => {
    const s = as('bob');
    for (const p of [s.machine('m1'), s.machine('m3'), s.machine('nope'), s.project('p1'), s.project('p9'), s.tab('t1'), s.tab('t2'), s.task('k1'), s.integration('i1'), s.projectMachine('p1', 'm2')]) {
      await expect(p).rejects.toMatchObject({ statusCode: 404 });
    }
    expect((await s.aiAccount('a1')).machine.id).toBe('m2');
    await expect(as('alice').aiAccount('a1')).rejects.toMatchObject({ statusCode: 404 });
    await expect(as('alice').tab('t2')).rejects.toMatchObject({ statusCode: 404 }); // alice's project, bob's machine
  });

  it('sees everything with a null owner filter (admin "all")', async () => {
    const s = as(null);
    expect((await s.machine('m1')).id).toBe('m1');
    expect((await s.machine('m3')).id).toBe('m3');
    expect((await s.project('p9')).project.id).toBe('p9');
    expect((await s.tab('t2')).machine.id).toBe('m2');
    expect((await s.aiAccount('a1')).account.id).toBe('a1');
  });
});
```

- [ ] **Step 2: Run to see it fail**

```bash
th 'npx vitest run apps/server/src/auth/scope.test.ts'
```

Expected: FAIL (`projectMachine is not a function`, `.machine` undefined on project).

- [ ] **Step 3: Rewrite the project/tab/task lookups in `scope.ts`**

Update the import: `import type { AiAccount, Machine, Project, ProjectMachine, Tab, Task, User } from '../db/repositories/types.js';` and `import { HttpError, notFound } from '../lib/errors.js';`. Update the file comment: "Data scope: machines, projects and integrations belong to a user (`owner_id`); tabs, tasks, notes and tickets follow their project, and a tab additionally runs on a machine of the same scope."

Replace `project`, `tab` and `task` with:

```ts
  async project(id: string): Promise<{ project: Project }> {
    const project = await this.repos.projects.findById(id);
    if (!project || !this.owns(project.owner_id)) throw notFound('Projeto não encontrado');
    return { project };
  }

  /** A project and one of its linked machines; the link and the machine must both be in scope. */
  async projectMachine(projectId: string, machineId: string): Promise<{ project: Project; machine: Machine; link: ProjectMachine }> {
    const { project } = await this.project(projectId);
    const link = await this.repos.projectMachines.find(projectId, machineId);
    if (!link) throw notFound('Máquina não vinculada ao projeto');
    const machine = await this.machine(machineId).catch(() => {
      throw notFound('Máquina não vinculada ao projeto');
    });
    return { project, machine, link };
  }

  /** A project with every linked machine the scope can see (a link to a machine outside it is skipped). */
  async projectMachines(projectId: string): Promise<{ project: Project; machines: Array<{ machine: Machine; link: ProjectMachine }> }> {
    const { project } = await this.project(projectId);
    const links = await this.repos.projectMachines.listByProject(projectId);
    const machines: Array<{ machine: Machine; link: ProjectMachine }> = [];
    for (const link of links) {
      const machine = await this.repos.machines.findById(link.machine_id);
      if (machine && this.owns(machine.owner_id)) machines.push({ machine, link });
    }
    return { project, machines };
  }

  /**
   * The machine a new tab opens on: `machineId` when given (must be linked), else the only linked
   * machine. 400 MACHINE_REQUIRED with several, 400 NO_MACHINE with none — the messages tell the
   * person (or the agent) what to do.
   */
  async projectMachineFor(projectId: string, machineId?: string): Promise<{ project: Project; machine: Machine; link: ProjectMachine }> {
    if (machineId) return this.projectMachine(projectId, machineId);
    const { project, machines } = await this.projectMachines(projectId);
    if (machines.length === 0) throw new HttpError(400, 'Vincule uma máquina ao projeto antes de abrir um terminal', 'NO_MACHINE');
    if (machines.length > 1) throw new HttpError(400, 'Escolha a máquina onde abrir o terminal (machine_id)', 'MACHINE_REQUIRED');
    return { project, ...machines[0] };
  }

  async tab(id: string): Promise<{ tab: Tab; project: Project; machine: Machine; cwd: string }> {
    const tab = await this.repos.tabs.findById(id);
    if (!tab) throw notFound('Tab não encontrada');
    const { project, machine, link } = await this.projectMachine(tab.project_id, tab.machine_id).catch(() => {
      throw notFound('Tab não encontrada');
    });
    return { tab, project, machine, cwd: link.cwd };
  }

  async task(id: string): Promise<{ task: Task; project: Project }> {
    const task = await this.repos.tasks.findById(id);
    if (!task) throw notFound('Tarefa não encontrada');
    const { project } = await this.project(task.project_id).catch(() => {
      throw notFound('Tarefa não encontrada');
    });
    return { task, project };
  }
```

Check `HttpError`'s constructor in `apps/server/src/lib/errors.ts` is `(statusCode, message, code)` (it is: `new HttpError(404, msg, 'NOT_FOUND')`) and that it is exported (`export class HttpError`).

- [ ] **Step 4: Run the scope tests**

```bash
th 'npx vitest run apps/server/src/auth/scope.test.ts'
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/auth
git commit -m "Scope: projects by owner, tabs through their machine link"
```

---

### Task 5: Project routes (CRUD, key availability, machine links, tabs)

**Files:**
- Modify: `apps/server/src/routes/projects.ts` (full rewrite)
- Create: `apps/server/src/routes/projects.test.ts`

**Interfaces:**
- Consumes: `Scoped.project/projectMachine/projectMachines/projectMachineFor`, `repos.projects.{list,create,update,delete,isKeyAvailable}`, `repos.projectMachines.{listByProjects,listByProject,link,updateCwd,unlink}`, `repos.tabs.{listByProject,listByProjectMachine,create,delete}`, `ProjectRuleError`, `ensureDirectory(machine, path, create)`, `killTmuxSession(machine, session)`, `listTmuxSessions(machine)`.
- Produces (HTTP, all under `/projects`, resource `projects`):
  - `GET /` → `{ projects: Array<Project & { machines: Array<{ machine_id, cwd, position }>; open_tasks: number }> }`
  - `GET /key-available?key=` → `{ available: boolean; reason?: 'invalid' | 'taken' }`
  - `POST /` body `{ name, key, description?, status?, machine_id?, cwd?, create_dir? }` → 201 `{ project: Project & { machines } }`; 400 `KEY_INVALID`/`MACHINE_REQUIRED`-style messages, 409 `KEY_TAKEN`
  - `GET /:id` → `{ project: Project & { machines } }`
  - `PATCH /:id` body `{ name?, description?, status? }` (extra keys such as `key`/`cwd` are rejected by zod `.strict()`)
  - `DELETE /:id` → `{ ok: true }` after killing tmux on every linked machine
  - `GET /:id/machines` → `{ machines: Array<{ machine_id, cwd, position, machine: { id, name, type } }> }`
  - `POST /:id/machines` body `{ machine_id, cwd, create_dir? }` → 201 `{ link }`; 409 when already linked
  - `PATCH /:id/machines/:machineId` body `{ cwd, create_dir? }` → `{ link }`
  - `DELETE /:id/machines/:machineId` → `{ ok: true, closed_tabs: number }`
  - `GET /:id/tabs` → `{ reachable: boolean; tabs: Array<Tab & { alive: boolean }> }` (`reachable` false if any linked machine with terminal tabs could not be probed)
  - `POST /:id/tabs` body `{ name?, kind?, simulator_udid?, machine_id? }` → 201 `{ tab }`

- [ ] **Step 1: Write the failing route tests**

`apps/server/src/routes/projects.test.ts`:

```ts
import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { ensureDirectory, killTmuxSession, listTmuxSessions } = vi.hoisted(() => ({ ensureDirectory: vi.fn(), killTmuxSession: vi.fn(), listTmuxSessions: vi.fn() }));
vi.mock('../terminal/machine-fs.js', () => ({ ensureDirectory }));
vi.mock('../terminal/machine-exec.js', () => ({ killTmuxSession, listTmuxSessions }));

import type { Repositories } from '../db/repositories/index.js';
import { ProjectRuleError } from '../db/repositories/projects.js';
import type { Machine, Project, ProjectMachine, Tab } from '../db/repositories/types.js';
import { applyErrorHandler } from '../lib/errors.js';
import { projectRoutes } from './projects.js';

const machine = (over: Partial<Machine> & { id: string }): Machine => ({
  name: over.id, host: null, ssh_user: null, ssh_port: 22, type: 'agent', os: null, capabilities: ['tmux'], checked_at: null,
  agent_version: null, agent_last_seen_at: null, agent_auto_update: false, is_local: false, owner_id: 'u1', owner_name: null, created_at: '', ...over,
});
const project = (over: Partial<Project> & { id: string }): Project => ({
  owner_id: 'u1', key: over.id.toUpperCase(), next_task_number: 1, name: over.id, status: 'active', description: null, last_terminal_at: null, created_at: '', ...over,
});
const link = (project_id: string, machine_id: string, cwd = `/src/${project_id}`): ProjectMachine => ({ id: `${project_id}-${machine_id}`, project_id, machine_id, cwd, position: 0, created_at: '' });
const tab = (over: Partial<Tab> & { id: string; project_id: string; machine_id: string }): Tab => ({
  name: over.id, kind: 'terminal', tmux_session: `th-${over.id}`, simulator_udid: null, created_by_token_id: null, position: 0,
  state: null, state_text: null, state_tool: null, state_at: null, state_seen_at: null, created_at: '', ...over,
});

/** u1 owns m1, m2 and projects p1 (m1 only), p2 (m1 + m2), p3 (no machine); u2 owns mx and px. */
function buildApp() {
  const machines: Record<string, Machine> = { m1: machine({ id: 'm1' }), m2: machine({ id: 'm2', type: 'local' }), mx: machine({ id: 'mx', owner_id: 'u2' }) };
  const projects: Record<string, Project> = { p1: project({ id: 'p1' }), p2: project({ id: 'p2' }), p3: project({ id: 'p3' }), px: project({ id: 'px', owner_id: 'u2' }) };
  let links: ProjectMachine[] = [link('p1', 'm1'), link('p2', 'm1'), link('p2', 'm2', '/other'), link('px', 'mx')];
  let tabs: Tab[] = [tab({ id: 't1', project_id: 'p2', machine_id: 'm1' }), tab({ id: 't2', project_id: 'p2', machine_id: 'm2' })];
  const app = Fastify();
  applyErrorHandler(app);
  app.addHook('preHandler', async (request) => {
    request.scope = { user: { id: 'u1' } as never, viewAs: { kind: 'self' }, ownerId: 'u1', createAs: 'u1' };
    request.user = { id: 'u1' } as never;
  });
  const repos = {
    machines: { findById: vi.fn(async (id: string) => machines[id]) },
    projects: {
      list: vi.fn(async (f: { owner?: string | null }) => Object.values(projects).filter((p) => !f.owner || p.owner_id === f.owner)),
      findById: vi.fn(async (id: string) => projects[id]),
      isKeyAvailable: vi.fn(async (key: string) => /^[A-Z][A-Z0-9]{1,9}$/.test(key) && !Object.values(projects).some((p) => p.key === key)),
      create: vi.fn(async (input: { owner_id: string; key: string; name: string }) => {
        if (Object.values(projects).some((p) => p.key === input.key)) throw new ProjectRuleError('KEY_TAKEN', `A chave ${input.key} já está em uso`);
        return (projects.new = project({ id: 'new', ...input }));
      }),
      update: vi.fn(async (id: string, patch: Partial<Project>) => (projects[id] = { ...projects[id], ...patch })),
      delete: vi.fn(async (id: string) => delete projects[id]),
    },
    projectMachines: {
      listByProjects: vi.fn(async (ids: string[]) => links.filter((l) => ids.includes(l.project_id))),
      listByProject: vi.fn(async (id: string) => links.filter((l) => l.project_id === id)),
      find: vi.fn(async (p: string, m: string) => links.find((l) => l.project_id === p && l.machine_id === m)),
      link: vi.fn(async (input: { project_id: string; machine_id: string; cwd: string }) => {
        if (links.some((l) => l.project_id === input.project_id && l.machine_id === input.machine_id)) throw new ProjectRuleError('MACHINE_ALREADY_LINKED', 'Esta máquina já está vinculada ao projeto');
        const l = link(input.project_id, input.machine_id, input.cwd);
        links.push(l);
        return l;
      }),
      updateCwd: vi.fn(async (p: string, m: string, cwd: string) => {
        const l = links.find((x) => x.project_id === p && x.machine_id === m);
        return l ? Object.assign(l, { cwd }) : undefined;
      }),
      unlink: vi.fn(async (p: string, m: string) => {
        const before = links.length;
        links = links.filter((l) => !(l.project_id === p && l.machine_id === m));
        return links.length < before;
      }),
    },
    tabs: {
      listByProject: vi.fn(async (id: string) => tabs.filter((t) => t.project_id === id)),
      listByProjectMachine: vi.fn(async (p: string, m: string) => tabs.filter((t) => t.project_id === p && t.machine_id === m)),
      create: vi.fn(async (project_id: string, machine_id: string, name: string, opts: { kind?: string }) => {
        const t = tab({ id: `t${tabs.length + 1}`, project_id, machine_id, name, kind: (opts.kind ?? 'terminal') as Tab['kind'] });
        tabs.push(t);
        return t;
      }),
      delete: vi.fn(async (id: string) => {
        tabs = tabs.filter((t) => t.id !== id);
        return true;
      }),
    },
    tasks: { openCountByProject: vi.fn(async () => ({ p1: 2 })) },
  };
  app.register((a) => projectRoutes(a, repos as unknown as Repositories, { simulators: { isReady: () => false } as never }), { prefix: '/projects' });
  return { app, repos, get links() { return links; }, get tabs() { return tabs; } };
}

beforeEach(() => {
  vi.clearAllMocks();
  ensureDirectory.mockImplementation(async (_m: Machine, path: string) => ({ path: path.replace(/\/$/, ''), created: false }));
  killTmuxSession.mockResolvedValue(true);
  listTmuxSessions.mockResolvedValue(new Set(['th-t1', 'th-t2']));
});

describe('GET /projects', () => {
  it('lists the owner\'s projects with their machine links and open task counts', async () => {
    const { app } = buildApp();
    const body = (await app.inject({ method: 'GET', url: '/projects' })).json();
    expect(body.projects.map((p: { id: string }) => p.id)).toEqual(['p1', 'p2', 'p3']);
    expect(body.projects[0]).toMatchObject({ key: 'P1', open_tasks: 2, machines: [{ machine_id: 'm1', cwd: '/src/p1' }] });
    expect(body.projects[1].machines.map((l: { machine_id: string }) => l.machine_id)).toEqual(['m1', 'm2']);
    expect(body.projects[2]).toMatchObject({ open_tasks: 0, machines: [] });
  });
});

describe('GET /projects/key-available', () => {
  it('answers available / taken / invalid', async () => {
    const { app } = buildApp();
    expect((await app.inject({ method: 'GET', url: '/projects/key-available?key=NEW' })).json()).toEqual({ available: true });
    expect((await app.inject({ method: 'GET', url: '/projects/key-available?key=P1' })).json()).toEqual({ available: false, reason: 'taken' });
    expect((await app.inject({ method: 'GET', url: '/projects/key-available?key=p1' })).json()).toEqual({ available: false, reason: 'invalid' });
    expect((await app.inject({ method: 'GET', url: '/projects/key-available' })).statusCode).toBe(400);
  });
});

describe('POST /projects', () => {
  it('creates a project without a machine, owned by the scope', async () => {
    const { app, repos } = buildApp();
    const r = await app.inject({ method: 'POST', url: '/projects', payload: { name: 'Novo', key: 'NOVO' } });
    expect(r.statusCode).toBe(201);
    expect(repos.projects.create).toHaveBeenCalledWith({ owner_id: 'u1', key: 'NOVO', name: 'Novo', description: undefined, status: undefined });
    expect(r.json().project).toMatchObject({ key: 'NOVO', machines: [] });
    expect(repos.projectMachines.link).not.toHaveBeenCalled();
  });

  it('creates and links in one step when machine_id and cwd come together, resolving the directory on the machine', async () => {
    const { app, repos } = buildApp();
    const r = await app.inject({ method: 'POST', url: '/projects', payload: { name: 'Novo', key: 'NOVO', machine_id: 'm1', cwd: '/home/u/novo/', create_dir: true } });
    expect(r.statusCode).toBe(201);
    expect(ensureDirectory).toHaveBeenCalledWith(expect.objectContaining({ id: 'm1' }), '/home/u/novo/', true);
    expect(repos.projectMachines.link).toHaveBeenCalledWith({ project_id: 'new', machine_id: 'm1', cwd: '/home/u/novo' });
    expect(r.json().project.machines).toEqual([expect.objectContaining({ machine_id: 'm1', cwd: '/home/u/novo' })]);
  });

  it.each([
    ['machine_id without cwd', { name: 'x', key: 'X1', machine_id: 'm1' }],
    ['cwd without machine_id', { name: 'x', key: 'X1', cwd: '/x' }],
    ['a relative cwd', { name: 'x', key: 'X1', machine_id: 'm1', cwd: 'rel' }],
    ['a lowercase key', { name: 'x', key: 'x1' }],
    ['no key', { name: 'x' }],
  ])('rejects %s with 400', async (_n, payload) => {
    const { app, repos } = buildApp();
    expect((await app.inject({ method: 'POST', url: '/projects', payload })).statusCode).toBe(400);
    expect(repos.projects.create).not.toHaveBeenCalled();
  });

  it('answers 409 for a taken key and 400 for a machine outside the scope', async () => {
    const { app } = buildApp();
    const taken = await app.inject({ method: 'POST', url: '/projects', payload: { name: 'x', key: 'P1' } });
    expect(taken.statusCode).toBe(409);
    expect(taken.json().error).toBe('A chave P1 já está em uso');
    const foreign = await app.inject({ method: 'POST', url: '/projects', payload: { name: 'x', key: 'X1', machine_id: 'mx', cwd: '/x' } });
    expect(foreign.statusCode).toBe(400);
    expect(foreign.json().error).toBe('Máquina inexistente');
  });
});

describe('PATCH / DELETE /projects/:id', () => {
  it('updates name/description/status and refuses key and cwd', async () => {
    const { app, repos } = buildApp();
    const ok = await app.inject({ method: 'PATCH', url: '/projects/p1', payload: { name: 'Renomeado', status: 'paused' } });
    expect(ok.statusCode).toBe(200);
    expect(repos.projects.update).toHaveBeenCalledWith('p1', { name: 'Renomeado', status: 'paused' });
    expect((await app.inject({ method: 'PATCH', url: '/projects/p1', payload: { key: 'ZZ' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PATCH', url: '/projects/p1', payload: { cwd: '/x' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PATCH', url: '/projects/px', payload: { name: 'x' } })).statusCode).toBe(404);
  });

  it('kills the tmux sessions on every linked machine before deleting', async () => {
    const { app, repos } = buildApp();
    const r = await app.inject({ method: 'DELETE', url: '/projects/p2' });
    expect(r.statusCode).toBe(200);
    expect(killTmuxSession).toHaveBeenCalledWith(expect.objectContaining({ id: 'm1' }), 'th-t1');
    expect(killTmuxSession).toHaveBeenCalledWith(expect.objectContaining({ id: 'm2' }), 'th-t2');
    expect(repos.projects.delete).toHaveBeenCalledWith('p2');
  });
});

describe('project machines', () => {
  it('lists links with the machine summary', async () => {
    const { app } = buildApp();
    const body = (await app.inject({ method: 'GET', url: '/projects/p2/machines' })).json();
    expect(body.machines).toEqual([
      expect.objectContaining({ machine_id: 'm1', cwd: '/src/p2', machine: { id: 'm1', name: 'm1', type: 'agent' } }),
      expect.objectContaining({ machine_id: 'm2', cwd: '/other', machine: { id: 'm2', name: 'm2', type: 'local' } }),
    ]);
  });

  it('links a machine (directory checked on it), 409 when already linked, 400 for a foreign machine', async () => {
    const { app, repos } = buildApp();
    const r = await app.inject({ method: 'POST', url: '/projects/p3/machines', payload: { machine_id: 'm2', cwd: '/w/', create_dir: true } });
    expect(r.statusCode).toBe(201);
    expect(ensureDirectory).toHaveBeenCalledWith(expect.objectContaining({ id: 'm2' }), '/w/', true);
    expect(repos.projectMachines.link).toHaveBeenCalledWith({ project_id: 'p3', machine_id: 'm2', cwd: '/w' });
    expect((await app.inject({ method: 'POST', url: '/projects/p1/machines', payload: { machine_id: 'm1', cwd: '/x' } })).statusCode).toBe(409);
    expect((await app.inject({ method: 'POST', url: '/projects/p1/machines', payload: { machine_id: 'mx', cwd: '/x' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/projects/px/machines', payload: { machine_id: 'm1', cwd: '/x' } })).statusCode).toBe(404);
  });

  it('updates the cwd of a link and 404s an unlinked machine', async () => {
    const { app } = buildApp();
    const r = await app.inject({ method: 'PATCH', url: '/projects/p2/machines/m2', payload: { cwd: '/new' } });
    expect(r.statusCode).toBe(200);
    expect(r.json().link).toMatchObject({ machine_id: 'm2', cwd: '/new' });
    expect((await app.inject({ method: 'PATCH', url: '/projects/p1/machines/m2', payload: { cwd: '/new' } })).statusCode).toBe(404);
  });

  it('unlinking closes that machine\'s tabs of the project and reports how many', async () => {
    const built = buildApp();
    const r = await built.app.inject({ method: 'DELETE', url: '/projects/p2/machines/m2' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true, closed_tabs: 1 });
    expect(killTmuxSession).toHaveBeenCalledTimes(1);
    expect(killTmuxSession).toHaveBeenCalledWith(expect.objectContaining({ id: 'm2' }), 'th-t2');
    expect(built.tabs.map((t) => t.id)).toEqual(['t1']);
    expect(built.links.some((l) => l.project_id === 'p2' && l.machine_id === 'm2')).toBe(false);
  });
});

describe('tabs', () => {
  it('GET lists tabs across machines with alive per machine; a silent machine marks only its own tabs dead', async () => {
    const { app } = buildApp();
    listTmuxSessions.mockImplementation(async (m: Machine) => {
      if (m.id === 'm2') throw new Error('offline');
      return new Set(['th-t1']);
    });
    const body = (await app.inject({ method: 'GET', url: '/projects/p2/tabs' })).json();
    expect(body.reachable).toBe(false);
    expect(body.tabs.map((t: Tab & { alive: boolean }) => [t.id, t.machine_id, t.alive])).toEqual([['t1', 'm1', true], ['t2', 'm2', false]]);
  });

  it('POST opens on the only linked machine, needs machine_id with several, refuses with none', async () => {
    const { app, repos } = buildApp();
    const one = await app.inject({ method: 'POST', url: '/projects/p1/tabs', payload: {} });
    expect(one.statusCode).toBe(201);
    expect(repos.tabs.create).toHaveBeenCalledWith('p1', 'm1', expect.any(String), { kind: 'terminal', simulator_udid: null }); // nextTerminalName picks a random teammate name
    expect(one.json().tab).toMatchObject({ machine_id: 'm1', alive: false });

    const several = await app.inject({ method: 'POST', url: '/projects/p2/tabs', payload: {} });
    expect(several.statusCode).toBe(400);
    expect(several.json().code).toBe('MACHINE_REQUIRED');
    const chosen = await app.inject({ method: 'POST', url: '/projects/p2/tabs', payload: { machine_id: 'm2' } });
    expect(chosen.statusCode).toBe(201);
    expect(chosen.json().tab.machine_id).toBe('m2');

    const none = await app.inject({ method: 'POST', url: '/projects/p3/tabs', payload: {} });
    expect(none.statusCode).toBe(400);
    expect(none.json().code).toBe('NO_MACHINE');
    expect((await app.inject({ method: 'POST', url: '/projects/p1/tabs', payload: { machine_id: 'm2' } })).statusCode).toBe(404);
  });
});
```

- [ ] **Step 2: Run to see it fail**

```bash
th 'npx vitest run apps/server/src/routes/projects.test.ts'
```

Expected: FAIL (old body schema, `machine` destructured from `scoped.project`).

- [ ] **Step 3: Rewrite `routes/projects.ts`**

```ts
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Repositories } from '../db/repositories/index.js';
import { ProjectRuleError } from '../db/repositories/projects.js';
import type { Machine, Project, ProjectMachine, Tab } from '../db/repositories/types.js';
import { badRequest, conflict } from '../lib/errors.js';
import { PROJECT_KEY_RE } from '../lib/project-key.js';
import { nextTerminalName } from '../lib/tab-names.js';
import { scoped } from '../auth/scope.js';
import { killTmuxSession, listTmuxSessions } from '../terminal/machine-exec.js';
import type { SimulatorSessionManager } from '../simulator/session-manager.js';
import { ensureDirectory } from '../terminal/machine-fs.js';

const idParam = z.object({ id: z.string().min(1).max(64) });
const linkParams = z.object({ id: z.string().min(1).max(64), machineId: z.string().min(1).max(64) });

const cwdSchema = z.string().trim().min(1).max(1024).refine((p) => p.startsWith('/') || /^[A-Za-z]:\\/.test(p) || p.startsWith('~'), {
  message: 'cwd deve ser um caminho absoluto',
});
const keySchema = z.string().trim().regex(PROJECT_KEY_RE, 'Chave inválida: 2 a 10 letras maiúsculas ou dígitos, começando com letra');
const statusSchema = z.enum(['active', 'paused', 'archived']);

const createBody = z
  .object({
    name: z.string().trim().min(1).max(120),
    key: keySchema,
    status: statusSchema.optional(),
    description: z.string().trim().max(2000).optional().nullable(),
    /** optional first machine link (both or neither) */
    machine_id: z.string().min(1).max(64).optional(),
    cwd: cwdSchema.optional(),
    /** creates the folder on the machine (mkdir -p) when it does not exist */
    create_dir: z.boolean().optional(),
  })
  .strict()
  .refine((b) => (b.machine_id === undefined) === (b.cwd === undefined), { message: 'machine_id e cwd vêm juntos' });

/** `key` and `cwd` are not patchable: the key never changes, the cwd lives on the machine link. */
const patchBody = z.object({ name: z.string().trim().min(1).max(120).optional(), status: statusSchema.optional(), description: z.string().trim().max(2000).optional().nullable() }).strict();

const linkBody = z.object({ machine_id: z.string().min(1).max(64), cwd: cwdSchema, create_dir: z.boolean().optional() }).strict();
const linkPatchBody = z.object({ cwd: cwdSchema, create_dir: z.boolean().optional() }).strict();

const tabBody = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  kind: z.enum(['terminal', 'simulator']).optional(),
  simulator_udid: z.string().regex(/^[A-Fa-f0-9-]{8,64}$/).optional(),
  /** required when the project is linked to more than one machine */
  machine_id: z.string().min(1).max(64).optional(),
});

/** Windows paths (C:\...) do not go through sh: they are stored unchecked. */
const isPosixPath = (p: string) => p.startsWith('/') || p.startsWith('~');

/** Checks the folder on the machine (creates it when asked) and returns the resolved absolute path. */
async function resolveCwd(machine: Machine, cwd: string, createDir: boolean | undefined): Promise<string> {
  if (!isPosixPath(cwd)) return cwd;
  return (await ensureDirectory(machine, cwd, createDir ?? false)).path;
}

/** Repository rule errors become 409 (conflicts) or 400 with their pt-BR message. */
async function rule<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (e) {
    if (e instanceof ProjectRuleError) throw (e.code === 'KEY_TAKEN' || e.code === 'MACHINE_ALREADY_LINKED' ? conflict : badRequest)(e.message);
    throw e;
  }
}

const linkView = (l: ProjectMachine) => ({ machine_id: l.machine_id, cwd: l.cwd, position: l.position });

export async function projectRoutes(app: FastifyInstance, repos: Repositories, deps: { simulators: SimulatorSessionManager }) {
  /** Projects with their links attached, one query for the links. */
  async function withLinks(projects: Project[]): Promise<Array<Project & { machines: ReturnType<typeof linkView>[] }>> {
    const links = await repos.projectMachines.listByProjects(projects.map((p) => p.id));
    return projects.map((p) => ({ ...p, machines: links.filter((l) => l.project_id === p.id).map(linkView) }));
  }

  app.get('/', async (request) => {
    const q = z.object({ status: statusSchema.optional(), machine_id: z.string().min(1).max(64).optional() }).parse(request.query);
    const [projects, openCounts] = await Promise.all([
      repos.projects.list({ status: q.status, machine_id: q.machine_id, owner: request.scope.ownerId }),
      repos.tasks.openCountByProject(),
    ]);
    return { projects: (await withLinks(projects)).map((p) => ({ ...p, open_tasks: openCounts[p.id] ?? 0 })) };
  });

  app.get('/key-available', async (request) => {
    const { key } = z.object({ key: z.string().trim().min(1).max(20) }).parse(request.query);
    if (!PROJECT_KEY_RE.test(key)) return { available: false, reason: 'invalid' as const };
    return (await repos.projects.isKeyAvailable(key)) ? { available: true } : { available: false, reason: 'taken' as const };
  });

  app.post('/', async (request, reply) => {
    const { create_dir, machine_id, cwd, ...body } = createBody.parse(request.body);
    let machine: Machine | undefined;
    let resolvedCwd: string | undefined;
    if (machine_id && cwd) {
      machine = await scoped(repos, request).machine(machine_id).catch(() => {
        throw badRequest('Máquina inexistente');
      });
      resolvedCwd = await resolveCwd(machine, cwd, create_dir);
    }
    const project = await rule(() => repos.projects.create({ owner_id: request.scope.createAs, key: body.key, name: body.name, description: body.description, status: body.status }));
    const machines = machine && resolvedCwd ? [linkView(await repos.projectMachines.link({ project_id: project.id, machine_id: machine.id, cwd: resolvedCwd }))] : [];
    return reply.code(201).send({ project: { ...project, machines } });
  });

  app.get('/:id', async (request) => {
    const { id } = idParam.parse(request.params);
    const { project } = await scoped(repos, request).project(id);
    return { project: (await withLinks([project]))[0] };
  });

  app.patch('/:id', async (request) => {
    const { id } = idParam.parse(request.params);
    await scoped(repos, request).project(id);
    const patch = patchBody.parse(request.body);
    const project = await repos.projects.update(id, patch);
    return { project: project ? (await withLinks([project]))[0] : undefined };
  });

  app.delete('/:id', async (request) => {
    const { id } = idParam.parse(request.params);
    const { machines } = await scoped(repos, request).projectMachines(id);
    // Best effort: kill the tmux sessions on every linked machine before deleting (a machine may be offline).
    const tabs = await repos.tabs.listByProject(id);
    await Promise.allSettled(
      tabs
        .filter((t) => t.tmux_session)
        .map((t) => {
          const m = machines.find((x) => x.machine.id === t.machine_id)?.machine;
          return m ? killTmuxSession(m, t.tmux_session!) : Promise.resolve(false);
        }),
    );
    await repos.projects.delete(id);
    return { ok: true };
  });

  // --- Machine links ---
  app.get('/:id/machines', async (request) => {
    const { id } = idParam.parse(request.params);
    const { machines } = await scoped(repos, request).projectMachines(id);
    return { machines: machines.map(({ machine, link }) => ({ ...linkView(link), machine: { id: machine.id, name: machine.name, type: machine.type } })) };
  });

  app.post('/:id/machines', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    await scoped(repos, request).project(id);
    const { machine_id, cwd, create_dir } = linkBody.parse(request.body);
    const machine = await scoped(repos, request).machine(machine_id).catch(() => {
      throw badRequest('Máquina inexistente');
    });
    const resolved = await resolveCwd(machine, cwd, create_dir);
    const link = await rule(() => repos.projectMachines.link({ project_id: id, machine_id: machine.id, cwd: resolved }));
    return reply.code(201).send({ link: linkView(link) });
  });

  app.patch('/:id/machines/:machineId', async (request) => {
    const { id, machineId } = linkParams.parse(request.params);
    const { machine } = await scoped(repos, request).projectMachine(id, machineId);
    const { cwd, create_dir } = linkPatchBody.parse(request.body);
    const link = await repos.projectMachines.updateCwd(id, machineId, await resolveCwd(machine, cwd, create_dir));
    return { link: link ? linkView(link) : undefined };
  });

  /** Closes the project's tabs on that machine (best-effort tmux kill), then removes the link. */
  app.delete('/:id/machines/:machineId', async (request) => {
    const { id, machineId } = linkParams.parse(request.params);
    const { machine } = await scoped(repos, request).projectMachine(id, machineId);
    const tabs = await repos.tabs.listByProjectMachine(id, machineId);
    await Promise.allSettled(tabs.filter((t) => t.tmux_session).map((t) => killTmuxSession(machine, t.tmux_session!)));
    for (const t of tabs) await repos.tabs.delete(t.id);
    await repos.projectMachines.unlink(id, machineId);
    return { ok: true, closed_tabs: tabs.length };
  });

  // --- Tabs ---
  app.get('/:id/tabs', async (request) => {
    const { id } = idParam.parse(request.params);
    const { machines } = await scoped(repos, request).projectMachines(id);
    const tabs = await repos.tabs.listByProject(id);
    // one probe per machine that has terminal tabs; a silent machine marks only its own tabs dead
    const alive = new Map<string, Set<string>>();
    let reachable = true;
    await Promise.all(
      machines
        .filter(({ machine }) => tabs.some((t) => t.kind === 'terminal' && t.machine_id === machine.id))
        .map(async ({ machine }) => {
          try {
            alive.set(machine.id, await listTmuxSessions(machine));
          } catch {
            reachable = false;
          }
        }),
    );
    const isAlive = (t: Tab) =>
      t.kind === 'simulator' ? !!t.simulator_udid && deps.simulators.isReady(t.machine_id, t.simulator_udid) : !!t.tmux_session && (alive.get(t.machine_id)?.has(t.tmux_session) ?? false);
    return { reachable, tabs: tabs.map((t) => ({ ...t, alive: isAlive(t) })) };
  });

  app.post('/:id/tabs', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const body = tabBody.parse(request.body ?? {});
    const { machine } = await scoped(repos, request).projectMachineFor(id, body.machine_id);
    const kind = body.kind ?? 'terminal';
    const existing = await repos.tabs.listByProject(id);
    const count = existing.filter((t) => t.kind === kind).length + 1;
    const name = body.name ?? (kind === 'simulator' ? `Simulador ${count}` : nextTerminalName(existing.map((t) => t.name)));
    if (kind === 'simulator' && !machine.capabilities.includes('wda')) throw badRequest('Prepare o WDA nesta máquina antes de abrir um simulador');
    const tab = await repos.tabs.create(id, machine.id, name, { kind, simulator_udid: body.simulator_udid ?? null });
    return reply.code(201).send({ tab: { ...tab, alive: false } });
  });
}
```

Note: `projectMachineFor` throws `HttpError(400, …, 'MACHINE_REQUIRED' | 'NO_MACHINE')`; `applyErrorHandler` already serialises `HttpError` as `{ error, code }`.

- [ ] **Step 4: Run the tests**

```bash
th 'npx vitest run apps/server/src/routes/projects.test.ts'
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/routes/projects.ts apps/server/src/routes/projects.test.ts
git commit -m "Project routes: key, machine links, tabs per machine"
```

---

### Task 6: Terminal, PTY, monitor and tab routes use the tab's machine and cwd

**Files:**
- Modify: `apps/server/src/terminal/pty-session.ts` (`buildSpawn`, `LocalPtySession`, `createPtySession`)
- Modify: `apps/server/src/agent/pty.ts` (`AgentPtySession.open`)
- Modify: `apps/server/src/terminal/ws.ts` (upgrade handler and `handleConnection` ctx)
- Modify: `apps/server/src/simulator/ws.ts` (no change needed beyond the destructure; verify)
- Modify: `apps/server/src/routes/tabs.ts:54-57` (screenshot uses `machine.id`)
- Modify: `apps/server/src/monitor/ingest.ts:27-31` (`applyState`)
- Modify: `apps/server/src/routes/monitor.ts:19-22`
- Tests: `apps/server/src/terminal/ws.test.ts`, `apps/server/src/agent/pty.test.ts`, `apps/server/src/agent/e2e.test.ts`, `apps/server/src/routes/tabs.test.ts`, `apps/server/src/routes/hooks.test.ts`, `apps/server/src/control/screen.test.ts`

**Interfaces:**
- Produces: `buildSpawn(machine: Machine, cwd: string, tab: Tab)`, `new LocalPtySession(machine, cwd, tab, size, handlers)`, `createPtySession(machine, cwd, tab, size, handlers)`, `AgentPtySession.open(registry, machine, cwd, tab, size, handlers)`. Nothing in the terminal path reads `Project` anymore.

- [ ] **Step 1: Update the tests first**

`apps/server/src/agent/pty.test.ts`: remove the `project` fixture (lines ~28–36) and the `Project` import; call `AgentPtySession.open(registry, machine, '/Users/x/proj', tab, …)` where it currently passes `project`. The assertion at line ~82 stays (`cwd: '/Users/x/proj'`).

`apps/server/src/terminal/ws.test.ts`: change the `project` fixture to the new shape and add the link/tab fields:

```ts
const project: Project = { id: 'p1', owner_id: 'u1', key: 'PROJ', next_task_number: 1, name: 'proj', status: 'active', description: null, last_terminal_at: null, created_at: new Date().toISOString() };
const tab: Tab = { id: 't1', project_id: 'p1', machine_id: 'm1', name: 'main', kind: 'terminal', tmux_session: 'termhub-t1', simulator_udid: null, position: 0, created_at: new Date().toISOString() } as unknown as Tab;

function fakeRepos(): Repositories {
  return {
    tabs: { findById: vi.fn(async () => tab) },
    projects: { findById: vi.fn(async () => project), touchTerminal: vi.fn(async () => {}) },
    projectMachines: { find: vi.fn(async () => ({ id: 'l1', project_id: 'p1', machine_id: 'm1', cwd: '/Users/x/proj', position: 0, created_at: '' })) },
    machines: { findById: vi.fn(async () => machine) },
  } as unknown as Repositories;
}
```

Any assertion in that file on the spawn args that used `project.cwd` keeps the value `/Users/x/proj`.

`apps/server/src/agent/e2e.test.ts` (~lines 132–170): same change — project without `machine_id`/`cwd` (add `owner_id: 'u1', key: 'E2E', next_task_number: 1`), tabs gain `machine_id: 'm1'`, and `repos.projectMachines = { find: vi.fn(async () => ({ id: 'l1', project_id: 'p1', machine_id: 'm1', cwd: projectCwd, position: 0, created_at: '' })) }`.

`apps/server/src/routes/tabs.test.ts` `buildApp`: tabs get `machine_id: machine.id` in the `tab()` factory default (`machine_id: 'm1'`), and repos become:

```ts
    projects: { findById: vi.fn(async (id: string) => (id === 'p1' ? { id: 'p1', owner_id: 'u1' } : undefined)) },
    projectMachines: { find: vi.fn(async (p: string, m: string) => (p === 'p1' && m === machine.id ? { id: 'l1', project_id: 'p1', machine_id: m, cwd: '/tmp', position: 0, created_at: '' } : undefined)) },
    machines: { findById: vi.fn(async (id: string) => (id === machine.id ? { owner_id: 'u1', ...machine } : undefined)) },
```

`apps/server/src/routes/hooks.test.ts` (~line 20): the tab fixture gains `machine_id: 'm1'`; replace `projects: { findById: async () => ({ id: 'p1', machine_id: 'm1' }) }` with `machines: { findById: async (id: string) => (id === 'm1' ? { id: 'm1', owner_id: 'u1' } : undefined) }` (keep whatever else the repos stub has).

`apps/server/src/control/screen.test.ts` (~lines 17–31): `p1 = { id: 'p1', owner_id: 'u1' } as Project`; tab fixtures gain `machine_id: 'm1'`; add `projectMachines: { find: vi.fn(async () => ({ id: 'l1', project_id: 'p1', machine_id: 'm1', cwd: '/p1', position: 0, created_at: '' })) }` next to `projects` in the repos stub.

- [ ] **Step 2: Run them to see the failures**

```bash
th 'npx vitest run apps/server/src/agent/pty.test.ts apps/server/src/terminal/ws.test.ts apps/server/src/routes/tabs.test.ts apps/server/src/routes/hooks.test.ts apps/server/src/control/screen.test.ts'
```

Expected: FAIL (type/shape mismatches; `project.cwd` undefined).

- [ ] **Step 3: Change the PTY code to take `cwd`**

`apps/server/src/terminal/pty-session.ts`: remove `Project` from the types import; change the three signatures and bodies:

```ts
export function buildSpawn(machine: Machine, cwd: string, tab: Tab): { file: string; args: string[]; cwd?: string } {
  // ... same body, with `localCwd(cwd)` in place of `localCwd(project.cwd)` (twice) and `shellQuote(cwd)` in place of `shellQuote(project.cwd)`
}

  constructor(machine: Machine, cwd: string, tab: Tab, size: Partial<PtySize>, handlers: PtySessionHandlers) {
    const spawnSpec = buildSpawn(machine, cwd, tab);
    // ... and use spawnSpec.file / spawnSpec.args / spawnSpec.cwd below

export async function createPtySession(machine: Machine, cwd: string, tab: Tab, size: Partial<PtySize>, handlers: PtySessionHandlers): Promise<PtySession> {
  if (machine.type === 'agent') return AgentPtySession.open(agents, machine, cwd, tab, size, handlers);
  return new LocalPtySession(machine, cwd, tab, size, handlers);
}
```

`apps/server/src/agent/pty.ts`: `static async open(registry, machine: Machine, cwd: string, tab: Tab, size, handlers)` and `{ session: tab.tmux_session, cwd, cols, rows }`; drop the `Project` import.

`apps/server/src/terminal/ws.ts`: in the upgrade handler, `const { tab, project, machine, cwd } = found;` and `handleConnection(ws, { tab, project, machine, cwd, cols, rows }, deps, log)`; `handleConnection`'s ctx type becomes `{ tab: Tab; project: Project; machine: Machine; cwd: string; cols: number; rows: number }`; the `createPtySession(ctx.machine, ctx.project, ctx.tab, …)` call becomes `createPtySession(ctx.machine, ctx.cwd, ctx.tab, …)`. `touchTerminal(ctx.project.id)` stays.

`apps/server/src/simulator/ws.ts`: `const { tab, machine } = found;` already ignores the project — no change; confirm it typechecks.

- [ ] **Step 4: Tab routes and the monitor read the machine from the tab**

`apps/server/src/routes/tabs.ts` screenshot route: `const { tab, machine } = await scoped(repos, request).tab(id);` and `deps.simulators.getClient(machine.id, tab.simulator_udid)`.

`apps/server/src/monitor/ingest.ts` `applyState`:

```ts
  const { tab: updated } = await repos.tabs.recordEvent(tab.id, { kind: next.kind, tool, text: next.text, meta: next.meta });
  const machine = await repos.machines.findById(tab.machine_id);
  log.info({ tabId: tab.id, machineId: machine?.id, tool, kind: next.kind, textLen: next.text?.length ?? 0 }, 'monitor: tab state');
  publishTabChange(updated, tab.project_id, machine);
```

`apps/server/src/routes/monitor.ts`:

```ts
    for (const tab of tabs) {
      const project = projectById.get(tab.project_id);
      const machine = machineById.get(tab.machine_id);
      if (project && machine) items.push({ tab, project, machine });
    }
```

- [ ] **Step 5: Run the tests**

```bash
th 'npx vitest run apps/server/src/agent/pty.test.ts apps/server/src/terminal/ws.test.ts apps/server/src/routes/tabs.test.ts apps/server/src/routes/hooks.test.ts apps/server/src/control/screen.test.ts apps/server/src/agent/e2e.test.ts'
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/terminal apps/server/src/agent apps/server/src/simulator apps/server/src/routes/tabs.ts apps/server/src/routes/monitor.ts apps/server/src/monitor/ingest.ts apps/server/src/control/screen.test.ts
git commit -m "Terminals: open sessions with the machine link's cwd, tab carries its machine"
```

---

### Task 7: MCP control (terminals, agents, inventory) and tool definitions

**Files:**
- Modify: `apps/server/src/control/terminals.ts` (`terminal()`, `openTab`, `sendInput`, `sendKey`, `runCommand`)
- Modify: `apps/server/src/control/agents.ts:95-110`
- Modify: `apps/server/src/control/inventory.ts` (`listProjects`, `listTabs`, `find`)
- Modify: `apps/server/src/mcp/tools.ts` (`list_projects`, `open_tab`, `start_agent`)
- Tests: `apps/server/src/control/terminals.test.ts`, `apps/server/src/control/agents.test.ts`, `apps/server/src/control/inventory.test.ts`, `apps/server/src/mcp/terminals.e2e.test.ts`, `apps/server/src/mcp/start-agent.e2e.test.ts`, `apps/server/src/mcp/gate.e2e.test.ts`

**Interfaces:**
- Produces: `openTab(ctx, { project_id, machine_id?, name? })` → `{ tab_id, name, project_id, machine_id, tmux_session, created }`; `startAgent(ctx, { project_id, machine_id?, account_id, prompt, task_id?, tab_name? })`; `listProjects` items `{ id, key, name, status, description, machines: Array<{ machine_id, machine_name, cwd }> }`; `listTabs` items gain `machine_id`; `find` matches project keys too and reports `machine_id: null` for projects.

- [ ] **Step 1: Update the control tests**

`apps/server/src/control/terminals.test.ts` (~line 29): `const project = { id: 'p1', name: 'app', status: 'active', owner_id: 'u1', key: 'APP', next_task_number: 1 };` and add to its repos stub `projectMachines: { find: vi.fn(async (p: string, m: string) => (p === 'p1' && m === 'm1' ? { id: 'l1', project_id: 'p1', machine_id: 'm1', cwd: '/home/u/app', position: 0, created_at: '' } : undefined)), listByProject: vi.fn(async () => [{ id: 'l1', project_id: 'p1', machine_id: 'm1', cwd: '/home/u/app', position: 0, created_at: '' }]) }`; tab fixtures gain `machine_id: 'm1'`; `tabs.create` expectations become `('p1', 'm1', name, …)`. Add one test:

```ts
  it('openTab needs machine_id when the project has two machines and reports it in the result', async () => {
    const { c, repos } = ctx();
    repos.projectMachines.listByProject.mockResolvedValueOnce([
      { id: 'l1', project_id: 'p1', machine_id: 'm1', cwd: '/a', position: 0, created_at: '' },
      { id: 'l2', project_id: 'p1', machine_id: 'm2', cwd: '/b', position: 1, created_at: '' },
    ]);
    await expect(openTab(c, { project_id: 'p1' })).rejects.toMatchObject({ code: 'MACHINE_REQUIRED' });
    const r = await openTab(c, { project_id: 'p1', machine_id: 'm1' });
    expect(r.machine_id).toBe('m1');
  });
```

(adapt `ctx()` / `repos` to that file's own builder names; `m2` must exist in its machines stub with `owner_id: 'u1'`.)

`apps/server/src/control/agents.test.ts` (~lines 18–20, 27, 45–46): project factory becomes `(over: Partial<Project> & { id: string }) => ({ owner_id: 'u1', key: over.id.toUpperCase(), next_task_number: 1, name: over.id, status: 'active', description: null, last_terminal_at: null, created_at: '', ...over })`; `projects = [project({ id: 'p1' }), project({ id: 'p2' }), project({ id: 'px', owner_id: 'u2' })]`; add `const links = [{ project_id: 'p1', machine_id: 'm1', cwd: '/src/p1' }, { project_id: 'p2', machine_id: 'm2', cwd: '/src/p2' }, { project_id: 'px', machine_id: 'mx', cwd: '/x' }].map((l, i) => ({ id: `l${i}`, position: 0, created_at: '', ...l }));` and in `ctx()` repos: `projectMachines: { find: vi.fn(async (p: string, m: string) => links.find((l) => l.project_id === p && l.machine_id === m)), listByProject: vi.fn(async (p: string) => links.filter((l) => l.project_id === p)) }`. Where the tests assert `openTab` was called, expect `{ project_id: 'p1', machine_id: 'm1', name: … }`.

`apps/server/src/control/inventory.test.ts` (~lines 18–35, 47–52): project factory as above; `projects = [project({ id: 'p1', name: 'Hub Community' }), project({ id: 'p2', name: 'termhub' }), project({ id: 'p3', name: 'Velho', status: 'archived' }), project({ id: 'px', name: 'Hub Community', owner_id: 'u2' })]`; `links = [l('p1','m1'), l('p2','m2'), l('p3','m1'), l('px','mx')]` with `l = (p, m) => ({ id: p + m, project_id: p, machine_id: m, cwd: '/src/' + p, position: 0, created_at: '' })`; tabs gain `machine_id: 'm1'`; repos: `projects.list` filters by `f.owner == null || p.owner_id === f.owner` and `!f.machine_id || links.some((l) => l.project_id === p.id && l.machine_id === f.machine_id)`; add `projectMachines: { listByProjects: vi.fn(async (ids: string[]) => links.filter((l) => ids.includes(l.project_id))), listByProject: vi.fn(async (p: string) => links.filter((l) => l.project_id === p)), find: vi.fn(async (p: string, m: string) => links.find((l) => l.project_id === p && l.machine_id === m)) }`. Update expectations: `listProjects` items now carry `key` and `machines: [{ machine_id: 'm1', machine_name: 'MacBook Pro M4', cwd: '/src/p1' }]` instead of `machine_id`/`cwd`/`machine_name`; `find` project matches have `machine_id: null, machine_name: null`, and add `expect((await find(c, { query: 'p2' })).matches[0]).toMatchObject({ kind: 'project', id: 'p2' })` (matched by key).

`apps/server/src/mcp/terminals.e2e.test.ts`, `gate.e2e.test.ts`, `start-agent.e2e.test.ts`: the `project` constant drops `cwd`/`machine_id` and gains `key: 'APP', next_task_number: 1` (keep `owner_id: 'u1'`); add `projectMachines: { find: vi.fn(async () => ({ id: 'l1', project_id: 'p1', machine_id: 'm1', cwd: <the cwd the test used>, position: 0, created_at: '' })), listByProject: vi.fn(async () => [<same link>]) }` to each repos stub; tab fixtures gain `machine_id: 'm1'`. `tmux.ensure` expectations keep the same `cwd`.

- [ ] **Step 2: Run to see them fail**

```bash
th 'npx vitest run apps/server/src/control apps/server/src/mcp'
```

Expected: FAIL.

- [ ] **Step 3: `control/terminals.ts`**

Remove `Project` from the types import. Replace `terminal()` and the `project.cwd` uses:

```ts
/** A terminal tab with a session name, on a machine that can answer right now. */
async function terminal(ctx: ControlContext, tabId: string): Promise<{ tab: Tab; machine: Machine; cwd: string; session: string }> {
  const { tab, machine, cwd } = await ctx.scoped.tab(tabId);
  assertTerminal(tab);
  assertReady(machine);
  return { tab, machine, cwd, session: tab.tmux_session };
}
```

In `sendInput`, `sendKey`, `runCommand`: `const { tab, machine, cwd, session } = await terminal(ctx, input.tab_id);` and `ensureSession(machine, session, cwd)`.

`openTab`:

```ts
/** Opens a tab and starts its tmux session detached, so it is alive without a browser attached. */
export async function openTab(
  ctx: ControlContext,
  input: { project_id: string; machine_id?: string; name?: string },
): Promise<{ tab_id: string; name: string; project_id: string; machine_id: string; tmux_session: string | null; created: boolean }> {
  const { project, machine, link } = await ctx.scoped.projectMachineFor(input.project_id, input.machine_id);
  assertReady(machine);
  // ... token limit unchanged ...
  const existing = await ctx.repos.tabs.listByProject(project.id);
  const name = input.name?.trim() || nextTerminalName(existing.map((t) => t.name));
  const tab = await ctx.repos.tabs.create(project.id, machine.id, name, { created_by_token_id: ctx.token?.id ?? null });
  try {
    const { created } = await ensureSession(machine, tab.tmux_session as string, link.cwd);
    return { tab_id: tab.id, name: tab.name, project_id: project.id, machine_id: machine.id, tmux_session: tab.tmux_session, created };
  } catch (e) {
    // unchanged
  }
}
```

- [ ] **Step 4: `control/agents.ts`**

```ts
  input: { project_id: string; machine_id?: string; account_id: string; prompt: string; task_id?: string; tab_name?: string },
  // ...
  const { project, machine } = await ctx.scoped.projectMachineFor(input.project_id, input.machine_id);
  // ...
  const tab = await openTab(ctx, { project_id: project.id, machine_id: machine.id, name });
```

- [ ] **Step 5: `control/inventory.ts`**

```ts
export async function listProjects(ctx: ControlContext, input: { machine_id?: string; include_archived?: boolean }) {
  if (input.machine_id) await ctx.scoped.machine(input.machine_id);
  const [projects, names] = await Promise.all([ctx.repos.projects.list({ machine_id: input.machine_id, owner: ctx.scope.ownerId }), machineNames(ctx)]);
  const links = await ctx.repos.projectMachines.listByProjects(projects.map((p) => p.id));
  return {
    projects: projects
      .filter((p) => input.include_archived || p.status !== 'archived')
      .map((p) => ({
        id: p.id,
        key: p.key,
        name: p.name,
        status: p.status,
        description: p.description,
        machines: links.filter((l) => l.project_id === p.id).map((l) => ({ machine_id: l.machine_id, machine_name: names.get(l.machine_id) ?? null, cwd: l.cwd })),
      })),
  };
}
```

`TabSummary` gains `machine_id: string;`. `listTabs`:

```ts
export async function listTabs(ctx: ControlContext, input: { project_id?: string; machine_id?: string }): Promise<{ tabs: TabSummary[] }> {
  let tabs: Tab[];
  const machines = new Map<string, Machine>();
  if (input.project_id) {
    const r = await ctx.scoped.projectMachines(input.project_id);
    for (const { machine } of r.machines) machines.set(machine.id, machine);
    tabs = (await ctx.repos.tabs.listByProject(r.project.id)).filter((t) => machines.has(t.machine_id));
  } else if (input.machine_id) {
    const machine = await ctx.scoped.machine(input.machine_id);
    machines.set(machine.id, machine);
    const projectIds = (await ctx.repos.projects.list({ machine_id: machine.id, owner: ctx.scope.ownerId })).map((p) => p.id);
    tabs = await ctx.repos.tabs.listByProjectsOnMachine(projectIds, machine.id);
  } else {
    throw new ControlError('BAD_REQUEST', 'Informe project_id ou machine_id');
  }

  // One probe per machine. An offline agent's listTmuxSessions answers an empty set (not an error): that would read every tab as dead.
  const sessions = new Map<string, Set<string> | null>();
  for (const [id, machine] of machines) {
    sessions.set(id, machine.type === 'agent' && !agents.isOnline(machine.id) ? null : await listTmuxSessions(machine).catch(() => null));
  }
  const byTab = new Map<string, { id: string; title: string; status: string }>();
  for (const pid of new Set(tabs.map((t) => t.project_id))) {
    for (const t of (await ctx.repos.tasks.listByProject(pid)).flatMap((x) => [x, ...(x.subtasks ?? [])])) if (t.tab_id) byTab.set(t.tab_id, { id: t.id, title: t.title, status: t.status });
  }
  return {
    tabs: tabs.map((t) => {
      const s = sessions.get(t.machine_id) ?? null;
      const alive = t.kind !== 'terminal' || !t.tmux_session || s === null ? null : s.has(t.tmux_session);
      return { id: t.id, name: t.name, kind: t.kind, project_id: t.project_id, machine_id: t.machine_id, alive, state: t.state, state_text: t.state_text, state_at: t.state_at, task: byTab.get(t.id) ?? null };
    }),
  };
}
```

Add `Tab` to the types import. In `find`, the project line becomes:

```ts
  if (kinds.has('project') && canProjects) for (const p of await ctx.repos.projects.list({ owner: ctx.scope.ownerId })) add('project', p.id, p.name, null, p.key);
```

and `add` gains an optional `key?: string`: `const s = Math.max(score(name, query), key && normalizeName(key) === query ? 3 : 0);`.

- [ ] **Step 6: `mcp/tools.ts`**

```ts
  {
    name: 'list_projects',
    description: 'List projects: id, key (used in card numbers and URLs), name, status and the machines each one is linked to with the working directory on each. Archived ones are hidden unless include_archived; machine_id keeps only projects linked to that machine.',
    // input/run unchanged
  },
  {
    name: 'open_tab',
    description: 'Open a terminal tab in a project and start its tmux session detached, so it keeps running with no browser attached. machine_id picks which linked machine; it is required when the project is linked to more than one (list_projects shows them).',
    scope: 'terminals', resource: 'terminals', action: 'write',
    input: { project_id: id, machine_id: id.optional(), name: z.string().trim().min(1).max(60).optional() },
    run: (ctx, a) => openTab(ctx, a as { project_id: string; machine_id?: string; name?: string }),
  },
  // start_agent: append to the description " machine_id picks the linked machine (required when the project has several).",
  // input gains machine_id: id.optional(), run casts include machine_id?: string
```

- [ ] **Step 7: Run the control and MCP tests**

```bash
th 'npx vitest run apps/server/src/control apps/server/src/mcp'
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/server/src/control apps/server/src/mcp
git commit -m "MCP: open tabs on a chosen linked machine, list projects with their machines"
```

---

### Task 8: Dashboard, office, machine deletion, and the rest of the server test suite

**Files:**
- Modify: `apps/server/src/routes/dashboard.ts`
- Modify: `apps/server/src/routes/office.ts:26-30`
- Modify: `apps/server/src/routes/machines.ts:141-150`
- Tests: `apps/server/src/routes/office.test.ts`, `apps/server/src/office/snapshot.test.ts`, `apps/server/src/routes/machines.test.ts`, `apps/server/src/routes/tasks.test.ts`, `apps/server/src/control/tasks.test.ts`, `apps/server/src/chat/service.test.ts`, `apps/server/src/db/repositories/chat-actions-view.test.ts`, `apps/server/src/routes/chat.test.ts`, `apps/server/src/db/repositories/chat.db.test.ts`

**Interfaces:**
- Produces: `GET /dashboard` items `{ project, machines: Machine[], doing, open_tasks }` (was `machine: Machine | null`).

- [ ] **Step 1: Update the tests**

`routes/office.test.ts`: stub `tabs: { listByProjectsOnMachine: vi.fn(async () => [...same tab..., machine_id: 'm1']) }` instead of `listByProjects`; project stub drops `machine_id` (add `owner_id: 'u1'`). Add: `expect(repos.tabs.listByProjectsOnMachine).toHaveBeenCalledWith(['p1'], 'm1')` in the first test.

`office/snapshot.test.ts`: `project()` factory drops `machine_id: 'm1'` (add `owner_id: 'u1', key: id.toUpperCase()`); `tab()` gains `machine_id: 'm1'`.

`routes/machines.test.ts` `buildApp`: replace `projects: { list: async () => [] }` with `projectMachines: { listByMachine: async () => [] }` only if the route needs it (it will not after Step 3 — remove the `projects` stub entirely); add a test:

```ts
  it('deletes a machine that still has linked projects (the links go, the projects stay)', async () => {
    store.m1 = makeMachine({ id: 'm1', type: 'agent' });
    ({ app } = buildApp(store));
    const res = await app.inject({ method: 'DELETE', url: '/api/machines/m1' });
    expect(res.statusCode).toBe(200);
    expect(store.m1).toBeUndefined();
  });
```

`routes/tasks.test.ts` and `control/tasks.test.ts`: `projects.findById` stubs return `{ id: 'p1', owner_id: 'u1' }`; drop the `machines` stub where it only served the project lookup.

`chat/service.test.ts:84`, `db/repositories/chat-actions-view.test.ts:31,38`, `routes/chat.test.ts` project fixtures: replace `machine_id: 'm1'` with `owner_id: OWNER-or-'u1'` (these only go through `findByIdsForOwner`, so the field is cosmetic — keep the objects type-correct).

`db/repositories/chat.db.test.ts`: any `db.project.create` there: drop `machineId`/`cwd`, add a unique `key` (same pattern as Task 3).

- [ ] **Step 2: Run the whole server suite to see what fails**

```bash
thdb 'npx vitest run --root apps/server'
```

Expected: FAIL only in `dashboard`/`office`/`machines` (the code changes below) — anything else failing is a fixture missed in Steps 1 of Tasks 6–8; fix those fixtures.

- [ ] **Step 3: Code**

`routes/dashboard.ts`:

```ts
    const [projects, machines, doing, openCounts] = await Promise.all([
      repos.projects.list({ status: 'active', owner }),
      repos.machines.list(owner),
      repos.tasks.listDoing(owner),
      repos.tasks.openCountByProject(),
    ]);
    const links = await repos.projectMachines.listByProjects(projects.map((p) => p.id));
    const machineById = new Map(machines.map((m) => [m.id, m]));
    const items = projects
      .map((p) => ({
        project: p,
        machines: links.filter((l) => l.project_id === p.id).map((l) => machineById.get(l.machine_id)).filter((m): m is NonNullable<typeof m> => !!m),
        doing: doing.filter((t) => t.project_id === p.id),
        open_tasks: openCounts[p.id] ?? 0,
      }))
```

Update the file's doc comment: "active projects + their machines + tasks in progress + last terminal".

`routes/office.ts`: `repos.tabs.listByProjects(projectIds)` → `repos.tabs.listByProjectsOnMachine(projectIds, machine.id)`. Update the doc comment: "a machine's floor: the projects linked to it, and their tabs that run on it".

`routes/machines.ts` delete: remove the `projects.list` check and its `throw badRequest('Remova os projetos…')` — the DB cascade removes the links and the tabs; projects stay. (If `badRequest` becomes unused in the file, drop the import.)

- [ ] **Step 4: Full server suite and typecheck**

```bash
thdb 'npx vitest run --root apps/server && npm run typecheck -w @termhub/server'; rm -rf .npm
```

Expected: all PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add apps/server
git commit -m "Dashboard and office follow project machine links; machine delete keeps projects"
```

---

### Task 9: Web model, API client, data provider, key helper

**Files:**
- Modify: `apps/web/src/lib/types.ts` (`Project` ~118–130, `ProjectInput` 132, `Tab`, `DashboardItem` 256)
- Modify: `apps/web/src/lib/api.ts` (`projects` block ~128–137)
- Modify: `apps/web/src/lib/data.tsx`
- Create: `apps/web/src/lib/project-key.ts`, `apps/web/src/lib/project-key.test.ts`

**Interfaces:**
- Produces (types.ts):
  ```ts
  interface ProjectMachineLink { machine_id: string; cwd: string; position: number }
  interface Project { id; owner_id: string | null; key: string; next_task_number: number; name; status; description; last_terminal_at; created_at; machines: ProjectMachineLink[]; open_tasks?: number }
  interface ProjectInput { name?: string; key?: string; description?: string | null; status?: ProjectStatus; machine_id?: string; cwd?: string; create_dir?: boolean }
  interface Tab { ...; machine_id: string }
  interface DashboardItem { project: Project; machines: Machine[]; doing: Task[]; open_tasks: number }
  ```
- Produces (api.ts `api.projects`): `keyAvailable(key) → { available, reason? }`, `machines(id) → { machines: Array<ProjectMachineLink & { machine: { id, name, type } }> }`, `linkMachine(id, { machine_id, cwd, create_dir? }) → { link }`, `updateMachine(id, machineId, { cwd, create_dir? }) → { link }`, `unlinkMachine(id, machineId) → { ok, closed_tabs }`, `createTab(id, { name?, kind?, simulator_udid?, machine_id? })`.
- Produces (data.tsx): `projects` no longer filtered by visible machines; `createProject(input: ProjectInput)`, `updateProject(id, input)`, `linkMachine(projectId, input)`, `updateProjectMachine(projectId, machineId, cwd, createDir)`, `unlinkMachine(projectId, machineId) → Promise<number>` (closed tabs), `machinesOf(project): Machine[]` helper.
- Produces (project-key.ts): same `isValidProjectKey` / `suggestProjectKey` as the server (the web cannot import server code).

- [ ] **Step 1: Key helper test and implementation (copy of Task 2, web side)**

`apps/web/src/lib/project-key.test.ts`: the same test file as Task 2 Step 1 with the import `from './project-key'` (no `.js`). `apps/web/src/lib/project-key.ts`: the same code as Task 2 Step 3.

```bash
th 'npx vitest run --root apps/web src/lib/project-key.test.ts'
```

Expected: PASS.

- [ ] **Step 2: Types**

In `apps/web/src/lib/types.ts` replace `Project` and `ProjectInput`:

```ts
/** One machine a project is linked to and its working directory there. */
export interface ProjectMachineLink {
  machine_id: string;
  cwd: string;
  position: number;
}

export interface Project {
  id: string;
  /** null = orphan (visible only to admins viewing "all") */
  owner_id: string | null;
  /** short key: URLs and card numbers (TERMHUB-42); unique, never changes */
  key: string;
  next_task_number: number;
  name: string;
  status: ProjectStatus;
  description: string | null;
  last_terminal_at: string | null;
  created_at: string;
  /** machines the project runs on; empty = board and notes only */
  machines: ProjectMachineLink[];
  /** tasks em "todo" + "doing" (vem na listagem) */
  open_tasks?: number;
}

/** Corpo de criação/edição. `machine_id` + `cwd` juntos criam o primeiro vínculo; `create_dir` cria a pasta na máquina. */
export interface ProjectInput {
  name?: string;
  key?: string;
  description?: string | null;
  status?: ProjectStatus;
  machine_id?: string;
  cwd?: string;
  create_dir?: boolean;
}
```

`Tab`: add `machine_id: string;` after `project_id`. `DashboardItem`: `machines: Machine[];` replaces `machine: Machine | null;`.

- [ ] **Step 3: API client**

Replace the `projects` block in `apps/web/src/lib/api.ts`:

```ts
  projects: {
    list: () => request<{ projects: Project[] }>('GET', '/projects'),
    get: (id: string) => request<{ project: Project }>('GET', `/projects/${id}`),
    keyAvailable: (key: string) => request<{ available: boolean; reason?: 'invalid' | 'taken' }>('GET', `/projects/key-available?key=${encodeURIComponent(key)}`),
    create: (input: ProjectInput) => request<{ project: Project }>('POST', '/projects', input),
    update: (id: string, input: ProjectInput) => request<{ project: Project }>('PATCH', `/projects/${id}`, input),
    remove: (id: string) => request<{ ok: true }>('DELETE', `/projects/${id}`),
    machines: (id: string) => request<{ machines: Array<ProjectMachineLink & { machine: { id: string; name: string; type: MachineType } }> }>('GET', `/projects/${id}/machines`),
    linkMachine: (id: string, input: { machine_id: string; cwd: string; create_dir?: boolean }) => request<{ link: ProjectMachineLink }>('POST', `/projects/${id}/machines`, input),
    updateMachine: (id: string, machineId: string, input: { cwd: string; create_dir?: boolean }) => request<{ link: ProjectMachineLink }>('PATCH', `/projects/${id}/machines/${machineId}`, input),
    unlinkMachine: (id: string, machineId: string) => request<{ ok: true; closed_tabs: number }>('DELETE', `/projects/${id}/machines/${machineId}`),
    tabs: (id: string) => request<{ reachable: boolean; tabs: Tab[] }>('GET', `/projects/${id}/tabs`),
    createTab: (id: string, input: { name?: string; kind?: TabKind; simulator_udid?: string; machine_id?: string } = {}) =>
      request<{ tab: Tab }>('POST', `/projects/${id}/tabs`, input),
  },
```

Add `ProjectMachineLink` and `MachineType` to the type imports at the top of `api.ts` if not already there.

- [ ] **Step 4: Data provider**

In `apps/web/src/lib/data.tsx`:

- `DataState`: change the `projects` doc to `/** every project of the scope (machines a browser hides do not hide projects) */`; add after `deleteProject`:

```ts
  linkMachine: (projectId: string, input: { machine_id: string; cwd: string; create_dir?: boolean }) => Promise<void>;
  updateProjectMachine: (projectId: string, machineId: string, cwd: string, createDir: boolean) => Promise<void>;
  /** removes the link; resolves with how many tabs were closed */
  unlinkMachine: (projectId: string, machineId: string) => Promise<number>;
  /** the visible Machine records a project is linked to, in link order */
  machinesOf: (project: Project) => Machine[];
```

- In the `useMemo` that builds `{ machines, projects, hiddenLocal }`: `projects: allProjects,` (drop the `ids.has(p.machine_id)` filter and the now-unused `ids`).
- In the `value` object add:

```ts
      async linkMachine(projectId, input) {
        const { link } = await api.projects.linkMachine(projectId, input);
        setProjects((p) => p.map((x) => (x.id === projectId ? { ...x, machines: [...x.machines, link] } : x)));
      },
      async updateProjectMachine(projectId, machineId, cwd, createDir) {
        const { link } = await api.projects.updateMachine(projectId, machineId, { cwd, create_dir: createDir });
        setProjects((p) => p.map((x) => (x.id === projectId ? { ...x, machines: x.machines.map((l) => (l.machine_id === machineId ? link : l)) } : x)));
      },
      async unlinkMachine(projectId, machineId) {
        const { closed_tabs } = await api.projects.unlinkMachine(projectId, machineId);
        setProjects((p) => p.map((x) => (x.id === projectId ? { ...x, machines: x.machines.filter((l) => l.machine_id !== machineId) } : x)));
        return closed_tabs;
      },
      machinesOf(project) {
        return project.machines.map((l) => machines.find((m) => m.id === l.machine_id)).filter((m): m is Machine => !!m);
      },
```

- [ ] **Step 5: Typecheck the web (expect component errors)**

```bash
th 'npm run typecheck -w @termhub/web'; rm -rf .npm
```

Expected: errors only in components/pages that still read `project.machine_id` / `project.cwd` / `item.machine` (Sidebar, ProjectForm, ProjectSettings, SetupForm, TerminalsView, ProjectPage, ProjectsByMachine, OfficePage, office/harness, tests). Tasks 10–13 fix them.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/lib
git commit -m "Web model: project key and machine links, tab machine_id, API client"
```

---

### Task 10: Sidebar with Projects and Machines sections; project form with key and optional machine

**Files:**
- Modify: `apps/web/src/components/Sidebar.tsx`
- Modify: `apps/web/src/components/ProjectForm.tsx`
- Test: `apps/web/src/components/ProjectForm.test.tsx` (new)

**Interfaces:**
- Consumes: `useData().{projects, machines, machinesOf, createProject}`, `api.projects.keyAvailable`, `suggestProjectKey`, `isValidProjectKey`, `DirectoryBrowser({ machineId, initialPath, onSelect, onClose })`, `Modal`.
- Produces: `ProjectForm({ open, onClose, machineId?: string })` — `machineId` preselects the optional machine block.

- [ ] **Step 1: ProjectForm test**

`apps/web/src/components/ProjectForm.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { createProject, keyAvailable } = vi.hoisted(() => ({ createProject: vi.fn(), keyAvailable: vi.fn() }));
vi.mock('../lib/data', () => ({ useData: () => ({ createProject, machines: [{ id: 'm1', name: 'mac', type: 'agent', capabilities: [] }] }) }));
vi.mock('../lib/api', async (orig) => ({ ...(await orig<typeof import('../lib/api')>()), api: { projects: { keyAvailable } } }));

import { ProjectForm } from './ProjectForm';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const mount = (machineId?: string) => render(
  <MemoryRouter>
    <ProjectForm open onClose={() => {}} machineId={machineId} />
  </MemoryRouter>,
);

describe('ProjectForm', () => {
  it('suggests a key from the name and checks its availability', async () => {
    keyAvailable.mockResolvedValue({ available: true });
    mount();
    fireEvent.change(screen.getByLabelText('Nome'), { target: { value: 'Hub Community' } });
    expect((screen.getByLabelText('Chave') as HTMLInputElement).value).toBe('HC');
    await waitFor(() => expect(keyAvailable).toHaveBeenCalledWith('HC'));
    await screen.findByText('disponível');
  });

  it('shows "já em uso" and blocks submit for a taken key; a hand-edited key is kept', async () => {
    keyAvailable.mockResolvedValue({ available: false, reason: 'taken' });
    mount();
    fireEvent.change(screen.getByLabelText('Nome'), { target: { value: 'Hub Community' } });
    fireEvent.change(screen.getByLabelText('Chave'), { target: { value: 'HUB' } });
    fireEvent.change(screen.getByLabelText('Nome'), { target: { value: 'Hub Community 2' } });
    expect((screen.getByLabelText('Chave') as HTMLInputElement).value).toBe('HUB');
    await screen.findByText('já em uso');
    expect(screen.getByRole('button', { name: 'Criar' })).toBeDisabled();
  });

  it('creates without a machine when none is chosen, and with machine + cwd when one is', async () => {
    keyAvailable.mockResolvedValue({ available: true });
    createProject.mockResolvedValue({ id: 'new' });
    mount();
    fireEvent.change(screen.getByLabelText('Nome'), { target: { value: 'Novo' } });
    await screen.findByText('disponível');
    fireEvent.click(screen.getByRole('button', { name: 'Criar' }));
    await waitFor(() => expect(createProject).toHaveBeenCalledWith({ name: 'Novo', key: 'NOV', description: null }));

    cleanup();
    mount('m1');
    fireEvent.change(screen.getByLabelText('Nome'), { target: { value: 'Outro' } });
    fireEvent.change(screen.getByLabelText('Diretório (caminho absoluto na máquina)'), { target: { value: '/src/outro' } });
    await screen.findByText('disponível');
    fireEvent.click(screen.getByRole('button', { name: 'Criar' }));
    await waitFor(() => expect(createProject).toHaveBeenLastCalledWith({ name: 'Outro', key: 'OUT', description: null, machine_id: 'm1', cwd: '/src/outro', create_dir: true }));
  });
});
```

```bash
th 'npx vitest run --root apps/web src/components/ProjectForm.test.tsx'
```

Expected: FAIL (no "Chave" field; `machineId` required).

- [ ] **Step 2: Rewrite `ProjectForm.tsx`**

```tsx
import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Modal } from './Modal';
import { DirectoryBrowser } from './DirectoryBrowser';
import { useData } from '../lib/data';
import { api, ApiError } from '../lib/api';
import { isValidProjectKey, suggestProjectKey } from '../lib/project-key';

interface Props {
  open: boolean;
  onClose: () => void;
  /** preselects the machine block (the "+" on a machine row) */
  machineId?: string;
}

type KeyState = { kind: 'idle' } | { kind: 'checking' } | { kind: 'ok' } | { kind: 'taken' } | { kind: 'invalid' };

export function ProjectForm({ open, onClose, machineId }: Props) {
  const { createProject, machines } = useData();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [key, setKey] = useState('');
  const [keyEdited, setKeyEdited] = useState(false);
  const [keyState, setKeyState] = useState<KeyState>({ kind: 'idle' });
  const [description, setDescription] = useState('');
  const [machine, setMachine] = useState<string>(machineId ?? '');
  const [cwd, setCwd] = useState('');
  const [createDir, setCreateDir] = useState(true);
  const [browsing, setBrowsing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // suggestion follows the name until the person edits the key by hand
  const onName = (v: string) => {
    setName(v);
    if (!keyEdited) setKey(v.trim() ? suggestProjectKey(v) : '');
  };

  // availability: debounced, invalid keys never hit the server
  useEffect(() => {
    if (!key) return setKeyState({ kind: 'idle' });
    if (!isValidProjectKey(key)) return setKeyState({ kind: 'invalid' });
    setKeyState({ kind: 'checking' });
    let cancelled = false;
    const t = setTimeout(() => {
      api.projects
        .keyAvailable(key)
        .then((r) => !cancelled && setKeyState(r.available ? { kind: 'ok' } : { kind: r.reason === 'invalid' ? 'invalid' : 'taken' }))
        .catch(() => !cancelled && setKeyState({ kind: 'idle' }));
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [key]);

  const canSubmit = !busy && !!name.trim() && keyState.kind === 'ok' && (!machine || !!cwd.trim());

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const project = await createProject({
        name: name.trim(),
        key,
        description: description || null,
        ...(machine ? { machine_id: machine, cwd, create_dir: createDir } : {}),
      });
      onClose();
      navigate(`/projects/${project.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Erro ao criar projeto');
    } finally {
      setBusy(false);
    }
  };

  const keyHint: Record<KeyState['kind'], { text: string; cls: string }> = {
    idle: { text: '', cls: '' },
    checking: { text: 'verificando…', cls: 'text-fg-dim' },
    ok: { text: 'disponível', cls: 'text-ok' },
    taken: { text: 'já em uso', cls: 'text-danger' },
    invalid: { text: 'formato inválido', cls: 'text-danger' },
  };

  return (
    <Modal title="Novo projeto" open={open} onClose={onClose} width={browsing ? 'max-w-2xl' : 'max-w-md'}>
      <form onSubmit={submit} className="space-y-3">
        <div>
          <label className="label" htmlFor="project-name">Nome</label>
          <input id="project-name" className="input" value={name} onChange={(e) => onName(e.target.value)} required autoFocus placeholder="ex.: meu-app" />
        </div>
        <div>
          <label className="label" htmlFor="project-key">Chave</label>
          <div className="flex items-center gap-2">
            <input
              id="project-key"
              className="input w-40 font-mono uppercase"
              value={key}
              onChange={(e) => {
                setKeyEdited(true);
                setKey(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10));
              }}
              required
              placeholder="APP"
            />
            <span className={`text-xs ${keyHint[keyState.kind].cls}`}>{keyHint[keyState.kind].text}</span>
          </div>
          <p className="mt-1 text-xs text-fg-dim">2 a 10 letras ou dígitos, começando com letra. Aparece nas URLs e nos números dos cards (ex.: {key || 'APP'}-12). Não muda depois.</p>
        </div>
        <div>
          <label className="label" htmlFor="project-machine">Máquina (opcional)</label>
          <select id="project-machine" className="input" value={machine} onChange={(e) => setMachine(e.target.value)}>
            <option value="">Sem máquina por enquanto</option>
            {machines.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
          {!machine && <p className="mt-1 text-xs text-fg-dim">Sem máquina o projeto nasce só com quadro e notas; vincule uma depois em Setup → Máquinas.</p>}
        </div>
        {machine && (
          <div>
            <label className="label" htmlFor="project-cwd">Diretório (caminho absoluto na máquina)</label>
            <div className="flex gap-2">
              <input id="project-cwd" className="input font-mono" value={cwd} onChange={(e) => setCwd(e.target.value)} required placeholder="/home/pedro/projetos/meu-app" />
              <button type="button" className="btn-ghost shrink-0 border border-line" onClick={() => setBrowsing((b) => !b)} title="Listar discos e pastas da máquina">
                {browsing ? 'Ocultar' : 'Procurar…'}
              </button>
            </div>
            <label className="mt-1.5 flex items-center gap-1.5 text-xs text-fg-muted">
              <input type="checkbox" checked={createDir} onChange={(e) => setCreateDir(e.target.checked)} /> criar a pasta na máquina se não existir
            </label>
            {browsing && (
              <div className="mt-2">
                <DirectoryBrowser
                  machineId={machine}
                  initialPath={cwd}
                  onSelect={(path) => {
                    setCwd(path);
                    if (!name) onName(path.split('/').filter(Boolean).pop() ?? '');
                    setBrowsing(false);
                  }}
                  onClose={() => setBrowsing(false)}
                />
              </div>
            )}
          </div>
        )}
        <div>
          <label className="label" htmlFor="project-description">Descrição (opcional)</label>
          <textarea id="project-description" className="input" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>
        {error && <p className="text-sm text-danger">{error}</p>}
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" className="btn-primary" disabled={!canSubmit}>
            Criar
          </button>
        </div>
      </form>
    </Modal>
  );
}
```

- [ ] **Step 3: Run the form test**

```bash
th 'npx vitest run --root apps/web src/components/ProjectForm.test.tsx'
```

Expected: PASS.

- [ ] **Step 4: Sidebar sections**

In `apps/web/src/components/Sidebar.tsx`:

1. State: `const [projectForm, setProjectForm] = useState<{ open: boolean; machineId?: string }>({ open: false });`. Get `machinesOf` from `useData()`.
2. Header: next to `+ máquina` add (guarded by `can('projects', 'create')`):
   ```tsx
   <button className="btn-ghost px-2 py-1 text-xs" title="Novo projeto" onClick={() => setProjectForm({ open: true })}>+ projeto</button>
   ```
3. Replace the `<nav>` body with two sections. **Projetos** first:

```tsx
        <p className="px-3 pb-1 pt-1 text-[10px] uppercase tracking-wide text-fg-dim">Projetos</p>
        {!loading && visibleProjects.length === 0 && (
          <button className="px-3 py-1 text-xs text-fg-dim hover:text-fg" onClick={() => setProjectForm({ open: true })}>+ novo projeto</button>
        )}
        <ul>
          {visibleProjects.map((p) => (
            <li key={p.id} className="group/p flex items-center rounded-r hover:bg-bg-3">
              <NavLink
                to={`/projects/${p.id}`}
                className={({ isActive }) => `flex min-w-0 flex-1 items-center gap-2 rounded-r px-3 py-1 text-sm ${isActive ? 'bg-accent/15 text-fg' : 'text-fg-muted group-hover/p:text-fg'}`}
                title={machinesOf(p).map((m) => m.name).join(', ') || 'sem máquina vinculada'}
              >
                <span className="shrink-0 font-mono text-[10px] text-fg-dim">{p.key}</span>
                <span className={`truncate ${p.status !== 'active' ? 'opacity-60' : ''}`}>{p.name}</span>
                {/* the waiting dot, open_tasks badge, paused/archived labels: unchanged from the old project row */}
              </NavLink>
              {/* the ✎ / ✕ hover actions: unchanged */}
            </li>
          ))}
        </ul>
```

   Then **Máquinas**: the existing machine rows, minus the nested `<ul>` of projects and minus the "+ novo projeto" button under an empty machine; the per-machine `+` button stays and calls `setProjectForm({ open: true, machineId: m.id })`; put `<p className="mt-3 px-3 pb-1 text-[10px] uppercase tracking-wide text-fg-dim">Máquinas</p>` above them. Remove the `collapsed` state and the ▶/▼ toggle (nothing to expand anymore). Keep `hiddenLocal` and `showArchived` blocks.
4. Render: `{projectForm.open && <ProjectForm open onClose={() => setProjectForm({ open: false })} machineId={projectForm.machineId} />}`.
5. Delete-project confirm text: "Remover <strong>{name}</strong>? As tarefas, notas e tickets do projeto são apagados e as sessões tmux das tabs são encerradas nas máquinas vinculadas. As pastas nas máquinas continuam intactas." (drop the `cwd` reference).
6. Delete-machine confirm text: "Excluir <strong>{name}</strong>? Os projetos vinculados continuam existindo; só o vínculo e as tabs abertas nesta máquina são removidos."

- [ ] **Step 5: Typecheck and existing web tests**

```bash
th 'npm run typecheck -w @termhub/web 2>&1 | grep -v "ProjectSettings\|SetupForm\|TerminalsView\|ProjectPage\|ProjectsByMachine\|OfficePage\|harness\|NeedsYouList.test"'; rm -rf .npm
```

Expected: no errors in `Sidebar.tsx` / `ProjectForm.tsx` (the filtered files are Tasks 11–13).

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/Sidebar.tsx apps/web/src/components/ProjectForm.tsx apps/web/src/components/ProjectForm.test.tsx
git commit -m "Web: projects section in the sidebar, project form with key and optional machine"
```

---

### Task 11: Project settings — machine links block

**Files:**
- Create: `apps/web/src/components/ProjectMachines.tsx`
- Modify: `apps/web/src/components/ProjectSettings.tsx`
- Modify: `apps/web/src/components/SetupForm.tsx:47-51, 240`
- Test: `apps/web/src/components/ProjectMachines.test.tsx` (new)

**Interfaces:**
- Consumes: `useData().{machines, machinesOf, linkMachine, updateProjectMachine, unlinkMachine}`, `DirectoryBrowser`, `ConfirmDialog`.
- Produces: `ProjectMachines({ project: Project })`.

- [ ] **Step 1: Test**

`apps/web/src/components/ProjectMachines.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Machine, Project } from '../lib/types';

const { linkMachine, updateProjectMachine, unlinkMachine } = vi.hoisted(() => ({ linkMachine: vi.fn(), updateProjectMachine: vi.fn(), unlinkMachine: vi.fn() }));
const machines = [{ id: 'm1', name: 'mac' }, { id: 'm2', name: 'jarvis' }] as Machine[];
vi.mock('../lib/data', () => ({
  useData: () => ({
    machines,
    statuses: { m1: 'online', m2: 'offline' },
    machinesOf: (p: Project) => p.machines.map((l) => machines.find((m) => m.id === l.machine_id)!),
    linkMachine,
    updateProjectMachine,
    unlinkMachine,
  }),
}));
vi.mock('./DirectoryBrowser', () => ({ DirectoryBrowser: () => null }));

import { ProjectMachines } from './ProjectMachines';

const project = { id: 'p1', key: 'P1', name: 'p1', machines: [{ machine_id: 'm1', cwd: '/src/p1', position: 0 }] } as Project;

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ProjectMachines', () => {
  it('lists the links and offers only unlinked machines to add', () => {
    render(<ProjectMachines project={project} />);
    expect(screen.getByText('mac')).toBeInTheDocument();
    expect(screen.getByDisplayValue('/src/p1')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Vincular máquina' }));
    const options = Array.from((screen.getByLabelText('Máquina') as HTMLSelectElement).options).map((o) => o.value).filter(Boolean);
    expect(options).toEqual(['m2']);
  });

  it('links a machine with its directory', async () => {
    linkMachine.mockResolvedValue(undefined);
    render(<ProjectMachines project={project} />);
    fireEvent.click(screen.getByRole('button', { name: 'Vincular máquina' }));
    fireEvent.change(screen.getByLabelText('Máquina'), { target: { value: 'm2' } });
    fireEvent.change(screen.getByLabelText('Diretório'), { target: { value: '/w' } });
    fireEvent.click(screen.getByRole('button', { name: 'Vincular' }));
    await waitFor(() => expect(linkMachine).toHaveBeenCalledWith('p1', { machine_id: 'm2', cwd: '/w', create_dir: true }));
  });

  it('saves an edited directory and unlinks after confirming', async () => {
    updateProjectMachine.mockResolvedValue(undefined);
    unlinkMachine.mockResolvedValue(2);
    render(<ProjectMachines project={project} />);
    fireEvent.change(screen.getByDisplayValue('/src/p1'), { target: { value: '/moved' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(updateProjectMachine).toHaveBeenCalledWith('p1', 'm1', '/moved', false));
    fireEvent.click(screen.getByRole('button', { name: 'Desvincular' })); // the row's link
    fireEvent.click(screen.getAllByRole('button', { name: 'Desvincular' })[1]); // the dialog's confirm
    await waitFor(() => expect(unlinkMachine).toHaveBeenCalledWith('p1', 'm1'));
    await screen.findByText('2 tabs fechadas.');
  });
});
```

```bash
th 'npx vitest run --root apps/web src/components/ProjectMachines.test.tsx'
```

Expected: FAIL (module missing).

- [ ] **Step 2: Component**

`apps/web/src/components/ProjectMachines.tsx`:

```tsx
import { useState, type FormEvent } from 'react';
import { useData } from '../lib/data';
import { ApiError } from '../lib/api';
import type { Project, ProjectMachineLink } from '../lib/types';
import { ConfirmDialog } from './Modal';
import { DirectoryBrowser } from './DirectoryBrowser';

function LinkRow({ project, link }: { project: Project; link: ProjectMachineLink }) {
  const { machines, statuses, updateProjectMachine, unlinkMachine } = useData();
  const machine = machines.find((m) => m.id === link.machine_id);
  const status = statuses[link.machine_id] ?? 'checking';
  const [cwd, setCwd] = useState(link.cwd);
  const [createDir, setCreateDir] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const dirty = cwd !== link.cwd;

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      await updateProjectMachine(project.id, link.machine_id, cwd, createDir);
      setMsg({ ok: true, text: 'Salvo.' });
    } catch (err) {
      setMsg({ ok: false, text: err instanceof ApiError ? err.message : 'Erro ao salvar' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="rounded-lg border border-line p-3">
      <form onSubmit={save} className="space-y-2">
        <div className="flex items-center gap-2 text-sm">
          <span className={`h-2 w-2 shrink-0 rounded-full ${status === 'online' ? 'bg-ok' : status === 'offline' ? 'bg-danger' : 'bg-warn animate-pulse'}`} title={status} />
          <span className="font-medium">{machine?.name ?? link.machine_id}</span>
          <button type="button" className="ml-auto text-xs text-fg-dim hover:text-danger" onClick={() => setConfirm(true)}>
            Desvincular
          </button>
        </div>
        <div className="flex gap-2">
          <input className="input font-mono" value={cwd} onChange={(e) => setCwd(e.target.value)} required aria-label={`Diretório em ${machine?.name ?? link.machine_id}`} />
          <button type="button" className="btn-ghost shrink-0 border border-line" onClick={() => setBrowsing((b) => !b)} title="Listar discos e pastas da máquina">
            {browsing ? 'Ocultar' : 'Procurar…'}
          </button>
          <button type="submit" className="btn-primary shrink-0" disabled={busy || !dirty}>
            Salvar
          </button>
        </div>
        <label className="flex items-center gap-1.5 text-xs text-fg-muted">
          <input type="checkbox" checked={createDir} onChange={(e) => setCreateDir(e.target.checked)} /> criar a pasta na máquina se não existir
        </label>
        {browsing && (
          <DirectoryBrowser machineId={link.machine_id} initialPath={cwd} onSelect={(p) => { setCwd(p); setBrowsing(false); }} onClose={() => setBrowsing(false)} />
        )}
        {msg && <p className={`text-xs ${msg.ok ? 'text-ok' : 'text-danger'}`}>{msg.text}</p>}
        <p className="text-xs text-fg-dim">Vale para novas sessões tmux; tabs já abertas continuam onde estão.</p>
      </form>
      <ConfirmDialog
        open={confirm}
        title="Desvincular máquina"
        message={<>Desvincular <strong>{machine?.name}</strong> de <strong>{project.name}</strong>? As tabs deste projeto abertas nela serão fechadas. Nada é apagado na máquina.</>}
        confirmLabel="Desvincular"
        danger
        onCancel={() => setConfirm(false)}
        onConfirm={async () => {
          try {
            const closed = await unlinkMachine(project.id, link.machine_id);
            setMsg({ ok: true, text: closed === 1 ? '1 tab fechada.' : `${closed} tabs fechadas.` });
          } catch (err) {
            setMsg({ ok: false, text: err instanceof ApiError ? err.message : 'Erro ao desvincular' });
          }
          setConfirm(false);
        }}
      />
    </li>
  );
}

/** Setup → Máquinas: where the project's terminals run, one directory per machine. */
export function ProjectMachines({ project }: { project: Project }) {
  const { machines, linkMachine } = useData();
  const [adding, setAdding] = useState(false);
  const [machineId, setMachineId] = useState('');
  const [cwd, setCwd] = useState('');
  const [createDir, setCreateDir] = useState(true);
  const [browsing, setBrowsing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const available = machines.filter((m) => !project.machines.some((l) => l.machine_id === m.id));

  const add = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await linkMachine(project.id, { machine_id: machineId, cwd, create_dir: createDir });
      setAdding(false);
      setMachineId('');
      setCwd('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Erro ao vincular');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mb-8 max-w-2xl space-y-3 rounded-lg border border-line bg-bg-2 p-4">
      <h3 className="text-sm font-semibold">Máquinas</h3>
      {project.machines.length === 0 && <p className="text-xs text-fg-muted">Nenhuma máquina vinculada: o projeto tem quadro e notas, mas nenhum terminal.</p>}
      <ul className="space-y-2">
        {project.machines.map((l) => (
          <LinkRow key={l.machine_id} project={project} link={l} />
        ))}
      </ul>
      {!adding ? (
        <button type="button" className="btn-ghost border border-line" onClick={() => setAdding(true)} disabled={available.length === 0}>
          Vincular máquina
        </button>
      ) : (
        <form onSubmit={add} className="space-y-2 rounded-lg border border-dashed border-line p-3">
          <div>
            <label className="label" htmlFor="link-machine">Máquina</label>
            <select id="link-machine" className="input" value={machineId} onChange={(e) => setMachineId(e.target.value)} required>
              <option value="">Escolha…</option>
              {available.map((m) => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="link-cwd">Diretório</label>
            <div className="flex gap-2">
              <input id="link-cwd" className="input font-mono" value={cwd} onChange={(e) => setCwd(e.target.value)} required placeholder="/home/pedro/projetos/meu-app" />
              <button type="button" className="btn-ghost shrink-0 border border-line" onClick={() => setBrowsing((b) => !b)} disabled={!machineId}>
                {browsing ? 'Ocultar' : 'Procurar…'}
              </button>
            </div>
            <label className="mt-1.5 flex items-center gap-1.5 text-xs text-fg-muted">
              <input type="checkbox" checked={createDir} onChange={(e) => setCreateDir(e.target.checked)} /> criar a pasta na máquina se não existir
            </label>
            {browsing && machineId && (
              <DirectoryBrowser machineId={machineId} initialPath={cwd} onSelect={(p) => { setCwd(p); setBrowsing(false); }} onClose={() => setBrowsing(false)} />
            )}
          </div>
          {error && <p className="text-xs text-danger">{error}</p>}
          <div className="flex gap-2">
            <button type="submit" className="btn-primary" disabled={busy || !machineId || !cwd.trim()}>Vincular</button>
            <button type="button" className="btn-ghost" onClick={() => setAdding(false)}>Cancelar</button>
          </div>
        </form>
      )}
    </section>
  );
}
```

- [ ] **Step 3: `ProjectSettings.tsx`**

- Remove `cwd`, `browsing`, `createDir` state, the "Diretório" block, the `DirectoryBrowser` import and the `machine` lookup.
- `dirty = name !== project.name || (description || null) !== (project.description ?? null) || status !== project.status`.
- `updateProject(project.id, { name, description: description || null, status })`.
- Under the "Nome" field add a read-only key line:
  ```tsx
  <div>
    <label className="label">Chave</label>
    <p className="font-mono text-sm">{project.key}</p>
    <p className="mt-1 text-xs text-fg-dim">Usada nas URLs e nos números dos cards; não muda.</p>
  </div>
  ```
- After the "Geral" form and before `<SetupForm>`, render `<ProjectMachines project={project} />` (import it).
- Delete text: "Remove o projeto, suas tasks, notas e tickets, e encerra as sessões tmux das tabs nas máquinas vinculadas. Não apaga arquivos."

- [ ] **Step 4: `SetupForm.tsx`**

Lines ~47–51: the runner's default machine is `project.machines[0]?.machine_id`:

```ts
  const runnerMachine = useMemo(
    () => machines.find((m) => m.id === (data?.runner.machine_id ?? project.machines[0]?.machine_id)),
    [machines, data?.runner.machine_id, project.machines],
  );
```

Line ~240: `placeholder={project.machines.find((l) => l.machine_id === (data.runner.machine_id ?? project.machines[0]?.machine_id))?.cwd ?? ''}`.

- [ ] **Step 5: Run the tests**

```bash
th 'npx vitest run --root apps/web src/components/ProjectMachines.test.tsx'
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/ProjectMachines.tsx apps/web/src/components/ProjectMachines.test.tsx apps/web/src/components/ProjectSettings.tsx apps/web/src/components/SetupForm.tsx
git commit -m "Web: manage a project's machine links in Setup"
```

---

### Task 12: Terminals view and project page header

**Files:**
- Modify: `apps/web/src/components/TerminalsView.tsx` (lines ~37–41, 164–177, 262–276, 331)
- Modify: `apps/web/src/pages/ProjectPage.tsx` (lines ~22–46, 68)

**Interfaces:**
- Consumes: `useData().{machinesOf, statuses, missingTmux}`, `api.projects.createTab(id, { kind, machine_id })`, `Modal`.
- Produces: `newTab(kind, cell?, machineId?)`; a machine picker modal when the project has several machines; per-project last machine in `localStorage` key `termhub:last-machine:<projectId>`.

- [ ] **Step 1: TerminalsView**

Replace lines ~37–41:

```ts
  const { machinesOf, missingTmux } = useData();
  const projectMachines = machinesOf(project);
  const machineById = (id: string) => projectMachines.find((m) => m.id === id);
  const noTmux = projectMachines.some((m) => missingTmux[m.id]);
  const canSimulator = projectMachines.some((m) => m.capabilities.includes('wda'));
  const [picking, setPicking] = useState<{ kind: TabKind; cell?: number } | null>(null);
```

Add helpers near the top of the file:

```ts
const LAST_MACHINE_KEY = (projectId: string) => `termhub:last-machine:${projectId}`;
function readLastMachine(projectId: string): string | null {
  try {
    return localStorage.getItem(LAST_MACHINE_KEY(projectId));
  } catch {
    return null;
  }
}
function writeLastMachine(projectId: string, machineId: string): void {
  try {
    localStorage.setItem(LAST_MACHINE_KEY(projectId), machineId);
  } catch {
    /* private mode */
  }
}
```

Replace `newTab`:

```ts
  const newTab = useCallback(
    async (kind: TabKind = 'terminal', cell?: number, machineId?: string) => {
      if (projectMachines.length === 0) {
        setError('Vincule uma máquina ao projeto em Setup → Máquinas para abrir terminais.');
        return;
      }
      let chosen = machineId ?? (projectMachines.length === 1 ? projectMachines[0].id : undefined);
      if (!chosen) {
        setPicking({ kind, cell });
        return;
      }
      try {
        const { tab } = await api.projects.createTab(project.id, { kind, machine_id: chosen });
        writeLastMachine(project.id, chosen);
        setTabs((t) => [...(t ?? []), tab]);
        setLayout((l) => {
          const target = cell ?? (l.cells.indexOf(null) === -1 ? l.focusedCell : l.cells.indexOf(null));
          return reduce(l, { type: 'assignTo', cell: target, tabId: tab.id }, area);
        });
      } catch (e) {
        setError(e instanceof ApiError ? e.message : 'Erro ao criar tab');
      }
    },
    [project.id, area, projectMachines],
  );
```

After the `{noTmux && …}` banner, change its text to name the machines: `<strong>{projectMachines.filter((m) => missingTmux[m.id]).map((m) => m.name).join(', ')}</strong> está online mas não tem tmux…`. Add the empty state right after the `<TabBar …/>`:

```tsx
      {projectMachines.length === 0 && (
        <div className="border-b border-warn/30 bg-warn/10 px-3 py-1 text-xs text-warn">
          Este projeto não tem máquina vinculada. <Link to={`/projects/${project.id}/settings`} className="underline">Vincular em Setup → Máquinas</Link>.
        </div>
      )}
```

(import `Link` from `react-router-dom`). Add the picker modal at the end of the returned fragment:

```tsx
      <Modal title="Abrir em qual máquina?" open={!!picking} onClose={() => setPicking(null)}>
        <ul className="space-y-1">
          {projectMachines.map((m) => (
            <li key={m.id}>
              <button
                type="button"
                className={`btn w-full justify-start border ${readLastMachine(project.id) === m.id ? 'border-accent' : 'border-line'} hover:bg-bg-3`}
                onClick={() => {
                  const p = picking!;
                  setPicking(null);
                  void newTab(p.kind, p.cell, m.id);
                }}
              >
                {m.name}
                <span className="ml-2 font-mono text-[11px] text-fg-dim">{project.machines.find((l) => l.machine_id === m.id)?.cwd}</span>
              </button>
            </li>
          ))}
        </ul>
      </Modal>
```

(import `Modal` from `./Modal`; `ConfirmDialog` is already imported from there.)

Line ~331: `<SimulatorView tab={t} machineId={t.machine_id} …/>`.

Machine badge on tabs: `TabBar` (`apps/web/src/components/TabBar.tsx`, `interface Props` at the top) has no per-tab extra text. Add an optional prop `badges?: Record<string, string>;` to `Props`, and where the tab name is rendered, add right after it:

```tsx
{badges?.[tab.id] && <span className="ml-1 rounded bg-bg-4 px-1 text-[10px] text-fg-dim">{badges[tab.id]}</span>}
```

In `TerminalsView`, pass `badges={projectMachines.length > 1 ? Object.fromEntries((tabs ?? []).map((t) => [t.id, machineById(t.machine_id)?.name ?? ''])) : undefined}` to `<TabBar …/>`.

- [ ] **Step 2: ProjectPage header**

Replace the machine lookup and the `machine:cwd` span:

```tsx
  const { projects, machinesOf, statuses, loading } = useData();
  // ...
  const projectMachines = machinesOf(project);
  const online = projectMachines.some((m) => statuses[m.id] === 'online');
  const status = projectMachines.length === 0 ? null : online ? 'online' : projectMachines.every((m) => statuses[m.id] === 'offline') ? 'offline' : 'checking';
```

```tsx
        <span className="font-mono text-xs text-fg-dim">{project.key}</span>
        <span className="hidden truncate text-xs text-fg-dim md:inline" title={project.machines.map((l) => l.cwd).join('\n')}>
          {projectMachines.length === 0 ? 'sem máquina' : projectMachines.map((m) => m.name).join(', ')}
        </span>
        {status && <span className={`h-2 w-2 shrink-0 rounded-full ${status === 'online' ? 'bg-ok' : status === 'offline' ? 'bg-danger' : 'bg-warn animate-pulse'}`} title={status} />}
```

Line ~68: `key={`settings-${project.id}-${project.status}-${project.name}-${project.machines.map((l) => l.machine_id + l.cwd).join(',')}`}`.

- [ ] **Step 3: Typecheck**

```bash
th 'npm run typecheck -w @termhub/web 2>&1 | grep -v "ProjectsByMachine\|OfficePage\|harness\|NeedsYouList.test"'; rm -rf .npm
```

Expected: nothing left from `TerminalsView.tsx` / `ProjectPage.tsx` / `TabBar.tsx`.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/TerminalsView.tsx apps/web/src/components/TabBar.tsx apps/web/src/pages/ProjectPage.tsx
git commit -m "Web: open terminals on a chosen linked machine"
```

---

### Task 13: Home, Office and remaining web fixtures

**Files:**
- Create: `apps/web/src/components/ProjectCards.tsx`, `apps/web/src/components/ProjectCards.test.tsx`
- Delete: `apps/web/src/components/ProjectsByMachine.tsx`, `apps/web/src/components/ProjectsByMachine.test.tsx`
- Modify: `apps/web/src/pages/HomePage.tsx:11,87` and the empty-state copy
- Modify: `apps/web/src/pages/OfficePage.tsx:143`
- Modify: `apps/web/src/office/harness.ts:31`
- Modify: `apps/web/src/components/NeedsYouList.test.tsx:28-30`

**Interfaces:**
- Produces: `ProjectCards({ items: DashboardItem[]; statuses: Record<string, MachineStatus> })` — a flat grid, one card per active project, each card listing its machines with a status dot.

- [ ] **Step 1: Test**

`apps/web/src/components/ProjectCards.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import type { DashboardItem, Machine, Task } from '../lib/types';
import { ProjectCards } from './ProjectCards';

afterEach(cleanup);

const machine = (id: string, name: string) => ({ id, name, type: 'agent', capabilities: [], owner_id: 'u1' }) as unknown as Machine;
const item = (id: string, name: string, machines: Machine[], doing = 0, open = 0): DashboardItem => ({
  project: { id, key: id.toUpperCase(), owner_id: 'u1', next_task_number: 1, name, status: 'active', description: null, last_terminal_at: null, created_at: '2026-01-01T00:00:00Z', machines: machines.map((m, i) => ({ machine_id: m.id, cwd: `/p/${name}`, position: i })) },
  machines,
  doing: Array.from({ length: doing }, (_, n) => ({ id: `${id}-t${n}`, project_id: id, title: `task ${n}` }) as Task),
  open_tasks: open,
});

describe('ProjectCards', () => {
  it('renders one card per project with its key, machines and tasks in progress', () => {
    const mini = machine('m1', 'mac mini');
    const jarvis = machine('m2', 'jarvis');
    render(
      <MemoryRouter>
        <ProjectCards items={[item('p1', 'hub', [mini, jarvis], 2, 5), item('p2', 'solo', [], 0, 0)]} statuses={{ m1: 'online', m2: 'offline' }} />
      </MemoryRouter>,
    );
    expect(screen.getByText('P1')).toBeInTheDocument();
    expect(screen.getByText('mac mini')).toBeInTheDocument();
    expect(screen.getByText('jarvis')).toBeInTheDocument();
    expect(screen.getByText('task 0')).toBeInTheDocument();
    expect(screen.getByText('5 abertas →')).toBeInTheDocument();
    expect(screen.getByText('sem máquina')).toBeInTheDocument();
  });
});
```

```bash
th 'npx vitest run --root apps/web src/components/ProjectCards.test.tsx'
```

Expected: FAIL (module missing).

- [ ] **Step 2: Component**

`apps/web/src/components/ProjectCards.tsx` (the card body is the one from `ProjectsByMachine.tsx`, which this task deletes):

```tsx
import { Link } from 'react-router-dom';
import type { MachineStatus } from '../lib/data';
import type { DashboardItem } from '../lib/types';

function relative(iso: string | null): string {
  if (!iso) return 'nunca';
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'agora';
  if (m < 60) return `há ${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `há ${h} h`;
  const d = Math.floor(h / 24);
  if (d < 30) return `há ${d} dia${d > 1 ? 's' : ''}`;
  return new Date(iso).toLocaleDateString('pt-BR');
}

function ProjectCard({ item: { project: p, machines, doing, open_tasks }, statuses }: { item: DashboardItem; statuses: Record<string, MachineStatus> }) {
  return (
    <li className="flex flex-col rounded-lg border border-line bg-bg-2 p-4 hover:border-accent/60">
      <div className="flex items-center gap-2">
        <span className="font-mono text-[11px] text-fg-dim">{p.key}</span>
        <Link to={`/projects/${p.id}`} className="truncate font-medium hover:underline">
          {p.name}
        </Link>
      </div>
      <ul className="mt-1 flex flex-wrap gap-2 text-[11px] text-fg-dim">
        {machines.length === 0 && <li>sem máquina</li>}
        {machines.map((m) => {
          const st = statuses[m.id] ?? 'checking';
          return (
            <li key={m.id} className="flex items-center gap-1" title={p.machines.find((l) => l.machine_id === m.id)?.cwd}>
              <span className={`h-1.5 w-1.5 rounded-full ${st === 'online' ? 'bg-ok' : st === 'offline' ? 'bg-danger' : 'bg-warn'}`} />
              {m.name}
            </li>
          );
        })}
      </ul>
      {p.description && <p className="mt-2 line-clamp-2 text-xs text-fg-muted">{p.description}</p>}

      <div className="mt-3 flex-1">
        <div className="mb-1 flex items-center text-[11px] uppercase tracking-wide text-fg-dim">
          <span className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-accent" />
          Fazendo
          <Link to={`/projects/${p.id}/tasks`} className="ml-auto normal-case tracking-normal hover:text-fg">
            {open_tasks} aberta{open_tasks === 1 ? '' : 's'} →
          </Link>
        </div>
        {doing.length === 0 ? (
          <p className="text-xs text-fg-dim">nada em andamento</p>
        ) : (
          <ul className="space-y-1">
            {doing.slice(0, 4).map((t) => (
              <li key={t.id} className="truncate rounded bg-bg-3 px-2 py-1 text-xs" title={t.title}>
                {t.title}
              </li>
            ))}
            {doing.length > 4 && <li className="px-2 text-xs text-fg-dim">+{doing.length - 4}</li>}
          </ul>
        )}
      </div>

      <div className="mt-3 flex items-center justify-between border-t border-line pt-2 text-[11px] text-fg-dim">
        <span>terminal: {relative(p.last_terminal_at)}</span>
        <Link to={`/projects/${p.id}`} className="text-accent hover:underline">
          abrir terminais
        </Link>
      </div>
    </li>
  );
}

/** Home: the active projects, one card each, newest terminal activity first (the API's order). */
export function ProjectCards({ items, statuses }: { items: DashboardItem[]; statuses: Record<string, MachineStatus> }) {
  return (
    <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
      {items.map((i) => (
        <ProjectCard key={i.project.id} item={i} statuses={statuses} />
      ))}
    </ul>
  );
}
```

Delete `ProjectsByMachine.tsx` and `ProjectsByMachine.test.tsx`. In `HomePage.tsx`: import and render `ProjectCards` instead; the empty-state copy becomes `Nenhum projeto ativo. Clique em "+ projeto" na sidebar.`

- [ ] **Step 3: Office and fixtures**

`OfficePage.tsx:143`: `projects.filter((p) => p.machines.some((l) => l.machine_id === machine.id) && p.status !== 'archived')`.

`office/harness.ts:31`: the project fixture becomes `{ id: projectId, owner_id: 'u1', key: \`P${r}\`, next_task_number: 1, name: …, status: …, description: null, last_terminal_at: null, created_at: at, machines: [{ machine_id: \`m${mi}\`, cwd: '/', position: 0 }] }` and its tabs gain `machine_id: \`m${mi}\``.

`NeedsYouList.test.tsx:28-30`: `project(id, machineId)` returns `{ id, owner_id: 'u1', key: id.toUpperCase(), next_task_number: 1, name: id, status: 'active', description: null, last_terminal_at: null, created_at: T1, machines: [{ machine_id: machineId, cwd: '/tmp', position: 0 }] }`; its `tab()` factory gains `machine_id: 'm1'`.

- [ ] **Step 4: Full web verification**

```bash
th 'npm run typecheck -w @termhub/web && npx vitest run --root apps/web && npm run build -w @termhub/web'; rm -rf .npm
```

Expected: typecheck clean, all web tests PASS, build OK.

- [ ] **Step 5: Commit**

```bash
git add -A apps/web/src
git commit -m "Web: home cards per project, office rooms by machine link"
```

---

### Task 14: Docs, full verification, PR

**Files:**
- Modify: `README.md` (the sections that describe projects as "a directory on a machine", the sidebar, MCP `list_projects` / `open_tab`, and the ownership note around lines 123, 176, 237–270)
- Modify: `CLAUDE.md` "Architecture rules" ownership bullet

- [ ] **Step 1: README and CLAUDE.md**

README: describe a project as "a user-owned board with a short key, linked to zero or more machines, each with its own working directory"; note that deleting a machine keeps its projects; document `POST /projects/:id/machines`, the `machine_id` argument of `open_tab`/`start_agent`, and the migration note ("release X: not backward compatible; the blue/green switch runs the migration on the new colour and switches at once").

CLAUDE.md ownership bullet: "machines, projects and integrations have `owner_id`; tabs, tasks, notes and tickets follow their project, and a tab also runs on a machine of the same scope (`project_machines`)".

- [ ] **Step 2: Everything green, from scratch**

```bash
docker rm -f th-test-db; docker run -d --name th-test-db --network th-test -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=termhub postgres:16; sleep 3
thdb 'cd apps/server && npx prisma migrate deploy && npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code && cd ../.. && npm run typecheck -w @termhub/server && npx vitest run --root apps/server && npm run typecheck -w @termhub/web && npx vitest run --root apps/web && npm run build -w @termhub/web'; rm -rf .npm
```

Expected: every step passes. Paste the final summary lines of both vitest runs into the PR description.

- [ ] **Step 3: Commit and open the PR**

```bash
git add README.md CLAUDE.md
git commit -m "Docs: projects decoupled from machines"
git push -u origin feat/projects-decoupled-from-machines
gh pr create --title "Projects decoupled from machines" --body-file - <<'EOF'
Implements docs/superpowers/specs/2026-09-22-projects-decoupled-from-machines-design.md.

- projects: owner_id, unique key, next_task_number; machine_id/cwd removed
- project_machines: per-machine working directory; tabs carry machine_id
- scope: projects by owner, tabs through their machine link
- API: key-available, machine link routes, machine_id on tab open; MCP open_tab/start_agent take machine_id
- web: Projetos/Máquinas sidebar sections, key in the create form, Setup → Máquinas, machine picker for terminals
- migration is NOT backward compatible with the current release (spec §11): switch colours right after it runs

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
```

Do not merge: the owner merges (`gh pr merge`) on request.
