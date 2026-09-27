# Progress panel — Phase 1 (no external dependency) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show, per epic and per card, progress %, the agents working on it (and who waits for the user), and a rough finish range — on the web (project section "Progresso") and on the phone (tab "Progresso") — for TER-183.

**Architecture:** A database trigger stamps `started_at`/`done_at` on every status change; the monitor's `recordEvent` adds closed `working` intervals to the card's `active_seconds`. A new `ProgressRepository` reads epics → cards → subtasks (+ linked tabs) in two queries; pure `estimate.ts`/`aggregate.ts` build the read model; one route plugin serves it at `/api/progress` and `/api/m/v1/progress`, validated by a zod contract in `@termhub/mobile-api`. Web overlays live tab states from `useMonitor()`; the phone polls.

**Tech Stack:** Fastify + zod + Prisma 6 (Postgres, plpgsql trigger), React + Vite + vitest/RTL (web), Expo/React Native + zustand + jest/RNTL (app), `@termhub/mobile-api` (shared zod contract consumed from `dist/`).

**Spec:** `docs/superpowers/specs/2026-09-26-progress-panel-design.md` (§3 decisions D1–D10, §4 phase 1).

## Global Constraints

- Work in a git worktree of your own on branch `feat/ter-183-progress-phase1` (created with superpowers:using-git-worktrees from `origin/main`). Other tabs work in parallel on this host. No push, no merge, no deploy unless the user asks.
- The host has no Node: every npm/npx command runs in Docker. One-time setup (throwaway names only — never touch a container that is not `th-*`):
  ```bash
  docker network create th-ter183-net
  docker run -d --name th-ter183-db --network th-ter183-net -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=termhub pgvector/pgvector:pg16
  ```
  Then use this prefix, referred to below as `DOCKER '<command>'` (`$WT` = absolute path of your worktree):
  `docker run --rm --name th-ter183-run -u "$(id -u):$(id -g)" -e HOME=/tmp --network th-ter183-net -e DATABASE_URL=postgresql://postgres:postgres@th-ter183-db:5432/termhub -e TERMHUB_DB_TESTS=1 -v "$WT:/w" -w /w node:22 sh -c '<command>'`
  First run: `DOCKER 'npm ci && npm run prisma:generate && npm run build:packages && cd apps/server && npx prisma migrate deploy'`. After every migration you add: `DOCKER 'npm run prisma:generate && cd apps/server && npx prisma migrate deploy'`. After changing `packages/mobile-api/src`: `DOCKER 'npm run build -w @termhub/mobile-api'`. Remove `.npm` left in the worktree before committing.
- Test commands: server `DOCKER 'npx -w @termhub/server vitest run <paths>'`; web `DOCKER 'npx -w @termhub/web vitest run <paths>'`; app `DOCKER 'npm test -w @termhub/mobile -- <paths>'`; mobile-api `DOCKER 'npx -w @termhub/mobile-api vitest run'`.
- Commit messages in English, imperative subject ≤ 72 chars, ending with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- UI copy stays pt-BR exactly as written here; code, comments and identifiers in English; match the surrounding comment density.
- Routes never import Prisma (go through repositories); every request input is validated with zod; projects are loaded through `scoped(repos, request)`; tab content is never logged.
- The migration must be backward compatible: the previous release keeps writing `tasks` during a blue/green switch (new columns nullable or defaulted; the trigger covers its writes).
- After each task, tick the matching subtask of TER-183 on the board (termhub MCP `update_task` with `status: done`).

## Review Focus

- A subtask ticked **done → todo → done** must end with a fresh `done_at`, and one reopened must have `done_at = NULL` — pinned in Task 1.
- A tab linked to **both a card and one of its subtasks** must add a working interval **once**, to the card — pinned in Task 2.
- A card **done on the board with unfinished subtasks** reads 100 % and "concluído", not 60 % — pinned in Task 5.
- A caller with `tasks:read` but **no `terminals:read`** gets `agents: null` everywhere (no tab names, no states) — pinned in Task 7.
- `project_id` of **another owner** answers 404, never an empty list that reveals nothing but still ran — pinned in Task 7.

---

### Task 1: Migration — `started_at`, `done_at`, `active_seconds` and the status trigger

**Files:**
- Create: `apps/server/prisma/migrations/20260927000000_task_progress/migration.sql`
- Modify: `apps/server/prisma/schema.prisma` (model `Task`)
- Test: `apps/server/src/db/repositories/progress.db.test.ts` (new; Task 6 appends to it)

**Interfaces:**
- Produces: columns `tasks.started_at TIMESTAMP(3) NULL`, `tasks.done_at TIMESTAMP(3) NULL`, `tasks.active_seconds INTEGER NOT NULL DEFAULT 0`; Prisma fields `startedAt`, `doneAt`, `activeSeconds`.

- [ ] **Step 1: Write the failing test**

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `DOCKER 'npx -w @termhub/server vitest run src/db/repositories/progress.db.test.ts'`
Expected: FAIL — TypeScript/Prisma error `startedAt` does not exist on the task type.

- [ ] **Step 3: Write the migration and the schema fields**

`apps/server/prisma/migrations/20260927000000_task_progress/migration.sql`:

```sql
-- Progress panel (spec 2026-09-26 progress-panel §4.1): when a card or subtask started and
-- finished, and how long an agent actually worked on a card. Nullable/defaulted: the previous
-- release keeps writing tasks during a blue/green switch, and the trigger stamps its writes too.
ALTER TABLE "tasks" ADD COLUMN "started_at" TIMESTAMP(3),
  ADD COLUMN "done_at" TIMESTAMP(3),
  ADD COLUMN "active_seconds" INTEGER NOT NULL DEFAULT 0;

-- Best effort for rows that are already done: their last write is when they finished.
UPDATE "tasks" SET "done_at" = "updated_at" WHERE "status" = 'done';

CREATE FUNCTION "tasks_track_progress_times"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."status" = 'doing' AND NEW."started_at" IS NULL THEN
    NEW."started_at" := now();
  END IF;
  IF NEW."status" = 'done' THEN
    IF TG_OP = 'INSERT' THEN
      NEW."done_at" := now();
    ELSIF OLD."status" <> 'done' THEN
      NEW."done_at" := now();
    END IF;
  ELSE
    NEW."done_at" := NULL;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "tasks_track_progress_times" BEFORE INSERT OR UPDATE OF "status" ON "tasks"
  FOR EACH ROW EXECUTE FUNCTION "tasks_track_progress_times"();
```

In `schema.prisma`, model `Task`, after `updatedAt`:

```prisma
  /// First time the row went to doing; set by the tasks_track_progress_times trigger, never cleared.
  startedAt     DateTime? @map("started_at")
  /// When the row last became done; set by the trigger, cleared when it leaves done.
  doneAt        DateTime? @map("done_at")
  /// Seconds an agent tab linked to this card (or to one of its subtasks) spent working (monitor/recordEvent).
  activeSeconds Int       @default(0) @map("active_seconds")
```

- [ ] **Step 4: Apply and run the test**

Run: `DOCKER 'npm run prisma:generate && cd apps/server && npx prisma migrate deploy && npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code'` (no drift), then the test command of Step 2.
Expected: migration applied, diff exits 0, 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/prisma apps/server/src/db/repositories/progress.db.test.ts
git commit -m "Tasks: stamp start and finish times with a status trigger"
```

---

### Task 2: Accumulate agent working time on the card

**Files:**
- Modify: `apps/server/src/db/repositories/tabs.ts` (`recordEvent`, constant near `EVENTS_KEPT_PER_TAB`)
- Test: `apps/server/src/db/repositories/tabs.db.test.ts` (append a `describe`)

**Interfaces:**
- Consumes: `tasks.active_seconds` (Task 1).
- Produces: `export const MAX_WORKING_INTERVAL_S = 7200;` in `tabs.ts`; `recordEvent` behaviour: before inserting, if the tab's latest event is `working`, adds `min(now − latest.createdAt, 7200)` seconds to every distinct `COALESCE(parent_id, id)` of tasks whose `tab_id` is the tab.

- [ ] **Step 1: Write the failing test** — append to `tabs.db.test.ts` (own rows, own client):

```ts
describe.skipIf(process.env.TERMHUB_DB_TESTS !== '1')('TabsRepository.recordEvent — agent time (Postgres)', () => {
  let db: PrismaClient;
  let repo: TabsRepository;
  let machineId: string;
  let projectId: string;
  let tabId: string;

  beforeAll(() => {
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
    repo = new TabsRepository(db);
  });

  beforeEach(async () => {
    machineId = newId();
    projectId = newId();
    tabId = newId();
    await db.machine.create({ data: { id: machineId, name: 'm', type: 'agent' } });
    await db.project.create({ data: { id: projectId, key: 'A' + projectId.replace(/[^a-z0-9]/gi, '').slice(0, 8).toUpperCase(), name: 'p' } });
    await db.tab.create({ data: { id: tabId, projectId, machineId, name: 'agent' } });
    return async () => {
      await db.project.delete({ where: { id: projectId } });
      await db.machine.delete({ where: { id: machineId } });
    };
  });

  const eventAgo = (kind: 'working' | 'idle', seconds: number) =>
    db.tabEvent.create({ data: { id: newId(), tabId, kind, tool: 'claude', createdAt: new Date(Date.now() - seconds * 1000) } });
  const task = (data: { parentId?: string; tabId?: string | null; type?: 'task' | 'subtask' }) =>
    db.task.create({ data: { id: newId(), projectId, title: 't', type: data.type ?? 'task', parentId: data.parentId ?? null, tabId: data.tabId ?? null } });
  const secondsOf = async (id: string) => (await db.task.findUniqueOrThrow({ where: { id } })).activeSeconds;

  it('adds the closed working interval to the linked card', async () => {
    const card = await task({ tabId });
    await eventAgo('working', 90);
    await repo.recordEvent(tabId, { kind: 'waiting_input', tool: 'claude', text: null });
    expect(await secondsOf(card.id)).toBeGreaterThanOrEqual(89);
    expect(await secondsOf(card.id)).toBeLessThanOrEqual(91);
  });

  it('adds nothing when the previous event was not working', async () => {
    const card = await task({ tabId });
    await eventAgo('idle', 600);
    await repo.recordEvent(tabId, { kind: 'working', tool: 'claude', text: null });
    expect(await secondsOf(card.id)).toBe(0);
  });

  it('caps one interval at two hours', async () => {
    const card = await task({ tabId });
    await eventAgo('working', 5 * 3600);
    await repo.recordEvent(tabId, { kind: 'idle', tool: 'claude', text: null });
    expect(await secondsOf(card.id)).toBe(7200);
  });

  it('credits the parent card once when the tab is linked to the card and to one of its subtasks', async () => {
    const card = await task({ tabId });
    const sub = await task({ parentId: card.id, tabId, type: 'subtask' });
    await eventAgo('working', 60);
    await repo.recordEvent(tabId, { kind: 'idle', tool: 'claude', text: null });
    expect(await secondsOf(card.id)).toBeGreaterThanOrEqual(59);
    expect(await secondsOf(card.id)).toBeLessThanOrEqual(61);
    expect(await secondsOf(sub.id)).toBe(0);
  });

  it('credits the parent card when only a subtask is linked', async () => {
    const card = await task({});
    await task({ parentId: card.id, tabId, type: 'subtask' });
    await eventAgo('working', 60);
    await repo.recordEvent(tabId, { kind: 'idle', tool: 'claude', text: null });
    expect(await secondsOf(card.id)).toBeGreaterThanOrEqual(59);
  });
});
```

(Add the imports the file does not have yet: `PrismaPg`, `PrismaClient`, `newId`, `TabsRepository`, vitest's `beforeAll`/`beforeEach`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `DOCKER 'npx -w @termhub/server vitest run src/db/repositories/tabs.db.test.ts'`
Expected: the new "adds the closed working interval…" tests FAIL (`activeSeconds` stays 0).

- [ ] **Step 3: Implement** — in `tabs.ts`, next to `EVENTS_KEPT_PER_TAB`:

```ts
/** One working interval counts at most this much agent time: bounds a hook that died mid-turn (spec 2026-09-26 progress-panel D2). */
export const MAX_WORKING_INTERVAL_S = 7200;
```

In `recordEvent`, inside the transaction, right after reading `current` and before `tx.tabEvent.create`:

```ts
      // A working interval ends here: credit it to the card this tab works on (a subtask's parent), once.
      const previous = await tx.tabEvent.findFirst({ where: { tabId }, orderBy: { createdAt: 'desc' }, select: { kind: true, createdAt: true } });
      if (previous?.kind === 'working') {
        const seconds = Math.min(MAX_WORKING_INTERVAL_S, Math.round((at.getTime() - previous.createdAt.getTime()) / 1000));
        if (seconds > 0) {
          await tx.$executeRaw`UPDATE "tasks" SET "active_seconds" = "active_seconds" + ${seconds} WHERE "id" IN (SELECT DISTINCT COALESCE("parent_id", "id") FROM "tasks" WHERE "tab_id" = ${tabId})`;
        }
      }
