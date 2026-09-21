# Office World Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `/office`: a live isometric view of one machine's floor — projects as rooms, tabs as people — with a camera between floor and room, kanban progress, focus mode, and the spike removed.

**Architecture:** One server read endpoint returns the floor snapshot (projects, tabs with `alive`, kanban progress). In the browser, pure functions turn snapshot + live monitor state into a scene model and a generated layout; a small PixiJS scene draws that model and nothing else knows PixiJS. Art comes from a pack (manifest + textures); v1's pack is painted at runtime by code.

**Tech Stack:** Fastify + Prisma + zod (server), React 18 + react-router 7 + Vite + Tailwind + PixiJS 8 (web), Vitest.

**Spec:** `docs/superpowers/specs/2026-09-21-office-world-design.md`

## Global Constraints

- Code, comments, commit messages and docs in English; **UI copy in Portuguese (pt-BR)**.
- The host has no Node. Run everything through Docker from the repo root:
  `docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/w" -w /w node:20 sh -c '<cmd>'`, then `rm -rf .npm`. Below, `DOCKER '<cmd>'` means exactly that.
- After a fresh `npm ci`, the server typecheck needs `npm run prisma:generate && npm run build:packages` first.
- Address workspaces by package name (`-w @termhub/server`, `-w @termhub/web`), never by path.
- Routes never import Prisma; go through `apps/server/src/db/repositories`. Every request input is validated with zod. Load machines through `scoped(repos, request).machine(id)`. Register route plugins with `guarded(resource, plugin, prefix)` in `apps/server/src/app.ts`. Never check roles by name.
- No schema change and no migration in this plan.
- Terminal content is never sent or logged. The only text in the snapshot is names and task titles.
- PixiJS is imported only under `apps/web/src/office/scene/` and `apps/web/src/office/pack/`, and the page is `lazy()`: the main bundle must not grow.
- Progress is drawn only from a real `doing` task bound to the tab. Otherwise nothing is drawn.
- Work on branch `feat/office-world`, created from `origin/main`. Do not push to `main`; open a PR at the end.

## Review Focus

1. **A project with zero tabs, and a machine with zero projects** — the floor must still render (an empty lit room; an empty-state message), never a blank canvas or a NaN camera. Pinned in Task 3 (`layoutFloor([])`, `layoutRoom(0)`) and Task 6 (`frame` on an empty bounds).
2. **Machine unreachable when the snapshot is built** — `listTmuxSessions` throws; the endpoint must answer 200 with `reachable: false` and every terminal tab `alive: false`, not 500. Pinned in Task 2.
3. **A user without `tasks:read`** — the snapshot must carry `progress: null` and `tasks: null`, and the task repository must not even be queried. Pinned in Task 2.
4. **A monitor push for a tab the snapshot does not have, or a snapshot tab the monitor never saw** — the first triggers a snapshot re-read (no crash, no ghost desk); the second is a desk with `state: null`. Pinned in Task 4 (`buildModel`) and Task 8 (`missingFromSnapshot`).
5. **Long and odd names** (120-char project name, emoji, RTL) — labels are truncated with an ellipsis at a fixed width and never resize a room. Pinned in Task 4 (`truncateLabel`).

---

## File Structure

```
apps/server/src/db/repositories/tabs.ts        + listByProjects()
apps/server/src/db/repositories/tasks.ts       + officeProgress()
apps/server/src/office/snapshot.ts             pure: rows -> OfficeSnapshot
apps/server/src/office/snapshot.test.ts
apps/server/src/routes/office.ts               GET /api/office/:machineId
apps/server/src/routes/office.test.ts
apps/server/src/app.ts                         register the route

apps/web/src/lib/types.ts                      + Office* types
apps/web/src/lib/api.ts                        + api.office()
apps/web/src/office/layout/iso.ts              moved from office/iso.ts (spike)
apps/web/src/office/layout/iso.test.ts         moved
apps/web/src/office/layout/floor.ts            shelf packing
apps/web/src/office/layout/floor.test.ts
apps/web/src/office/model.ts                   snapshot + monitor -> FloorModel
apps/web/src/office/model.test.ts
apps/web/src/office/pack/manifest.ts           the sprite contract (types + validate)
apps/web/src/office/pack/manifest.test.ts
apps/web/src/office/pack/generated.ts          v1 pack, painted at runtime
apps/web/src/office/scene/camera.ts            pure camera math + Camera
apps/web/src/office/scene/camera.test.ts
apps/web/src/office/scene/PersonView.ts
apps/web/src/office/scene/RoomView.ts
apps/web/src/office/scene/Overlay.ts
apps/web/src/office/scene/OfficeScene.ts
apps/web/src/office/harness.ts                 rewritten over the new scene (dev tool)
apps/web/spike-office.html -> apps/web/office-harness.html
apps/web/src/office/useOfficeSnapshot.ts
apps/web/src/lib/focus.tsx                     focus-mode context
apps/web/src/pages/OfficePage.tsx
apps/web/src/App.tsx, components/Layout.tsx, components/Sidebar.tsx
deleted: apps/web/src/office/OfficeScene.ts (spike), apps/web/src/pages/OfficeSpikePage.tsx
```

---

### Task 1: Repository reads for the office snapshot

**Files:**
- Modify: `apps/server/src/db/repositories/tabs.ts` (add after `listByProject`)
- Modify: `apps/server/src/db/repositories/tasks.ts` (add after `listDoing`)
- Modify: `apps/server/src/db/repositories/types.ts` (add types at the end of the task types)
- Test: `apps/server/src/db/repositories/tasks.db.test.ts`, `apps/server/src/db/repositories/tabs.db.test.ts`

**Interfaces:**
- Produces:
  - `TabsRepository.listByProjects(projectIds: string[]): Promise<Tab[]>` — ordered by position then creation.
  - `TasksRepository.officeProgress(projectIds: string[]): Promise<OfficeProgress>`
  - `interface OfficeTaskCounts { todo: number; doing: number; done: number }`
  - `interface OfficeTabProgress { task_id: string; title: string; done: number; total: number }`
  - `interface OfficeProgress { counts: Record<string, OfficeTaskCounts>; byTab: Record<string, OfficeTabProgress> }`

- [ ] **Step 1: Add the types** to `apps/server/src/db/repositories/types.ts`, right after `TaskWithSubtasks`:

```ts
/** Board columns that count as "the project's work" on the office floor; the backlog does not. */
export interface OfficeTaskCounts {
  todo: number;
  doing: number;
  done: number;
}

/** The `doing` task bound to a tab. `total = 0` means it has no subtasks: a title, no bar. */
export interface OfficeTabProgress {
  task_id: string;
  title: string;
  done: number;
  total: number;
}

export interface OfficeProgress {
  /** by project id; a project with no todo/doing/done task has no entry */
  counts: Record<string, OfficeTaskCounts>;
  /** by tab id */
  byTab: Record<string, OfficeTabProgress>;
}
```

- [ ] **Step 2: Write the failing DB tests.** Append to `apps/server/src/db/repositories/tasks.db.test.ts` (it already builds `db`, a `TasksRepository` named `repo`, a machine and a project in `beforeEach`; reuse its `projectId` and create the tab inline):

```ts
describe.skipIf(process.env.TERMHUB_DB_TESTS !== '1')('TasksRepository.officeProgress (Postgres)', () => {
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
    await db.tab.create({ data: { id: tabId, projectId, name: 't', tmuxSession: `th-${tabId}` } });
    const doing = await repo.create(projectId, { title: 'Ship it', status: 'doing' });
    await repo.setTab(doing.id, tabId);
    const subs = await repo.createSubtasks(doing.id, [{ title: 's1' }, { title: 's2' }, { title: 's3' }]);
    await repo.update(subs[0].id, { status: 'done' });
    const { byTab } = await repo.officeProgress([projectId]);
    expect(byTab[tabId]).toEqual({ task_id: doing.id, title: 'Ship it', done: 1, total: 3 });
  });

  it('ignores a bound task that is not in doing, and picks the first by position when two are', async () => {
    const tabId = newId();
    await db.tab.create({ data: { id: tabId, projectId, name: 't', tmuxSession: `th-${tabId}` } });
    const todo = await repo.create(projectId, { title: 'later', status: 'todo' });
    await repo.setTab(todo.id, tabId);
    expect((await repo.officeProgress([projectId])).byTab[tabId]).toBeUndefined();
    const first = await repo.create(projectId, { title: 'first', status: 'doing' });
    const second = await repo.create(projectId, { title: 'second', status: 'doing' });
    await repo.setTab(first.id, tabId);
    await repo.setTab(second.id, tabId);
    expect((await repo.officeProgress([projectId])).byTab[tabId].title).toBe('first');
  });

  it('answers empty for no projects without touching the database', async () => {
    expect(await repo.officeProgress([])).toEqual({ counts: {}, byTab: {} });
  });
});
```

If `newId` or `db` are not already imported/visible at that scope in the file, import `newId` from `'../../lib/ids.js'` and reuse the file's existing `db` variable (move the new `describe` inside the file's outer `describe` if `db`/`repo`/`projectId` are scoped there).

Append to `apps/server/src/db/repositories/tabs.db.test.ts`, inside its existing `describe`:

```ts
  it('listByProjects returns the tabs of the given projects in tab-bar order, and nothing for none', async () => {
    const second = newId();
    await db.tab.create({ data: { id: second, projectId, name: 'second', position: 1, tmuxSession: `th-${second}` } });
    expect((await repo.listByProjects([projectId])).map((t) => t.id)).toEqual([tabId, second]);
    expect(await repo.listByProjects([])).toEqual([]);
  });
```

- [ ] **Step 3: Run them to see them fail.** They need Postgres:

```bash
docker run -d --rm --name office-pg -e POSTGRES_PASSWORD=pw -e POSTGRES_DB=termhub_test -p 127.0.0.1:55432:5432 postgres:16
docker run --rm --network host -u "$(id -u):$(id -g)" -e HOME=/tmp -e TERMHUB_DB_TESTS=1 \
  -e DATABASE_URL=postgresql://postgres:pw@127.0.0.1:55432/termhub_test -v "$PWD:/w" -w /w node:20 sh -c \
  'npm run prisma:generate >/dev/null && (cd apps/server && npx prisma migrate deploy >/dev/null) && npx -w @termhub/server vitest run src/db/repositories/tasks.db.test.ts src/db/repositories/tabs.db.test.ts'
```

Expected: FAIL — `repo.officeProgress is not a function`, `repo.listByProjects is not a function`.

- [ ] **Step 4: Implement.** In `apps/server/src/db/repositories/tabs.ts`, after `listByProject`:

```ts
  /** Every tab of the given projects, in tab-bar order within each project (the office floor). */
  async listByProjects(projectIds: string[]): Promise<Tab[]> {
    if (projectIds.length === 0) return [];
    const rows = await this.db.tab.findMany({ where: { projectId: { in: projectIds } }, orderBy: [{ position: 'asc' }, { createdAt: 'asc' }] });
    return rows.map(mapTab);
  }
```

