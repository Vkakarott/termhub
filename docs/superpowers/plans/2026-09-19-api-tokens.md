# API Tokens Implementation Plan (global terminal, PR 2 of 5)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Users create, list and revoke personal API tokens with scopes in Settings, stored as hashes, with the audit table in place — so PR 3's `/mcp` route only has to look a token up and check its scopes.

**Architecture:** Two additive tables (`api_tokens`, `api_token_events`) plus default grants for a new `api_tokens` resource, in one migration. A small token module (`auth/api-tokens.ts`) owns the format, hashing and scope catalog; `ApiTokensRepository` owns persistence (never returns the hash); `routes/api-tokens.ts` is registered through `guarded('api_tokens', …)` and always acts on the signed-in user — never on an admin's "view as" target. The web gets a "Tokens de API" section in Settings. No route accepts a token yet; that is PR 3.

**Tech Stack:** Prisma 7 + Postgres 16, Fastify 5 + zod, vitest 3, React + Testing Library (jsdom).

**Spec:** `docs/superpowers/specs/2026-09-18-global-terminal-mcp-design.md` — sections 3.1 and 3.2 (and 8, item 2). The spec lands on `main` with PR #50; **execution starts only after #50 is merged and `main` is merged into this branch** (see Setup).

## Global Constraints

- Token format: `thb_pat_` + 32 random bytes base64url (**43 chars**). Only the **sha256 hex** is stored (`token_hash`, unique). The plain token is returned **once**, by the create call, and never again by any route.
- Scopes: a non-empty subset of `read`, `tasks`, `terminals` (catalog order, no duplicates).
- Optional expiry: `expires_in_days` integer **1–365**, or none.
- A user sees and revokes **only their own tokens**. Routes use `request.user.id`, never `request.scope.ownerId` (an admin in "view as" still manages only their own tokens). Admins get no cross-user view.
- Revoke sets `revoked_at` (the row stays, for the audit trail); revoking twice is a no-op that keeps the first timestamp.
- At most **20 active** tokens per user (active = not revoked and not expired). Creating a 21st answers 409.
- Audit rows (`api_token_events`) hold **metadata only** (tool, ids, ok, error code, duration). Rows older than **30 days** are pruned by the hourly purge in `app.ts` (through `AuthService.purgeExpired`).
- New resource `api_tokens` (label "Tokens de API") in `RESOURCES`; the migration grants `api_tokens` create/read/update/delete to `role_authenticated` and `role_manager` (admins bypass).
- `MCP_URL` (optional env): the public MCP endpoint. When unset, the UI does not show the `claude mcp add` command (PR 3 sets it in production).
- Migrations are **additive** (blue/green); name: `20260919120000_api_tokens` (after `20260919090000_task_subtasks`).
- `apps/server/src/generated/prisma/**` is tracked: regenerate and commit it with the schema change.
- Routes never import Prisma; every input is validated with zod.
- Code, comments, commits, README in **English**; UI copy and API error messages in **pt-BR**.
- This host has **no Node**: every npm/npx/vitest/prisma command runs in Docker (see Setup). Server commands always need `DATABASE_URL` set (config.ts exits at import otherwise).

## Setup (once, before Task 1)

```bash
cd ~/termhub-wt-api-tokens
git fetch origin && git merge --no-edit origin/main     # brings PR #50 (spec, subtasks, DB test harness)
test -f docs/superpowers/specs/2026-09-18-global-terminal-mcp-design.md && ls apps/server/prisma/migrations | tail -2
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/w" -w /w node:20 sh -c 'npm ci --no-audit --no-fund && npm run prisma:generate && npm run build:packages'; rm -rf .npm
```

Expected: the spec exists and the last migration is `20260919090000_task_subtasks`. If `main` has a migration newer than `20260919120000`, rename this plan's migration folder to a later timestamp everywhere below.

