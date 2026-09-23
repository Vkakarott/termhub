# Project Chat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every project gets its own chat conversation, opened from a 💬 button in the sidebar into a right-hand drawer. Every conversation, the account-wide one included, gets a "Nova conversa" button that starts a clean CLI session.

**Architecture:** `chat_conversations` gains `project_id`, where null means the account-wide chat, and `archived_at`. There is one active row per (user, scope). `ChatService` is reused whole: it now runs "a conversation" instead of "the user's conversation". The host always comes from the account-wide row. Concierge tokens carry their conversation id, so the gate asks in the right chat and rotation never revokes a neighbour's token. Project runs add `--append-system-prompt`, which a new agent capability gates. On the web, `ChatPage`'s body becomes `ChatPanel`. `/chat` wraps it with the host picker, and a `ChatDrawer` mounted in `Layout` wraps it per project.

**Tech Stack:** Fastify + Prisma/Postgres + vitest (`apps/server`), React + react-router + Tailwind + vitest/testing-library (`apps/web`), zod protocol (`packages/agent-protocol`), `packages/claude-cli`, node agent (`apps/agent`).

**Spec:** `docs/superpowers/specs/2026-09-23-project-chat-design.md`

## Global Constraints

- Repo code, comments, docs and commit messages are in English. User-facing strings are pt-BR.
- Commit subjects follow the repo's style: `Server: …`, `Web: …`, `Agent: …`, `Docs: …`.
- Every commit ends with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- Throwaway containers are named `th-<something>`. Never touch `termhub-*`, `proxy-*` or `*-app-*` containers (CLAUDE.md).
- DB tests only run with `TERMHUB_DB_TESTS=1 DATABASE_URL=…`. Use a throwaway Postgres, set up once:
  ```bash
  docker run -d --name th-test-db -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=termhub -p 55432:5432 postgres:16-alpine
  export DATABASE_URL=postgresql://postgres:postgres@localhost:55432/termhub
  (cd apps/server && npx prisma migrate deploy)
  ```
- The unique index on active conversations is exactly `(user_id, COALESCE(project_id, '')) WHERE tab_id IS NULL AND archived_at IS NULL`.
- The chat's MCP token still has scopes `['read','tasks','terminals']` and is always `gated: true`.
- The account-wide chat's argv must stay byte-identical: `--append-system-prompt` only appears when set.
- New agent capability string: `claude.system_prompt`.
- Drawer width is 420px on desktop, full-screen on mobile, and it overlays the content (never resizes `main`).

---

### Task 1: Migration and `ChatRepository` scopes

**Files:**
- Create: `apps/server/prisma/migrations/20260923150000_project_chat/migration.sql`
- Modify: `apps/server/prisma/schema.prisma` (`ChatConversation`, `ApiToken`, `Project`)
- Modify: `apps/server/src/db/repositories/chat.ts`
- Modify: `apps/server/src/db/repositories/chat-actions.ts`
- Test: `apps/server/src/db/repositories/chat.db.test.ts`, `apps/server/src/db/repositories/chat-actions.db.test.ts`

**Interfaces:**
- Produces:
  - `ChatConversation.project_id: string | null` and `ChatConversation.archived_at: string | null`
  - `ChatRepository.getOrCreateForUser(userId)`, now narrowed to the active account-wide row
  - `ChatRepository.getOrCreateForProject(userId: string, projectId: string): Promise<ChatConversation>`
  - `ChatRepository.findByIdForUser(id: string, userId: string): Promise<ChatConversation | undefined>`
  - `ChatRepository.archive(id: string): Promise<void>`
  - `ChatRepository.clearProjectSessions(userId: string): Promise<void>`
  - `ChatRepository.listActiveProjectConversations(userId: string): Promise<{ id: string; project_id: string }[]>`
  - `ChatActionsRepository.expireOpenForConversation(conversationId: string): Promise<number>`
  - `ChatActionsRepository.countPendingByConversation(ids: string[]): Promise<Map<string, number>>`
  - Prisma: `ApiToken.chatConversationId String?`, which Task 2 uses

- [ ] **Step 1: Write the migration**

`apps/server/prisma/migrations/20260923150000_project_chat/migration.sql`:

```sql
-- A chat per project (spec 2026-09-23-project-chat-design.md §3).
ALTER TABLE "chat_conversations" ADD COLUMN "project_id" TEXT;
ALTER TABLE "chat_conversations" ADD COLUMN "archived_at" TIMESTAMP(3);
ALTER TABLE "chat_conversations"
  ADD CONSTRAINT "chat_conversations_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "chat_conversations_project_id_idx" ON "chat_conversations"("project_id");

-- One active conversation per user per scope (account-wide = project_id NULL), any number archived.
DROP INDEX IF EXISTS "chat_conversations_one_per_user";
CREATE UNIQUE INDEX "chat_conversations_one_active"
  ON "chat_conversations" ("user_id", COALESCE("project_id", ''))
  WHERE "tab_id" IS NULL AND "archived_at" IS NULL;

-- A concierge token names the conversation it runs for (spec §4.2), so the gate asks in that chat.
ALTER TABLE "api_tokens" ADD COLUMN "chat_conversation_id" TEXT;
ALTER TABLE "api_tokens"
  ADD CONSTRAINT "api_tokens_chat_conversation_id_fkey"
  FOREIGN KEY ("chat_conversation_id") REFERENCES "chat_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "api_tokens_chat_conversation_id_idx" ON "api_tokens"("chat_conversation_id");
```

Before writing it, check that the `projects` table is really named `"projects"`: `grep -n '@@map("projects")' apps/server/prisma/schema.prisma`.

- [ ] **Step 2: Update `schema.prisma`**

In `model ChatConversation`, add these after `aiAccount`:

```prisma
  /// The project this conversation is about. Null = the account-wide chat (spec 2026-09-23 §3).
  projectId     String?       @map("project_id")
  project       Project?      @relation(fields: [projectId], references: [id], onDelete: Cascade)
  /// Set by "Nova conversa": the row is kept, but it is no longer the scope's active conversation.
  archivedAt    DateTime?     @map("archived_at")
  apiTokens     ApiToken[]
```

Also add `@@index([projectId])`. Replace the doc comment's index paragraph with the new index text: `chat_conversations_one_active (user_id, COALESCE(project_id, '')) WHERE tab_id IS NULL AND archived_at IS NULL`. Keep the note that Prisma cannot express it.

In `model ApiToken`, add:

```prisma
  /// The chat conversation a concierge token runs for. Null on a person's own tokens.
  chatConversationId String?           @map("chat_conversation_id")
  chatConversation   ChatConversation? @relation(fields: [chatConversationId], references: [id], onDelete: Cascade)
```

Also add `@@index([chatConversationId])`.

In `model Project`, add the back-relation `chatConversations ChatConversation[]`.

Run: `cd apps/server && npx prisma generate && npx prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --shadow-database-url "$DATABASE_URL" --script`

Expected: an empty diff. The partial index is invisible to the diff, as documented in the model comment.

- [ ] **Step 3: Write the failing repository tests**

Append to `chat.db.test.ts`, inside the existing `describe`. It already creates `userId`. Add a project fixture in `beforeAll` (look at `projects.db.test.ts` for the required `project.create` fields, at least `id`, `key`, `name`, `ownerId`):

```ts
  it('keeps one active conversation per project, separate from the account-wide one', async () => {
    const wide = await repo.getOrCreateForUser(userId);
    const [a, b] = await Promise.all([repo.getOrCreateForProject(userId, projectId), repo.getOrCreateForProject(userId, projectId)]);
    expect(a.id).toBe(b.id);
    expect(a.id).not.toBe(wide.id);
    expect(a.project_id).toBe(projectId);
    expect(wide.project_id).toBeNull();
  });

  it('archive frees the scope: the next lookup creates a fresh row with no session', async () => {
    const before = await repo.getOrCreateForProject(userId, projectId);
    await repo.setCliSession(before.id, '3f1e9b1e-0000-4000-8000-0000000000aa');
    await repo.archive(before.id);
    const after = await repo.getOrCreateForProject(userId, projectId);
    expect(after.id).not.toBe(before.id);
    expect(after.cli_session_id).toBeNull();
    expect((await repo.findByIdForUser(before.id, userId))?.archived_at).not.toBeNull();
  });

  it('findByIdForUser never answers for another user', async () => {
    const c = await repo.getOrCreateForProject(userId, projectId);
    expect(await repo.findByIdForUser(c.id, 'someone-else')).toBeUndefined();
  });

  it('clearProjectSessions drops the session of every active project conversation and only those', async () => {
    const wide = await repo.getOrCreateForUser(userId);
    const p = await repo.getOrCreateForProject(userId, projectId);
    await repo.setCliSession(wide.id, '3f1e9b1e-0000-4000-8000-0000000000b1');
    await repo.setCliSession(p.id, '3f1e9b1e-0000-4000-8000-0000000000b2');
    await repo.clearProjectSessions(userId);
    expect((await repo.findByIdForUser(wide.id, userId))?.cli_session_id).toBe('3f1e9b1e-0000-4000-8000-0000000000b1');
    expect((await repo.findByIdForUser(p.id, userId))?.cli_session_id).toBeNull();
  });

  it('lists active project conversations only', async () => {
    const p = await repo.getOrCreateForProject(userId, projectId);
    expect(await repo.listActiveProjectConversations(userId)).toEqual([{ id: p.id, project_id: projectId }]);
  });

  it('deleting the project deletes its conversations', async () => {
    const otherProject = newId();
    await db.project.create({ data: { id: otherProject, key: `K${otherProject.slice(-5).toUpperCase()}`, name: 'tmp', ownerId: userId } });
    const c = await repo.getOrCreateForProject(userId, otherProject);
    await db.project.delete({ where: { id: otherProject } });
    expect(await repo.findByIdForUser(c.id, userId)).toBeUndefined();
  });
```

Append to `chat-actions.db.test.ts`, using its existing fixtures to create a conversation with one `pending`, one `approved` and one `denied` row:

```ts
  it('expireOpenForConversation expires pending and approved rows of that conversation only', async () => {
    // pending + approved in `conversationId`, a pending row in another conversation of the same user
    const n = await repo.expireOpenForConversation(conversationId);
    expect(n).toBe(2);
    const rows = await repo.listByConversation(conversationId);
    expect(rows.filter((r) => r.status === 'pending' || r.status === 'approved')).toEqual([]);
    expect((await repo.listByConversation(otherConversationId)).some((r) => r.status === 'pending')).toBe(true);
  });

  it('countPendingByConversation counts only pending rows, per conversation', async () => {
    const counts = await repo.countPendingByConversation([conversationId, otherConversationId]);
    expect(counts.get(otherConversationId)).toBe(1);
    expect(counts.get(conversationId) ?? 0).toBe(0);
  });
```