In `apps/server/src/db/repositories/tasks.ts`, after `listDoing` (add `OfficeProgress` to the file's type import from `./types.js`):

```ts
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
```

- [ ] **Step 5: Run the tests again** (same command as Step 3). Expected: PASS. Then `docker rm -f office-pg` and `rm -rf .npm`.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/db/repositories
git commit -m "Office: repository reads for the floor snapshot"
```

---

### Task 2: `GET /api/office/:machineId`

**Files:**
- Create: `apps/server/src/office/snapshot.ts`, `apps/server/src/office/snapshot.test.ts`
- Create: `apps/server/src/routes/office.ts`, `apps/server/src/routes/office.test.ts`
- Modify: `apps/server/src/app.ts` (next to the `dashboardRoutes` registration, ~line 143)

**Interfaces:**
- Consumes: `TabsRepository.listByProjects`, `TasksRepository.officeProgress`, `OfficeProgress`, `OfficeTaskCounts`, `OfficeTabProgress` (Task 1); `scoped(repos, request).machine(id)`; `canAccess(repos, user, resource, action)` from `../auth/permissions.js`; `listTmuxSessions(machine): Promise<Set<string>>` from `../terminal/machine-exec.js`; `SimulatorSessionManager.isReady(machineId, udid)`.
- Produces: `GET /api/office/:machineId` → `OfficeSnapshot`:

```ts
interface OfficeTab extends Tab { alive: boolean; progress: OfficeTabProgress | null }
interface OfficeRoom { project: Project; tabs: OfficeTab[]; tasks: OfficeTaskCounts | null }
interface OfficeSnapshot { machine: Machine; reachable: boolean; rooms: OfficeRoom[] }
```

- [ ] **Step 1: Write the failing test for the pure builder**, `apps/server/src/office/snapshot.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { Machine, Project, Tab } from '../db/repositories/types.js';
import { buildOfficeSnapshot } from './snapshot.js';

const machine = { id: 'm1', name: 'jarvis' } as Machine;
const project = (id: string, over: Partial<Project> = {}): Project => ({ id, machine_id: 'm1', name: id, status: 'active', ...over }) as Project;
const tab = (id: string, projectId: string, over: Partial<Tab> = {}): Tab =>
  ({ id, project_id: projectId, name: id, kind: 'terminal', tmux_session: `th-${id}`, simulator_udid: null, position: 0, state: null, ...over }) as Tab;

describe('buildOfficeSnapshot', () => {
  it('groups tabs into their project rooms, drops archived projects and keeps empty rooms', () => {
    const snap = buildOfficeSnapshot({
      machine,
      projects: [project('b'), project('a'), project('z', { status: 'archived' })],
      tabs: [tab('t1', 'a'), tab('t2', 'a'), tab('t9', 'z')],
      aliveSessions: new Set(['th-t1']),
      reachable: true,
      simulatorReady: () => false,
      progress: null,
    });
    expect(snap.rooms.map((r) => r.project.id)).toEqual(['b', 'a']);
    expect(snap.rooms[1].tabs.map((t) => [t.id, t.alive])).toEqual([['t1', true], ['t2', false]]);
    expect(snap.rooms[0].tabs).toEqual([]);
  });

  it('marks every terminal tab dead when the machine was unreachable', () => {
    const snap = buildOfficeSnapshot({ machine, projects: [project('a')], tabs: [tab('t1', 'a')], aliveSessions: new Set(), reachable: false, simulatorReady: () => true, progress: null });
    expect(snap.reachable).toBe(false);
    expect(snap.rooms[0].tabs[0].alive).toBe(false);
  });

  it('asks the simulator manager for simulator tabs', () => {
    const sim = tab('s1', 'a', { kind: 'simulator', tmux_session: null, simulator_udid: 'UDID' });
    const snap = buildOfficeSnapshot({ machine, projects: [project('a')], tabs: [sim], aliveSessions: new Set(), reachable: true, simulatorReady: (udid) => udid === 'UDID', progress: null });
    expect(snap.rooms[0].tabs[0].alive).toBe(true);
  });

  it('carries progress when given and nulls when the person cannot read tasks', () => {
    const progress = { counts: { a: { todo: 1, doing: 1, done: 2 } }, byTab: { t1: { task_id: 'k', title: 'Ship', done: 1, total: 3 } } };
    const base = { machine, projects: [project('a'), project('b')], tabs: [tab('t1', 'a')], aliveSessions: new Set<string>(), reachable: true, simulatorReady: () => false };
    const withTasks = buildOfficeSnapshot({ ...base, progress });
    expect(withTasks.rooms[0].tasks).toEqual({ todo: 1, doing: 1, done: 2 });
    expect(withTasks.rooms[0].tabs[0].progress).toEqual({ task_id: 'k', title: 'Ship', done: 1, total: 3 });
    expect(withTasks.rooms[1].tasks).toEqual({ todo: 0, doing: 0, done: 0 });
    const without = buildOfficeSnapshot({ ...base, progress: null });
    expect(without.rooms[0].tasks).toBeNull();
    expect(without.rooms[0].tabs[0].progress).toBeNull();
  });
});
```

- [ ] **Step 2: Run it.** `DOCKER 'npx -w @termhub/server vitest run src/office/snapshot.test.ts'` — Expected: FAIL, cannot find `./snapshot.js`.

- [ ] **Step 3: Implement** `apps/server/src/office/snapshot.ts`:

```ts
import type { Machine, OfficeProgress, OfficeTabProgress, OfficeTaskCounts, Project, Tab } from '../db/repositories/types.js';

export interface OfficeTab extends Tab {
  alive: boolean;
  progress: OfficeTabProgress | null;
}

export interface OfficeRoom {
  project: Project;
  tabs: OfficeTab[];
  /** null = the person cannot read tasks */
  tasks: OfficeTaskCounts | null;
}

export interface OfficeSnapshot {
  machine: Machine;
  /** false = the machine could not be asked which tmux sessions exist; every terminal tab reads as not alive */
  reachable: boolean;
  rooms: OfficeRoom[];
}

/**
 * The floor of one machine: a room per non-archived project (in the order given — the repository
 * sorts by name, like the sidebar), its tabs, and the board's progress when the person may see it.
 * Pure: the route does the loading. Only names and task titles travel, never terminal content.
 */
export function buildOfficeSnapshot(input: {
  machine: Machine;
  projects: Project[];
  tabs: Tab[];
  aliveSessions: Set<string>;
  reachable: boolean;
  simulatorReady: (udid: string) => boolean;
  progress: OfficeProgress | null;
}): OfficeSnapshot {
  const tabsByProject = new Map<string, Tab[]>();
  for (const t of input.tabs) tabsByProject.set(t.project_id, [...(tabsByProject.get(t.project_id) ?? []), t]);
  const rooms = input.projects
    .filter((p) => p.status !== 'archived')
    .map((project) => ({
      project,
      tasks: input.progress ? (input.progress.counts[project.id] ?? { todo: 0, doing: 0, done: 0 }) : null,
      tabs: (tabsByProject.get(project.id) ?? []).map((t) => ({
        ...t,
        alive: t.kind === 'simulator' ? !!t.simulator_udid && input.simulatorReady(t.simulator_udid) : input.reachable && !!t.tmux_session && input.aliveSessions.has(t.tmux_session),
        progress: input.progress?.byTab[t.id] ?? null,
      })),
    }));
  return { machine: input.machine, reachable: input.reachable, rooms };
}
```

- [ ] **Step 4: Run it again.** Expected: PASS (4 tests).

- [ ] **Step 5: Write the failing route test**, `apps/server/src/routes/office.test.ts`:

```ts
import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Repositories } from '../db/repositories/index.js';
import { applyErrorHandler } from '../lib/errors.js';

const listTmuxSessions = vi.fn();
const canAccess = vi.fn();
vi.mock('../terminal/machine-exec.js', () => ({ listTmuxSessions: (...a: unknown[]) => listTmuxSessions(...a) }));
vi.mock('../auth/permissions.js', async (orig) => ({ ...(await orig<typeof import('../auth/permissions.js')>()), canAccess: (...a: unknown[]) => canAccess(...a) }));

const { officeRoutes } = await import('./office.js');

function buildApp() {
  const app = Fastify();
  applyErrorHandler(app);
  app.addHook('preHandler', async (request) => {
    request.scope = { user: { id: 'u1' } as never, viewAs: { kind: 'self' }, ownerId: 'u1', createAs: 'u1' };
    request.user = { id: 'u1' } as never;
  });
  const officeProgress = vi.fn(async () => ({ counts: { p1: { todo: 0, doing: 1, done: 0 } }, byTab: {} }));
  const repos = {
    machines: { findById: vi.fn(async (id: string) => (id === 'm1' ? { id: 'm1', name: 'jarvis', owner_id: 'u1' } : id === 'm2' ? { id: 'm2', name: 'other', owner_id: 'someone-else' } : undefined)) },
    projects: { list: vi.fn(async () => [{ id: 'p1', machine_id: 'm1', name: 'p1', status: 'active' }]) },
    tabs: { listByProjects: vi.fn(async () => [{ id: 't1', project_id: 'p1', name: 't1', kind: 'terminal', tmux_session: 'th-t1', simulator_udid: null }]) },
    tasks: { officeProgress },
  } as unknown as Repositories;
  app.register((a) => officeRoutes(a, repos, { simulators: { isReady: () => false } as never }), { prefix: '/office' });
  return { app, repos, officeProgress };
}

