# Public City Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A machine's owner flips one switch on a project and their city becomes readable at `termhub.dev/city/@nickname` — the same office scene, live, with no account and no Cloudflare Access.

**Architecture:** A nullable nickname on `User` addresses a city; a boolean on `Project` publishes a room. A mapper of its own (`toPublicCity`) builds the public payload field by field from the same data the office reads, replacing every real id with a one-way derived id. Two public surfaces serve it — a REST snapshot and a websocket fed by the existing `monitorBus` — and a second Vite bundle, built from the app's own source with base `/city/`, renders it with the same PixiJS scene and none of the private app.

**Tech Stack:** Fastify + Prisma + zod (server), `ws` (websocket), React 18 + PixiJS 8 + Vite (web), Vitest, nginx (vhost template rendered by `deploy/blue-green.sh`).

**Spec:** `docs/superpowers/specs/2026-09-22-public-city-design.md`

## Global Constraints

- Code, comments, commit messages and docs in English; **UI copy in Portuguese (pt-BR)**.
- The host has no Node. Run everything through Docker from the repo root:
  `docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/w" -w /w node:20 sh -c '<cmd>'`, then `rm -rf .npm`. Below, `DOCKER '<cmd>'` means exactly that. Never pipe a test/typecheck/build command through `tail`/`head` in a way that hides its exit code.
- After a fresh `npm ci`, the server typecheck needs `npm run prisma:generate && npm run build:packages` first.
- Address workspaces by package name (`-w @termhub/server`, `-w @termhub/web`), never by path.
- Routes never import Prisma; go through repositories. Every request input validated with zod. Log metadata only — never a tab's name, never terminal content.
- **The privacy rule of this feature:** every public response and every public websocket frame is produced by `toPublicCity` / `toPublicRobot` in `apps/server/src/public/city.ts`, which name every field they emit. Never spread a `Tab`, `Project`, `Machine` or `User` into a public payload, and never reuse `buildOfficeSnapshot` for a public response.
- **The public bundle must not contain the private app.** `apps/web/src/city/**` may import from `apps/web/src/office/**` and `apps/web/src/lib/types.ts`, and nothing else from `apps/web/src/` — in particular not `lib/api.ts`, not `lib/monitor.tsx`, not `App.tsx`.
- PixiJS is imported only under `apps/web/src/office/scene/` and `apps/web/src/office/pack/`.
- Migrations are additive (one nullable column, one boolean with a default) and backward compatible: the previous container keeps serving during the blue/green switch.
- The public surfaces live on the `termhub.dev` vhost, which has **no** Cloudflare Access. Nothing about Access changes. The vhost is rendered from `deploy/nginx/termhub.dev.conf.tmpl` by `deploy/blue-green.sh` — edit the template, never a rendered file.
- Work on branch `docs/public-city-spec` (it carries the spec) or a branch cut from it. Do not push to `main`; open a PR at the end.

## Review Focus

1. **A nickname that collides** — another user's, in different case, or a reserved word (`city`, `api`, `ws`, `admin`, `www`, `static`, `assets`). It must be refused with a clear reason; two cities must never answer at one address. Pinned in Task 1.
2. **A project published on a machine with no owner** (`owner_id` is null — a seeded or orphaned machine). There is nobody to address the city to, so the switch must refuse. Pinned in Task 2.
3. **A tab of a private project on the same machine reaching the public channel.** The filter is by project, not by machine or owner. Pinned in Task 5.
4. **Unpublishing while a visitor is connected** — the socket closes and the deep link 404s, rather than the visitor keeping a live view of a room that is no longer public. Pinned in Tasks 4 and 5.
5. **A nickname that exists but has published nothing** — 404, exactly like an unknown nickname. An empty city would confirm which nicknames are taken. Pinned in Task 4.

---

## File Structure

```
apps/server/prisma/schema.prisma                     User.nickname; Project.isPublic
apps/server/prisma/migrations/<ts>_public_city/migration.sql

apps/server/src/db/repositories/types.ts             User.nickname, Project.is_public, public_id on Project/Machine
apps/server/src/db/repositories/users.ts             setNickname, findByNickname
apps/server/src/db/repositories/projects.ts          is_public through update()
apps/server/src/auth/routes.ts                       PATCH /me/nickname
apps/server/src/auth/nickname-route.test.ts   NEW
apps/server/src/routes/projects.ts                   the publish guard on PATCH /:id
apps/server/src/routes/projects.publish.test.ts NEW

apps/server/src/public/nickname.ts        NEW  validation + reserved words (shared by route and UI rules)
apps/server/src/public/city.ts            NEW  PublicCity types, publicId(), toPublicCity(), toPublicRobot()
apps/server/src/public/city.test.ts       NEW
apps/server/src/public/read.ts            NEW  the one read: nickname -> the city's rows (repositories only)
apps/server/src/routes/public-city.ts     NEW  GET /api/public/city/:nickname
apps/server/src/routes/public-city.test.ts NEW
apps/server/src/public/bus.ts             NEW  in-process "a project's public flag changed"
apps/server/src/public/ws.ts              NEW  /ws/public/:nickname
apps/server/src/public/ws.test.ts         NEW
apps/server/src/app.ts                    registration of the public route, the public ws and /city/*

apps/web/index-city.html                  NEW  the public entry's document
apps/web/vite.city.config.ts              NEW  base '/city/', outDir 'dist-city'
apps/web/src/city/main.tsx                NEW  the public app: router + three depths
apps/web/src/city/api.ts                  NEW  the public snapshot + the public socket
apps/web/src/city/CityPage.tsx            NEW  the scene, the top bar, the call to action
apps/web/src/city/CityPage.test.tsx       NEW
apps/web/src/lib/types.ts                 PublicCity types mirrored for the browser

apps/web/src/pages/ProjectPage.tsx        the switch
apps/web/src/components/NicknameDialog.tsx NEW  asked at first sign-in and before the first publish
apps/web/src/pages/OfficePage.tsx         the share button

deploy/nginx/termhub.dev.conf.tmpl        /city/, /api/public/, /ws/public/ locations
```

---

### Task 1: The nickname on the account

**Files:**
- Modify: `apps/server/prisma/schema.prisma`; Create: `apps/server/prisma/migrations/20260922170000_public_city/migration.sql`
- Create: `apps/server/src/public/nickname.ts`, `apps/server/src/public/nickname.test.ts`, `apps/server/src/auth/nickname-route.test.ts` (there is no test file for `auth/routes.ts` today — this one covers the route you add, not the rest of the file)
- Modify: `apps/server/src/db/repositories/types.ts`, `apps/server/src/db/repositories/users.ts`, `apps/server/src/db/repositories/users.db.test.ts`, `apps/server/src/auth/routes.ts`

**Interfaces:**
- Produces: `normalizeNickname(input: unknown): { ok: true; value: string } | { ok: false; reason: 'format' | 'reserved' }`; `RESERVED_NICKNAMES: readonly string[]`; `User.nickname: string | null` on the DTO and in `GET /api/auth/me`; `UsersRepository.setNickname(userId, nickname): Promise<'ok' | 'taken'>`; `UsersRepository.findByNickname(nickname): Promise<User | undefined>`; `PATCH /api/auth/me/nickname`.