Build the fixture rows with `repo.insertPending` and `repo.decide`, as the existing tests in that file do.

- [ ] **Step 4: Run to verify they fail**

Run: `TERMHUB_DB_TESTS=1 npm test -w @termhub/server -- src/db/repositories/chat.db.test.ts src/db/repositories/chat-actions.db.test.ts`

Expected: FAIL with `repo.getOrCreateForProject is not a function`, and similar errors for the other new methods.

- [ ] **Step 5: Implement the repository methods**

In `chat.ts`:
- Add `project_id: string | null; archived_at: string | null;` to `ChatConversation`, and map them in `mapConversation` (`c.projectId`, `c.archivedAt?.toISOString() ?? null`).
- Replace `getOrCreateForUser` with a shared private helper:

```ts
  /** The active conversation of one scope — the account-wide chat (`projectId === null`) or one
   * project's — created on first use. The partial unique index `chat_conversations_one_active` makes
   * two concurrent first loads converge on one row: the loser's insert is refused (P2002) and it
   * re-reads the winner. */
  private async getOrCreateActive(userId: string, projectId: string | null): Promise<ChatConversation> {
    const where = { userId, projectId, tabId: null, archivedAt: null };
    const existing = await this.db.chatConversation.findFirst({ where, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    if (existing) return mapConversation(existing);
    try {
      return mapConversation(await this.db.chatConversation.create({ data: { id: newId(), userId, projectId } }));
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const winner = await this.db.chatConversation.findFirst({ where, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
        if (winner) return mapConversation(winner);
      }
      throw err;
    }
  }

  /** The account-wide conversation: the one `/chat` shows and the one that holds the host (spec §3). */
  getOrCreateForUser(userId: string): Promise<ChatConversation> {
    return this.getOrCreateActive(userId, null);
  }

  /** A project's active conversation. Ownership of the project is the caller's check. */
  getOrCreateForProject(userId: string, projectId: string): Promise<ChatConversation> {
    return this.getOrCreateActive(userId, projectId);
  }

  async findByIdForUser(id: string, userId: string): Promise<ChatConversation | undefined> {
    const row = await this.db.chatConversation.findFirst({ where: { id, userId } });
    return row ? mapConversation(row) : undefined;
  }

  /** "Nova conversa": the row and its transcript stay, but it stops being the scope's active one. */
  async archive(id: string): Promise<void> {
    await this.db.chatConversation.updateMany({ where: { id, archivedAt: null }, data: { archivedAt: new Date() } });
  }

  /** A host change moves every project conversation too: their CLI sessions live in the old host's
   * config dir and cannot be resumed anywhere else (user-hosted spec §3). */
  async clearProjectSessions(userId: string): Promise<void> {
    await this.db.chatConversation.updateMany({ where: { userId, projectId: { not: null }, archivedAt: null }, data: { cliSessionId: null } });
  }

  async listActiveProjectConversations(userId: string): Promise<{ id: string; project_id: string }[]> {
    const rows = await this.db.chatConversation.findMany({ where: { userId, projectId: { not: null }, tabId: null, archivedAt: null }, select: { id: true, projectId: true }, orderBy: { createdAt: 'asc' } });
    return rows.map((r) => ({ id: r.id, project_id: r.projectId! }));
  }
```

Update the doc comment above `getOrCreateForUser` so it no longer says "v1 keeps one conversation per user".

In `chat-actions.ts`:

```ts
  /** Reset closes every open question of the conversation it archives: nobody reads that session any
   * more, so a pending card or an unconsumed approval must not be injected into it later. */
  async expireOpenForConversation(conversationId: string): Promise<number> {
    const { count } = await this.db.chatAction.updateMany({
      where: { conversationId, status: { in: ['pending', 'approved'] satisfies ChatActionStatus[] } },
      data: { status: 'expired' satisfies ChatActionStatus },
    });
    return count;
  }

  async countPendingByConversation(ids: string[]): Promise<Map<string, number>> {
    if (ids.length === 0) return new Map();
    const rows = await this.db.chatAction.groupBy({ by: ['conversationId'], where: { conversationId: { in: ids }, status: 'pending' satisfies ChatActionStatus }, _count: { _all: true } });
    return new Map(rows.map((r) => [r.conversationId, r._count._all]));
  }
```

- [ ] **Step 6: Run the tests**

Run: `TERMHUB_DB_TESTS=1 npm test -w @termhub/server -- src/db/repositories/chat.db.test.ts src/db/repositories/chat-actions.db.test.ts`

Expected: PASS, including the old tests. `getOrCreateForUser` still returns one row per user.

Then run `npm run typecheck -w @termhub/server`. Expected: PASS. The new fields are additive, so test fixtures that build `ChatConversation` literals may need `project_id: null, archived_at: null` only where they are typed as `ChatConversation`. Fix any such fixture.

- [ ] **Step 7: Commit**

```bash
git add apps/server/prisma apps/server/src/db/repositories/chat.ts apps/server/src/db/repositories/chat-actions.ts apps/server/src/db/repositories/*.db.test.ts
git commit -m "Server: chat conversations scoped per project, archivable

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Concierge tokens carry their conversation, and the gate reads it

**Files:**
- Modify: `apps/server/src/db/repositories/api-tokens.ts`
- Modify: `apps/server/src/chat/token.ts`
- Modify: `apps/server/src/chat/gate-runtime.ts:20-28, 278-303`
- Modify: `apps/server/src/chat/service.ts` (the one `mintConciergeToken` call; the full rework is Task 4)
- Test: `apps/server/src/chat/token.test.ts`, `apps/server/src/mcp/gate.e2e.test.ts`, `apps/server/src/db/repositories/api-tokens.db.test.ts`

**Interfaces:**
- Consumes: the `ApiToken.chatConversationId` Prisma column (Task 1).
- Produces:
  - `ApiToken.chat_conversation_id: string | null`
  - `ApiTokensRepository.create(userId, { …, chatConversationId?: string | null }, hash)`
  - `ApiTokensRepository.revokeForConversation(conversationId: string): Promise<number>`
  - `countActive` ignores gated tokens
  - `mintConciergeToken(repos, userId: string, conversationId: string, scopes: ApiTokenScope[]): Promise<string>`
  - `GatedCall.token: { gated: boolean; chat_conversation_id?: string | null }`

- [ ] **Step 1: Write the failing tests**

Replace `token.test.ts`'s revoke test and add a new one. The fake `listByUser` rows gain `chat_conversation_id`:

```ts
it('revokes only the previous token of the same conversation', async () => {
  const r = repos([
    { id: 'tok_old', name: CONCIERGE_TOKEN_NAME, revoked_at: null, chat_conversation_id: 'c1' },
    { id: 'tok_other_chat', name: CONCIERGE_TOKEN_NAME, revoked_at: null, chat_conversation_id: 'c2' },
    { id: 'tok_mine', name: 'meu notebook', revoked_at: null, chat_conversation_id: null },
    { id: 'tok_dead', name: CONCIERGE_TOKEN_NAME, revoked_at: '2026-09-01T00:00:00.000Z', chat_conversation_id: 'c1' },
  ]);
  await mintConciergeToken(r, 'u1', 'c1', ['read']);
  expect(r.apiTokens.revoke.mock.calls).toEqual([['tok_old', 'u1']]);
});

it('revokes a pre-migration concierge token (no conversation) only from the account-wide chat', async () => {
  const r = repos([{ id: 'tok_legacy', name: CONCIERGE_TOKEN_NAME, revoked_at: null, chat_conversation_id: null }]);
  await mintConciergeToken(r, 'u1', 'c_project', ['read'], { accountWide: false });
  expect(r.apiTokens.revoke).not.toHaveBeenCalled();
  await mintConciergeToken(r, 'u1', 'c_wide', ['read'], { accountWide: true });
  expect(r.apiTokens.revoke.mock.calls).toEqual([['tok_legacy', 'u1']]);
});

