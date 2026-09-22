# Office City (v2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `/office` from one machine's floor into the city: every machine of the account as a block of ONE continuous PixiJS scene, with camera rests at city, machine and room, snapshots read per machine in parallel, and the tmux probe memoised on the server.

**Architecture:** The per-machine endpoint stays; the browser fans out one request per machine, so a slow machine delays only its own block. Pure functions lay out blocks the way rooms are already laid out (one shared shelf packer) and build a city model out of the existing floor model. The scene is mounted once per visit and draws the city model; moving between city, machine and room is a camera move driven by the URL.

**Tech Stack:** Fastify + zod (server), React 18 + react-router 7 + Vite + PixiJS 8 (web), Vitest.

**Spec:** `docs/superpowers/specs/2026-09-21-office-world-design.md` (sections 3, 4, 5, 7, 8 describe v2).

## Global Constraints

- Code, comments, commit messages and docs in English; **UI copy in Portuguese (pt-BR)**.
- The host has no Node. Run everything through Docker from the repo root:
  `docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/w" -w /w node:20 sh -c '<cmd>'`, then `rm -rf .npm`. Below, `DOCKER '<cmd>'` means exactly that. Never pipe a test/typecheck/build command through `tail`/`head` in a way that hides its exit code.
- After a fresh `npm ci`, the server typecheck needs `npm run prisma:generate && npm run build:packages` first.
- Address workspaces by package name (`-w @termhub/server`, `-w @termhub/web`), never by path.
- Server: routes never import Prisma; every request input (params AND query) validated with zod; machines loaded through `scoped(repos, request).machine(id)`; anything executed on a machine goes through `runOnMachine`; log metadata only.
- No schema change, no migration.
- PixiJS is imported only under `apps/web/src/office/scene/` and `apps/web/src/office/pack/`; the page stays `lazy()`.
- Nothing in the overlay is an opaque plate: text carries an outline (the shared style helper in `scene/Overlay.ts`).
- **Hard-won invariants of v1 — every task must keep them, and `OfficePage.test.tsx` pins most:**
  1. react-router 7's `setSearchParams` AND `navigate` change identity (the first on every query-string change, the second on every pathname change). The scene-mount effect depends on the host element ONLY; handlers reach the scene through a ref synced in an effect.
  2. The host `<div>` is state via a callback ref (the page returns early while `useData().loading`).
  3. A freshly created scene is seeded with the current model and focus target.
  4. The monitor overrides only the five state fields of a snapshot tab, and only when its `state_at` is newer.
  5. A snapshot re-read for newly missing tabs happens only when the set of missing ids GROWS, and an id is marked asked only when a request really started.
  6. `!snapshot.reachable` ⇒ `alive: false` is not evidence: people keep pose, marker and needsYou.
  7. The canvas follows its container through a `ResizeObserver` (Pixi's `resizeTo` listens to the window only).
- Work on branch `feat/office-city`, cut from `docs/office-city-spec` (origin/main + the spec and this plan). Do not push to `main`; open a PR at the end.

## Review Focus

1. **One machine never answers** (ssh timeout ~8 s, or its request rejects) — the other blocks must appear immediately and stay interactive; the late one becomes an error/"sem resposta" block without moving the camera the person already placed. Pinned in Task 4 (hook) and Task 3 (model).
2. **Memo serving a stale "no sessions" right after a tab was opened** — the explicit re-read for a newly missing tab must bypass the memo (`?fresh=1`), or the new person sits as an empty chair for up to a minute. Pinned in Task 1 and Task 4.
3. **`/office/:machineId` for a machine that does not exist or has not loaded yet, and `?room=` naming a room of another machine** — must frame the city (or the machine) and never a wrong room, and must not throw. Pinned in Task 3 (`resolveFocus`) and Task 6.
4. **An account with zero machines, one machine, and a machine with zero projects** — message; auto-drill to the machine; a minimal empty block with its sign. Pinned in Tasks 2, 3, 6.
5. **Two concurrent requests for the same machine while the memo is empty** (two browser tabs opening the city) — must share ONE probe, not start two. Pinned in Task 1.

---

## File Structure

```
apps/server/src/terminal/machine-exec.ts        + probeTmuxSessionsCached, clearTmuxProbeMemo
apps/server/src/terminal/machine-exec.test.ts   + memo tests
apps/server/src/routes/office.ts                uses the memo; ?fresh=1 bypasses it
apps/server/src/routes/office.test.ts

apps/web/src/office/layout/shelves.ts           packShelves (extracted from floor.ts)
apps/web/src/office/layout/shelves.test.ts
apps/web/src/office/layout/floor.ts             now a thin wrapper over packShelves
apps/web/src/office/layout/city.ts              layoutCity, roomOnCity, blockBounds, cityBounds
apps/web/src/office/layout/city.test.ts
apps/web/src/office/model.ts                    + buildCityModel, resolveFocus, CityModel types
apps/web/src/office/model.test.ts
apps/web/src/lib/api.ts                         api.office(machineId, fresh?)
apps/web/src/office/useOfficeSnapshots.ts       replaces useOfficeSnapshot.ts (deleted)
apps/web/src/office/useOfficeSnapshots.test.tsx replaces useOfficeSnapshot.test.tsx (deleted)
apps/web/src/office/scene/OfficeScene.ts        draws a CityModel; focus(target)
apps/web/src/office/scene/Overlay.ts            + MachineSign
apps/web/src/office/scene/RoomView.ts           + drawBlock
apps/web/src/office/harness.ts                  ?machines=N, ?machine=<i>, offline/error blocks
apps/web/src/pages/OfficePage.tsx               city page: breadcrumb, Esc ladder, URL rests
apps/web/src/pages/OfficePage.test.tsx
```

---

### Task 1: Memoise the tmux probe; `?fresh=1` bypasses it

**Files:**
- Modify: `apps/server/src/terminal/machine-exec.ts` (after `probeTmuxSessions`)
- Modify: `apps/server/src/terminal/machine-exec.test.ts`, `apps/server/src/routes/office.ts`, `apps/server/src/routes/office.test.ts`

**Interfaces:**
- Consumes: `probeTmuxSessions(machine: Machine): Promise<TmuxProbe>`, `TmuxProbe { reachable; sessions: Set<string>; cause? }` (already in `machine-exec.ts`).
- Produces:

```ts
export const PROBE_TTL_MS = { reachable: 15_000, unreachable: 60_000 } as const;
export function probeTmuxSessionsCached(machine: Machine, opts?: { fresh?: boolean; now?: () => number }): Promise<TmuxProbe>;
export function clearTmuxProbeMemo(): void;   // tests
```

`GET /api/office/:machineId?fresh=1` — bypasses the memo and refreshes it.

- [ ] **Step 1: Write the failing tests.** Append to `apps/server/src/terminal/machine-exec.test.ts` (reuse the file's existing `machine(type, id?)` helper and its agent/ssh mocks; import `probeTmuxSessionsCached, clearTmuxProbeMemo, PROBE_TTL_MS`). Use an injected clock, not fake timers:

```ts
describe('probeTmuxSessionsCached', () => {
  beforeEach(() => clearTmuxProbeMemo());

  it('serves a reachable answer from memory for 15 s, then probes again', async () => {
    let t = 1_000;
    const now = () => t;
    const m = machine('ssh');
    // arrange the file's ssh mock to answer "th-a"
    await probeTmuxSessionsCached(m, { now });
    const calls = probeCallCount(); // however this file counts executions: vi.mocked(execFile).mock.calls.length
    t += PROBE_TTL_MS.reachable - 1;
    await probeTmuxSessionsCached(m, { now });
    expect(probeCallCount()).toBe(calls);
    t += 2;
    await probeTmuxSessionsCached(m, { now });
    expect(probeCallCount()).toBe(calls + 1);
  });

  it('keeps an unreachable answer for 60 s — a machine that is down costs one timeout a minute', async () => {
    let t = 0;
    const now = () => t;
    const m = machine('agent', 'offline-agent');
    expect((await probeTmuxSessionsCached(m, { now })).reachable).toBe(false);
    t += PROBE_TTL_MS.unreachable - 1;
    const again = await probeTmuxSessionsCached(m, { now });
    expect(again).toEqual({ reachable: false, sessions: new Set(), cause: 'agent offline' });
  });

  it('keys by machine id', async () => {
    const now = () => 0;
    const a = await probeTmuxSessionsCached(machine('agent', 'offline-agent'), { now });
    const b = await probeTmuxSessionsCached(machine('ssh', 'other'), { now });
    expect(a.reachable).toBe(false);
    expect(b.reachable).toBe(true);
  });

  it('shares one in-flight probe between concurrent callers', async () => {
    const now = () => 0;
    const m = machine('ssh');
    const before = probeCallCount();
    const [x, y] = await Promise.all([probeTmuxSessionsCached(m, { now }), probeTmuxSessionsCached(m, { now })]);
    expect(probeCallCount()).toBe(before + 1);
    expect(x).toBe(y);
  });

  it('fresh bypasses the memo and refreshes it', async () => {
    const now = () => 0;
    const m = machine('ssh');
    await probeTmuxSessionsCached(m, { now });
    const calls = probeCallCount();
    await probeTmuxSessionsCached(m, { now, fresh: true });
    expect(probeCallCount()).toBe(calls + 1);
    await probeTmuxSessionsCached(m, { now });
    expect(probeCallCount()).toBe(calls + 1); // served by the refreshed entry
  });
});
```

Open the file first: adapt `probeCallCount()` and the mock arrangement to how its existing `probeTmuxSessions` tests drive ssh and agent answers. Do not weaken what the five cases assert.

In `apps/server/src/routes/office.test.ts` (it mocks `probeTmuxSessions` today): switch the mock to `probeTmuxSessionsCached` and add:

```ts
  it('asks for a fresh probe only when ?fresh=1', async () => {
    const { app } = buildApp();
    await app.inject({ method: 'GET', url: '/office/m1' });
    expect(probe).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'm1' }), { fresh: false });
    await app.inject({ method: 'GET', url: '/office/m1?fresh=1' });
    expect(probe).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'm1' }), { fresh: true });
  });

  it('rejects a malformed fresh value', async () => {
    const { app } = buildApp();
    expect((await app.inject({ method: 'GET', url: '/office/m1?fresh=yes' })).statusCode).toBe(400);
  });
```

(`probe` = the name that file gives its mock; keep its existing tests passing.)

- [ ] **Step 2: Run them.** `DOCKER 'npx -w @termhub/server vitest run src/terminal/machine-exec.test.ts src/routes/office.test.ts'` — Expected: FAIL (`probeTmuxSessionsCached` is not exported).

- [ ] **Step 3: Implement** in `apps/server/src/terminal/machine-exec.ts`, right after `probeTmuxSessions`:

```ts
/** How long a probe answer is reused. An unreachable machine is asked again less often: over ssh it costs a timeout. */
export const PROBE_TTL_MS = { reachable: 15_000, unreachable: 60_000 } as const;

const probeMemo = new Map<string, { at: number; probe: TmuxProbe }>();
const probesInFlight = new Map<string, Promise<TmuxProbe>>();

/**
 * `probeTmuxSessions` behind a per-machine memo: the office city asks every machine every minute
 * from every open browser tab, and they can all share one round-trip. Only the probe is reused —
 * callers read projects, tabs and tasks from the database every time. `fresh` skips the memo (a
 * tab was just opened and must not read as "no session yet") and refreshes it. Concurrent callers
 * share one in-flight probe.
 */
export function probeTmuxSessionsCached(machine: Machine, opts: { fresh?: boolean; now?: () => number } = {}): Promise<TmuxProbe> {
  const now = opts.now ?? Date.now;
  const hit = probeMemo.get(machine.id);
  if (!opts.fresh && hit && now() - hit.at < (hit.probe.reachable ? PROBE_TTL_MS.reachable : PROBE_TTL_MS.unreachable)) return Promise.resolve(hit.probe);
  const running = probesInFlight.get(machine.id);
  if (running) return running;
  const started = probeTmuxSessions(machine)
    .then((probe) => {
      probeMemo.set(machine.id, { at: now(), probe });
      return probe;
    })
    .finally(() => probesInFlight.delete(machine.id));
  probesInFlight.set(machine.id, started);
  return started;
}

/** Tests only. */
export function clearTmuxProbeMemo(): void {
  probeMemo.clear();
  probesInFlight.clear();
}
```

In `apps/server/src/routes/office.ts`: add `const query = z.object({ fresh: z.enum(['0', '1']).optional() });`, parse `request.query` with it, and replace the `probeTmuxSessions(machine)` call with `probeTmuxSessionsCached(machine, { fresh: fresh === '1' })`. Update the route's doc comment to say the probe is memoised and what `fresh` is for.

- [ ] **Step 4: Run the tests and the server typecheck.** `DOCKER 'npx -w @termhub/server vitest run src/terminal/machine-exec.test.ts src/routes/office.test.ts && npm run typecheck -w @termhub/server'` — Expected: PASS.

- [ ] **Step 5: Commit** — `git commit -m "Office: memoise the tmux probe per machine; ?fresh=1 bypasses it"`

---

### Task 2: One shelf packer; the city layout

**Files:**
- Create: `apps/web/src/office/layout/shelves.ts`, `shelves.test.ts`, `city.ts`, `city.test.ts`
- Modify: `apps/web/src/office/layout/floor.ts` (becomes a wrapper; `floor.test.ts` must pass unchanged)

**Interfaces:**
- Consumes: `Cell`, `toScreen`, `RoomLayout`, `layoutRoom`, `roomBounds` from `./iso`; `RoomInput`, `PlacedRoom`, `FloorLayout`, `layoutFloor` from `./floor`.
- Produces:

```ts
// shelves.ts
interface Sized { width: number; height: number }
function packShelves<T extends Sized>(items: T[], gapX: number, gapY: number, targetWidth?: number): { placed: Array<{ item: T; origin: Cell }>; width: number; height: number }

// city.ts
const STREET = 4;
interface BlockInput { id: string; rooms: RoomInput[] }
interface PlacedBlock { id: string; origin: Cell; floor: FloorLayout; width: number; height: number }
interface CityLayout { blocks: PlacedBlock[]; width: number; height: number }
function layoutCity(blocks: BlockInput[], targetWidth?: number): CityLayout
function roomOnCity(block: PlacedBlock, room: PlacedRoom): PlacedRoom   // same room, origin moved by the block's
function blockBounds(block: PlacedBlock, wallH: number): { x: number; y: number; w: number; h: number }
function cityBounds(city: CityLayout, wallH: number): { x: number; y: number; w: number; h: number }
```

- [ ] **Step 1: Write the failing tests.** `apps/web/src/office/layout/shelves.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { packShelves } from './shelves';

const box = (width: number, height: number) => ({ width, height });

describe('packShelves', () => {
  it('fills a row left to right and wraps past the target, keeping order', () => {
    const { placed, width, height } = packShelves([box(5, 3), box(5, 3), box(5, 3)], 1, 2, 12);
    expect(placed.map((p) => p.origin)).toEqual([{ gx: 0, gy: 0 }, { gx: 6, gy: 0 }, { gx: 0, gy: 5 }]);
    expect([width, height]).toEqual([11, 8]);
  });
  it('gives an item wider than the target its own row instead of looping', () => {
    const { placed } = packShelves([box(40, 3), box(5, 3)], 1, 2, 8);
    expect(placed.map((p) => p.origin)).toEqual([{ gx: 0, gy: 0 }, { gx: 0, gy: 5 }]);
  });
  it('uses the tallest item of a row for the next row', () => {
    const { placed } = packShelves([box(5, 9), box(5, 3), box(5, 3)], 1, 2, 12);
    expect(placed[2].origin).toEqual({ gx: 0, gy: 11 });
  });
  it('is empty and finite for nothing', () => {
    expect(packShelves([], 1, 2)).toEqual({ placed: [], width: 0, height: 0 });
  });
});
```

`apps/web/src/office/layout/city.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { blockBounds, cityBounds, layoutCity, roomOnCity, STREET } from './city';

const block = (id: string, desks: number[]) => ({ id, rooms: desks.map((d, i) => ({ id: `${id}-r${i}`, desks: d })) });
const overlap = (a: { origin: { gx: number; gy: number }; width: number; height: number }, b: typeof a) =>
  a.origin.gx < b.origin.gx + b.width && b.origin.gx < a.origin.gx + a.width && a.origin.gy < b.origin.gy + b.height && b.origin.gy < a.origin.gy + a.height;

describe('layoutCity', () => {
  it('keeps the order given and separates blocks by a street', () => {
    const city = layoutCity([block('a', [2]), block('b', [2])], 60);
    expect(city.blocks.map((b) => b.id)).toEqual(['a', 'b']);
    expect(city.blocks[1].origin).toEqual({ gx: city.blocks[0].width + STREET, gy: 0 });
  });
  it('never overlaps blocks of very different sizes, and stays inside its own size', () => {
    const city = layoutCity([block('a', [1, 12, 0]), block('b', [40]), block('c', []), block('d', [3, 3, 3, 3, 3, 3]), block('e', [7])]);
    for (let i = 0; i < city.blocks.length; i++) for (let j = i + 1; j < city.blocks.length; j++) expect(overlap(city.blocks[i], city.blocks[j])).toBe(false);
    for (const b of city.blocks) {
      expect(b.origin.gx + b.width).toBeLessThanOrEqual(city.width);
      expect(b.origin.gy + b.height).toBeLessThanOrEqual(city.height);
    }
  });
  it('gives a machine with no projects a minimal block, so its sign has ground to stand on', () => {
    const city = layoutCity([block('empty', [])]);
    expect([city.blocks[0].width, city.blocks[0].height]).toEqual([5, 3]);
    expect(city.blocks[0].floor.rooms).toEqual([]);
  });
  it('is an empty, finite city for no machines', () => {
    const city = layoutCity([]);
    expect(city).toEqual({ blocks: [], width: 0, height: 0 });
    expect(Object.values(cityBounds(city, 28)).every(Number.isFinite)).toBe(true);
  });
  it('keeps an earlier block where it was when a later one grows', () => {
    const before = layoutCity([block('a', [3]), block('b', [3])], 80);
    const after = layoutCity([block('a', [3]), block('b', [30])], 80);
    expect(after.blocks[0].origin).toEqual(before.blocks[0].origin);
  });
});

describe('roomOnCity / bounds', () => {
  it('moves a room by its block origin and leaves the block-local layout alone', () => {
    const city = layoutCity([block('a', [2]), block('b', [2, 2])], 60);
    const b = city.blocks[1];
    const local = b.floor.rooms[1];
    const placed = roomOnCity(b, local);
    expect(placed.origin).toEqual({ gx: b.origin.gx + local.origin.gx, gy: b.origin.gy + local.origin.gy });
    expect(placed.layout).toBe(local.layout);
    expect(local.origin).toEqual(b.floor.rooms[1].origin); // not mutated
  });
  it('bounds of a later block sit to the right of an earlier one in the same row, and the city spans both', () => {
    const city = layoutCity([block('a', [2]), block('b', [2])], 60);
    const [a, b] = city.blocks.map((x) => blockBounds(x, 28));
    expect(b.x).toBeGreaterThan(a.x);
    const all = cityBounds(city, 28);
    expect(all.x).toBeLessThanOrEqual(a.x);
    expect(all.x + all.w).toBeGreaterThanOrEqual(b.x + b.w);
  });
});
```

- [ ] **Step 2: Run them.** `DOCKER 'npx -w @termhub/web vitest run src/office/layout'` — Expected: `floor.test.ts`/`iso.test.ts` PASS; the two new files FAIL (modules missing).

- [ ] **Step 3: Implement.** `apps/web/src/office/layout/shelves.ts`:

```ts
/** Shelf packing, shared by the rooms of a floor and the blocks of the city. Pure. */
import type { Cell } from './iso';

export interface Sized {
  width: number;
  height: number;
}

/**
 * Items go left to right in the order given and wrap to a new row past `targetWidth`. Order is
 * never changed, so an item only moves when one before it changes size. The target is never
 * narrower than the widest item, so a row always takes at least one item and the loop cannot
 * stall. The default target makes the packing roughly square in tiles, which projects to about
 * 2:1 on screen.
 */
export function packShelves<T extends Sized>(items: T[], gapX: number, gapY: number, targetWidth?: number): { placed: Array<{ item: T; origin: Cell }>; width: number; height: number } {
  const area = items.reduce((sum, i) => sum + (i.width + gapX) * (i.height + gapY), 0);
  const widest = items.reduce((w, i) => Math.max(w, i.width), 0);
  const target = Math.max(widest, targetWidth ?? Math.ceil(Math.sqrt(area) * 1.15));
  const placed: Array<{ item: T; origin: Cell }> = [];
  let x = 0;
  let y = 0;
  let rowHeight = 0;
  let width = 0;
  for (const item of items) {
    if (x > 0 && x + item.width > target) {
      x = 0;
      y += rowHeight + gapY;
      rowHeight = 0;
    }
    placed.push({ item, origin: { gx: x, gy: y } });
    width = Math.max(width, x + item.width);
    x += item.width + gapX;
    rowHeight = Math.max(rowHeight, item.height);
  }
  return { placed, width, height: placed.length ? y + rowHeight : 0 };
}
```

In `apps/web/src/office/layout/floor.ts`, replace the body of `layoutFloor` (keep its exports, doc comment, `GAP_X = 1`, `CORRIDOR = 2`, `placedRoomBounds`, `floorBounds` exactly as they are):

```ts
export function layoutFloor(rooms: RoomInput[], targetWidth?: number): FloorLayout {
  const items = rooms.map((r) => {
    const layout = layoutRoom(r.desks);
    return { id: r.id, layout, width: layout.width, height: layout.height };
  });
  const packed = packShelves(items, GAP_X, CORRIDOR, targetWidth);
  return { rooms: packed.placed.map(({ item, origin }) => ({ id: item.id, origin, layout: item.layout })), width: packed.width, height: packed.height };
}
```

`apps/web/src/office/layout/city.ts`:

```ts
/** Where each machine's floor sits in the city. Pure; the scene only draws the result. */
import { layoutFloor, placedRoomBounds, type FloorLayout, type PlacedRoom, type RoomInput } from './floor';
import { toScreen, type Cell } from './iso';
import { packShelves } from './shelves';

/** Tiles between two blocks: wider than a floor's corridor, so where a machine ends reads by itself. */
export const STREET = 4;
/** A machine with no projects still gets ground for its sign. */
const MIN_BLOCK = { width: 5, height: 3 };

export interface BlockInput {
  id: string;
  rooms: RoomInput[];
}

export interface PlacedBlock {
  id: string;
  /** the block's (0,0) tile on the city grid */
  origin: Cell;
  /** the machine's floor, in block-local coordinates */
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
    const floor = layoutFloor(b.rooms);
    return { id: b.id, floor, width: Math.max(floor.width, MIN_BLOCK.width), height: Math.max(floor.height, MIN_BLOCK.height) };
  });
  const packed = packShelves(items, STREET, STREET, targetWidth);
  return { blocks: packed.placed.map(({ item, origin }) => ({ ...item, origin })), width: packed.width, height: packed.height };
}

/** A block-local room in city coordinates. */
export function roomOnCity(block: PlacedBlock, room: PlacedRoom): PlacedRoom {
  return { ...room, origin: { gx: block.origin.gx + room.origin.gx, gy: block.origin.gy + room.origin.gy } };
}

/** Screen-space box of a block's footprint, `wallH` pixels of walls included. */
export function blockBounds(block: PlacedBlock, wallH: number): { x: number; y: number; w: number; h: number } {
  const { gx, gy } = block.origin;
  const left = toScreen(gx, gy + block.height).x;
  const right = toScreen(gx + block.width, gy).x;
  const top = toScreen(gx, gy).y - wallH;
  const bottom = toScreen(gx + block.width, gy + block.height).y;
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

export { placedRoomBounds };
```

If a test literal disagrees with what this code computes, work out by hand which is right, fix the wrong one and say so in your report. (`layoutRoom(2)` is 5×3; `layoutRoom(0)` is 5×3.)

- [ ] **Step 4: Run the tests and typecheck.** `DOCKER 'npx -w @termhub/web vitest run src/office/layout && npm run typecheck -w @termhub/web'` — Expected: PASS, with `floor.test.ts` untouched.

- [ ] **Step 5: Commit** — `git commit -m "Office: one shelf packer for rooms and blocks; the city layout"`

---

### Task 3: The city model and the focus target

**Files:**
- Modify: `apps/web/src/office/model.ts`, `apps/web/src/office/model.test.ts`

**Interfaces:**
- Consumes: `buildModel(snapshot, liveTab): FloorModel`, `truncateLabel`, `OfficeSnapshot`.
- Produces:

```ts
interface MachineEntry { id: string; name: string; online: boolean; snapshot: OfficeSnapshot | null; failed: boolean }
type MachineNotice = 'offline' | 'silent' | 'error' | null;
interface MachineModel { id: string; name: string; label: string; lit: boolean; notice: MachineNotice; needsYou: number; floor: FloorModel }
interface CityModel { machines: MachineModel[]; needsYou: number }
function buildCityModel(entries: MachineEntry[], liveTab: (tabId: string) => Tab | undefined): CityModel

type FocusTarget = { kind: 'city' } | { kind: 'machine'; machineId: string } | { kind: 'room'; machineId: string; roomId: string };
function resolveFocus(city: CityModel | null, machineId: string | undefined, roomId: string | null): FocusTarget
function sameFocus(a: FocusTarget, b: FocusTarget): boolean
```

Rules: a machine still loading (`snapshot === null && !failed`) is NOT in the city yet. A failed one is an empty block with `notice: 'error'`. `lit = online`; `notice` is `'offline'` when `!online`, else `'silent'` when `snapshot.reachable === false`, else `null`. Machines are sorted by `name` (`localeCompare`), then `id`. A snapshot whose `machine.id` differs from the entry's id is treated as not loaded.

- [ ] **Step 1: Write the failing tests** — append to `apps/web/src/office/model.test.ts` (reuse the file's `tab`, `room`, `snap` helpers; `snap(rooms)` builds a snapshot for machine `m1` — add an optional machine id parameter to it, defaulting to `'m1'`, and a `reachable` override if it has none):

```ts
describe('buildCityModel', () => {
  const entry = (id: string, over: Partial<MachineEntry> = {}): MachineEntry => ({ id, name: id, online: true, snapshot: snap([room(`${id}-p`, [tab(`${id}-t`)])], id), failed: false, ...over });

  it('orders machines by name and leaves out the ones still loading', () => {
    const city = buildCityModel([entry('zeta'), entry('alpha'), entry('mid', { snapshot: null })], none);
    expect(city.machines.map((m) => m.id)).toEqual(['alpha', 'zeta']);
  });
  it('turns a failed machine into an empty error block and keeps the rest', () => {
    const city = buildCityModel([entry('a'), entry('b', { snapshot: null, failed: true })], none);
    expect(city.machines.map((m) => [m.id, m.notice, m.floor.rooms.length])).toEqual([['a', null, 1], ['b', 'error', 0]]);
  });
  it('tells offline from silent, offline winning, and darkens only an offline block', () => {
    const silent = snap([room('p', [tab('t')])], 's');
    silent.reachable = false;
    const city = buildCityModel([entry('o', { online: false }), entry('s', { snapshot: silent }), entry('k')], none);
    expect(city.machines.map((m) => [m.id, m.notice, m.lit])).toEqual([['k', null, true], ['o', 'offline', false], ['s', 'silent', true]]);
  });
  it('sums who needs you per machine and for the city', () => {
    const at = '2026-09-21T10:00:00.000Z';
    const waiting = (id: string) => tab(id, { state: 'waiting_input', state_at: at });
    const city = buildCityModel([entry('a', { snapshot: snap([room('p', [waiting('t1'), waiting('t2')])], 'a') }), entry('b', { snapshot: snap([room('q', [waiting('t3')])], 'b') })], none);
    expect(city.machines.map((m) => m.needsYou)).toEqual([2, 1]);
    expect(city.needsYou).toBe(3);
  });
  it('ignores a snapshot that belongs to another machine', () => {
    expect(buildCityModel([entry('a', { snapshot: snap([], 'someone-else') })], none).machines).toEqual([]);
  });
  it('truncates the label and keeps the name', () => {
    const long = 'm'.repeat(80);
    const m = buildCityModel([entry('a', { name: long })], none).machines[0];
    expect(m.name).toBe(long);
    expect(m.label.length).toBeLessThanOrEqual(28);
  });
});

describe('resolveFocus', () => {
  const city = buildCityModel(
    [{ id: 'm1', name: 'm1', online: true, failed: false, snapshot: snap([room('p1', [tab('t')])], 'm1') }, { id: 'm2', name: 'm2', online: true, failed: false, snapshot: snap([room('p2', [])], 'm2') }],
    none,
  );
  it('frames the city with no machine, an unknown machine, or before anything loaded', () => {
    expect(resolveFocus(city, undefined, null)).toEqual({ kind: 'city' });
    expect(resolveFocus(city, 'ghost', 'p1')).toEqual({ kind: 'city' });
    expect(resolveFocus(null, 'm1', 'p1')).toEqual({ kind: 'city' });
  });
  it('frames a machine, and a room only when it belongs to that machine', () => {
    expect(resolveFocus(city, 'm1', null)).toEqual({ kind: 'machine', machineId: 'm1' });
    expect(resolveFocus(city, 'm1', 'p1')).toEqual({ kind: 'room', machineId: 'm1', roomId: 'p1' });
    expect(resolveFocus(city, 'm1', 'p2')).toEqual({ kind: 'machine', machineId: 'm1' });
  });
  it('compares targets by value', () => {
    expect(sameFocus({ kind: 'room', machineId: 'a', roomId: 'r' }, { kind: 'room', machineId: 'a', roomId: 'r' })).toBe(true);
    expect(sameFocus({ kind: 'machine', machineId: 'a' }, { kind: 'city' })).toBe(false);
  });
});
```

- [ ] **Step 2: Run.** `DOCKER 'npx -w @termhub/web vitest run src/office/model.test.ts'` — Expected: FAIL (`buildCityModel` not exported).

- [ ] **Step 3: Implement** at the end of `apps/web/src/office/model.ts`:

```ts
/** What the page knows about one machine when it builds the city. */
export interface MachineEntry {
  id: string;
  name: string;
  /** false only when the status check said so; "still checking" counts as online */
  online: boolean;
  snapshot: OfficeSnapshot | null;
  /** the first read of this machine's snapshot failed */
  failed: boolean;
}

export type MachineNotice = 'offline' | 'silent' | 'error' | null;

export interface MachineModel {
  id: string;
  name: string;
  label: string;
  /** false for an offline machine: its block is drawn dark */
  lit: boolean;
  notice: MachineNotice;
  needsYou: number;
  floor: FloorModel;
}

export interface CityModel {
  machines: MachineModel[];
  needsYou: number;
}

const MACHINE_LABEL_MAX = 28;
const EMPTY_FLOOR: FloorModel = { rooms: [], needsYou: 0 };

/**
 * Every machine that has something to draw, in name order (the sidebar's): a loaded machine with
 * its floor, a failed one as an empty block. A machine still loading is left out — it joins when
 * its snapshot lands — and a snapshot for another machine counts as not loaded.
 */
export function buildCityModel(entries: MachineEntry[], liveTab: (tabId: string) => Tab | undefined): CityModel {
  const machines = entries
    .map((e): MachineModel | null => {
      const snapshot = e.snapshot && e.snapshot.machine.id === e.id ? e.snapshot : null;
      if (!snapshot && !e.failed) return null;
      const floor = snapshot ? buildModel(snapshot, liveTab) : EMPTY_FLOOR;
      const notice: MachineNotice = !snapshot ? 'error' : !e.online ? 'offline' : !snapshot.reachable ? 'silent' : null;
      return { id: e.id, name: e.name, label: truncateLabel(e.name, MACHINE_LABEL_MAX), lit: e.online, notice, needsYou: floor.needsYou, floor };
    })
    .filter((m): m is MachineModel => m !== null)
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return { machines, needsYou: machines.reduce((n, m) => n + m.needsYou, 0) };
}

export type FocusTarget = { kind: 'city' } | { kind: 'machine'; machineId: string } | { kind: 'room'; machineId: string; roomId: string };

/** What the URL asks the camera to frame, against what actually exists: never a room of another machine. */
export function resolveFocus(city: CityModel | null, machineId: string | undefined, roomId: string | null): FocusTarget {
  const machine = city?.machines.find((m) => m.id === machineId);
  if (!machine) return { kind: 'city' };
  if (roomId && machine.floor.rooms.some((r) => r.id === roomId)) return { kind: 'room', machineId: machine.id, roomId };
  return { kind: 'machine', machineId: machine.id };
}

export function sameFocus(a: FocusTarget, b: FocusTarget): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'city') return true;
  if (a.machineId !== (b as typeof a).machineId) return false;
  return a.kind === 'machine' || a.roomId === (b as typeof a).roomId;
}
```

Note the "offline winning" test: an offline machine whose failed flag is false and snapshot is loaded is `'offline'`; an offline machine with a failed read is `'error'` (there is nothing to draw).

- [ ] **Step 4: Run tests + typecheck.** `DOCKER 'npx -w @termhub/web vitest run src/office/model.test.ts && npm run typecheck -w @termhub/web'` — Expected: PASS.

- [ ] **Step 5: Commit** — `git commit -m "Office: city model and the focus target resolved against what exists"`

---

### Task 4: `useOfficeSnapshots` — one read per machine, in parallel

**Files:**
- Modify: `apps/web/src/lib/api.ts` (`office`)
- Create: `apps/web/src/office/useOfficeSnapshots.ts`, `apps/web/src/office/useOfficeSnapshots.test.tsx`
- Delete (in Task 6, when the page stops importing it): `useOfficeSnapshot.ts` and its test. In THIS task leave them in place so the build stays green.

**Interfaces:**
- Produces:

```ts
api.office(machineId: string, fresh = false)  // GET /office/<id> or /office/<id>?fresh=1

interface MachineSnapshotState { snapshot: OfficeSnapshot | null; failed: boolean }
function useOfficeSnapshots(machineIds: string[]): {
  byMachine: Record<string, MachineSnapshotState>;   // an entry per id in machineIds, always
  /** re-reads ONE machine, bypassing the server memo; false when a request for it is already in flight */
  reload: (machineId: string) => boolean;
}
```

Behaviour (same cadence as v1's hook, per machine): read every machine on mount and when an id is added; every 60 s while `document.visibilityState === 'visible'`; on window `focus` and on becoming visible, with a 10 s floor between those throttled reads (per machine); `reload(id)` is exempt from the floor and sends `fresh`. A failed re-read keeps the last snapshot (`failed` stays false); only a failed FIRST read sets `failed: true`, and a later success clears it. A response for a machine no longer in `machineIds` is dropped. Requests are independent: one that never resolves blocks nothing else. `machineIds` is compared by content (sorted, joined), not identity, so a new array with the same ids does not restart anything.

- [ ] **Step 1: Write the failing tests**, `apps/web/src/office/useOfficeSnapshots.test.tsx`. Follow the conventions of the existing `useOfficeSnapshot.test.tsx` (open it: `// @vitest-environment jsdom`, `afterEach(cleanup)`, `renderHook`, `vi.mock('../lib/api', …)` with controllable promises, fake timers where it uses them). Cases — write each as a real assertion on `result.current`:

  1. **reads every machine on mount**: `machineIds = ['a','b']` → `api.office` called once for each with `fresh` false; after both resolve, `byMachine.a.snapshot.machine.id === 'a'` and likewise `b`.
  2. **a slow machine does not hold the others**: `a` resolves, `b` never does → `byMachine.a.snapshot` is set while `byMachine.b` is `{ snapshot: null, failed: false }`.
  3. **a failed first read is an error block; a failed re-read is not**: `b` rejects on mount → `byMachine.b.failed === true`, `a` unaffected. Then: `a` succeeded, advance 60 s, `a` rejects → `byMachine.a.snapshot` still the first snapshot and `failed === false`.
  4. **a later success clears `failed`**.
  5. **`reload(id)` re-reads only that machine, fresh**: after mount, `reload('b')` → exactly one more call, `api.office('b', true)`; returns `true`; called again while pending → `false` and no new call.
  6. **the 10 s floor applies to focus, not to reload**: dispatch `focus` on `window` 1 s after mount → no new calls; `reload('a')` → a call.
  7. **hidden tab is not polled**: set `document.visibilityState` to `'hidden'` (the existing test shows how), advance 60 s → no calls; make it visible and dispatch `visibilitychange` after the floor → calls.
  8. **adding a machine reads only the new one; removing one drops its late response**: rerender with `['a','b','c']` → one call, for `c`. Start with `['a','b']`, leave `b` pending, rerender with `['a']`, resolve `b` → `byMachine` has no `b` key.
  9. **a new array with the same ids restarts nothing**: rerender with a fresh `['a','b']` → no new calls.

- [ ] **Step 2: Run.** `DOCKER 'npx -w @termhub/web vitest run src/office/useOfficeSnapshots.test.tsx'` — Expected: FAIL (module missing).

- [ ] **Step 3: Implement.** `apps/web/src/lib/api.ts`:

```ts
  office: (machineId: string, fresh = false) => request<OfficeSnapshot>('GET', `/office/${encodeURIComponent(machineId)}${fresh ? '?fresh=1' : ''}`),
```

`apps/web/src/office/useOfficeSnapshots.ts`:

```ts
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api';
import type { OfficeSnapshot } from '../lib/types';

const REFRESH_MS = 60_000;
/** Floor of the gap between two reads of one machine asked for by window focus or by the tab becoming visible. */
const MIN_GAP_MS = 10_000;

export interface MachineSnapshotState {
  snapshot: OfficeSnapshot | null;
  /** the FIRST read failed; a failed re-read keeps the last snapshot and is not an error */
  failed: boolean;
}

const EMPTY: MachineSnapshotState = { snapshot: null, failed: false };

/**
 * The floor snapshot of every machine, each read on its own: a block appears as soon as its
 * machine answers, and a machine that is slow or down delays only itself. Same cadence as a single
 * floor had — mount, every minute while the browser tab is visible, window focus and becoming
 * visible (10 s apart at least), and `reload(id)` when the monitor names a tab that machine's
 * snapshot lacks. `reload` skips the floor and asks the server for a fresh tmux probe: the tab is
 * already on screen and must not read as "no session yet" from the server's memo.
 */
export function useOfficeSnapshots(machineIds: string[]): { byMachine: Record<string, MachineSnapshotState>; reload: (machineId: string) => boolean } {
  const key = [...machineIds].sort().join('\n');
  const ids = useMemo(() => (key ? key.split('\n') : []), [key]);
  const [states, setStates] = useState<Record<string, MachineSnapshotState>>({});
  const wanted = useRef(new Set<string>());
  const inFlight = useRef(new Set<string>());
  const lastRead = useRef(new Map<string, number>());

  const read = useCallback((id: string, opts: { throttled?: boolean; fresh?: boolean } = {}): boolean => {
    if (!wanted.current.has(id) || inFlight.current.has(id)) return false;
    if (opts.throttled && Date.now() - (lastRead.current.get(id) ?? 0) < MIN_GAP_MS) return false;
    lastRead.current.set(id, Date.now());
    inFlight.current.add(id);
    api
      .office(id, opts.fresh ?? false)
      .then((snapshot) => {
        if (wanted.current.has(id)) setStates((s) => ({ ...s, [id]: { snapshot, failed: false } }));
      })
      .catch(() => {
        if (wanted.current.has(id)) setStates((s) => (s[id]?.snapshot ? s : { ...s, [id]: { snapshot: null, failed: true } }));
      })
      .finally(() => inFlight.current.delete(id));
    return true;
  }, []);

  // the set of machines: read the new ones, forget the ones that left
  useEffect(() => {
    const next = new Set(ids);
    const added = ids.filter((id) => !wanted.current.has(id));
    wanted.current = next;
    setStates((s) => {
      const kept = Object.fromEntries(Object.entries(s).filter(([id]) => next.has(id)));
      return Object.keys(kept).length === Object.keys(s).length ? s : kept;
    });
    for (const id of [...lastRead.current.keys()]) if (!next.has(id)) lastRead.current.delete(id);
    for (const id of added) read(id);
  }, [ids, read]);

  useEffect(() => {
    const all = (throttled: boolean) => {
      if (document.visibilityState !== 'visible') return;
      for (const id of wanted.current) read(id, { throttled });
    };
    const timer = setInterval(() => all(false), REFRESH_MS);
    const onFocus = () => all(true);
    const onVisible = () => all(true);
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [read]);

  const byMachine = useMemo(() => Object.fromEntries(ids.map((id) => [id, states[id] ?? EMPTY])), [ids, states]);
  const reload = useCallback((machineId: string) => read(machineId, { fresh: true }), [read]);
  return { byMachine, reload };
}
```

Known subtlety to verify with test 8: a machine removed while its request is in flight leaves its id in `inFlight` until that request settles; if the machine is re-added before then, its read is skipped once and picked up by the next tick. If test 8's re-add variant matters to you, clear `inFlight` for removed ids and guard the late response with a per-id generation counter — say which you chose in the report.

- [ ] **Step 4: Run tests + typecheck.** `DOCKER 'npx -w @termhub/web vitest run src/office/useOfficeSnapshots.test.tsx && npm run typecheck -w @termhub/web'` — Expected: PASS.

- [ ] **Step 5: Commit** — `git commit -m "Office: read every machine's snapshot on its own"`

---

### Task 5: The scene draws a city

**Files:**
- Modify: `apps/web/src/office/scene/OfficeScene.ts`, `Overlay.ts`, `RoomView.ts`, `apps/web/src/office/harness.ts`
- The page still uses the old scene API until Task 6 — so this task ALSO adapts `apps/web/src/pages/OfficePage.tsx` minimally to compile: wrap its single `FloorModel` as a one-machine `CityModel` and call `focus(...)` instead of `focusRoom(...)`. Do not restructure the page here; `OfficePage.test.tsx`'s fake scene must be updated to the new method names and keep all its cases green.

**Interfaces:**
- Consumes: `CityModel`, `MachineModel`, `FocusTarget`, `sameFocus` (Task 3); `layoutCity`, `roomOnCity`, `blockBounds`, `cityBounds`, `PlacedBlock`, `CityLayout` (Task 2); everything the scene already uses.
- Produces (the page in Task 6 builds on exactly this):

```ts
interface SceneHandlers {
  onPickDesk(deskId: string, projectId: string): void;
  onPickRoom(machineId: string, roomId: string): void;
  onPickMachine(machineId: string): void;
  onPickSign(roomId: string): void;          // a room's sign → open the project
  /** the person zoomed out far enough that the current rest no longer describes the view: go up one */
  onGoUp(): void;
}
class OfficeScene {
  constructor(handlers: SceneHandlers);
  mount(host: HTMLElement): Promise<void>;    // unchanged contract
  destroy(): void;
  setModel(model: CityModel): void;
  focus(target: FocusTarget, snap?: boolean): void;   // replaces focusRoom
  debugHover(deskId: string | null): void;
  readonly fps: number; frameMs: number; readonly rendererName: string;
}
```

**Required behaviour**

1. **Layout.** `layoutCity(model.machines.map((m) => ({ id: m.id, rooms: m.floor.rooms.map((r) => ({ id: r.id, desks: r.desks.length })) })))`. Every room is drawn at `roomOnCity(block, room)`. Depth (`zIndex = depthOf(cell)`) uses CITY cells, in the one sorted `things` container.
2. **Block ground.** New `drawBlock(block: PlacedBlock, lit: boolean, into?: Graphics): Graphics` in `RoomView.ts`: one flat diamond over the block's footprint grown by one tile on every side, a shade darker than a room's floor (lit `0x1b1f28`, dark `0x13151b`), `eventMode = 'static'`, `cursor = 'pointer'`; added to the `floor` layer BEFORE that block's rooms so rooms paint over it. Its `pointertap` → `onPickMachine(machineId)`. Repaints in place when `lit` changes, like a room.
3. **Rooms of an unlit machine are drawn dark** (`drawRoom(placed, room.lit && machine.lit)`), and that too repaints in place when the machine's `lit` changes.
4. **Machine signs.** New `MachineSign` in `Overlay.ts`, modelled on `RoomSign` (same outlined text helper, no plate): name at 16 px bold; a detail line made of `notice` — `offline` → "offline", `silent` → "sem resposta", `error` → "não foi possível carregar" — and the counter ("1 precisa de você" / "N precisam de você") joined by " · "; detail in attention orange when `needsYou > 0`, muted otherwise; alpha 0.6 when `!lit`. Anchored above the block's back corner (`toScreen(block.origin).y - WALL_H - 30`). `pointertap` → `onPickMachine`. `zIndex` below desk overlays (markers win), like room signs.
5. **Detail by zoom.** A constant `ROOM_SIGN_SCALE = 0.7`: room signs are visible when the focus is a machine or a room of THAT machine, or when `view.scale >= ROOM_SIGN_SCALE`; machine signs are visible when the focus is the city, or `view.scale < ROOM_SIGN_SCALE`, or the sign belongs to a machine other than the focused one. Markers at every zoom (unchanged). Desk labels and bars: unchanged rule — the focused room's desks, or every desk when nothing narrower than a machine is focused and `scale >= LABEL_SCALE`.
6. **Diffing.** `shapeOf(city)` = machines (id, order) → rooms (id, order) → desks (`id:kind`, order). Same shape → apply in place: desks, room signs, machine signs, and the `lit` repaints of 2 and 3. Different shape → rebuild. `notice`, names and counters are NOT shape.
7. **Camera rule on rebuild — unchanged from v1:** the first build frames the current target and snaps. A later rebuild re-frames (eased) only when the target is a machine or a room that still exists; when the target is the city, re-frame ONLY while `!userMoved`; otherwise leave the camera where the person put it. If the target no longer exists, fall back to `{ kind: 'city' }` without moving the camera.
8. **`focus(target, snap)`**: frames `cityBounds` / `blockBounds(block, WALL_H + SIGN_H + 30)` / the room's `placedRoomBounds(roomOnCity(...), WALL_H + SIGN_H)`; stores the target (so it is replayed after mount and after a rebuild); records the scale it framed at; clears `userMoved`. Safe before `mount()` and a no-op after `destroy()`.
9. **`onGoUp`**: in `camera.onUserMove`, when the target is a room or a machine and `camera.target.scale < framedScale * 0.6`, call `handlers.onGoUp()` once per framing (guard against firing on every wheel tick: reset the guard in `focus`).
10. **Resize** (keep the `ResizeObserver`): on renderer resize, re-frame the current target unless it is the city and `userMoved`.
11. **Clicks.** A room's ground → `onPickRoom(machineId, roomId)`; a desk → `onPickDesk`; a room sign → `onPickSign`; block ground or machine sign → `onPickMachine`. The `clicked()` drag guard wraps all of them.
12. **Teardown** unchanged: textures, source, camera, observer, listeners.

- [ ] **Step 1: Harness first** — `apps/web/src/office/harness.ts`: build a `CityModel` through `buildCityModel` from synthetic snapshots. Params: `machines=N` (default 3), `rooms`, `desks` as today per machine (vary the counts per machine so blocks differ in size), `machine=<i>` and `room=<j>` to open focused (`focus({kind:'machine'…})` / `{kind:'room'…}`), `offline=<i>` (that entry `online: false`), `silent=<i>` (`reachable: false`), `error=<i>` (`snapshot: null, failed: true`), `hover=<deskId>`, `grow=1`, `still=1`. `onPickMachine` → `scene.focus({ kind: 'machine', machineId })`; `onPickRoom` → room; `onGoUp` → one rest up. Keep the HUD line.

- [ ] **Step 2: Implement** items 1–12. Keep files focused: if `OfficeScene.ts` passes ~330 lines, move the visibility rules of item 5 into a small pure helper in `scene/detail.ts` (`signVisibility(target, scale, machineId) → { roomSigns: boolean; machineSign: boolean }`) and unit-test it — it is pure and needs no Pixi.

- [ ] **Step 3: Adapt `OfficePage.tsx` minimally** so the app compiles and behaves as before: build `{ machines: [ { id, name, label, lit, notice: null, needsYou, floor: model } ], needsYou }` from its single `FloorModel` (use `buildCityModel` with one entry), call `scene.focus(room ? { kind: 'room', machineId, roomId: room } : { kind: 'machine', machineId })`, map `onPickRoom(_machineId, roomId)` to `setRoom(roomId)`, `onGoUp` to `setRoom(null, true)`, `onPickMachine` to a no-op. Update the fake scene in `OfficePage.test.tsx` (`focus` instead of `focusRoom`, record targets) and its assertions; every existing case must still pass.

- [ ] **Step 4: Verify by screenshot.** Vite in a container on `127.0.0.1:5199` (`office-vite`, removed afterwards), Playwright image, PNGs to `/tmp/office-shots/` — the procedure of v1's harness check:

```bash
docker run -d --rm --name office-vite -u "$(id -u):$(id -g)" -e HOME=/tmp -e VITE_HOST=0.0.0.0 -p 127.0.0.1:5199:5173 -v "$PWD:/w" -w /w node:20 npm run dev -w @termhub/web
mkdir -p /tmp/office-shots && cat > /tmp/office-shots/city.mjs <<'EOF'
import { chromium } from 'playwright';
const b = await chromium.launch({ args: ['--enable-unsafe-swiftshader'] });
const shots = [['city', 'still=1&machines=4'], ['city-one', 'still=1&machines=1'], ['city-states', 'still=1&machines=4&offline=1&silent=2&error=3'], ['machine', 'still=1&machines=4&machine=1'], ['room', 'still=1&machines=4&machine=1&room=1'], ['city-many', 'still=1&machines=9&rooms=8&desks=10'], ['grow', 'still=1&machines=4&grow=1']];
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
await b.close();
EOF
docker run --rm --network host --ipc=host -v /tmp/office-shots:/s -w /tmp mcr.microsoft.com/playwright:v1.63.0-noble sh -c 'npm i playwright@1.63.0 --no-audit --no-fund >/dev/null 2>&1 && cp /s/city.mjs . && node city.mjs'
docker rm -f office-vite
```

`no page errors` seven times. **Open every PNG with the Read tool and check by eye**, saying per shot what you see: (city) every block whole, separated by a visible gap, each with its machine sign; NO room signs; markers readable; nothing covers a person; (city-states) the offline block dark with "offline", the silent one lit with "sem resposta" and people still in it, the error one an empty block with "não foi possível carregar"; (machine) that block framed whole with its room signs, other machines' signs still readable where visible; (room) only that room's desks labelled; (city-many) no block overlaps another, signs do not pile on top of each other illegibly; (grow) canvas fills the widened host and the city is centred. Fix what is wrong and re-shoot before committing — sign offsets, `ROOM_SIGN_SCALE` and block margin are the expected knobs.

- [ ] **Step 5: Verify.** `DOCKER 'npm run typecheck -w @termhub/web && npm test -w @termhub/web && npm run build -w @termhub/web'` and `grep -rln "from 'pixi.js'" apps/web/src | grep -v '^apps/web/src/office/\(scene\|pack\)/'` (must print nothing).

- [ ] **Step 6: Commit** — `git commit -m "Office: the scene draws the whole city; focus(target) frames city, machine or room"`

---

### Task 6: The page — the city, the breadcrumb, the Esc ladder

**Files:**
- Modify: `apps/web/src/pages/OfficePage.tsx`, `apps/web/src/pages/OfficePage.test.tsx`
- Delete: `apps/web/src/office/useOfficeSnapshot.ts`, `apps/web/src/office/useOfficeSnapshot.test.tsx`

**Interfaces:**
- Consumes: `useOfficeSnapshots` (Task 4); `buildCityModel`, `resolveFocus`, `sameFocus`, `missingTabIds`, `MachineEntry`, `FocusTarget` (Tasks 3 and v1); `OfficeScene` with `focus`/`setModel` and the five handlers (Task 5); `useData()` → `{ machines, projects, statuses, loading }`; `useMonitor()` → `{ items, needsYou, tabState, connected }`.

**Required behaviour**

1. **Snapshots:** `useOfficeSnapshots(machines.map((m) => m.id))`. Entries: `{ id, name, online: statuses[id] !== 'offline', snapshot, failed }`. `city = useMemo(() => buildCityModel(entries, tabState), [entries…, items])` — keep `items` as a dependency with the v1 comment explaining why.
2. **One scene per visit.** The scene-mount effect depends on `[host]` ONLY — `machineId` leaves its dependency list; delete the per-machine `modelRef`/`focusRef` clearing and the `currentSnapshot` gate (the city model's own "snapshot belongs to this machine" rule replaces it). Handlers still go through the effect-synced ref; a fresh scene is still seeded with the current city model and focus target.
3. **Focus target:** `target = resolveFocus(city, machineId, room)`; an effect calls `scene.focus(target)` when the target changes BY VALUE (`sameFocus`) or when the first model arrives. An unknown `machineId` or a `?room=` of another machine never throws and frames what `resolveFocus` says.
4. **URL moves:** `onPickMachine(id)` → `navigate('/office/' + id + keepFocusQuery)` (push); `onPickRoom(machineId, roomId)` → navigate to `/office/<machineId>?room=<roomId>` (push; works from the city too); `onGoUp`, `Esc` and the breadcrumb go up with `replace`. Preserve `?focus=1` across every one of these (build the query from the current params, dropping/setting only `room`).
5. **Esc ladder:** room → machine → city → leave focus mode. With a single machine, "city" is skipped (machine → leave focus), because auto-drill would send it straight back.
6. **Auto-drill:** at `/office` with exactly ONE machine in `useData().machines`, `navigate('/office/<id>', { replace: true })`. With several, stay on the city. Once per arrival at a machine URL with no `?room=` — reached by auto-drill or by a direct load, NOT by clicking a block — a machine with exactly one room that has desks opens that room (`replace`). Track "arrived by click" in a ref set by `onPickMachine`.
7. **Invalid machine in the URL** (`machineId` not in `machines` once `loading` is false) → `<Navigate to="/office" replace />` (no longer "the first machine").
8. **Re-read for newly missing tabs, per machine:** for each machine, `missingTabIds(snapshotOfThatMachine, monitorTabIds, nonArchivedProjectIdsOfThatMachine, projectOf)`; keep ONE notified-id set per machine; call `reload(machineId)` only when that machine's missing set grew, and mark ids only when `reload` returned `true`.
9. **Top bar:** "Escritório", then the breadcrumb `Cidade › <machine name> › <project name>` — each part a button that navigates (replace) to that rest; the last part is plain text. With a single machine the "Cidade" part is not rendered. The machine `<select>` and the "voltar ao andar" button are removed. Status notices: `reconectando…` always (top bar, and the focus-mode corner); "máquina offline" and "sem resposta do tmux: estado pode estar desatualizado" only when the target is a machine or a room and refer to THAT machine (at the city rest the block's sign says it).
10. **Overlays:** "Carregando a cidade…" while no machine has a snapshot and none failed; the no-machines message and the permission redirect unchanged; the WebGL failure message unchanged; the floor-wide CSS dimming (`opacity-60`) is removed — blocks darken themselves.
11. **Focus mode** and the `F` key unchanged.

- [ ] **Step 1: Rewrite the render test first** (`OfficePage.test.tsx`, fake scene recording constructions, `destroyed`, `models`, `targets`). Keep the cases that still apply and add the new ones; each must fail against the current page before you change it:
  - one scene is constructed even though `useData().loading` is true at first; it receives a city model;
  - **the same scene instance survives** city → machine (`onPickMachine`) → room (`onPickRoom`) → `Esc` → `Esc`, across `?focus=1`, and `destroy` is never called; `targets` ends with room, machine, city in that order;
  - with ONE machine, `/office` redirects to `/office/<id>`, and `Esc` from the machine does not navigate to the city;
  - with several machines `/office` stays on the city and the scene is asked to frame `{ kind: 'city' }`;
  - `/office/ghost` redirects to `/office`; `/office/m1?room=<a room of m2>` frames machine `m1`, not the room;
  - auto-drill into the only room with desks happens on a direct load of `/office/m1`, and does NOT happen after `onPickMachine('m1')` from the city;
  - a slow machine: `m1` resolves, `m2` pending → the model handed to the scene has only `m1`; when `m2` resolves, the same scene gets a model with both;
  - `?focus=1` is preserved by `onPickMachine`, `onPickRoom` and `Esc`;
  - the breadcrumb renders `Cidade › m1 › p1` inside a room and clicking "Cidade" frames the city;
  - with focus on and `connected: false`, "reconectando…" is visible (v1 case, kept).

- [ ] **Step 2: Run** — `DOCKER 'npx -w @termhub/web vitest run src/pages/OfficePage.test.tsx'` — Expected: the new cases FAIL.

- [ ] **Step 3: Implement** the page per items 1–11; delete the two `useOfficeSnapshot` files; keep `Message`, `Overlay`, `StatusNotices` helpers, adapting `StatusNotices` to item 9.

- [ ] **Step 4: Verify.** `DOCKER 'npm run typecheck -w @termhub/web && npm test -w @termhub/web && npm run build -w @termhub/web'`; report the main `index-*.js` size and the `OfficePage-*.js` chunk size; run the pixi-import grep.

- [ ] **Step 5: Commit** — `git commit -m "Office: /office is the city; breadcrumb, Esc ladder, one scene per visit"`

---

### Task 7: Spec truth, full verification, pull request

**Files:**
- Modify: `docs/superpowers/specs/2026-09-21-office-world-design.md`

- [ ] **Step 1: Make the spec describe what was built**, in its own voice (rewrite sentences in place, no changelog): the Status line (v2 implemented on `feat/office-city`, pending review/merge); any value the implementation settled differently (`ROOM_SIGN_SCALE`, the block ground and its margin, sign anchors, the `?fresh=1` bypass of the probe memo and why — section 7); the single-machine Esc ladder; the auto-drill-into-a-room rule as implemented.

- [ ] **Step 2: Full verification** with a throwaway Postgres, exactly as v1's final check (container `office-pg` on `127.0.0.1:55432`, `TERMHUB_DB_TESTS=1`, `DATABASE_URL=postgresql://postgres:pw@127.0.0.1:55432/termhub_test`, `npx prisma migrate deploy` from `apps/server` first; remove the container afterwards): `npm ci`, `prisma:generate`, `build:packages`, server typecheck, server tests, web typecheck, web tests, web build, landing build. Capture the full output to a file under `/tmp/office-verify/`; report each command's exit code and the pass/fail counts. Baseline on `origin/main` at the time of writing: server 714 passed / 6 skipped, web 362 passed.

- [ ] **Step 3: Re-run Task 5's screenshot check** and look at the images again.

- [ ] **Step 4 (controller, after the whole-branch review):** merge `origin/main` into the branch if it moved, re-verify, push, open the PR.

- [ ] **Step 5 (after merge and deploy):** open `https://app.termhub.dev/office` logged in: every machine shows as a block; a waiting tab on any machine is noticeable from the city; block → machine → room → `Esc` → `Esc` never blanks the canvas; focus mode keeps working through all of it; v1 links (`/office/<id>?room=<id>`) still land in the room.
