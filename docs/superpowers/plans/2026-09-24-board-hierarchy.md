# Board Hierarchy, Backlog, Custom Columns and Card URLs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every card a type (epic, story, task, subtask, bug, spike), a mandatory epic, a per-project number and URL (`/project/TER-12`), and give every project its own board columns (name + fixed category), an agent column, a filterable Board and a Backlog grouped by epic.

**Architecture:** Additive migration: `tasks` gains `type`, `number` (assigned by a `BEFORE INSERT` trigger from `projects.next_task_number`), `epic_id`, `column_id`; a new `task_columns` table holds each project's columns; `projects` gains `agent_column_id`. `status` stays and now means the card's *category* (`backlog`, or its column's category), kept in sync on every write. Every structural write takes a row lock on the project (`SELECT … FOR UPDATE`), which serializes positions, the default epic and numbering. Rules live in the repositories (`task-rules.ts` pure checks, `task-board.ts` transaction helpers, `tasks.ts`, `task-columns.ts`); routes and MCP tools only validate and translate. The web gets dynamic columns, a type/epic filter, a Backlog view, a standalone card editor opened from `/project/:ref`, and a "Colunas do board" settings block.

**Tech Stack:** Fastify 5 + zod, Prisma 7 (`@prisma/adapter-pg`, Postgres 16), vitest; React 18 + Vite + react-router 7 + Tailwind; npm workspaces (`-w @termhub/server`, `-w @termhub/web`). Node runs only inside Docker on this host.

**Spec:** `docs/superpowers/specs/2026-09-24-board-hierarchy-design.md`

## Global Constraints

- Repo: `/home/pedrogoiania/termhub-wt-board` (a git worktree), branch `docs/board-hierarchy` (already holds the spec commit). Do not push; do not open a PR.
- Commit messages in English, `Area: imperative subject` ≤ 72 chars (CLAUDE.md), each ending with the trailer line `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` (pass it as a second `-m`). UI copy stays pt-BR. Code, comments and identifiers in English.
- Routes never import Prisma; go through `apps/server/src/db/repositories`. Every request input validated with zod. In handlers, load projects/tasks/columns through `scoped(repos, request).<kind>()`, never `repos.*.findById`.
- The migration is **additive and backward compatible** (spec §2, §11; CLAUDE.md): the previous release keeps reading and writing `status`, `position`, `parent_id` with their old meaning during the blue/green switch. No column is dropped or re-purposed.
- CI runs `prisma migrate deploy` then `prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code`, so the migration SQL must produce exactly the Prisma schema. Triggers, functions and `CHECK` constraints are invisible to Prisma's diff (not modelled, not dropped); Task 1 Step 5 proves it on a real database.
- The generated Prisma client is committed (`apps/server/src/generated/prisma`): regenerate and commit it with the schema.
- Types: `epic, story, task, subtask, bug, spike`. Work types (board, counters): `story, task, bug, spike`. Subtask parents: `story, task`. Column categories: `todo, doing, done` (never `backlog`). Max 12 columns per project, names 1–40 chars trimmed. Default columns: "A fazer" (`todo`), "Fazendo" (`doing`), "Feito" (`done`). Default epic title: "Geral". Ref: `KEY-N`, URL `/project/KEY-N`.
- pt-BR rule messages (spec §9), verbatim: "Escolha um épico", "Épico não encontrado", "Subtarefa só pode ficar em uma história ou tarefa", "Tire as subtarefas antes de mudar para bug ou spike", "Épico e subtarefa não mudam de tipo", "Este épico ainda tem cards", "Coluna não encontrada", "O board precisa de ao menos uma coluna de cada tipo", "Limite de 12 colunas". `TaskRuleError` → 400, except `EPIC_HAS_CHILDREN` and `COLUMN_LAST_OF_CATEGORY` → 409.
- The host has no Node. Run every npm/npx command through Docker. Define once per shell:

```bash
cd /home/pedrogoiania/termhub-wt-board
# plain node (typecheck, unit tests, prisma generate)
th() { docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/w" -w /w node:20 sh -c "$*"; }
# node + disposable Postgres (repository *.db.test.ts, migrations)
thdb() { docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp --network th-test -e DATABASE_URL=postgresql://postgres:postgres@th-test-db:5432/termhub -e TERMHUB_DB_TESTS=1 -v "$PWD:/w" -w /w node:20 sh -c "$*"; }
```

  One-time test database (recreate it whenever you need a clean slate):

```bash
docker network create th-test 2>/dev/null || true
docker rm -f th-test-db
docker run -d --name th-test-db --network th-test -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=termhub postgres:16
sleep 3 && thdb 'npm ci --no-audit --no-fund >/dev/null && cd apps/server && npx prisma migrate deploy'
```

  After any Docker run: `rm -rf .npm` (cache the container leaves behind). If the server typecheck or tests cannot resolve `@termhub/agent-protocol` / `@termhub/machine-ops` / `@termhub/claude-cli`, build the shared packages once: `th 'npm run build:packages'` (CI does the same before its tests). The web suite checks the public city bundle (`src/city/bundle.test.ts`): build it once before the first `npm test -w @termhub/web` with `th 'npm run build:city -w @termhub/web'` (CI builds it first too). Server tests run with `--root apps/server` (its `vitest.config.ts` loads `test/setup.ts`), web tests with `--root apps/web`.
- `th-test-db` / `th-test` are throwaway names (CLAUDE.md `th-` rule). Never touch `termhub-*`, `proxy-*` or any `*-app-*` container. Keep `docker rm -f th-test-db` on a line of its own, never chained with `;` or inside a heredoc: the user-level `protect-prod-containers` hook reads the words after `rm` as targets and refuses anything it cannot name (a script file run with `bash`, like Task 1's, is fine).
- `npm test -w @termhub/server` and `npm test -w @termhub/web` must be green at the end of every task (server DB tests through `thdb`).

## Review Focus

- **The previous release keeps writing during the blue/green switch** — top-level tasks with no epic and no column, subtasks with `type = 'task'`, projects with no columns. Expected: the next `GET /projects/:id/tasks` shows them in the right column / epic / checklist, numbered. Pinned by Task 5 "heals a board the old container wrote".
- **Two creates at once on a project with no epic yet** (quick add in two tabs, or the concierge and the web). Expected: one "Geral" epic, distinct numbers, distinct positions. Pinned by Task 3 "creates the default epic once and numbers cards uniquely under concurrency".
- **Deleting a project whose agent column is set** (FK cycle `projects.agent_column_id` ↔ `task_columns.project_id`). Expected: the project and its columns go, no FK error. Pinned by Task 4 "deleting a project whose agent column is set removes it cleanly".
- **Drag and drop while the type/epic filter hides cards.** Expected: the card lands between the two cards the person dropped it between; hidden cards keep their places. Pinned by Task 8 `dropPosition` tests (hidden neighbours, dragging downward in the same column).
- **A ref typed by hand** — lowercase key, surrounding spaces, a subtask's ref, another user's ref. Expected: case-insensitive key, a subtask opens its parent card, another user's ref is a plain 404. Pinned by Task 2 `parseRef` tests, Task 6 "by ref" route and scope tests, and Task 11 `CardPage` "opens the parent of a subtask".

## Deviations from the spec (deliberate, small)

- **Legacy subtasks are retyped by `normalize`.** The previous release inserts subtasks with `type` defaulting to `task`; spec §3's healing list does not mention them. `normalize` also sets `type = 'subtask'` (and clears `epic_id`/`column_id`) on any row with `parent_id`.
- **Creation defaults.** An epic created without `status`/`column_id` goes to the backlog (it is a container); every other type keeps today's default, the first `todo` column. The spec is silent.
- **`epic_id` on an epic or a subtask is ignored** by `PATCH /tasks/:id` and `update_task` (neither has an epic). A type change on a subtask or an epic is refused with `TYPE_LOCKED`, as the spec says.
- **Moving a backlog item to another epic** (changing `epic_id` while it is in the backlog) puts it at the top of the new epic's backlog. A board card keeps its column and position.
- **`start_agent` on a subtask** marks the subtask `doing` (checklist semantics, as today); the agent column applies to top-level cards only.
- **The agent column must be a `doing` column** (owner decision, 2026-09-24): `setAgentColumn` refuses others with `COLUMN_NOT_DOING`, `setCategory` clears the setting when the agent column leaves `doing`, and the settings select lists `doing` columns only. "Already in a doing column" is read from `status = 'doing'`.
- **Every inserted row is numbered by the trigger, subtasks included**, so a subtask has a ref too. `GET /tasks/by-ref/<a subtask's ref>` returns the subtask; the web opens its parent card (subtasks have no editor of their own).
- **Response shapes the spec leaves open:** `POST /columns/:id/move` → `{ columns }` (the new order); `PATCH /columns/:id` → `{ column }`; `PUT /projects/:id/agent-column` → `{ agent_column_id }`. Column positions are kept compact (`0..n-1`) after a move or delete.
- **MCP:** the `column` object (`{ id, name, category }`) is added to `list_tasks` items only; the other task tools return `column_id`. `find` searches kind `task` by default and only when the query parses as a ref.
- **"Elsewhere" labels (spec §7):** type labels are used on the Board, Backlog and editor only; the home page's "doing" list keeps its current copy.
- **Plan order:** card URLs (Task 11) come before the Backlog view (Task 12) because the Backlog's "Abrir" action navigates to the card route; move/positions live with the rest of `TasksRepository` (Task 3) because placement and creation share the same helpers.
- **Migration verification** is a scripted run over old-shaped rows (Task 1 Step 5), as in the previous plan, not a vitest case.
- **Contingency, only if Task 1 Step 5 proves it necessary:** if `migrate diff` reports the `task_columns_category_not_backlog` CHECK as drift, drop the CHECK from the migration (the category is already enforced by zod and by the `ColumnCategory` type) and add a line here saying so.

## File map

Server (`apps/server`):
- `prisma/schema.prisma` — `TaskType` enum, `Task` (type, number, epic, column), `TaskColumn` (new), `Project.agentColumn`.
- `prisma/migrations/20260924000000_board_hierarchy/migration.sql` — new; DDL, backfill, numbering trigger.
- `src/generated/prisma/**` — regenerated client (committed).
- `src/db/repositories/task-rules.ts` (+ `task-rules.test.ts`) — new, pure: rule codes/messages, `TaskRuleError`, type/parent checks, `parseRef`, limits.
- `src/db/repositories/types.ts` — `TaskType`, `ColumnCategory`, `Task` fields, `TaskColumn`, `Project.agent_column_id`, mappers.
- `src/db/repositories/task-board.ts` — new: transaction helpers (project lock, default columns, default epic, placements, gaps).
- `src/db/repositories/tasks.ts` (+ `tasks.db.test.ts`) — hierarchy, numbering refs, moves, `startWork`, `findByRef`, `normalize`, counts.
- `src/db/repositories/task-columns.ts` (+ `task-columns.db.test.ts`) — new: columns CRUD, agent column.
- `src/db/repositories/projects.ts`, `index.ts` — default columns on create; `taskColumns` registered.
- `src/auth/scope.ts` (+ `scope.test.ts`) — `column(id)`, `taskByRef(ref)`.
- `src/routes/tasks.ts` (+ `tasks.test.ts`) — list payload, bodies, move exactly-one-of, by-ref, `taskRules` (400/409).
- `src/routes/columns.ts` (+ `columns.test.ts`) — new; `src/app.ts` registers it.
- `src/control/tasks.ts`, `agents.ts`, `inventory.ts`, `src/mcp/tools.ts` (+ tests) — MCP fields, filters, move by column, agent column, `find` by ref.
- `src/db/repositories/chat-actions-view.ts` (+ test) — the ref before the title.

Web (`apps/web/src`):
- `lib/types.ts`, `lib/api.ts` — task/column model and client.
- `lib/board.ts` (+ `board.test.ts`) — new, pure board helpers (filter, positions, sections).
- `components/TypeBadge.tsx` — new.
- `components/TaskEditor.tsx` (+ test) — new; the card editor.
- `components/TasksBoard.tsx` (+ test) — dynamic columns, filter, card markers, URL-driven editor.
- `pages/CardPage.tsx` (+ test) — new, `/project/:ref`; `pages/ProjectPage.tsx` (+ test), `App.tsx`.
- `components/BacklogView.tsx` (+ test) — new.
- `components/BoardColumnsSettings.tsx` (+ test) — new; `components/ProjectSettings.tsx`, `components/SetupForm.tsx` (hint copy).

Docs: `README.md`, `CLAUDE.md`.

---

### Task 1: Schema, migration and numbering trigger

**Files:**
- Modify: `apps/server/prisma/schema.prisma` (`model Project` ~173, `enum TaskStatus` ~329, `model Task` ~336)
- Create: `apps/server/prisma/migrations/20260924000000_board_hierarchy/migration.sql`
- Regenerate: `apps/server/src/generated/prisma/**`

**Interfaces:**
- Produces: Prisma enum `TaskType`; `Task { type: TaskType; number: Int; epicId; epic; epicCards; columnId; column }` with compound unique `projectId_number`; `TaskColumn { id, projectId, name, category: TaskStatus, position, createdAt, project, tasks, agentFor }`; `Project { agentColumnId, agentColumn, columns }`. Database trigger `tasks_assign_number` numbers every inserted row whose `number` is 0 or null. Everything after this task compiles against the regenerated client.

- [ ] **Step 1: Edit the Prisma schema**

In `apps/server/prisma/schema.prisma`, inside `model Project`, after the line `  isPublic       Boolean       @default(false) @map("is_public")` add:

```prisma
  /// Column a card moves to when an agent starts on it (start_agent). Null = automatic: the first `doing` column.
  agentColumnId  String?       @map("agent_column_id")
```

and after `  groupItems     ProjectGroupItem[]` add:

```prisma
  agentColumn    TaskColumn?   @relation("ProjectAgentColumn", fields: [agentColumnId], references: [id], onDelete: SetNull)
  /// The project's board columns, in `position` order.
  columns        TaskColumn[]  @relation("ProjectColumns")
```

Replace the doc comment of `nextTaskNumber` (the line `/// Next card number for this project (used by the task-hierarchy spec; untouched here).`) with:

```prisma
  /// Next card number for this project; the `tasks_assign_number` trigger takes it on every insert.
```

Right after the `enum TaskStatus { … }` block add:

```prisma
/// Kind of card. Epics group work; stories/tasks/bugs/spikes are the work; subtasks are a checklist inside a story or task.
enum TaskType {
  epic
  story
  task
  subtask
  bug
  spike
}

/// A board column of a project. The user names it; `category` is what the system reasons with
/// (todo, doing or done — never backlog, a CHECK in the migration enforces it).
model TaskColumn {
  id        String     @id
  projectId String     @map("project_id")
  name      String
  category  TaskStatus
  position  Int
  createdAt DateTime   @default(now()) @map("created_at")
  project   Project    @relation("ProjectColumns", fields: [projectId], references: [id], onDelete: Cascade)
  tasks     Task[]
  agentFor  Project[]  @relation("ProjectAgentColumn")

  @@index([projectId, position])
  @@map("task_columns")
}
```

In `model Task`, replace the line `  status      TaskStatus @default(todo)` with:

```prisma
  /// The card's category: backlog = in the backlog; otherwise the category of `column`. Kept in sync on every write.
  status      TaskStatus @default(todo)
  type        TaskType   @default(task)
  /// Sequential per project (projects.next_task_number), set by the tasks_assign_number trigger; never reused.
  number      Int        @default(0)
```

and after the line `  subtasks    Task[]     @relation("TaskSubtasks")` add:

```prisma

  /// Story/task/bug/spike: the epic it belongs to. Null on epics and subtasks.
  epicId      String?    @map("epic_id")
  epic        Task?      @relation("TaskEpic", fields: [epicId], references: [id], onDelete: SetNull)
  epicCards   Task[]     @relation("TaskEpic")
  /// Board column; null in the backlog and on subtasks.
  columnId    String?    @map("column_id")
  column      TaskColumn? @relation(fields: [columnId], references: [id], onDelete: SetNull)
```

and replace the block

```prisma
  @@unique([projectId, externalKey])
  @@index([projectId, status, position])
  @@index([parentId, position])
  @@map("tasks")
```

with

```prisma
  @@unique([projectId, externalKey])
  @@unique([projectId, number])
  @@index([projectId, status, position])
  @@index([parentId, position])
  @@index([columnId, position])
  @@index([epicId, status, position])
  @@map("tasks")
```

Also update the doc comment of `parentId` (the two lines starting `/// Subtask: the parent task`) to:

```prisma
  /// Subtask: the parent story or task (one level only, enforced in TasksRepository). Subtasks have no
  /// board column — `position` orders them among siblings — and are always local (no externalKey).
```

- [ ] **Step 2: Get Prisma's DDL for the new schema (exact index and constraint names)**

The test database must be at the previous migration (`20260923150000_project_chat`): run the one-time recipe from Global Constraints now if `th-test-db` does not exist yet — before Step 3 creates the new migration directory. Then:

```bash
thdb 'cd apps/server && npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script' > /tmp/th-board-ddl.sql; rm -rf .npm
cat /tmp/th-board-ddl.sql
```

Expected: `CREATE TYPE "TaskType"`, `ALTER TABLE "projects" ADD COLUMN "agent_column_id" TEXT`, `ALTER TABLE "tasks" ADD COLUMN "column_id" …, "epic_id" …, "number" INTEGER NOT NULL DEFAULT 0, "type" "TaskType" NOT NULL DEFAULT 'task'`, `CREATE TABLE "task_columns"`, indexes `task_columns_project_id_position_idx`, `tasks_column_id_position_idx`, `tasks_epic_id_status_position_idx`, `tasks_project_id_number_key`, and foreign keys `tasks_epic_id_fkey`, `tasks_column_id_fkey`, `task_columns_project_id_fkey`, `projects_agent_column_id_fkey`. If any name differs from Step 3, use Prisma's.

- [ ] **Step 3: Write the migration**

`apps/server/prisma/migrations/20260924000000_board_hierarchy/migration.sql`:

```sql
-- Board hierarchy (spec 2026-09-24-board-hierarchy-design.md §8). Additive: the previous release
-- keeps reading and writing status/position/parent_id with their old meaning during the switch, and
-- the numbering trigger numbers its inserts too.

-- 1. Types, columns, table, keys
CREATE TYPE "TaskType" AS ENUM ('epic', 'story', 'task', 'subtask', 'bug', 'spike');

ALTER TABLE "tasks" ADD COLUMN "type" "TaskType" NOT NULL DEFAULT 'task',
                    ADD COLUMN "number" INTEGER NOT NULL DEFAULT 0,
                    ADD COLUMN "epic_id" TEXT,
                    ADD COLUMN "column_id" TEXT;

CREATE TABLE "task_columns" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" "TaskStatus" NOT NULL,
    "position" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_columns_pkey" PRIMARY KEY ("id"),
    -- invisible to Prisma (not modelled, never dropped by migrate)
    CONSTRAINT "task_columns_category_not_backlog" CHECK ("category" <> 'backlog')
);

ALTER TABLE "projects" ADD COLUMN "agent_column_id" TEXT;

CREATE INDEX "task_columns_project_id_position_idx" ON "task_columns"("project_id", "position");
CREATE INDEX "tasks_column_id_position_idx" ON "tasks"("column_id", "position");
CREATE INDEX "tasks_epic_id_status_position_idx" ON "tasks"("epic_id", "status", "position");

ALTER TABLE "task_columns" ADD CONSTRAINT "task_columns_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_epic_id_fkey" FOREIGN KEY ("epic_id") REFERENCES "tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_column_id_fkey" FOREIGN KEY ("column_id") REFERENCES "task_columns"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "projects" ADD CONSTRAINT "projects_agent_column_id_fkey" FOREIGN KEY ("agent_column_id") REFERENCES "task_columns"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 2. Subtasks
UPDATE "tasks" SET "type" = 'subtask' WHERE "parent_id" IS NOT NULL;

-- 3. Default columns for every project
INSERT INTO "task_columns" ("id", "project_id", "name", "category", "position")
SELECT 'tc' || p."id" || c.n, p."id", c.name, c.category::"TaskStatus", c.n - 1
  FROM "projects" p
 CROSS JOIN (VALUES (1, 'A fazer', 'todo'), (2, 'Fazendo', 'doing'), (3, 'Feito', 'done')) AS c(n, name, category);

-- 4. Top-level cards on the board: the column of their status, positions kept
UPDATE "tasks" t
   SET "column_id" = 'tc' || t."project_id" || CASE t."status" WHEN 'todo' THEN '1' WHEN 'doing' THEN '2' ELSE '3' END
 WHERE t."parent_id" IS NULL AND t."status" <> 'backlog';

-- 5. Default epic "Geral" (in the backlog) for every project with top-level cards
INSERT INTO "tasks" ("id", "project_id", "title", "status", "position", "type")
SELECT 'ep' || p."id", p."id", 'Geral', 'backlog', 0, 'epic'
  FROM "projects" p
 WHERE EXISTS (SELECT 1 FROM "tasks" t WHERE t."project_id" = p."id" AND t."parent_id" IS NULL);

UPDATE "tasks" SET "epic_id" = 'ep' || "project_id" WHERE "parent_id" IS NULL AND "type" <> 'epic';

-- 6. Numbers per project by creation (epics first); the counter continues after the highest
UPDATE "tasks" t SET "number" = n.rn
  FROM (SELECT "id", ROW_NUMBER() OVER (PARTITION BY "project_id" ORDER BY ("type" <> 'epic'), "created_at", "id") AS rn FROM "tasks") n
 WHERE n."id" = t."id";

UPDATE "projects" p SET "next_task_number" = COALESCE((SELECT MAX(t."number") FROM "tasks" t WHERE t."project_id" = p."id"), 0) + 1;

-- 7. Uniqueness, then the trigger that numbers every new row (the previous release's too)
CREATE UNIQUE INDEX "tasks_project_id_number_key" ON "tasks"("project_id", "number");

CREATE FUNCTION "tasks_assign_number"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."number" IS NULL OR NEW."number" = 0 THEN
    -- the row lock on the project serializes concurrent inserts: numbers never repeat
    UPDATE "projects" SET "next_task_number" = "next_task_number" + 1
     WHERE "id" = NEW."project_id"
    RETURNING "next_task_number" - 1 INTO NEW."number";
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "tasks_assign_number" BEFORE INSERT ON "tasks"
  FOR EACH ROW EXECUTE FUNCTION "tasks_assign_number"();
```

- [ ] **Step 4: Write the verification script (not committed)**

Create it with the file-writing tool, not a shell heredoc (the prod-container hook scans heredoc text and refuses it). `/tmp/th-verify-board-migration.sh`:

```bash
#!/usr/bin/env bash
# Runs 20260924000000_board_hierarchy over rows shaped like the previous release, then checks the
# backfill, the trigger and that the schema matches Prisma exactly. Recreates th-test-db.
set -euo pipefail
cd /home/pedrogoiania/termhub-wt-board
MIG=apps/server/prisma/migrations/20260924000000_board_hierarchy
thdb() { docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp --network th-test -e DATABASE_URL=postgresql://postgres:postgres@th-test-db:5432/termhub -e TERMHUB_DB_TESTS=1 -v "$PWD:/w" -w /w node:20 sh -c "$*"; }
pg() { docker exec -i th-test-db psql -v ON_ERROR_STOP=1 -U postgres termhub "$@"; }

docker network create th-test >/dev/null 2>&1 || true
docker rm -f th-test-db >/dev/null 2>&1 || true
docker run -d --name th-test-db --network th-test -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=termhub postgres:16 >/dev/null
until docker exec th-test-db pg_isready -U postgres >/dev/null 2>&1; do sleep 1; done
sleep 2

mv "$MIG" /tmp/th-board-mig
trap 'mv /tmp/th-board-mig "$MIG" 2>/dev/null || true' EXIT
thdb 'cd apps/server && npx prisma migrate deploy' >/dev/null
pg <<'SQL'
INSERT INTO projects (id, key, name) VALUES ('p1', 'PA', 'Alpha'), ('p2', 'PB', 'Empty');
INSERT INTO tasks (id, project_id, title, status, position, created_at) VALUES
  ('k_back',  'p1', 'in backlog', 'backlog', 0, '2026-01-01 00:00:01'),
  ('k_todo',  'p1', 'to do',      'todo',    0, '2026-01-01 00:00:02'),
  ('k_doing', 'p1', 'doing',      'doing',   0, '2026-01-01 00:00:03'),
  ('k_done',  'p1', 'done',       'done',    0, '2026-01-01 00:00:04');
INSERT INTO tasks (id, project_id, parent_id, title, status, position, created_at)
  VALUES ('k_sub', 'p1', 'k_todo', 'sub', 'todo', 0, '2026-01-01 00:00:05');
SQL
mv /tmp/th-board-mig "$MIG"; trap - EXIT

thdb 'cd apps/server && npx prisma migrate deploy >/dev/null && npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code && echo "migrate diff: no drift"'
pg -At <<'SQL'
SELECT 'columns', project_id, string_agg(id || ':' || name || ':' || category || ':' || position, ',' ORDER BY position) FROM task_columns GROUP BY project_id ORDER BY project_id;
SELECT 'task', id, type, number, coalesce(epic_id, '-'), coalesce(column_id, '-'), status, position FROM tasks ORDER BY number;
SELECT 'next', id, next_task_number FROM projects ORDER BY id;
INSERT INTO tasks (id, project_id, title) VALUES ('k_new', 'p1', 'written by the old release');
SELECT 'trigger', id, number FROM tasks WHERE id = 'k_new';
SELECT 'next-after', id, next_task_number FROM projects WHERE id = 'p1';
SQL
rm -rf .npm
```

- [ ] **Step 5: Run it**

```bash
bash /tmp/th-verify-board-migration.sh
```

Expected output (order exact):

```
migrate diff: no drift
columns|p1|tcp11:A fazer:todo:0,tcp12:Fazendo:doing:1,tcp13:Feito:done:2
columns|p2|tcp21:A fazer:todo:0,tcp22:Fazendo:doing:1,tcp23:Feito:done:2
task|epp1|epic|1|-|-|backlog|0
task|k_back|task|2|epp1|-|backlog|0
task|k_todo|task|3|epp1|tcp11|todo|0
task|k_doing|task|4|epp1|tcp12|doing|0
task|k_done|task|5|epp1|tcp13|done|0
task|k_sub|subtask|6|-|-|todo|0
next|p1|7
next|p2|1
trigger|k_new|7
next-after|p1|8
```

If `migrate diff` fails and its output names only the CHECK constraint `task_columns_category_not_backlog`, apply the contingency in "Deviations from the spec" (remove the `CONSTRAINT … CHECK` line and the comment above it, add the deviation line) and rerun. Any other drift means Step 1 and Step 3 disagree: fix the SQL to match Prisma's DDL from Step 2.

The script leaves `th-test-db` migrated to the new schema, which is what the next tasks need.

- [ ] **Step 6: Regenerate the client and typecheck**

```bash
th 'cd apps/server && npx prisma generate && npm run typecheck'; rm -rf .npm
```

Expected: `prisma generate` succeeds and typecheck passes (nothing reads the new fields yet; `mapTask` still compiles because it ignores them).

- [ ] **Step 7: Run the server suite against the new schema**

```bash
thdb 'npm test -w @termhub/server'; rm -rf .npm
```

Expected: PASS (existing behaviour unchanged; the trigger numbers rows silently).

- [ ] **Step 8: Commit**

```bash
git add apps/server/prisma/schema.prisma apps/server/prisma/migrations/20260924000000_board_hierarchy apps/server/src/generated/prisma
git commit -m "Prisma: card types, numbers, epics and per-project board columns" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Pure task rules

**Files:**
- Create: `apps/server/src/db/repositories/task-rules.ts`
- Test: `apps/server/src/db/repositories/task-rules.test.ts`
- Modify: `apps/server/src/db/repositories/types.ts` (type aliases next to `TaskStatus`, line ~18)

**Interfaces:**
- Produces (types.ts): `type TaskType = 'epic' | 'story' | 'task' | 'subtask' | 'bug' | 'spike'`, `type ColumnCategory = Exclude<TaskStatus, 'backlog'>`.
- Produces (task-rules.ts):
  ```ts
  type TaskRuleCode = 'PARENT_NOT_FOUND' | 'PARENT_IS_SUBTASK' | 'SUBTASK_CANNOT_MOVE' | 'NOT_A_SUBTASK' | 'TOO_MANY_SUBTASKS' | 'EPIC_REQUIRED' | 'EPIC_NOT_FOUND' | 'PARENT_TYPE' | 'HAS_SUBTASKS' | 'TYPE_LOCKED' | 'EPIC_HAS_CHILDREN' | 'COLUMN_NOT_FOUND' | 'COLUMN_NOT_DOING' | 'COLUMN_LAST_OF_CATEGORY' | 'TOO_MANY_COLUMNS'
  const MAX_SUBTASKS_PER_CALL = 50, MAX_COLUMNS = 12, COLUMN_NAME_MAX = 40
  class TaskRuleError extends Error { code: TaskRuleCode; constructor(code, message = <pt-BR default>) }
  const WORK_TYPES: TaskType[]   // story, task, bug, spike
  const PARENT_TYPES: TaskType[] // story, task
  function checkTypeChange(from: TaskType, to: TaskType, subtaskCount: number): void
  function checkSubtaskParent(parent: { type: TaskType; parentId: string | null }): void
  function parseRef(ref: string): { key: string; number: number } | null
  ```

- [ ] **Step 1: Add the type aliases**

In `apps/server/src/db/repositories/types.ts`, after `export type TaskStatus = 'backlog' | 'todo' | 'doing' | 'done';` add:

```ts
/** Kind of card (spec 2026-09-24 §3): epics group work, subtasks are a checklist inside a story or task. */
export type TaskType = 'epic' | 'story' | 'task' | 'subtask' | 'bug' | 'spike';
/** What a board column means to the system; the backlog is not a column. */
export type ColumnCategory = Exclude<TaskStatus, 'backlog'>;
```

- [ ] **Step 2: Write the failing test**

`apps/server/src/db/repositories/task-rules.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { checkSubtaskParent, checkTypeChange, parseRef, TaskRuleError } from './task-rules.js';

describe('TaskRuleError', () => {
  it('carries the pt-BR message of its code by default, or the one given', () => {
    expect(new TaskRuleError('EPIC_REQUIRED').message).toBe('Escolha um épico');
    expect(new TaskRuleError('COLUMN_LAST_OF_CATEGORY').message).toBe('O board precisa de ao menos uma coluna de cada tipo');
    expect(new TaskRuleError('TOO_MANY_COLUMNS').message).toBe('Limite de 12 colunas');
    expect(new TaskRuleError('PARENT_IS_SUBTASK', 'custom').message).toBe('custom');
    expect(new TaskRuleError('HAS_SUBTASKS').code).toBe('HAS_SUBTASKS');
  });
});

describe('checkTypeChange', () => {
  it('allows any change among story, task, bug and spike', () => {
    for (const [from, to] of [['story', 'task'], ['task', 'bug'], ['bug', 'spike'], ['spike', 'story']] as const) {
      expect(() => checkTypeChange(from, to, 0)).not.toThrow();
    }
  });
  it('keeps a card with subtasks a story or a task', () => {
    expect(() => checkTypeChange('story', 'task', 3)).not.toThrow();
    expect(() => checkTypeChange('task', 'bug', 1)).toThrow(expect.objectContaining({ code: 'HAS_SUBTASKS', message: 'Tire as subtarefas antes de mudar para bug ou spike' }));
    expect(() => checkTypeChange('story', 'spike', 1)).toThrow(expect.objectContaining({ code: 'HAS_SUBTASKS' }));
  });
  it('never changes an epic or a subtask, nor turns anything into one', () => {
    for (const [from, to] of [['epic', 'task'], ['subtask', 'task'], ['task', 'epic'], ['story', 'subtask']] as const) {
      expect(() => checkTypeChange(from, to, 0)).toThrow(expect.objectContaining({ code: 'TYPE_LOCKED', message: 'Épico e subtarefa não mudam de tipo' }));
    }
  });
  it('accepts no change at all', () => {
    expect(() => checkTypeChange('epic', 'epic', 0)).not.toThrow();
  });
});

describe('checkSubtaskParent', () => {
  it('accepts a story or a task', () => {
    expect(() => checkSubtaskParent({ type: 'story', parentId: null })).not.toThrow();
    expect(() => checkSubtaskParent({ type: 'task', parentId: null })).not.toThrow();
  });
  it('refuses a subtask (or any row with a parent) as parent', () => {
    expect(() => checkSubtaskParent({ type: 'subtask', parentId: 'x' })).toThrow(expect.objectContaining({ code: 'PARENT_IS_SUBTASK' }));
    expect(() => checkSubtaskParent({ type: 'task', parentId: 'x' })).toThrow(expect.objectContaining({ code: 'PARENT_IS_SUBTASK' }));
  });
  it('refuses an epic, a bug and a spike', () => {
    for (const type of ['epic', 'bug', 'spike'] as const) {
      expect(() => checkSubtaskParent({ type, parentId: null })).toThrow(expect.objectContaining({ code: 'PARENT_TYPE', message: 'Subtarefa só pode ficar em uma história ou tarefa' }));
    }
  });
});

describe('parseRef', () => {
  it('splits KEY-N, uppercasing the key and ignoring surrounding spaces', () => {
    expect(parseRef('TER-12')).toEqual({ key: 'TER', number: 12 });
    expect(parseRef(' ter-7 ')).toEqual({ key: 'TER', number: 7 });
    expect(parseRef('A1B2-1')).toEqual({ key: 'A1B2', number: 1 });
  });
  it.each(['TER', 'TER-', 'TER-0', 'TER-01', '1AB-2', 'T-1', 'TER-12-3', 'TER 12', 'ABCDEFGHIJK-1', 'TER-1234567890'])('rejects %j', (ref) => {
    expect(parseRef(ref)).toBeNull();
  });
});
```

- [ ] **Step 3: Run it to see it fail**

```bash
th 'npx vitest run --root apps/server src/db/repositories/task-rules.test.ts'; rm -rf .npm
```

Expected: FAIL — cannot find module `./task-rules.js`.

- [ ] **Step 4: Implement**

`apps/server/src/db/repositories/task-rules.ts`:

```ts
import type { TaskType } from './types.js';

/** Rules the board repositories enforce. Routes answer 409 for EPIC_HAS_CHILDREN and COLUMN_LAST_OF_CATEGORY, 400 for the rest. */
export type TaskRuleCode =
  | 'PARENT_NOT_FOUND'
  | 'PARENT_IS_SUBTASK'
  | 'SUBTASK_CANNOT_MOVE'
  | 'NOT_A_SUBTASK'
  | 'TOO_MANY_SUBTASKS'
  | 'EPIC_REQUIRED'
  | 'EPIC_NOT_FOUND'
  | 'PARENT_TYPE'
  | 'HAS_SUBTASKS'
  | 'TYPE_LOCKED'
  | 'EPIC_HAS_CHILDREN'
  | 'COLUMN_NOT_FOUND'
  | 'COLUMN_NOT_DOING'
  | 'COLUMN_LAST_OF_CATEGORY'
  | 'TOO_MANY_COLUMNS';

/** Enforced both here and in the route's zod schema (which uses this constant too). */
export const MAX_SUBTASKS_PER_CALL = 50;
export const MAX_COLUMNS = 12;
export const COLUMN_NAME_MAX = 40;

const MESSAGES: Record<TaskRuleCode, string> = {
  PARENT_NOT_FOUND: 'Tarefa pai não encontrada neste projeto',
  PARENT_IS_SUBTASK: 'Uma subtarefa não pode ter subtarefas',
  SUBTASK_CANNOT_MOVE: 'Subtarefas não ficam em colunas; mude o status ou reordene',
  NOT_A_SUBTASK: 'Só subtarefas são reordenadas aqui; use mover para tarefas do quadro',
  TOO_MANY_SUBTASKS: 'No máximo 50 subtarefas por vez',
  EPIC_REQUIRED: 'Escolha um épico',
  EPIC_NOT_FOUND: 'Épico não encontrado',
  PARENT_TYPE: 'Subtarefa só pode ficar em uma história ou tarefa',
  HAS_SUBTASKS: 'Tire as subtarefas antes de mudar para bug ou spike',
  TYPE_LOCKED: 'Épico e subtarefa não mudam de tipo',
  EPIC_HAS_CHILDREN: 'Este épico ainda tem cards',
  COLUMN_NOT_FOUND: 'Coluna não encontrada',
  COLUMN_NOT_DOING: 'A coluna do agente precisa ser do tipo Fazendo',
  COLUMN_LAST_OF_CATEGORY: 'O board precisa de ao menos uma coluna de cada tipo',
  TOO_MANY_COLUMNS: 'Limite de 12 colunas',
};

/** A board rule was broken. `message` is pt-BR and safe to show to the user. */
export class TaskRuleError extends Error {
  constructor(
    readonly code: TaskRuleCode,
    message: string = MESSAGES[code],
  ) {
    super(message);
    this.name = 'TaskRuleError';
  }
}

/** The work: what the board shows by default and what every counter counts. */
export const WORK_TYPES: TaskType[] = ['story', 'task', 'bug', 'spike'];
/** The only types that may hold subtasks. */
export const PARENT_TYPES: TaskType[] = ['story', 'task'];

/** Spec §3: types change only among story/task/bug/spike, and a card with subtasks stays a story or task. */
export function checkTypeChange(from: TaskType, to: TaskType, subtaskCount: number): void {
  if (from === to) return;
  if (from === 'epic' || from === 'subtask' || to === 'epic' || to === 'subtask') throw new TaskRuleError('TYPE_LOCKED');
  if (subtaskCount > 0 && !PARENT_TYPES.includes(to)) throw new TaskRuleError('HAS_SUBTASKS');
}

/** A subtask's parent is a top-level story or task (a row with a parent is a subtask, whatever its type says). */
export function checkSubtaskParent(parent: { type: TaskType; parentId: string | null }): void {
  if (parent.parentId || parent.type === 'subtask') throw new TaskRuleError('PARENT_IS_SUBTASK');
  if (!PARENT_TYPES.includes(parent.type)) throw new TaskRuleError('PARENT_TYPE');
}

const REF_RE = /^([A-Za-z][A-Za-z0-9]{1,9})-([1-9][0-9]{0,8})$/;

/** "TER-12" → { key: "TER", number: 12 }; the key is case-insensitive. Null when it is not a ref. */
export function parseRef(ref: string): { key: string; number: number } | null {
  const m = REF_RE.exec(ref.trim());
  return m ? { key: m[1].toUpperCase(), number: Number(m[2]) } : null;
}
```

- [ ] **Step 5: Run the test**

```bash
th 'npx vitest run --root apps/server src/db/repositories/task-rules.test.ts && npm run typecheck -w @termhub/server'; rm -rf .npm
```

Expected: PASS (4 describe blocks), typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/db/repositories/task-rules.ts apps/server/src/db/repositories/task-rules.test.ts apps/server/src/db/repositories/types.ts
git commit -m "Tasks: pure board rules, messages and ref parsing" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---
### Task 3: TasksRepository — types, epics, numbers, placement and moves

**Files:**
- Modify: `apps/server/src/db/repositories/types.ts` (imports 1–12, `Project` ~88, `Task` ~151, `mapProject` ~268, `mapTask` ~320)
- Create: `apps/server/src/db/repositories/task-board.ts`
- Modify (full rewrite): `apps/server/src/db/repositories/tasks.ts`
- Modify: `apps/server/src/routes/tasks.ts:67` and `apps/server/src/control/tasks.ts:98` (new `move` signature only)
- Test (full rewrite): `apps/server/src/db/repositories/tasks.db.test.ts`; Modify: `apps/server/src/control/tasks.test.ts` (two `move` expectations)

**Interfaces:**
- Consumes: Task 2 `TaskRuleError`, `checkTypeChange`, `checkSubtaskParent`, `PARENT_TYPES`, `MAX_SUBTASKS_PER_CALL`, `TaskType`, `ColumnCategory`.
- Produces (types.ts):
  ```ts
  interface Project { ...; agent_column_id: string | null }
  interface Task { id; project_id; type: TaskType; number: number; ref: string; title; description; status: TaskStatus; position; external_ref; external_key; tab_id; parent_id: string | null; epic_id: string | null; column_id: string | null; created_at; updated_at }
  interface TaskColumn { id: string; project_id: string; name: string; category: ColumnCategory; position: number; created_at: string }
  mapTask(t: PrismaTask, key: string): Task      // ref = `${key}-${number}`
  mapTaskColumn(c: PrismaTaskColumn): TaskColumn
  ```
- Produces (task-board.ts): `type Tx = Prisma.TransactionClient`; `DEFAULT_COLUMNS`, `DEFAULT_EPIC_TITLE`; `lockProject(tx, projectId)`, `ensureDefaultColumns(tx, projectId)`, `firstColumnId(tx, projectId, category): Promise<string>`, `defaultEpicId(tx, projectId): Promise<string>`, `requireEpic(tx, projectId, epicId): Promise<string>`; `interface Placement { status; columnId; epicId; type }`, `placementOf(row)`, `scopeWhere(projectId, p)`, `placementFor(tx, projectId, card: { type; epicId }, target: { column_id?; status? })`, `closeGap(tx, projectId, from, position, exceptId?)`, `openSlot(tx, projectId, to, position, exceptId?): Promise<number>`, `endOf(tx, projectId, to): Promise<number>`.
- Produces (tasks.ts): `TaskInput { title; description?; status?; type?; epic_id?; column_id?; parent_id? }`, `TaskPatch { title?; description?; status?; type?; epic_id? }`, `type MoveTarget = { column_id: string } | { status: TaskStatus }`; `TasksRepository` methods `listByProject`, `findById`, `findByRef(projectId, number)`, `findByIdsForOwner`, `create`, `createWithSubtasks(projectId, Omit<TaskInput,'parent_id'>, subtasks)`, `createSubtasks`, `childIds`, `update(id, TaskPatch)`, `move(id, MoveTarget, position)`, `startWork(id)`, `reorder`, `delete` (throws `EPIC_HAS_CHILDREN`), `createFromTicket` (end of the default epic's backlog), `setExternalRef`, `setTab`, `openCountByProject`, `listDoing`, `officeProgress`. Re-exports `TaskRuleError`, `TaskRuleCode`, `MAX_SUBTASKS_PER_CALL`.

- [ ] **Step 1: Update the shared types**

In `apps/server/src/db/repositories/types.ts`:

Add `TaskColumn as PrismaTaskColumn,` to the import list from `'../../generated/prisma/client.js'` (after `Task as PrismaTask,`).

In `export interface Project`, after `is_public: boolean;` add:

```ts
  /** column a card moves to when an agent starts on it; null = automatic (first `doing` column) */
  agent_column_id: string | null;
```

Replace the whole `export interface Task { … }` with:

```ts
export interface Task {
  id: string;
  project_id: string;
  /** epic, story, task, subtask, bug or spike (spec 2026-09-24 §3) */
  type: TaskType;
  /** sequential per project, set by the database trigger; never reused */
  number: number;
  /** "TER-12": project key + number; the card opens at /project/<ref> */
  ref: string;
  title: string;
  description: string | null;
  /** backlog = in the backlog; otherwise the category of its column */
  status: TaskStatus;
  position: number;
  /** Ticket externo: { provider, id, identifier, url, state, meta } */
  external_ref: unknown | null;
  external_key: string | null;
  tab_id: string | null;
  /** Parent story/task for a subtask; null for every other card. */
  parent_id: string | null;
  /** The epic of a story/task/bug/spike; null on epics and subtasks. */
  epic_id: string | null;
  /** Board column; null in the backlog and on subtasks. */
  column_id: string | null;
  created_at: string;
  updated_at: string;
}

/** A board column of a project: the user's name, the system's category. */
export interface TaskColumn {
  id: string;
  project_id: string;
  name: string;
  category: ColumnCategory;
  position: number;
  created_at: string;
}
```

In `mapProject`, after `is_public: p.isPublic,` add `agent_column_id: p.agentColumnId,`.

Replace `mapTask` with:

```ts
/** `key`: the project's key, for `ref` (TasksRepository loads it with every task). */
export const mapTask = (t: PrismaTask, key: string): Task => ({
  id: t.id,
  project_id: t.projectId,
  type: t.type,
  number: t.number,
  ref: `${key}-${t.number}`,
  title: t.title,
  description: t.description,
  status: t.status,
  position: t.position,
  external_ref: t.externalRef ?? null,
  external_key: t.externalKey,
  tab_id: t.tabId,
  parent_id: t.parentId,
  epic_id: t.epicId,
  column_id: t.columnId,
  created_at: t.createdAt.toISOString(),
  updated_at: t.updatedAt.toISOString(),
});

export const mapTaskColumn = (c: PrismaTaskColumn): TaskColumn => ({
  id: c.id,
  project_id: c.projectId,
  name: c.name,
  category: c.category as ColumnCategory,
  position: c.position,
  created_at: c.createdAt.toISOString(),
});
```

- [ ] **Step 2: Write the transaction helpers**

`apps/server/src/db/repositories/task-board.ts`:

```ts
import type { Prisma } from '../../generated/prisma/client.js';
import { newId } from '../../lib/ids.js';
import { TaskRuleError } from './task-rules.js';
import type { ColumnCategory, TaskStatus, TaskType } from './types.js';

/** A transaction handle (`db.$transaction(async (tx) => …)`). */
export type Tx = Prisma.TransactionClient;

export const DEFAULT_COLUMNS: ReadonlyArray<{ name: string; category: ColumnCategory }> = [
  { name: 'A fazer', category: 'todo' },
  { name: 'Fazendo', category: 'doing' },
  { name: 'Feito', category: 'done' },
];

export const DEFAULT_EPIC_TITLE = 'Geral';

/**
 * Serializes every structural write on one project's board — positions, the default epic, columns.
 * Always taken first in a transaction (project row, then task rows), so writers never deadlock; the
 * numbering trigger locks the same row, which the transaction then already holds.
 */
export async function lockProject(tx: Tx, projectId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM "projects" WHERE id = ${projectId} FOR UPDATE`;
}

/** "A fazer", "Fazendo", "Feito" for a project that has no column (new, or made by the previous release). Caller holds the lock. */
export async function ensureDefaultColumns(tx: Tx, projectId: string): Promise<void> {
  if ((await tx.taskColumn.count({ where: { projectId } })) > 0) return;
  await tx.taskColumn.createMany({
    data: DEFAULT_COLUMNS.map((c, position) => ({ id: newId(), projectId, name: c.name, category: c.category, position })),
  });
}

/** The first column of a category, by position. Every category always keeps one (TaskColumnsRepository refuses to remove the last). */
export async function firstColumnId(tx: Tx, projectId: string, category: ColumnCategory): Promise<string> {
  await ensureDefaultColumns(tx, projectId);
  const c = await tx.taskColumn.findFirst({ where: { projectId, category }, orderBy: [{ position: 'asc' }, { createdAt: 'asc' }], select: { id: true } });
  if (!c) throw new TaskRuleError('COLUMN_NOT_FOUND');
  return c.id;
}

/** The project's default epic — the one with the lowest number — created as "Geral" in the backlog when there is none. Caller holds the lock. */
export async function defaultEpicId(tx: Tx, projectId: string): Promise<string> {
  const epic = await tx.task.findFirst({ where: { projectId, type: 'epic' }, orderBy: { number: 'asc' }, select: { id: true } });
  if (epic) return epic.id;
  const created = await tx.task.create({
    data: { id: newId(), projectId, type: 'epic', title: DEFAULT_EPIC_TITLE, status: 'backlog', position: 0 },
    select: { id: true },
  });
  return created.id;
}

/** `epicId` must be an epic of this project. */
export async function requireEpic(tx: Tx, projectId: string, epicId: string): Promise<string> {
  const epic = await tx.task.findFirst({ where: { id: epicId, projectId, type: 'epic' }, select: { id: true } });
  if (!epic) throw new TaskRuleError('EPIC_NOT_FOUND');
  return epic.id;
}

/** Where a top-level card sits, which decides what its `position` counts among (spec §2 "Position scope"). */
export interface Placement {
  status: TaskStatus;
  columnId: string | null;
  epicId: string | null;
  type: TaskType;
}

export const placementOf = (t: { status: TaskStatus; columnId: string | null; epicId: string | null; type: TaskType }): Placement => ({
  status: t.status,
  columnId: t.columnId,
  epicId: t.epicId,
  type: t.type,
});

/**
 * The cards sharing a position sequence: a board column; the backlog of one epic; the project's
 * backlog epics. A non-backlog card with no column (a row the previous release wrote, before
 * `normalize` heals it) counts among the column-less cards of its status.
 */
export function scopeWhere(projectId: string, p: Placement): Prisma.TaskWhereInput {
  if (p.status !== 'backlog') return p.columnId ? { columnId: p.columnId } : { projectId, status: p.status, columnId: null, parentId: null };
  if (p.type === 'epic') return { projectId, type: 'epic', status: 'backlog' };
  return { projectId, epicId: p.epicId, status: 'backlog', parentId: null, type: { notIn: ['epic', 'subtask'] } };
}

/** Where a card goes: a column of this project, or a status (backlog, or the first column of a category; default todo). */
export async function placementFor(
  tx: Tx,
  projectId: string,
  card: { type: TaskType; epicId: string | null },
  target: { column_id?: string | null; status?: TaskStatus },
): Promise<Placement> {
  if (target.column_id) {
    const col = await tx.taskColumn.findFirst({ where: { id: target.column_id, projectId }, select: { id: true, category: true } });
    if (!col) throw new TaskRuleError('COLUMN_NOT_FOUND');
    return { status: col.category, columnId: col.id, epicId: card.epicId, type: card.type };
  }
  const status = target.status ?? 'todo';
  if (status === 'backlog') return { status, columnId: null, epicId: card.epicId, type: card.type };
  return { status, columnId: await firstColumnId(tx, projectId, status), epicId: card.epicId, type: card.type };
}

/** Pulls up the cards after `position` in `from` (the card itself, `exceptId`, is left alone). */
export async function closeGap(tx: Tx, projectId: string, from: Placement, position: number, exceptId?: string): Promise<void> {
  await tx.task.updateMany({
    where: { ...scopeWhere(projectId, from), position: { gt: position }, ...(exceptId ? { id: { not: exceptId } } : {}) },
    data: { position: { decrement: 1 } },
  });
}

/** Makes room at `position` in `to` (clamped to 0..count) and returns the slot. */
export async function openSlot(tx: Tx, projectId: string, to: Placement, position: number, exceptId?: string): Promise<number> {
  const others = exceptId ? { id: { not: exceptId } } : {};
  const count = await tx.task.count({ where: { ...scopeWhere(projectId, to), ...others } });
  const slot = Math.max(0, Math.min(Math.trunc(position), count));
  await tx.task.updateMany({ where: { ...scopeWhere(projectId, to), position: { gte: slot }, ...others }, data: { position: { increment: 1 } } });
  return slot;
}

/** The position after the last card of `to`. */
export async function endOf(tx: Tx, projectId: string, to: Placement): Promise<number> {
  const agg = await tx.task.aggregate({ where: scopeWhere(projectId, to), _max: { position: true } });
  return (agg._max.position ?? -1) + 1;
}
```

- [ ] **Step 3: Write the failing repository tests**

Replace `apps/server/src/db/repositories/tasks.db.test.ts` with:

```ts
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
```

- [ ] **Step 4: Run it to see it fail**

```bash
thdb 'npx vitest run --root apps/server src/db/repositories/tasks.db.test.ts'; rm -rf .npm
```

Expected: FAIL — typecheck-free vitest still runs; failures such as `repo.findByRef is not a function`, `expected undefined to be 'task'` (no `type` on results), `repo.move(...)` signature mismatch.

- [ ] **Step 5: Rewrite the repository**

Replace `apps/server/src/db/repositories/tasks.ts` with:

```ts
import type { PrismaClient } from '../prisma.js';
import type { Task as PrismaTask } from '../../generated/prisma/client.js';
import { newId } from '../../lib/ids.js';
import { closeGap, defaultEpicId, endOf, ensureDefaultColumns, lockProject, openSlot, placementFor, placementOf, requireEpic, type Tx } from './task-board.js';
import { checkSubtaskParent, checkTypeChange, MAX_SUBTASKS_PER_CALL, PARENT_TYPES, TaskRuleError } from './task-rules.js';
import { nestTasks } from './task-tree.js';
import { mapTask, type OfficeProgress, type Task, type TaskStatus, type TaskType, type TaskWithSubtasks } from './types.js';

export { MAX_SUBTASKS_PER_CALL, TaskRuleError, type TaskRuleCode } from './task-rules.js';

/** Every query that maps a task loads its project's key, for `ref`. */
const KEY = { project: { select: { key: true } } } as const;
const toTask = (t: PrismaTask & { project: { key: string } }): Task => mapTask(t, t.project.key);

export interface TaskInput {
  title: string;
  description?: string | null;
  /** backlog, or a category (the card lands in the first column of it); default todo, backlog for an epic */
  status?: TaskStatus;
  /** default task; a subtask needs parent_id */
  type?: TaskType;
  /** story/task/bug/spike: its epic; absent or null = the project's default epic. Ignored for an epic. */
  epic_id?: string | null;
  /** a board column of the project; wins over status */
  column_id?: string | null;
  /** creates a subtask of this story or task */
  parent_id?: string | null;
}

/** What `update` changes. `epic_id` is ignored on epics and subtasks (they have none). */
export interface TaskPatch {
  title?: string;
  description?: string | null;
  status?: TaskStatus;
  type?: TaskType;
  epic_id?: string | null;
}

export interface SubtaskInput {
  title: string;
  description?: string | null;
  status?: TaskStatus;
}

/** Where `move` sends a card: a column of its project, or a status (backlog, or the first column of a category). */
export type MoveTarget = { column_id: string } | { status: TaskStatus };

export class TasksRepository {
  constructor(private db: PrismaClient) {}

  /** Every card of the project, subtasks nested under their parent (epics included: the backlog needs them). */
  async listByProject(projectId: string): Promise<TaskWithSubtasks[]> {
    const project = await this.db.project.findUnique({ where: { id: projectId }, select: { key: true } });
    if (!project) return [];
    const rows = await this.db.task.findMany({ where: { projectId }, orderBy: [{ status: 'asc' }, { position: 'asc' }, { createdAt: 'asc' }] });
    return nestTasks(rows.map((t) => mapTask(t, project.key)));
  }

  async findById(id: string): Promise<Task | undefined> {
    const t = await this.db.task.findUnique({ where: { id }, include: KEY });
    return t ? toTask(t) : undefined;
  }

  /** The card numbered `number` in the project (the `N` of `KEY-N`). */
  async findByRef(projectId: string, number: number): Promise<Task | undefined> {
    const t = await this.db.task.findUnique({ where: { projectId_number: { projectId, number } }, include: KEY });
    return t ? toTask(t) : undefined;
  }

  /**
   * Batched by id, one query regardless of how many ids are asked for, filtered to one owner's tasks
   * through their project — never "no filter": a caller that resolves names for one
   * person's screen (e.g. the chat action trail) must not be able to pass `null` and see everyone's.
   * Another owner's task id is simply absent from the result, like a row that does not exist.
   */
  async findByIdsForOwner(ids: string[], ownerId: string): Promise<Task[]> {
    if (ids.length === 0) return [];
    return (await this.db.task.findMany({ where: { id: { in: ids }, project: { ownerId } }, include: KEY })).map(toTask);
  }

  /** A top-level card lands at the top of its column (or of its epic's backlog); a subtask is appended to its parent. */
  async create(projectId: string, input: TaskInput): Promise<Task> {
    if (input.parent_id || input.type === 'subtask') {
      if (!input.parent_id) throw new TaskRuleError('PARENT_NOT_FOUND');
      const [subtask] = await this.createSubtasks(input.parent_id, [{ title: input.title, description: input.description, status: input.status }], projectId);
      return subtask;
    }
    return this.db.$transaction(async (tx) => toTask(await this.insertCard(tx, projectId, input)));
  }

  /**
   * A top-level card and its subtasks in one transaction (the MCP `create_task` tool): the card lands
   * at the top of its column, the subtasks in call order. All or nothing — every rule is checked
   * before anything is written.
   */
  async createWithSubtasks(projectId: string, input: Omit<TaskInput, 'parent_id'>, subtasks: SubtaskInput[]): Promise<TaskWithSubtasks> {
    if (subtasks.length > MAX_SUBTASKS_PER_CALL) throw new TaskRuleError('TOO_MANY_SUBTASKS');
    if (input.type === 'subtask') throw new TaskRuleError('PARENT_NOT_FOUND');
    if (subtasks.length > 0 && !PARENT_TYPES.includes(input.type ?? 'task')) throw new TaskRuleError('PARENT_TYPE');
    return this.db.$transaction(async (tx) => {
      const parent = await this.insertCard(tx, projectId, input);
      const rows = [toTask(parent)];
      for (const [position, item] of subtasks.entries()) {
        const t = await tx.task.create({
          data: { id: newId(), projectId, parentId: parent.id, type: 'subtask', title: item.title, description: item.description ?? null, status: item.status ?? 'todo', position },
          include: KEY,
        });
        rows.push(toTask(t));
      }
      return nestTasks(rows)[0];
    });
  }

  /** Validates type, epic and column, then writes a top-level card at slot 0 of its place. */
  private async insertCard(tx: Tx, projectId: string, input: Omit<TaskInput, 'parent_id'>) {
    await lockProject(tx, projectId);
    await ensureDefaultColumns(tx, projectId);
    const type = input.type ?? 'task';
    const epicId = type === 'epic' ? null : input.epic_id ? await requireEpic(tx, projectId, input.epic_id) : await defaultEpicId(tx, projectId);
    const to = await placementFor(tx, projectId, { type, epicId }, { column_id: input.column_id, status: input.status ?? (type === 'epic' ? 'backlog' : 'todo') });
    const position = await openSlot(tx, projectId, to, 0);
    return tx.task.create({
      data: { id: newId(), projectId, type, title: input.title, description: input.description ?? null, status: to.status, columnId: to.columnId, epicId, position },
      include: KEY,
    });
  }

  /**
   * Appends subtasks to `parentId` in one transaction. The parent must be a top-level story or task
   * (of `expectProjectId`, when given). Subtasks inherit the parent's project and have no epic or column.
   */
  async createSubtasks(parentId: string, items: SubtaskInput[], expectProjectId?: string): Promise<Task[]> {
    if (items.length > MAX_SUBTASKS_PER_CALL) throw new TaskRuleError('TOO_MANY_SUBTASKS');
    const found = await this.db.task.findUnique({ where: { id: parentId }, select: { projectId: true } });
    if (!found || (expectProjectId && found.projectId !== expectProjectId)) throw new TaskRuleError('PARENT_NOT_FOUND');
    return this.db.$transaction(async (tx) => {
      // The project lock serializes every writer of this board, concurrent appends to one parent included.
      await lockProject(tx, found.projectId);
      const parent = await tx.task.findUnique({ where: { id: parentId } });
      if (!parent) throw new TaskRuleError('PARENT_NOT_FOUND');
      checkSubtaskParent(parent);
      const agg = await tx.task.aggregate({ where: { parentId }, _max: { position: true } });
      let position = (agg._max.position ?? -1) + 1;
      const created: Task[] = [];
      for (const item of items) {
        const t = await tx.task.create({
          data: {
            id: newId(),
            projectId: parent.projectId,
            parentId,
            type: 'subtask',
            title: item.title,
            description: item.description ?? null,
            status: item.status ?? 'todo',
            position: position++,
          },
          include: KEY,
        });
        created.push(toTask(t));
      }
      return created;
    });
  }

  /** Ids of a task's subtasks (the route unlinks their tickets before a cascading delete). */
  async childIds(id: string): Promise<string[]> {
    const rows = await this.db.task.findMany({ where: { parentId: id }, select: { id: true } });
    return rows.map((r) => r.id);
  }

  /**
   * Title, description, type, epic and status. A subtask's status changes in place (the checklist);
   * a top-level card's status change is a move to the top of the first column of that category (or of
   * its epic's backlog). A backlog item that changes epic goes to the top of the new epic's backlog.
   */
  async update(id: string, patch: TaskPatch): Promise<Task | undefined> {
    return this.db.$transaction(async (tx) => {
      const found = await tx.task.findUnique({ where: { id }, select: { projectId: true } });
      if (!found) return undefined;
      await lockProject(tx, found.projectId);
      const cur = await tx.task.findUnique({ where: { id } });
      if (!cur) return undefined;
      const text = {
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.description !== undefined ? { description: patch.description } : {}),
      };
      if (cur.parentId) {
        if (patch.type && patch.type !== cur.type) throw new TaskRuleError('TYPE_LOCKED');
        return toTask(await tx.task.update({ where: { id }, data: { ...text, ...(patch.status ? { status: patch.status } : {}) }, include: KEY }));
      }
      const type = patch.type ?? cur.type;
      if (type !== cur.type) checkTypeChange(cur.type, type, await tx.task.count({ where: { parentId: id } }));
      let epicId = cur.epicId;
      if (type !== 'epic' && patch.epic_id !== undefined) {
        if (!patch.epic_id) throw new TaskRuleError('EPIC_REQUIRED');
        epicId = await requireEpic(tx, cur.projectId, patch.epic_id);
      }
      if (type !== 'epic' && !epicId) epicId = await defaultEpicId(tx, cur.projectId);

      const statusChanges = patch.status !== undefined && patch.status !== cur.status;
      const backlogEpicChanges = !statusChanges && cur.status === 'backlog' && epicId !== cur.epicId;
      let place = { status: cur.status as TaskStatus, columnId: cur.columnId, position: cur.position };
      if (statusChanges || backlogEpicChanges) {
        const to = await placementFor(tx, cur.projectId, { type, epicId }, { status: statusChanges ? patch.status : 'backlog' });
        await closeGap(tx, cur.projectId, placementOf(cur), cur.position, id);
        place = { status: to.status, columnId: to.columnId, position: await openSlot(tx, cur.projectId, to, 0, id) };
      }
      const t = await tx.task.update({ where: { id }, data: { ...text, type, epicId, status: place.status, columnId: place.columnId, position: place.position }, include: KEY });
      return toTask(t);
    });
  }

  /** Moves a top-level card to a column (or a status) at `position` (clamped), closing its old gap. */
  async move(id: string, target: MoveTarget, position: number): Promise<Task | undefined> {
    return this.db.$transaction(async (tx) => {
      const found = await tx.task.findUnique({ where: { id }, select: { projectId: true, parentId: true } });
      if (!found) return undefined;
      if (found.parentId) throw new TaskRuleError('SUBTASK_CANNOT_MOVE');
      await lockProject(tx, found.projectId);
      const cur = await tx.task.findUniqueOrThrow({ where: { id } });
      const epicId = cur.type === 'epic' ? null : (cur.epicId ?? (await defaultEpicId(tx, cur.projectId)));
      const to = await placementFor(tx, cur.projectId, { type: cur.type, epicId }, 'column_id' in target ? { column_id: target.column_id } : { status: target.status });
      await closeGap(tx, cur.projectId, placementOf(cur), cur.position, id);
      const slot = await openSlot(tx, cur.projectId, to, position, id);
      return toTask(await tx.task.update({ where: { id }, data: { status: to.status, columnId: to.columnId, epicId, position: slot }, include: KEY }));
    });
  }

  /**
   * An agent starts on the card (start_agent): a top-level card goes to the top of the project's agent
   * column — else the first `doing` column — unless it already sits in a doing column; a subtask is
   * marked doing.
   */
  async startWork(id: string): Promise<Task | undefined> {
    const cur = await this.findById(id);
    if (!cur) return undefined;
    if (cur.status === 'doing') return cur;
    if (cur.parent_id) return this.update(id, { status: 'doing' });
    const project = await this.db.project.findUnique({ where: { id: cur.project_id }, select: { agentColumnId: true } });
    return this.move(id, project?.agentColumnId ? { column_id: project.agentColumnId } : { status: 'doing' }, 0);
  }

  /** Moves a subtask to `position` among its siblings (clamped), reindexing them 0..n-1. */
  async reorder(id: string, position: number): Promise<Task | undefined> {
    const current = await this.findById(id);
    if (!current) return undefined;
    if (!current.parent_id) throw new TaskRuleError('NOT_A_SUBTASK');
    return this.db.$transaction(async (tx) => {
      await lockProject(tx, current.project_id);
      const siblings = await tx.task.findMany({ where: { parentId: current.parent_id }, orderBy: [{ position: 'asc' }, { createdAt: 'asc' }], select: { id: true, position: true } });
      const ids = siblings.map((s) => s.id).filter((s) => s !== id);
      ids.splice(Math.max(0, Math.min(Math.trunc(position), ids.length)), 0, id);
      for (const [i, siblingId] of ids.entries()) {
        if (siblings.find((s) => s.id === siblingId)?.position !== i) await tx.task.update({ where: { id: siblingId }, data: { position: i } });
      }
      const t = await tx.task.findUnique({ where: { id }, include: KEY });
      return t ? toTask(t) : undefined;
    });
  }

  /** Deletes the card (its subtasks cascade) and closes the gap it leaves. An epic with cards is refused. */
  async delete(id: string): Promise<boolean> {
    return this.db.$transaction(async (tx) => {
      const found = await tx.task.findUnique({ where: { id }, select: { projectId: true } });
      if (!found) return false;
      await lockProject(tx, found.projectId);
      const cur = await tx.task.findUnique({ where: { id } });
      if (!cur) return false;
      if (cur.type === 'epic' && (await tx.task.count({ where: { epicId: id } })) > 0) throw new TaskRuleError('EPIC_HAS_CHILDREN');
      await tx.task.delete({ where: { id } });
      if (cur.parentId) {
        await tx.task.updateMany({ where: { parentId: cur.parentId, position: { gt: cur.position } }, data: { position: { decrement: 1 } } });
      } else {
        await closeGap(tx, cur.projectId, placementOf(cur), cur.position);
      }
      return true;
    });
  }

  /** A synced ticket becomes a task at the end of the default epic's backlog (spec §5). */
  async createFromTicket(projectId: string, ticket: { key: string; title: string; description: string | null; ref: Record<string, unknown> }): Promise<Task> {
    return this.db.$transaction(async (tx) => {
      await lockProject(tx, projectId);
      await ensureDefaultColumns(tx, projectId);
      const epicId = await defaultEpicId(tx, projectId);
      const position = await endOf(tx, projectId, { status: 'backlog', columnId: null, epicId, type: 'task' });
      const t = await tx.task.create({
        data: {
          id: newId(),
          projectId,
          type: 'task',
          epicId,
          title: ticket.title,
          description: ticket.description,
          status: 'backlog',
          position,
          externalKey: ticket.key,
          externalRef: ticket.ref as object,
        },
        include: KEY,
      });
      return toTask(t);
    });
  }

  /** Atualiza só o espelho do ticket externo (estado/meta), sem mexer em título, coluna ou descrição. */
  async setExternalRef(id: string, ref: Record<string, unknown>): Promise<void> {
    await this.db.task.updateMany({ where: { id }, data: { externalRef: ref as object } });
  }

  async setTab(id: string, tabId: string | null): Promise<Task | undefined> {
    const t = await this.db.task.update({ where: { id }, data: { tabId }, include: KEY });
    return toTask(t);
  }

  /** Contagem de tasks abertas (todo + doing) por projeto. */
  async openCountByProject(): Promise<Record<string, number>> {
    const rows = await this.db.task.groupBy({ by: ['projectId'], where: { status: { in: ['todo', 'doing'] }, parentId: null }, _count: { _all: true } });
    return Object.fromEntries(rows.map((r) => [r.projectId, r._count._all]));
  }

  /** `owner`: only tasks of that user's projects (null = all). */
  async listDoing(owner: string | null = null): Promise<Task[]> {
    const rows = await this.db.task.findMany({
      where: { status: 'doing', parentId: null, ...(owner ? { project: { ownerId: owner } } : {}) },
      orderBy: [{ projectId: 'asc' }, { position: 'asc' }],
      include: KEY,
    });
    return rows.map(toTask);
  }

  /**
   * What the office floor shows of the board: per project, how many top-level tasks sit in
   * todo/doing/done (the backlog is not work in progress); per tab, the `doing` task bound to it
   * with its subtask counts. Two `doing` tasks on one tab: the first by position wins.
   */
  async officeProgress(projectIds: string[]): Promise<OfficeProgress> {
    if (projectIds.length === 0) return { counts: {}, byTab: {} };
    const [groups, bound] = await Promise.all([
      this.db.task.groupBy({
        by: ['projectId', 'status'],
        where: { projectId: { in: projectIds }, parentId: null, status: { in: ['todo', 'doing', 'done'] } },
        _count: { _all: true },
      }),
      this.db.task.findMany({
        where: { projectId: { in: projectIds }, parentId: null, status: 'doing', tabId: { not: null } },
        orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
        select: { id: true, title: true, tabId: true, subtasks: { select: { status: true } } },
      }),
    ]);
    const counts: OfficeProgress['counts'] = {};
    for (const g of groups) {
      const c = (counts[g.projectId] ??= { todo: 0, doing: 0, done: 0 });
      c[g.status as 'todo' | 'doing' | 'done'] = g._count._all;
    }
    const byTab: OfficeProgress['byTab'] = {};
    for (const t of bound) {
      if (!t.tabId || byTab[t.tabId]) continue;
      byTab[t.tabId] = { task_id: t.id, title: t.title, done: t.subtasks.filter((s) => s.status === 'done').length, total: t.subtasks.length };
    }
    return { counts, byTab };
  }
}
```

(The unused `stableStringify` helper of the old file is dropped: nothing called it.)

- [ ] **Step 6: Keep the callers compiling (new `move` signature)**

In `apps/server/src/routes/tasks.ts`, in the `/:id/move` handler, replace

```ts
    const task = await rules(() => repos.tasks.move(id, body.status, body.position));
```

with

```ts
    const task = await rules(() => repos.tasks.move(id, { status: body.status }, body.position));
```

In `apps/server/src/control/tasks.ts`, in `moveTask`, replace

```ts
  const moved = await rules(() => ctx.repos.tasks.move(task.id, input.status, input.position ?? 0));
```

with

```ts
  const moved = await rules(() => ctx.repos.tasks.move(task.id, { status: input.status }, input.position ?? 0));
```

In `apps/server/src/control/tasks.test.ts`, replace `expect(repos.tasks.move).toHaveBeenCalledWith('k2', 'doing', 0);` with `expect(repos.tasks.move).toHaveBeenCalledWith('k2', { status: 'doing' }, 0);` and `expect(repos.tasks.move).toHaveBeenCalledWith('k2', 'done', 3);` with `expect(repos.tasks.move).toHaveBeenCalledWith('k2', { status: 'done' }, 3);`.

- [ ] **Step 7: Run the tests and the typecheck**

```bash
thdb 'npx vitest run --root apps/server src/db/repositories/tasks.db.test.ts src/db/repositories/task-tree.test.ts src/control/tasks.test.ts src/routes/tasks.test.ts && npm run typecheck -w @termhub/server'; rm -rf .npm
```

Expected: PASS, typecheck clean.

- [ ] **Step 8: Full server suite**

```bash
thdb 'npm test -w @termhub/server'; rm -rf .npm
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/server/src/db/repositories/types.ts apps/server/src/db/repositories/task-board.ts apps/server/src/db/repositories/tasks.ts apps/server/src/db/repositories/tasks.db.test.ts apps/server/src/routes/tasks.ts apps/server/src/control/tasks.ts apps/server/src/control/tasks.test.ts
git commit -m "Tasks: types, mandatory epics, numbers, per-column positions" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: TaskColumnsRepository and default columns on project create

**Files:**
- Create: `apps/server/src/db/repositories/task-columns.ts`
- Modify: `apps/server/src/db/repositories/projects.ts` (`create`), `apps/server/src/db/repositories/index.ts`
- Test: `apps/server/src/db/repositories/task-columns.db.test.ts` (new)

**Interfaces:**
- Consumes: Task 3 `lockProject`, `ensureDefaultColumns`, `Tx`, `mapTaskColumn`, `TaskColumn`, `ColumnCategory`; Task 2 `MAX_COLUMNS`, `TaskRuleError`.
- Produces: `class TaskColumnsRepository` with
  ```ts
  list(projectId): Promise<TaskColumn[]>                       // by position
  findById(id): Promise<TaskColumn | undefined>
  ensureDefaults(projectId): Promise<void>
  create(projectId, { name, category }): Promise<TaskColumn>    // appended; TOO_MANY_COLUMNS at 12
  rename(id, name): Promise<TaskColumn | undefined>
  setCategory(id, category): Promise<TaskColumn | undefined>    // cards' status follows; COLUMN_LAST_OF_CATEGORY; clears the agent column when it leaves doing
  move(id, position): Promise<TaskColumn[] | undefined>         // the new order
  delete(id): Promise<{ moved_tasks: number } | undefined>      // cards → end of first other column of the category; COLUMN_LAST_OF_CATEGORY
  setAgentColumn(projectId, columnId | null): Promise<void>     // COLUMN_NOT_FOUND; COLUMN_NOT_DOING unless category = doing
  ```
  and `Repositories.taskColumns`. `ProjectsRepository.create` creates the default columns in the same transaction.

- [ ] **Step 1: Write the failing test**

`apps/server/src/db/repositories/task-columns.db.test.ts`:

```ts
import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../generated/prisma/client.js';
import { newId } from '../../lib/ids.js';
import { ProjectsRepository } from './projects.js';
import { TaskColumnsRepository } from './task-columns.js';

const keyOf = (id: string) => 'K' + id.replace(/[^a-z0-9]/gi, '').slice(0, 8).toUpperCase();

// Needs a migrated Postgres: TERMHUB_DB_TESTS=1 DATABASE_URL=… (CI sets both).
describe.skipIf(process.env.TERMHUB_DB_TESTS !== '1')('TaskColumnsRepository (Postgres)', () => {
  let db: PrismaClient;
  let repo: TaskColumnsRepository;
  let projectId: string;

  beforeAll(() => {
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
    repo = new TaskColumnsRepository(db);
  });

  beforeEach(async () => {
    projectId = newId();
    await db.project.create({ data: { id: projectId, key: keyOf(projectId), name: 'p' } });
    return async () => {
      await db.project.deleteMany({ where: { id: projectId } });
    };
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  const names = async () => (await repo.list(projectId)).map((c) => `${c.name}:${c.category}:${c.position}`);
  /** A top-level card placed straight in a column (TasksRepository is not under test here). */
  const card = async (columnId: string, category: 'todo' | 'doing' | 'done', position: number) =>
    (await db.task.create({ data: { id: newId(), projectId, title: `c${position}`, status: category, columnId, position } })).id;

  it('a new project comes with A fazer, Fazendo and Feito', async () => {
    const p = await new ProjectsRepository(db).create({ owner_id: null, key: keyOf(newId()), name: 'novo' });
    try {
      expect((await repo.list(p.id)).map((c) => [c.name, c.category, c.position])).toEqual([
        ['A fazer', 'todo', 0],
        ['Fazendo', 'doing', 1],
        ['Feito', 'done', 2],
      ]);
      expect(p.agent_column_id).toBeNull();
    } finally {
      await db.project.delete({ where: { id: p.id } });
    }
  });

  it('ensureDefaults fills a project without columns exactly once, even concurrently', async () => {
    await Promise.all([repo.ensureDefaults(projectId), repo.ensureDefaults(projectId), repo.ensureDefaults(projectId)]);
    expect(await names()).toEqual(['A fazer:todo:0', 'Fazendo:doing:1', 'Feito:done:2']);
  });

  it('appends a column and refuses the 13th', async () => {
    await repo.ensureDefaults(projectId);
    expect(await repo.create(projectId, { name: 'QA', category: 'doing' })).toMatchObject({ name: 'QA', category: 'doing', position: 3, project_id: projectId });
    for (let i = 0; i < 8; i++) await repo.create(projectId, { name: `c${i}`, category: 'todo' });
    await expect(repo.create(projectId, { name: 'x', category: 'todo' })).rejects.toMatchObject({ code: 'TOO_MANY_COLUMNS', message: 'Limite de 12 colunas' });
    expect(await repo.list(projectId)).toHaveLength(12);
  });

  it('renames and reorders, keeping positions compact', async () => {
    await repo.ensureDefaults(projectId);
    const [todo, , done] = await repo.list(projectId);
    await repo.rename(todo.id, 'Pronto p/ começar');
    expect((await repo.move(done.id, 0))?.map((c) => c.name)).toEqual(['Feito', 'Pronto p/ começar', 'Fazendo']);
    expect(await names()).toEqual(['Feito:done:0', 'Pronto p/ começar:todo:1', 'Fazendo:doing:2']);
    expect(await repo.rename('nope', 'x')).toBeUndefined();
    expect(await repo.move('nope', 0)).toBeUndefined();
  });

  it('changing the category carries the status of its cards along; the last of a category cannot change', async () => {
    await repo.ensureDefaults(projectId);
    const [todo, doing] = await repo.list(projectId);
    const review = await repo.create(projectId, { name: 'Em revisão', category: 'todo' });
    const c = await card(review.id, 'todo', 0);
    expect(await repo.setCategory(review.id, 'doing')).toMatchObject({ category: 'doing' });
    expect((await db.task.findUniqueOrThrow({ where: { id: c } })).status).toBe('doing');
    await expect(repo.setCategory(todo.id, 'done')).rejects.toMatchObject({ code: 'COLUMN_LAST_OF_CATEGORY', message: 'O board precisa de ao menos uma coluna de cada tipo' });
    expect((await repo.findById(doing.id))?.category).toBe('doing');
    // the agent column stops being one when it leaves doing
    await repo.setAgentColumn(projectId, review.id);
    expect(await repo.setCategory(review.id, 'done')).toMatchObject({ category: 'done' });
    expect((await db.project.findUniqueOrThrow({ where: { id: projectId } })).agentColumnId).toBeNull();
  });

  it('deleting a column moves its cards to the end of the first other column of that category', async () => {
    await repo.ensureDefaults(projectId);
    const [, doing] = await repo.list(projectId);
    const qa = await repo.create(projectId, { name: 'QA', category: 'doing' });
    const kept = await card(doing.id, 'doing', 0);
    const a = await card(qa.id, 'doing', 0);
    const b = await card(qa.id, 'doing', 1);
    expect(await repo.delete(qa.id)).toEqual({ moved_tasks: 2 });
    const rows = await db.task.findMany({ where: { projectId }, orderBy: { position: 'asc' } });
    expect(rows.map((r) => [r.id, r.columnId, r.position])).toEqual([[kept, doing.id, 0], [a, doing.id, 1], [b, doing.id, 2]]);
    expect(await names()).toEqual(['A fazer:todo:0', 'Fazendo:doing:1', 'Feito:done:2']);
    expect(await repo.delete('nope')).toBeUndefined();
  });

  it('refuses to delete the last column of a category', async () => {
    await repo.ensureDefaults(projectId);
    const [, , done] = await repo.list(projectId);
    await expect(repo.delete(done.id)).rejects.toMatchObject({ code: 'COLUMN_LAST_OF_CATEGORY' });
    expect(await repo.list(projectId)).toHaveLength(3);
  });

  it('the agent column must be a doing column of the project, and falls back to automatic when it is deleted', async () => {
    await repo.ensureDefaults(projectId);
    const [todo] = await repo.list(projectId);
    const qa = await repo.create(projectId, { name: 'QA', category: 'doing' });
    await repo.setAgentColumn(projectId, qa.id);
    expect((await db.project.findUniqueOrThrow({ where: { id: projectId } })).agentColumnId).toBe(qa.id);
    await repo.delete(qa.id);
    expect((await db.project.findUniqueOrThrow({ where: { id: projectId } })).agentColumnId).toBeNull();
    await expect(repo.setAgentColumn(projectId, 'nope')).rejects.toMatchObject({ code: 'COLUMN_NOT_FOUND' });
    await expect(repo.setAgentColumn(projectId, todo.id)).rejects.toMatchObject({ code: 'COLUMN_NOT_DOING', message: 'A coluna do agente precisa ser do tipo Fazendo' });
    await repo.setAgentColumn(projectId, null);
  });

  it('deleting a project whose agent column is set removes it cleanly', async () => {
    await repo.ensureDefaults(projectId);
    const [, doing] = await repo.list(projectId);
    await repo.setAgentColumn(projectId, doing.id);
    await card(doing.id, 'doing', 0);
    await db.project.delete({ where: { id: projectId } });
    expect(await db.taskColumn.count({ where: { projectId } })).toBe(0);
    expect(await db.task.count({ where: { projectId } })).toBe(0);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

```bash
thdb 'npx vitest run --root apps/server src/db/repositories/task-columns.db.test.ts'; rm -rf .npm
```

Expected: FAIL — cannot find module `./task-columns.js`.

- [ ] **Step 3: Implement the repository**

`apps/server/src/db/repositories/task-columns.ts`:

```ts
import type { PrismaClient } from '../prisma.js';
import { newId } from '../../lib/ids.js';
import { ensureDefaultColumns, lockProject, type Tx } from './task-board.js';
import { MAX_COLUMNS, TaskRuleError } from './task-rules.js';
import { mapTaskColumn, type ColumnCategory, type TaskColumn } from './types.js';

const ORDER = [{ position: 'asc' as const }, { createdAt: 'asc' as const }];

/** A project's board columns (spec §2 `task_columns`, rules §3 "Columns"). Every write locks the project. */
export class TaskColumnsRepository {
  constructor(private db: PrismaClient) {}

  async list(projectId: string): Promise<TaskColumn[]> {
    return (await this.db.taskColumn.findMany({ where: { projectId }, orderBy: ORDER })).map(mapTaskColumn);
  }

  async findById(id: string): Promise<TaskColumn | undefined> {
    const c = await this.db.taskColumn.findUnique({ where: { id } });
    return c ? mapTaskColumn(c) : undefined;
  }

  /** "A fazer", "Fazendo", "Feito" for a project with no column (one made by the previous release). */
  async ensureDefaults(projectId: string): Promise<void> {
    await this.db.$transaction(async (tx) => {
      await lockProject(tx, projectId);
      await ensureDefaultColumns(tx, projectId);
    });
  }

  /** Appended at the end. At most MAX_COLUMNS per project. */
  async create(projectId: string, input: { name: string; category: ColumnCategory }): Promise<TaskColumn> {
    return this.db.$transaction(async (tx) => {
      await lockProject(tx, projectId);
      await ensureDefaultColumns(tx, projectId);
      const count = await tx.taskColumn.count({ where: { projectId } });
      if (count >= MAX_COLUMNS) throw new TaskRuleError('TOO_MANY_COLUMNS');
      const c = await tx.taskColumn.create({ data: { id: newId(), projectId, name: input.name, category: input.category, position: count } });
      return mapTaskColumn(c);
    });
  }

  async rename(id: string, name: string): Promise<TaskColumn | undefined> {
    const r = await this.db.taskColumn.updateMany({ where: { id }, data: { name } });
    return r.count ? this.findById(id) : undefined;
  }

  /** The column's cards take the new category as their status in the same transaction. */
  async setCategory(id: string, category: ColumnCategory): Promise<TaskColumn | undefined> {
    return this.db.$transaction(async (tx) => {
      const col = await this.locked(tx, id);
      if (!col) return undefined;
      if (col.category !== category) {
        await this.refuseLastOfCategory(tx, col);
        await tx.taskColumn.update({ where: { id }, data: { category } });
        await tx.task.updateMany({ where: { columnId: id }, data: { status: category } });
        // the agent column must stay a doing column; otherwise the project goes back to automatic
        if (category !== 'doing') await tx.project.updateMany({ where: { id: col.projectId, agentColumnId: id }, data: { agentColumnId: null } });
      }
      return mapTaskColumn(await tx.taskColumn.findUniqueOrThrow({ where: { id } }));
    });
  }

  /** Moves the column to `position` (clamped) and answers the project's columns in their new order. */
  async move(id: string, position: number): Promise<TaskColumn[] | undefined> {
    return this.db.$transaction(async (tx) => {
      const col = await this.locked(tx, id);
      if (!col) return undefined;
      const cols = await tx.taskColumn.findMany({ where: { projectId: col.projectId }, orderBy: ORDER, select: { id: true, position: true } });
      const ids = cols.map((c) => c.id).filter((c) => c !== id);
      ids.splice(Math.max(0, Math.min(Math.trunc(position), ids.length)), 0, id);
      for (const [i, colId] of ids.entries()) {
        if (cols.find((c) => c.id === colId)?.position !== i) await tx.taskColumn.update({ where: { id: colId }, data: { position: i } });
      }
      return (await tx.taskColumn.findMany({ where: { projectId: col.projectId }, orderBy: ORDER })).map(mapTaskColumn);
    });
  }

  /**
   * Deletes the column; its cards go, in order, to the end of the first other column of the same
   * category. A project that pointed its agent column here falls back to automatic (FK SET NULL).
   */
  async delete(id: string): Promise<{ moved_tasks: number } | undefined> {
    return this.db.$transaction(async (tx) => {
      const col = await this.locked(tx, id);
      if (!col) return undefined;
      const target = await tx.taskColumn.findFirst({ where: { projectId: col.projectId, category: col.category, id: { not: id } }, orderBy: ORDER, select: { id: true } });
      if (!target) throw new TaskRuleError('COLUMN_LAST_OF_CATEGORY');
      const cards = await tx.task.findMany({ where: { columnId: id }, orderBy: [{ position: 'asc' }, { createdAt: 'asc' }], select: { id: true } });
      const agg = await tx.task.aggregate({ where: { columnId: target.id }, _max: { position: true } });
      let next = (agg._max.position ?? -1) + 1;
      for (const c of cards) await tx.task.update({ where: { id: c.id }, data: { columnId: target.id, position: next++ } });
      await tx.taskColumn.delete({ where: { id } });
      const rest = await tx.taskColumn.findMany({ where: { projectId: col.projectId }, orderBy: ORDER, select: { id: true, position: true } });
      for (const [i, c] of rest.entries()) if (c.position !== i) await tx.taskColumn.update({ where: { id: c.id }, data: { position: i } });
      return { moved_tasks: cards.length };
    });
  }

  /** null = automatic (the first `doing` column). A set column must be one of the project's `doing` columns. */
  async setAgentColumn(projectId: string, columnId: string | null): Promise<void> {
    await this.db.$transaction(async (tx) => {
      if (columnId) {
        const col = await tx.taskColumn.findFirst({ where: { id: columnId, projectId }, select: { category: true } });
        if (!col) throw new TaskRuleError('COLUMN_NOT_FOUND');
        if (col.category !== 'doing') throw new TaskRuleError('COLUMN_NOT_DOING');
      }
      await tx.project.update({ where: { id: projectId }, data: { agentColumnId: columnId } });
    });
  }

  /** The column, re-read after locking its project (null when it does not exist). */
  private async locked(tx: Tx, id: string) {
    const col = await tx.taskColumn.findUnique({ where: { id }, select: { projectId: true } });
    if (!col) return null;
    await lockProject(tx, col.projectId);
    return tx.taskColumn.findUnique({ where: { id } });
  }

  private async refuseLastOfCategory(tx: Tx, col: { id: string; projectId: string; category: string }): Promise<void> {
    const others = await tx.taskColumn.count({ where: { projectId: col.projectId, category: col.category as ColumnCategory, id: { not: col.id } } });
    if (others === 0) throw new TaskRuleError('COLUMN_LAST_OF_CATEGORY');
  }
}
```

- [ ] **Step 4: Default columns when a project is created, and register the repository**

In `apps/server/src/db/repositories/projects.ts`, add `import { ensureDefaultColumns } from './task-board.js';` and replace the body of `create` after the two `KEY_*` checks — the block

```ts
    const p = await this.db.project.create({
      data: {
        id: newId(),
        ownerId: input.owner_id,
        key: input.key,
        name: input.name,
        status: input.status ?? 'active',
        description: input.description ?? null,
        isPublic: input.is_public ?? false,
      },
    });
    return mapProject(p);
```

with

```ts
    return this.db.$transaction(async (tx) => {
      const p = await tx.project.create({
        data: {
          id: newId(),
          ownerId: input.owner_id,
          key: input.key,
          name: input.name,
          status: input.status ?? 'active',
          description: input.description ?? null,
          isPublic: input.is_public ?? false,
        },
      });
      // Every board starts with "A fazer", "Fazendo", "Feito" (spec §2).
      await ensureDefaultColumns(tx, p.id);
      return mapProject(p);
    });
```

In `apps/server/src/db/repositories/index.ts`: add `import { TaskColumnsRepository } from './task-columns.js';` after the `TasksRepository` import; add `taskColumns: TaskColumnsRepository;` after `tasks: TasksRepository;` in `Repositories`; add `taskColumns: new TaskColumnsRepository(db),` after `tasks: new TasksRepository(db),` in `createRepositories`; and at the end add:

```ts
export { TaskRuleError } from './task-rules.js';
export type { TaskRuleCode } from './task-rules.js';
```

- [ ] **Step 5: Run the tests and the typecheck**

```bash
thdb 'npx vitest run --root apps/server src/db/repositories/task-columns.db.test.ts src/db/repositories/projects.db.test.ts && npm run typecheck -w @termhub/server'; rm -rf .npm
```

Expected: PASS, typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/db/repositories/task-columns.ts apps/server/src/db/repositories/task-columns.db.test.ts apps/server/src/db/repositories/projects.ts apps/server/src/db/repositories/index.ts
git commit -m "Tasks: per-project board columns repository and default columns" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Healing rows from the previous release, and counts over work types only

**Files:**
- Modify: `apps/server/src/db/repositories/tasks.ts` (`listByProject`, new `normalize`, `openCountByProject`, `listDoing`, `officeProgress`)
- Test: `apps/server/src/db/repositories/tasks.db.test.ts` (append two describe blocks)

**Interfaces:**
- Consumes: Task 3 `firstColumnId`, `defaultEpicId`, `ensureDefaultColumns`, `lockProject`; Task 2 `WORK_TYPES`.
- Produces: `TasksRepository.normalize(projectId): Promise<void>` (idempotent, a no-op without legacy rows); `listByProject` calls it first. `openCountByProject`, `listDoing`, `officeProgress` count only top-level `story/task/bug/spike`. The dashboard, office and projects list routes need no change: they read these methods.

- [ ] **Step 1: Write the failing tests**

In `apps/server/src/db/repositories/tasks.db.test.ts`, before the final `});` of the file, add:

```ts
  describe('normalize (rows written by the previous release)', () => {
    it('heals a board the old container wrote: columns, the default epic, board columns and subtask types', async () => {
      // shaped like the previous release's inserts: no type/epic/column, and a project without columns
      const todo = await db.task.create({ data: { id: newId(), projectId, title: 'old todo', status: 'todo', position: 0 } });
      const back = await db.task.create({ data: { id: newId(), projectId, title: 'old backlog', status: 'backlog', position: 0 } });
      const sub = await db.task.create({ data: { id: newId(), projectId, parentId: todo.id, title: 'old sub', status: 'todo', position: 0 } });

      const list = await repo.listByProject(projectId);

      const [epic] = await epics();
      expect(epic.title).toBe('Geral');
      expect((await db.taskColumn.findMany({ where: { projectId }, orderBy: { position: 'asc' } })).map((c) => c.name)).toEqual(['A fazer', 'Fazendo', 'Feito']);
      expect(await db.task.findUniqueOrThrow({ where: { id: todo.id } })).toMatchObject({ epicId: epic.id, columnId: (await column('todo')).id, status: 'todo' });
      expect(await db.task.findUniqueOrThrow({ where: { id: back.id } })).toMatchObject({ epicId: epic.id, columnId: null, status: 'backlog' });
      expect(await db.task.findUniqueOrThrow({ where: { id: sub.id } })).toMatchObject({ type: 'subtask', epicId: null, columnId: null });
      expect(list.find((t) => t.id === todo.id)?.subtasks.map((s) => s.id)).toEqual([sub.id]);
      expect(list.find((t) => t.id === todo.id)?.ref).toBe(`${key}-${todo.number}`);
    });

    it('appends a card that lost its column to the end of the first column of its category', async () => {
      await repo.create(projectId, { title: 'a', status: 'doing' });
      const qa = await addColumn('QA', 'doing', 3);
      await repo.create(projectId, { title: 'b', column_id: qa.id });
      await db.taskColumn.delete({ where: { id: qa.id } }); // a raw delete leaves b with column_id NULL (FK SET NULL)
      await repo.listByProject(projectId);
      expect(await inColumn((await column('doing')).id)).toEqual(['a', 'b']);
    });

    it('writes nothing when the board is healthy', async () => {
      const t = await repo.create(projectId, { title: 't' });
      const before = await db.task.findUniqueOrThrow({ where: { id: t.id } });
      await repo.listByProject(projectId);
      expect((await db.task.findUniqueOrThrow({ where: { id: t.id } })).updatedAt).toEqual(before.updatedAt);
      expect(await db.taskColumn.count({ where: { projectId } })).toBe(3);
    });
  });

  describe('counts', () => {
    it('count only stories, tasks, bugs and spikes — never epics or subtasks', async () => {
      const t = await repo.create(projectId, { title: 't', status: 'todo' });
      await repo.create(projectId, { title: 'bug', type: 'bug', status: 'doing' });
      await repo.create(projectId, { title: 'epic on the board', type: 'epic', status: 'doing' });
      const [s] = await repo.createSubtasks(t.id, [{ title: 's' }]);
      await repo.update(s.id, { status: 'doing' });
      expect((await repo.openCountByProject())[projectId]).toBe(2);
      expect(titles((await repo.listDoing()).filter((x) => x.project_id === projectId))).toEqual(['bug']);
      expect((await repo.officeProgress([projectId])).counts[projectId]).toEqual({ todo: 1, doing: 1, done: 0 });
    });
  });
```

- [ ] **Step 2: Run them to see them fail**

```bash
thdb 'npx vitest run --root apps/server src/db/repositories/tasks.db.test.ts -t "normalize|counts"'; rm -rf .npm
```

Expected: FAIL — "heals a board…" (no columns, epic undefined), "appends a card…" (`['a']`), "count only…" (open count 3, `listDoing` includes the epic).

- [ ] **Step 3: Implement**

In `apps/server/src/db/repositories/tasks.ts`:

Change the `task-board.js` import to also bring `firstColumnId`:

```ts
import { closeGap, defaultEpicId, endOf, ensureDefaultColumns, firstColumnId, lockProject, openSlot, placementFor, placementOf, requireEpic, type Tx } from './task-board.js';
```

and the `task-rules.js` import to also bring `WORK_TYPES`:

```ts
import { checkSubtaskParent, checkTypeChange, MAX_SUBTASKS_PER_CALL, PARENT_TYPES, TaskRuleError, WORK_TYPES } from './task-rules.js';
```

After the `toTask` line add:

```ts
/** The work the counters count: top-level stories, tasks, bugs and spikes (epics group, subtasks are checklist items). */
const WORK = { parentId: null, type: { in: WORK_TYPES } };
```

Replace `listByProject` with:

```ts
  /** Every card of the project, subtasks nested under their parent (epics included: the backlog needs them). Heals legacy rows first. */
  async listByProject(projectId: string): Promise<TaskWithSubtasks[]> {
    await this.normalize(projectId);
    const project = await this.db.project.findUnique({ where: { id: projectId }, select: { key: true } });
    if (!project) return [];
    const rows = await this.db.task.findMany({ where: { projectId }, orderBy: [{ status: 'asc' }, { position: 'asc' }, { createdAt: 'asc' }] });
    return nestTasks(rows.map((t) => mapTask(t, project.key)));
  }

  /**
   * Heals what the previous release writes during a blue/green switch (spec §3): a project without
   * columns gets the defaults; a row with a parent becomes a subtask; a top-level non-epic card with
   * no epic joins the default epic (appended to its backlog when it is in the backlog); a non-backlog
   * top-level card with no column is appended to the first column of its category. Four cheap counts
   * decide; a healthy board is not written to.
   */
  async normalize(projectId: string): Promise<void> {
    const legacySubtasks = { projectId, parentId: { not: null }, type: { not: 'subtask' as const } };
    const orphans = { projectId, parentId: null, epicId: null, type: { notIn: ['epic' as const, 'subtask' as const] } };
    const homeless = { projectId, parentId: null, columnId: null, status: { not: 'backlog' as const } };
    const [columns, subs, noEpic, noColumn] = await Promise.all([
      this.db.taskColumn.count({ where: { projectId } }),
      this.db.task.count({ where: legacySubtasks }),
      this.db.task.count({ where: orphans }),
      this.db.task.count({ where: homeless }),
    ]);
    if (columns > 0 && subs + noEpic + noColumn === 0) return;
    await this.db.$transaction(async (tx) => {
      await lockProject(tx, projectId);
      await ensureDefaultColumns(tx, projectId);
      await tx.task.updateMany({ where: legacySubtasks, data: { type: 'subtask', epicId: null, columnId: null } });
      const noEpicRows = await tx.task.findMany({ where: orphans, orderBy: [{ position: 'asc' }, { createdAt: 'asc' }] });
      if (noEpicRows.length > 0) {
        const epicId = await defaultEpicId(tx, projectId);
        let next = await endOf(tx, projectId, { status: 'backlog', columnId: null, epicId, type: 'task' });
        for (const t of noEpicRows) await tx.task.update({ where: { id: t.id }, data: { epicId, ...(t.status === 'backlog' ? { position: next++ } : {}) } });
      }
      for (const category of ['todo', 'doing', 'done'] as const) {
        const rows = await tx.task.findMany({ where: { ...homeless, status: category }, orderBy: [{ position: 'asc' }, { createdAt: 'asc' }] });
        if (rows.length === 0) continue;
        const columnId = await firstColumnId(tx, projectId, category);
        let next = await endOf(tx, projectId, { status: category, columnId, epicId: null, type: 'task' });
        for (const t of rows) await tx.task.update({ where: { id: t.id }, data: { columnId, position: next++ } });
      }
    });
  }
```

Replace `openCountByProject`, `listDoing` and the `groups`/`bound` queries of `officeProgress`:

```ts
  /** Open work (todo + doing) per project: stories, tasks, bugs and spikes. */
  async openCountByProject(): Promise<Record<string, number>> {
    const rows = await this.db.task.groupBy({ by: ['projectId'], where: { status: { in: ['todo', 'doing'] }, ...WORK }, _count: { _all: true } });
    return Object.fromEntries(rows.map((r) => [r.projectId, r._count._all]));
  }

  /** `owner`: only tasks of that user's projects (null = all). Work types only. */
  async listDoing(owner: string | null = null): Promise<Task[]> {
    const rows = await this.db.task.findMany({
      where: { status: 'doing', ...WORK, ...(owner ? { project: { ownerId: owner } } : {}) },
      orderBy: [{ projectId: 'asc' }, { position: 'asc' }],
      include: KEY,
    });
    return rows.map(toTask);
  }
```

and inside `officeProgress` replace the two `where` clauses:

```ts
        where: { projectId: { in: projectIds }, ...WORK, status: { in: ['todo', 'doing', 'done'] } },
```

```ts
        where: { projectId: { in: projectIds }, ...WORK, status: 'doing', tabId: { not: null } },
```

- [ ] **Step 4: Run the repository tests and the typecheck**

```bash
thdb 'npx vitest run --root apps/server src/db/repositories/tasks.db.test.ts && npm run typecheck -w @termhub/server'; rm -rf .npm
```

Expected: PASS, typecheck clean.

- [ ] **Step 5: Full server suite (dashboard, office and projects routes read these counts)**

```bash
thdb 'npm test -w @termhub/server'; rm -rf .npm
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/db/repositories/tasks.ts apps/server/src/db/repositories/tasks.db.test.ts
git commit -m "Tasks: heal legacy rows on read; count only work types" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: REST routes — tasks, card refs, columns, agent column

**Files:**
- Modify: `apps/server/src/auth/scope.ts` (imports; new `taskByRef`, `column`)
- Modify (full rewrite): `apps/server/src/routes/tasks.ts`
- Create: `apps/server/src/routes/columns.ts`
- Modify: `apps/server/src/app.ts` (imports ~17, `guarded('tasks', …)` lines ~166–168)
- Test: `apps/server/src/auth/scope.test.ts` (fixture + two cases), `apps/server/src/routes/tasks.test.ts` (full rewrite), `apps/server/src/routes/columns.test.ts` (new)

**Interfaces:**
- Consumes: Task 3 `TaskInput`, `TaskPatch`, `MoveTarget`, `findByRef`; Task 4 `Repositories.taskColumns`; Task 2 `parseRef`, `COLUMN_NAME_MAX`, `TaskRuleError`, `TaskRuleCode`.
- Produces (scope.ts): `Scoped.taskByRef(ref): Promise<{ task: Task; project: Project }>` (404 "Card não encontrado"), `Scoped.column(id): Promise<{ column: TaskColumn; project: Project }>` (404 "Coluna não encontrada").
- Produces (routes/tasks.ts): `taskRules<T>(run): Promise<T>` (TaskRuleError → 400, or 409 for `EPIC_HAS_CHILDREN`/`COLUMN_LAST_OF_CATEGORY`); `GET /projects/:id/tasks → { tasks, columns, agent_column_id }`; `POST /projects/:id/tasks` body `{ title, description?, status?, type?, epic_id?, column_id?, parent_id? }`; `PATCH /tasks/:id` body `{ title?, description?, status?, type?, epic_id? }`; `POST /tasks/:id/move` body `{ column_id, position }` xor `{ status, position }`; `GET /tasks/by-ref/:ref → { task, project_id }`.
- Produces (routes/columns.ts): `projectColumnRoutes` (under `/projects`): `GET /:id/columns → { columns, agent_column_id }`, `POST /:id/columns { name, category } → 201 { column }`, `PUT /:id/agent-column { column_id: string | null } → { agent_column_id }`; `columnRoutes` (under `/columns`): `PATCH /:id { name?, category? } → { column }`, `POST /:id/move { position } → { columns }`, `DELETE /:id → { ok: true, moved_tasks }`. All under the `tasks` permission resource.

- [ ] **Step 1: Write the failing scope tests**

In `apps/server/src/auth/scope.test.ts`, inside `fakeRepos()`:
- change `{ id: 'p1', owner_id: 'alice' },` to `{ id: 'p1', owner_id: 'alice', key: 'ALI' },` and `{ id: 'p9', owner_id: null },` to `{ id: 'p9', owner_id: null, key: 'ORF' },`;
- change `const tasks = [{ id: 'k1', project_id: 'p1' }];` to `const tasks = [{ id: 'k1', project_id: 'p1', number: 7 }];` and add below it `const columns = [{ id: 'c1', project_id: 'p1' }];`;
- replace `projects: { findById: find(projects) },` with

```ts
    projects: { findById: find(projects), findByKey: async (key: string) => projects.find((p) => p.key === key) },
```

- replace `tasks: { findById: find(tasks) },` with

```ts
    tasks: { findById: find(tasks), findByRef: async (projectId: string, n: number) => tasks.find((t) => t.project_id === projectId && t.number === n) },
    taskColumns: { findById: find(columns) },
```

At the end of `describe('Scoped', …)` (before its closing `});`) add:

```ts
  it('resolves a card by its ref, key case-insensitive, and a column through its project', async () => {
    const s = as('alice');
    expect((await s.taskByRef('ali-7')).task.id).toBe('k1');
    expect((await s.taskByRef(' ALI-7 ')).project.id).toBe('p1');
    expect((await s.column('c1')).project.id).toBe('p1');
    expect((await as(null).taskByRef('ALI-7')).task.id).toBe('k1');
  });

  it('answers the same 404 for a malformed ref, an unknown key or number, and another owner\'s card or column', async () => {
    const alice = as('alice');
    const bob = as('bob');
    for (const p of [alice.taskByRef('ALI-8'), alice.taskByRef('NOPE-1'), alice.taskByRef('ali'), bob.taskByRef('ALI-7'), bob.column('c1'), alice.column('nope')]) {
      await expect(p).rejects.toMatchObject({ statusCode: 404 });
    }
  });
```

- [ ] **Step 2: Write the failing route tests**

Replace `apps/server/src/routes/tasks.test.ts` with:

```ts
import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Repositories } from '../db/repositories/index.js';
import { TaskRuleError } from '../db/repositories/tasks.js';
import type { Task, TaskColumn } from '../db/repositories/types.js';
import { applyErrorHandler } from '../lib/errors.js';
import { projectTaskRoutes, taskRoutes } from './tasks.js';

const task = (over: Partial<Task> & { id: string }): Task => ({
  project_id: 'p1',
  type: 'task',
  number: 1,
  ref: `P1-${over.number ?? 1}`,
  title: over.id,
  description: null,
  status: 'todo',
  position: 0,
  external_ref: null,
  external_key: null,
  tab_id: null,
  parent_id: null,
  epic_id: 'e1',
  column_id: 'c1',
  created_at: '',
  updated_at: '',
  ...over,
});
const column: TaskColumn = { id: 'c1', project_id: 'p1', name: 'A fazer', category: 'todo', position: 0, created_at: '' };
const projects = [
  { id: 'p1', key: 'P1', owner_id: 'u1', agent_column_id: 'c2' },
  { id: 'p2', key: 'OTR', owner_id: 'u2', agent_column_id: null },
];

/** Routes over stubbed repositories and a fixed request scope (ownerId null = admin "all"). */
function buildApp(tasks: Record<string, Task>, ownerId: string | null = null) {
  const app = Fastify();
  applyErrorHandler(app);
  app.addHook('preHandler', async (request) => {
    request.scope = { user: { id: 'u1' } as never, viewAs: { kind: 'self' }, ownerId, createAs: 'u1' };
    request.user = { id: 'u1' } as never;
  });
  const tasksRepo = {
    findById: vi.fn(async (id: string) => tasks[id]),
    findByRef: vi.fn(async (projectId: string, n: number) => Object.values(tasks).find((t) => t.project_id === projectId && t.number === n)),
    listByProject: vi.fn(async () => Object.values(tasks)),
    create: vi.fn(async (_p: string, input: { title: string; parent_id?: string | null }) => task({ id: 'new', title: input.title, parent_id: input.parent_id ?? null })),
    createSubtasks: vi.fn(async (parentId: string, items: { title: string }[]) => items.map((it, i) => task({ id: `s${i}`, title: it.title, parent_id: parentId, position: i }))),
    reorder: vi.fn(async (id: string, position: number) => ({ ...tasks[id], position })),
    childIds: vi.fn(async (id: string) => Object.values(tasks).filter((t) => t.parent_id === id).map((t) => t.id)),
    update: vi.fn(async (id: string, patch: Partial<Task>) => ({ ...tasks[id], ...patch })),
    move: vi.fn(async (id: string) => tasks[id]),
    delete: vi.fn(async () => true),
  };
  const unlinkTask = vi.fn(async () => {});
  const repos = {
    tasks: tasksRepo,
    tickets: { unlinkTask },
    taskColumns: { list: vi.fn(async () => [column]) },
    projects: {
      findById: vi.fn(async (id: string) => projects.find((p) => p.id === id)),
      findByKey: vi.fn(async (key: string) => projects.find((p) => p.key === key)),
    },
  } as unknown as Repositories;
  app.register((a) => projectTaskRoutes(a, repos), { prefix: '/projects' });
  app.register((a) => taskRoutes(a, repos), { prefix: '/tasks' });
  return { app, tasksRepo, unlinkTask };
}

let store: Record<string, Task>;
beforeEach(() => {
  store = {
    t1: task({ id: 't1' }),
    c1: task({ id: 'c1', parent_id: 't1', type: 'subtask', number: 2, epic_id: null, column_id: null }),
    c2: task({ id: 'c2', parent_id: 't1', type: 'subtask', number: 3, epic_id: null, column_id: null, position: 1 }),
    x9: task({ id: 'x9', project_id: 'p2', number: 1, ref: 'OTR-1' }),
  };
});

describe('task routes: board', () => {
  it('lists the tasks with the columns and the agent column', async () => {
    const { app } = buildApp(store);
    const r = await app.inject({ method: 'GET', url: '/projects/p1/tasks' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ columns: [column], agent_column_id: 'c2' });
    expect(r.json().tasks).toHaveLength(4);
  });

  it('creates with type, epic and column', async () => {
    const { app, tasksRepo } = buildApp(store);
    const r = await app.inject({ method: 'POST', url: '/projects/p1/tasks', payload: { title: ' x ', type: 'story', epic_id: 'e1', column_id: 'c1' } });
    expect(r.statusCode).toBe(201);
    expect(tasksRepo.create).toHaveBeenCalledWith('p1', { title: 'x', type: 'story', epic_id: 'e1', column_id: 'c1' });
  });

  it('rejects an unknown type before calling the repository', async () => {
    const { app, tasksRepo } = buildApp(store);
    const r = await app.inject({ method: 'POST', url: '/projects/p1/tasks', payload: { title: 'x', type: 'feature' } });
    expect(r.statusCode).toBe(400);
    expect(tasksRepo.create).not.toHaveBeenCalled();
  });

  it('patches type and epic, and turns a broken rule into a 400 with its message', async () => {
    const { app, tasksRepo } = buildApp(store);
    expect((await app.inject({ method: 'PATCH', url: '/tasks/t1', payload: { type: 'bug', epic_id: 'e2' } })).statusCode).toBe(200);
    expect(tasksRepo.update).toHaveBeenCalledWith('t1', { type: 'bug', epic_id: 'e2' });
    tasksRepo.update.mockRejectedValueOnce(new TaskRuleError('HAS_SUBTASKS'));
    const r = await app.inject({ method: 'PATCH', url: '/tasks/t1', payload: { type: 'bug' } });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toEqual({ error: 'Tire as subtarefas antes de mudar para bug ou spike', code: 'BAD_REQUEST' });
  });

  it.each([
    [{ column_id: 'c2', position: 0 }, { column_id: 'c2' }, 0],
    [{ status: 'done', position: 2 }, { status: 'done' }, 2],
  ])('moves to %j', async (payload, target, position) => {
    const { app, tasksRepo } = buildApp(store);
    expect((await app.inject({ method: 'POST', url: '/tasks/t1/move', payload })).statusCode).toBe(200);
    expect(tasksRepo.move).toHaveBeenCalledWith('t1', target, position);
  });

  it.each([
    ['both targets', { column_id: 'c2', status: 'done', position: 0 }],
    ['no target', { position: 0 }],
    ['no position', { status: 'done' }],
    ['a negative position', { status: 'done', position: -1 }],
  ])('refuses a move with %s', async (_name, payload) => {
    const { app, tasksRepo } = buildApp(store);
    expect((await app.inject({ method: 'POST', url: '/tasks/t1/move', payload })).statusCode).toBe(400);
    expect(tasksRepo.move).not.toHaveBeenCalled();
  });

  it('answers 409 when deleting an epic that still has cards', async () => {
    const { app, tasksRepo } = buildApp(store);
    tasksRepo.delete.mockRejectedValueOnce(new TaskRuleError('EPIC_HAS_CHILDREN'));
    const r = await app.inject({ method: 'DELETE', url: '/tasks/t1' });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toEqual({ error: 'Este épico ainda tem cards', code: 'CONFLICT' });
  });
});

describe('task routes: by ref', () => {
  it('finds a card by KEY-N, the key case-insensitive', async () => {
    const { app } = buildApp(store, 'u1');
    const r = await app.inject({ method: 'GET', url: '/tasks/by-ref/p1-2' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ project_id: 'p1', task: { id: 'c1', parent_id: 't1' } });
  });

  it.each(['OTR-1', 'P1-99', 'NOPE-1', 'garbage'])('answers 404 for %s (another owner, unknown number or key, not a ref)', async (ref) => {
    const { app } = buildApp(store, 'u1');
    const r = await app.inject({ method: 'GET', url: `/tasks/by-ref/${ref}` });
    expect(r.statusCode).toBe(404);
    expect(r.json().error).toBe('Card não encontrado');
  });
});

describe('task routes: subtasks', () => {
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

  it('does not let PATCH reparent a task or set its column', async () => {
    const { app, tasksRepo } = buildApp(store);
    const r = await app.inject({ method: 'PATCH', url: '/tasks/c1', payload: { status: 'done', parent_id: 'other', column_id: 'c2' } });
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
    tasksRepo.move.mockRejectedValueOnce(new TaskRuleError('SUBTASK_CANNOT_MOVE'));
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
```

`apps/server/src/routes/columns.test.ts`:

```ts
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
```

- [ ] **Step 3: Run them to see them fail**

```bash
th 'npx vitest run --root apps/server src/auth/scope.test.ts src/routes/tasks.test.ts src/routes/columns.test.ts'; rm -rf .npm
```

Expected: FAIL — `s.taskByRef is not a function`, `/tasks/by-ref/…` 404 on every ref, list without `columns`, cannot find module `./columns.js`.

- [ ] **Step 4: Scoped lookups**

In `apps/server/src/auth/scope.ts`, change the types import to

```ts
import type { AiAccount, Machine, Project, ProjectMachine, Tab, Task, TaskColumn, User } from '../db/repositories/types.js';
```

add `import { parseRef } from '../db/repositories/task-rules.js';`, and after the `task(id)` method add:

```ts
  /**
   * A card by its ref ("TER-12", key case-insensitive). A malformed ref, an unknown key or number
   * and another owner's project all answer the same 404 — the ref never confirms a foreign project.
   */
  async taskByRef(ref: string): Promise<{ task: Task; project: Project }> {
    const parsed = parseRef(ref);
    const project = parsed ? await this.repos.projects.findByKey(parsed.key) : undefined;
    if (!parsed || !project || !this.owns(project.owner_id)) throw notFound('Card não encontrado');
    const task = await this.repos.tasks.findByRef(project.id, parsed.number);
    if (!task) throw notFound('Card não encontrado');
    return { task, project };
  }

  /** A board column and its project; the project must be in scope. */
  async column(id: string): Promise<{ column: TaskColumn; project: Project }> {
    const column = await this.repos.taskColumns.findById(id);
    if (!column) throw notFound('Coluna não encontrada');
    const { project } = await this.project(column.project_id).catch(() => {
      throw notFound('Coluna não encontrada');
    });
    return { column, project };
  }
```

- [ ] **Step 5: Rewrite the task routes**

Replace `apps/server/src/routes/tasks.ts` with:

```ts
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Repositories } from '../db/repositories/index.js';
import { MAX_SUBTASKS_PER_CALL, TaskRuleError, type TaskRuleCode } from '../db/repositories/tasks.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { scoped } from '../auth/scope.js';

const idParam = z.object({ id: z.string().min(1).max(64) });
const refParam = z.object({ ref: z.string().min(1).max(32) });
const rowId = z.string().min(1).max(64);
const statusSchema = z.enum(['backlog', 'todo', 'doing', 'done']);
const typeSchema = z.enum(['epic', 'story', 'task', 'subtask', 'bug', 'spike']);
const position = z.number().int().min(0).max(10_000);

const taskFields = {
  title: z.string().trim().min(1).max(300),
  description: z.string().trim().max(5000).optional().nullable(),
  status: statusSchema.optional(),
};
const createBody = z.object({
  ...taskFields,
  type: typeSchema.optional(),
  epic_id: rowId.optional().nullable(),
  column_id: rowId.optional().nullable(),
  parent_id: rowId.optional().nullable(),
});
/** No parent_id and no column_id: a task is never reparented, and a column change is a move (zod strips both). */
const patchBody = z.object({ ...taskFields, type: typeSchema, epic_id: rowId.nullable() }).partial();
/** Exactly one target: strict objects make `{ column_id, status, … }` match neither branch. */
const moveBody = z.union([z.object({ column_id: rowId, position }).strict(), z.object({ status: statusSchema, position }).strict()]);
const subtasksBody = z.object({
  items: z
    .array(z.object({ title: taskFields.title, description: taskFields.description }))
    .min(1)
    .max(MAX_SUBTASKS_PER_CALL),
});
const reorderBody = z.object({ position });

/** Rules that conflict with what the board holds (spec §9): 409 instead of 400. */
const CONFLICTS = new Set<TaskRuleCode>(['EPIC_HAS_CHILDREN', 'COLUMN_LAST_OF_CATEGORY']);

/** Board rules live in the repositories; a broken one is the client's mistake (400) or a conflict (409). */
export async function taskRules<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    if (e instanceof TaskRuleError) throw CONFLICTS.has(e.code) ? conflict(e.message) : badRequest(e.message);
    throw e;
  }
}

/** Mounted at /projects: a project's board (list) and new cards. */
export async function projectTaskRoutes(app: FastifyInstance, repos: Repositories) {
  app.get('/:id/tasks', async (request) => {
    const { id } = idParam.parse(request.params);
    const { project } = await scoped(repos, request).project(id);
    // listByProject heals rows from the previous release first, columns included
    const tasks = await repos.tasks.listByProject(id);
    return { tasks, columns: await repos.taskColumns.list(id), agent_column_id: project.agent_column_id };
  });

  app.post('/:id/tasks', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    await scoped(repos, request).project(id);
    const body = createBody.parse(request.body);
    return reply.code(201).send({ task: await taskRules(() => repos.tasks.create(id, body)) });
  });
}

/** Mounted at /tasks: one card by id (edit, move, subtasks, delete) or by ref. */
export async function taskRoutes(app: FastifyInstance, repos: Repositories) {
  app.get('/by-ref/:ref', async (request) => {
    const { ref } = refParam.parse(request.params);
    const { task, project } = await scoped(repos, request).taskByRef(ref);
    return { task, project_id: project.id };
  });

  app.patch('/:id', async (request) => {
    const { id } = idParam.parse(request.params);
    const body = patchBody.parse(request.body);
    await scoped(repos, request).task(id);
    const task = await taskRules(() => repos.tasks.update(id, body));
    if (!task) throw notFound('Task não encontrada');
    return { task };
  });

  app.post('/:id/move', { config: { action: 'update' } }, async (request) => {
    const { id } = idParam.parse(request.params);
    const body = moveBody.parse(request.body);
    await scoped(repos, request).task(id);
    const target = 'column_id' in body ? { column_id: body.column_id } : { status: body.status };
    const task = await taskRules(() => repos.tasks.move(id, target, body.position));
    if (!task) throw notFound('Task não encontrada');
    return { task };
  });

  app.post('/:id/subtasks', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const body = subtasksBody.parse(request.body ?? {});
    const { task } = await scoped(repos, request).task(id);
    return reply.code(201).send({ subtasks: await taskRules(() => repos.tasks.createSubtasks(id, body.items, task.project_id)) });
  });

  app.post('/:id/reorder', { config: { action: 'update' } }, async (request) => {
    const { id } = idParam.parse(request.params);
    const body = reorderBody.parse(request.body ?? {});
    await scoped(repos, request).task(id);
    const task = await taskRules(() => repos.tasks.reorder(id, body.position));
    if (!task) throw notFound('Task não encontrada');
    return { task };
  });

  app.delete('/:id', async (request) => {
    const { id } = idParam.parse(request.params);
    await scoped(repos, request).task(id);
    const children = await repos.tasks.childIds(id);
    // tickets point at tasks by id with no FK: unlink the whole subtree so they show as "não importado" again
    for (const taskId of [id, ...children]) await repos.tickets.unlinkTask(taskId);
    if (!(await taskRules(() => repos.tasks.delete(id)))) throw notFound('Task não encontrada');
    return { ok: true, deleted_subtasks: children.length };
  });
}
```

- [ ] **Step 6: Column routes**

`apps/server/src/routes/columns.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Repositories } from '../db/repositories/index.js';
import { COLUMN_NAME_MAX, MAX_COLUMNS } from '../db/repositories/task-rules.js';
import type { TaskColumn } from '../db/repositories/types.js';
import { notFound } from '../lib/errors.js';
import { scoped } from '../auth/scope.js';
import { taskRules } from './tasks.js';

const idParam = z.object({ id: z.string().min(1).max(64) });
const name = z.string().trim().min(1).max(COLUMN_NAME_MAX);
const category = z.enum(['todo', 'doing', 'done']);
const createBody = z.object({ name, category });
const patchBody = z
  .object({ name, category })
  .partial()
  .refine((b) => b.name !== undefined || b.category !== undefined, { message: 'Informe name ou category' });
const moveBody = z.object({ position: z.number().int().min(0).max(MAX_COLUMNS) });
const agentBody = z.object({ column_id: z.string().min(1).max(64).nullable() });

/** Mounted at /projects: a project's board columns and its agent column (spec §5 "Columns"). */
export async function projectColumnRoutes(app: FastifyInstance, repos: Repositories) {
  app.get('/:id/columns', async (request) => {
    const { id } = idParam.parse(request.params);
    const { project } = await scoped(repos, request).project(id);
    await repos.taskColumns.ensureDefaults(id);
    return { columns: await repos.taskColumns.list(id), agent_column_id: project.agent_column_id };
  });

  app.post('/:id/columns', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    await scoped(repos, request).project(id);
    const body = createBody.parse(request.body);
    return reply.code(201).send({ column: await taskRules(() => repos.taskColumns.create(id, body)) });
  });

  app.put('/:id/agent-column', async (request) => {
    const { id } = idParam.parse(request.params);
    await scoped(repos, request).project(id);
    const { column_id } = agentBody.parse(request.body ?? {});
    await taskRules(() => repos.taskColumns.setAgentColumn(id, column_id));
    return { agent_column_id: column_id };
  });
}

/** Mounted at /columns: one column by id. */
export async function columnRoutes(app: FastifyInstance, repos: Repositories) {
  app.patch('/:id', async (request) => {
    const { id } = idParam.parse(request.params);
    const body = patchBody.parse(request.body ?? {});
    let column: TaskColumn | undefined = (await scoped(repos, request).column(id)).column;
    const next = body.category;
    // category first: a refused re-categorization leaves the name untouched too
    if (next !== undefined) column = await taskRules(() => repos.taskColumns.setCategory(id, next));
    if (body.name !== undefined) column = await repos.taskColumns.rename(id, body.name);
    if (!column) throw notFound('Coluna não encontrada');
    return { column };
  });

  app.post('/:id/move', { config: { action: 'update' } }, async (request) => {
    const { id } = idParam.parse(request.params);
    const body = moveBody.parse(request.body ?? {});
    await scoped(repos, request).column(id);
    const columns = await repos.taskColumns.move(id, body.position);
    if (!columns) throw notFound('Coluna não encontrada');
    return { columns };
  });

  app.delete('/:id', async (request) => {
    const { id } = idParam.parse(request.params);
    await scoped(repos, request).column(id);
    const r = await taskRules(() => repos.taskColumns.delete(id));
    if (!r) throw notFound('Coluna não encontrada');
    return { ok: true, moved_tasks: r.moved_tasks };
  });
}
```

- [ ] **Step 7: Register the column routes**

In `apps/server/src/app.ts`, after `import { projectTaskRoutes, taskRoutes } from './routes/tasks.js';` add `import { columnRoutes, projectColumnRoutes } from './routes/columns.js';`, and after the line `      await guarded('tasks', (a) => taskRoutes(a, repos), '/tasks');` add:

```ts
      await guarded('tasks', (a) => projectColumnRoutes(a, repos), '/projects');
      await guarded('tasks', (a) => columnRoutes(a, repos), '/columns');
```

- [ ] **Step 8: Run the tests and the typecheck**

```bash
th 'npx vitest run --root apps/server src/auth/scope.test.ts src/routes/tasks.test.ts src/routes/columns.test.ts && npm run typecheck -w @termhub/server'; rm -rf .npm
```

Expected: PASS, typecheck clean.

- [ ] **Step 9: Full server suite**

```bash
thdb 'npm test -w @termhub/server'; rm -rf .npm
```

Expected: PASS (`tickets/import` needs no change: `createFromTicket` already lands in the default epic's backlog).

- [ ] **Step 10: Commit**

```bash
git add apps/server/src/auth/scope.ts apps/server/src/auth/scope.test.ts apps/server/src/routes/tasks.ts apps/server/src/routes/tasks.test.ts apps/server/src/routes/columns.ts apps/server/src/routes/columns.test.ts apps/server/src/app.ts
git commit -m "API: card types and refs, move by column, board column routes" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: MCP tools — card fields, move by column, agent column, find by ref, chat trail

**Files:**
- Modify (full rewrite): `apps/server/src/control/tasks.ts`
- Modify: `apps/server/src/control/agents.ts` (task link block ~127–131), `apps/server/src/control/inventory.ts` (`find`, ~146–171), `apps/server/src/mcp/tools.ts` (schemas ~32–35, `find` ~76–84, `start_agent` ~136, task tools ~141–175), `apps/server/src/db/repositories/chat-actions-view.ts` (`verbPhrase`)
- Test: `apps/server/src/control/tasks.test.ts`, `apps/server/src/control/agents.test.ts`, `apps/server/src/control/inventory.test.ts`, `apps/server/src/mcp/route.test.ts:180`, `apps/server/src/db/repositories/chat-actions-view.test.ts`

**Interfaces:**
- Consumes: Task 3 `TasksRepository.startWork`, `MoveTarget`, `Task.ref/type/epic_id/column_id`; Task 4 `taskColumns.list`; Task 6 `Scoped.taskByRef`; Task 2 `parseRef`.
- Produces (control/tasks.ts): `cardUrl(ref): string` (`${publicUrl}/project/${ref}`); `TaskOut` gains `type, ref, url, epic_id, column_id`; `ColumnOut { id, name, category }`; `ListedTaskOut extends TaskTreeOut { column: ColumnOut | null }`; `listTasks(ctx, { project_id, status?, type?, epic_id? }) → { project_id, board_url, columns: ColumnOut[], tasks: ListedTaskOut[] }`; `createTask(ctx, { …, type?: CreatableType, epic_id? })`; `updateTask(ctx, { …, type?: WorkType, epic_id? })`; `moveTask(ctx, { task_id, column_id?, status?, position? })` (exactly one of column_id/status); `type CreatableType = Exclude<TaskType, 'subtask'>`, `type WorkType = 'story' | 'task' | 'bug' | 'spike'`.
- Produces (inventory.ts): `FindKind` gains `'task'`; a task match is `{ kind: 'task', id, name: '<ref> <title>', machine_id: null, machine_name: null, score: 3 }`.

- [ ] **Step 1: Write the failing tests**

In `apps/server/src/control/tasks.test.ts`:

Replace the `task` factory with:

```ts
const task = (over: Partial<Task> & { id: string; project_id: string }): Task => ({
  title: over.id, description: null, status: 'todo', position: 0, external_ref: null, external_key: null, tab_id: null, parent_id: null,
  type: over.parent_id ? 'subtask' : 'task', number: 1, ref: `P1-${over.id}`, epic_id: over.parent_id ? null : 'e1', column_id: null,
  created_at: '2026-09-20T10:00:00.000Z', updated_at: '2026-09-20T10:00:00.000Z', ...over,
});
```

Replace the `k1` and `k2` fixtures with:

```ts
const k1 = task({ id: 'k1', project_id: 'p1', title: 'Spec', status: 'doing', column_id: 'c2', external_ref: { provider: 'linear' }, external_key: 'LIN-1' });
```

```ts
const k2 = task({ id: 'k2', project_id: 'p1', title: 'Plan', status: 'todo', position: 1, type: 'bug', epic_id: 'e2', column_id: 'c1' });
```

Right after `const tasks = [k1, s1, k2, kx];` add:

```ts
const columns = [
  { id: 'c1', project_id: 'p1', name: 'A fazer', category: 'todo', position: 0, created_at: '' },
  { id: 'c2', project_id: 'p1', name: 'Em revisão', category: 'doing', position: 1, created_at: '' },
];
```

In `ctx()`, add to `repos` (after `tickets: …`):

```ts
    taskColumns: { list: vi.fn(async (pid: string) => columns.filter((c) => c.project_id === pid)) },
```

In `describe('updateTask')`, replace `new ControlError('BAD_REQUEST', 'Informe title, description ou status')` with `new ControlError('BAD_REQUEST', 'Informe title, description, status, type ou epic_id')`.

At the end of the file add:

```ts
describe('card fields, filters and move by column', () => {
  it('gives every card its type, ref, url, epic and column, and lists the columns in order', async () => {
    const { c } = ctx();
    const r = await listTasks(c, { project_id: 'p1' });
    expect(r.columns).toEqual([{ id: 'c1', name: 'A fazer', category: 'todo' }, { id: 'c2', name: 'Em revisão', category: 'doing' }]);
    expect(r.tasks[0]).toMatchObject({ id: 'k1', type: 'task', ref: 'P1-k1', url: 'https://app.test/project/P1-k1', epic_id: 'e1', column_id: 'c2', column: { id: 'c2', name: 'Em revisão', category: 'doing' } });
    expect(r.tasks[0].subtasks[0]).toMatchObject({ id: 's1', type: 'subtask', url: 'https://app.test/project/P1-s1' });
  });

  it('filters by type and by epic', async () => {
    const { c } = ctx();
    expect((await listTasks(c, { project_id: 'p1', type: 'bug' })).tasks.map((t) => t.id)).toEqual(['k2']);
    expect((await listTasks(c, { project_id: 'p1', epic_id: 'e1' })).tasks.map((t) => t.id)).toEqual(['k1']);
  });

  it('creates with a type and an epic', async () => {
    const { c, repos } = ctx();
    repos.tasks.createWithSubtasks.mockResolvedValue(tree(task({ id: 'k9', project_id: 'p1', type: 'story' })));
    const r = await createTask(c, { project_id: 'p1', title: 'Pay', type: 'story', epic_id: 'e2' });
    expect(repos.tasks.createWithSubtasks).toHaveBeenCalledWith('p1', { title: 'Pay', description: undefined, status: undefined, type: 'story', epic_id: 'e2' }, []);
    expect(r.task).toMatchObject({ type: 'story', url: 'https://app.test/project/P1-k9' });
  });

  it('updates the type and the epic', async () => {
    const { c, repos } = ctx();
    repos.tasks.update.mockResolvedValue({ ...k2, type: 'spike' });
    await updateTask(c, { task_id: 'k2', type: 'spike', epic_id: 'e1' });
    expect(repos.tasks.update).toHaveBeenCalledWith('k2', { title: undefined, description: undefined, status: undefined, type: 'spike', epic_id: 'e1' });
  });

  it('moves to a column by id, and wants exactly one of column_id and status', async () => {
    const { c, repos } = ctx();
    repos.tasks.move.mockResolvedValue({ ...k2, column_id: 'c2', status: 'doing' });
    await moveTask(c, { task_id: 'k2', column_id: 'c2', position: 1 });
    expect(repos.tasks.move).toHaveBeenCalledWith('k2', { column_id: 'c2' }, 1);
    const one = new ControlError('BAD_REQUEST', 'Informe column_id ou status (um dos dois)');
    await expect(moveTask(c, { task_id: 'k2', column_id: 'c2', status: 'done' })).rejects.toEqual(one);
    await expect(moveTask(c, { task_id: 'k2' })).rejects.toEqual(one);
    expect(repos.tasks.move).toHaveBeenCalledTimes(1);
  });
});
```

In `apps/server/src/control/agents.test.ts`:
- in `ctx()`, replace `update: vi.fn(async () => undefined) },` (the end of the `tasks` stub) with `update: vi.fn(async () => undefined), startWork: vi.fn(async () => undefined) },`;
- in "links a subtask too…", replace `expect(repos.tasks.update).toHaveBeenCalledWith('s1', { status: 'doing' });` with `expect(repos.tasks.startWork).toHaveBeenCalledWith('s1');`;
- rename "links the task to the tab and moves it to doing" to "links the task to the tab and hands it to startWork (agent column)" and replace its `expect(repos.tasks.update).toHaveBeenCalledWith('k1', { status: 'doing' });` with `expect(repos.tasks.startWork).toHaveBeenCalledWith('k1');`;
- replace the whole test "leaves a task already in doing where it is" with:

```ts
  it('leaves the "already in doing" decision to the repository', async () => {
    const { c, repos } = ctx();
    await startAgent(c, { project_id: 'p1', account_id: 'a1', prompt: 'p', task_id: 'k2' });
    expect(repos.tasks.setTab).toHaveBeenCalledWith('k2', 't9');
    expect(repos.tasks.startWork).toHaveBeenCalledWith('k2');
    expect(repos.tasks.update).not.toHaveBeenCalled();
  });
```

In `apps/server/src/control/inventory.test.ts`:
- in `ctx()`, replace the `projects:` stub's closing `findById: vi.fn(async (id: string) => projects.find((p) => p.id === id)),` with

```ts
      findById: vi.fn(async (id: string) => projects.find((p) => p.id === id)),
      findByKey: vi.fn(async (key: string) => projects.find((p) => p.key === key)),
```

- replace the `tasks:` stub with

```ts
    tasks: {
      listByProject: vi.fn(async (pid: string) => (pid === 'p1' ? [{ id: 'k1', title: 'XPTO', status: 'doing', tab_id: 't1', subtasks: [] }] : [])),
      findByRef: vi.fn(async (pid: string, n: number) =>
        pid === 'p1' && n === 12 ? { id: 'k12', project_id: 'p1', ref: 'P1-12', title: 'Checkout' } : pid === 'px' && n === 1 ? { id: 'kx1', project_id: 'px', ref: 'PX-1', title: 'Deles' } : undefined,
      ),
    },
```

- at the end of `describe('find', …)` add:

```ts
  it('finds a card by its exact ref, only in the owner\'s projects and with tasks:read', async () => {
    const grants = ['machines:read', 'projects:read', 'ai_accounts:read', 'tasks:read'];
    expect((await find(ctx(grants), { query: 'p1-12' })).matches).toEqual([{ kind: 'task', id: 'k12', name: 'P1-12 Checkout', machine_id: null, machine_name: null, score: 3 }]);
    expect((await find(ctx(grants), { query: 'PX-1', kinds: ['task'] })).matches).toEqual([]); // another user's project
    expect((await find(ctx(grants), { query: 'P1-99', kinds: ['task'] })).matches).toEqual([]);
    expect((await find(ctx(), { query: 'P1-12', kinds: ['task'] })).matches).toEqual([]); // no tasks:read
  });
```

In `apps/server/src/mcp/route.test.ts:180`, replace `da permissão de leitura de máquinas, projetos ou contas de IA na sua role` with `da permissão de leitura de máquinas, projetos, tarefas ou contas de IA na sua role`.

In `apps/server/src/db/repositories/chat-actions-view.test.ts`:
- line 33: `const task = { id: 'tk1', project_id: 'p1', title: 'Corrigir o build', ref: 'REA-7' };`
- the four summaries become `'apagar a tarefa REA-7 "Corrigir o build" no projeto reactivando'`, `'adicionar subtarefas à tarefa REA-7 "Corrigir o build" no projeto reactivando'`, `'atualizar a tarefa REA-7 "Corrigir o build" no projeto reactivando'`, `'mover a tarefa REA-7 "Corrigir o build" no projeto reactivando'`.

- [ ] **Step 2: Run them to see them fail**

```bash
th 'npx vitest run --root apps/server src/control/tasks.test.ts src/control/agents.test.ts src/control/inventory.test.ts src/mcp/route.test.ts src/db/repositories/chat-actions-view.test.ts'; rm -rf .npm
```

Expected: FAIL — no `columns`/`url` in `listTasks`, the old "Informe…" message, `startWork` not called, no task match in `find`, the old grant text, summaries without the ref.

- [ ] **Step 3: Rewrite the task control functions**

Replace `apps/server/src/control/tasks.ts` with:

```ts
import { config } from '../config.js';
import { TaskRuleError } from '../db/repositories/tasks.js';
import type { ColumnCategory, Task, TaskColumn, TaskStatus, TaskType, TaskWithSubtasks } from '../db/repositories/types.js';
import { ControlError, type ControlContext } from './context.js';

/** Field limits, the same the REST routes enforce (`routes/tasks.ts`). */
export const TASK_TITLE_MAX = 300;
export const TASK_DESCRIPTION_MAX = 5000;
export const TASK_POSITION_MAX = 10_000;

/** Types a tool may create (a subtask is created with add_subtasks) and switch between. */
export type CreatableType = Exclude<TaskType, 'subtask'>;
export type WorkType = 'story' | 'task' | 'bug' | 'spike';

export interface SubtaskIn {
  title: string;
  description?: string | null;
}

/** A card as the tools return it: never `external_ref` (provider payload the model does not need). */
export interface TaskOut {
  id: string;
  project_id: string;
  type: TaskType;
  /** "TER-12" */
  ref: string;
  /** where the person opens this card in the app */
  url: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  position: number;
  parent_id: string | null;
  epic_id: string | null;
  column_id: string | null;
  tab_id: string | null;
  external_key: string | null;
  created_at: string;
  updated_at: string;
}

export interface TaskTreeOut extends TaskOut {
  subtasks: TaskOut[];
  subtask_counts: { done: number; total: number };
}

/** A board column as the tools see it: the user's name, the category the system reasons with. */
export interface ColumnOut {
  id: string;
  name: string;
  category: ColumnCategory;
}

export interface ListedTaskOut extends TaskTreeOut {
  /** null in the backlog (and on epics kept there) */
  column: ColumnOut | null;
}

/** Where the person opens one card: `/project/TER-12`. */
export function cardUrl(ref: string): string {
  return `${config.publicUrl}/project/${ref}`;
}

/** Where the person sees this board in the app. */
export function boardUrl(projectId: string): string {
  return `${config.publicUrl}/projects/${projectId}/tasks`;
}

const out = (t: Task): TaskOut => ({
  id: t.id, project_id: t.project_id, type: t.type, ref: t.ref, url: cardUrl(t.ref), title: t.title, description: t.description, status: t.status,
  position: t.position, parent_id: t.parent_id, epic_id: t.epic_id, column_id: t.column_id, tab_id: t.tab_id, external_key: t.external_key,
  created_at: t.created_at, updated_at: t.updated_at,
});
const outTree = (t: TaskWithSubtasks): TaskTreeOut => ({ ...out(t), subtasks: t.subtasks.map(out), subtask_counts: t.subtask_counts });
const columnOut = (c: TaskColumn): ColumnOut => ({ id: c.id, name: c.name, category: c.category });

/** Board rules live in the repository; a broken one is the caller's mistake, said in pt-BR. */
async function rules<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    if (e instanceof TaskRuleError) throw new ControlError(e.code, e.message);
    throw e;
  }
}

export async function listTasks(
  ctx: ControlContext,
  input: { project_id: string; status?: TaskStatus; type?: TaskType; epic_id?: string },
): Promise<{ project_id: string; board_url: string; columns: ColumnOut[]; tasks: ListedTaskOut[] }> {
  await ctx.scoped.project(input.project_id);
  // listByProject heals rows from the previous release first, columns included
  const tasks = await ctx.repos.tasks.listByProject(input.project_id);
  const columns = (await ctx.repos.taskColumns.list(input.project_id)).map(columnOut);
  const byId = new Map(columns.map((c) => [c.id, c]));
  return {
    project_id: input.project_id,
    board_url: boardUrl(input.project_id),
    columns,
    tasks: tasks
      .filter((t) => (!input.status || t.status === input.status) && (!input.type || t.type === input.type) && (!input.epic_id || t.epic_id === input.epic_id))
      .map((t) => ({ ...outTree(t), column: (t.column_id ? byId.get(t.column_id) : undefined) ?? null })),
  };
}

export async function createTask(
  ctx: ControlContext,
  input: { project_id: string; title: string; description?: string | null; status?: TaskStatus; type?: CreatableType; epic_id?: string; subtasks?: SubtaskIn[] },
): Promise<{ task: TaskTreeOut; board_url: string }> {
  await ctx.scoped.project(input.project_id);
  const task = await rules(() =>
    ctx.repos.tasks.createWithSubtasks(input.project_id, { title: input.title, description: input.description, status: input.status, type: input.type, epic_id: input.epic_id }, input.subtasks ?? []),
  );
  return { task: outTree(task), board_url: boardUrl(input.project_id) };
}

export async function addSubtasks(ctx: ControlContext, input: { task_id: string; subtasks: SubtaskIn[] }): Promise<{ task_id: string; subtasks: TaskOut[]; board_url: string }> {
  const { task } = await ctx.scoped.task(input.task_id);
  const created = await rules(() => ctx.repos.tasks.createSubtasks(task.id, input.subtasks, task.project_id));
  return { task_id: task.id, subtasks: created.map(out), board_url: boardUrl(task.project_id) };
}

export async function updateTask(
  ctx: ControlContext,
  input: { task_id: string; title?: string; description?: string | null; status?: TaskStatus; type?: WorkType; epic_id?: string },
): Promise<{ task: TaskOut; board_url: string }> {
  const { task } = await ctx.scoped.task(input.task_id);
  if ([input.title, input.description, input.status, input.type, input.epic_id].every((v) => v === undefined)) {
    throw new ControlError('BAD_REQUEST', 'Informe title, description, status, type ou epic_id');
  }
  const updated = await rules(() =>
    ctx.repos.tasks.update(task.id, { title: input.title, description: input.description, status: input.status, type: input.type, epic_id: input.epic_id }),
  );
  if (!updated) throw new ControlError('NOT_FOUND', 'Tarefa não encontrada');
  return { task: out(updated), board_url: boardUrl(task.project_id) };
}

/** Top-level cards only: the repository refuses a subtask (they have no column of their own). */
export async function moveTask(
  ctx: ControlContext,
  input: { task_id: string; column_id?: string; status?: TaskStatus; position?: number },
): Promise<{ task: TaskOut; board_url: string }> {
  const { task } = await ctx.scoped.task(input.task_id);
  if ((input.column_id === undefined) === (input.status === undefined)) throw new ControlError('BAD_REQUEST', 'Informe column_id ou status (um dos dois)');
  const target = input.column_id !== undefined ? { column_id: input.column_id } : { status: input.status as TaskStatus };
  const moved = await rules(() => ctx.repos.tasks.move(task.id, target, input.position ?? 0));
  if (!moved) throw new ControlError('NOT_FOUND', 'Tarefa não encontrada');
  return { task: out(moved), board_url: boardUrl(task.project_id) };
}

const subtaskCount = (n: number) => (n === 1 ? '1 subtarefa' : `${n} subtarefas`);

/** Destructive and cascading, so it needs `confirm: true`; the refusal spells out what would go. */
export async function deleteTask(ctx: ControlContext, input: { task_id: string; confirm?: boolean }): Promise<{ deleted: true; task_id: string; deleted_subtasks: number; board_url: string }> {
  const { task } = await ctx.scoped.task(input.task_id);
  const children = await ctx.repos.tasks.childIds(task.id);
  if (!input.confirm) {
    const kind = task.parent_id ? 'a subtarefa' : 'a tarefa';
    const what = children.length ? `${kind} "${task.title}" e ${subtaskCount(children.length)}` : `${kind} "${task.title}"`;
    throw new ControlError('CONFIRM_REQUIRED', `Isso exclui ${what}; repita com confirm: true para confirmar`);
  }
  // Tickets point at tasks by id with no FK: unlink the whole subtree so they show as "não importado" again.
  for (const id of [task.id, ...children]) await ctx.repos.tickets.unlinkTask(id);
  // An epic that still has cards is refused here (EPIC_HAS_CHILDREN), after the unlink: an epic never has tickets.
  if (!(await rules(() => ctx.repos.tasks.delete(task.id)))) throw new ControlError('NOT_FOUND', 'Tarefa não encontrada');
  return { deleted: true, task_id: task.id, deleted_subtasks: children.length, board_url: boardUrl(task.project_id) };
}
```

- [ ] **Step 4: start_agent uses the agent column**

In `apps/server/src/control/agents.ts`, replace

```ts
      await ctx.repos.tasks.setTab(task.id, tab.tab_id);
      if (task.status !== 'doing') await ctx.repos.tasks.update(task.id, { status: 'doing' });
```

with

```ts
      await ctx.repos.tasks.setTab(task.id, tab.tab_id);
      // a top-level card goes to the project's agent column (else the first doing column) unless it is
      // already in a doing column; a subtask is marked doing
      await ctx.repos.tasks.startWork(task.id);
```

- [ ] **Step 5: find by ref**

In `apps/server/src/control/inventory.ts`, add the imports

```ts
import { parseRef } from '../db/repositories/task-rules.js';
import { HttpError } from '../lib/errors.js';
```

change `export type FindKind = 'machine' | 'project' | 'ai_account';` to `export type FindKind = 'machine' | 'project' | 'ai_account' | 'task';`, and in `find` replace

```ts
  const kinds = new Set<FindKind>(input.kinds?.length ? input.kinds : ['machine', 'project', 'ai_account']);
  const [canMachines, canProjects, canAccounts] = await Promise.all([ctx.can('machines', 'read'), ctx.can('projects', 'read'), ctx.can('ai_accounts', 'read')]);
```

with

```ts
  const kinds = new Set<FindKind>(input.kinds?.length ? input.kinds : ['machine', 'project', 'ai_account', 'task']);
  const [canMachines, canProjects, canAccounts, canTasks] = await Promise.all([
    ctx.can('machines', 'read'),
    ctx.can('projects', 'read'),
    ctx.can('ai_accounts', 'read'),
    ctx.can('tasks', 'read'),
  ]);
```

and before `matches.sort(…)` add:

```ts
  // A card only by its exact ref ("TER-12"): titles are not names. Another owner's card is simply no match.
  if (kinds.has('task') && canTasks && parseRef(input.query)) {
    try {
      const { task } = await ctx.scoped.taskByRef(input.query);
      matches.push({ kind: 'task', id: task.id, name: `${task.ref} ${task.title}`, machine_id: null, machine_name: null, score: 3 });
    } catch (e) {
      if (!(e instanceof HttpError && e.statusCode === 404)) throw e;
    }
  }
```

Update the doc comment above `find` to: `/** Resolves names ("MacBook Pro M4", "Hub Community", "pedrogoiania") and card refs ("TER-12") to ids in one call, within the owner's data. */`.

- [ ] **Step 6: Tool schemas and descriptions**

In `apps/server/src/mcp/tools.ts`:

Change the imports: `import type { TaskStatus, TaskType } from '../db/repositories/types.js';` and `import { addSubtasks, createTask, deleteTask, listTasks, moveTask, TASK_DESCRIPTION_MAX, TASK_POSITION_MAX, TASK_TITLE_MAX, updateTask, type CreatableType, type WorkType } from '../control/tasks.js';`.

After `const taskStatus = z.enum(['backlog', 'todo', 'doing', 'done']);` add:

```ts
const taskType = z.enum(['epic', 'story', 'task', 'subtask', 'bug', 'spike']);
const creatableType = z.enum(['epic', 'story', 'task', 'bug', 'spike']);
const workType = z.enum(['story', 'task', 'bug', 'spike']);
```

Replace the `find` tool's `description`, `allowedIf`, `grantText`, `input` and `run` with:

```ts
    description: 'Resolve names to ids in one call — e.g. "MacBook Pro M4", "Hub Community", "pedrogoiania", "TER-12" — across machines, projects (name or key), AI accounts and cards (exact ref only) (case- and accent-insensitive, best matches first).',
```

```ts
    allowedIf: async (ctx) => (await Promise.all([ctx.can('machines', 'read'), ctx.can('projects', 'read'), ctx.can('tasks', 'read'), ctx.can('ai_accounts', 'read')])).some(Boolean),
    grantText: 'de leitura de máquinas, projetos, tarefas ou contas de IA',
    input: { query: z.string().min(1).max(200), kinds: z.array(z.enum(['machine', 'project', 'ai_account', 'task'])).optional() },
    run: (ctx, a) => find(ctx, a as { query: string; kinds?: ('machine' | 'project' | 'ai_account' | 'task')[] }),
```

In `start_agent`'s description replace `With task_id (needs the tasks:update permission) the task is linked to the tab and moved to doing.` with `With task_id (needs the tasks:update permission) the task is linked to the tab and moved to the project's agent column (a project setting; default the first doing column) unless it already sits in a doing column; a subtask is marked doing.`

Replace the `list_tasks`, `create_task`, `update_task` and `move_task` entries with:

```ts
  {
    name: 'list_tasks',
    description:
      "List a project's cards as the board and backlog show them. Epics group the work; stories, tasks, bugs and spikes are the work; subtasks come nested as a checklist. Each card has a type, a ref (TER-12), its url, its epic_id and its board column ({ id, name, category } — the board shows columns by the user's names, the category todo/doing/done is what they mean; backlog cards have no column). The result also lists the project's columns in order. status, type and epic_id filter the top-level cards.",
    scope: 'tasks', resource: 'tasks', action: 'read',
    input: { project_id: id, status: taskStatus.optional(), type: taskType.optional(), epic_id: id.optional() },
    run: (ctx, a) => listTasks(ctx, a as { project_id: string; status?: TaskStatus; type?: TaskType; epic_id?: string }),
  },
  {
    name: 'create_task',
    description: `Create a card at the top of a column (default the first todo column; an epic defaults to the backlog), optionally with its subtasks (max ${MAX_SUBTASKS_PER_CALL}) in one transaction. type: epic, story, task (default), bug or spike — only stories and tasks take subtasks. epic_id: the epic it belongs to (default: the project's default epic). Returns the card with its ref and url, and the board URL.`,
    scope: 'tasks', resource: 'tasks', action: 'create',
    input: { project_id: id, title: taskTitle, description: taskDescription.optional(), status: taskStatus.optional(), type: creatableType.optional(), epic_id: id.optional(), subtasks: subtaskItems.optional() },
    run: (ctx, a) =>
      createTask(ctx, a as { project_id: string; title: string; description?: string | null; status?: TaskStatus; type?: CreatableType; epic_id?: string; subtasks?: { title: string; description?: string | null }[] }),
  },
```

(keep `add_subtasks` as it is, between `create_task` and `update_task`)

```ts
  {
    name: 'update_task',
    description:
      'Change the title, description (null clears it), status, type (story, task, bug or spike; a card with subtasks stays a story or task) or epic_id of a card, or the title/description/status of a subtask. Changing the status of a top-level card moves it to the top of the first column of that category (backlog: of its epic backlog).',
    scope: 'tasks', resource: 'tasks', action: 'update',
    input: { task_id: id, title: taskTitle.optional(), description: taskDescription.optional(), status: taskStatus.optional(), type: workType.optional(), epic_id: id.optional() },
    run: (ctx, a) => updateTask(ctx, a as { task_id: string; title?: string; description?: string | null; status?: TaskStatus; type?: WorkType; epic_id?: string }),
  },
  {
    name: 'move_task',
    description: `Move a top-level card to a board column (column_id, from list_tasks) or to a status (backlog, or the first column of todo/doing/done) — exactly one of the two — at a position (0 = top, default; max ${TASK_POSITION_MAX}, clamped). Subtasks have no column: change their status with update_task.`,
    scope: 'tasks', resource: 'tasks', action: 'update',
    input: { task_id: id, column_id: id.optional(), status: taskStatus.optional(), position: z.number().int().min(0).max(TASK_POSITION_MAX).optional() },
    run: (ctx, a) => moveTask(ctx, a as { task_id: string; column_id?: string; status?: TaskStatus; position?: number }),
  },
```

- [ ] **Step 7: The chat trail shows the ref**

In `apps/server/src/db/repositories/chat-actions-view.ts`, above `function verbPhrase` add:

```ts
/** A task as the sentence names it: its ref, then its title — `TER-12 "Corrigir o build"`. */
const named = (task: Task) => `${task.ref} "${task.title}"`;
```

and in `verbPhrase` replace the four task cases with:

```ts
    case 'add_subtasks':
      return task ? `adicionar subtarefas à tarefa ${named(task)}` : 'adicionar subtarefas a uma tarefa que não existe mais';
    case 'update_task':
      return task ? `atualizar a tarefa ${named(task)}` : 'atualizar uma tarefa que não existe mais';
    case 'move_task':
      return task ? `mover a tarefa ${named(task)}` : 'mover uma tarefa que não existe mais';
    case 'delete_task':
      return task ? `apagar a tarefa ${named(task)}` : 'apagar uma tarefa que não existe mais';
```

(The chat gate's classification is unchanged: no tool was added or renamed.)

- [ ] **Step 8: Run the tests and the typecheck**

```bash
th 'npx vitest run --root apps/server src/control src/mcp/route.test.ts src/db/repositories/chat-actions-view.test.ts && npm run typecheck -w @termhub/server'; rm -rf .npm
```

Expected: PASS, typecheck clean.

- [ ] **Step 9: Full server suite**

```bash
thdb 'npm test -w @termhub/server'; rm -rf .npm
```

Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add apps/server/src/control apps/server/src/mcp/tools.ts apps/server/src/mcp/route.test.ts apps/server/src/db/repositories/chat-actions-view.ts apps/server/src/db/repositories/chat-actions-view.test.ts
git commit -m "MCP: card types, refs and urls; move by column; agent column; find by ref" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Web model, API client and pure board helpers

**Files:**
- Modify: `apps/web/src/lib/types.ts` (`Project` ~129, `TaskStatus`/`Task` ~170–189, after `TASK_STATUS_LABEL` ~299)
- Modify: `apps/web/src/lib/api.ts` (import line 1, `tasks` block ~209–224)
- Modify: `apps/web/src/components/TasksBoard.tsx:150` (new `move` signature only)
- Create: `apps/web/src/lib/board.ts`
- Test: `apps/web/src/lib/board.test.ts` (new)

**Interfaces:**
- Produces (types.ts): `TaskType`, `ColumnCategory`; `Task` gains `type, number, ref, epic_id, column_id`; `Project.agent_column_id?: string | null`; `TaskColumn { id, project_id, name, category, position, created_at }`; `BoardData { tasks: Task[]; columns: TaskColumn[]; agent_column_id: string | null }`; `TaskCreateInput`, `TaskPatchInput`, `MoveTarget = { column_id: string } | { status: TaskStatus }`; `TASK_TYPE_LABEL: Record<TaskType, string>`, `COLUMN_CATEGORY_LABEL: Record<ColumnCategory, string>`.
- Produces (api.ts): `api.tasks.list(projectId): BoardData`, `create(projectId, TaskCreateInput)`, `update(id, TaskPatchInput)`, `move(id, MoveTarget, position)`, `byRef(ref): { task, project_id }` (other `api.tasks` methods unchanged); `api.columns.create(projectId, { name, category }) → { column }`, `update(id, { name?, category? }) → { column }`, `move(id, position) → { columns }`, `remove(id) → { ok, moved_tasks }`, `setAgent(projectId, columnId | null) → { agent_column_id }`.
- Produces (board.ts): `WORK_TYPES`, `FILTER_TYPES`, `BoardFilter { types: TaskType[]; epicId: string | null }`, `DEFAULT_FILTER`, `readBoardFilter(projectId)`, `writeBoardFilter(projectId, filter)`, `cardsIn(tasks, columnId)`, `visible(cards, filter)`, `dropPosition(all, shown, index, movingId)`, `applyMove(tasks, id, column, position)`, `nextColumn(columns, columnId)`, `epicsOf(tasks)`, `openCount(tasks)`, `BacklogSection { epic; items; done; total }`, `backlogSections(tasks)`, `typeOptions(task)`, `canHaveSubtasks(task)`, `cardPath(ref)`.

- [ ] **Step 1: Types**

In `apps/web/src/lib/types.ts`:

In `export interface Project`, after `is_public: boolean;` add:

```ts
  /** column a card moves to when an agent starts on it; null = automatic (first "Fazendo"). The board reads it from the tasks list. */
  agent_column_id?: string | null;
```

Replace `export type TaskStatus = …;` and the whole `export interface Task { … }` with:

```ts
export type TaskStatus = 'backlog' | 'todo' | 'doing' | 'done';

/** Kind of card: epics group the work; stories, tasks, bugs and spikes are the work; subtasks are a checklist inside a story or task. */
export type TaskType = 'epic' | 'story' | 'task' | 'subtask' | 'bug' | 'spike';

/** What a board column means to the system (the backlog is not a column). */
export type ColumnCategory = 'todo' | 'doing' | 'done';

export interface Task {
  id: string;
  project_id: string;
  type: TaskType;
  /** sequential per project */
  number: number;
  /** "TER-12"; the card opens at /project/<ref> */
  ref: string;
  title: string;
  description: string | null;
  /** backlog, or the category of its column */
  status: TaskStatus;
  position: number;
  external_ref: ExternalRef | null;
  external_key: string | null;
  tab_id: string | null;
  /** Parent story/task for a subtask; null for every other card. */
  parent_id: string | null;
  /** the epic of a story/task/bug/spike; null on epics and subtasks */
  epic_id: string | null;
  /** board column; null in the backlog and on subtasks */
  column_id: string | null;
  /** Only on top-level cards from the list endpoint. */
  subtasks?: Task[];
  subtask_counts?: { done: number; total: number };
  created_at: string;
  updated_at: string;
}

/** A board column of a project: the user's name, the system's category. */
export interface TaskColumn {
  id: string;
  project_id: string;
  name: string;
  category: ColumnCategory;
  position: number;
  created_at: string;
}

/** GET /projects/:id/tasks */
export interface BoardData {
  tasks: Task[];
  columns: TaskColumn[];
  agent_column_id: string | null;
}

export interface TaskCreateInput {
  title: string;
  description?: string | null;
  status?: TaskStatus;
  type?: TaskType;
  epic_id?: string | null;
  column_id?: string | null;
  parent_id?: string | null;
}

export interface TaskPatchInput {
  title?: string;
  description?: string | null;
  status?: TaskStatus;
  type?: TaskType;
  epic_id?: string | null;
}

/** Where a move sends a card: a column, or a status (backlog, or the first column of a category). */
export type MoveTarget = { column_id: string } | { status: TaskStatus };
```

After the `TASK_STATUS_LABEL` constant add:

```ts
export const TASK_TYPE_LABEL: Record<TaskType, string> = {
  epic: 'Épico',
  story: 'História',
  task: 'Tarefa',
  subtask: 'Subtarefa',
  bug: 'Bug',
  spike: 'Spike',
};

export const COLUMN_CATEGORY_LABEL: Record<ColumnCategory, string> = {
  todo: 'A fazer',
  doing: 'Fazendo',
  done: 'Feito',
};
```

- [ ] **Step 2: API client**

In `apps/web/src/lib/api.ts`, in the type import on line 1 replace `Task, Transcription, TaskStatus,` with `Task, Transcription, BoardData, ColumnCategory, MoveTarget, TaskColumn, TaskCreateInput, TaskPatchInput,`.

In the `tasks` block replace the `list`, `create`, `update` and `move` entries (the first six lines of the block) with:

```ts
    list: (projectId: string) => request<BoardData>('GET', `/projects/${projectId}/tasks`),
    create: (projectId: string, input: TaskCreateInput) => request<{ task: Task }>('POST', `/projects/${projectId}/tasks`, input),
    update: (id: string, input: TaskPatchInput) => request<{ task: Task }>('PATCH', `/tasks/${id}`, input),
    move: (id: string, target: MoveTarget, position: number) => request<{ task: Task }>('POST', `/tasks/${id}/move`, { ...target, position }),
    /** `KEY-N`, key case-insensitive; 404 outside the scope */
    byRef: (ref: string) => request<{ task: Task; project_id: string }>('GET', `/tasks/by-ref/${encodeURIComponent(ref)}`),
```

and right after the `tasks` block (before `tickets: {`) add:

```ts
  columns: {
    create: (projectId: string, input: { name: string; category: ColumnCategory }) => request<{ column: TaskColumn }>('POST', `/projects/${projectId}/columns`, input),
    update: (id: string, input: { name?: string; category?: ColumnCategory }) => request<{ column: TaskColumn }>('PATCH', `/columns/${id}`, input),
    move: (id: string, position: number) => request<{ columns: TaskColumn[] }>('POST', `/columns/${id}/move`, { position }),
    remove: (id: string) => request<{ ok: true; moved_tasks: number }>('DELETE', `/columns/${id}`),
    setAgent: (projectId: string, columnId: string | null) => request<{ agent_column_id: string | null }>('PUT', `/projects/${projectId}/agent-column`, { column_id: columnId }),
  },
```

In `apps/web/src/components/TasksBoard.tsx`, replace `await api.tasks.move(id, status, pos);` with `await api.tasks.move(id, { status }, pos);` (the board is rewritten in Task 10; this keeps it compiling).

- [ ] **Step 3: Write the failing helper tests**

`apps/web/src/lib/board.test.ts`:

```ts
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyMove,
  backlogSections,
  canHaveSubtasks,
  cardPath,
  cardsIn,
  DEFAULT_FILTER,
  dropPosition,
  epicsOf,
  nextColumn,
  openCount,
  readBoardFilter,
  typeOptions,
  visible,
  WORK_TYPES,
  writeBoardFilter,
} from './board';
import type { Task, TaskColumn } from './types';

const task = (over: Partial<Task> & { id: string }): Task => ({
  project_id: 'p1', type: 'task', number: 1, ref: `P1-${over.id}`, title: over.id, description: null, status: 'todo', position: 0,
  external_ref: null, external_key: null, tab_id: null, parent_id: null, epic_id: 'e1', column_id: 'c1', created_at: '', updated_at: '', ...over,
});
const col = (id: string, category: TaskColumn['category'], position: number): TaskColumn => ({ id, project_id: 'p1', name: id, category, position, created_at: '' });

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('board filter', () => {
  it('defaults to stories, tasks, bugs and spikes of every epic', () => {
    expect(readBoardFilter('p1')).toEqual({ types: ['story', 'task', 'bug', 'spike'], epicId: null });
    expect(DEFAULT_FILTER.types).toEqual(WORK_TYPES);
  });

  it('is remembered per project and drops unknown types or broken JSON', () => {
    writeBoardFilter('p1', { types: ['epic', 'bug'], epicId: 'e2' });
    expect(readBoardFilter('p1')).toEqual({ types: ['bug', 'epic'], epicId: 'e2' });
    expect(readBoardFilter('p2')).toEqual(DEFAULT_FILTER);
    localStorage.setItem('termhub:board-filter:p3', JSON.stringify({ types: ['nope', 'spike'] }));
    expect(readBoardFilter('p3')).toEqual({ types: ['spike'], epicId: null });
    localStorage.setItem('termhub:board-filter:p4', 'not json');
    expect(readBoardFilter('p4')).toEqual(DEFAULT_FILTER);
  });

  it('survives a storage that throws (private mode)', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    expect(readBoardFilter('p1')).toEqual(DEFAULT_FILTER);
    expect(() => writeBoardFilter('p1', DEFAULT_FILTER)).not.toThrow();
  });

  it('lets through the chosen types and, with an epic chosen, its cards and the epic itself', () => {
    const a = task({ id: 'a' });
    const b = task({ id: 'b', type: 'bug', epic_id: 'e2' });
    const e1 = task({ id: 'e1', type: 'epic', epic_id: null });
    expect(visible([a, b, e1], DEFAULT_FILTER).map((t) => t.id)).toEqual(['a', 'b']);
    expect(visible([a, b, e1], { types: [...WORK_TYPES, 'epic'], epicId: 'e1' }).map((t) => t.id)).toEqual(['a', 'e1']);
  });
});

describe('columns', () => {
  it('lists a column\'s top-level cards by position, subtasks and other columns left out', () => {
    const tasks = [task({ id: 'b', position: 1 }), task({ id: 'a', position: 0 }), task({ id: 's', parent_id: 'a', column_id: null }), task({ id: 'z', column_id: 'c2' })];
    expect(cardsIn(tasks, 'c1').map((t) => t.id)).toEqual(['a', 'b']);
  });

  it('finds the next column by position, none after the last', () => {
    const columns = [col('c3', 'done', 2), col('c1', 'todo', 0), col('c2', 'doing', 1)];
    expect(nextColumn(columns, 'c1')?.id).toBe('c2');
    expect(nextColumn(columns, 'c3')).toBeUndefined();
  });
});

describe('dropPosition', () => {
  const all = ['a', 'b', 'c', 'd', 'e'].map((id, position) => task({ id, position }));
  const shown = [all[0], all[2], all[4]]; // b and d hidden by the filter

  it('drops right after the visible card above the drop point; hidden cards keep their places', () => {
    expect(dropPosition(all, shown, 0, 'x')).toBe(0);
    expect(dropPosition(all, shown, 1, 'x')).toBe(1); // after a, before the hidden b
    expect(dropPosition(all, shown, 2, 'x')).toBe(3); // after c, before the hidden d
    expect(dropPosition(all, shown, 3, 'x')).toBe(5); // after e: the end
  });

  it('counts the dragged card out when it moves down inside its own column', () => {
    expect(dropPosition(all, shown, 2, 'a')).toBe(2); // below c: b, c, a, d, e
    expect(dropPosition(all, shown, 1, 'a')).toBe(0); // its own place
    expect(dropPosition(all, shown, 0, 'e')).toBe(0);
  });
});

describe('applyMove', () => {
  it('reindexes the target column and the one the card left, and takes the column category', () => {
    const tasks = [task({ id: 'a', position: 0 }), task({ id: 'b', position: 1 }), task({ id: 'x', column_id: 'c2', status: 'doing', position: 0 })];
    const next = applyMove(tasks, 'a', col('c2', 'doing', 1), 1);
    const get = (id: string) => next.find((t) => t.id === id)!;
    expect(get('a')).toMatchObject({ column_id: 'c2', status: 'doing', position: 1 });
    expect(get('x').position).toBe(0);
    expect(get('b').position).toBe(0);
  });
});

describe('epics, counts and the backlog', () => {
  const tasks = [
    task({ id: 'e2', type: 'epic', number: 5, epic_id: null, column_id: null, status: 'backlog' }),
    task({ id: 'e1', type: 'epic', number: 1, epic_id: null, column_id: null, status: 'backlog' }),
    task({ id: 'b1', status: 'backlog', column_id: null, position: 1 }),
    task({ id: 'b0', status: 'backlog', column_id: null, position: 0, type: 'bug' }),
    task({ id: 'd', status: 'done', column_id: 'c3' }),
    task({ id: 't', status: 'todo' }),
    task({ id: 'x', status: 'doing', epic_id: 'e2', column_id: 'c2' }),
    task({ id: 's', status: 'doing', parent_id: 't', type: 'subtask', epic_id: null, column_id: null }),
  ];

  it('orders epics by number (the default epic first)', () => {
    expect(epicsOf(tasks).map((t) => t.id)).toEqual(['e1', 'e2']);
  });

  it('counts open work only: work types in todo or doing, no epics, no subtasks', () => {
    expect(openCount([...tasks, task({ id: 'eb', type: 'epic', status: 'doing', epic_id: null })])).toBe(2);
  });

  it('builds one section per epic with its backlog items in order and its progress on the board', () => {
    const [s1, s2] = backlogSections(tasks);
    expect(s1.epic.id).toBe('e1');
    expect(s1.items.map((t) => t.id)).toEqual(['b0', 'b1']);
    expect([s1.done, s1.total]).toEqual([1, 2]);
    expect(s2.items).toEqual([]);
    expect([s2.done, s2.total]).toEqual([0, 1]);
  });
});

describe('card rules on the web', () => {
  it('offers the type changes the server allows', () => {
    expect(typeOptions(task({ id: 'a' }))).toEqual(['story', 'task', 'bug', 'spike']);
    expect(typeOptions(task({ id: 'a', type: 'story', subtasks: [task({ id: 's', parent_id: 'a' })] }))).toEqual(['story', 'task']);
    expect(typeOptions(task({ id: 'e', type: 'epic' }))).toEqual(['epic']);
    expect(canHaveSubtasks(task({ id: 'b', type: 'bug' }))).toBe(false);
    expect(canHaveSubtasks(task({ id: 's', type: 'story' }))).toBe(true);
    expect(cardPath('TER-12')).toBe('/project/TER-12');
  });
});
```

- [ ] **Step 4: Run it to see it fail**

```bash
th 'npx vitest run --root apps/web src/lib/board.test.ts'; rm -rf .npm
```

Expected: FAIL — cannot find module `./board`.

- [ ] **Step 5: Implement the helpers**

`apps/web/src/lib/board.ts`:

```ts
import type { Task, TaskColumn, TaskType } from './types';

/** The work: what the board shows by default and the open counter counts. */
export const WORK_TYPES: TaskType[] = ['story', 'task', 'bug', 'spike'];
/** The board's type-filter chips, in display order (spec §7: default all but Épico). */
export const FILTER_TYPES: TaskType[] = ['story', 'task', 'bug', 'spike', 'epic'];

export interface BoardFilter {
  types: TaskType[];
  /** only this epic's cards; null = every epic */
  epicId: string | null;
}

export const DEFAULT_FILTER: BoardFilter = { types: WORK_TYPES, epicId: null };

const filterKey = (projectId: string) => `termhub:board-filter:${projectId}`;

/** The filter remembered for a project. Best effort: private mode or broken JSON fall back to the default. */
export function readBoardFilter(projectId: string): BoardFilter {
  try {
    const raw = localStorage.getItem(filterKey(projectId));
    if (!raw) return DEFAULT_FILTER;
    const v = JSON.parse(raw) as { types?: unknown; epicId?: unknown };
    const types = Array.isArray(v.types) ? FILTER_TYPES.filter((t) => (v.types as unknown[]).includes(t)) : WORK_TYPES;
    return { types, epicId: typeof v.epicId === 'string' ? v.epicId : null };
  } catch {
    return DEFAULT_FILTER;
  }
}

export function writeBoardFilter(projectId: string, filter: BoardFilter): void {
  try {
    localStorage.setItem(filterKey(projectId), JSON.stringify(filter));
  } catch {
    /* private mode: the filter is just not remembered */
  }
}

const byPosition = (a: Task, b: Task) => a.position - b.position || a.created_at.localeCompare(b.created_at);

/** Every top-level card of a column in order, hidden or not: server positions count them all. */
export function cardsIn(tasks: Task[], columnId: string): Task[] {
  return tasks.filter((t) => !t.parent_id && t.column_id === columnId).sort(byPosition);
}

/** What the filter lets through: the chosen types and, with an epic chosen, that epic's cards (and the epic itself). */
export function visible(cards: Task[], filter: BoardFilter): Task[] {
  return cards.filter((t) => filter.types.includes(t.type) && (!filter.epicId || t.epic_id === filter.epicId || t.id === filter.epicId));
}

/**
 * The server position for a drop at `index` of the visible list — the index the person saw, which
 * counts the dragged card when it is in that list. The card goes right after the visible card above
 * the drop point (the top when there is none), so hidden cards keep their places.
 */
export function dropPosition(all: Task[], shown: Task[], index: number, movingId: string): number {
  const from = shown.findIndex((t) => t.id === movingId);
  const at = from !== -1 && from < index ? index - 1 : index;
  const allOthers = all.filter((t) => t.id !== movingId);
  const shownOthers = shown.filter((t) => t.id !== movingId);
  const above = shownOthers[Math.min(at, shownOthers.length) - 1];
  return above ? allOthers.indexOf(above) + 1 : 0;
}

/** Local copy of a move to a column, reindexing that column and the one the card left, as the server does. */
export function applyMove(tasks: Task[], id: string, column: TaskColumn, position: number): Task[] {
  const moving = tasks.find((t) => t.id === id);
  if (!moving) return tasks;
  const target = cardsIn(tasks, column.id).filter((t) => t.id !== id);
  target.splice(Math.max(0, Math.min(position, target.length)), 0, { ...moving, column_id: column.id, status: column.category });
  const next = new Map<string, Task>();
  target.forEach((t, i) => next.set(t.id, { ...t, position: i }));
  if (moving.column_id && moving.column_id !== column.id) {
    cardsIn(tasks, moving.column_id)
      .filter((t) => t.id !== id)
      .forEach((t, i) => next.set(t.id, { ...t, position: i }));
  }
  return tasks.map((t) => next.get(t.id) ?? t);
}

/** The column after this one by position; undefined for the last. */
export function nextColumn(columns: TaskColumn[], columnId: string): TaskColumn | undefined {
  const sorted = [...columns].sort((a, b) => a.position - b.position);
  const i = sorted.findIndex((c) => c.id === columnId);
  return i === -1 ? undefined : sorted[i + 1];
}

/** A project's epics by number; the first is the default epic. */
export function epicsOf(tasks: Task[]): Task[] {
  return tasks.filter((t) => t.type === 'epic').sort((a, b) => a.number - b.number);
}

/** Open work for the sidebar badge: stories, tasks, bugs and spikes in todo or doing. */
export function openCount(tasks: Task[]): number {
  return tasks.filter((t) => !t.parent_id && WORK_TYPES.includes(t.type) && (t.status === 'todo' || t.status === 'doing')).length;
}

export interface BacklogSection {
  epic: Task;
  /** the epic's backlog items, in order */
  items: Task[];
  /** progress over the epic's cards already on the board ("3/8 feitas") */
  done: number;
  total: number;
}

/** The Backlog view: one section per epic, the default epic (lowest number) first. */
export function backlogSections(tasks: Task[]): BacklogSection[] {
  return epicsOf(tasks).map((epic) => {
    const cards = tasks.filter((t) => !t.parent_id && t.epic_id === epic.id);
    const onBoard = cards.filter((t) => t.status !== 'backlog');
    return {
      epic,
      items: cards.filter((t) => t.status === 'backlog').sort(byPosition),
      done: onBoard.filter((t) => t.status === 'done').length,
      total: onBoard.length,
    };
  });
}

/** Types the editor offers (spec §3): epics and subtasks never change; a card with subtasks stays a story or task. */
export function typeOptions(task: Task): TaskType[] {
  if (task.type === 'epic' || task.type === 'subtask') return [task.type];
  return (task.subtasks?.length ?? 0) > 0 ? ['story', 'task'] : WORK_TYPES;
}

export const canHaveSubtasks = (task: Task): boolean => task.type === 'story' || task.type === 'task';

/** A card's own URL path (spec §7): `/project/TER-12`. */
export const cardPath = (ref: string): string => `/project/${ref}`;
```

- [ ] **Step 6: Run the tests and the web typecheck**

```bash
th 'npx vitest run --root apps/web src/lib/board.test.ts && npm run typecheck -w @termhub/web && npm test -w @termhub/web'; rm -rf .npm
```

Expected: PASS; typecheck clean; the web suite green (component tests mock the API).

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/lib/types.ts apps/web/src/lib/api.ts apps/web/src/lib/board.ts apps/web/src/lib/board.test.ts apps/web/src/components/TasksBoard.tsx
git commit -m "Web: card types, refs and columns in the model; board helpers" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Card editor component and type marker

**Files:**
- Create: `apps/web/src/components/TypeBadge.tsx`
- Create: `apps/web/src/components/TaskEditor.tsx`
- Test: `apps/web/src/components/TaskEditor.test.tsx` (new)

**Interfaces:**
- Consumes: Task 8 `typeOptions`, `canHaveSubtasks`, `cardPath`, `TASK_TYPE_LABEL`, `TaskColumn`, `TaskPatchInput`; existing `Modal`, `SubtaskList({ parent, onChange, onError })`, `PROVIDER_LABEL`, `TASK_STATUS_LABEL`.
- Produces: `TypeBadge({ type }: { type: TaskType })` — a letter marker with the type name as its accessible label; `type PlaceTarget = { column_id: string } | { status: 'backlog' }`; `interface TaskEditorProps { task; columns; epics; terminalHref; onClose; onSave(patch: TaskPatchInput); onPlace(target: PlaceTarget); onDelete; onOpenTerminal; onPushStatus(): Promise<string | null>; onSubtasks; onError }`; `TaskEditor(props)` — modal titled with the ref: Título, Tipo, Épico (not on epics), Coluna (with "Backlog"), Descrição, Subtarefas (story/task only), external ref, terminal, "Copiar link", Excluir, Salvar.

- [ ] **Step 1: Write the failing test**

`apps/web/src/components/TaskEditor.test.tsx`:

```tsx
// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Task, TaskColumn } from '../lib/types';

vi.mock('./SubtaskList', () => ({ SubtaskList: () => <div>lista de subtarefas</div> }));

import { TaskEditor, type TaskEditorProps } from './TaskEditor';

const task = (over: Partial<Task> & { id: string }): Task => ({
  project_id: 'p1', type: 'task', number: 7, ref: 'P1-7', title: over.id, description: null, status: 'todo', position: 0,
  external_ref: null, external_key: null, tab_id: null, parent_id: null, epic_id: 'e1', column_id: 'c1', created_at: '2026-09-24T00:00:00.000Z', updated_at: '', ...over,
});
const columns: TaskColumn[] = [
  { id: 'c1', project_id: 'p1', name: 'A fazer', category: 'todo', position: 0, created_at: '' },
  { id: 'c2', project_id: 'p1', name: 'Em revisão', category: 'doing', position: 1, created_at: '' },
];
const epics = [
  task({ id: 'e1', type: 'epic', number: 1, ref: 'P1-1', title: 'Geral', epic_id: null, column_id: null, status: 'backlog' }),
  task({ id: 'e2', type: 'epic', number: 5, ref: 'P1-5', title: 'Checkout', epic_id: null, column_id: null, status: 'backlog' }),
];

function mount(t: Task, over: Partial<TaskEditorProps> = {}) {
  const props: TaskEditorProps = {
    task: t, columns, epics, terminalHref: null, onClose: vi.fn(), onSave: vi.fn(), onPlace: vi.fn(), onDelete: vi.fn(), onOpenTerminal: vi.fn(),
    onPushStatus: vi.fn(async () => null), onSubtasks: vi.fn(), onError: vi.fn(), ...over,
  };
  render(
    <MemoryRouter>
      <TaskEditor {...props} />
    </MemoryRouter>,
  );
  return props;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('TaskEditor', () => {
  it('is titled with the ref and saves type and epic changes', () => {
    const props = mount(task({ id: 'Pagar' }));
    expect(screen.getByRole('heading', { name: 'P1-7' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Tipo'), { target: { value: 'bug' } });
    fireEvent.change(screen.getByLabelText('Épico'), { target: { value: 'e2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    expect(props.onSave).toHaveBeenCalledWith({ type: 'bug', epic_id: 'e2' });
    expect(props.onClose).toHaveBeenCalled();
  });

  it('keeps a card with subtasks a story or a task, and shows its checklist', () => {
    mount(task({ id: 's', type: 'story', subtasks: [task({ id: 'x', parent_id: 's', type: 'subtask' })] }));
    const options = Array.from((screen.getByLabelText('Tipo') as HTMLSelectElement).options).map((o) => o.textContent);
    expect(options).toEqual(['História', 'Tarefa']);
    expect(screen.getByText('lista de subtarefas')).toBeInTheDocument();
  });

  it('never changes an epic\'s type and has no epic select on it', () => {
    mount(epics[1]);
    expect(screen.getByLabelText('Tipo')).toBeDisabled();
    expect(screen.queryByLabelText('Épico')).not.toBeInTheDocument();
    expect(screen.queryByText('lista de subtarefas')).not.toBeInTheDocument();
  });

  it('has no checklist on a bug', () => {
    mount(task({ id: 'b', type: 'bug' }));
    expect(screen.queryByText('lista de subtarefas')).not.toBeInTheDocument();
  });

  it('moves between columns and to the backlog from the column select', () => {
    const props = mount(task({ id: 'a' }));
    const select = screen.getByLabelText('Coluna') as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual(['Backlog', 'A fazer', 'Em revisão']);
    fireEvent.change(select, { target: { value: 'c2' } });
    expect(props.onPlace).toHaveBeenCalledWith({ column_id: 'c2' });
    fireEvent.change(select, { target: { value: '' } });
    expect(props.onPlace).toHaveBeenLastCalledWith({ status: 'backlog' });
  });

  it('copies the card link', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    mount(task({ id: 'a' }));
    fireEvent.click(screen.getByRole('button', { name: 'Copiar link' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/project/P1-7`));
    expect(await screen.findByRole('button', { name: 'Link copiado' })).toBeInTheDocument();
  });

  it('asks before deleting', () => {
    const props = mount(task({ id: 'a' }));
    fireEvent.click(screen.getByRole('button', { name: 'Excluir' }));
    fireEvent.click(screen.getByRole('button', { name: 'Sim, excluir' }));
    expect(props.onDelete).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it to see it fail**

```bash
th 'npx vitest run --root apps/web src/components/TaskEditor.test.tsx'; rm -rf .npm
```

Expected: FAIL — cannot find module `./TaskEditor`.

- [ ] **Step 3: Type marker**

`apps/web/src/components/TypeBadge.tsx`:

```tsx
import { TASK_TYPE_LABEL, type TaskType } from '../lib/types';

const STYLE: Record<TaskType, { mark: string; className: string }> = {
  epic: { mark: 'É', className: 'bg-accent/20 text-accent' },
  story: { mark: 'H', className: 'bg-ok/20 text-ok' },
  task: { mark: 'T', className: 'bg-bg-4 text-fg-muted' },
  subtask: { mark: 's', className: 'bg-bg-4 text-fg-dim' },
  bug: { mark: 'B', className: 'bg-danger/20 text-danger' },
  spike: { mark: 'S', className: 'bg-warn/20 text-warn' },
};

/** A card's type as a small letter; the full name is its tooltip and accessible label. */
export function TypeBadge({ type }: { type: TaskType }) {
  const s = STYLE[type];
  return (
    <span
      role="img"
      aria-label={TASK_TYPE_LABEL[type]}
      title={TASK_TYPE_LABEL[type]}
      className={`inline-flex h-4 w-4 shrink-0 items-center justify-center rounded text-[10px] font-semibold ${s.className}`}
    >
      {s.mark}
    </span>
  );
}
```

- [ ] **Step 4: The editor**

`apps/web/src/components/TaskEditor.tsx`:

```tsx
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { canHaveSubtasks, cardPath, typeOptions } from '../lib/board';
import { PROVIDER_LABEL, TASK_STATUS_LABEL, TASK_TYPE_LABEL, type Task, type TaskColumn, type TaskPatchInput, type TaskType } from '../lib/types';
import { Modal } from './Modal';
import { SubtaskList } from './SubtaskList';

/** Where the column select sends a card. */
export type PlaceTarget = { column_id: string } | { status: 'backlog' };

export interface TaskEditorProps {
  /** a top-level card, with its subtasks */
  task: Task;
  columns: TaskColumn[];
  /** the project's epics, default first */
  epics: Task[];
  terminalHref: string | null;
  onClose: () => void;
  onSave: (patch: TaskPatchInput) => void;
  onPlace: (target: PlaceTarget) => void;
  onDelete: () => void;
  onOpenTerminal: () => void;
  onPushStatus: () => Promise<string | null>;
  onSubtasks: (subtasks: Task[] | ((prev: Task[]) => Task[])) => void;
  onError: (message: string) => void;
}

/** A card's editor (spec §7 "Card editor"): title, type, epic, column, description, subtasks, link. */
export function TaskEditor({ task, columns, epics, terminalHref, onClose, onSave, onPlace, onDelete, onOpenTerminal, onPushStatus, onSubtasks, onError }: TaskEditorProps) {
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description ?? '');
  const [type, setType] = useState<TaskType>(task.type);
  const [epicId, setEpicId] = useState(task.epic_id ?? '');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [pushing, setPushing] = useState<'idle' | 'busy' | string>('idle');
  const [copied, setCopied] = useState<'idle' | 'ok' | 'fail'>('idle');
  const ref = task.external_ref;
  const types = typeOptions(task);

  const save = () => {
    const patch: TaskPatchInput = {};
    if (title.trim() && title.trim() !== task.title) patch.title = title.trim();
    if ((description.trim() || null) !== (task.description ?? null)) patch.description = description.trim() || null;
    if (type !== task.type) patch.type = type;
    if (task.type !== 'epic' && epicId && epicId !== task.epic_id) patch.epic_id = epicId;
    if (Object.keys(patch).length) onSave(patch);
    onClose();
  };

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}${cardPath(task.ref)}`);
      setCopied('ok');
    } catch {
      setCopied('fail');
    }
  };

  return (
    <Modal title={task.ref} open onClose={onClose} width="max-w-lg">
      <div className="space-y-3">
        <div>
          <label className="label" htmlFor="card-title">
            Título
          </label>
          <input id="card-title" className="input" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
        </div>
        <div className="grid grid-cols-3 gap-2">
          <div>
            <label className="label" htmlFor="card-type">
              Tipo
            </label>
            <select id="card-type" className="input" value={type} disabled={types.length === 1} onChange={(e) => setType(e.target.value as TaskType)}>
              {types.map((t) => (
                <option key={t} value={t}>
                  {TASK_TYPE_LABEL[t]}
                </option>
              ))}
            </select>
          </div>
          {task.type !== 'epic' && (
            <div>
              <label className="label" htmlFor="card-epic">
                Épico
              </label>
              <select id="card-epic" className="input" value={epicId} onChange={(e) => setEpicId(e.target.value)}>
                {epics.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.ref} {e.title}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div>
            <label className="label" htmlFor="card-column">
              Coluna
            </label>
            <select
              id="card-column"
              className="input"
              value={task.column_id ?? ''}
              onChange={(e) => onPlace(e.target.value ? { column_id: e.target.value } : { status: 'backlog' })}
            >
              <option value="">Backlog</option>
              {columns.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div>
          <label className="label" htmlFor="card-description">
            Descrição
          </label>
          <textarea
            id="card-description"
            className="input min-h-[120px] font-mono text-xs"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Detalhes, links, contexto…"
          />
        </div>
        {canHaveSubtasks(task) && <SubtaskList parent={task} onChange={onSubtasks} onError={onError} />}
        {ref && (
          <div className="rounded-md border border-line bg-bg p-3 text-xs">
            <div className="flex items-center gap-2">
              <a href={ref.url} target="_blank" rel="noreferrer" className="rounded bg-accent/15 px-1 font-mono text-accent hover:bg-accent/25">
                {ref.identifier}
              </a>
              <span className="text-fg-muted">
                {PROVIDER_LABEL[ref.provider]}: <strong className="text-fg">{ref.state}</strong>
              </span>
              {ref.status !== task.status && <span className="text-warn">≠ {TASK_STATUS_LABEL[task.status]} aqui</span>}
              <button
                type="button"
                className="btn-ghost ml-auto border border-line px-2 py-0.5 text-[11px]"
                disabled={pushing === 'busy'}
                onClick={async () => {
                  setPushing('busy');
                  const st = await onPushStatus();
                  setPushing(st ? `atualizado: ${st}` : 'idle');
                }}
                title="Muda o estado no provedor para refletir a coluna atual. Nada é enviado sem este clique."
              >
                {pushing === 'busy' ? 'atualizando…' : `Atualizar no ${PROVIDER_LABEL[ref.provider]}`}
              </button>
            </div>
            {pushing !== 'idle' && pushing !== 'busy' && <p className="mt-1 text-ok">{pushing}</p>}
            {ref.pushed_at && <p className="mt-1 text-fg-dim">último envio: {new Date(ref.pushed_at).toLocaleString('pt-BR')}</p>}
          </div>
        )}
        <div className="flex items-center gap-2 text-xs">
          {terminalHref ? (
            <Link to={terminalHref} className="btn-ghost border border-line text-ok">
              ▮_ Ir para o terminal
            </Link>
          ) : (
            <button type="button" className="btn-ghost border border-line" onClick={onOpenTerminal}>
              ▮_ Abrir terminal para esta task
            </button>
          )}
          <span className="text-fg-dim">a tab fica ligada ao card e aparece nele</span>
        </div>
        <div className="flex items-center justify-between gap-2 pt-2 text-xs text-fg-dim">
          <span className="flex items-center gap-2">
            criado em {new Date(task.created_at).toLocaleDateString('pt-BR')}
            <button type="button" className="btn-ghost border border-line px-2 py-0.5 text-[11px]" onClick={() => void copyLink()}>
              {copied === 'ok' ? 'Link copiado' : 'Copiar link'}
            </button>
            {copied === 'fail' && <span className="text-danger">não deu para copiar</span>}
          </span>
          <div className="flex gap-2">
            {confirmDelete ? (
              <>
                <span className="self-center">{(task.subtasks?.length ?? 0) > 0 ? `Excluir com ${task.subtasks!.length} subtarefa(s)?` : 'Excluir?'}</span>
                <button className="btn-danger" onClick={onDelete}>
                  Sim, excluir
                </button>
                <button className="btn-ghost" onClick={() => setConfirmDelete(false)}>
                  Não
                </button>
              </>
            ) : (
              <button className="btn-ghost text-danger" onClick={() => setConfirmDelete(true)}>
                Excluir
              </button>
            )}
            <button className="btn-primary" onClick={save}>
              Salvar
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
```

- [ ] **Step 5: Run the tests and the web typecheck**

```bash
th 'npx vitest run --root apps/web src/components/TaskEditor.test.tsx && npm run typecheck -w @termhub/web'; rm -rf .npm
```

Expected: PASS (7 tests), typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/TypeBadge.tsx apps/web/src/components/TaskEditor.tsx apps/web/src/components/TaskEditor.test.tsx
git commit -m "Web: card editor with type, epic, column and copy link" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: Board with the project's columns, type/epic filter and card markers

**Files:**
- Modify (full rewrite): `apps/web/src/components/TasksBoard.tsx`
- Test (full rewrite): `apps/web/src/components/TasksBoard.test.tsx`

**Interfaces:**
- Consumes: Task 8 `api.tasks.list/create/update/move`, `cardsIn`, `visible`, `dropPosition`, `applyMove`, `nextColumn`, `epicsOf`, `openCount`, `readBoardFilter`, `writeBoardFilter`, `FILTER_TYPES`, `BoardFilter`, `COLUMN_CATEGORY_LABEL`, `TASK_TYPE_LABEL`; Task 9 `TaskEditor`, `PlaceTarget`, `TypeBadge`; existing `useData().{projects, machinesOf, setOpenTasks}`, `MachinePicker`, `readLastMachine`/`writeLastMachine`.
- Produces: `TasksBoard({ projectId })` — one `<section aria-label={column.name}>` per column in position order (horizontal scroll, 260px each); a toolbar with type chips (`aria-pressed`, labels "História", "Tarefa", "Bug", "Spike", "Épico") and an epic select labelled "Filtrar por épico", remembered in `localStorage` key `termhub:board-filter:<projectId>`; quick add "+ novo card (Enter)" per column (`api.tasks.create(projectId, { title, column_id })`); cards with type marker, ref, title, epic name, subtask counter, terminal link, "Abrir card" (⋯) and "Mover para <next column>" (→); native drag and drop keyed by column. The editor opens from local state here; Task 11 moves it to the URL.

- [ ] **Step 1: Write the failing test**

Replace `apps/web/src/components/TasksBoard.test.tsx` with:

```tsx
// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Machine, Project, Task, TaskColumn } from '../lib/types';

const listMock = vi.fn();
const openTerminalMock = vi.fn();
const createMock = vi.fn();
const moveMock = vi.fn();
vi.mock('../lib/api', () => {
  class ApiError extends Error {}
  return {
    ApiError,
    api: {
      tasks: {
        list: (...a: unknown[]) => listMock(...a),
        openTerminal: (...a: unknown[]) => openTerminalMock(...a),
        create: (...a: unknown[]) => createMock(...a),
        move: (...a: unknown[]) => moveMock(...a),
      },
    },
  };
});

const machines = [{ id: 'm1', name: 'mac', capabilities: [] }, { id: 'm2', name: 'jarvis', capabilities: [] }] as Machine[];
let project: Project;
vi.mock('../lib/data', () => ({
  useData: () => ({
    projects: [project],
    machinesOf: (p: Project) => p.machines.map((l) => machines.find((m) => m.id === l.machine_id)!),
    setOpenTasks: () => {},
  }),
}));

import { TasksBoard } from './TasksBoard';

const task = (over: Partial<Task> & { id: string }): Task => ({
  project_id: 'p1', type: 'task', number: 2, ref: `P1-${over.id}`, title: over.id, description: null, status: 'todo', position: 0,
  external_ref: null, external_key: null, tab_id: null, parent_id: null, epic_id: 'e1', column_id: 'c1', created_at: '', updated_at: '', ...over,
});
const epic = (id: string, title: string, number: number) => task({ id, title, number, ref: `P1-${number}`, type: 'epic', epic_id: null, column_id: null, status: 'backlog' });
const col = (id: string, name: string, category: TaskColumn['category'], position: number): TaskColumn => ({ id, project_id: 'p1', name, category, position, created_at: '' });
const columns = [col('c3', 'Feito', 'done', 2), col('c1', 'A fazer', 'todo', 0), col('c2', 'Em revisão', 'doing', 1)];
const board = (tasks: Task[]) => ({ tasks, columns, agent_column_id: null });

function mount() {
  return render(
    <MemoryRouter>
      <TasksBoard projectId="p1" />
    </MemoryRouter>,
  );
}

/** Opens the card editor and clicks "Abrir terminal para esta task". */
async function requestTerminal(taskTitle = 't1') {
  await screen.findByText(taskTitle);
  fireEvent.click(screen.getByTitle('Abrir card'));
  fireEvent.click(await screen.findByRole('button', { name: /Abrir terminal para esta task/ }));
}

beforeEach(() => {
  localStorage.clear();
  project = { id: 'p1', key: 'P1', name: 'p1', machines: [{ machine_id: 'm1', cwd: '/a', position: 0 }] } as Project;
  listMock.mockResolvedValue(board([epic('e1', 'Geral', 1), task({ id: 't1' })]));
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('TasksBoard — columns, cards and filter', () => {
  it('renders one column per project column, in order, with each card\'s ref and epic', async () => {
    listMock.mockResolvedValue(board([epic('e1', 'Geral', 1), task({ id: 'a' }), task({ id: 'r', column_id: 'c2', status: 'doing' })]));
    mount();
    await screen.findByText('a');
    expect(screen.getAllByRole('region').map((r) => r.getAttribute('aria-label'))).toEqual(['A fazer', 'Em revisão', 'Feito']);
    expect(within(screen.getByRole('region', { name: 'Em revisão' })).getByText('r')).toBeInTheDocument();
    expect(screen.getByText('P1-a')).toBeInTheDocument();
    expect(screen.getAllByText('Geral')).toHaveLength(2);
    expect(within(screen.getByRole('region', { name: 'A fazer' })).getByRole('img', { name: 'Tarefa' })).toBeInTheDocument();
  });

  it('hides epics by default; the Épico chip shows them and is remembered', async () => {
    listMock.mockResolvedValue(board([epic('e1', 'Geral', 1), task({ id: 'epic on board', type: 'epic', epic_id: null, number: 3 }), task({ id: 'a' })]));
    mount();
    await screen.findByText('a');
    expect(screen.queryByText('epic on board')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Épico' }));
    expect(screen.getByText('epic on board')).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem('termhub:board-filter:p1')!).types).toContain('epic');
  });

  it('filters by epic', async () => {
    listMock.mockResolvedValue(board([epic('e1', 'Geral', 1), epic('e2', 'Checkout', 4), task({ id: 'a' }), task({ id: 'b', epic_id: 'e2' })]));
    mount();
    await screen.findByText('a');
    fireEvent.change(screen.getByLabelText('Filtrar por épico'), { target: { value: 'e2' } });
    expect(screen.queryByText('a')).not.toBeInTheDocument();
    expect(screen.getByText('b')).toBeInTheDocument();
  });

  it('quick add creates a card in that column', async () => {
    createMock.mockResolvedValue({ task: task({ id: 'nova', column_id: 'c2', status: 'doing' }) });
    mount();
    await screen.findByText('t1');
    const input = within(screen.getByRole('region', { name: 'Em revisão' })).getByPlaceholderText('+ novo card (Enter)');
    fireEvent.change(input, { target: { value: 'nova' } });
    fireEvent.submit(input.closest('form')!);
    await waitFor(() => expect(createMock).toHaveBeenCalledWith('p1', { title: 'nova', column_id: 'c2' }));
    expect(await within(screen.getByRole('region', { name: 'Em revisão' })).findByText('nova')).toBeInTheDocument();
  });

  it('the → button moves a card to the next column', async () => {
    moveMock.mockResolvedValue({ task: task({ id: 't1', column_id: 'c2', status: 'doing' }) });
    mount();
    await screen.findByText('t1');
    fireEvent.click(screen.getByTitle('Mover para Em revisão'));
    await waitFor(() => expect(moveMock).toHaveBeenCalledWith('t1', { column_id: 'c2' }, 0));
    expect(within(screen.getByRole('region', { name: 'Em revisão' })).getByText('t1')).toBeInTheDocument();
  });
});

describe('TasksBoard — choosing a machine to open a task terminal', () => {
  it('opens directly on the only linked machine, without a picker', async () => {
    openTerminalMock.mockResolvedValue({ task: task({ id: 't1', tab_id: 'tab1' }), tab: { id: 'tab1' }, created: true });
    mount();
    await requestTerminal();
    await waitFor(() => expect(openTerminalMock).toHaveBeenCalledWith('t1', 'm1'));
    expect(screen.queryByText('Abrir em qual máquina?')).not.toBeInTheDocument();
  });

  it('shows a picker with several machines when none was used before, and remembers the pick', async () => {
    project = { id: 'p1', key: 'P1', name: 'p1', machines: [{ machine_id: 'm1', cwd: '/a', position: 0 }, { machine_id: 'm2', cwd: '/b', position: 1 }] } as Project;
    openTerminalMock.mockResolvedValue({ task: task({ id: 't1', tab_id: 'tab1' }), tab: { id: 'tab1' }, created: true });
    mount();
    await requestTerminal();
    expect(await screen.findByText('Abrir em qual máquina?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /jarvis/ }));
    await waitFor(() => expect(openTerminalMock).toHaveBeenCalledWith('t1', 'm2'));
    expect(localStorage.getItem('termhub:last-machine:p1')).toBe('m2');
  });

  it('skips the picker and reuses the last machine when it is still linked', async () => {
    localStorage.setItem('termhub:last-machine:p1', 'm2');
    project = { id: 'p1', key: 'P1', name: 'p1', machines: [{ machine_id: 'm1', cwd: '/a', position: 0 }, { machine_id: 'm2', cwd: '/b', position: 1 }] } as Project;
    openTerminalMock.mockResolvedValue({ task: task({ id: 't1', tab_id: 'tab1' }), tab: { id: 'tab1' }, created: true });
    mount();
    await requestTerminal();
    await waitFor(() => expect(openTerminalMock).toHaveBeenCalledWith('t1', 'm2'));
    expect(screen.queryByText('Abrir em qual máquina?')).not.toBeInTheDocument();
  });

  it('shows the no-machine error and never calls the API when the project has no linked machine', async () => {
    project = { id: 'p1', key: 'P1', name: 'p1', machines: [] } as unknown as Project;
    mount();
    await requestTerminal();
    expect(await screen.findByText('Vincule uma máquina ao projeto em Setup → Máquinas para abrir terminais.')).toBeInTheDocument();
    expect(openTerminalMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it to see it fail**

```bash
th 'npx vitest run --root apps/web src/components/TasksBoard.test.tsx'; rm -rf .npm
```

Expected: FAIL — the old board renders the four fixed columns, has no toolbar, no "Abrir card" title.

- [ ] **Step 3: Rewrite the board**

Replace `apps/web/src/components/TasksBoard.tsx` with:

```tsx
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { applyMove, cardsIn, dropPosition, epicsOf, FILTER_TYPES, nextColumn, openCount, readBoardFilter, visible, writeBoardFilter, type BoardFilter } from '../lib/board';
import { useData } from '../lib/data';
import { readLastMachine, writeLastMachine } from '../lib/last-machine';
import { COLUMN_CATEGORY_LABEL, PROVIDER_LABEL, TASK_TYPE_LABEL, type ColumnCategory, type Task, type TaskColumn, type TaskPatchInput, type TaskType } from '../lib/types';
import { MachinePicker } from './MachinePicker';
import { TaskEditor, type PlaceTarget } from './TaskEditor';
import { TypeBadge } from './TypeBadge';

const CATEGORY_DOT: Record<ColumnCategory, string> = { todo: 'bg-fg-dim', doing: 'bg-accent', done: 'bg-ok' };

interface Props {
  projectId: string;
}

interface DragState {
  taskId: string;
  overColumn: string | null;
  overIndex: number | null;
}

/** The project's Board (spec §7): its own columns, a type/epic filter, cards with type, ref and epic. */
export function TasksBoard({ projectId }: Props) {
  const { projects, machinesOf, setOpenTasks } = useData();
  const navigate = useNavigate();
  const project = projects.find((p) => p.id === projectId);
  const projectMachines = project ? machinesOf(project) : [];
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [columns, setColumns] = useState<TaskColumn[]>([]);
  const [filter, setFilter] = useState<BoardFilter>(() => readBoardFilter(projectId));
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [pickingMachineFor, setPickingMachineFor] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api.tasks.list(projectId);
      setTasks(r.tasks);
      setColumns([...r.columns].sort((a, b) => a.position - b.position));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Erro ao carregar o board');
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (tasks) setOpenTasks(projectId, openCount(tasks));
  }, [tasks, projectId, setOpenTasks]);

  const epics = useMemo(() => epicsOf(tasks ?? []), [tasks]);
  const epicTitle = useMemo(() => new Map(epics.map((e) => [e.id, e.title])), [epics]);
  const editing = editingId ? ((tasks ?? []).find((t) => t.id === editingId) ?? null) : null;

  const changeFilter = (next: BoardFilter) => {
    setFilter(next);
    writeBoardFilter(projectId, next);
  };

  const fail = (e: unknown, fallback: string) => {
    setError(e instanceof ApiError ? e.message : fallback);
    void load();
  };

  // PATCH/move answer with the bare card: keep the subtasks the list endpoint gave us
  const replaceTask = (task: Task) => setTasks((t) => (t ?? []).map((x) => (x.id === task.id ? { ...task, subtasks: task.subtasks ?? x.subtasks } : x)));

  const setSubtasks = (parentId: string, v: Task[] | ((prev: Task[]) => Task[])) =>
    setTasks((t) => (t ?? []).map((x) => (x.id === parentId ? { ...x, subtasks: typeof v === 'function' ? v(x.subtasks ?? []) : v } : x)));

  const create = async (column: TaskColumn, title: string) => {
    try {
      const { task } = await api.tasks.create(projectId, { title, column_id: column.id });
      setTasks((t) => [...(t ?? []).map((x) => (!x.parent_id && x.column_id === column.id ? { ...x, position: x.position + 1 } : x)), { ...task, subtasks: [] }]);
      // the first card of a project also creates its default epic: fetch it for the names and the filter
      if (task.epic_id && !epicTitle.has(task.epic_id)) void load();
    } catch (e) {
      fail(e, 'Erro ao criar o card');
    }
  };

  const update = async (id: string, patch: TaskPatchInput) => {
    setTasks((t) => (t ?? []).map((x) => (x.id === id ? { ...x, ...patch } : x)));
    try {
      replaceTask((await api.tasks.update(id, patch)).task);
    } catch (e) {
      fail(e, 'Erro ao salvar o card');
    }
  };

  /** Moves locally (reindexing both columns) and persists. `position` is the server position. */
  const move = async (id: string, columnId: string, position: number) => {
    const column = columns.find((c) => c.id === columnId);
    if (!column) return;
    setTasks((t) => applyMove(t ?? [], id, column, position));
    try {
      replaceTask((await api.tasks.move(id, { column_id: columnId }, position)).task);
    } catch (e) {
      fail(e, 'Erro ao mover o card');
    }
  };

  const place = async (id: string, target: PlaceTarget) => {
    if ('column_id' in target) return move(id, target.column_id, 0);
    try {
      await api.tasks.move(id, target, 0);
      await load(); // it left the board: the column it was in closes its gap
    } catch (e) {
      fail(e, 'Erro ao mover o card');
    }
  };

  const openTerminal = async (id: string, machineId?: string) => {
    try {
      const r = await api.tasks.openTerminal(id, machineId);
      if (machineId) writeLastMachine(projectId, machineId);
      replaceTask(r.task);
      setEditingId(null);
      navigate(`/projects/${projectId}?tab=${r.tab.id}`);
    } catch (e) {
      fail(e, 'Erro ao abrir terminal');
    }
  };

  /** Resolves which machine to open the card's terminal on before calling the API. */
  const chooseTerminal = (id: string) => {
    if (projectMachines.length === 0) {
      setError('Vincule uma máquina ao projeto em Setup → Máquinas para abrir terminais.');
      return;
    }
    if (projectMachines.length === 1) {
      void openTerminal(id, projectMachines[0].id);
      return;
    }
    const last = readLastMachine(projectId);
    if (last && projectMachines.some((m) => m.id === last)) {
      void openTerminal(id, last);
      return;
    }
    setPickingMachineFor(id);
  };

  const pushStatus = async (id: string) => {
    try {
      const r = await api.tasks.pushStatus(id);
      replaceTask(r.task);
      return r.state;
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Erro ao atualizar no provedor');
      return null;
    }
  };

  /** Not optimistic: an epic that still has cards is refused (409) and must stay on screen. */
  const remove = async (id: string) => {
    setEditingId(null);
    try {
      await api.tasks.remove(id);
      setTasks((t) => (t ?? []).filter((x) => x.id !== id));
    } catch (e) {
      fail(e, 'Erro ao excluir o card');
    }
  };

  // --- native drag and drop, keyed by column ---
  const onDragStart = (e: DragEvent, task: Task) => {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', task.id);
    setDrag({ taskId: task.id, overColumn: null, overIndex: null });
  };
  const onDragOverColumn = (e: DragEvent, columnId: string, index: number) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDrag((d) => (d && (d.overColumn !== columnId || d.overIndex !== index) ? { ...d, overColumn: columnId, overIndex: index } : d));
  };
  const onDrop = (e: DragEvent, column: TaskColumn, index: number) => {
    e.preventDefault();
    const id = e.dataTransfer.getData('text/plain') || drag?.taskId;
    setDrag(null);
    if (!id || !tasks) return;
    const all = cardsIn(tasks, column.id);
    void move(id, column.id, dropPosition(all, visible(all, filter), index, id));
  };

  if (tasks === null) return <div className="flex h-full items-center justify-center text-sm text-fg-dim">{error ?? 'Carregando o board…'}</div>;
  const loaded = tasks;

  return (
    <div className="flex h-full flex-col">
      {error && (
        <div className="border-b border-danger/30 bg-danger/10 px-3 py-1 text-xs text-danger">
          {error}{' '}
          <button className="underline" onClick={() => setError(null)}>
            fechar
          </button>
        </div>
      )}
      <BoardToolbar filter={filter} epics={epics} onChange={changeFilter} />
      <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto p-3">
        {columns.map((column) => {
          const shown = visible(cardsIn(loaded, column.id), filter);
          const isOver = drag?.overColumn === column.id;
          const next = nextColumn(columns, column.id);
          return (
            <section
              key={column.id}
              aria-label={column.name}
              className={`flex min-h-0 w-[260px] shrink-0 flex-col rounded-lg border bg-bg-2 ${isOver ? 'border-accent/60' : 'border-line'}`}
              onDragOver={(e) => onDragOverColumn(e, column.id, shown.length)}
              onDrop={(e) => onDrop(e, column, drag?.overIndex ?? shown.length)}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node)) setDrag((d) => (d ? { ...d, overColumn: null, overIndex: null } : d));
              }}
            >
              <header className="flex items-center gap-2 px-3 py-2 text-xs font-semibold text-fg-muted">
                <span className={`h-2 w-2 shrink-0 rounded-full ${CATEGORY_DOT[column.category]}`} title={COLUMN_CATEGORY_LABEL[column.category]} />
                <span className="truncate">{column.name}</span>
                <span className="ml-auto rounded-full bg-bg-4 px-1.5 text-[10px] tabular-nums">{shown.length}</span>
              </header>
              <QuickAdd onAdd={(title) => void create(column, title)} />
              <ul className="min-h-0 flex-1 space-y-1.5 overflow-y-auto px-2 pb-2">
                {shown.map((task, i) => (
                  <li
                    key={task.id}
                    onDragOver={(e) => {
                      e.stopPropagation();
                      const rect = e.currentTarget.getBoundingClientRect();
                      onDragOverColumn(e, column.id, e.clientY < rect.top + rect.height / 2 ? i : i + 1);
                    }}
                    onDrop={(e) => {
                      e.stopPropagation();
                      onDrop(e, column, drag?.overIndex ?? i);
                    }}
                  >
                    {isOver && drag?.overIndex === i && drag.taskId !== task.id && <DropLine />}
                    <TaskCard
                      task={task}
                      epicTitle={task.epic_id ? (epicTitle.get(task.epic_id) ?? null) : null}
                      dragging={drag?.taskId === task.id}
                      onDragStart={(e) => onDragStart(e, task)}
                      onDragEnd={() => setDrag(null)}
                      onOpen={() => setEditingId(task.id)}
                      onRename={(title) => void update(task.id, { title })}
                      next={next}
                      onMoveNext={next ? () => void move(task.id, next.id, 0) : undefined}
                      terminalHref={task.tab_id ? `/projects/${projectId}?tab=${task.tab_id}` : null}
                    />
                  </li>
                ))}
                {isOver && drag && drag.overIndex === shown.length && <DropLine />}
                {shown.length === 0 && !isOver && <li className="px-1 py-6 text-center text-xs text-fg-dim">vazio</li>}
              </ul>
            </section>
          );
        })}
      </div>

      {editing && (
        <TaskEditor
          key={editing.id}
          task={editing}
          columns={columns}
          epics={epics}
          terminalHref={editing.tab_id ? `/projects/${projectId}?tab=${editing.tab_id}` : null}
          onClose={() => setEditingId(null)}
          onSave={(patch) => void update(editing.id, patch)}
          onPlace={(target) => void place(editing.id, target)}
          onDelete={() => void remove(editing.id)}
          onOpenTerminal={() => chooseTerminal(editing.id)}
          onPushStatus={() => pushStatus(editing.id)}
          onSubtasks={(subtasks) => setSubtasks(editing.id, subtasks)}
          onError={(message) => {
            setError(message);
            void load();
          }}
        />
      )}
      {project && (
        <MachinePicker
          open={pickingMachineFor !== null}
          project={project}
          machines={projectMachines}
          onPick={(machineId) => {
            const id = pickingMachineFor;
            setPickingMachineFor(null);
            if (id) void openTerminal(id, machineId);
          }}
          onClose={() => setPickingMachineFor(null)}
        />
      )}
    </div>
  );
}

function BoardToolbar({ filter, epics, onChange }: { filter: BoardFilter; epics: Task[]; onChange: (next: BoardFilter) => void }) {
  const toggle = (type: TaskType) =>
    onChange({ ...filter, types: FILTER_TYPES.filter((t) => (t === type ? !filter.types.includes(t) : filter.types.includes(t))) });
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2 text-xs">
      <span className="text-fg-dim">Mostrar:</span>
      {FILTER_TYPES.map((t) => (
        <button
          key={t}
          type="button"
          aria-pressed={filter.types.includes(t)}
          onClick={() => toggle(t)}
          className={`rounded-full border px-2 py-0.5 ${filter.types.includes(t) ? 'border-accent bg-accent/15 text-fg' : 'border-line text-fg-muted hover:bg-bg-3'}`}
        >
          {TASK_TYPE_LABEL[t]}
        </button>
      ))}
      <select
        aria-label="Filtrar por épico"
        className="input ml-auto w-auto py-1 text-xs"
        value={filter.epicId ?? ''}
        onChange={(e) => onChange({ ...filter, epicId: e.target.value || null })}
      >
        <option value="">Todos os épicos</option>
        {epics.map((e) => (
          <option key={e.id} value={e.id}>
            {e.ref} {e.title}
          </option>
        ))}
      </select>
    </div>
  );
}

function DropLine() {
  return <div className="my-1 h-0.5 rounded bg-accent" />;
}

function QuickAdd({ onAdd }: { onAdd: (title: string) => void }) {
  const [value, setValue] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const v = value.trim();
    if (!v) return;
    onAdd(v);
    setValue('');
  };
  return (
    <form onSubmit={submit} className="px-2 pb-2">
      <input
        className="input py-1.5 text-xs"
        placeholder="+ novo card (Enter)"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setValue('');
        }}
      />
    </form>
  );
}

interface CardProps {
  task: Task;
  epicTitle: string | null;
  dragging: boolean;
  onDragStart: (e: DragEvent) => void;
  onDragEnd: () => void;
  onOpen: () => void;
  onRename: (title: string) => void;
  next?: TaskColumn;
  onMoveNext?: () => void;
  terminalHref: string | null;
}

function TaskCard({ task, epicTitle, dragging, onDragStart, onDragEnd, onOpen, onRename, next, onMoveNext, terminalHref }: CardProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(task.title);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const commit = () => {
    setEditing(false);
    const v = draft.trim();
    if (v && v !== task.title) onRename(v);
    else setDraft(task.title);
  };

  const done = task.subtasks?.filter((s) => s.status === 'done').length ?? 0;
  const total = task.subtasks?.length ?? 0;

  return (
    <div
      draggable={!editing}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={() => {
        if (editing) return;
        setDraft(task.title);
        setEditing(true);
      }}
      className={`group cursor-grab rounded-md border border-line bg-bg-3 px-2.5 py-2 text-sm hover:border-fg-dim active:cursor-grabbing ${
        dragging ? 'opacity-40' : ''
      } ${task.status === 'done' ? 'text-fg-muted line-through decoration-fg-dim' : ''}`}
    >
      {editing ? (
        <input
          ref={inputRef}
          className="w-full bg-transparent outline-none"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            if (e.key === 'Escape') {
              setDraft(task.title);
              setEditing(false);
            }
          }}
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <div className="flex items-start gap-1.5">
          <TypeBadge type={task.type} />
          <span className="flex-1 break-words">
            <span className="mr-1.5 font-mono text-[10px] text-fg-dim">{task.ref}</span>
            {task.external_ref && (
              <a
                href={task.external_ref.url}
                target="_blank"
                rel="noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="mr-1.5 rounded bg-accent/15 px-1 font-mono text-[10px] text-accent hover:bg-accent/25"
                title={`${task.external_ref.provider}: ${task.external_ref.state}`}
              >
                {task.external_ref.identifier}
              </a>
            )}
            {task.external_ref ? task.title.replace(task.external_ref.identifier, '').trim() : task.title}
          </span>
          {total > 0 && (
            <span className="shrink-0 rounded bg-bg-4 px-1 text-[10px] tabular-nums text-fg-muted" title={`${done} de ${total} subtarefas concluídas`}>
              ✓ {done}/{total}
            </span>
          )}
          {terminalHref && (
            <Link to={terminalHref} onClick={(e) => e.stopPropagation()} className="shrink-0 rounded px-1 font-mono text-[11px] text-ok hover:bg-bg-4" title="Terminal deste card (ir para a tab)">
              ▮_
            </Link>
          )}
          <button
            className="invisible shrink-0 rounded px-1 text-xs text-fg-dim hover:bg-bg-4 hover:text-fg group-hover:visible"
            title="Abrir card"
            onClick={(e) => {
              e.stopPropagation();
              onOpen();
            }}
          >
            ⋯
          </button>
          {onMoveNext && next && (
            <button
              className="invisible shrink-0 rounded px-1 text-xs text-fg-dim hover:bg-bg-4 hover:text-fg group-hover:visible"
              title={`Mover para ${next.name}`}
              onClick={(e) => {
                e.stopPropagation();
                onMoveNext();
              }}
            >
              →
            </button>
          )}
        </div>
      )}
      {epicTitle && !editing && (
        <p className="mt-0.5 truncate text-[10px] text-fg-dim" title={`Épico: ${epicTitle}`}>
          {epicTitle}
        </p>
      )}
      {task.external_ref && !editing && task.external_ref.status !== task.status && (
        <p className="mt-1 text-[10px] text-warn" title="Estado no provedor difere da coluna; abra o card → Atualizar para sincronizar">
          {PROVIDER_LABEL[task.external_ref.provider]}: {task.external_ref.state}
        </p>
      )}
      {task.description && !editing && (
        <p
          className="mt-1 line-clamp-2 cursor-pointer text-xs text-fg-dim hover:text-fg-muted"
          onClick={(e) => {
            e.stopPropagation();
            onOpen();
          }}
        >
          {task.description}
        </p>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run the tests, the web typecheck and the web suite**

```bash
th 'npx vitest run --root apps/web src/components/TasksBoard.test.tsx && npm run typecheck -w @termhub/web && npm test -w @termhub/web'; rm -rf .npm
```

Expected: PASS (9 board tests), typecheck clean, suite green.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/TasksBoard.tsx apps/web/src/components/TasksBoard.test.tsx
git commit -m "Web: board with the project's columns, type and epic filter" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: Card URLs — `/project/:ref` opens the editor

**Files:**
- Create: `apps/web/src/pages/CardPage.tsx`
- Modify: `apps/web/src/pages/ProjectPage.tsx` (signature, params, `TasksBoard` line), `apps/web/src/App.tsx` (import, one route), `apps/web/src/components/TasksBoard.tsx` (open/close through the URL)
- Test: `apps/web/src/pages/CardPage.test.tsx` (new), `apps/web/src/components/TasksBoard.test.tsx`, `apps/web/src/pages/ProjectPage.test.tsx`

**Interfaces:**
- Consumes: Task 8 `api.tasks.byRef`, `cardPath`; Task 10 `TasksBoard`.
- Produces: `CardPage()` for `/project/:ref` — resolves the ref (a subtask resolves to its parent card), then renders `<ProjectPage card={{ projectId, taskId }} />`; "Card não encontrado" on 404, "Erro ao abrir o card" otherwise. `ProjectPage({ card?: { projectId: string; taskId: string } })`. `TasksBoard({ projectId, openTaskId?: string })` — the editor shows the card of `openTaskId`; opening a card navigates to `/project/<ref>` with `state.from` = the section path; closing navigates back to `state.from`, else `/projects/<id>/tasks`.

- [ ] **Step 1: Write the failing tests**

`apps/web/src/pages/CardPage.test.tsx`:

```tsx
// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

const byRefMock = vi.fn();
vi.mock('../lib/api', () => {
  class ApiError extends Error {
    constructor(
      public status: number,
      message: string,
    ) {
      super(message);
    }
  }
  return { ApiError, api: { tasks: { byRef: (...a: unknown[]) => byRefMock(...a) } } };
});
vi.mock('./ProjectPage', () => ({
  ProjectPage: ({ card }: { card?: { projectId: string; taskId: string } }) => (
    <div>
      board {card?.projectId} {card?.taskId}
    </div>
  ),
}));

import { ApiError } from '../lib/api';
import { CardPage } from './CardPage';

function mount(ref: string) {
  render(
    <MemoryRouter initialEntries={[`/project/${ref}`]}>
      <Routes>
        <Route path="/project/:ref" element={<CardPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('CardPage', () => {
  it('resolves the ref and shows the project board with that card open', async () => {
    byRefMock.mockResolvedValue({ task: { id: 'k12', parent_id: null }, project_id: 'p1' });
    mount('ter-12');
    expect(await screen.findByText('board p1 k12')).toBeInTheDocument();
    expect(byRefMock).toHaveBeenCalledWith('ter-12');
  });

  it('opens the parent of a subtask', async () => {
    byRefMock.mockResolvedValue({ task: { id: 's1', parent_id: 'k12' }, project_id: 'p1' });
    mount('TER-13');
    expect(await screen.findByText('board p1 k12')).toBeInTheDocument();
  });

  it('says "Card não encontrado" for an unknown ref or one outside the scope', async () => {
    byRefMock.mockRejectedValue(new ApiError(404, 'Card não encontrado'));
    mount('TER-99');
    expect(await screen.findByText('Card não encontrado')).toBeInTheDocument();
  });

  it('says so when the lookup fails for another reason', async () => {
    byRefMock.mockRejectedValue(new ApiError(500, 'Erro interno'));
    mount('TER-1');
    expect(await screen.findByText('Erro ao abrir o card')).toBeInTheDocument();
  });
});
```

In `apps/web/src/components/TasksBoard.test.tsx`:
- change the router import to `import { MemoryRouter, useLocation } from 'react-router-dom';`;
- replace `function mount() { … }` and `async function requestTerminal(…) { … }` with:

```tsx
function LocationProbe() {
  const l = useLocation();
  return <output data-testid="location">{`${l.pathname}|${(l.state as { from?: string } | null)?.from ?? ''}`}</output>;
}

type Entry = string | { pathname: string; state: unknown };

function mount(openTaskId?: string, entry: Entry = '/projects/p1/tasks') {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <TasksBoard projectId="p1" openTaskId={openTaskId} />
      <LocationProbe />
    </MemoryRouter>,
  );
}

/** With the card's editor open (its URL), clicks "Abrir terminal para esta task". */
async function requestTerminal() {
  fireEvent.click(await screen.findByRole('button', { name: /Abrir terminal para esta task/ }));
}
```

- in the four machine-picker tests, replace `mount();` with `mount('t1');`;
- at the end of the file add:

```tsx
describe('TasksBoard — card URLs', () => {
  it('opening a card goes to /project/<ref>, remembering the section', async () => {
    mount();
    await screen.findByText('t1');
    fireEvent.click(screen.getByTitle('Abrir card'));
    expect(screen.getByTestId('location').textContent).toBe('/project/P1-t1|/projects/p1/tasks');
  });

  it('shows the editor of the card in the URL; closing goes back to the section it came from', async () => {
    mount('t1', { pathname: '/project/P1-t1', state: { from: '/projects/p1/backlog' } });
    expect(await screen.findByRole('heading', { name: 'P1-t1' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Fechar' }));
    expect(screen.getByTestId('location').textContent).toBe('/projects/p1/backlog|');
  });

  it('closing a card opened from a pasted link goes to the board', async () => {
    mount('t1', '/project/P1-t1');
    fireEvent.click(await screen.findByRole('button', { name: 'Fechar' }));
    expect(screen.getByTestId('location').textContent).toBe('/projects/p1/tasks|');
  });
});
```

In `apps/web/src/pages/ProjectPage.test.tsx`, replace `vi.mock('../components/TasksBoard', () => ({ TasksBoard: () => null }));` with

```tsx
vi.mock('../components/TasksBoard', () => ({ TasksBoard: ({ openTaskId }: { openTaskId?: string }) => <div>board {openTaskId ?? ''}</div> }));
```

and at the end of the file add:

```tsx
describe('ProjectPage with a card', () => {
  it('shows the Board with that card open, whatever the URL is', () => {
    const proj = project();
    dataState.current = { ...dataState.current, projects: [proj] };
    render(
      <MemoryRouter initialEntries={['/project/MEU-3']}>
        <Routes>
          <Route path="/project/:ref" element={<ProjectPage card={{ projectId: 'p1', taskId: 'k3' }} />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByText('board k3')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run them to see them fail**

```bash
th 'npx vitest run --root apps/web src/pages/CardPage.test.tsx src/components/TasksBoard.test.tsx src/pages/ProjectPage.test.tsx'; rm -rf .npm
```

Expected: FAIL — cannot find module `./CardPage`; the board opens the editor from local state (location unchanged), ignores `openTaskId`; `ProjectPage` ignores `card`.

- [ ] **Step 3: The card page**

`apps/web/src/pages/CardPage.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { FullScreenMessage } from '../components/Layout';
import { ProjectPage } from './ProjectPage';

type Resolved = { projectId: string; taskId: string } | 'missing' | 'error' | null;

/**
 * `/project/TER-12` (spec §7): resolves the ref, then shows the card's project on its Board with the
 * editor open. A subtask's ref opens its parent card (subtasks live in the parent's checklist).
 * The last resolved card stays on screen while the next ref loads, so moving between cards does not
 * remount the board.
 */
export function CardPage() {
  const { ref = '' } = useParams<{ ref: string }>();
  const [card, setCard] = useState<Resolved>(null);

  useEffect(() => {
    let alive = true;
    api.tasks.byRef(ref).then(
      ({ task, project_id }) => {
        if (alive) setCard({ projectId: project_id, taskId: task.parent_id ?? task.id });
      },
      (e: unknown) => {
        if (alive) setCard(e instanceof ApiError && e.status === 404 ? 'missing' : 'error');
      },
    );
    return () => {
      alive = false;
    };
  }, [ref]);

  if (card === null) return <FullScreenMessage>Carregando…</FullScreenMessage>;
  if (card === 'missing') return <FullScreenMessage>Card não encontrado</FullScreenMessage>;
  if (card === 'error') return <FullScreenMessage>Erro ao abrir o card</FullScreenMessage>;
  return <ProjectPage card={card} />;
}
```

- [ ] **Step 4: ProjectPage takes a card; the route**

In `apps/web/src/pages/ProjectPage.tsx`, replace

```tsx
export function ProjectPage() {
  const { id, section } = useParams<{ id: string; section?: string }>();
```

with

```tsx
interface Props {
  /** `/project/:ref` (CardPage): the card's project, on its Board, with the card's editor open */
  card?: { projectId: string; taskId: string };
}

export function ProjectPage({ card }: Props = {}) {
  const params = useParams<{ id: string; section?: string }>();
  const id = card?.projectId ?? params.id;
  const section = card ? 'tasks' : params.section;
```

and replace `{current === 'tasks' && <TasksBoard key={`tasks-${project.id}`} projectId={project.id} />}` with

```tsx
        {current === 'tasks' && <TasksBoard key={`tasks-${project.id}`} projectId={project.id} openTaskId={card?.taskId} />}
```

In `apps/web/src/App.tsx`, add `import { CardPage } from './pages/CardPage';` after the `ProjectPage` import, and after `<Route path="/projects/:id/:section" element={<ProjectPage />} />` add:

```tsx
          {/* a card's own URL (spec §7): TER-12 = project key + card number */}
          <Route path="/project/:ref" element={<CardPage />} />
```

(The server's SPA fallback already serves `/project/*`: every non-API path falls to `index.html` in `apps/server/src/frontend.ts`.)

- [ ] **Step 5: The board opens and closes cards through the URL**

In `apps/web/src/components/TasksBoard.tsx`:

- change `import { Link, useNavigate } from 'react-router-dom';` to `import { Link, useLocation, useNavigate } from 'react-router-dom';` and add `cardPath` to the `../lib/board` import;
- replace the `Props` interface with:

```tsx
interface Props {
  projectId: string;
  /** `/project/:ref`: the card whose editor is open — the URL owns it */
  openTaskId?: string;
}
```

- change the signature to `export function TasksBoard({ projectId, openTaskId }: Props) {` and add `const location = useLocation();` after `const navigate = useNavigate();`;
- delete the line `const [editingId, setEditingId] = useState<string | null>(null);`;
- replace `const editing = editingId ? ((tasks ?? []).find((t) => t.id === editingId) ?? null) : null;` with:

```tsx
  const editing = openTaskId ? ((tasks ?? []).find((t) => t.id === openTaskId) ?? null) : null;
  /** The section a card was opened from; the card URL keeps it in the history state (a pasted link has none). */
  const from = (location.state as { from?: string } | null)?.from ?? `/projects/${projectId}/tasks`;
  const openCard = (task: Task) => navigate(cardPath(task.ref), { state: { from: location.pathname.startsWith('/project/') ? from : location.pathname } });
  const closeCard = () => navigate(from);
```

- in `openTerminal`, delete the line `setEditingId(null);` (navigating to the terminal leaves the card URL);
- in `remove`, replace `setEditingId(null);` with `if (openTaskId === id) closeCard();`;
- on `<TaskCard …>`, replace `onOpen={() => setEditingId(task.id)}` with `onOpen={() => openCard(task)}`;
- on `<TaskEditor …>`, replace `onClose={() => setEditingId(null)}` with `onClose={closeCard}`.

- [ ] **Step 6: Run the tests, the web typecheck and the web suite**

```bash
th 'npx vitest run --root apps/web src/pages/CardPage.test.tsx src/components/TasksBoard.test.tsx src/pages/ProjectPage.test.tsx && npm run typecheck -w @termhub/web && npm test -w @termhub/web'; rm -rf .npm
```

Expected: PASS, typecheck clean, suite green.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/pages/CardPage.tsx apps/web/src/pages/CardPage.test.tsx apps/web/src/pages/ProjectPage.tsx apps/web/src/pages/ProjectPage.test.tsx apps/web/src/App.tsx apps/web/src/components/TasksBoard.tsx apps/web/src/components/TasksBoard.test.tsx
git commit -m "Web: card URLs at /project/KEY-N open the editor" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 12: Backlog view and the Board/Backlog sections

**Files:**
- Create: `apps/web/src/components/BacklogView.tsx`
- Modify: `apps/web/src/pages/ProjectPage.tsx` (`ProjectSection`, `SECTIONS`, one render line, one import)
- Test: `apps/web/src/components/BacklogView.test.tsx` (new), `apps/web/src/pages/ProjectPage.test.tsx` (mock + header expectations)

**Interfaces:**
- Consumes: Task 8 `api.tasks.list/create/move`, `backlogSections`, `openCount`, `cardPath`, `WORK_TYPES`, `TASK_TYPE_LABEL`; Task 9 `TypeBadge`; Task 11 card route (`state.from`).
- Produces: `BacklogView({ projectId })` — one `<section aria-label={epic.title}>` per epic (default epic first, then by number) with ref, title and "N/M feitas"; the epic's backlog items by position, draggable within the section (`api.tasks.move(id, { status: 'backlog' }, position)`); per row "Enviar para o board" (`move(id, { status: 'todo' }, 0)`) and "Abrir" (navigates to `/project/<ref>` with `state.from = /projects/<id>/backlog`); per epic a quick add "+ item (Enter)" with a type select labelled "Tipo do item"; "+ Novo épico" at the top. `ProjectSection` gains `'backlog'`; sections are Terminais, Board (`tasks`), Backlog (`backlog`), Tickets, Notas, Setup; the open-task badge stays on Board.

- [ ] **Step 1: Write the failing tests**

`apps/web/src/components/BacklogView.test.tsx`:

```tsx
// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '../lib/types';

const listMock = vi.fn();
const createMock = vi.fn();
const moveMock = vi.fn();
vi.mock('../lib/api', () => {
  class ApiError extends Error {}
  return {
    ApiError,
    api: { tasks: { list: (...a: unknown[]) => listMock(...a), create: (...a: unknown[]) => createMock(...a), move: (...a: unknown[]) => moveMock(...a) } },
  };
});
vi.mock('../lib/data', () => ({ useData: () => ({ setOpenTasks: () => {} }) }));

import { BacklogView } from './BacklogView';

const task = (over: Partial<Task> & { id: string }): Task => ({
  project_id: 'p1', type: 'task', number: 9, ref: `P1-${over.id}`, title: over.id, description: null, status: 'backlog', position: 0,
  external_ref: null, external_key: null, tab_id: null, parent_id: null, epic_id: 'e1', column_id: null, created_at: '', updated_at: '', ...over,
});
const epic = (id: string, title: string, number: number) => task({ id, title, number, ref: `P1-${number}`, type: 'epic', epic_id: null });

function LocationProbe() {
  const l = useLocation();
  return <output data-testid="location">{`${l.pathname}|${(l.state as { from?: string } | null)?.from ?? ''}`}</output>;
}

function mount() {
  render(
    <MemoryRouter initialEntries={['/projects/p1/backlog']}>
      <BacklogView projectId="p1" />
      <LocationProbe />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  listMock.mockResolvedValue({
    columns: [],
    agent_column_id: null,
    tasks: [
      epic('e2', 'Checkout', 5),
      epic('e1', 'Geral', 1),
      task({ id: 'second', position: 1 }),
      task({ id: 'first', position: 0, type: 'bug' }),
      task({ id: 'on board', status: 'done', column_id: 'c3' }),
      task({ id: 'doing', status: 'doing', column_id: 'c2' }),
      task({ id: 'pay', epic_id: 'e2', type: 'story' }),
    ],
  });
  moveMock.mockResolvedValue({ task: task({ id: 'first' }) });
  createMock.mockResolvedValue({ task: task({ id: 'new' }) });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('BacklogView', () => {
  it('groups backlog items by epic, the default epic first, with progress over the board', async () => {
    mount();
    await screen.findByText('first');
    expect(screen.getAllByRole('region').map((r) => r.getAttribute('aria-label'))).toEqual(['Geral', 'Checkout']);
    const geral = screen.getByRole('region', { name: 'Geral' });
    expect(within(geral).getAllByRole('listitem').map((li) => li.textContent)).toEqual([expect.stringContaining('first'), expect.stringContaining('second')]);
    expect(within(geral).getByText('1/2 feitas')).toBeInTheDocument();
    expect(within(geral).queryByText('on board')).not.toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Checkout' })).getByText('pay')).toBeInTheDocument();
  });

  it('sends an item to the board (first A fazer column)', async () => {
    mount();
    await screen.findByText('first');
    const row = screen.getByText('first').closest('li')!;
    fireEvent.click(within(row).getByRole('button', { name: 'Enviar para o board' }));
    await waitFor(() => expect(moveMock).toHaveBeenCalledWith('first', { status: 'todo' }, 0));
    expect(listMock).toHaveBeenCalledTimes(2);
  });

  it('opens a card at its URL, remembering the backlog', async () => {
    mount();
    await screen.findByText('first');
    fireEvent.click(within(screen.getByText('first').closest('li')!).getByRole('button', { name: 'Abrir' }));
    expect(screen.getByTestId('location').textContent).toBe('/project/P1-first|/projects/p1/backlog');
  });

  it('adds an item of the chosen type to that epic', async () => {
    mount();
    await screen.findByText('pay');
    const section = screen.getByRole('region', { name: 'Checkout' });
    fireEvent.change(within(section).getByLabelText('Tipo do item'), { target: { value: 'bug' } });
    const input = within(section).getByPlaceholderText('+ item (Enter)');
    fireEvent.change(input, { target: { value: 'crash' } });
    fireEvent.submit(input.closest('form')!);
    await waitFor(() => expect(createMock).toHaveBeenCalledWith('p1', { title: 'crash', type: 'bug', epic_id: 'e2', status: 'backlog' }));
  });

  it('creates a new epic', async () => {
    mount();
    await screen.findByText('first');
    fireEvent.click(screen.getByRole('button', { name: '+ Novo épico' }));
    fireEvent.change(screen.getByLabelText('Título do épico'), { target: { value: 'Pagamentos' } });
    fireEvent.click(screen.getByRole('button', { name: 'Criar' }));
    await waitFor(() => expect(createMock).toHaveBeenCalledWith('p1', { title: 'Pagamentos', type: 'epic', status: 'backlog' }));
  });

  it('reorders by dropping inside the section', async () => {
    mount();
    await screen.findByText('first');
    const [firstRow, secondRow] = within(screen.getByRole('region', { name: 'Geral' })).getAllByRole('listitem');
    const dataTransfer = { effectAllowed: '', setData: () => {} };
    fireEvent.dragStart(secondRow, { dataTransfer });
    fireEvent.drop(firstRow, { dataTransfer });
    await waitFor(() => expect(moveMock).toHaveBeenCalledWith('second', { status: 'backlog' }, 0));
  });
});
```

In `apps/web/src/pages/ProjectPage.test.tsx`:
- after the `TasksBoard` mock add `vi.mock('../components/BacklogView', () => ({ BacklogView: () => null }));`;
- in the header test, replace the expected href list with `['/projects/p1', '/projects/p1/tasks', '/projects/p1/backlog', '/projects/p1/tickets', '/projects/p1/notes', '/projects/p1/settings']` and replace `expect(within(tabs).getByRole('link', { name: /Tarefas/ }).textContent).toBe('Tarefas3');` with `expect(within(tabs).getByRole('link', { name: /Board/ }).textContent).toBe('Board3');`.

- [ ] **Step 2: Run them to see them fail**

```bash
th 'npx vitest run --root apps/web src/components/BacklogView.test.tsx src/pages/ProjectPage.test.tsx'; rm -rf .npm
```

Expected: FAIL — cannot find module `./BacklogView`; the header still says "Tarefas" and has no Backlog link.

- [ ] **Step 3: The backlog view**

`apps/web/src/components/BacklogView.tsx`:

```tsx
import { useCallback, useEffect, useMemo, useState, type DragEvent, type FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { backlogSections, cardPath, openCount, WORK_TYPES, type BacklogSection } from '../lib/board';
import { useData } from '../lib/data';
import { TASK_TYPE_LABEL, type Task, type TaskType } from '../lib/types';
import { TypeBadge } from './TypeBadge';

/**
 * The project's Backlog (spec §7): one section per epic, its backlog items in order, draggable
 * within the section. Every change goes to the server and reloads — the backlog is not a hot path.
 */
export function BacklogView({ projectId }: { projectId: string }) {
  const { setOpenTasks } = useData();
  const navigate = useNavigate();
  const location = useLocation();
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [newEpic, setNewEpic] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setTasks((await api.tasks.list(projectId)).tasks);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Erro ao carregar o backlog');
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (tasks) setOpenTasks(projectId, openCount(tasks));
  }, [tasks, projectId, setOpenTasks]);

  const sections = useMemo(() => backlogSections(tasks ?? []), [tasks]);

  const run = async (action: () => Promise<unknown>, fallback: string) => {
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : fallback);
    }
    await load();
  };

  const open = (task: Task) => navigate(cardPath(task.ref), { state: { from: location.pathname } });

  /** Drop on row `index` of a section; the index counts the dragged row when it sits above. */
  const dropOn = (e: DragEvent, section: BacklogSection, index: number) => {
    e.preventDefault();
    const id = dragId;
    setDragId(null);
    const from = section.items.findIndex((t) => t.id === id);
    if (!id || from === -1 || from === index) return; // only within the section
    void run(() => api.tasks.move(id, { status: 'backlog' }, index), 'Erro ao reordenar o backlog');
  };

  if (tasks === null) return <div className="flex h-full items-center justify-center text-sm text-fg-dim">{error ?? 'Carregando o backlog…'}</div>;

  return (
    <div className="h-full overflow-y-auto p-4">
      {error && (
        <div className="mb-3 rounded border border-danger/30 bg-danger/10 px-3 py-1 text-xs text-danger">
          {error}{' '}
          <button className="underline" onClick={() => setError(null)}>
            fechar
          </button>
        </div>
      )}
      <div className="mb-4">
        {newEpic === null ? (
          <button className="btn-ghost border border-line text-xs" onClick={() => setNewEpic('')}>
            + Novo épico
          </button>
        ) : (
          <form
            className="flex max-w-md gap-2"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              const title = newEpic.trim();
              setNewEpic(null);
              if (title) void run(() => api.tasks.create(projectId, { title, type: 'epic', status: 'backlog' }), 'Erro ao criar o épico');
            }}
          >
            <input
              className="input py-1 text-sm"
              aria-label="Título do épico"
              autoFocus
              value={newEpic}
              onChange={(e) => setNewEpic(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setNewEpic(null);
              }}
            />
            <button type="submit" className="btn-primary text-xs">
              Criar
            </button>
          </form>
        )}
      </div>
      {sections.length === 0 && <p className="text-sm text-fg-dim">Nenhum épico ainda. Crie um para começar o backlog.</p>}
      <div className="space-y-4">
        {sections.map((s) => (
          <section key={s.epic.id} aria-label={s.epic.title} className="rounded-lg border border-line bg-bg-2">
            <header className="flex items-center gap-2 border-b border-line px-3 py-2 text-sm">
              <TypeBadge type="epic" />
              <button className="font-mono text-xs text-fg-muted hover:text-fg" onClick={() => open(s.epic)} title="Abrir o épico">
                {s.epic.ref}
              </button>
              <span className="font-medium">{s.epic.title}</span>
              <span className="ml-auto text-xs text-fg-dim">
                {s.done}/{s.total} feitas
              </span>
            </header>
            <ul>
              {s.items.map((t, i) => (
                <li
                  key={t.id}
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.effectAllowed = 'move';
                    setDragId(t.id);
                  }}
                  onDragEnd={() => setDragId(null)}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => dropOn(e, s, i)}
                  className={`group flex cursor-grab items-center gap-2 border-b border-line px-3 py-1.5 text-sm last:border-b-0 ${dragId === t.id ? 'opacity-40' : ''}`}
                >
                  <TypeBadge type={t.type} />
                  <span className="font-mono text-[11px] text-fg-dim">{t.ref}</span>
                  <span className="flex-1 break-words">{t.title}</span>
                  {(t.subtasks?.length ?? 0) > 0 && (
                    <span className="shrink-0 rounded bg-bg-4 px-1 text-[10px] tabular-nums text-fg-muted">
                      ✓ {t.subtasks!.filter((x) => x.status === 'done').length}/{t.subtasks!.length}
                    </span>
                  )}
                  <button
                    className="btn-ghost shrink-0 border border-line px-2 py-0.5 text-[11px]"
                    onClick={() => void run(() => api.tasks.move(t.id, { status: 'todo' }, 0), 'Erro ao enviar para o board')}
                  >
                    Enviar para o board
                  </button>
                  <button className="shrink-0 rounded px-1 text-xs text-fg-dim hover:bg-bg-4 hover:text-fg" onClick={() => open(t)}>
                    Abrir
                  </button>
                </li>
              ))}
            </ul>
            {s.items.length === 0 && <p className="px-3 py-3 text-xs text-fg-dim">Nada no backlog deste épico.</p>}
            <BacklogQuickAdd onAdd={(title, type) => void run(() => api.tasks.create(projectId, { title, type, epic_id: s.epic.id, status: 'backlog' }), 'Erro ao criar o item')} />
          </section>
        ))}
      </div>
    </div>
  );
}

function BacklogQuickAdd({ onAdd }: { onAdd: (title: string, type: TaskType) => void }) {
  const [value, setValue] = useState('');
  const [type, setType] = useState<TaskType>('task');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const v = value.trim();
    if (!v) return;
    onAdd(v, type);
    setValue('');
  };
  return (
    <form onSubmit={submit} className="flex gap-2 p-2">
      <select aria-label="Tipo do item" className="input w-auto py-1 text-xs" value={type} onChange={(e) => setType(e.target.value as TaskType)}>
        {WORK_TYPES.map((t) => (
          <option key={t} value={t}>
            {TASK_TYPE_LABEL[t]}
          </option>
        ))}
      </select>
      <input className="input py-1 text-xs" placeholder="+ item (Enter)" value={value} onChange={(e) => setValue(e.target.value)} />
    </form>
  );
}
```

- [ ] **Step 4: Board and Backlog sections**

In `apps/web/src/pages/ProjectPage.tsx`:
- add `import { BacklogView } from '../components/BacklogView';` after the `TasksBoard` import;
- replace `export type ProjectSection = 'terminals' | 'tasks' | 'tickets' | 'notes' | 'settings';` with `export type ProjectSection = 'terminals' | 'tasks' | 'backlog' | 'tickets' | 'notes' | 'settings';`;
- replace the line `  { key: 'tasks', label: 'Tarefas', path: 'tasks' },` with

```tsx
  { key: 'tasks', label: 'Board', path: 'tasks' },
  { key: 'backlog', label: 'Backlog', path: 'backlog' },