it('stores the conversation on the token', async () => {
  const r = repos();
  await mintConciergeToken(r, 'u1', 'c1', ['read']);
  const [, input] = r.apiTokens.create.mock.calls[0];
  expect(input).toMatchObject({ gated: true, chatConversationId: 'c1' });
});
```

Update the other existing calls in that file to `mintConciergeToken(r, 'u1', 'c1', [...])`.

Add a case to `gate.e2e.test.ts`. The fake token in `build` (line ~161) gains `chat_conversation_id: opts.conversationId ?? null`, and `build` takes `conversationId?: string`:

```ts
it('asks in the conversation named by the token, not the account-wide one', async () => {
  const { app, actions } = build({ gated: true, conversationId: 'c_project' });
  // same send_input call as the existing "a gated write becomes a pending question" case
  // …
  expect(actions.insertPending).toHaveBeenCalledWith(expect.objectContaining({ conversation_id: 'c_project' }));
});
```

Copy the request body and helpers from the neighbouring gated-write case in that file, so the call is identical apart from the token.

Add to `api-tokens.db.test.ts`:

```ts
  it('countActive ignores gated (concierge) tokens', async () => {
    const before = await repo.countActive(userId);
    await repo.create(userId, { name: 'concierge (automático)', scopes: ['read'], expiresAt: null, gated: true }, `h_${newId()}`);
    expect(await repo.countActive(userId)).toBe(before);
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -w @termhub/server -- src/chat/token.test.ts src/mcp/gate.e2e.test.ts`

Expected: FAIL. The revoke list includes `tok_other_chat`, and `insertPending` receives `CONVERSATION`.

- [ ] **Step 3: Implement**

`api-tokens.ts`:
- Add `chat_conversation_id: string | null` to `ApiToken` and map it from `t.chatConversationId`.
- `create` takes `chatConversationId?: string | null` and writes `chatConversationId: input.chatConversationId ?? null`.
- `countActive` uses `where: { userId, gated: false, ...activeWhere(now) }`. Add a comment: the concierge mints its own tokens per conversation, and they must never use up the person's own cap.
- Add:

```ts
  /** Revokes every live concierge token of a conversation — used when "Nova conversa" archives it. */
  async revokeForConversation(conversationId: string): Promise<number> {
    const { count } = await this.db.apiToken.updateMany({ where: { chatConversationId: conversationId, revokedAt: null }, data: { revokedAt: new Date() } });
    return count;
  }
```

`token.ts`:

```ts
/** Mints a fresh token for one conversation's run and revokes that conversation's previous one —
 * never another conversation's: a project chat and the account-wide chat run at the same time, and
 * revoking across them would cut the other run's MCP calls mid-answer. A token minted before tokens
 * named their conversation (null) belongs to the account-wide chat, the only one that existed. */
export async function mintConciergeToken(
  repos: Repositories,
  userId: string,
  conversationId: string,
  scopes: ApiTokenScope[],
  opts: { accountWide?: boolean } = {},
): Promise<string> {
  const previous = (await repos.apiTokens.listByUser(userId)).filter(
    (t) => t.name === CONCIERGE_TOKEN_NAME && t.revoked_at === null && (t.chat_conversation_id === conversationId || (opts.accountWide === true && t.chat_conversation_id === null)),
  );
  for (const t of previous) await repos.apiTokens.revoke(t.id, userId);

  const { token, hash } = newApiToken();
  await repos.apiTokens.create(userId, { name: CONCIERGE_TOKEN_NAME, scopes, expiresAt: new Date(Date.now() + TTL_MS), gated: true, chatConversationId: conversationId }, hash);
  return token;
}
```

Keep the existing `gated: true` comment.

`gate-runtime.ts`:
- Change `GatedCall.token` to `{ gated: boolean; chat_conversation_id?: string | null }`.
- In `applyGate`, replace the v1 comment and the lookup with:

```ts
  // The token names the conversation it was minted for (spec 2026-09-23 §4.2): that is the chat the
  // question belongs in. A gated token with none predates per-conversation tokens (24 h at most) and
  // can only have come from the account-wide chat.
  const conversationId = call.token.chat_conversation_id ?? (await ctx.repos.chat.getOrCreateForUser(ctx.scope.user.id)).id;
```

- Replace `conversation.id` with `conversationId` in the rest of `applyGate`.

`service.ts`, a temporary one-line bridge until Task 4:

```ts
token = await mintConciergeToken(this.deps.repos, user.id, conversation.id, ['read', 'tasks', 'terminals'], { accountWide: conversation.project_id === null });
```

- [ ] **Step 4: Run the tests**

Run: `npm test -w @termhub/server -- src/chat src/mcp && TERMHUB_DB_TESTS=1 npm test -w @termhub/server -- src/db/repositories/api-tokens.db.test.ts && npm run typecheck -w @termhub/server`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src
git commit -m "Server: concierge tokens name their conversation; the gate asks there

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `--append-system-prompt` through the CLI package, the protocol and the agent

**Files:**
- Modify: `packages/claude-cli/src/index.ts:11-45`
- Modify: `packages/agent-protocol/src/messages.ts:30-38, 74-88`
- Modify: `apps/agent/src/run.ts:31`
- Modify: `apps/agent/src/claude/run.ts:114-119`
- Modify: `apps/server/src/chat/agent-runner.ts:137-148`
- Modify: `apps/server/src/chat/service.ts` (`RunnerInput` only)
- Test: `packages/claude-cli/src/argv.test.ts`, `packages/agent-protocol/src/messages.test.ts`, `apps/agent/src/claude/run.test.ts`, `apps/server/src/chat/agent-runner.test.ts`

**Interfaces:**
- Produces:
  - `ClaudeRunSpec.append_system_prompt?: string | null`
  - `CAPABILITY_CLAUDE_SYSTEM_PROMPT = 'claude.system_prompt'`, exported from `@termhub/agent-protocol`
  - `ClaudeOpenParams.append_system_prompt?: string | null`, capped at 4000 chars
  - `RunnerInput.append_system_prompt?: string | null`

- [ ] **Step 1: Write the failing tests**

`argv.test.ts`:

```ts
  it('appends the system prompt as the last flag pair, only when set', () => {
    expect(buildClaudeArgs({ ...spec, append_system_prompt: 'Você é o chat do projeto X.' }).slice(-2)).toEqual(['--append-system-prompt', 'Você é o chat do projeto X.']);
    expect(buildClaudeArgs({ ...spec, append_system_prompt: null })).not.toContain('--append-system-prompt');
    expect(buildClaudeArgs({ ...spec, append_system_prompt: '' })).not.toContain('--append-system-prompt');
  });
```

`messages.test.ts`:

```ts
  it('accepts a claude open with a system prompt, and one without (older servers)', () => {
    const base = { type: 'open', ch: 1, kind: 'claude', params: { session_id: 's', resume: false, config_dir: null, mcp_url: 'https://x/mcp', token: 't' } };
    expect(serverMessage.safeParse(base).success).toBe(true);
    expect(serverMessage.safeParse({ ...base, params: { ...base.params, append_system_prompt: 'foco no projeto' } }).success).toBe(true);
    expect(serverMessage.safeParse({ ...base, params: { ...base.params, append_system_prompt: 'x'.repeat(4001) } }).success).toBe(false);
  });
```

Match `ch` to whatever the existing tests in that file use for a channel id.

`apps/agent/src/claude/run.test.ts`: find the existing test that asserts the spawned argv, typically through a fake spawn capturing `args`. Add a case that sends `append_system_prompt: 'foco'` in the open params and expects `args` to end with `['--append-system-prompt', 'foco']`. Also add a case asserting `CAPABILITIES` from `../run.js` contains `CAPABILITY_CLAUDE_SYSTEM_PROMPT`.

`agent-runner.test.ts`: find the test asserting the open params sent to the agent. Add `append_system_prompt: 'foco'` to the `RunnerInput` and expect it in `params`. When the input omits it, expect `append_system_prompt: null`.

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -w @termhub/claude-cli && npm test -w @termhub/agent-protocol && npm test -w @termhub/agent -- src/claude/run.test.ts && npm test -w @termhub/server -- src/chat/agent-runner.test.ts`

Expected: FAIL. The flag is absent and the zod schema strips or rejects the field.

- [ ] **Step 3: Implement**

`claude-cli/src/index.ts`: add `append_system_prompt?: string | null;` to `ClaudeRunSpec`, and as the last element of `buildClaudeArgs`:

```ts
    // Last, and only when set: the account-wide chat's argv stays exactly what it was. It is our own
    // server-composed text (a project's name, key and paths), never the user's prompt, which still
    // travels on stdin only.
    ...(spec.append_system_prompt ? ['--append-system-prompt', spec.append_system_prompt] : []),
```

`agent-protocol/src/messages.ts`: next to `CAPABILITY_CLAUDE`:

```ts
/** The agent forwards `append_system_prompt` from a `claude` open into the CLI's argv. An agent without
 * it would silently drop the field, so the server requires it before running a project chat. */
export const CAPABILITY_CLAUDE_SYSTEM_PROMPT = 'claude.system_prompt';
```

In `claudeOpenParams`, add `append_system_prompt: z.string().max(4000).nullable().optional(),`.

`apps/agent/src/run.ts`: `export const CAPABILITIES = [CAPABILITY_CLAUDE, CAPABILITY_CLAUDE_SYSTEM_PROMPT];` and update the import.

`apps/agent/src/claude/run.ts`: add `append_system_prompt: params.append_system_prompt ?? null,` to the `buildClaudeArgs({...})` call.

`service.ts` `RunnerInput`: add

```ts
  /** Project chats only: the server-composed focus text (spec §4.3). Absent for the account-wide chat. */
  append_system_prompt?: string | null;
```

`agent-runner.ts` params: add `append_system_prompt: input.append_system_prompt ?? null,`.

- [ ] **Step 4: Run the tests**

Run the Step 2 command, then `npm run build:packages && npm run typecheck -w @termhub/server && npm run typecheck -w @termhub/agent`.

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/claude-cli packages/agent-protocol apps/agent apps/server/src/chat/agent-runner.ts apps/server/src/chat/agent-runner.test.ts apps/server/src/chat/service.ts
git commit -m "Agent: forward an appended system prompt to the chat's CLI

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: `ChatService` runs a conversation: project scope, host from the account-wide row, prompt, reset, statuses, bus `conversation_id`

**Files:**
- Create: `apps/server/src/chat/project-prompt.ts`
- Test: `apps/server/src/chat/project-prompt.test.ts`
- Modify: `apps/server/src/chat/bus.ts`
- Modify: `apps/server/src/chat/host.ts:83-115`
- Modify: `apps/server/src/chat/service.ts`
- Modify: `apps/server/src/chat/gate-runtime.ts:262` (the `confirmation` publish)
- Test: `apps/server/src/chat/service.test.ts`, `apps/server/src/chat/host.test.ts`, `apps/server/src/chat/bus.test.ts`

**Interfaces:**
- Consumes:
  - Task 1 repository methods
  - `mintConciergeToken(repos, userId, conversationId, scopes, { accountWide })` from Task 2
  - `RunnerInput.append_system_prompt` and `CAPABILITY_CLAUDE_SYSTEM_PROMPT` from Task 3
- Produces:
  - `projectSystemPrompt(project: { name: string; key: string }, links: { machine: string; cwd: string }[]): string`
  - `ChatEvent`: every member gains `conversation_id: string`
  - `resolveHost(ctx, user, opts?: { requires?: string })`
  - `ChatService.conversationFor(user: User, projectId?: string | null): Promise<ChatConversation>`. It throws 404 `PROJECT_NOT_FOUND` for a project the user does not own.
  - `ChatService.hostFor(user: User, projectId?: string | null): Promise<HostChoice>`
  - `ChatService.send(user: User, text: string, opts?: { projectId?: string | null }): Promise<ChatMessage>`
  - `ChatService.resumeAfterDecision(user: User, action: ChatAction): Promise<ChatMessage>`, which now runs in `action.conversation_id`
  - `ChatService.reset(user: User, projectId: string | null): Promise<ChatConversation>`. It throws 409 `CHAT_BUSY`.
  - `ChatService.projectStatuses(user: User): Promise<{ project_id: string; busy: boolean; pending_confirmations: number }[]>`

- [ ] **Step 1: The prompt builder, with its test first**

`project-prompt.test.ts`:

```ts
import { expect, it } from 'vitest';
import { projectSystemPrompt } from './project-prompt.js';

it('names the project, its machines and paths, and asks for focus and brevity', () => {
  const text = projectSystemPrompt({ name: 'Popingo monorepo', key: 'POP' }, [
    { machine: 'jarvis', cwd: '/home/p/popingo' },
    { machine: 'mac', cwd: '/Users/p/popingo' },
  ]);
  expect(text).toContain('"Popingo monorepo" (key POP)');
  expect(text).toContain('jarvis → /home/p/popingo; mac → /Users/p/popingo');
  expect(text).toMatch(/Do not report on other projects unless the person asks about them by name/);
  expect(text).toMatch(/Keep answers short/);
});

it('says so when the project has no machine yet', () => {
  expect(projectSystemPrompt({ name: 'X', key: 'X' }, [])).toContain('no machine linked yet');
});

it('stays under the protocol cap even with many long paths', () => {
  const links = Array.from({ length: 200 }, (_, i) => ({ machine: `m${i}`, cwd: `/very/long/path/${'d'.repeat(40)}/${i}` }));
  expect(projectSystemPrompt({ name: 'X', key: 'X' }, links).length).toBeLessThanOrEqual(4000);
});
```

`project-prompt.ts`:

```ts
/** The protocol's cap on `append_system_prompt` (packages/agent-protocol, claudeOpenParams). */
const MAX = 4000;

/**
 * What a project chat is told about itself (spec 2026-09-23 §4.3): the project's name and key, and
 * where it lives. Names and paths only — tasks, screens and output are the MCP tools' business, read
 * when needed, never pasted in here. Built per run so a rename or a new machine link shows up at once.
 */
export function projectSystemPrompt(project: { name: string; key: string }, links: { machine: string; cwd: string }[]): string {
  const where = links.length ? links.map((l) => `${l.machine} → ${l.cwd}`).join('; ') : 'no machine linked yet';
  const head = `You are the termhub chat for the project "${project.name}" (key ${project.key}).\n`;
  const tail =
    '\nAnswer about this project. Do not report on other projects unless the person asks about them by name.\n' +
    'Keep answers short unless asked for detail.';
  const room = MAX - head.length - tail.length - 'Its machines and directories: '.length;
  const list = where.length > room ? `${where.slice(0, room - 1)}…` : where;
  return `${head}Its machines and directories: ${list}${tail}`;
}
```

Run: `npm test -w @termhub/server -- src/chat/project-prompt.test.ts`. Expected: PASS.

- [ ] **Step 2: Write the failing service and host tests**

In `service.test.ts`, extend `build`:
- `chat` gains `getOrCreateForProject`, which returns a second in-memory `projectConversation = { ...conversation, id: 'c_p1', project_id: 'p1', machine_id: null, cli_session_id: null }`. It also gains `findByIdForUser` (looks up `c1` or `c_p1`), `archive`, `clearProjectSessions`, `listActiveProjectConversations` (→ `[{ id: 'c_p1', project_id: 'p1' }]`) and `setCliSession`, which writes to whichever conversation has that id.
- Add `projectMachines: { listByProject: vi.fn(async () => [{ machine_id: 'm1', cwd: '/srv/app' }]) }`.
- `chatActions` gains `expireOpenForConversation: vi.fn(async () => 0)` and `countPendingByConversation: vi.fn(async () => new Map([['c_p1', 2]]))`.
- `apiTokens` gains `revokeForConversation: vi.fn(async () => 0)`.
- The capabilities default becomes `['claude', 'claude.system_prompt']`.
- Keep the runner fake recording its `RunnerInput`s. Check how the existing tests read `input.resume`: they spy on `runnerFor`/`run`.

New cases:

```ts
describe('project conversations', () => {
  it('runs in the project conversation, on the account-wide host, with the project prompt', async () => {
    const { service, inputs, repos } = build(['{"type":"done","session_id":"s-p"}']);
    await service.send(user, 'como está o build?', { projectId: 'p1' });
    expect(inputs[0].append_system_prompt).toContain('"app" (key');
    expect(repos.chat.addMessage).toHaveBeenCalledWith(expect.objectContaining({ conversation_id: 'c_p1' }));
    expect(repos.apiTokens.create).toHaveBeenCalledWith('u1', expect.objectContaining({ chatConversationId: 'c_p1' }), expect.any(String));
  });

  it('never passes a system prompt for the account-wide chat', async () => {
    const { service, inputs } = build(['{"type":"done","session_id":"s"}']);
    await service.send(user, 'oi');
    expect(inputs[0].append_system_prompt ?? null).toBeNull();
  });

  it('runs a project chat and the account-wide chat at the same time', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { service } = build(async function* () {
      await gate;
      yield '{"type":"done","session_id":"s"}';
    });
    const a = service.send(user, 'um', { projectId: 'p1' });
    const b = service.send(user, 'dois');
    release();
    await expect(Promise.all([a, b])).resolves.toHaveLength(2);
  });

  it('refuses a project the user does not own', async () => {
    const { service } = build([]);
    await expect(service.send(user, 'oi', { projectId: 'not-mine' })).rejects.toMatchObject({ statusCode: 404, code: 'PROJECT_NOT_FOUND' });
  });

  it('reports agent_too_old for a project chat on an agent without claude.system_prompt, while the account-wide chat is ready', async () => {
    const { service } = build([], { host: { capabilities: ['claude'] } });
    expect((await service.hostFor(user, 'p1')).kind).toBe('agent_too_old');
    expect((await service.hostFor(user)).kind).toBe('ready');
  });

  it('bus events carry the conversation id', async () => {
    const seen: ChatEvent[] = [];
    const off = chatBus.subscribe((e) => seen.push(e));
    const { service } = build(['{"type":"text","delta":"ok"}', '{"type":"done","session_id":"s"}']);
    await service.send(user, 'oi', { projectId: 'p1' });
    off();
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((e) => e.conversation_id === 'c_p1')).toBe(true);
  });
});

describe('reset', () => {
  it('archives, expires open actions, revokes the tokens and returns the fresh conversation', async () => {
    const { service, repos } = build([]);
    const fresh = await service.reset(user, 'p1');
    expect(repos.chat.archive).toHaveBeenCalledWith('c_p1');
    expect(repos.chatActions.expireOpenForConversation).toHaveBeenCalledWith('c_p1');
    expect(repos.apiTokens.revokeForConversation).toHaveBeenCalledWith('c_p1');
    expect(fresh).toBeDefined();
  });

  it('is refused while that conversation is answering', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { service } = build(async function* () {
      await gate;
      yield '{"type":"done","session_id":"s"}';
    });
    const running = service.send(user, 'um', { projectId: 'p1' });
    await new Promise((r) => setTimeout(r, 0));
    await expect(service.reset(user, 'p1')).rejects.toMatchObject({ code: 'CHAT_BUSY' });
    release();
    await running;
  });
});

it('projectStatuses reports busy and pending confirmations per project', async () => {
  const { service } = build([]);
  expect(await service.projectStatuses(user)).toEqual([{ project_id: 'p1', busy: false, pending_confirmations: 2 }]);
});
```

Adapt the helper names `inputs`, `repos` and `service` to what `build` actually returns. Extend its return value if it does not expose them. The `projects.findByIdsForOwner` fake is already `ownedBy(project)`: `'p1'` resolves and `'not-mine'` does not.

In `host.test.ts`:

```ts
it('requires the extra capability when asked to', async () => {
  // same fixture as the existing "ready" case, agent capabilities ['claude']
  expect((await resolveHost(ctx, user, { requires: 'claude.system_prompt' })).kind).toBe('agent_too_old');
  expect((await resolveHost(ctx, user)).kind).toBe('ready');
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `npm test -w @termhub/server -- src/chat/service.test.ts src/chat/host.test.ts`

Expected: the new cases FAIL (`send` ignores `projectId`, there is no `reset`, events lack `conversation_id`). The old cases still pass.

- [ ] **Step 4: Implement `bus.ts` and the gate publish**

Add `conversation_id: string;` right after `user_id: string;` in every member of the `ChatEvent` union. In `gate-runtime.ts`, the `confirmation` publish gets `conversation_id: conversationId`: pass it into `ask`, which already receives it.

- [ ] **Step 5: Implement `host.ts`**

Give `resolveHost` a third parameter, `opts: { requires?: string } = {}`. After the existing `CAPABILITY_CLAUDE` check:

```ts
  // A project chat needs more of the agent than the account-wide chat does (spec §4.3): an agent that
  // does not forward the project's prompt would run the chat unfocused without saying so.
  if (opts.requires && !capabilities.includes(opts.requires)) {
    return { kind: 'agent_too_old', machine, version: ctx.agents.info(machine.id)?.agent_version ?? machine.agent_version ?? '' };
  }
```

Widen `HostContext.repos` to `Pick<Repositories, 'chat' | 'machines' | 'aiAccounts'>`, which is unchanged. It still reads `getOrCreateForUser`, now the account-wide row, and that is exactly the host's owner.

- [ ] **Step 6: Implement `service.ts`**

Changes, in order:

1. Imports: `CAPABILITY_CLAUDE_SYSTEM_PROMPT` from `@termhub/agent-protocol`, `projectSystemPrompt` from `./project-prompt.js`, and `notFound` from `../lib/errors.js`.

2. Replace `conversationFor` and `hostFor`:

```ts
  /** The active conversation of a scope: the account-wide chat, or one of the user's own projects. A
   * project id that is not this user's is a 404 — never a conversation about someone else's project. */
  async conversationFor(user: User, projectId: string | null = null): Promise<ChatConversation> {
    if (projectId === null) return this.deps.repos.chat.getOrCreateForUser(user.id);
    const [project] = await this.deps.repos.projects.findByIdsForOwner([projectId], user.id);
    if (!project) throw new HttpError(404, 'Projeto não encontrado', 'PROJECT_NOT_FOUND');
    return this.deps.repos.chat.getOrCreateForProject(user.id, projectId);
  }

  /** The host is always the account-wide conversation's (spec §3); a project chat additionally needs an
   * agent that forwards its prompt. */
  hostFor(user: User, projectId: string | null = null): Promise<HostChoice> {
    return resolveHost({ repos: this.deps.repos, agents: this.deps.agents }, user, projectId === null ? {} : { requires: CAPABILITY_CLAUDE_SYSTEM_PROMPT });
  }
```

If `notFound` from `../lib/errors.js` accepts a code argument, use it instead. Otherwise keep the explicit `HttpError`.

3. Split `send` into a public entry point and a private runner:

```ts
  async send(user: User, text: string, opts: { projectId?: string | null } = {}): Promise<ChatMessage> {
    return this.sendIn(user, await this.conversationFor(user, opts.projectId ?? null), text);
  }

  private async sendIn(user: User, conversation: ChatConversation, text: string, opts?: { beforeRun?: () => Promise<void> }): Promise<ChatMessage> {
    // …the current body of `send`, from `const host = …` on, with these edits:
  }
```

Edits inside `sendIn`:
- `const host = await this.hostFor(user, conversation.project_id);`
- `pinHostMachine` pins the **host's** conversation, which is not necessarily this one:

```ts
      const hostConversation = conversation.project_id === null ? conversation : await this.deps.repos.chat.getOrCreateForUser(user.id);
      await this.deps.repos.chat.pinHostMachine(hostConversation.id, host.machine.id);
```

- Every `chatBus.publish({...})` in the body gains `conversation_id: conversation.id`.
- Mint the token as `mintConciergeToken(this.deps.repos, user.id, conversation.id, ['read', 'tasks', 'terminals'], { accountWide: conversation.project_id === null })`.
- Build `input` with `append_system_prompt: await this.promptFor(user, conversation)`.
- In `finally`: `void this.drainNextDecision(user, conversation.id).catch(() => {});`

4. The prompt helper:

```ts
  /** The project's focus text for this run, or null for the account-wide chat. Owner-scoped reads, so a
   * machine link to a machine this user no longer owns names nothing. */
  private async promptFor(user: User, conversation: ChatConversation): Promise<string | null> {
    if (conversation.project_id === null) return null;
    const [project] = await this.deps.repos.projects.findByIdsForOwner([conversation.project_id], user.id);
    if (!project) return null;
    const links = await this.deps.repos.projectMachines.listByProject(project.id);
    const machines = await this.deps.repos.machines.findByIdsForOwner(links.map((l) => l.machine_id), user.id);
    const nameOf = new Map(machines.map((m) => [m.id, m.name]));
    return projectSystemPrompt(project, links.filter((l) => nameOf.has(l.machine_id)).map((l) => ({ machine: nameOf.get(l.machine_id)!, cwd: l.cwd })));
  }
```

5. `resumeAfterDecision` runs in the action's own conversation:

```ts
  async resumeAfterDecision(user: User, action: ChatAction): Promise<ChatMessage> {
    const conversation = await this.deps.repos.chat.findByIdForUser(action.conversation_id, user.id);
    // `decide` already proved the row is this user's; a conversation archived since then has nobody
    // reading it, and `reset` expired its open rows — nothing to inject.
    if (!conversation || conversation.archived_at !== null) throw new HttpError(409, 'Esta conversa foi encerrada', 'CHAT_ARCHIVED');
    return this.sendIn(user, conversation, await this.injectionFor(user, action, conversation.cli_session_id === null), {
      beforeRun: () => this.deps.repos.chatActions.markInjected(action.id),
    });
  }
```

The route already turns a `CHAT_BUSY` from this call into `queued: true`. `CHAT_ARCHIVED` is a plain 409, which is correct: `reset` already expired the row, so `decide` would normally have refused it before this point.

6. `drainNextDecision(user, conversationId)`: replace `const conversation = await this.conversationFor(user)` with `const conversation = await this.deps.repos.chat.findByIdForUser(conversationId, user.id); if (!conversation || conversation.archived_at !== null) return;`. Replace the inner `this.send(user, …)` with `this.sendIn(user, conversation, …)`. Drop the "one user has exactly one conversation" paragraph from its doc comment.

7. Reset and statuses:

```ts
  /**
   * "Nova conversa" (spec §4.1): the active conversation of the scope is archived and a fresh one takes
   * its place — a new CLI session, an empty thread. Holds the conversation's lock while it works, so a
   * message cannot start a run on the row being archived.
   */
  async reset(user: User, projectId: string | null): Promise<ChatConversation> {
    const current = await this.conversationFor(user, projectId);
    if (this.running.has(current.id)) throw new HttpError(409, 'O concierge ainda está respondendo a mensagem anterior', 'CHAT_BUSY');
    this.running.add(current.id);
    try {
      await this.deps.repos.chatActions.expireOpenForConversation(current.id);
      await this.deps.repos.apiTokens.revokeForConversation(current.id);
      await this.deps.repos.chat.archive(current.id);
    } finally {
      this.running.delete(current.id);
    }
    return this.conversationFor(user, projectId);
  }

  /** What the sidebar's 💬 shows per project: answering right now, and questions waiting on the user. */
  async projectStatuses(user: User): Promise<{ project_id: string; busy: boolean; pending_confirmations: number }[]> {
    const rows = await this.deps.repos.chat.listActiveProjectConversations(user.id);
    const pending = await this.deps.repos.chatActions.countPendingByConversation(rows.map((r) => r.id));
    return rows.map((r) => ({ project_id: r.project_id, busy: this.running.has(r.id), pending_confirmations: pending.get(r.id) ?? 0 }));
  }
```

- [ ] **Step 7: Run all server tests and the typecheck**

Run: `npm test -w @termhub/server && npm run typecheck -w @termhub/server`

Expected: PASS. Old tests that build `ChatEvent` literals, or assert on published events with `toEqual`, need `conversation_id: 'c1'` added. Update them. That is the only expected churn.

- [ ] **Step 8: Commit**

```bash
git add apps/server/src/chat
git commit -m "Server: ChatService runs per conversation, with project focus and reset

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Routes: `?project=`, `project_id`, `/reset`, `/projects`, and a host change clears project sessions

**Files:**
- Modify: `apps/server/src/routes/chat.ts`
- Test: `apps/server/src/routes/chat.test.ts`

**Interfaces:**
- Consumes: the `ChatService` methods from Task 4, and `ChatRepository.clearProjectSessions` from Task 1.
- Produces the HTTP API the web uses:
  - `GET /api/chat?project=<id>` → `{ conversation, messages, actions, host }`
  - `POST /api/chat/messages { text, project_id? }` → `201 { message }`
  - `POST /api/chat/reset { project_id? }` → `{ conversation }`, or 409 `CHAT_BUSY`
  - `GET /api/chat/projects` → `{ projects: { project_id, busy, pending_confirmations }[] }`

- [ ] **Step 1: Write the failing route tests**

In `chat.test.ts`, extend `build`'s `service` fake with `reset: opts.reset ?? vi.fn(async () => ({ id: 'c_new', project_id: 'p1' }))` and `projectStatuses: vi.fn(async () => [{ project_id: 'p1', busy: true, pending_confirmations: 1 }])`. Make `conversationFor` record its arguments. Add `clearProjectSessions: vi.fn(async () => undefined)` to `repos.chat`.

```ts
it('GET /?project= reads that project conversation and its host', async () => {
  const { app, service } = build();
  const res = await app.inject({ method: 'GET', url: '/api/chat?project=p1' });
  expect(res.statusCode).toBe(200);
  expect(service.conversationFor).toHaveBeenCalledWith(expect.objectContaining({ id: 'u1' }), 'p1');
  expect(service.hostFor).toHaveBeenCalledWith(expect.objectContaining({ id: 'u1' }), 'p1');
});

it('POST /messages passes project_id through', async () => {
  const { app, send } = build();
  await app.inject({ method: 'POST', url: '/api/chat/messages', payload: { text: 'oi', project_id: 'p1' } });
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ id: 'u1' }), 'oi', { projectId: 'p1' });
});

it('POST /reset archives the scope and answers the fresh conversation', async () => {
  const { app, service } = build();
  const res = await app.inject({ method: 'POST', url: '/api/chat/reset', payload: { project_id: 'p1' } });
  expect(res.statusCode).toBe(200);
  expect(res.json().conversation.id).toBe('c_new');
  expect(service.reset).toHaveBeenCalledWith(expect.objectContaining({ id: 'u1' }), 'p1');
});

it('POST /reset without project_id resets the account-wide chat', async () => {
  const { app, service } = build();
  await app.inject({ method: 'POST', url: '/api/chat/reset', payload: {} });
  expect(service.reset).toHaveBeenCalledWith(expect.anything(), null);
});

it('POST /reset is a 409 while busy', async () => {
  const { app } = build({ reset: vi.fn(async () => { throw new HttpError(409, 'ocupado', 'CHAT_BUSY'); }) });
  const res = await app.inject({ method: 'POST', url: '/api/chat/reset', payload: {} });
  expect(res.statusCode).toBe(409);
});

it('GET /projects lists per-project status', async () => {
  const { app } = build();
  const res = await app.inject({ method: 'GET', url: '/api/chat/projects' });
  expect(res.json()).toEqual({ projects: [{ project_id: 'p1', busy: true, pending_confirmations: 1 }] });
});

it('POST /host also drops the sessions of the project chats', async () => {
  const { app, repos } = build();
  await app.inject({ method: 'POST', url: '/api/chat/host', payload: { machine_id: 'm1' } });
  expect(repos.chat.clearProjectSessions).toHaveBeenCalledWith('u1');
});
```

Import `HttpError` from `../lib/errors.js` if the file does not already. Adapt the destructured names (`service`, `send`, `repos`) to what `build` returns. Extend its return value where needed.

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -w @termhub/server -- src/routes/chat.test.ts`

Expected: the new cases FAIL.

- [ ] **Step 3: Implement**

In `routes/chat.ts`:

```ts
const messageBody = z.object({ text: z.string().trim().min(1).max(8000), project_id: z.string().min(1).max(64).nullish() });
const scopeQuery = z.object({ project: z.string().min(1).max(64).optional() });
const resetBody = z.object({ project_id: z.string().min(1).max(64).nullish() });
```

- `GET /`: `const { project } = scopeQuery.parse(request.query); const projectId = project ?? null;`. Then call `deps.service.conversationFor(request.scope.user, projectId)` and `deps.service.hostFor(request.scope.user, projectId)`.
- `POST /host`: when `setHost` dropped the account-wide session (the host really moved), drop the project chats' sessions too:

```ts
    const current = await deps.service.conversationFor(user);
    const conversation = await repos.chat.setHost(current.id, { machine_id: machine.id, ai_account_id: accountId });
    // The project chats run on this same host (spec §3): a move strands their sessions exactly as it
    // strands this one's, and `setHost` is the one that knows whether it really moved.
    if (current.cli_session_id !== null && conversation.cli_session_id === null) await repos.chat.clearProjectSessions(user.id);
```

  In the test for this, make `conversationFor` return `cli_session_id: 's-old'` (the fake `setHost` already answers `cli_session_id: null`).
- `POST /messages`: `const { text, project_id } = messageBody.parse(request.body); const message = await deps.service.send(request.scope.user, text, { projectId: project_id ?? null });`
- `POST /actions/:id/decision`: add `conversation_id: action.conversation_id` to the `decision` publish.
- New routes:

```ts
  /** "Nova conversa": archives the scope's active conversation and answers the fresh, empty one. */
  app.post('/reset', { config: { action: 'update' } }, async (request) => {
    const { project_id } = resetBody.parse(request.body ?? {});
    return { conversation: await deps.service.reset(request.scope.user, project_id ?? null) };
  });

  /** Per-project chat status for the sidebar's 💬: answering now, and questions waiting on the user. */
  app.get('/projects', async (request) => ({ projects: await deps.service.projectStatuses(request.scope.user) }));
```


- [ ] **Step 4: Run the tests**

Run: `npm test -w @termhub/server && npm run typecheck -w @termhub/server`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/routes
git commit -m "Server: chat routes take a project; reset and per-project status

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Web: `ChatPanel` extracted from `ChatPage`, with event filtering and "Nova conversa"

**Files:**
- Create: `apps/web/src/components/chat/ChatPanel.tsx`
- Modify: `apps/web/src/pages/ChatPage.tsx`, which becomes a thin wrapper
- Modify: `apps/web/src/lib/api.ts:148-185`
- Modify: `apps/web/src/lib/types.ts:561-685`
- Test: `apps/web/src/components/chat/ChatPanel.test.tsx`. `pages/ChatPage.test.tsx` and `ChatPage.stream.test.tsx` must keep passing unchanged, except for additions.

**Interfaces:**
- Consumes: the HTTP API from Task 5.
- Produces:
  - `api.chat(projectId?: string | null)`
  - `api.sendChatMessage(text: string, projectId?: string | null)`
  - `api.resetChat(projectId?: string | null): Promise<{ conversation: ChatConversation }>`
  - `api.chatProjects(): Promise<{ projects: ProjectChatStatus[] }>`
  - `type ProjectChatStatus = { project_id: string; busy: boolean; pending_confirmations: number }`
  - `ChatEvent` members gain `conversation_id?: string`
  - `ChatConversation` gains `project_id: string | null; archived_at: string | null`
  - `<ChatPanel projectId={string | null} />`

- [ ] **Step 1: API and types**

`types.ts`:
- Add `project_id: string | null; archived_at: string | null;` to `ChatConversation`.
- Add `conversation_id?: string;` to every `ChatEvent` member. It is optional so older servers and the existing tests still type-check.
- Add `export interface ProjectChatStatus { project_id: string; busy: boolean; pending_confirmations: number }`.

`api.ts`:

```ts
  /** The active conversation of a scope: no project = the account-wide chat (`/chat`); a project id =
   * that project's own chat (404 when it is not the signed-in user's). */
  chat: (projectId?: string | null) =>
    request<{ conversation: ChatConversation; messages: ChatMessage[]; actions: ChatAction[]; host: ChatHostState }>('GET', projectId ? `/chat?project=${encodeURIComponent(projectId)}` : '/chat'),
  sendChatMessage: (text: string, projectId?: string | null) => request<{ message: ChatMessage }>('POST', '/chat/messages', projectId ? { text, project_id: projectId } : { text }),
  /** "Nova conversa": archives the scope's active conversation (the transcript is kept) and answers the
   *  fresh one. 409 CHAT_BUSY while an answer is being written. */
  resetChat: (projectId?: string | null) => request<{ conversation: ChatConversation }>('POST', '/chat/reset', projectId ? { project_id: projectId } : {}),
  chatProjects: () => request<{ projects: ProjectChatStatus[] }>('GET', '/chat/projects'),
```

Keep the existing doc comments on `chat` and `sendChatMessage`, but drop "v1: one conversation per user".

- [ ] **Step 2: Write the failing `ChatPanel` tests**

`components/chat/ChatPanel.test.tsx`: copy the mock block (lines 1–60) from `pages/ChatPage.test.tsx`, adding `resetChat` and `confirmMock`. Adjust the relative paths to `../../lib/...`. Then:

```tsx
it('loads the project conversation and sends into it', async () => {
  chatMock.mockResolvedValue({ conversation: { id: 'c_p1', project_id: 'p1', ai_account_id: null }, messages: [], actions: [], host: { kind: 'ready', machine: { id: 'm1', name: 'jarvis' }, configDir: null, account: { kind: 'default' }, sessionAtStake: false } });
  sendMock.mockResolvedValue({ message: { id: 'm2' } });
  render(<MemoryRouter><ChatPanel projectId="p1" /></MemoryRouter>);
  await waitFor(() => expect(chatMock).toHaveBeenCalledWith('p1'));
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'status?' } });
  fireEvent.click(screen.getByRole('button', { name: /enviar/i }));
  await waitFor(() => expect(sendMock).toHaveBeenCalledWith('status?', 'p1'));
});