```

(Raw SQL on purpose: it does not touch `updated_at` and does not fire the status trigger.)

- [ ] **Step 4: Run the tests**

Run: `DOCKER 'npx -w @termhub/server vitest run src/db/repositories/tabs.db.test.ts src/monitor'`
Expected: PASS (monitor tests unchanged).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/db/repositories/tabs.ts apps/server/src/db/repositories/tabs.db.test.ts
git commit -m "Monitor: credit closed working intervals to the linked card"
```

---

### Task 3: Contract — progress schemas in `@termhub/mobile-api`

**Files:**
- Create: `packages/mobile-api/src/progress.ts`, `packages/mobile-api/src/progress.test.ts`
- Modify: `packages/mobile-api/src/index.ts`

**Interfaces:**
- Produces (exported from `@termhub/mobile-api`): zod `progressEstimate`, `progressTabState`, `agentOnCard`, `cardProgress`, `epicProgress`, `progressResponse`, `progressScope`; types `ProgressEstimate`, `AgentOnCard`, `CardProgress`, `EpicProgress`, `ProgressResponse`, `ProgressScope` (`z.infer`).

- [ ] **Step 1: Write the failing test** (`progress.test.ts`):

```ts
import { describe, expect, it } from 'vitest';
import { progressEstimate, progressResponse } from './progress.js';

const card = {
  id: 'c1', ref: 'TER-2', title: 'Card', type: 'story', status: 'doing', column_name: 'Fazendo',
  units: { done: 1, total: 2 }, percent: 50, started_at: null, done_at: null, active_seconds: 0,
  estimate: { kind: 'none', reason: 'few_samples' }, agents: null,
};
const epic = {
  id: 'e1', ref: 'TER-1', title: 'Epic', project: { id: 'p1', key: 'TER', name: 'termhub' },
  units: { done: 1, total: 2, backlog_total: 0 }, percent: 50, estimate: { kind: 'none', reason: 'few_samples' },
  cards_without_estimate: 1, agents: null, cards: [card],
};

describe('progress contract', () => {
  it('accepts a full response', () => {
    expect(progressResponse.parse({ epics: [epic], generated_at: '2026-09-27T12:00:00.000Z' }).epics[0].cards[0].ref).toBe('TER-2');
  });
  it('accepts a range estimate and rejects an unknown basis', () => {
    expect(progressEstimate.parse({ kind: 'range', low_s: 600, high_s: 1800, basis: 'agent_time', samples: 3 }).kind).toBe('range');
    expect(() => progressEstimate.parse({ kind: 'range', low_s: 600, high_s: 1800, basis: 'guess', samples: 3 })).toThrow();
  });
  it('rejects a percent above 100', () => {
    expect(() => progressResponse.parse({ epics: [{ ...epic, percent: 101 }], generated_at: 'x' })).toThrow();
  });
});
```

- [ ] **Step 2: Run** `DOCKER 'npx -w @termhub/mobile-api vitest run'` — Expected: FAIL, `./progress.js` not found.

- [ ] **Step 3: Implement** `progress.ts`:

```ts
import { z } from 'zod';

/** Progress panel read model (spec 2026-09-26 progress-panel §4.4), shared by /api/progress and /api/m/v1/progress. */
export const progressScope = z.enum(['active', 'all']);
export const progressTabState = z.enum(['working', 'waiting_input', 'waiting_permission', 'idle', 'error']);
const taskStatus = z.enum(['backlog', 'todo', 'doing', 'done']);
const count = z.number().int().nonnegative();
const percent = z.number().int().min(0).max(100);

export const progressEstimate = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('done') }),
  z.object({ kind: z.literal('none'), reason: z.enum(['not_started', 'few_samples']) }),
  z.object({ kind: z.literal('range'), low_s: count, high_s: count, basis: z.enum(['agent_time', 'wall_clock']), samples: z.number().int().positive() }),
]);

export const agentOnCard = z.object({
  tab_id: z.string(),
  tab_name: z.string(),
  machine_name: z.string(),
  /** the subtask this tab was started on; null = the card itself */
  subtask_ref: z.string().nullable(),
  state: progressTabState.nullable(),
  state_at: z.string().nullable(),
  needs_you: z.boolean(),
  activity: z.string().nullable(),
  activity_verb: z.string().nullable(),
  rate_limited: z.boolean(),
});

export const cardProgress = z.object({
  id: z.string(),
  ref: z.string(),
  title: z.string(),
  type: z.string(),
  status: taskStatus,
  column_name: z.string().nullable(),
  units: z.object({ done: count, total: count }),
  percent,
  started_at: z.string().nullable(),
  done_at: z.string().nullable(),
  active_seconds: count,
  estimate: progressEstimate,
  /** null = the caller cannot read terminals */
  agents: z.array(agentOnCard).nullable(),
});

export const epicProgress = z.object({
  id: z.string(),
  ref: z.string(),
  title: z.string(),
  project: z.object({ id: z.string(), key: z.string(), name: z.string() }),
  units: z.object({ done: count, total: count, backlog_total: count }),
  percent,
  estimate: progressEstimate,
  cards_without_estimate: count,
  agents: z.object({ working: count, needs_you: count, idle: count }).nullable(),
  cards: z.array(cardProgress),
});

export const progressResponse = z.object({ epics: z.array(epicProgress), generated_at: z.string() });

export type ProgressScope = z.infer<typeof progressScope>;
export type ProgressEstimate = z.infer<typeof progressEstimate>;
export type AgentOnCard = z.infer<typeof agentOnCard>;
export type CardProgress = z.infer<typeof cardProgress>;
export type EpicProgress = z.infer<typeof epicProgress>;
export type ProgressResponse = z.infer<typeof progressResponse>;
```

Add `export * from './progress.js';` to `index.ts`.

- [ ] **Step 4: Run** the mobile-api tests, then `DOCKER 'npm run build -w @termhub/mobile-api'`. Expected: PASS, build OK.

- [ ] **Step 5: Commit**

```bash
git add packages/mobile-api/src
git commit -m "Mobile API: add the progress panel contract"
```

---

### Task 4: Pure estimator

**Files:**
- Create: `apps/server/src/progress/estimate.ts`, `apps/server/src/progress/estimate.test.ts`

**Interfaces:**
- Consumes: `ProgressEstimate` (Task 3).
- Produces:
  ```ts
  export const MIN_SAMPLES = 2;
  export interface EstimateInput { status: 'backlog' | 'todo' | 'doing' | 'done'; units: { done: number; total: number }; active_seconds: number; started_at: Date | null; unit_done_at: Date[] }
  export function roundDuration(seconds: number): number
  export function estimateCard(input: EstimateInput): ProgressEstimate
  ```

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { estimateCard, roundDuration, type EstimateInput } from './estimate.js';

const at = (min: number) => new Date(Date.UTC(2026, 8, 27, 12, 0) + min * 60_000);
const input = (over: Partial<EstimateInput>): EstimateInput => ({ status: 'doing', units: { done: 0, total: 4 }, active_seconds: 0, started_at: null, unit_done_at: [], ...over });

describe('roundDuration', () => {
  it('rounds to 5 min below an hour with a 5 min floor, to 30 min above', () => {
    expect(roundDuration(10)).toBe(300);
    expect(roundDuration(1260)).toBe(1200);
    expect(roundDuration(3700)).toBe(3600);
    expect(roundDuration(4600)).toBe(5400);
  });
});

describe('estimateCard', () => {
  it('is done for a done card, or when every unit is done', () => {
    expect(estimateCard(input({ status: 'done' }))).toEqual({ kind: 'done' });
    expect(estimateCard(input({ units: { done: 4, total: 4 } }))).toEqual({ kind: 'done' });
  });
  it('is not_started when nothing started, no time and no unit done', () => {
    expect(estimateCard(input({ status: 'todo' }))).toEqual({ kind: 'none', reason: 'not_started' });
  });
  it('needs two finished units', () => {
    expect(estimateCard(input({ started_at: at(0) }))).toEqual({ kind: 'none', reason: 'few_samples' });
    expect(estimateCard(input({ units: { done: 1, total: 4 }, active_seconds: 600 }))).toEqual({ kind: 'none', reason: 'few_samples' });
  });
  it('uses agent time when there is some: 2 done in 20 min, 2 left → 20 min × [0.5, 2]', () => {
    expect(estimateCard(input({ units: { done: 2, total: 4 }, active_seconds: 1200 }))).toEqual({ kind: 'range', low_s: 600, high_s: 2400, basis: 'agent_time', samples: 2 });
  });
  it('narrows the band from 5 samples on', () => {
    const e = estimateCard(input({ units: { done: 5, total: 6 }, active_seconds: 3000 }));
    // 600 s per unit, 1 left → [420, 900] → 420 rounds to 300
    expect(e).toEqual({ kind: 'range', low_s: 300, high_s: 900, basis: 'agent_time', samples: 5 });
  });
  it('falls back to wall clock from the start to the last finished unit', () => {
    const e = estimateCard(input({ units: { done: 2, total: 3 }, started_at: at(0), unit_done_at: [at(10), at(30)] }));
    // 30 min / 2 units = 15 min per unit, 1 left → [7.5, 30] min → rounded
    expect(e).toEqual({ kind: 'range', low_s: 600, high_s: 1800, basis: 'wall_clock', samples: 2 });
  });
  it('without a start, measures between finished units only', () => {
    const e = estimateCard(input({ units: { done: 2, total: 3 }, unit_done_at: [at(30), at(10)] }));
    // one interval of 20 min → 20 min per unit, 1 left → [10, 40] min
    expect(e).toEqual({ kind: 'range', low_s: 600, high_s: 2400, basis: 'wall_clock', samples: 2 });
  });
  it('ignores a start later than the first finished unit', () => {
    const e = estimateCard(input({ units: { done: 2, total: 3 }, started_at: at(20), unit_done_at: [at(10), at(30)] }));
    expect(e).toEqual({ kind: 'range', low_s: 600, high_s: 2400, basis: 'wall_clock', samples: 2 });
  });
  it('gives up when the finished units have no usable span', () => {
    expect(estimateCard(input({ units: { done: 2, total: 3 }, unit_done_at: [at(10), at(10)] }))).toEqual({ kind: 'none', reason: 'few_samples' });
  });
});
```

- [ ] **Step 2: Run** `DOCKER 'npx -w @termhub/server vitest run src/progress/estimate.test.ts'` — Expected: FAIL, module not found.

- [ ] **Step 3: Implement** `estimate.ts`:

```ts
import type { ProgressEstimate } from '@termhub/mobile-api';

/** Finished units needed before a card gets a range (spec 2026-09-26 progress-panel D4). */
export const MIN_SAMPLES = 2;
/** From this many samples on the band narrows from [×0.5, ×2] to [×0.7, ×1.5]. */
const NARROW_FROM = 5;

export interface EstimateInput {
  status: 'backlog' | 'todo' | 'doing' | 'done';
  units: { done: number; total: number };
  active_seconds: number;
  started_at: Date | null;
  /** when each finished unit finished: the subtasks', or the card's own when it has none */
  unit_done_at: Date[];
}

/** Below an hour to 5 min (never under 5 min), from an hour on to 30 min. */
export function roundDuration(seconds: number): number {
  if (seconds < 3600) return Math.max(300, Math.round(seconds / 300) * 300);
  return Math.round(seconds / 1800) * 1800;
}

/** Seconds per unit: agent time when the card has some, else wall clock between finished units. */
function paceOf(input: EstimateInput): { seconds: number; basis: 'agent_time' | 'wall_clock' } | null {
  const done = input.units.done;
  if (input.active_seconds > 0) return { seconds: input.active_seconds / done, basis: 'agent_time' };
  const times = input.unit_done_at.map((d) => d.getTime()).sort((a, b) => a - b);
  if (times.length === 0) return null;
  const start = input.started_at?.getTime();
  const fromStart = start !== undefined && start <= times[0];
  const span = times[times.length - 1] - (fromStart ? start : times[0]);
  const intervals = fromStart ? times.length : times.length - 1;
  if (intervals < 1 || span <= 0) return null;
  return { seconds: span / 1000 / intervals, basis: 'wall_clock' };
}