- [ ] **Step 1: Write the failing validation tests.** Create `apps/server/src/public/nickname.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { normalizeNickname, RESERVED_NICKNAMES } from './nickname.js';

describe('normalizeNickname', () => {
  it('accepts a plain nickname and lowercases it', () => {
    expect(normalizeNickname('Pedro')).toEqual({ ok: true, value: 'pedro' });
    expect(normalizeNickname('  eng-inversa  ')).toEqual({ ok: true, value: 'eng-inversa' });
  });

  it('refuses what cannot be an address', () => {
    for (const bad of ['', 'ab', 'a'.repeat(31), 'pedro!', 'pedro goiania', 'pe_dro', '-pedro', 'pedro-', 'pedrõ', 42, null, undefined, {}]) {
      expect(normalizeNickname(bad as unknown)).toEqual({ ok: false, reason: 'format' });
    }
  });

  it('refuses the words the routes need', () => {
    for (const word of RESERVED_NICKNAMES) {
      expect(normalizeNickname(word)).toEqual({ ok: false, reason: 'reserved' });
      expect(normalizeNickname(word.toUpperCase())).toEqual({ ok: false, reason: 'reserved' });
    }
    expect(RESERVED_NICKNAMES).toContain('city');
    expect(RESERVED_NICKNAMES).toContain('api');
  });
});
```

- [ ] **Step 2: Run it.** `DOCKER 'npx -w @termhub/server vitest run src/public/nickname.test.ts'` — Expected: FAIL, the module does not exist.

- [ ] **Step 3: Implement.** Create `apps/server/src/public/nickname.ts`:

```ts
/**
 * A nickname is the address of a public city (`/city/@<nickname>`), so it lives in the same space as
 * the paths around it: the reserved list is every first segment the public host already answers.
 */
export const RESERVED_NICKNAMES = ['city', 'api', 'ws', 'mcp', 'admin', 'www', 'static', 'assets', 'health', 'login', 'office'] as const;

const SHAPE = /^[a-z0-9]([a-z0-9-]{1,28})[a-z0-9]$/;

export function normalizeNickname(input: unknown): { ok: true; value: string } | { ok: false; reason: 'format' | 'reserved' } {
  if (typeof input !== 'string') return { ok: false, reason: 'format' };
  const value = input.trim().toLowerCase();
  if (!SHAPE.test(value)) return { ok: false, reason: 'format' };
  if ((RESERVED_NICKNAMES as readonly string[]).includes(value)) return { ok: false, reason: 'reserved' };
  return { ok: true, value };
}
```

- [ ] **Step 4: Run it.** Same command — Expected: PASS.

- [ ] **Step 5: Schema and migration.** In `schema.prisma`, on `model User`, after `avatarUrl`:

```prisma
  /// The address of this person's public city (/city/@nickname). Null = no city. Unique, lowercase.
  nickname     String?   @unique
```

and on `model Project`, after `description`:

```prisma
  /// Published: this project's room, its tabs and its machine's name are readable by anyone with the link.
  isPublic       Boolean       @default(false) @map("is_public")
```

Create `apps/server/prisma/migrations/20260922170000_public_city/migration.sql`:

```sql
-- The public city: an address per person, a switch per project. Both additive: the previous
-- container neither selects nor writes these columns during the blue/green switch.
ALTER TABLE "users" ADD COLUMN "nickname" TEXT;
CREATE UNIQUE INDEX "users_nickname_key" ON "users"("nickname");

ALTER TABLE "projects" ADD COLUMN "is_public" BOOLEAN NOT NULL DEFAULT false;
```

Then `DOCKER 'npm run prisma:generate'`.

