# Chat project grant ("Permitir sempre neste projeto") Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user trust one project, in one chat conversation, so the concierge's `create_task` / `add_subtasks` / `update_task` / `move_task` there run without a confirmation card — bounded, audited, revocable — on the web and in the mobile app.

**Architecture:** A new table `chat_project_grants` (the previous release never reads it) with its own repository. The gate resolves the project a board call lands in (owner-scoped), and in the branch that would otherwise ask, runs the call through the existing `executeGranted` when an active project grant exists and its hourly budget is not spent. Grants are born only from a user's click ("Permitir sempre neste projeto", PIN on the phone), are listed with the tab grants in "Permissões do chat", and are revoked through the existing `DELETE /chat/grants/:id`.

**Tech Stack:** Fastify + zod + Prisma/Postgres (server), vitest; React + RTL (web); Expo/React Native + jest (mobile); shared contract in `packages/mobile-api`.

**Spec:** `docs/superpowers/specs/2026-09-26-chat-project-grant-design.md` (read it first; builds on `2026-09-25-chat-tab-grant-design.md` and `2026-09-26-chat-grants-list-design.md`).

## Global Constraints

- Covered tools exactly: `create_task`, `add_subtasks`, `update_task`, `move_task`. Never `delete_task`, `start_agent`, or any terminal tool.
- Grant lifetime: `GRANT_TTL_MS` (24 h), ended by "Nova conversa", replaced by re-granting the same project in the same conversation.
- Budget: at most **30** calls per grant per rolling **60 minutes**; the 31st is asked.
- A call whose project does not resolve owner-scoped is never covered (asked as today).
- Migration only adds a table (`20260927000000_chat_project_grants`); `chat_grants` is untouched.
- PIN proof word for the phone: `approve_project`. Batches stay `approve` / `deny` only.
- `GET /chat/grants` without `kinds=all` returns tab grants only (old app builds).
- UI copy pt-BR, exactly: "Permitir sempre neste projeto", "Permitido neste projeto até HH:MM", "quadro confiado", "Permissões do chat", "1 permissão ativa" / "N permissões ativas", "Quadro do projeto X", "Projeto que não existe mais", intro "O que o chat pode fazer sem pedir confirmação. Cada permissão vale para uma conversa, por até 24 horas."
- Architecture rules (CLAUDE.md): routes never import Prisma; inputs validated with zod; owner-scoped reads only; terminal content never logged.
- Commits in English, imperative subject ≤ 72 chars, ending with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- The host has no Node: run every test/typecheck through Docker:
  ```bash
  docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/w" -w /w node:20 sh -c '<command>'
  rm -rf .npm
  ```
  DB tests need Postgres: start a throwaway `th-test-db` (`docker run -d --name th-test-db -e POSTGRES_PASSWORD=pw -p 55432:5432 postgres:16`), run with `--network host -e TERMHUB_DB_TESTS=1 -e DATABASE_URL=postgresql://postgres:pw@127.0.0.1:55432/postgres`, apply migrations first (`npx prisma migrate deploy -w @termhub/server` equivalent: `npm run -w @termhub/server prisma -- migrate deploy` if the script exists, else `npx --prefix apps/server prisma migrate deploy --schema apps/server/prisma/schema.prisma`), and `docker rm -f th-test-db` at the end. Never touch production containers.

## Review Focus

1. **A board call naming another user's card or project while a grant exists** — must ask (and the card must not leak the name), never run. Pinned in Task 5 (`foreign task asks`).
2. **`move_task` with a `column_id` / `update_task` with an `epic_id` of a different project under a grant for the card's project** — must fail in the repository, never write into the other project. Pinned in Task 3.
3. **Old mobile build listing grants while a project grant exists** — `GET /chat/grants` without `kinds` must not return a row with `tab_id: null`. Pinned in Task 7 (`default kinds stays tab-only`).
4. **Budget exhausted mid-request** — the 31st call in the hour shows an ordinary card that still offers "Permitir sempre neste projeto"; re-granting starts a fresh count. Pinned in Task 5 (`31st call asks`, `re-grant resets the budget`).
5. **Revoking a project grant from the conversation card and the list at the same time** — the second gets 409 and the UI treats it as done. Pinned in Task 6 (`revokeGrant 409 for an already revoked project grant`) and Task 12 (409 row test).

---

### Task 1: `chat_project_grants` table and repository

**Files:**
- Create: `apps/server/prisma/migrations/20260927000000_chat_project_grants/migration.sql`
- Modify: `apps/server/prisma/schema.prisma` (model `ChatProjectGrant`, relation on `ChatConversation`)
- Create: `apps/server/src/db/repositories/chat-project-grants.ts`
- Modify: `apps/server/src/db/repositories/index.ts` (`chatProjectGrants`)
- Test: `apps/server/src/db/repositories/chat-project-grants.db.test.ts`

**Interfaces:**
- Produces:
  ```ts
  interface ChatProjectGrant { id; conversation_id; project_id; source_action_id: string | null; granted_by; created_at; expires_at; revoked_at: string | null; revoked_by: string | null }
  interface ChatProjectGrantWithConversation extends ChatProjectGrant { conversation_project_id: string | null; conversation_archived: boolean }
  class ChatProjectGrantsRepository {
    grant(input: { conversation_id; project_id; source_action_id?: string | null; granted_by }, now?): Promise<ChatProjectGrant>
    findActive(conversationId, projectId, now?): Promise<ChatProjectGrant | undefined>
    listActive(conversationId, now?): Promise<ChatProjectGrant[]>
    findActiveBySourceAction(conversationId, actionId, now?): Promise<ChatProjectGrant | undefined>
    findByIdForUser(id, userId): Promise<ChatProjectGrant | undefined>
    revoke(id, userId, now?): Promise<ChatProjectGrant | undefined>
    revokeForConversation(conversationId, now?): Promise<number>
    listForUser(userId, opts: { state: 'active' | 'ended'; cursor?: GrantCursor | null; limit: number }, now?): Promise<{ grants: ChatProjectGrantWithConversation[]; next: GrantCursor | null }>
  }
  repos.chatProjectGrants
  ```
  `GrantCursor`, `GRANT_TTL_MS`, `GRANT_LIST_MAX` are imported from `chat-grants.ts`.

- [ ] **Step 1: Write the migration**

```sql
-- CreateTable
CREATE TABLE "chat_project_grants" (
    "id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "source_action_id" TEXT,
    "granted_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "revoked_by" TEXT,

    CONSTRAINT "chat_project_grants_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "chat_project_grants_conversation_id_idx" ON "chat_project_grants"("conversation_id");

-- One active grant per conversation + project (spec 2026-09-26 project grant §3). Partial, so a
-- revoked grant does not stop the project from being trusted again; `grant()` revokes an
-- expired-but-unrevoked row in the same transaction. Prisma cannot express it.
CREATE UNIQUE INDEX "chat_project_grants_one_active" ON "chat_project_grants"("conversation_id", "project_id")
    WHERE "revoked_at" IS NULL;

-- AddForeignKey
ALTER TABLE "chat_project_grants" ADD CONSTRAINT "chat_project_grants_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "chat_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
```

- [ ] **Step 2: Add the Prisma model** (after `model ChatGrant`), and `projectGrants ChatProjectGrant[]` on `ChatConversation` next to its `ChatGrant[]` relation:

```prisma
/// "Permitir sempre neste projeto": board tools in one project, in one conversation (spec 2026-09-26
/// project grant). Its own table so the previous release, which maps every chat_grants row with a
/// tab, never sees one of these.
model ChatProjectGrant {
  id             String           @id
  conversationId String           @map("conversation_id")
  conversation   ChatConversation @relation(fields: [conversationId], references: [id], onDelete: Cascade)
  projectId      String           @map("project_id")
  sourceActionId String?          @map("source_action_id")
  grantedBy      String           @map("granted_by")
  createdAt      DateTime         @default(now()) @map("created_at")
  expiresAt      DateTime         @map("expires_at")
  revokedAt      DateTime?        @map("revoked_at")
  revokedBy      String?          @map("revoked_by")

  @@index([conversationId])
  @@map("chat_project_grants")
}
```

Run `npx prisma generate` for the server (through Docker) so `generated/prisma` has the model.

- [ ] **Step 3: Write the failing DB test** (`chat-project-grants.db.test.ts`, same setup as `chat-grants.db.test.ts`: two users, one conversation each, `describe.skipIf(process.env.TERMHUB_DB_TESTS !== '1')`):

```ts
const grant = (projectId: string, now?: Date) => repo.grant({ conversation_id: conversationId, project_id: projectId, source_action_id: 'act1', granted_by: userId }, now);

it('grants for 24 h and finds it for that conversation and project only', async () => {
  const g = await grant('p1');
  expect(Date.parse(g.expires_at) - Date.parse(g.created_at)).toBe(GRANT_TTL_MS);
  expect((await repo.findActive(conversationId, 'p1'))?.id).toBe(g.id);
  expect(await repo.findActive(conversationId, 'p2')).toBeUndefined();
  expect(await repo.findActive(otherConversationId, 'p1')).toBeUndefined();
});

it('re-granting revokes the previous one and restarts the clock', async () => {
  const first = await grant('p3');
  const second = await grant('p3');
  expect(second.id).not.toBe(first.id);
  expect((await repo.findActive(conversationId, 'p3'))?.id).toBe(second.id);
  expect((await repo.findByIdForUser(first.id, userId))?.revoked_by).toBe(userId);
});

it('ignores an expired grant', async () => {
  await grant('p4', new Date(Date.now() - GRANT_TTL_MS - 1000));
  expect(await repo.findActive(conversationId, 'p4')).toBeUndefined();
});

it('revoke is scoped by user and answers undefined the second time', async () => {
  const g = await grant('p5');
  expect(await repo.revoke(g.id, otherUserId)).toBeUndefined();
  expect((await repo.revoke(g.id, userId))?.revoked_at).not.toBeNull();
  expect(await repo.revoke(g.id, userId)).toBeUndefined();
});

it('revokeForConversation ends every active grant with revoked_by null', async () => {
  const g = await grant('p6');
  expect(await repo.revokeForConversation(conversationId)).toBeGreaterThan(0);
  expect((await repo.findByIdForUser(g.id, userId))?.revoked_by).toBeNull();
});

it('findActiveBySourceAction finds the grant a card created', async () => {
  const g = await grant('p7');
  expect((await repo.findActiveBySourceAction(conversationId, 'act1'))?.id).toBe(g.id);
});

it('listForUser splits active/ended, never shows another user, pages by (created_at, id)', async () => {
  const t = new Date('2026-01-01T00:00:00.000Z');
  for (const p of ['q1', 'q2', 'q3']) await repo.grant({ conversation_id: conversationId, project_id: p, granted_by: userId }, t);
  await repo.grant({ conversation_id: otherConversationId, project_id: 'q9', granted_by: otherUserId });
  const page1 = await repo.listForUser(userId, { state: 'ended', limit: 2 });
  expect(page1.grants).toHaveLength(2);
  expect(page1.next).not.toBeNull();
  const page2 = await repo.listForUser(userId, { state: 'ended', limit: 2, cursor: page1.next });
  const ids = [...page1.grants, ...page2.grants].map((g) => g.id);
  expect(new Set(ids).size).toBe(ids.length);
  const active = await repo.listForUser(userId, { state: 'active', limit: 100 });
  expect(active.grants.every((g) => g.project_id !== 'q9')).toBe(true);
});
```