it('ignores live events of another conversation', async () => {
  // load answers conversation c_p1; the stream mock hands us onEvent
  let onEvent!: (e: unknown) => void;
  streamMock.mockImplementation((_reload: unknown, cb: (e: unknown) => void) => {
    onEvent = cb;
    return { events: [{ type: 'delta', conversation_id: 'c_other', message_id: 'm9', delta: 'VAZOU' }], connected: true };
  });
  chatMock.mockResolvedValue({ conversation: { id: 'c_p1', project_id: 'p1', ai_account_id: null }, messages: [{ id: 'm9', conversation_id: 'c_p1', role: 'assistant', text: '', error_code: null, created_at: '' }], actions: [], host: { kind: 'ready', machine: { id: 'm1', name: 'jarvis' }, configDir: null, account: { kind: 'default' }, sessionAtStake: false } });
  render(<MemoryRouter><ChatPanel projectId="p1" /></MemoryRouter>);
  await waitFor(() => expect(chatMock).toHaveBeenCalled());
  expect(screen.queryByText('VAZOU')).toBeNull();
  onEvent({ type: 'confirmation', conversation_id: 'c_other', action_id: 'a9', tool: 'send_input', args: {}, class: 'write', machine_id: null, project_id: null, tab_id: null, summary: 'NÃO É DAQUI', created_at: '' });
  expect(screen.queryByText('NÃO É DAQUI')).toBeNull();
});