```

- after the `{current === 'tasks' && …}` line add:

```tsx
        {current === 'backlog' && <BacklogView key={`backlog-${project.id}`} projectId={project.id} />}
```

- [ ] **Step 5: Run the tests, the web typecheck and the web suite**

```bash
th 'npx vitest run --root apps/web src/components/BacklogView.test.tsx src/pages/ProjectPage.test.tsx && npm run typecheck -w @termhub/web && npm test -w @termhub/web'; rm -rf .npm
```

Expected: PASS, typecheck clean, suite green.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/BacklogView.tsx apps/web/src/components/BacklogView.test.tsx apps/web/src/pages/ProjectPage.tsx apps/web/src/pages/ProjectPage.test.tsx
git commit -m "Web: backlog grouped by epic; Board and Backlog sections" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---


### Task 13: Settings — "Colunas do board" and the agent column

**Files:**
- Create: `apps/web/src/components/BoardColumnsSettings.tsx`
- Modify: `apps/web/src/components/ProjectSettings.tsx` (import, one line after `<ProjectMachines …/>`), `apps/web/src/components/SetupForm.tsx:157` (hint copy)
- Test: `apps/web/src/components/BoardColumnsSettings.test.tsx` (new)

**Interfaces:**
- Consumes: Task 8 `api.tasks.list`, `api.columns.create/update/move/remove/setAgent`, `COLUMN_CATEGORY_LABEL`, `TaskColumn`, `ColumnCategory`; existing `ConfirmDialog`.
- Produces: `BoardColumnsSettings({ project })` — a section "Colunas do board": one row per column in order with a name input (`aria-label="Nome da coluna <name>"`, saved on blur/Enter), a category select (`"Tipo da coluna <name>"`: "A fazer", "Fazendo", "Feito"), "Subir"/"Descer"/"Excluir <name>" buttons (category and delete disabled for the last column of a category); a delete confirmation that says how many cards move and to which column; "+ coluna" with name and category (disabled at 12); "Coluna do agente" select with "Automática (primeira Fazendo)" and the `doing` columns only. Server refusals are shown as they come.

- [ ] **Step 1: Write the failing test**

`apps/web/src/components/BoardColumnsSettings.test.tsx`:

```tsx
// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project, Task, TaskColumn } from '../lib/types';