describe('GET /office/:machineId', () => {
  beforeEach(() => {
    listTmuxSessions.mockReset().mockResolvedValue(new Set(['th-t1']));
    canAccess.mockReset().mockResolvedValue(true);
  });

  it('returns the floor with alive tabs and task counts', async () => {
    const { app } = buildApp();
    const res = await app.inject({ method: 'GET', url: '/office/m1' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.reachable).toBe(true);
    expect(body.rooms[0].tabs[0]).toMatchObject({ id: 't1', alive: true, progress: null });
    expect(body.rooms[0].tasks).toEqual({ todo: 0, doing: 1, done: 0 });
  });

  it('answers 200 with reachable: false when the machine cannot be asked', async () => {
    listTmuxSessions.mockRejectedValue(new Error('ssh: connect timed out'));
    const { app } = buildApp();
    const body = (await app.inject({ method: 'GET', url: '/office/m1' })).json();
    expect(body.reachable).toBe(false);
    expect(body.rooms[0].tabs[0].alive).toBe(false);
  });

  it('leaves the board out, unqueried, for someone who cannot read tasks', async () => {
    canAccess.mockResolvedValue(false);
    const { app, officeProgress } = buildApp();
    const body = (await app.inject({ method: 'GET', url: '/office/m1' })).json();
    expect(officeProgress).not.toHaveBeenCalled();
    expect(body.rooms[0].tasks).toBeNull();
    expect(canAccess).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: 'u1' }), 'tasks', 'read');
  });

  it('is 404 for a machine outside the scope and for an unknown one', async () => {
    const { app } = buildApp();
    expect((await app.inject({ method: 'GET', url: '/office/m2' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/office/nope' })).statusCode).toBe(404);
  });
});
```

Before relying on the scope shape or the `owner_id` rule above, open `apps/server/src/routes/machines.test.ts` and copy its `request.scope` literal and its out-of-scope fixture exactly — that file is the reference for how `scoped(...).machine(id)` decides a 404.

- [ ] **Step 6: Run it.** `DOCKER 'npx -w @termhub/server vitest run src/routes/office.test.ts'` — Expected: FAIL, cannot find `./office.js`.

- [ ] **Step 7: Implement** `apps/server/src/routes/office.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { canAccess } from '../auth/permissions.js';
import { scoped } from '../auth/scope.js';
import type { Repositories } from '../db/repositories/index.js';
import { buildOfficeSnapshot } from '../office/snapshot.js';
import type { SimulatorSessionManager } from '../simulator/session-manager.js';
import { listTmuxSessions } from '../terminal/machine-exec.js';

const params = z.object({ machineId: z.string().min(1).max(64) });

/**
 * The office view's one read: a machine's floor (projects, tabs, board progress). Registered under
 * the `projects` resource; the board part additionally needs `tasks:read` and is left out — not
 * even queried — without it.
 */
export async function officeRoutes(app: FastifyInstance, repos: Repositories, deps: { simulators: Pick<SimulatorSessionManager, 'isReady'> }) {
  app.get('/:machineId', async (request) => {
    const { machineId } = params.parse(request.params);
    const machine = await scoped(repos, request).machine(machineId);
    const projects = await repos.projects.list({ machine_id: machine.id });
    const projectIds = projects.filter((p) => p.status !== 'archived').map((p) => p.id);
    const [tabs, progress] = await Promise.all([
      repos.tabs.listByProjects(projectIds),
      (await canAccess(repos, request.user, 'tasks', 'read')) ? repos.tasks.officeProgress(projectIds) : Promise.resolve(null),
    ]);
    let aliveSessions = new Set<string>();
    let reachable = true;
    if (tabs.some((t) => t.kind === 'terminal')) {
      try {
        aliveSessions = await listTmuxSessions(machine);
      } catch {
        reachable = false;
      }
    }
    request.log.info({ machineId: machine.id, rooms: projectIds.length, tabs: tabs.length, reachable }, 'office: snapshot');
    return buildOfficeSnapshot({ machine, projects, tabs, aliveSessions, reachable, simulatorReady: (udid) => deps.simulators.isReady(machine.id, udid), progress });
  });
}
```

Check the real import path of `scoped` (grep `export function scoped` / `export const scoped` under `apps/server/src/auth/`) and of `SimulatorSessionManager` (`apps/server/src/simulator/session-manager.ts`) and fix the imports if they differ.

Register it in `apps/server/src/app.ts`, right after the `dashboardRoutes` line, and add the import at the top with the other route imports:

```ts
      await guarded('projects', (a) => officeRoutes(a, repos, { simulators }), '/office');
```

- [ ] **Step 8: Run the route test and the server typecheck.**
`DOCKER 'npx -w @termhub/server vitest run src/routes/office.test.ts src/office && npm run typecheck -w @termhub/server'` — Expected: PASS, no type errors.

- [ ] **Step 9: Commit**

```bash
git add apps/server/src/office apps/server/src/routes/office.ts apps/server/src/routes/office.test.ts apps/server/src/app.ts
git commit -m "Office: snapshot endpoint for a machine's floor"
```

---

### Task 3: Layout — promote `iso.ts`, add the floor packing

**Files:**
- Move: `apps/web/src/office/iso.ts` → `apps/web/src/office/layout/iso.ts`; `apps/web/src/office/iso.test.ts` → `apps/web/src/office/layout/iso.test.ts`
- Create: `apps/web/src/office/layout/floor.ts`, `apps/web/src/office/layout/floor.test.ts`
- Modify (temporarily, until Task 9 deletes them): `apps/web/src/office/OfficeScene.ts` import of `./iso` → `./layout/iso`

**Interfaces:**
- Consumes (from `iso.ts`, unchanged): `TILE_W`, `TILE_H`, `Cell`, `Point`, `toScreen(gx, gy, z?)`, `depthOf(cell)`, `RoomLayout { width; height; desks: Cell[] }`, `layoutRoom(count)`, `roomBounds(layout, wallH)`.
- Produces:

```ts
interface RoomInput { id: string; desks: number }
interface PlacedRoom { id: string; origin: Cell; layout: RoomLayout }
interface FloorLayout { rooms: PlacedRoom[]; width: number; height: number }
function layoutFloor(rooms: RoomInput[], targetWidth?: number): FloorLayout
function floorBounds(floor: FloorLayout, wallH: number): { x: number; y: number; w: number; h: number }
function placedRoomBounds(room: PlacedRoom, wallH: number): { x: number; y: number; w: number; h: number }
```

- [ ] **Step 1: Move the files and drop the "SPIKE (throwaway)" header line from `iso.ts`** (replace the first comment line with `Isometric geometry and the generated room layout for the office view.`):

```bash
mkdir -p apps/web/src/office/layout
git mv apps/web/src/office/iso.ts apps/web/src/office/layout/iso.ts
git mv apps/web/src/office/iso.test.ts apps/web/src/office/layout/iso.test.ts
sed -i "s#from './iso'#from './layout/iso'#" apps/web/src/office/OfficeScene.ts
```

- [ ] **Step 2: Write the failing test**, `apps/web/src/office/layout/floor.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { floorBounds, layoutFloor, placedRoomBounds } from './floor';

const overlaps = (a: { origin: { gx: number; gy: number }; layout: { width: number; height: number } }, b: typeof a) =>
  a.origin.gx < b.origin.gx + b.layout.width && b.origin.gx < a.origin.gx + a.layout.width && a.origin.gy < b.origin.gy + b.layout.height && b.origin.gy < a.origin.gy + a.layout.height;

describe('layoutFloor', () => {
  it('places rooms in the order given, left to right, then on the next row', () => {
    const floor = layoutFloor([{ id: 'a', desks: 2 }, { id: 'b', desks: 2 }, { id: 'c', desks: 2 }], 12);
    expect(floor.rooms.map((r) => r.id)).toEqual(['a', 'b', 'c']);
    expect(floor.rooms[1].origin.gy).toBe(floor.rooms[0].origin.gy);
    expect(floor.rooms[1].origin.gx).toBe(floor.rooms[0].layout.width + 1);
    expect(floor.rooms[2].origin.gx).toBe(0);
    expect(floor.rooms[2].origin.gy).toBe(floor.rooms[0].layout.height + 2);
  });

  it('never overlaps rooms of very different sizes', () => {
    const floor = layoutFloor([1, 12, 0, 40, 3, 7, 0, 25].map((desks, i) => ({ id: `r${i}`, desks })));
    for (let i = 0; i < floor.rooms.length; i++) for (let j = i + 1; j < floor.rooms.length; j++) expect(overlaps(floor.rooms[i], floor.rooms[j])).toBe(false);
    for (const r of floor.rooms) {
      expect(r.origin.gx + r.layout.width).toBeLessThanOrEqual(floor.width);
      expect(r.origin.gy + r.layout.height).toBeLessThanOrEqual(floor.height);
    }
  });

  it('gives a room wider than the target its own row instead of looping', () => {
    const floor = layoutFloor([{ id: 'big', desks: 200 }, { id: 'small', desks: 1 }], 8);
    expect(floor.rooms[0].origin).toEqual({ gx: 0, gy: 0 });
    expect(floor.rooms[1].origin.gx).toBe(0);
  });

  it('is an empty, finite floor for no rooms', () => {
    const floor = layoutFloor([]);
    expect(floor).toEqual({ rooms: [], width: 0, height: 0 });
    const b = floorBounds(floor, 90);
    expect(Object.values(b).every(Number.isFinite)).toBe(true);
  });

  it('picks a target width that keeps the floor from being a single long row', () => {
    const floor = layoutFloor(Array.from({ length: 12 }, (_, i) => ({ id: `r${i}`, desks: 3 })));
    expect(new Set(floor.rooms.map((r) => r.origin.gy)).size).toBeGreaterThan(1);
  });

  it('keeps a room where it was when only a later room changes size', () => {
    const before = layoutFloor([{ id: 'a', desks: 3 }, { id: 'b', desks: 3 }, { id: 'c', desks: 3 }], 30);
    const after = layoutFloor([{ id: 'a', desks: 3 }, { id: 'b', desks: 3 }, { id: 'c', desks: 9 }], 30);
    expect(after.rooms[0].origin).toEqual(before.rooms[0].origin);
    expect(after.rooms[1].origin).toEqual(before.rooms[1].origin);
  });
});

describe('placedRoomBounds', () => {
  it('is the room box moved to its origin', () => {
    const floor = layoutFloor([{ id: 'a', desks: 1 }, { id: 'b', desks: 1 }], 40);
    const a = placedRoomBounds(floor.rooms[0], 90);
    const b = placedRoomBounds(floor.rooms[1], 90);
    expect(b.w).toBe(a.w);
    expect(b.x).toBeGreaterThan(a.x);
  });
});
```

- [ ] **Step 3: Run it.** `DOCKER 'npx -w @termhub/web vitest run src/office/layout'` — Expected: `iso.test.ts` PASS, `floor.test.ts` FAIL (cannot find `./floor`).

- [ ] **Step 4: Implement** `apps/web/src/office/layout/floor.ts`:

```ts
/** Where each room sits on a machine's floor. Pure; the scene only draws the result. */
import { layoutRoom, roomBounds, toScreen, type Cell, type RoomLayout } from './iso';

export interface RoomInput {
  id: string;
  desks: number;
}

export interface PlacedRoom {
  id: string;
  /** the room's (0,0) tile on the floor grid */
  origin: Cell;
  layout: RoomLayout;
}

export interface FloorLayout {
  rooms: PlacedRoom[];
  /** floor size in tiles */
  width: number;
  height: number;
}

const GAP_X = 1;
const CORRIDOR = 2;

/**
 * Shelf packing: rooms go left to right in the order given and wrap to a new row past
 * `targetWidth`. Order is never changed, so a room only moves when one before it changes size.
 * The default target makes the floor roughly square in tiles, which projects to about 2:1 on
 * screen — close to a monitor's shape once the walls are added.
 */
export function layoutFloor(rooms: RoomInput[], targetWidth?: number): FloorLayout {
  const layouts = rooms.map((r) => ({ id: r.id, layout: layoutRoom(r.desks) }));
  const area = layouts.reduce((sum, r) => sum + (r.layout.width + GAP_X) * (r.layout.height + CORRIDOR), 0);
  const widest = layouts.reduce((w, r) => Math.max(w, r.layout.width), 0);
  const target = Math.max(widest, targetWidth ?? Math.ceil(Math.sqrt(area) * 1.15));
  const placed: PlacedRoom[] = [];
  let x = 0;
  let y = 0;
  let rowHeight = 0;
  let width = 0;
  for (const r of layouts) {
    if (x > 0 && x + r.layout.width > target) {
      x = 0;
      y += rowHeight + CORRIDOR;
      rowHeight = 0;
    }
    placed.push({ id: r.id, origin: { gx: x, gy: y }, layout: r.layout });
    width = Math.max(width, x + r.layout.width);
    x += r.layout.width + GAP_X;
    rowHeight = Math.max(rowHeight, r.layout.height);
  }
  return { rooms: placed, width, height: placed.length ? y + rowHeight : 0 };
}

/** Screen-space box of one placed room, walls included. */
export function placedRoomBounds(room: PlacedRoom, wallH: number): { x: number; y: number; w: number; h: number } {
  const b = roomBounds(room.layout, wallH);
  const o = toScreen(room.origin.gx, room.origin.gy);
  return { x: b.x + o.x, y: b.y + o.y, w: b.w, h: b.h };
}

/** Screen-space box of the whole floor; a zero-size box at the origin when there are no rooms. */
export function floorBounds(floor: FloorLayout, wallH: number): { x: number; y: number; w: number; h: number } {
  if (floor.rooms.length === 0) return { x: 0, y: 0, w: 0, h: 0 };
  const boxes = floor.rooms.map((r) => placedRoomBounds(r, wallH));
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  return { x, y, w: Math.max(...boxes.map((b) => b.x + b.w)) - x, h: Math.max(...boxes.map((b) => b.y + b.h)) - y };
}
```

- [ ] **Step 5: Run the tests and the web typecheck.** `DOCKER 'npx -w @termhub/web vitest run src/office/layout && npm run typecheck -w @termhub/web'` — Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A apps/web/src/office
git commit -m "Office: shelf-packed floor layout; promote the spike's iso geometry"
```

---

### Task 4: The scene model

**Files:**
- Modify: `apps/web/src/lib/types.ts` (add after `MonitorItem`), `apps/web/src/lib/api.ts` (add next to `dashboard`)
- Create: `apps/web/src/office/model.ts`, `apps/web/src/office/model.test.ts`

**Interfaces:**
- Consumes: `Tab`, `TabState`, `Project`, `Machine` from `lib/types`; `tabNeedsYou(tab)` from `lib/needs-you` (open the file and confirm the exact parameter type before calling it).
- Produces (types in `lib/types.ts`):

```ts
export interface OfficeTaskCounts { todo: number; doing: number; done: number }
export interface OfficeTabProgress { task_id: string; title: string; done: number; total: number }
export interface OfficeTab extends Tab { progress: OfficeTabProgress | null }
export interface OfficeRoom { project: Project; tabs: OfficeTab[]; tasks: OfficeTaskCounts | null }
export interface OfficeSnapshot { machine: Machine; reachable: boolean; rooms: OfficeRoom[] }
```

`api.office = (machineId: string) => request<OfficeSnapshot>('GET', \`/office/${encodeURIComponent(machineId)}\`)`

Produces (in `office/model.ts`):

```ts
type Pose = 'type' | 'raise' | 'sleep' | 'shake' | 'sit' | 'empty';
type Marker = 'input' | 'permission' | 'error' | null;
interface DeskModel { id: string; projectId: string; name: string; label: string; kind: 'person' | 'phone'; pose: Pose; marker: Marker; dimmed: boolean; screenOn: boolean; state: TabState | null; progress: { done: number; total: number; title: string } | null; look: number }
interface RoomModel { id: string; name: string; label: string; lit: boolean; needsYou: number; progress: { done: number; total: number } | null; desks: DeskModel[] }
interface FloorModel { rooms: RoomModel[]; needsYou: number }
function buildModel(snapshot: OfficeSnapshot, liveTab: (tabId: string) => Tab | undefined): FloorModel
function truncateLabel(text: string, max: number): string
function lookOf(id: string, variants: number): number
function missingFromSnapshot(snapshot: OfficeSnapshot | null, monitorTabIds: string[], machineProjectIds: Set<string>, projectOf: (tabId: string) => string | undefined): boolean
```

- [ ] **Step 1: Add the types and the api call** exactly as listed above. `OfficeTab` needs no `alive` field of its own: the web `Tab` already has `alive: boolean`.

- [ ] **Step 2: Write the failing test**, `apps/web/src/office/model.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { OfficeRoom, OfficeSnapshot, OfficeTab, Project, Tab } from '../lib/types';
import { buildModel, lookOf, missingFromSnapshot, truncateLabel } from './model';

const tab = (id: string, over: Partial<OfficeTab> = {}): OfficeTab =>
  ({ id, project_id: 'p1', name: id, kind: 'terminal', position: 0, state: null, state_text: null, state_tool: null, state_at: null, state_seen_at: null, alive: true, progress: null, ...over }) as OfficeTab;
const room = (id: string, tabs: OfficeTab[], over: Partial<OfficeRoom> = {}): OfficeRoom => ({ project: { id, name: id, status: 'active' } as Project, tabs, tasks: null, ...over });
const snap = (rooms: OfficeRoom[]): OfficeSnapshot => ({ machine: { id: 'm1', name: 'jarvis' } as never, reachable: true, rooms });
const none = () => undefined;

describe('buildModel', () => {
  it('maps each tab state to a pose and a marker', () => {
    const at = '2026-09-21T10:00:00.000Z';
    const m = buildModel(
      snap([room('p1', [
        tab('w', { state: 'working', state_at: at }),
        tab('i', { state: 'waiting_input', state_at: at }),
        tab('p', { state: 'waiting_permission', state_at: at }),
        tab('z', { state: 'idle', state_at: at }),
        tab('e', { state: 'error', state_at: at }),
        tab('n'),
      ])]),
      none,
    );
    expect(m.rooms[0].desks.map((d) => [d.id, d.pose, d.marker, d.dimmed, d.screenOn])).toEqual([
      ['w', 'type', null, false, true],
      ['i', 'raise', 'input', false, false],
      ['p', 'raise', 'permission', false, false],
      ['z', 'sleep', null, false, false],
      ['e', 'shake', 'error', false, false],
      ['n', 'sit', null, true, false],
    ]);
    expect(m.rooms[0].needsYou).toBe(2);
    expect(m.needsYou).toBe(2);
  });

  it('keeps the hand up but drops the marker once the tab was seen', () => {
    const seen = tab('i', { state: 'waiting_input', state_at: '2026-09-21T10:00:00.000Z', state_seen_at: '2026-09-21T10:05:00.000Z' });
    const d = buildModel(snap([room('p1', [seen])]), none).rooms[0].desks[0];
    expect([d.pose, d.marker]).toEqual(['raise', null]);
    expect(buildModel(snap([room('p1', [seen])]), none).needsYou).toBe(0);
  });

  it('lets the live monitor state override the snapshot, and a tab the monitor never saw stay as it is', () => {
    const live = (id: string) => (id === 'a' ? ({ ...tab('a'), state: 'working', state_at: '2026-09-21T10:00:00.000Z' } as Tab) : undefined);
    const desks = buildModel(snap([room('p1', [tab('a'), tab('b')])]), live).rooms[0].desks;
    expect(desks.map((d) => d.pose)).toEqual(['type', 'sit']);
  });

  it('shows an empty chair for a dead terminal tab and a phone for a simulator tab', () => {
    const desks = buildModel(snap([room('p1', [tab('dead', { alive: false, state: 'working', state_at: 'x' }), tab('sim', { kind: 'simulator', alive: true })])]), none).rooms[0].desks;
    expect([desks[0].pose, desks[0].marker, desks[0].screenOn]).toEqual(['empty', null, false]);
    expect([desks[1].kind, desks[1].screenOn]).toEqual(['phone', true]);
  });

  it('draws progress only from a bound task, and a bar only when it has subtasks', () => {
    const desks = buildModel(
      snap([room('p1', [tab('a', { progress: { task_id: 'k', title: 'Ship', done: 1, total: 3 } }), tab('b', { progress: { task_id: 'k2', title: 'Solo', done: 0, total: 0 } }), tab('c')])]),
      none,
    ).rooms[0].desks;
    expect(desks.map((d) => d.progress)).toEqual([{ done: 1, total: 3, title: 'Ship' }, { done: 0, total: 0, title: 'Solo' }, null]);
  });

  it('gives a room its board progress, none when the board is empty or unreadable, and lights by project status', () => {
    const m = buildModel(
      snap([
        room('a', [], { tasks: { todo: 1, doing: 1, done: 2 } }),
        room('b', [], { tasks: { todo: 0, doing: 0, done: 0 } }),
        room('c', [], { tasks: null }),
        room('d', [], { project: { id: 'd', name: 'd', status: 'paused' } as Project }),
      ]),
      none,
    );
    expect(m.rooms.map((r) => r.progress)).toEqual([{ done: 2, total: 4 }, null, null, null]);
    expect(m.rooms.map((r) => r.lit)).toEqual([true, true, true, false]);
  });

  it('orders desks by tab position and truncates labels without touching names', () => {
    const long = 'x'.repeat(120);
    const m = buildModel(snap([room(long, [tab('second', { position: 1 }), tab('first', { position: 0, name: long })])]), none);
    expect(m.rooms[0].desks.map((d) => d.id)).toEqual(['first', 'second']);
    expect(m.rooms[0].desks[0].name).toBe(long);
    expect(m.rooms[0].desks[0].label.length).toBeLessThanOrEqual(18);
    expect(m.rooms[0].label.length).toBeLessThanOrEqual(28);
  });
});

describe('truncateLabel', () => {
  it('cuts by code point so an emoji is never split, and leaves short text alone', () => {
    expect(truncateLabel('api', 10)).toBe('api');
    expect(truncateLabel('🚀🚀🚀🚀🚀', 3)).toBe('🚀🚀…');
    expect(truncateLabel('  spaced   name  ', 20)).toBe('spaced name');
    expect(truncateLabel('', 5)).toBe('');
  });
});

describe('lookOf', () => {
  it('is stable for an id and spread over the variants', () => {
    expect(lookOf('tab-1', 6)).toBe(lookOf('tab-1', 6));
    const seen = new Set(Array.from({ length: 60 }, (_, i) => lookOf(`tab-${i}`, 6)));
    expect(seen.size).toBe(6);
    expect([...seen].every((n) => n >= 0 && n < 6)).toBe(true);
  });
});

describe('missingFromSnapshot', () => {
  const s = snap([room('p1', [tab('a')])]);
  const projects = new Set(['p1']);
  const projectOf = (id: string) => ({ a: 'p1', b: 'p1', other: 'p9' })[id];
  it('is true when the monitor knows a tab of this machine the snapshot lacks', () => {
    expect(missingFromSnapshot(s, ['a', 'b'], projects, projectOf)).toBe(true);
  });
  it('is false for tabs of other machines, for known tabs, and before the first snapshot', () => {
    expect(missingFromSnapshot(s, ['a', 'other'], projects, projectOf)).toBe(false);
    expect(missingFromSnapshot(null, ['b'], projects, projectOf)).toBe(false);
  });
});
```

- [ ] **Step 3: Run it.** `DOCKER 'npx -w @termhub/web vitest run src/office/model.test.ts'` — Expected: FAIL, cannot find `./model`.

- [ ] **Step 4: Implement** `apps/web/src/office/model.ts`:

```ts
/**
 * Snapshot + live monitor state -> what the scene draws. Pure, and the only place where a tab's
 * fields are turned into poses and markers: the scene never reads a `Tab`.
 */
import { tabNeedsYou } from '../lib/needs-you';
import type { OfficeSnapshot, OfficeTab, Tab, TabState } from '../lib/types';

export type Pose = 'type' | 'raise' | 'sleep' | 'shake' | 'sit' | 'empty';
export type Marker = 'input' | 'permission' | 'error' | null;

export interface DeskModel {
  id: string;
  projectId: string;
  /** full tab name (hover) */
  name: string;
  /** what is drawn under the desk */
  label: string;
  kind: 'person' | 'phone';
  pose: Pose;
  marker: Marker;
  /** never reported a state: a person, but not an "idle" one */
  dimmed: boolean;
  screenOn: boolean;
  state: TabState | null;
  /** total = 0: a bound task with no subtasks — a title, no bar */
  progress: { done: number; total: number; title: string } | null;
  /** stable appearance variant, from the tab id */
  look: number;
}

export interface RoomModel {
  id: string;
  name: string;
  label: string;
  /** false for a paused project */
  lit: boolean;
  needsYou: number;
  progress: { done: number; total: number } | null;
  desks: DeskModel[];
}

export interface FloorModel {
  rooms: RoomModel[];
  needsYou: number;
}

export const LOOK_VARIANTS = 6;
const DESK_LABEL_MAX = 18;
const ROOM_LABEL_MAX = 28;

const POSE: Record<TabState, Pose> = { working: 'type', waiting_input: 'raise', waiting_permission: 'raise', idle: 'sleep', error: 'shake' };

/** Collapses whitespace and cuts by code point (never inside an emoji), ending in an ellipsis. */
export function truncateLabel(text: string, max: number): string {
  const chars = Array.from(text.trim().replace(/\s+/g, ' '));
  return chars.length <= max ? chars.join('') : `${chars.slice(0, max - 1).join('')}…`;
}

/** FNV-1a over the id: the same tab is always the same person. */
export function lookOf(id: string, variants: number): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 0x01000193);
  return (h >>> 0) % variants;
}

function deskOf(tab: OfficeTab, live: Tab | undefined): DeskModel {
  const t: OfficeTab = live ? { ...tab, ...live, alive: tab.alive, progress: tab.progress } : tab;
  const base = { id: t.id, projectId: t.project_id, name: t.name, label: truncateLabel(t.name, DESK_LABEL_MAX), look: lookOf(t.id, LOOK_VARIANTS), progress: t.progress ? { done: t.progress.done, total: t.progress.total, title: t.progress.title } : null };
  if (t.kind === 'simulator') return { ...base, kind: 'phone', pose: 'empty', marker: null, dimmed: false, screenOn: t.alive, state: null };
  if (!t.alive) return { ...base, kind: 'person', pose: 'empty', marker: null, dimmed: false, screenOn: false, state: t.state };
  const needs = tabNeedsYou(t);
  const marker: Marker = t.state === 'error' ? 'error' : !needs ? null : t.state === 'waiting_permission' ? 'permission' : 'input';
  return { ...base, kind: 'person', pose: t.state ? POSE[t.state] : 'sit', marker, dimmed: !t.state, screenOn: t.state === 'working', state: t.state };
}

export function buildModel(snapshot: OfficeSnapshot, liveTab: (tabId: string) => Tab | undefined): FloorModel {
  const rooms = snapshot.rooms.map((r): RoomModel => {
    const desks = [...r.tabs].sort((a, b) => a.position - b.position).map((t) => deskOf(t, liveTab(t.id)));
    const total = r.tasks ? r.tasks.todo + r.tasks.doing + r.tasks.done : 0;
    return {
      id: r.project.id,
      name: r.project.name,
      label: truncateLabel(r.project.name, ROOM_LABEL_MAX),
      lit: r.project.status !== 'paused',
      needsYou: desks.filter((d) => d.marker === 'input' || d.marker === 'permission').length,
      progress: r.tasks && total > 0 ? { done: r.tasks.done, total } : null,
      desks,
    };
  });
  return { rooms, needsYou: rooms.reduce((n, r) => n + r.needsYou, 0) };
}

/** True when the monitor knows a tab of this machine that the snapshot lacks: time to re-read it. */
export function missingFromSnapshot(snapshot: OfficeSnapshot | null, monitorTabIds: string[], machineProjectIds: Set<string>, projectOf: (tabId: string) => string | undefined): boolean {
  if (!snapshot) return false;
  const known = new Set(snapshot.rooms.flatMap((r) => r.tabs.map((t) => t.id)));
  return monitorTabIds.some((id) => !known.has(id) && machineProjectIds.has(projectOf(id) ?? ''));
}
```

If `tabNeedsYou`'s parameter type rejects an `OfficeTab`, pass `{ state: t.state, state_at: t.state_at, state_seen_at: t.state_seen_at }` — do not reimplement the rule.

- [ ] **Step 5: Run the tests and typecheck.** `DOCKER 'npx -w @termhub/web vitest run src/office && npm run typecheck -w @termhub/web'` — Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/lib/types.ts apps/web/src/lib/api.ts apps/web/src/office/model.ts apps/web/src/office/model.test.ts
git commit -m "Office: scene model built from the snapshot and the live monitor"
```

---

### Task 5: The sprite contract and the generated pack

**Files:**
- Create: `apps/web/src/office/pack/manifest.ts`, `apps/web/src/office/pack/manifest.test.ts`, `apps/web/src/office/pack/generated.ts`

**Interfaces:**
- Consumes: `TILE_W`, `TILE_H` from `../layout/iso`; `LOOK_VARIANTS` from `../model`.
- Produces:

```ts
type Anim = 'sit' | 'type' | 'raise' | 'sleep' | 'shake';
interface FrameRect { x: number; y: number; w: number; h: number }
interface SpriteDef { frames: FrameRect[]; anchor: { x: number; y: number }; fps: number }
interface PackManifest {
  name: string; tile: { w: number; h: number };
  sprites: Record<string, SpriteDef>;   // 'desk', 'chair', 'monitor/on', 'monitor/off', 'phone/on', 'phone/off',
                                        // 'person/<anim>/body', 'person/<anim>/shirt', 'person/hair'
  head: { x: number; y: number };       // from the person's anchor to the top of the head
  skin: number[]; hair: number[];       // tints, LOOK_VARIANTS long each
}
const REQUIRED_SPRITES: string[]
function validateManifest(m: PackManifest): string[]   // problems; empty = valid
function generatedPack(): { manifest: PackManifest; canvas: HTMLCanvasElement }
```

Floor tiles and walls are drawn by the scene with `Graphics` from colours, not sprites: they scale with room size. (The spec's `floor/*` and `wall/*` frame names are dropped from the contract for that reason — note it in the spec, Task 9.)

A person is three layered sprites so that art stays small: `body` (skin, tinted by `skin[look]`), `shirt` (white, tinted by state colour), `hair` (white, tinted by `hair[look]`).

- [ ] **Step 1: Write the failing test**, `apps/web/src/office/pack/manifest.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { REQUIRED_SPRITES, validateManifest, type PackManifest } from './manifest';

const sprite = { frames: [{ x: 0, y: 0, w: 8, h: 8 }], anchor: { x: 4, y: 8 }, fps: 0 };
const valid = (): PackManifest => ({
  name: 'test',
  tile: { w: 64, h: 32 },
  sprites: Object.fromEntries(REQUIRED_SPRITES.map((k) => [k, sprite])),
  head: { x: 0, y: -30 },
  skin: [1, 2, 3, 4, 5, 6],
  hair: [1, 2, 3, 4, 5, 6],
});

describe('validateManifest', () => {
  it('accepts a complete manifest', () => {
    expect(validateManifest(valid())).toEqual([]);
  });
  it('names every missing sprite', () => {
    const m = valid();
    delete m.sprites['person/raise/shirt'];
    delete m.sprites['desk'];
    expect(validateManifest(m)).toEqual(['missing sprite: desk', 'missing sprite: person/raise/shirt']);
  });
  it('rejects a sprite with no frames, an animated one with no fps, and short tint lists', () => {
    const m = valid();
    m.sprites['chair'] = { ...sprite, frames: [] };
    m.sprites['person/type/body'] = { ...sprite, frames: [sprite.frames[0], sprite.frames[0]], fps: 0 };
    m.skin = [1];
    expect(validateManifest(m)).toEqual(['sprite chair has no frames', 'sprite person/type/body has 2 frames but no fps', 'skin needs 6 tints, has 1']);
  });
  it('covers every animation with a body and a shirt', () => {
    for (const a of ['sit', 'type', 'raise', 'sleep', 'shake']) {
      expect(REQUIRED_SPRITES).toContain(`person/${a}/body`);
      expect(REQUIRED_SPRITES).toContain(`person/${a}/shirt`);
    }
  });
});
```

- [ ] **Step 2: Run it.** `DOCKER 'npx -w @termhub/web vitest run src/office/pack'` — Expected: FAIL, cannot find `./manifest`.

- [ ] **Step 3: Implement** `apps/web/src/office/pack/manifest.ts`:

```ts
/**
 * The sprite contract: what any art pack must provide. The scene knows this file and nothing
 * about how a pack was made, so art is replaced by swapping the pack.
 */
import { LOOK_VARIANTS } from '../model';

export const ANIMS = ['sit', 'type', 'raise', 'sleep', 'shake'] as const;
export type Anim = (typeof ANIMS)[number];

export interface FrameRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SpriteDef {
  frames: FrameRect[];
  /** the pixel of the frame that sits on the tile point the sprite is placed at */
  anchor: { x: number; y: number };
  /** 0 for a still sprite */
  fps: number;
}

export interface PackManifest {
  name: string;
  tile: { w: number; h: number };
  sprites: Record<string, SpriteDef>;
  /** from a person's anchor to the top of the head: where markers go and what is clicked */
  head: { x: number; y: number };
  skin: number[];
  hair: number[];
}

export const REQUIRED_SPRITES: string[] = [
  'chair',
  'desk',
  'monitor/off',
  'monitor/on',
  'person/hair',
  'phone/off',
  'phone/on',
  ...ANIMS.flatMap((a) => [`person/${a}/body`, `person/${a}/shirt`]),
].sort();

export function validateManifest(m: PackManifest): string[] {
  const problems: string[] = [];
  for (const key of REQUIRED_SPRITES) if (!m.sprites[key]) problems.push(`missing sprite: ${key}`);
  for (const [key, s] of Object.entries(m.sprites).sort(([a], [b]) => a.localeCompare(b))) {
    if (s.frames.length === 0) problems.push(`sprite ${key} has no frames`);
    else if (s.frames.length > 1 && s.fps <= 0) problems.push(`sprite ${key} has ${s.frames.length} frames but no fps`);
  }
  for (const list of ['skin', 'hair'] as const) if (m[list].length < LOOK_VARIANTS) problems.push(`${list} needs ${LOOK_VARIANTS} tints, has ${m[list].length}`);
  return problems;
}
```

- [ ] **Step 4: Run it.** Expected: PASS.

- [ ] **Step 5: Implement the v1 pack**, `apps/web/src/office/pack/generated.ts`. It paints a small atlas on a canvas at runtime — pixel art from rectangles on an integer grid, with a one-pixel dark outline — and returns the manifest that describes it. No binary asset, no build step.

```ts
/**
 * The in-house pack: pixel art painted by code onto one canvas, described by a manifest like any
 * other pack. Everything is drawn in whole pixels and meant to be sampled with 'nearest'.
 */
import { TILE_H, TILE_W } from '../layout/iso';
import { ANIMS, validateManifest, type Anim, type FrameRect, type PackManifest, type SpriteDef } from './manifest';

const OUTLINE = '#0f1115';
const CELL = { w: 32, h: 48 };
type Ctx = CanvasRenderingContext2D;

/** A filled pixel rectangle with a 1px outline around it. */
function block(ctx: Ctx, x: number, y: number, w: number, h: number, fill: string): void {
  ctx.fillStyle = OUTLINE;
  ctx.fillRect(x - 1, y - 1, w + 2, h + 2);
  ctx.fillStyle = fill;
  ctx.fillRect(x, y, w, h);
}

/** An isometric box drawn as pixel columns, footprint in tile fractions, heights in px. Origin = tile top vertex. */
function isoBox(ctx: Ctx, ox: number, oy: number, u0: number, u1: number, v0: number, v1: number, z0: number, z1: number, top: string, left: string, right: string): void {
  const p = (u: number, v: number, z: number): [number, number] => [Math.round(ox + ((u - v) * TILE_W) / 2), Math.round(oy + ((u + v) * TILE_H) / 2 - z)];
  const face = (pts: Array<[number, number]>, fill: string) => {
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.strokeStyle = OUTLINE;
    ctx.lineWidth = 1;
    ctx.stroke();
  };
  face([p(u0, v1, z1), p(u1, v1, z1), p(u1, v1, z0), p(u0, v1, z0)], left);
  face([p(u1, v0, z1), p(u1, v1, z1), p(u1, v1, z0), p(u1, v0, z0)], right);
  face([p(u0, v0, z1), p(u1, v0, z1), p(u1, v1, z1), p(u0, v1, z1)], top);
}

/** One person frame, feet at the cell's bottom centre. `layer` picks which tintable part is painted (in white). */
function person(ctx: Ctx, cx: number, by: number, anim: Anim, frame: number, layer: 'body' | 'shirt' | 'hair'): void {
  const bob = anim === 'type' ? frame % 2 : anim === 'sleep' ? 3 : 0;
  const lean = anim === 'sleep' ? 2 : 0;
  const shake = anim === 'shake' ? (frame % 2 ? 1 : -1) : 0;
  const x = cx + shake;
  const W = '#ffffff';
  if (layer === 'shirt') {
    block(ctx, x - 6, by - 22, 12, 14, W);
    if (anim === 'raise') block(ctx, x + 6, by - 36 - (frame % 2), 3, 16, W);
    if (anim === 'type') block(ctx, x - 8 + (frame % 2) * 2, by - 14, 3, 5, W);
  } else if (layer === 'body') {
    block(ctx, x - 5 + lean, by - 33 + bob, 10, 10, W);
    if (anim === 'raise') block(ctx, x + 6, by - 40 - (frame % 2), 3, 4, W);
    block(ctx, x - 5, by - 8, 4, 8, '#3a4152');
    block(ctx, x + 1, by - 8, 4, 8, '#3a4152');
  } else {
    block(ctx, x - 5 + lean, by - 35 + bob, 10, 4, W);
  }
}

export function generatedPack(): { manifest: PackManifest; canvas: HTMLCanvasElement } {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  const sprites: Record<string, SpriteDef> = {};
  let cursorX = 0;
  let cursorY = 0;
  let rowH = 0;
  /** Reserves a w×h cell in the atlas and returns its rect. */
  const alloc = (w: number, h: number): FrameRect => {
    if (cursorX + w > canvas.width) {
      cursorX = 0;
      cursorY += rowH;
      rowH = 0;
    }
    const r = { x: cursorX, y: cursorY, w, h };
    cursorX += w;
    rowH = Math.max(rowH, h);
    return r;
  };

  // furniture: one 72×64 cell each, the tile's top vertex at (36, 24) inside the cell
  const furniture = (key: string, paint: (ox: number, oy: number) => void) => {
    const r = alloc(72, 64);
    paint(r.x + 36, r.y + 24);
    sprites[key] = { frames: [r], anchor: { x: 36, y: 24 }, fps: 0 };
  };
  furniture('desk', (ox, oy) => isoBox(ctx, ox, oy, 0.08, 0.92, 0.12, 0.5, 0, 14, '#8a6a4a', '#6b5138', '#5a442f'));
  furniture('chair', (ox, oy) => isoBox(ctx, ox, oy, 0.36, 0.64, 0.62, 0.9, 0, 9, '#4b5468', '#3a4152', '#2f3544'));
  furniture('monitor/off', (ox, oy) => isoBox(ctx, ox, oy, 0.36, 0.64, 0.2, 0.27, 14, 34, '#2a2f3a', '#1e222b', '#161920'));
  furniture('monitor/on', (ox, oy) => isoBox(ctx, ox, oy, 0.36, 0.64, 0.2, 0.27, 14, 34, '#2a2f3a', '#4f8cff', '#161920'));
  furniture('phone/off', (ox, oy) => isoBox(ctx, ox, oy, 0.42, 0.58, 0.22, 0.42, 14, 17, '#1e222b', '#1e222b', '#161920'));
  furniture('phone/on', (ox, oy) => isoBox(ctx, ox, oy, 0.42, 0.58, 0.22, 0.42, 14, 17, '#9ecbff', '#1e222b', '#161920'));

  // people: 2 frames per animation (1 for sit and sleep), body and shirt layers
  const FRAMES: Record<Anim, number> = { sit: 1, type: 2, raise: 2, sleep: 1, shake: 2 };
  const FPS: Record<Anim, number> = { sit: 0, type: 6, raise: 3, sleep: 0, shake: 12 };
  for (const anim of ANIMS) {
    for (const layer of ['body', 'shirt'] as const) {
      const frames: FrameRect[] = [];
      for (let f = 0; f < FRAMES[anim]; f++) {
        const r = alloc(CELL.w, CELL.h);
        person(ctx, r.x + CELL.w / 2, r.y + CELL.h - 2, anim, f, layer);
        frames.push(r);
      }
      sprites[`person/${anim}/${layer}`] = { frames, anchor: { x: CELL.w / 2, y: CELL.h - 2 }, fps: FPS[anim] };
    }
  }
  const hair = alloc(CELL.w, CELL.h);
  person(ctx, hair.x + CELL.w / 2, hair.y + CELL.h - 2, 'sit', 0, 'hair');
  sprites['person/hair'] = { frames: [hair], anchor: { x: CELL.w / 2, y: CELL.h - 2 }, fps: 0 };

  const manifest: PackManifest = {
    name: 'generated',
    tile: { w: TILE_W, h: TILE_H },
    sprites,
    head: { x: 0, y: -36 },
    skin: [0xf2c9a5, 0xe8b998, 0xc99674, 0xa5714f, 0x7d4f34, 0x5a3825],
    hair: [0x2b1d14, 0x4a3323, 0x8a5a2b, 0xd9b36a, 0x9a9a9a, 0x1b1b1b],
  };
  const problems = validateManifest(manifest);
  if (problems.length) throw new Error(`generated pack is invalid: ${problems.join('; ')}`);
  return { manifest, canvas };
}
```

- [ ] **Step 6: Typecheck.** `DOCKER 'npm run typecheck -w @termhub/web && npx -w @termhub/web vitest run src/office'` — Expected: PASS. (The painting itself is verified by screenshot in Task 7.)

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/office/pack
git commit -m "Office: sprite contract and the generated in-house pack"
```

---

### Task 6: Camera

**Files:**
- Create: `apps/web/src/office/scene/camera.ts`, `apps/web/src/office/scene/camera.test.ts`

**Interfaces:**
- Produces:

```ts
interface View { x: number; y: number; scale: number }
interface Box { x: number; y: number; w: number; h: number }
const MIN_SCALE = 0.15, MAX_SCALE = 4
function frame(box: Box, screen: { width: number; height: number }, margin?: number, maxScale?: number): View
function zoomAt(view: View, cx: number, cy: number, factor: number): View
function ease(current: View, target: View, k: number): View
function settled(a: View, b: View): boolean
class Camera { target: View; current: View; readonly dragged: number;
  constructor(canvas: HTMLCanvasElement); frameBox(box: Box, snap?: boolean): void;
  tick(): View; onUserMove: (() => void) | null; destroy(): void }
```

- [ ] **Step 1: Write the failing test**, `apps/web/src/office/scene/camera.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ease, frame, MAX_SCALE, MIN_SCALE, settled, zoomAt } from './camera';

const screen = { width: 1000, height: 600 };

describe('frame', () => {
  it('centres the box and fits it inside the margin', () => {
    const v = frame({ x: -100, y: -50, w: 400, h: 200 }, screen, 50);
    expect(v.scale).toBeCloseTo(Math.min(900 / 400, 500 / 200));
    expect(v.x + (-100 + 200) * v.scale).toBeCloseTo(500);
    expect(v.y + (-50 + 100) * v.scale).toBeCloseTo(300);
  });
  it('caps the zoom for a tiny box and stays finite for an empty one or an empty screen', () => {
    expect(frame({ x: 0, y: 0, w: 10, h: 10 }, screen, 40, 2.5).scale).toBe(2.5);
    for (const v of [frame({ x: 0, y: 0, w: 0, h: 0 }, screen), frame({ x: 0, y: 0, w: 100, h: 100 }, { width: 0, height: 0 })]) {
      expect(Object.values(v).every(Number.isFinite)).toBe(true);
      expect(v.scale).toBeGreaterThanOrEqual(MIN_SCALE);
    }
  });
});

describe('zoomAt', () => {
  it('keeps the world point under the cursor where it is', () => {
    const before = { x: 120, y: 40, scale: 1 };
    const after = zoomAt(before, 300, 200, 1.5);
    expect((300 - after.x) / after.scale).toBeCloseTo((300 - before.x) / before.scale);
    expect((200 - after.y) / after.scale).toBeCloseTo((200 - before.y) / before.scale);
  });
  it('clamps to the scale limits', () => {
    expect(zoomAt({ x: 0, y: 0, scale: 3.9 }, 0, 0, 10).scale).toBe(MAX_SCALE);
    expect(zoomAt({ x: 0, y: 0, scale: 0.2 }, 0, 0, 0.01).scale).toBe(MIN_SCALE);
  });
});

describe('ease / settled', () => {
  it('moves a fraction of the way and reports when it has arrived', () => {
    const t = { x: 100, y: 0, scale: 2 };
    expect(ease({ x: 0, y: 0, scale: 1 }, t, 0.5)).toEqual({ x: 50, y: 0, scale: 1.5 });
    expect(settled({ x: 99.95, y: 0, scale: 2 }, t)).toBe(true);
    expect(settled({ x: 90, y: 0, scale: 2 }, t)).toBe(false);
  });
});
```

- [ ] **Step 2: Run it.** `DOCKER 'npx -w @termhub/web vitest run src/office/scene'` — Expected: FAIL, cannot find `./camera`.

- [ ] **Step 3: Implement** `apps/web/src/office/scene/camera.ts`:

```ts
/** The camera: pure view math, plus the class that binds wheel and drag to it. No PixiJS here. */
export interface View {
  x: number;
  y: number;
  scale: number;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const MIN_SCALE = 0.15;
export const MAX_SCALE = 4;
const clamp = (s: number, max = MAX_SCALE) => Math.min(max, Math.max(MIN_SCALE, Number.isFinite(s) ? s : 1));

/** The view that centres `box` on the screen with `margin` pixels around it. */
export function frame(box: Box, screen: { width: number; height: number }, margin = 40, maxScale = 2.5): View {
  const availW = Math.max(1, screen.width - margin * 2);
  const availH = Math.max(1, screen.height - margin * 2);
  const scale = clamp(box.w > 0 && box.h > 0 ? Math.min(availW / box.w, availH / box.h) : 1, maxScale);
  return { scale, x: screen.width / 2 - (box.x + box.w / 2) * scale, y: screen.height / 2 - (box.y + box.h / 2) * scale };
}

/** Zooms by `factor` keeping the world point under screen point (cx, cy) fixed. */
export function zoomAt(view: View, cx: number, cy: number, factor: number): View {
  const scale = clamp(view.scale * factor);
  const k = scale / view.scale;
  return { scale, x: cx - (cx - view.x) * k, y: cy - (cy - view.y) * k };
}

export function ease(current: View, target: View, k: number): View {
  return { x: current.x + (target.x - current.x) * k, y: current.y + (target.y - current.y) * k, scale: current.scale + (target.scale - current.scale) * k };
}

export function settled(a: View, b: View): boolean {
  return Math.abs(a.x - b.x) < 0.1 && Math.abs(a.y - b.y) < 0.1 && Math.abs(a.scale - b.scale) < 0.001;
}

export class Camera {
  target: View = { x: 0, y: 0, scale: 1 };
  current: View = { x: 0, y: 0, scale: 1 };
  /** pixels dragged since the last pointer down: a click is a press that moved less than 5 */
  dragged = 0;
  /** called when the person zooms or pans by hand (the page uses it to notice "zoomed out of the room") */
  onUserMove: (() => void) | null = null;
  private snapNext = true;
  private cleanup: Array<() => void> = [];

  constructor(private readonly canvas: HTMLCanvasElement) {
    let last: { x: number; y: number } | null = null;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = canvas.getBoundingClientRect();
      this.target = zoomAt(this.target, e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0015));
      this.onUserMove?.();
    };
    const onDown = (e: PointerEvent) => {
      last = { x: e.clientX, y: e.clientY };
      this.dragged = 0;
    };
    const onMove = (e: PointerEvent) => {
      if (!last) return;
      const dx = e.clientX - last.x;
      const dy = e.clientY - last.y;
      this.dragged += Math.abs(dx) + Math.abs(dy);
      this.target = { ...this.target, x: this.target.x + dx, y: this.target.y + dy };
      last = { x: e.clientX, y: e.clientY };
      if (this.dragged >= 5) this.onUserMove?.();
    };
    const onUp = () => (last = null);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('pointerdown', onDown);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    this.cleanup.push(() => {
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    });
  }

  frameBox(box: Box, snap = false): void {
    this.target = frame(box, { width: this.canvas.clientWidth, height: this.canvas.clientHeight });
    if (snap) this.snapNext = true;
  }

  /** Advances one frame and returns the view to apply to the world container. */
  tick(): View {
    this.current = this.snapNext ? this.target : ease(this.current, this.target, 0.18);
    this.snapNext = false;
    return this.current;
  }

  destroy(): void {
    this.cleanup.forEach((fn) => fn());
  }
}
```

- [ ] **Step 4: Run it.** Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/office/scene
git commit -m "Office: camera math and input binding"
```

---

### Task 7: The scene

**Files:**
- Create: `apps/web/src/office/scene/PersonView.ts`, `RoomView.ts`, `Overlay.ts`, `OfficeScene.ts` (all under `apps/web/src/office/scene/`)
- Rewrite: `apps/web/src/office/harness.ts`; rename `apps/web/spike-office.html` → `apps/web/office-harness.html` (and its `<script src>` stays `/src/office/harness.ts`, its comment loses "SPIKE (throwaway)")
- Delete: `apps/web/src/office/OfficeScene.ts` (the spike scene) — and, to keep the build green until Task 8, point `apps/web/src/pages/OfficeSpikePage.tsx` nowhere: delete it and its route in `App.tsx` now.

**Interfaces:**
- Consumes: `FloorModel`, `RoomModel`, `DeskModel`, `Pose`, `Marker` (Task 4); `layoutFloor`, `floorBounds`, `placedRoomBounds`, `PlacedRoom`, `FloorLayout` (Task 3); `toScreen`, `depthOf`, `TILE_W`, `TILE_H` (iso); `PackManifest`, `SpriteDef`, `Anim` and `generatedPack()` (Task 5); `Camera`, `Box` (Task 6).
- Produces:

```ts
class OfficeScene {
  constructor(handlers: { onPickDesk(deskId: string, projectId: string): void; onPickRoom(roomId: string): void; onPickSign(roomId: string): void; onLeaveRoom(): void });
  mount(host: HTMLElement): Promise<void>;
  destroy(): void;
  setModel(model: FloorModel): void;
  focusRoom(roomId: string | null, snap?: boolean): void;   // null = the floor
  readonly fps: number; readonly frameMs: number; readonly rendererName: string;
}
```

The scene owns three layers in one `world` container: `floor` (Graphics: tiles and walls per room), `things` (sorted by depth: desks, chairs, people), and an `overlay` container that is **not** inside `world` — labels, markers, bars and room signs live there and are positioned every frame from world coordinates, so furniture never covers them and markers keep a fixed screen size.

- [ ] **Step 1: `PersonView.ts`** — one desk: furniture sprites, the layered person, and the animation clock.

```ts
import { AnimatedSprite, Container, Sprite, type Texture } from 'pixi.js';
import { toScreen } from '../layout/iso';
import type { DeskModel, Pose } from '../model';
import type { Anim, PackManifest } from '../pack/manifest';

export type Textures = Record<string, Texture[]>;

const SHIRT: Record<string, number> = { working: 0x3fb950, waiting_input: 0xd29922, waiting_permission: 0xf0883e, idle: 0x7d8799, error: 0xf85149, none: 0x475569 };
const SEAT = { u: 0.5, v: 0.78 };

function sprite(textures: Textures, manifest: PackManifest, key: string): AnimatedSprite {
  const def = manifest.sprites[key];
  const s = new AnimatedSprite(textures[key]);
  s.anchor.set(def.anchor.x / def.frames[0].w, def.anchor.y / def.frames[0].h);
  s.animationSpeed = def.fps / 60;
  if (def.fps > 0) s.play();
  return s;
}

export class DeskView {
  readonly root = new Container();
  /** world-space point of the person's head, relative to `root` */
  readonly head: { x: number; y: number };
  model: DeskModel;
  private readonly monitor: { on: Sprite; off: Sprite } | null = null;
  private readonly phone: { on: Sprite; off: Sprite } | null = null;
  private readonly person = new Container();
  private pose: Pose | null = null;
  private fade = 1;

  constructor(
    model: DeskModel,
    private readonly textures: Textures,
    private readonly manifest: PackManifest,
    private readonly reducedMotion: boolean,
  ) {
    this.model = model;
    this.root.addChild(sprite(textures, manifest, 'desk'));
    if (model.kind === 'phone') {
      this.phone = { on: sprite(textures, manifest, 'phone/on'), off: sprite(textures, manifest, 'phone/off') };
      this.root.addChild(this.phone.off, this.phone.on);
    } else {
      this.monitor = { on: sprite(textures, manifest, 'monitor/on'), off: sprite(textures, manifest, 'monitor/off') };
      this.root.addChild(this.monitor.off, this.monitor.on, sprite(textures, manifest, 'chair'));
    }
    const seat = toScreen(SEAT.u, SEAT.v);
    this.person.position.set(seat.x, seat.y);
    this.root.addChild(this.person);
    this.head = { x: seat.x + manifest.head.x, y: seat.y + manifest.head.y };
    this.root.eventMode = 'static';
    this.root.cursor = 'pointer';
    this.apply(model);
  }

  apply(model: DeskModel): void {
    this.model = model;
    if (this.monitor) this.monitor.on.visible = model.screenOn;
    if (this.phone) this.phone.on.visible = model.screenOn;
    if (model.pose === this.pose && this.person.children.length) {
      this.tintShirt();
      return;
    }
    this.pose = model.pose;
    this.person.removeChildren().forEach((c) => c.destroy());
    if (model.kind === 'phone' || model.pose === 'empty') return;
    const anim = model.pose as Anim;
    const body = sprite(this.textures, this.manifest, `person/${anim}/body`);
    const shirt = sprite(this.textures, this.manifest, `person/${anim}/shirt`);
    const hair = sprite(this.textures, this.manifest, 'person/hair');
    body.tint = this.manifest.skin[model.look];
    hair.tint = this.manifest.hair[model.look];
    if (this.reducedMotion) [body, shirt].forEach((s) => s.gotoAndStop(0));
    this.person.addChild(body, shirt, hair);
    this.tintShirt();
    this.fade = 0; // crossfade in (150 ms at 60 fps ≈ 9 frames)
  }

  private tintShirt(): void {
    const shirt = this.person.children[1] as Sprite | undefined;
    if (shirt) shirt.tint = SHIRT[this.model.state ?? 'none'];
    this.person.alpha = this.model.dimmed ? 0.55 : 1;
  }

  update(): void {
    if (this.fade < 1) {
      this.fade = Math.min(1, this.fade + 1 / 9);
      this.person.alpha = (this.model.dimmed ? 0.55 : 1) * this.fade;
    }
  }
}
```

- [ ] **Step 2: `RoomView.ts`** — the floor and walls of one placed room, drawn with `Graphics` from colours.

```ts
import { Graphics } from 'pixi.js';
import type { PlacedRoom } from '../layout/floor';
import { toScreen } from '../layout/iso';

export const WALL_H = 90;
const LIT = { a: 0x313847, b: 0x2b3140, wallL: 0x1e222b, wallR: 0x262b36 };
const DARK = { a: 0x1a1d25, b: 0x171a21, wallL: 0x13151b, wallR: 0x171a20 };

/** Tiles and the two back walls; nothing in front, so people are never covered. Also the room's click target. */
export function drawRoom(room: PlacedRoom, lit: boolean): Graphics {
  const c = lit ? LIT : DARK;
  const { gx: ox, gy: oy } = room.origin;
  const { width, height } = room.layout;
  const g = new Graphics();
  const o = toScreen(ox, oy);
  const r = toScreen(ox + width, oy);
  const l = toScreen(ox, oy + height);
  g.poly([o.x, o.y, r.x, r.y, r.x, r.y - WALL_H, o.x, o.y - WALL_H]).fill(c.wallR);
  g.poly([o.x, o.y, l.x, l.y, l.x, l.y - WALL_H, o.x, o.y - WALL_H]).fill(c.wallL);
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      const a = toScreen(ox + x, oy + y);
      const b = toScreen(ox + x + 1, oy + y);
      const d = toScreen(ox + x + 1, oy + y + 1);
      const e = toScreen(ox + x, oy + y + 1);
      g.poly([a.x, a.y, b.x, b.y, d.x, d.y, e.x, e.y]).fill((x + y) % 2 ? c.a : c.b);
    }
  }
  g.eventMode = 'static';
  g.cursor = 'pointer';
  return g;
}
```

- [ ] **Step 3: `Overlay.ts`** — everything that must stay readable: desk labels, markers, progress bars, room signs. It lives outside `world`; `place()` runs every frame.

```ts
import { Container, Graphics, Text } from 'pixi.js';
import type { DeskModel, Marker, RoomModel } from '../model';
import type { View } from './camera';