export function estimateCard(input: EstimateInput): ProgressEstimate {
  const { done, total } = input.units;
  if (input.status === 'done' || (total > 0 && done >= total)) return { kind: 'done' };
  if (done === 0 && !input.started_at && input.active_seconds === 0) return { kind: 'none', reason: 'not_started' };
  if (done < MIN_SAMPLES) return { kind: 'none', reason: 'few_samples' };
  const pace = paceOf(input);
  if (!pace) return { kind: 'none', reason: 'few_samples' };
  const mid = (total - done) * pace.seconds;
  const [low, high] = done >= NARROW_FROM ? [0.7, 1.5] : [0.5, 2];
  return { kind: 'range', low_s: roundDuration(mid * low), high_s: roundDuration(mid * high), basis: pace.basis, samples: done };
}
```

- [ ] **Step 4: Run** the test — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/progress
git commit -m "Progress: estimate a card's remaining work as a range"
```

---

### Task 5: Pure aggregator — cards, epics, agents, scope

**Files:**
- Create: `apps/server/src/progress/aggregate.ts`, `apps/server/src/progress/aggregate.test.ts`

**Interfaces:**
- Consumes: `estimateCard` (Task 4); `NEEDS_YOU` from `apps/server/src/monitor/state.ts`; contract types (Task 3).
- Produces:
  ```ts
  export interface ProgressTabRow { id: string; name: string; machine_name: string; state: 'working' | 'waiting_input' | 'waiting_permission' | 'idle' | 'error' | null; state_at: Date | null; activity: string | null; activity_verb: string | null; rate_limited_at: Date | null }
  export interface ProgressSubtaskRow { id: string; ref: string; status: TaskStatus; done_at: Date | null; tab: ProgressTabRow | null }
  export interface ProgressCardRow { id: string; ref: string; title: string; type: string; status: TaskStatus; position: number; column_name: string | null; started_at: Date | null; done_at: Date | null; active_seconds: number; tab: ProgressTabRow | null; subtasks: ProgressSubtaskRow[] }
  export interface ProgressEpicRow { id: string; ref: string; title: string; project: { id: string; key: string; name: string }; cards: ProgressCardRow[] }
  export function aggregateCard(card: ProgressCardRow, includeAgents: boolean): CardProgress
  export function aggregateEpic(epic: ProgressEpicRow, includeAgents: boolean): EpicProgress
  export function selectEpics(epics: EpicProgress[], scope: ProgressScope): EpicProgress[]
  ```
  (`TaskStatus = 'backlog' | 'todo' | 'doing' | 'done'`.)

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { aggregateCard, aggregateEpic, selectEpics, type ProgressCardRow, type ProgressEpicRow, type ProgressTabRow } from './aggregate.js';

const at = (min: number) => new Date(Date.UTC(2026, 8, 27, 12, 0) + min * 60_000);
const tab = (id: string, state: ProgressTabRow['state']): ProgressTabRow => ({ id, name: `aba ${id}`, machine_name: 'jarvis', state, state_at: at(0), activity: null, activity_verb: null, rate_limited_at: null });
const card = (over: Partial<ProgressCardRow> & { id: string }): ProgressCardRow => ({
  ref: `TER-${over.id}`, title: over.id, type: 'story', status: 'doing', position: 0, column_name: 'Fazendo',
  started_at: null, done_at: null, active_seconds: 0, tab: null, subtasks: [], ...over,
});
const sub = (id: string, status: 'todo' | 'done', extra: { done_at?: Date; tab?: ProgressTabRow } = {}) => ({ id, ref: `TER-${id}`, status, done_at: extra.done_at ?? null, tab: extra.tab ?? null });
const epic = (cards: ProgressCardRow[], id = 'e1'): ProgressEpicRow => ({ id, ref: `TER-${id}`, title: `Épico ${id}`, project: { id: 'p1', key: 'TER', name: 'termhub' }, cards });

describe('aggregateCard', () => {
  it('counts subtasks as units', () => {
    const c = aggregateCard(card({ id: '2', subtasks: [sub('3', 'done'), sub('4', 'todo'), sub('5', 'todo')] }), true);
    expect(c.units).toEqual({ done: 1, total: 3 });
    expect(c.percent).toBe(33);
  });
  it('counts a card without subtasks as one unit', () => {
    expect(aggregateCard(card({ id: '2' }), true).units).toEqual({ done: 0, total: 1 });
    expect(aggregateCard(card({ id: '2', status: 'done' }), true).percent).toBe(100);
  });
  it('reads a done card with unfinished subtasks as 100 % and done', () => {
    const c = aggregateCard(card({ id: '2', status: 'done', subtasks: [sub('3', 'done'), sub('4', 'todo')] }), true);
    expect(c.units).toEqual({ done: 2, total: 2 });
    expect(c.percent).toBe(100);
    expect(c.estimate).toEqual({ kind: 'done' });
  });
  it('lists the tabs of the card and of its subtasks once, needs-you first', () => {
    const t1 = tab('t1', 'working');
    const t2 = tab('t2', 'waiting_permission');
    const c = aggregateCard(card({ id: '2', tab: t1, subtasks: [sub('3', 'todo', { tab: t2 }), sub('4', 'todo', { tab: t1 })] }), true);
    expect(c.agents?.map((a) => [a.tab_id, a.subtask_ref, a.needs_you])).toEqual([
      ['t2', 'TER-3', true],
      ['t1', null, false],
    ]);
  });
  it('hides agents when the caller cannot read terminals', () => {
    expect(aggregateCard(card({ id: '2', tab: tab('t1', 'working') }), false).agents).toBeNull();
  });
  it('estimates from the subtasks finish times', () => {
    const c = aggregateCard(card({ id: '2', started_at: at(0), subtasks: [sub('3', 'done', { done_at: at(10) }), sub('4', 'done', { done_at: at(20) }), sub('5', 'todo')] }), true);
    expect(c.estimate).toMatchObject({ kind: 'range', basis: 'wall_clock', samples: 2 });
  });
});

describe('aggregateEpic', () => {
  const ranged = (id: string, active: number) => card({ id, active_seconds: active, subtasks: [sub(`${id}a`, 'done'), sub(`${id}b`, 'done'), sub(`${id}c`, 'todo')] });

  it('sums units across cards, backlog included and reported apart', () => {
    const e = aggregateEpic(epic([card({ id: '2', subtasks: [sub('3', 'done'), sub('4', 'todo')] }), card({ id: '5', status: 'backlog', column_name: null })]), true);
    expect(e.units).toEqual({ done: 1, total: 3, backlog_total: 1 });
    expect(e.percent).toBe(33);
  });
  it('orders cards doing, todo, done, backlog, then by position', () => {
    const e = aggregateEpic(epic([card({ id: 'b', status: 'backlog' }), card({ id: 'd', status: 'done' }), card({ id: 't', status: 'todo' }), card({ id: 'x', position: 1 }), card({ id: 'y', position: 0 })]), true);
    expect(e.cards.map((c) => c.id)).toEqual(['y', 'x', 't', 'd', 'b']);
  });
  it('takes the longest range among doing cards, never the sum', () => {
    const e = aggregateEpic(epic([ranged('2', 1200), ranged('6', 2400)]), true);
    // card 6: 1200 s per unit, 1 left → [600, 2400]; card 2: [300, 1200]
    expect(e.estimate).toEqual({ kind: 'range', low_s: 600, high_s: 2400, basis: 'agent_time', samples: 2 });
  });
  it('counts open cards without an estimate', () => {
    const e = aggregateEpic(epic([ranged('2', 1200), card({ id: '7', status: 'todo' }), card({ id: '8' }), card({ id: '9', status: 'backlog' })]), true);
    expect(e.cards_without_estimate).toBe(2);
  });
  it('is done when every card is done', () => {
    expect(aggregateEpic(epic([card({ id: '2', status: 'done' })]), true).estimate).toEqual({ kind: 'done' });
  });
  it('counts distinct agents by state', () => {
    const t1 = tab('t1', 'working');
    const e = aggregateEpic(epic([card({ id: '2', tab: t1 }), card({ id: '3', tab: tab('t2', 'waiting_input'), subtasks: [sub('4', 'todo', { tab: t1 })] }), card({ id: '5', tab: tab('t3', null) })]), true);
    expect(e.agents).toEqual({ working: 1, needs_you: 1, idle: 1 });
  });
});

describe('selectEpics', () => {
  const doing = aggregateEpic(epic([card({ id: '2' })], 'a'), true);
  const todoOnly = aggregateEpic(epic([card({ id: '3', status: 'todo' })], 'b'), true);
  const empty = aggregateEpic(epic([], 'c'), true);
  const finished = aggregateEpic(epic([card({ id: '4', status: 'done' })], 'd'), true);
  const waiting = aggregateEpic(epic([card({ id: '5', tab: tab('t9', 'waiting_input') })], 'e'), true);

  it('active keeps epics with a card in doing, needs-you first', () => {
    expect(selectEpics([doing, todoOnly, empty, finished, waiting], 'active').map((e) => e.id)).toEqual(['e', 'a']);
  });
  it('all keeps every epic with cards, finished ones last', () => {
    expect(selectEpics([finished, todoOnly, doing, empty], 'all').map((e) => e.id)).toEqual(['a', 'b', 'd']);
  });
});
```

- [ ] **Step 2: Run** `DOCKER 'npx -w @termhub/server vitest run src/progress/aggregate.test.ts'` — Expected: FAIL, module not found.

- [ ] **Step 3: Implement** `aggregate.ts`:

```ts
import type { AgentOnCard, CardProgress, EpicProgress, ProgressEstimate, ProgressScope } from '@termhub/mobile-api';
import { NEEDS_YOU } from '../monitor/state.js';
import { estimateCard } from './estimate.js';

type TaskStatus = 'backlog' | 'todo' | 'doing' | 'done';
type Range = Extract<ProgressEstimate, { kind: 'range' }>;

export interface ProgressTabRow {
  id: string;
  name: string;
  machine_name: string;
  state: 'working' | 'waiting_input' | 'waiting_permission' | 'idle' | 'error' | null;
  state_at: Date | null;
  activity: string | null;
  activity_verb: string | null;
  rate_limited_at: Date | null;
}
export interface ProgressSubtaskRow { id: string; ref: string; status: TaskStatus; done_at: Date | null; tab: ProgressTabRow | null }
export interface ProgressCardRow {
  id: string;
  ref: string;
  title: string;
  type: string;
  status: TaskStatus;
  position: number;
  column_name: string | null;
  started_at: Date | null;
  done_at: Date | null;
  active_seconds: number;
  tab: ProgressTabRow | null;
  subtasks: ProgressSubtaskRow[];
}
export interface ProgressEpicRow { id: string; ref: string; title: string; project: { id: string; key: string; name: string }; cards: ProgressCardRow[] }

const STATUS_ORDER: Record<TaskStatus, number> = { doing: 0, todo: 1, done: 2, backlog: 3 };
const iso = (d: Date | null) => d?.toISOString() ?? null;
const percentOf = (u: { done: number; total: number }) => (u.total === 0 ? 0 : Math.round((u.done / u.total) * 100));

/** Each subtask is a unit; a card without subtasks is one; a done card has all its units done (spec D3). */
function unitsOf(card: ProgressCardRow): { done: number; total: number } {
  const total = card.subtasks.length || 1;
  if (card.status === 'done') return { done: total, total };
  if (card.subtasks.length === 0) return { done: 0, total };
  return { done: card.subtasks.filter((s) => s.status === 'done').length, total };
}

function agentOf(tab: ProgressTabRow, subtaskRef: string | null): AgentOnCard {
  return {
    tab_id: tab.id,
    tab_name: tab.name,
    machine_name: tab.machine_name,
    subtask_ref: subtaskRef,
    state: tab.state,
    state_at: iso(tab.state_at),
    needs_you: tab.state !== null && NEEDS_YOU.includes(tab.state),
    activity: tab.activity,
    activity_verb: tab.activity_verb,
    rate_limited: tab.rate_limited_at !== null,
  };
}