it('Nova conversa asks first, resets, and swaps in the empty conversation', async () => {
  chatMock
    .mockResolvedValueOnce({ conversation: { id: 'c_p1', project_id: 'p1', ai_account_id: null }, messages: [{ id: 'm1', conversation_id: 'c_p1', role: 'user', text: 'antigo', error_code: null, created_at: '' }], actions: [], host: READY })
    .mockResolvedValue({ conversation: { id: 'c_new', project_id: 'p1', ai_account_id: null }, messages: [], actions: [], host: READY });
  resetMock.mockResolvedValue({ conversation: { id: 'c_new', project_id: 'p1' } });
  render(<MemoryRouter><ChatPanel projectId="p1" /></MemoryRouter>);
  await screen.findByText('antigo');
  fireEvent.click(screen.getByRole('button', { name: 'Nova conversa' }));
  expect(resetMock).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Começar de novo' }));
  await waitFor(() => expect(resetMock).toHaveBeenCalledWith('p1'));
  await waitFor(() => expect(screen.queryByText('antigo')).toBeNull());
});

it('in a project, a host that is not chosen points to /chat instead of offering a picker', async () => {
  chatMock.mockResolvedValue({ conversation: { id: 'c_p1', project_id: 'p1', ai_account_id: null }, messages: [], actions: [], host: { kind: 'not_chosen', machines: [{ id: 'm1', name: 'a' }, { id: 'm2', name: 'b' }], sessionAtStake: false } });
  render(<MemoryRouter><ChatPanel projectId="p1" /></MemoryRouter>);
  expect(await screen.findByRole('link', { name: /escolher a máquina do chat/i })).toHaveAttribute('href', '/chat');
});
```

Define `const READY = { kind: 'ready', machine: { id: 'm1', name: 'jarvis' }, configDir: null, account: { kind: 'default' }, sessionAtStake: false };` at the top. Check `ChatComposer` for the send button's accessible name, and use it. Default `streamMock` to `() => ({ events: [], connected: true })` in `beforeEach`.

- [ ] **Step 3: Run to verify it fails**

Run: `npm test -w @termhub/web -- src/components/chat/ChatPanel.test.tsx`

Expected: FAIL. `ChatPanel` does not exist.

- [ ] **Step 4: Extract `ChatPanel`**

Move the whole body of `ChatPage` (the state, `load`, `onEvent`, `decide`, the picker, `send`, `live`, the timeline and the JSX) into `components/chat/ChatPanel.tsx` as `export function ChatPanel({ projectId }: { projectId: string | null })`. Fix the relative imports (`../../lib/...`, `./ChatActionCard`, and so on). Then make these edits:

1. Track the conversation id and filter by it:

```tsx
  /** The conversation this panel shows. Live events of any other one — the account-wide chat and every
   *  project chat share one socket per user — are dropped, so two open chats never mix their answers. */
  const [conversationId, setConversationId] = useState<string | null>(null);
  const mine = useCallback((e: ChatEvent) => e.conversation_id === undefined || conversationId === null || e.conversation_id === conversationId, [conversationId]);