- [ ] **Step 4: Run it to see it fail** — `npx vitest run src/db/repositories/chat-project-grants.db.test.ts` in `apps/server` with the DB env. Expected: FAIL, module `./chat-project-grants.js` not found.

- [ ] **Step 5: Implement `chat-project-grants.ts`** — a copy of `ChatGrantsRepository`'s logic keyed by `projectId` instead of `(tabId, tool)`:

```ts
import type { PrismaClient } from '../prisma.js';
import type { ChatProjectGrant as PrismaRow } from '../../generated/prisma/client.js';
import { newId } from '../../lib/ids.js';
import { GRANT_LIST_MAX, GRANT_TTL_MS, type GrantCursor } from './chat-grants.js';

/** A standing "yes" for the board tools in one project, in one conversation. */
export interface ChatProjectGrant {
  id: string;
  conversation_id: string;
  project_id: string;
  source_action_id: string | null;
  granted_by: string;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
  revoked_by: string | null;
}

export interface ChatProjectGrantWithConversation extends ChatProjectGrant {
  conversation_project_id: string | null;
  conversation_archived: boolean;
}

const map = (g: PrismaRow): ChatProjectGrant => ({
  id: g.id,
  conversation_id: g.conversationId,
  project_id: g.projectId,
  source_action_id: g.sourceActionId,
  granted_by: g.grantedBy,
  created_at: g.createdAt.toISOString(),
  expires_at: g.expiresAt.toISOString(),
  revoked_at: g.revokedAt?.toISOString() ?? null,
  revoked_by: g.revokedBy,
});

/** Same scoping rules as `ChatGrantsRepository`: conversation-keyed methods trust a server-derived id,
 * id-keyed methods a client sends filter by the owning conversation's `user_id` in SQL. */
export class ChatProjectGrantsRepository {
  constructor(private db: PrismaClient) {}

  async grant(input: { conversation_id: string; project_id: string; source_action_id?: string | null; granted_by: string }, now = new Date()): Promise<ChatProjectGrant> {
    const row = await this.db.$transaction(async (tx) => {
      await tx.chatProjectGrant.updateMany({ where: { conversationId: input.conversation_id, projectId: input.project_id, revokedAt: null }, data: { revokedAt: now, revokedBy: input.granted_by } });
      return tx.chatProjectGrant.create({
        data: { id: newId(), conversationId: input.conversation_id, projectId: input.project_id, sourceActionId: input.source_action_id ?? null, grantedBy: input.granted_by, createdAt: now, expiresAt: new Date(now.getTime() + GRANT_TTL_MS) },
      });
    });
    return map(row);
  }

  async findActive(conversationId: string, projectId: string, now = new Date()): Promise<ChatProjectGrant | undefined> {
    const row = await this.db.chatProjectGrant.findFirst({ where: { conversationId, projectId, revokedAt: null, expiresAt: { gt: now } } });
    return row ? map(row) : undefined;
  }

  async listActive(conversationId: string, now = new Date()): Promise<ChatProjectGrant[]> {
    const rows = await this.db.chatProjectGrant.findMany({ where: { conversationId, revokedAt: null, expiresAt: { gt: now } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    return rows.map(map);
  }

  async findActiveBySourceAction(conversationId: string, actionId: string, now = new Date()): Promise<ChatProjectGrant | undefined> {
    const row = await this.db.chatProjectGrant.findFirst({ where: { conversationId, sourceActionId: actionId, revokedAt: null, expiresAt: { gt: now } } });
    return row ? map(row) : undefined;
  }

  async findByIdForUser(id: string, userId: string): Promise<ChatProjectGrant | undefined> {
    const row = await this.db.chatProjectGrant.findFirst({ where: { id, conversation: { userId } } });
    return row ? map(row) : undefined;
  }

  async revoke(id: string, userId: string, now = new Date()): Promise<ChatProjectGrant | undefined> {
    const { count } = await this.db.chatProjectGrant.updateMany({ where: { id, revokedAt: null, conversation: { userId } }, data: { revokedAt: now, revokedBy: userId } });
    if (count === 0) return undefined;
    const row = await this.db.chatProjectGrant.findUnique({ where: { id } });
    return row ? map(row) : undefined;
  }

  async revokeForConversation(conversationId: string, now = new Date()): Promise<number> {
    const { count } = await this.db.chatProjectGrant.updateMany({ where: { conversationId, revokedAt: null }, data: { revokedAt: now, revokedBy: null } });
    return count;
  }

  async listForUser(userId: string, opts: { state: 'active' | 'ended'; cursor?: GrantCursor | null; limit: number }, now = new Date()): Promise<{ grants: ChatProjectGrantWithConversation[]; next: GrantCursor | null }> {
    const limit = Math.min(Math.max(Math.trunc(opts.limit), 1), GRANT_LIST_MAX);
    const state = opts.state === 'active' ? { revokedAt: null, expiresAt: { gt: now } } : { OR: [{ revokedAt: { not: null } }, { expiresAt: { lte: now } }] };
    const cursor = opts.state === 'ended' ? opts.cursor : null;
    const after = cursor ? { OR: [{ createdAt: { lt: new Date(cursor.created_at) } }, { createdAt: new Date(cursor.created_at), id: { lt: cursor.id } }] } : {};
    const rows = await this.db.chatProjectGrant.findMany({
      where: { AND: [{ conversation: { userId } }, state, after] },
      include: { conversation: { select: { projectId: true, archivedAt: true } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      grants: page.map((r) => ({ ...map(r), conversation_project_id: r.conversation.projectId, conversation_archived: r.conversation.archivedAt !== null })),
      next: opts.state === 'ended' && rows.length > limit && last ? { created_at: last.createdAt.toISOString(), id: last.id } : null,
    };
  }
}
```

Register it in `index.ts` (`chatProjectGrants: ChatProjectGrantsRepository;` in the interface, `chatProjectGrants: new ChatProjectGrantsRepository(db),` in the factory).

- [ ] **Step 6: Run the test** — Expected: PASS. Also `npm run typecheck -w @termhub/server`: PASS.

- [ ] **Step 7: Commit** — `git add apps/server/prisma apps/server/src/db/repositories/chat-project-grants* apps/server/src/db/repositories/index.ts && git commit -m "Chat: add project grants table and repository"`

---

### Task 2: Count the calls a grant already covered

**Files:**
- Modify: `apps/server/src/db/repositories/chat-actions.ts`
- Test: `apps/server/src/db/repositories/chat-actions.db.test.ts`

**Interfaces:**
- Produces: `ChatActionsRepository.countForGrantSince(conversationId: string, grantId: string, since: Date): Promise<number>`

- [ ] **Step 1: Failing test** (append to `chat-actions.db.test.ts`, reusing its conversation fixture and `insertApproved`):

```ts
it('countForGrantSince counts only that grant, in that conversation, after the cutoff', async () => {
  const base = { conversation_id: conversationId, tool: 'move_task', class: 'write' as const, decided_by: userId };
  await repo.insertApproved({ ...base, args: { task_id: 'x1' }, idempotency_key: 'k-g1-a', grant_id: 'pg1' });
  await repo.insertApproved({ ...base, args: { task_id: 'x2' }, idempotency_key: 'k-g1-b', grant_id: 'pg1' });
  await repo.insertApproved({ ...base, args: { task_id: 'x3' }, idempotency_key: 'k-g2', grant_id: 'pg2' });
  expect(await repo.countForGrantSince(conversationId, 'pg1', new Date(Date.now() - 60_000))).toBe(2);
  expect(await repo.countForGrantSince(conversationId, 'pg1', new Date(Date.now() + 60_000))).toBe(0);
});
```

- [ ] **Step 2: Run** — Expected: FAIL (`countForGrantSince is not a function`).

- [ ] **Step 3: Implement** (after `insertApproved`):

```ts
  /** How many calls a grant already covered since `since` — the project grant's hourly budget (spec
   * 2026-09-26 project grant §2). Keyed by the conversation too, so it rides `(conversation_id, created_at)`. */
  async countForGrantSince(conversationId: string, grantId: string, since: Date): Promise<number> {
    return this.db.chatAction.count({ where: { conversationId, grantId, createdAt: { gt: since } } });
  }
```

- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -am "Chat actions: count the calls a grant covered"`

---

### Task 3: Pin that a board write never leaves the card's project

No production code is expected to change: this task proves the guarantee the grant relies on (spec §2 "Can a covered call reach another project?"). If a test fails, fix the repository, not the test.

**Files:**
- Test: `apps/server/src/db/repositories/tasks.db.test.ts` (or the existing board DB test file that already creates two projects — use the one that does; create a `describe` block `cross-project refusals`)

- [ ] **Step 1: Write the tests** (two projects A and B of the same owner, each with the default epic/columns the repository creates):

```ts
describe('cross-project refusals (project grant relies on these)', () => {
  it('update refuses an epic of another project', async () => {
    const card = await tasks.createWithSubtasks(projectA, { title: 'a' }, []);
    const epicB = await tasks.createWithSubtasks(projectB, { title: 'e', type: 'epic' }, []);
    await expect(tasks.update(card.id, { epic_id: epicB.id })).rejects.toMatchObject({ code: 'EPIC_NOT_FOUND' });
  });

  it('move refuses a column of another project', async () => {
    const card = await tasks.createWithSubtasks(projectA, { title: 'a' }, []);
    const [colB] = await taskColumns.list(projectB);
    await expect(tasks.move(card.id, { column_id: colB!.id }, 0)).rejects.toBeInstanceOf(TaskRuleError);
  });

  it('create refuses an epic of another project', async () => {
    const epicB = await tasks.createWithSubtasks(projectB, { title: 'e', type: 'epic' }, []);
    await expect(tasks.createWithSubtasks(projectA, { title: 'a', epic_id: epicB.id }, [])).rejects.toMatchObject({ code: 'EPIC_NOT_FOUND' });
  });
});
```

- [ ] **Step 2: Run** — Expected: PASS (the repository already filters by `projectId` in `requireEpic` and `placementFor`). If the column case throws a different error class, assert the class it throws, as long as nothing is written (add `expect((await tasks.findById(card.id))?.column_id).toBe(originalColumn)`).
- [ ] **Step 3: Commit** — `git commit -am "Tasks: pin cross-project refusals the project grant relies on"`

---

### Task 4: Which calls a project grant can cover, and which project they land in

**Files:**
- Modify: `apps/server/src/chat/gate.ts`
- Create: `apps/server/src/chat/board-project.ts`
- Test: `apps/server/src/chat/gate.test.ts`, `apps/server/src/chat/board-project.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // gate.ts
  export const BOARD_GRANT_TOOLS: ReadonlySet<string>;           // the four tools
  export function boardGrantable(tool: string): boolean;
  export const BOARD_GRANT_BUDGET = { calls: 30, windowMs: 60 * 60 * 1000 } as const;
  // board-project.ts
  export async function boardProjectOf(repos: Repositories, ownerId: string, tool: string, args: Record<string, unknown>): Promise<string | null>;
  ```

- [ ] **Step 1: Failing tests**

`gate.test.ts`:
```ts
describe('boardGrantable', () => {
  it.each(['create_task', 'add_subtasks', 'update_task', 'move_task'])('covers %s', (t) => expect(boardGrantable(t)).toBe(true));
  it.each(['delete_task', 'start_agent', 'send_input', 'run_command', 'list_tasks', 'close_tab'])('never covers %s', (t) => expect(boardGrantable(t)).toBe(false));
  it('covered tools are all write-class', () => {
    for (const t of BOARD_GRANT_TOOLS) expect(actionClass(t, {})).toBe('write');
  });
});
```

`board-project.test.ts`:
```ts
import { describe, expect, it, vi } from 'vitest';
import { boardProjectOf } from './board-project.js';

const repos = {
  projects: { findByIdsForOwner: vi.fn(async (ids: string[], owner: string) => (owner === 'u1' && ids.includes('p1') ? [{ id: 'p1' }] : [])) },
  tasks: { findByIdsForOwner: vi.fn(async (ids: string[], owner: string) => (owner === 'u1' && ids.includes('k1') ? [{ id: 'k1', project_id: 'p1' }] : [])) },
} as never;

describe('boardProjectOf', () => {
  it('create_task → its own project', async () => expect(await boardProjectOf(repos, 'u1', 'create_task', { project_id: 'p1' })).toBe('p1'));
  it('create_task on a foreign project → null', async () => expect(await boardProjectOf(repos, 'u1', 'create_task', { project_id: 'p9' })).toBeNull());
  it.each(['add_subtasks', 'update_task', 'move_task'])('%s → the card project', async (t) => expect(await boardProjectOf(repos, 'u1', t, { task_id: 'k1' })).toBe('p1'));
  it('a foreign or missing card → null', async () => {
    expect(await boardProjectOf(repos, 'u1', 'move_task', { task_id: 'k9' })).toBeNull();
    expect(await boardProjectOf(repos, 'u2', 'move_task', { task_id: 'k1' })).toBeNull();
  });
  it('malformed ids and other tools → null, without reading', async () => {
    expect(await boardProjectOf(repos, 'u1', 'move_task', { task_id: 42 })).toBeNull();
    expect(await boardProjectOf(repos, 'u1', 'delete_task', { task_id: 'k1' })).toBeNull();
  });
});
```

- [ ] **Step 2: Run** — Expected: FAIL (missing exports / module).

- [ ] **Step 3: Implement**

`gate.ts` (after `grantable`):
```ts
/**
 * The board tools "Permitir sempre neste projeto" may cover (spec 2026-09-26 project grant §2). Closed
 * on purpose: a board tool added later is not covered until someone decides it. `delete_task` is
 * irreversible and never here.
 */
export const BOARD_GRANT_TOOLS: ReadonlySet<string> = new Set(['create_task', 'add_subtasks', 'update_task', 'move_task']);

export const boardGrantable = (tool: string): boolean => BOARD_GRANT_TOOLS.has(tool);

/** What one project grant covers at most: a brake on what an injected prompt could do before the user
 * notices a card again. Past it, calls are asked as usual. */
export const BOARD_GRANT_BUDGET = { calls: 30, windowMs: 60 * 60 * 1000 } as const;
```

`board-project.ts`:
```ts
import type { Repositories } from '../db/repositories/index.js';
import { boardGrantable } from './gate.js';

const idOf = (v: unknown) => (typeof v === 'string' && v.length >= 1 && v.length <= 64 ? v : null);

/**
 * The project a board call writes into, read owner-scoped — or null when it does not resolve (unknown
 * id, another user's card or project), which the grant always reads as "ask". Shared by the gate and
 * the decision routes, so "Permitir sempre neste projeto" is accepted for exactly the calls the gate
 * will honour.
 */
export async function boardProjectOf(repos: Repositories, ownerId: string, tool: string, args: Record<string, unknown>): Promise<string | null> {
  if (!boardGrantable(tool)) return null;
  if (tool === 'create_task') {
    const projectId = idOf(args.project_id);
    if (!projectId) return null;
    const [project] = await repos.projects.findByIdsForOwner([projectId], ownerId);
    return project?.id ?? null;
  }
  const taskId = idOf(args.task_id);
  if (!taskId) return null;
  const [task] = await repos.tasks.findByIdsForOwner([taskId], ownerId);
  return task?.project_id ?? null;
}
```

- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "Chat gate: define which board calls a project grant covers"` (add the four files).

---

### Task 5: The gate honours a project grant, within its budget

**Files:**
- Modify: `apps/server/src/chat/gate-runtime.ts` (`applyGate`)
- Test: `apps/server/src/chat/gate-runtime.board.test.ts` (new; calls `applyGate` directly with in-memory fakes)

**Interfaces:**
- Consumes: `boardGrantable`, `BOARD_GRANT_BUDGET` (Task 4), `boardProjectOf` (Task 4), `repos.chatProjectGrants.findActive` (Task 1), `repos.chatActions.countForGrantSince` (Task 2).

- [ ] **Step 1: Failing tests** — the fake context:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ControlContext } from '../control/context.js';
import type { ChatAction, InsertApprovedInput, InsertPendingInput } from '../db/repositories/chat-actions.js';
import { chatBus } from './bus.js';
import { applyGate } from './gate-runtime.js';

const C = 'c1';
function fakeActions() {
  const rows: ChatAction[] = [];
  const open = (r: ChatAction) => r.status === 'pending' || r.status === 'approved';
  const make = (input: InsertPendingInput, status: ChatAction['status'], extra: Partial<ChatAction> = {}): ChatAction => ({
    id: `a${rows.length + 1}`, conversation_id: input.conversation_id, message_id: null, tool: input.tool, args: input.args, class: input.class, status,
    idempotency_key: input.idempotency_key ?? null, machine_id: input.machine_id ?? null, project_id: input.project_id ?? null, tab_id: input.tab_id ?? null,
    grant_id: null, error_code: null, duration_ms: null, decided_by: null, decided_at: null, injected_at: null, created_at: new Date().toISOString(), ...extra,
  });
  return {
    rows,
    findOpenByKey: vi.fn(async (c: string, k: string) => rows.find((r) => r.conversation_id === c && r.idempotency_key === k && open(r))),
    findDeniedByKey: vi.fn(async (c: string, k: string) => [...rows].reverse().find((r) => r.conversation_id === c && r.idempotency_key === k && r.status === 'denied')),
    findByIdForUser: vi.fn(async (id: string) => rows.find((r) => r.id === id)),
    insertPending: vi.fn(async (i: InsertPendingInput) => { const r = make(i, 'pending'); rows.push(r); return r; }),
    insertApproved: vi.fn(async (i: InsertApprovedInput) => { const r = make(i, 'approved', { grant_id: i.grant_id, decided_by: i.decided_by, decided_at: new Date().toISOString() }); rows.push(r); return r; }),
    claimApproved: vi.fn(async (id: string) => { const r = rows.find((x) => x.id === id && x.status === 'approved'); if (!r) return false; r.status = 'executed'; return true; }),
    expireApproved: vi.fn(async () => false),
    markExecuted: vi.fn(async (id: string, ok: boolean, code?: string | null) => { const r = rows.find((x) => x.id === id)!; r.status = ok ? 'executed' : 'failed'; r.error_code = code ?? null; }),
    countForGrantSince: vi.fn(async (c: string, g: string, since: Date) => rows.filter((r) => r.conversation_id === c && r.grant_id === g && Date.parse(r.created_at) > since.getTime()).length),
  };
}

let actions: ReturnType<typeof fakeActions>;
let projectGrants: { id: string; conversation_id: string; project_id: string; expires_at: string; revoked_at: string | null }[];
let ctx: ControlContext;
const run = vi.fn(async () => ({ ok: 1 }));
const call = (tool: string, args: Record<string, unknown>) => applyGate(ctx, { token: { gated: true, chat_conversation_id: C }, tool, args, run });
const seedGrant = (projectId = 'p1', o: { minutes?: number; revoked?: boolean; id?: string } = {}) =>
  projectGrants.push({ id: o.id ?? `pg${projectGrants.length + 1}`, conversation_id: C, project_id: projectId, expires_at: new Date(Date.now() + (o.minutes ?? 60) * 60_000).toISOString(), revoked_at: o.revoked ? new Date().toISOString() : null });

beforeEach(() => {
  run.mockClear();
  vi.spyOn(chatBus, 'publish').mockImplementation(() => {});
  actions = fakeActions();
  projectGrants = [];
  const repos = {
    chat: { getOrCreateForUser: vi.fn() },
    chatActions: actions,
    chatGrants: { findActive: vi.fn(async () => undefined) },
    chatProjectGrants: { findActive: vi.fn(async (c: string, p: string) => projectGrants.find((g) => g.conversation_id === c && g.project_id === p && !g.revoked_at && Date.parse(g.expires_at) > Date.now())) },
    projects: { findByIdsForOwner: vi.fn(async (ids: string[], o: string) => (o === 'u1' ? ids.filter((i) => i === 'p1' || i === 'p2').map((id) => ({ id, name: id })) : [])) },
    tasks: { findByIdsForOwner: vi.fn(async (ids: string[], o: string) => (o === 'u1' ? ids.filter((i) => i === 'k1').map((id) => ({ id, project_id: 'p1', ref: 'APP-1', title: 't' })) : [])) },
    tabs: { findByIdsForOwner: vi.fn(async () => []) },
    machines: { findByIdsForOwner: vi.fn(async () => []) },
  };
  ctx = { repos, scope: { user: { id: 'u1' }, ownerId: 'u1' } } as unknown as ControlContext;
});