const MARKER: Record<Exclude<Marker, null>, { color: number; glyph: string }> = {
  input: { color: 0xd29922, glyph: '!' },
  permission: { color: 0xf0883e, glyph: '!' },
  error: { color: 0xf85149, glyph: '×' },
};
const text = (size: number, fill: number, weight: '400' | '700' = '400') => ({ fontSize: size, fill, fontWeight: weight, fontFamily: 'JetBrains Mono, Menlo, monospace' });

/** Screen-space pieces of one desk. `world` is the desk's head point in world coordinates. */
export class DeskOverlay {
  readonly root = new Container();
  private readonly label: Text;
  private readonly marker = new Container();
  private readonly bar = new Graphics();
  private readonly barText: Text;
  private markerKind: Marker = null;
  private pulse = 0;
  hovered = false;

  constructor(
    readonly world: { x: number; y: number },
    model: DeskModel,
  ) {
    this.label = new Text({ text: model.label, style: text(11, 0xe6e8ee) });
    this.label.anchor.set(0.5, 0);
    this.barText = new Text({ text: '', style: text(10, 0xe6e8ee) });
    this.barText.anchor.set(0.5, 1);
    this.root.addChild(this.bar, this.barText, this.label, this.marker);
    this.apply(model);
  }

  apply(model: DeskModel): void {
    this.label.text = model.label;
    if (model.marker !== this.markerKind) {
      const entering = model.marker && model.marker !== 'error' && !this.markerKind;
      this.markerKind = model.marker;
      this.marker.removeChildren().forEach((c) => c.destroy());
      if (model.marker) {
        const m = MARKER[model.marker];
        const glyph = new Text({ text: m.glyph, style: text(14, 0x0f1115, '700') });
        glyph.anchor.set(0.5);
        this.marker.addChild(new Graphics().circle(0, 0, 10).fill(m.color).stroke({ color: 0x0f1115, width: 2 }), glyph);
      }
      if (entering) this.pulse = 1;
    }
    this.bar.clear();
    const p = model.progress;
    this.barText.text = p && p.total > 0 ? `${p.done}/${p.total}` : '';
    if (p && p.total > 0) {
      const done = p.done >= p.total;
      this.bar.roundRect(-20, -5, 40, 5, 2).fill(0x1e222b).roundRect(-20, -5, Math.max(2, 40 * (p.done / p.total)), 5, 2).fill(done ? 0x3fb950 : 0x4f8cff);
    }
  }