```

- In `load`: `const { conversation, … } = await api.chat(projectId ?? undefined);` must still call `api.chat()` with **no argument** for the account-wide chat, because the old `ChatPage` tests may assert `toHaveBeenCalledWith()`. Write it as `projectId ? api.chat(projectId) : api.chat()`. Then `setConversationId(conversation.id)`.
- `onEvent` starts with `if (!mine(e)) return;` and lists `mine` in its deps.
- `const { events: allEvents, connected } = useChatStream(load, onEvent);` then `const events = useMemo(() => allEvents.filter(mine), [allEvents, mine]);`. `live` and the scroll effect keep reading `events`.
- `send`: `projectId ? await api.sendChatMessage(value, projectId) : await api.sendChatMessage(value)`, for the same reason.
- The `load` deps become `[projectId]`.

2. The "Nova conversa" header, above the host card:

```tsx
  const [confirmReset, setConfirmReset] = useState(false);
  const [resetting, setResetting] = useState(false);
  /** Whether an answer is being written right now — the only time a reset is refused (409). */
  const answering = sending || (lastMessageId !== null && live.started.has(lastMessageId) && !messages[messages.length - 1]?.text && !messages[messages.length - 1]?.error_code);

  const reset = async () => {
    setResetting(true);
    setError(null);
    try {
      await api.resetChat(projectId);
      setConfirmReset(false);
      setActions([]);
      setQueuedNotes({});
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Não foi possível começar uma nova conversa');
    } finally {
      setResetting(false);
    }
  };
```

In the JSX, as the first child of the column:

```tsx
      <div className="flex items-center justify-end pt-2">
        <button type="button" className="rounded px-2 py-1 text-xs text-fg-dim hover:bg-bg-3 hover:text-fg disabled:opacity-50" disabled={answering || resetting || messages.length === 0} onClick={() => setConfirmReset(true)}>
          Nova conversa
        </button>
      </div>
      <ConfirmDialog
        open={confirmReset}
        title="Nova conversa"
        message="O contexto atual desta conversa será descartado. As mensagens saem da tela e o concierge começa do zero."
        confirmLabel="Começar de novo"
        onCancel={() => setConfirmReset(false)}
        onConfirm={() => void reset()}
      />
