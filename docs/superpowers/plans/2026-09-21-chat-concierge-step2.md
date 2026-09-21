# Chat concierge — step 2 (the gate and a concierge that can act) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the concierge write — type into a tab, open one, start an agent, manage tasks — with every write it makes either auto-allowed by class or waiting for the user's confirmation in the chat, durably, and with multi-line text actually arriving whole in an open CLI.

**Architecture:** The gate lives at the MCP boundary in the server, where every concierge action already arrives as a tool call. It does not hold the call: a gated call inserts a `chat_actions` row and returns "pending"; the user's answer is recorded and re-injected into the same `claude --resume` session, so the model re-issues the call and the second arrival executes. Gating is a property of the **token** (`api_tokens.gated`), not of the tool, so a human's own MCP session keeps acting unmediated. `tmux.sendText` learns bracketed paste, without which a multi-line prompt submits at its first newline.

**Tech Stack:** TypeScript (NodeNext), Fastify 5, Prisma 7 + Postgres, `ws`, zod, vitest, React 19 + Vite, tmux.

**Spec:** `docs/superpowers/specs/2026-09-20-chat-concierge-design.md` — §5 (the gate), §7 (`chat_actions`), §8 (limits), §11 (step 2). Step 1 shipped in #78 and #79.

## What the requester asked for that already exists

Recorded so nobody builds it twice: `send_input(tab_id, text, enter?)`, `open_tab`, `run_command`,
`send_key`, `close_tab` and `start_agent` all shipped in #66 and #71 under the `terminals` scope, and
`send_input` already refuses a tab in `waiting_permission` unless the caller passes
`answering_permission: true`. A dead or missing tab already answers `404`, `NOT_A_TERMINAL`,
`MACHINE_OFFLINE` or `AGENT_OUTDATED` as an `isError` tool result. What the concierge lacks is not
tools: its token is minted with `['read']`. This plan is what has to exist before that changes.

## Deferred from the spec and from the request, on purpose

`create_project` as an MCP tool and the `projects` token scope it needs (the REST route already
validates the cwd on the machine; the tool is a small follow-up, not a prerequisite); the vector
memory and the learning policy of §6, which is step 3 — **the gate in this plan is fixed, not
learned**: reads never ask, reversible writes always ask, irreversible always ask; `review_mode` and
the per-conversation model picker in the UI; per-machine and per-tab conversations.

## How this plan specifies the work, and why it changed

The step-1 plan carried the complete body of every function, and two of my own mistakes rode into
production inside that code: the `--session-id` plus `--resume` combination the CLI refuses, which
broke every message after the first, and a `listMessages` that returned the oldest 200 rows, which
would have frozen the chat. Both passed review, because a reviewer reads the code against the plan
and the plan was the error.

