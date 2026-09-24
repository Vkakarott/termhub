# City by Project Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the project the unit of the office and of the public city: one building per project, whose desks are the project's agents (tabs) on whatever machine they run, with the machine reduced to a tag on each desk in the private office and absent from the public city altogether.

**Architecture:** One PR on `feat/city-by-project`, executed in two parts by two implementers in sequence. **Part A (server)** gives `Project` its public id and takes `Machine`'s away, replaces the per-machine floor read with one city read (`buildOfficeCity` + `GET /api/office`, every machine probed in parallel), rebuilds the public payload, frames, card and link-preview document around published projects (`PublicBuilding { id, name, robots }`), and moves the live channel to a (published projects × owned machines) rule with `RobotsGone` on the public bus. **Part B (web)** takes the new DTO through one model (`buildCityModel(city: ModelCity)`), a scene with one block per building and no room level, one hook for the whole city (`useOfficeCity`), the page and its share rules, the public city bundle (URL, adapter, frames, trail, share media), and the "Minha cidade"/publish copy.

**Tech Stack:** Fastify 5 + Prisma 7 + zod 3 (server), React 18 + react-router 7 + PixiJS 8.21 + Vite 6 (web), Vitest 3 + Testing Library (jsdom), Playwright 1.63 for the real-browser smoke.

**Spec:** `docs/superpowers/specs/2026-09-24-city-by-project-design.md` (supersedes the "what a city is" amendment of `2026-09-22-public-city-design.md` and §4 of `2026-09-21-office-world-design.md`). Read it before starting; every task below argues from it.

## Global Constraints

- **The host has no Node.** Every npm/npx command runs from the worktree root (`/home/pedrogoiania/termhub-wt-city-project`) as `docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/w" -w /w node:20 sh -c '<cmd>'` then `rm -rf .npm`. Below, `DOCKER '<cmd>'` means exactly that pair. Never pipe a test, typecheck or build command through `tail`/`head` in a way that hides its exit code.
- **First, once:** `node_modules` is not installed in this worktree. Before Task A1 run `DOCKER 'npm ci && npm run prisma:generate && npm run build:packages'` (the Prisma client under `apps/server/src/generated/` is committed; no schema change in this plan, so it is never regenerated for a commit).
- **Server unit tests need a dummy `DATABASE_URL`** (`config.ts` exits without one, and many test files import it). `SRVTEST <files>` means `DOCKER 'DATABASE_URL=postgresql://unused:unused@127.0.0.1:1/unused npx -w @termhub/server vitest run <files>'`. File paths are relative to `apps/server` (e.g. `src/office/snapshot.test.ts`); with no files it runs the whole server suite.
- **DB tests need `TERMHUB_DB_TESTS=1` with a throwaway `postgres:16`** (`--rm`, unique name prefix `pccp-`) and `prisma migrate deploy`. `DBTEST <files>` means exactly:
  ```bash
  docker run -d --rm --name pccp-db -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=termhub -p 127.0.0.1:55461:5432 postgres:16
  until docker exec pccp-db pg_isready -h 127.0.0.1 -U postgres -d termhub >/dev/null 2>&1; do sleep 1; done
  docker run --rm --network host -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/w" -w /w node:20 sh -c 'export DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55461/termhub TERMHUB_DB_TESTS=1; cd apps/server && npx prisma migrate deploy && npx vitest run <files>'
  rm -rf .npm
  docker stop pccp-db
  ```
  (`--network host` lets the test container reach the throwaway database; `-h 127.0.0.1` makes `pg_isready` wait for the real server, not the init-time one.)
- **Web tests run with `CI=1`, after `npm run build:city -w @termhub/web`** (under `CI` the bundle guard in `apps/web/src/city/bundle.test.ts` refuses to skip). `WEBTEST <files>` means `DOCKER 'CI=1 npx -w @termhub/web vitest run <files>'` (paths relative to `apps/web`); `WEBSUITE` means `DOCKER 'npm run build:city -w @termhub/web && CI=1 npm test -w @termhub/web'`.
- **Language:** code, comments, identifiers, commit messages and repo docs in **English**; **UI copy in Portuguese (pt-BR)**, exactly as written in this plan. Commit subjects follow the repo style `Area: imperative subject` (≤ 72 chars).
- **Architecture rules:** routes never import Prisma (go through `apps/server/src/db/repositories`); every request input is validated with zod; log metadata only (ids, counts, a cause code — never a tab name, a project name, a request body or terminal content).
- **THE PRIVACY RULE:** every public byte is produced by `toPublicCity` / `toPublicRobot` / `toPublicRobotFrame` / `toPublicRobotGone` in `apps/server/src/public/city.ts`, which **name every field they emit**. Never spread a `Tab`, `Project`, `Machine` or `User` into a public payload. **No machine data in the public shape** — no machine id, name, subtitle, or anything derived from one (not even an HMAC of a machine id).
- **The public bundle rule:** `apps/web/src/city/**` imports only from `apps/web/src/office/**`, `apps/web/src/lib/types.ts`, its own `city/` files and npm packages — never `lib/api.ts`, `lib/auth.tsx`, `lib/monitor.tsx`, `lib/public-city.ts` or `App.tsx`. `apps/web/src/office/model.ts` (which the bundle imports) must therefore stay free of those too. `apps/web/src/city/bundle.test.ts` guards both the source and the built output.
- **PixiJS is imported only under `apps/web/src/office/scene/` and `apps/web/src/office/pack/`.** New pure helpers that the scene uses (`scene/shape.ts`, `scene/detail.ts`) import no PixiJS, so they can be unit-tested.
- **Never touch production:** never stop, remove, restart or reuse the name of `termhub-*`, `proxy-*` or any `*-app-*` container; never run `deploy/blue-green.sh`; never read from or write to `/mnt/hd2tb/projetos/termhub` (the production checkout). Throwaway containers in this plan are named `pccp-db`, `pccp-app`, `pccp-vite`. Work only in the worktree.
- Address workspaces by package name (`-w @termhub/server`, `-w @termhub/web`), never by path.
- **Every commit ends with the trailer** (after a blank line): `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`
- **Branch:** `feat/city-by-project` in the worktree above (already checked out, carrying the spec and this plan). Commit per task; do not push, do not open the PR — that is the controller's call after the whole-branch review.
- **Typecheck windows.** Part A keeps `npm run typecheck -w @termhub/server` green after every task. Part B changes one set of shared types that the scene, the page, the harness and the city bundle all read, so the **web** typecheck is expected to be red after Task B1 in exactly the files the later tasks rewrite (listed in each task) and green again from the end of Task B6. Each task runs its own tests, which Vitest runs without typechecking.

## Review Focus

1. **A link or bookmark from the city-by-machine era** — `/city/@nick/<machine-hmac>?room=<room-hmac>`, `card.png?building=<machine-hmac>&room=…`, `/office/<machineId>?room=<projectId>`. A person clicking an old link expects the city, never an error, a blank page or a stale trail. Pinned in Task A4 (`cityMetaFor`/`buildCardSvg` fall back to the city and `depthFromCityUrl` ignores `?room=`), Task B4 (`/office/m1?room=p1&focus=1` lands on `/office?focus=1`) and Task B6 (the page opens an old link as the city with no trail).
2. **A tab of a published project on a machine the owner does not own** (a cross-owner link, or a machine transferred away). It must never be a robot — not in the snapshot, not in a live frame, not in a `robot_gone` — while the building stays. Pinned in Task A4 (`read.db.test.ts`, `public-city.test.ts`) and Task A5 (`ws.test.ts`: frame and gone both refused for `mB`).
3. **One machine that does not answer while the others do** (an ssh timeout, an agent that dropped, a probe that throws). The office must still load in one request; only that machine's desks keep their last state, dimmed, and the building says "sem resposta". Pinned in Task A3 (a throwing probe marks its machine unreachable and the answer is 200), Task B1 (dimmed desk, `silent` notice, hands kept up) and Task B4 ("tmux sem resposta" at the building's rest).
4. **A published project with no agent of the owner's own right now** (no tab, or all of them on somebody else's machine). It is still a building — the city must not 404, the card must still count it, and the sign says "sem agentes agora". Pinned in Task A4 (`read.db.test.ts`, `public-city.test.ts`, `card.test.ts` "0 agentes trabalhando"), Task B2 (`buildingSignText`) and Task B7 ("publicado · 0 agentes agora", no "nada publicado" warning).
5. **Unpublishing one of several buildings while a visitor watches.** The spec's "`unpublished` still closes the socket when its last building leaves" would, read literally, leave a now-private building on screen until a reload. The building must leave at once, whatever else is still published. Pinned in Task A5 (`ws.test.ts`: unpublishing `p4` with `p1` still public hangs the socket up, and the page re-reads the snapshot).

---

## File Structure

```
Part A — server
apps/server/src/db/repositories/types.ts                 Project.public_id (mapProject); Machine.public_id removed (mapMachine)
apps/server/src/db/repositories/machine-mapper.test.ts   no public id on a machine
apps/server/src/db/repositories/project-mapper.test.ts   NEW  the project's public id
apps/server/src/office/snapshot.ts / .test.ts            buildOfficeCity, OfficeCity/OfficeBuilding/OfficeMachine (replaces buildOfficeSnapshot)
apps/server/src/routes/office.ts / .test.ts              GET /api/office?fresh= (replaces /office/:machineId)
apps/server/src/app.ts                                   officeRoutes gets `agents`
apps/server/src/public/city.ts / .test.ts                PublicBuilding { id, name, robots }; frames without room
apps/server/src/public/read.ts / read.test.ts / read.db.test.ts   resolvePublicCity, readPublicCity by project; memo on RobotsGone
apps/server/src/public/card.ts / .test.ts                ?building= only; "N projetos · M agentes trabalhando"
apps/server/src/public/city-page.ts / .test.ts           building depth only; new building description
apps/server/src/routes/public-city.ts / .test.ts         card query without room
apps/server/src/frontend.test.ts                         the snapshot's building id is the project's
apps/server/src/public/bus.ts                            RoomsGone -> RobotsGone
apps/server/src/public/ws.ts / .test.ts                  (published projects × owned machines) rule
apps/server/src/routes/projects.ts, routes/machines.ts   publishRobotsGone
apps/server/src/routes/projects.publish.test.ts, routes/machines.owner.test.ts
apps/server/src/public/public-id.ts / .test.ts           kinds 'project' | 'tab'; publicRoomId removed

Part B — web
apps/web/src/lib/types.ts                                OfficeCity/OfficeBuilding/OfficeMachine; PublicBuilding.robots; Project.public_id; Machine.public_id removed
apps/web/src/lib/api.ts                                  api.office(fresh)
apps/web/src/office/model.ts / .test.ts                  ModelCity -> CityModel { buildings }, DeskModel.machine, deskMachineLine, FocusTarget building
apps/web/src/city/api.ts / .test.ts                      toBuildingEntries, frames by building
apps/web/src/office/layout/floor.ts / .test.ts           one floor per building
apps/web/src/office/layout/city.ts / .test.ts            BlockInput { id, desks }, floorOnCity
apps/web/src/office/layout/shelves.ts                    doc comment only
apps/web/src/office/scene/shape.ts / .test.ts            NEW  shapeOf (b{d:kind})
apps/web/src/office/scene/detail.ts / .test.ts           deskLabelsVisible, buildingSignText, SIGN_SCALE, LABEL_SCALE
apps/web/src/office/scene/RoomView.ts                    drawFloor
apps/web/src/office/scene/Overlay.ts                     DeskOverlay machine line; BuildingSign
apps/web/src/office/scene/OfficeScene.ts                 one block per building; new handlers
apps/web/src/office/useOfficeCity.ts / .test.tsx         NEW  one read for the whole city
apps/web/src/office/useOfficeSnapshots.ts / .test.tsx    DELETED
apps/web/src/pages/OfficePage.tsx / .test.tsx            /office and /office/:projectId; ladder; share by project
apps/web/src/App.tsx                                     route param :projectId
apps/web/src/office/harness-data.ts / .test.ts           NEW  synthetic city for the harness
apps/web/src/office/harness.ts                           ?projects=&desks=&project=&churn=
apps/web/src/city/url.ts / .test.ts                      Rest { building }
apps/web/src/city/CityPage.tsx / .test.tsx               building depth, trail, old links
apps/web/src/city/share/compose.ts / .test.ts, sound.ts / .test.ts   walk buildings -> desks
apps/web/src/city/share/SharePanel.test.tsx, record.story.test.ts    fixtures
apps/web/src/components/MyCityView.tsx / .test.tsx       "publicado · N agentes agora" / "não publicado"
apps/web/src/components/PublishControl.tsx               confirm-panel copy
apps/web/src/pages/ProjectPage.test.tsx                  confirm-panel copy
docs/superpowers/specs/2026-09-22-public-city-design.md, 2026-09-21-office-world-design.md, 2026-09-24-city-by-project-design.md   superseded notes, status
```

No change is needed in `apps/web/src/lib/focus.tsx` (`focusAppliesTo` already accepts any `/office/*`) or `apps/web/src/components/Layout.test.tsx` (it only mounts `/office?focus=1`).

---
# Part A — server

Part A leaves the web app reading the old shapes (it compiles, since it has its own types, but its office and city pages are wrong at runtime until Part B lands in the same PR). Part B's implementer starts from the shapes in the **Interfaces** blocks below, which are exactly what Part A's code produces.

### Task A1: The project carries its public id; the machine no longer does

**Files:**
- Modify: `apps/server/src/db/repositories/types.ts` (`interface Machine` lines 61-88, `interface Project` lines 90-104, `mapMachine` line 268, `mapProject` lines 271-282)
- Modify: `apps/server/src/routes/machines.owner.test.ts:10` (fixture)
- Test: `apps/server/src/db/repositories/machine-mapper.test.ts`
- Create: `apps/server/src/db/repositories/project-mapper.test.ts`

**Interfaces:**
- Consumes: `publicId(kind, realId)` from `apps/server/src/public/public-id.ts` (unchanged here; its `'machine'`/`'room'` kinds go in Task A6).
- Produces:
  - `Project.public_id: string` = `publicId('project', project.id)`, on every `Project` the repositories return (so on `GET /api/projects`, `GET /api/projects/:id`, and on `OfficeBuilding.project` in Task A2). It reaches only authenticated callers; the public payload names its own fields and never carries it.
  - `Machine` has **no** `public_id` any more (nothing on the server read it; the web's copy of the type drops it in Task B1).

- [ ] **Step 1: Write the failing tests.** Append to `apps/server/src/db/repositories/machine-mapper.test.ts`, inside `describe('mapMachine', …)`:

```ts
  // city-by-project §2.3: nothing on the street is a machine any more, so a machine has no public id
  it('carries no public id', () => {
    expect('public_id' in mapMachine(row())).toBe(false);
  });
```

Create `apps/server/src/db/repositories/project-mapper.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { Project as PrismaProject } from '../../generated/prisma/client.js';
import { publicId } from '../../public/public-id.js';
import { mapProject } from './types.js';

const row = (over: Partial<PrismaProject> = {}): PrismaProject =>
  ({
    id: 'p1', ownerId: 'u1', key: 'ENG', nextTaskNumber: 1, name: 'Engage Easy', status: 'active', description: null, isPublic: false,
    lastTerminalAt: null, createdAt: new Date('2026-09-24T00:00:00.000Z'), ...over,
  }) as PrismaProject;

describe('mapProject', () => {
  // city-by-project §2.3: the share button builds a building's link from this, with no new endpoint
  it("carries the project's building id on the public city", () => {
    expect(mapProject(row()).public_id).toBe(publicId('project', 'p1'));
    expect(mapProject(row({ id: 'p2' })).public_id).not.toBe(mapProject(row()).public_id);
  });
});
```

- [ ] **Step 2: Run them to see them fail.** `SRVTEST src/db/repositories/machine-mapper.test.ts src/db/repositories/project-mapper.test.ts` — Expected: FAIL, 2 failed (`'public_id' in …` is `true`; `mapProject(...).public_id` is `undefined`).

- [ ] **Step 3: Implement.** In `apps/server/src/db/repositories/types.ts`, delete these two lines from `interface Machine`:

```ts
  /** one-way id used on the public city; carrying it here costs nothing since it cannot be reversed */
  public_id: string;
```

and this line from `mapMachine`:

```ts
  public_id: publicId('machine', m.id),
```

In `interface Project`, replace

```ts
  /** published: readable by anyone with the /city/@nickname link */
  is_public: boolean;
```

with

```ts
  /** published: this project is a building on its owner's public city (/city/@nickname) */
  is_public: boolean;
  /**
   * The project's building id on its owner's public city (`publicId('project', id)`): one-way, so
   * carrying it to the person who already reads the real id costs nothing, and the share button
   * builds the building's link from it. Never part of the public payload (public/city.ts).
   */
  public_id: string;
```

and in `mapProject`, after `is_public: p.isPublic,` add:

```ts
  public_id: publicId('project', p.id),
```

(`publicId` is already imported at the top of the file.) In `apps/server/src/routes/machines.owner.test.ts` line 10, drop the stale field: `const machine = { id: 'm1', name: 'box', type: 'agent', owner_id: 'u1' } as Machine;`.

- [ ] **Step 4: Run them to see them pass, and typecheck.** `SRVTEST src/db/repositories/machine-mapper.test.ts src/db/repositories/project-mapper.test.ts src/routes/machines.owner.test.ts` — Expected: PASS (all tests in the three files). `DOCKER 'npm run typecheck -w @termhub/server'` — Expected: exit 0 (no server code reads `Machine.public_id`; only mappers build a `Project`).

- [ ] **Step 5: Commit.**

```bash
git add apps/server/src/db/repositories/types.ts apps/server/src/db/repositories/machine-mapper.test.ts apps/server/src/db/repositories/project-mapper.test.ts apps/server/src/routes/machines.owner.test.ts
git commit -m "Projects: carry the public city building id; machines no longer do

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task A2: `buildOfficeCity` — the office as one building per project

**Files:**
- Modify: `apps/server/src/office/snapshot.ts` (add; the old `buildOfficeSnapshot` stays until Task A3 switches the route)
- Test: `apps/server/src/office/snapshot.test.ts` (append a `describe`)

**Interfaces:**
- Consumes: `Project.public_id` is on every project (Task A1), but this function derives the id itself with `publicId('project', project.id)` so a fixture cannot drift from it. `TmuxProbe` (`apps/server/src/terminal/machine-exec.ts`: `{ reachable: boolean; sessions: Set<string>; cause?: string }`), `OfficeProgress`/`OfficeTabProgress`/`OfficeTaskCounts`, `Machine`, `MachineType`, `Project`, `Tab` from `db/repositories/types.ts`.
- Produces (exported from `apps/server/src/office/snapshot.ts`; `OfficeTab` already exists):

```ts
export interface OfficeTab extends Tab { alive: boolean; progress: OfficeTabProgress | null }  // Tab already carries machine_id
export interface OfficeBuilding { project: Project; public_id: string; tabs: OfficeTab[]; tasks: OfficeTaskCounts | null }
export interface OfficeMachine { id: string; name: string; subtitle: string | null; type: MachineType; online: boolean; reachable: boolean | null }
export interface OfficeCity { projects: OfficeBuilding[]; machines: OfficeMachine[] }
export function machineOnline(machine: Pick<Machine, 'id' | 'type'>, probe: TmuxProbe | undefined, agentOnline: (machineId: string) => boolean): boolean;
export function buildOfficeCity(input: {
  projects: Project[]; tabs: Tab[]; machines: Machine[];
  probes: Map<string, TmuxProbe>;                 // by machine id; absent = not probed
  agentOnline: (machineId: string) => boolean;
  simulatorReady: (machineId: string, udid: string) => boolean;
  progress: OfficeProgress | null;
}): OfficeCity;
```

  Rules: a building per non-archived project, in the order given, empty ones kept; `public_id = publicId('project', id)`; a terminal tab is `alive` when its **own machine's** probe is `reachable` and its `tmux_session` is in that probe's `sessions`; a simulator tab asks `simulatorReady(tab.machine_id, udid)`; `machines` are the ones given, each named field by field; `online`: agent → `agentOnline(id)`, local → `true`, ssh → `probe ? probe.reachable : true`; `reachable`: `probe ? probe.reachable : null`.

- [ ] **Step 1: Write the failing tests.** In `apps/server/src/office/snapshot.test.ts`, change the imports at the top to:

```ts
import { describe, expect, it, vi } from 'vitest';
import type { Machine, Project, Tab } from '../db/repositories/types.js';
import type { TmuxProbe } from '../terminal/machine-exec.js';
import { buildOfficeCity, buildOfficeSnapshot } from './snapshot.js';
import { publicId, publicRoomId } from '../public/public-id.js';
```

and append at the end of the file:

```ts
describe('buildOfficeCity', () => {
  const m = (id: string, over: Partial<Machine> = {}): Machine => ({ id, name: id, subtitle: null, type: 'agent', host: null, ssh_user: null, ...over }) as Machine;
  const probe = (sessions: string[], reachable = true): TmuxProbe => ({ reachable, sessions: new Set(sessions) });
  const base = { machines: [m('m1'), m('m2')], probes: new Map<string, TmuxProbe>(), agentOnline: () => true, simulatorReady: () => false, progress: null };

  it('makes a building per non-archived project, in the order given, empty ones kept, with every tab of the project whatever its machine', () => {
    const city = buildOfficeCity({
      ...base,
      projects: [project('b'), project('a'), project('z', { status: 'archived' })],
      tabs: [tab('t1', 'a'), tab('t2', 'a', { machine_id: 'm2' }), tab('t9', 'z')],
    });
    expect(city.projects.map((b) => b.project.id)).toEqual(['b', 'a']);
    expect(city.projects[0].tabs).toEqual([]);
    expect(city.projects[1].tabs.map((t) => [t.id, t.machine_id])).toEqual([['t1', 'm1'], ['t2', 'm2']]);
  });

  // The share button builds a building's link from this: the project's own public id, the same
  // whichever machines its desks run on.
  it("carries each building's public city id, derived from the project alone", () => {
    const city = buildOfficeCity({ ...base, projects: [project('a')], tabs: [] });
    expect(city.projects[0].public_id).toBe(publicId('project', 'a'));
  });

  it("reads a terminal tab alive from its own machine's probe", () => {
    const city = buildOfficeCity({
      ...base,
      projects: [project('a')],
      tabs: [tab('t1', 'a'), tab('t2', 'a', { machine_id: 'm2' }), tab('t3', 'a')],
      probes: new Map([['m1', probe(['th-t1', 'th-t2'])], ['m2', probe(['th-t2'], false)]]),
    });
    // t2's session is in m1's list, but t2 runs on m2, which could not be asked
    expect(city.projects[0].tabs.map((t) => [t.id, t.alive])).toEqual([['t1', true], ['t2', false], ['t3', false]]);
  });

  it('gives a machine nobody probed no reachable answer, and its terminal tabs read as not alive', () => {
    const city = buildOfficeCity({ ...base, projects: [project('a')], tabs: [tab('t1', 'a')] });
    expect(city.projects[0].tabs[0].alive).toBe(false);
    expect(city.machines.map((x) => [x.id, x.reachable])).toEqual([['m1', null], ['m2', null]]);
  });

  it("asks the simulator manager for simulator tabs, on the tab's own machine", () => {
    const sim = tab('s1', 'a', { kind: 'simulator', tmux_session: null, simulator_udid: 'UDID', machine_id: 'm2' });
    const ready = vi.fn((machineId: string, udid: string) => machineId === 'm2' && udid === 'UDID');
    const city = buildOfficeCity({ ...base, projects: [project('a')], tabs: [sim], simulatorReady: ready });
    expect(city.projects[0].tabs[0].alive).toBe(true);
    expect(ready).toHaveBeenCalledWith('m2', 'UDID');
  });

  it('says whether each machine is up: an agent by its connection, local always, ssh by its probe', () => {
    const city = buildOfficeCity({
      ...base,
      machines: [m('a1'), m('l1', { type: 'local' }), m('s1', { type: 'ssh' }), m('s2', { type: 'ssh' })],
      projects: [],
      tabs: [],
      probes: new Map([['s1', probe([], false)]]),
      agentOnline: (id) => id !== 'a1',
    });
    expect(city.machines.map((x) => [x.id, x.online])).toEqual([['a1', false], ['l1', true], ['s1', false], ['s2', true]]);
  });

  it('describes each machine field by field, never the whole record', () => {
    const city = buildOfficeCity({
      ...base,
      machines: [m('m1', { name: 'jarvis', subtitle: 'MacBook do escritório', host: '10.0.0.9', ssh_user: 'pedro' })],
      projects: [],
      tabs: [],
      probes: new Map([['m1', probe([])]]),
    });
    expect(city.machines[0]).toEqual({ id: 'm1', name: 'jarvis', subtitle: 'MacBook do escritório', type: 'agent', online: true, reachable: true });
    expect(JSON.stringify(city)).not.toContain('10.0.0.9');
  });

  it('carries progress when given and nulls when the person cannot read tasks', () => {
    const progress = { counts: { a: { todo: 1, doing: 1, done: 2 } }, byTab: { t1: { task_id: 'k', title: 'Ship', done: 1, total: 3 } } };
    const input = { ...base, projects: [project('a'), project('b')], tabs: [tab('t1', 'a')] };
    const withTasks = buildOfficeCity({ ...input, progress });
    expect(withTasks.projects[0].tasks).toEqual({ todo: 1, doing: 1, done: 2 });
    expect(withTasks.projects[0].tabs[0].progress).toEqual({ task_id: 'k', title: 'Ship', done: 1, total: 3 });
    expect(withTasks.projects[1].tasks).toEqual({ todo: 0, doing: 0, done: 0 });
    const without = buildOfficeCity({ ...input, progress: null });
    expect(without.projects[0].tasks).toBeNull();
    expect(without.projects[0].tabs[0].progress).toBeNull();
  });
});
```

(`project(...)` and `tab(...)` are the helpers already at the top of the file; `tab` puts every tab on `m1` unless told otherwise.)

- [ ] **Step 2: Run them to see them fail.** `SRVTEST src/office/snapshot.test.ts` — Expected: the 5 old `buildOfficeSnapshot` tests pass; the 8 new ones FAIL with `buildOfficeCity is not a function`.

- [ ] **Step 3: Implement.** In `apps/server/src/office/snapshot.ts`, change the imports to:

```ts
import { publicId, publicRoomId } from '../public/public-id.js';
import type { Machine, MachineType, OfficeProgress, OfficeTabProgress, OfficeTaskCounts, Project, Tab } from '../db/repositories/types.js';
import type { TmuxProbe } from '../terminal/machine-exec.js';
```

and append:

```ts
/** One building of the office city: a project and every desk (tab) it has, whatever machine each runs on. */
export interface OfficeBuilding {
  project: Project;
  /** the building's id on the owner's public city (`publicId('project', id)`), for the share link */
  public_id: string;
  tabs: OfficeTab[];
  /** null = the person cannot read tasks */
  tasks: OfficeTaskCounts | null;
}

/** A machine one of the city's desks runs on: a detail of the desk (its tag, its offline state), never a building. */
export interface OfficeMachine {
  id: string;
  name: string;
  subtitle: string | null;
  type: MachineType;
  /** agent: connected now; local: always; ssh: its probe answered, or it was not asked */
  online: boolean;
  /** the tmux probe: false = it could not ask the machine; null = not probed (no terminal desk runs there) */
  reachable: boolean | null;
}

export interface OfficeCity {
  /** the scope's non-archived projects, in the order given (by name, like the sidebar), empty ones kept */
  projects: OfficeBuilding[];
  /** every machine a desk refers to */
  machines: OfficeMachine[];
}

/** Whether a machine is up: the rule the MCP's list_machines uses (control/inventory.ts), with the probe answering for ssh. */
export function machineOnline(machine: Pick<Machine, 'id' | 'type'>, probe: TmuxProbe | undefined, agentOnline: (machineId: string) => boolean): boolean {
  if (machine.type === 'agent') return agentOnline(machine.id);
  if (machine.type === 'local') return true;
  // nothing but the probe ever answers for an ssh machine; not asked counts as up, as "checking" does in the app
  return probe ? probe.reachable : true;
}

/**
 * The whole office: a building per non-archived project (in the order given — the repository sorts
 * by name, like the sidebar), each with every one of its tabs whatever machine it runs on, and the
 * machines those tabs run on. A terminal tab is alive when its own machine's probe reached tmux and
 * its session is there; a simulator tab when the simulator manager says so. Pure: the route does
 * the loading and the probing. It carries the same Project/Tab records the person already receives
 * from /projects and /monitor, a narrow view of each machine, and task counts — no terminal content.
 */
export function buildOfficeCity(input: {
  projects: Project[];
  tabs: Tab[];
  machines: Machine[];
  /** by machine id; a machine absent here was not probed */
  probes: Map<string, TmuxProbe>;
  agentOnline: (machineId: string) => boolean;
  simulatorReady: (machineId: string, udid: string) => boolean;
  progress: OfficeProgress | null;
}): OfficeCity {
  const tabsByProject = new Map<string, Tab[]>();
  for (const t of input.tabs) tabsByProject.set(t.project_id, [...(tabsByProject.get(t.project_id) ?? []), t]);
  const alive = (t: Tab): boolean => {
    if (t.kind === 'simulator') return !!t.simulator_udid && input.simulatorReady(t.machine_id, t.simulator_udid);
    const probe = input.probes.get(t.machine_id);
    return !!probe?.reachable && !!t.tmux_session && probe.sessions.has(t.tmux_session);
  };
  const projects = input.projects
    .filter((p) => p.status !== 'archived')
    .map((project) => ({
      project,
      public_id: publicId('project', project.id),
      tasks: input.progress ? (input.progress.counts[project.id] ?? { todo: 0, doing: 0, done: 0 }) : null,
      tabs: (tabsByProject.get(project.id) ?? []).map((t) => ({ ...t, alive: alive(t), progress: input.progress?.byTab[t.id] ?? null })),
    }));
  // named field by field: a machine is a detail of a desk here, not the whole record (host, ssh user…)
  const machines = input.machines.map((m): OfficeMachine => {
    const probe = input.probes.get(m.id);
    return { id: m.id, name: m.name, subtitle: m.subtitle, type: m.type, online: machineOnline(m, probe, input.agentOnline), reachable: probe ? probe.reachable : null };
  });
  return { projects, machines };
}
```

- [ ] **Step 4: Run them to see them pass.** `SRVTEST src/office/snapshot.test.ts` — Expected: PASS (13 tests). `DOCKER 'npm run typecheck -w @termhub/server'` — Expected: exit 0.

- [ ] **Step 5: Commit.**

```bash
git add apps/server/src/office/snapshot.ts apps/server/src/office/snapshot.test.ts
git commit -m "Office: build the city as one building per project

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task A3: `GET /api/office` — the whole city in one read

**Files:**
- Modify: `apps/server/src/routes/office.ts` (whole file)
- Modify: `apps/server/src/app.ts:170`
- Modify: `apps/server/src/office/snapshot.ts` (remove `OfficeRoom`, `OfficeSnapshot`, `buildOfficeSnapshot`, the `publicRoomId` import)
- Test: `apps/server/src/routes/office.test.ts` (whole file), `apps/server/src/office/snapshot.test.ts` (remove the old `describe`)

**Interfaces:**
- Consumes: `buildOfficeCity`, `OfficeCity` (Task A2); `repos.projects.list({ owner })`, `repos.machines.list(owner)`, `repos.tabs.listByProjects(projectIds)` (exists, `apps/server/src/db/repositories/tabs.ts:20`), `repos.tasks.officeProgress(projectIds)`, `canAccess(repos, user, 'tasks', 'read')`, `probeTmuxSessionsCached(machine, { fresh })` (`terminal/machine-exec.ts:226`), `AgentRegistry.isOnline(machineId)` (`agent/registry.ts:37`).
- Produces: `GET /api/office?fresh=0|1` under `guarded('projects', …)`, answering `OfficeCity` as JSON:

```ts
// the JSON body, for Part B (dates are ISO strings; Project and Tab are the same records /projects and /monitor send)
{ projects: Array<{ project: Project /* incl. public_id */; public_id: string; tabs: Array<Tab & { alive: boolean; progress: { task_id: string; title: string; done: number; total: number } | null }>; tasks: { todo: number; doing: number; done: number } | null }>;
  machines: Array<{ id: string; name: string; subtitle: string | null; type: 'local' | 'ssh' | 'agent'; online: boolean; reachable: boolean | null }> }
```

  `GET /api/office/:machineId` no longer exists (404). `officeRoutes(app, repos, deps: { simulators: Pick<SimulatorSessionManager, 'isReady'>; agents: Pick<AgentRegistry, 'isOnline'> })`. `repos.tabs.listByProjectsOnMachine` stays (the MCP's `control/inventory.ts` uses it).

- [ ] **Step 1: Write the failing test.** Replace `apps/server/src/routes/office.test.ts` with:

```ts
import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Repositories } from '../db/repositories/index.js';
import { applyErrorHandler } from '../lib/errors.js';
import { publicId } from '../public/public-id.js';

const probe = vi.fn();
const canAccess = vi.fn();
vi.mock('../terminal/machine-exec.js', () => ({ probeTmuxSessionsCached: (...a: unknown[]) => probe(...a) }));
vi.mock('../auth/permissions.js', async (orig) => ({ ...(await orig<typeof import('../auth/permissions.js')>()), canAccess: (...a: unknown[]) => canAccess(...a) }));

const { officeRoutes } = await import('./office.js');

interface LogLine {
  level: number;
  msg: string;
  [key: string]: unknown;
}
const LEVEL = { debug: 20, info: 30, warn: 40 };

const MACHINES = [
  { id: 'm1', name: 'jarvis', subtitle: 'MacBook do escritório', type: 'agent', owner_id: 'u1', host: '10.0.0.9' },
  { id: 'm2', name: 'friday', subtitle: null, type: 'ssh', owner_id: 'u1', host: '10.0.0.10' },
];
const PROJECTS = [
  { id: 'p1', owner_id: 'u1', name: 'p1', status: 'active' },
  { id: 'p2', owner_id: 'u1', name: 'p2', status: 'active' },
  { id: 'pz', owner_id: 'u1', name: 'pz', status: 'archived' },
];
type TabRow = { id: string; project_id: string; machine_id: string; name: string; kind: string; tmux_session: string | null; simulator_udid: string | null };
const TABS: TabRow[] = [
  { id: 't1', project_id: 'p1', machine_id: 'm1', name: 't1', kind: 'terminal', tmux_session: 'th-t1', simulator_udid: null },
  { id: 't2', project_id: 'p1', machine_id: 'm2', name: 't2', kind: 'terminal', tmux_session: 'th-t2', simulator_udid: null },
  // p1 also runs on a machine outside this scope (a cross-owner link): not a desk here
  { id: 'tX', project_id: 'p1', machine_id: 'mX', name: 'tX', kind: 'terminal', tmux_session: 'th-tX', simulator_udid: null },
];

function buildApp(opts: { tabs?: TabRow[]; agentOnline?: boolean } = {}) {
  const logs: LogLine[] = [];
  const app = Fastify({ logger: { level: 'debug', stream: { write: (s: string) => void logs.push(JSON.parse(s) as LogLine) } } });
  applyErrorHandler(app);
  app.addHook('preHandler', async (request) => {
    request.scope = { user: { id: 'u1' } as never, viewAs: { kind: 'self' }, ownerId: 'u1', createAs: 'u1' };
    request.user = { id: 'u1' } as never;
  });
  const officeProgress = vi.fn(async () => ({ counts: { p1: { todo: 0, doing: 1, done: 0 } }, byTab: {} }));
  const repos = {
    projects: { list: vi.fn(async () => PROJECTS) },
    machines: { list: vi.fn(async () => MACHINES) },
    tabs: { listByProjects: vi.fn(async () => opts.tabs ?? TABS) },
    tasks: { officeProgress },
  } as unknown as Repositories;
  app.register((a) => officeRoutes(a, repos, { simulators: { isReady: () => false }, agents: { isOnline: () => opts.agentOnline ?? true } }), { prefix: '/office' });
  return { app, repos, officeProgress, logs };
}

describe('GET /office', () => {
  beforeEach(() => {
    probe.mockReset().mockImplementation(async (m: { id: string }) => ({ reachable: true, sessions: new Set(m.id === 'm1' ? ['th-t1'] : ['th-t2']) }));
    canAccess.mockReset().mockResolvedValue(true);
  });

  it('answers the whole city: a building per non-archived project, each with its tabs on every machine', async () => {
    const { app, repos } = buildApp();
    const res = await app.inject({ method: 'GET', url: '/office' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.projects.map((b: { project: { id: string } }) => b.project.id)).toEqual(['p1', 'p2']);
    expect(body.projects[0].tabs.map((t: { id: string; machine_id: string; alive: boolean }) => [t.id, t.machine_id, t.alive])).toEqual([['t1', 'm1', true], ['t2', 'm2', true]]);
    expect(body.projects[0].public_id).toBe(publicId('project', 'p1'));
    expect(body.projects[0].tasks).toEqual({ todo: 0, doing: 1, done: 0 });
    expect(body.projects[1].tabs).toEqual([]);
    expect(repos.tabs.listByProjects).toHaveBeenCalledWith(['p1', 'p2']);
  });

  // scoped to the caller: an admin's "view as" or a transferred machine must not bring another
  // owner's projects, machines or tabs into this city
  it('reads only the scope: its projects, its machines, and no desk on a machine outside it', async () => {
    const { app, repos } = buildApp();
    const body = (await app.inject({ method: 'GET', url: '/office' })).json();
    expect(repos.projects.list).toHaveBeenCalledWith({ owner: 'u1' });
    expect(repos.machines.list).toHaveBeenCalledWith('u1');
    expect(body.projects[0].tabs.map((t: { id: string }) => t.id)).toEqual(['t1', 't2']);
    expect(body.machines.map((m: { id: string }) => m.id)).toEqual(['m1', 'm2']);
    expect(probe).not.toHaveBeenCalledWith(expect.objectContaining({ id: 'mX' }), expect.anything());
  });

  it('describes each machine a desk runs on, field by field', async () => {
    const { app } = buildApp();
    const body = (await app.inject({ method: 'GET', url: '/office' })).json();
    expect(body.machines[0]).toEqual({ id: 'm1', name: 'jarvis', subtitle: 'MacBook do escritório', type: 'agent', online: true, reachable: true });
    expect(JSON.stringify(body)).not.toContain('10.0.0.9');
  });

  it('says an agent machine is offline from its connection', async () => {
    const { app } = buildApp({ agentOnline: false });
    const body = (await app.inject({ method: 'GET', url: '/office' })).json();
    expect(body.machines[0]).toMatchObject({ id: 'm1', online: false });
  });

  it('probes every machine with a terminal desk once, all at the same time', async () => {
    const answers: Array<() => void> = [];
    probe.mockImplementation((m: { id: string }) => new Promise((resolve) => answers.push(() => resolve({ reachable: true, sessions: new Set([m.id === 'm1' ? 'th-t1' : 'th-t2']) }))));
    const { app } = buildApp();
    const pending = app.inject({ method: 'GET', url: '/office' });
    // both asked before either answered: one slow machine does not queue the next one behind it
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(2));
    answers.forEach((answer) => answer());
    expect((await pending).statusCode).toBe(200);
  });

  // city-by-project §8: a failing probe marks the machine unreachable without failing the request
  it('answers 200 with the machine unreachable when its probe throws, the rest of the city intact', async () => {
    probe.mockImplementation(async (m: { id: string }) => {
      if (m.id === 'm2') throw new Error('boom');
      return { reachable: true, sessions: new Set(['th-t1']) };
    });
    const { app, logs } = buildApp();
    const res = await app.inject({ method: 'GET', url: '/office' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.machines.find((m: { id: string }) => m.id === 'm2')).toMatchObject({ reachable: false, online: false });
    expect(body.projects[0].tabs.map((t: { id: string; alive: boolean }) => [t.id, t.alive])).toEqual([['t1', true], ['t2', false]]);
    expect(logs.find((l) => l.msg === 'office: machine unreachable')).toMatchObject({ level: LEVEL.warn, machineId: 'm2', cause: 'probe failed' });
  });

  // The probe never throws for the ways a machine really goes silent (offline agent, ssh timeout,
  // non-zero exit): it answers `reachable: false`, and that is what has to reach the city.
  it('reports a probe that could not ask the machine: its tabs read as not alive', async () => {
    probe.mockImplementation(async (m: { id: string }) => (m.id === 'm1' ? { reachable: false, sessions: new Set(), cause: 'timeout' } : { reachable: true, sessions: new Set(['th-t2']) }));
    const { app } = buildApp();
    const body = (await app.inject({ method: 'GET', url: '/office' })).json();
    expect(body.machines[0]).toMatchObject({ id: 'm1', reachable: false });
    expect(body.projects[0].tabs[0].alive).toBe(false);
  });

  it('logs the unreachable cause as metadata only, and the city line at debug', async () => {
    probe.mockImplementation(async (m: { id: string }) => (m.id === 'm1' ? { reachable: false, sessions: new Set(), cause: 'exit 255' } : { reachable: true, sessions: new Set() }));
    const { app, logs } = buildApp();
    await app.inject({ method: 'GET', url: '/office' });
    expect(logs.find((l) => l.msg === 'office: machine unreachable')).toMatchObject({ level: LEVEL.warn, machineId: 'm1', cause: 'exit 255' });
    // one read per browser tab per minute: not worth an info line
    expect(logs.find((l) => l.msg === 'office: city')).toMatchObject({ level: LEVEL.debug, buildings: 2, tabs: 2, machines: 2 });
  });

  it('never asks a machine that has no terminal desk', async () => {
    const { app } = buildApp({ tabs: [{ id: 's1', project_id: 'p1', machine_id: 'm1', name: 's1', kind: 'simulator', tmux_session: null, simulator_udid: 'u1' }] });
    const body = (await app.inject({ method: 'GET', url: '/office' })).json();
    expect(probe).not.toHaveBeenCalled();
    expect(body.machines).toEqual([expect.objectContaining({ id: 'm1', reachable: null })]);
  });

  it('leaves the board out, unqueried, for someone who cannot read tasks', async () => {
    canAccess.mockResolvedValue(false);
    const { app, officeProgress } = buildApp();
    const body = (await app.inject({ method: 'GET', url: '/office' })).json();
    expect(officeProgress).not.toHaveBeenCalled();
    expect(body.projects[0].tasks).toBeNull();
    expect(canAccess).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: 'u1' }), 'tasks', 'read');
  });

  it('asks for a fresh probe only when ?fresh=1', async () => {
    const { app } = buildApp();
    await app.inject({ method: 'GET', url: '/office' });
    expect(probe).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'm2' }), { fresh: false });
    await app.inject({ method: 'GET', url: '/office?fresh=1' });
    expect(probe).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'm2' }), { fresh: true });
  });

  it('rejects a malformed fresh value', async () => {
    const { app } = buildApp();
    expect((await app.inject({ method: 'GET', url: '/office?fresh=yes' })).statusCode).toBe(400);
  });

  it('no longer serves the per-machine floor', async () => {
    const { app } = buildApp();
    expect((await app.inject({ method: 'GET', url: '/office/m1' })).statusCode).toBe(404);
  });
});
```

In `apps/server/src/office/snapshot.test.ts`, delete the whole `describe('buildOfficeSnapshot', …)` block and the `machine` constant above it (`const machine = { id: 'm1', name: 'jarvis' } as Machine;`), and change the two import lines to:

```ts
import { buildOfficeCity } from './snapshot.js';
import { publicId } from '../public/public-id.js';
```

- [ ] **Step 2: Run them to see them fail.** `SRVTEST src/routes/office.test.ts src/office/snapshot.test.ts` — Expected: `office.test.ts` FAILS (the old route only matches `/office/:machineId`, so every `GET /office` answers 404, and `/office/m1` reaches `repos.machines.findById`, which the new stub does not have); `snapshot.test.ts` PASSES (8 tests).

- [ ] **Step 3: Implement the route.** Replace `apps/server/src/routes/office.ts` with:

```ts
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AgentRegistry } from '../agent/registry.js';
import { canAccess } from '../auth/permissions.js';
import type { Repositories } from '../db/repositories/index.js';
import { buildOfficeCity } from '../office/snapshot.js';
import type { SimulatorSessionManager } from '../simulator/session-manager.js';
import { probeTmuxSessionsCached, type TmuxProbe } from '../terminal/machine-exec.js';

const query = z.object({ fresh: z.enum(['0', '1']).optional() });

/**
 * The office view's one read: the whole city — every non-archived project of the scope as a
 * building, all of its tabs whatever machine they run on, and those machines. Registered under the
 * `projects` resource; the board part additionally needs `tasks:read` and is left out — not even
 * queried — without it. A tab on a machine outside the scope is not a desk: the scope would 404 it
 * the moment someone clicked it (`scoped(...).tab`). Every machine with a terminal desk is probed
 * once, all in parallel, so the answer waits for the slowest one, bounded by the probe's own
 * timeouts; the probe is memoised per machine (see `probeTmuxSessionsCached`), so every browser tab
 * polling once a minute shares one round-trip per machine, and `?fresh=1` bypasses that memo for a
 * tab that was just opened. A probe that fails outright marks its machine unreachable, never the
 * whole read.
 */
export async function officeRoutes(app: FastifyInstance, repos: Repositories, deps: { simulators: Pick<SimulatorSessionManager, 'isReady'>; agents: Pick<AgentRegistry, 'isOnline'> }) {
  app.get('/', async (request) => {
    const { fresh } = query.parse(request.query);
    const owner = request.scope.ownerId;
    const projects = (await repos.projects.list({ owner })).filter((p) => p.status !== 'archived');
    const projectIds = projects.map((p) => p.id);
    const [allTabs, scopeMachines, progress] = await Promise.all([
      repos.tabs.listByProjects(projectIds),
      repos.machines.list(owner),
      (await canAccess(repos, request.user, 'tasks', 'read')) ? repos.tasks.officeProgress(projectIds) : Promise.resolve(null),
    ]);
    const inScope = new Map(scopeMachines.map((m) => [m.id, m]));
    const tabs = allTabs.filter((t) => inScope.has(t.machine_id));
    const machines = [...new Set(tabs.map((t) => t.machine_id))].map((id) => inScope.get(id)!);
    const probed = machines.filter((m) => tabs.some((t) => t.machine_id === m.id && t.kind === 'terminal'));
    const probes = new Map<string, TmuxProbe>(
      await Promise.all(
        probed.map(async (machine) => {
          // the probe answers `reachable: false` for the usual ways a machine goes silent; a throw (a
          // misconfigured machine, a bug) must still be one silent machine, not a failed city
          const probe = await probeTmuxSessionsCached(machine, { fresh: fresh === '1' }).catch((): TmuxProbe => ({ reachable: false, sessions: new Set(), cause: 'probe failed' }));
          if (!probe.reachable) request.log.warn({ machineId: machine.id, cause: probe.cause }, 'office: machine unreachable');
          return [machine.id, probe] as const;
        }),
      ),
    );
    request.log.debug({ buildings: projects.length, tabs: tabs.length, machines: machines.length, probed: probed.length }, 'office: city');
    return buildOfficeCity({
      projects,
      tabs,
      machines,
      probes,
      agentOnline: (id) => deps.agents.isOnline(id),
      simulatorReady: (machineId, udid) => deps.simulators.isReady(machineId, udid),
      progress,
    });
  });
}
```

In `apps/server/src/app.ts` line 170 pass the agent registry (already imported there as `agents`):

```ts
      await guarded('projects', (a) => officeRoutes(a, repos, { simulators, agents }), '/office');
```

In `apps/server/src/office/snapshot.ts`, delete `interface OfficeRoom`, `interface OfficeSnapshot`, `function buildOfficeSnapshot` with their doc comments, and change the first import to `import { publicId } from '../public/public-id.js';`.

- [ ] **Step 4: Run them to see them pass, and typecheck.** `SRVTEST src/routes/office.test.ts src/office/snapshot.test.ts` — Expected: PASS (13 + 8 tests). `DOCKER 'npm run typecheck -w @termhub/server'` — Expected: exit 0.

- [ ] **Step 5: Commit.**

```bash
git add apps/server/src/routes/office.ts apps/server/src/routes/office.test.ts apps/server/src/app.ts apps/server/src/office/snapshot.ts apps/server/src/office/snapshot.test.ts
git commit -m "Office: read the whole city in one request, probing machines in parallel

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---
### Task A4: The public payload by project — snapshot, frames, card and link preview

One task because one shape changes: `PublicBuilding` stops being a machine with rooms and becomes a published project with robots, and every producer and reader of that shape (`city.ts`, `read.ts`, the two frame calls in `ws.ts`, `card.ts`, `city-page.ts`, the card route) has to move together for the server to compile. The live channel's **rules** (which changes reach which socket) are Task A5; here `ws.ts` only builds its frames through the new builders.

**Files:**
- Modify: `apps/server/src/public/city.ts` (whole file)
- Modify: `apps/server/src/public/read.ts` (header comment, new `resolvePublicCity`, `readPublicCity`, memo comment; `resolvePublicRooms`/`roomKey` stay for `ws.ts` until Task A5)
- Modify: `apps/server/src/public/ws.ts:203` and `:221` (the two frame builders)
- Modify: `apps/server/src/public/card.ts` (lines 1-97: header comment, `resolveFocus`, `buildCardSvg`)
- Modify: `apps/server/src/public/city-page.ts` (lines 1-90 and `depthFromCityUrl`)
- Modify: `apps/server/src/routes/public-city.ts` (card query, cache key, comments)
- Test: `apps/server/src/public/city.test.ts` (whole file), `apps/server/src/public/read.test.ts`, `apps/server/src/public/read.db.test.ts` (whole file), `apps/server/src/public/card.test.ts`, `apps/server/src/public/city-page.test.ts`, `apps/server/src/routes/public-city.test.ts`, `apps/server/src/frontend.test.ts`, `apps/server/src/public/ws.test.ts`

**Interfaces:**
- Consumes: `publicId('project' | 'tab', …)`; `repos.projects.list({ owner })`, `repos.machines.list(ownerId)`, `repos.tabs.listByProjects(projectIds)`; `cachedTmuxProbe(machineId)` (reads the memo, never probes); `effectiveShortUrl(owner)`.
- Produces (the public wire format, for Part B):

```ts
// apps/server/src/public/city.ts — every field named in the builders
export interface PublicRobot { id: string; name: string; kind: 'terminal' | 'simulator'; state: TabState | null; state_at: string | null; activity: TabActivity | null; activity_verb: string | null; alive: boolean; progress: { done: number; total: number } | null } // unchanged
export interface PublicBuilding { id: string /* publicId('project', projectId) */; name: string /* the project's name */; robots: PublicRobot[] }
export interface PublicCity { nickname: string; owner_name: string; short_url: string | null; buildings: PublicBuilding[] }
export interface PublicRobotFrame { type: 'robot'; building: string; robot: PublicRobot }
export interface PublicRobotGone { type: 'robot_gone'; building: string; robot: string /* the robot's id */ }
export function toPublicCity(input: { nickname: string; ownerName: string; shortUrl: string | null; buildings: { project: Project; robots: { tab: Tab; alive: boolean; progress: OfficeTabProgress | null }[] }[] }): PublicCity;
export function toPublicRobotFrame(input: { projectId: string; tab: Tab; alive: boolean; progress: OfficeTabProgress | null }): PublicRobotFrame;
export function toPublicRobotGone(input: { projectId: string; tabId: string }): PublicRobotGone;

// apps/server/src/public/read.ts
export async function resolvePublicCity(repos: Pick<Repositories, 'machines' | 'projects'>, ownerId: string): Promise<{ projects: Project[]; machines: Machine[] }>;
// projects: the owner's published, non-archived projects (by name); machines: the ones the owner owns; both [] when nothing is published (machines not even read)

// apps/server/src/public/card.ts
export function resolveFocus(city: PublicCity, focus: { building?: string }): { building?: PublicBuilding };
export function buildCardSvg(city: PublicCity, focus: { building?: string }): string;

// apps/server/src/public/city-page.ts
export interface CityDepth { building?: string }
export function depthFromCityUrl(url: string): { nickname: string; depth: CityDepth }; // any ?room= is ignored
```

  Endpoints: `GET /api/public/city/:nickname` answers `PublicCity` (404 when nothing is published); `GET /api/public/city/:nickname/card.png?building=<id>` (a `?room=` is not read); `/city/@nick[/building]` documents. Copy: card city "N projetos · M agentes trabalhando", card building "<projeto> — M agentes trabalhando"; meta description at building depth "<projeto>, um dos projetos publicados de <dono> no termhub."

- [ ] **Step 1: Write the failing DTO test.** Replace `apps/server/src/public/city.test.ts` with:

```ts
import { describe, expect, it } from 'vitest';
import { toPublicCity, toPublicRobot, toPublicRobotFrame, toPublicRobotGone } from './city.js';
import { publicId } from './public-id.js';
import type { Project, Tab } from '../db/repositories/types.js';

const tab = (over: Partial<Tab> = {}): Tab => ({
  id: 't1', project_id: 'p1', machine_id: 'maquina-secreta-id', name: 'corrigir o cliente ACME', kind: 'terminal', tmux_session: 'th-t1', simulator_udid: null,
  created_by_token_id: null, position: 0, state: 'working', state_text: 'rodando os testes', state_tool: 'claude', state_at: '2026-09-22T10:00:00.000Z',
  state_seen_at: null, activity: 'coding', activity_verb: null, created_at: '2026-09-22T09:00:00.000Z', ...over,
});
const project = (over: Partial<Project> = {}): Project => ({ id: 'p1', owner_id: 'u1', key: 'ENG', next_task_number: 1, name: 'Engage Easy', status: 'active', description: 'o que eu não quero na rua', is_public: true, public_id: 'not-emitted', last_terminal_at: null, created_at: '2026-09-01T00:00:00.000Z', ...over });
type Robot = { tab: Tab; alive: boolean; progress: { task_id: string; title: string; done: number; total: number } | null };
const city = (robots: Robot[] = [{ tab: tab(), alive: true, progress: null }], shortUrl: string | null = null) =>
  toPublicCity({ nickname: 'pedro', ownerName: 'Pedro', shortUrl, buildings: [{ project: project(), robots }] });

describe('the public payload', () => {
  it('emits exactly the fields the public city is allowed to carry', () => {
    const c = city([{ tab: tab(), alive: true, progress: { task_id: 'k', title: 'segredo do board', done: 2, total: 5 } }]);
    expect(Object.keys(c).sort()).toEqual(['buildings', 'nickname', 'owner_name', 'short_url']);
    expect(Object.keys(c.buildings[0]).sort()).toEqual(['id', 'name', 'robots']);
    expect(Object.keys(c.buildings[0].robots[0]).sort()).toEqual(['activity', 'activity_verb', 'alive', 'id', 'kind', 'name', 'progress', 'state', 'state_at']);
    expect(c.buildings[0].robots[0].progress).toEqual({ done: 2, total: 5 });
    expect(JSON.stringify(c)).not.toContain('segredo do board');
  });

  // city-by-project §2.3: a building is a published project, under its project's public id
  it('makes the building of a published project its project, by name, under an id that is not the real one', () => {
    const c = city();
    expect(c.buildings[0].name).toBe('Engage Easy');
    expect(c.buildings[0].id).toBe(publicId('project', 'p1'));
    expect(c.buildings[0].id).not.toBe('p1');
  });

  it('carries nothing that describes a machine or the person beyond a name', () => {
    const body = JSON.stringify(city());
    for (const secret of ['maquina-secreta-id', 'machine', 'not-emitted', '/home/p/engageasy', 'o que eu não quero na rua', 'th-t1', 'u1', 'rodando os testes', 'claude']) {
      expect(body).not.toContain(secret);
    }
  });

  it('replaces every real id with one that is not the real id, and does it the same way twice', () => {
    const once = city();
    const twice = city();
    expect(once.buildings[0].robots[0].id).not.toBe('t1');
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
    expect(publicId('tab', 't1')).not.toBe(publicId('project', 't1'));
  });

  it('a robot that is not working carries no activity and keeps its state', () => {
    const r = toPublicRobot(tab({ state: 'waiting_input', activity: null }), { alive: true, progress: null });
    expect(r.state).toBe('waiting_input');
    expect(r.activity).toBeNull();
  });

  it('publishes a spinner verb only when it is one of Claude Code\'s defaults', () => {
    const robot = (verb: string | null) => toPublicRobot(tab({ activity_verb: verb }), { alive: true, progress: null }).activity_verb;
    expect(robot('Moonwalking')).toBe('Moonwalking');
    expect(robot('Flibbertigibbeting')).toBe('Flibbertigibbeting');
    expect(robot(null)).toBeNull();
    // a customised verb is the person's own words: it stays in the office
    for (const custom of ['Acmeing', 'Deploying', 'moonwalking', 'MOONWALKING', 'toString', 'constructor', '__proto__']) expect(robot(custom)).toBeNull();
  });

  it('publishes activity and verb only while the robot is working, whatever the row still holds', () => {
    for (const state of ['waiting_input', 'waiting_permission', 'idle', 'error', null] as const) {
      const r = toPublicRobot(tab({ state, activity: 'coding', activity_verb: 'Moonwalking' }), { alive: true, progress: null });
      expect([r.state, r.activity, r.activity_verb]).toEqual([state, null, null]);
    }
    const working = toPublicRobot(tab({ state: 'working', activity: 'coding', activity_verb: 'Moonwalking' }), { alive: true, progress: null });
    expect([working.activity, working.activity_verb]).toEqual(['coding', 'Moonwalking']);
  });

  it('keeps a custom verb out of the whole payload', () => {
    expect(JSON.stringify(city([{ tab: tab({ activity_verb: 'Acmeing' }), alive: true, progress: null }]))).not.toContain('Acmeing');
  });

  // The snapshot, the socket frames and the share link all join on the building id.
  it('gives the frames the building and robot ids of the snapshot, and nothing else', () => {
    const c = city();
    const frame = toPublicRobotFrame({ projectId: 'p1', tab: tab(), alive: true, progress: null });
    expect(Object.keys(frame).sort()).toEqual(['building', 'robot', 'type']);
    expect(frame.building).toBe(c.buildings[0].id);
    expect(frame.robot).toEqual(c.buildings[0].robots[0]);
    expect(toPublicRobotGone({ projectId: 'p1', tabId: 't1' })).toEqual({ type: 'robot_gone', building: c.buildings[0].id, robot: c.buildings[0].robots[0].id });
  });

  // city-by-project §1: one building per project, whatever machines its agents run on
  it('keeps one building for a project whose robots run on two machines, and its frames agree', () => {
    const c = city([{ tab: tab(), alive: true, progress: null }, { tab: tab({ id: 't2', machine_id: 'outra-maquina-id' }), alive: false, progress: null }]);
    expect(c.buildings).toHaveLength(1);
    expect(c.buildings[0].robots.map((r) => r.id)).toEqual([publicId('tab', 't1'), publicId('tab', 't2')]);
    const f2 = toPublicRobotFrame({ projectId: 'p1', tab: tab({ id: 't2', machine_id: 'outra-maquina-id' }), alive: true, progress: null });
    expect(f2.building).toBe(c.buildings[0].id);
  });

  // §2.4: a published project always appears, even with no agents
  it('keeps a published project with no robot as a building of its own', () => {
    expect(city([]).buildings).toEqual([{ id: publicId('project', 'p1'), name: 'Engage Easy', robots: [] }]);
  });

  // The short link is public by nature — it is printed on images meant for strangers — and it is
  // the one field of the owner's account that travels, named here and nowhere else.
  it('carries the owner’s short link, or null', () => {
    expect(city([], 'https://77a.it/pedro').short_url).toBe('https://77a.it/pedro');
    expect(city([], null).short_url).toBeNull();
  });

  // §6: no machine id, name or subtitle in the snapshot or in any frame
  it('carries no machine, in the snapshot or in any frame', () => {
    const payloads = [city(), toPublicRobotFrame({ projectId: 'p1', tab: tab(), alive: true, progress: null }), toPublicRobotGone({ projectId: 'p1', tabId: 't1' })];
    for (const payload of payloads) {
      const body = JSON.stringify(payload);
      expect(body).not.toMatch(/machine|subtitle/);
      expect(body).not.toContain('maquina-secreta-id');
    }
  });
});
```

- [ ] **Step 2: Run it to see it fail.** `SRVTEST src/public/city.test.ts` — Expected: FAIL (the building's keys are `['id', 'name', 'rooms']`, `toPublicCity` reads `b.machine.id` of `undefined`, frames carry `room`).

- [ ] **Step 3: Implement the DTO.** Replace `apps/server/src/public/city.ts` with:

```ts
import { publicId } from './public-id.js';
import { publicSpinnerVerb } from './spinner-verbs.js';
import type { OfficeTabProgress, Project, Tab, TabActivity, TabState } from '../db/repositories/types.js';

/**
 * The public face of the office, and the only thing that reaches a visitor. Every field here was
 * written on purpose: nothing is spread, so a column added to Tab or Project tomorrow stays inside
 * the instance until somebody adds it here too. A building is a published project; nothing about a
 * machine — its id, its name, its subtitle — exists in this shape at all (city-by-project §2.3).
 */
export interface PublicRobot {
  id: string;
  name: string;
  kind: Tab['kind'];
  state: TabState | null;
  state_at: string | null;
  activity: TabActivity | null;
  /** Claude Code's spinner verb, only when it is one of its defaults (spinner-verbs.ts): a custom verb is the person's own words */
  activity_verb: string | null;
  alive: boolean;
  progress: { done: number; total: number } | null;
}

/** One published project on the street: its name and its agents on the owner's own machines. */
export interface PublicBuilding { id: string; name: string; robots: PublicRobot[] }
export interface PublicCity { nickname: string; owner_name: string; short_url: string | null; buildings: PublicBuilding[] }

/** A live change of one robot: `building` is the snapshot's own building id, so the page joins them. */
export interface PublicRobotFrame { type: 'robot'; building: string; robot: PublicRobot }

/** A robot leaving its building (its tab was closed or deleted): public ids and nothing else. */
export interface PublicRobotGone { type: 'robot_gone'; building: string; robot: string }

export function toPublicRobot(tab: Tab, opts: { alive: boolean; progress: OfficeTabProgress | null }): PublicRobot {
  // what the robot is doing only means something while it works: never publish a leftover
  const working = tab.state === 'working';
  return {
    id: publicId('tab', tab.id),
    name: tab.name,
    kind: tab.kind,
    state: tab.state,
    state_at: tab.state_at,
    activity: working ? tab.activity : null,
    activity_verb: working ? publicSpinnerVerb(tab.activity_verb) : null,
    alive: opts.alive,
    progress: opts.progress ? { done: opts.progress.done, total: opts.progress.total } : null,
  };
}

export function toPublicRobotFrame(input: { projectId: string; tab: Tab; alive: boolean; progress: OfficeTabProgress | null }): PublicRobotFrame {
  return { type: 'robot', building: publicId('project', input.projectId), robot: toPublicRobot(input.tab, { alive: input.alive, progress: input.progress }) };
}

export function toPublicRobotGone(input: { projectId: string; tabId: string }): PublicRobotGone {
  return { type: 'robot_gone', building: publicId('project', input.projectId), robot: publicId('tab', input.tabId) };
}

export function toPublicCity(input: {
  nickname: string;
  ownerName: string;
  shortUrl: string | null;
  buildings: { project: Project; robots: { tab: Tab; alive: boolean; progress: OfficeTabProgress | null }[] }[];
}): PublicCity {
  return {
    nickname: input.nickname,
    owner_name: input.ownerName,
    // the owner's effective short link (custom ?? partner): printed on share images, public by nature
    short_url: input.shortUrl,
    buildings: input.buildings.map((b) => ({
      id: publicId('project', b.project.id),
      name: b.project.name,
      robots: b.robots.map((r) => toPublicRobot(r.tab, { alive: r.alive, progress: r.progress })),
    })),
  };
}
```

In `apps/server/src/public/ws.ts`, change the two builder calls (the rules around them are Task A5's):

```ts
        ws.send(JSON.stringify(toPublicRobotFrame({ projectId: change.project_id, tab: change.tab, alive, progress: null })));
```

```ts
        ws.send(JSON.stringify(toPublicRobotGone({ projectId: removed.project_id, tabId: removed.tab_id })));
```

- [ ] **Step 4: Run it to see it pass.** `SRVTEST src/public/city.test.ts` — Expected: PASS (13 tests).

- [ ] **Step 5: Write the failing read tests.** In `apps/server/src/public/read.test.ts`:

  1. Change the dynamic import to `const { PUBLIC_CITY_MEMO_MAX, PUBLIC_CITY_MEMO_MS, clearPublicCityMemo, readPublicCity, readPublicCityCached, resolvePublicCity } = await import('./read.js');`
  2. In `stubRepos()`, replace the `projectMachines` and `tabs` lines with `tabs: { listByProjects: vi.fn(async () => []) },`.
  3. Replace the whole `describe('resolvePublicRooms', …)` block with:

```ts
describe('resolvePublicCity', () => {
  function repos(projects: unknown[], machines: unknown[] = [{ id: 'm1', owner_id: 'u1' }]) {
    return { projects: { list: vi.fn(async () => projects) }, machines: { list: vi.fn(async () => machines) } } as unknown as Repositories;
  }

  // Defence in depth: `projects.list({ owner })` already filters, but a published project of
  // somebody else must never become a building even if that filter ever slips.
  it('drops a published project the owner does not own, even if the repository returns it', async () => {
    const r = repos([
      { id: 'p1', owner_id: 'u1', is_public: true, status: 'active' },
      { id: 'pX', owner_id: 'u2', is_public: true, status: 'active' },
      { id: 'pO', owner_id: null, is_public: true, status: 'active' },
    ]);
    expect((await resolvePublicCity(r, 'u1')).projects.map((p) => p.id)).toEqual(['p1']);
  });

  it('keeps only published, non-archived projects, in the order given', async () => {
    const r = repos([
      { id: 'b', owner_id: 'u1', is_public: true, status: 'active' },
      { id: 'priv', owner_id: 'u1', is_public: false, status: 'active' },
      { id: 'arch', owner_id: 'u1', is_public: true, status: 'archived' },
      { id: 'a', owner_id: 'u1', is_public: true, status: 'paused' },
    ]);
    expect((await resolvePublicCity(r, 'u1')).projects.map((p) => p.id)).toEqual(['b', 'a']);
  });

  // the one line between a published project and somebody else's machine
  it('keeps only the machines the owner owns, even if the repository returns another', async () => {
    const r = repos([{ id: 'p1', owner_id: 'u1', is_public: true, status: 'active' }], [{ id: 'm1', owner_id: 'u1' }, { id: 'mX', owner_id: 'u2' }]);
    expect((await resolvePublicCity(r, 'u1')).machines.map((m) => m.id)).toEqual(['m1']);
  });

  it('reads no machine when nothing is published', async () => {
    const r = repos([{ id: 'p1', owner_id: 'u1', is_public: false, status: 'active' }]);
    expect(await resolvePublicCity(r, 'u1')).toEqual({ projects: [], machines: [] });
    expect(r.machines.list).not.toHaveBeenCalled();
  });

  // An empty id could read as "no owner filter" further down; it is refused before any read.
  it('refuses an empty owner id without reading anything', async () => {
    const r = repos([{ id: 'p1', owner_id: '', is_public: true, status: 'active' }]);
    expect(await resolvePublicCity(r, '')).toEqual({ projects: [], machines: [] });
    expect(r.projects.list).not.toHaveBeenCalled();
  });
});

describe('readPublicCity', () => {
  const tabRow = (id: string, projectId: string, machineId: string, name: string) => ({
    id, project_id: projectId, machine_id: machineId, name, kind: 'terminal', tmux_session: `th-${id}`, simulator_udid: null, position: 0,
    state: 'working', state_text: null, state_tool: 'claude', state_at: '2026-09-24T10:00:00.000Z', state_seen_at: null, activity: null, activity_verb: null, created_at: '',
  });

  it("reads every building's tabs in one query and keeps only those on a machine the owner owns", async () => {
    const listByProjects = vi.fn(async () => [tabRow('t1', 'p1', 'm1', 'minha'), tabRow('t2', 'p1', 'mX', 'alheia')]);
    const repos = {
      users: { findByNickname: async () => ({ id: 'u1', name: 'Pedro', city_short_url_partner: null, city_short_url_custom: null }) },
      projects: { list: async () => [{ id: 'p1', name: 'Engage', owner_id: 'u1', is_public: true, status: 'active' }, { id: 'p2', name: 'Vazio', owner_id: 'u1', is_public: true, status: 'active' }] },
      machines: { list: async () => [{ id: 'm1', owner_id: 'u1' }] },
      tabs: { listByProjects },
    } as unknown as Repositories;
    const city = (await readPublicCity(repos, 'pedro'))!;
    expect(listByProjects).toHaveBeenCalledTimes(1);
    expect(listByProjects).toHaveBeenCalledWith(['p1', 'p2']);
    // a published project with no robot of its own is still a building
    expect(city.buildings.map((b) => [b.name, b.robots.map((r) => r.name)])).toEqual([['Engage', ['minha']], ['Vazio', []]]);
  });
});
```

Replace `apps/server/src/public/read.db.test.ts` with:

```ts
import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '../generated/prisma/client.js';
import { createRepositories, type Repositories } from '../db/repositories/index.js';
import { newId } from '../lib/ids.js';
import { publicId } from './public-id.js';

// The public read only ever consults the tmux memo; cold here, so `alive` falls back to the tab's state.
vi.mock('../terminal/machine-exec.js', () => ({ cachedTmuxProbe: () => undefined }));

const { readPublicCity } = await import('./read.js');

/**
 * The public city against the real schema (city-by-project §2.4): a city is the owner's published,
 * non-archived projects, one building each, and a building's robots are that project's tabs on the
 * machines the owner owns. No machine is ever part of it.
 */
// Needs a migrated Postgres: TERMHUB_DB_TESTS=1 DATABASE_URL=… (CI sets both; see README → Development).
describe.skipIf(process.env.TERMHUB_DB_TESTS !== '1')('readPublicCity (Postgres)', () => {
  let db: PrismaClient;
  let repos: Repositories;
  let pedro: string;
  let other: string;
  let nick: string;
  let mine: string;
  let mine2: string;
  let theirs: string;

  beforeAll(() => {
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
    repos = createRepositories(db);
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  const key = () => `K${newId(8).toUpperCase().replace(/[^A-Z0-9]/g, 'X')}`;

  beforeEach(async () => {
    pedro = newId();
    other = newId();
    nick = `pc${newId(10).toLowerCase().replace(/[^a-z0-9]/g, 'x')}`;
    await db.user.createMany({ data: [
      { id: pedro, email: `${pedro}@test.local`, name: 'Pedro', nickname: nick },
      { id: other, email: `${other}@test.local`, name: 'Outra' },
    ] });
    [mine, mine2, theirs] = [newId(), newId(), newId()];
    await db.machine.createMany({ data: [
      { id: mine, name: 'Jarvis', type: 'agent', ownerId: pedro },
      { id: mine2, name: 'Friday', type: 'agent', ownerId: pedro },
      { id: theirs, name: 'Maquina Alheia', type: 'agent', ownerId: other },
    ] });
    return async () => {
      await db.project.deleteMany({ where: { ownerId: { in: [pedro, other] } } });
      await db.machine.deleteMany({ where: { id: { in: [mine, mine2, theirs] } } });
      await db.user.deleteMany({ where: { id: { in: [pedro, other] } } });
    };
  });

  async function published(name = 'Engage Easy', machines: string[] = [mine]) {
    const project = await repos.projects.create({ owner_id: pedro, key: key(), name });
    for (const machine_id of machines) await repos.projectMachines.link({ project_id: project.id, machine_id, cwd: '/w' });
    await repos.projects.update(project.id, { is_public: true });
    return project;
  }

  it('makes one building of a published project, with its robots from every machine the owner owns', async () => {
    const project = await published('Engage Easy', [mine, mine2]);
    await repos.tabs.create(project.id, mine, 'no jarvis');
    await repos.tabs.create(project.id, mine2, 'no friday');
    const city = (await readPublicCity(repos, nick))!;
    expect(city.buildings).toHaveLength(1);
    expect(city.buildings[0]!.id).toBe(publicId('project', project.id));
    expect(city.buildings[0]!.name).toBe('Engage Easy');
    expect(city.buildings[0]!.robots.map((r) => r.name)).toEqual(['no jarvis', 'no friday']);
  });

  it('never shows a robot on a machine the owner does not own, nor any machine at all', async () => {
    const project = await published('Engage Easy', [mine, theirs]);
    await repos.tabs.create(project.id, mine, 'uma aba');
    await repos.tabs.create(project.id, theirs, 'na maquina alheia');
    const city = (await readPublicCity(repos, nick))!;
    expect(city.buildings[0]!.robots.map((r) => r.name)).toEqual(['uma aba']);
    const body = JSON.stringify(city);
    for (const secret of ['Maquina Alheia', 'na maquina alheia', 'Jarvis', theirs, mine]) expect(body).not.toContain(secret);
  });

  // §2.4: a published project always appears, even with no agents ("sem agentes agora")
  it('keeps a published project whose agents all run elsewhere, or that has none, as an empty building', async () => {
    const elsewhere = await published('Alheio', [theirs]);
    await repos.tabs.create(elsewhere.id, theirs, 'na maquina alheia');
    await published('Sem maquina', []);
    const city = (await readPublicCity(repos, nick))!;
    expect(city.buildings.map((b) => [b.name, b.robots.length])).toEqual([['Alheio', 0], ['Sem maquina', 0]]);
  });

  it('drops the robots of a machine that changed owner, keeping the building and its publish switch', async () => {
    const project = await published('Engage Easy', [mine, mine2]);
    await repos.tabs.create(project.id, mine, 'no jarvis');
    await repos.tabs.create(project.id, mine2, 'no friday');
    await repos.machines.update(mine2, { owner_id: other });
    const city = (await readPublicCity(repos, nick))!;
    expect(city.buildings[0]!.robots.map((r) => r.name)).toEqual(['no jarvis']);
    expect((await repos.projects.findById(project.id))?.is_public).toBe(true);
    // and the new owner's city does not gain it: the project is not theirs
    await db.user.update({ where: { id: other }, data: { nickname: `${nick}o` } });
    expect(await readPublicCity(repos, `${nick}o`)).toBeUndefined();
  });

  it('leaves out private and archived projects, and orders the buildings by name', async () => {
    await published('Zeta');
    await published('Alfa');
    await repos.projects.create({ owner_id: pedro, key: key(), name: 'Privado' });
    const archived = await published('Arquivado');
    await repos.projects.update(archived.id, { status: 'archived' });
    const city = (await readPublicCity(repos, nick))!;
    expect(city.buildings.map((b) => b.name)).toEqual(['Alfa', 'Zeta']);
  });

  it('is no city at all when nothing is published', async () => {
    await repos.projects.create({ owner_id: pedro, key: key(), name: 'Privado' });
    expect(await readPublicCity(repos, nick)).toBeUndefined();
  });

  // The subtitle is the owner's own note about the machine ("MacBook do escritório"), and the
  // machine's name is no longer public either: neither ever reaches the street.
  it("never publishes a machine's name or subtitle", async () => {
    await repos.machines.update(mine, { subtitle: 'MacBook do escritório secreto' });
    const project = await published();
    await repos.tabs.create(project.id, mine, 'uma tab');
    const city = (await readPublicCity(repos, nick))!;
    expect(Object.keys(city.buildings[0]!).sort()).toEqual(['id', 'name', 'robots']);
    const body = JSON.stringify(city);
    for (const secret of ['subtitle', 'MacBook do escritório secreto', 'Jarvis', 'machine']) expect(body).not.toContain(secret);
  });
});
```

In `apps/server/src/routes/public-city.test.ts`:

  1. Delete the `LINKS` constant and its comment, and the `projectMachines: { … }` entry of `repos` in `buildApp`. Replace the `tabs` entry with:

```ts
    tabs: {
      listByProjects: vi.fn(async (projectIds: string[]) => TABS.filter((t) => projectIds.includes(t.project_id))),
    },
```

  2. Replace the tests between `'answers the city of a nickname that has a public project'` and `'404s an unknown nickname'` (both excluded) with:

```ts
  it('leaves out a private project', async () => {
    const { app } = buildApp();
    const body = JSON.stringify((await app.inject({ method: 'GET', url: '/public/city/pedro' })).json());
    expect(body).not.toContain('Projeto Secreto');
  });

  it('leaves out an archived project even though it is public', async () => {
    const { app } = buildApp();
    const body = JSON.stringify((await app.inject({ method: 'GET', url: '/public/city/pedro' })).json());
    expect(body).not.toContain('Projeto Arquivado');
  });

  it('never asks for a private project\'s tabs — asserted on the repository call, not only on the body', async () => {
    const { app, repos } = buildApp();
    await app.inject({ method: 'GET', url: '/public/city/pedro' });
    // p2 (private) and p3 (archived) must never appear in the argument, not just in the response
    expect(repos.tabs.listByProjects).toHaveBeenCalledTimes(1);
    expect(repos.tabs.listByProjects).toHaveBeenCalledWith(['p1']);
  });

  it('leaves out somebody else\'s published project', async () => {
    const { app } = buildApp();
    const body = JSON.stringify((await app.inject({ method: 'GET', url: '/public/city/pedro' })).json());
    expect(body).not.toContain('Rival Room');
    expect(body).not.toContain('Rival HQ');
  });

  // p1 is published and runs on m3 too, a machine u3 owns: its robot there is not pedro's to publish,
  // and no machine — not even pedro's own m1 — is named anywhere
  it('never exposes a robot on a machine the owner does not own, nor any machine name', async () => {
    const { app } = buildApp();
    const city = (await app.inject({ method: 'GET', url: '/public/city/pedro' })).json();
    expect(city.buildings).toHaveLength(1);
    expect(city.buildings[0].name).toBe('Engage Easy');
    expect(city.buildings[0].robots.map((r: { name: string }) => r.name)).toEqual(['shell']);
    const body = JSON.stringify(city);
    for (const secret of ['Rival HQ', 'shell na maquina alheia', 'Jarvis Office']) expect(body).not.toContain(secret);
  });

  // city-by-project §2.4: a published project is a building even with no agent of the owner's own
  it("shows a published project whose agents all run on somebody else's machine as an empty building", async () => {
    const { app } = buildApp();
    PROJECTS.push({ id: 'p7', owner_id: 'u2', name: 'Sem Agentes Proprios', status: 'active', is_public: true });
    TABS.push({ id: 't7', project_id: 'p7', machine_id: 'm3', name: 'aba na maquina de outro', kind: 'terminal', tmux_session: 'th-t7', simulator_udid: null, state: 'working' });
    try {
      const res = await app.inject({ method: 'GET', url: '/public/city/semnada' });
      expect(res.statusCode).toBe(200);
      expect(res.json().buildings).toEqual([expect.objectContaining({ name: 'Sem Agentes Proprios', robots: [] })]);
      expect(res.body).not.toContain('aba na maquina de outro');
    } finally {
      PROJECTS.pop();
      TABS.pop();
    }
  });
```

  3. In `'answers the city of a nickname that has a public project'`, replace the last line with `expect(res.json().buildings.map((b: { name: string }) => b.name)).toEqual(['Engage Easy']);`.
  4. In `'performs no probe at all with a cold memo, and still answers with its robots'`, replace `res.json().buildings[0].rooms[0].robots` with `res.json().buildings[0].robots`.

In `apps/server/src/frontend.test.ts`, in `stubRepos` delete the `projectMachines` line and replace the `tabs` line with `tabs: { listByProjects: vi.fn(async () => []) },`; at the end of the Postgres test replace the last two lines with:

```ts
    const { publicId } = await import('./public/public-id.js');
    // the building is the project, under its project's public id, and the machine is named nowhere
    expect(snapshot.json().buildings[0].id).toBe(publicId('project', project.id));
    expect(snapshot.json().buildings[0].name).toBe('Fixture Room');
    expect(snapshot.body).not.toContain('Fixture HQ');
```

In `apps/server/src/public/ws.test.ts` (only the frame shape and the two tests that read the snapshot change here; its rules are Task A5):

  1. Import line: `import { publicId } from './public-id.js';`
  2. `nextMessage`'s return type: `Promise<{ type: string; building: string; robot: Record<string, unknown> }>`.
  3. In `'sends a change on a published room'` (rename it `'sends a change of a published building'`), after `expect(frame.robot.id).toBe(publicId('tab', 't1'));` add:

```ts
    expect(frame.building).toBe(publicId('project', 'p1'));
    expect(Object.keys(frame).sort()).toEqual(['building', 'robot', 'type']);
```

  4. In `'never carries the machine\'s subtitle, in a frame or in the snapshot'`, replace the three lines from `const snapRepos` to the first `expect(city…` with:

```ts
    const snapRepos = { ...repos, tabs: { listByProjects: async () => [tab()] } } as unknown as Repositories;
    const city = (await readPublicCity(snapRepos, 'pedro'))!;
    expect(city.buildings.map((b) => b.id)).toContain(publicId('project', 'p1'));
```

  5. Replace the test `'splits one project\'s robots per (project, machine) room'` with:

```ts
  // city-by-project §1: a project's robots on each of the owner's machines are one building
  it("sends a project's robots from each of the owner's machines under its one building", async () => {
    const client = await connect('/ws/public/pedro');
    monitorBus.publish({ tab: tab({ id: 't1', machine_id: 'm1' }), project_id: 'p1', machine_id: 'm1', owner_id: 'u1' });
    const onM1 = await nextMessage(client);
    monitorBus.publish({ tab: tab({ id: 't7', machine_id: 'm3' }), project_id: 'p1', machine_id: 'm3', owner_id: 'u1' });
    const onM3 = await nextMessage(client);
    expect(onM1.building).toBe(publicId('project', 'p1'));
    expect(onM3.building).toBe(onM1.building);
    expect(onM3.robot.id).toBe(publicId('tab', 't7'));
    client.terminate();
  });
```

  6. In `'filters by is_public and status, …'`, replace `expect(frame.room).toBe(publicRoomId('p1', 'm1'));` with `expect(frame.building).toBe(publicId('project', 'p1'));`.
  7. In `'reports the same alive as the snapshot, warm memo or cold'`, replace the `snapRepos` object and the return line of `snapshotAlive` with:

```ts
      const snapRepos = {
        users: { findByNickname: async () => pedro },
        machines: { list: async () => [{ id: 'm1', name: 'M', owner_id: 'u1' }] },
        projects: { list: async () => [p1] },
        tabs: { listByProjects: async () => [t] },
      } as unknown as Repositories;
      return (await readPublicCity(snapRepos, 'pedro'))!.buildings[0]!.robots[0]!.alive;
```

  8. In `'tells the visitor a tab of a published room is gone, by its public id only'` (rename `'…of a published building is gone…'`), replace the `toEqual` with `expect(frame).toEqual({ type: 'robot_gone', building: publicId('project', 'p1'), robot: publicId('tab', 't1') });`.

- [ ] **Step 6: Run them to see them fail.** `SRVTEST src/public/read.test.ts src/routes/public-city.test.ts src/frontend.test.ts src/public/ws.test.ts` — Expected: FAIL in `read.test.ts` (`resolvePublicCity is not a function`), `public-city.test.ts` (`listByProjectsOnMachine is not a function` → 500s), `frontend.test.ts` (the city document's read throws, so the first test answers 503 instead of 200) and the two snapshot-reading `ws.test.ts` tests; the frame tests of `ws.test.ts` already pass (Step 3 moved the builders).

- [ ] **Step 7: Implement the read.** In `apps/server/src/public/read.ts`:

Replace the first doc comment (the one starting `The one read behind both public surfaces`) with:

```ts
/**
 * The one read behind both public surfaces: a nickname, and only the projects its owner published
 * (see `resolvePublicCity`), each one a building. This never initiates an ssh round-trip: it only
 * ever *reads* the tmux memo the office already warms (`cachedTmuxProbe`), and never calls the
 * probing function that would refresh it. When the memo is warm, a terminal tab's `alive` is real
 * tmux session membership. When it is cold — nobody with the office open recently, or the memo
 * expired — the tab's own last reported state stands in for it instead (a tab that never reported
 * one reads as not alive): an anonymous visitor must not be able to make this server dial an
 * unreachable machine and wait out its timeout, and a cold city showing every desk empty would be a
 * worse answer than a stale one.
 */
```

Right after `publicAlive`, add:

```ts
/**
 * What a person's city is made of (city-by-project §2.4): their published, non-archived projects
 * (by name) — each one a building, even with no agent at all — and the machines THEY own, the only
 * ones whose tabs may be shown. A tab of a published project on a machine somebody else owns is
 * never a robot: its name is not the owner's to publish. Both lists are empty when nothing is
 * published, and the machines are not even read then.
 */
export async function resolvePublicCity(repos: Pick<Repositories, 'machines' | 'projects'>, ownerId: string): Promise<{ projects: Project[]; machines: Machine[] }> {
  // An empty id must never reach `projects.list`, where a falsy owner could read as "no filter".
  if (!ownerId) return { projects: [], machines: [] };
  // `projects.list({ owner })` already filters by owner; checked again here because this is the line
  // that decides whose work goes on the street.
  const projects = (await repos.projects.list({ owner: ownerId })).filter((p) => p.owner_id === ownerId && p.is_public && p.status !== 'archived');
  if (projects.length === 0) return { projects: [], machines: [] };
  // machines.list(ownerId) already filters by owner; checked again because this is the one line
  // standing between a published project and somebody else's machine
  const machines = (await repos.machines.list(ownerId)).filter((m) => m.owner_id === ownerId);
  return { projects, machines };
}
```

Replace `readPublicCity` with:

```ts
export async function readPublicCity(repos: Repositories, nickname: string): Promise<PublicCity | undefined> {
  const owner = await repos.users.findByNickname(nickname);
  if (!owner) return undefined;
  const { projects, machines } = await resolvePublicCity(repos, owner.id);
  if (projects.length === 0) return undefined;
  const owned = new Set(machines.map((m) => m.id));
  // one read for every building, then only what runs on a machine the owner owns
  const tabs = (await repos.tabs.listByProjects(projects.map((p) => p.id))).filter((t) => owned.has(t.machine_id));
  const probes = new Map<string, TmuxProbe | undefined>();
  const probeOf = (machineId: string): TmuxProbe | undefined => {
    if (!probes.has(machineId)) probes.set(machineId, cachedTmuxProbe(machineId));
    return probes.get(machineId);
  };
  const buildings = projects.map((project) => ({
    project,
    robots: tabs
      .filter((t) => t.project_id === project.id)
      .map((tab) => ({ tab, alive: publicAlive(tab, tab.kind === 'terminal' ? probeOf(tab.machine_id) : undefined), progress: null })),
  }));
  // A saved link keeps showing even if the key is removed later: it still works; the key gates creation and editing only.
  return toPublicCity({ nickname, ownerName: owner.name, shortUrl: effectiveShortUrl(owner), buildings });
}
```

and, in the doc comment of `readPublicCityCached`, replace `each of those was a full read (2 + 2N queries for N machines), with nothing in front of it.` with `each of those was a full read (four queries), with nothing in front of it.` Leave `resolvePublicRooms` and `roomKey` where they are: `ws.ts` still admits with them until Task A5.

- [ ] **Step 8: Run them to see them pass.** `SRVTEST src/public/city.test.ts src/public/read.test.ts src/routes/public-city.test.ts src/frontend.test.ts src/public/ws.test.ts` — Expected: PASS, except the card tests of `public-city.test.ts` (`GET /public/city/:nickname/card.png` → the rasteriser-unavailable test answers 500 instead of 302, because `card.ts` still walks `rooms`); Steps 9-11 fix those.

- [ ] **Step 9: Write the failing card and link-preview tests.** In `apps/server/src/public/card.test.ts`, replace the `city` constant and every test up to (not including) `'falls back to null instead of throwing when the rasteriser is missing'` with:

```ts
const city: PublicCity = {
  nickname: 'pedro',
  owner_name: 'Pedro',
  short_url: null,
  buildings: [
    { id: 'b1', name: 'Engage Easy', robots: [
      { id: 'x1', name: 'aba 1', kind: 'terminal', state: 'working', state_at: null, activity: 'coding', activity_verb: null, alive: true, progress: null },
      { id: 'x2', name: 'aba 2', kind: 'terminal', state: 'waiting_input', state_at: null, activity: null, activity_verb: null, alive: true, progress: null },
    ] },
    { id: 'b2', name: 'Vazio', robots: [] },
  ],
};

describe('the link preview card', () => {
  it('says whose city it is, how many projects it has and how many agents are working', () => {
    const svg = buildCardSvg(city, {});
    expect(svg).toContain('Pedro');
    expect(svg).toContain('2 projetos · 1 agente trabalhando');
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('width="1200"');
    expect(svg).toContain('height="630"');
  });

  it('names the project and counts only its own agents when the link points at a building', () => {
    expect(buildCardSvg(city, { building: 'b1' })).toContain('Engage Easy — 1 agente trabalhando');
    // §2.4: a published project with nobody in it right now is still a building with a card
    expect(buildCardSvg(city, { building: 'b2' })).toContain('Vazio — 0 agentes trabalhando');
    expect(buildCardSvg(city, { building: 'b1' })).not.toContain('projetos');
  });

  it('escapes a name that would otherwise break the drawing', () => {
    const hostile = { ...city, owner_name: 'Pedro & "cia" <b>', buildings: [{ ...city.buildings[0], name: 'a < b' }] };
    const svg = buildCardSvg(hostile, { building: 'b1' });
    expect(svg).not.toContain('<b>');
    expect(svg).toContain('&amp;');
    expect(svg).toContain('&lt;');
    expect(svg).toContain('&quot;');
  });

  // city-by-project §7: a building id of the old scheme (a machine's) is just an id that matches nothing
  it('falls back to the city card for an id that matches no building, an old machine id included', () => {
    expect(buildCardSvg(city, { building: 'old-machine-id' })).toContain('2 projetos · 1 agente trabalhando');
  });
```

and replace the `'resolves an id from the query against the real city, …'` test with:

```ts
  it('resolves an id from the query against the real city, and nothing for one that matches no building', () => {
    expect(resolveFocus(city, { building: 'b1' }).building?.name).toBe('Engage Easy');
    expect(resolveFocus(city, { building: 'not-a-real-id' }).building).toBeUndefined();
    expect(resolveFocus(city, {}).building).toBeUndefined();
  });
```

In `apps/server/src/public/city-page.test.ts`:

  1. Import `{ publicId }` only (drop `publicRoomId`).
  2. Replace `CITY` with:

```ts
const CITY: PublicCity = {
  nickname: 'pedro',
  owner_name: 'Pedro',
  short_url: null,
  buildings: [
    { id: publicId('project', 'p1'), name: 'Engage Easy', robots: [] },
    { id: publicId('project', 'p2'), name: 'A "melhor" ideia & cia', robots: [] },
  ],
};
```

  3. Replace the tests `'names the building at the building depth'`, `'names the room at the room depth'` and `'falls back one level up when a depth id matches nothing in this city, same as buildCardSvg'` with:

```ts
  it('names the project at the building depth', () => {
    const building = CITY.buildings[0]!;
    const meta = cityMetaFor(CITY, { building: building.id }, BASE);
    expect(meta.title).toBe('Engage Easy — a cidade de Pedro');
    expect(meta.description).toBe('Engage Easy, um dos projetos publicados de Pedro no termhub.');
    expect(meta.image).toBe(`https://termhub.dev/api/public/city/pedro/card.png?building=${building.id}`);
    expect(meta.url).toBe(`https://termhub.dev/city/@pedro/${building.id}`);
  });

  // city-by-project §7: links shared under the old scheme (a machine id) still open the city
  it('falls back to the city for an id that matches no building, an old machine id included, same as buildCardSvg', () => {
    const meta = cityMetaFor(CITY, { building: 'old-machine-id' }, BASE);
    expect(meta.title).toBe('A cidade de Pedro no termhub');
    expect(meta.url).toBe('https://termhub.dev/city/@pedro');
    expect(meta.image).toBe('https://termhub.dev/api/public/city/pedro/card.png');
  });
```

  4. Replace the two `depthFromCityUrl` tests that read depths with:

```ts
  it('reads the nickname without its @, and no depth when the path carries none', () => {
    expect(depthFromCityUrl('/city/@pedro')).toEqual({ nickname: 'pedro', depth: { building: undefined } });
  });

  it('reads the building segment and ignores a ?room= from the city-by-machine links', () => {
    expect(depthFromCityUrl('/city/@pedro/abc?room=xyz')).toEqual({ nickname: 'pedro', depth: { building: 'abc' } });
  });
```

  5. Replace `stubRepos()` with:

```ts
function stubRepos(): Repositories {
  const machines = [{ id: 'm1', name: 'Jarvis Office', owner_id: 'u1' }];
  const projects = [
    { id: 'p1', owner_id: 'u1', name: 'Engage Easy', status: 'active', is_public: true },
    { id: 'p2', owner_id: 'u1', name: 'A "melhor" ideia & cia', status: 'active', is_public: true },
  ];
  const tabs = [
    { id: 't1', project_id: 'p1', machine_id: 'm1', name: 'shell', kind: 'terminal', tmux_session: 'th-t1', simulator_udid: null, state: 'working' },
    { id: 't2', project_id: 'p2', machine_id: 'm1', name: 'shell', kind: 'terminal', tmux_session: 'th-t1', simulator_udid: null, state: 'working' },
  ];
  return {
    users: {
      findByNickname: vi.fn(async (nickname: string) => (nickname === 'pedro' ? { id: 'u1', name: 'Pedro' } : undefined)),
    },
    machines: { list: vi.fn(async (ownerId?: string | null) => machines.filter((m) => m.owner_id === ownerId)) },
    projects: { list: vi.fn(async ({ owner }: { owner: string }) => projects.filter((p) => p.owner_id === owner)) },
    tabs: { listByProjects: vi.fn(async (ids: string[]) => tabs.filter((t) => ids.includes(t.project_id))) },
  } as unknown as Repositories;
}
```

  6. Replace the document tests `'escapes a room name carrying " and & at the room depth'` and `'sets og:url to the canonical address of the depth the link points at'` with:

```ts
  it('escapes a project name carrying " and & at the building depth', async () => {
    const app = buildDocumentApp(stubRepos());
    const res = await app.inject({ method: 'GET', url: `/city/@pedro/${publicId('project', 'p2')}` });
    expect(res.body).toContain('content="A &quot;melhor&quot; ideia &amp; cia — a cidade de Pedro"');
    expect(res.body).not.toContain('content="A "melhor" ideia & cia — a cidade de Pedro"');
  });

  it('sets og:url to the canonical address of the building the link points at, without a ?room=', async () => {
    const app = buildDocumentApp(stubRepos());
    const building = publicId('project', 'p1');
    const res = await app.inject({ method: 'GET', url: `/city/@pedro/${building}?room=anything` });
    expect(res.body).toContain(`<meta property="og:url" content="https://termhub.dev/city/@pedro/${building}" />`);
    // the machine hosting the tabs is named nowhere in the document
    expect(res.body).not.toContain('Jarvis Office');
  });
```

In `apps/server/src/routes/public-city.test.ts`, add inside `describe('GET /public/city/:nickname/card.png', …)`, after `'falls back to the landing card, not a 400, for an oversized or repeated ?building='`:

```ts
  // city-by-project §2.5: the card takes `?building=` only; a `?room=` of an old link is not read
  it('does not read a ?room= at all, however it is written', async () => {
    vi.stubEnv('TERMHUB_RSVG_BIN', '/nonexistent/rsvg-convert');
    const { app } = buildApp();
    const res = await app.inject({ method: 'GET', url: `/public/city/pedro/card.png?room=${'x'.repeat(65)}&room=y` });
    vi.unstubAllEnvs();
    // the city read and the rasteriser were reached (the fallback here is the missing binary's), not a query refusal
    expect(res.statusCode).toBe(302);
    expect(renderCardSpy).toHaveBeenCalledTimes(1);
  });
```

- [ ] **Step 10: Run them to see them fail.** `SRVTEST src/public/card.test.ts src/public/city-page.test.ts src/routes/public-city.test.ts` — Expected: FAIL (card: `b.rooms` is undefined; meta: old copy and `?room=` kept; the new card-route test: the old `cardQuery` refuses the oversized `room` before rasterising, so `renderCardSpy` is not called).

- [ ] **Step 11: Implement the card, the document and the card route.** In `apps/server/src/public/card.ts`, replace everything from the first line to the end of `buildCardSvg` with:

```ts
import { spawn } from 'node:child_process';
import type { PublicBuilding, PublicCity } from './city.js';

/**
 * The link preview card: what WhatsApp, Slack and X show before anyone clicks. It is drawn in the
 * same visual language as `apps/landing/og/og-image.svg` (same size, same palette, same product
 * mark), but for the city the link points at — whose city, how many projects it shows, and how many
 * agents are working right now — instead of one fixed image for every link.
 */

const CARD_WIDTH = 1200;
const CARD_HEIGHT = 630;

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Every name in the card was written by someone else (an owner's name, a project's): never trust it as markup. */
function xml(s: string): string {
  // ASCII control characters (tab/newline/CR included — these are single-line labels) are not
  // valid XML text content; rsvg-convert simply fails to parse them, silently breaking that one
  // city's card while every other city keeps working. Strip before escaping the XML metacharacters.
  return s.replace(/[\x00-\x1F\x7F]/g, '').replace(/[&<>"']/g, (c) => ESCAPES[c]!);
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * The building a link points at, resolved from the public (obfuscated) id in the query. Exported so
 * a caller (the route's cache) can key on what this actually resolved to rather than on the raw
 * query string — an id that matches nothing (a stale one, or a machine id from the links of the
 * city by machine) must collapse onto the same entry as no id at all, not mint one cache entry per
 * garbage value.
 */
export function resolveFocus(city: PublicCity, focus: { building?: string }): { building?: PublicBuilding } {
  return { building: focus.building ? city.buildings.find((b) => b.id === focus.building) : undefined };
}

export function buildCardSvg(city: PublicCity, focus: { building?: string }): string {
  const { building } = resolveFocus(city, focus);

  // What "is happening right now" scopes to the depth the link points at: a building card counts
  // only that project's agents, the city card counts everyone's.
  const robots = building ? building.robots : city.buildings.flatMap((b) => b.robots);
  const agents = plural(robots.filter((r) => r.state === 'working').length, 'agente trabalhando', 'agentes trabalhando');
  const live = building ? `${xml(building.name)} — ${agents}` : `${plural(city.buildings.length, 'projeto', 'projetos')} · ${agents}`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_WIDTH}" height="${CARD_HEIGHT}" viewBox="0 0 ${CARD_WIDTH} ${CARD_HEIGHT}">
  <defs>
    <linearGradient id="cta" x1="0" y1="1" x2="1" y2="0">
      <stop offset="0" stop-color="#5b63d3"/>
      <stop offset="1" stop-color="#7c87f7"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.85" cy="0.1" r="0.7">
      <stop offset="0" stop-color="#5b63d3" stop-opacity="0.35"/>
      <stop offset="1" stop-color="#0f101a" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="${CARD_WIDTH}" height="${CARD_HEIGHT}" fill="#0f101a"/>
  <rect width="${CARD_WIDTH}" height="${CARD_HEIGHT}" fill="url(#glow)"/>
  <!-- mark: the same terminal-window icon as public/logo.svg's, self-contained so rasterising needs no second file -->
  <g transform="translate(90 56)">
    <rect x="1" y="1" width="64" height="64" rx="14" fill="#151621" stroke="#1f2433" stroke-width="2"/>
    <circle cx="14" cy="14" r="2.6" fill="#646e87"/>
    <circle cx="23" cy="14" r="2.6" fill="#939db8"/>
    <circle cx="32" cy="14" r="2.6" fill="#c9d3ee"/>
    <polyline points="15,30 28,41 15,52" fill="none" stroke="url(#cta)" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>
    <rect x="35" y="47" width="17" height="6" rx="2" fill="url(#cta)"/>
  </g>
  <text x="170" y="98" font-family="Inter, sans-serif" font-size="34" font-weight="700" fill="#e6e8ee">termhub</text>
  <text x="1110" y="98" text-anchor="end" font-family="Inter, sans-serif" font-size="24" fill="#646e87">termhub.dev</text>
  <text x="90" y="260" font-family="Inter, sans-serif" font-size="60" font-weight="700" fill="#c9d3ee">Cidade de ${xml(city.owner_name)}</text>
  <text x="90" y="400" font-family="Inter, sans-serif" font-size="34" font-weight="600" fill="#c9d3ee">${live}</text>
  <rect x="90" y="530" width="404" height="46" rx="10" fill="#151621" stroke="#1f2433" stroke-width="2"/>
  <circle cx="118" cy="553" r="5" fill="#98a4f7"/>
  <text x="134" y="562" font-family="Inter, sans-serif" font-size="22" fill="#c9d3ee">self-hosted · open source · MIT</text>
</svg>
`;
}
```

(`renderCard` below it is unchanged.)

In `apps/server/src/public/city-page.ts`, replace everything from the top of the file to the end of `cityMetaFor` with:

```ts
import type { Repositories } from '../db/repositories/index.js';
import { normalizeNickname } from './nickname.js';
import { readPublicCityCached } from './read.js';
import type { PublicCity } from './city.js';

/** Where along `/city/@nick[/building]` a link points. A `?room=` from the links of the city by machine is not read. */
export interface CityDepth {
  building?: string;
}

interface CityMeta {
  title: string;
  description: string;
  image: string;
  /** og:url; absent for the neutral not-found document */
  url?: string;
}

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Every value spliced into the document — an owner's or a project's name — was written by someone else: never trust it as markup. */
function attr(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESCAPES[c]!);
}

/** The neutral document for a nickname nobody can read a city out of: no name, the landing's own card. */
const FALLBACK_TITLE = 'Cidade não encontrada · termhub';
const FALLBACK_DESCRIPTION = 'Cada tab é uma sessão tmux que sobrevive ao navegador. Self-hosted, open source (MIT).';

/**
 * Every absolute URL below is built from this instance's own public-city address
 * (`config.publicCityUrl`, e.g. https://termhub.dev/city), never a hardcoded host: on a self-hosted
 * instance a termhub.dev URL would unfurl to somebody else's city, or to nothing.
 */
const originOf = (base: string) => new URL(base).origin;

/** The card this depth's link unfurls to — the same nickname and `?building=` the page itself carries. */
function cardImageUrl(base: string, nickname: string, depth: CityDepth): string {
  const qs = depth.building ? `?${new URLSearchParams({ building: depth.building }).toString()}` : '';
  return `${originOf(base)}/api/public/city/${encodeURIComponent(nickname)}/card.png${qs}`;
}

/** The canonical address of this depth of the city: the same shape the app's share button copies. */
function cityPageUrl(base: string, nickname: string, depth: CityDepth): string {
  return `${base}/@${encodeURIComponent(nickname)}${depth.building ? `/${encodeURIComponent(depth.building)}` : ''}`;
}

/**
 * The link preview's text for the depth a `/city/@nick[/building]` URL points at: the city, or one
 * of its buildings (a published project). A building id that matches nothing in the city — a stale
 * link, or a machine id from the links of the city by machine — resolves to the city, the same
 * forgiving rule `buildCardSvg` uses: never a broken page over a slightly-too-shallow one.
 */
export function cityMetaFor(city: PublicCity | undefined, depth: CityDepth, base: string): CityMeta {
  if (!city) return { title: FALLBACK_TITLE, description: FALLBACK_DESCRIPTION, image: `${originOf(base)}/og-image.png` };
  const building = depth.building ? city.buildings.find((b) => b.id === depth.building) : undefined;
  const resolved: CityDepth = { building: building?.id };
  const image = cardImageUrl(base, city.nickname, resolved);
  const url = cityPageUrl(base, city.nickname, resolved);
  if (building) {
    return {
      title: `${building.name} — a cidade de ${city.owner_name}`,
      description: `${building.name}, um dos projetos publicados de ${city.owner_name} no termhub.`,
      image,
      url,
    };
  }
  return {
    title: `A cidade de ${city.owner_name} no termhub`,
    description: `Terminais e projetos publicados por ${city.owner_name}, ao vivo, no termhub.`,
    image,
    url,
  };
}
```

and replace `depthFromCityUrl` (with its doc comment) with:

```ts
/** The nickname and the building of a `/city/@nick[/building]` request URL — the server-side mirror of `apps/web/src/city/url.ts`. Any query string (an old `?room=`) is ignored. */
export function depthFromCityUrl(url: string): { nickname: string; depth: CityDepth } {
  const [pathname = ''] = url.split('?');
  const parts = pathname.split('/').filter(Boolean); // ['city', '@nick', 'building'?]
  const nickname = (segment(parts[1]) ?? '').replace(/^@/, '');
  return { nickname, depth: { building: segment(parts[2]) } };
}
```

In `apps/server/src/routes/public-city.ts`, replace the `cardQuery` comment and declaration with:

```ts
// `building` is a public (obfuscated) id from PublicCity, 22 base64url characters; the cap is a
// generous safety limit, not a shape check — an id that matches nothing (a stale one, or a machine
// id from the links of the city by machine) renders the city-level card (see buildCardSvg's own
// resolution). A `?room=` from those old links is not read at all. A query that does not fit (an
// oversized id, a repeated parameter) falls back to the landing card like every other malformed
// input on this route, never a 400 with validation details.
const cardQuery = z.object({ building: z.string().max(64).optional() });
```

replace `cardCacheKey` with:

```ts
/** The cache key for a nickname at a resolved depth: an unresolved id folds onto the same key as no id at all. */
function cardCacheKey(nickname: string, focus: { building?: { id: string } }): string {
  return `${nickname}:${focus.building?.id ?? ''}`;
}
```

and in the card handler replace `const { building, room } = query.data;` with `const { building } = query.data;`, `resolveFocus(city, { building, room })` with `resolveFocus(city, { building })`, and `buildCardSvg(city, { building, room })` with `buildCardSvg(city, { building })`. In the two doc comments of that file, change "buildings/rooms" to "buildings" and "the *resolved* building/room" to "the *resolved* building" and "random ?building=/?room= values" to "random ?building= values".

- [ ] **Step 12: Run everything this task touched, the typecheck and the DB tests.**
  - `SRVTEST src/public/city.test.ts src/public/read.test.ts src/public/card.test.ts src/public/city-page.test.ts src/routes/public-city.test.ts src/frontend.test.ts src/public/ws.test.ts` — Expected: PASS (0 failed; the `with a real rsvg-convert on PATH` block skips in `node:20`).
  - `DOCKER 'npm run typecheck -w @termhub/server'` — Expected: exit 0.
  - `DBTEST src/public/read.db.test.ts src/frontend.test.ts` — Expected: PASS (7 Postgres tests in `read.db.test.ts`, and the `buildApp serving the frontends (Postgres)` test).

- [ ] **Step 13: Commit.**

```bash
git add apps/server/src/public/city.ts apps/server/src/public/city.test.ts apps/server/src/public/read.ts apps/server/src/public/read.test.ts apps/server/src/public/read.db.test.ts apps/server/src/public/ws.ts apps/server/src/public/ws.test.ts apps/server/src/public/card.ts apps/server/src/public/card.test.ts apps/server/src/public/city-page.ts apps/server/src/public/city-page.test.ts apps/server/src/routes/public-city.ts apps/server/src/routes/public-city.test.ts apps/server/src/frontend.test.ts
git commit -m "Public city: one building per published project, no machine in it

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---
### Task A5: The live channel by project — `RobotsGone` and the (published × owned) rule

**Files:**
- Modify: `apps/server/src/public/bus.ts` (`RoomsGone` → `RobotsGone`)
- Modify: `apps/server/src/public/ws.ts` (whole file)
- Modify: `apps/server/src/public/read.ts` (memo subscription; delete `resolvePublicRooms` and `roomKey`)
- Modify: `apps/server/src/routes/projects.ts:138-152`, `:199`, `:221-222`; `apps/server/src/routes/machines.ts:152-156`, `:173-175`
- Test: `apps/server/src/public/ws.test.ts`, `apps/server/src/public/read.test.ts`, `apps/server/src/routes/machines.owner.test.ts`, `apps/server/src/routes/projects.publish.test.ts`

**Interfaces:**
- Consumes: `resolvePublicCity(repos, ownerId)` (Task A4); `toPublicRobotFrame({ projectId, tab, alive, progress })`, `toPublicRobotGone({ projectId, tabId })` (Task A4); `monitorBus` changes `{ tab, project_id, machine_id, owner_id }` where `owner_id` is the owner of the machine the tab runs on (`monitor/ingest.ts` `publishTabChange`).
- Produces:

```ts
// apps/server/src/public/bus.ts
export interface RobotsGone { machine_id: string; project_id?: string }
publicBus.publishRobotsGone(gone: RobotsGone): void;
publicBus.subscribeRobotsGone(listener: (gone: RobotsGone) => void): () => void;   // event name 'robots-gone'
```

  Socket rule (`/ws/public/<nickname>`): at admission the socket resolves `published` (project ids) and `owned` (machine ids) from `resolvePublicCity`; 404 when nothing is published. It forwards a monitor change only when `change.owner_id === owner.id`, `project_id ∈ published` and `machine_id ∈ owned`; a `TabRemoved` only when `project_id ∈ published` and `machine_id ∈ owned`. A change **touches** the socket when: unpublished `p` with `p ∈ published`; `RobotsGone { machine_id: m }` with `m ∈ owned`; `RobotsGone { machine_id: m, project_id: p }` with `m ∈ owned` and `p ∈ published`; `OwnerGone` of this owner. A touching change is taken off the sets and the socket closes (`1000`, reason `'unpublished'` or `'robots gone'`); the page then re-reads the snapshot, which is how a building or a machine's robots leave the visitor's screen (frames never name a machine, so the page could not drop them by itself). The memo in `read.ts` is cleared on `RobotsGone` as it was on `RoomsGone`.

- [ ] **Step 1: Write the failing tests.** In `apps/server/src/public/ws.test.ts`:

  1. Replace the comment and constants from `// Pedro owns m1 and m3; mB is somebody else's machine…` down to the end of `const links = [ … ];` with:

```ts
// Pedro owns m1 and m3; mB is somebody else's machine that p1 also runs on (city-by-project §2.4:
// a robot there is never shown, whatever owner a change claims).
const machinesOfPedro = [
  // m1 carries a subtitle: the owner's own note about the machine, never on the street
  { id: 'm1', name: 'M1', subtitle: 'MacBook do escritório secreto', owner_id: 'u1' },
  { id: 'm3', name: 'M3', subtitle: null, owner_id: 'u1' },
];
```

  2. In the `repos` declaration and in `beforeEach`, delete the `projectMachines` member (the socket no longer reads links).
  3. Replace the test `'closes the socket when the room is unpublished'` with:

```ts
  it('closes the socket when a building is unpublished', async () => {
    const client = await connect('/ws/public/pedro');
    publicBus.publish({ project_id: 'p1', is_public: false });
    await expect(closed(client)).resolves.toBe(true);
  });

  // Review focus 5: a building leaves the street at once, not only when it is the last one — the
  // page re-reads the snapshot on the hang-up, and that is how the building disappears from it.
  it('closes the socket when one of several buildings is unpublished', async () => {
    repos.projects.list.mockResolvedValue([p1, { ...p1, id: 'p4' }, p2, p3]);
    const client = await connect('/ws/public/pedro');
    const wentClosed = closed(client);
    publicBus.publish({ project_id: 'p4', is_public: false });
    await expect(wentClosed).resolves.toBe(true);
  });
```

  4. Replace the two tests `'closes the socket when a building of this city leaves the street, not when another does'` and `'closes the socket when a published project is unlinked from one of its buildings'` with:

```ts
  // A machine that changes owner or is deleted takes its robots off the street; the building stays,
  // and the page watching it is hung up so it re-reads the snapshot without them.
  it("hangs up when a machine of this owner leaves the street, not when somebody else's does", async () => {
    const client = await connect('/ws/public/pedro');
    let isClosed = false;
    client.on('close', () => (isClosed = true));
    publicBus.publishRobotsGone({ machine_id: 'mB' }); // never pedro's
    publicBus.publishRobotsGone({ machine_id: 'm1', project_id: 'p2' }); // a private project unlinked
    await new Promise((r) => setTimeout(r, 100));
    expect(isClosed).toBe(false);
    publicBus.publishRobotsGone({ machine_id: 'm3' });
    await vi.waitFor(() => expect(isClosed).toBe(true));
  });

  it("hangs up when a published project is unlinked from one of the owner's machines", async () => {
    const client = await connect('/ws/public/pedro');
    const wentClosed = closed(client);
    publicBus.publishRobotsGone({ machine_id: 'm3', project_id: 'p1' });
    await expect(wentClosed).resolves.toBe(true);
  });
```

  5. In the admission-race loop, change the event list to `['unpublish', 'robots-gone', 'owner-gone'] as const`, the title to `` `never streams what stopped being public (${event}) while the city was being resolved` `` and the middle branch to `else if (event === 'robots-gone') publicBus.publishRobotsGone({ machine_id: 'm1' });`.
  6. Replace the test `'refuses a nickname whose published projects sit only on other people\'s machines'` with:

```ts
  // city-by-project §2.4: a published project is a building even when none of its agents runs on a
  // machine its owner owns — and none of those agents is ever sent
  it("admits a city whose published project runs only on other people's machines, and sends none of those robots", async () => {
    repos.machines.list.mockResolvedValue([]);
    const client = await connect('/ws/public/pedro');
    monitorBus.publish({ tab: tab({ id: 't8', machine_id: 'mB' }), project_id: 'p1', machine_id: 'mB', owner_id: 'u1' });
    await expect(nextMessage(client, { timeoutMs: 300 })).rejects.toThrow(/timeout/);
    client.terminate();
  });

  it('refuses a nickname that published nothing', async () => {
    repos.projects.list.mockResolvedValue([p2, p3]);
    await expect(connect('/ws/public/pedro')).rejects.toThrow(/404/);
  });
```

  7. In `'tells the visitor a tab of a published building is gone, by its public id only'`, after the `p2` line add:

```ts
    publicBus.publishTabRemoved({ tab_id: 't8', project_id: 'p1', machine_id: 'mB' }); // not pedro's machine: nothing
```

In `apps/server/src/public/read.test.ts`, replace the test `'forgets everything the moment rooms leave the street'` with:

```ts
  // Robots leaving the street (owner reassigned, machine deleted, project unlinked) is as immediate
  // as an unpublish.
  it('forgets everything the moment robots leave the street', async () => {
    const { repos, findByNickname } = stubRepos();
    await readPublicCityCached(repos, 'pedro');
    publicBus.publishRobotsGone({ machine_id: 'm1' });
    await readPublicCityCached(repos, 'pedro');
    expect(findByNickname).toHaveBeenCalledTimes(2);
  });
```

In `apps/server/src/routes/machines.owner.test.ts`: import `type RobotsGone` instead of `type RoomsGone`; declare `let gone: RobotsGone[];`; subscribe with `publicBus.subscribeRobotsGone((g) => gone.push(g))`; rename the three tests that check `gone` to `"drops the machine's robots from open public pages when its owner changes, without unpublishing anything"`, `"also when the machine is left without an owner"` (unchanged) and `"drops the machine's robots from open public pages when the machine is deleted"`. Their assertions (`expect(gone).toEqual([{ machine_id: 'm1' }])`) stay.

In `apps/server/src/routes/projects.publish.test.ts`: `const gone = vi.spyOn(publicBus, 'publishRobotsGone');`, and rename the test `'unlinking a machine drops that one room from open public pages, and unpublishes nothing'` to `"unlinking a machine drops that project's robots on it from open public pages, and unpublishes nothing"` (its assertion `expect(gone).toHaveBeenCalledWith({ machine_id: 'm1', project_id: 'p3' })` stays).

- [ ] **Step 2: Run them to see them fail.** `SRVTEST src/public/ws.test.ts src/public/read.test.ts src/routes/machines.owner.test.ts src/routes/projects.publish.test.ts` — Expected: FAIL (`publicBus.publishRobotsGone`/`subscribeRobotsGone` are not functions; `vi.spyOn` cannot spy on a missing `publishRobotsGone`; without `projectMachines` in the repos the socket's admission throws, so connects fail).

- [ ] **Step 3: Implement the bus.** In `apps/server/src/public/bus.ts`, replace the `RoomsGone` interface (with its comment) by:

```ts
/**
 * Robots left the street without their building being unpublished: a machine changed owner or was
 * deleted (every robot on it, `project_id` absent), or one project was unlinked from a machine (that
 * project's robots on it). The building stays; the public sockets that showed one of those robots
 * hang up, so the page re-reads the snapshot without them.
 */
export interface RobotsGone { machine_id: string; project_id?: string }
```

and the two methods by:

```ts
  publishRobotsGone(gone: RobotsGone): void { this.emitter.emit('robots-gone', gone); }
  subscribeRobotsGone(listener: (gone: RobotsGone) => void): () => void {
    this.emitter.on('robots-gone', listener);
    return () => this.emitter.off('robots-gone', listener);
  }
```

In `apps/server/src/public/read.ts`, replace

```ts
// A building or a room leaving the street (owner reassigned, machine deleted, project unlinked), likewise.
publicBus.subscribeRoomsGone(() => cityMemo.clear());
```

with

```ts
// Robots leaving the street (a machine reassigned or deleted, a project unlinked), likewise.
publicBus.subscribeRobotsGone(() => cityMemo.clear());
```

and delete `resolvePublicRooms` and `roomKey` with their doc comments (nothing uses them after the socket below).

In `apps/server/src/routes/projects.ts`, line 221-222:

```ts
    // that project's robots on this machine leave the street at once (the building stays)
    publicBus.publishRobotsGone({ machine_id: machineId, project_id: id });
```

and adjust the comments: line 138-139 "watching this project's rooms" → "watching this project's building"; line 141 "Archiving takes the rooms out of the snapshot's filter" → "Archiving takes the building out of the snapshot's filter"; line 149 "a published project's rooms back" → "a published project's building back"; line 199 → `// a published project on a new machine may bring its robots there onto the street: the next public read must see them`; line 177 "A deleted room can never be publicly visible again" → "A deleted project can never be publicly visible again".

In `apps/server/src/routes/machines.ts`, in `PATCH /:id`, replace the three-line comment that starts `// A city only ever shows machines its person owns`, the `if (owner_id !== undefined && owner_id !== current.owner_id) {` line, the `publicBus.publishRoomsGone({ machine_id: id });` call and the `request.log.info(…, 'machine transferred: left its old owner\'s public city');` line under it with:

```ts
    // A city only ever shows the robots on machines its person owns (public/read.ts), so a
    // transferred machine's robots leave the old owner's city by that rule alone — the projects stay
    // published (they belong to their owners, not to the machine). Any public page showing them
    // hangs up and re-reads.
    if (owner_id !== undefined && owner_id !== current.owner_id) {
      publicBus.publishRobotsGone({ machine_id: id });
      request.log.info({ machineId: id }, 'machine transferred: its robots left its old owner\'s public city');
```

and, in `DELETE /:id`, the `publishTabsRemoved` line with the comment and the `publishRoomsGone` call under it with:

```ts
    await publishTabsRemoved(repos, tabs, [machine]);
    // its robots leave every public city at once (the projects, and their publish switch, stay)
    publicBus.publishRobotsGone({ machine_id: id });
```

- [ ] **Step 4: Implement the socket.** Replace `apps/server/src/public/ws.ts` with:

```ts
import { WebSocketServer, WebSocket } from 'ws';
import type { FastifyBaseLogger } from 'fastify';
import type { createUpgradeRouter } from '../ws/router.js';
import type { Repositories } from '../db/repositories/index.js';
import { rejectUpgrade, type PublicUpgradeContext } from '../ws/router.js';
import { monitorBus } from '../monitor/bus.js';
import { publicBus } from './bus.js';
import { toPublicRobotFrame, toPublicRobotGone } from './city.js';
import { normalizeNickname } from './nickname.js';
import { publicAlive, resolvePublicCity } from './read.js';
import { cachedTmuxProbe } from '../terminal/machine-exec.js';

/**
 * `/ws/public/<nickname>`: the live city for a visitor with no account. It is not `/ws/monitor` with
 * a filter — a different channel, a different payload, and a city (the owner's published projects
 * and the machines they own, see `resolvePublicCity`) resolved at connect and kept current by
 * `publicBus`, so unpublishing, a machine changing owner or being deleted, a project unlinked or the
 * owner deleted drops the socket instead of leaving somebody watching what is no longer public.
 */
/** Every public socket this process holds at once, across all cities: past it, new visitors get a 503. */
export const PUBLIC_WS_MAX_SOCKETS = 1_000;
/** How often each public socket is pinged; one that has not answered the previous ping is dropped. */
export const PUBLIC_WS_HEARTBEAT_MS = 30_000;

/** How many times admission re-reads a city that changed under it before answering 503. */
export const PUBLIC_WS_ADMISSION_ATTEMPTS = 3;

/** What one socket may show: the owner's published projects (its buildings) and the machines they own (the only ones whose robots it sends). */
interface CityScope {
  published: Set<string>;
  owned: Set<string>;
}

/** A public-bus change that can take something off a socket: a project unpublished (or archived or deleted), robots leaving the street, the owner deleted. */
type PublicCityChange =
  | { kind: 'unpublished'; projectId: string }
  | { kind: 'robots-gone'; machineId: string; projectId?: string }
  | { kind: 'owner-gone'; ownerId: string };

/** Whether a change takes anything off this city: one of its buildings, or robots it could show. */
function touches(change: PublicCityChange, ownerId: string, city: CityScope): boolean {
  switch (change.kind) {
    case 'unpublished':
      return city.published.has(change.projectId);
    case 'robots-gone':
      return city.owned.has(change.machineId) && (change.projectId === undefined || city.published.has(change.projectId));
    case 'owner-gone':
      return change.ownerId === ownerId;
  }
}

/** Takes what a change touches off the sets the forwarding rule reads, so nothing more of it is ever sent. */
function drop(change: PublicCityChange, city: CityScope): void {
  switch (change.kind) {
    case 'unpublished':
      city.published.delete(change.projectId);
      return;
    case 'robots-gone':
      // a machine gone from this person (another owner, or deleted): none of its robots may be sent
      // again; an unlinked project's robots there were deleted with the link
      if (change.projectId === undefined) city.owned.delete(change.machineId);
      return;
    case 'owner-gone':
      city.published.clear();
      city.owned.clear();
  }
}

export function registerPublicWs(
  router: ReturnType<typeof createUpgradeRouter>,
  deps: { repos: Repositories; log: FastifyBaseLogger; limits?: { maxSockets?: number; heartbeatMs?: number } },
): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 });
  const log = deps.log.child({ mod: 'public-ws' });
  const maxSockets = deps.limits?.maxSockets ?? PUBLIC_WS_MAX_SOCKETS;

  // These sockets are anonymous, skip the Origin check (any page can open them from its visitors'
  // browsers) and sit behind a one-hour proxy read timeout: nginx's per-IP cap is the only other
  // bound. So the process keeps its own: a ceiling on how many it holds (counting upgrades still
  // resolving their nickname), and a ping per interval that drops a half-open socket which never
  // answered the last one, instead of letting it hold its bus listeners until the proxy gives up.
  let slots = 0;
  const answered = new WeakMap<WebSocket, boolean>();
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (answered.get(ws) === false) {
        ws.terminate();
        continue;
      }
      answered.set(ws, false);
      ws.ping();
    }
  }, deps.limits?.heartbeatMs ?? PUBLIC_WS_HEARTBEAT_MS);
  heartbeat.unref();
  wss.on('close', () => clearInterval(heartbeat));

  router.addPublic(/^\/ws\/public\/([^/]+)\/?$/, async (ctx) => {
    if (slots >= maxSockets) {
      log.warn({ slots }, 'public visitor refused: socket ceiling reached');
      return rejectUpgrade(ctx.socket, 503, 'Service Unavailable');
    }
    slots++;
    let held = true;
    const release = () => {
      if (!held) return;
      held = false;
      slots--;
    };
    // The slot goes back with the socket, however it ends: a visitor who resets the connection
    // while the nickname lookups below are still pending, or a handshake `ws` aborts without ever
    // calling back. Attached here, where the slot is taken, not after the awaits — by then the
    // socket may already have closed and the listener would never fire. (The router gives every
    // upgrade socket an `error` listener, so a reset surfaces here as `close`.)
    ctx.socket.once('close', release);
    try {
      await admit(ctx, release);
    } catch (err) {
      release();
      throw err;
    }
  });

  async function admit(ctx: PublicUpgradeContext, release: () => void): Promise<void> {
    // The public bus is listened to from the very start of admission, not from the moment the socket
    // opens: the city is resolved across several awaits, and an unpublish, an archive, robots leaving
    // the street or the owner being deleted that lands during them would otherwise be missed for
    // good — the socket would then stream something that is already private. While admission runs,
    // changes are only recorded; once the socket is open, they are applied (see `live` below).
    const pending: PublicCityChange[] = [];
    let onChange: (change: PublicCityChange) => void = (change) => pending.push(change);
    const offs = [
      publicBus.subscribe((change) => {
        if (!change.is_public) onChange({ kind: 'unpublished', projectId: change.project_id });
      }),
      publicBus.subscribeRobotsGone((gone) => onChange({ kind: 'robots-gone', machineId: gone.machine_id, projectId: gone.project_id })),
      publicBus.subscribeOwnerGone((gone) => onChange({ kind: 'owner-gone', ownerId: gone.owner_id })),
    ];
    const unsubscribe = () => {
      for (const off of offs.splice(0)) off();
    };
    // However admission ends — refused, reset by the visitor, a handshake `ws` aborts without
    // calling back, or the open socket closing later — the listeners go with the socket.
    ctx.socket.once('close', unsubscribe);
    let upgrading = false;
    try {
      upgrading = await admitResolved(ctx, release, {
        takePending: () => pending.splice(0),
        goLive: (live) => {
          onChange = live;
          return unsubscribe;
        },
      });
    } finally {
      if (!upgrading) unsubscribe();
    }
  }

  async function admitResolved(
    { req, socket, head, params }: PublicUpgradeContext,
    release: () => void,
    changes: { takePending: () => PublicCityChange[]; goLive: (live: (change: PublicCityChange) => void) => () => void },
  ): Promise<boolean> {
    const reject = (status: number, text: string) => {
      release();
      rejectUpgrade(socket, status, text);
      return false;
    };
    // A malformed escape (`%`) makes decodeURIComponent throw; every rejected nickname answers
    // the same 404, not a 500 that would tell a stranger their input broke something.
    let raw: string;
    try {
      raw = decodeURIComponent(params[0] ?? '');
    } catch {
      return reject(404, 'Not Found');
    }
    const parsed = normalizeNickname(raw);
    if (!parsed.ok) return reject(404, 'Not Found');
    const owner = await deps.repos.users.findByNickname(parsed.value);
    if (!owner) return reject(404, 'Not Found');
    const resolveCity = async (): Promise<CityScope> => {
      const { projects, machines } = await resolvePublicCity(deps.repos, owner.id);
      return { published: new Set(projects.map((p) => p.id)), owned: new Set(machines.map((m) => m.id)) };
    };
    // A change recorded while the city was read may have landed after the read (the read is then
    // stale) or before it (harmless): only one that touches what the read returned forces a re-read.
    // Past a few attempts under a storm of changes, the visitor is told to come back.
    let city = await resolveCity();
    for (let attempt = 1; changes.takePending().some((change) => touches(change, owner.id, city)); attempt++) {
      if (attempt >= PUBLIC_WS_ADMISSION_ATTEMPTS) {
        log.warn({ nickname: parsed.value }, 'public visitor refused: the city kept changing during admission');
        return reject(503, 'Service Unavailable');
      }
      city = await resolveCity();
    }
    if (city.published.size === 0) return reject(404, 'Not Found');
    // The visitor left while the lookups ran: nothing to upgrade (its `close` already released the slot).
    if (socket.destroyed) {
      release();
      return false;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
      answered.set(ws, true);
      ws.on('pong', () => answered.set(ws, true));
      const offTab = monitorBus.subscribe((change) => {
        // all three: the monitor names this person as the machine's owner, the project is one of
        // their published buildings, and the machine is one they own — a tab of their project on
        // somebody else's machine is never a robot
        if (change.owner_id !== owner.id || !city.published.has(change.project_id) || !city.owned.has(change.machine_id)) return;
        if (ws.readyState !== WebSocket.OPEN) return;
        // A change proves the tab's tmux session existed once, not that it still does (a plain
        // "seen" click on the tab publishes here too): the same rule as the snapshot, reading the
        // same memo (never probing), so a visitor never sees the two public surfaces disagree.
        const probe = change.tab.kind === 'terminal' ? cachedTmuxProbe(change.machine_id) : undefined;
        const alive = publicAlive(change.tab, probe);
        ws.send(JSON.stringify(toPublicRobotFrame({ projectId: change.project_id, tab: change.tab, alive, progress: null })));
      });
      /**
       * Takes what a change touches off this city and hangs up: the page re-reads the snapshot, the
       * one place that can say which buildings and robots are still on the street — a frame never
       * names a machine, so the page could not drop a machine's robots by itself.
       */
      const live = (change: PublicCityChange) => {
        if (!touches(change, owner.id, city)) return;
        drop(change, city);
        ws.close(1000, change.kind === 'robots-gone' ? 'robots gone' : 'unpublished');
      };
      // Anything that landed between the last read and this callback is applied before going live.
      const early = changes.takePending();
      const offPublic = changes.goLive(live);
      for (const change of early) live(change);
      const offGone = publicBus.subscribeTabRemoved((removed) => {
        if (!city.published.has(removed.project_id) || !city.owned.has(removed.machine_id) || ws.readyState !== WebSocket.OPEN) return;
        ws.send(JSON.stringify(toPublicRobotGone({ projectId: removed.project_id, tabId: removed.tab_id })));
      });
      const teardown = () => {
        offTab();
        offPublic();
        offGone();
        release();
      };
      log.info({ nickname: parsed.value, buildings: city.published.size }, 'public visitor connected');
      ws.on('close', () => {
        teardown();
        log.info({ nickname: parsed.value, buildings: city.published.size }, 'public visitor disconnected');
      });
      // A server-side ws socket with no error listener throws on a protocol violation (e.g. a
      // frame over maxPayload) — uncaught, that takes the whole process down. This route is
      // unauthenticated on a vhost with no Cloudflare Access, so it gets no benefit of the doubt.
      ws.on('error', (err) => {
        teardown();
        log.warn({ nickname: parsed.value, err: err.message }, 'public visitor socket error');
      });
    });
    return true;
  }

  return wss;
}
```

- [ ] **Step 5: Run them to see them pass, and typecheck.** `SRVTEST src/public/ws.test.ts src/public/read.test.ts src/routes/machines.owner.test.ts src/routes/projects.publish.test.ts` — Expected: PASS (0 failed). `DOCKER 'npm run typecheck -w @termhub/server'` — Expected: exit 0. Then `grep -rn "RoomsGone\|resolvePublicRooms\|roomKey" apps/server/src` — Expected: no output.

- [ ] **Step 6: Commit.**

```bash
git add apps/server/src/public/bus.ts apps/server/src/public/ws.ts apps/server/src/public/ws.test.ts apps/server/src/public/read.ts apps/server/src/public/read.test.ts apps/server/src/routes/projects.ts apps/server/src/routes/machines.ts apps/server/src/routes/machines.owner.test.ts apps/server/src/routes/projects.publish.test.ts
git commit -m "Public city: stream robots of published projects on owned machines

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task A6: Only project and tab ids on the street; Part A verified whole

**Files:**
- Modify: `apps/server/src/public/public-id.ts` (the `publicId` kind union; delete `publicRoomId`)
- Test: `apps/server/src/public/public-id.test.ts`

**Interfaces:**
- Consumes: nothing new — after Tasks A1-A5 no server code asks for a `'machine'` or `'room'` id.
- Produces: `publicId(kind: 'project' | 'tab', realId: string): string` (unchanged construction, so every id already published keeps its value; the golden `publicId('project', 'p_0123456789abcdef') === 'XqnUzs9jCu74u3srI8PIlw'` holds). `publicRoomId` no longer exists.

- [ ] **Step 1: Update the test.** In `apps/server/src/public/public-id.test.ts`: change the import to `import { PUBLIC_ID_KEY_NAME, generatePublicIdKey, loadPublicIdKey, publicId, setPublicIdKey } from './public-id.js';`; in `'keeps the shape the routes and the frontend expect: 22 base64url characters'` use `publicId('tab', 'm1')`; delete the test `'gives a room an id per (project, machine) pair, in the same shape'` with its comment; add, after the golden test:

```ts
  // city-by-project §2.3: a building is a project and a robot is a tab — nothing on the street is a
  // machine or a room, so those are the only two kinds, and they never collide
  it('gives a project and a tab of the same real id two different ids', () => {
    expect(publicId('project', 'x')).not.toBe(publicId('tab', 'x'));
  });
```

- [ ] **Step 2: Run it.** `SRVTEST src/public/public-id.test.ts` — Expected: PASS (6 tests; the golden literal is untouched, which proves the construction did not move).

- [ ] **Step 3: Narrow the kinds.** In `apps/server/src/public/public-id.ts`, change the signature to

```ts
export function publicId(kind: 'project' | 'tab', realId: string): string {
```

and delete `publicRoomId` with its doc comment.

- [ ] **Step 4: Verify Part A whole.**
  - `DOCKER 'npm run typecheck -w @termhub/server'` — Expected: exit 0 (a leftover `publicId('machine', …)` or `publicRoomId` anywhere would fail here).
  - `grep -rnE "publicRoomId|publicId\('(machine|room)'|RoomsGone|OfficeSnapshot|buildOfficeSnapshot" apps/server/src` — Expected: no output.
  - `SRVTEST` (no files: the whole server suite) — Expected: PASS, 0 failed (the Postgres, tmux and rsvg-convert tests skip).
  - `DBTEST` with `<files>` left empty (`npx vitest run`: the whole suite with the Postgres tests on) — Expected: PASS, 0 failed.

- [ ] **Step 5: Commit.**

```bash
git add apps/server/src/public/public-id.ts apps/server/src/public/public-id.test.ts
git commit -m "Public city: only projects and tabs have public ids

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---
# Part B — web

Part B starts from Part A's wire format (the **Interfaces** of Tasks A3 and A4), whether or not Part A's code has been read. Its implementer runs `DOCKER 'npm ci && npm run prisma:generate && npm run build:packages'` first if `node_modules` is not there yet.

### Task B1: The web's DTO and the one model both cities draw

The first task moves the data path from the wire to the `CityModel`: the web's copy of the types, the API client, the office model and the public city's adapter. Every consumer of the old shapes (the scene, the page, the harness, the city page, the share media) is rewritten in Tasks B2-B6; until B6 the web typecheck reports errors in exactly those files: `office/scene/OfficeScene.ts`, `office/scene/Overlay.ts`, `office/scene/detail.ts`, `office/layout/*`, `office/useOfficeSnapshots.ts`, `office/harness.ts`, `pages/OfficePage.tsx`, `city/CityPage.tsx`, `city/share/compose.ts`, `city/share/sound.ts`. Anything else red is a mistake in this task.

**Files:**
- Modify: `apps/web/src/lib/types.ts` (`Machine` lines 64-97, `Project` lines 130-148, `ProjectInput.is_public` comment, the Office section lines 372-405, the Public section lines 407-445)
- Modify: `apps/web/src/lib/api.ts:1` (import) and `:165` (`office`)
- Modify: `apps/web/src/office/model.ts` (whole file)
- Modify: `apps/web/src/city/api.ts` (frame types, `toBuildingEntries`)
- Test: `apps/web/src/office/model.test.ts` (whole file), `apps/web/src/city/api.test.ts` (whole file)

**Interfaces:**
- Consumes (from Part A, JSON): `GET /api/office?fresh=1` → `OfficeCity`; `GET /api/public/city/:nickname` → `PublicCity`; `/ws/public/:nickname` frames `{ type: 'robot', building, robot }` and `{ type: 'robot_gone', building, robot }`; `Project.public_id` on every project from `/api/projects`.
- Produces:

```ts
// apps/web/src/lib/types.ts
interface Project { /* … */ public_id: string }               // Machine has no public_id any more
interface OfficeTab extends Tab { progress: OfficeTabProgress | null }   // Tab has machine_id and alive
interface OfficeBuilding { project: Project; public_id: string; tabs: OfficeTab[]; tasks: OfficeTaskCounts | null }
interface OfficeMachine { id: string; name: string; subtitle: string | null; type: MachineType; online: boolean; reachable: boolean | null }
interface OfficeCity { projects: OfficeBuilding[]; machines: OfficeMachine[] }
interface PublicBuilding { id: string; name: string; robots: PublicRobot[] }   // PublicRoom is gone
// apps/web/src/lib/api.ts
api.office(fresh?: boolean): Promise<OfficeCity>   // GET /office[?fresh=1]

// apps/web/src/office/model.ts
type ModelTab = Pick<OfficeTab, 'id'|'project_id'|'name'|'kind'|'position'|'state'|'state_text'|'state_tool'|'state_at'|'state_seen_at'|'activity'|'activity_verb'|'alive'> & { machine_id?: string; progress: { done: number; total: number; title?: string | null } | null };
interface ModelBuilding { project: Pick<Project, 'id' | 'name' | 'status'>; tabs: ModelTab[]; tasks: OfficeTaskCounts | null }
interface ModelMachine { id: string; name: string; subtitle: string | null; online: boolean; reachable: boolean | null }
interface ModelCity { projects: ModelBuilding[]; machines: ModelMachine[] }          // OfficeCity satisfies it
interface DeskMachine { name: string; subtitle: string | null; online: boolean }
interface DeskModel { id; projectId; name; label; kind: 'person' | 'phone'; pose: Pose; marker: Marker; dimmed: boolean; screenOn: boolean; state; activity; verb; progress: { done; total; title } | null; look: number; machine: DeskMachine | null }
type BuildingNotice = 'offline' | 'silent' | null;
interface BuildingModel { id: string; name: string; label: string; lit: boolean; notice: BuildingNotice; needsYou: number; progress: { done: number; total: number } | null; desks: DeskModel[] }
interface CityModel { buildings: BuildingModel[]; needsYou: number }
type FocusTarget = { kind: 'city' } | { kind: 'building'; projectId: string };
const SUBTITLE_CAP = 28;
function buildCityModel(city: ModelCity, liveTab: (tabId: string) => Tab | undefined): CityModel;
function deskMachineLine(machine: DeskMachine | null): string;
function missingTabIds(city: ModelCity | null, monitorTabIds: string[], projectOf: (tabId: string) => string | undefined): string[];
function resolveFocus(city: CityModel | null, projectId: string | undefined): FocusTarget;
function sameFocus(a: FocusTarget, b: FocusTarget): boolean;
// unchanged: Pose, Marker, LOOK_VARIANTS, activityLabel, workingLabel, truncateLabel, lookOf

// apps/web/src/city/api.ts
interface RobotFrame { type: 'robot'; building: string; robot: PublicRobot }
interface RobotGoneFrame { type: 'robot_gone'; building: string; robot: string }
type CityFrame = RobotFrame | RobotGoneFrame;
function toBuildingEntries(city: PublicCity): ModelCity;   // machines: [], every robot a tab with no machine_id
```

  Model rules (spec §3.1): one building per project in the order given, empty ones kept; desks sorted by `position`; a desk's `machine` is the `OfficeMachine` its tab's `machine_id` names (`null` when there is none — the public city); a desk is `dimmed` when it never reported a state **or** its machine is offline or unreachable; an unreachable machine keeps its desks' last state (hands stay up); `notice` is `'offline'` when every machine of the building's desks is offline, else `'silent'` when one of them has `reachable === false`, else `null`; `lit` = some tab is `alive` or someone needs you; `progress` = `{ done, total: todo + doing + done }` or `null` when the board is empty or unreadable. (`'error'` is not a building notice any more: there is one read for the whole city, so a failed read has no building to hang a sign on — the page says it, Task B4.)

- [ ] **Step 1: Write the failing model test.** Replace `apps/web/src/office/model.test.ts` with:

```ts
import { describe, expect, it } from 'vitest';
import type { OfficeBuilding, OfficeCity, OfficeMachine, OfficeTab, Project, Tab } from '../lib/types';
import { activityLabel, buildCityModel, deskMachineLine, lookOf, missingTabIds, resolveFocus, sameFocus, SUBTITLE_CAP, truncateLabel, workingLabel } from './model';

const AT = '2026-09-21T10:00:00.000Z';
const tab = (id: string, over: Partial<OfficeTab> = {}): OfficeTab =>
  ({ id, project_id: 'p1', machine_id: 'm1', name: id, kind: 'terminal', position: 0, state: null, state_text: null, state_tool: null, state_at: null, state_seen_at: null, activity: null, activity_verb: null, alive: true, progress: null, ...over }) as OfficeTab;
const building = (id: string, tabs: OfficeTab[], over: Partial<OfficeBuilding> = {}): OfficeBuilding => ({ project: { id, name: id, status: 'active' } as Project, public_id: `${id}-pub`, tabs: tabs.map((t) => ({ ...t, project_id: id })), tasks: null, ...over });
const machine = (id: string, over: Partial<OfficeMachine> = {}): OfficeMachine => ({ id, name: id, subtitle: null, type: 'agent', online: true, reachable: true, ...over });
const city = (projects: OfficeBuilding[], machines: OfficeMachine[] = [machine('m1')]): OfficeCity => ({ projects, machines });
const none = () => undefined;
/** the desks of the first building */
const desks = (c: OfficeCity, live: (id: string) => Tab | undefined = none) => buildCityModel(c, live).buildings[0].desks;

describe('buildCityModel: desks', () => {
  it('maps each tab state to a pose and a marker', () => {
    const c = city([building('p1', [
      tab('w', { state: 'working', state_at: AT }),
      tab('i', { state: 'waiting_input', state_at: AT }),
      tab('p', { state: 'waiting_permission', state_at: AT }),
      tab('z', { state: 'idle', state_at: AT }),
      tab('e', { state: 'error', state_at: AT }),
      tab('n'),
    ])]);
    expect(desks(c).map((d) => [d.id, d.pose, d.marker, d.dimmed, d.screenOn])).toEqual([
      ['w', 'type', null, false, true],
      ['i', 'raise', 'input', false, false],
      ['p', 'raise', 'permission', false, false],
      ['z', 'sleep', null, false, false],
      ['e', 'shake', 'error', false, false],
      ['n', 'sit', null, true, false],
    ]);
    const m = buildCityModel(c, none);
    expect(m.buildings[0].needsYou).toBe(2);
    expect(m.needsYou).toBe(2);
  });

  it('keeps the hand up but drops the marker once the tab was seen', () => {
    const seen = tab('i', { state: 'waiting_input', state_at: AT, state_seen_at: '2026-09-21T10:05:00.000Z' });
    const d = desks(city([building('p1', [seen])]))[0];
    expect([d.pose, d.marker]).toEqual(['raise', null]);
    expect(buildCityModel(city([building('p1', [seen])]), none).needsYou).toBe(0);
  });

  it('lets the live monitor state override the city, and a tab the monitor never saw stay as it is', () => {
    const live = (id: string) => (id === 'a' ? ({ ...tab('a'), state: 'working', state_at: AT } as Tab) : undefined);
    expect(desks(city([building('p1', [tab('a'), tab('b')])]), live).map((d) => d.pose)).toEqual(['type', 'sit']);
  });

  it('takes only the live state from the monitor tab, keeping the city identity fields and ordering', () => {
    const live = (id: string) => (id === 'a' ? ({ ...tab('a'), name: 'old name', position: 0, kind: 'simulator', state: 'working', state_at: AT } as Tab) : undefined);
    const ds = desks(city([building('p1', [tab('a', { name: 'new name', position: 1 }), tab('b', { position: 0 })])]), live);
    expect(ds.map((d) => d.id)).toEqual(['b', 'a']);
    expect([ds[1].name, ds[1].kind, ds[1].pose]).toEqual(['new name', 'person', 'type']);
  });

  it('shows an empty chair for a dead terminal tab and a phone for a simulator tab', () => {
    const ds = desks(city([building('p1', [tab('dead', { alive: false, state: 'working', state_at: 'x' }), tab('sim', { kind: 'simulator', alive: true })])]));
    expect([ds[0].pose, ds[0].marker, ds[0].screenOn]).toEqual(['empty', null, false]);
    expect([ds[1].kind, ds[1].screenOn]).toEqual(['phone', true]);
  });

  it('keeps people, markers and needsYou when the machine could not be asked', () => {
    // reachable: false means the tmux listing failed, so `alive: false` is not evidence of anything:
    // emptying the chairs there would erase every raised hand for up to a minute
    const c = city([building('p1', [tab('a', { alive: false, state: 'waiting_input', state_at: AT }), tab('sim', { kind: 'simulator', alive: false })])], [machine('m1', { reachable: false })]);
    const ds = desks(c);
    expect([ds[0].pose, ds[0].marker]).toEqual(['raise', 'input']);
    // a simulator's `alive` comes from the simulator manager, not from tmux: it still holds
    expect([ds[1].kind, ds[1].screenOn]).toEqual(['phone', false]);
    expect(buildCityModel(c, none).needsYou).toBe(1);
  });

  it('takes the state fields from whichever side saw them last', () => {
    const older = AT;
    const newer = '2026-09-21T10:05:00.000Z';
    const liveWith = (over: Partial<Tab>) => (id: string) => (id === 'a' ? ({ ...tab('a'), ...over } as Tab) : undefined);
    const fresh = desks(city([building('p1', [tab('a', { state: 'idle', state_at: older })])]), liveWith({ state: 'working', state_at: newer }))[0];
    expect([fresh.state, fresh.pose]).toEqual(['working', 'type']);
    const stale = desks(city([building('p1', [tab('a', { state: 'working', state_at: newer })])]), liveWith({ state: 'idle', state_at: older }))[0];
    expect([stale.state, stale.pose]).toEqual(['working', 'type']);
    const seen = desks(city([building('p1', [tab('a', { state: 'waiting_input', state_at: older })])]), liveWith({ state: 'waiting_input', state_at: older, state_seen_at: newer }))[0];
    expect(seen.marker).toBeNull();
  });

  it('draws progress only from a bound task, and a bar only when it has subtasks', () => {
    const ds = desks(city([building('p1', [tab('a', { progress: { task_id: 'k', title: 'Ship', done: 1, total: 3 } }), tab('b', { progress: { task_id: 'k2', title: 'Solo', done: 0, total: 0 } }), tab('c')])]));
    expect(ds.map((d) => d.progress)).toEqual([{ done: 1, total: 3, title: 'Ship' }, { done: 0, total: 0, title: 'Solo' }, null]);
  });

  it('orders desks by tab position and truncates labels without touching names', () => {
    const long = 'x'.repeat(120);
    const m = buildCityModel(city([building(long, [tab('second', { position: 1 }), tab('first', { position: 0, name: long })])]), none);
    expect(m.buildings[0].desks.map((d) => d.id)).toEqual(['first', 'second']);
    expect(m.buildings[0].desks[0].name).toBe(long);
    expect(m.buildings[0].desks[0].label.length).toBeLessThanOrEqual(18);
    expect(m.buildings[0].label.length).toBeLessThanOrEqual(28);
    expect(m.buildings[0].name).toBe(long);
  });
});

describe('buildCityModel: buildings', () => {
  it('makes one building per project, in the order given, empty ones kept', () => {
    const m = buildCityModel(city([building('b', []), building('a', [tab('t1')])]), none);
    expect(m.buildings.map((b) => [b.id, b.desks.length])).toEqual([['b', 0], ['a', 1]]);
  });

  // city-by-project §1: the machine is a detail of the desk
  it("puts a project's desks from every machine in its one building, each desk carrying its machine", () => {
    const c = city([building('p1', [tab('t1', { position: 0 }), tab('t2', { machine_id: 'm2', position: 1 })])], [machine('m1', { name: 'jarvis', subtitle: 'MacBook do escritório' }), machine('m2', { name: 'friday' })]);
    expect(desks(c).map((d) => [d.id, d.machine])).toEqual([
      ['t1', { name: 'jarvis', subtitle: 'MacBook do escritório', online: true }],
      ['t2', { name: 'friday', subtitle: null, online: true }],
    ]);
  });

  it('dims a desk whose machine is offline or unreachable, and only that desk', () => {
    const working = { state: 'working' as const, state_at: AT };
    const c = city(
      [building('p1', [tab('ok', { ...working, position: 0 }), tab('off', { ...working, machine_id: 'm2', position: 1 }), tab('mute', { ...working, machine_id: 'm3', position: 2 })])],
      [machine('m1'), machine('m2', { online: false, reachable: false }), machine('m3', { reachable: false })],
    );
    expect(desks(c).map((d) => [d.id, d.dimmed])).toEqual([['ok', false], ['off', true], ['mute', true]]);
    expect(desks(c)[1].machine).toEqual({ name: 'm2', subtitle: null, online: false });
  });

  it('says offline only when every machine of its desks is offline, silent when some tmux did not answer', () => {
    const on = (id: string, machineId: string) => tab(id, { machine_id: machineId });
    const ms = [machine('m1'), machine('m2', { online: false, reachable: false }), machine('m3', { reachable: false }), machine('m4', { online: false, reachable: null })];
    const m = buildCityModel(city([building('all-off', [on('a', 'm2'), on('b', 'm4')]), building('mixed', [on('c', 'm1'), on('d', 'm2')]), building('silent', [on('e', 'm3')]), building('fine', [on('f', 'm1')]), building('empty', [])], ms), none);
    expect(m.buildings.map((b) => [b.id, b.notice])).toEqual([['all-off', 'offline'], ['mixed', 'silent'], ['silent', 'silent'], ['fine', null], ['empty', null]]);
  });

  it('lights a building with someone at a desk or someone waiting, and leaves an empty or deserted one dark', () => {
    const m = buildCityModel(
      city(
        [
          building('busy', [tab('a')]),
          building('deserted', [tab('b', { alive: false })]),
          // its machine did not answer: the hand stays up, and so does the light
          building('waiting', [tab('c', { alive: false, machine_id: 'm9', state: 'waiting_input', state_at: AT })]),
          building('empty', []),
        ],
        [machine('m1'), machine('m9', { reachable: false })],
      ),
      none,
    );
    expect(m.buildings.map((b) => [b.id, b.lit])).toEqual([['busy', true], ['deserted', false], ['waiting', true], ['empty', false]]);
  });

  it('gives a building its board progress, none when the board is empty or unreadable', () => {
    const m = buildCityModel(city([building('a', [], { tasks: { todo: 1, doing: 1, done: 2 } }), building('b', [], { tasks: { todo: 0, doing: 0, done: 0 } }), building('c', [], { tasks: null })]), none);
    expect(m.buildings.map((b) => b.progress)).toEqual([{ done: 2, total: 4 }, null, null]);
  });

  it('sums who needs you per building and for the city', () => {
    const waiting = (id: string) => tab(id, { state: 'waiting_input', state_at: AT });
    const m = buildCityModel(city([building('a', [waiting('t1'), waiting('t2')]), building('b', [waiting('t3')])]), none);
    expect(m.buildings.map((b) => b.needsYou)).toEqual([2, 1]);
    expect(m.needsYou).toBe(3);
  });
});

describe('deskMachineLine', () => {
  it('is the machine name, with its subtitle when the two fit', () => {
    expect(deskMachineLine({ name: 'jarvis', subtitle: 'MacBook', online: true })).toBe('jarvis · MacBook');
    expect(deskMachineLine({ name: 'jarvis', subtitle: null, online: true })).toBe('jarvis');
  });

  it('drops a subtitle that would not fit, and cuts a long name', () => {
    expect(deskMachineLine({ name: 'jarvis', subtitle: 'um subtítulo comprido demais para a mesa', online: true })).toBe('jarvis');
    const long = deskMachineLine({ name: 'm'.repeat(60), subtitle: null, online: true });
    expect(Array.from(long)).toHaveLength(SUBTITLE_CAP);
    expect(long.endsWith('…')).toBe(true);
  });

  it('says offline in place of the subtitle', () => {
    expect(deskMachineLine({ name: 'jarvis', subtitle: 'MacBook', online: false })).toBe('jarvis · offline');
    expect(Array.from(deskMachineLine({ name: 'x'.repeat(60), subtitle: null, online: false })).length).toBeLessThanOrEqual(SUBTITLE_CAP);
  });

  it('is empty without a machine — the public city', () => {
    expect(deskMachineLine(null)).toBe('');
  });
});

describe('activity', () => {
  it('reaches the desk from the city and from a newer monitor push', () => {
    expect(desks(city([building('p1', [tab('a', { state: 'working', state_at: AT, activity: 'coding' })])]))[0].activity).toBe('coding');
    const live = (id: string) => (id === 'a' ? ({ ...tab('a'), state: 'working', state_at: '2026-09-21T10:01:00.000Z', activity: 'reading' } as Tab) : undefined);
    expect(desks(city([building('p1', [tab('a', { state: 'working', state_at: AT, activity: 'coding' })])]), live)[0].activity).toBe('reading');
  });
  it('is null when the tab is not working, whatever the city says', () => {
    expect(desks(city([building('p1', [tab('a', { state: 'waiting_input', state_at: AT, activity: 'coding' })])]))[0].activity).toBeNull();
  });
  it('carries the spinner verb with the activity, and drops it off working or at an empty desk', () => {
    expect(desks(city([building('p1', [tab('a', { state: 'working', state_at: AT, activity: 'coding', activity_verb: 'Brewing' })])]))[0].verb).toBe('Brewing');
    expect(desks(city([building('p1', [tab('a', { state: 'waiting_input', state_at: AT, activity: 'coding', activity_verb: 'Brewing' })])]))[0].verb).toBeNull();
    expect(desks(city([building('p1', [tab('a', { state: 'working', state_at: AT, activity: 'coding', activity_verb: 'Brewing', alive: false })])]))[0].verb).toBeNull();
  });
  it('shows "<Verb>…" before the activity label while working, and the activity alone without a verb', () => {
    expect(workingLabel('coding', 'Moonwalking')).toBe('Moonwalking… · codando');
    expect(workingLabel('reading', null)).toBe('lendo arquivos');
    expect(workingLabel(null, 'Brewing')).toBe('Brewing…');
    expect(workingLabel(null, null)).toBeNull();
    expect(Array.from(workingLabel('reading', 'Flibbertigibbeting')!)).toHaveLength(28);
  });
  it('labels every category in pt-BR and nothing for null', () => {
    expect(['coding', 'reading', 'researching', 'planning', 'terminal', 'working'].map((a) => activityLabel(a as never))).toEqual(['codando', 'lendo arquivos', 'pesquisando', 'planejando', 'no terminal', 'trabalhando']);
    expect(activityLabel(null)).toBeNull();
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
  });
});

describe('missingTabIds', () => {
  const c = city([building('p1', [tab('a')])]);
  const projectOf = (id: string) => ({ a: 'p1', b: 'p1', other: 'p9' })[id];
  it("returns the ids the monitor knows for one of the city's projects that the city lacks", () => {
    expect(missingTabIds(c, ['a', 'b'], projectOf)).toEqual(['b']);
  });
  it('leaves out tabs of projects outside the city and tabs it already knows', () => {
    expect(missingTabIds(c, ['a', 'other'], projectOf)).toEqual([]);
  });
  it('returns [] before the first read', () => {
    expect(missingTabIds(null, ['b'], projectOf)).toEqual([]);
  });
});

describe('resolveFocus', () => {
  const model = buildCityModel(city([building('p1', [tab('t')]), building('p2', [])]), none);
  it('frames the city with no project, an unknown one (an old machine id), or before anything loaded', () => {
    expect(resolveFocus(model, undefined)).toEqual({ kind: 'city' });
    expect(resolveFocus(model, 'm1')).toEqual({ kind: 'city' });
    expect(resolveFocus(null, 'p1')).toEqual({ kind: 'city' });
  });
  it('frames a building of the city, an empty one included', () => {
    expect(resolveFocus(model, 'p1')).toEqual({ kind: 'building', projectId: 'p1' });
    expect(resolveFocus(model, 'p2')).toEqual({ kind: 'building', projectId: 'p2' });
  });
  it('compares targets by value', () => {
    expect(sameFocus({ kind: 'building', projectId: 'a' }, { kind: 'building', projectId: 'a' })).toBe(true);
    expect(sameFocus({ kind: 'building', projectId: 'a' }, { kind: 'building', projectId: 'b' })).toBe(false);
    expect(sameFocus({ kind: 'building', projectId: 'a' }, { kind: 'city' })).toBe(false);
    expect(sameFocus({ kind: 'city' }, { kind: 'city' })).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to see it fail.** `WEBTEST src/office/model.test.ts` — Expected: FAIL (`buildCityModel` expects an array of machine entries: `entries.map is not a function`; `deskMachineLine` and `SUBTITLE_CAP` are not exported).

- [ ] **Step 3: Implement the types and the API client.** In `apps/web/src/lib/types.ts`:

Delete from `interface Machine`:

```ts
  /** one-way id used on the public city; carrying it here costs nothing since it cannot be reversed */
  public_id: string;
```

In `interface Project`, replace

```ts
  /** whether this project's rooms (one per machine its owner owns) are readable on the owner's public city */
  is_public: boolean;
```

with

```ts
  /** whether this project is a building on its owner's public city (with its agents on the owner's own machines) */
  is_public: boolean;
  /** this project's building id on its owner's public city (one-way, from the server): the share link is built from it */
  public_id: string;
```

In `interface ProjectInput`, change the `is_public` comment to `/** edit only (a project is born private): publishes it on the owner's public city */`.

Replace everything from `/** GET /office/:machineId: a machine's floor, one room per non-archived project. */` to the end of `interface PublicCity { … }` with:

```ts
/** Board columns that count as a project's work in the office: todo, doing, done (not the backlog). */
export interface OfficeTaskCounts {
  todo: number;
  doing: number;
  done: number;
}

/** The board task bound to a tab, if any (a tab's own `doing` task with subtasks). */
export interface OfficeTabProgress {
  task_id: string;
  title: string;
  done: number;
  total: number;
}

export interface OfficeTab extends Tab {
  progress: OfficeTabProgress | null;
}

/** One building of the office (GET /office): a project and every desk (tab) it has, whatever machine each runs on. */
export interface OfficeBuilding {
  project: Project;
  /** the building's id on the owner's public city (the same as `project.public_id`) */
  public_id: string;
  tabs: OfficeTab[];
  /** null when the board could not be read (no `tasks:read`); a project with no tasks sends zeros */
  tasks: OfficeTaskCounts | null;
}

/** A machine one of the city's desks runs on: a detail of the desk, never a building. */
export interface OfficeMachine {
  id: string;
  name: string;
  subtitle: string | null;
  type: MachineType;
  online: boolean;
  /** the tmux probe: false = it could not ask the machine; null = not probed (no terminal desk on it) */
  reachable: boolean | null;
}

/** GET /office: the whole city — one building per non-archived project of the scope, and the machines its desks run on. */
export interface OfficeCity {
  projects: OfficeBuilding[];
  machines: OfficeMachine[];
}

/**
 * The public city, mirrored field for field from apps/server/src/public/city.ts — the only shape a
 * visitor with no account ever sees. A building is a published project; nothing about a machine is
 * in it. The ids are derived from the real ones by the server and are what the public surfaces join on.
 */
export interface PublicRobot {
  id: string;
  name: string;
  kind: TabKind;
  state: TabState | null;
  state_at: string | null;
  activity: TabActivity | null;
  /** Claude Code's spinner verb, only when it is one of its defaults (the server drops custom verbs) */
  activity_verb: string | null;
  alive: boolean;
  /** the board task bound to the tab, without its title: a bar, never what it says */
  progress: { done: number; total: number } | null;
}

export interface PublicBuilding {
  id: string;
  name: string;
  robots: PublicRobot[];
}

export interface PublicCity {
  nickname: string;
  owner_name: string;
  /** the owner's short link (77a.it/…), or null: use the long /city/@nickname address */
  short_url: string | null;
  buildings: PublicBuilding[];
}
```

In `apps/web/src/lib/api.ts`, in the type import on line 1 replace `OfficeSnapshot` with `OfficeCity`, and replace line 165 with:

```ts
  office: (fresh = false) => request<OfficeCity>('GET', `/office${fresh ? '?fresh=1' : ''}`),
```

- [ ] **Step 4: Implement the model.** Replace `apps/web/src/office/model.ts` with:

```ts
/**
 * City read + live monitor state -> what the scene draws. Pure, and the only place where a tab's
 * fields are turned into poses and markers: the scene never reads a `Tab`. A building is a project
 * (city-by-project §3.1); the machine a desk runs on is a detail of that desk.
 */
import { tabNeedsYou } from '../lib/needs-you';
import type { OfficeTab, OfficeTaskCounts, Project, Tab, TabActivity, TabState } from '../lib/types';

/**
 * What the model reads of a tab, and nothing more. `OfficeTab` satisfies it, and so does a robot of
 * the public city once src/city/api.ts adapts it — one model, one scene, both the office and the
 * page a stranger opens. A robot has no machine (the public payload carries none) and its bar has
 * no title (a task's name is not published).
 */
export type ModelTab = Pick<OfficeTab, 'id' | 'project_id' | 'name' | 'kind' | 'position' | 'state' | 'state_text' | 'state_tool' | 'state_at' | 'state_seen_at' | 'activity' | 'activity_verb' | 'alive'> & {
  /** the machine the tab runs on; absent on the public city */
  machine_id?: string;
  progress: { done: number; total: number; title?: string | null } | null;
};

/** One project and its desks, as the model reads it. `OfficeBuilding` satisfies it. */
export interface ModelBuilding {
  project: Pick<Project, 'id' | 'name' | 'status'>;
  tabs: ModelTab[];
  /** null when the board could not be read (no `tasks:read`, or a city with no board at all) */
  tasks: OfficeTaskCounts | null;
}

/** A machine a desk runs on. `OfficeMachine` satisfies it; the public city has none. */
export interface ModelMachine {
  id: string;
  name: string;
  subtitle: string | null;
  online: boolean;
  /** false = its tmux could not be asked; null = not probed */
  reachable: boolean | null;
}

/** The model's whole input: `OfficeCity` satisfies it, and so does the public city through its adapter. */
export interface ModelCity {
  projects: ModelBuilding[];
  machines: ModelMachine[];
}

export type Pose = 'type' | 'raise' | 'sleep' | 'shake' | 'sit' | 'empty';
export type Marker = 'input' | 'permission' | 'error' | null;

/** The machine tag of a desk: what the office tells about where an agent runs. */
export interface DeskMachine {
  name: string;
  subtitle: string | null;
  online: boolean;
}

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
  /** never reported a state, or its machine is offline or unreachable: drawn faded */
  dimmed: boolean;
  screenOn: boolean;
  state: TabState | null;
  /** what the tool is about to do, under the person while typing; null off `working` or an old agent */
  activity: TabActivity | null;
  /** Claude Code's spinner verb ("Moonwalking"), shown with the activity; null whenever `activity` is */
  verb: string | null;
  /** total = 0: a bound task with no subtasks — a title, no bar */
  progress: { done: number; total: number; title: string } | null;
  /** stable appearance variant, from the tab id */
  look: number;
  /** the machine the desk runs on — office only; null on the public city, which names no machine */
  machine: DeskMachine | null;
}

/** Why a building may not be telling the truth, read from across the city. */
export type BuildingNotice = 'offline' | 'silent' | null;

export interface BuildingModel {
  /** the project id in the office; the building's public id on the street */
  id: string;
  name: string;
  label: string;
  /** someone is at a desk, or someone needs you: an empty or deserted building is drawn dark */
  lit: boolean;
  notice: BuildingNotice;
  needsYou: number;
  /** the board, as the sign prints it (d/t tarefas); null when it is empty or unreadable */
  progress: { done: number; total: number } | null;
  desks: DeskModel[];
}

export interface CityModel {
  buildings: BuildingModel[];
  needsYou: number;
}

export const LOOK_VARIANTS = 6;
const DESK_LABEL_MAX = 18;
const BUILDING_LABEL_MAX = 28;
/** The desk's machine line: name and subtitle together stay this short, or the subtitle goes. */
export const SUBTITLE_CAP = 28;

const POSE: Record<TabState, Pose> = { working: 'type', waiting_input: 'raise', waiting_permission: 'raise', idle: 'sleep', error: 'shake' };

const ACTIVITY_LABEL: Record<TabActivity, string> = { coding: 'codando', reading: 'lendo arquivos', researching: 'pesquisando', planning: 'planejando', terminal: 'no terminal', working: 'trabalhando' };
/** What a working person is doing, under them on the floor — pt-BR, or null when nothing is known. */
export function activityLabel(activity: TabActivity | null): string | null {
  return activity ? ACTIVITY_LABEL[activity] : null;
}

/** A verb and an activity label side by side stay about as wide as the longest desk label plus a word. */
const WORKING_LABEL_MAX = 28;
/**
 * The label under a working person: "Moonwalking… · codando" with a spinner verb (cut to fit, so a
 * customised 24-letter verb cannot run over the next desk), the activity alone without one.
 */
export function workingLabel(activity: TabActivity | null, verb: string | null): string | null {
  const label = activityLabel(activity);
  if (!verb) return label;
  return truncateLabel(label ? `${verb}… · ${label}` : `${verb}…`, WORKING_LABEL_MAX);
}

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

const oneLine = (s: string) => s.trim().replace(/\s+/g, ' ');

/**
 * The muted line under a desk's name in the office (spec §3.2): the machine's name, with its
 * subtitle when the two fit SUBTITLE_CAP, or "offline" in the subtitle's place when the machine is;
 * '' without a machine — the public city, which names none.
 */
export function deskMachineLine(machine: DeskMachine | null): string {
  if (!machine) return '';
  const name = oneLine(machine.name);
  if (!machine.online) return `${truncateLabel(name, SUBTITLE_CAP - ' · offline'.length)} · offline`;
  const subtitle = machine.subtitle ? oneLine(machine.subtitle) : '';
  const both = subtitle ? `${name} · ${subtitle}` : '';
  return both && Array.from(both).length <= SUBTITLE_CAP ? both : truncateLabel(name, SUBTITLE_CAP);
}

const time = (iso: string | null): number | null => {
  const ms = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(ms) ? null : ms;
};

/**
 * Which side's state fields to draw. The monitor is normally ahead of the city read, but with the
 * WebSocket down its items go stale (it resyncs every 3 min) while a 60 s read keeps coming — so the
 * newer `state_at` wins, and on a tie only a fresher `state_seen_at` (the hand was lowered
 * elsewhere) moves the tab.
 */
function withLiveState(tab: ModelTab, live: Tab | undefined): ModelTab {
  if (!live) return tab;
  const fromLive = (): ModelTab => ({ ...tab, state: live.state, state_text: live.state_text, state_tool: live.state_tool, state_at: live.state_at, state_seen_at: live.state_seen_at, activity: live.activity, activity_verb: live.activity_verb });
  const liveAt = time(live.state_at);
  const tabAt = time(tab.state_at);
  if (liveAt !== tabAt) return (liveAt ?? -Infinity) > (tabAt ?? -Infinity) ? fromLive() : tab;
  return (time(live.state_seen_at) ?? -Infinity) > (time(tab.state_seen_at) ?? -Infinity) ? fromLive() : tab;
}

/** `machine`: where the tab runs; undefined on the public city, which reads as online and reachable. */
function deskOf(tab: ModelTab, live: Tab | undefined, machine: ModelMachine | undefined): DeskModel {
  const t = withLiveState(tab, live);
  // a machine that could not be asked answers `alive: false` for every terminal tab, which is not
  // evidence that anyone left: keep the last known state (and its raised hand), faded
  const reachable = machine?.reachable !== false;
  const down = !!machine && (!machine.online || machine.reachable === false);
  const base = {
    id: t.id,
    projectId: t.project_id,
    name: t.name,
    label: truncateLabel(t.name, DESK_LABEL_MAX),
    look: lookOf(t.id, LOOK_VARIANTS),
    progress: t.progress ? { done: t.progress.done, total: t.progress.total, title: t.progress.title ?? '' } : null,
    machine: machine ? { name: machine.name, subtitle: machine.subtitle, online: machine.online } : null,
  };
  // a simulator's `alive` comes from the simulator manager, so tmux being unreachable says nothing about it
  if (t.kind === 'simulator') return { ...base, kind: 'phone', pose: 'empty', marker: null, dimmed: down, screenOn: t.alive, state: null, activity: null, verb: null };
  if (!t.alive && reachable) return { ...base, kind: 'person', pose: 'empty', marker: null, dimmed: down, screenOn: false, state: t.state, activity: null, verb: null };
  const needs = tabNeedsYou(t);
  const marker: Marker = t.state === 'error' ? 'error' : !needs ? null : t.state === 'waiting_permission' ? 'permission' : 'input';
  return { ...base, kind: 'person', pose: t.state ? POSE[t.state] : 'sit', marker, dimmed: !t.state || down, screenOn: t.state === 'working', state: t.state, activity: t.state === 'working' ? t.activity : null, verb: t.state === 'working' ? t.activity_verb : null };
}

function buildingOf(b: ModelBuilding, machines: Map<string, ModelMachine>, liveTab: (tabId: string) => Tab | undefined): BuildingModel {
  const machineOf = (t: ModelTab) => (t.machine_id ? machines.get(t.machine_id) : undefined);
  const desks = [...b.tabs].sort((x, y) => x.position - y.position).map((t) => deskOf(t, liveTab(t.id), machineOf(t)));
  const needsYou = desks.filter((d) => d.marker === 'input' || d.marker === 'permission').length;
  const used = [...new Set(b.tabs.map(machineOf).filter((m): m is ModelMachine => !!m))];
  const notice: BuildingNotice = used.length > 0 && used.every((m) => !m.online) ? 'offline' : used.some((m) => m.reachable === false) ? 'silent' : null;
  const total = b.tasks ? b.tasks.todo + b.tasks.doing + b.tasks.done : 0;
  return {
    id: b.project.id,
    name: b.project.name,
    label: truncateLabel(b.project.name, BUILDING_LABEL_MAX),
    lit: b.tabs.some((t) => t.alive) || needsYou > 0,
    notice,
    needsYou,
    progress: b.tasks && total > 0 ? { done: b.tasks.done, total } : null,
    desks,
  };
}

/** One building per project, in the order given (the server's: by name, like the sidebar), empty ones kept. */
export function buildCityModel(city: ModelCity, liveTab: (tabId: string) => Tab | undefined): CityModel {
  const machines = new Map(city.machines.map((m) => [m.id, m]));
  const buildings = city.projects.map((b) => buildingOf(b, machines, liveTab));
  return { buildings, needsYou: buildings.reduce((n, b) => n + b.needsYou, 0) };
}

/** Ids the monitor knows for one of the city's projects that the city itself lacks: time to re-read it. */
export function missingTabIds(city: ModelCity | null, monitorTabIds: string[], projectOf: (tabId: string) => string | undefined): string[] {
  if (!city) return [];
  const projects = new Set(city.projects.map((b) => b.project.id));
  const known = new Set(city.projects.flatMap((b) => b.tabs.map((t) => t.id)));
  return monitorTabIds.filter((id) => !known.has(id) && projects.has(projectOf(id) ?? ''));
}

export type FocusTarget = { kind: 'city' } | { kind: 'building'; projectId: string };

/** What the URL asks the camera to frame, against what exists: an unknown id (an old machine id, too) is the city. */
export function resolveFocus(city: CityModel | null, projectId: string | undefined): FocusTarget {
  return projectId && city?.buildings.some((b) => b.id === projectId) ? { kind: 'building', projectId } : { kind: 'city' };
}

export function sameFocus(a: FocusTarget, b: FocusTarget): boolean {
  return a.kind === 'city' ? b.kind === 'city' : b.kind === 'building' && a.projectId === b.projectId;
}
```

- [ ] **Step 5: Run it to see it pass.** `WEBTEST src/office/model.test.ts` — Expected: PASS (0 failed).

- [ ] **Step 6: Write the failing adapter test.** Replace `apps/web/src/city/api.test.ts` with:

```ts
import { describe, expect, expectTypeOf, it } from 'vitest';
import { buildCityModel } from '../office/model';
import type { PublicBuilding, PublicCity, PublicRobot } from '../lib/types';
import { toBuildingEntries } from './api';

const ROBOT: PublicRobot = { id: 'x1', name: 'aba 1', kind: 'terminal', state: 'working', state_at: '2026-09-22T10:00:00.000Z', activity: 'coding', activity_verb: null, alive: true, progress: null };
const CITY: PublicCity = {
  nickname: 'pedro',
  owner_name: 'Pedro',
  short_url: null,
  buildings: [
    { id: 'b1', name: 'Engage Easy', robots: [ROBOT, { ...ROBOT, id: 'x2', name: 'aba 2', alive: false }] },
    { id: 'b2', name: 'Vazio', robots: [] },
  ],
};

describe('the public city as the office model', () => {
  it('has no machine anywhere in the public types', () => {
    expectTypeOf<keyof PublicBuilding>().toEqualTypeOf<'id' | 'name' | 'robots'>();
    expectTypeOf<keyof PublicCity>().toEqualTypeOf<'nickname' | 'owner_name' | 'short_url' | 'buildings'>();
    expectTypeOf<'machine_id' extends keyof PublicRobot ? true : false>().toEqualTypeOf<false>();
    expectTypeOf<'subtitle' extends keyof PublicRobot ? true : false>().toEqualTypeOf<false>();
  });

  it('makes one building per published project, its robots as desks in order', () => {
    const model = buildCityModel(toBuildingEntries(CITY), () => undefined);
    expect(model.buildings.map((b) => [b.id, b.name, b.desks.map((d) => d.id)])).toEqual([['b1', 'Engage Easy', ['x1', 'x2']], ['b2', 'Vazio', []]]);
    expect(model.buildings.map((b) => b.lit)).toEqual([true, false]);
  });

  it('gives the model no machine: no desk has a machine line or is dimmed for one, no building has a notice', () => {
    const entries = toBuildingEntries(CITY);
    expect(entries.machines).toEqual([]);
    const model = buildCityModel(entries, () => undefined);
    expect(model.buildings[0].desks.map((d) => [d.machine, d.dimmed])).toEqual([[null, false], [null, false]]);
    expect(model.buildings.map((b) => b.notice)).toEqual([null, null]);
  });

  it('never hands a machine or a subtitle to the model, even one smuggled into the payload', () => {
    const smuggled = {
      ...CITY,
      buildings: [{ ...CITY.buildings[0], machine: { name: 'MAQUINA-SECRETA' }, subtitle: 'MacBook do escritório secreto', robots: [{ ...ROBOT, machine_id: 'm-secreta' }] }],
    } as unknown as PublicCity;
    const entries = toBuildingEntries(smuggled);
    const model = buildCityModel(entries, () => undefined);
    for (const secret of ['MAQUINA-SECRETA', 'MacBook do escritório secreto', 'm-secreta']) {
      expect(JSON.stringify(entries)).not.toContain(secret);
      expect(JSON.stringify(model)).not.toContain(secret);
    }
  });
});
```

- [ ] **Step 7: Run it to see it fail.** `WEBTEST src/city/api.test.ts` — Expected: FAIL (`toBuildingEntries is not a function`).

- [ ] **Step 8: Implement the adapter.** In `apps/web/src/city/api.ts`, replace the import of `MachineEntry` with `import type { ModelCity } from '../office/model';`, replace the two frame interfaces with:

```ts
/** One change of one robot of a published building, as /ws/public sends it. `building` is a snapshot id: they join. */
export interface RobotFrame {
  type: 'robot';
  building: string;
  robot: PublicRobot;
}

/** A tab of a published building was closed or deleted: its robot leaves. `robot` is the robot's id. */
export interface RobotGoneFrame {
  type: 'robot_gone';
  building: string;
  robot: string;
}
```

in the doc comment of `openCitySocket` replace `the server hangs this socket up when the last published room is taken off the street` with `the server hangs this socket up whenever something it showed leaves the street`, and replace `toMachineEntries` (with its doc comment) by:

```ts
/**
 * The public payload as the office model's input. The server mirrors the office's field names
 * (apps/server/src/public/city.ts), so from here on the model, the scene, the overlay and the
 * activity label are the very code the app runs. Nothing here is a machine: the public shape has
 * none, so the model gets none — every desk reads as online and reachable, and none carries a
 * machine line.
 */
export function toBuildingEntries(city: PublicCity): ModelCity {
  return {
    machines: [],
    projects: city.buildings.map((building) => ({
      project: { id: building.id, name: building.name, status: 'active' as const },
      // the board is not published: a building sign on the street carries a name, never a task count
      tasks: null,
      tabs: building.robots.map((robot, i) => ({
        id: robot.id,
        project_id: building.id,
        name: robot.name,
        kind: robot.kind,
        // the payload keeps the server's order and nothing else orders the desks
        position: i,
        state: robot.state,
        // the tool's own message and the tool's name are not published
        state_text: null,
        state_tool: null,
        state_at: robot.state_at,
        // whether the owner has looked is the owner's business: on the street a raised hand stays raised
        state_seen_at: null,
        activity: robot.activity,
        activity_verb: robot.activity_verb,
        alive: robot.alive,
        progress: robot.progress,
      })),
    })),
  };
}
```

- [ ] **Step 9: Run both, and check the typecheck is red only where expected.** `WEBTEST src/office/model.test.ts src/city/api.test.ts` — Expected: PASS. `DOCKER 'npm run typecheck -w @termhub/web'` — Expected: errors, and every error line names one of the files listed at the top of this task (the scene, the layout, the per-machine hook, the harness, the office page, the city page and the two share walks) — none in `lib/`, `office/model.ts` or `city/api.ts`.

- [ ] **Step 10: Commit.**

```bash
git add apps/web/src/lib/types.ts apps/web/src/lib/api.ts apps/web/src/office/model.ts apps/web/src/office/model.test.ts apps/web/src/city/api.ts apps/web/src/city/api.test.ts
git commit -m "Office: one model of buildings by project, desks tagged with their machine

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task B2: The scene — one block per building, desks on one floor, one sign

**Files:**
- Modify: `apps/web/src/office/layout/floor.ts` (whole file), `apps/web/src/office/layout/city.ts` (whole file), `apps/web/src/office/layout/shelves.ts:1` (comment)
- Create: `apps/web/src/office/scene/shape.ts`
- Modify: `apps/web/src/office/scene/detail.ts` (whole file), `apps/web/src/office/scene/RoomView.ts` (whole file), `apps/web/src/office/scene/Overlay.ts` (whole file), `apps/web/src/office/scene/OfficeScene.ts` (whole file)
- Test: `apps/web/src/office/layout/floor.test.ts`, `apps/web/src/office/layout/city.test.ts`, `apps/web/src/office/scene/shape.test.ts` (new), `apps/web/src/office/scene/detail.test.ts` (all whole files)

**Interfaces:**
- Consumes: `CityModel`, `BuildingModel`, `DeskModel`, `FocusTarget`, `sameFocus`, `deskMachineLine`, `truncateLabel`, `workingLabel` (Task B1); `layoutRoom`, `toScreen`, `depthOf` (`layout/iso.ts`, unchanged); `packShelves` (`layout/shelves.ts`, unchanged); `Camera`, `sameBox`, `FrameListeners`, `DeskView` (unchanged).
- Produces:

```ts
// layout/floor.ts
type FloorLayout = RoomLayout;                       // { width; height; desks: Cell[] }
function layoutFloor(desks: number): FloorLayout;
interface PlacedFloor { origin: Cell; layout: FloorLayout }
// layout/city.ts
interface BlockInput { id: string; desks: number }
interface PlacedBlock { id: string; origin: Cell; floor: FloorLayout; width: number; height: number }
function layoutCity(blocks: BlockInput[], targetWidth?: number): CityLayout;
function floorOnCity(block: PlacedBlock): PlacedFloor;
// blockBounds, cityBounds, STREET, BLOCK_MARGIN unchanged
// scene/shape.ts
function shapeOf(city: CityModel): string;           // "p1{t1:person,s1:phone};p2{}"
// scene/detail.ts
const SIGN_SCALE = 0.7; const LABEL_SCALE = 1.8;
function deskLabelsVisible(target: FocusTarget, scale: number, buildingId: string): boolean;
function buildingSignText(b: Pick<BuildingModel, 'label' | 'notice' | 'progress' | 'needsYou' | 'desks'>): { name: string; detail: string; count: string };
// scene/RoomView.ts
function drawFloor(floor: PlacedFloor, lit: boolean, into?: Graphics): Graphics;   // replaces drawRoom
// scene/Overlay.ts: DeskOverlay (+ machine line), BuildingSign (replaces MachineSign and RoomSign)
// scene/OfficeScene.ts
interface SceneHandlers { onPickDesk(deskId: string, projectId: string): void; onPickBuilding(projectId: string): void; onPickSign(projectId: string): void; onGoUp(): void }
class OfficeScene { constructor(handlers: SceneHandlers); mount(host): Promise<void>; destroy(); setModel(model: CityModel); focus(target: FocusTarget, snap?: boolean); onFrame(cb); lockCamera(locked); debugHover(deskId | null); fps; rendererName; frameMs }
```

- [ ] **Step 1: Write the failing tests.** Replace `apps/web/src/office/layout/floor.test.ts` with:

```ts
import { describe, expect, it } from 'vitest';
import { layoutFloor } from './floor';

describe('layoutFloor', () => {
  // city-by-project §3.2: no rooms any more — every desk of a building on one floor
  it('puts every desk of a building on its one floor, row by row, none outside it', () => {
    const floor = layoutFloor(7);
    expect(floor.desks).toHaveLength(7);
    expect(new Set(floor.desks.map((d) => `${d.gx},${d.gy}`)).size).toBe(7);
    for (const d of floor.desks) {
      expect(d.gx).toBeGreaterThan(0);
      expect(d.gy).toBeGreaterThan(0);
      expect(d.gx).toBeLessThan(floor.width);
      expect(d.gy).toBeLessThan(floor.height);
    }
    expect(floor.desks.slice(0, 2)).toEqual([{ gx: 1, gy: 1 }, { gx: 3, gy: 1 }]);
  });

  it('grows with the desks and keeps a small floor for a building with none', () => {
    expect(layoutFloor(0)).toEqual({ width: 5, height: 3, desks: [] });
    const area = (n: number) => layoutFloor(n).width * layoutFloor(n).height;
    expect(area(40)).toBeGreaterThan(area(4));
  });
});

```

Replace `apps/web/src/office/layout/city.test.ts` with:

```ts
import { describe, expect, it } from 'vitest';
import { BLOCK_MARGIN, blockBounds, cityBounds, floorOnCity, layoutCity, STREET } from './city';

const block = (id: string, desks: number) => ({ id, desks });
const overlap = (a: { origin: { gx: number; gy: number }; width: number; height: number }, b: typeof a) =>
  a.origin.gx < b.origin.gx + b.width && b.origin.gx < a.origin.gx + a.width && a.origin.gy < b.origin.gy + b.height && b.origin.gy < a.origin.gy + a.height;

describe('layoutCity', () => {
  it('keeps the order given and separates blocks by a street', () => {
    const city = layoutCity([block('a', 2), block('b', 2)], 60);
    expect(city.blocks.map((b) => b.id)).toEqual(['a', 'b']);
    expect(city.blocks[1].origin).toEqual({ gx: city.blocks[0].width + STREET, gy: 0 });
  });
  it('never overlaps blocks of very different sizes, and stays inside its own size', () => {
    const city = layoutCity([block('a', 13), block('b', 40), block('c', 0), block('d', 18), block('e', 7)]);
    for (let i = 0; i < city.blocks.length; i++) for (let j = i + 1; j < city.blocks.length; j++) expect(overlap(city.blocks[i], city.blocks[j])).toBe(false);
    for (const b of city.blocks) {
      expect(b.origin.gx + b.width).toBeLessThanOrEqual(city.width);
      expect(b.origin.gy + b.height).toBeLessThanOrEqual(city.height);
    }
  });
  it('gives a building with no desk a minimal block, so its sign has ground to stand on', () => {
    const city = layoutCity([block('empty', 0)]);
    expect([city.blocks[0].width, city.blocks[0].height]).toEqual([5, 3]);
    expect(city.blocks[0].floor.desks).toEqual([]);
  });
  it('is an empty, finite city for no buildings', () => {
    const city = layoutCity([]);
    expect(city).toEqual({ blocks: [], width: 0, height: 0 });
    expect(Object.values(cityBounds(city, 28)).every(Number.isFinite)).toBe(true);
  });
  it('keeps an earlier block where it was when a later one grows', () => {
    const before = layoutCity([block('a', 3), block('b', 3)], 80);
    const after = layoutCity([block('a', 3), block('b', 30)], 80);
    expect(after.blocks[0].origin).toEqual(before.blocks[0].origin);
  });
});

describe('floorOnCity / bounds', () => {
  it("puts a block's floor at the block's own origin, leaving its layout alone", () => {
    const city = layoutCity([block('a', 2), block('b', 4)], 60);
    const placed = floorOnCity(city.blocks[1]);
    expect(placed.origin).toEqual(city.blocks[1].origin);
    expect(placed.layout).toBe(city.blocks[1].floor);
  });
  it('frames the pavement the block is drawn with, not only its floor', () => {
    const city = layoutCity([block('a', 2)]);
    const b = city.blocks[0];
    expect([b.origin, b.width, b.height]).toEqual([{ gx: 0, gy: 0 }, 5, 3]);
    // drawBlock paints the footprint grown by BLOCK_MARGIN on every side: 64 px per tile across, 32 down, 28 px of walls on top
    expect(BLOCK_MARGIN).toBe(1);
    expect(blockBounds(b, 28)).toEqual({ x: -160, y: -60, w: 384, h: 220 });
    expect(cityBounds(city, 28)).toEqual(blockBounds(b, 28));
  });
  it('puts a later block of the same row to the right of an earlier one, and the city spans both', () => {
    const city = layoutCity([block('a', 2), block('b', 2)], 60);
    const [a, b] = city.blocks.map((x) => blockBounds(x, 28));
    expect(b.x).toBeGreaterThan(a.x);
    const all = cityBounds(city, 28);
    expect(all.x).toBeLessThanOrEqual(a.x);
    expect(all.x + all.w).toBeGreaterThanOrEqual(b.x + b.w);
  });
});
```

Create `apps/web/src/office/scene/shape.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { BuildingModel, CityModel, DeskModel } from '../model';
import { shapeOf } from './shape';

const desk = (id: string, kind: DeskModel['kind'] = 'person', over: Partial<DeskModel> = {}) => ({ id, kind, pose: 'sit', marker: null, ...over }) as DeskModel;
const building = (id: string, desks: DeskModel[], over: Partial<BuildingModel> = {}) => ({ id, desks, lit: true, notice: null, needsYou: 0, ...over }) as BuildingModel;
const city = (...buildings: BuildingModel[]): CityModel => ({ buildings, needsYou: 0 });

describe('shapeOf', () => {
  it('is one b{d:kind} entry per building, in order', () => {
    expect(shapeOf(city(building('p1', [desk('t1'), desk('s1', 'phone')]), building('p2', [])))).toBe('p1{t1:person,s1:phone};p2{}');
  });
  it('ignores everything a repaint can handle: state, light, notices, who needs you', () => {
    const a = city(building('p1', [desk('t1')]));
    const b = city(building('p1', [desk('t1', 'person', { pose: 'type', marker: 'input' })], { lit: false, notice: 'offline', needsYou: 1 }));
    expect(shapeOf(b)).toBe(shapeOf(a));
  });
  it('changes when a desk or a building comes, goes, moves or changes kind', () => {
    const base = shapeOf(city(building('p1', [desk('t1'), desk('t2')])));
    for (const other of [
      city(building('p1', [desk('t1')])),
      city(building('p1', [desk('t2'), desk('t1')])),
      city(building('p1', [desk('t1'), desk('t2', 'phone')])),
      city(building('p1', [desk('t1'), desk('t2')]), building('p2', [])),
    ]) {
      expect(shapeOf(other)).not.toBe(base);
    }
  });
});
```

Replace `apps/web/src/office/scene/detail.test.ts` with:

```ts
import { describe, expect, it } from 'vitest';
import type { BuildingModel, FocusTarget } from '../model';
import { buildingSignText, deskLabelsVisible, LABEL_SCALE } from './detail';

const city: FocusTarget = { kind: 'city' };
const inside: FocusTarget = { kind: 'building', projectId: 'p1' };
const far = LABEL_SCALE / 4;

describe('deskLabelsVisible', () => {
  it('shows every desk label only once the zoom makes them readable', () => {
    expect(deskLabelsVisible(city, far, 'p1')).toBe(false);
    expect(deskLabelsVisible(city, LABEL_SCALE, 'p1')).toBe(true);
  });
  it('always labels the desks of the building the person stands in, and only those', () => {
    expect(deskLabelsVisible(inside, far, 'p1')).toBe(true);
    expect(deskLabelsVisible(inside, far, 'p2')).toBe(false);
  });
});

// city-by-project §3.2: the building sign merges the old machine and room signs
describe('buildingSignText', () => {
  const b = (over: Partial<BuildingModel> = {}) => ({ label: 'termhub', notice: null, progress: null, needsYou: 0, desks: [{}], ...over }) as BuildingModel;
  it('is the name alone for a quiet building', () => {
    expect(buildingSignText(b())).toEqual({ name: 'termhub', detail: '', count: '' });
  });
  it('says the board and who is waiting', () => {
    expect(buildingSignText(b({ progress: { done: 2, total: 5 }, needsYou: 1 }))).toEqual({ name: 'termhub', detail: '2/5 tarefas ·', count: '1 precisa de você' });
    expect(buildingSignText(b({ needsYou: 3 }))).toEqual({ name: 'termhub', detail: '', count: '3 precisam de você' });
  });
  it('puts the notice first, in pt-BR', () => {
    expect(buildingSignText(b({ notice: 'offline', progress: { done: 1, total: 2 } })).detail).toBe('offline · 1/2 tarefas');
    expect(buildingSignText(b({ notice: 'silent' })).detail).toBe('sem resposta');
  });
  // §2.4: a published project with nobody in it is still a building — and says so
  it('says so when a building has no agent right now', () => {
    expect(buildingSignText(b({ desks: [] })).detail).toBe('sem agentes agora');
  });
});
```

- [ ] **Step 2: Run them to see them fail.** `WEBTEST src/office/layout/floor.test.ts src/office/layout/city.test.ts src/office/scene/shape.test.ts src/office/scene/detail.test.ts` — Expected: FAIL (`layoutFloor(7)` iterates a number; `floorOnCity`, `shapeOf`, `deskLabelsVisible`, `buildingSignText` do not exist).

- [ ] **Step 3: Implement the layout.** Replace `apps/web/src/office/layout/floor.ts` with:

```ts
/** Where a building's desks sit on its one floor. Pure; the scene only draws the result. */
import { layoutRoom, type Cell, type RoomLayout } from './iso';

/**
 * A building's floor: every desk of the project in one open room — there is no room level any more
 * (city-by-project §3.2). The room layout's own rule decides the shape, so a building with no desk
 * still gets a small floor to stand its sign by.
 */
export type FloorLayout = RoomLayout;

export function layoutFloor(desks: number): FloorLayout {
  return layoutRoom(desks);
}

/** A floor on the city grid: its (0,0) tile and its layout. */
export interface PlacedFloor {
  origin: Cell;
  layout: FloorLayout;
}
```

Replace `apps/web/src/office/layout/city.ts` with:

```ts
/** Where each building's block sits in the city. Pure; the scene only draws the result. */
import { layoutFloor, type FloorLayout, type PlacedFloor } from './floor';
import { toScreen, type Cell } from './iso';
import { packShelves } from './shelves';

/** Tiles between two blocks: wide enough that where a building ends reads by itself. */
export const STREET = 4;
/**
 * Tiles of bare ground around a block's floor: the pavement that says where one building ends. It
 * is part of the block — `drawBlock` paints it and `blockBounds` frames it — so it lives here, with
 * the geometry, rather than with the drawing: framed without it, both side vertices fell off the canvas.
 */
export const BLOCK_MARGIN = 1;
/** A building with no desk still gets ground for its sign. */
const MIN_BLOCK = { width: 5, height: 3 };

export interface BlockInput {
  id: string;
  /** how many desks the building's one floor holds */
  desks: number;
}

export interface PlacedBlock {
  id: string;
  /** the block's (0,0) tile on the city grid */
  origin: Cell;
  /** the building's floor, in block-local coordinates */
  floor: FloorLayout;
  width: number;
  height: number;
}

export interface CityLayout {
  blocks: PlacedBlock[];
  width: number;
  height: number;
}

export function layoutCity(blocks: BlockInput[], targetWidth?: number): CityLayout {
  const items = blocks.map((b) => {
    const floor = layoutFloor(b.desks);
    return { id: b.id, floor, width: Math.max(floor.width, MIN_BLOCK.width), height: Math.max(floor.height, MIN_BLOCK.height) };
  });
  const packed = packShelves(items, STREET, STREET, targetWidth);
  return { blocks: packed.placed.map(({ item, origin }) => ({ ...item, origin })), width: packed.width, height: packed.height };
}

/** A block's floor in city coordinates: it sits at the block's own origin. */
export function floorOnCity(block: PlacedBlock): PlacedFloor {
  return { origin: block.origin, layout: block.floor };
}

/** Screen-space box of a block's ground, pavement and `wallH` pixels of walls included. */
export function blockBounds(block: PlacedBlock, wallH: number): { x: number; y: number; w: number; h: number } {
  const gx = block.origin.gx - BLOCK_MARGIN;
  const gy = block.origin.gy - BLOCK_MARGIN;
  const width = block.width + BLOCK_MARGIN * 2;
  const height = block.height + BLOCK_MARGIN * 2;
  const left = toScreen(gx, gy + height).x;
  const right = toScreen(gx + width, gy).x;
  const top = toScreen(gx, gy).y - wallH;
  const bottom = toScreen(gx + width, gy + height).y;
  return { x: left, y: top, w: right - left, h: bottom - top };
}

/** Screen-space box of the whole city; a zero-size box at the origin when there are no blocks. */
export function cityBounds(city: CityLayout, wallH: number): { x: number; y: number; w: number; h: number } {
  if (city.blocks.length === 0) return { x: 0, y: 0, w: 0, h: 0 };
  const boxes = city.blocks.map((b) => blockBounds(b, wallH));
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  return { x, y, w: Math.max(...boxes.map((b) => b.x + b.w)) - x, h: Math.max(...boxes.map((b) => b.y + b.h)) - y };
}

```

In `apps/web/src/office/layout/shelves.ts` line 1: `/** Shelf packing for the blocks of the city. Pure. */`.

- [ ] **Step 4: Implement the pure scene helpers.** Create `apps/web/src/office/scene/shape.ts`:

```ts
/** What a rebuild depends on. Pure: no PixiJS, so it can be tested alone. */
import type { CityModel } from '../model';

/**
 * Which buildings and desks exist — ids, kinds, order — and nothing about their state: `b{d:kind}`
 * per building. The same shape means a repaint in place; a new one means the city is rebuilt.
 */
export function shapeOf(city: CityModel): string {
  return city.buildings.map((b) => `${b.id}{${b.desks.map((d) => `${d.id}:${d.kind}`).join(',')}}`).join(';');
}
```

Replace `apps/web/src/office/scene/detail.ts` with:

```ts
/** What the overlay says at a given zoom, and what a building's sign says. Pure: no PixiJS, so it can be tested alone. */
import type { BuildingModel, FocusTarget } from '../model';

/** Zoom from which a sign keeps its full size; below it, it gives way a little (see Overlay.ts). */
export const SIGN_SCALE = 0.7;

/**
 * Zoom from which a free-roaming view is close enough to read a building's desks: a label keeps its
 * screen size, so below this the labels of two neighbouring desks (two tiles apart) run into each
 * other.
 */
export const LABEL_SCALE = 1.8;

/** A desk's name, machine line and bar: always inside the building the person stands in, elsewhere only close enough to read. */
export function deskLabelsVisible(target: FocusTarget, scale: number, buildingId: string): boolean {
  return scale >= LABEL_SCALE || (target.kind === 'building' && target.projectId === buildingId);
}

const NOTICE = { offline: 'offline', silent: 'sem resposta' } as const;
const needsYouText = (n: number) => (n === 1 ? '1 precisa de você' : `${n} precisam de você`);

/**
 * The building sign's three texts (city-by-project §3.2): the name, a muted detail line — the
 * notice, the board, or that nobody is in there right now — and the orange counter of who needs
 * you, which an offline building must still shout. The separator before the counter belongs to the
 * detail line, so it dims with it.
 */
export function buildingSignText(b: Pick<BuildingModel, 'label' | 'notice' | 'progress' | 'needsYou' | 'desks'>): { name: string; detail: string; count: string } {
  const parts: string[] = [];
  if (b.notice) parts.push(NOTICE[b.notice]);
  if (b.progress) parts.push(`${b.progress.done}/${b.progress.total} tarefas`);
  if (b.desks.length === 0) parts.push('sem agentes agora');
  const count = b.needsYou > 0 ? needsYouText(b.needsYou) : '';
  const detail = parts.join(' · ');
  return { name: b.label, detail: detail && count ? `${detail} ·` : detail, count };
}
```

- [ ] **Step 5: Run them to see them pass.** `WEBTEST src/office/layout/floor.test.ts src/office/layout/city.test.ts src/office/scene/shape.test.ts src/office/scene/detail.test.ts` — Expected: PASS (0 failed).

- [ ] **Step 6: Draw it.** Replace `apps/web/src/office/scene/RoomView.ts` with:

```ts
/** The ground of one building's block, and the floor and two back walls of its one floor. Colours only — no art needed. */
import { Graphics } from 'pixi.js';
import { BLOCK_MARGIN, type PlacedBlock } from '../layout/city';
import type { PlacedFloor } from '../layout/floor';
import { toScreen } from '../layout/iso';

/** Office partitions, not full walls: high enough to read as a floor, low enough not to hide the block behind. */
export const WALL_H = 28;
const LIT = { a: 0x313847, b: 0x2b3140, wallL: 0x1e222b, wallR: 0x262b36 };
const DARK = { a: 0x1f2430, b: 0x1b202a, wallL: 0x14171f, wallR: 0x191d26 };
/**
 * A dark block still needs a silhouette. Filled alone, an unlit building's ground was four values per
 * channel away from the page background: its footprint, and the street around it, were simply not
 * there. So every block is outlined, which also tells two neighbouring blocks apart.
 */
const BLOCK = { lit: { fill: 0x242a36, line: 0x3f485c }, dark: { fill: 0x171b24, line: 0x2c3342 } };
/** In world units, so that at city zoom the outline lands on about one pixel. */
const BLOCK_LINE = 3;

/**
 * One building's ground: a flat diamond under its floor, a shade darker than the floor. Also the
 * building's click target — it is what is left uncovered around the floor. Pass `into` to repaint it
 * in place, like `drawFloor`.
 */
export function drawBlock(block: PlacedBlock, lit: boolean, into?: Graphics): Graphics {
  const c = lit ? BLOCK.lit : BLOCK.dark;
  const g = into ?? new Graphics();
  g.clear();
  const x0 = block.origin.gx - BLOCK_MARGIN;
  const y0 = block.origin.gy - BLOCK_MARGIN;
  const x1 = block.origin.gx + block.width + BLOCK_MARGIN;
  const y1 = block.origin.gy + block.height + BLOCK_MARGIN;
  const n = toScreen(x0, y0);
  const e = toScreen(x1, y0);
  const s = toScreen(x1, y1);
  const w = toScreen(x0, y1);
  g.poly([n.x, n.y, e.x, e.y, s.x, s.y, w.x, w.y])
    .fill(c.fill)
    .stroke({ color: c.line, width: BLOCK_LINE });
  g.eventMode = 'static';
  g.cursor = 'pointer';
  return g;
}

/**
 * Tiles and the two back walls of a building's floor; nothing in front, so people are never covered.
 * Also a click target for the building. Pass `into` to repaint it in place — a light going out keeps
 * its handlers.
 */
export function drawFloor(floor: PlacedFloor, lit: boolean, into?: Graphics): Graphics {
  const c = lit ? LIT : DARK;
  const { gx: ox, gy: oy } = floor.origin;
  const { width, height } = floor.layout;
  const g = into ?? new Graphics();
  g.clear();
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

Replace `apps/web/src/office/scene/Overlay.ts` with:

```ts
/**
 * Everything that must stay readable: desk labels, markers, progress bars and building signs. These
 * live outside `world`, so furniture never covers them and they keep a fixed screen size;
 * `place()` puts each one back over its world point every frame.
 */
import { Container, Graphics, Text, type TextStyleOptions } from 'pixi.js';
import { deskMachineLine, truncateLabel, workingLabel, type BuildingModel, type DeskModel, type Marker } from '../model';
import type { View } from './camera';
import { buildingSignText, SIGN_SCALE } from './detail';

/** Hover is where a name cut to 18 characters and a task title become readable: room for both. */
const HOVER_MAX = 48;
/** A shade dimmer than the name colour: the activity label, the machine line and every sign's detail line. */
const MUTED = 0x9aa1b1;
const ATTENTION = 0xf0883e;

const MARKER: Record<Exclude<Marker, null>, { color: number; glyph: string }> = {
  input: { color: 0xd29922, glyph: '!' },
  permission: { color: 0xf0883e, glyph: '!' },
  error: { color: 0xf85149, glyph: '×' },
};

/**
 * Overlay text is read over furniture and people. It carries its own outline instead of a plate,
 * because anything opaque up here would hide the floor behind it. `outline` is the colour it is
 * read against: the background for a label, the disc itself for a marker's glyph.
 */
const text = (size: number, fill: number, weight: '400' | '700' = '400', outline = 0x0f1115): TextStyleOptions => ({
  fontSize: size,
  fill,
  fontWeight: weight,
  fontFamily: 'JetBrains Mono, Menlo, monospace',
  stroke: { color: outline, width: 3, join: 'round' },
});

/** Screen-space pieces of one desk. `world` is the desk's head point in world coordinates. */
export class DeskOverlay {
  readonly root = new Container();
  private readonly label: Text;
  /** the machine the desk runs on (office only, city-by-project §3.2): muted, under the name */
  private readonly machine: Text;
  /** the bound task's title, hover only: a task without subtasks has no bar, so this is all it gets */
  private readonly title: Text;
  private readonly marker = new Container();
  private readonly bar = new Graphics();
  private readonly barText: Text;
  private markerKind: Marker = null;
  private short = '';
  private full = '';
  /** the desk shows an activity label instead of its name right now: dims it, unless hovered */
  private showingActivity = false;
  private pulse = 0;
  hovered = false;

  constructor(
    readonly world: { x: number; y: number },
    model: DeskModel,
  ) {
    this.label = new Text({ text: model.label, style: text(11, 0xe6e8ee) });
    this.label.anchor.set(0.5, 0);
    this.machine = new Text({ text: '', style: text(10, MUTED) });
    this.machine.anchor.set(0.5, 0);
    this.title = new Text({ text: '', style: text(10, MUTED) });
    this.title.anchor.set(0.5, 0);
    this.barText = new Text({ text: '', style: text(10, 0xe6e8ee) });
    this.barText.anchor.set(0, 0.5);
    this.root.addChild(this.bar, this.barText, this.label, this.machine, this.title, this.marker);
    this.apply(model);
  }

  apply(model: DeskModel): void {
    const activity = model.pose === 'type' && workingLabel(model.activity, model.verb);
    this.short = activity || model.label;
    this.showingActivity = !!activity;
    this.full = truncateLabel(model.name, HOVER_MAX);
    this.machine.text = deskMachineLine(model.machine);
    this.title.text = model.progress ? truncateLabel(model.progress.title, HOVER_MAX) : '';
    this.label.text = this.hovered ? this.full : this.short;
    if (model.marker !== this.markerKind) {
      const entering = model.marker && model.marker !== 'error' && !this.markerKind;
      this.markerKind = model.marker;
      this.marker.removeChildren().forEach((c) => c.destroy());
      if (model.marker) {
        const m = MARKER[model.marker];
        const glyph = new Text({ text: m.glyph, style: text(14, 0x0f1115, '700', m.color) });
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
      // the track needs its own outline: filled with a background colour it vanishes into the floor
      this.bar.roundRect(-20, -5, 40, 5, 2).fill(0x1e222b).stroke({ color: 0x4b5468, width: 1 });
      this.bar.roundRect(-20, -5, Math.max(2, 40 * (p.done / p.total)), 5, 2).fill(done ? 0x3fb950 : 0x4f8cff);
    }
  }

  /** `labelsOn`: names, machine lines and bars are for a building seen up close; farther out only the marker shows. */
  place(view: View, labelsOn: boolean, t: number, reducedMotion: boolean): void {
    const x = view.x + this.world.x * view.scale;
    const y = view.y + this.world.y * view.scale;
    this.root.position.set(Math.round(x), Math.round(y));
    const bounce = this.markerKind && this.markerKind !== 'error' && !reducedMotion ? Math.abs(Math.sin(t * 4)) * 6 : 0;
    this.pulse = Math.max(0, this.pulse - 0.03);
    this.marker.position.set(0, -16 - bounce);
    this.marker.scale.set(1 + this.pulse * 0.8);
    // the label clears the chair, which scales with the world; everything else stacks right under it
    const below = 39 * view.scale;
    const shown = labelsOn || this.hovered;
    this.label.visible = shown;
    this.label.text = this.hovered ? this.full : this.short;
    this.label.style.fill = !this.hovered && this.showingActivity ? MUTED : 0xe6e8ee;
    this.label.position.set(0, below);
    this.label.alpha = this.hovered ? 1 : 0.75;
    // one line per piece under the name: the machine, then (hovered) the task's title, then the bar
    let line = below;
    const machineShown = shown && this.machine.text !== '';
    this.machine.visible = machineShown;
    if (machineShown) {
      line += 13;
      this.machine.position.set(0, line);
    }
    const titled = this.hovered && this.title.text !== '';
    this.title.visible = titled;
    if (titled) {
      line += 14;
      this.title.position.set(0, line);
    }
    const barY = line + 21;
    this.bar.visible = this.barText.visible = labelsOn;
    this.bar.position.set(-13, barY);
    this.barText.position.set(11, barY - 2.5);
    // over every other overlay item (its neighbours' labels, the signs), or it reads as clipped
    const z = this.hovered ? 2 : 1;
    if (this.root.zIndex !== z) this.root.zIndex = z;
  }
}

/** Overlay stacking: desk overlays take 1 (2 hovered), so a marker always wins over a sign. */
const SIGN_Z = 0.5;

/**
 * A sign hanging over a world point: a bold name, a muted detail line under it, no plate. `lift` is
 * extra height in SCREEN pixels. The world anchor shrinks with the zoom while markers, labels and
 * the signs themselves keep their screen size, so a sign that clears what is under it at close range
 * lands right on top of it once the camera pulls back.
 */
class Sign {
  readonly root = new Container();
  private readonly name: Text;
  private readonly detail: Text;

  constructor(
    readonly world: { x: number; y: number },
    size: number,
    private readonly lift = 0,
  ) {
    this.name = new Text({ text: '', style: text(size, 0xe6e8ee, '700') });
    this.detail = new Text({ text: '', style: text(11, MUTED) });
    this.name.anchor.set(0.5, 1);
    this.detail.anchor.set(0.5, 0);
    this.root.addChild(this.name, this.detail);
    this.root.eventMode = 'static';
    this.root.cursor = 'pointer';
  }

  /** `lit` dims the sign's OWN words and nothing a subclass added beside them. */
  protected write(label: string, detail: string, lit: boolean): void {
    this.name.text = label;
    this.detail.text = detail;
    this.name.alpha = this.detail.alpha = lit ? 1 : 0.6;
  }

  /** Width of the detail line, 0 when empty, so a subclass can lay its own piece out beside it. */
  protected get detailWidth(): number {
    return this.detail.text ? this.detail.width : 0;
  }

  protected set detailX(x: number) {
    this.detail.x = x;
  }

  /** Hidden once its anchor leaves the viewport, or half a sign stays glued to the screen edge. */
  place(view: View, screen: { width: number; height: number }): void {
    const x = view.x + this.world.x * view.scale;
    const y = view.y + this.world.y * view.scale - this.lift;
    this.root.visible = x >= 0 && x <= screen.width && y >= 0 && y <= screen.height;
    this.root.position.set(Math.round(x), Math.round(y));
  }
}

/**
 * The sign hangs over the block's FRONT corner, the one piece of a block that is reliably clear:
 * every marker points upwards out of a desk, so nothing of the building's own reaches down there,
 * and the text stays over its own ground instead of drifting across the street onto the block
 * behind it. The lift takes it far enough up that the diamond is wide enough to hold the text.
 */
const SIGN_LIFT = 32;
/** Zoomed out, the block shrinks around a sign that does not; it gives way a little, never past legibility. */
const MIN_SIGN_SCALE = 0.72;
/** Room between the detail line and the counter when the sign carries both. */
const DETAIL_GAP = 4;

/**
 * A building's one sign (city-by-project §3.2), merging the old machine and room signs: the
 * project's name, the notice, the board ("d/t tarefas") or "sem agentes agora", and how many need
 * you — in its own colour, because that is the one thing an unlit building must NOT say quietly.
 */
export class BuildingSign extends Sign {
  private readonly count = new Text({ text: '', style: text(11, ATTENTION) });

  constructor(world: { x: number; y: number }, model: BuildingModel) {
    super(world, 16, SIGN_LIFT);
    this.count.anchor.set(0.5, 0);
    this.root.addChild(this.count);
    this.root.zIndex = SIGN_Z;
    this.apply(model);
  }

  apply(model: BuildingModel): void {
    const { name, detail, count } = buildingSignText(model);
    this.count.text = count;
    this.write(name, detail, model.lit);
    // detail and counter are two texts on one line: centre the pair, not each half
    const detailW = this.detailWidth;
    const countW = count ? this.count.width : 0;
    const total = detailW + (detailW && countW ? DETAIL_GAP : 0) + countW;
    this.detailX = detailW / 2 - total / 2;
    this.count.x = total / 2 - countW / 2;
  }

  place(view: View, screen: { width: number; height: number }): void {
    this.root.scale.set(Math.min(1, Math.max(MIN_SIGN_SCALE, view.scale / SIGN_SCALE)));
    super.place(view, screen);
  }
}
```

Replace `apps/web/src/office/scene/OfficeScene.ts` with:

```ts
/** The city in PixiJS: one block per project (a building), its desks on one floor. Knows nothing about tabs, the API or React. */
import { Application, CanvasSource, Container, Rectangle, Texture, UPDATE_PRIORITY, type Graphics } from 'pixi.js';
import { BLOCK_MARGIN, blockBounds, cityBounds, floorOnCity, layoutCity, type CityLayout, type PlacedBlock } from '../layout/city';
import { depthOf, toScreen } from '../layout/iso';
import { sameFocus, type CityModel, type FocusTarget } from '../model';
import { generatedPack } from '../pack/generated';
import type { PackManifest } from '../pack/manifest';
import { Camera, sameBox, type Box } from './camera';
import { deskLabelsVisible } from './detail';
import { FrameListeners } from './frames';
import { BuildingSign, DeskOverlay } from './Overlay';
import { DeskView, type Textures } from './PersonView';
import { drawBlock, drawFloor, WALL_H } from './RoomView';
import { shapeOf } from './shape';

/** Room above a block's walls, so framing a block does not cut its top off. */
const SIGN_H = 24;

/** Headroom a block (or the whole city) needs above its ground, for its walls. */
const BLOCK_TOP = WALL_H + SIGN_H;

/** And under it, for the building sign that hangs over the block's front corner. */
const BLOCK_BOTTOM = SIGN_H + 32;

/** What is left of an unlit building's furniture and people. Its markers keep their full strength. */
const UNLIT_ALPHA = 0.45;

/** One building as drawn, so a light going out can repaint it where it stands. */
interface DrawnBuilding {
  block: PlacedBlock;
  ground: Graphics;
  floor: Graphics;
  lit: boolean;
  sign: BuildingSign;
  /** every desk of this building, so its light going out dims them all without a rebuild */
  views: DeskView[];
}

export interface SceneHandlers {
  onPickDesk(deskId: string, projectId: string): void;
  /** the block's ground or floor: frame that building */
  onPickBuilding(projectId: string): void;
  onPickSign(projectId: string): void;
  /** the person zoomed out far enough that the current rest no longer describes the view */
  onGoUp(): void;
}

export class OfficeScene {
  private app: Application | null = null;
  private mounting = false;
  private camera: Camera | null = null;
  private readonly world = new Container();
  private readonly floor = new Container();
  private readonly things = new Container();
  private readonly overlay = new Container();
  private textures: Textures = {};
  /** the pack's atlas: ours to free, since nothing else knows about it */
  private source: CanvasSource | null = null;
  private manifest: PackManifest | null = null;
  private city: CityLayout = layoutCity([]);
  private shape = '';
  private model: CityModel | null = null;
  /** keyed `buildingId:deskId`: two buildings could carry desks with the same id without colliding */
  private desks = new Map<string, { id: string; view: DeskView; overlay: DeskOverlay; buildingId: string }>();
  private buildings = new Map<string, DrawnBuilding>();
  private target: FocusTarget = { kind: 'city' };
  /** the scale the camera framed the current target at: zooming well below it means "go up" */
  private framedScale = 1;
  /** the person has panned or zoomed since the camera last framed something by itself */
  private userMoved = false;
  /** onGoUp already fired for this framing — one wheel gesture is many events */
  private wentUp = false;
  private destroyed = false;
  private readonly reducedMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  frameMs = 0;
  /** called right after every render to the screen with the canvas just drawn (see frames.ts) */
  private readonly frameListeners = new FrameListeners();
  /** while a video is recorded: no wheel, no drag, no re-framing */
  private cameraLocked = false;
  /** a framing asked for while the camera was locked, applied once it unlocks */
  private framingDeferred = false;

  constructor(private readonly handlers: SceneHandlers) {
    this.things.sortableChildren = true;
    // desk overlays over signs: a sign must never hide a marker of the building in front of it
    this.overlay.sortableChildren = true;
    this.world.addChild(this.floor, this.things);
  }

  /** Async because Pixi v8 picks its renderer asynchronously; safe against an unmount in between. */
  async mount(host: HTMLElement): Promise<void> {
    if (this.app || this.mounting || this.destroyed) return;
    this.mounting = true;
    const app = new Application();
    try {
      await app.init({ resizeTo: host, background: 0x0f1115, antialias: false, autoDensity: true, resolution: window.devicePixelRatio || 1 });
    } catch (err) {
      // neither WebGL nor canvas started: free the half-built app and let the page show its message,
      // leaving the scene mountable again (a stuck `mounting` would refuse every later attempt)
      this.mounting = false;
      app.destroy(true, { children: true });
      throw err;
    }
    this.mounting = false;
    if (this.destroyed) return app.destroy(true, { children: true });
    this.app = app;
    host.appendChild(app.canvas);
    const pack = generatedPack();
    this.manifest = pack.manifest;
    // built by hand rather than with Texture.from, which would leave the atlas in the global cache
    this.source = new CanvasSource({ resource: pack.canvas, scaleMode: 'nearest' });
    for (const [key, def] of Object.entries(pack.manifest.sprites)) {
      this.textures[key] = def.frames.map((f) => new Texture({ source: this.source!, frame: new Rectangle(f.x, f.y, f.w, f.h) }));
    }
    app.stage.addChild(this.world, this.overlay);
    this.camera = new Camera(app.canvas);
    this.camera.locked = this.cameraLocked;
    this.camera.onUserMove = () => {
      this.userMoved = true;
      if (this.wentUp || this.target.kind === 'city' || !this.camera) return;
      if (this.camera.target.scale < this.framedScale * 0.6) {
        this.wentUp = true;
        this.handlers.onGoUp();
      }
    };
    // brackets our update and Pixi's render (priority LOW) to get the CPU cost of one frame
    let t0 = 0;
    app.ticker.add(() => (t0 = performance.now()), undefined, UPDATE_PRIORITY.INTERACTION);
    app.ticker.add(() => this.tick());
    app.ticker.add(() => (this.frameMs = this.frameMs * 0.9 + (performance.now() - t0) * 0.1), undefined, UPDATE_PRIORITY.UTILITY);
    // Pixi's post-render runner fires inside render(), right after the draw calls — the frame is
    // still in the WebGL drawing buffer, so a 2D canvas can copy it (share images, the video)
    // only a render to the screen: a future render into a texture would hand out a stale canvas
    const postrender = {
      postrender: (options?: { target?: unknown }) => this.frameListeners.emit(app.canvas, options?.target === app.renderer.view.renderTarget),
    };
    app.renderer.runners.postrender.add(postrender);
    const onVisibility = () => (document.hidden ? app.ticker.stop() : app.ticker.start());
    // a resized canvas leaves the framing stale; re-frame unless the person put the camera there
    const onResize = () => {
      if (this.target.kind !== 'city' || !this.userMoved) this.frameTarget(true);
    };
    document.addEventListener('visibilitychange', onVisibility);
    app.renderer.on('resize', onResize);
    // Pixi's `resizeTo` only listens to the WINDOW's resize; the host also changes size with no
    // window resize at all — focus mode hides the sidebar, the sidebar collapses — so watch the element.
    const observer = new ResizeObserver(() => app.resize());
    observer.observe(host);
    this.cleanup = () => {
      observer.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      app.renderer.off('resize', onResize);
      app.renderer.runners.postrender.remove(postrender);
    };
    if (this.model) this.rebuild(this.model, true);
  }

  private cleanup: () => void = () => {};

  destroy(): void {
    this.destroyed = true;
    this.cleanup();
    this.camera?.destroy();
    this.camera = null;
    this.app?.destroy(true, { children: true });
    this.app = null;
    for (const frames of Object.values(this.textures)) for (const texture of frames) texture.destroy();
    this.textures = {};
    this.source?.destroy();
    this.source = null;
  }

  get fps(): number {
    return this.app?.ticker.FPS ?? 0;
  }

  get rendererName(): string {
    return this.app?.renderer.name ?? '—';
  }

  /** Subscribes to every rendered frame (see `frameListeners`); returns the unsubscribe. */
  onFrame(cb: (canvas: HTMLCanvasElement) => void): () => void {
    return this.frameListeners.add(cb);
  }

  /**
   * Freezes the framing for a recording: wheel and drag are ignored, and a re-framing (a resize, a
   * new target from a tap or Back) waits until the lock is released, which applies it once.
   */
  lockCamera(locked: boolean): void {
    this.cameraLocked = locked;
    if (this.camera) this.camera.locked = locked;
    if (!locked && this.framingDeferred) {
      this.framingDeferred = false;
      this.frameTarget(false);
    }
  }

  /** Same buildings and desks (ids, kinds, order) → only properties change; otherwise the city is rebuilt. */
  setModel(model: CityModel): void {
    const shape = shapeOf(model);
    this.model = model;
    if (!this.app) return;
    if (shape !== this.shape) return this.rebuild(model, this.shape === '');
    for (const building of model.buildings) {
      const drawn = this.buildings.get(building.id);
      if (!drawn) continue;
      // a building going dark is not a new city: repaint it and dim its desks where they stand
      if (drawn.lit !== building.lit) {
        drawn.lit = building.lit;
        drawBlock(drawn.block, building.lit, drawn.ground);
        drawFloor(floorOnCity(drawn.block), building.lit, drawn.floor);
        for (const view of drawn.views) view.root.alpha = building.lit ? 1 : UNLIT_ALPHA;
      }
      drawn.sign.apply(building);
      for (const d of building.desks) {
        const desk = this.desks.get(deskKey(building.id, d.id));
        desk?.view.apply(d);
        desk?.overlay.apply(d);
      }
    }
  }

  /** Dev/test aid: forces one desk's hovered state (`null` clears it), so a screenshot can show it. */
  debugHover(deskId: string | null): void {
    for (const desk of this.desks.values()) desk.overlay.hovered = desk.id === deskId;
  }

  /**
   * Frames the city or one building's block. The page replays the URL's target on every
   * navigation, so an equal target is a no-op: re-framing would undo a camera the person moved.
   */
  focus(target: FocusTarget, snap = false): void {
    if (this.destroyed || sameFocus(target, this.target)) return;
    this.target = target;
    this.frameTarget(snap);
  }

  /** No camera yet (focused before `mount()` resolved): the target is stored and the rebuild frames it. */
  private frameTarget(snap: boolean): void {
    if (!this.camera) return;
    if (this.cameraLocked) {
      this.framingDeferred = true;
      return;
    }
    this.camera.frameBox(this.boxOf(this.target), snap);
    this.framedScale = this.camera.target.scale;
    this.userMoved = false;
    this.wentUp = false;
  }

  private boxOf(target: FocusTarget): Box {
    // the building signs hang under their blocks, so a framed box reaches past the last block's ground
    const withSign = (b: Box): Box => ({ ...b, h: b.h + BLOCK_BOTTOM });
    const block = target.kind === 'building' ? this.city.blocks.find((b) => b.id === target.projectId) : undefined;
    return withSign(block ? blockBounds(block, BLOCK_TOP) : cityBounds(this.city, BLOCK_TOP));
  }

  /** Whether the current model still has what the target names. */
  private exists(target: FocusTarget): boolean {
    return target.kind === 'city' || !!this.model?.buildings.some((b) => b.id === target.projectId);
  }

  /**
   * `first`: the very first city, which is framed and snapped to. A later rebuild (a tab opened
   * anywhere in the account) re-frames the building the person is in only when its box actually
   * moved — the shelf packing moves later blocks, but a tab opened in ANOTHER building leaves this
   * one exactly where it was, and re-framing there would yank a camera zoomed onto one desk. On the
   * city as a whole it only re-centres while nobody has moved the camera by hand.
   */
  private rebuild(model: CityModel, first: boolean): void {
    if (!this.manifest) return;
    // read against the layout that is about to be replaced, so the two can be compared below
    const before = first ? null : this.boxOf(this.target);
    this.shape = shapeOf(model);
    this.city = layoutCity(model.buildings.map((b) => ({ id: b.id, desks: b.desks.length })));
    for (const layer of [this.floor, this.things, this.overlay]) layer.removeChildren().forEach((c) => c.destroy({ children: true }));
    this.desks.clear();
    this.buildings.clear();
    model.buildings.forEach((building, bi) => {
      const block = this.city.blocks[bi];
      const pick = () => this.clicked(() => this.handlers.onPickBuilding(building.id));
      // the block's ground goes down before its floor, which paints over it: both pick the building
      const ground = drawBlock(block, building.lit);
      ground.on('pointertap', pick);
      this.floor.addChild(ground);
      const placed = floorOnCity(block);
      const floor = drawFloor(placed, building.lit);
      floor.on('pointertap', pick);
      this.floor.addChild(floor);
      // over the block's FRONT corner, not its back one: markers all point up out of their desks,
      // so the ground down there is the one part of a block nothing of its own reaches into
      const front = toScreen(block.origin.gx + block.width + BLOCK_MARGIN, block.origin.gy + block.height + BLOCK_MARGIN);
      const sign = new BuildingSign(front, building);
      sign.root.on('pointertap', () => this.clicked(() => this.handlers.onPickSign(building.id)));
      this.overlay.addChild(sign.root);
      const drawn: DrawnBuilding = { block, ground, floor, lit: building.lit, sign, views: [] };
      this.buildings.set(building.id, drawn);
      building.desks.forEach((d, j) => {
        const cell = { gx: placed.origin.gx + placed.layout.desks[j].gx, gy: placed.origin.gy + placed.layout.desks[j].gy };
        const at = toScreen(cell.gx, cell.gy);
        const view = new DeskView(d, this.textures, this.manifest!, this.reducedMotion);
        view.root.position.set(at.x, at.y);
        view.root.zIndex = depthOf(cell);
        // an unlit building's furniture and people fade; their markers, in the overlay, do not
        view.root.alpha = building.lit ? 1 : UNLIT_ALPHA;
        drawn.views.push(view);
        const overlay = new DeskOverlay({ x: at.x + view.head.x, y: at.y + view.head.y }, d);
        overlay.root.zIndex = 1;
        view.root.on('pointertap', () => this.clicked(() => this.handlers.onPickDesk(view.model.id, view.model.projectId)));
        view.root.on('pointerover', () => (overlay.hovered = true));
        view.root.on('pointerout', () => (overlay.hovered = false));
        this.things.addChild(view.root);
        this.overlay.addChild(overlay.root);
        this.desks.set(deskKey(building.id, d.id), { id: d.id, view, overlay, buildingId: building.id });
      });
    });
    // a target whose building is gone falls back to the city, but the camera stays put
    if (!this.exists(this.target)) {
      this.target = { kind: 'city' };
      if (!first) return;
    }
    if (first) return this.frameTarget(true);
    // when the box is unchanged nothing is framed at all, so `userMoved` and `wentUp` keep whatever
    // the person's own wheel and drag put there
    const reframe = this.target.kind === 'city' ? !this.userMoved : before !== null && !sameBox(before, this.boxOf(this.target));
    if (reframe) this.frameTarget(false);
  }

  /** A press that dragged the camera is not a click. */
  private clicked(fn: () => void): void {
    if ((this.camera?.dragged ?? 0) < 5) fn();
  }

  private tick(): void {
    if (!this.camera || !this.app) return;
    const screen = this.app.screen;
    const view = this.camera.tick();
    this.world.scale.set(view.scale);
    this.world.position.set(view.x, view.y);
    const t = performance.now() / 1000;
    for (const { view: desk, overlay, buildingId } of this.desks.values()) {
      desk.update();
      overlay.place(view, deskLabelsVisible(this.target, view.scale, buildingId), t, this.reducedMotion);
    }
    // `place` turns a sign off again when its anchor has left the viewport
    for (const drawn of this.buildings.values()) drawn.sign.place(view, screen);
  }
}

const deskKey = (buildingId: string, deskId: string) => `${buildingId}:${deskId}`;
```

- [ ] **Step 7: Verify.** `WEBTEST src/office/layout src/office/scene` — Expected: PASS (layout, shape, detail, camera, camera.lock and frames tests; 0 failed). `grep -rln "from 'pixi.js'" apps/web/src | grep -v '^apps/web/src/office/\(scene\|pack\)/'` — Expected: no output. `DOCKER 'npm run typecheck -w @termhub/web'` — Expected: still red, but no error in `office/layout/*` or `office/scene/*` any more. The scene is seen drawing in Task B5's screenshots.

- [ ] **Step 8: Commit.**

```bash
git add apps/web/src/office/layout apps/web/src/office/scene
git commit -m "Office: draw one block per project with its desks on one floor

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---
### Task B3: `useOfficeCity` — one read for the whole city

**Files:**
- Create: `apps/web/src/office/useOfficeCity.ts`
- Test: `apps/web/src/office/useOfficeCity.test.tsx` (new)
- Delete: `apps/web/src/office/useOfficeSnapshots.ts`, `apps/web/src/office/useOfficeSnapshots.test.tsx`

**Interfaces:**
- Consumes: `api.office(fresh?: boolean): Promise<OfficeCity>` (Task B1).
- Produces: `useOfficeCity(enabled: boolean): { city: OfficeCity | null; failed: boolean; reload: () => boolean }` — reads on mount (`fresh` false) once `enabled`; again every 60 s while the browser tab is visible, and on window focus / becoming visible at most every 10 s; `reload()` asks for a fresh read (`api.office(true)`) and answers whether it started one (never two in flight); `failed` is true only when the FIRST read failed (a failed re-read keeps the last city); an answer landing after unmount is dropped.

- [ ] **Step 1: Write the failing test.** Create `apps/web/src/office/useOfficeCity.test.tsx`:

```tsx
// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OfficeCity } from '../lib/types';

const officeMock = vi.fn();

vi.mock('../lib/api', () => ({
  api: { office: (...a: unknown[]) => officeMock(...a) },
}));

import { useOfficeCity } from './useOfficeCity';

const cityOf = (name: string): OfficeCity => ({ projects: [{ project: { id: name, name } as never, public_id: `${name}-pub`, tabs: [], tasks: null }], machines: [] });

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.resetAllMocks();
  setVisibility('visible');
});

describe('useOfficeCity', () => {
  it('reads the whole city once on mount, not fresh', async () => {
    officeMock.mockResolvedValue(cityOf('a'));
    const { result } = renderHook(() => useOfficeCity(true));
    expect(result.current.city).toBeNull();
    await act(async () => {});
    expect(officeMock).toHaveBeenCalledTimes(1);
    expect(officeMock).toHaveBeenCalledWith(false);
    expect(result.current).toMatchObject({ city: cityOf('a'), failed: false });
  });

  it('reads nothing while disabled, and starts once enabled', async () => {
    officeMock.mockResolvedValue(cityOf('a'));
    const { rerender } = renderHook(({ on }) => useOfficeCity(on), { initialProps: { on: false } });
    await act(async () => {});
    expect(officeMock).not.toHaveBeenCalled();
    rerender({ on: true });
    await act(async () => {});
    expect(officeMock).toHaveBeenCalledTimes(1);
  });

  it('is failed when the first read fails, and keeps the last city when a later one does', async () => {
    vi.useFakeTimers();
    officeMock.mockRejectedValueOnce(new Error('boom'));
    const { result } = renderHook(() => useOfficeCity(true));
    await act(async () => {});
    expect(result.current).toMatchObject({ city: null, failed: true });
    officeMock.mockResolvedValueOnce(cityOf('a'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(result.current).toMatchObject({ city: cityOf('a'), failed: false });
    officeMock.mockRejectedValueOnce(new Error('again'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(result.current).toMatchObject({ city: cityOf('a'), failed: false });
  });

  it('re-reads every minute while visible, never while hidden, and at once on coming back', async () => {
    vi.useFakeTimers();
    officeMock.mockResolvedValue(cityOf('a'));
    renderHook(() => useOfficeCity(true));
    await act(async () => {});
    expect(officeMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(officeMock).toHaveBeenCalledTimes(2);
    act(() => setVisibility('hidden'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(officeMock).toHaveBeenCalledTimes(2);
    await act(async () => setVisibility('visible'));
    expect(officeMock).toHaveBeenCalledTimes(3);
  });

  it('reads on window focus at most once every 10 s, while reload() asks for a fresh read regardless', async () => {
    vi.useFakeTimers();
    officeMock.mockResolvedValue(cityOf('a'));
    const { result } = renderHook(() => useOfficeCity(true));
    await act(async () => {});
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    await act(async () => void window.dispatchEvent(new Event('focus')));
    expect(officeMock).toHaveBeenCalledTimes(1);
    let started = false;
    act(() => {
      started = result.current.reload();
    });
    expect(started).toBe(true);
    expect(officeMock).toHaveBeenLastCalledWith(true);
    await act(async () => {});
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    await act(async () => void window.dispatchEvent(new Event('focus')));
    expect(officeMock).toHaveBeenCalledTimes(3);
    expect(officeMock).toHaveBeenLastCalledWith(false);
  });

  it('never stacks a read on one in flight: reload() says whether it started one', async () => {
    let resolve!: (c: OfficeCity) => void;
    officeMock.mockReturnValueOnce(new Promise<OfficeCity>((r) => (resolve = r)));
    const { result } = renderHook(() => useOfficeCity(true));
    let started = true;
    act(() => {
      started = result.current.reload();
    });
    expect(started).toBe(false);
    expect(officeMock).toHaveBeenCalledTimes(1);
    await act(async () => resolve(cityOf('a')));
    officeMock.mockResolvedValue(cityOf('b'));
    act(() => {
      started = result.current.reload();
    });
    expect(started).toBe(true);
    await act(async () => {});
    expect(result.current.city).toEqual(cityOf('b'));
  });

  it('drops an answer that lands after the page is gone', async () => {
    let resolve!: (c: OfficeCity) => void;
    officeMock.mockReturnValueOnce(new Promise<OfficeCity>((r) => (resolve = r)));
    const { result, unmount } = renderHook(() => useOfficeCity(true));
    unmount();
    await act(async () => resolve(cityOf('a')));
    expect(result.current.city).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to see it fail.** `WEBTEST src/office/useOfficeCity.test.tsx` — Expected: FAIL, `Failed to resolve import "./useOfficeCity"`.

- [ ] **Step 3: Implement.** Create `apps/web/src/office/useOfficeCity.ts`:

```ts
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import type { OfficeCity } from '../lib/types';

const REFRESH_MS = 60_000;
/** Floor of the gap between two reads asked for by window focus or by the tab becoming visible. */
const MIN_GAP_MS = 10_000;

/**
 * The whole office city in one read (GET /api/office): on mount, every minute while the browser tab
 * is visible, on window focus and on becoming visible (10 s apart at least), and on `reload()` —
 * which the page calls when the monitor names a tab the city lacks, and which asks the server for a
 * fresh tmux probe (that tab is already on screen and must not read as "no session yet"). One read
 * in flight at a time. `failed` is only about the FIRST read: a failed re-read keeps the last city,
 * which is still the best picture there is. Nothing is read while `enabled` is false (a role that
 * cannot read projects or terminals is sent away by the page anyway).
 */
export function useOfficeCity(enabled: boolean): { city: OfficeCity | null; failed: boolean; reload: () => boolean } {
  const [city, setCity] = useState<OfficeCity | null>(null);
  const [failed, setFailed] = useState(false);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const hasCity = useRef(false);
  const inFlight = useRef(false);
  const lastRead = useRef(0);
  const mounted = useRef(true);

  const read = useCallback((opts: { throttled?: boolean; fresh?: boolean } = {}): boolean => {
    if (!enabledRef.current || inFlight.current) return false;
    if (opts.throttled && Date.now() - lastRead.current < MIN_GAP_MS) return false;
    lastRead.current = Date.now();
    inFlight.current = true;
    api
      .office(opts.fresh ?? false)
      .then((next) => {
        if (!mounted.current) return;
        hasCity.current = true;
        setCity(next);
        setFailed(false);
      })
      .catch(() => {
        if (mounted.current && !hasCity.current) setFailed(true);
      })
      .finally(() => {
        inFlight.current = false;
      });
    return true;
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (enabled) read();
  }, [enabled, read]);

  useEffect(() => {
    const again = (throttled: boolean) => {
      if (document.visibilityState === 'visible') read({ throttled });
    };
    const timer = setInterval(() => again(false), REFRESH_MS);
    const onFocus = () => again(true);
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [read]);

  const reload = useCallback(() => read({ fresh: true }), [read]);
  return { city, failed, reload };
}
```

Delete the per-machine hook and its test: `git rm apps/web/src/office/useOfficeSnapshots.ts apps/web/src/office/useOfficeSnapshots.test.tsx`.

- [ ] **Step 4: Run it to see it pass.** `WEBTEST src/office/useOfficeCity.test.tsx` — Expected: PASS (7 tests).

- [ ] **Step 5: Commit.**

```bash
git add apps/web/src/office/useOfficeCity.ts apps/web/src/office/useOfficeCity.test.tsx
git commit -m "Office: read the whole city in one request from the page

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

(The `git rm` above already staged the two deletions.)

---

### Task B4: The office page — `/office` and `/office/:projectId`

**Files:**
- Modify: `apps/web/src/pages/OfficePage.tsx` (whole file)
- Modify: `apps/web/src/App.tsx:67` (route param)
- Test: `apps/web/src/pages/OfficePage.test.tsx` (whole file)

**Interfaces:**
- Consumes: `useOfficeCity(enabled)` (Task B3); `buildCityModel`, `missingTabIds`, `resolveFocus`, `sameFocus`, `BuildingModel`, `CityModel`, `FocusTarget` (Task B1); `OfficeScene` with `{ onPickDesk, onPickBuilding, onPickSign, onGoUp }` (Task B2); `useMonitor()` → `{ items: MonitorItem[]; tabState; connected }`; `useCityLink(active)` → `{ link: { short_url } | null }`; `cityLinkFor(publicCityUrl, nickname)`; `useFocusMode()`; `useAuth()` → `{ can, user, publicCityUrl }`; `Project.public_id` (Task B1).
- Produces: routes `/office` (the city) and `/office/:projectId` (a building); `?focus=1` kept through every move, `?room=` dropped; an unknown `:projectId` (an old `/office/:machineId` bookmark included) redirects to `/office` keeping the rest of the query. Ladder (Esc): building → city → out of focus mode, skipping the city with a single project; the scene's zoom-out gesture never takes the last rung. `/office` with a single project auto-drills into it. Trail `Cidade › <projeto>` (no `Cidade` with one project). Share: `shareResultFor(target, userId, nickname, publicCityUrl, shortUrl, projects)` → `{ kind: 'link'; url } | { kind: 'unpublished' } | { kind: 'foreign' }` — city: the short link (else the base) when one of the viewer's own projects is published, `foreign` when only somebody else's is, else `unpublished`; building: `${base}/${project.public_id}` when the project is published and the viewer owns it, `unpublished` when it is not published (or the viewer has no nickname yet), `foreign` when somebody else owns it. `offstreet` is gone.

- [ ] **Step 1: Write the failing test.** Replace `apps/web/src/pages/OfficePage.test.tsx` with:

```tsx
// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation, useNavigate, type NavigateFunction } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OfficeBuilding, OfficeCity, OfficeMachine, OfficeTab, Project, User } from '../lib/types';

// vi.mock factories are hoisted above every other top-level statement in this file, including this
// file's own `import { OfficePage } from './OfficePage'` below — so everything a factory needs to
// reference has to be created through vi.hoisted(), not as a plain top-level const/class.
const { officeMock, canMock, monitorState, authState, FakeOfficeScene } = vi.hoisted(() => {
  /**
   * Pins the scene-mount effect's stability: no WebGL in jsdom, so `OfficeScene` itself is replaced
   * with a spy-able stand-in that records what the page does to it, instead of drawing anything.
   */
  type Target = { kind: 'city' } | { kind: 'building'; projectId: string };
  class FakeOfficeScene {
    static instances: FakeOfficeScene[] = [];
    handlers: { onPickDesk: (tabId: string, projectId: string) => void; onPickBuilding: (projectId: string) => void; onPickSign: (projectId: string) => void; onGoUp: () => void };
    models: Array<{ buildings: Array<{ id: string; notice: string | null; desks: Array<{ id: string; machine: unknown }> }> }> = [];
    focusCalls: Array<[Target, boolean | undefined]> = [];
    destroyed = false;
    constructor(handlers: FakeOfficeScene['handlers']) {
      this.handlers = handlers;
      FakeOfficeScene.instances.push(this);
    }
    /** every target the page asked for, in order */
    get targets(): Target[] {
      return this.focusCalls.map(([t]) => t);
    }
    /** which buildings the last model the page handed over carries */
    get buildingIds(): string[] {
      return (this.models.at(-1)?.buildings ?? []).map((b) => b.id);
    }
    async mount(): Promise<void> {}
    destroy(): void {
      this.destroyed = true;
    }
    setModel(model: FakeOfficeScene['models'][number]): void {
      this.models.push(model);
    }
    focus(target: Target, snap?: boolean): void {
      this.focusCalls.push([target, snap]);
    }
  }
  return {
    officeMock: vi.fn(),
    canMock: vi.fn((_resource: string, _action?: string) => true),
    // mutable containers: the mocked hooks below read `.current` fresh on every call
    monitorState: { current: { items: [] as unknown[], needsYou: [] as unknown[], tabState: () => undefined, connected: true } },
    // null by default: the share button must stay out of the way (a quiet "nothing published" span)
    authState: { current: { user: null as User | null, publicCityUrl: 'https://termhub.dev/city' as string | null } },
    FakeOfficeScene,
  };
});

const { cityLinkState } = vi.hoisted(() => ({ cityLinkState: { current: { link: null as { short_url: string | null } | null } } }));
vi.mock('../lib/city-link', () => ({ useCityLink: () => cityLinkState.current }));
vi.mock('../office/scene/OfficeScene', () => ({ OfficeScene: FakeOfficeScene }));
vi.mock('../lib/api', () => ({ api: { office: (...a: unknown[]) => officeMock(...a) } }));
vi.mock('../lib/auth', () => ({ useAuth: () => ({ can: canMock, user: authState.current.user, publicCityUrl: authState.current.publicCityUrl }) }));
vi.mock('../lib/monitor', () => ({ useMonitor: () => monitorState.current }));

import { FocusProvider } from '../lib/focus';
import { OfficePage } from './OfficePage';

const tab = (id: string, projectId: string, machineId = 'm1'): OfficeTab => ({
  id, project_id: projectId, machine_id: machineId, name: id, kind: 'terminal', tmux_session: null, simulator_udid: null, position: 0,
  state: null, state_text: null, state_tool: null, state_at: null, state_seen_at: null, activity: null, activity_verb: null, created_at: '', alive: true, progress: null,
});
const project = (id: string, over: Partial<Project> = {}): Project => ({ id, name: id, status: 'active', owner_id: 'u1', is_public: false, public_id: `${id}-pub`, ...over }) as Project;
const building = (id: string, tabs: OfficeTab[] = [], over: Partial<Project> = {}): OfficeBuilding => ({ project: project(id, over), public_id: `${id}-pub`, tabs, tasks: null });
const machine = (id: string, name: string, over: Partial<OfficeMachine> = {}): OfficeMachine => ({ id, name, subtitle: null, type: 'agent', online: true, reachable: true, ...over });
const MACHINES = [machine('m1', 'jarvis', { subtitle: 'MacBook do escritório' }), machine('m2', 'hal')];
const cityOf = (projects: OfficeBuilding[], machines: OfficeMachine[] = MACHINES): OfficeCity => ({ projects, machines });

/** p1 runs on jarvis and hal, p2 on hal: two buildings, so /office rests on the city. */
function twoProjects(over: { p1?: Partial<Project>; p2?: Partial<Project> } = {}, machines: OfficeMachine[] = MACHINES) {
  officeMock.mockResolvedValue(cityOf([building('p1', [tab('t1', 'p1', 'm1'), tab('t1b', 'p1', 'm2')], over.p1), building('p2', [tab('t2', 'p2', 'm2')], over.p2)], machines));
}
/** one project: /office is its building */
function oneProject(machines: OfficeMachine[] = MACHINES) {
  officeMock.mockResolvedValue(cityOf([building('p1', [tab('t1', 'p1', 'm1')])], machines));
}

// lets a test drive real react-router navigation (path AND query string) the same way a production
// click or a pasted URL would — the rests of the office are URLs, so every move is read back from them
let testNavigate: NavigateFunction | undefined;
let testPath = '';
let testSearch = '';
function NavCapture() {
  testNavigate = useNavigate();
  const location = useLocation();
  testPath = location.pathname;
  testSearch = location.search;
  return null;
}

const tree = (initialEntry: string) => (
  <MemoryRouter initialEntries={[initialEntry]}>
    <FocusProvider>
      <NavCapture />
      <Routes>
        <Route path="/office" element={<OfficePage />} />
        <Route path="/office/:projectId" element={<OfficePage />} />
      </Routes>
    </FocusProvider>
  </MemoryRouter>
);

function renderPage(initialEntry = '/office') {
  return render(tree(initialEntry));
}

const scene = () => FakeOfficeScene.instances[0];
const escape = () => fireEvent.keyDown(document.body, { key: 'Escape' });
const pedro = () => (authState.current = { ...authState.current, user: { id: 'u1', nickname: 'pedro' } as User });

beforeEach(() => {
  FakeOfficeScene.instances = [];
  cityLinkState.current = { link: null };
  officeMock.mockReset();
  canMock.mockReset();
  canMock.mockReturnValue(true);
  testNavigate = undefined;
  testPath = '';
  testSearch = '';
  monitorState.current = { items: [], needsYou: [], tabState: () => undefined, connected: true };
  authState.current = { user: null, publicCityUrl: 'https://termhub.dev/city' };
});

afterEach(() => {
  cleanup();
});

describe('OfficePage scene lifecycle', () => {
  it('builds one scene once the city is read, and hands it every building', async () => {
    let resolve!: (c: OfficeCity) => void;
    officeMock.mockReturnValue(new Promise<OfficeCity>((r) => (resolve = r)));
    renderPage('/office');
    await act(async () => {});
    // still reading: there is no host to mount on yet
    expect(FakeOfficeScene.instances).toHaveLength(0);
    expect(screen.getByText('Carregando…')).toBeTruthy();
    await act(async () => resolve(cityOf([building('p1', [tab('t1', 'p1')]), building('p2')])));
    expect(FakeOfficeScene.instances).toHaveLength(1);
    expect(scene().buildingIds).toEqual(['p1', 'p2']);
  });

  it('reads the whole city in one request', async () => {
    twoProjects();
    renderPage('/office');
    await act(async () => {});
    expect(officeMock).toHaveBeenCalledTimes(1);
    expect(officeMock).toHaveBeenCalledWith(false);
  });

  it('keeps the same scene from the city into a building and back up', async () => {
    twoProjects();
    renderPage('/office?focus=1');
    await act(async () => {});
    const only = scene();
    act(() => only.handlers.onPickBuilding('p1'));
    await act(async () => {});
    expect(testPath).toBe('/office/p1');
    expect(new URLSearchParams(testSearch).get('focus')).toBe('1');
    escape();
    await act(async () => {});
    expect(testPath).toBe('/office');
    // every rest of the walk is a camera move on ONE scene: the canvas never blanks
    expect(FakeOfficeScene.instances).toHaveLength(1);
    expect(only.destroyed).toBe(false);
    expect(only.targets.slice(-2)).toEqual([{ kind: 'building', projectId: 'p1' }, { kind: 'city' }]);
  });

  it('keeps the same scene when focus mode is toggled by the real button', async () => {
    twoProjects();
    renderPage('/office/p1');
    await act(async () => {});
    const only = scene();
    fireEvent.click(screen.getByText('modo foco'));
    await act(async () => {});
    expect(screen.getByText('sair do foco (Esc)')).toBeTruthy();
    fireEvent.click(screen.getByText('sair do foco (Esc)'));
    await act(async () => {});
    expect(screen.getByText('modo foco')).toBeTruthy();
    expect(FakeOfficeScene.instances).toHaveLength(1);
    expect(only.destroyed).toBe(false);
  });

  it('leaves a building without pushing history, so Back does not walk straight back in', async () => {
    twoProjects();
    renderPage('/office');
    await act(async () => {});
    act(() => scene().handlers.onPickBuilding('p2'));
    await act(async () => {});
    expect(testPath).toBe('/office/p2');
    escape();
    await act(async () => {});
    expect(testPath).toBe('/office');
    await act(async () => testNavigate?.(-1));
    expect(testPath).toBe('/office');
  });

  it("opens a desk's terminal in a new tab, and the building sign opens its project", async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    twoProjects();
    renderPage('/office/p1');
    await act(async () => {});
    act(() => scene().handlers.onPickDesk('t1', 'p1'));
    expect(open).toHaveBeenCalledWith('/projects/p1?tab=t1', '_blank', 'noopener');
    open.mockRestore();
    act(() => scene().handlers.onPickSign('p1'));
    await act(async () => {});
    expect(testPath).toBe('/projects/p1');
  });
});

describe('OfficePage rests and the URL', () => {
  it('with a single project, /office lands on its building and keeps ?focus=1', async () => {
    oneProject();
    renderPage('/office?focus=1');
    await act(async () => {});
    expect(testPath).toBe('/office/p1');
    expect(testSearch).toBe('?focus=1');
  });

  it('with a single project, the ladder skips the city: Esc leaves focus mode', async () => {
    oneProject();
    renderPage('/office/p1?focus=1');
    await act(async () => {});
    escape();
    await act(async () => {});
    // the city rung is skipped: /office with one project would auto-drill straight back here
    expect(testPath).toBe('/office/p1');
    expect(testSearch).toBe('');
    expect(scene().targets.at(-1)).toEqual({ kind: 'building', projectId: 'p1' });
    expect(screen.getByText('Escritório')).toBeTruthy();
    expect(screen.queryByText('sair do foco (Esc)')).toBeNull();
  });

  it('a zoom-out gesture never leaves focus mode', async () => {
    oneProject();
    renderPage('/office/p1?focus=1');
    await act(async () => {});
    act(() => scene().handlers.onGoUp());
    await act(async () => {});
    expect(testPath).toBe('/office/p1');
    expect(testSearch).toBe('?focus=1');
    expect(screen.getByText('sair do foco (Esc)')).toBeTruthy();
  });

  it('with several projects, /office rests on the city', async () => {
    twoProjects();
    renderPage('/office');
    await act(async () => {});
    expect(testPath).toBe('/office');
    expect(scene().targets.at(-1)).toEqual({ kind: 'city' });
  });

  it('frames the building of the project in the URL on a direct load', async () => {
    twoProjects();
    renderPage('/office/p2');
    await act(async () => {});
    expect(scene().targets.at(-1)).toEqual({ kind: 'building', projectId: 'p2' });
  });

  // city-by-project §7: a /office/:machineId bookmark, with the old office's ?room=, is the city
  it('sends an unknown project — an old machine bookmark — back to the city, keeping focus and dropping ?room=', async () => {
    twoProjects();
    renderPage('/office/m1?room=p1&focus=1');
    await act(async () => {});
    expect(testPath).toBe('/office');
    expect(testSearch).toBe('?focus=1');
  });

  it('re-reads the city, fresh, when the monitor names a tab it lacks — once per tab', async () => {
    twoProjects();
    const { rerender } = renderPage('/office');
    await act(async () => {});
    expect(officeMock).toHaveBeenCalledTimes(1);
    monitorState.current = { ...monitorState.current, items: [{ tab: { id: 'new' }, project: { id: 'p1' } }] };
    await act(async () => {
      rerender(tree('/office'));
    });
    expect(officeMock).toHaveBeenCalledTimes(2);
    expect(officeMock).toHaveBeenLastCalledWith(true);
    await act(async () => {
      rerender(tree('/office'));
    });
    expect(officeMock).toHaveBeenCalledTimes(2);
  });

  it('reads nothing and goes home without the grants to see the office', async () => {
    canMock.mockImplementation((resource: string) => resource !== 'terminals');
    renderPage('/office');
    await act(async () => {});
    expect(officeMock).not.toHaveBeenCalled();
    expect(testPath).toBe('/');
  });

  it('says there is nothing to draw without projects', async () => {
    officeMock.mockResolvedValue(cityOf([], []));
    renderPage('/office');
    await act(async () => {});
    expect(screen.getByText(/Nenhum projeto ainda/)).toBeTruthy();
    expect(FakeOfficeScene.instances).toHaveLength(0);
  });

  it('says so when the city could not be read', async () => {
    officeMock.mockRejectedValue(new Error('nope'));
    renderPage('/office');
    await act(async () => {});
    expect(screen.getByText('Não foi possível carregar o escritório. Tentando de novo…')).toBeTruthy();
  });
});

describe('OfficePage desks', () => {
  // city-by-project §1: the machine is a detail of the desk, not a place
  it('hands the scene every desk with the machine it runs on', async () => {
    twoProjects();
    renderPage('/office');
    await act(async () => {});
    const p1 = scene().models.at(-1)!.buildings.find((b) => b.id === 'p1')!;
    expect(p1.desks.map((d) => [d.id, d.machine])).toEqual([
      ['t1', { name: 'jarvis', subtitle: 'MacBook do escritório', online: true }],
      ['t1b', { name: 'hal', subtitle: null, online: true }],
    ]);
  });
});

describe('OfficePage top bar', () => {
  it('renders the trail at a building, and its city part goes back up', async () => {
    twoProjects();
    renderPage('/office/p1');
    await act(async () => {});
    expect(screen.getByLabelText('Trilha').textContent).toBe('Cidade›p1');
    fireEvent.click(screen.getByRole('button', { name: 'Cidade' }));
    await act(async () => {});
    expect(testPath).toBe('/office');
    expect(scene().targets.at(-1)).toEqual({ kind: 'city' });
  });

  it('leaves the city part out of the trail with a single project', async () => {
    oneProject();
    renderPage('/office/p1');
    await act(async () => {});
    expect(screen.getByLabelText('Trilha').textContent).toBe('p1');
  });

  it('is the shared page header: Escritório as the only title, the trail and the actions in it', async () => {
    twoProjects();
    renderPage('/office');
    await act(async () => {});
    expect(screen.getAllByRole('heading', { level: 1 }).map((h) => h.textContent)).toEqual(['Escritório']);
    const header = screen.getByRole('heading', { level: 1 }).closest('header')!;
    expect(header.contains(screen.getByLabelText('Trilha'))).toBe(true);
    expect(header.contains(screen.getByText('modo foco'))).toBe(true);
  });
});

describe('OfficePage status notices', () => {
  // focus mode is the second monitor left open all day: a dropped WebSocket there must not be a
  // frozen picture that looks live
  it('shows "reconectando…" in focus mode, where the top bar is gone', async () => {
    oneProject();
    monitorState.current = { ...monitorState.current, connected: false };
    renderPage('/office/p1?focus=1');
    await act(async () => {});
    expect(screen.getByText('sair do foco (Esc)')).toBeTruthy();
    expect(screen.queryByText('modo foco')).toBeNull();
    expect(screen.getByText('reconectando…')).toBeTruthy();
  });

  it('shows "máquina offline" at a building whose every machine is offline, in both modes', async () => {
    oneProject([machine('m1', 'jarvis', { online: false, reachable: false })]);
    const { unmount } = renderPage('/office/p1');
    await act(async () => {});
    expect(screen.getByText('máquina offline')).toBeTruthy();
    unmount();
    renderPage('/office/p1?focus=1');
    await act(async () => {});
    expect(screen.getByText('máquina offline')).toBeTruthy();
    // an offline machine already explains the silence; the tmux notice is for a machine that answers
    expect(screen.queryByText(/tmux sem resposta/)).toBeNull();
  });

  it('says so when a machine of the building cannot read its tmux', async () => {
    oneProject([machine('m1', 'jarvis', { reachable: false })]);
    renderPage('/office/p1');
    await act(async () => {});
    // compact in the header: a short label, the whole sentence for hover and screen readers
    const notice = screen.getByLabelText('sem resposta do tmux: estado pode estar desatualizado');
    expect(notice.textContent).toBe('tmux sem resposta');
    expect(notice.getAttribute('title')).toBe('sem resposta do tmux: estado pode estar desatualizado');
    expect(notice.querySelector('svg')).not.toBeNull();
  });

  it("keeps a building's notices out of the city rest, where its sign says it", async () => {
    twoProjects({}, [machine('m1', 'jarvis', { online: false, reachable: false }), machine('m2', 'hal', { online: false, reachable: false })]);
    renderPage('/office');
    await act(async () => {});
    expect(testPath).toBe('/office');
    expect(screen.queryByText('máquina offline')).toBeNull();
  });
});

describe('OfficePage share button', () => {
  function stubClipboard() {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    return writeText;
  }

  afterEach(() => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
  });

  async function share() {
    fireEvent.click(screen.getByRole('button', { name: /compartilhar/i }));
    await act(async () => {});
  }

  it("copies the city's own address when one of the viewer's projects is published", async () => {
    const writeText = stubClipboard();
    pedro();
    twoProjects({ p1: { is_public: true } });
    renderPage('/office');
    await act(async () => {});
    await share();
    expect(writeText).toHaveBeenCalledWith('https://termhub.dev/city/@pedro');
  });

  it('copies the short link at the city, when there is one', async () => {
    const writeText = stubClipboard();
    pedro();
    cityLinkState.current = { link: { short_url: 'https://77a.it/pedro' } };
    twoProjects({ p1: { is_public: true } });
    renderPage('/office');
    await act(async () => {});
    await share();
    expect(writeText).toHaveBeenCalledWith('https://77a.it/pedro');
  });

  // city-by-project §3.3: a building's link is the base plus its project's public id
  it("copies a building's address from its project's public id, even with a short link", async () => {
    const writeText = stubClipboard();
    pedro();
    cityLinkState.current = { link: { short_url: 'https://77a.it/pedro' } };
    twoProjects({ p1: { is_public: true } });
    renderPage('/office/p1');
    await act(async () => {});
    await share();
    expect(writeText).toHaveBeenCalledWith('https://termhub.dev/city/@pedro/p1-pub');
  });

  // A self-hosted instance: the link is its own public-city address, as the server reports it.
  it("builds the link from this instance's own public-city address, never termhub.dev", async () => {
    const writeText = stubClipboard();
    authState.current = { user: { id: 'u1', nickname: 'pedro' } as User, publicCityUrl: 'https://th.example.org/city' };
    twoProjects({ p1: { is_public: true } });
    renderPage('/office/p1');
    await act(async () => {});
    await share();
    expect(writeText).toHaveBeenCalledWith('https://th.example.org/city/@pedro/p1-pub');
  });

  // §2.4: a published project is always on the street, whatever machines its agents use
  it("shares the viewer's published project even when its agents run on other machines, and never says 'máquina de outra pessoa'", async () => {
    const writeText = stubClipboard();
    pedro();
    twoProjects({ p1: { is_public: true } });
    renderPage('/office/p1');
    await act(async () => {});
    expect(screen.queryByText(/máquina de outra pessoa/i)).toBeNull();
    await share();
    expect(writeText).toHaveBeenCalledTimes(1);
  });

  it('explains itself instead of copying when the project in view is not published', async () => {
    const writeText = stubClipboard();
    pedro();
    twoProjects({ p1: { is_public: true } });
    renderPage('/office/p2');
    await act(async () => {});
    expect(screen.queryByRole('button', { name: /compartilhar/i })).toBeNull();
    expect(screen.getByText(/nada publicado/i)).toBeTruthy();
    expect(writeText).not.toHaveBeenCalled();
  });

  it('explains itself at the city while nothing is published', async () => {
    pedro();
    twoProjects();
    renderPage('/office');
    await act(async () => {});
    expect(screen.queryByRole('button', { name: /compartilhar/i })).toBeNull();
    expect(screen.getByText(/nada publicado/i)).toBeTruthy();
  });

  it('produces no link for a published project whose owner is not the viewer (view-as/view-all)', async () => {
    const writeText = stubClipboard();
    pedro();
    twoProjects({ p1: { is_public: true, owner_id: 'u2' } });
    renderPage('/office/p1');
    await act(async () => {});
    expect(screen.queryByRole('button', { name: /compartilhar/i })).toBeNull();
    expect(screen.getByText(/pertence a outra pessoa/i)).toBeTruthy();
    expect(writeText).not.toHaveBeenCalled();
  });

  it("does not build the city link from an admin's own nickname when only someone else's project is published", async () => {
    const writeText = stubClipboard();
    pedro();
    twoProjects({ p1: { is_public: true, owner_id: 'u2' } });
    renderPage('/office');
    await act(async () => {});
    expect(screen.queryByRole('button', { name: /compartilhar/i })).toBeNull();
    expect(screen.getByText(/pertence a outra pessoa/i)).toBeTruthy();
    expect(writeText).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it to see it fail.** `WEBTEST src/pages/OfficePage.test.tsx` — Expected: FAIL (the page still imports the deleted `../office/useOfficeSnapshots`: `Failed to resolve import`).

- [ ] **Step 3: Implement the page.** Replace `apps/web/src/pages/OfficePage.tsx` with:

```tsx
import { TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { useCityLink } from '../lib/city-link';
import { useFocusMode } from '../lib/focus';
import { useMonitor } from '../lib/monitor';
import { cityLinkFor } from '../lib/public-city';
import type { Project } from '../lib/types';
import { PageHeader } from '../components/PageHeader';
import { buildCityModel, missingTabIds, resolveFocus, sameFocus, type BuildingModel, type CityModel, type FocusTarget } from '../office/model';
import { OfficeScene } from '../office/scene/OfficeScene';
import { useOfficeCity } from '../office/useOfficeCity';

const EMPTY_CITY: CityModel = { buildings: [], needsYou: 0 };

/** The query string without `room` — a key of the office by machine that means nothing any more. */
function withoutRoom(params: URLSearchParams): string {
  const next = new URLSearchParams(params);
  next.delete('room');
  const query = next.toString();
  return query ? `?${query}` : '';
}

/**
 * The office: the whole account as a city, live, one building per project (city-by-project §3). The
 * URL is the state, and each of its rests is a place the camera stands — /office the city,
 * /office/:projectId a building, ?focus=1 focus mode. Moving between rests only moves the camera:
 * one scene is built per visit and kept, so the canvas never blanks on the way down or up. A machine
 * is a detail of a desk here, never a place.
 */
export function OfficePage() {
  const { projectId } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { can, user, publicCityUrl } = useAuth();
  // the city's short link, when the instance makes one: only the city depth uses it (a building has none)
  const cityLink = useCityLink(!!user?.nickname);
  const { items, tabState, connected } = useMonitor();
  const { focus, setFocus } = useFocusMode();
  const allowed = can('projects', 'read') && can('terminals', 'read');
  const { city: office, failed: readFailed, reload } = useOfficeCity(allowed);
  // a callback ref, not useRef: the host <div> is absent on the first render (loading/permission
  // branches return early below), and a ref alone would never re-trigger the mount effect once it
  // finally renders — which left the scene blank on a direct load or reload of the URL.
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const sceneRef = useRef<OfficeScene | null>(null);
  const [failed, setFailed] = useState(false);

  // tabState reads a ref (lib/monitor.tsx), so it never changes identity; `items` is what actually
  // changes on a live push — keep it as a dep, or the model stops updating on monitor pushes.
  const city = useMemo(() => (office ? buildCityModel(office, tabState) : EMPTY_CITY), [office, tabState, items]);

  // mirrors `city` for the scene-mount effect below: a scene created there must be seeded with
  // whatever is already known, not sit blank waiting for this effect to fire again.
  const cityRef = useRef<CityModel>(city);
  useEffect(() => {
    cityRef.current = city;
    sceneRef.current?.setModel(city);
  }, [city]);

  // What the URL asks the camera to frame, against what exists: an unknown project (an old machine
  // bookmark too) is the city (office/model.ts), so it can never throw here.
  const target = resolveFocus(city, projectId);
  // mirrors the target; the object is rebuilt on every render, so the scene is only told when the
  // target changed BY VALUE: re-framing an equal target would undo a camera the person moved by hand.
  const targetRef = useRef<FocusTarget>(target);
  useEffect(() => {
    if (sameFocus(target, targetRef.current)) return;
    targetRef.current = target;
    sceneRef.current?.focus(target);
  });

  // Every move keeps the rest of the query string — ?focus=1 above all: a screen left in focus mode
  // must stay in it through a building and the way back up.
  const go = useCallback(
    (id: string | null, replace = false) => navigate(`/office${id ? `/${encodeURIComponent(id)}` : ''}${withoutRoom(params)}`, { replace }),
    [navigate, params],
  );
  const count = city.buildings.length;

  /**
   * The ladder: building -> city -> out of focus mode. Going up replaces, or Back would walk
   * straight back into the building that was just left. With a single project the city rung is
   * skipped: /office would auto-drill straight back into it. `camera` is set only by the scene's
   * own zoom-out gesture: it never takes the last rung — leaving focus mode is a deliberate act (Esc,
   * the "sair do foco" button), not something a zoom gesture should do by itself.
   */
  const up = (opts: { camera?: boolean } = {}) => {
    if (projectId && count > 1) go(null, true);
    else if (!opts.camera && focus) setFocus(false);
  };

  // `navigate` and `useSearchParams` change identity on every move, and so does everything built on
  // them. The scene and the key listener call through this ref, re-synced after every render, which
  // is what lets the scene-mount effect below depend on the host element ALONE.
  const actions = {
    onPickDesk: (tabId: string, pid: string) => window.open(`/projects/${pid}?tab=${tabId}`, '_blank', 'noopener'),
    onPickBuilding: (id: string) => go(id),
    onPickSign: (id: string) => navigate(`/projects/${id}`),
    onGoUp: () => up({ camera: true }),
    onEscape: () => up(),
    toggleFocus: () => setFocus(!focus),
  };
  const handlers = useRef(actions);
  useEffect(() => {
    handlers.current = actions;
  });

  // a tab the monitor knows and the city lacks (opened since the last read): read the city again,
  // fresh, once per newly-missing id that really started a read — a re-read that bounced off one
  // in flight must not be marked "asked", or that tab is stuck until the next minute's read
  const notified = useRef(new Set<string>());
  useEffect(() => {
    const projectOf = (tabId: string) => items.find((i) => i.tab.id === tabId)?.project.id;
    const missing = missingTabIds(office, items.map((i) => i.tab.id), projectOf);
    if (missing.length === 0) return;
    if (missing.some((id) => !notified.current.has(id)) && reload()) for (const id of missing) notified.current.add(id);
  }, [items, office, reload]);

  // Auto-drill: what is not a choice is not asked — /office with a single project IS that building.
  // Only from the city rest, and with one project the ladder never goes back there.
  useEffect(() => {
    if (!projectId && office?.projects.length === 1) go(office.projects[0].project.id, true);
  }, [projectId, office, go]);

  useEffect(() => {
    if (!host) return;
    setFailed(false);
    const scene = new OfficeScene({
      onPickDesk: (tabId, pid) => handlers.current.onPickDesk(tabId, pid),
      onPickBuilding: (id) => handlers.current.onPickBuilding(id),
      onPickSign: (id) => handlers.current.onPickSign(id),
      onGoUp: () => handlers.current.onGoUp(),
    });
    sceneRef.current = scene;
    // setModel/focus are safe to call before mount() resolves — the scene stores them and replays
    // them once it can draw, so a scene created here is never left blank
    scene.setModel(cityRef.current);
    scene.focus(targetRef.current, true);
    // Pixi falls back from WebGL to canvas by itself; this only fires when neither could start
    scene.mount(host).catch(() => setFailed(true));
    return () => {
      scene.destroy();
      sceneRef.current = null;
    };
  }, [host]);

  // Esc walks up the ladder, F toggles focus mode. Subscribed once: what the keys do is read
  // through the same ref the scene's handlers use, so no move re-subscribes this listener.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return; // a dialog already handled it — don't also kick out of the building
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)) return;
      if (e.key === 'Escape') handlers.current.onEscape();
      else if ((e.key === 'f' || e.key === 'F') && !e.metaKey && !e.ctrlKey && !e.altKey) handlers.current.toggleFocus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!allowed) return <Navigate to="/" replace />;
  if (!office) return <Message>{readFailed ? 'Não foi possível carregar o escritório. Tentando de novo…' : 'Carregando…'}</Message>;
  if (office.projects.length === 0) {
    return (
      <Message>
        Nenhum projeto ainda. <Link className="text-accent hover:underline" to="/">Crie o primeiro</Link> para ver o escritório.
      </Message>
    );
  }
  // an unknown project — a /office/:machineId bookmark of the office by machine, too — is the city
  if (projectId && !office.projects.some((b) => b.project.id === projectId)) return <Navigate to={`/office${withoutRoom(params)}`} replace />;

  // the building the camera is standing at, as the city drew it: null in the city
  const here = target.kind === 'building' ? (city.buildings.find((b) => b.id === target.projectId) ?? null) : null;
  const trail: Array<{ label: string; go?: () => void }> = [];
  if (count > 1) trail.push({ label: 'Cidade', go: () => go(null, true) });
  if (here) trail.push({ label: here.name });
  const shareResult = shareResultFor(target, user?.id, user?.nickname ?? null, publicCityUrl, cityLink.link?.short_url ?? null, office.projects.map((b) => b.project));

  return (
    <div className="flex h-full flex-col">
      {!focus && (
        <PageHeader
          title="Escritório"
          extra={<Trail parts={trail} />}
          actions={
            <span className="flex items-center gap-3 text-xs text-fg-muted">
              <StatusNotices building={here} connected={connected} />
              <ShareButton result={shareResult} />
              <button className="rounded px-2 py-1 hover:bg-bg-3 hover:text-fg" onClick={() => setFocus(true)} title="Modo foco (F)">
                modo foco
              </button>
            </span>
          }
        />
      )}
      <div className="relative min-h-0 flex-1">
        {/* an unlit building is dimmed by the scene itself, so the canvas is never dimmed on top of it */}
        <div ref={setHost} className="absolute inset-0 overflow-hidden" />
        {focus && (
          <div className="absolute right-3 top-3 flex items-center gap-3 rounded bg-bg-2/80 px-2 py-1 text-xs text-fg-muted">
            <StatusNotices building={here} connected={connected} />
            <ShareButton result={shareResult} />
            <button className="rounded hover:text-fg" onClick={() => setFocus(false)}>
              sair do foco (Esc)
            </button>
          </div>
        )}
        {failed && <Overlay>Seu navegador não conseguiu desenhar o escritório.</Overlay>}
      </div>
    </div>
  );
}

/**
 * Where the camera stands, as the ladder Esc walks: Cidade › projeto. Every part but the last one
 * goes to that rest, replacing rather than pushing (going up must not pile history up). With a
 * single project there is no city to go back to, so that part is not rendered at all.
 */
function Trail({ parts }: { parts: Array<{ label: string; go?: () => void }> }) {
  return (
    <nav aria-label="Trilha" className="flex items-center gap-1">
      {parts.map((part, i) => (
        <span key={`${i}:${part.label}`} className="flex items-center gap-1">
          {i > 0 && (
            <span aria-hidden="true" className="text-fg-muted/60">
              ›
            </span>
          )}
          {i === parts.length - 1 ? (
            <span className="text-fg">{part.label}</span>
          ) : (
            <button className="rounded px-1 py-0.5 hover:bg-bg-3 hover:text-fg" onClick={part.go}>
              {part.label}
            </button>
          )}
        </span>
      ))}
    </nav>
  );
}

/**
 * Why the scene may not be telling the truth right now. Rendered in the top bar and, in focus mode
 * (where there is no top bar), in the corner: a second monitor left open all day must never show a
 * frozen picture that looks live. A building's own trouble is only said at its rest — in the city
 * its sign carries the notice.
 */
const TMUX_SILENT = 'sem resposta do tmux: estado pode estar desatualizado';

function StatusNotices({ building, connected }: { building: BuildingModel | null; connected: boolean }) {
  return (
    <>
      {building?.notice === 'offline' && <span className="text-warn">máquina offline</span>}
      {building?.notice === 'silent' && (
        // compact: the header's actions must fit a narrow window; the whole sentence is on hover and for screen readers
        <span className="flex items-center gap-1 whitespace-nowrap text-warn" role="status" aria-label={TMUX_SILENT} title={TMUX_SILENT}>
          <TriangleAlert size={14} aria-hidden="true" />
          tmux sem resposta
        </span>
      )}
      {!connected && <span className="text-warn">reconectando…</span>}
    </>
  );
}

function Message({ children }: { children: React.ReactNode }) {
  return <div className="flex h-full items-center justify-center px-6 text-center text-sm text-fg-muted">{children}</div>;
}

function Overlay({ children }: { children: React.ReactNode }) {
  return <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-fg-muted">{children}</div>;
}

/**
 * `unpublished`: nothing in view has been made public (or the viewer has no nickname yet, which can
 * only be true before anything of theirs was ever published). `foreign`: something IS published
 * here, but it is a project somebody else owns (view-as/view-all only) — there is no link this
 * viewer's own nickname could build for it.
 */
type ShareResult = { kind: 'link'; url: string } | { kind: 'unpublished' } | { kind: 'foreign' };

/**
 * The public city a nickname points to is that nickname's OWNER's city: their own published
 * projects, one building each (city-by-project §2.4) — never the signed-in viewer's view. The two
 * only agree while someone looks at their own work; under the view-as/view-all admin scope the
 * office can carry other people's projects, and building the link from the viewer's own nickname
 * would then point at a city that does not contain them. So the check is on the PROJECT's owner.
 * Which machines the agents run on no longer matters: a published project is always on the street.
 */
function shareResultFor(
  target: FocusTarget,
  userId: string | undefined,
  nickname: string | null,
  publicCityUrl: string | null,
  /** the owner's short link (77a.it/…), used at the city depth only */
  shortUrl: string | null,
  projects: Array<Pick<Project, 'id' | 'owner_id' | 'is_public' | 'public_id'>>,
): ShareResult {
  const mine = (p: Pick<Project, 'owner_id'>) => !!userId && p.owner_id === userId;
  const base = cityLinkFor(publicCityUrl, nickname);
  if (target.kind === 'city') {
    if (base && projects.some((p) => p.is_public && mine(p))) return { kind: 'link', url: shortUrl ?? base };
    if (projects.some((p) => p.is_public && !mine(p))) return { kind: 'foreign' };
    return { kind: 'unpublished' };
  }
  const project = projects.find((p) => p.id === target.projectId);
  if (!project?.is_public) return { kind: 'unpublished' };
  if (!mine(project)) return { kind: 'foreign' };
  if (!base) return { kind: 'unpublished' };
  return { kind: 'link', url: `${base}/${encodeURIComponent(project.public_id)}` };
}

type ShareStatus = 'idle' | 'copied' | 'failed';

/**
 * Copies the current rest's public link. When there is nothing to copy, the button explains why
 * instead of pretending there is something to copy — nothing published yet, or something published
 * that belongs to a city this viewer's own nickname cannot address (view-as/view-all).
 */
function ShareButton({ result }: { result: ShareResult }) {
  const [status, setStatus] = useState<ShareStatus>('idle');

  useEffect(() => {
    if (status === 'idle') return;
    const id = setTimeout(() => setStatus('idle'), 2500);
    return () => clearTimeout(id);
  }, [status]);

  if (result.kind === 'unpublished') {
    return (
      <span className="rounded px-2 py-1 text-fg-dim" title="Publique um projeto para gerar o link público">
        nada publicado aqui ainda
      </span>
    );
  }
  if (result.kind === 'foreign') {
    return (
      <span className="rounded px-2 py-1 text-fg-dim" title="Só o dono de um projeto pode compartilhar o link dele">
        pertence a outra pessoa
      </span>
    );
  }

  const link = result.url;
  const copy = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('no clipboard API');
      await navigator.clipboard.writeText(link);
      setStatus('copied');
    } catch {
      setStatus('failed');
    }
  };

  return (
    <button className="rounded px-2 py-1 hover:bg-bg-3 hover:text-fg" onClick={() => void copy()} title={link}>
      {status === 'copied' ? 'link copiado' : status === 'failed' ? 'selecione e copie' : 'compartilhar'}
    </button>
  );
}
```

In `apps/web/src/App.tsx`, replace `<Route path="/office/:machineId" element={<OfficeRoute />} />` with `<Route path="/office/:projectId" element={<OfficeRoute />} />`.

- [ ] **Step 4: Run it to see it pass.** `WEBTEST src/pages/OfficePage.test.tsx src/App.test.tsx src/lib/focus.test.tsx` — Expected: PASS (0 failed).

- [ ] **Step 5: Commit.**

```bash
git add apps/web/src/pages/OfficePage.tsx apps/web/src/pages/OfficePage.test.tsx apps/web/src/App.tsx
git commit -m "Office: a building per project at /office/:projectId, shared by project

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task B5: The harness — synthetic buildings, and the scene seen drawing

**Files:**
- Create: `apps/web/src/office/harness-data.ts`
- Test: `apps/web/src/office/harness-data.test.ts` (new)
- Modify: `apps/web/src/office/harness.ts` (whole file)

**Interfaces:**
- Consumes: `OfficeCity`, `OfficeBuilding`, `OfficeMachine`, `OfficeTab` (Task B1); `buildCityModel` (Task B1); `OfficeScene` (Task B2).
- Produces: `harnessCity(o: HarnessOptions): OfficeCity`, `churned(city, projectId, on): OfficeCity`, `jiggled(city, at, random?): OfficeCity`, `HARNESS_STATES`, `CHURN_ID`; the harness page `office-harness.html` reads `?projects=` (default 6), `?desks=` (default 8), `?project=i` (open on building `p<i>`), `?churn=tabs`, `?offline=i` / `?silent=i` (machine `m<i>` of three), `?activity=`, `?verb=`, `?hover=<deskId>`, `?still=1`, `?grow=1`.

- [ ] **Step 1: Write the failing test.** Create `apps/web/src/office/harness-data.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { CHURN_ID, churned, HARNESS_STATES, harnessCity, jiggled } from './harness-data';
import { buildCityModel } from './model';

const opts = { projects: 6, desks: 8, offline: -1, silent: -1, activity: null, verb: null, at: '2026-09-24T10:00:00.000Z' };

describe('harnessCity', () => {
  it('makes ?projects= buildings: the second empty, the third with every desk the scene can draw', () => {
    const city = harnessCity(opts);
    expect(city.projects.map((b) => b.project.id)).toEqual(['p0', 'p1', 'p2', 'p3', 'p4', 'p5']);
    expect(city.projects[1].tabs).toEqual([]);
    expect(city.projects[2].tabs.length).toBeGreaterThanOrEqual(HARNESS_STATES.length);
    expect(new Set(city.projects[2].tabs.map((t) => t.kind))).toEqual(new Set(['terminal', 'simulator']));
  });

  it('spreads a building over several machines, every desk on a machine the city describes', () => {
    const city = harnessCity(opts);
    const ids = new Set(city.machines.map((m) => m.id));
    expect(city.projects.flatMap((b) => b.tabs).every((t) => ids.has(t.machine_id))).toBe(true);
    expect(new Set(city.projects[2].tabs.map((t) => t.machine_id)).size).toBeGreaterThan(1);
  });

  it('puts one machine offline and another silent with ?offline= and ?silent=', () => {
    const city = harnessCity({ ...opts, offline: 1, silent: 2 });
    expect(city.machines.map((m) => [m.id, m.online, m.reachable])).toEqual([['m0', true, true], ['m1', false, false], ['m2', true, false]]);
    expect(buildCityModel(city, () => undefined).buildings.some((b) => b.notice === 'silent')).toBe(true);
  });

  it('churns one desk in and out of one building, leaving the others alone', () => {
    const city = harnessCity(opts);
    const on = churned(city, 'p0', true);
    expect(on.projects[0].tabs.at(-1)?.id).toBe(CHURN_ID);
    expect(on.projects[2]).toBe(city.projects[2]);
    expect(churned(on, 'p0', false).projects[0].tabs.map((t) => t.id)).toEqual(city.projects[0].tabs.map((t) => t.id));
  });

  it('jiggles states without adding or losing desks', () => {
    const city = harnessCity(opts);
    const next = jiggled(city, 'x', () => 0);
    expect(next.projects.map((b) => b.tabs.length)).toEqual(city.projects.map((b) => b.tabs.length));
    expect(next.projects[0].tabs[0].state_at).toBe('x');
  });
});
```

- [ ] **Step 2: Run it to see it fail.** `WEBTEST src/office/harness-data.test.ts` — Expected: FAIL, `Failed to resolve import "./harness-data"`.

- [ ] **Step 3: Implement.** Create `apps/web/src/office/harness-data.ts`:

```ts
/** Synthetic office for the harness (office-harness.html): pure, so the harness's own knobs can be tested. */
import type { OfficeBuilding, OfficeCity, OfficeMachine, OfficeTab, TabActivity, TabState } from '../lib/types';

export const HARNESS_STATES: Array<TabState | null> = ['working', 'working', 'working', 'waiting_input', 'waiting_permission', 'idle', 'idle', 'error', null];
const ACTIVITIES: TabActivity[] = ['coding', 'reading', 'researching', 'planning', 'terminal', 'working'];
/** Three machines, so one building's desks sit on several of them; two carry a subtitle for the desk tag. */
const MACHINES = [
  { id: 'm0', name: 'jarvis', subtitle: 'MacBook do escritório' },
  { id: 'm1', name: 'friday', subtitle: null },
  { id: 'm2', name: 'um-servidor-com-nome-comprido', subtitle: 'rack do porão, segunda prateleira' },
];

export interface HarnessOptions {
  /** how many buildings (projects) */
  projects: number;
  /** the most desks a building gets */
  desks: number;
  /** index of the machine drawn offline, -1 for none */
  offline: number;
  /** index of the machine whose tmux did not answer, -1 for none */
  silent: number;
  /** `?activity=<category>` on every working desk, `mix` to cycle the six, null for none */
  activity: string | null;
  /** `?verb=<Word>` with every activity */
  verb: string | null;
  at: string;
}

function activityFor(o: HarnessOptions, i: number, state: TabState | null): TabActivity | null {
  if (state !== 'working' || !o.activity) return null;
  return o.activity === 'mix' ? ACTIVITIES[i % ACTIVITIES.length] : (o.activity as TabActivity);
}

/**
 * Project 1 is empty and project 2 has one desk per HARNESS_STATES entry — with the simulator and
 * the dead tab in there, that building shows every desk the scene can draw. Desks rotate over the
 * three machines, so every building of more than one desk spans several of them.
 */
export function harnessCity(o: HarnessOptions): OfficeCity {
  const projects = Array.from({ length: Math.max(1, o.projects) }, (_, r): OfficeBuilding => {
    const id = `p${r}`;
    const count = r === 1 ? 0 : r === 2 ? Math.max(HARNESS_STATES.length, o.desks) : 1 + ((r * 5) % Math.max(1, o.desks));
    const tabs = Array.from({ length: count }, (_, i): OfficeTab => {
      const state = HARNESS_STATES[(r + i) % HARNESS_STATES.length];
      // i = 1 carries a task with no subtasks: no bar anywhere, its title only on hover
      const progress = i % 3 === 0 ? { task_id: 'k', title: 'Tarefa com subtarefas', done: i % 4, total: 4 } : i === 1 ? { task_id: 'k0', title: 'Tarefa sem subtarefas', done: 0, total: 0 } : null;
      const activity = activityFor(o, i, state);
      return {
        id: `${id}-t${i}`,
        project_id: id,
        machine_id: MACHINES[(r + i) % MACHINES.length].id,
        name: i === 0 ? 'um nome de aba bem comprido mesmo 🚀' : `aba ${i + 1}`,
        kind: i % 8 === 7 ? 'simulator' : 'terminal',
        tmux_session: null,
        simulator_udid: null,
        position: i,
        state,
        state_text: null,
        state_tool: null,
        state_at: state ? o.at : null,
        state_seen_at: null,
        activity,
        activity_verb: o.verb && activity ? o.verb : null,
        created_at: o.at,
        alive: i % 9 !== 4,
        progress,
      };
    });
    return {
      project: {
        id,
        owner_id: 'u1',
        key: `P${r}`,
        next_task_number: 1,
        name: r === 0 ? 'projeto com um nome enorme para testar o corte' : `projeto-${r}`,
        status: r === 3 ? 'paused' : 'active',
        description: null,
        last_terminal_at: null,
        created_at: o.at,
        machines: [],
        is_public: false,
        public_id: `${id}-pub`,
      },
      public_id: `${id}-pub`,
      tabs,
      tasks: r % 2 ? { todo: 2, doing: 1, done: r } : null,
    };
  });
  const machines = MACHINES.map((m, i): OfficeMachine => ({ ...m, type: 'agent', online: i !== o.offline, reachable: i !== o.offline && i !== o.silent }));
  return { projects, machines };
}

/** The id of the desk `churned` adds and removes. */
export const CHURN_ID = 'churn';

/** `?churn=tabs`: the city with one extra desk in `projectId` (`on`) or without it — what a tab opened anywhere does. */
export function churned(city: OfficeCity, projectId: string, on: boolean): OfficeCity {
  return {
    ...city,
    projects: city.projects.map((b) => {
      if (b.project.id !== projectId) return b;
      const tabs = b.tabs.filter((t) => t.id !== CHURN_ID);
      return { ...b, tabs: on && tabs.length > 0 ? [...tabs, { ...tabs[0], id: CHURN_ID, name: 'aba recém-aberta', position: tabs.length }] : tabs };
    }),
  };
}

/** A random tenth of the desks change state: the harness's live mode. */
export function jiggled(city: OfficeCity, at: string, random: () => number = Math.random): OfficeCity {
  return {
    ...city,
    projects: city.projects.map((b) => ({ ...b, tabs: b.tabs.map((t) => (random() < 0.1 ? { ...t, state: HARNESS_STATES[Math.floor(random() * HARNESS_STATES.length)], state_at: at } : t)) })),
  };
}
```

Replace `apps/web/src/office/harness.ts` with:

```ts
/** Dev tool: the office city with synthetic data, no login and no server — for screenshots and frame timing. */
import { churned, harnessCity, jiggled } from './harness-data';
import { buildCityModel, type FocusTarget } from './model';
import { OfficeScene } from './scene/OfficeScene';

const q = new URLSearchParams(location.search);
/** `-1` when absent: `Number(null)` is 0, which would silently mean "the first one". */
const index = (name: string) => (q.get(name) === null ? -1 : Number(q.get(name)));
/** `?projects=`, `?desks=`, `?offline=i`, `?silent=i` (machine m<i>), `?activity=`, `?verb=` — see harness-data.ts */
let city = harnessCity({
  projects: Number(q.get('projects')) || 6,
  desks: Number(q.get('desks')) || 8,
  offline: index('offline'),
  silent: index('silent'),
  activity: q.get('activity'),
  verb: q.get('verb'),
  at: new Date().toISOString(),
});

const hud = document.getElementById('hud')!;
let target: FocusTarget = { kind: 'city' };
/** Every handler the scene fires, in order: what a click routed to is otherwise unscreenshotable. */
const log = (what: string) => (hud.dataset.picked = `${hud.dataset.picked ?? ''}${what};`);
const go = (t: FocusTarget) => {
  target = t;
  scene.focus(t);
};
const scene = new OfficeScene({
  onPickDesk: (id) => log(`desk:${id}`),
  onPickBuilding: (projectId) => {
    log(`building:${projectId}`);
    go({ kind: 'building', projectId });
  },
  onPickSign: (projectId) => log(`sign:${projectId}`),
  onGoUp: () => {
    log('up');
    go({ kind: 'city' });
  },
});
const draw = () => scene.setModel(buildCityModel(city, () => undefined));

// `?grow=1`: the host starts narrow and widens WITHOUT a window resize — what hiding the sidebar in focus mode does
const hostEl = document.getElementById('host')!;
if (q.get('grow')) {
  hostEl.style.width = '75%';
  setTimeout(() => (hostEl.style.width = '100%'), 800);
}
await scene.mount(hostEl);
draw();
// `?project=i` opens on that building
if (q.get('project')) {
  target = { kind: 'building', projectId: `p${Math.max(0, index('project'))}` };
  scene.focus(target, true);
}
// `?hover=<deskId>` (e.g. p2-t0) pins one desk as hovered: hover text cannot be screenshotted otherwise
if (q.get('hover')) scene.debugHover(q.get('hover'));

/**
 * `?churn=tabs`: one desk appears and disappears every second in a building OTHER than the focused
 * one — the rebuild a tab opened anywhere in the account causes. The camera framing this building
 * must not move because of it, which is what the two screenshots around it show.
 */
if (q.get('churn') === 'tabs') {
  const focused = target.kind === 'building' ? target.projectId : null;
  const other = city.projects.find((b) => b.project.id !== focused && b.tabs.length > 0)?.project.id;
  let extra = false;
  if (other)
    setInterval(() => {
      extra = !extra;
      city = churned(city, other, extra);
      draw();
      // how many rebuilds this run has caused, so a screenshot pair can say it really churned
      hud.dataset.churn = String(Number(hud.dataset.churn ?? 0) + 1);
    }, 1000);
}

if (!q.get('still')) {
  setInterval(() => {
    city = jiggled(city, new Date().toISOString());
    draw();
  }, 400);
}
setInterval(() => (hud.textContent = `${Math.round(scene.fps)} fps · ${scene.frameMs.toFixed(2)} ms/frame CPU · ${scene.rendererName}`), 500);
```

- [ ] **Step 4: Run the test, and the web typecheck up to here.** `WEBTEST src/office/harness-data.test.ts` — Expected: PASS (5 tests). `DOCKER 'npm run typecheck -w @termhub/web'` — Expected: still red, now only in `city/CityPage.tsx`, `city/share/compose.ts`, `city/share/sound.ts` (Task B6).

- [ ] **Step 5: See the scene draw.** Vite in a container on `127.0.0.1:5199`, the Playwright image, PNGs to `/tmp/pccp-shots/`:

```bash
docker run -d --rm --name pccp-vite -u "$(id -u):$(id -g)" -e HOME=/tmp -e VITE_HOST=0.0.0.0 -p 127.0.0.1:5199:5173 -v "$PWD:/w" -w /w node:20 npm run dev -w @termhub/web
mkdir -p /tmp/pccp-shots && cat > /tmp/pccp-shots/office.mjs <<'EOF'
import { chromium } from 'playwright';
const b = await chromium.launch({ args: ['--enable-unsafe-swiftshader'] });
const shots = [
  ['city', 'still=1&projects=6'],
  ['one', 'still=1&projects=1'],
  ['states', 'still=1&projects=6&offline=1&silent=2'],
  ['building', 'still=1&projects=6&project=2'],
  ['hover', 'still=1&projects=6&project=2&hover=p2-t0'],
  ['many', 'still=1&projects=14&desks=10'],
  ['grow', 'still=1&projects=6&grow=1'],
];
for (const [name, query] of shots) {
  const p = await b.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  p.on('pageerror', (e) => errors.push(String(e)));
  await p.goto(`http://127.0.0.1:5199/office-harness.html?${query}`);
  await p.waitForTimeout(3000);
  await p.screenshot({ path: `/s/${name}.png` });
  console.log(name, errors.length ? errors : 'no page errors', await p.textContent('#hud'));
  await p.close();
}
// the churn pair: the same framing 2.5 s apart while another building rebuilds every second
const p = await b.newPage({ viewport: { width: 1400, height: 900 } });
await p.goto('http://127.0.0.1:5199/office-harness.html?still=1&projects=6&project=2&churn=tabs');
await p.waitForTimeout(3000);
await p.screenshot({ path: '/s/churn-a.png' });
await p.waitForTimeout(2500);
await p.screenshot({ path: '/s/churn-b.png' });
console.log('churn', await p.getAttribute('#hud', 'data-churn'));
await b.close();
EOF
docker run --rm --network host --ipc=host -v /tmp/pccp-shots:/s -w /tmp mcr.microsoft.com/playwright:v1.63.0-noble sh -c 'npm i playwright@1.63.0 --no-audit --no-fund >/dev/null 2>&1 && cp /s/office.mjs . && node office.mjs'
docker stop pccp-vite
rm -rf .npm
```

Expected: `no page errors` seven times and `churn` printing a number ≥ 4. **Open every PNG with the Read tool and say, shot by shot, what you see:** (city) six blocks separated by streets, each with ONE sign at its front corner naming the project, no room signs, one floor per block; the empty `projeto-1` block dark with "sem agentes agora"; (one) a single block framed; (states) desks on `friday` (m1) faded, buildings touching `um-servidor…` (m2) saying "sem resposta", none of them saying "não foi possível carregar"; (building) `projeto-2` framed whole, every desk labelled with its name and a muted machine line under it (`jarvis · MacBook do escritório`, `friday`, `um-servidor-com-nome-comp…`), other blocks' signs still readable where visible; (hover) `p2-t0`'s full name, its machine line and its task title stacked without overlapping the bar; (many) no block overlaps another and signs do not pile up illegibly; (grow) the canvas fills the widened host and the city is centred; (churn-a / churn-b) identical framing of `projeto-2`. Fix what is wrong and re-shoot before committing — the label line offsets in `DeskOverlay.place`, `SUBTITLE_CAP`, `SIGN_LIFT` and `BLOCK_MARGIN` are the expected knobs.

- [ ] **Step 6: Commit.**

```bash
git add apps/web/src/office/harness-data.ts apps/web/src/office/harness-data.test.ts apps/web/src/office/harness.ts
git commit -m "Office: the harness draws buildings by project over several machines

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

(Add any knob fixed in Step 5 — `apps/web/src/office/scene/Overlay.ts`, `apps/web/src/office/model.ts` — to the same commit.)

---
### Task B6: The public city page by project

**Files:**
- Modify: `apps/web/src/city/url.ts` (whole file), `apps/web/src/city/CityPage.tsx` (whole file), `apps/web/src/city/share/compose.ts:94-98` (`countsOf`), `apps/web/src/city/share/sound.ts:11-23` (`read`)
- Test: `apps/web/src/city/url.test.ts` (whole file), `apps/web/src/city/CityPage.test.tsx`, `apps/web/src/city/share/compose.test.ts:83-84`, `apps/web/src/city/share/sound.test.ts` (whole file), `apps/web/src/city/share/SharePanel.test.tsx:5-6,27-29`, `apps/web/src/city/share/record.story.test.ts:30`

**Interfaces:**
- Consumes: `toBuildingEntries`, `CityFrame`, `fetchCity`, `openCitySocket` (Task B1, `city/api.ts`); `buildCityModel`, `resolveFocus`, `sameFocus`, `CityModel`, `FocusTarget` (Task B1); `OfficeScene` handlers `{ onPickDesk, onPickBuilding, onPickSign, onGoUp }` (Task B2).
- Produces: `interface Rest { building: string | null }`; `restFromUrl(pathname: string): Rest` (any query string — an old `?room=` — is ignored); `cityPath(nickname: string, rest: Rest): string` (`/city/@nick[/building]`); `countsOf(model: CityModel)` and `soundEvents(prev, next)` walking `model.buildings → desks` (a raised hand is keyed `${building.id}:${desk.id}`). The page: rests `/city/@nick` and `/city/@nick/<projectPublicId>`; a building id that matches nothing (an old machine id) falls back to the city with no trail; trail `Cidade › <projeto>`; Esc and the zoom-out gesture: building → city; a building's sign and ground both lead into it; "Copiar link": the short link at the city, the long URL at a building.

- [ ] **Step 1: Write the failing tests.** Replace `apps/web/src/city/url.test.ts` with:

```ts
import { describe, expect, it } from 'vitest';
import { cityPath, nicknameFromPath, restFromUrl } from './url';

describe('the public city URL', () => {
  it('reads the two depths', () => {
    expect(nicknameFromPath('/city/@pedro')).toBe('pedro');
    expect(restFromUrl('/city/@pedro')).toEqual({ building: null });
    expect(restFromUrl('/city/@pedro/b1')).toEqual({ building: 'b1' });
  });

  it('round-trips an address it wrote itself', () => {
    const path = cityPath('pedro', { building: 'b1' });
    expect(path).toBe('/city/@pedro/b1');
    expect(nicknameFromPath(path)).toBe('pedro');
    expect(restFromUrl(path)).toEqual({ building: 'b1' });
    expect(cityPath('pedro', { building: null })).toBe('/city/@pedro');
  });

  it('escapes what it writes, and reads it back', () => {
    const path = cityPath('pedro', { building: 'a/b' });
    expect(path).toBe('/city/@pedro/a%2Fb');
    expect(restFromUrl(path)).toEqual({ building: 'a/b' });
  });

  it('never throws on a malformed escape, so the page can say the city is not there', () => {
    expect(nicknameFromPath('/city/@100%')).toBe('100%');
    expect(restFromUrl('/city/@pedro/%E0%A4%A')).toEqual({ building: '%E0%A4%A' });
  });

  it('answers empty for a path that carries no nickname', () => {
    expect(nicknameFromPath('/city/')).toBe('');
    expect(nicknameFromPath('/')).toBe('');
  });
});
```

Replace `apps/web/src/city/share/sound.test.ts` with:

```ts
import { describe, expect, it } from 'vitest';
import type { CityModel, DeskModel } from '../../office/model';
import { soundEvents } from './sound';

const desk = (id: string, pose: DeskModel['pose'], marker: DeskModel['marker'] = null) => ({ id, pose, marker }) as DeskModel;
const city = (...buildings: Array<[string, DeskModel[]]>): CityModel => ({ needsYou: 0, buildings: buildings.map(([id, desks]) => ({ id, desks })) }) as unknown as CityModel;

describe('soundEvents', () => {
  it('starts the clicks with the robots typing when the clip starts, and no dings', () => {
    expect(soundEvents(null, city(['b1', [desk('a', 'type'), desk('b', 'type'), desk('c', 'raise', 'input')]]))).toEqual([{ kind: 'typing', typists: 2 }]);
    expect(soundEvents(null, city(['b1', [desk('a', 'sleep')]]))).toEqual([]);
  });

  it('follows the number of typing robots', () => {
    const before = city(['b1', [desk('a', 'type'), desk('b', 'sit')]]);
    const after = city(['b1', [desk('a', 'type'), desk('b', 'type')]]);
    expect(soundEvents(before, after)).toEqual([{ kind: 'typing', typists: 2 }]);
    expect(soundEvents(after, before)).toEqual([{ kind: 'typing', typists: 1 }]);
  });

  it('dings once per newly raised hand, input or permission', () => {
    const before = city(['b1', [desk('a', 'type'), desk('b', 'type')]]);
    const after = city(['b1', [desk('a', 'raise', 'input'), desk('b', 'raise', 'permission')]]);
    expect(soundEvents(before, after)).toEqual([
      { kind: 'typing', typists: 0 },
      { kind: 'ding', desk: 'b1:a' },
      { kind: 'ding', desk: 'b1:b' },
    ]);
    // a hand that stays up does not ding again, nor does an error marker
    expect(soundEvents(after, after)).toEqual([]);
    expect(soundEvents(before, city(['b1', [desk('a', 'shake', 'error'), desk('b', 'type')]]))).toEqual([{ kind: 'typing', typists: 1 }]);
  });

  it('tells two buildings’ desks with the same id apart', () => {
    const before = city(['b1', [desk('a', 'raise', 'input')]], ['b2', [desk('a', 'sit')]]);
    const after = city(['b1', [desk('a', 'raise', 'input')]], ['b2', [desk('a', 'raise', 'input')]]);
    expect(soundEvents(before, after)).toEqual([{ kind: 'ding', desk: 'b2:a' }]);
  });

  it('plays nothing when nothing changed', () => {
    const same = city(['b1', [desk('a', 'type'), desk('b', 'raise', 'input')]]);
    expect(soundEvents(same, city(['b1', [desk('a', 'type'), desk('b', 'raise', 'input')]]))).toEqual([]);
  });
});
```

In `apps/web/src/city/share/compose.test.ts`, line 84:

```ts
  const model = { needsYou: 2, buildings: [{ id: 'b1', desks: [desk('a', 'type'), desk('b', 'type'), desk('c', 'raise'), desk('d', 'sleep')] }] } as unknown as CityModel;
```

In `apps/web/src/city/share/SharePanel.test.tsx`: line 6 `import { toBuildingEntries } from '../api';`; line 27 `buildings: [{ id: 'b1', name: 'Engage Easy', robots: [{ id: 'x1', name: 'aba 1', kind: 'terminal', state: 'working', state_at: '2026-09-23T10:00:00.000Z', activity: 'coding', activity_verb: null, alive: true, progress: null }] }],`; line 29 `const MODEL = buildCityModel(toBuildingEntries(CITY), () => undefined);`.

In `apps/web/src/city/share/record.story.test.ts`, line 30: `const model = () => ({ buildings: [], needsYou: 0 }) as unknown as CityModel;`.

In `apps/web/src/city/CityPage.test.tsx`:

  1. In `FakeOfficeScene`, the `handlers` type becomes `{ onPickDesk: (tabId: string, projectId: string) => void; onPickBuilding: (projectId: string) => void; onPickSign: (projectId: string) => void; onGoUp: () => void };`, and in the `socket` doc comment replace `what it does when the last published room is taken off the street` with `what it does when something it showed leaves the street`.
  2. Replace `CITY` and `desks` with:

```ts
const CITY: PublicCity = { nickname: 'pedro', owner_name: 'Pedro', short_url: null, buildings: [{ id: 'b1', name: 'Engage Easy', robots: [{ id: 'x1', name: 'aba 1', kind: 'terminal', state: 'working', state_at: AT, activity: 'coding', activity_verb: 'Moonwalking', alive: true, progress: null }] }] };
```

```ts
/** what the page last handed the scene, as the office's own CityModel */
const desks = (desk: unknown) => ({ buildings: [expect.objectContaining({ desks: [expect.objectContaining(desk as object)] })] });
```

  3. In `'applies a live robot frame without refetching the snapshot'`, the frame becomes `{ type: 'robot', building: 'b1', robot: { ...CITY.buildings[0].robots[0], activity: 'reading', state_at: LATER } }`.
  4. In `'removes a robot when the channel says its tab is gone'`, the frame becomes `{ type: 'robot_gone', building: 'b1', robot: 'x1' }` and the awaited model `expect.objectContaining({ buildings: [expect.objectContaining({ desks: [] })] })`.
  5. In `'goes to the not-found state, without a reload, when the city is unpublished under the visitor'`, the comment becomes `// the server hangs the socket up when something it showed leaves the street`.
  6. Add to `describe('CityPage', …)`:

```ts
  // city-by-project §4: the street's model has no machine, so no desk carries a machine line
  it('hands the scene desks with no machine', async () => {
    fetchMock.mockResolvedValueOnce(json(CITY));
    render(<CityPage nickname="pedro" />);
    await screen.findByText(/Cidade de Pedro/);
    expect(scene().setModel).toHaveBeenLastCalledWith(expect.objectContaining(desks({ machine: null })));
  });
```

  7. Add a new `describe` after `describe('CityPage', …)`:

```ts
describe('CityPage rests', () => {
  beforeEach(() => history.replaceState(null, '', '/city/@pedro'));

  it('walks into a building from its ground or its sign, shows the trail, and Esc walks back out', async () => {
    fetchMock.mockResolvedValueOnce(json(CITY));
    render(<CityPage nickname="pedro" />);
    await screen.findByText(/Cidade de Pedro/);
    act(() => scene().handlers.onPickBuilding('b1'));
    expect(location.pathname).toBe('/city/@pedro/b1');
    expect(screen.getByLabelText('Trilha').textContent).toBe('Cidade›Engage Easy');
    expect(scene().focus).toHaveBeenLastCalledWith({ kind: 'building', projectId: 'b1' });
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(location.pathname).toBe('/city/@pedro');
    expect(screen.getByLabelText('Trilha').textContent).toBe('');
    act(() => scene().handlers.onPickSign('b1'));
    expect(location.pathname).toBe('/city/@pedro/b1');
  });

  // city-by-project §2.5/§7: links shared under the old scheme — a machine's id, a ?room= — open the city
  it('opens an old link as the city, with no trail, and copies the city link from it', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    history.replaceState(null, '', '/city/@pedro/old-machine-id?room=old-room-id');
    fetchMock.mockResolvedValueOnce(json({ ...CITY, short_url: 'https://77a.it/pedro' }));
    render(<CityPage nickname="pedro" />);
    await screen.findByText(/Cidade de Pedro/);
    expect(screen.getByLabelText('Trilha').textContent).toBe('');
    expect(scene().focus.mock.calls.at(-1)?.[0]).toEqual({ kind: 'city' });
    fireEvent.click(screen.getByRole('button', { name: 'Compartilhar' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copiar link' }));
    });
    expect(writeText).toHaveBeenCalledWith('https://77a.it/pedro');
  });
});
```

- [ ] **Step 2: Run them to see them fail.** `WEBTEST src/city/url.test.ts src/city/CityPage.test.tsx src/city/api.test.ts src/city/share` — Expected: FAIL in `url.test.ts` (`restFromUrl` returns `room`), `CityPage.test.tsx` (the page still calls `toMachineEntries`, which no longer exists), `sound.test.ts` and `compose.test.ts` (they walk `machines`), `SharePanel.test.tsx` and `record.story.test.ts` (same); `api.test.ts` passes. (`bundle.test.ts` is left to Step 6: under `CI=1` its built-output test fails, rather than skips, until `dist-city` is built.)

- [ ] **Step 3: Implement the URL.** Replace `apps/web/src/city/url.ts` with:

```ts
/**
 * The whole deep-link contract of the public city, in one place and testable on its own:
 * `/city/@nick` and `/city/@nick/<building>` — the city and one building (a published project). A
 * `?room=` from the links of the city by machine is not read, and a building id that matches nothing
 * (one of those old machine ids) falls back to the city on the page. main.tsx reads the nickname from
 * here before the page mounts; the page reads the rest of it on every move and on Back, and writes
 * it back through `cityPath`.
 */

/** Where the visitor stands, below the nickname. */
export interface Rest {
  building: string | null;
}

/**
 * One path segment as it was written. A malformed escape (a bare `%`) makes `decodeURIComponent`
 * throw, which at module level rendered a blank page: hand the raw segment on instead and let the
 * server answer it the same 404 as any other nickname that does not exist.
 */
function segment(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** The nickname of `/city/@nick[/…]`, without the `@` it is written with; '' when the path carries none. */
export function nicknameFromPath(pathname: string): string {
  const parts = pathname.split('/').filter(Boolean);
  return (segment(parts[1]) ?? '').replace(/^@/, '');
}

/** The building of `/city/@nick/<building>`; the query string is not part of the rest. */
export function restFromUrl(pathname: string): Rest {
  const parts = pathname.split('/').filter(Boolean);
  return { building: segment(parts[2]) };
}

/** The address of a rest, as the page pushes it and as a person shares it. */
export function cityPath(nickname: string, rest: Rest): string {
  return `/city/@${encodeURIComponent(nickname)}${rest.building ? `/${encodeURIComponent(rest.building)}` : ''}`;
}
```

- [ ] **Step 4: Implement the page and the share walks.** Replace `apps/web/src/city/CityPage.tsx` with:

```tsx
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { buildCityModel, resolveFocus, sameFocus, type CityModel, type FocusTarget } from '../office/model';
import { OfficeScene } from '../office/scene/OfficeScene';
import type { PublicCity } from '../lib/types';
import { fetchCity, openCitySocket, toBuildingEntries, type CityFrame } from './api';
import { BetaCard, LANDING_URL, useBetaCard } from './BetaCard';
import { CopyLinkButton } from './share/CopyLinkButton';
import { SharePanel } from './share/SharePanel';
import { cityPath, restFromUrl, type Rest } from './url';

/** A snapshot that could not be read is tried again, backing off the same way the socket does. */
const RETRY_MIN_MS = 2_000;
const RETRY_MAX_MS = 30_000;

const readRest = (): Rest => restFromUrl(location.pathname);

/**
 * One socket frame, applied where it lands. The building id in it is the snapshot's own, so a
 * change never costs a second read of the city; a frame for a building this page has never seen is
 * dropped, since there is nowhere to draw it.
 */
function applyRobot(city: PublicCity | null, frame: CityFrame): PublicCity | null {
  if (!city) return city;
  let landed = false;
  const buildings = city.buildings.map((building) => {
    if (building.id !== frame.building) return building;
    landed = true;
    // a tab closed or deleted while somebody watches leaves its desk at once
    if (frame.type === 'robot_gone') return { ...building, robots: building.robots.filter((r) => r.id !== frame.robot) };
    const i = building.robots.findIndex((r) => r.id === frame.robot.id);
    const robots = building.robots.slice();
    // a tab opened while somebody is watching joins the building instead of waiting for a reload
    if (i === -1) robots.push(frame.robot);
    else robots[i] = frame.robot;
    return { ...building, robots };
  });
  return landed ? { ...city, buildings } : city;
}

/**
 * The public city: somebody else's account as a city, live, to a visitor with no account at all.
 * Two rests, like the office — the city and one building (a published project) — and nothing else:
 * no sidebar, no actions, no terminal, no machine. The snapshot is read on arrival and every change
 * after it comes down the socket, so a visit costs one read while the channel holds; the snapshot is
 * read again only when that channel is hung up, which is how a building (or a machine's robots)
 * taken off the street disappears without a reload.
 */
export function CityPage({ nickname }: { nickname: string }) {
  const [city, setCity] = useState<PublicCity | null>(null);
  /** the server said there is no such city: a 404 is final, and nothing here knocks again after it */
  const [missing, setMissing] = useState(false);
  const [rest, setRest] = useState<Rest>(readRest);
  // a callback ref, not useRef: the host <div> is absent while the snapshot is on its way, and a
  // ref alone would never re-trigger the mount effect once it finally renders
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [betaOpen, setBetaOpen] = useBetaCard();
  const [shareOpen, setShareOpen] = useState(false);
  const shareButton = useRef<HTMLButtonElement>(null);
  /** the panel closed (its ×, Esc): the focus goes back to the button that opened it */
  const closeShare = useCallback(() => {
    setShareOpen(false);
    shareButton.current?.focus();
  }, []);
  const sceneRef = useRef<OfficeScene | null>(null);

  const gone = useRef(false);
  const retry = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryIn = useRef(RETRY_MIN_MS);

  /**
   * One read of the snapshot: on mount, and again every time the socket is hung up — that is the
   * only way to tell a city taken off the street from a channel that merely dropped. A read that
   * could not be made at all keeps whatever is drawn and comes back, because "we could not read it"
   * is not "it is not there".
   */
  const load = useCallback(async () => {
    if (gone.current) return;
    try {
      const answer = await fetchCity(nickname);
      if (gone.current) return;
      retryIn.current = RETRY_MIN_MS;
      if (answer) setCity(answer);
      else setMissing(true);
    } catch {
      if (gone.current) return;
      retry.current = setTimeout(() => void load(), retryIn.current);
      retryIn.current = Math.min(retryIn.current * 2, RETRY_MAX_MS);
    }
  }, [nickname]);

  useEffect(() => {
    gone.current = false;
    void load();
    return () => {
      gone.current = true;
      if (retry.current) clearTimeout(retry.current);
    };
  }, [load]);

  useEffect(() => {
    // a city that is not there has no channel to watch, and the upgrade would be refused the same
    // 404 over and over: once the snapshot has said so, this page stops knocking for good
    if (missing) return;
    return openCitySocket(nickname, {
      onRobot: (frame) => setCity((prev) => applyRobot(prev, frame)),
      onClosed: () => void load(),
    });
  }, [nickname, missing, load]);

  useEffect(() => {
    const onPop = () => setRest(readRest());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const entries = useMemo(() => (city ? toBuildingEntries(city) : { projects: [], machines: [] }), [city]);
  // no monitor on the street: the socket already wrote every change into `city` above
  const model = useMemo(() => buildCityModel(entries, () => undefined), [entries]);

  // mirrors `model` for the scene-mount effect below: a scene created there must be seeded with
  // whatever is already known, not sit blank waiting for this effect to fire again
  const modelRef = useRef<CityModel>(model);
  useEffect(() => {
    modelRef.current = model;
    sceneRef.current?.setModel(model);
  }, [model]);

  // an unknown building — an old machine id, say — falls back to the city on its own (office/model.ts)
  const target = resolveFocus(model, rest.building ?? undefined);
  // the target is rebuilt on every render, so the scene is only told when it changed BY VALUE:
  // re-framing an equal target would undo a camera the visitor moved by hand
  const targetRef = useRef<FocusTarget>(target);
  useEffect(() => {
    if (sameFocus(target, targetRef.current)) return;
    targetRef.current = target;
    sceneRef.current?.focus(target);
  });

  const go = useCallback(
    (building: string | null, replace = false) => {
      history[replace ? 'replaceState' : 'pushState'](null, '', cityPath(nickname, { building }));
      setRest({ building });
    },
    [nickname],
  );

  /** The ladder Esc and the zoom-out gesture walk: building -> city. Going up replaces, or Back would walk straight back in. */
  const up = () => {
    if (target.kind === 'building') go(null, true);
  };

  // the scene and the key listener call through this ref, re-synced after every render, which is
  // what lets the mount effect below depend on the host element ALONE
  const actions = {
    onPickBuilding: (building: string) => go(building),
    onGoUp: () => up(),
  };
  const handlers = useRef(actions);
  useEffect(() => {
    handlers.current = actions;
  });

  useEffect(() => {
    if (!host) return;
    setFailed(false);
    const scene = new OfficeScene({
      // a desk leads somewhere only for the person who owns it: on the street it is scenery, and
      // this bundle knows no route that could open one
      onPickDesk: () => {},
      onPickBuilding: (building) => handlers.current.onPickBuilding(building),
      // the sign names the building, so it leads into it, like its ground
      onPickSign: (building) => handlers.current.onPickBuilding(building),
      onGoUp: () => handlers.current.onGoUp(),
    });
    sceneRef.current = scene;
    // setModel/focus are safe to call before mount() resolves — the scene replays them once it can draw
    scene.setModel(modelRef.current);
    scene.focus(targetRef.current, true);
    // Pixi falls back from WebGL to canvas by itself; this only fires when neither could start
    scene.mount(host).catch(() => setFailed(true));
    return () => {
      scene.destroy();
      sceneRef.current = null;
    };
  }, [host]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Esc in the beta form is the person editing a field, not asking the camera to step back
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (e.key === 'Escape') handlers.current.onGoUp();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (missing) {
    return (
      // nothing else to show here, so the card is the page: open, and not something to put away
      <div className="flex min-h-full flex-col items-center justify-center gap-4 px-4 py-8 text-center">
        <p className="text-sm text-fg-muted">Cidade não encontrada.</p>
        <div className="w-full max-w-sm">
          <BetaCard ownerName={null} />
        </div>
      </div>
    );
  }

  // the city's own address: the media footers print it when there is no short link
  const cityUrl = `${location.origin}${cityPath(nickname, { building: null })}`;
  // "Copiar link": only the city has a short link; a building keeps its long address
  const restUrl = target.kind === 'city' ? null : `${location.origin}${cityPath(nickname, { building: target.projectId })}`;
  const copyUrl = restUrl ?? city?.short_url ?? cityUrl;
  // media are made from the scene: nothing to share before it has a city to draw
  const canShare = !!city && model.buildings.length > 0;

  // only a building that exists gets a trail: an old link that fell back to the city shows none
  const here = target.kind === 'building' ? (model.buildings.find((b) => b.id === target.projectId) ?? null) : null;
  const trail: Array<{ label: string; go?: () => void }> = [];
  if (here) trail.push({ label: 'Cidade', go: () => go(null, true) }, { label: here.name });

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-3 border-b border-line bg-bg-2 px-3 py-2 text-xs text-fg-muted">
        <span className="text-sm font-semibold text-fg">Cidade de {city?.owner_name ?? '…'}</span>
        <Trail parts={trail} />
        <span className="ml-auto flex items-center gap-3">
          {failed ? (
            <CopyLinkButton url={copyUrl} className="rounded px-2 py-1 hover:bg-bg-3 hover:text-fg" />
          ) : (
            <button
              ref={shareButton}
              type="button"
              disabled={!canShare}
              aria-expanded={shareOpen}
              onClick={() => setShareOpen((open) => !open)}
              className="rounded px-2 py-1 hover:bg-bg-3 hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
            >
              Compartilhar
            </button>
          )}
          <a className="hidden hover:text-fg sm:inline" href={LANDING_URL}>
            O que é o termhub?
          </a>
          <button
            type="button"
            onClick={() => setBetaOpen(true)}
            aria-expanded={betaOpen}
            className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-sm font-semibold text-white shadow-md shadow-accent/30 ring-1 ring-accent/60 transition-colors hover:bg-accent-hover"
          >
            <span aria-hidden="true" className="h-1.5 w-1.5 animate-pulse rounded-full bg-white" />
            Participar do beta grátis
          </button>
        </span>
      </div>
      <div className="relative min-h-0 flex-1">
        <div ref={setHost} className="absolute inset-0 overflow-hidden" />
        {failed && <Overlay>Seu navegador não conseguiu desenhar a cidade.</Overlay>}
        {!failed && !city && <Overlay>Carregando a cidade…</Overlay>}
        {betaOpen && (
          // a bottom sheet on a phone, a card in the corner from `sm` up; only its own box takes the
          // pointer, so the rest of the scene stays as draggable and clickable as without it
          <div className="absolute inset-x-0 bottom-0 z-10 max-h-[75%] overflow-y-auto sm:bottom-4 sm:left-4 sm:right-auto sm:w-[22rem] sm:max-h-[calc(100%-2rem)]">
            <BetaCard ownerName={city?.owner_name ?? null} onCollapse={() => setBetaOpen(false)} className="rounded-t-xl border-t sm:rounded-lg sm:border" />
          </div>
        )}
        {shareOpen && !failed && canShare && city && sceneRef.current && (
          // full width under the bar on a phone, a card in the top-right corner from `sm` up
          <div className="absolute inset-x-0 top-0 z-20 max-h-full overflow-y-auto sm:left-auto sm:right-4 sm:top-4 sm:w-[22rem]">
            <SharePanel scene={sceneRef.current} city={city} model={model} cityUrl={cityUrl} copyUrl={copyUrl} onClose={closeShare} />
          </div>
        )}
      </div>
    </div>
  );
}

/** Where the camera stands, as the ladder Esc walks: Cidade › projeto. */
function Trail({ parts }: { parts: Array<{ label: string; go?: () => void }> }) {
  return (
    <nav aria-label="Trilha" className="flex items-center gap-1">
      {parts.map((part, i) => (
        <span key={`${i}:${part.label}`} className="flex items-center gap-1">
          {i > 0 && (
            <span aria-hidden="true" className="text-fg-muted/60">
              ›
            </span>
          )}
          {i === parts.length - 1 ? (
            <span className="text-fg">{part.label}</span>
          ) : (
            <button className="rounded px-1 py-0.5 hover:bg-bg-3 hover:text-fg" onClick={part.go}>
              {part.label}
            </button>
          )}
        </span>
      ))}
    </nav>
  );
}

function Overlay({ children }: { children: React.ReactNode }) {
  return <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-fg-muted">{children}</div>;
}
```

In `apps/web/src/city/share/compose.ts`, replace `countsOf` with:

```ts
/** What the page draws right now: robots drawn typing (every working robot), and raised hands. */
export function countsOf(model: CityModel): { working: number; waiting: number } {
  let working = 0;
  for (const building of model.buildings) for (const desk of building.desks) if (desk.pose === 'type') working += 1;
  return { working, waiting: model.needsYou };
}
```

In `apps/web/src/city/share/sound.ts`, replace `read` with:

```ts
function read(model: CityModel): { typists: number; raised: Set<string> } {
  let typists = 0;
  const raised = new Set<string>();
  for (const building of model.buildings) {
    for (const desk of building.desks) {
      if (desk.pose === 'type') typists += 1;
      // keyed by building too: two buildings may carry desks with the same id
      if (desk.marker === 'input' || desk.marker === 'permission') raised.add(`${building.id}:${desk.id}`);
    }
  }
  return { typists, raised };
}
```

- [ ] **Step 5: Run them to see them pass, and the web typecheck green again.** `WEBTEST src/city/url.test.ts src/city/CityPage.test.tsx src/city/api.test.ts src/city/share` — Expected: PASS (0 failed). `DOCKER 'npm run typecheck -w @termhub/web'` — Expected: exit 0.

- [ ] **Step 6: The bundle guard, built.** `WEBSUITE` — Expected: `build:city` succeeds and the whole web suite passes under `CI=1`, including `the public bundle > does not carry the private app` and `the public bundle source > imports nothing of the private app`.

- [ ] **Step 7: Commit.**

```bash
git add apps/web/src/city
git commit -m "Public city page: a building per project, old links open the city

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task B7: "Minha cidade" and the publish confirmation, by project

**Files:**
- Modify: `apps/web/src/components/MyCityView.tsx` (imports, header copy, the project rows, the empty-city warning)
- Modify: `apps/web/src/components/PublishControl.tsx` (doc comment, confirm panel)
- Test: `apps/web/src/components/MyCityView.test.tsx`, `apps/web/src/pages/ProjectPage.test.tsx:107-110,160`

**Interfaces:**
- Consumes: `useMonitor().openTabs: Tab[]` (every terminal tab on the scope's machines — `lib/monitor.tsx`; `MyCityView` renders inside `Layout`'s `MonitorProvider`); `useData()` → `{ projects, machines, hiddenLocal, loading }`; `Project.is_public`, `Project.status`.
- Produces: copy only. Each own project row: `publicado · N agentes agora` (`1 agente agora` for one) when published, `não publicado` otherwise, where N = the project's open terminals on machines the person owns (exactly the robots the street shows). The confirm panel: "Publicar deixa visível, para quem tiver o link, o nome do projeto e cada agente (aba) dele que roda nas suas máquinas, com o que cada um está fazendo, além do seu nome e apelido." and "Agentes em máquinas de outras pessoas não aparecem." The "Nenhum projeto publicado ainda" warning goes away as soon as one non-archived project is published, whatever machines it has.

- [ ] **Step 1: Write the failing tests.** In `apps/web/src/components/MyCityView.test.tsx`:

  1. After the `vi.mock('../lib/auth', …)` line add:

```ts
const { monitorState } = vi.hoisted(() => ({ monitorState: { current: { openTabs: [] as Array<{ id: string; project_id: string; machine_id: string }> } } }));
vi.mock('../lib/monitor', () => ({ useMonitor: () => monitorState.current }));
```

  2. In `machine(…)` delete the `public_id: \`pub-${id}\`,` line; in `beforeEach` add `monitorState.current = { openTabs: [] };`.
  3. In `describe('MyCityView link', …)` add:

```ts
  // city-by-project §2.4: a published project is always on the street, with or without machines
  it('stops warning once a project is published, even one with no machine linked', () => {
    dataState.current = { ...dataState.current, projects: [project({ is_public: true, machines: [] })] };
    renderView();
    expect(screen.queryByText(/nenhum projeto publicado ainda/i)).toBeNull();
  });
```

  4. Replace the test `'lists only the projects the user owns, with the machines where each one shows and a link to it'` with:

```ts
  it('lists only the projects the user owns, each saying whether it is published and how many of its agents are on the street now', () => {
    dataState.current = {
      ...dataState.current,
      machines: [machine('m1', 'jarvis'), machine('m2', 'servidor-alheio', 'u2')],
      projects: [
        project({ is_public: true, machines: [{ machine_id: 'm1', cwd: '/a', position: 0 }, { machine_id: 'm2', cwd: '/a', position: 1 }] }),
        project({ id: 'p3', key: 'PRIV', name: 'privado' }),
        project({ id: 'p2', key: 'OUTRO', name: 'projeto-de-outro', owner_id: 'u2' }),
      ],
    };
    monitorState.current = {
      openTabs: [
        { id: 't1', project_id: 'p1', machine_id: 'm1' },
        { id: 't2', project_id: 'p1', machine_id: 'm1' },
        // on somebody else's machine: never on the street, so never counted
        { id: 't3', project_id: 'p1', machine_id: 'm2' },
      ],
    };
    renderView();
    const [published, priv] = screen.getAllByRole('listitem');
    expect(within(published).getByText('meu-projeto')).toBeTruthy();
    expect(within(published).getByText('publicado · 2 agentes agora')).toBeTruthy();
    expect(within(priv).getByText('não publicado')).toBeTruthy();
    // the machines are no longer part of what a city shows
    expect(within(published).queryByText(/jarvis|servidor-alheio|Aparece em/)).toBeNull();
    expect(within(published).getByRole('link', { name: /abrir projeto meu-projeto/i }).getAttribute('href')).toBe('/projects/p1');
    expect(screen.queryByText('projeto-de-outro')).toBeNull();
  });

  it('says one agent in the singular, and none for a published project with nobody in it', () => {
    dataState.current = { ...dataState.current, projects: [project({ is_public: true }), project({ id: 'p4', key: 'VAZIO', name: 'vazio', is_public: true })] };
    monitorState.current = { openTabs: [{ id: 't1', project_id: 'p1', machine_id: 'm1' }] };
    renderView();
    expect(screen.getByText('publicado · 1 agente agora')).toBeTruthy();
    expect(screen.getByText('publicado · 0 agentes agora')).toBeTruthy();
  });
```

  5. In `'publishes from the list through the same path as the project page'`, replace the panel assertion with:

```ts
    expect(screen.getByText(/o nome do projeto e cada agente \(aba\) dele que roda nas suas máquinas/i)).toBeTruthy();
    expect(screen.getByText(/agentes em máquinas de outras pessoas não aparecem/i)).toBeTruthy();
```

In `apps/web/src/pages/ProjectPage.test.tsx`, in `'says what publishing makes readable before it flips'` replace the three `expect(screen.getByText(…))` lines (and their two comments) with:

```ts
    expect(screen.getByText(/o nome do projeto e cada agente \(aba\) dele que roda nas suas máquinas/i)).toBeTruthy();
    // city-by-project §5: an agent on somebody else's machine never shows, and the panel says so
    expect(screen.getByText(/agentes em máquinas de outras pessoas não aparecem/i)).toBeTruthy();
    // the owner's display name and nickname become public too
    expect(screen.getByText(/além do seu nome e apelido/i)).toBeTruthy();
```

and in `'unpublishes immediately, without the confirmation panel'` replace the last `queryByText` regex with `/o nome do projeto e cada agente \(aba\) dele que roda nas suas máquinas/i`.

- [ ] **Step 2: Run them to see them fail.** `WEBTEST src/components/MyCityView.test.tsx src/pages/ProjectPage.test.tsx` — Expected: FAIL (the rows still say "Aparece em: jarvis", the panel has the old copy, the warning still shows for a published project with no machine).

- [ ] **Step 3: Implement.** In `apps/web/src/components/MyCityView.tsx`:

Replace the import block at the top of the file with:

```tsx
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { useCityLink, type CityLinkState } from '../lib/city-link';
import { useData } from '../lib/data';
import { useMonitor } from '../lib/monitor';
import { cityLinkFor, displayLink } from '../lib/public-city';
import type { Project } from '../lib/types';
import { NicknameDialog } from './NicknameDialog';
import { PublishControl } from './PublishControl';
```

Replace the doc comment of `MyCityView` and everything from `const { projects, machines, hiddenLocal, loading } = useData();` down to `const onStreet = …;` (keeping the nickname/link/short/canListProjects lines between them as they are) so that the body starts:

```tsx
/**
 * Settings → Minha cidade: the signed-in user's own public city, for every account (no resource
 * grant). The nickname (set once, never changed), the city's address, and the projects this user
 * owns with the same publish switch as the project page. A published project is a building on the
 * street (city-by-project §2.4), and its agents there are its open terminals on the machines this
 * person owns — so each row says whether it is published and how many of those agents it has now.
 */
export function MyCityView() {
  const { user, publicCityUrl, can } = useAuth();
  const { projects, machines, hiddenLocal, loading } = useData();
  const { openTabs } = useMonitor();
  const [choosingNickname, setChoosingNickname] = useState(false);

  const nickname = user?.nickname ?? null;
  const link = cityLinkFor(publicCityUrl, nickname);
  const short = useCityLink(!!nickname);
  // An account that cannot list projects cannot own any either; its project list never loads, so
  // there is nothing to wait for.
  const canListProjects = can('projects', 'read');

  // Hidden local machines (someone's own computer added from another browser) are still the
  // person's, so their agents count here too.
  const ownMachines = useMemo(() => new Set([...machines, ...hiddenLocal].filter((m) => user && m.owner_id === user.id).map((m) => m.id)), [machines, hiddenLocal, user]);
  /** the project's agents on the street right now: its open terminals on the machines this person owns */
  const agentsOf = (p: Project) => openTabs.filter((t) => t.project_id === p.id && ownMachines.has(t.machine_id)).length;

  const mine = canListProjects && user ? projects.filter((p) => p.owner_id === user.id) : [];
  const onStreet = mine.some((p) => p.is_public && p.status !== 'archived');
```

Replace the first paragraph of the returned JSX with:

```tsx
      <p className="text-sm text-fg-muted">Sua cidade pública mostra, para quem tiver o link, cada projeto que você publicar e os agentes dele que rodam nas suas máquinas.</p>
```

Replace the `mine.map((p) => { … })` callback with:

```tsx
            {mine.map((p) => (
              <li key={p.id} className="flex items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 text-sm">
                    <span className="truncate font-medium">{p.name}</span>
                    <span className="font-mono text-xs text-fg-dim">{p.key}</span>
                  </div>
                  <p className="truncate text-xs text-fg-dim">{p.is_public ? publishedLine(agentsOf(p)) : 'não publicado'}</p>
                </div>
                <Link to={`/projects/${p.id}`} className="shrink-0 text-xs text-accent hover:underline" aria-label={`Abrir projeto ${p.name}`}>
                  abrir →
                </Link>
                <PublishControl project={p} />
              </li>
            ))}
```

and add, right above `function useCopy()`:

```tsx
/** A published project always has its building on the street, even with nobody in it right now. */
const publishedLine = (agents: number) => `publicado · ${agents} ${agents === 1 ? 'agente' : 'agentes'} agora`;
```

In `apps/web/src/components/PublishControl.tsx`, replace the doc comment above `PublishControl` with:

```tsx
/**
 * Publishes the project on its owner's public city: one building, whose robots are the project's
 * agents (tabs) on the machines the owner owns — an agent on somebody else's machine never shows,
 * and no machine is named at all (city-by-project §2.4). Publishing is a one-way disclosure — it
 * makes readable, to anyone with the link, the project's name, each of those agents with what it is
 * doing, and the owner's display name and nickname — so turning it ON asks for a separate
 * confirmation, spelling that out; turning it back OFF does not, since there is nothing new to warn
 * about. The server is the only source of truth for whether this is allowed (project owner,
 * nickname claimed): this component reacts to its 403/409 codes and never re-implements those rules.
 */
```

and replace the three `<p>` of the confirm panel with:

```tsx
          <p className="text-fg-muted">
            Publicar deixa visível, para quem tiver o link, o nome do projeto e cada agente (aba) dele que roda nas suas máquinas, com o que cada um está fazendo, além do seu nome e apelido.
          </p>
          <p className="mt-2 text-fg-muted">Agentes em máquinas de outras pessoas não aparecem.</p>
```

- [ ] **Step 4: Run them to see them pass.** `WEBTEST src/components/MyCityView.test.tsx src/pages/ProjectPage.test.tsx` — Expected: PASS (0 failed). `DOCKER 'npm run typecheck -w @termhub/web'` — Expected: exit 0.

- [ ] **Step 5: Commit.**

```bash
git add apps/web/src/components/MyCityView.tsx apps/web/src/components/MyCityView.test.tsx apps/web/src/components/PublishControl.tsx apps/web/src/pages/ProjectPage.test.tsx
git commit -m "Minha cidade: each project published with its agents, no machines

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task B8: The superseded notes, the whole branch, and a real browser against a real server

**Files:**
- Modify: `docs/superpowers/specs/2026-09-22-public-city-design.md` (before the "Amended after merge with projects-decoupled" block), `docs/superpowers/specs/2026-09-21-office-world-design.md` (under `## 4. Levels and navigation`), `docs/superpowers/specs/2026-09-24-city-by-project-design.md:3` (status)

**Interfaces:**
- Consumes: everything above.
- Produces: no code. The branch is ready for the whole-branch review.

- [ ] **Step 1: Write the notes.** In `docs/superpowers/specs/2026-09-22-public-city-design.md`, insert right before the line that starts `**Amended after merge with projects-decoupled**`:

```markdown
> **Superseded by `2026-09-24-city-by-project-design.md`** for what a city is, its ids and the
> sharing rules below: a building is a published project, its robots are that project's tabs on
> machines the owner owns, nothing about a machine is public, and `RobotsGone` replaced `RoomsGone`.
> The surfaces (snapshot, socket, card, document) are still described here.
```

In `docs/superpowers/specs/2026-09-21-office-world-design.md`, insert right after the `## 4. Levels and navigation` heading:

```markdown
> **Superseded by `2026-09-24-city-by-project-design.md`**: the city has one building per project
> and two levels (city › project, `/office` and `/office/:projectId`); a machine is a tag on each
> desk, not a building, and there are no rooms.
```

In `docs/superpowers/specs/2026-09-24-city-by-project-design.md` line 3, replace `Status: **approved design, not implemented.**` with `Status: **implemented on \`feat/city-by-project\`, pending review and merge.**`.

- [ ] **Step 2: Verify the whole branch.**
  - `DOCKER 'npm run typecheck -w @termhub/server && npm run build -w @termhub/web && npm run build -w @termhub/landing'` — Expected: exit 0 (the repo's own pre-push check, CLAUDE.md).
  - `SRVTEST` (the whole server suite) — Expected: PASS, 0 failed.
  - `DBTEST` with `<files>` empty — Expected: PASS, 0 failed.
  - `WEBSUITE` — Expected: PASS, 0 failed.
  - `grep -rln "from 'pixi.js'" apps/web/src | grep -v '^apps/web/src/office/\(scene\|pack\)/'` — Expected: no output.
  - `grep -rnE "publicRoomId|RoomsGone|OfficeSnapshot|OfficeRoom|PublicRoom|toMachineEntries|useOfficeSnapshots|onPickRoom|onPickMachine|MachineSign|RoomSign|offstreet" apps/server/src apps/web/src` — Expected: no output.

- [ ] **Step 3: The public city in a real browser, against a real server and database.** Build both bundles, migrate a throwaway database, boot the server on it, seed one city whose published project also runs on somebody else's machine, and read it the way a visitor does:

```bash
set -o pipefail
docker run -d --rm --name pccp-db -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=termhub -p 127.0.0.1:55461:5432 postgres:16
until docker exec pccp-db pg_isready -h 127.0.0.1 -U postgres -d termhub >/dev/null 2>&1; do sleep 1; done
DB=postgresql://postgres:postgres@127.0.0.1:55461/termhub
docker run --rm --network host -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/w" -w /w node:20 sh -c "npm run build -w @termhub/web && npm run build:city -w @termhub/web && cd apps/server && DATABASE_URL=$DB npx prisma migrate deploy"
docker run -d --rm --name pccp-app --network host -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/w" -w /w/apps/server -e DATABASE_URL=$DB -e PORT=3999 -e HOST=127.0.0.1 -e SEED_LOCAL_MACHINE=false -e PUBLIC_CITY_URL=http://127.0.0.1:3999/city node:20 npx tsx src/index.ts
until curl -sf http://127.0.0.1:3999/api/health >/dev/null; do sleep 1; done
mkdir -p /tmp/pccp-smoke && cat > /tmp/pccp-smoke/seed.mts <<'EOF'
import { closePrisma, getPrisma } from '/w/apps/server/src/db/prisma.ts';
import { createRepositories } from '/w/apps/server/src/db/repositories/index.ts';
import { SYSTEM_ROLE_IDS } from '/w/apps/server/src/db/repositories/roles.ts';
import { loadPublicIdKey, setPublicIdKey } from '/w/apps/server/src/public/public-id.ts';

const repos = createRepositories(getPrisma());
setPublicIdKey(await loadPublicIdKey(repos));
const owner = await repos.users.create({ email: 'pccp-owner@smoke.test', name: 'Dona Smoke', role_id: SYSTEM_ROLE_IDS.authenticated });
const other = await repos.users.create({ email: 'pccp-other@smoke.test', name: 'Outra Pessoa', role_id: SYSTEM_ROLE_IDS.authenticated });
if ((await repos.users.setNickname(owner.id, 'pccpsmoke')) !== 'ok') throw new Error('nickname');
const mine = await repos.machines.create({ name: 'MAQUINA-SECRETA-PCCP', subtitle: 'SUBTITULO-SECRETO-PCCP', type: 'agent', owner_id: owner.id });
const theirs = await repos.machines.create({ name: 'MAQUINA-ALHEIA-PCCP', type: 'agent', owner_id: other.id });
const project = await repos.projects.create({ owner_id: owner.id, key: 'PCCP', name: 'Projeto Smoke' });
await repos.projectMachines.link({ project_id: project.id, machine_id: mine.id, cwd: '/w' });
await repos.projectMachines.link({ project_id: project.id, machine_id: theirs.id, cwd: '/w' });
await repos.projects.update(project.id, { is_public: true });
const empty = await repos.projects.create({ owner_id: owner.id, key: 'PCCPV', name: 'Projeto Vazio' });
await repos.projects.update(empty.id, { is_public: true });
for (const [machineId, name] of [[mine.id, 'aba publica'], [theirs.id, 'ABA-ALHEIA-PCCP']] as const) {
  const tab = await repos.tabs.create(project.id, machineId, name);
  await repos.tabs.recordEvent(tab.id, { kind: 'working', tool: 'claude', text: null });
}
console.log(JSON.stringify({ building: project.public_id }));
await closePrisma();
EOF
FIXTURE=$(docker run --rm --network host -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/w" -v /tmp/pccp-smoke:/smoke -w /w/apps/server -e DATABASE_URL=$DB node:20 npx tsx /smoke/seed.mts | tail -n 1) && echo "$FIXTURE"
cat > /tmp/pccp-smoke/city.mjs <<'EOF'
import { chromium } from 'playwright';
const secrets = ['MAQUINA-SECRETA-PCCP', 'SUBTITULO-SECRETO-PCCP', 'MAQUINA-ALHEIA-PCCP', 'ABA-ALHEIA-PCCP'];
const { building } = JSON.parse(process.env.FIXTURE);
const b = await chromium.launch({ args: ['--enable-unsafe-swiftshader'] });
let failed = false;
for (const [name, path] of [
  ['city', '/city/@pccpsmoke'],
  ['building', `/city/@pccpsmoke/${building}`],
  ['old-link', '/city/@pccpsmoke/AAAAAAAAAAAAAAAAAAAAAA?room=BBBBBBBBBBBBBBBBBBBBBB'],
]) {
  const p = await b.newPage({ viewport: { width: 1400, height: 900 } });
  const bodies = [];
  const errors = [];
  p.on('pageerror', (e) => errors.push(String(e)));
  p.on('response', async (r) => { if (r.url().includes('/api/public/')) bodies.push(await r.text().catch(() => '')); });
  p.on('websocket', (ws) => ws.on('framereceived', (f) => bodies.push(String(f.payload))));
  await p.goto(`http://127.0.0.1:3999${path}`);
  await p.waitForTimeout(3000);
  const html = await p.content();
  const trail = (await p.locator('nav[aria-label="Trilha"]').innerText()).replace(/\s+/g, ' ');
  await p.screenshot({ path: `/s/${name}.png` });
  const leaks = secrets.filter((s) => html.includes(s) || bodies.some((x) => x.includes(s)));
  console.log(name, JSON.stringify({ title: await p.title(), trail, leaks, errors }));
  if (leaks.length || errors.length) failed = true;
  await p.close();
}
await b.close();
process.exit(failed ? 1 : 0);
EOF
docker run --rm --network host --ipc=host -e FIXTURE="$FIXTURE" -v /tmp/pccp-smoke:/s -w /tmp mcr.microsoft.com/playwright:v1.63.0-noble sh -c 'npm i playwright@1.63.0 --no-audit --no-fund >/dev/null 2>&1 && cp /s/city.mjs . && node city.mjs'
docker stop pccp-app pccp-db
rm -rf .npm
```

Expected: the last `docker run` exits 0 and prints three lines — `city` with title `A cidade de Dona Smoke no termhub` and an empty trail; `building` with title `Projeto Smoke — a cidade de Dona Smoke` and trail `Cidade › Projeto Smoke` (whitespace normalised by the script); `old-link` with the city's title and an empty trail — each with `"leaks":[]` and `"errors":[]` (no machine name, subtitle or foreign tab anywhere in the DOM, the snapshot, the document or a socket frame). **Open the three PNGs with the Read tool:** (city) two buildings — `Projeto Smoke` lit with one robot typing, `Projeto Vazio` dark with "sem agentes agora" — and no machine line under the robot; (building) `Projeto Smoke` framed; (old-link) the same as (city).

- [ ] **Step 4: Commit.**

```bash
git add docs/superpowers/specs/2026-09-22-public-city-design.md docs/superpowers/specs/2026-09-21-office-world-design.md docs/superpowers/specs/2026-09-24-city-by-project-design.md
git commit -m "Docs: mark the city by machine superseded by the city by project

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Self-review

Checked against the spec after writing:

- **§2.1 / §2.2** — `buildOfficeCity` (A2) and `GET /api/office?fresh=` with parallel probes, scope, `tasks:read`, a throwing probe tolerated (A3); `listByProjectsOnMachine` kept for the MCP (A3 Interfaces).
- **§2.3** — `PublicBuilding { id, name, robots }`, frames without `room` (A4); `publicId` kinds `'project' | 'tab'`, `publicRoomId` removed (A6); `Machine.public_id` removed and `Project.public_id` added (A1).
- **§2.4** — published and non-archived only, empty buildings kept, robots on owned machines only, by name (A4); memo cleared on `PublicChange`, `OwnerGone`, `TabRemoved`, `RobotsGone` (A5); `ws.ts` rule (A5).
- **§2.5** — `/office`, `/office/:projectId`, `?focus=1` kept, `?room=` gone (B4); public `/city/@nick[/<projectPublicId>]`, `?room=` ignored, unknown id → city (A4, B6); card `?building=` only and its copy, meta description (A4).
- **§3.1** — `DeskModel.machine`, `BuildingModel`, `CityModel`, `FocusTarget`, dimmed/notice/lit, `resolveFocus`, `missingTabIds` (B1).
- **§3.2** — `layoutCity`/`layoutFloor`, shape `b{d:kind}`, `BuildingSign`, desk machine line with `SUBTITLE_CAP`, handlers (B2).
- **§3.3** — `useOfficeCity`, ladder, auto-drill, trail, notices, `shareResultFor` without `offstreet`, harness knobs (B3, B4, B5).
- **§4** — `url.ts`, `toBuildingEntries`, frames by building, trail, `up()`, copy link, compose/sound walks (B1, B6).
- **§5** — "Minha cidade" rows and the confirm panel (B7); superseded notes (B8).
- **§6** — machine secrets never public, pinned in fixtures and against Postgres (A4 `read.db.test.ts`, `city.test.ts`; B8 real browser); private and archived never buildings (A4); `Project.public_id` reaches only the authenticated app and the bundle imports nothing new (A1, B6 `WEBSUITE`).
- **§7** — no migration; old links and bookmarks fall back (A4, B4, B6).
- **§8** — every listed test area has a task; the Playwright smoke is B5 (private, harness) and B8 (public, real server).