  /** `roomLevel`: labels and bars are for the room view; on the floor only the marker shows. */
  place(view: View, roomLevel: boolean, t: number, reducedMotion: boolean): void {
    const x = view.x + this.world.x * view.scale;
    const y = view.y + this.world.y * view.scale;
    this.root.position.set(Math.round(x), Math.round(y));
    const bounce = this.markerKind && this.markerKind !== 'error' && !reducedMotion ? Math.abs(Math.sin(t * 4)) * 6 : 0;
    this.pulse = Math.max(0, this.pulse - 0.03);
    this.marker.position.set(0, -16 - bounce);
    this.marker.scale.set(1 + this.pulse * 0.8);
    this.label.visible = roomLevel || this.hovered;
    this.label.position.set(0, 46 * view.scale);
    this.label.alpha = this.hovered ? 1 : 0.75;
    this.bar.visible = this.barText.visible = roomLevel;
    this.bar.position.set(0, -34);
    this.barText.position.set(0, -40);
  }
}

/** The sign over a room's back corner: name, board progress, how many need you. */
export class RoomSign {
  readonly root = new Container();
  private readonly name: Text;
  private readonly detail: Text;

  constructor(
    readonly world: { x: number; y: number },
    model: RoomModel,
  ) {
    this.name = new Text({ text: model.label, style: text(13, 0xe6e8ee, '700') });
    this.detail = new Text({ text: '', style: text(11, 0x9aa1b1) });
    this.name.anchor.set(0.5, 1);
    this.detail.anchor.set(0.5, 0);
    this.root.addChild(this.name, this.detail);
    this.root.eventMode = 'static';
    this.root.cursor = 'pointer';
    this.apply(model);
  }