```

Import `ConfirmDialog` from `../Modal`. Check its `onConfirm` type: the Sidebar passes an async function, so a void-returning one is fine.

3. Host card by scope. The picker (`ChatHost` with all its props) renders only when `projectId === null`. For a project:

```tsx
      {host && projectId !== null && host.kind !== 'ready' && (
        <div className="mt-2 rounded border border-line bg-bg-2 p-3 text-sm text-fg-muted">
          {host.kind === 'no_machine' || host.kind === 'not_chosen' ? (
            <>
              O chat dos projetos roda na mesma máquina do chat geral.{' '}
              <Link to="/chat" className="text-accent hover:underline">
                Escolher a máquina do chat
              </Link>
            </>
          ) : host.kind === 'offline' ? (
            `A máquina ${host.machine.name} está offline.`
          ) : (
            `O agente da máquina ${host.machine.name} precisa ser atualizado para o chat do projeto.`
          )}
        </div>
      )}
```

Import `Link` from `react-router-dom`. The panel is always rendered inside a router: `ChatLayout` for `/chat`, `Layout` for the drawer.

4. The empty-state sentence: for a project, `Pergunte sobre este projeto: o concierge lê os terminais dele e pede sua autorização antes de qualquer alteração.` For the account-wide chat, keep the current sentence.

`pages/ChatPage.tsx` becomes:

```tsx
import { ChatPanel } from '../components/chat/ChatPanel';

/** The account-wide concierge chat (`/chat`): questions that cross projects, and where the host is chosen. */
export function ChatPage() {
  return <ChatPanel projectId={null} />;
}
```

- [ ] **Step 5: Run the web tests**

Run: `npm test -w @termhub/web -- src/components/chat src/pages/ChatPage`

Expected: PASS. The two existing `ChatPage` test files pass unchanged: their mocks never send `conversation_id`, so `mine` keeps every event. If one asserts the exact first children of the column, update it for the new "Nova conversa" row. That is the only acceptable change there.

Then `npm run build -w @termhub/web`. Expected: PASS (tsc + vite).

- [ ] **Step 6: Commit**

```bash
git add apps/web/src
git commit -m "Web: ChatPanel shared by /chat and project chats, with Nova conversa

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Web: the project chat context, `ChatDrawer`, and the Escape layer

**Files:**
- Create: `apps/web/src/lib/project-chat.tsx`
- Create: `apps/web/src/components/chat/ChatDrawer.tsx`
- Modify: `apps/web/src/components/Modal.tsx:1-35`, to extract `useEscapeLayer`
- Modify: `apps/web/src/components/Layout.tsx:38-52`
- Test: `apps/web/src/components/chat/ChatDrawer.test.tsx`, `apps/web/src/lib/project-chat.test.tsx`. `Modal.test.tsx` must keep passing.

**Interfaces:**
- Consumes: `ChatPanel`, `api.chatProjects`, and `useChatStream` from Task 6.
- Produces:
  - `useEscapeLayer(open: boolean, onEscape: () => void, enabled?: boolean): void`, from `components/Modal.tsx`
  - `ProjectChatProvider`
  - `useProjectChat(): { openProjectId: string | null; toggle(id: string): void; close(): void; status(id: string): { busy: boolean; pending: number } }`
  - `<ChatDrawer />`, which renders nothing when closed

- [ ] **Step 1: Extract `useEscapeLayer` (refactor, guarded by `Modal.test.tsx`)**

In `Modal.tsx`, add:

```tsx
/**
 * Joins the stack of open layers for as long as `open` is true: only the top one answers Escape, so a
 * dialog opened from the chat drawer closes before the drawer does. Keyed on `open` only, so a
 * re-render with a new callback keeps the stack order.
 */
export function useEscapeLayer(open: boolean, onEscape: () => void, enabled = true): void {
  const latest = useRef({ onEscape, enabled });
  latest.current = { onEscape, enabled };
  useEffect(() => {
    if (!open) return;
    const id = Symbol('layer');
    openStack.push(id);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || openStack[openStack.length - 1] !== id) return;
      if (latest.current.enabled) latest.current.onEscape();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      openStack.splice(openStack.indexOf(id), 1);
    };
  }, [open]);
}
```

In `Modal`, replace the `latest` ref and the effect with `useEscapeLayer(open, onClose, dismissible);`. Rename the stack comment to "Open layers (modals, the chat drawer), innermost last".

Run: `npm test -w @termhub/web -- src/components/Modal.test.tsx`. Expected: PASS.

- [ ] **Step 2: Write the failing tests**

`lib/project-chat.test.tsx`:

```tsx
// @vitest-environment jsdom
import { act, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { ProjectChatProvider, useProjectChat } from './project-chat';

const projectsMock = vi.fn();
let emit!: (e: unknown) => void;
vi.mock('./api', () => ({ api: { chatProjects: (...a: unknown[]) => projectsMock(...a) } }));
vi.mock('./chat', () => ({ useChatStream: (_r: unknown, cb: (e: unknown) => void) => ((emit = cb), { events: [], connected: true }) }));

function Probe() {
  const { openProjectId, toggle, status } = useProjectChat();
  return (
    <>
      <span data-testid="open">{openProjectId ?? 'none'}</span>
      <span data-testid="p1">{JSON.stringify(status('p1'))}</span>
      <button onClick={() => toggle('p1')}>p1</button>
      <button onClick={() => toggle('p2')}>p2</button>
    </>
  );
}

it('toggle opens, swaps and closes', () => {
  projectsMock.mockResolvedValue({ projects: [] });
  render(<ProjectChatProvider><Probe /></ProjectChatProvider>);
  act(() => screen.getByText('p1').click());
  expect(screen.getByTestId('open').textContent).toBe('p1');
  act(() => screen.getByText('p2').click());
  expect(screen.getByTestId('open').textContent).toBe('p2');
  act(() => screen.getByText('p2').click());
  expect(screen.getByTestId('open').textContent).toBe('none');
});

it('reads statuses on load and re-reads them on chat events', async () => {
  projectsMock.mockResolvedValueOnce({ projects: [{ project_id: 'p1', busy: false, pending_confirmations: 1 }] }).mockResolvedValue({ projects: [{ project_id: 'p1', busy: true, pending_confirmations: 0 }] });
  render(<ProjectChatProvider><Probe /></ProjectChatProvider>);
  await waitFor(() => expect(screen.getByTestId('p1').textContent).toBe('{"busy":false,"pending":1}'));
  act(() => emit({ type: 'message', conversation_id: 'c_p1', message: {} }));
  await waitFor(() => expect(screen.getByTestId('p1').textContent).toBe('{"busy":true,"pending":0}'));
});

it('works without a provider (the sidebar in isolation): closed, no status', () => {
  render(<Probe />);
  expect(screen.getByTestId('open').textContent).toBe('none');
  expect(screen.getByTestId('p1').textContent).toBe('{"busy":false,"pending":0}');
});
```

`components/chat/ChatDrawer.test.tsx`:

```tsx
// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { expect, it, vi } from 'vitest';
import { ChatDrawer } from './ChatDrawer';
import { useProjectChat } from '../../lib/project-chat';

vi.mock('./ChatPanel', () => ({ ChatPanel: ({ projectId }: { projectId: string }) => <div>painel {projectId}</div> }));
vi.mock('../../lib/data', () => ({ useData: () => ({ projects: [{ id: 'p1', name: 'Popingo', key: 'POP' }, { id: 'p2', name: 'Outro', key: 'OUT' }] }) }));
const state = vi.hoisted(() => ({ openProjectId: 'p1' as string | null, close: vi.fn() }));
vi.mock('../../lib/project-chat', () => ({ useProjectChat: () => ({ ...state, toggle: vi.fn(), status: () => ({ busy: false, pending: 0 }) }) }));

it('shows the open project chat with its name', () => {
  render(<MemoryRouter><ChatDrawer /></MemoryRouter>);
  expect(screen.getByRole('dialog', { name: 'Chat · Popingo' })).toBeTruthy();
  expect(screen.getByText('painel p1')).toBeTruthy();
});

it('keys the panel by project, so switching projects remounts it', () => {
  const { rerender } = render(<MemoryRouter><ChatDrawer /></MemoryRouter>);
  state.openProjectId = 'p2';
  rerender(<MemoryRouter><ChatDrawer /></MemoryRouter>);
  expect(screen.getByText('painel p2')).toBeTruthy();
  state.openProjectId = 'p1';
});

it('Escape and × close it', () => {
  render(<MemoryRouter><ChatDrawer /></MemoryRouter>);
  act(() => void fireEvent.keyDown(window, { key: 'Escape' }));
  expect(state.close).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'Fechar chat' }));
  expect(state.close).toHaveBeenCalledTimes(2);
});

it('renders nothing when closed', () => {
  state.openProjectId = null;
  const { container } = render(<MemoryRouter><ChatDrawer /></MemoryRouter>);
  expect(container.innerHTML).toBe('');
  state.openProjectId = 'p1';
});
```

Remove the unused `useProjectChat` import if the linter complains. It is only there to show the mocked module.

- [ ] **Step 3: Run to verify they fail**

Run: `npm test -w @termhub/web -- src/lib/project-chat.test.tsx src/components/chat/ChatDrawer.test.tsx`

Expected: FAIL, modules not found.

- [ ] **Step 4: Implement `lib/project-chat.tsx`**

```tsx
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api } from './api';
import { useChatStream } from './chat';
import type { ChatEvent, ProjectChatStatus } from './types';

interface ProjectChatValue {
  /** The project whose chat the drawer shows, or null when it is closed. */
  openProjectId: string | null;
  /** The sidebar's 💬: opens that project's chat, swaps to it from another one, or closes it if open. */
  toggle(id: string): void;
  close(): void;
  /** Whether that project's chat is answering, and how many questions wait on the user. */
  status(id: string): { busy: boolean; pending: number };
}

const IDLE = { busy: false, pending: 0 };
/** Without a provider (a component rendered on its own, in a test) the chat is closed and idle. */
const ProjectChatContext = createContext<ProjectChatValue>({ openProjectId: null, toggle: () => {}, close: () => {}, status: () => IDLE });

export function ProjectChatProvider({ children }: { children: ReactNode }) {
  const [openProjectId, setOpenProjectId] = useState<string | null>(null);
  const [statuses, setStatuses] = useState<Map<string, ProjectChatStatus>>(new Map());

  const refresh = useCallback(async () => {
    try {
      const { projects } = await api.chatProjects();
      setStatuses(new Map(projects.map((p) => [p.project_id, p])));
    } catch {
      /* an indicator, never an error: the next event tries again */
    }
  }, []);
  useEffect(() => void refresh(), [refresh]);

  // A run starts and ends with a `message` event; a question appears with `confirmation` and goes
  // away with `decision`. Those are the only moments a dot can change, so they are the only re-reads.
  const onEvent = useCallback((e: ChatEvent) => {
    if (e.type === 'message' || e.type === 'confirmation' || e.type === 'decision') void refresh();
  }, [refresh]);
  useChatStream(refresh, onEvent);

  const value = useMemo<ProjectChatValue>(
    () => ({
      openProjectId,
      toggle: (id) => setOpenProjectId((cur) => (cur === id ? null : id)),
      close: () => setOpenProjectId(null),
      status: (id) => {
        const s = statuses.get(id);
        return s ? { busy: s.busy, pending: s.pending_confirmations } : IDLE;
      },
    }),
    [openProjectId, statuses],
  );
  return <ProjectChatContext.Provider value={value}>{children}</ProjectChatContext.Provider>;
}

export const useProjectChat = (): ProjectChatValue => useContext(ProjectChatContext);
```