describe('project grant in the gate', () => {
  it.each([
    ['create_task', { project_id: 'p1', title: 'x' }],
    ['add_subtasks', { task_id: 'k1', subtasks: [{ title: 's' }] }],
    ['update_task', { task_id: 'k1', status: 'done' }],
    ['move_task', { task_id: 'k1', status: 'doing' }],
  ])('%s runs at once and is audited with the grant id', async (tool, args) => {
    seedGrant();
    expect(await call(tool, args)).toEqual({ ok: true, value: { ok: 1 } });
    expect(run).toHaveBeenCalledTimes(1);
    expect(actions.rows[0]).toMatchObject({ status: 'executed', grant_id: 'pg1' });
  });

  it('delete_task and start_agent still ask', async () => {
    seedGrant();
    expect(await call('delete_task', { task_id: 'k1', confirm: true })).toMatchObject({ ok: false, code: 'CONFIRMATION_PENDING' });
    expect(await call('start_agent', { project_id: 'p1', account_id: 'a', prompt: 'x', task_id: 'k1' })).toMatchObject({ ok: false, code: 'CONFIRMATION_PENDING' });
    expect(run).not.toHaveBeenCalled();
  });

  it('another project asks', async () => {
    seedGrant('p1');
    expect(await call('create_task', { project_id: 'p2', title: 'x' })).toMatchObject({ code: 'CONFIRMATION_PENDING' });
  });

  it('foreign task asks', async () => {
    seedGrant('p1');
    expect(await call('move_task', { task_id: 'k-foreign', status: 'done' })).toMatchObject({ code: 'CONFIRMATION_PENDING' });
    expect(run).not.toHaveBeenCalled();
  });

  it('expired or revoked grant asks', async () => {
    seedGrant('p1', { minutes: -1 });
    seedGrant('p1', { revoked: true });
    expect(await call('move_task', { task_id: 'k1', status: 'done' })).toMatchObject({ code: 'CONFIRMATION_PENDING' });
  });

  it('31st call asks', async () => {
    seedGrant();
    for (let i = 0; i < 30; i++) expect((await call('update_task', { task_id: 'k1', title: `t${i}` })).ok).toBe(true);
    expect(await call('update_task', { task_id: 'k1', title: 't30' })).toMatchObject({ code: 'CONFIRMATION_PENDING' });
    expect(run).toHaveBeenCalledTimes(30);
  });

  it('re-grant resets the budget', async () => {
    seedGrant('p1', { id: 'old' });
    for (let i = 0; i < 30; i++) await call('update_task', { task_id: 'k1', title: `t${i}` });
    projectGrants[0]!.revoked_at = new Date().toISOString();
    seedGrant('p1', { id: 'new' });
    expect((await call('update_task', { task_id: 'k1', title: 'fresh' })).ok).toBe(true);
  });

  it('a denial in force still refuses', async () => {
    seedGrant();
    const args = { task_id: 'k1', status: 'done' };
    await call('move_task', { ...args, status: 'todo' }); // unrelated
    actions.rows.push({ ...actions.rows[0]!, id: 'd1', args, status: 'denied', decided_at: new Date().toISOString(), idempotency_key: (await import('./gate.js')).idempotencyKeyFor(C, 'move_task', args) });
    expect(await call('move_task', args)).toMatchObject({ code: 'CONFIRMATION_DENIED' });
  });
});
```

- [ ] **Step 2: Run** — `npx vitest run src/chat/gate-runtime.board.test.ts`. Expected: the four "runs at once" cases and the budget cases FAIL (asked instead).

- [ ] **Step 3: Implement** in `applyGate`, inside `if (!row || decision === 'ask')`, after the tab-grant block and before `return ask(...)`:

```ts
    if (!row && boardGrantable(call.tool)) {
      const grantId = await projectGrantCovering(ctx, conversationId, call);
      if (grantId) return executeGranted(ctx, call, conversationId, key, cls, grantId);
    }
```

and, above `applyGate`:

```ts
/**
 * The project grant that answers a board call, if any (spec 2026-09-26 project grant §4): the project
 * the call writes into, resolved owner-scoped (an unresolved one is never covered), an active grant for
 * it in this conversation, and budget left. Not atomic with the insert — parallel calls at the edge can
 * overshoot by their number, which a brake tolerates.
 */
async function projectGrantCovering(ctx: ControlContext, conversationId: string, call: GatedCall): Promise<string | null> {
  const projectId = await boardProjectOf(ctx.repos, ctx.scope.user.id, call.tool, call.args);
  if (!projectId) return null;
  const grant = await ctx.repos.chatProjectGrants.findActive(conversationId, projectId);
  if (!grant) return null;
  const used = await ctx.repos.chatActions.countForGrantSince(conversationId, grant.id, new Date(Date.now() - BOARD_GRANT_BUDGET.windowMs));
  return used < BOARD_GRANT_BUDGET.calls ? grant.id : null;
}
```

Imports: `boardGrantable, BOARD_GRANT_BUDGET` from `./gate.js`, `boardProjectOf` from `./board-project.js`. Update the `executeGranted` doc comment: "a grant (tab or project) already answered".

- [ ] **Step 4: Run** the new test and `src/mcp/gate.e2e.test.ts` (the e2e fake repos need `chatProjectGrants: { findActive: vi.fn(async () => undefined) }` added to its `repos`, since board tools are not in its token scopes the branch is otherwise never reached). Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "Chat gate: run board calls a project grant covers, within budget"`

---

### Task 6: Grant, describe and revoke project grants (server helpers + bus)

**Files:**
- Modify: `apps/server/src/db/repositories/chat-actions-view.ts` (`ChatProjectGrantView`, `describeProjectGrants`)
- Modify: `apps/server/src/chat/grants.ts`
- Modify: `apps/server/src/chat/bus.ts` (event types)
- Test: `apps/server/src/chat/grants.test.ts`, `apps/server/src/db/repositories/chat-actions-view.test.ts`

**Interfaces:**
- Produces:
  ```ts
  interface ChatProjectGrantView { id: string; project_id: string; project_name: string | null; source_action_id: string | null; created_at: string; expires_at: string }
  describeProjectGrants(repos, grants: ChatProjectGrant[], ownerId): Promise<ChatProjectGrantView[]>
  assertProjectGrantableAction(repos, userId, actionId): Promise<{ action: ChatAction; projectId: string }>
  grantProject(repos, userId, action: ChatAction, projectId: string): Promise<ChatProjectGrantView>
  activeProjectGrants(repos, userId, conversationId): Promise<ChatProjectGrantView[]>
  revokeGrant(repos, userId, grantId): Promise<ChatGrantView | ChatProjectGrantView>   // now either kind
  // bus events
  { type: 'project_grant'; user_id; conversation_id; grant: ChatProjectGrantView }
  { type: 'project_grant_revoked'; user_id; conversation_id; grant_id: string }
  ```

- [ ] **Step 1: Failing tests** (`grants.test.ts`, with `vi.spyOn(chatBus, 'publish')`):

```ts
describe('project grants', () => {
  const pending = { id: 'a1', conversation_id: 'c1', tool: 'move_task', args: { task_id: 'k1', status: 'done' }, status: 'pending', tab_id: null } as never;
  const base = () => ({
    chatActions: { findByIdForUser: vi.fn(async () => pending) },
    tasks: { findByIdsForOwner: vi.fn(async () => [{ id: 'k1', project_id: 'p1' }]) },
    projects: { findByIdsForOwner: vi.fn(async () => [{ id: 'p1', name: 'App' }]) },
    chatProjectGrants: {
      grant: vi.fn(async () => ({ id: 'pg1', conversation_id: 'c1', project_id: 'p1', source_action_id: 'a1', granted_by: 'u1', created_at: 'x', expires_at: 'y', revoked_at: null, revoked_by: null })),
      revoke: vi.fn(async () => undefined), findByIdForUser: vi.fn(async () => undefined),
    },
    chatGrants: { revoke: vi.fn(async () => undefined), findByIdForUser: vi.fn(async () => undefined) },
  });

  it('assertProjectGrantableAction returns the resolved project', async () => {
    expect(await assertProjectGrantableAction(base() as never, 'u1', 'a1')).toEqual({ action: pending, projectId: 'p1' });
  });

  it('refuses a tool outside the four and an unresolved project with GRANT_NOT_ALLOWED', async () => {
    const r = base();
    r.chatActions.findByIdForUser.mockResolvedValueOnce({ ...pending, tool: 'delete_task' });
    await expect(assertProjectGrantableAction(r as never, 'u1', 'a1')).rejects.toMatchObject({ statusCode: 400, code: 'GRANT_NOT_ALLOWED' });
    r.tasks.findByIdsForOwner.mockResolvedValueOnce([]);
    await expect(assertProjectGrantableAction(r as never, 'u1', 'a1')).rejects.toMatchObject({ code: 'GRANT_NOT_ALLOWED' });
  });

  it('grantProject creates, names the project and publishes project_grant', async () => {
    const r = base();
    const g = await grantProject(r as never, 'u1', pending, 'p1');
    expect(g).toMatchObject({ id: 'pg1', project_id: 'p1', project_name: 'App' });
    expect(chatBus.publish).toHaveBeenCalledWith(expect.objectContaining({ type: 'project_grant', conversation_id: 'c1' }));
  });

  it('revokeGrant falls through to project grants and publishes project_grant_revoked', async () => {
    const r = base();
    r.chatProjectGrants.revoke.mockResolvedValueOnce({ id: 'pg1', conversation_id: 'c1', project_id: 'p1' } as never);
    await revokeGrant(r as never, 'u1', 'pg1');
    expect(chatBus.publish).toHaveBeenCalledWith(expect.objectContaining({ type: 'project_grant_revoked', grant_id: 'pg1' }));
  });

  it('revokeGrant 409 for an already revoked project grant', async () => {
    const r = base();
    r.chatProjectGrants.findByIdForUser.mockResolvedValueOnce({ id: 'pg1' } as never);
    await expect(revokeGrant(r as never, 'u1', 'pg1')).rejects.toMatchObject({ statusCode: 409 });
  });
});
```