/** The card's own tab, then each subtask's, each tab once; the ones waiting for the user first. */
function agentsOf(card: ProgressCardRow): AgentOnCard[] {
  const byTab = new Map<string, AgentOnCard>();
  if (card.tab) byTab.set(card.tab.id, agentOf(card.tab, null));
  for (const s of card.subtasks) if (s.tab && !byTab.has(s.tab.id)) byTab.set(s.tab.id, agentOf(s.tab, s.ref));
  return [...byTab.values()].sort((a, b) => Number(b.needs_you) - Number(a.needs_you));
}

export function aggregateCard(card: ProgressCardRow, includeAgents: boolean): CardProgress {
  const units = unitsOf(card);
  const finished = (card.subtasks.length > 0 ? card.subtasks.map((s) => s.done_at) : [card.done_at]).filter((d): d is Date => d !== null);
  return {
    id: card.id,
    ref: card.ref,
    title: card.title,
    type: card.type,
    status: card.status,
    column_name: card.column_name,
    units,
    percent: percentOf(units),
    started_at: iso(card.started_at),
    done_at: iso(card.done_at),
    active_seconds: card.active_seconds,
    estimate: estimateCard({ status: card.status, units, active_seconds: card.active_seconds, started_at: card.started_at, unit_done_at: finished }),
    agents: includeAgents ? agentsOf(card) : null,
  };
}

/** The longest range among the cards in doing: they run in parallel, so never a sum (spec D5). */
function epicEstimate(cards: CardProgress[]): ProgressEstimate {
  if (cards.length > 0 && cards.every((c) => c.status === 'done')) return { kind: 'done' };
  const doing = cards.filter((c) => c.status === 'doing');
  const ranges = doing.map((c) => c.estimate).filter((e): e is Range => e.kind === 'range');
  if (ranges.length === 0) return { kind: 'none', reason: doing.length > 0 ? 'few_samples' : 'not_started' };
  return {
    kind: 'range',
    low_s: Math.max(...ranges.map((r) => r.low_s)),
    high_s: Math.max(...ranges.map((r) => r.high_s)),
    basis: ranges.every((r) => r.basis === 'agent_time') ? 'agent_time' : 'wall_clock',
    samples: Math.min(...ranges.map((r) => r.samples)),
  };
}

function agentCounts(cards: CardProgress[]): { working: number; needs_you: number; idle: number } {
  const byTab = new Map<string, AgentOnCard>();
  for (const c of cards) for (const a of c.agents ?? []) byTab.set(a.tab_id, a);
  const counts = { working: 0, needs_you: 0, idle: 0 };
  for (const a of byTab.values()) {
    if (a.needs_you) counts.needs_you++;
    else if (a.state === 'working') counts.working++;
    else counts.idle++;
  }
  return counts;
}

export function aggregateEpic(epic: ProgressEpicRow, includeAgents: boolean): EpicProgress {
  const ordered = [...epic.cards].sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.position - b.position);
  const cards = ordered.map((c) => aggregateCard(c, includeAgents));
  const units = { done: 0, total: 0, backlog_total: 0 };
  for (const c of cards) {
    units.done += c.units.done;
    units.total += c.units.total;
    if (c.status === 'backlog') units.backlog_total += c.units.total;
  }
  return {
    id: epic.id,
    ref: epic.ref,
    title: epic.title,
    project: epic.project,
    units,
    percent: percentOf(units),
    estimate: epicEstimate(cards),
    cards_without_estimate: cards.filter((c) => (c.status === 'todo' || c.status === 'doing') && c.estimate.kind === 'none').length,
    agents: includeAgents ? agentCounts(cards) : null,
    cards,
  };
}

/** active: epics with a card in doing; all: every epic with cards, finished last. Needs-you first, then working agents, then ref. */
export function selectEpics(epics: EpicProgress[], scope: ProgressScope): EpicProgress[] {
  const kept = epics.filter((e) => e.cards.length > 0 && (scope === 'all' || e.cards.some((c) => c.status === 'doing')));
  const finished = (e: EpicProgress) => Number(e.estimate.kind === 'done');
  return kept.sort(
    (a, b) =>
      finished(a) - finished(b) ||
      (b.agents?.needs_you ?? 0) - (a.agents?.needs_you ?? 0) ||
      (b.agents?.working ?? 0) - (a.agents?.working ?? 0) ||
      a.ref.localeCompare(b.ref, undefined, { numeric: true }),
  );
}
```

- [ ] **Step 4: Run** the test — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/progress
git commit -m "Progress: aggregate cards and epics into the panel read model"
```

---

### Task 6: `ProgressRepository.list`

**Files:**
- Create: `apps/server/src/db/repositories/progress.ts`
- Modify: `apps/server/src/db/repositories/index.ts` (import, `progress: ProgressRepository` in `Repositories`, `progress: new ProgressRepository(db)` in `createRepositories`)
- Test: `apps/server/src/db/repositories/progress.db.test.ts` (append a `describe`)

**Interfaces:**
- Consumes: row types of Task 5; Prisma fields of Task 1.
- Produces: `class ProgressRepository { list(opts: { owner: string | null; projectId: string | null }): Promise<ProgressEpicRow[]> }` — epics of non-archived projects (owner-filtered when `owner` is set), each with every top-level non-epic card and its subtasks, refs `KEY-N`.

- [ ] **Step 1: Write the failing test** (append):

```ts
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

  beforeEach(async () => {
    [ownerId, otherOwnerId, machineId, projectId, otherProjectId] = [newId(), newId(), newId(), newId(), newId()];
    key = keyOf(projectId);
    await db.user.createMany({ data: [{ id: ownerId, email: `${ownerId}@t.dev` }, { id: otherOwnerId, email: `${otherOwnerId}@t.dev` }] });
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
```

(Add the `ProgressRepository` import at the top. If `db.user.createMany` needs more required columns, copy them from `users.db.test.ts`.)

- [ ] **Step 2: Run** `DOCKER 'npx -w @termhub/server vitest run src/db/repositories/progress.db.test.ts'` — Expected: FAIL, `./progress.js` not found.

- [ ] **Step 3: Implement** `progress.ts`:

```ts
import type { PrismaClient } from '../prisma.js';
import type { ProgressEpicRow, ProgressTabRow } from '../../progress/aggregate.js';

const TAB = { include: { machine: { select: { name: true } } } } as const;

type TabWithMachine = {
  id: string;
  name: string;
  state: ProgressTabRow['state'];
  stateAt: Date | null;
  activity: string | null;
  activityVerb: string | null;
  rateLimitedAt: Date | null;
  machine: { name: string };
};

const toTab = (t: TabWithMachine | null): ProgressTabRow | null =>
  t && { id: t.id, name: t.name, machine_name: t.machine.name, state: t.state, state_at: t.stateAt, activity: t.activity, activity_verb: t.activityVerb, rate_limited_at: t.rateLimitedAt };

/**
 * The progress panel's rows (spec 2026-09-26 progress-panel §4.5): epics of the owner's
 * non-archived projects, each with its top-level cards, their subtasks and the tabs linked to
 * either. A card's tab always belongs to the card's project, so the project filter scopes it too.
 */
export class ProgressRepository {
  constructor(private db: PrismaClient) {}

  async list(opts: { owner: string | null; projectId: string | null }): Promise<ProgressEpicRow[]> {
    const project = { status: { not: 'archived' as const }, ...(opts.owner ? { ownerId: opts.owner } : {}), ...(opts.projectId ? { id: opts.projectId } : {}) };
    const epics = await this.db.task.findMany({
      where: { type: 'epic', project },
      include: { project: { select: { id: true, key: true, name: true } } },
      orderBy: [{ projectId: 'asc' }, { number: 'asc' }],
    });
    if (epics.length === 0) return [];
    const cards = await this.db.task.findMany({
      where: { epicId: { in: epics.map((e) => e.id) }, parentId: null, type: { not: 'epic' } },
      include: { column: { select: { name: true } }, tab: TAB, subtasks: { include: { tab: TAB }, orderBy: [{ position: 'asc' }, { createdAt: 'asc' }] } },
    });
    const byEpic = new Map<string, typeof cards>();
    for (const c of cards) {
      const list = byEpic.get(c.epicId!) ?? [];
      list.push(c);
      byEpic.set(c.epicId!, list);
    }
    return epics.map((e) => {
      const ref = (n: number) => `${e.project.key}-${n}`;
      return {
        id: e.id,
        ref: ref(e.number),
        title: e.title,
        project: e.project,
        cards: (byEpic.get(e.id) ?? []).map((c) => ({
          id: c.id,
          ref: ref(c.number),
          title: c.title,
          type: c.type,
          status: c.status,
          position: c.position,
          column_name: c.column?.name ?? null,
          started_at: c.startedAt,
          done_at: c.doneAt,
          active_seconds: c.activeSeconds,
          tab: toTab(c.tab),
          subtasks: c.subtasks.map((s) => ({ id: s.id, ref: ref(s.number), status: s.status, done_at: s.doneAt, tab: toTab(s.tab) })),
        })),
      };
    });
  }
}
```

Register it in `index.ts` (import, interface field, factory line) next to `tasks`.

- [ ] **Step 4: Run** the test and `DOCKER 'npm run typecheck -w @termhub/server'` — Expected: PASS, no type errors (every existing `Repositories` stub in tests is cast with `as unknown as Repositories`, so they keep compiling).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/db/repositories
git commit -m "Progress: read epics, cards, subtasks and linked tabs"
```

---

### Task 7: Route `/api/progress` (web) and `/api/m/v1/progress` (phone)

**Files:**
- Create: `apps/server/src/routes/progress.ts`, `apps/server/src/routes/progress.test.ts`
- Modify: `apps/server/src/app.ts` (register), `apps/server/src/mobile/app.ts` (register in `mobileRoutes`)

**Interfaces:**
- Consumes: `repos.progress.list` (Task 6), `aggregateEpic`/`selectEpics` (Task 5), `progressResponse`/`progressScope` (Task 3), `canAccess` (`auth/permissions.ts`), `scoped` (`auth/scope.ts`).
- Produces: `export async function progressRoutes(app: FastifyInstance, repos: Repositories, deps?: { now?: () => Date }): Promise<void>` — `GET /` with query `{ project_id?: string; scope?: 'active' | 'all' }` → `ProgressResponse`.

- [ ] **Step 1: Write the failing test** (`progress.test.ts`):

```ts
import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Repositories } from '../db/repositories/index.js';
import type { ProgressEpicRow } from '../progress/aggregate.js';
import { applyErrorHandler } from '../lib/errors.js';

const perms = vi.hoisted(() => ({ terminals: true }));
vi.mock('../auth/permissions.js', async (orig) => ({
  ...(await orig<typeof import('../auth/permissions.js')>()),
  canAccess: vi.fn(async (_r: unknown, _u: unknown, resource: string, action: string) => (resource === 'terminals' && action === 'read' ? perms.terminals : true)),
}));

import { progressRoutes } from './progress.js';

const NOW = new Date('2026-09-27T12:00:00.000Z');
const rows: ProgressEpicRow[] = [
  {
    id: 'e1', ref: 'TER-1', title: 'Épico', project: { id: 'p1', key: 'TER', name: 'termhub' },
    cards: [{
      id: 'c1', ref: 'TER-2', title: 'Card', type: 'story', status: 'doing', position: 0, column_name: 'Fazendo',
      started_at: null, done_at: null, active_seconds: 0, subtasks: [],
      tab: { id: 't1', name: 'agent', machine_name: 'jarvis', state: 'waiting_input', state_at: NOW, activity: null, activity_verb: null, rate_limited_at: null },
    }],
  },
  { id: 'e2', ref: 'TER-3', title: 'Parado', project: { id: 'p1', key: 'TER', name: 'termhub' }, cards: [{ id: 'c2', ref: 'TER-4', title: 'x', type: 'task', status: 'todo', position: 0, column_name: 'A fazer', started_at: null, done_at: null, active_seconds: 0, subtasks: [], tab: null }] },
];
const projects = [{ id: 'p1', owner_id: 'u1' }, { id: 'p2', owner_id: 'u2' }];