  apply(model: RoomModel): void {
    this.name.text = model.label;
    const parts: string[] = [];
    if (model.progress) parts.push(`${model.progress.done}/${model.progress.total} tarefas`);
    if (model.needsYou > 0) parts.push(model.needsYou === 1 ? '1 precisa de você' : `${model.needsYou} precisam de você`);
    this.detail.text = parts.join(' · ');
    this.detail.style.fill = model.needsYou > 0 ? 0xf0883e : 0x9aa1b1;
    this.root.alpha = model.lit ? 1 : 0.6;
  }

  place(view: View): void {
    this.root.position.set(Math.round(view.x + this.world.x * view.scale), Math.round(view.y + this.world.y * view.scale));
  }
}
```

- [ ] **Step 4: `OfficeScene.ts`** — builds and diffs the floor, runs the ticker.

```ts
/** The office floor in PixiJS. Draws a FloorModel; knows nothing about tabs, the API or React. */
import { Application, Container, Rectangle, Texture, UPDATE_PRIORITY, type Graphics } from 'pixi.js';
import { floorBounds, layoutFloor, placedRoomBounds, type FloorLayout } from '../layout/floor';
import { depthOf, toScreen } from '../layout/iso';
import type { FloorModel } from '../model';
import { generatedPack } from '../pack/generated';
import type { PackManifest } from '../pack/manifest';
import { Camera } from './camera';
import { DeskOverlay, RoomSign } from './Overlay';
import { DeskView, type Textures } from './PersonView';
import { drawRoom, WALL_H } from './RoomView';

export interface SceneHandlers {
  onPickDesk(deskId: string, projectId: string): void;
  onPickRoom(roomId: string): void;
  onPickSign(roomId: string): void;
  /** the person zoomed out far enough that "inside a room" no longer describes the view */
  onLeaveRoom(): void;
}

export class OfficeScene {
  private app: Application | null = null;
  private camera: Camera | null = null;
  private readonly world = new Container();
  private readonly floor = new Container();
  private readonly things = new Container();
  private readonly overlay = new Container();
  private textures: Textures = {};
  private manifest: PackManifest | null = null;
  private layout: FloorLayout = layoutFloor([]);
  private shape = '';
  private model: FloorModel | null = null;
  private desks = new Map<string, { view: DeskView; overlay: DeskOverlay }>();
  private signs = new Map<string, RoomSign>();
  private focused: string | null = null;
  private roomScale = 1;
  private destroyed = false;
  private readonly reducedMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  frameMs = 0;

  constructor(private readonly handlers: SceneHandlers) {
    this.things.sortableChildren = true;
    this.world.addChild(this.floor, this.things);
  }

  async mount(host: HTMLElement): Promise<void> {
    const app = new Application();
    await app.init({ resizeTo: host, background: 0x0f1115, antialias: false, autoDensity: true, resolution: window.devicePixelRatio || 1 });
    if (this.destroyed) return app.destroy(true, { children: true });
    this.app = app;
    host.appendChild(app.canvas);
    const pack = generatedPack();
    this.manifest = pack.manifest;
    const source = Texture.from(pack.canvas).source;
    source.scaleMode = 'nearest';
    for (const [key, def] of Object.entries(pack.manifest.sprites)) {
      this.textures[key] = def.frames.map((f) => new Texture({ source, frame: new Rectangle(f.x, f.y, f.w, f.h) }));
    }
    app.stage.addChild(this.world, this.overlay);
    this.camera = new Camera(app.canvas);
    this.camera.onUserMove = () => {
      if (this.focused && this.camera && this.camera.target.scale < this.roomScale * 0.6) this.handlers.onLeaveRoom();
    };
    let t0 = 0;
    app.ticker.add(() => (t0 = performance.now()), undefined, UPDATE_PRIORITY.INTERACTION);
    app.ticker.add(() => this.tick());
    app.ticker.add(() => (this.frameMs = this.frameMs * 0.9 + (performance.now() - t0) * 0.1), undefined, UPDATE_PRIORITY.UTILITY);
    const onVisibility = () => (document.hidden ? app.ticker.stop() : app.ticker.start());
    document.addEventListener('visibilitychange', onVisibility);
    this.cleanup = () => document.removeEventListener('visibilitychange', onVisibility);
    if (this.model) this.rebuild(this.model, true);
  }