Command shorthands used below (inline them — shell functions don't persist between tool calls):

```bash
# unit tests / typecheck / builds (placeholder DB URL, never connected to)
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -e DATABASE_URL=postgresql://x:x@localhost:5432/x -v "$PWD:/w" -w /w node:20 sh -c '<cmd>'; rm -rf .npm

# DB-backed tests: start once, reuse, stop at the end of the task
docker network create th-test 2>/dev/null; docker run -d --rm --name th-test-db --network th-test -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=termhub postgres:16-alpine; sleep 6
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp --network th-test -e DATABASE_URL=postgresql://postgres:postgres@th-test-db:5432/termhub -e TERMHUB_DB_TESTS=1 -v "$PWD:/w" -w /w node:20 sh -c '<cmd>'; rm -rf .npm
docker stop th-test-db; docker network rm th-test
```

## Review Focus

1. **An admin in "view as" another user opens Tokens de API.** Expected: they see and revoke only their own tokens; another user's token id answers 404. → route test in Task 3.
2. **An expired (not revoked) token.** Expected: it does not count toward the 20-token limit, is never returned by `findActiveByHash`, and the UI labels it "expirado". → DB test in Task 2, component test in Task 4.
3. **A malformed create body:** duplicate scopes, an unknown scope, blank name, `expires_in_days` 0 or 366. Expected: duplicates collapse; the rest answer 400 and create nothing. → route test in Task 3.
4. **Any response leaking the secret.** Expected: no route ever returns `token_hash`; the list never returns a plain token. → route test in Task 3 and repository test in Task 2.
5. **Deleting a user.** Expected: their tokens and audit rows go with them (FK cascade). → DB test in Task 2.

---

### Task 1: Schema, migration with default grants, token module

**Files:**
- Modify: `apps/server/prisma/schema.prisma` (model `User`; new models at the end)
- Create: `apps/server/prisma/migrations/20260919120000_api_tokens/migration.sql`
- Create: `apps/server/src/auth/api-tokens.ts`
- Test: `apps/server/src/auth/api-tokens.test.ts`
- Regenerate + commit: `apps/server/src/generated/prisma/**`

**Interfaces:**
- Produces: `API_TOKEN_PREFIX`, `API_TOKEN_RE`, `API_TOKEN_SCOPES`, `type ApiTokenScope = 'read' | 'tasks' | 'terminals'`, `MAX_ACTIVE_TOKENS_PER_USER = 20`, `API_TOKEN_EVENT_RETENTION_DAYS = 30`, `newApiToken(): { token: string; hash: string }`, `hashApiToken(token: string): string`, `toScopes(raw: readonly string[]): ApiTokenScope[]`; Prisma models `ApiToken`, `ApiTokenEvent`.

- [ ] **Step 1: Write the failing test**

`apps/server/src/auth/api-tokens.test.ts`:

```ts
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { API_TOKEN_RE, hashApiToken, newApiToken, toScopes } from './api-tokens.js';

describe('newApiToken', () => {
  it('is thb_pat_ plus 43 base64url chars, and returns the sha256 hex of the token', () => {
    const { token, hash } = newApiToken();
    expect(token).toMatch(/^thb_pat_[A-Za-z0-9_-]{43}$/);
    expect(API_TOKEN_RE.test(token)).toBe(true);
    expect(hash).toBe(createHash('sha256').update(token).digest('hex'));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('never repeats', () => {
    const tokens = new Set(Array.from({ length: 50 }, () => newApiToken().token));
    expect(tokens.size).toBe(50);
  });
});

describe('hashApiToken', () => {
  it('is stable and differs per token', () => {
    expect(hashApiToken('thb_pat_a')).toBe(hashApiToken('thb_pat_a'));
    expect(hashApiToken('thb_pat_a')).not.toBe(hashApiToken('thb_pat_b'));
  });
});

describe('API_TOKEN_RE', () => {
  it.each(['thb_pat_short', 'thb_hk_' + 'a'.repeat(43), 'thb_pat_' + 'a'.repeat(44), 'thb_pat_' + 'a'.repeat(42) + '!'])('rejects %s', (t) => {
    expect(API_TOKEN_RE.test(t)).toBe(false);
  });
});

describe('toScopes', () => {
  it('keeps known scopes once, in catalog order, and drops unknown ones', () => {
    expect(toScopes(['terminals', 'read', 'read', 'admin', 'tasks'])).toEqual(['read', 'tasks', 'terminals']);
    expect(toScopes([])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run (unit shorthand): `cd apps/server && npx vitest run src/auth/api-tokens.test.ts`
Expected: FAIL — cannot resolve `./api-tokens.js`.

- [ ] **Step 3: The token module**

`apps/server/src/auth/api-tokens.ts`:

```ts
import { createHash, randomBytes } from 'node:crypto';

/** Personal API tokens (Settings → Tokens de API), used by the MCP endpoint. Only the hash is stored. */
export const API_TOKEN_PREFIX = 'thb_pat_';
export const API_TOKEN_RE = /^thb_pat_[A-Za-z0-9_-]{43}$/;

/** What a token may do, on top of the owner's own grants (effective = scopes ∩ grants). */
export const API_TOKEN_SCOPES = ['read', 'tasks', 'terminals'] as const;
export type ApiTokenScope = (typeof API_TOKEN_SCOPES)[number];

export const MAX_ACTIVE_TOKENS_PER_USER = 20;
export const API_TOKEN_EVENT_RETENTION_DAYS = 30;

export function newApiToken(): { token: string; hash: string } {
  const token = API_TOKEN_PREFIX + randomBytes(32).toString('base64url');
  return { token, hash: hashApiToken(token) };
}

export function hashApiToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Known scopes only, once each, in catalog order. */
export function toScopes(raw: readonly string[]): ApiTokenScope[] {
  return API_TOKEN_SCOPES.filter((s) => raw.includes(s));
}
```

- [ ] **Step 4: Run the test**

Run: `cd apps/server && npx vitest run src/auth/api-tokens.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Schema**

In `apps/server/prisma/schema.prisma`, add to `model User` after `uploads      Upload[]`:

```prisma
  apiTokens    ApiToken[]
```

and at the end of the file:

```prisma
/// Personal API token (Settings → Tokens de API) for the MCP endpoint. Only the sha256 of the
/// token is stored; the plain token is shown once at creation. Revoked rows stay for the audit trail.
model ApiToken {
  id         String          @id
  userId     String          @map("user_id")
  user       User            @relation(fields: [userId], references: [id], onDelete: Cascade)
  name       String
  tokenHash  String          @unique @map("token_hash")
  /// subset of read | tasks | terminals (see auth/api-tokens.ts)
  scopes     String[]
  expiresAt  DateTime?       @map("expires_at")
  lastUsedAt DateTime?       @map("last_used_at")
  revokedAt  DateTime?       @map("revoked_at")
  createdAt  DateTime        @default(now()) @map("created_at")
  events     ApiTokenEvent[]

  @@index([userId])
  @@map("api_tokens")
}

/// One MCP tool call made with a token. Metadata only — never typed text, screen content or prompts.
/// Pruned after 30 days.
model ApiTokenEvent {
  id         String   @id
  tokenId    String   @map("token_id")
  token      ApiToken @relation(fields: [tokenId], references: [id], onDelete: Cascade)
  tool       String
  machineId  String?  @map("machine_id")
  projectId  String?  @map("project_id")
  tabId      String?  @map("tab_id")
  ok         Boolean
  errorCode  String?  @map("error_code")
  durationMs Int      @map("duration_ms")
  createdAt  DateTime @default(now()) @map("created_at")

  @@index([tokenId, createdAt])
  @@index([createdAt])
  @@map("api_token_events")
}
```

- [ ] **Step 6: Migration — generated DDL plus default grants**

Start the test DB (DB shorthand), apply the existing migrations, and let Prisma write the DDL for the new models:

```bash
mkdir -p apps/server/prisma/migrations/20260919120000_api_tokens
# DB shorthand, cmd:
cd apps/server && npx prisma migrate deploy && npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script > prisma/migrations/20260919120000_api_tokens/migration.sql
```

Check the generated file: it must contain only `CREATE TABLE "api_tokens"`, `CREATE TABLE "api_token_events"`, their indexes and two foreign keys — no `DROP`, no `ALTER` of other tables. Then append:

```sql

-- ── Default grants for the new resource (admins bypass the matrix) ─────────────
INSERT INTO "permissions" ("id", "resource", "action", "role_id")
SELECT 'perm_' || r.prefix || '_api_tokens_' || a, 'api_tokens', a, r.role_id
FROM (VALUES ('auth', 'role_authenticated'), ('mgr', 'role_manager')) AS r(prefix, role_id),
     unnest(ARRAY['create','read','update','delete']) AS a
WHERE EXISTS (SELECT 1 FROM "roles" WHERE "id" = r.role_id)
ON CONFLICT DO NOTHING;
```

- [ ] **Step 7: Apply, regenerate, check drift**

```bash
# DB shorthand, cmd:
cd apps/server && npx prisma migrate deploy && npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code && cd /w && npm run prisma:generate && cd apps/server && npx tsc --noEmit -p tsconfig.json
```

Then confirm the grants landed:

```bash
docker exec th-test-db psql -U postgres -d termhub -tAc "select role_id, count(*) from permissions where resource='api_tokens' group by role_id order by 1"
```

Expected: migrate deploy applies `20260919120000_api_tokens`; `No difference detected.`; typecheck passes; `role_authenticated|4` and `role_manager|4`. **Leave `th-test-db` running** for Task 2.

- [ ] **Step 8: Commit**

```bash
git add apps/server/prisma apps/server/src/generated apps/server/src/auth/api-tokens.ts apps/server/src/auth/api-tokens.test.ts
git commit -m "API tokens: tables, default grants and the token module"
```

---

### Task 2: Repository

**Files:**
- Create: `apps/server/src/db/repositories/api-tokens.ts`
- Modify: `apps/server/src/db/repositories/index.ts` (register `apiTokens`)
- Modify: `apps/server/src/auth/service.ts` (`purgeExpired`)
- Test: `apps/server/src/db/repositories/api-tokens.db.test.ts`

**Interfaces:**
- Consumes: `ApiTokenScope`, `toScopes`, `API_TOKEN_EVENT_RETENTION_DAYS` (Task 1).
- Produces:
  - `interface ApiToken { id: string; user_id: string; name: string; scopes: ApiTokenScope[]; expires_at: string | null; last_used_at: string | null; revoked_at: string | null; created_at: string }` (exported from `api-tokens.ts`; **no hash field**)
  - `interface ApiTokenEventInput { token_id: string; tool: string; machine_id?: string | null; project_id?: string | null; tab_id?: string | null; ok: boolean; error_code?: string | null; duration_ms: number }`
  - `ApiTokensRepository`:
    - `listByUser(userId: string): Promise<ApiToken[]>` — newest first
    - `countActive(userId: string, now?: Date): Promise<number>`
    - `create(userId: string, input: { name: string; scopes: ApiTokenScope[]; expiresAt: Date | null }, tokenHash: string): Promise<ApiToken>`
    - `revoke(id: string, userId: string): Promise<ApiToken | undefined>` — undefined when not that user's
    - `findActiveByHash(tokenHash: string, now?: Date): Promise<ApiToken | undefined>` — for PR 3
    - `touchLastUsed(id: string, now?: Date): Promise<void>` — for PR 3; writes at most once a minute
    - `recordEvent(input: ApiTokenEventInput): Promise<void>` — for PR 3
    - `purgeEventsBefore(cutoff: Date): Promise<number>`
  - `repos.apiTokens`

- [ ] **Step 1: Write the failing tests**

`apps/server/src/db/repositories/api-tokens.db.test.ts`:

```ts
import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../generated/prisma/client.js';
import { newId } from '../../lib/ids.js';
import { ApiTokensRepository } from './api-tokens.js';

const DAY = 24 * 60 * 60 * 1000;

// Needs a migrated Postgres: TERMHUB_DB_TESTS=1 DATABASE_URL=… (see README → Development).
describe.skipIf(process.env.TERMHUB_DB_TESTS !== '1')('ApiTokensRepository (Postgres)', () => {
  let db: PrismaClient;
  let repo: ApiTokensRepository;
  let userId: string;
  let otherId: string;

  beforeAll(() => {
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
    repo = new ApiTokensRepository(db);
  });

  beforeEach(async () => {
    userId = newId();
    otherId = newId();
    await db.user.createMany({
      data: [
        { id: userId, email: `${userId}@test.local`, name: 'me' },
        { id: otherId, email: `${otherId}@test.local`, name: 'other' },
      ],
    });
    return async () => {
      await db.user.deleteMany({ where: { id: { in: [userId, otherId] } } }); // cascades tokens and events
    };
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  const make = (owner: string, over: { name?: string; expiresAt?: Date | null; hash?: string } = {}) =>
    repo.create(owner, { name: over.name ?? 't', scopes: ['read', 'tasks'], expiresAt: over.expiresAt ?? null }, over.hash ?? newId(32));

  it('creates a token, maps it without the hash, and lists only the owner\'s, newest first', async () => {
    const first = await make(userId, { name: 'first' });
    // created_at has millisecond precision: age the first token so the order is deterministic
    await db.apiToken.update({ where: { id: first.id }, data: { createdAt: new Date(Date.now() - 60_000) } });
    const second = await make(userId, { name: 'second' });
    await make(otherId, { name: 'foreign' });

    expect(first).toMatchObject({ user_id: userId, name: 'first', scopes: ['read', 'tasks'], expires_at: null, last_used_at: null, revoked_at: null });
    expect(Object.keys(first)).not.toContain('token_hash');
    expect(Object.keys(first)).not.toContain('tokenHash');
    expect((await repo.listByUser(userId)).map((t) => t.id)).toEqual([second.id, first.id]);
  });

  it('revokes only the owner\'s token, once', async () => {
    const mine = await make(userId);
    expect(await repo.revoke(mine.id, otherId)).toBeUndefined();
    expect(await repo.revoke('missing', userId)).toBeUndefined();

    const revoked = await repo.revoke(mine.id, userId);
    expect(revoked?.revoked_at).not.toBeNull();
    const again = await repo.revoke(mine.id, userId);
    expect(again?.revoked_at).toBe(revoked?.revoked_at);
  });

  it('counts only active tokens: not revoked, not expired', async () => {
    await make(userId);
    await make(userId, { expiresAt: new Date(Date.now() + DAY) });
    await make(userId, { expiresAt: new Date(Date.now() - 1000) });
    const revoked = await make(userId);
    await repo.revoke(revoked.id, userId);
    await make(otherId);

    expect(await repo.countActive(userId)).toBe(2);
  });

  it('finds an active token by hash, and never a revoked, expired or unknown one', async () => {
    const active = await make(userId, { hash: 'h-active' });
    await make(userId, { hash: 'h-expired', expiresAt: new Date(Date.now() - 1000) });
    const revoked = await make(userId, { hash: 'h-revoked' });
    await repo.revoke(revoked.id, userId);

    expect((await repo.findActiveByHash('h-active'))?.id).toBe(active.id);
    expect(await repo.findActiveByHash('h-expired')).toBeUndefined();
    expect(await repo.findActiveByHash('h-revoked')).toBeUndefined();
    expect(await repo.findActiveByHash('h-unknown')).toBeUndefined();
  });

  it('touches last_used_at at most once a minute', async () => {
    const t = await make(userId);
    const t0 = new Date();
    await repo.touchLastUsed(t.id, t0);
    await repo.touchLastUsed(t.id, new Date(t0.getTime() + 30_000));
    expect((await repo.listByUser(userId))[0].last_used_at).toBe(t0.toISOString());

    const t1 = new Date(t0.getTime() + 61_000);
    await repo.touchLastUsed(t.id, t1);
    expect((await repo.listByUser(userId))[0].last_used_at).toBe(t1.toISOString());
  });

  it('records events and purges the old ones', async () => {
    const t = await make(userId);
    await repo.recordEvent({ token_id: t.id, tool: 'list_machines', ok: true, duration_ms: 12 });
    await repo.recordEvent({ token_id: t.id, tool: 'read_screen', tab_id: 'tab1', ok: false, error_code: 'NOT_FOUND', duration_ms: 3 });
    await db.apiTokenEvent.updateMany({ where: { tokenId: t.id, tool: 'list_machines' }, data: { createdAt: new Date(Date.now() - 31 * DAY) } });

    expect(await repo.purgeEventsBefore(new Date(Date.now() - 30 * DAY))).toBe(1);
    const left = await db.apiTokenEvent.findMany({ where: { tokenId: t.id } });
    expect(left.map((e) => e.tool)).toEqual(['read_screen']);
  });

  it('deleting the user removes their tokens and events', async () => {
    const t = await make(userId);
    await repo.recordEvent({ token_id: t.id, tool: 'find', ok: true, duration_ms: 1 });
    await db.user.delete({ where: { id: userId } });
    expect(await db.apiToken.count({ where: { id: t.id } })).toBe(0);
    expect(await db.apiTokenEvent.count({ where: { tokenId: t.id } })).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run (DB shorthand): `cd apps/server && npx vitest run src/db/repositories/api-tokens.db.test.ts`
Expected: FAIL — cannot resolve `./api-tokens.js`.

- [ ] **Step 3: Implement the repository**

`apps/server/src/db/repositories/api-tokens.ts`:

```ts
import type { PrismaClient } from '../prisma.js';
import type { ApiToken as PrismaApiToken } from '../../generated/prisma/client.js';
import { newId } from '../../lib/ids.js';
import { toScopes, type ApiTokenScope } from '../../auth/api-tokens.js';

/** A personal API token as routes see it: never the hash, never the plain token. */
export interface ApiToken {
  id: string;
  user_id: string;
  name: string;
  scopes: ApiTokenScope[];
  expires_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

/** One MCP tool call: metadata only (never typed text, screen content or prompts). */
export interface ApiTokenEventInput {
  token_id: string;
  tool: string;
  machine_id?: string | null;
  project_id?: string | null;
  tab_id?: string | null;
  ok: boolean;
  error_code?: string | null;
  duration_ms: number;
}

const TOUCH_INTERVAL_MS = 60_000;

const mapApiToken = (t: PrismaApiToken): ApiToken => ({
  id: t.id,
  user_id: t.userId,
  name: t.name,
  scopes: toScopes(t.scopes),
  expires_at: t.expiresAt?.toISOString() ?? null,
  last_used_at: t.lastUsedAt?.toISOString() ?? null,
  revoked_at: t.revokedAt?.toISOString() ?? null,
  created_at: t.createdAt.toISOString(),
});

const activeWhere = (now: Date) => ({ revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] });

export class ApiTokensRepository {
  constructor(private db: PrismaClient) {}

  async listByUser(userId: string): Promise<ApiToken[]> {
    const rows = await this.db.apiToken.findMany({ where: { userId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
    return rows.map(mapApiToken);
  }

  async countActive(userId: string, now = new Date()): Promise<number> {
    return this.db.apiToken.count({ where: { userId, ...activeWhere(now) } });
  }

  async create(userId: string, input: { name: string; scopes: ApiTokenScope[]; expiresAt: Date | null }, tokenHash: string): Promise<ApiToken> {
    const t = await this.db.apiToken.create({
      data: { id: newId(), userId, name: input.name, scopes: input.scopes, expiresAt: input.expiresAt, tokenHash },
    });
    return mapApiToken(t);
  }

  /** Revokes the user's token (idempotent: a second call keeps the first timestamp). Undefined when it isn't theirs. */
  async revoke(id: string, userId: string): Promise<ApiToken | undefined> {
    await this.db.apiToken.updateMany({ where: { id, userId, revokedAt: null }, data: { revokedAt: new Date() } });
    const t = await this.db.apiToken.findFirst({ where: { id, userId } });
    return t ? mapApiToken(t) : undefined;
  }

  /** The token for a presented secret's hash, when it is neither revoked nor expired. */
  async findActiveByHash(tokenHash: string, now = new Date()): Promise<ApiToken | undefined> {
    const t = await this.db.apiToken.findFirst({ where: { tokenHash, ...activeWhere(now) } });
    return t ? mapApiToken(t) : undefined;
  }

  /** Records a use; skips the write when the last one is under a minute old. */
  async touchLastUsed(id: string, now = new Date()): Promise<void> {
    await this.db.apiToken.updateMany({
      where: { id, OR: [{ lastUsedAt: null }, { lastUsedAt: { lte: new Date(now.getTime() - TOUCH_INTERVAL_MS) } }] },
      data: { lastUsedAt: now },
    });
  }

  async recordEvent(e: ApiTokenEventInput): Promise<void> {
    await this.db.apiTokenEvent.create({
      data: {
        id: newId(),
        tokenId: e.token_id,
        tool: e.tool,
        machineId: e.machine_id ?? null,
        projectId: e.project_id ?? null,
        tabId: e.tab_id ?? null,
        ok: e.ok,
        errorCode: e.error_code ?? null,
        durationMs: e.duration_ms,
      },
    });
  }

  async purgeEventsBefore(cutoff: Date): Promise<number> {
    const r = await this.db.apiTokenEvent.deleteMany({ where: { createdAt: { lt: cutoff } } });
    return r.count;
  }
}
```

Note on the touch test: `touchLastUsed(t.id, t0 + 30 s)` must not write because `lastUsedAt (t0) > now − 60 s`; at `t0 + 61 s` it writes. The comparison is `lte`, so exactly 60 s also writes.

- [ ] **Step 4: Register and purge**

`apps/server/src/db/repositories/index.ts`: import `ApiTokensRepository` from `./api-tokens.js`, add `apiTokens: ApiTokensRepository;` to `Repositories` and `apiTokens: new ApiTokensRepository(db),` to `createRepositories`.

`apps/server/src/auth/service.ts`, `purgeExpired` becomes:

```ts
  async purgeExpired(): Promise<void> {
    const eventsCutoff = new Date(Date.now() - API_TOKEN_EVENT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    await Promise.all([this.repos.sessions.purgeExpired(), this.repos.loginCodes.purgeExpired(), this.repos.apiTokens.purgeEventsBefore(eventsCutoff)]);
  }
```

with `import { API_TOKEN_EVENT_RETENTION_DAYS } from './api-tokens.js';` at the top. If an existing test stubs `repos` for `purgeExpired`, add `apiTokens: { purgeEventsBefore: vi.fn(async () => 0) }` to that stub.

- [ ] **Step 5: Run the DB tests, the suite and the typecheck**

Run (DB shorthand): `cd apps/server && npx vitest run src/db/repositories/api-tokens.db.test.ts && npx vitest run && npx tsc --noEmit -p tsconfig.json`
Expected: 7 new DB tests PASS; the full suite passes (agent e2e skips without tmux); typecheck passes.

- [ ] **Step 6: Commit and stop the test DB**

```bash
git add apps/server/src/db/repositories/api-tokens.ts apps/server/src/db/repositories/api-tokens.db.test.ts apps/server/src/db/repositories/index.ts apps/server/src/auth/service.ts
git commit -m "API tokens: repository, audit events and their 30-day purge"
docker stop th-test-db; docker network rm th-test
```

---

### Task 3: Routes, resource, config

**Files:**
- Create: `apps/server/src/routes/api-tokens.ts`
- Test: `apps/server/src/routes/api-tokens.test.ts`
- Modify: `apps/server/src/auth/permissions.ts` (`RESOURCES`)
- Modify: `apps/server/src/app.ts` (register the plugin)
- Modify: `apps/server/src/config.ts` (`MCP_URL` → `config.mcpUrl`)
- Modify: `.env.example`

**Interfaces:**
- Consumes: `ApiTokensRepository` methods and `ApiToken` (Task 2); `newApiToken`, `API_TOKEN_SCOPES`, `MAX_ACTIVE_TOKENS_PER_USER` (Task 1).
- Produces (HTTP, under `/api`, resource `api_tokens`):
  - `GET /api-tokens` → `{ tokens: ApiToken[] }`
  - `POST /api-tokens` body `{ name: string (1–80, trimmed), scopes: ('read'|'tasks'|'terminals')[] (≥ 1), expires_in_days?: int 1–365 | null }` → `201 { api_token: ApiToken, token: string, mcp_url: string | null }`; `409` over the limit
  - `DELETE /api-tokens/:id` → `{ api_token: ApiToken }`; `404` when not the caller's
  - `config.mcpUrl: string | null`

- [ ] **Step 1: Write the failing tests**

`apps/server/src/routes/api-tokens.test.ts`:

```ts
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { Repositories } from '../db/repositories/index.js';
import type { ApiToken } from '../db/repositories/api-tokens.js';
import { applyErrorHandler } from '../lib/errors.js';
import { apiTokenRoutes } from './api-tokens.js';

const token = (over: Partial<ApiToken> & { id: string }): ApiToken => ({
  user_id: 'u1',
  name: over.id,
  scopes: ['read'],
  expires_at: null,
  last_used_at: null,
  revoked_at: null,
  created_at: '2026-09-19T00:00:00.000Z',
  ...over,
});

/** Routes over a stubbed repository. `viewAs` simulates an admin viewing as another user. */
function buildApp(opts: { active?: number; viewAs?: string } = {}) {
  const app = Fastify();
  applyErrorHandler(app);
  app.addHook('preHandler', async (request) => {
    const owner = opts.viewAs ?? 'u1';
    request.user = { id: 'u1' } as never;
    request.scope = { user: { id: 'u1' } as never, viewAs: opts.viewAs ? { kind: 'user', user: { id: owner } as never } : { kind: 'self' }, ownerId: owner, createAs: owner };
  });
  const apiTokens = {
    listByUser: vi.fn(async (userId: string) => [token({ id: 't1', user_id: userId })]),
    countActive: vi.fn(async () => opts.active ?? 0),
    create: vi.fn(async (userId: string, input: { name: string; scopes: ApiToken['scopes']; expiresAt: Date | null }, hash: string) => {
      void hash;
      return token({ id: 'new', user_id: userId, name: input.name, scopes: input.scopes, expires_at: input.expiresAt?.toISOString() ?? null });
    }),
    revoke: vi.fn(async (id: string, userId: string) => (id === 't1' && userId === 'u1' ? token({ id, revoked_at: '2026-09-19T01:00:00.000Z' }) : undefined)),
  };
  app.register((a) => apiTokenRoutes(a, { apiTokens } as unknown as Repositories, { mcpUrl: 'https://termhub.dev/mcp' }), { prefix: '/api-tokens' });
  return { app, apiTokens };
}

describe('api token routes', () => {
  it('creates a token: returns the plain token once, stores only its hash', async () => {
    const { app, apiTokens } = buildApp();
    const r = await app.inject({ method: 'POST', url: '/api-tokens', payload: { name: '  laptop  ', scopes: ['terminals', 'read', 'read'], expires_in_days: 90 } });
    expect(r.statusCode).toBe(201);
    const body = r.json();
    expect(body.token).toMatch(/^thb_pat_[A-Za-z0-9_-]{43}$/);
    expect(body.mcp_url).toBe('https://termhub.dev/mcp');
    expect(body.api_token).toMatchObject({ name: 'laptop', scopes: ['read', 'terminals'] });
    expect(JSON.stringify(body.api_token)).not.toContain(body.token);

    const [userId, input, hash] = apiTokens.create.mock.calls[0];
    expect(userId).toBe('u1');
    expect(input.scopes).toEqual(['read', 'terminals']);
    expect(input.expiresAt.getTime() - Date.now()).toBeGreaterThan(89.9 * 24 * 3600 * 1000);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toBe(body.token);
  });

  it('creates a token without expiry', async () => {
    const { app, apiTokens } = buildApp();
    const r = await app.inject({ method: 'POST', url: '/api-tokens', payload: { name: 'ci', scopes: ['read'] } });
    expect(r.statusCode).toBe(201);
    expect(apiTokens.create.mock.calls[0][1].expiresAt).toBeNull();
  });

  it.each([
    ['no scopes', { name: 'a', scopes: [] }],
    ['an unknown scope', { name: 'a', scopes: ['read', 'admin'] }],
    ['a blank name', { name: '   ', scopes: ['read'] }],
    ['a name over 80 chars', { name: 'x'.repeat(81), scopes: ['read'] }],
    ['expiry 0 days', { name: 'a', scopes: ['read'], expires_in_days: 0 }],
    ['expiry 366 days', { name: 'a', scopes: ['read'], expires_in_days: 366 }],
    ['a fractional expiry', { name: 'a', scopes: ['read'], expires_in_days: 1.5 }],
  ])('rejects %s with 400 and creates nothing', async (_n, payload) => {
    const { app, apiTokens } = buildApp();
    const r = await app.inject({ method: 'POST', url: '/api-tokens', payload });
    expect(r.statusCode).toBe(400);
    expect(apiTokens.create).not.toHaveBeenCalled();
  });

  it('refuses a 21st active token with 409', async () => {
    const { app, apiTokens } = buildApp({ active: 20 });
    const r = await app.inject({ method: 'POST', url: '/api-tokens', payload: { name: 'a', scopes: ['read'] } });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe('Limite de 20 tokens ativos: revogue um antes de criar outro');
    expect(apiTokens.create).not.toHaveBeenCalled();
  });

  it('lists the caller\'s tokens and never a hash', async () => {
    const { app } = buildApp();
    const r = await app.inject({ method: 'GET', url: '/api-tokens' });
    expect(r.statusCode).toBe(200);
    expect(r.json().tokens).toHaveLength(1);
    expect(r.body).not.toMatch(/hash/i);
  });

  it('an admin viewing as another user still manages only their own tokens', async () => {
    const { app, apiTokens } = buildApp({ viewAs: 'u2' });
    await app.inject({ method: 'GET', url: '/api-tokens' });
    expect(apiTokens.listByUser).toHaveBeenCalledWith('u1');
    await app.inject({ method: 'POST', url: '/api-tokens', payload: { name: 'a', scopes: ['read'] } });
    expect(apiTokens.countActive).toHaveBeenCalledWith('u1');
    expect(apiTokens.create.mock.calls[0][0]).toBe('u1');
    await app.inject({ method: 'DELETE', url: '/api-tokens/t1' });
    expect(apiTokens.revoke).toHaveBeenCalledWith('t1', 'u1');
  });

  it('revokes the caller\'s token and 404s anyone else\'s', async () => {
    const { app } = buildApp();
    const ok = await app.inject({ method: 'DELETE', url: '/api-tokens/t1' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().api_token.revoked_at).not.toBeNull();
    const nope = await app.inject({ method: 'DELETE', url: '/api-tokens/t9' });
    expect(nope.statusCode).toBe(404);
    expect(nope.json().error).toBe('Token não encontrado');
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run (unit shorthand): `cd apps/server && npx vitest run src/routes/api-tokens.test.ts`
Expected: FAIL — cannot resolve `./api-tokens.js`.

- [ ] **Step 3: Implement the routes**

`apps/server/src/routes/api-tokens.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Repositories } from '../db/repositories/index.js';
import { API_TOKEN_SCOPES, MAX_ACTIVE_TOKENS_PER_USER, newApiToken, toScopes } from '../auth/api-tokens.js';
import { conflict, notFound } from '../lib/errors.js';

const DAY_MS = 24 * 60 * 60 * 1000;

const idParam = z.object({ id: z.string().min(1).max(64) });
const createBody = z.object({
  name: z.string().trim().min(1).max(80),
  scopes: z.array(z.enum(API_TOKEN_SCOPES)).min(1),
  expires_in_days: z.number().int().min(1).max(365).optional().nullable(),
});

/**
 * Personal API tokens (Settings → Tokens de API). Always the signed-in user's own tokens:
 * `request.user`, never `request.scope` — an admin "viewing as" someone does not get their tokens.
 */
export async function apiTokenRoutes(app: FastifyInstance, repos: Repositories, opts: { mcpUrl: string | null }) {
  app.get('/', async (request) => ({ tokens: await repos.apiTokens.listByUser(request.user!.id) }));

  app.post('/', async (request, reply) => {
    const body = createBody.parse(request.body ?? {});
    const userId = request.user!.id;
    if ((await repos.apiTokens.countActive(userId)) >= MAX_ACTIVE_TOKENS_PER_USER) {
      throw conflict(`Limite de ${MAX_ACTIVE_TOKENS_PER_USER} tokens ativos: revogue um antes de criar outro`);
    }
    const { token, hash } = newApiToken();
    const expiresAt = body.expires_in_days ? new Date(Date.now() + body.expires_in_days * DAY_MS) : null;
    const apiToken = await repos.apiTokens.create(userId, { name: body.name, scopes: toScopes(body.scopes), expiresAt }, hash);
    // The only response that ever carries the plain token.
    return reply.code(201).send({ api_token: apiToken, token, mcp_url: opts.mcpUrl });
  });

  app.delete('/:id', async (request) => {
    const { id } = idParam.parse(request.params);
    const apiToken = await repos.apiTokens.revoke(id, request.user!.id);
    if (!apiToken) throw notFound('Token não encontrado');
    return { api_token: apiToken };
  });
}
```

`z.enum(API_TOKEN_SCOPES)` needs a non-empty readonly tuple — `API_TOKEN_SCOPES` is declared `as const`, so it type-checks as-is.

- [ ] **Step 4: Resource, registration, config**

`apps/server/src/auth/permissions.ts`, in `RESOURCES` right after `{ key: 'uploads', label: 'Arquivos enviados' },`:

```ts
  { key: 'api_tokens', label: 'Tokens de API' },
```

`apps/server/src/config.ts`, in `envSchema` right after `HOOKS_URL`:

```ts
  /**
   * Public MCP endpoint (https://termhub.dev/mcp in production), shown in the "claude mcp add"
   * command when a token is created. Unset = the command is not shown.
   */
  MCP_URL: z.string().url().optional(),
```

and in the exported `config` object, next to `hooksUrl`:

```ts
  mcpUrl: env.MCP_URL ?? null,
```

`apps/server/src/app.ts`: import `apiTokenRoutes` from `./routes/api-tokens.js` and register after the `uploads` line:

```ts
      await guarded('api_tokens', (a) => apiTokenRoutes(a, repos, { mcpUrl: config.mcpUrl }), '/api-tokens');
```

(`config` is already imported in `app.ts`; if not, import it from `./config.js`.)

`.env.example`, after the `HOOKS_URL` block:

```bash

# Endpoint MCP público (terminal global). Aparece no comando "claude mcp add" quando um token de
# API é criado (Configurações → Tokens de API). Vazio = o comando não aparece.
# MCP_URL=https://termhub.dev/mcp
```

- [ ] **Step 5: Run the route tests, the suite and the typecheck**

Run (unit shorthand): `cd apps/server && npx vitest run src/routes/api-tokens.test.ts && npx vitest run && npx tsc --noEmit -p tsconfig.json`
Expected: 13 route tests PASS; the suite passes; typecheck passes.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/routes/api-tokens.ts apps/server/src/routes/api-tokens.test.ts apps/server/src/auth/permissions.ts apps/server/src/app.ts apps/server/src/config.ts .env.example
git commit -m "API tokens: create, list and revoke routes under a new api_tokens resource"
```

---

### Task 4: Settings → Tokens de API

**Files:**
- Modify: `apps/web/src/lib/types.ts` (append the token types)
- Modify: `apps/web/src/lib/api.ts` (add `apiTokens`)
- Create: `apps/web/src/lib/settings-sections.ts`
- Test: `apps/web/src/lib/settings-sections.test.ts`
- Create: `apps/web/src/components/ApiTokensView.tsx`
- Test: `apps/web/src/components/ApiTokensView.test.tsx`
- Modify: `apps/web/src/pages/SettingsPage.tsx`
- Modify: `apps/web/src/components/Sidebar.tsx`

**Interfaces:**
- Consumes: the HTTP contract from Task 3.
- Produces: `type ApiTokenScope`, `interface ApiToken`, `interface CreatedApiToken`; `api.apiTokens.list() → { tokens }`, `.create(input) → CreatedApiToken`, `.revoke(id) → { api_token }`; `SETTINGS_SECTIONS`, `canSeeSettings(can)`; `mcpAddCommand(url, token)`, `tokenStatus(t, now?)`; `<ApiTokensView />`.

- [ ] **Step 1: Types, API client, sections**

Append to `apps/web/src/lib/types.ts`:

```ts
export type ApiTokenScope = 'read' | 'tasks' | 'terminals';

/** Personal API token as the server lists it (never the secret). */
export interface ApiToken {
  id: string;
  user_id: string;
  name: string;
  scopes: ApiTokenScope[];
  expires_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

/** Create response: the only time the plain token is ever returned. */
export interface CreatedApiToken {
  api_token: ApiToken;
  token: string;
  mcp_url: string | null;
}
```

In `apps/web/src/lib/api.ts`, add `ApiToken, ApiTokenScope, CreatedApiToken` to the type import and, next to `users:`, add:

```ts
  apiTokens: {
    list: () => request<{ tokens: ApiToken[] }>('GET', '/api-tokens'),
    create: (input: { name: string; scopes: ApiTokenScope[]; expires_in_days: number | null }) => request<CreatedApiToken>('POST', '/api-tokens', input),
    revoke: (id: string) => request<{ api_token: ApiToken }>('DELETE', `/api-tokens/${id}`),
  },
```

`apps/web/src/lib/settings-sections.ts`:

```ts
/** Settings tabs and the resource that unlocks each. The sidebar shows "Configurações" when any is visible. */
export type SettingsSection = 'users' | 'roles' | 'permissions' | 'uploads' | 'api-tokens';

export const SETTINGS_SECTIONS: { key: SettingsSection; label: string; resource: string }[] = [
  { key: 'users', label: 'Usuários', resource: 'users' },
  { key: 'roles', label: 'Roles', resource: 'roles' },
  { key: 'permissions', label: 'Permissões', resource: 'roles' },
  { key: 'uploads', label: 'Arquivos', resource: 'uploads' },
  { key: 'api-tokens', label: 'Tokens de API', resource: 'api_tokens' },
];

export function canSeeSettings(can: (resource: string) => boolean): boolean {
  return SETTINGS_SECTIONS.some((s) => can(s.resource));
}
```

`apps/web/src/lib/settings-sections.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { canSeeSettings, SETTINGS_SECTIONS } from './settings-sections';

describe('settings sections', () => {
  it('shows Settings to a user whose only grant is api_tokens', () => {
    expect(canSeeSettings((r) => r === 'api_tokens')).toBe(true);
  });

  it('hides Settings without any settings grant', () => {
    expect(canSeeSettings((r) => r === 'machines')).toBe(false);
  });

  it('has a Tokens de API tab guarded by api_tokens', () => {
    expect(SETTINGS_SECTIONS.find((s) => s.key === 'api-tokens')).toEqual({ key: 'api-tokens', label: 'Tokens de API', resource: 'api_tokens' });
  });
});
```

In `apps/web/src/pages/SettingsPage.tsx`: delete the local `type Section` and `SECTIONS` constant, import `{ SETTINGS_SECTIONS, type SettingsSection }` from `../lib/settings-sections` and `{ ApiTokensView }` from `../components/ApiTokensView`, replace `SECTIONS` with `SETTINGS_SECTIONS` (and any `Section` type use with `SettingsSection`), and add to the section switch:

```tsx
        {current === 'api-tokens' && <ApiTokensView />}
```

Update the file's top doc comment to mention the personal API tokens.

In `apps/web/src/components/Sidebar.tsx`: import `{ canSeeSettings }` from `../lib/settings-sections` and replace `(can('users') || can('roles') || can('uploads'))` with `canSeeSettings(can)`.

- [ ] **Step 2: Write the failing component test**

`apps/web/src/components/ApiTokensView.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiTokensView, mcpAddCommand, tokenStatus } from './ApiTokensView';
import type { ApiToken } from '../lib/types';

const listMock = vi.fn();
const createMock = vi.fn();
const revokeMock = vi.fn();

vi.mock('../lib/api', () => {
  class ApiError extends Error {}
  return {
    ApiError,
    api: { apiTokens: { list: (...a: unknown[]) => listMock(...a), create: (...a: unknown[]) => createMock(...a), revoke: (...a: unknown[]) => revokeMock(...a) } },
  };
});

vi.mock('../lib/auth', () => ({ useAuth: () => ({ can: () => true }) }));

const tok = (over: Partial<ApiToken> & { id: string }): ApiToken => ({
  user_id: 'u1',
  name: over.id,
  scopes: ['read'],
  expires_at: null,
  last_used_at: null,
  revoked_at: null,
  created_at: '2026-09-19T00:00:00.000Z',
  ...over,
});

const SECRET = 'thb_pat_' + 'A'.repeat(43);

beforeEach(() => {
  listMock.mockResolvedValue({ tokens: [] });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('tokenStatus', () => {
  const now = new Date('2026-09-19T12:00:00.000Z');
  it('is revoked, expired or active', () => {
    expect(tokenStatus(tok({ id: 'a', revoked_at: '2026-09-19T01:00:00.000Z' }), now)).toBe('revoked');
    expect(tokenStatus(tok({ id: 'b', expires_at: '2026-09-19T11:59:59.000Z' }), now)).toBe('expired');
    expect(tokenStatus(tok({ id: 'c', expires_at: '2026-09-20T00:00:00.000Z' }), now)).toBe('active');
    expect(tokenStatus(tok({ id: 'd' }), now)).toBe('active');
  });
});

describe('mcpAddCommand', () => {
  it('builds the claude mcp add command', () => {
    expect(mcpAddCommand('https://termhub.dev/mcp', SECRET)).toBe(`claude mcp add --transport http termhub https://termhub.dev/mcp --header "Authorization: Bearer ${SECRET}"`);
  });
});

describe('ApiTokensView', () => {
  it('lists tokens with their status', async () => {
    listMock.mockResolvedValue({
      tokens: [
        tok({ id: 'laptop', scopes: ['read', 'terminals'] }),
        tok({ id: 'old', expires_at: '2000-01-01T00:00:00.000Z' }),
        tok({ id: 'gone', revoked_at: '2026-09-19T01:00:00.000Z' }),
      ],
    });
    render(<ApiTokensView />);
    const laptop = (await screen.findByText('laptop')).closest('tr')!;
    expect(within(laptop).getByText('ler, terminais')).toBeTruthy();
    expect(within(laptop).getByText('nunca')).toBeTruthy();
    expect(within(screen.getByText('old').closest('tr')!).getByText('expirado')).toBeTruthy();
    expect(within(screen.getByText('gone').closest('tr')!).getByText('revogado')).toBeTruthy();
    expect(within(screen.getByText('gone').closest('tr')!).queryByRole('button', { name: /Revogar/ })).toBeNull();
  });

  it('creates a token, shows it once with the mcp command, and forgets it on close', async () => {
    createMock.mockResolvedValue({ api_token: tok({ id: 'new', name: 'laptop', scopes: ['read', 'tasks'] }), token: SECRET, mcp_url: 'https://termhub.dev/mcp' });
    render(<ApiTokensView />);
    fireEvent.click(await screen.findByRole('button', { name: 'Novo token' }));

    const create = screen.getByRole('button', { name: 'Criar token' });
    fireEvent.change(screen.getByLabelText('Nome'), { target: { value: '  laptop ' } });
    fireEvent.click(screen.getByLabelText(/^Ler/));
    fireEvent.click(screen.getByLabelText(/^Tarefas/));
    fireEvent.change(screen.getByLabelText('Validade'), { target: { value: '30' } });
    fireEvent.click(create);

    await waitFor(() => expect(createMock).toHaveBeenCalledWith({ name: 'laptop', scopes: ['read', 'tasks'], expires_in_days: 30 }));
    expect(await screen.findByDisplayValue(SECRET)).toBeTruthy();
    expect(screen.getByText(/não aparece de novo/)).toBeTruthy();
    expect(screen.getByDisplayValue(mcpAddCommand('https://termhub.dev/mcp', SECRET))).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Concluído' }));
    expect(screen.queryByDisplayValue(SECRET)).toBeNull();
    expect(await screen.findByText('laptop')).toBeTruthy();
  });

  it('hides the mcp command when the server has no MCP_URL', async () => {
    createMock.mockResolvedValue({ api_token: tok({ id: 'new' }), token: SECRET, mcp_url: null });
    render(<ApiTokensView />);
    fireEvent.click(await screen.findByRole('button', { name: 'Novo token' }));
    fireEvent.change(screen.getByLabelText('Nome'), { target: { value: 'x' } });
    fireEvent.click(screen.getByLabelText(/^Ler/));
    fireEvent.click(screen.getByRole('button', { name: 'Criar token' }));
    expect(await screen.findByDisplayValue(SECRET)).toBeTruthy();
    expect(screen.queryByDisplayValue(/claude mcp add/)).toBeNull();
  });

  it('keeps Criar token disabled without a name or a scope', async () => {
    render(<ApiTokensView />);
    fireEvent.click(await screen.findByRole('button', { name: 'Novo token' }));
    const create = screen.getByRole('button', { name: 'Criar token' }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Nome'), { target: { value: 'x' } });
    expect(create.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(/^Terminais/));
    expect(create.disabled).toBe(false);
  });

  it('revokes after confirmation', async () => {
    listMock.mockResolvedValue({ tokens: [tok({ id: 'laptop' })] });
    revokeMock.mockResolvedValue({ api_token: tok({ id: 'laptop', revoked_at: '2026-09-19T02:00:00.000Z' }) });
    render(<ApiTokensView />);
    fireEvent.click(await screen.findByRole('button', { name: 'Revogar laptop' }));
    fireEvent.click(screen.getByRole('button', { name: 'Revogar' }));
    await waitFor(() => expect(revokeMock).toHaveBeenCalledWith('laptop'));
    expect(await screen.findByText('revogado')).toBeTruthy();
  });
});
```

- [ ] **Step 3: Run it to make sure it fails**

Run (unit shorthand): `cd apps/web && npx vitest run src/components/ApiTokensView.test.tsx src/lib/settings-sections.test.ts`
Expected: `settings-sections` PASS (written in Step 1); `ApiTokensView` FAIL — cannot resolve `./ApiTokensView`.

- [ ] **Step 4: Implement the view**

`apps/web/src/components/ApiTokensView.tsx`:

```tsx
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import type { ApiToken, ApiTokenScope, CreatedApiToken } from '../lib/types';
import { ConfirmDialog, Modal } from './Modal';

const SCOPES: { key: ApiTokenScope; label: string; short: string; hint: string }[] = [
  { key: 'read', label: 'Ler', short: 'ler', hint: 'máquinas, projetos, abas, contas de IA e a tela dos terminais' },
  { key: 'tasks', label: 'Tarefas', short: 'tarefas', hint: 'criar, editar e mover tarefas e subtarefas' },
  { key: 'terminals', label: 'Terminais', short: 'terminais', hint: 'abrir abas, digitar e iniciar agentes nas suas máquinas' },
];
const EXPIRY: { value: string; label: string }[] = [
  { value: '30', label: '30 dias' },
  { value: '90', label: '90 dias' },
  { value: '365', label: '1 ano' },
  { value: '', label: 'Sem validade' },
];

export type TokenStatus = 'active' | 'expired' | 'revoked';

export function tokenStatus(t: ApiToken, now = new Date()): TokenStatus {
  if (t.revoked_at) return 'revoked';
  if (t.expires_at && new Date(t.expires_at) <= now) return 'expired';
  return 'active';
}

export function mcpAddCommand(url: string, token: string): string {
  return `claude mcp add --transport http termhub ${url} --header "Authorization: Bearer ${token}"`;
}

const fmtDate = (iso: string | null, empty: string) => (iso ? new Date(iso).toLocaleDateString('pt-BR') : empty);

/** Settings → Tokens de API: the signed-in user's own tokens for the MCP endpoint. */
export function ApiTokensView() {
  const { can } = useAuth();
  const [tokens, setTokens] = useState<ApiToken[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<CreatedApiToken | null>(null);
  const [revoking, setRevoking] = useState<ApiToken | null>(null);

  const load = useCallback(async () => {
    try {
      setTokens((await api.apiTokens.list()).tokens);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Erro ao carregar tokens');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const revoke = async () => {
    const t = revoking;
    setRevoking(null);
    if (!t) return;
    try {
      const r = await api.apiTokens.revoke(t.id);
      setTokens((list) => (list ?? []).map((x) => (x.id === t.id ? r.api_token : x)));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Erro ao revogar token');
    }
  };

  return (
    <div className="max-w-4xl space-y-4">
      <div className="flex items-start gap-4">
        <p className="flex-1 text-sm text-fg-muted">
          Tokens pessoais para o terminal global (MCP): um Claude Code com o token consegue agir nas suas máquinas dentro dos escopos escolhidos, nunca além das suas próprias permissões. Trate como senha.
        </p>
        {can('api_tokens', 'create') && (
          <button className="btn-primary shrink-0" onClick={() => setCreating(true)}>
            Novo token
          </button>
        )}
      </div>
      {error && <p className="text-sm text-danger">{error}</p>}
      {tokens === null ? (
        <p className="text-sm text-fg-dim">Carregando…</p>
      ) : tokens.length === 0 ? (
        <p className="text-sm text-fg-dim">Nenhum token ainda.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-fg-dim">
              <tr>
                <th className="py-1 pr-3 font-normal">Nome</th>
                <th className="py-1 pr-3 font-normal">Escopos</th>
                <th className="py-1 pr-3 font-normal">Criado</th>
                <th className="py-1 pr-3 font-normal">Último uso</th>
                <th className="py-1 pr-3 font-normal">Validade</th>
                <th className="py-1 font-normal" />
              </tr>
            </thead>
            <tbody>
              {tokens.map((t) => {
                const status = tokenStatus(t);
                return (
                  <tr key={t.id} className={`border-t border-line ${status === 'active' ? '' : 'text-fg-dim'}`}>
                    <td className="py-1.5 pr-3">{t.name}</td>
                    <td className="py-1.5 pr-3">{t.scopes.map((s) => SCOPES.find((x) => x.key === s)?.short ?? s).join(', ')}</td>
                    <td className="py-1.5 pr-3">{fmtDate(t.created_at, '—')}</td>
                    <td className="py-1.5 pr-3">{fmtDate(t.last_used_at, 'nunca')}</td>
                    <td className="py-1.5 pr-3">
                      {status === 'revoked' ? 'revogado' : status === 'expired' ? 'expirado' : fmtDate(t.expires_at, 'sem validade')}
                    </td>
                    <td className="py-1.5 text-right">
                      {status !== 'revoked' && can('api_tokens', 'delete') && (
                        <button className="btn-ghost px-2 py-0.5 text-xs text-danger" aria-label={`Revogar ${t.name}`} onClick={() => setRevoking(t)}>
                          Revogar
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {creating && (
        <CreateTokenModal
          onClose={() => setCreating(false)}
          onCreated={(c) => {
            setCreating(false);
            setCreated(c);
            setTokens((list) => [c.api_token, ...(list ?? [])]);
          }}
        />
      )}
      {created && <CreatedTokenModal created={created} onClose={() => setCreated(null)} />}
      <ConfirmDialog
        open={!!revoking}
        title="Revogar token"
        message={`O token "${revoking?.name ?? ''}" para de funcionar na hora. Isso não pode ser desfeito.`}
        confirmLabel="Revogar"
        danger
        onConfirm={revoke}
        onCancel={() => setRevoking(null)}
      />
    </div>
  );
}

function CreateTokenModal({ onClose, onCreated }: { onClose: () => void; onCreated: (c: CreatedApiToken) => void }) {
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<ApiTokenScope[]>([]);
  const [expiry, setExpiry] = useState('90');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = (s: ApiTokenScope) => setScopes((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const ordered = SCOPES.map((s) => s.key).filter((k) => scopes.includes(k));
      onCreated(await api.apiTokens.create({ name: name.trim(), scopes: ordered, expires_in_days: expiry ? Number(expiry) : null }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Erro ao criar token');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Novo token de API" open onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <div>
          <label className="label" htmlFor="api-token-name">
            Nome
          </label>
          <input id="api-token-name" className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoFocus placeholder="ex.: Claude Code no jarvis" />
        </div>
        <fieldset className="space-y-1.5">
          <legend className="label">Escopos</legend>
          {SCOPES.map((s) => (
            <label key={s.key} className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-1" checked={scopes.includes(s.key)} onChange={() => toggle(s.key)} />
              <span>
                <strong>{s.label}</strong> <span className="text-fg-muted">— {s.hint}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <div>
          <label className="label" htmlFor="api-token-expiry">
            Validade
          </label>
          <select id="api-token-expiry" className="input" value={expiry} onChange={(e) => setExpiry(e.target.value)}>
            {EXPIRY.map((o) => (
              <option key={o.label} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        {error && <p className="text-sm text-danger">{error}</p>}
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" className="btn-primary" disabled={busy || !name.trim() || scopes.length === 0}>
            {busy ? 'Criando…' : 'Criar token'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div>
      <label className="label">{label}</label>
      <div className="flex gap-2">
        <input className="input font-mono text-xs" readOnly value={value} onFocus={(e) => e.currentTarget.select()} />
        <button
          type="button"
          className="btn-ghost shrink-0 border border-line"
          onClick={() => {
            void navigator.clipboard?.writeText(value);
            setCopied(true);
          }}
        >
          {copied ? 'Copiado' : 'Copiar'}
        </button>
      </div>
    </div>
  );
}

function CreatedTokenModal({ created, onClose }: { created: CreatedApiToken; onClose: () => void }) {
  return (
    <Modal title="Token criado" open onClose={onClose} width="max-w-2xl">
      <div className="space-y-3">
        <p className="rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-sm text-warn">Copie agora: este token não aparece de novo. Se perder, revogue e crie outro.</p>
        <CopyField label="Token" value={created.token} />
        {created.mcp_url && (
          <>
            <CopyField label="Conectar o Claude Code" value={mcpAddCommand(created.mcp_url, created.token)} />
            <p className="text-xs text-fg-dim">Rode no terminal da máquina onde está o Claude Code que vai ser o terminal global.</p>
          </>
        )}
        <div className="flex justify-end pt-2">
          <button className="btn-primary" onClick={onClose}>
            Concluído
          </button>
        </div>
      </div>
    </Modal>
  );
}
```

Two test details this code relies on: each scope checkbox sits inside its `<label>`, so its accessible name is that label's text and starts with the scope label (`/^Ler/`, `/^Tarefas/`, `/^Terminais/`), and `ConfirmDialog` renders its confirm button with the `confirmLabel` text ("Revogar"), distinct from the row button's accessible name "Revogar laptop". If `ConfirmDialog`'s props differ from `{ open, title, message, confirmLabel, danger, onConfirm, onCancel }`, adapt the call to its real props — do not change the test's button names.

- [ ] **Step 5: Run the tests, the web suite and the build**

Run (unit shorthand): `cd apps/web && npx vitest run src/components/ApiTokensView.test.tsx src/lib/settings-sections.test.ts && cd /w && npm test -w @termhub/web && npm run build -w @termhub/web`
Expected: 7 view tests + 3 section tests PASS; the web suite passes; the build succeeds.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/lib/types.ts apps/web/src/lib/api.ts apps/web/src/lib/settings-sections.ts apps/web/src/lib/settings-sections.test.ts apps/web/src/components/ApiTokensView.tsx apps/web/src/components/ApiTokensView.test.tsx apps/web/src/pages/SettingsPage.tsx apps/web/src/components/Sidebar.tsx
git commit -m "Settings: Tokens de API — create with scopes and expiry, copy once, revoke"
```

---

### Task 5: Docs and full verification

**Files:**
- Modify: `README.md`

- [ ] **Step 1: README**

In `README.md`, add a subsection right before `### Cloudflare Tunnel`:

```markdown
### API tokens (global terminal)

Settings → **Tokens de API** creates personal tokens (`thb_pat_…`) for the MCP endpoint that lets one agent session drive every machine of an account. Each token has scopes — `read`, `tasks`, `terminals` — and never exceeds its owner's own permissions; only its sha256 is stored, the token is shown once, and it can expire (30/90/365 days) or be revoked at any time. Every call made with a token is recorded as metadata (tool, ids, result, duration — never terminal content) and pruned after 30 days. Set `MCP_URL` (e.g. `https://termhub.dev/mcp`) to show the ready-made `claude mcp add` command when a token is created.
```

- [ ] **Step 2: Full check (CLAUDE.md pre-push, plus every suite with the DB tests)**

Start the test DB (DB shorthand) and run:

```bash
cd apps/server && npx prisma migrate deploy && npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code && cd /w && npm run typecheck -w @termhub/server && npm run build -w @termhub/web && npm run build -w @termhub/landing && npm test -w @termhub/server && npm test -w @termhub/web
```

Stop the DB afterwards. Expected: no drift; everything passes, including the API-token and task DB tests. `git status --short` shows only `README.md`.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "README: personal API tokens for the global terminal"
```

Push and PR are the user's call (the finishing step presents the options).

- [ ] **Step 4: After the merge deploys, confirm on jarvis**

```bash
docker ps --filter name=termhub-app --format '{{.Names}} {{.Status}}'
curl -s -o /dev/null -w '%{http_code}\n' -H 'Host: app.termhub.dev' http://127.0.0.1/
docker exec "termhub-app-$(cat /mnt/hd2tb/projetos/termhub/active-color)" npx --prefix apps/server prisma migrate status --config apps/server/prisma.config.ts
```

Expected: active color healthy, `200`, "Database schema is up to date". Then in the app: Configurações → Tokens de API, create a token with `read`, see it once (no `claude mcp add` line yet — `MCP_URL` is set in PR 3), revoke it.