function build(ownerId: string | null = 'u1') {
  const list = vi.fn(async () => rows);
  const repos = { progress: { list }, projects: { findById: vi.fn(async (id: string) => projects.find((p) => p.id === id)) } } as unknown as Repositories;
  const app = Fastify();
  applyErrorHandler(app);
  app.addHook('preHandler', async (request) => {
    request.scope = { user: { id: 'u1' } as never, viewAs: { kind: 'self' }, ownerId, createAs: 'u1' };
    request.user = { id: 'u1', role_id: 'r1' } as never;
  });
  app.register((a) => progressRoutes(a, repos, { now: () => NOW }), { prefix: '/progress' });
  return { app, list };
}

beforeEach(() => {
  perms.terminals = true;
});

describe('GET /progress', () => {
  it('returns the active epics of the caller with agents', async () => {
    const { app, list } = build();
    const r = await app.inject({ method: 'GET', url: '/progress' });
    expect(r.statusCode).toBe(200);
    expect(list).toHaveBeenCalledWith({ owner: 'u1', projectId: null });
    const body = r.json();
    expect(body.generated_at).toBe(NOW.toISOString());
    expect(body.epics.map((e: { ref: string }) => e.ref)).toEqual(['TER-1']);
    expect(body.epics[0].agents).toEqual({ working: 0, needs_you: 1, idle: 0 });
    expect(body.epics[0].cards[0].agents[0]).toMatchObject({ tab_id: 't1', needs_you: true });
  });

  it('scope=all keeps epics without a card in doing', async () => {
    const { app } = build();
    const r = await app.inject({ method: 'GET', url: '/progress?scope=all' });
    expect(r.json().epics.map((e: { ref: string }) => e.ref)).toEqual(['TER-1', 'TER-3']);
  });

  it('hides every agent without terminals:read', async () => {
    perms.terminals = false;
    const { app } = build();
    const body = (await app.inject({ method: 'GET', url: '/progress' })).json();
    expect(body.epics[0].agents).toBeNull();
    expect(body.epics[0].cards[0].agents).toBeNull();
    expect(JSON.stringify(body)).not.toContain('jarvis');
  });

  it('filters by a project of the scope', async () => {
    const { app, list } = build();
    expect((await app.inject({ method: 'GET', url: '/progress?project_id=p1' })).statusCode).toBe(200);
    expect(list).toHaveBeenCalledWith({ owner: 'u1', projectId: 'p1' });
  });

  it('answers 404 for a project of another owner, without reading progress', async () => {
    const { app, list } = build();
    expect((await app.inject({ method: 'GET', url: '/progress?project_id=p2' })).statusCode).toBe(404);
    expect(list).not.toHaveBeenCalled();
  });

  it('rejects an unknown scope with 400', async () => {
    const { app } = build();
    expect((await app.inject({ method: 'GET', url: '/progress?scope=everything' })).statusCode).toBe(400);
  });
});
```

- [ ] **Step 2: Run** `DOCKER 'npx -w @termhub/server vitest run src/routes/progress.test.ts'` — Expected: FAIL, `./progress.js` not found.

- [ ] **Step 3: Implement** `routes/progress.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { progressResponse, progressScope } from '@termhub/mobile-api';
import type { Repositories } from '../db/repositories/index.js';
import { canAccess } from '../auth/permissions.js';
import { scoped } from '../auth/scope.js';
import { aggregateEpic, selectEpics } from '../progress/aggregate.js';

const query = z.object({ project_id: z.string().min(1).max(64).optional(), scope: progressScope.default('active') });

/**
 * The progress panel (spec 2026-09-26 progress-panel §4.5), mounted at /api/progress and, for the
 * phone, /api/m/v1/progress. Guarded as `tasks`; agents (tab names and states) only with terminals:read.
 */
export async function progressRoutes(app: FastifyInstance, repos: Repositories, deps: { now?: () => Date } = {}) {
  app.get('/', async (request) => {
    const q = query.parse(request.query ?? {});
    if (q.project_id) await scoped(repos, request).project(q.project_id);
    const includeAgents = await canAccess(repos, request.user, 'terminals', 'read');
    const rows = await repos.progress.list({ owner: request.scope.ownerId, projectId: q.project_id ?? null });
    const epics = selectEpics(rows.map((e) => aggregateEpic(e, includeAgents)), q.scope);
    return progressResponse.parse({ epics, generated_at: (deps.now?.() ?? new Date()).toISOString() });
  });
}
```

In `app.ts`, after the `dashboardRoutes` line: `await guarded('tasks', (a) => progressRoutes(a, repos), '/progress');` (plus the import).
In `mobile/app.ts`, inside `mobileRoutes`, after the notifications line:

```ts
        // The Progresso tab: the same read model as the web panel (spec 2026-09-26 progress-panel D10).
        await guarded('tasks', (a) => progressRoutes(a, deps.repos), '/progress');
```

- [ ] **Step 4: Run** the test, then `DOCKER 'npx -w @termhub/server vitest run src/routes src/mobile && npm run typecheck -w @termhub/server'` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/routes/progress.ts apps/server/src/routes/progress.test.ts apps/server/src/app.ts apps/server/src/mobile/app.ts
git commit -m "Progress: serve the panel on the web and phone APIs"
```

---

### Task 8: Web — types, API client and formatters

**Files:**
- Modify: `apps/web/src/lib/types.ts`, `apps/web/src/lib/api.ts`
- Create: `apps/web/src/lib/progress.ts`, `apps/web/src/lib/progress.test.ts`

**Interfaces:**
- Produces (web): types `ProgressEstimate`, `AgentOnCard`, `CardProgress`, `EpicProgress`, `ProgressResponse`, `ProgressScope` in `lib/types.ts` (same shapes as Task 3); `api.progress(params: { project_id?: string; scope?: ProgressScope }): Promise<ProgressResponse>`; in `lib/progress.ts`: `formatDuration(s: number): string`, `formatEstimate(e: ProgressEstimate): string`, `BASIS_LABEL`, `stateLabel(state: TabState | null): string`, `withLiveTab(agent: AgentOnCard, live: Tab | undefined): AgentOnCard`, `needsYouAgents(epics: EpicProgress[]): AgentOnCard[]`.

- [ ] **Step 1: Write the failing test** (`progress.test.ts`):

```ts
import { describe, expect, it } from 'vitest';
import type { AgentOnCard, EpicProgress, Tab } from './types';
import { formatDuration, formatEstimate, needsYouAgents, stateLabel, withLiveTab } from './progress';

const agent = (over: Partial<AgentOnCard> = {}): AgentOnCard => ({
  tab_id: 't1', tab_name: 'agent', machine_name: 'jarvis', subtask_ref: null, state: 'working', state_at: '2026-09-27T12:00:00.000Z',
  needs_you: false, activity: 'coding', activity_verb: 'Coding', rate_limited: false, ...over,
});

describe('formatDuration', () => {
  it('shows minutes below an hour and hours with a pt-BR decimal above', () => {
    expect(formatDuration(1200)).toBe('20 min');
    expect(formatDuration(3600)).toBe('1 h');
    expect(formatDuration(9000)).toBe('2,5 h');
  });
});

describe('formatEstimate', () => {
  it('writes ranges in one unit when both ends share it', () => {
    expect(formatEstimate({ kind: 'range', low_s: 1200, high_s: 2700, basis: 'agent_time', samples: 2 })).toBe('~20–45 min de trabalho');
    expect(formatEstimate({ kind: 'range', low_s: 3600, high_s: 9000, basis: 'agent_time', samples: 2 })).toBe('~1–2,5 h de trabalho');
  });
  it('writes both units when the range crosses an hour, and one value when the ends match', () => {
    expect(formatEstimate({ kind: 'range', low_s: 2700, high_s: 5400, basis: 'wall_clock', samples: 2 })).toBe('~45 min–1,5 h de trabalho');
    expect(formatEstimate({ kind: 'range', low_s: 300, high_s: 300, basis: 'wall_clock', samples: 2 })).toBe('~5 min de trabalho');
  });
  it('explains the missing estimate', () => {
    expect(formatEstimate({ kind: 'none', reason: 'not_started' })).toBe('ainda não começou');
    expect(formatEstimate({ kind: 'none', reason: 'few_samples' })).toBe('estimativa após 2 subtarefas');
    expect(formatEstimate({ kind: 'done' })).toBe('concluído');
  });
});

describe('stateLabel', () => {
  it('names each state in pt-BR', () => {
    expect(stateLabel('waiting_input')).toBe('esperando você');
    expect(stateLabel('waiting_permission')).toBe('pedindo permissão');
    expect(stateLabel(null)).toBe('sem sinal');
  });
});

describe('withLiveTab', () => {
  it('replaces the state with the live monitor tab', () => {
    const live = { id: 't1', state: 'waiting_permission', state_at: '2026-09-27T12:05:00.000Z', activity: null, activity_verb: null, rate_limited_at: null } as Tab;
    expect(withLiveTab(agent(), live)).toMatchObject({ state: 'waiting_permission', needs_you: true, activity: null, state_at: '2026-09-27T12:05:00.000Z' });
  });
  it('keeps the server value when the monitor does not know the tab', () => {
    expect(withLiveTab(agent(), undefined)).toEqual(agent());
  });
});

describe('needsYouAgents', () => {
  it('collects each waiting tab once across epics', () => {
    const waiting = agent({ tab_id: 't2', needs_you: true, state: 'waiting_input' });
    const card = { agents: [waiting, agent()] } as EpicProgress['cards'][number];
    const epics = [{ cards: [card, card] }, { cards: [{ agents: null }] }] as unknown as EpicProgress[];
    expect(needsYouAgents(epics).map((a) => a.tab_id)).toEqual(['t2']);
  });
});
```

- [ ] **Step 2: Run** `DOCKER 'npx -w @termhub/web vitest run src/lib/progress.test.ts'` — Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

In `lib/types.ts` (near `Task`), mirror Task 3's shapes:

```ts
/** Progress panel (spec 2026-09-26 progress-panel §4.4); same shape as `@termhub/mobile-api` progress.ts. */
export type ProgressScope = 'active' | 'all';
export type ProgressEstimate =
  | { kind: 'done' }
  | { kind: 'none'; reason: 'not_started' | 'few_samples' }
  | { kind: 'range'; low_s: number; high_s: number; basis: 'agent_time' | 'wall_clock'; samples: number };
export interface AgentOnCard {
  tab_id: string;
  tab_name: string;
  machine_name: string;
  subtask_ref: string | null;
  state: TabState | null;
  state_at: string | null;
  needs_you: boolean;
  activity: string | null;
  activity_verb: string | null;
  rate_limited: boolean;
}
export interface CardProgress {
  id: string;
  ref: string;
  title: string;
  type: string;
  status: 'backlog' | 'todo' | 'doing' | 'done';
  column_name: string | null;
  units: { done: number; total: number };
  percent: number;
  started_at: string | null;
  done_at: string | null;
  active_seconds: number;
  estimate: ProgressEstimate;
  agents: AgentOnCard[] | null;
}
export interface EpicProgress {
  id: string;
  ref: string;
  title: string;
  project: { id: string; key: string; name: string };
  units: { done: number; total: number; backlog_total: number };
  percent: number;
  estimate: ProgressEstimate;
  cards_without_estimate: number;
  agents: { working: number; needs_you: number; idle: number } | null;
  cards: CardProgress[];
}
export interface ProgressResponse {
  epics: EpicProgress[];
  generated_at: string;
}
```

In `lib/api.ts`, add the types to the import and, after `dashboard`:

```ts
  progress: (params: { project_id?: string; scope?: ProgressScope } = {}) => {
    const qs = new URLSearchParams(Object.entries(params).filter((e): e is [string, string] => !!e[1])).toString();
    return request<ProgressResponse>('GET', `/progress${qs ? `?${qs}` : ''}`);
  },
```

`lib/progress.ts`:

```ts
import type { AgentOnCard, EpicProgress, ProgressEstimate, Tab, TabState } from './types';

const HOUR = 3600;

/** "20 min", "1 h", "2,5 h". */
export function formatDuration(seconds: number): string {
  if (seconds < HOUR) return `${Math.round(seconds / 60)} min`;
  const hours = Math.round((seconds / HOUR) * 10) / 10;
  return `${String(hours).replace('.', ',')} h`;
}

/** The card's or epic's estimate as one line (spec D4, D6: work time, never a clock time). */
export function formatEstimate(e: ProgressEstimate): string {
  if (e.kind === 'done') return 'concluído';
  if (e.kind === 'none') return e.reason === 'not_started' ? 'ainda não começou' : 'estimativa após 2 subtarefas';
  const low = formatDuration(e.low_s);
  const high = formatDuration(e.high_s);
  if (low === high) return `~${low} de trabalho`;
  const sameUnit = e.low_s < HOUR === e.high_s < HOUR;
  return `~${sameUnit ? low.replace(/ (min|h)$/, '') : low}–${high} de trabalho`;
}

export const BASIS_LABEL = { agent_time: 'tempo de agente', wall_clock: 'tempo corrido' } as const;

const STATE_LABEL: Record<TabState, string> = {
  working: 'trabalhando',
  waiting_input: 'esperando você',
  waiting_permission: 'pedindo permissão',
  idle: 'parado',
  error: 'erro',
};

export function stateLabel(state: TabState | null): string {
  return state ? STATE_LABEL[state] : 'sem sinal';
}

/** The monitor streams tab states live; the panel's own copy is up to 15 s old. */
export function withLiveTab(agent: AgentOnCard, live: Tab | undefined): AgentOnCard {
  if (!live) return agent;
  return {
    ...agent,
    state: live.state,
    state_at: live.state_at,
    needs_you: live.state === 'waiting_input' || live.state === 'waiting_permission',
    activity: live.activity,
    activity_verb: live.activity_verb,
    rate_limited: live.rate_limited_at !== null,
  };
}

/** Every tab waiting for the user, once, across the epics shown. */
export function needsYouAgents(epics: EpicProgress[]): AgentOnCard[] {
  const byTab = new Map<string, AgentOnCard>();
  for (const e of epics) for (const c of e.cards) for (const a of c.agents ?? []) if (a.needs_you) byTab.set(a.tab_id, a);
  return [...byTab.values()];
}
```

- [ ] **Step 4: Run** the test — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib
git commit -m "Web: progress types, API call and formatters"
```

---

### Task 9: Web — `ProgressPanel` and the "Progresso" project section

**Files:**
- Create: `apps/web/src/components/ProgressPanel.tsx`, `apps/web/src/components/ProgressPanel.test.tsx`
- Modify: `apps/web/src/pages/ProjectPage.tsx` (type `ProjectSection`, `SECTIONS`, render), `apps/web/src/pages/ProjectPage.test.tsx`

**Interfaces:**
- Consumes: `api.progress`, `lib/progress.ts` (Task 8), `useMonitor().tabState` (`lib/monitor.tsx`), `relativeTime` (`lib/time.ts`).
- Produces: `export function ProgressPanel({ projectId }: { projectId: string }): JSX.Element`; `export const PROGRESS_REFRESH_MS = 15_000`.

- [ ] **Step 1: Write the failing test** (`ProgressPanel.test.tsx`):

```tsx
// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProgressResponse, Tab } from '../lib/types';

const progressMock = vi.fn();
const live: Record<string, Tab | undefined> = {};
vi.mock('../lib/api', () => ({ api: { progress: (...a: unknown[]) => progressMock(...a) } }));
vi.mock('../lib/monitor', () => ({ useMonitor: () => ({ tabState: (id: string) => live[id] }) }));

import { PROGRESS_REFRESH_MS, ProgressPanel } from './ProgressPanel';

const response = (): ProgressResponse => ({
  generated_at: '2026-09-27T12:00:00.000Z',
  epics: [{
    id: 'e1', ref: 'TER-182', title: 'Visão gerencial', project: { id: 'p1', key: 'TER', name: 'termhub' },
    units: { done: 3, total: 6, backlog_total: 1 }, percent: 50,
    estimate: { kind: 'range', low_s: 1200, high_s: 2700, basis: 'agent_time', samples: 2 },
    cards_without_estimate: 1, agents: { working: 1, needs_you: 0, idle: 0 },
    cards: [{
      id: 'c1', ref: 'TER-183', title: 'Painel de progresso', type: 'story', status: 'doing', column_name: 'Fazendo',
      units: { done: 3, total: 5 }, percent: 60, started_at: null, done_at: null, active_seconds: 1800,
      estimate: { kind: 'range', low_s: 1200, high_s: 2700, basis: 'agent_time', samples: 3 },
      agents: [{ tab_id: 't1', tab_name: 'spec', machine_name: 'jarvis', subtask_ref: null, state: 'working', state_at: '2026-09-27T11:50:00.000Z', needs_you: false, activity: 'coding', activity_verb: 'Coding', rate_limited: false }],
    }],
  }],
});

function mount() {
  render(<MemoryRouter><ProgressPanel projectId="p1" /></MemoryRouter>);
}

beforeEach(() => {
  progressMock.mockResolvedValue(response());
  for (const k of Object.keys(live)) delete live[k];
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('ProgressPanel', () => {
  it('shows the epic and card progress, estimate and agent state', async () => {
    mount();
    expect(await screen.findByText('Visão gerencial')).toBeInTheDocument();
    expect(progressMock).toHaveBeenCalledWith({ project_id: 'p1', scope: 'active' });
    expect(screen.getByText('50%')).toBeInTheDocument();
    expect(screen.getByText('3/6 · backlog: 1')).toBeInTheDocument();
    expect(screen.getAllByText('~20–45 min de trabalho')).toHaveLength(2);
    expect(screen.getByText('1 cards sem estimativa')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /TER-183/ })).toHaveAttribute('href', '/project/TER-183');
    expect(screen.getByRole('link', { name: /spec.*trabalhando/ })).toHaveAttribute('href', '/projects/p1?tab=t1');
  });

  it('overlays the live monitor state and lists who is waiting for the user', async () => {
    live.t1 = { id: 't1', state: 'waiting_input', state_at: '2026-09-27T12:01:00.000Z', activity: null, activity_verb: null, rate_limited_at: null } as Tab;
    mount();
    expect(await screen.findByText('1 agente esperando você')).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: /spec.*esperando você/ })[0]).toHaveAttribute('href', '/projects/p1?tab=t1');
  });

  it('switches to every epic', async () => {
    mount();
    await screen.findByText('Visão gerencial');
    fireEvent.click(screen.getByRole('button', { name: 'Todos' }));
    await waitFor(() => expect(progressMock).toHaveBeenLastCalledWith({ project_id: 'p1', scope: 'all' }));
  });

  it('says so when nothing is running', async () => {
    progressMock.mockResolvedValue({ generated_at: '', epics: [] });
    mount();
    expect(await screen.findByText('Nenhum épico em andamento')).toBeInTheDocument();
  });

  it('refreshes every 15 s', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mount();
    await screen.findByText('Visão gerencial');
    await act(async () => {
      vi.advanceTimersByTime(PROGRESS_REFRESH_MS);
    });
    expect(progressMock).toHaveBeenCalledTimes(2);
  });

  it('shows the error when loading fails', async () => {
    progressMock.mockRejectedValue(new Error('boom'));
    mount();
    expect(await screen.findByText('Não foi possível carregar o progresso.')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run** `DOCKER 'npx -w @termhub/web vitest run src/components/ProgressPanel.test.tsx'` — Expected: FAIL, module not found.

- [ ] **Step 3: Implement** `ProgressPanel.tsx` (reuse the Tailwind idiom of `BacklogView.tsx`/`TasksBoard.tsx` for colours and spacing; the structure and copy below are fixed):

```tsx
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { useMonitor } from '../lib/monitor';
import { BASIS_LABEL, formatEstimate, needsYouAgents, stateLabel, withLiveTab } from '../lib/progress';
import { relativeTime } from '../lib/time';
import type { AgentOnCard, CardProgress, EpicProgress, ProgressEstimate, ProgressResponse, ProgressScope } from '../lib/types';

/** Percentages move at subtask pace; tab states come live from the monitor (spec D9). */
export const PROGRESS_REFRESH_MS = 15_000;

const STATE_DOT: Record<string, string> = {
  working: 'bg-emerald-500',
  waiting_input: 'bg-amber-500',
  waiting_permission: 'bg-amber-500',
  idle: 'bg-zinc-400',
  error: 'bg-red-500',
};

function Bar({ percent, label }: { percent: number; label: string }) {
  return (
    <div role="progressbar" aria-label={label} aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100} className="h-1.5 w-full rounded bg-zinc-200 dark:bg-zinc-800">
      <div className="h-1.5 rounded bg-indigo-500" style={{ width: `${percent}%` }} />
    </div>
  );
}

function EstimateLine({ estimate }: { estimate: ProgressEstimate }) {
  return (
    <span className="text-xs text-zinc-500">
      {formatEstimate(estimate)}
      {estimate.kind === 'range' && <span title={BASIS_LABEL[estimate.basis]}> · {BASIS_LABEL[estimate.basis]}</span>}
    </span>
  );
}

function AgentChip({ agent, projectId }: { agent: AgentOnCard; projectId: string }) {
  const since = agent.state_at ? ` · ${relativeTime(agent.state_at)}` : '';
  return (
    <Link
      to={`/projects/${projectId}?tab=${agent.tab_id}`}
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs ${agent.needs_you ? 'border-amber-500 bg-amber-50 dark:bg-amber-950' : 'border-zinc-300 dark:border-zinc-700'}`}
    >
      <span className={`h-2 w-2 rounded-full ${agent.state ? STATE_DOT[agent.state] : 'bg-zinc-300'}`} aria-hidden />
      <span>{agent.tab_name}</span>
      <span>
        {stateLabel(agent.state)}
        {agent.state === 'working' && agent.activity_verb ? ` (${agent.activity_verb})` : ''}
        {since}
      </span>
      {agent.subtask_ref && <span className="text-zinc-500">{agent.subtask_ref}</span>}
      {agent.rate_limited && <span className="text-red-600">limite de uso</span>}
    </Link>
  );
}

function CardRow({ card, projectId }: { card: CardProgress; projectId: string }) {
  return (
    <li className="space-y-1 py-2">
      <div className="flex items-baseline gap-2">
        <Link to={`/project/${card.ref}`} className="font-medium hover:underline">
          {card.ref} {card.title}
        </Link>
        <span className="text-xs text-zinc-500">{card.column_name ?? 'Backlog'}</span>
        <span className="ml-auto text-xs tabular-nums">
          {card.units.done}/{card.units.total} · {card.percent}%
        </span>
      </div>
      <Bar percent={card.percent} label={`${card.ref} ${card.percent}%`} />
      <EstimateLine estimate={card.estimate} />
      {card.agents && card.agents.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {card.agents.map((a) => (
            <AgentChip key={a.tab_id} agent={a} projectId={projectId} />
          ))}
        </div>
      )}
    </li>
  );
}

function EpicBlock({ epic, projectId }: { epic: EpicProgress; projectId: string }) {
  return (
    <section className="space-y-2 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
      <header className="flex items-baseline gap-2">
        <h2 className="text-base font-semibold">{epic.title}</h2>
        <span className="text-xs text-zinc-500">{epic.ref}</span>
        <span className="ml-auto text-lg font-semibold tabular-nums">{epic.percent}%</span>
      </header>
      <Bar percent={epic.percent} label={`${epic.ref} ${epic.percent}%`} />
      <div className="flex flex-wrap gap-3 text-xs text-zinc-500">
        <span>
          {epic.units.done}/{epic.units.total}
          {epic.units.backlog_total > 0 ? ` · backlog: ${epic.units.backlog_total}` : ''}
        </span>
        <EstimateLine estimate={epic.estimate} />
        {epic.cards_without_estimate > 0 && <span>{epic.cards_without_estimate} cards sem estimativa</span>}
        {epic.agents && (
          <span>
            {epic.agents.working} trabalhando · {epic.agents.needs_you} esperando você · {epic.agents.idle} parados
          </span>
        )}
      </div>
      <ul className="divide-y divide-zinc-100 dark:divide-zinc-900">
        {epic.cards.map((c) => (
          <CardRow key={c.id} card={c} projectId={projectId} />
        ))}
      </ul>
    </section>
  );
}