- [ ] **Step 6: Write the failing repository and route tests.** In `apps/server/src/db/repositories/users.db.test.ts`, inside the existing describe (follow the file's own setup):

```ts
  it('reserves a nickname once', async () => {
    const a = await repos.users.create({ email: 'a@x.dev', name: 'A' });
    const b = await repos.users.create({ email: 'b@x.dev', name: 'B' });
    expect(await repos.users.setNickname(a.id, 'pedro')).toBe('ok');
    expect(await repos.users.setNickname(b.id, 'pedro')).toBe('taken');
    expect((await repos.users.findByNickname('pedro'))?.id).toBe(a.id);
    expect(await repos.users.findByNickname('nobody')).toBeUndefined();
  });
```

Create `apps/server/src/auth/nickname-route.test.ts`, following the house pattern for route tests (`apps/server/src/routes/office.test.ts`: a bare Fastify, `applyErrorHandler`, a `preHandler` that injects `request.user` and `request.scope`, and stubbed repositories):

```ts
import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Repositories } from '../db/repositories/index.js';
import { applyErrorHandler } from '../lib/errors.js';
import { authRoutes } from './routes.js';

const setNickname = vi.fn();

function buildApp(user: { id: string; nickname: string | null }) {
  const app = Fastify();
  applyErrorHandler(app);
  app.addHook('preHandler', async (request) => {
    request.user = user as never;
    request.scope = { user, viewAs: { kind: 'self' }, ownerId: user.id, createAs: user.id } as never;
  });
  const repos = { users: { setNickname, findByNickname: vi.fn(async () => undefined) } } as unknown as Repositories;
  app.register((a) => authRoutes(a, { repos } as never), { prefix: '/auth' });
  return app;
}

const patch = (app: ReturnType<typeof buildApp>, nickname: unknown) => app.inject({ method: 'PATCH', url: '/auth/me/nickname', payload: { nickname } });

describe('PATCH /auth/me/nickname', () => {
  beforeEach(() => setNickname.mockReset().mockResolvedValue('ok'));

  it('claims a nickname, lowercased', async () => {
    const res = await patch(buildApp({ id: 'u1', nickname: null }), 'Pedro');
    expect(res.statusCode).toBe(200);
    expect(setNickname).toHaveBeenCalledWith('u1', 'pedro');
    expect(res.json().user.nickname).toBe('pedro');
  });

  it('refuses a reserved word and a bad shape without touching the database', async () => {
    for (const bad of ['city', 'ab', 'pe dro', 'pedro!']) {
      expect((await patch(buildApp({ id: 'u1', nickname: null }), bad)).statusCode).toBe(400);
    }
    expect(setNickname).not.toHaveBeenCalled();
  });

  it('answers 409 when another account already holds it', async () => {
    setNickname.mockResolvedValue('taken');
    const res = await patch(buildApp({ id: 'u2', nickname: null }), 'pedro');
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('NICKNAME_TAKEN');
  });
});
```

Check `authRoutes`' real second argument (the `AuthContext`) and pass a stub shaped like it; the route only needs `repos.users`.

- [ ] **Step 7: Run them.** `DOCKER 'npx -w @termhub/server vitest run src/db/repositories/users.db.test.ts src/auth/nickname-route.test.ts'` (the DB file needs the throwaway Postgres and `TERMHUB_DB_TESTS=1`, as the repo's other DB tests do) — Expected: FAIL, `setNickname` is not a function and the route is 404.

- [ ] **Step 8: Implement the repository.** In `apps/server/src/db/repositories/types.ts`, add `nickname: string | null;` to the `User` interface after `avatar_url`, emit it in the user mapper, add `is_public: boolean;` to `Project` after `description`, and emit `is_public: p.isPublic` in `mapProject`. In `apps/server/src/db/repositories/users.ts`:

```ts
  /** Claims a nickname for this user. 'taken' when another account already holds it (unique index). */
  async setNickname(userId: string, nickname: string): Promise<'ok' | 'taken'> {
    const holder = await this.db.user.findUnique({ where: { nickname } });
    if (holder && holder.id !== userId) return 'taken';
    await this.db.user.update({ where: { id: userId }, data: { nickname } });
    return 'ok';
  }

  async findByNickname(nickname: string): Promise<User | undefined> {
    const u = await this.db.user.findUnique({ where: { nickname } });
    return u ? mapUser(u) : undefined;
  }
```

- [ ] **Step 9: Implement the route.** In `apps/server/src/auth/routes.ts`, next to `GET /me` (authenticated — no `config.public`):

```ts
  app.patch('/me/nickname', async (request, reply) => {
    if (!request.user) throw unauthorized();
    const parsed = normalizeNickname((request.body as { nickname?: unknown } | null)?.nickname);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.reason === 'reserved' ? 'Esse apelido é reservado' : 'Use de 3 a 30 letras, números ou hífen', code: 'NICKNAME_INVALID' });
    const out = await auth.repos.users.setNickname(request.user.id, parsed.value);
    if (out === 'taken') return reply.code(409).send({ error: 'Esse apelido já é de outra pessoa', code: 'NICKNAME_TAKEN' });
    request.log.info({ userId: request.user.id }, 'nickname: claimed');
    return { user: await withRole({ ...request.user, nickname: parsed.value }) };
  });
```

Include `nickname` in whatever `GET /me` already returns for the user (it comes through the mapper, so check it is not stripped by `withRole`).

- [ ] **Step 10: Run them.** Same command as Step 7 — Expected: PASS. Then `DOCKER 'npm run typecheck -w @termhub/server'`.

- [ ] **Step 11: Commit.**

```bash
git add apps/server/prisma apps/server/src/public/nickname.ts apps/server/src/public/nickname.test.ts apps/server/src/auth apps/server/src/db
git commit -m "Accounts: a nickname addresses a public city"
```

Note for Task 2: this commit also adds `Project.isPublic` to the schema and the migration, because one migration for the whole feature is cheaper than two and the column is inert until a route writes it. `mapProject` emits `is_public` from here on.

---

### Task 2: The switch on the project

**Files:**
- Modify: `apps/server/src/db/repositories/projects.ts`, `apps/server/src/routes/projects.ts`
- Create: `apps/server/src/routes/projects.publish.test.ts` (there is no test file for `routes/projects.ts` today — this one covers the publish guard, not the rest of the file)

**Interfaces:**
- Consumes: `Project.is_public`, `User.nickname` (Task 1).
- Produces: `PATCH /api/projects/:id` accepts `is_public: boolean`; it refuses with 403 `NOT_OWNER` unless the caller owns the machine, with 409 `NICKNAME_REQUIRED` when the caller has no nickname, and with 409 `MACHINE_UNOWNED` when the machine has no owner.

- [ ] **Step 1: Write the failing route tests.** Create `apps/server/src/routes/projects.publish.test.ts`, following the house pattern (`office.test.ts`): a bare Fastify, `applyErrorHandler`, a `preHandler` that injects the caller, and stubbed repositories. `scoped(repos, request).project(id)` is what the route uses to load the project and its machine — stub the repositories it reads rather than mocking `scoped` itself, so the real ownership path runs.

```ts
import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Repositories } from '../db/repositories/index.js';
import { applyErrorHandler } from '../lib/errors.js';
import { projectRoutes } from './projects.js';

const update = vi.fn();

const PROJECTS: Record<string, unknown> = {
  p1: { id: 'p1', machine_id: 'm1', name: 'Engage Easy', cwd: '/w', status: 'active', description: null, is_public: false },
  p2: { id: 'p2', machine_id: 'm2', name: 'Órfão', cwd: '/w', status: 'active', description: null, is_public: false },
  p3: { id: 'p3', machine_id: 'm1', name: 'Já público', cwd: '/w', status: 'active', description: null, is_public: true },
};
const MACHINES: Record<string, unknown> = {
  m1: { id: 'm1', name: 'Jarvis', owner_id: 'u1' },
  m2: { id: 'm2', name: 'Sem dono', owner_id: null },
};

function buildApp(user: { id: string; nickname: string | null }) {
  const app = Fastify();
  applyErrorHandler(app);
  app.addHook('preHandler', async (request) => {
    request.user = user as never;
    request.scope = { user, viewAs: { kind: 'self' }, ownerId: user.id, createAs: user.id } as never;
  });
  const repos = {
    projects: { findById: vi.fn(async (id: string) => PROJECTS[id]), update },
    machines: { findById: vi.fn(async (id: string) => MACHINES[id]) },
  } as unknown as Repositories;
  app.register((a) => projectRoutes(a, repos), { prefix: '/projects' });
  return app;
}

const owner = { id: 'u1', nickname: 'pedro' };
const ownerNoNick = { id: 'u1', nickname: null };
const stranger = { id: 'u2', nickname: 'outro' };
const patch = (user: { id: string; nickname: string | null }, id: string, body: unknown) =>
  buildApp(user).inject({ method: 'PATCH', url: `/projects/${id}`, payload: body });

describe('PATCH /projects/:id is_public', () => {
  beforeEach(() => update.mockReset().mockImplementation(async (id: string, p: Record<string, unknown>) => ({ ...(PROJECTS[id] as object), ...p })));

  it('publishes when the caller owns the machine and has a nickname', async () => {
    const res = await patch(owner, 'p1', { is_public: true });
    expect(res.statusCode).toBe(200);
    expect(res.json().project.is_public).toBe(true);
    expect(update).toHaveBeenCalledWith('p1', expect.objectContaining({ is_public: true }));
  });

  it('refuses a caller who does not own the machine', async () => {
    const res = await patch(stranger, 'p1', { is_public: true });
    expect([403, 404]).toContain(res.statusCode);
    expect(update).not.toHaveBeenCalled();
  });

  it('refuses when the owner has no nickname yet', async () => {
    const res = await patch(ownerNoNick, 'p1', { is_public: true });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('NICKNAME_REQUIRED');
    expect(update).not.toHaveBeenCalled();
  });

  it('refuses on a machine with no owner', async () => {
    const res = await patch(owner, 'p2', { is_public: true });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('MACHINE_UNOWNED');
  });

  it('unpublishing needs none of that', async () => {
    const res = await patch(ownerNoNick, 'p3', { is_public: false });
    expect(res.statusCode).toBe(200);
    expect(update).toHaveBeenCalledWith('p3', expect.objectContaining({ is_public: false }));
  });
});
```

The stranger case accepts 403 or 404: `scoped(...)` may refuse a project on a machine the caller cannot see before the publish guard is reached, and hiding it is at least as good as refusing it. Check which one it is while implementing and narrow the assertion to that one.

Check `projectRoutes`' real export name and argument list before writing the registration line.

- [ ] **Step 2: Run them.** `DOCKER 'npx -w @termhub/server vitest run src/routes/projects.publish.test.ts'` — Expected: FAIL, `is_public` is stripped by the patch body schema.

- [ ] **Step 3: Implement.** In `apps/server/src/db/repositories/projects.ts`, carry the field through `create` (`isPublic: input.is_public ?? false`) and `update` (`isPublic: next.is_public`), and add `is_public?: boolean` to `ProjectInput`. In `apps/server/src/routes/projects.ts`, extend the create body schema with `is_public: z.boolean().optional()` (so `patchBody`, derived from it, accepts it) and guard the publish inside the existing `app.patch('/:id')`, after `scoped(...).project(id)`:

```ts
    if (patch.is_public === true && !current.is_public) {
      if (!machine.owner_id) return reply.code(409).send({ error: 'Essa máquina não tem dono', code: 'MACHINE_UNOWNED' });
      if (machine.owner_id !== request.user.id) return reply.code(403).send({ error: 'Só quem é dono da máquina pode publicar', code: 'NOT_OWNER' });
      if (!request.user.nickname) return reply.code(409).send({ error: 'Escolha seu apelido antes de publicar', code: 'NICKNAME_REQUIRED' });
    }
```

Turning it off takes no guard: the route's own scope already decided the caller may edit this project, and stopping a publication must never be harder than starting one. Declare `reply` in the handler's signature if it is not there yet.

- [ ] **Step 4: Run them.** Same command — Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add apps/server/src/db/repositories/projects.ts apps/server/src/routes/projects.ts apps/server/src/routes/projects.publish.test.ts
git commit -m "Projects: the switch that publishes a room"
```

---

### Task 3: The public payload

**Files:**
- Create: `apps/server/src/public/city.ts`, `apps/server/src/public/city.test.ts`

**Interfaces:**
- Consumes: `Machine`, `Project`, `Tab`, `OfficeTabProgress` from `db/repositories/types.js`.
- Produces:

```ts
export interface PublicRobot { id: string; name: string; kind: Tab['kind']; state: TabState | null; state_at: string | null; activity: TabActivity | null; alive: boolean; progress: { done: number; total: number } | null }
export interface PublicRoom { id: string; name: string; robots: PublicRobot[] }
export interface PublicBuilding { id: string; name: string; rooms: PublicRoom[] }
export interface PublicCity { nickname: string; owner_name: string; buildings: PublicBuilding[] }
export function publicId(kind: 'machine' | 'project' | 'tab', realId: string): string;
export function toPublicRobot(tab: Tab, opts: { alive: boolean; progress: OfficeTabProgress | null }): PublicRobot;
export function toPublicCity(input: { nickname: string; ownerName: string; buildings: { machine: Machine; rooms: { project: Project; tabs: { tab: Tab; alive: boolean; progress: OfficeTabProgress | null }[] }[] }[] }): PublicCity;
```

- [ ] **Step 1: Write the failing tests.** Create `apps/server/src/public/city.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { publicId, toPublicCity, toPublicRobot } from './city.js';
import type { Machine, Project, Tab } from '../db/repositories/types.js';

const tab = (over: Partial<Tab> = {}): Tab => ({
  id: 't1', project_id: 'p1', name: 'corrigir o cliente ACME', kind: 'terminal', tmux_session: 'th-t1', simulator_udid: null,
  position: 0, state: 'working', state_text: 'rodando os testes', state_tool: 'claude', state_at: '2026-09-22T10:00:00.000Z',
  state_seen_at: null, activity: 'coding', created_at: '2026-09-22T09:00:00.000Z', ...over,
});
const project = (over: Partial<Project> = {}): Project => ({ id: 'p1', machine_id: 'm1', name: 'Engage Easy', cwd: '/home/p/engageasy', status: 'active', description: 'o que eu não quero na rua', is_public: true, last_terminal_at: null, created_at: '2026-09-01T00:00:00.000Z', ...over });
const machine = (over: Partial<Machine> = {}): Machine => ({ id: 'm1', name: 'Jarvis', host: '10.0.0.9', ssh_user: 'pedro', ssh_port: 22, type: 'agent', os: 'linux', capabilities: ['claude'], checked_at: null, agent_version: '0.4.1', agent_last_seen_at: null, agent_auto_update: true, is_local: false, owner_id: 'u1', created_at: '2026-09-01T00:00:00.000Z', ...over } as Machine);

describe('the public payload', () => {
  it('emits exactly the fields the public city is allowed to carry', () => {
    const city = toPublicCity({ nickname: 'pedro', ownerName: 'Pedro', buildings: [{ machine: machine(), rooms: [{ project: project(), tabs: [{ tab: tab(), alive: true, progress: { done: 2, total: 5 } }] }] }] });
    expect(Object.keys(city).sort()).toEqual(['buildings', 'nickname', 'owner_name']);
    expect(Object.keys(city.buildings[0]).sort()).toEqual(['id', 'name', 'rooms']);
    expect(Object.keys(city.buildings[0].rooms[0]).sort()).toEqual(['id', 'name', 'robots']);
    expect(Object.keys(city.buildings[0].rooms[0].robots[0]).sort()).toEqual(['activity', 'alive', 'id', 'kind', 'name', 'progress', 'state', 'state_at', 'state_seen_at'].filter((k) => k !== 'state_seen_at').sort());
  });

  it('carries nothing that describes the machine or the person beyond a name', () => {
    const body = JSON.stringify(toPublicCity({ nickname: 'pedro', ownerName: 'Pedro', buildings: [{ machine: machine(), rooms: [{ project: project(), tabs: [{ tab: tab(), alive: true, progress: null }] }] }] }));
    for (const secret of ['10.0.0.9', '/home/p/engageasy', 'o que eu não quero na rua', 'th-t1', 'u1', 'rodando os testes', 'claude']) {
      expect(body).not.toContain(secret);
    }
  });

  it('replaces every real id with one that is not the real id, and does it the same way twice', () => {
    const once = toPublicCity({ nickname: 'pedro', ownerName: 'Pedro', buildings: [{ machine: machine(), rooms: [{ project: project(), tabs: [{ tab: tab(), alive: true, progress: null }] }] }] });
    const twice = toPublicCity({ nickname: 'pedro', ownerName: 'Pedro', buildings: [{ machine: machine(), rooms: [{ project: project(), tabs: [{ tab: tab(), alive: true, progress: null }] }] }] });
    const b = once.buildings[0];
    expect(b.id).not.toBe('m1');
    expect(b.rooms[0].id).not.toBe('p1');
    expect(b.rooms[0].robots[0].id).not.toBe('t1');
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
    expect(publicId('tab', 't1')).not.toBe(publicId('project', 't1'));
  });

  it('a robot that is not working carries no activity and keeps its state', () => {
    const r = toPublicRobot(tab({ state: 'waiting_input', activity: null }), { alive: true, progress: null });
    expect(r.state).toBe('waiting_input');
    expect(r.activity).toBeNull();
  });
});
```

- [ ] **Step 2: Run it.** `DOCKER 'npx -w @termhub/server vitest run src/public/city.test.ts'` — Expected: FAIL, the module does not exist.

- [ ] **Step 3: Implement.** Create `apps/server/src/public/city.ts`:

```ts
import { createHash } from 'node:crypto';
import type { Machine, OfficeTabProgress, Project, Tab, TabActivity, TabState } from '../db/repositories/types.js';

/**
 * The public face of the office, and the only thing that reaches a visitor. Every field here was
 * written on purpose: nothing is spread, so a column added to Tab, Project or Machine tomorrow
 * stays inside the instance until somebody adds it here too.
 */
export interface PublicRobot {
  id: string;
  name: string;
  kind: Tab['kind'];
  state: TabState | null;
  state_at: string | null;
  activity: TabActivity | null;
  alive: boolean;
  progress: { done: number; total: number } | null;
}

export interface PublicRoom { id: string; name: string; robots: PublicRobot[] }
export interface PublicBuilding { id: string; name: string; rooms: PublicRoom[] }
export interface PublicCity { nickname: string; owner_name: string; buildings: PublicBuilding[] }

/**
 * A one-way id for the street. Real ids are random, so a hash of one cannot be walked back into it;
 * confirming a match needs the real id, which only someone who already has access holds. Same input,
 * same output on every container, so a snapshot from one and a socket frame from another agree
 * during a blue/green switch.
 */
export function publicId(kind: 'machine' | 'project' | 'tab', realId: string): string {
  return createHash('sha256').update(`${kind}:${realId}`).digest('base64url').slice(0, 22);
}

export function toPublicRobot(tab: Tab, opts: { alive: boolean; progress: OfficeTabProgress | null }): PublicRobot {
  return {
    id: publicId('tab', tab.id),
    name: tab.name,
    kind: tab.kind,
    state: tab.state,
    state_at: tab.state_at,
    activity: tab.activity,
    alive: opts.alive,
    progress: opts.progress ? { done: opts.progress.done, total: opts.progress.total } : null,
  };
}

export function toPublicCity(input: {
  nickname: string;
  ownerName: string;
  buildings: { machine: Machine; rooms: { project: Project; tabs: { tab: Tab; alive: boolean; progress: OfficeTabProgress | null }[] }[] }[];
}): PublicCity {
  return {
    nickname: input.nickname,
    owner_name: input.ownerName,
    buildings: input.buildings.map((b) => ({
      id: publicId('machine', b.machine.id),
      name: b.machine.name,
      rooms: b.rooms.map((r) => ({
        id: publicId('project', r.project.id),
        name: r.project.name,
        robots: r.tabs.map((t) => toPublicRobot(t.tab, { alive: t.alive, progress: t.progress })),
      })),
    })),
  };
}
```

Check `OfficeTabProgress`'s real field names in `db/repositories/types.ts` before writing the `progress` mapping, and use those; if they are not `done`/`total`, keep the public names `done`/`total` and map onto them.

- [ ] **Step 4: Run it.** Same command — Expected: PASS.

- [ ] **Step 5: The share button needs these ids in the app.** The app builds a share link from the public ids, so `mapProject` and `mapMachine` (`apps/server/src/db/repositories/types.ts`) each gain one derived field — `public_id: publicId('project', p.id)` and `public_id: publicId('machine', m.id)` — and the `Project` and `Machine` interfaces gain `public_id: string`. It is a one-way value, so carrying it on an authenticated payload gives away nothing. Add to `apps/server/src/public/city.test.ts`:

```ts
  it('the id a project carries for the app is the id the city shows', () => {
    expect(mapProject({ id: 'p1', machineId: 'm1', name: 'x', cwd: '/w', status: 'active', description: null, isPublic: true, lastTerminalAt: null, createdAt: new Date() } as never).public_id).toBe(publicId('project', 'p1'));
  });
```

Run `DOCKER 'npx -w @termhub/server vitest run src/public/city.test.ts'` — Expected: FAIL, then PASS once the mappers emit it. Mirror `public_id` on the web's `Project` and `Machine` types in `apps/web/src/lib/types.ts`, and fix whatever fixtures the web typecheck flags.

- [ ] **Step 6: Commit.**

```bash
git add apps/server/src/public/city.ts apps/server/src/public/city.test.ts apps/server/src/db/repositories/types.ts apps/web/src/lib/types.ts
git commit -m "Public: the payload a visitor is allowed to see"
```

---

### Task 4: The public snapshot

**Files:**
- Create: `apps/server/src/public/read.ts`, `apps/server/src/routes/public-city.ts`, `apps/server/src/routes/public-city.test.ts`
- Modify: `apps/server/src/app.ts`

**Interfaces:**
- Consumes: `toPublicCity` (Task 3), `users.findByNickname` (Task 1), `Project.is_public` (Task 2).
- Produces: `readPublicCity(repos, nickname, deps): Promise<PublicCity | undefined>`; `GET /api/public/city/:nickname` (public route) answering the `PublicCity` body or 404.

- [ ] **Step 1: Write the failing route tests.** Create `apps/server/src/routes/public-city.test.ts`, building the app the way `office.test.ts` does but registering `publicCityRoutes` under `/public`, with repository stubs:

```ts
  it('answers the city of a nickname that has a public project', async () => {
    const res = await app.inject({ method: 'GET', url: '/public/city/pedro' });
    expect(res.statusCode).toBe(200);
    expect(res.json().nickname).toBe('pedro');
    expect(res.json().buildings[0].rooms.map((r: { name: string }) => r.name)).toEqual(['Engage Easy']);
  });

  it('leaves out the private rooms of the same machine', async () => {
    const body = JSON.stringify((await app.inject({ method: 'GET', url: '/public/city/pedro' })).json());
    expect(body).not.toContain('Projeto Secreto');
  });

  it('404s an unknown nickname', async () => {
    expect((await app.inject({ method: 'GET', url: '/public/city/ninguem' })).statusCode).toBe(404);
  });

  it('404s a nickname that exists but published nothing — an empty city would confirm the name', async () => {
    expect((await app.inject({ method: 'GET', url: '/public/city/semnada' })).statusCode).toBe(404);
  });

  it('does not ask the machine for a fresh tmux probe', async () => {
    await app.inject({ method: 'GET', url: '/public/city/pedro' });
    expect(probeCalls.every((c) => c.fresh === false)).toBe(true);
  });
```

- [ ] **Step 2: Run them.** `DOCKER 'npx -w @termhub/server vitest run src/routes/public-city.test.ts'` — Expected: FAIL, the module does not exist.

- [ ] **Step 3: Implement the read.** Create `apps/server/src/public/read.ts`:

```ts
import type { Repositories } from '../db/repositories/index.js';
import { probeTmuxSessionsCached } from '../terminal/machine-exec.js';
import { toPublicCity, type PublicCity } from './city.js';

/**
 * The one read behind both public surfaces: a nickname, the machines its owner has, and only the
 * projects that are published. Never probes a machine fresh — an anonymous visitor must not be able
 * to make this server open ssh connections; the memoised probe is what the office already warms.
 */
export async function readPublicCity(repos: Repositories, nickname: string): Promise<PublicCity | undefined> {
  const owner = await repos.users.findByNickname(nickname);
  if (!owner) return undefined;
  const machines = (await repos.machines.list()).filter((m) => m.owner_id === owner.id);
  const buildings = [];
  for (const machine of machines) {
    const projects = (await repos.projects.list({ machine_id: machine.id })).filter((p) => p.is_public && p.status !== 'archived');
    if (projects.length === 0) continue;
    const tabs = await repos.tabs.listByProjects(projects.map((p) => p.id));
    const probe = tabs.some((t) => t.kind === 'terminal') ? await probeTmuxSessionsCached(machine, { fresh: false }) : { reachable: true, sessions: new Set<string>() };
    buildings.push({
      machine,
      rooms: projects.map((project) => ({
        project,
        tabs: tabs.filter((t) => t.project_id === project.id).map((tab) => ({ tab, alive: probe.reachable && !!tab.tmux_session && probe.sessions.has(tab.tmux_session), progress: null })),
      })),
    });
  }
  if (buildings.length === 0) return undefined;
  return toPublicCity({ nickname, ownerName: owner.name, buildings });
}
```

Progress is `null` for now: the board's counts are a second read per project and the design does not promise them in v1. If `OfficeProgress` is cheap to fetch for the published projects only, fetch it and pass it through — the public payload already has the field.

- [ ] **Step 4: Implement the route.** Create `apps/server/src/routes/public-city.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Repositories } from '../db/repositories/index.js';
import { normalizeNickname } from '../public/nickname.js';
import { readPublicCity } from '../public/read.js';

const params = z.object({ nickname: z.string().min(1).max(64) });

/**
 * The public city, read by anyone with the link. No session, no Access: this lives on the landing
 * host. A nickname that does not exist and one that published nothing answer the same 404 — an empty
 * city would tell a stranger which nicknames are taken.
 */
export async function publicCityRoutes(app: FastifyInstance, repos: Repositories) {
  app.get('/city/:nickname', { config: { public: true } }, async (request, reply) => {
    const parsed = normalizeNickname(params.parse(request.params).nickname);
    if (!parsed.ok) return reply.code(404).send({ error: 'Cidade não encontrada', code: 'NOT_FOUND' });
    const city = await readPublicCity(repos, parsed.value);
    if (!city) return reply.code(404).send({ error: 'Cidade não encontrada', code: 'NOT_FOUND' });
    request.log.debug({ nickname: parsed.value, buildings: city.buildings.length }, 'public city: snapshot');
    reply.header('cache-control', 'public, max-age=5');
    return city;
  });
}
```

Register it in `apps/server/src/app.ts` beside the other API routes, outside `guarded(...)` — like the waitlist's registration but with `{ prefix: '/public' }` and no resource:

```ts
      await api.register((a) => publicCityRoutes(a, repos), { prefix: '/public' });
```

- [ ] **Step 5: Run them.** Same command as Step 2 — Expected: PASS. Then `DOCKER 'npm run typecheck -w @termhub/server'`.

- [ ] **Step 6: Commit.**

```bash
git add apps/server/src/public/read.ts apps/server/src/routes/public-city.ts apps/server/src/routes/public-city.test.ts apps/server/src/app.ts
git commit -m "Public: the city snapshot"
```

---

### Task 5: The public channel

**Files:**
- Create: `apps/server/src/public/bus.ts`, `apps/server/src/public/ws.ts`, `apps/server/src/public/ws.test.ts`
- Modify: `apps/server/src/routes/projects.ts` (emit on the switch), `apps/server/src/app.ts` (register the upgrade route)

**Interfaces:**
- Consumes: `monitorBus` (`apps/server/src/monitor/bus.ts`), `readPublicCity` (Task 4), `toPublicRobot`, `publicId` (Task 3).
- Produces: `publicBus.publish({ project_id, is_public })` and `publicBus.subscribe(fn)`; the upgrade route `/ws/public/:nickname`, which sends `{ type: 'robot', building: string, room: string, robot: PublicRobot }` frames.

- [ ] **Step 1: Write the failing tests.** Create `apps/server/src/public/ws.test.ts`. **Copy the setup from `apps/server/src/agent/ws.test.ts`** — it is this repo's test for a *public* upgrade route (an http server on an ephemeral port, `createUpgradeRouter`, a real client from `ws`), which is exactly the shape you need; read it before writing, and reuse its helpers for connecting, reading one frame and waiting for a close. The four tests:

```ts
  it('sends a change on a published room', async () => {
    const client = await connect('/ws/public/pedro');
    monitorBus.publish({ tab: tab({ activity: 'reading' }), project_id: 'p1', machine_id: 'm1', owner_id: 'u1' });
    const frame = await nextMessage(client);
    expect(frame.type).toBe('robot');
    expect(frame.robot.activity).toBe('reading');
    expect(frame.robot.id).toBe(publicId('tab', 't1'));
    expect(JSON.stringify(frame)).not.toContain('th-t1');
  });

  it('never sends a change on a private room of the same machine', async () => {
    const client = await connect('/ws/public/pedro');
    monitorBus.publish({ tab: tab({ id: 't9', project_id: 'p9' }), project_id: 'p9', machine_id: 'm1', owner_id: 'u1' });
    await expect(nextMessage(client, { timeoutMs: 300 })).rejects.toThrow(/timeout/);
  });

  it('closes the socket when the room is unpublished', async () => {
    const client = await connect('/ws/public/pedro');
    publicBus.publish({ project_id: 'p1', is_public: false });
    await expect(closed(client)).resolves.toBe(true);
  });

  it('refuses an unknown nickname', async () => {
    await expect(connect('/ws/public/ninguem')).rejects.toThrow(/404/);
  });
```

- [ ] **Step 2: Run them.** `DOCKER 'npx -w @termhub/server vitest run src/public/ws.test.ts'` — Expected: FAIL, the modules do not exist.

- [ ] **Step 3: Implement the bus.** Create `apps/server/src/public/bus.ts`, the same shape as `monitor/bus.ts`:

```ts
import { EventEmitter } from 'node:events';

/** A project's public switch moved. The public sockets watching it need to know at once. */
export interface PublicChange { project_id: string; is_public: boolean }

class PublicBus {
  private emitter = new EventEmitter();
  constructor() { this.emitter.setMaxListeners(0); }
  publish(change: PublicChange): void { this.emitter.emit('public', change); }
  subscribe(listener: (change: PublicChange) => void): () => void {
    this.emitter.on('public', listener);
    return () => this.emitter.off('public', listener);
  }
}

export const publicBus = new PublicBus();
```

In `apps/server/src/routes/projects.ts`, after a successful `update` that changed `is_public`, `publicBus.publish({ project_id: id, is_public: next })`.

- [ ] **Step 4: Implement the channel.** Create `apps/server/src/public/ws.ts`:

```ts
import { WebSocketServer, WebSocket } from 'ws';
import type { FastifyBaseLogger } from 'fastify';
import type { createUpgradeRouter } from '../ws/router.js';
import type { Repositories } from '../db/repositories/index.js';
import { monitorBus } from '../monitor/bus.js';
import { publicBus } from './bus.js';
import { publicId, toPublicRobot } from './city.js';
import { normalizeNickname } from './nickname.js';

/**
 * `/ws/public/<nickname>`: the live city for a visitor with no account. It is not `/ws/monitor` with
 * a filter — a different channel, a different payload, and a set of published project ids resolved
 * at connect and kept current by `publicBus`, so unpublishing drops the socket instead of leaving
 * somebody watching a room that is no longer public.
 */
export function registerPublicWs(router: ReturnType<typeof createUpgradeRouter>, deps: { repos: Repositories; log: FastifyBaseLogger }): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 });
  const log = deps.log.child({ mod: 'public-ws' });

  router.addPublic(/^\/ws\/public\/([^/]+)\/?$/, async ({ req, socket, head, params }) => {
    const parsed = normalizeNickname(decodeURIComponent(params[0] ?? ''));
    if (!parsed.ok) return rejectUpgrade(socket, 404, 'Not Found');
    const owner = await deps.repos.users.findByNickname(parsed.value);
    if (!owner) return rejectUpgrade(socket, 404, 'Not Found');
    const published = new Set((await deps.repos.projects.list({ owner: owner.id })).filter((p) => p.is_public && p.status !== 'archived').map((p) => p.id));
    if (published.size === 0) return rejectUpgrade(socket, 404, 'Not Found');

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
      const offTab = monitorBus.subscribe((change) => {
        if (change.owner_id !== owner.id || !published.has(change.project_id)) return;
        if (ws.readyState !== WebSocket.OPEN) return;
        ws.send(JSON.stringify({ type: 'robot', building: publicId('machine', change.machine_id), room: publicId('project', change.project_id), robot: toPublicRobot(change.tab, { alive: true, progress: null }) }));
      });
      const offPublic = publicBus.subscribe((change) => {
        if (!published.has(change.project_id) || change.is_public) return;
        published.delete(change.project_id);
        ws.close(1000, 'unpublished');
      });
      ws.on('close', () => { offTab(); offPublic(); });
    });
  });

  return wss;
}
```

Import `rejectUpgrade` from `../ws/router.js`. Note that public upgrade routes skip the `Origin` check by design in this repo — acceptable here because every frame is already public, and a page on another origin learns nothing it could not read from the snapshot.

`alive: true` on a pushed robot is deliberate: a change arrived from that tab's hook, so its session exists. The snapshot decides `alive` for tabs that are silent.

- [ ] **Step 5: Register it.** In `apps/server/src/app.ts`, beside `registerMonitorWs(...)`, add `registerPublicWs(upgradeRouter, { repos, log: fastify.log })`, following the exact argument shape used there.

- [ ] **Step 6: Run them.** Same command as Step 2 — Expected: PASS. Then `DOCKER 'npx -w @termhub/server vitest run src/routes/projects.test.ts'` to confirm the switch still behaves, and `DOCKER 'npm run typecheck -w @termhub/server'`.

- [ ] **Step 7: Commit.**

```bash
git add apps/server/src/public apps/server/src/routes/projects.ts apps/server/src/app.ts
git commit -m "Public: the live channel for a visitor"
```

---

### Task 6: The bundle that goes to the street

**Files:**
- Create: `apps/web/index-city.html`, `apps/web/vite.city.config.ts`, `apps/web/src/city/main.tsx`, `apps/web/src/city/api.ts`, `apps/web/src/city/CityPage.tsx`, `apps/web/src/city/CityPage.test.tsx`
- Modify: `apps/web/package.json` (a `build:city` script), `apps/web/src/lib/types.ts` (the public types, mirrored)

**Interfaces:**
- Consumes: `GET /api/public/city/:nickname` (Task 4), `/ws/public/:nickname` (Task 5), `buildCityModel`, `resolveFocus`, `OfficeScene` from `apps/web/src/office/`.
- Produces: `npm run build:city -w @termhub/web` writing `apps/web/dist-city/` with base `/city/`.

The public snapshot's shape mirrors the office snapshot's field names on purpose, so the browser's model code is reused unchanged. `buildCityModel` takes `MachineEntry[]`; the public page adapts a `PublicCity` into that shape once, in `api.ts`, and everything downstream — the model, the scene, the overlay, the activity label — is the same code the app runs.

- [ ] **Step 1: Write the failing page test.** Create `apps/web/src/city/CityPage.test.tsx`, following `OfficePage.test.tsx`'s setup (it already stubs the scene; reuse that stub so no PixiJS runs in jsdom):

```tsx
  it('draws the city of the nickname in the URL and says whose it is', async () => {
    fetchMock.mockResolvedValueOnce(json({ nickname: 'pedro', owner_name: 'Pedro', buildings: [{ id: 'b1', name: 'Jarvis', rooms: [{ id: 'r1', name: 'Engage Easy', robots: [{ id: 'x1', name: 'aba 1', kind: 'terminal', state: 'working', state_at: AT, activity: 'coding', alive: true, progress: null }] }] }] }));
    render(<CityPage nickname="pedro" />);
    expect(await screen.findByText(/Pedro/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /criar minha conta/i })).toHaveAttribute('href', expect.stringContaining('termhub.dev'));
  });

  it('shows the not-found state for a city that does not answer', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', { status: 404 }));
    render(<CityPage nickname="ninguem" />);
    expect(await screen.findByText(/cidade não encontrada/i)).toBeInTheDocument();
  });

  it('applies a live robot frame without refetching the snapshot', async () => {
    fetchMock.mockResolvedValueOnce(json(CITY));            // the same body as the first test
    render(<CityPage nickname="pedro" />);
    await screen.findByText(/Pedro/);
    expect(scene.apply).toHaveBeenLastCalledWith(expect.objectContaining({
      machines: [expect.objectContaining({ floor: expect.objectContaining({ rooms: [expect.objectContaining({ desks: [expect.objectContaining({ activity: 'coding' })] })] }) })],
    }));

    act(() => socket.emit({ type: 'robot', building: 'b1', room: 'r1', robot: { ...CITY.buildings[0].rooms[0].robots[0], activity: 'reading', state_at: LATER } }));

    await waitFor(() => expect(scene.apply).toHaveBeenLastCalledWith(expect.objectContaining({
      machines: [expect.objectContaining({ floor: expect.objectContaining({ rooms: [expect.objectContaining({ desks: [expect.objectContaining({ activity: 'reading' })] })] }) })],
    })));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
```

`socket` is a fake in the shape `openCitySocket` expects (an `emit` that hands a parsed frame to the callback it was given), and `scene` is the same scene stub `OfficePage.test.tsx` already installs. Match the assertion to the real `CityModel` shape once `buildCityModel` is wired — the point of the test is that a frame moves a desk and that no second snapshot is fetched.

- [ ] **Step 2: Run it.** `DOCKER 'npx -w @termhub/web vitest run src/city/CityPage.test.tsx'` — Expected: FAIL, the module does not exist.

- [ ] **Step 3: The types.** In `apps/web/src/lib/types.ts`, add the `PublicRobot`, `PublicRoom`, `PublicBuilding` and `PublicCity` interfaces, field for field as Task 3 defines them. They are a mirror, like the other server types in this file.

- [ ] **Step 4: The public client.** Create `apps/web/src/city/api.ts`: `fetchCity(nickname)` doing a plain `fetch('/api/public/city/' + encodeURIComponent(nickname))` (no credentials, no shared api client), `openCitySocket(nickname, onRobot)` opening `/ws/public/<nickname>` with reconnect-on-close backoff, and `toMachineEntries(city: PublicCity): MachineEntry[]` adapting the payload into what `buildCityModel` consumes.

- [ ] **Step 5: The page.** Create `apps/web/src/city/CityPage.tsx`: the snapshot on mount, the socket for changes, `buildCityModel` + `resolveFocus` + `OfficeScene` exactly as `OfficePage` uses them, the three depths read from the URL (`/city/@nick`, `/city/@nick/<building>`, `?room=<room>`), a slim top bar in pt-BR — whose city this is and a link *Criar minha conta* pointing at `https://termhub.dev/#waitlist` — and a not-found state saying *Cidade não encontrada*. No sidebar, no actions, no terminal.

- [ ] **Step 6: The entry and the build.** Create `apps/web/index-city.html` (a `<div id="root">` and `<script type="module" src="/src/city/main.tsx">`), `apps/web/src/city/main.tsx` (mounts `CityPage`, reading the nickname from `location.pathname`), and `apps/web/vite.city.config.ts`:

```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/** The public city: the same scene, built on its own with base /city/ so it never shares an asset path with the app or the landing. */
export default defineConfig({
  base: '/city/',
  plugins: [react()],
  build: { outDir: 'dist-city', sourcemap: false, rollupOptions: { input: 'index-city.html' } },
});
```

Add `"build:city": "vite build --config vite.city.config.ts"` to `apps/web/package.json`.

- [ ] **Step 7: Write the failing bundle test.** Create `apps/web/src/city/bundle.test.ts`:

```ts
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const dist = new URL('../../dist-city/assets', import.meta.url).pathname;

describe.skipIf(!existsSync(dist))('the public bundle', () => {
  it('does not carry the private app', () => {
    const js = readdirSync(dist).filter((f) => f.endsWith('.js')).map((f) => readFileSync(join(dist, f), 'utf8')).join('\n');
    for (const marker of ['/api/machines', '/api/projects', '/ws/monitor', '/api/auth/me']) {
      expect(js).not.toContain(marker);
    }
  });
});
```

- [ ] **Step 8: Build and run.** `DOCKER 'npm run build:city -w @termhub/web'`, then `DOCKER 'npx -w @termhub/web vitest run src/city'` — Expected: PASS, including the bundle test now that `dist-city` exists. Then `DOCKER 'npm run typecheck -w @termhub/web'` and the full web suite.

- [ ] **Step 9: Commit.**

```bash
git add apps/web/index-city.html apps/web/vite.city.config.ts apps/web/package.json apps/web/src/city apps/web/src/lib/types.ts
git commit -m "City: the public page, built on its own"
```

---

### Task 7: The switch, the nickname and the share button, in the app

**Files:**
- Create: `apps/web/src/components/NicknameDialog.tsx`, `apps/web/src/components/NicknameDialog.test.tsx`
- Modify: `apps/web/src/lib/types.ts` (`User.nickname`), `apps/web/src/lib/api.ts` (`setNickname`, `is_public` on the project patch), `apps/web/src/pages/ProjectPage.tsx`, `apps/web/src/pages/OfficePage.tsx`, their tests

**Interfaces:**
- Consumes: `PATCH /api/auth/me/nickname` (Task 1), `PATCH /api/projects/:id` with `is_public` (Task 2).
- Produces: the publish switch on the project page; `NicknameDialog`, shown at first sign-in when `user.nickname` is null and before a first publish; the share button on `/office`.

- [ ] **Step 1: Write the failing tests.** In `apps/web/src/pages/ProjectPage.test.tsx`:

```tsx
  it('says what publishing makes readable before it flips', async () => {
    render(<ProjectPage {...props} />);
    await userEvent.click(screen.getByRole('switch', { name: /publicar/i }));
    expect(screen.getByText(/o nome do projeto, o nome da máquina e todas as abas/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /publicar/i }));
    expect(patchMock).toHaveBeenCalledWith(project.id, expect.objectContaining({ is_public: true }));
  });

  it('asks for the nickname when the server says it is missing', async () => {
    patchMock.mockRejectedValueOnce({ code: 'NICKNAME_REQUIRED' });
    render(<ProjectPage {...props} />);
    await userEvent.click(screen.getByRole('switch', { name: /publicar/i }));
    await userEvent.click(screen.getByRole('button', { name: /publicar/i }));
    expect(await screen.findByLabelText(/apelido/i)).toBeInTheDocument();
  });
```

In `apps/web/src/components/NicknameDialog.test.tsx`: it refuses a reserved word and a bad shape client-side with the same rules the server uses, shows the address it will produce (`termhub.dev/city/@pedro`), and surfaces the server's 409 as *Esse apelido já é de outra pessoa*.

In `apps/web/src/pages/OfficePage.test.tsx`: the share button copies `https://termhub.dev/city/@pedro` on the city, `.../@pedro/<building>` inside a building and `...?room=<room>` inside a room, using the **public** ids the snapshot carries; and it explains itself instead of copying when nothing in view is published.

- [ ] **Step 2: Run them.** `DOCKER 'npx -w @termhub/web vitest run src/pages/ProjectPage.test.tsx src/components/NicknameDialog.test.tsx src/pages/OfficePage.test.tsx'` — Expected: FAIL.

- [ ] **Step 3: Implement.** The switch sits on the project page with the sentence the test pins, in pt-BR: publishing makes readable *o nome do projeto, o nome da máquina e todas as abas dele, com o que cada uma está fazendo*. `NicknameDialog` validates with the same rules as the server (duplicate the small regex and the reserved list in the web — do not create a shared package for two constants). The share button builds its link from `Project.public_id` and `Machine.public_id`, which Task 3 already put on the payloads the app receives; no new endpoint.

- [ ] **Step 4: Run them.** Same command — Expected: PASS. Then the full web suite and `DOCKER 'npm run typecheck -w @termhub/web'`.

- [ ] **Step 5: Commit.**

```bash
git add apps/web/src
git commit -m "App: publish a room, claim a nickname, share the link"
```

---

### Task 8: Serving it — the vhost, the document, the verification

**Files:**
- Modify: `deploy/nginx/termhub.dev.conf.tmpl`, `apps/server/src/app.ts`, `Dockerfile` (or wherever `apps/web/dist` is built and copied), `docs/superpowers/specs/2026-09-22-public-city-design.md` (the Status line)

**Interfaces:**
- Consumes: everything above.
- Produces: `termhub.dev/city/@<nickname>` served end to end, with the link preview's title and description per depth.

- [ ] **Step 1: Serve the bundle.** In `apps/server/src/app.ts`, beside the existing `fastifyStatic` registration for `apps/web/dist`, register `apps/web/dist-city` with `prefix: '/city/'` when it exists, and extend the SPA fallback so a URL starting with `/city/` returns `dist-city`'s `index.html` instead of the app's. Keep the existing behaviour for every other path.

- [ ] **Step 2: The link preview.** The same handler, before sending `index-city.html`, replaces its `<title>` and its `og:title` / `og:description` / `og:image` meta tags with values for the depth being served: the city (*A cidade de \<nome\> no termhub*), a building (*\<máquina\> — a cidade de \<nome\>*) or a room (*\<projeto\> — a cidade de \<nome\>*). The image is the landing's existing card at `https://termhub.dev/og-image.png`; a card drawn per city needs a rasteriser this repo does not have, and is out of scope here. Pin it with a server test: a request for `/city/@pedro` returns HTML whose `og:title` contains the owner's name, and a request for an unknown nickname returns the page with the neutral title and no name.

- [ ] **Step 3: Build the bundle in the image.** Wherever the production image runs `npm run build -w @termhub/web`, add `npm run build:city -w @termhub/web`, and make sure `apps/web/dist-city` is copied into the runtime image beside `apps/web/dist`.

- [ ] **Step 4: The vhost.** In `deploy/nginx/termhub.dev.conf.tmpl`, inside the `termhub.dev` server block (the one with no Access), add — following the existing locations' header and budget style, and using `__APP_HOST__` as they do:

At the top of the file, beside the other zones:

```nginx
# Public city: per-client budget for an audience with no account (the client IP comes from Cloudflare)
limit_req_zone $http_cf_connecting_ip zone=termhub_public:1m rate=5r/s;
limit_conn_zone $http_cf_connecting_ip zone=termhub_public_conn:1m;
```

Inside the `termhub.dev` server block, before `location / {`:

```nginx
    # The public city: the page, its snapshot and its live channel (public routes; no Access on this host)
    location /city/ {
        limit_except GET { deny all; }
        limit_req zone=termhub_public burst=10 nodelay;
        limit_req_status 429;
        proxy_pass http://__APP_HOST__:3000;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $http_cf_connecting_ip;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
    }
    location /api/public/ {
        limit_except GET { deny all; }
        limit_req zone=termhub_public burst=10 nodelay;
        limit_req_status 429;
        proxy_pass http://__APP_HOST__:3000;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $http_cf_connecting_ip;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
    }
    location /ws/public/ {
        limit_conn termhub_public_conn 4;
        proxy_pass http://__APP_HOST__:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade           $http_upgrade;
        proxy_set_header Connection        "upgrade";
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $http_cf_connecting_ip;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_read_timeout 3600s;
    }
```

Read the template before editing: it uses `__APP_HOST__` where the rendered file names a container, and the existing locations are the exact style to copy. Four concurrent sockets per client IP is the cap; behind Cloudflare the IP is the visitor's, so it limits a person, not the world.

Nothing about Cloudflare Access changes: Access is bound to `app.termhub.dev`, and these paths are on `termhub.dev`.

- [ ] **Step 5: Full verification** with a throwaway Postgres, the v1 recipe: `npm ci`, `prisma:generate`, `build:packages`, server typecheck + tests (with the DB tests on), web typecheck + tests, `build`, `build:city`, landing build. Capture the output under `/tmp/city-verify/` and report exit codes and counts. `nginx -t` the rendered template with `DRY_RUN` if `deploy/blue-green.sh` supports it.

- [ ] **Step 6: The spec's Status line** becomes *implemented on `feat/public-city`, pending review and merge*, plus a line for anything the implementation settled differently — the link preview's image in particular.

- [ ] **Step 7 (controller, after the whole-branch review):** merge `origin/main` if it moved, re-verify, push, open the PR. The PR description must say that the public surfaces live on the `termhub.dev` vhost, that Access is untouched, and that the first city only exists once someone claims a nickname and flips a switch.

- [ ] **Step 8 (after merge and deploy):** claim a nickname, publish one project, open `termhub.dev/city/@<nickname>` in a browser with no session — the city draws, the labels follow the tools, and unpublishing the project makes the page go to *Cidade não encontrada* without a reload.