  private cleanup: () => void = () => {};

  destroy(): void {
    this.destroyed = true;
    this.cleanup();
    this.camera?.destroy();
    this.app?.destroy(true, { children: true });
    this.app = null;
  }

  get fps(): number {
    return this.app?.ticker.FPS ?? 0;
  }

  get rendererName(): string {
    return this.app?.renderer.name ?? '—';
  }

  /** Same rooms and desks (ids, kinds, order) → only properties change; otherwise the floor is rebuilt. */
  setModel(model: FloorModel): void {
    const shape = model.rooms.map((r) => `${r.id}:${r.lit}[${r.desks.map((d) => `${d.id}:${d.kind}`).join(',')}]`).join('|');
    this.model = model;
    if (!this.app) return;
    if (shape !== this.shape) return this.rebuild(model, this.shape === '');
    for (const room of model.rooms) {
      this.signs.get(room.id)?.apply(room);
      for (const d of room.desks) {
        const desk = this.desks.get(d.id);
        desk?.view.apply(d);
        desk?.overlay.apply(d);
      }
    }
  }

  focusRoom(roomId: string | null, snap = false): void {
    this.focused = roomId;
    if (!this.camera) return;
    const placed = roomId ? this.layout.rooms.find((r) => r.id === roomId) : undefined;
    this.camera.frameBox(placed ? placedRoomBounds(placed, WALL_H) : floorBounds(this.layout, WALL_H), snap);
    if (placed) this.roomScale = this.camera.target.scale;
  }

  private rebuild(model: FloorModel, snap: boolean): void {
    if (!this.manifest) return;
    this.shape = model.rooms.map((r) => `${r.id}:${r.lit}[${r.desks.map((d) => `${d.id}:${d.kind}`).join(',')}]`).join('|');
    this.layout = layoutFloor(model.rooms.map((r) => ({ id: r.id, desks: r.desks.length })));
    for (const layer of [this.floor, this.things, this.overlay]) layer.removeChildren().forEach((c) => c.destroy({ children: true }));
    this.desks.clear();
    this.signs.clear();
    model.rooms.forEach((room, i) => {
      const placed = this.layout.rooms[i];
      const ground: Graphics = drawRoom(placed, room.lit);
      ground.on('pointertap', () => this.clicked(() => this.handlers.onPickRoom(room.id)));
      this.floor.addChild(ground);
      const corner = toScreen(placed.origin.gx, placed.origin.gy);
      const sign = new RoomSign({ x: corner.x, y: corner.y - WALL_H - 6 }, room);
      sign.root.on('pointertap', () => this.clicked(() => this.handlers.onPickSign(room.id)));
      this.signs.set(room.id, sign);
      this.overlay.addChild(sign.root);
      room.desks.forEach((d, j) => {
        const cell = { gx: placed.origin.gx + placed.layout.desks[j].gx, gy: placed.origin.gy + placed.layout.desks[j].gy };
        const at = toScreen(cell.gx, cell.gy);
        const view = new DeskView(d, this.textures, this.manifest!, this.reducedMotion);
        view.root.position.set(at.x, at.y);
        view.root.zIndex = depthOf(cell);
        const overlay = new DeskOverlay({ x: at.x + view.head.x, y: at.y + view.head.y }, d);
        view.root.on('pointertap', () => this.clicked(() => this.handlers.onPickDesk(view.model.id, view.model.projectId)));
        view.root.on('pointerover', () => (overlay.hovered = true));
        view.root.on('pointerout', () => (overlay.hovered = false));
        this.things.addChild(view.root);
        this.overlay.addChild(overlay.root);
        this.desks.set(d.id, { view, overlay });
      });
    });
    const stillThere = this.focused && model.rooms.some((r) => r.id === this.focused);
    this.focusRoom(stillThere ? this.focused : null, snap);
  }

  /** A press that dragged the camera is not a click. */
  private clicked(fn: () => void): void {
    if ((this.camera?.dragged ?? 0) < 5) fn();
  }

  private tick(): void {
    if (!this.camera) return;
    const view = this.camera.tick();
    this.world.scale.set(view.scale);
    this.world.position.set(view.x, view.y);
    const t = performance.now() / 1000;
    const roomLevel = this.focused !== null || view.scale >= 0.9;
    for (const { view: desk, overlay } of this.desks.values()) {
      desk.update();
      overlay.place(view, roomLevel, t, this.reducedMotion);
    }
    for (const sign of this.signs.values()) sign.place(view);
  }
}
```

Note on the spec's "rooms slide to their new place with a tween": a rebuild re-frames the camera with easing (`snap` is false after the first build), which is what keeps the person oriented. Per-room position tweens are left out of v1 — a rebuild only happens when a tab is created or closed — and recorded as a follow-up in the spec (Task 9).

- [ ] **Step 5: Rewrite the harness**, `apps/web/src/office/harness.ts`, over the new scene and a synthetic model (`?rooms=N&desks=M`, `?room=<index>` to open inside a room, `?still=1` to stop the churn):

```ts
/** Dev tool: the office scene with synthetic data, no login and no server — for screenshots and frame timing. */
import type { TabState } from '../lib/types';
import { buildModel } from './model';
import type { OfficeRoom, OfficeSnapshot, OfficeTab } from '../lib/types';
import { OfficeScene } from './scene/OfficeScene';

const STATES: Array<TabState | null> = ['working', 'working', 'working', 'waiting_input', 'waiting_permission', 'idle', 'idle', 'error', null];
const q = new URLSearchParams(location.search);
const roomCount = Number(q.get('rooms')) || 6;
const deskMax = Number(q.get('desks')) || 8;
const at = new Date().toISOString();

const rooms: OfficeRoom[] = Array.from({ length: roomCount }, (_, r) => {
  const n = r === 1 ? 0 : 1 + ((r * 5) % deskMax);
  const tabs = Array.from({ length: n }, (_, i): OfficeTab => {
    const state = STATES[(r + i) % STATES.length];
    return { id: `t${r}-${i}`, project_id: `p${r}`, name: i === 0 ? 'um nome de aba bem comprido mesmo 🚀' : `aba ${i + 1}`, kind: i % 7 === 6 ? 'simulator' : 'terminal', tmux_session: null, simulator_udid: null, position: i, state, state_text: null, state_tool: null, state_at: state ? at : null, state_seen_at: null, created_at: at, alive: i % 9 !== 8, progress: i % 3 === 0 ? { task_id: 'k', title: 'Tarefa', done: i % 4, total: 4 } : null };
  });
  return { project: { id: `p${r}`, machine_id: 'm', name: r === 0 ? 'projeto com um nome enorme para testar o corte' : `projeto-${r}`, cwd: '/', status: r === 3 ? 'paused' : 'active', description: null, last_terminal_at: null, created_at: at }, tabs, tasks: r % 2 ? { todo: 2, doing: 1, done: r } : null };
});
let snapshot: OfficeSnapshot = { machine: { id: 'm', name: 'harness' } as never, reachable: true, rooms };

const hud = document.getElementById('hud')!;
const scene = new OfficeScene({
  onPickDesk: (id) => (hud.dataset.picked = id),
  onPickRoom: (id) => scene.focusRoom(id),
  onPickSign: (id) => (hud.dataset.sign = id),
  onLeaveRoom: () => scene.focusRoom(null),
});
await scene.mount(document.getElementById('host')!);
scene.setModel(buildModel(snapshot, () => undefined));
if (q.get('room')) scene.focusRoom(`p${q.get('room')}`, true);

if (!q.get('still')) {
  setInterval(() => {
    snapshot = { ...snapshot, rooms: snapshot.rooms.map((r) => ({ ...r, tabs: r.tabs.map((t) => (Math.random() < 0.1 ? { ...t, state: STATES[Math.floor(Math.random() * STATES.length)], state_at: new Date().toISOString() } : t)) })) };
    scene.setModel(buildModel(snapshot, () => undefined));
  }, 400);
}
setInterval(() => (hud.textContent = `${Math.round(scene.fps)} fps · ${scene.frameMs.toFixed(2)} ms/frame CPU · ${scene.rendererName}`), 500);
```

- [ ] **Step 6: Remove the spike scene and page now** so the build stays green:

```bash
git rm -q apps/web/src/office/OfficeScene.ts apps/web/src/pages/OfficeSpikePage.tsx
git mv apps/web/spike-office.html apps/web/office-harness.html
```

In `apps/web/src/App.tsx` delete the `OfficeSpikePage` lazy constant, its comment and the `/spike/office` route (leave the `lazy`/`Suspense` import; Task 8 uses it). In `office-harness.html` replace the first comment with `<!-- Dev tool: the office scene without login or server, for screenshots and frame timing. -->`.

- [ ] **Step 7: Typecheck and build.** `DOCKER 'npm run typecheck -w @termhub/web && npx -w @termhub/web vitest run && npm run build -w @termhub/web'` — Expected: PASS; the build output lists no `OfficeSpikePage` chunk.

- [ ] **Step 8: Verify by screenshot.** Start Vite in a container, then capture the floor and one room with the Playwright image:

```bash
docker run -d --rm --name office-vite -u "$(id -u):$(id -g)" -e HOME=/tmp -e VITE_HOST=0.0.0.0 -p 127.0.0.1:5199:5173 -v "$PWD:/w" -w /w node:20 npm run dev -w @termhub/web
mkdir -p /tmp/office-shots && cat > /tmp/office-shots/shot.mjs <<'EOF'
import { chromium } from 'playwright';
const b = await chromium.launch({ args: ['--enable-unsafe-swiftshader'] });
for (const [name, query] of [['floor', 'still=1'], ['room', 'still=1&room=2'], ['empty', 'still=1&rooms=1&desks=1'], ['many', 'still=1&rooms=14&desks=12']]) {
  const p = await b.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  p.on('pageerror', (e) => errors.push(String(e)));
  await p.goto(`http://127.0.0.1:5199/office-harness.html?${query}`);
  await p.waitForTimeout(2500);
  await p.screenshot({ path: `/s/${name}.png` });
  console.log(name, errors.length ? errors : 'no page errors', await p.textContent('#hud'));
  await p.close();
}
await b.close();
EOF
docker run --rm --network host --ipc=host -v /tmp/office-shots:/s -w /tmp mcr.microsoft.com/playwright:v1.63.0-noble sh -c 'npm i playwright@1.63.0 --no-audit --no-fund >/dev/null 2>&1 && cp /s/shot.mjs . && node shot.mjs'
docker rm -f office-vite
```

Expected: `no page errors` four times. **Open the four PNGs and check by eye**: (floor) every room has two back walls, a sign with its name, the paused room is dark, the empty room is drawn, markers are visible over desks and no desk label shows; (room) labels under desks are not covered by furniture, the long tab name ends in `…`, progress bars show `n/4`, the dead tab is an empty chair, the simulator desk has a phone; (many) no room overlaps another. Fix what is wrong before committing — the numbers in `PersonView`/`generated.ts` (seat point, head offset, cell sizes) are the expected place for adjustments.

- [ ] **Step 9: Commit**

```bash
git add -A apps/web
git commit -m "Office: PixiJS scene over the floor model; retire the spike scene"
```

---

### Task 8: The page — route, snapshot hook, focus mode, sidebar

**Files:**
- Create: `apps/web/src/office/useOfficeSnapshot.ts`, `apps/web/src/lib/focus.tsx`, `apps/web/src/pages/OfficePage.tsx`
- Modify: `apps/web/src/App.tsx`, `apps/web/src/components/Layout.tsx`, `apps/web/src/components/Sidebar.tsx` (next to the `/chat` `NavLink`, ~line 228)
- Test: `apps/web/src/lib/focus.test.tsx`

**Interfaces:**
- Consumes: `api.office`, `OfficeSnapshot` (Task 4); `buildModel`, `missingFromSnapshot` (Task 4); `OfficeScene` (Task 7); `useMonitor()` → `{ items, needsYou, tabState, connected }`; `useData()` → `{ machines, projects, statuses, loading }`; `useAuth()` → `{ can }`.
- Produces: routes `/office` and `/office/:machineId`; `FocusProvider`, `useFocusMode(): { focus: boolean; setFocus(on: boolean): void }`.

- [ ] **Step 1: Write the failing test**, `apps/web/src/lib/focus.test.tsx`:

```tsx
import { act, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { FocusProvider, useFocusMode } from './focus';

function Probe() {
  const { focus, setFocus } = useFocusMode();
  const { search } = useLocation();
  return (
    <button onClick={() => setFocus(!focus)} data-search={search}>
      {focus ? 'on' : 'off'}
    </button>
  );
}
const mount = (url: string) => render(<MemoryRouter initialEntries={[url]}><FocusProvider><Probe /></FocusProvider></MemoryRouter>);

describe('focus mode', () => {
  it('reads ?focus=1 from the URL, so a reload keeps it', () => {
    mount('/office/m1?room=p1&focus=1');
    expect(screen.getByRole('button').textContent).toBe('on');
  });
  it('writes the flag to the URL without losing the other params, and removes it when off', () => {
    mount('/office/m1?room=p1');
    const b = screen.getByRole('button');
    act(() => b.click());
    expect(b.textContent).toBe('on');
    expect(b.dataset.search).toBe('?room=p1&focus=1');
    act(() => b.click());
    expect(b.dataset.search).toBe('?room=p1');
  });
});
```

- [ ] **Step 2: Run it.** `DOCKER 'npx -w @termhub/web vitest run src/lib/focus.test.tsx'` — Expected: FAIL, cannot find `./focus`.

- [ ] **Step 3: Implement** `apps/web/src/lib/focus.tsx`:

```tsx
import { createContext, useCallback, useContext, useMemo, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';

interface FocusState {
  /** the page asked for the whole window: Layout hides the sidebar */
  focus: boolean;
  setFocus: (on: boolean) => void;
}

const FocusContext = createContext<FocusState>({ focus: false, setFocus: () => {} });

/** Focus mode lives in the URL (`?focus=1`): a second monitor left open all day must survive a reload. */
export function FocusProvider({ children }: { children: ReactNode }) {
  const [params, setParams] = useSearchParams();
  const focus = params.get('focus') === '1';
  const setFocus = useCallback(
    (on: boolean) =>
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (on) next.set('focus', '1');
          else next.delete('focus');
          return next;
        },
        { replace: true },
      ),
    [setParams],
  );
  const value = useMemo(() => ({ focus, setFocus }), [focus, setFocus]);
  return <FocusContext.Provider value={value}>{children}</FocusContext.Provider>;
}