/** Project section "Progresso" (spec 2026-09-26 progress-panel §4.6). Read-only. */
export function ProgressPanel({ projectId }: { projectId: string }) {
  const [scope, setScope] = useState<ProgressScope>('active');
  const [data, setData] = useState<ProgressResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { tabState } = useMonitor();

  const load = useCallback(async () => {
    try {
      setData(await api.progress({ project_id: projectId, scope }));
      setError(null);
    } catch {
      setError('Não foi possível carregar o progresso.');
    }
  }, [projectId, scope]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, PROGRESS_REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  const epics = (data?.epics ?? []).map((e) => ({
    ...e,
    cards: e.cards.map((c) => ({ ...c, agents: c.agents?.map((a) => withLiveTab(a, tabState(a.tab_id))) ?? null })),
  }));
  const waiting = needsYouAgents(epics);

  return (
    <div className="space-y-4 p-4">
      <div className="flex items-center gap-2">
        <h1 className="text-lg font-semibold">Progresso</h1>
        <div className="ml-auto flex gap-1">
          {(['active', 'all'] as const).map((s) => (
            <button key={s} type="button" aria-pressed={scope === s} onClick={() => setScope(s)} className={`rounded px-2 py-1 text-sm ${scope === s ? 'bg-indigo-600 text-white' : 'border border-zinc-300 dark:border-zinc-700'}`}>
              {s === 'active' ? 'Só ativos' : 'Todos'}
            </button>
          ))}
        </div>
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
      {waiting.length > 0 && (
        <div className="rounded-lg border border-amber-500 bg-amber-50 p-3 dark:bg-amber-950">
          <p className="text-sm font-medium">{waiting.length === 1 ? '1 agente esperando você' : `${waiting.length} agentes esperando você`}</p>
          <div className="mt-2 flex flex-wrap gap-1">
            {waiting.map((a) => (
              <AgentChip key={a.tab_id} agent={a} projectId={projectId} />
            ))}
          </div>
        </div>
      )}
      {data && epics.length === 0 && <p className="text-sm text-zinc-500">Nenhum épico em andamento</p>}
      {epics.map((e) => (
        <EpicBlock key={e.id} epic={e} projectId={projectId} />
      ))}
    </div>
  );
}
```

(`relativeTime(iso, now?)` is the helper already in `lib/time.ts`.)

In `ProjectPage.tsx`: `ProjectSection` gains `'progress'`; `SECTIONS` gains `{ key: 'progress', label: 'Progresso', path: 'progress' }` right after Backlog; render `{current === 'progress' && <ProgressPanel key={`progress-${project.id}`} projectId={project.id} />}` next to the Backlog line; import it.

In `ProjectPage.test.tsx`, following the file's existing mocks for sibling sections, add `vi.mock('../components/ProgressPanel', () => ({ ProgressPanel: () => <div>progress-panel</div> }))` and a test: rendering the route `/projects/<id>/progress` shows `progress-panel`, and the section nav has a link named `Progresso`.

- [ ] **Step 4: Run** `DOCKER 'npx -w @termhub/web vitest run src/components/ProgressPanel.test.tsx src/pages/ProjectPage.test.tsx'` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/ProgressPanel.tsx apps/web/src/components/ProgressPanel.test.tsx apps/web/src/pages
git commit -m "Web: add the Progresso project section"
```

---

### Task 10: Phone — API client, contract aliases and mock route

**Files:**
- Modify: `apps/mobile/src/services/api/contract/local.ts` (type aliases), `apps/mobile/src/services/api/types.ts` (`MobileApi`), `apps/mobile/src/services/api/client.ts`, `apps/mobile/src/services/api/mock/transport.ts` (register)
- Create: `apps/mobile/src/services/api/mock/handlers/progress.ts`, `apps/mobile/src/services/api/mock/progress.e2e.test.ts`

**Interfaces:**
- Consumes: `progressResponse` (Task 3).
- Produces: `MobileApi.progress(auth: Auth, scope?: 'active' | 'all'): Promise<TProgressResponse>`; aliases `TProgressResponse`, `TEpicProgress`, `TCardProgress`, `TAgentOnCard`, `TProgressEstimate`; mock export `mockProgress(now: number): TProgressResponse` in `handlers/progress.ts`.

- [ ] **Step 1: Write the failing test** (`progress.e2e.test.ts`):

```ts
import { enrol, setupSession } from '../../../../test/helpers/enrolled-session';

beforeEach(() => jest.useFakeTimers());
afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

it('progress lists the active epics through the signed client', async () => {
  const ctx = setupSession();
  await enrol(ctx);
  const auth = ctx.store.getState().auth();
  const res = await ctx.api.progress(auth);
  expect(res.epics[0]).toMatchObject({ ref: 'TER-182', title: 'Visão gerencial' });
  expect(res.epics[0].cards[0].agents?.[0]).toMatchObject({ needs_you: true, state: 'waiting_input' });
});
```

(If the session store exposes `auth` differently, copy how `mock/chat.e2e.test.ts` obtains `auth` for `api.notifications`.)

- [ ] **Step 2: Run** `DOCKER 'npm test -w @termhub/mobile -- src/services/api/mock/progress.e2e.test.ts'` — Expected: FAIL, `ctx.api.progress is not a function`.

- [ ] **Step 3: Implement**

`local.ts`: import `progressResponse, epicProgress, cardProgress, agentOnCard, progressEstimate` and add

```ts
export type TProgressResponse = z.infer<typeof progressResponse>;
export type TEpicProgress = z.infer<typeof epicProgress>;
export type TCardProgress = z.infer<typeof cardProgress>;
export type TAgentOnCard = z.infer<typeof agentOnCard>;
export type TProgressEstimate = z.infer<typeof progressEstimate>;
```

`types.ts`, in `MobileApi` after `notifications`:

```ts
  // progress panel (spec 2026-09-26 progress-panel D10)
  progress(auth: Auth, scope?: 'active' | 'all'): Promise<TProgressResponse>;
```

`client.ts`, after `markRead` (import `progressResponse`):

```ts
    progress: (a: Auth, scope: 'active' | 'all' = 'active') => call('GET', `/api/m/v1/progress?scope=${scope}`, progressResponse, { token: a.accessToken }),
```

`mock/handlers/progress.ts`:

```ts
// The Progresso tab's route: one epic with a card whose agent waits for the user, so the screen
// and the store have every state to show against the mock transport.
import type { TProgressResponse } from '../../contract';
import type { MockRouter } from '../router';
import { type MockState, verifyAuth } from '../state';

export function mockProgress(now: number): TProgressResponse {
  const minutesAgo = (m: number) => new Date(now - m * 60_000).toISOString();
  return {
    generated_at: new Date(now).toISOString(),
    epics: [
      {
        id: 'e-182', ref: 'TER-182', title: 'Visão gerencial', project: { id: 'p-termhub', key: 'TER', name: 'termhub' },
        units: { done: 3, total: 6, backlog_total: 1 }, percent: 50,
        estimate: { kind: 'range', low_s: 1200, high_s: 2700, basis: 'agent_time', samples: 3 },
        cards_without_estimate: 0, agents: { working: 0, needs_you: 1, idle: 0 },
        cards: [
          {
            id: 'c-183', ref: 'TER-183', title: 'Painel de progresso', type: 'story', status: 'doing', column_name: 'Fazendo',
            units: { done: 3, total: 5 }, percent: 60, started_at: minutesAgo(90), done_at: null, active_seconds: 1800,
            estimate: { kind: 'range', low_s: 1200, high_s: 2700, basis: 'agent_time', samples: 3 },
            agents: [{ tab_id: 't-api', tab_name: 'api', machine_name: 'jarvis', subtask_ref: null, state: 'waiting_input', state_at: minutesAgo(12), needs_you: true, activity: null, activity_verb: null, rate_limited: false }],
          },
        ],
      },
    ],
  };
}

export function registerProgressRoutes(router: MockRouter, state: MockState): void {
  router.route('GET', '/api/m/v1/progress', (ctx) => {
    verifyAuth(state, { headers: ctx.headers, htm: 'GET', htu: ctx.htu, now: ctx.now() });
    return { status: 200, body: mockProgress(ctx.now()) };
  });
}
```

Register it in `mock/transport.ts` next to `registerNotificationRoutes(...)`.

- [ ] **Step 4: Run** the test and `DOCKER 'npm run typecheck -w @termhub/mobile'` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/src/services/api
git commit -m "App: progress API call and mock route"
```

---

### Task 11: Phone — formatters and progress store

**Files:**
- Create: `apps/mobile/src/features/progress/model/format.ts`, `apps/mobile/src/features/progress/model/format.test.ts`, `apps/mobile/src/features/progress/viewmodel/createProgressStore.ts`, `apps/mobile/src/features/progress/viewmodel/createProgressStore.test.ts`, `apps/mobile/src/features/progress/viewmodel/useProgressStore.ts`

**Interfaces:**
- Consumes: `MobileApi.progress` (Task 10), `SessionApi` shape of the notifications store (`auth()`, `handleApiError(err)`).
- Produces: `formatDuration`, `formatEstimate`, `stateLabel` (same behaviour and copy as the web's, Task 8); `PROGRESS_POLL_MS = 20_000`; `createProgressStore(deps: { api: MobileApi; session: () => SessionApi }): UseBoundStore<StoreApi<ProgressState>>` with `ProgressState { epics: TEpicProgress[]; loading: boolean; error: string | null; load(): Promise<void>; startPolling(): void; stopPolling(): void }`; `useProgressStore` singleton.

- [ ] **Step 1: Write the failing tests**

`format.test.ts` — the same cases as the web's `formatDuration`/`formatEstimate`/`stateLabel` tests of Task 8, with jest globals:

```ts
import { formatDuration, formatEstimate, stateLabel } from './format';

it('formats durations', () => {
  expect(formatDuration(1200)).toBe('20 min');
  expect(formatDuration(3600)).toBe('1 h');
  expect(formatDuration(9000)).toBe('2,5 h');
});
it('formats estimates', () => {
  expect(formatEstimate({ kind: 'range', low_s: 1200, high_s: 2700, basis: 'agent_time', samples: 2 })).toBe('~20–45 min de trabalho');
  expect(formatEstimate({ kind: 'range', low_s: 2700, high_s: 5400, basis: 'wall_clock', samples: 2 })).toBe('~45 min–1,5 h de trabalho');
  expect(formatEstimate({ kind: 'range', low_s: 300, high_s: 300, basis: 'wall_clock', samples: 2 })).toBe('~5 min de trabalho');
  expect(formatEstimate({ kind: 'none', reason: 'not_started' })).toBe('ainda não começou');
  expect(formatEstimate({ kind: 'none', reason: 'few_samples' })).toBe('estimativa após 2 subtarefas');
  expect(formatEstimate({ kind: 'done' })).toBe('concluído');
});
it('names states', () => {
  expect(stateLabel('waiting_input')).toBe('esperando você');
  expect(stateLabel(null)).toBe('sem sinal');
});
```

`createProgressStore.test.ts`:

```ts
import { mmkv } from '@/services/storage';
import { enrol, setupSession } from '../../../../test/helpers/enrolled-session';
import { createProgressStore, PROGRESS_POLL_MS } from './createProgressStore';

/** `ctx.store` is the session store; the store under test is `progress`. */
async function setup(handleApiError?: (err: unknown) => boolean) {
  const ctx = setupSession();
  await enrol(ctx);
  const session = () => {
    const s = ctx.store.getState();
    return handleApiError ? { auth: () => s.auth(), handleApiError } : s;
  };
  const progress = createProgressStore({ api: ctx.api, session });
  return { ...ctx, progress };
}

beforeEach(() => {
  jest.useFakeTimers();
  mmkv.clearAll();
});
afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

it('load() fills the epics', async () => {
  const { progress } = await setup();
  await progress.getState().load();
  expect(progress.getState().epics[0].ref).toBe('TER-182');
  expect(progress.getState().error).toBeNull();
});

it('polls every 20 s while started, and stops', async () => {
  const { progress, api } = await setup();
  const spy = jest.spyOn(api, 'progress');
  progress.getState().startPolling();
  await jest.advanceTimersByTimeAsync(PROGRESS_POLL_MS * 2);
  expect(spy).toHaveBeenCalledTimes(3); // immediate + two ticks
  progress.getState().stopPolling();
  await jest.advanceTimersByTimeAsync(PROGRESS_POLL_MS * 2);
  expect(spy).toHaveBeenCalledTimes(3);
});

it('keeps the last epics and shows an error when a refresh fails', async () => {
  const { progress, api } = await setup();
  await progress.getState().load();
  jest.spyOn(api, 'progress').mockRejectedValueOnce(new Error('offline'));
  await progress.getState().load();
  expect(progress.getState().epics).toHaveLength(1);
  expect(progress.getState().error).toBe('Não foi possível carregar o progresso.');
});

it('leaves session-ending errors to the session store and stops polling', async () => {
  const handled = jest.fn(() => true);
  const { progress, api } = await setup(handled);
  const spy = jest.spyOn(api, 'progress').mockRejectedValue(new Error('revoked'));
  progress.getState().startPolling();
  await jest.advanceTimersByTimeAsync(PROGRESS_POLL_MS * 2);
  expect(handled).toHaveBeenCalled();
  expect(progress.getState().error).toBeNull();
  expect(spy).toHaveBeenCalledTimes(1); // polling stopped after the first refusal
});
```

- [ ] **Step 2: Run** `DOCKER 'npm test -w @termhub/mobile -- src/features/progress'` — Expected: FAIL, modules not found.

- [ ] **Step 3: Implement**

`model/format.ts` — copy the bodies of `formatDuration`, `formatEstimate`, `stateLabel` from the web's `lib/progress.ts` (Task 8), typed with `TProgressEstimate` and `TAgentOnCard['state']`, with a header comment: `// Same wording as the web's lib/progress.ts (spec 2026-09-26 progress-panel §4.6): keep both in sync.`

`viewmodel/createProgressStore.ts`:

```ts
// The Progresso tab's store (spec 2026-09-26 progress-panel D10): the active epics across the
// user's projects, polled while the tab is focused. Same factory shape as the notifications store.
import { create } from 'zustand';
import type { TEpicProgress } from '@/services/api/contract';
import type { Auth, MobileApi } from '@/services/api/types';

export const PROGRESS_POLL_MS = 20_000;
const LOAD_FAILED = 'Não foi possível carregar o progresso.';

export interface SessionApi {
  auth(): Auth;
  handleApiError(err: unknown): boolean;
}

export interface ProgressState {
  epics: TEpicProgress[];
  loading: boolean;
  error: string | null;
  load(): Promise<void>;
  startPolling(): void;
  stopPolling(): void;
}

export function createProgressStore(deps: { api: MobileApi; session: () => SessionApi }) {
  let timer: ReturnType<typeof setInterval> | null = null;
  const store = create<ProgressState>()((set, get) => ({
    epics: [],
    loading: false,
    error: null,
    async load() {
      set({ loading: true });
      try {
        const res = await deps.api.progress(deps.session().auth(), 'active');
        set({ epics: res.epics, loading: false, error: null });
      } catch (err) {
        if (deps.session().handleApiError(err)) {
          get().stopPolling();
          set({ loading: false });
          return;
        }
        set({ loading: false, error: LOAD_FAILED });
      }
    },
    startPolling() {
      get().stopPolling();
      void get().load();
      timer = setInterval(() => void get().load(), PROGRESS_POLL_MS);
    },
    stopPolling() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  }));
  return store;
}
```

`viewmodel/useProgressStore.ts`:

```ts
// The app's one progress store, over the real API singleton and the session store.
import { api } from '@/services/api';
import { useSessionStore } from '@/features/session/viewmodel/useSessionStore';
import { createProgressStore } from './createProgressStore';

export const useProgressStore = createProgressStore({ api, session: () => useSessionStore.getState() });
```

- [ ] **Step 4: Run** the tests — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/src/features/progress
git commit -m "App: progress formatters and polling store"
```

---

### Task 12: Phone — "Progresso" tab and screen

**Files:**
- Create: `apps/mobile/src/features/progress/view/progress-screen.tsx`, `apps/mobile/src/features/progress/view/progress-screen.test.tsx`, `apps/mobile/app/(tabs)/progress.tsx`
- Modify: `apps/mobile/app/(tabs)/_layout.tsx`, `apps/mobile/test/helpers/ui-stores.ts` (add `progress` store built over the same mock API as the others)

**Interfaces:**
- Consumes: `useProgressStore` (Task 11), formatters (Task 11), `relativeTime(iso, now)` (`features/shared/relative-time.ts`).
- Produces: `export function ProgressScreen(): JSX.Element`.

- [ ] **Step 1: Write the failing test** (`progress-screen.test.tsx`), following `notifications-screen.test.tsx`'s mocks:

```tsx
import { fireEvent, render, screen } from '@testing-library/react-native';

jest.mock('@/features/session/viewmodel/useSessionStore', () => ({ useSessionStore: require('../../../../test/helpers/ui-stores').stores.store }));
jest.mock('@/features/progress/viewmodel/useProgressStore', () => ({ useProgressStore: require('../../../../test/helpers/ui-stores').stores.progress }));
jest.mock('expo-router', () => ({
  useFocusEffect: (cb: () => void | (() => void)) => {
    require('react').useEffect(cb, [cb]);
  },
}));

import { useProgressStore } from '@/features/progress/viewmodel/useProgressStore';
import { enrolStores, stores } from '../../../../test/helpers/ui-stores';
import { ProgressScreen } from './progress-screen';

const LOAD = { timeout: 15_000 };

beforeAll(async () => {
  await enrolStores();
});
beforeEach(() => {
  useProgressStore.setState({ epics: [], loading: false, error: null });
});
afterEach(() => {
  useProgressStore.getState().stopPolling();
  jest.restoreAllMocks();
});

describe('Progresso', () => {
  it('loads on focus and shows the epic, its percent and who waits for the user', async () => {
    const load = jest.spyOn(stores.api, 'progress');
    await render(<ProgressScreen />);
    expect(load).toHaveBeenCalled();
    expect(await screen.findByText('Visão gerencial', {}, LOAD)).toBeTruthy();
    expect(screen.getByText('50%')).toBeTruthy();
    expect(screen.getByText('1 agente esperando você')).toBeTruthy();
  });

  it('expands an epic to its cards and agents', async () => {
    await render(<ProgressScreen />);
    fireEvent.press(await screen.findByText('Visão gerencial', {}, LOAD));
    expect(screen.getByText('TER-183 Painel de progresso')).toBeTruthy();
    expect(screen.getByText(/api · esperando você/)).toBeTruthy();
    expect(screen.getAllByText('~20–45 min de trabalho').length).toBeGreaterThan(0);
  });

  it('shows the empty state', async () => {
    jest.spyOn(stores.api, 'progress').mockResolvedValue({ epics: [], generated_at: '' });
    await render(<ProgressScreen />);
    expect(await screen.findByText('Nenhum épico em andamento', {}, LOAD)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run** `DOCKER 'npm test -w @termhub/mobile -- src/features/progress/view'` — Expected: FAIL, module not found (and `stores.progress` undefined until `ui-stores.ts` builds it: `progress: createProgressStore({ api, session: () => store.getState() })`, mirroring how it builds `notifications`).

- [ ] **Step 3: Implement** `progress-screen.tsx` (NativeWind classes in the style of `notifications-screen.tsx`; structure and copy fixed):

```tsx
import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { FlatList, Pressable, RefreshControl, Text, View } from 'react-native';
import { relativeTime } from '@/features/shared/relative-time';
import type { TAgentOnCard, TEpicProgress } from '@/services/api/contract';
import { formatEstimate, stateLabel } from '../model/format';
import { useProgressStore } from '../viewmodel/useProgressStore';

function Bar({ percent }: { percent: number }) {
  return (
    <View className="h-1.5 w-full rounded bg-zinc-800">
      <View className="h-1.5 rounded bg-indigo-400" style={{ width: `${percent}%` }} />
    </View>
  );
}

function Agent({ agent }: { agent: TAgentOnCard }) {
  const since = agent.state_at ? ` · ${relativeTime(agent.state_at, Date.now())}` : '';
  return (
    <Text className={agent.needs_you ? 'text-xs text-amber-400' : 'text-xs text-zinc-400'}>
      {`${agent.tab_name} · ${stateLabel(agent.state)}${since} · ${agent.machine_name}`}
    </Text>
  );
}

function Epic({ epic }: { epic: TEpicProgress }) {
  const [open, setOpen] = useState(false);
  const waiting = epic.agents?.needs_you ?? 0;
  return (
    <View className="mx-4 my-2 rounded-xl bg-zinc-900 p-4">
      <Pressable onPress={() => setOpen((v) => !v)} accessibilityRole="button">
        <View className="flex-row items-baseline justify-between">
          <Text className="flex-1 text-base font-semibold text-white">{epic.title}</Text>
          <Text className="text-lg font-semibold text-white">{`${epic.percent}%`}</Text>
        </View>
        <Text className="text-xs text-zinc-500">{`${epic.project.name} · ${epic.ref}`}</Text>
        <View className="my-2">
          <Bar percent={epic.percent} />
        </View>
        <Text className="text-xs text-zinc-400">{formatEstimate(epic.estimate)}</Text>
        {waiting > 0 && <Text className="text-xs text-amber-400">{waiting === 1 ? '1 agente esperando você' : `${waiting} agentes esperando você`}</Text>}
      </Pressable>
      {open &&
        epic.cards.map((c) => (
          <View key={c.id} className="mt-3 gap-1">
            <Text className="text-sm text-white">{`${c.ref} ${c.title}`}</Text>
            <Bar percent={c.percent} />
            <Text className="text-xs text-zinc-400">{`${c.units.done}/${c.units.total} · ${formatEstimate(c.estimate)}`}</Text>
            {c.agents?.map((a) => <Agent key={a.tab_id} agent={a} />)}
          </View>
        ))}
    </View>
  );
}

/** The Progresso tab (spec 2026-09-26 progress-panel D10): active epics across projects, read-only. */
export function ProgressScreen() {
  const epics = useProgressStore((s) => s.epics);
  const loading = useProgressStore((s) => s.loading);
  const error = useProgressStore((s) => s.error);
  useFocusEffect(
    useCallback(() => {
      useProgressStore.getState().startPolling();
      return () => useProgressStore.getState().stopPolling();
    }, []),
  );
  return (
    <FlatList
      className="flex-1 bg-[#0B0E17]"
      data={epics}
      keyExtractor={(e) => e.id}
      renderItem={({ item }) => <Epic epic={item} />}
      refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void useProgressStore.getState().load()} />}
      ListHeaderComponent={error ? <Text className="px-4 pt-4 text-sm text-red-400">{error}</Text> : null}
      ListEmptyComponent={!loading ? <Text className="px-4 pt-8 text-center text-sm text-zinc-500">Nenhum épico em andamento</Text> : null}
    />
  );
}
```

`app/(tabs)/progress.tsx`: `export { ProgressScreen as default } from '@/features/progress/view/progress-screen';`

`_layout.tsx`: between Notificações and Ajustes:

```tsx
      <Tabs.Screen name="progress" options={{ title: 'Progresso', tabBarIcon: tabIcon('chart.bar', 'chart.bar.fill', 'bar_chart') }} />
```

and update the comment above `TabsLayout` to "The four tabs…".

- [ ] **Step 4: Run** the tests and `DOCKER 'npm run typecheck -w @termhub/mobile && npm test -w @termhub/mobile'` — Expected: PASS (whole app suite, the layout change included).

- [ ] **Step 5: Commit**

```bash
git add apps/mobile
git commit -m "App: add the Progresso tab"
```

---

### Task 13: Full verification

**Files:** none new (fixes only if something fails).

- [ ] **Step 1: Server, web, app, contract suites**

Run: `DOCKER 'npm test -w @termhub/server && npm test -w @termhub/web && npm test -w @termhub/mobile && npx -w @termhub/mobile-api vitest run'`
Expected: all PASS (DB tests included: `TERMHUB_DB_TESTS=1` is in the prefix).

- [ ] **Step 2: The CLAUDE.md gate and the drift check**

Run: `DOCKER 'npm run typecheck -w @termhub/server && npm run build -w @termhub/web && npm run build -w @termhub/landing && npm run typecheck -w @termhub/mobile && cd apps/server && npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code'`
Expected: exit 0.

- [ ] **Step 3: Backward compatibility of the migration** — on the throwaway DB, confirm the previous release's writes still work: `docker exec th-ter183-db psql -U postgres termhub -c "INSERT INTO tasks (id, project_id, title, status, type) SELECT 'compat1', id, 'x', 'done', 'task' FROM projects LIMIT 1 RETURNING done_at IS NOT NULL AS stamped, active_seconds;"` → `stamped = t`, `active_seconds = 0`; then delete the row.

- [ ] **Step 4: Clean up and commit fixes if any**

```bash
rm -rf .npm
git status --short   # only intended files
```

Leave `th-ter183-db` / `th-ter183-net` running only if phase 2 follows right away; otherwise `docker rm -f th-ter183-db && docker network rm th-ter183-net`.

- [ ] **Step 5: Hand-off note** — tell the user what to verify by hand after merge: open `/projects/<id>/progress` on the web while an agent works a card (state chip changes live, % moves when a subtask is ticked), and the Progresso tab on the phone (needs an app build: the tab is new UI).