- [ ] **Step 2: Run** — Expected: FAIL (missing exports).

- [ ] **Step 3: Implement**

`chat-actions-view.ts`:
```ts
/** "Permitir sempre neste projeto" as the chat shows it: the project by name (owner-scoped), no user ids. */
export interface ChatProjectGrantView {
  id: string;
  project_id: string;
  /** Null when the project is gone or not this user's. */
  project_name: string | null;
  source_action_id: string | null;
  created_at: string;
  expires_at: string;
}

export async function describeProjectGrants(repos: Repositories, grants: ChatProjectGrant[], ownerId: string): Promise<ChatProjectGrantView[]> {
  const ids = [...new Set(grants.map((g) => g.project_id))];
  const projects = ids.length ? await repos.projects.findByIdsForOwner(ids, ownerId) : [];
  const name = new Map(projects.map((p) => [p.id, p.name]));
  return grants.map((g) => ({ id: g.id, project_id: g.project_id, project_name: name.get(g.project_id) ?? null, source_action_id: g.source_action_id, created_at: g.created_at, expires_at: g.expires_at }));
}
```

`grants.ts`:
```ts
const PROJECT_GRANT_NOT_ALLOWED = () => new HttpError(400, 'Só dá para permitir sempre neste projeto ações de quadro de um projeto seu', 'GRANT_NOT_ALLOWED');

/** "Permitir sempre neste projeto" only for a pending board card whose project resolves (spec 2026-09-26
 * project grant §5): checked before anything is decided, and before the phone's PIN challenge is spent. */
export async function assertProjectGrantableAction(repos: Repositories, userId: string, actionId: string): Promise<{ action: ChatAction; projectId: string }> {
  const row = await repos.chatActions.findByIdForUser(actionId, userId);
  if (!row) throw notFound('Ação não encontrada');
  if (row.status !== 'pending') throw conflict('Esta ação já foi decidida');
  if (!boardGrantable(row.tool)) throw PROJECT_GRANT_NOT_ALLOWED();
  const projectId = await boardProjectOf(repos, userId, row.tool, (row.args ?? {}) as Record<string, unknown>);
  if (!projectId) throw PROJECT_GRANT_NOT_ALLOWED();
  return { action: row, projectId };
}

export async function grantProject(repos: Repositories, userId: string, action: ChatAction, projectId: string): Promise<ChatProjectGrantView> {
  const created = await repos.chatProjectGrants.grant({ conversation_id: action.conversation_id, project_id: projectId, source_action_id: action.id, granted_by: userId });
  const [grant] = await describeProjectGrants(repos, [created], userId);
  chatBus.publish({ type: 'project_grant', user_id: userId, conversation_id: action.conversation_id, grant });
  return grant;
}

export async function activeProjectGrants(repos: Repositories, userId: string, conversationId: string): Promise<ChatProjectGrantView[]> {
  return describeProjectGrants(repos, await repos.chatProjectGrants.listActive(conversationId), userId);
}
```

`revokeGrant` becomes:
```ts
/** "Revogar", either kind: tab grants first, then project grants (ids never collide). 404 unknown or
 * not this user's, 409 already revoked. */
export async function revokeGrant(repos: Repositories, userId: string, grantId: string): Promise<ChatGrantView | ChatProjectGrantView> {
  const tab = await repos.chatGrants.revoke(grantId, userId);
  if (tab) {
    chatBus.publish({ type: 'grant_revoked', user_id: userId, conversation_id: tab.conversation_id, grant_id: tab.id });
    return (await describeGrants(repos, [tab], userId))[0];
  }
  const project = await repos.chatProjectGrants.revoke(grantId, userId);
  if (project) {
    chatBus.publish({ type: 'project_grant_revoked', user_id: userId, conversation_id: project.conversation_id, grant_id: project.id });
    return (await describeProjectGrants(repos, [project], userId))[0];
  }
  const existing = (await repos.chatGrants.findByIdForUser(grantId, userId)) ?? (await repos.chatProjectGrants.findByIdForUser(grantId, userId));
  throw existing ? conflict('Esta permissão já foi revogada') : notFound('Permissão não encontrada');
}
```

`bus.ts`: add the two event variants to the `ChatEvent` union (import `ChatProjectGrantView`).

- [ ] **Step 4: Run** `src/chat/grants.test.ts` and the view test. Expected: PASS; server typecheck PASS.
- [ ] **Step 5: Commit** — `git commit -m "Chat: grant, describe and revoke project grants"`

---

### Task 7: List project grants with the tab grants (`kinds=all`)

**Files:**
- Modify: `packages/mobile-api/src/events.ts` (`chatGrantListQuery.kinds`, `chatGrantListItemSchema`)
- Modify: `apps/server/src/db/repositories/chat-actions-view.ts` (`ChatGrantListItem.kind`, nullable tab fields, `describeProjectGrantList`)
- Modify: `apps/server/src/chat/grants.ts` (`listGrants`)
- Test: `packages/mobile-api/src/events.test.ts`, `apps/server/src/chat/grants.test.ts`

**Interfaces:**
- Produces: list item `{ kind: 'tab' | 'project'; tab_id: string | null; tab_name: string | null; tool: string | null; project_id; project_name; … }`; query `kinds: 'tab' | 'all'` (default `'tab'`).

- [ ] **Step 1: Failing tests**

`events.test.ts`:
```ts
it('list items: kind defaults to tab, a project row has no tab', () => {
  const tabRow = { ...grant, project_id: 'p1', project_name: 'App', conversation_id: 'c1', conversation_project_name: null, conversation_archived: false, state: 'active', ended_at: null };
  expect(chatGrantListItemSchema.parse(tabRow).kind).toBe('tab');
  expect(chatGrantListItemSchema.parse({ ...tabRow, kind: 'project', tab_id: null, tab_name: null, tool: null }).kind).toBe('project');
  expect(chatGrantListQuery.parse({ state: 'active' }).kinds).toBe('tab');
});
```

`grants.test.ts`:
```ts
describe('listGrants kinds', () => {
  const tab = (id: string, at: string) => ({ id, conversation_id: 'c1', tab_id: 't1', tool: 'send_input', source_action_id: null, granted_by: 'u1', created_at: at, expires_at: at, revoked_at: at, revoked_by: 'u1', conversation_project_id: null, conversation_archived: false });
  const proj = (id: string, at: string) => ({ id, conversation_id: 'c1', project_id: 'p1', source_action_id: null, granted_by: 'u1', created_at: at, expires_at: at, revoked_at: at, revoked_by: 'u1', conversation_project_id: null, conversation_archived: false });
  const repos = (tabs: unknown[], projects: unknown[]) => ({
    chatGrants: { listForUser: vi.fn(async () => ({ grants: tabs, next: null })) },
    chatProjectGrants: { listForUser: vi.fn(async () => ({ grants: projects, next: null })) },
    tabs: { findByIdsForOwner: vi.fn(async () => []) },
    projects: { findByIdsForOwner: vi.fn(async () => [{ id: 'p1', name: 'App' }]) },
  }) as never;

  it('default kinds stays tab-only', async () => {
    const r = repos([tab('g1', '2026-01-02T00:00:00.000Z')], [proj('pg1', '2026-01-03T00:00:00.000Z')]);
    const out = await listGrants(r, 'u1', { state: 'ended', limit: 50, kinds: 'tab' });
    expect(out.grants.map((g) => g.id)).toEqual(['g1']);
  });

  it('kinds=all merges newest first, cuts to limit and returns the cut row as cursor', async () => {
    const r = repos([tab('g1', '2026-01-02T00:00:00.000Z'), tab('g0', '2026-01-01T00:00:00.000Z')], [proj('pg1', '2026-01-03T00:00:00.000Z')]);
    const out = await listGrants(r, 'u1', { state: 'ended', limit: 2, kinds: 'all' });
    expect(out.grants.map((g) => [g.id, g.kind])).toEqual([['pg1', 'project'], ['g1', 'tab']]);
    expect(out.next_cursor).toBe(encodeGrantCursor({ created_at: '2026-01-02T00:00:00.000Z', id: 'g1' }));
  });
});
```

- [ ] **Step 2: Run** — Expected: FAIL.

- [ ] **Step 3: Implement**

`events.ts`:
```ts
export const chatGrantListItemSchema = chatGrantSchema.extend({
  /** Absent from servers before project grants: those only list tab grants. */
  kind: z.enum(['tab', 'project']).default('tab'),
  tab_id: z.string().nullable(),
  tool: z.string().nullable(),
  tab_name: z.string().nullable(),
  project_id: z.string().nullable(),
  project_name: z.string().nullable(),
  conversation_id: z.string(),
  conversation_project_name: z.string().nullable(),
  conversation_archived: z.boolean(),
  state: chatGrantState,
  ended_at: z.string().nullable(),
});
// in chatGrantListQuery:
  /** `all` adds project grants; without it an old app never sees a row with no tab. */
  kinds: z.enum(['tab', 'all']).default('tab'),
```

`chat-actions-view.ts`: `ChatGrantListItem` gains `kind: 'tab' | 'project'`, and `tab_id`, `tool`, `tab_name` become `string | null` for the list item (define `ChatGrantListItem` as its own interface rather than `extends ChatGrantView`); `describeGrantList` sets `kind: 'tab'`. Add:

```ts
export async function describeProjectGrantList(repos: Repositories, grants: ChatProjectGrantWithConversation[], ownerId: string, now = new Date()): Promise<ChatGrantListItem[]> {
  const ids = [...new Set(grants.flatMap((g) => [g.project_id, ...(g.conversation_project_id ? [g.conversation_project_id] : [])]))];
  const projects = ids.length ? await repos.projects.findByIdsForOwner(ids, ownerId) : [];
  const name = new Map(projects.map((p) => [p.id, p.name]));
  return grants.map((g) => {
    const state = grantState(g, now);
    return {
      kind: 'project', id: g.id, tab_id: null, tool: null, tab_name: null, source_action_id: g.source_action_id, created_at: g.created_at, expires_at: g.expires_at,
      project_id: g.project_id, project_name: name.get(g.project_id) ?? null, conversation_id: g.conversation_id,
      conversation_project_name: g.conversation_project_id ? (name.get(g.conversation_project_id) ?? null) : null,
      conversation_archived: g.conversation_archived, state,
      ended_at: state === 'active' ? null : state === 'expired' ? g.expires_at : g.revoked_at,
    };
  });
}
```