export function useFocusMode(): FocusState {
  return useContext(FocusContext);
}
```

- [ ] **Step 4: Run it.** Expected: PASS.

- [ ] **Step 5: Make `Layout` honour it.** In `apps/web/src/components/Layout.tsx` import `FocusProvider, useFocusMode` from `'../lib/focus'`, wrap the returned tree in `<FocusProvider>` (outermost, above `DataProvider`), and move the sidebar choice into a small inner component so it can read the context:

```tsx
function Chrome({ collapsed, setCollapsed }: { collapsed: boolean; setCollapsed: (v: boolean) => void }) {
  const { focus } = useFocusMode();
  if (focus) return null;
  return collapsed ? <SidebarRail onExpand={() => setCollapsed(false)} /> : <Sidebar onCollapse={() => setCollapsed(true)} />;
}
```

and replace the `{collapsed ? <SidebarRail … /> : <Sidebar … />}` expression with `<Chrome collapsed={collapsed} setCollapsed={setCollapsed} />`.

- [ ] **Step 6: The snapshot hook**, `apps/web/src/office/useOfficeSnapshot.ts`:

```ts
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import type { OfficeSnapshot } from '../lib/types';

const REFRESH_MS = 60_000;

/**
 * The floor snapshot of one machine: read on mount, on window focus, every minute, and whenever
 * `reload` is called (a monitor push named a tab the snapshot lacks). A failed re-read keeps the
 * last snapshot on screen; only a failed first read is an error.
 */
export function useOfficeSnapshot(machineId: string | null): { snapshot: OfficeSnapshot | null; error: string | null; reload: () => void } {
  const [snapshot, setSnapshot] = useState<OfficeSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  const reload = useCallback(() => {
    if (!machineId || inFlight.current) return;
    inFlight.current = true;
    api
      .office(machineId)
      .then((s) => {
        setSnapshot(s);
        setError(null);
      })
      .catch(() => setError('Não foi possível carregar o escritório desta máquina.'))
      .finally(() => (inFlight.current = false));
  }, [machineId]);

  useEffect(() => {
    setSnapshot(null);
    setError(null);
    reload();
    const timer = setInterval(reload, REFRESH_MS);
    window.addEventListener('focus', reload);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', reload);
    };
  }, [reload]);

  return { snapshot, error: snapshot ? null : error, reload };
}
```

- [ ] **Step 7: The page**, `apps/web/src/pages/OfficePage.tsx`:

```tsx
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { useData } from '../lib/data';
import { useFocusMode } from '../lib/focus';
import { useMonitor } from '../lib/monitor';
import { buildModel, missingFromSnapshot } from '../office/model';
import { OfficeScene } from '../office/scene/OfficeScene';
import { useOfficeSnapshot } from '../office/useOfficeSnapshot';

/** The office: one machine's floor, live. URL is the state: /office/:machineId?room=<projectId>&focus=1 */
export function OfficePage() {
  const { machineId } = useParams();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const { can } = useAuth();
  const { machines, projects, statuses, loading } = useData();
  const { items, needsYou, tabState, connected } = useMonitor();
  const { focus, setFocus } = useFocusMode();
  const { snapshot, error, reload } = useOfficeSnapshot(machineId ?? null);
  const hostRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<OfficeScene | null>(null);
  const room = params.get('room');
  const autoDrilled = useRef(false);
  const [failed, setFailed] = useState(false);

  const setRoom = (id: string | null, replace = false) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (id) next.set('room', id);
        else next.delete('room');
        return next;
      },
      { replace },
    );
  const setRoomRef = useRef(setRoom);
  setRoomRef.current = setRoom;

  const model = useMemo(() => (snapshot ? buildModel(snapshot, tabState) : null), [snapshot, tabState, items]);

  // a tab opened since the snapshot: re-read it
  useEffect(() => {
    const mine = new Set(projects.filter((p) => p.machine_id === machineId).map((p) => p.id));
    const projectOf = (tabId: string) => items.find((i) => i.tab.id === tabId)?.project.id;
    if (missingFromSnapshot(snapshot, items.map((i) => i.tab.id), mine, projectOf)) reload();
  }, [items, snapshot, projects, machineId, reload]);

  useEffect(() => {
    if (!hostRef.current) return;
    const scene = new OfficeScene({
      onPickDesk: (tabId, projectId) => window.open(`/projects/${projectId}?tab=${tabId}`, '_blank', 'noopener'),
      onPickRoom: (id) => setRoomRef.current(id),
      onPickSign: (id) => navigate(`/projects/${id}`),
      onLeaveRoom: () => setRoomRef.current(null),
    });
    sceneRef.current = scene;
    // Pixi falls back from WebGL to canvas by itself; this only fires when neither could start
    scene.mount(hostRef.current).catch(() => setFailed(true));
    return () => {
      scene.destroy();
      sceneRef.current = null;
    };
  }, [navigate, machineId]);

  useEffect(() => {
    if (model) sceneRef.current?.setModel(model);
  }, [model]);

  // auto-drill once per machine: exactly one room with desks opens straight into it
  useEffect(() => {
    if (!model || autoDrilled.current) return;
    autoDrilled.current = true;
    const withDesks = model.rooms.filter((r) => r.desks.length > 0);
    if (!room && withDesks.length === 1) setRoomRef.current(withDesks[0].id, true);
  }, [model, room]);
  useEffect(() => {
    autoDrilled.current = false;
  }, [machineId]);

  const roomExists = !!model?.rooms.some((r) => r.id === room);
  useEffect(() => {
    if (model) sceneRef.current?.focusRoom(roomExists ? room : null);
  }, [room, roomExists, model === null]);

  // Esc leaves the room first, then focus mode; F toggles focus mode
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)) return;
      if (e.key === 'Escape') {
        if (room) setRoomRef.current(null);
        else if (focus) setFocus(false);
      } else if ((e.key === 'f' || e.key === 'F') && !e.metaKey && !e.ctrlKey && !e.altKey) {
        setFocus(!focus);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [room, focus, setFocus]);

  if (!can('projects', 'read') || !can('terminals', 'read')) return <Navigate to="/" replace />;
  if (loading) return <Message>Carregando…</Message>;
  if (machines.length === 0) {
    return (
      <Message>
        Nenhuma máquina cadastrada ainda. <Link className="text-accent hover:underline" to="/">Cadastre a primeira</Link> para ver o escritório.
      </Message>
    );
  }
  if (!machineId || !machines.some((m) => m.id === machineId)) return <Navigate to={`/office/${machines[0].id}`} replace />;

  const online = statuses[machineId]?.online !== false;
  const needsYouByMachine = (id: string) => needsYou.some((i) => i.machine.id === id);

  return (
    <div className="flex h-full flex-col">
      {!focus && (
        <div className="flex flex-wrap items-center gap-3 border-b border-line bg-bg-2 px-3 py-2 text-xs text-fg-muted">
          <span className="text-sm font-semibold text-fg">Escritório</span>
          {machines.length > 1 && (
            <select aria-label="Máquina" className="rounded border border-line bg-bg-3 px-2 py-1 text-fg" value={machineId} onChange={(e) => navigate(`/office/${e.target.value}`)}>
              {machines.map((m) => (
                <option key={m.id} value={m.id}>
                  {needsYouByMachine(m.id) ? '● ' : ''}
                  {m.name}
                </option>
              ))}
            </select>
          )}
          {room && roomExists && (
            <button className="rounded px-2 py-1 hover:bg-bg-3 hover:text-fg" onClick={() => setRoom(null)}>
              ← voltar ao andar
            </button>
          )}
          <span className="ml-auto flex items-center gap-3">
            {!online && <span className="text-warn">máquina offline</span>}
            {snapshot && !snapshot.reachable && online && <span className="text-warn">sem resposta do tmux: abas aparecem como fechadas</span>}
            {!connected && <span className="text-warn">reconectando…</span>}
            <button className="rounded px-2 py-1 hover:bg-bg-3 hover:text-fg" onClick={() => setFocus(true)} title="Modo foco (F)">
              modo foco
            </button>
          </span>
        </div>
      )}
      <div className="relative min-h-0 flex-1">
        <div ref={hostRef} className={`absolute inset-0 overflow-hidden ${online ? '' : 'opacity-60'}`} />
        {focus && (
          <button className="absolute right-3 top-3 rounded bg-bg-2/80 px-2 py-1 text-xs text-fg-muted hover:text-fg" onClick={() => setFocus(false)}>
            sair do foco (Esc)
          </button>
        )}
        {failed && <Overlay>Seu navegador não conseguiu desenhar o escritório.</Overlay>}
        {error && <Overlay>{error}</Overlay>}
        {!error && !snapshot && <Overlay>Carregando o andar…</Overlay>}
        {model && model.rooms.length === 0 && <Overlay>Esta máquina ainda não tem projetos.</Overlay>}
      </div>
    </div>
  );
}

function Message({ children }: { children: React.ReactNode }) {
  return <div className="flex h-full items-center justify-center px-6 text-center text-sm text-fg-muted">{children}</div>;
}

function Overlay({ children }: { children: React.ReactNode }) {
  return <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-fg-muted">{children}</div>;
}
```

Before relying on `statuses[machineId]?.online`, open `MachineStatus` in `apps/web/src/lib/types.ts` and use its real online field; and confirm `MonitorItem.machine.id` is what `needsYou` items carry (it is, per `MonitorItem`).

- [ ] **Step 8: Route and sidebar.** In `apps/web/src/App.tsx`:

```tsx
// lazy so PixiJS stays out of the main bundle
const OfficePage = lazy(() => import('./pages/OfficePage').then((m) => ({ default: m.OfficePage })));
```

and, inside the `<Route element={<Layout />}>` group:

```tsx
              <Route path="/office" element={<Suspense fallback={null}><OfficePage /></Suspense>} />
              <Route path="/office/:machineId" element={<Suspense fallback={null}><OfficePage /></Suspense>} />
```

In `apps/web/src/components/Sidebar.tsx`, right before the `{can('chat') && (` block, add (and take `needsYou` from `useMonitor()` if the component does not already have it):

```tsx
        {can('projects', 'read') && can('terminals', 'read') && (
          <NavLink to="/office" className={({ isActive }) => `flex items-center justify-between rounded px-2 py-1 text-xs ${isActive ? 'bg-bg-4 text-fg' : 'text-fg-muted hover:bg-bg-3 hover:text-fg'}`}>
            Escritório
            {needsYou.length > 0 && <i className="h-1.5 w-1.5 rounded-full bg-attention" aria-label="alguém precisa de você" />}
          </NavLink>
        )}
```

- [ ] **Step 9: Verify.** `DOCKER 'npm run typecheck -w @termhub/web && npx -w @termhub/web vitest run && npm run build -w @termhub/web'` — Expected: PASS; the build lists an `OfficePage-*.js` chunk and `index-*.js` stays within a few kB of 898 kB (it must not absorb PixiJS). Then confirm nothing outside the office imports PixiJS:

```bash
grep -rln "from 'pixi.js'" apps/web/src | grep -v '^apps/web/src/office/\(scene\|pack\)/' && echo LEAK || echo "pixi stays inside office/"
```

Expected: `pixi stays inside office/`.

- [ ] **Step 10: Commit**

```bash
git add -A apps/web
git commit -m "Office: /office page with machine selector, focus mode and sidebar entry"
```

---

### Task 9: Spec notes, full verification, pull request

**Files:**
- Modify: `docs/superpowers/specs/2026-09-21-office-world-design.md`

- [ ] **Step 1: Record what the implementation settled**, in the spec:
  - Section 6, sprite contract: floor tiles and walls are drawn by the scene from colours, not pack sprites (they scale with the room); a person is three tinted layers (`body`, `shirt`, `hair`); the v1 pack is painted at runtime by `office/pack/generated.ts` rather than shipped as files under `public/` — a folder-based loader arrives with the first second pack.
  - Section 5, stability: a rebuild eases the camera to the new framing; per-room slide tweens are a follow-up.
  - Section 8, states of the page: an offline machine shows "máquina offline" and a dimmed floor; "offline desde …" needs a timestamp `MachineStatus` does not carry, so it is a follow-up.
  - Section 3, out of v1: add "per-room slide tweens on repack" and "folder-based pack loader".

- [ ] **Step 2: Full verification, as CLAUDE.md requires before a push.**

```bash
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/w" -w /w node:20 sh -c \
  'npm ci --no-audit --no-fund >/dev/null && npm run prisma:generate >/dev/null && npm run build:packages >/dev/null \
   && npm run typecheck -w @termhub/server && npm test -w @termhub/server && npm test -w @termhub/web \
   && npm run build -w @termhub/web && npm run build -w @termhub/landing'
rm -rf .npm
```

Expected: every command exits 0. Read the output for the word `failed`; do not pipe it through `tail` (that hides the exit code).

- [ ] **Step 3: Re-run the screenshot check of Task 7 Step 8** and look at the images again — Task 8 did not touch the scene, this guards against an accidental change.

- [ ] **Step 4: Commit, push, open the PR.**

```bash
git add docs/superpowers/specs/2026-09-21-office-world-design.md
git commit -m "Docs: record what the office implementation settled"
git push -u origin feat/office-world
gh pr create --base main --title "Office: live isometric view of a machine's floor at /office" --body-file - <<'EOF'
Implements `docs/superpowers/specs/2026-09-21-office-world-design.md`.

- `GET /api/office/:machineId`: the floor snapshot (projects, tabs with `alive`, board progress; the board part only with `tasks:read`).
- `/office`: one continuous PixiJS scene per machine — rooms per project, a person per tab animated from the live monitor state, camera between floor and room, click-through to the terminal, focus mode in the URL.
- Art is a pack behind a manifest contract; v1's pack is painted by code.
- The `/spike/office` route and the spike scene are removed; the login-free harness stays as a dev tool (`office-harness.html`).
- No schema change. PixiJS stays in lazy chunks; the main bundle is unchanged.

Verified locally: server typecheck and tests, web tests and build, landing build, and harness screenshots of the floor, a room, the empty case and a 14-room floor.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
```

- [ ] **Step 5: After the merge and deploy,** open `https://app.termhub.dev/office` logged in and check against the spec's success criteria: a real tab changing state updates without reload; a waiting tab is noticeable from the floor; clicking a person opens its terminal; `F` and `?focus=1` survive a reload; `/spike/office` redirects home.