const mocks = vi.hoisted(() => ({ list: vi.fn(), create: vi.fn(), update: vi.fn(), move: vi.fn(), remove: vi.fn(), setAgent: vi.fn() }));
vi.mock('../lib/api', () => {
  class ApiError extends Error {
    constructor(
      public status: number,
      message: string,
    ) {
      super(message);
    }
  }
  return {
    ApiError,
    api: {
      tasks: { list: mocks.list },
      columns: { create: mocks.create, update: mocks.update, move: mocks.move, remove: mocks.remove, setAgent: mocks.setAgent },
    },
  };
});

import { ApiError } from '../lib/api';
import { BoardColumnsSettings } from './BoardColumnsSettings';

const col = (id: string, name: string, category: TaskColumn['category'], position: number): TaskColumn => ({ id, project_id: 'p1', name, category, position, created_at: '' });
const columns = [col('c1', 'A fazer', 'todo', 0), col('c2', 'Fazendo', 'doing', 1), col('c4', 'QA', 'doing', 2), col('c3', 'Feito', 'done', 3)];
const card = (id: string, column_id: string) => ({ id, column_id, parent_id: null }) as Task;
const project = { id: 'p1', name: 'p1' } as Project;

beforeEach(() => {
  mocks.list.mockResolvedValue({ tasks: [card('a', 'c4'), card('b', 'c4'), card('x', 'c1')], columns, agent_column_id: null });
  for (const m of [mocks.create, mocks.update, mocks.move, mocks.remove, mocks.setAgent]) m.mockResolvedValue({});
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('BoardColumnsSettings', () => {
  it('lists the columns in order and locks the last column of each category', async () => {
    render(<BoardColumnsSettings project={project} />);
    expect(await screen.findByDisplayValue('QA')).toBeInTheDocument();
    expect(screen.getAllByRole('textbox', { name: /^Nome da coluna / }).map((i) => (i as HTMLInputElement).value)).toEqual(['A fazer', 'Fazendo', 'QA', 'Feito']);
    expect(screen.getByLabelText('Tipo da coluna A fazer')).toBeDisabled();
    expect(screen.getByLabelText('Tipo da coluna QA')).not.toBeDisabled();
    expect(screen.getByRole('button', { name: 'Excluir Feito' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Subir A fazer' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Descer Feito' })).toBeDisabled();
  });

  it('renames on blur, changes a category and moves a column', async () => {
    render(<BoardColumnsSettings project={project} />);
    const qa = await screen.findByDisplayValue('QA');
    fireEvent.change(qa, { target: { value: 'Em revisão' } });
    fireEvent.blur(qa);
    await waitFor(() => expect(mocks.update).toHaveBeenCalledWith('c4', { name: 'Em revisão' }));
    fireEvent.change(screen.getByLabelText('Tipo da coluna Fazendo'), { target: { value: 'todo' } });
    await waitFor(() => expect(mocks.update).toHaveBeenCalledWith('c2', { category: 'todo' }));
    fireEvent.click(screen.getByRole('button', { name: 'Subir QA' }));
    await waitFor(() => expect(mocks.move).toHaveBeenCalledWith('c4', 1));
  });

  it('says how many cards move and where before deleting', async () => {
    render(<BoardColumnsSettings project={project} />);
    await screen.findByDisplayValue('QA');
    fireEvent.click(screen.getByRole('button', { name: 'Excluir QA' }));
    expect(screen.getByText(/2 cards vão para "Fazendo"/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Excluir' }));
    await waitFor(() => expect(mocks.remove).toHaveBeenCalledWith('c4'));
  });

  it('adds a column and sets the agent column', async () => {
    render(<BoardColumnsSettings project={project} />);
    await screen.findByDisplayValue('QA');
    fireEvent.change(screen.getByLabelText('Nome da nova coluna'), { target: { value: ' Bloqueado ' } });
    fireEvent.change(screen.getByLabelText('Tipo da nova coluna'), { target: { value: 'doing' } });
    fireEvent.click(screen.getByRole('button', { name: '+ coluna' }));
    await waitFor(() => expect(mocks.create).toHaveBeenCalledWith('p1', { name: 'Bloqueado', category: 'doing' }));
    const agent = screen.getByLabelText('Coluna do agente') as HTMLSelectElement;
    expect(agent.options[0].textContent).toBe('Automática (primeira Fazendo)');
    // only doing columns are offered
    expect(Array.from(agent.options).map((o) => o.textContent)).toEqual(['Automática (primeira Fazendo)', 'Fazendo', 'QA']);
    fireEvent.change(agent, { target: { value: 'c4' } });
    await waitFor(() => expect(mocks.setAgent).toHaveBeenCalledWith('p1', 'c4'));
  });

  it('shows the server refusal', async () => {
    mocks.remove.mockRejectedValueOnce(new ApiError(409, 'O board precisa de ao menos uma coluna de cada tipo'));
    render(<BoardColumnsSettings project={project} />);
    await screen.findByDisplayValue('QA');
    fireEvent.click(screen.getByRole('button', { name: 'Excluir QA' }));
    fireEvent.click(screen.getByRole('button', { name: 'Excluir' }));
    expect(await screen.findByText('O board precisa de ao menos uma coluna de cada tipo')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run it to see it fail**

```bash
th 'npx vitest run --root apps/web src/components/BoardColumnsSettings.test.tsx'; rm -rf .npm
```

Expected: FAIL — cannot find module `./BoardColumnsSettings`.

- [ ] **Step 3: Implement the block**

`apps/web/src/components/BoardColumnsSettings.tsx`:

```tsx
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../lib/api';
import { COLUMN_CATEGORY_LABEL, type ColumnCategory, type Project, type TaskColumn } from '../lib/types';
import { ConfirmDialog } from './Modal';

const CATEGORIES: ColumnCategory[] = ['todo', 'doing', 'done'];
const MAX_COLUMNS = 12;
const LOCKED = 'O board precisa de ao menos uma coluna de cada tipo';

/** Setup → "Colunas do board" (spec §7): names, categories, order, deletion and the agent column. */
export function BoardColumnsSettings({ project }: { project: Project }) {
  const [columns, setColumns] = useState<TaskColumn[] | null>(null);
  const [agentColumnId, setAgentColumnId] = useState<string | null>(null);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<TaskColumn | null>(null);
  const [draftName, setDraftName] = useState('');
  const [draftCategory, setDraftCategory] = useState<ColumnCategory>('todo');

  const load = useCallback(async () => {
    try {
      const r = await api.tasks.list(project.id);
      setColumns([...r.columns].sort((a, b) => a.position - b.position));
      setAgentColumnId(r.agent_column_id);
      const c: Record<string, number> = {};
      for (const t of r.tasks) if (t.column_id && !t.parent_id) c[t.column_id] = (c[t.column_id] ?? 0) + 1;
      setCounts(c);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Erro ao carregar as colunas');
    }
  }, [project.id]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Every change goes to the server, then the block reloads (the server keeps the rules). */
  const run = async (action: () => Promise<unknown>, fallback: string) => {
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : fallback);
    }
    await load();
  };

  if (!columns) {
    return <section className="mb-8 max-w-2xl rounded-lg border border-line bg-bg-2 p-4 text-sm text-fg-dim">{error ?? 'Carregando colunas…'}</section>;
  }

  const lastOfCategory = (c: TaskColumn) => columns.filter((x) => x.category === c.category).length === 1;
  const destination = (c: TaskColumn) => columns.find((x) => x.category === c.category && x.id !== c.id);
  const moving = deleting ? (counts[deleting.id] ?? 0) : 0;

  const add = (e: FormEvent) => {
    e.preventDefault();
    const name = draftName.trim();
    if (!name) return;
    setDraftName('');
    void run(() => api.columns.create(project.id, { name, category: draftCategory }), 'Erro ao criar a coluna');
  };

  return (
    <section aria-label="Colunas do board" className="mb-8 max-w-2xl space-y-3 rounded-lg border border-line bg-bg-2 p-4">
      <h3 className="text-sm font-semibold">Colunas do board</h3>
      <p className="text-xs text-fg-dim">
        O nome é seu; o tipo diz ao termhub o que a coluna significa. O board precisa de ao menos uma coluna de cada tipo e aceita até 12.
      </p>
      {error && <p className="text-xs text-danger">{error}</p>}
      <ul className="space-y-2">
        {columns.map((c, i) => (
          <ColumnRow
            key={c.id}
            column={c}
            index={i}
            last={i === columns.length - 1}
            locked={lastOfCategory(c)}
            onRename={(name) => void run(() => api.columns.update(c.id, { name }), 'Erro ao renomear a coluna')}
            onCategory={(category) => void run(() => api.columns.update(c.id, { category }), 'Erro ao mudar o tipo da coluna')}
            onMove={(position) => void run(() => api.columns.move(c.id, position), 'Erro ao mover a coluna')}
            onDelete={() => setDeleting(c)}
          />
        ))}
      </ul>
      <form onSubmit={add} className="flex gap-2">
        <input className="input" aria-label="Nome da nova coluna" placeholder="Nome da coluna" maxLength={40} value={draftName} onChange={(e) => setDraftName(e.target.value)} />
        <select className="input w-auto" aria-label="Tipo da nova coluna" value={draftCategory} onChange={(e) => setDraftCategory(e.target.value as ColumnCategory)}>
          {CATEGORIES.map((k) => (
            <option key={k} value={k}>
              {COLUMN_CATEGORY_LABEL[k]}
            </option>
          ))}
        </select>
        <button type="submit" className="btn-primary shrink-0" disabled={columns.length >= MAX_COLUMNS}>
          + coluna
        </button>
      </form>
      <div>
        <label className="label" htmlFor="agent-column">
          Coluna do agente
        </label>
        <select
          id="agent-column"
          className="input"
          value={agentColumnId ?? ''}
          onChange={(e) => {
            const columnId = e.target.value || null;
            void run(() => api.columns.setAgent(project.id, columnId), 'Erro ao salvar a coluna do agente');
          }}
        >
          <option value="">Automática (primeira Fazendo)</option>
          {columns
            .filter((c) => c.category === 'doing')
            .map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
        </select>
        <p className="mt-1 text-xs text-fg-dim">Para onde o card vai quando um agente começa a trabalhar nele.</p>
      </div>
      <ConfirmDialog
        open={deleting !== null}
        title="Excluir coluna"
        message={
          deleting ? (
            <>
              Excluir <strong>{deleting.name}</strong>?{' '}
              {moving > 0 ? `${moving === 1 ? '1 card vai' : `${moving} cards vão`} para "${destination(deleting)?.name ?? ''}".` : 'Ela está vazia.'}
            </>
          ) : null
        }
        confirmLabel="Excluir"
        danger
        onCancel={() => setDeleting(null)}
        onConfirm={async () => {
          const c = deleting;
          setDeleting(null);
          if (c) await run(() => api.columns.remove(c.id), 'Erro ao excluir a coluna');
        }}
      />
    </section>
  );
}

interface RowProps {
  column: TaskColumn;
  index: number;
  last: boolean;
  /** the only column of its category: its category cannot change and it cannot go */
  locked: boolean;
  onRename: (name: string) => void;
  onCategory: (category: ColumnCategory) => void;
  onMove: (position: number) => void;
  onDelete: () => void;
}

function ColumnRow({ column, index, last, locked, onRename, onCategory, onMove, onDelete }: RowProps) {
  const [name, setName] = useState(column.name);
  useEffect(() => {
    setName(column.name);
  }, [column.name]);

  const commit = () => {
    const v = name.trim();
    if (v && v !== column.name) onRename(v);
    else setName(column.name);
  };

  return (
    <li className="flex items-center gap-2">
      <input
        className="input"
        aria-label={`Nome da coluna ${column.name}`}
        maxLength={40}
        value={name}
        onChange={(e) => setName(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
          if (e.key === 'Escape') setName(column.name);
        }}
      />
      <select
        className="input w-auto"
        aria-label={`Tipo da coluna ${column.name}`}
        value={column.category}
        disabled={locked}
        title={locked ? LOCKED : undefined}
        onChange={(e) => onCategory(e.target.value as ColumnCategory)}
      >
        {CATEGORIES.map((k) => (
          <option key={k} value={k}>
            {COLUMN_CATEGORY_LABEL[k]}
          </option>
        ))}
      </select>
      <button type="button" className="btn-ghost px-2" aria-label={`Subir ${column.name}`} disabled={index === 0} onClick={() => onMove(index - 1)}>
        ↑
      </button>
      <button type="button" className="btn-ghost px-2" aria-label={`Descer ${column.name}`} disabled={last} onClick={() => onMove(index + 1)}>
        ↓
      </button>
      <button type="button" className="btn-ghost px-2 text-danger" aria-label={`Excluir ${column.name}`} disabled={locked} title={locked ? LOCKED : undefined} onClick={onDelete}>
        ✕
      </button>
    </li>
  );
}
```

- [ ] **Step 4: Put it in Setup, and fix the tickets hint**

In `apps/web/src/components/ProjectSettings.tsx`, add `import { BoardColumnsSettings } from './BoardColumnsSettings';` after the `ProjectMachines` import, and after `<ProjectMachines project={project} />` add:

```tsx
      <BoardColumnsSettings project={project} />
```

In `apps/web/src/components/SetupForm.tsx:157`, replace `hint="Fonte das tarefas: sincroniza para a coluna correspondente do kanban."` with `hint="Fonte das tarefas: os tickets que você escolher em Tickets entram no backlog do épico padrão."` (tickets never went straight to a column; now they land in the default epic's backlog).

- [ ] **Step 5: Run the tests, the web typecheck and the web suite**

```bash
th 'npx vitest run --root apps/web src/components/BoardColumnsSettings.test.tsx && npm run typecheck -w @termhub/web && npm test -w @termhub/web'; rm -rf .npm
```

Expected: PASS (5 tests), typecheck clean, suite green.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/BoardColumnsSettings.tsx apps/web/src/components/BoardColumnsSettings.test.tsx apps/web/src/components/ProjectSettings.tsx apps/web/src/components/SetupForm.tsx
git commit -m "Web: board columns and agent column in project settings" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 14: Docs and full verification

**Files:**
- Modify: `README.md` (MCP tools paragraph ~123, Tasks bullet ~242, Tickets bullet ~271)
- Modify: `CLAUDE.md` ("Architecture rules")

- [ ] **Step 1: README**

In `README.md`:

- In the MCP paragraph (~line 123):
  - replace ``` `find` (names → ids, projects matched by name or key) ``` with ``` `find` (names → ids, projects matched by name or key, cards by exact ref such as `APP-12`) ```;
  - replace the sentence that starts ``` Scope `tasks` gives `list_tasks`, `create_task` (with its subtasks in one call) ``` and ends ``` — the same board, rules and limits the web app uses. ``` with:

    ```markdown
    Scope `tasks` gives `list_tasks` (cards with type, ref, url, epic and column, plus the project's columns; filters by status, type and epic), `create_task` (optional type and epic — the default epic when absent — with its subtasks in one call), `add_subtasks`, `update_task` (also type and epic), `move_task` (to a `column_id` or a `status`), `delete_task` (needs `confirm: true`; an epic that still has cards is refused) — the same board, rules and limits the web app uses. Every card in a result carries its `url` (`/project/APP-12`).
    ```

  - replace ``` optionally linking a task and moving it to *doing* ``` with ``` optionally linking a task and moving it to the project's agent column (default: the first *Fazendo* column) ```.

- Replace the whole bullet that starts ``` - **Tasks:** kanban with four columns ``` (~line 242) with:

```markdown
- **Board and Backlog:** every card has a type — epic, story, task, subtask, bug or spike — and a number: `APP-12` (project key + a sequential number the database assigns and never reuses), opened at `/project/APP-12` ("Copiar link" in the card). Stories, tasks, bugs and spikes always belong to an epic (the project's default epic, "Geral", when none is chosen); subtasks are a checklist inside a story or task. **Board** shows the project's own columns — you name them, and each has a fixed category (A fazer / Fazendo / Feito) the system reasons with — with a type filter (default: everything but epics) and an epic filter, both remembered per project; drag and drop between columns, quick add per column, "→" to the next column. **Backlog** lists each epic's backlog items (drag to reorder, "Enviar para o board", quick add with a type, "+ Novo épico"). Setup → **Colunas do board** renames, re-categorizes, reorders and deletes columns (a deleted column's cards move to the first other column of the same category; at least one column per category, at most 12) and picks the **agent column** — where `start_agent` moves a task (default: the first Fazendo column). The open-task counter (stories, tasks, bugs and spikes in A fazer/Fazendo) shows in the sidebar next to the project. API: `GET /api/projects/:id/tasks` (`{ tasks, columns, agent_column_id }`), `POST /api/tasks/:id/move` (`{ column_id | status, position }`), `GET /api/tasks/by-ref/:ref`, `GET/POST /api/projects/:id/columns`, `PATCH/DELETE /api/columns/:id`, `POST /api/columns/:id/move`, `PUT /api/projects/:id/agent-column`. The `external_ref` field (JSON) is reserved for integrations (GitHub/Jira/Linear).
```

- In the Tickets bullet (~line 271), replace ``` they become tasks in the **Backlog** column with ``` with ``` they become tasks at the end of the default epic's **Backlog** with ```.

- [ ] **Step 2: CLAUDE.md**

In `CLAUDE.md`, at the end of "## Architecture rules" add:

```markdown
- The board (card types, epics, numbers, columns, positions) is ruled in `apps/server/src/db/repositories/{task-rules,task-board,tasks,task-columns}.ts`. Every structural write takes the project row lock first (`lockProject`), then touches task rows. Card numbers come from the `tasks_assign_number` database trigger: never write `tasks.number` or `projects.next_task_number` by hand. `status` is the card's category (`backlog`, or its column's category) and must stay in sync with `column_id`.
```

- [ ] **Step 3: Everything green, from a clean database**

Recreate the test database with the one-time recipe from Global Constraints (it names `th-test-db` explicitly), then:

```bash
thdb 'npm run build:packages >/dev/null && cd apps/server && npx prisma migrate deploy && npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code && npx prisma generate >/dev/null && git diff --exit-code -- src/generated && cd ../.. && npm run typecheck -w @termhub/server && npm test -w @termhub/server && npm run build -w @termhub/server && npm run build:city -w @termhub/web && npm test -w @termhub/web && npm run build -w @termhub/web && npm run build -w @termhub/landing'; rm -rf .npm
bash /tmp/th-verify-board-migration.sh
```

Expected: every command passes — no drift, the committed client matches `prisma generate` (no diff under `src/generated`), server and web suites green, all builds succeed; the migration script prints the same output as Task 1 Step 5. If `/tmp/th-verify-board-migration.sh` is gone (another shell session), recreate it from Task 1 Step 4 first. Keep the final summary lines of both vitest runs for the branch description.

The acceptance checks of spec §11 — every project has three columns, `next_task_number` above the highest number, creating a card from the board and from MCP returns a `ref` — are covered by Task 1 Step 5, Task 4 "a new project comes with…", Task 3 "creates the default epic…", Task 7 "creates with a type and an epic" and Task 10 "quick add". Production is never touched from this checkout.

- [ ] **Step 4: Commit (no push, no PR)**

```bash
git add README.md CLAUDE.md
git commit -m "Docs: board hierarchy, backlog, custom columns and card URLs" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
git log --oneline -16
```

Expected: 14 implementation commits on top of the spec commit. Do not push and do not open a PR: the owner decides when.