- [ ] **Step 5: Implement `components/chat/ChatDrawer.tsx`**

```tsx
import { useEffect } from 'react';
import { useData } from '../../lib/data';
import { useProjectChat } from '../../lib/project-chat';
import { trackAppHeight } from '../../lib/viewport';
import { useEscapeLayer } from '../Modal';
import { ChatPanel } from './ChatPanel';

/**
 * A project's chat, over whatever page is open (spec 2026-09-23 §5.2). Mounted once in `Layout`,
 * outside the routes, so it survives navigation: the person can open the project's tabs and keep
 * talking. It overlays `main` instead of resizing it, so no terminal re-fits because a chat opened.
 * Closing it stops nothing — a run in progress finishes on the server and is there on reopening.
 */
export function ChatDrawer() {
  const { openProjectId, close } = useProjectChat();
  const { projects } = useData();
  const open = openProjectId !== null;
  useEscapeLayer(open, close);
  // Full screen on a phone: the same viewport handling as `/chat`, so the composer stays above the
  // keyboard (see ChatLayout).
  useEffect(() => (open ? trackAppHeight() : undefined), [open]);

  if (!openProjectId) return null;
  const project = projects.find((p) => p.id === openProjectId);
  const title = `Chat · ${project?.name ?? 'projeto'}`;
  return (
    <aside
      role="dialog"
      aria-label={title}
      className="fixed inset-x-0 top-0 z-40 flex h-[var(--app-height,100svh)] flex-col border-l border-line bg-bg shadow-2xl md:left-auto md:w-[420px]"
    >
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-line px-3">
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-fg">{title}</h2>
        <button type="button" className="rounded px-2 py-1 text-sm text-fg-dim hover:bg-bg-3 hover:text-fg" aria-label="Fechar chat" title="Fechar (Esc)" onClick={close}>
          ✕
        </button>
      </header>
      <div className="flex min-h-0 flex-1 flex-col">
        <ChatPanel key={openProjectId} projectId={openProjectId} />
      </div>
    </aside>
  );
}
```

Check that `trackAppHeight` returns a cleanup function (`lib/viewport.ts`). `ChatLayout` uses it as `useEffect(() => trackAppHeight(), [])`, which implies it does. Check that `bg-bg` and `z-40` fit the palette and stacking in `tailwind.config` and `Modal`: `Modal` uses `z-50`, so dialogs from the drawer stack above it. `ChatPanel`'s column has `max-w-3xl mx-auto px-4`, which is fine inside 420px.

- [ ] **Step 6: Mount it in `Layout`**

```tsx
export function Layout() {
  // …
  return (
    <FocusProvider>
      <ProjectChatProvider>
        <div className="flex h-full">
          <Chrome collapsed={collapsed} setCollapsed={setCollapsed} />
          <main className="relative min-w-0 flex-1">
            <Outlet />
          </main>
        </div>
        <ChatDrawer />
      </ProjectChatProvider>
    </FocusProvider>
  );
}
```

Import `ProjectChatProvider` from `../lib/project-chat` and `ChatDrawer` from `./chat/ChatDrawer`. `ChatLayout`, the `/chat` route, deliberately does not get it.

- [ ] **Step 7: Run the tests and build**

Run: `npm test -w @termhub/web && npm run build -w @termhub/web`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src
git commit -m "Web: project chat drawer over the page, closed by Escape

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Sidebar: 💬 replaces ✕, with a live indicator

**Files:**
- Modify: `apps/web/src/components/Sidebar.tsx:36-49, 121-137, 296-315`
- Test: `apps/web/src/components/Sidebar.test.tsx`

**Interfaces:**
- Consumes: `useProjectChat()` from Task 7, and `can('chat')` from `useAuth`.

- [ ] **Step 1: Write the failing tests**

In `Sidebar.test.tsx`, mock the context. The file already mocks `../lib/data` with a project list; use one of those project ids as `P`:

```tsx
const chat = vi.hoisted(() => ({ toggle: vi.fn(), status: vi.fn(() => ({ busy: false, pending: 0 })) }));
vi.mock('../lib/project-chat', () => ({ useProjectChat: () => ({ openProjectId: null, close: vi.fn(), ...chat }) }));

it('a project row has chat and edit, and no delete', () => {
  renderSidebar();
  const row = screen.getByText(PROJECT_NAME).closest('li')!;
  expect(within(row).getByRole('button', { name: 'Chat do projeto' })).toBeTruthy();
  expect(within(row).getByTitle('Editar projeto')).toBeTruthy();
  expect(within(row).queryByTitle(/Excluir projeto/)).toBeNull();
});

it('💬 toggles that project chat', () => {
  renderSidebar();
  fireEvent.click(within(screen.getByText(PROJECT_NAME).closest('li')!).getByRole('button', { name: 'Chat do projeto' }));
  expect(chat.toggle).toHaveBeenCalledWith(PROJECT_ID);
});

it('shows the 💬 without hover, with a dot, while that chat is answering or waiting', () => {
  chat.status.mockReturnValue({ busy: false, pending: 1 });
  renderSidebar();
  const button = within(screen.getByText(PROJECT_NAME).closest('li')!).getByRole('button', { name: 'Chat do projeto' });
  expect(button.getAttribute('data-active')).toBe('true');
  chat.status.mockReturnValue({ busy: false, pending: 0 });
});

it('no chat button without the chat permission', () => {
  // flip the auth mock's `can` to deny 'chat' as the file's other permission cases do
  renderSidebar();
  expect(screen.queryByRole('button', { name: 'Chat do projeto' })).toBeNull();
});
```

Use the file's existing render helper and fixtures in place of `renderSidebar`, `PROJECT_NAME` and `PROJECT_ID`, and import `within` and `fireEvent`. Delete any existing test that exercises the ✕ / "Remover projeto" dialog. That flow now lives only in `ProjectSettings`, which has its own coverage.

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -w @termhub/web -- src/components/Sidebar.test.tsx`

Expected: FAIL. There is no "Chat do projeto" button, and "Excluir projeto" is present.

- [ ] **Step 3: Implement**

In `Sidebar.tsx`:
- Remove the `deletingProject` and `deleteError` state, `deleteProject` from the `useData()` destructure, the `ConfirmDialog` block at the bottom, and the `ConfirmDialog` import if nothing else uses it. Keep `useLocation`/`location` only if still used elsewhere in the file. Otherwise remove them.
- `const projectChat = useProjectChat();` (import from `../lib/project-chat`).
- Replace the actions `<span>` (lines 122–137) with:

```tsx
                  {/* ações: ficam fora do link para não navegar ao clicar. O 💬 fica visível sem hover
                      enquanto o chat do projeto responde ou espera uma confirmação sua. */}
                  {(() => {
                    const chatStatus = projectChat.status(p.id);
                    const chatActive = chatStatus.busy || chatStatus.pending > 0;
                    return (
                      <span className="flex shrink-0 items-center gap-0.5 pr-1">
                        {can('chat') && (
                          <button
                            type="button"
                            data-active={chatActive}
                            className={`relative rounded px-1 text-xs text-fg-dim hover:bg-bg-4 hover:text-fg ${chatActive || projectChat.openProjectId === p.id ? '' : 'hidden group-hover/p:inline-block'}`}
                            aria-label="Chat do projeto"
                            title={chatStatus.pending > 0 ? 'Chat do projeto — esperando sua confirmação' : chatStatus.busy ? 'Chat do projeto — respondendo' : 'Chat do projeto'}
                            onClick={() => projectChat.toggle(p.id)}
                          >
                            💬
                            {chatActive && <span className={`absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full ${chatStatus.pending > 0 ? 'bg-attention' : 'animate-pulse bg-accent'}`} />}
                          </button>
                        )}
                        <button className="hidden rounded px-1 text-xs text-fg-dim hover:bg-bg-4 hover:text-fg group-hover/p:inline-block" title="Editar projeto" onClick={() => navigate(`/projects/${p.id}/settings`)}>
                          ✎
                        </button>
                      </span>
                    );
                  })()}
```

If the inline IIFE reads poorly next to the surrounding code, extract a small `ProjectRowActions({ project, onEdit })` component in the same file. Prefer that when the row code is already long.

- [ ] **Step 4: Run the tests and build**

Run: `npm test -w @termhub/web && npm run build -w @termhub/web`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/Sidebar.tsx apps/web/src/components/Sidebar.test.tsx
git commit -m "Web: sidebar project row opens its chat; delete lives in settings

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Full verification and the real app

**Files:** none new. This task fixes whatever it finds, in the task-appropriate files.

- [ ] **Step 1: Run the full suite exactly as CI does**

```bash
export DATABASE_URL=postgresql://postgres:postgres@localhost:55432/termhub
(cd apps/server && npx prisma migrate deploy)
npm run build:packages
TERMHUB_DB_TESTS=1 npm test
npm run typecheck -w @termhub/server && npm run typecheck -w @termhub/agent
npm run build -w @termhub/web && npm run build -w @termhub/server
```

Expected: everything passes. Fix any failures before going on.

- [ ] **Step 2: Drive the real app**

Use the `run` skill to start the dev stack against `th-test-db`. With a user that has one agent machine with an updated agent (`npm run dev -w @termhub/agent`, or whatever `apps/agent/README` says), check the following:
1. The sidebar project row shows 💬 and ✎ on hover, and no ✕. ✎ → settings → "Excluir projeto" still works.
2. 💬 opens the drawer titled `Chat · <projeto>`. Navigate to the project's page: the drawer stays. Escape closes it.
3. Ask in project A, then open project B's chat: B's thread is empty and does not show A's answer. `/chat` does not show either.
4. While A is answering, A's 💬 stays visible with a pulsing dot.
5. "Nova conversa" in A: confirm → the thread empties, and the next message starts a fresh CLI session (`cli_session_id` changes in `chat_conversations`; check with `psql` against `th-test-db`).
6. `/chat` still works as before, with its own Nova conversa.

Report what was verified and anything that could not be (for example, no agent machine available).

- [ ] **Step 3: Commit any fixes**

Commit each fix with its own `Server:`/`Web:` subject.