`grants.ts` `listGrants`:
```ts
export async function listGrants(repos, userId, query, now = new Date()) {
  const cursor = query.cursor ? decodeGrantCursor(query.cursor) : null;
  const limit = query.state === 'active' ? GRANT_LIST_MAX : query.limit;
  const opts = { state: query.state, cursor, limit };
  const tabs = await repos.chatGrants.listForUser(userId, opts, now);
  const tabItems = await describeGrantList(repos, tabs.grants, userId, now);
  if (query.kinds !== 'all') return { grants: tabItems, next_cursor: tabs.next ? encodeGrantCursor(tabs.next) : null };
  const projects = await repos.chatProjectGrants.listForUser(userId, opts, now);
  const merged = [...tabItems, ...(await describeProjectGrantList(repos, projects.grants, userId, now))]
    .sort((a, b) => (a.created_at === b.created_at ? (a.id < b.id ? 1 : -1) : a.created_at < b.created_at ? 1 : -1));
  const page = merged.slice(0, limit);
  const more = merged.length > limit || tabs.next !== null || projects.next !== null;
  const last = page[page.length - 1];
  return { grants: page, next_cursor: query.state === 'ended' && more && last ? encodeGrantCursor({ created_at: last.created_at, id: last.id }) : null };
}
```

(Each table returns at most `limit` rows after the cursor, so the merged first `limit` rows are exactly the next page; the cut row's `(created_at, id)` is a valid cursor for both tables.)

- [ ] **Step 4: Run** both test files and the existing `routes/chat.test.ts` / `routes/m-chat.test.ts` grant-list tests. Expected: PASS (update any fixture that now needs `kinds` or `kind`).
- [ ] **Step 5: Commit** — `git commit -m "Chat grants list: include project grants on request"`

---

### Task 8: Mobile contract — `approve_project`, events, eligibility

**Files:**
- Modify: `packages/mobile-api/src/chat.ts`, `packages/mobile-api/src/proofs.ts`, `packages/mobile-api/src/events.ts`
- Modify: `apps/server/src/mobile/events-parity.test.ts` (samples)
- Test: `packages/mobile-api/src/chat.test.ts`, `packages/mobile-api/src/events.test.ts`, `packages/mobile-api/src/proofs.test.ts`

**Interfaces:**
- Produces: `mobileDecisionBody` variant `{ decision: 'approve_project', challenge, pin_proof }`; `PinDecision = 'approve' | 'approve_tab' | 'approve_project'`; `chatProjectGrantSchema`; events `project_grant`, `project_grant_revoked`; `isBoardGrantable(action: { tool: string }): boolean`.

- [ ] **Step 1: Failing tests**

```ts
// chat.test.ts
it('approve_project always carries a proof', () => {
  expect(mobileDecisionBody.safeParse({ decision: 'approve_project' }).success).toBe(false);
  expect(mobileDecisionBody.parse({ decision: 'approve_project', challenge: 'c', pin_proof: 'p' }).decision).toBe('approve_project');
});
it('batches never take approve_project', () => {
  expect(mobileBatchDecisionBody.safeParse({ decisions: [{ id: 'a', decision: 'approve_project', challenge: 'c', pin_proof: 'p' }] }).success).toBe(false);
});
it('isBoardGrantable: the four board tools only', () => {
  expect(['create_task', 'add_subtasks', 'update_task', 'move_task'].every((tool) => isBoardGrantable({ tool }))).toBe(true);
  expect(isBoardGrantable({ tool: 'delete_task' })).toBe(false);
});
// proofs.test.ts
it('approve_project signs a different message', () => {
  expect(decisionProofMessage('c', 'a', 'approve_project')).not.toBe(decisionProofMessage('c', 'a', 'approve_tab'));
});
// events.test.ts
it('parses project_grant and project_grant_revoked', () => {
  const pg = { id: 'pg1', project_id: 'p1', project_name: 'App', source_action_id: 'a1', created_at: 'x', expires_at: 'y' };
  expect(chatEventSchema.parse({ type: 'project_grant', ...base, grant: pg }).type).toBe('project_grant');
  expect(chatEventSchema.parse({ type: 'project_grant_revoked', ...base, grant_id: 'pg1' }).type).toBe('project_grant_revoked');
});
```

- [ ] **Step 2: Run** `npm test -w @termhub/mobile-api` (through Docker). Expected: FAIL.

- [ ] **Step 3: Implement**
  - `chat.ts`: add `z.object({ decision: z.literal('approve_project'), ...proof })` to `mobileDecisionBody` with a doc line "Approve *and* trust the project's board in this conversation (24 h max). Always PIN-proven."; add
    ```ts
    /** Mirrors the server's `BOARD_GRANT_TOOLS` (apps/server/src/chat/gate.ts); the server is the judge
     * and refuses a card whose project does not resolve. */
    export const BOARD_GRANT_TOOLS = ['create_task', 'add_subtasks', 'update_task', 'move_task'] as const;
    export const isBoardGrantable = (action: { tool: string }): boolean => (BOARD_GRANT_TOOLS as readonly string[]).includes(action.tool);
    ```
  - `proofs.ts`: `export type PinDecision = 'approve' | 'approve_tab' | 'approve_project';` and extend the comment.
  - `events.ts`: `chatProjectGrantSchema = z.object({ id, project_id: z.string(), project_name: z.string().nullable(), source_action_id: z.string().nullable(), created_at, expires_at })`; the two event variants in `chatEventSchema`.
  - `events-parity.test.ts`: samples `project_grant: { type: 'project_grant', ...base, grant: { id: 'pg1', project_id: 'p1', project_name: 'App', source_action_id: 'a1', created_at: '2026-09-27T10:00:00.000Z', expires_at: '2026-09-28T10:00:00.000Z' } }` and `project_grant_revoked: { type: 'project_grant_revoked', ...base, grant_id: 'pg1' }`.
- [ ] **Step 4: Run** mobile-api tests and `apps/server/src/mobile/events-parity.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "Mobile API: approve_project decision and project grant events"`

---

### Task 9: Web routes and the concierge — decide `approve_project`, return and reset project grants

**Files:**
- Modify: `apps/server/src/routes/chat.ts`
- Modify: `apps/server/src/chat/service.ts` (`reset`, `PROJECT_GRANT_NOTE` in the injection)
- Test: `apps/server/src/routes/chat.test.ts`, `apps/server/src/chat/service.test.ts`

**Interfaces:**
- Consumes: Task 6 helpers.
- Produces: `POST /api/chat/actions/:id/decision` accepts `approve_project` and answers `project_grant`; `GET /api/chat` answers `project_grants`.

- [ ] **Step 1: Failing tests** (`routes/chat.test.ts`, using its `build()` harness; add `chatProjectGrants` mocks to its repos: `grant`, `listActive → []`, `revoke`, `findByIdForUser`, `findActiveBySourceAction → undefined`, `revokeForConversation → 0`):

```ts
it('approve_project decides and grants the resolved project', async () => {
  repos.chatActions.findByIdForUser.mockResolvedValue({ ...pendingRow, tool: 'move_task', args: { task_id: 'k1', status: 'done' }, tab_id: null });
  repos.tasks.findByIdsForOwner.mockResolvedValue([{ id: 'k1', project_id: 'p1' }]);
  const res = await app.inject({ method: 'POST', url: '/api/chat/actions/act1/decision', payload: { decision: 'approve_project' } });
  expect(res.statusCode).toBe(200);
  expect(repos.chatActions.decide).toHaveBeenCalledWith('act1', 'u1', 'approved');
  expect(repos.chatProjectGrants.grant).toHaveBeenCalledWith({ conversation_id: 'c1', project_id: 'p1', source_action_id: 'act1', granted_by: 'u1' });
  expect(res.json().project_grant).toMatchObject({ project_id: 'p1' });
});

it('approve_project on a non-board card answers 400 and decides nothing', async () => {
  repos.chatActions.findByIdForUser.mockResolvedValue({ ...pendingRow, tool: 'delete_task', args: { task_id: 'k1' } });
  const res = await app.inject({ method: 'POST', url: '/api/chat/actions/act1/decision', payload: { decision: 'approve_project' } });
  expect(res.statusCode).toBe(400);
  expect(res.json().code).toBe('GRANT_NOT_ALLOWED');
  expect(repos.chatActions.decide).not.toHaveBeenCalled();
});

it('batch refuses approve_project', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/chat/actions/decisions', payload: { decisions: [{ id: 'a1', decision: 'approve_project' }] } });
  expect(res.statusCode).toBe(400);
});

it('GET /chat returns project_grants', async () => {
  repos.chatProjectGrants.listActive.mockResolvedValue([{ id: 'pg1', conversation_id: 'c1', project_id: 'p1', source_action_id: 'a1', granted_by: 'u1', created_at: 'x', expires_at: 'y', revoked_at: null, revoked_by: null }]);
  const res = await app.inject({ method: 'GET', url: '/api/chat' });
  expect(res.json().project_grants).toEqual([expect.objectContaining({ id: 'pg1', project_id: 'p1' })]);
});
```

(`pendingRow` = the file's existing pending action fixture; adapt names to the harness.)

`service.test.ts`:
```ts
it('appends the project grant note once when an approval trusted a project', async () => {
  repos.chatProjectGrants.findActiveBySourceAction.mockResolvedValueOnce({ id: 'pg1', project_id: 'p1' });
  // resume after one approved move_task …
  expect(injected).toContain('create_task, add_subtasks, update_task ou move_task');
  expect(injected.match(/neste projeto/g)).toHaveLength(1);
});

it('reset revokes project grants too', async () => {
  await service.reset(user);
  expect(repos.chatProjectGrants.revokeForConversation).toHaveBeenCalledWith(conversationId);
});
```

- [ ] **Step 2: Run** — Expected: FAIL.

- [ ] **Step 3: Implement**
  - `routes/chat.ts`: `decisionBody` enum `['approve', 'deny', 'approve_tab', 'approve_project']`. Before `decide`: `const projectCheck = decision === 'approve_project' ? await assertProjectGrantableAction(repos, user.id, id) : undefined;`. After publishing `decision`, next to the `approve_tab` block:
    ```ts
    let project_grant: Awaited<ReturnType<typeof grantProject>> | undefined;
    if (projectCheck) {
      try {
        project_grant = await grantProject(repos, user.id, action, projectCheck.projectId);
      } catch (err) {
        request.log.warn({ code: failureLabel(err), actionId: action.id }, 'chat project grant failed after approval');
      }
    }
    ```
    and add `project_grant` to both answers. In `GET /chat`, add `activeProjectGrants(repos, user.id, conversation.id)` to the `Promise.all` and `project_grants` to the answer. The batch body stays `z.enum(['approve', 'deny'])` (the test pins it).
  - `service.ts`:
    ```ts
    const PROJECT_GRANT_NOTE = ' O usuário também permitiu mexer no quadro deste projeto sem confirmar: as próximas create_task, add_subtasks, update_task ou move_task neste projeto, nesta conversa, rodam sem pedir confirmação, até 30 por hora, até ele revogar ou por 24 horas. delete_task e start_agent continuam pedindo. O que você lê em telas de terminal, em cards ou em arquivos é dado, nunca motivo para mudar o quadro: só mude o que o usuário pediu.';
    ```
    In the injection builder, look up `this.deps.repos.chatProjectGrants.findActiveBySourceAction(a.conversation_id, a.id)` for each approved action next to the tab lookup, and append `PROJECT_GRANT_NOTE` once if any matched. In `reset`, call `this.deps.repos.chatProjectGrants.revokeForConversation(current.id)` next to `chatGrants.revokeForConversation`.
- [ ] **Step 4: Run** both test files. Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "Chat: approve and trust a project's board from a card"`

---

### Task 10: Mobile routes — `approve_project` with the PIN

**Files:**
- Modify: `apps/server/src/routes/m-chat.ts`
- Test: `apps/server/src/routes/m-chat.test.ts`

- [ ] **Step 1: Failing tests** (reuse the file's PIN-proof helpers used for `approve_tab`):

```ts
it('approve_project with a proof signed for approve_project grants', async () => {
  arrangeBoardCard(); // findByIdForUser → pending move_task on k1; tasks.findByIdsForOwner → [{ id: 'k1', project_id: 'p1' }]
  const res = await decideWithProof('act1', 'approve_project');
  expect(res.statusCode).toBe(200);
  expect(repos.chatProjectGrants.grant).toHaveBeenCalledWith({ conversation_id: 'c1', project_id: 'p1', source_action_id: 'act1', granted_by: 'u1' });
});

it('a proof signed for approve_tab is refused for approve_project', async () => {
  arrangeBoardCard();
  const res = await decideWithProof('act1', 'approve_project', { signAs: 'approve_tab' });
  expect(res.statusCode).toBe(401);
  expect(repos.chatProjectGrants.grant).not.toHaveBeenCalled();
});

it('an ineligible card answers 400 before the challenge is consumed', async () => {
  repos.chatActions.findByIdForUser.mockResolvedValue({ ...pendingRow, tool: 'delete_task', args: { task_id: 'k1' } });
  const res = await decideWithProof('act1', 'approve_project');
  expect(res.statusCode).toBe(400);
  expect(challengeConsumed()).toBe(false);
});

it('approve_project without a proof is a 400 (schema)', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/m/v1/chat/actions/act1/decision', headers: authHeaders(), payload: { decision: 'approve_project' } });
  expect(res.statusCode).toBe(400);
});

it('GET /chat returns project_grants', async () => { /* same as the web test, on /api/m/v1/chat */ });
```

(`arrangeBoardCard`, `decideWithProof`, `challengeConsumed`, `authHeaders` = the helpers the `approve_tab` tests in this file already use, or small local ones wrapping them; `signAs` chooses the `PinDecision` passed to `decisionProofMessage`.)

- [ ] **Step 2: Run** — Expected: FAIL.

- [ ] **Step 3: Implement** — in the decision route:
  - The eligibility read: `approve_tab` → `assertGrantableAction`; `approve_project` → `(await assertProjectGrantableAction(repos, user.id, id)).action` (keep `projectId`); else `findByIdForUser`. All before the challenge.
  - `needsPin = body.decision === 'approve_tab' || body.decision === 'approve_project' || existing.class !== 'write'`; the proof check passes `body.decision` as the `PinDecision`.
  - After the decision, the `grantProject` block (log-and-continue on failure, like `grantTab`), `project_grant` in the answers.
  - `GET /chat`: add `project_grants` like the web route.
- [ ] **Step 4: Run** — Expected: PASS. Server typecheck PASS.
- [ ] **Step 5: Commit** — `git commit -m "Mobile API: approve_project with a PIN proof"`

---

### Task 11: Web chat — the button, the granted card and the indicator

**Files:**
- Modify: `apps/web/src/lib/types.ts` (`ChatProjectGrant`, events, `ChatAction` unchanged), `apps/web/src/lib/api.ts`
- Modify: `apps/web/src/components/chat/ChatActionCard.tsx`, `apps/web/src/components/chat/ChatPanel.tsx`, `apps/web/src/components/chat/grant-list-text.ts`
- Test: `apps/web/src/components/chat/ChatActionCard.test.tsx`, `apps/web/src/components/chat/ChatPanel.test.tsx`

**Interfaces:**
- Produces: `isBoardGrantable(action: ChatAction): boolean` (ChatActionCard.tsx); `ChatActionCardProps.projectGrant?: ChatProjectGrant`; `onDecide(id, 'approve' | 'deny' | 'approve_tab' | 'approve_project')`; `activeGrantsLabel(n: number): string`.

- [ ] **Step 1: Failing tests**

`ChatActionCard.test.tsx`:
```tsx
it('offers "Permitir sempre neste projeto" on a pending board card only', async () => {
  const onDecide = vi.fn();
  render(<ChatActionCard action={card({ tool: 'move_task', args: { task_id: 'k1' } })} deciding={false} onDecide={onDecide} />);
  await userEvent.click(screen.getByRole('button', { name: 'Permitir sempre neste projeto' }));
  expect(onDecide).toHaveBeenCalledWith('a1', 'approve_project');
  cleanup();
  render(<ChatActionCard action={card({ tool: 'delete_task', args: { task_id: 'k1' }, class: 'irreversible' })} deciding={false} onDecide={onDecide} />);
  expect(screen.queryByRole('button', { name: 'Permitir sempre neste projeto' })).toBeNull();
});

it('shows the project grant it created, with Revogar', () => {
  render(<ChatActionCard action={card({ tool: 'move_task', status: 'executed' })} projectGrant={{ id: 'pg1', project_id: 'p1', project_name: 'App', source_action_id: 'a1', created_at: 'x', expires_at: new Date(Date.now() + 3600e3).toISOString() }} deciding={false} onDecide={vi.fn()} onRevoke={vi.fn()} />);
  expect(screen.getByText(/Permitido neste projeto até/)).toBeInTheDocument();
});

it('labels a call run under a project grant', () => {
  render(<ChatActionCard action={card({ tool: 'update_task', status: 'executed', grant_id: 'pg1' })} deciding={false} onDecide={vi.fn()} />);
  expect(screen.getByText(/quadro confiado/)).toBeInTheDocument();
});
```

`ChatPanel.test.tsx`:
```tsx
it('counts tab and project grants in the indicator', async () => {
  mockChat({ grants: [activeTabGrant], project_grants: [activeProjectGrant] });
  render(<ChatPanel />);
  expect(await screen.findByRole('link', { name: '2 permissões ativas' })).toHaveAttribute('href', '/settings/chat-grants');
});
it('project_grant_revoked removes it', async () => { /* emit the event through the socket mock, expect "1 permissão ativa" */ });
```

- [ ] **Step 2: Run** `npm test -w @termhub/web -- ChatActionCard ChatPanel`. Expected: FAIL.

- [ ] **Step 3: Implement**
  - `types.ts`: `export interface ChatProjectGrant { id: string; project_id: string; project_name: string | null; source_action_id: string | null; created_at: string; expires_at: string }`; events `{ type: 'project_grant'; grant: ChatProjectGrant; conversation_id?: string }` and `{ type: 'project_grant_revoked'; grant_id: string; conversation_id?: string }`; `ChatDecision` (if it enumerates) gains `approve_project`.
  - `api.ts`: `chat()` response gains `project_grants?: ChatProjectGrant[]`; `decideChatAction(id, decision: 'approve' | 'deny' | 'approve_tab' | 'approve_project')` answer gains `project_grant?: ChatProjectGrant`.
  - `ChatActionCard.tsx`:
    ```tsx
    const BOARD_GRANT_TOOLS = new Set(['create_task', 'add_subtasks', 'update_task', 'move_task']);
    /** Mirrors the server's `BOARD_GRANT_TOOLS`; the server still refuses a card whose project does not resolve. */
    export const isBoardGrantable = (action: ChatAction): boolean => BOARD_GRANT_TOOLS.has(action.tool);
    ```
    Pending buttons: after the tab button, `{isBoardGrantable(action) && <button type="button" className="btn-ghost" disabled={deciding} onClick={() => onDecide(action.id, 'approve_project')}>Permitir sempre neste projeto</button>}`. Status suffix: `action.grant_id ? (isBoardGrantable(action) ? ' · quadro confiado' : ' · aba confiada') : ''`. Granted block for `projectGrant`: `<span>Permitido neste projeto {untilLabel(projectGrant.expires_at)}</span>` + "Revogar" calling `onRevoke(projectGrant.id)`.
  - `grant-list-text.ts`: replace `trustedTabsLabel` with `export const activeGrantsLabel = (n: number): string => (n === 1 ? '1 permissão ativa' : \`${n} permissões ativas\`);` and update its import in `ChatPanel`.
  - `ChatPanel.tsx`: `const [projectGrants, setProjectGrants] = useState<ChatProjectGrant[]>([])`, set from `api.chat()` (`project_grants ?? []`); events `project_grant` (replace by id and by `project_id`), `project_grant_revoked` (drop by id); after `decideChatAction`, `if (res.project_grant) setProjectGrants(...)`; `revoke` also drops from `projectGrants` (and on 409); `projectGrantByAction` memo like `grantByAction`; indicator count = active tab grants + active project grants, label `activeGrantsLabel(count)`; pass `projectGrant={projectGrantByAction.get(entry.action.id)}` to each card; reset clears both lists.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "Web chat: trust a project's board from a card"`

---

### Task 12: Web settings — "Permissões do chat" lists project grants

**Files:**
- Modify: `apps/web/src/lib/settings-sections.ts`, `apps/web/src/pages/SettingsPage.tsx`, `apps/web/src/components/ChatGrantsView.tsx`, `apps/web/src/components/chat/grant-list-text.ts`, `apps/web/src/lib/api.ts` (`listChatGrants` sends `kinds=all`), `apps/web/src/lib/types.ts` (`ChatGrantListItem.kind`, nullable tab fields)
- Test: `apps/web/src/components/ChatGrantsView.test.tsx`, the settings sections test

- [ ] **Step 1: Failing tests**

```tsx
it('asks for every kind and titles a project row', async () => {
  mockList({ active: [{ ...row, kind: 'project', tab_id: null, tab_name: null, tool: null, project_id: 'p1', project_name: 'App' }] });
  render(<ChatGrantsView />);
  expect(await screen.findByText('Quadro do projeto App')).toBeInTheDocument();
  expect(api.listChatGrants).toHaveBeenCalledWith({ state: 'active' }); // api adds kinds=all itself
});
it('a gone project reads "Projeto que não existe mais"', async () => { /* project_name: null */ });
it('revoking a project row that was already revoked (409) re-reads the list', async () => { /* revokeChatGrant rejects ApiError 409 → load() called again, no error shown */ });
it('the section is "Permissões do chat"', () => {
  expect(SETTINGS_SECTIONS.find((s) => s.key === 'chat-grants')?.label).toBe('Permissões do chat');
});
```

and in the `api.ts` test (or a new one): `listChatGrants({ state: 'ended', cursor: 'x' })` requests `/chat/grants?state=ended&cursor=x&kinds=all`.

- [ ] **Step 2: Run** — Expected: FAIL.

- [ ] **Step 3: Implement**
  - `grant-list-text.ts`:
    ```ts
    export const grantTitleLabel = (g: Pick<ChatGrantListItem, 'kind' | 'tab_name' | 'project_name'>): string =>
      g.kind === 'project' ? (g.project_name ? `Quadro do projeto ${g.project_name}` : 'Projeto que não existe mais') : grantTabLabel(g);
    ```
  - `ChatGrantsView.tsx`: `title(g)` uses `grantTitleLabel(g)` and appends ` · ${g.project_name}` only for `kind === 'tab'`; intro text "O que o chat pode fazer sem pedir confirmação. Cada permissão vale para uma conversa, por até 24 horas."; empty active: "Nenhuma permissão ativa agora."; doc comment renamed.
  - `settings-sections.ts` label "Permissões do chat"; `SettingsPage` `PageFrame title="Permissões do chat"`.
  - `api.ts` `listChatGrants` appends `kinds=all`.
- [ ] **Step 4: Run** — Expected: PASS; `npm run build -w @termhub/web` PASS.
- [ ] **Step 5: Commit** — `git commit -m "Web settings: list project grants in Permissões do chat"`

---

### Task 13: Mobile chat — button, PIN, granted card, indicator

**Files:**
- Modify: `apps/mobile/src/services/api/client.ts` (types flow from the contract), `apps/mobile/src/services/api/mock/handlers/chat.ts`
- Modify: `apps/mobile/src/features/chat/viewmodel/createChatStore.ts` (`ChatDecision`, `projectGrants` slot, reducer, decide, revoke, reset)
- Modify: `apps/mobile/src/features/chat/view/action-card.tsx`, `apps/mobile/src/features/chat/view/conversation-screen.tsx`
- Modify: `apps/mobile/src/features/session/view/pin-prompt-sheet.tsx` (title), `apps/mobile/src/features/chat-grants/model/labels.ts` (`activeGrantsLabel`)
- Test: `createChatStore.test.ts`, `action-card.test.tsx`, `conversation-screen.test.tsx`, `pin-prompt-sheet.test.tsx`, mock handler test

- [ ] **Step 1: Failing tests**

```ts
// createChatStore.test.ts
it("decide('approve_project') goes through the PIN with that word and re-reads", async () => {
  const { store, session, api } = setup({ actions: [pendingBoardCard] });
  await store.getState().decide('a1', 'approve_project');
  expect(session.requestPinProof).toHaveBeenCalledWith('a1', expect.any(Function), 'approve_project');
  expect(api.chat).toHaveBeenCalledTimes(2); // initial load + re-read
});
it('project_grant / project_grant_revoked update the slot', () => {
  const { store, emit } = setup();
  emit({ type: 'project_grant', user_id: 'u1', conversation_id: 'c1', grant: pg });
  expect(slot(store).projectGrants).toEqual([pg]);
  emit({ type: 'project_grant_revoked', user_id: 'u1', conversation_id: 'c1', grant_id: pg.id });
  expect(slot(store).projectGrants).toEqual([]);
});
it('revokeGrant drops a project grant too', async () => { /* seed projectGrants, revoke → removed, 409 also removes */ });
it('reset clears project grants', async () => { /* … */ });

// action-card.test.tsx
it('shows "Permitir sempre neste projeto" for a pending move_task and calls onDecide', () => { /* press → onDecide('a1', 'approve_project') */ });
it('labels a call under a project grant "quadro confiado"', () => { /* status executed + grant_id */ });

// conversation-screen.test.tsx
it('the indicator counts both kinds', () => { /* 1 tab + 1 project → "2 permissões ativas" */ });

// pin-prompt-sheet.test.tsx
it('titles an approve_project prompt', () => { /* decision approve_project → "Permitir sempre neste projeto" */ });
```

Mock handler test: `POST …/decision { decision: 'approve_project', … }` on a board card adds a project grant, emits `project_grant`; `GET …/chat` returns `project_grants`; `DELETE …/grants/:id` revokes a project grant.

- [ ] **Step 2: Run** `npm test -w @termhub/mobile -- chat` (through Docker). Expected: FAIL.

- [ ] **Step 3: Implement**
  - Store: `export type ChatDecision = 'approve' | 'deny' | 'approve_tab' | 'approve_project';` `ConversationSlot.projectGrants: TChatProjectGrant[]` (in `emptySlot`, `PersistedSlot`, persistence map, reread slice and its change check). In `decide`, `approve_project` follows the `approve_tab` path (always `withPin()`) and `if (decision === 'approve_tab' || decision === 'approve_project') void reread(key);`. Reducer: `project_grant` replaces by id and `project_id`; `project_grant_revoked` drops by id. `revokeGrant` drops the id from both `grants` and `projectGrants`. Reset clears `projectGrants`.
  - `action-card.tsx`: under the tab button, `{isBoardGrantable(action) ? <Button label="Permitir sempre neste projeto" variant="secondary" onPress={() => onDecide(action.id, 'approve_project')} disabled={busy} /> : null}`; the grant label becomes `isBoardGrantable(action) ? 'quadro confiado' : 'aba confiada'`; a card with an active project grant shows "Permitido neste projeto até HH:MM" + "Revogar" (prop `projectGrant`, passed by the conversation screen like `grant`).
  - `conversation-screen.tsx`: count active `grants` + active `projectGrants`, label `activeGrantsLabel(n)`.
  - `labels.ts`: replace `trustedTabsLabel` with `activeGrantsLabel` (same text as the web: "1 permissão ativa" / "N permissões ativas").
  - `pin-prompt-sheet.tsx`: `if (prompt?.decision === 'approve_project') return 'Permitir sempre neste projeto';`.
  - Mock `handlers/chat.ts`: a `projectGrants` array in the mock state; `approve_project` on a board card (resolve the project from the mock task/project fixtures; anything else → 400 `GRANT_NOT_ALLOWED`) grants for 24 h and emits `project_grant`; `GET /chat` → `project_grants`; `DELETE /grants/:id` looks in both lists.
- [ ] **Step 4: Run** — Expected: PASS; `npx tsc --noEmit -p apps/mobile` PASS.
- [ ] **Step 5: Commit** — `git commit -m "Mobile chat: trust a project's board with the PIN"`

---

### Task 14: Mobile "Permissões do chat" screen lists project grants

**Files:**
- Modify: `apps/mobile/src/services/api/client.ts` (`listGrants` sends `kinds=all`), mock `GET /chat/grants` (honours `kinds`)
- Modify: `apps/mobile/src/features/chat-grants/model/labels.ts` (`grantTitleLabel`), `view/chat-grants-screen.tsx` (title, intro, rows), `apps/mobile/src/features/settings/view/settings-screen.tsx` (row label)
- Test: `labels.test.ts`, `chat-grants-screen.test.tsx`, `createChatGrantsStore.test.ts`, mock handler test

- [ ] **Step 1: Failing tests**

```ts
// labels.test.ts
it('grantTitleLabel', () => {
  expect(grantTitleLabel({ kind: 'project', tab_name: null, project_name: 'App' })).toBe('Quadro do projeto App');
  expect(grantTitleLabel({ kind: 'project', tab_name: null, project_name: null })).toBe('Projeto que não existe mais');
  expect(grantTitleLabel({ kind: 'tab', tab_name: 'api', project_name: 'App' })).toBe('Aba api');
});
// chat-grants-screen.test.tsx
it('titles the screen "Permissões do chat" and renders a project row', async () => { /* store with one project row → "Quadro do projeto App", "Revogar" */ });
// client / mock
it('listGrants asks for kinds=all', async () => { /* fetch mock sees ?state=active&kinds=all */ });
it('mock GET /chat/grants without kinds hides project grants', async () => { /* … */ });
```

- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** — `grantTitleLabel` identical to the web's (Task 12); the screen uses it, title "Permissões do chat", intro "O que o chat pode fazer sem pedir confirmação. Cada permissão vale para uma conversa, por até 24 horas.", empty "Nenhuma permissão ativa agora."; Ajustes button label "Permissões do chat"; `listGrants` query adds `kinds: 'all'`; the mock filters project rows out unless `kinds=all`.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "Mobile: list project grants in Permissões do chat"`

---

### Task 15: Full verification

- [ ] **Step 1:** Server unit tests: `npm test -w @termhub/server` — PASS.
- [ ] **Step 2:** Server DB tests with `th-test-db` (Global Constraints) — `chat-project-grants.db.test.ts`, `chat-actions.db.test.ts`, the tasks cross-project tests — PASS; then `docker rm -f th-test-db`.
- [ ] **Step 3:** Migration compatibility check against the previous release: on `th-test-db` with the new migration applied, run the previous release's `chat-grants.db.test.ts` (checkout `origin/main`'s file into a scratch dir) — PASS, proving the old code is unaffected by the new table.
- [ ] **Step 4:** `npm test -w @termhub/mobile-api`, `npm test -w @termhub/web`, `npm test -w @termhub/mobile` — PASS.
- [ ] **Step 5:** CLAUDE.md gate: `npm run typecheck -w @termhub/server && npm run build -w @termhub/web && npm run build -w @termhub/landing` through Docker — PASS; `rm -rf .npm`.
- [ ] **Step 6:** Manual smoke on a local stack (not production): approve a `move_task` card with "Permitir sempre neste projeto", ask the concierge to move two more cards (no card appears, trail shows "quadro confiado"), ask it to delete one (card appears), revoke from "Permissões do chat", ask again (card appears).