So this plan specifies **behaviour by test** — the tests are written out in full and they are the
contract — and leaves the bodies to the implementer, with interfaces, invariants and the tricky
mechanics named. Where a body is genuinely subtle (the gate's branch table, the paste mechanism) the
plan says what it must do and the test says when it is done. If a test here is wrong, the
implementer is expected to say so rather than write code that satisfies it.

Task 2 (bracketed paste) is **not in the spec**: it comes from the request that opened this work, and
it belongs here because the gate decides whether a write happens while the paste decides whether the
write is the one that was meant. Fold it into §4 of the spec when this lands.

## Global Constraints

- Commit messages, PR titles/descriptions, comments, identifiers and repo docs in **English**; **UI copy in pt-BR**. Imperative commit subjects ≤ 72 chars.
- Routes and services never import Prisma; data access goes through `apps/server/src/db/repositories`. Every request input validated with zod. Route plugins registered through `guarded(resource, plugin, prefix)`; new resources go in `RESOURCES`.
- Data is scoped by owner; one user must never read or answer another user's pending action.
- **Terminal content is never stored, logged, published or embedded.** `chat_actions.args` holds the arguments the concierge proposed (the command, the prompt, the target) — never a tool result's payload.
- The agent accepts only named RPCs; the server never sends shell text for the agent to execute.
- Migrations additive and backward compatible: the previous release keeps serving during blue/green.
- Verify before pushing: `npm test -w @termhub/server`, `npm test -w @termhub/concierge`, `npm test -w @termhub/web`, `npm test -w @termhub/agent`, the typechecks, and both builds. DB tests: `DATABASE_URL=postgresql://termhub:termhub@172.17.0.3:5432/termhub_test TERMHUB_DB_TESTS=1`. Drift: from `apps/server`, `npx prisma migrate deploy && npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code`.
- The concierge image is separate from the app image and the blue/green deploy does **not** rebuild it: any change under `apps/concierge` or `apps/agent` needs its own rollout step, named in the task.

## Review Focus

Five things the spec implies that no task's happy path exercises; each one's test lands in the task that owns the code.

1. **The same gated call arriving twice** — a model that retries, or two conversations of the same user proposing the identical action, must not create two pending rows nor execute twice (Task 3).
2. **An approval that arrives after the run is long gone** — the user clicks approve an hour later, when no CLI session is alive: the re-injection must start a fresh run rather than fail silently or resurrect a dead session (Task 5).
3. **A denial the model ignores** — after a `denied` row, the model re-issuing the same call must keep getting refused, not get a fresh question (Task 3).
4. **A tab that changed between question and answer** — the tab was killed, or its agent moved to `waiting_permission`, while the row sat pending; executing on approval must re-validate instead of typing into a hole (Task 4).
5. **Bracketed paste against a CLI that does not understand it** — a plain shell receives the escape bytes; they must not end up as visible garbage in the user's terminal (Task 2).

---

### Task 1: The `chat_actions` table, the gated token flag, and their repository

**Files:**
- Create: `apps/server/prisma/migrations/20260921120000_chat_actions/migration.sql`
- Modify: `apps/server/prisma/schema.prisma` (model `ChatAction`; `ApiToken.gated`)
- Create: `apps/server/src/db/repositories/chat-actions.ts`
- Modify: `apps/server/src/db/repositories/index.ts`, `apps/server/src/db/repositories/api-tokens.ts` (`create` takes `gated`)
- Test: `apps/server/src/db/repositories/chat-actions.db.test.ts`

**Interfaces:**
- Produces: `ChatAction`, `ChatActionStatus = 'pending' | 'approved' | 'denied' | 'expired' | 'executed' | 'failed'`, `ChatActionsRepository` with `findOpenByKey(conversationId, key)`, `insertPending(input)`, `decide(id, userId, status)`, `markExecuted(id, ok, errorCode?, durationMs?)`, `listByConversation(conversationId, limit?)`, `expireOlderThan(cutoff)`.
- Consumes: `newId()`, the `PrismaClient` type from `../prisma.js`.

- [ ] **Step 1: Write the failing test**

`apps/server/src/db/repositories/chat-actions.db.test.ts` — follow `chat.db.test.ts`'s shape (the `PrismaPg` adapter, a user created with `{ id, email, name }` and no `roleId`, cleaned up at the end):

```ts
import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../generated/prisma/client.js';
import { newId } from '../../lib/ids.js';
import { ChatActionsRepository } from './chat-actions.js';
import { ChatRepository } from './chat.js';

describe.skipIf(process.env.TERMHUB_DB_TESTS !== '1')('ChatActionsRepository (Postgres)', () => {
  let db: PrismaClient;
  let repo: ChatActionsRepository;
  let conversationId: string;
  let userId: string;

  beforeAll(async () => {
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
    repo = new ChatActionsRepository(db);
    userId = newId();
    await db.user.create({ data: { id: userId, email: `${userId}@test.local`, name: 'test' } });
    conversationId = (await new ChatRepository(db).getOrCreateForUser(userId)).id;
  });

  afterAll(async () => {
    await db.user.delete({ where: { id: userId } }); // cascades the conversation and its actions
    await db.$disconnect();
  });

  const pending = (key: string) => repo.insertPending({ conversation_id: conversationId, tool: 'send_input', args: { tab_id: 't1', text: 'npm test' }, idempotency_key: key, class: 'write' });

  it('finds an open row by its key and does not see a decided one', async () => {
    const row = await pending('k1');
    expect(row.status).toBe('pending');
    expect((await repo.findOpenByKey(conversationId, 'k1'))?.id).toBe(row.id);

    await repo.decide(row.id, userId, 'denied');
    expect(await repo.findOpenByKey(conversationId, 'k1')).toBeUndefined();
  });

  it('refuses a second open row for the same key, so a retry cannot ask twice', async () => {
    await pending('k2');
    await expect(pending('k2')).rejects.toThrow(); // partial unique index on the open statuses
  });

  it('lets the same key through again once the first row is decided and executed', async () => {
    const first = await pending('k3');
    await repo.decide(first.id, userId, 'approved');
    await repo.markExecuted(first.id, true, null, 12);
    const again = await pending('k3');
    expect(again.id).not.toBe(first.id);
  });

  it('records who decided and when, and keeps the arguments as given', async () => {
    const row = await pending('k4');
    const decided = await repo.decide(row.id, userId, 'approved');
    expect(decided?.decided_by).toBe(userId);
    expect(decided?.decided_at).not.toBeNull();
    expect(decided?.args).toEqual({ tab_id: 't1', text: 'npm test' });
  });

  it('never lets another user decide', async () => {
    const row = await pending('k5');
    expect(await repo.decide(row.id, newId(), 'approved')).toBeUndefined();
    expect((await repo.findOpenByKey(conversationId, 'k5'))?.status).toBe('pending');
  });

  it('expires rows older than the cutoff and leaves fresh ones alone', async () => {
    const old = await pending('k6');
    await db.$executeRawUnsafe(`update chat_actions set created_at = now() - interval '2 days' where id = $1`, old.id);
    const fresh = await pending('k7');
    expect(await repo.expireOlderThan(new Date(Date.now() - 24 * 60 * 60 * 1000))).toBe(1);
    expect((await repo.findOpenByKey(conversationId, 'k7'))?.id).toBe(fresh.id);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `DATABASE_URL=postgresql://termhub:termhub@172.17.0.3:5432/termhub_test TERMHUB_DB_TESTS=1 npm test -w @termhub/server -- src/db/repositories/chat-actions`
Expected: FAIL — `Cannot find module './chat-actions.js'`.

- [ ] **Step 3: Add the model and the token flag**

In `apps/server/prisma/schema.prisma`, add `gated Boolean @default(false)` to `model ApiToken` (with a doc comment: a token whose writes pass the chat's confirmation gate — the concierge's, never a person's own), add `actions ChatAction[]` to `model ChatConversation`, and append:

```prisma
/// One action the concierge proposed, and what became of it. `args` holds what it proposed — the
/// command, the prompt, the target — never a tool result's payload (spec §7.1). Also the chat's
/// action trail: step 1 rendered the trail from live events only, so it vanished on reload.
model ChatAction {
  id             String           @id
  conversationId String           @map("conversation_id")
  conversation   ChatConversation @relation(fields: [conversationId], references: [id], onDelete: Cascade)
  messageId      String?          @map("message_id")
  tool           String
  args           Json
  /// read | write | irreversible
  class          String
  /// pending | approved | denied | expired | executed | failed
  status         String
  idempotencyKey String?          @map("idempotency_key")
  machineId      String?          @map("machine_id")
  projectId      String?          @map("project_id")
  tabId          String?          @map("tab_id")
  errorCode      String?          @map("error_code")
  durationMs     Int?             @map("duration_ms")
  decidedBy      String?          @map("decided_by")
  decidedAt      DateTime?        @map("decided_at")
  createdAt      DateTime         @default(now()) @map("created_at")

  @@index([conversationId, createdAt])
  @@map("chat_actions")
}
```

- [ ] **Step 4: Write the migration**

`apps/server/prisma/migrations/20260921120000_chat_actions/migration.sql`: `ALTER TABLE "api_tokens" ADD COLUMN "gated" BOOLEAN NOT NULL DEFAULT false;`, the `chat_actions` table with the columns above, the FK with `ON DELETE CASCADE`, the `(conversation_id, created_at)` index, and — the one that carries the dedupe rule — a **partial** unique index:

```sql
-- One open row per proposed action: a model that retries, or two conversations proposing the same
-- thing, must not produce two questions. Partial, because a decided row must not block the action
-- from ever being proposed again. Prisma cannot express a partial index, so it lives only here.
CREATE UNIQUE INDEX "chat_actions_one_open_per_key" ON "chat_actions"("conversation_id", "idempotency_key")
    WHERE "status" IN ('pending', 'approved') AND "idempotency_key" IS NOT NULL;
```

Note for whoever runs it: `prisma migrate diff` cannot see partial indexes in either direction, so this index has no drift protection — the repository test above is its only guard. That is the same trade-off `chat_conversations_one_per_user` already makes.

- [ ] **Step 5: Write the repository**

`apps/server/src/db/repositories/chat-actions.ts`, following `chat.ts`: a class taking `private db: PrismaClient`, `newId()` for ids, a `mapAction` returning a snake_case view. `decide(id, userId, status)` must be an `updateMany` filtered by `id` **and** the owning conversation's `user_id` (join through `conversation`), returning `undefined` when it matched nothing — that is what makes "another user cannot decide" true in SQL rather than in a handler. `findOpenByKey` filters `status in ('pending','approved')`. `expireOlderThan(cutoff)` updates `pending` rows created before the cutoff to `expired` and returns the count.

- [ ] **Step 6: Register it and run the tests**

Add `chatActions: ChatActionsRepository` to `Repositories` and `createRepositories`, export the types, then:

```bash
DATABASE_URL=postgresql://termhub:termhub@172.17.0.3:5432/termhub_test npm run prisma:generate -w @termhub/server
cd apps/server && DATABASE_URL=postgresql://termhub:termhub@172.17.0.3:5432/termhub_test npx prisma migrate deploy && DATABASE_URL=postgresql://termhub:termhub@172.17.0.3:5432/termhub_test npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code && cd ..
DATABASE_URL=postgresql://termhub:termhub@172.17.0.3:5432/termhub_test TERMHUB_DB_TESTS=1 npm test -w @termhub/server -- src/db/repositories/chat-actions
```
Expected: 6 passing, drift clean.

- [ ] **Step 7: Commit**

```bash
git add apps/server/prisma apps/server/src/db/repositories
git commit -m "Chat: record proposed actions and mark which tokens are gated"
```

---

### Task 2: Bracketed paste, so a multi-line prompt arrives whole

**Files:**
- Modify: `packages/agent-protocol/src/rpc.ts` (`tmux.sendText` gains `paste?: boolean`), `apps/agent/src/rpc/tmux.ts`, `apps/agent/package.json` (version bump), `apps/server/src/terminal/session-ops.ts`, `apps/server/src/agent/errors.ts` or wherever `TERMINAL_RPC_MIN_AGENT_VERSION` lives
- Test: `apps/agent/src/rpc/tmux.test.ts`, `apps/agent/src/rpc/tmux.real.test.ts`, `apps/server/src/terminal/session-ops.test.ts`

**Interfaces:**
- Produces: `tmux.sendText` accepting `paste`, and `sendTextToSession(machine, session, text, enter, opts?: { paste?: boolean })`.
- Consumes: the existing RPC plumbing.

**Why this task exists:** `send-keys -l --` writes the bytes literally, so a CLI TUI sees the newline as Enter and submits half a prompt. Wrapping the text in `\e[200~` … `\e[201~` tells a TUI "this is a paste, not typing". The requester named this as the most likely bug of the whole feature, and they are right: without it a gated `send_input` is allowed to do the wrong thing correctly.

- [ ] **Step 1: Find out what the real CLI does, before writing code**

Two candidate mechanisms; pick by evidence, not by preference. In a real tmux session running `claude` (use the concierge account's config dir, on this host), try each and read the pane:

```bash
tmux -L probe new-session -d -s probe -c /tmp 'CLAUDE_CONFIG_DIR=$HOME/.claude_pedrogoiania claude'
# candidate A: escape bytes around the text
tmux -L probe send-keys -t '=probe:' -l -- $'\e[200~linha um\nlinha dois\e[201~'
tmux -L probe capture-pane -p -t '=probe:' | tail -5
# candidate B: tmux's own buffer paste, which brackets for you
printf 'linha um\nlinha dois' | tmux -L probe load-buffer - && tmux -L probe paste-buffer -p -t '=probe:'
tmux -L probe capture-pane -p -t '=probe:' | tail -5
tmux -L probe kill-server
```
Record in your report which one leaves both lines in the composer **unsubmitted**, and whether either leaves visible garbage. If both work, prefer B: `paste-buffer -p` is tmux's own bracketing and needs no escape literals in our code. If neither works, stop and report — the design assumption is wrong and I need to know before you build on it.

- [ ] **Step 2: Write the failing agent tests**

In `apps/agent/src/rpc/tmux.test.ts` (the mocked-exec suite), assert the exact argv for the chosen mechanism — for B: `load-buffer -` receiving the text on stdin, then `paste-buffer -p -d -t '=<session>:'`, and that `paste` false or absent still takes the old `send-keys -l --` path. In `apps/agent/src/rpc/tmux.real.test.ts`, add a case against real tmux that pastes two lines into a plain `sh` session and asserts both lines land in the pane.

- [ ] **Step 3: Implement it in the agent**

`apps/agent/src/rpc/tmux.ts`: when `params.paste` is true, use the mechanism chosen in step 1 and keep the existing Enter handling (the pause then `send-keys Enter`) unchanged — Enter must stay a separate keystroke, which is what makes "compose without submitting" possible. Widen the RPC's zod schema in `packages/agent-protocol/src/rpc.ts` with `paste: z.boolean().optional()`. `PROTOCOL_VERSION` stays 1: an optional field is additive.

- [ ] **Step 4: Decide the version floor, and say it out loud**

An older agent silently ignores the new field and would type a multi-line prompt as keystrokes — the exact bug. So bump `apps/agent` to 0.3.0, publish it, and raise the floor for the paste path only: a machine whose agent is older answers `AGENT_OUTDATED` with the existing update message when `paste` is requested, while plain typing keeps working on 0.2.x. Put the version in one constant next to `TERMINAL_RPC_MIN_AGENT_VERSION` and test both sides of the boundary.

- [ ] **Step 5: Use it from the server**

`sendTextToSession` takes `opts?: { paste?: boolean }`, passes it to the RPC for agent machines, and for local/ssh machines runs the equivalent tmux commands through `runOnMachine` with `shellQuote`. `sendInput` in `control/terminals.ts` requests `paste: true` whenever the text contains a newline — nothing else changes about its signature, so no caller breaks.

- [ ] **Step 6: Verify and commit**

`npm test -w @termhub/agent`, `npm test -w @termhub/agent-protocol`, `npm test -w @termhub/server -- src/terminal src/control`, the typechecks. Then:

```bash
git add packages/agent-protocol apps/agent apps/server/src/terminal apps/server/src/control
git commit -m "Terminal: paste multi-line text instead of typing it"
```

**Rollout note for the controller:** this one needs the agent published (`npm publish -w @termhub/agent`) and each machine updated before `send_input` can paste there. The app deploy alone does not carry it.

---

### Task 3: The gate's policy and its dedupe, as pure functions

**Files:**
- Create: `apps/server/src/chat/gate.ts`
- Test: `apps/server/src/chat/gate.test.ts`

**Interfaces:**
- Produces: `actionClass(tool: string, args: unknown): ActionClass` (`'read' | 'write' | 'irreversible'`), `idempotencyKeyFor(conversationId: string, tool: string, args: unknown): string`, `gateDecision(row: ChatAction | undefined, cls: ActionClass): 'allow' | 'ask' | 'refuse' | 'waiting'`.
- Consumes: `ChatAction` from Task 1.

- [ ] **Step 1: Write the failing test**

```ts
import { expect, it } from 'vitest';
import { actionClass, gateDecision, idempotencyKeyFor } from './gate.js';

it('classifies every tool the MCP exposes, and defaults an unknown one to irreversible', () => {
  expect(actionClass('list_machines', {})).toBe('read');
  expect(actionClass('read_screen', { tab_id: 't1' })).toBe('read');
  expect(actionClass('send_input', { tab_id: 't1', text: 'oi' })).toBe('write');
  expect(actionClass('start_agent', {})).toBe('write');
  expect(actionClass('close_tab', { tab_id: 't1' })).toBe('irreversible');
  expect(actionClass('delete_task', { task_id: 'k1' })).toBe('irreversible');
  // a tool added later must not silently become auto-allowed
  expect(actionClass('drop_everything', {})).toBe('irreversible');
});

it('treats an interrupting key as irreversible and an ordinary one as a write', () => {
  expect(actionClass('send_key', { tab_id: 't1', key: 'C-c' })).toBe('irreversible');
  expect(actionClass('send_key', { tab_id: 't1', key: 'Escape' })).toBe('irreversible');
  expect(actionClass('send_key', { tab_id: 't1', key: 'Enter' })).toBe('write');
});

it('keys on the arguments, so a different command is a different question', () => {
  const a = idempotencyKeyFor('c1', 'send_input', { tab_id: 't1', text: 'npm test' });
  expect(idempotencyKeyFor('c1', 'send_input', { text: 'npm test', tab_id: 't1' })).toBe(a); // key order cannot matter
  expect(idempotencyKeyFor('c1', 'send_input', { tab_id: 't1', text: 'rm -rf /' })).not.toBe(a);
  expect(idempotencyKeyFor('c2', 'send_input', { tab_id: 't1', text: 'npm test' })).not.toBe(a);
});

it('decides from the row: nothing asks, pending waits, approved allows, denied refuses', () => {
  expect(gateDecision(undefined, 'read')).toBe('allow');
  expect(gateDecision(undefined, 'write')).toBe('ask');
  expect(gateDecision(undefined, 'irreversible')).toBe('ask');
  expect(gateDecision({ status: 'pending' } as never, 'write')).toBe('waiting');
  expect(gateDecision({ status: 'approved' } as never, 'write')).toBe('allow');
  expect(gateDecision({ status: 'denied' } as never, 'write')).toBe('refuse');
  expect(gateDecision({ status: 'expired' } as never, 'write')).toBe('refuse');
});
```

- [ ] **Step 2: Run it, watch it fail, then implement**

`actionClass` reads a table keyed by tool name with `send_key` inspecting `args.key` against a closed list of interrupting keys; anything unknown is `irreversible` (a tool added later must never be born auto-allowed). `idempotencyKeyFor` is a sha256 over `conversationId`, the tool and the arguments **canonically serialised** (keys sorted recursively), so argument order cannot create a second question. `gateDecision` is the table in the test.

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/chat/gate.ts apps/server/src/chat/gate.test.ts
git commit -m "Chat: classify a proposed action and key it for dedupe"
```

---

### Task 4: The gate at the MCP boundary

**Files:**
- Modify: `apps/server/src/mcp/route.ts` (or the tool-dispatch seam it calls), `apps/server/src/chat/bus.ts` (a `confirmation` event)
- Create: `apps/server/src/chat/gate-runtime.ts`
- Test: `apps/server/src/mcp/gate.e2e.test.ts`

**Interfaces:**
- Produces: `applyGate(ctx, { token, tool, args, run })` — returns the tool's result when allowed, or a pt-BR `isError` result describing the pending/denied state, inserting and reading `chat_actions` as it goes.
- Consumes: Task 1's repository, Task 3's pure functions, `chatBus`.

- [ ] **Step 1: Write the failing test**

`apps/server/src/mcp/gate.e2e.test.ts`, in the shape of `terminals.e2e.test.ts` (a real Fastify app, `mcpRoutes`, a fake agent connection, `app.inject`), with the token's `gated` flag on:

```ts
it('asks instead of acting, and says so in a way the model can act on', async () => {
  const { app, actions } = build({ gated: true });
  const res = await callTool(app, 'send_input', { tab_id: 't1', text: 'npm test' });
  expect(res.json().result.isError).toBe(true);
  expect(res.json().result.content[0].text).toMatch(/pendente de confirmação/i);
  expect(actions.insertPending).toHaveBeenCalledTimes(1);
  expect(conn.rpc).not.toHaveBeenCalledWith('tmux.sendText', expect.anything(), undefined); // nothing was typed
});

it('does not ask twice for the same proposal', async () => { /* second identical call → "aguardando", one row */ });
it('executes once the row is approved, and marks it executed', async () => { /* approved row → tmux.sendText called, markExecuted(true) */ });
it('keeps refusing after a denial, without asking again', async () => { /* denied row → isError, no new row */ });
it('re-validates the tab before executing an approved action', async () => { /* tab killed meanwhile → isError naming it, row marked failed */ });
it('lets a person\'s own token through untouched', async () => { /* gated: false → typed immediately, no row */ });
it('never gates a read', async () => { /* read_screen on a gated token → answers normally, no row */ });
it('publishes the question to the chat, with the arguments and no terminal content', async () => { /* bus event keys asserted exactly */ });
```

- [ ] **Step 2: Implement**

`applyGate` runs inside the tool dispatch, after the scope check and before `run`:

1. `cls = actionClass(tool, args)`; `if (cls === 'read' || !token.gated) return run()`.
2. `conversation = await repos.chat.getOrCreateForUser(scope.user.id)` — in v1 a user has exactly one conversation, which is what lets a token-shaped call find the chat to ask in.
3. `key = idempotencyKeyFor(conversation.id, tool, args)`; `row = await repos.chatActions.findOpenByKey(conversation.id, key)`.
4. `switch (gateDecision(row, cls))`:
   - `allow` → `run()`, then `markExecuted(row.id, ok, errorCode, durationMs)`; a thrown error marks it `failed` and is rethrown so the model sees the real failure.
   - `waiting` → pt-BR `isError`: "ainda aguardando sua confirmação".
   - `refuse` → pt-BR `isError` naming the denial, so the model explains instead of retrying.
   - `ask` → `insertPending`, publish `{ type: 'confirmation', … }` on `chatBus`, return the pt-BR `isError` that tells the model to stop and wait.
5. Before executing an approved write, re-validate: the row carries `tab_id`; if the tab is gone, or its state moved to `waiting_permission` while the row waited, mark `failed` and return the pt-BR error instead of typing. This is Review Focus 4, and it is the difference between a stale approval and a keystroke into the wrong place.

`args` are stored as given. They are the user's own proposal to approve — never a tool result.

- [ ] **Step 3: Verify and commit**

`npm test -w @termhub/server -- src/mcp src/chat`, typecheck, then commit as `Chat: gate a gated token's writes on the user's confirmation`.

---

### Task 5: Answering, and the re-injection that resumes the run

**Files:**
- Modify: `apps/server/src/routes/chat.ts` (`POST /api/chat/actions/:id/decision`), `apps/server/src/chat/service.ts` (`resumeAfterDecision`)
- Test: `apps/server/src/routes/chat.test.ts`, `apps/server/src/chat/service.test.ts`

**Interfaces:**
- Produces: the decision route (`{ decision: 'approve' | 'deny' }`), and `ChatService.resumeAfterDecision(user, action)`.
- Consumes: Task 1's repository, the existing runner client.

- [ ] **Step 1: Write the failing tests**

Route: approving a row the user owns answers 200 and triggers a resume; approving another user's row answers 404; an unknown decision is 400; a row already decided answers 409. Service: `resumeAfterDecision` sends a short pt-BR line into the same session (`resume: true`) naming the approved action, and the run that follows behaves exactly like any other message (deltas, trail, stored answer). And Review Focus 2: when the conversation has **no** live session id, it starts a fresh session and says so in the chat instead of failing.

- [ ] **Step 2: Implement**

The route decides through the repository (which filters by owner in SQL), publishes the decision on the bus so every open tab updates, and then calls `resumeAfterDecision`, which reuses `send`'s machinery: the injected text is a fixed pt-BR sentence naming the tool and its target — never the model's own words, and never a tool result. The run that follows re-issues the tool call, and Task 4's `allow` branch executes it.

- [ ] **Step 3: Commit** as `Chat: answer a pending action and let the run continue`.

---

### Task 6: The chat shows the question, and the trail survives a reload

**Files:**
- Modify: `apps/web/src/pages/ChatPage.tsx`, `apps/web/src/lib/api.ts`, `apps/web/src/lib/types.ts`, `apps/web/src/lib/chat.tsx`, `apps/server/src/routes/chat.ts` (`GET /api/chat` returns `actions`)
- Test: `apps/web/src/pages/ChatPage.test.tsx`, `apps/server/src/routes/chat.test.ts`

- [ ] **Step 1: Write the failing tests**

A pending action renders its question with the tool, the target and the arguments, plus **Autorizar** and **Recusar**; clicking calls the decision endpoint and the buttons go away; a denied action reads as denied; the trail comes from `GET /api/chat` so it is still there after a reload (step 1's trail was live-events only and vanished); a `confirmation` event arriving on the socket adds the question without a refetch.

- [ ] **Step 2: Implement**, keeping every string pt-BR and never rendering a raw tool name where a person would rather read a sentence ("digitar `npm test` na aba Terminal 2 do projeto reactivando, no macbook m3").

- [ ] **Step 3: Commit** as `Chat: show a pending action and keep the trail across reloads`.

---

### Task 7: Give the concierge the write scopes, and expire what nobody answered

**Files:**
- Modify: `apps/server/src/chat/token.ts` (mint with `gated: true` and the wider scopes), `apps/server/src/chat/service.ts`, `apps/server/src/app.ts` (the hourly purge also expires pending actions), `README.md`
- Test: `apps/server/src/chat/token.test.ts`, `apps/server/src/app.test.ts` if one exists for the timer, else the repository's `expireOlderThan` test from Task 1 plus a unit test of the purge function

- [ ] **Step 1: Write the failing tests**

The minted concierge token carries `['read', 'tasks', 'terminals']` **and** `gated: true` — assert both, because the scopes without the flag is exactly the dangerous combination (a concierge that writes with no gate). A person's token created through Settings stays `gated: false`. The purge marks `pending` rows older than 24h `expired`.

- [ ] **Step 2: Implement and document**

Widen the mint call, set the flag, hook `expireOlderThan` into the hourly timer in `app.ts` next to `authService.purgeExpired()`, and update the README's chat section: what the gate does, what auto-allows, what always asks, and that a person's own MCP token is never gated.

- [ ] **Step 3: Full verification before the last commit**

```bash
DATABASE_URL=postgresql://termhub:termhub@172.17.0.3:5432/termhub_test TERMHUB_DB_TESTS=1 npm test -w @termhub/server
npm test -w @termhub/concierge && npm test -w @termhub/web && npm test -w @termhub/agent && npm test -w @termhub/agent-protocol
npm run typecheck -w @termhub/server && npm run build -w @termhub/web && npm run build -w @termhub/landing
```

- [ ] **Step 4: Commit** as `Chat: let the concierge write, behind the gate`.

**Rollout, in this order, because the order matters:** merge (the app deploys), then rebuild the concierge image (`bash ~/concierge.sh` — the blue/green deploy does not touch it), then publish the agent and update each machine (Task 2's paste needs agent 0.3.0 there). Until an agent is updated, `send_input` with a newline answers `AGENT_OUTDATED` on that machine — by design, and the message says what to do.
