# Chat concierge — step 1 (read-only chat) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One chat screen in the app where the user types a question and a headless Claude Code session on jarvis answers it using the termhub MCP with the `read` scope only — no writes, so no permission gate yet.

**Architecture:** A new workspace `@termhub/concierge` runs in its own container on jarvis with the Claude Code CLI and the account config dirs mounted; it spawns `claude -p --output-format stream-json` and streams the NDJSON frames back over HTTP. The server persists the conversation, mints a short-lived `read`-scope API token per run, parses the frames into messages plus an action trail, and fans them out to the browser over `/ws/chat`. The web client is one page.

**Tech Stack:** TypeScript (NodeNext), Fastify 5, Prisma 7 + Postgres, `ws`, zod, vitest, React 19 + Vite, Docker Compose.

**Spec:** `docs/superpowers/specs/2026-09-20-chat-concierge-design.md` (delivery step 1 of §11).

## Deferred from the spec, on purpose

These are spec requirements that step 1 does **not** implement, so nobody has to guess whether they
were forgotten: account selection by `concierge_rank` with the credit check and the reactive
fallback (§4.2 — step 1 always uses the primary config dir), the permission gate and pending
confirmations (§5), the vector memory and learning (§6), *modo revisão* and the per-conversation
model picker in the UI (§4.3, §6 — the columns exist, the screen does not expose them yet).

## Global Constraints

- Commit messages, PR titles/descriptions, code comments, identifiers and repo docs in **English**; **UI copy in pt-BR** (project language) — `CLAUDE.md`.
- Routes never import Prisma; go through `apps/server/src/db/repositories` — `CLAUDE.md`.
- Every request input validated with zod — `CLAUDE.md`.
- New route plugins are registered through `guarded(resource, plugin, prefix)` in `app.ts`, and new resources go in the `RESOURCES` catalog; never check role names in handlers — `CLAUDE.md`.
- Data is scoped by owner: load rows through `scoped(repos, request)` and pass `request.scope.ownerId` to list methods — `CLAUDE.md`.
- **Terminal content is never logged.** In this step that means: the concierge's own prose is stored, `read_screen` output is not, and no frame text goes to the logger — spec §7.1.
- Migrations must stay backward compatible with the previous release (blue/green runs both) — `CLAUDE.md`. All tables here are new, so this holds by construction.
- The runner never passes `--dangerously-skip-permissions`, always passes `--strict-mcp-config` and `--disallowed-tools Bash,Read,Write,Edit,WebFetch,WebSearch` — spec §4.1.
- Step 1's concierge token carries **only** the `read` scope — spec §11.
- Before pushing, run the Docker `node:20` typecheck/build from `CLAUDE.md` and `prisma migrate diff --exit-code`.

## Review Focus

Five things the spec implies that no task's happy path exercises; each one's test is added to the task that owns the code.

1. **Two messages in flight in one conversation** — the second must wait or be refused with a clear pt-BR message, never interleave two `claude -p` runs on the same `--session-id` (Task 5).
2. **The runner exits non-zero or dies mid-stream** — the assistant message must end as `error_code` with what is known so far kept, and the chat must say it did not finish instead of showing an empty bubble (Task 5).
3. **A frame arrives for a tool the token cannot call** (a write tool in a `read`-only step) — the tool result is an error; the trail must record it and the answer must still complete (Task 3 parses it, Task 5 records it).
4. **`--resume` on a session the account no longer has** (config dir wiped, account switched) — the run must fall back to a fresh session instead of failing the message (Task 5).
5. **The browser reconnects mid-answer** — `/ws/chat` carries no history, so the client must refetch messages on open and not lose the tail of an answer that arrived while it was away (Task 6 for the endpoint, Task 7 for the client).

---

### Task 1: Conversations and messages in the database

**Files:**
- Create: `apps/server/prisma/migrations/20260921090000_chat_conversations/migration.sql`
- Modify: `apps/server/prisma/schema.prisma` (append the two models; add `chatConversations ChatConversation[]` to `model User`)
- Create: `apps/server/src/db/repositories/chat.ts`
- Modify: `apps/server/src/db/repositories/index.ts` (register `chat`)
- Test: `apps/server/src/db/repositories/chat.db.test.ts`

**Interfaces:**
- Consumes: `newId()` from `apps/server/src/lib/ids.js`; `PrismaClient` from `../prisma.js`.
- Produces: `ChatConversation`, `ChatMessage`, `ChatRepository` with `getOrCreateForUser(userId)`, `setCliSession(id, sessionId)`, `addMessage(input)`, `updateMessage(id, patch)`, `listMessages(conversationId, limit?)`.

- [ ] **Step 1: Write the failing test**

`apps/server/src/db/repositories/chat.db.test.ts` (Postgres-gated, same shape as `tasks.db.test.ts`):

```ts
import { beforeAll, describe, expect, it } from 'vitest';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../generated/prisma/client.js';
import { newId } from '../../lib/ids.js';
import { ChatRepository } from './chat.js';

// Needs a migrated Postgres: TERMHUB_DB_TESTS=1 DATABASE_URL=… (CI sets both).
describe.skipIf(process.env.TERMHUB_DB_TESTS !== '1')('ChatRepository (Postgres)', () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
  const repo = new ChatRepository(db);
  let userId: string;

  beforeAll(async () => {
    userId = newId();
    // User.name is required and roleId is nullable; roles are seeded by the app, not by migrations.
    await db.user.create({ data: { id: userId, email: `${userId}@test.local`, name: 'test' } });
  });

  it('creates one conversation per user and returns the same one after that', async () => {
    const first = await repo.getOrCreateForUser(userId);
    const again = await repo.getOrCreateForUser(userId);
    expect(again.id).toBe(first.id);
    expect(first.cli_session_id).toBeNull();
    expect(first.review_mode).toBe(false);
  });

  it('stores the cli session id, appends messages in order and bumps last_message_at', async () => {
    const c = await repo.getOrCreateForUser(userId);
    await repo.setCliSession(c.id, '3f1e9b1e-0000-4000-8000-000000000001');

    const user = await repo.addMessage({ conversation_id: c.id, role: 'user', text: 'o que está rodando?' });
    const assistant = await repo.addMessage({ conversation_id: c.id, role: 'assistant', text: '' });
    await repo.updateMessage(assistant.id, { text: 'Nada rodando agora.', usage: { input_tokens: 10 } });

    const messages = await repo.listMessages(c.id);
    expect(messages.map((m) => [m.role, m.text])).toEqual([
      ['user', 'o que está rodando?'],
      ['assistant', 'Nada rodando agora.'],
    ]);
    expect(messages[1].usage).toEqual({ input_tokens: 10 });

    const reloaded = await repo.getOrCreateForUser(userId);
    expect(reloaded.cli_session_id).toBe('3f1e9b1e-0000-4000-8000-000000000001');
    expect(reloaded.last_message_at).not.toBeNull();
  });

  it('keeps an assistant failure as an error code without losing the text so far', async () => {
    const c = await repo.getOrCreateForUser(userId);
    const m = await repo.addMessage({ conversation_id: c.id, role: 'assistant', text: 'comecei a olhar' });
    const failed = await repo.updateMessage(m.id, { error_code: 'RUNNER_FAILED' });
    expect(failed.error_code).toBe('RUNNER_FAILED');
    expect(failed.text).toBe('comecei a olhar');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `DATABASE_URL=postgresql://termhub:termhub@172.17.0.3:5432/termhub_test TERMHUB_DB_TESTS=1 npm test -w @termhub/server -- src/db/repositories/chat.db`
Expected: FAIL — `Cannot find module './chat.js'`.

- [ ] **Step 3: Add the Prisma models**

Append to `apps/server/prisma/schema.prisma`, and add `chatConversations ChatConversation[]` to `model User`:

```prisma
/// One chat with the concierge. v1 keeps a single conversation per user; machineId/tabId stay
/// nullable so per-machine and per-tab chats can arrive without a migration (spec §7).
model ChatConversation {
  id            String        @id
  userId        String        @map("user_id")
  user          User          @relation(fields: [userId], references: [id], onDelete: Cascade)
  title         String?
  /// uuid passed to claude -p as --session-id / --resume
  cliSessionId  String?       @map("cli_session_id")
  model         String?
  machineId     String?       @map("machine_id")
  tabId         String?       @map("tab_id")
  reviewMode    Boolean       @default(false) @map("review_mode")
  lastMessageAt DateTime?     @map("last_message_at")
  createdAt     DateTime      @default(now()) @map("created_at")
  messages      ChatMessage[]

  @@index([userId, createdAt])
  @@map("chat_conversations")
}

/// A turn of the conversation. The assistant's own prose is stored in full; captured screens and
/// command output never are (spec §7.1).
model ChatMessage {
  id             String           @id
  conversationId String           @map("conversation_id")
  conversation   ChatConversation @relation(fields: [conversationId], references: [id], onDelete: Cascade)
  /// user | assistant
  role           String
  text           String
  usage          Json?
  errorCode      String?          @map("error_code")
  createdAt      DateTime         @default(now()) @map("created_at")

  @@index([conversationId, createdAt])
  @@map("chat_messages")
}
```

- [ ] **Step 4: Write the migration SQL**

`apps/server/prisma/migrations/20260921090000_chat_conversations/migration.sql`:

```sql
-- CreateTable
CREATE TABLE "chat_conversations" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "title" TEXT,
    "cli_session_id" TEXT,
    "model" TEXT,
    "machine_id" TEXT,
    "tab_id" TEXT,
    "review_mode" BOOLEAN NOT NULL DEFAULT false,
    "last_message_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_messages" (
    "id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "usage" JSONB,
    "error_code" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "chat_conversations_user_id_created_at_idx" ON "chat_conversations"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "chat_messages_conversation_id_created_at_idx" ON "chat_messages"("conversation_id", "created_at");

-- AddForeignKey
ALTER TABLE "chat_conversations" ADD CONSTRAINT "chat_conversations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "chat_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Default grants for the new resource (admins bypass the matrix) ─────────────
INSERT INTO "permissions" ("id", "resource", "action", "role_id")
SELECT 'perm_' || r.prefix || '_chat_' || a, 'chat', a, r.role_id
FROM (VALUES ('auth', 'role_authenticated'), ('mgr', 'role_manager')) AS r(prefix, role_id),
     unnest(ARRAY['create','read','update','delete']) AS a
WHERE EXISTS (SELECT 1 FROM "roles" WHERE "id" = r.role_id)
ON CONFLICT DO NOTHING;
```

- [ ] **Step 5: Write the repository**

`apps/server/src/db/repositories/chat.ts`:

```ts
import type { PrismaClient } from '../prisma.js';
import type { ChatConversation as PrismaConversation, ChatMessage as PrismaMessage } from '../../generated/prisma/client.js';
import { newId } from '../../lib/ids.js';

export type ChatRole = 'user' | 'assistant';

export interface ChatConversation {
  id: string;
  user_id: string;
  title: string | null;
  cli_session_id: string | null;
  model: string | null;
  review_mode: boolean;
  last_message_at: string | null;
  created_at: string;
}

export interface ChatMessage {
  id: string;
  conversation_id: string;
  role: ChatRole;
  text: string;
  usage: unknown | null;
  error_code: string | null;
  created_at: string;
}

const mapConversation = (c: PrismaConversation): ChatConversation => ({
  id: c.id,
  user_id: c.userId,
  title: c.title,
  cli_session_id: c.cliSessionId,
  model: c.model,
  review_mode: c.reviewMode,
  last_message_at: c.lastMessageAt?.toISOString() ?? null,
  created_at: c.createdAt.toISOString(),
});

const mapMessage = (m: PrismaMessage): ChatMessage => ({
  id: m.id,
  conversation_id: m.conversationId,
  role: m.role as ChatRole,
  text: m.text,
  usage: m.usage ?? null,
  error_code: m.errorCode,
  created_at: m.createdAt.toISOString(),
});

export class ChatRepository {
  constructor(private db: PrismaClient) {}

  /** v1 keeps one conversation per user; the oldest one wins if several ever exist. */
  async getOrCreateForUser(userId: string): Promise<ChatConversation> {
    const existing = await this.db.chatConversation.findFirst({ where: { userId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    if (existing) return mapConversation(existing);
    const created = await this.db.chatConversation.create({ data: { id: newId(), userId } });
    return mapConversation(created);
  }

  async setCliSession(id: string, sessionId: string | null): Promise<void> {
    await this.db.chatConversation.update({ where: { id }, data: { cliSessionId: sessionId } });
  }

  async addMessage(input: { conversation_id: string; role: ChatRole; text: string; usage?: unknown; error_code?: string | null }): Promise<ChatMessage> {
    const [message] = await this.db.$transaction([
      this.db.chatMessage.create({
        data: {
          id: newId(),
          conversationId: input.conversation_id,
          role: input.role,
          text: input.text,
          usage: (input.usage ?? null) as never,
          errorCode: input.error_code ?? null,
        },
      }),
      this.db.chatConversation.update({ where: { id: input.conversation_id }, data: { lastMessageAt: new Date() } }),
    ]);
    return mapMessage(message);
  }

  async updateMessage(id: string, patch: { text?: string; usage?: unknown; error_code?: string | null }): Promise<ChatMessage> {
    const row = await this.db.chatMessage.update({
      where: { id },
      data: {
        ...(patch.text === undefined ? {} : { text: patch.text }),
        ...(patch.usage === undefined ? {} : { usage: patch.usage as never }),
        ...(patch.error_code === undefined ? {} : { errorCode: patch.error_code }),
      },
    });
    return mapMessage(row);
  }

  async listMessages(conversationId: string, limit = 200): Promise<ChatMessage[]> {
    const rows = await this.db.chatMessage.findMany({ where: { conversationId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: limit });
    return rows.map(mapMessage);
  }
}
```

Register it in `apps/server/src/db/repositories/index.ts`: import `ChatRepository`, add `chat: ChatRepository` to the interface, `chat: new ChatRepository(db)` to `createRepositories`, and `export type { ChatConversation, ChatMessage, ChatRole } from './chat.js';`.

- [ ] **Step 6: Generate the client and run the test**

```bash
DATABASE_URL=postgresql://termhub:termhub@172.17.0.3:5432/termhub_test npm run prisma:generate -w @termhub/server
DATABASE_URL=postgresql://termhub:termhub@172.17.0.3:5432/termhub_test npx prisma migrate deploy --schema apps/server/prisma/schema.prisma
DATABASE_URL=postgresql://termhub:termhub@172.17.0.3:5432/termhub_test TERMHUB_DB_TESTS=1 npm test -w @termhub/server -- src/db/repositories/chat.db
```
Expected: PASS (3 tests).

- [ ] **Step 7: Verify there is no schema drift**

Run, from `apps/server` (the same check CI runs in `.github/workflows/deploy.yml`; the
`--from-migrations` / `--to-schema-datamodel` flags do not exist in Prisma 7.10):

```bash
cd apps/server
DATABASE_URL=postgresql://termhub:termhub@172.17.0.3:5432/termhub_test npx prisma migrate deploy
DATABASE_URL=postgresql://termhub:termhub@172.17.0.3:5432/termhub_test npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code
```
Expected: exit code 0, "No difference detected".

- [ ] **Step 8: Commit**

```bash
git add apps/server/prisma/schema.prisma apps/server/prisma/migrations/20260921090000_chat_conversations apps/server/src/db/repositories/chat.ts apps/server/src/db/repositories/chat.db.test.ts apps/server/src/db/repositories/index.ts
git commit -m "Chat: conversations and messages tables with their repository"
```

---

### Task 2: The concierge runner (workspace, container, compose)

**Files:**
- Create: `apps/concierge/package.json`, `apps/concierge/tsconfig.json`, `apps/concierge/src/run.ts`, `apps/concierge/src/index.ts`
- Create: `docker/concierge/Dockerfile`
- Modify: `package.json` (workspaces), `docker-compose.yml` (service `concierge`), `.env.example`, `.github/workflows/deploy.yml`, `README.md`
- Test: `apps/concierge/src/run.test.ts`

**Interfaces:**
- Produces: `buildArgs(req: RunRequest): string[]`, `runClaude(req: RunRequest, opts): AsyncIterable<string>`, and the HTTP contract `POST /run` (header `x-concierge-secret`, JSON body `RunRequest`, NDJSON response). `RunRequest = { session_id: string; resume: boolean; text: string; config_dir: string; model?: string | null; token: string; mcp_url: string }`.
- Consumes: nothing from other tasks.

- [ ] **Step 1: Write the failing test**

`apps/concierge/src/run.test.ts` — the argv is asserted exactly, and the streaming is proved against a **fake `claude`** script that records its argv and stdin, the same trick used by `apps/server/src/mcp/start-agent.e2e.test.ts`:

```ts
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { buildArgs, runClaude } from './run.js';

const req = {
  session_id: '3f1e9b1e-0000-4000-8000-000000000001',
  resume: false,
  text: 'o que está rodando?',
  config_dir: '/home/u/.claude_pedrogoiania',
  model: null,
  token: 'thb_pat_' + 'A'.repeat(43),
  mcp_url: 'https://termhub.dev/mcp',
};

it('builds the exact argv the spec fixes, with no permission bypass', () => {
  expect(buildArgs({ ...req, mcp_config_path: '/tmp/mcp.json' })).toEqual([
    '-p',
    '--session-id', req.session_id,
    '--output-format', 'stream-json',
    '--include-partial-messages',
    '--mcp-config', '/tmp/mcp.json',
    '--strict-mcp-config',
    '--allowed-tools', 'mcp__termhub__*',
    '--disallowed-tools', 'Bash,Read,Write,Edit,WebFetch,WebSearch',
  ]);
});

it('resumes the session and passes the model when asked', () => {
  const args = buildArgs({ ...req, resume: true, model: 'sonnet', mcp_config_path: '/tmp/mcp.json' });
  expect(args.slice(0, 6)).toEqual(['-p', '--session-id', req.session_id, '--resume', req.session_id, '--output-format']);
  expect(args.slice(-2)).toEqual(['--model', 'sonnet']);
});

it('never passes a permission bypass, whatever the input', () => {
  expect(buildArgs({ ...req, mcp_config_path: '/tmp/mcp.json' }).join(' ')).not.toContain('dangerously');
});

// --- streaming, against a fake CLI: no login, no network, runs in CI ---
let bin: string;
beforeAll(() => {
  bin = mkdtempSync(join(tmpdir(), 'concierge-'));
  const fake = join(bin, 'claude');
  writeFileSync(
    fake,
    `#!/bin/sh
printf '%s\\n' "$@" > ${bin}/argv
cat > ${bin}/stdin
echo '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"oi"}}}'
echo '{"type":"result","session_id":"'"$2"'","usage":{"input_tokens":7}}'
`,
  );
  chmodSync(fake, 0o755);
  mkdirSync(join(bin, 'cfg'));
});
afterAll(() => rmSync(bin, { recursive: true, force: true }));

it('streams the CLI frames as lines and feeds the prompt over stdin', async () => {
  const lines: string[] = [];
  for await (const line of runClaude({ ...req, config_dir: join(bin, 'cfg') }, { cliPath: join(bin, 'claude'), tmpDir: bin })) lines.push(line);

  expect(lines).toHaveLength(2);
  expect(JSON.parse(lines[0]).event.delta.text).toBe('oi');
  expect(JSON.parse(lines[1]).type).toBe('result');
  // the prompt travels on stdin, so a prompt starting with "-" can never be read as a flag
  expect(readFileSync(join(bin, 'stdin'), 'utf8')).toBe('o que está rodando?');
  expect(readFileSync(join(bin, 'argv'), 'utf8')).toContain('--strict-mcp-config');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w @termhub/concierge -- src/run`
Expected: FAIL — the workspace does not exist yet (`npm error No workspaces found`).

- [ ] **Step 3: Create the workspace**

`apps/concierge/package.json`:

```json
{
  "name": "@termhub/concierge",
  "version": "0.1.0",
  "license": "MIT",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "test": "vitest run",
    "dev": "tsx src/index.ts"
  },
  "dependencies": {
    "zod": "^3.24.1"
  },
  "devDependencies": {
    "@types/node": "^22.10.5",
    "tsx": "^4.19.2",
    "typescript": "^5.7.3",
    "vitest": "^3.2.7"
  },
  "engines": {
    "node": ">=20"
  }
}
```

`apps/concierge/tsconfig.json`: copy `apps/agent/tsconfig.json` verbatim.

Add `"apps/concierge"` to `workspaces` in the root `package.json`, then run `npm install` once so the workspace is linked.

- [ ] **Step 4: Write the runner**

`apps/concierge/src/run.ts`:

```ts
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface RunRequest {
  session_id: string;
  resume: boolean;
  text: string;
  config_dir: string;
  model?: string | null;
  /** short-lived termhub API token, read scope in step 1 */
  token: string;
  mcp_url: string;
}

/** Tools the concierge must never have: with any of them it could reach a machine outside the MCP,
 * where the permission gate lives (spec §4.1). */
const DISALLOWED = 'Bash,Read,Write,Edit,WebFetch,WebSearch';

export function buildArgs(req: RunRequest & { mcp_config_path: string }): string[] {
  return [
    '-p',
    '--session-id', req.session_id,
    ...(req.resume ? ['--resume', req.session_id] : []),
    '--output-format', 'stream-json',
    '--include-partial-messages',
    '--mcp-config', req.mcp_config_path,
    '--strict-mcp-config',
    '--allowed-tools', 'mcp__termhub__*',
    '--disallowed-tools', DISALLOWED,
    ...(req.model ? ['--model', req.model] : []),
  ];
}

/** The MCP config the CLI loads: one HTTP server, the token in the header. Written per run into a
 * private temp dir, never logged. */
function writeMcpConfig(dir: string, req: RunRequest): string {
  const path = join(dir, 'termhub-mcp.json');
  writeFileSync(path, JSON.stringify({ mcpServers: { termhub: { type: 'http', url: req.mcp_url, headers: { Authorization: `Bearer ${req.token}` } } } }), { mode: 0o600 });
  return path;
}

export class RunFailed extends Error {
  constructor(readonly code: number | null, readonly stderr: string) {
    super(`claude exited with ${code ?? 'signal'}`);
  }
}

/** Spawns the CLI and yields its stdout line by line. The prompt goes in on stdin, so it is never
 * argv and a prompt starting with "-" cannot be read as a flag. */
export async function* runClaude(req: RunRequest, opts: { cliPath?: string; tmpDir?: string; timeoutMs?: number } = {}): AsyncIterable<string> {
  const dir = mkdtempSync(join(opts.tmpDir ?? tmpdir(), 'run-'));
  const args = buildArgs({ ...req, mcp_config_path: writeMcpConfig(dir, req) });
  const child = spawn(opts.cliPath ?? 'claude', args, {
    env: { ...process.env, CLAUDE_CONFIG_DIR: req.config_dir },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const timer = setTimeout(() => child.kill('SIGTERM'), opts.timeoutMs ?? 10 * 60 * 1000);
  let stderr = '';
  child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
  child.stdin.end(req.text);

  let buffer = '';
  try {
    for await (const chunk of child.stdout) {
      buffer += (chunk as Buffer).toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) if (line.trim()) yield line;
    }
    if (buffer.trim()) yield buffer;
    const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
    if (code !== 0) throw new RunFailed(code, stderr.slice(-2000));
  } finally {
    clearTimeout(timer);
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -w @termhub/concierge -- src/run`
Expected: PASS (4 tests).

- [ ] **Step 6: Write the HTTP service**

`apps/concierge/src/index.ts`:

```ts
import { createServer } from 'node:http';
import { z } from 'zod';
import { RunFailed, runClaude } from './run.js';

const SECRET = process.env.CONCIERGE_SECRET ?? '';
const PORT = Number(process.env.PORT ?? 4100);

const body = z.object({
  session_id: z.string().uuid(),
  resume: z.boolean(),
  text: z.string().min(1).max(8000),
  config_dir: z.string().min(1),
  model: z.string().max(60).nullish(),
  token: z.string().min(1),
  mcp_url: z.string().url(),
});

const server = createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') return res.writeHead(200).end('ok');
  if (req.method !== 'POST' || req.url !== '/run') return res.writeHead(404).end();
  // The compose network is not authentication: the shared secret is (spec §7.2).
  if (!SECRET || req.headers['x-concierge-secret'] !== SECRET) return res.writeHead(401).end();

  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const parsed = body.safeParse(JSON.parse(Buffer.concat(chunks).toString() || '{}'));
  if (!parsed.success) return res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'invalid body' }));

  res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' });
  try {
    for await (const line of runClaude(parsed.data)) res.write(line + '\n');
    res.end();
  } catch (e) {
    // The frames already sent stay valid; the last line says why it stopped. Never log the body.
    const code = e instanceof RunFailed ? e.code : null;
    res.write(JSON.stringify({ type: 'termhub_error', code, message: e instanceof Error ? e.message : 'unknown' }) + '\n');
    res.end();
  }
});

server.listen(PORT, () => console.log(`concierge listening on ${PORT}`));
```

- [ ] **Step 7: Write the Dockerfile**

`docker/concierge/Dockerfile`:

```dockerfile
# Runs the Claude Code CLI headless for the chat concierge (spec §4). The account config dirs are
# mounted at runtime; the image holds no credential.
FROM node:22-slim
WORKDIR /srv
ENV NODE_ENV=production
RUN npm install -g @anthropic-ai/claude-code && apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY apps/concierge/dist ./dist
COPY apps/concierge/package.json ./
RUN npm install --omit=dev
EXPOSE 4100
HEALTHCHECK --interval=15s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4100/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
```

- [ ] **Step 8: Wire compose and the environment**

Add to `docker-compose.yml`, next to `whisper`:

```yaml
  # ── Headless Claude Code for the chat concierge (docker/concierge) ────────────
  # Mounts the account config dirs read-write (the CLI refreshes its own token) and holds no
  # credential in the image. Not rebuilt by a blue/green deploy, so a conversation survives one.
  concierge:
    profiles: ["dev", "prod"]
    build:
      context: .
      dockerfile: docker/concierge/Dockerfile
    image: termhub-concierge
    restart: unless-stopped
    environment:
      CONCIERGE_SECRET: ${CONCIERGE_SECRET:?set CONCIERGE_SECRET in .env}
      PORT: 4100
    volumes:
      - ${CONCIERGE_PRIMARY_CONFIG_DIR:-/home/pedrogoiania/.claude_pedrogoiania}:/accounts/primary
      - ${CONCIERGE_SECONDARY_CONFIG_DIR:-/home/pedrogoiania/.claude}:/accounts/secondary
```

Add to `.env.example`, with comments in English:

```
# Chat concierge (docker/concierge): shared secret between the app and the runner, and the host
# paths of the Claude accounts it may use. Generate the secret with: openssl rand -base64 32
CONCIERGE_SECRET=
CONCIERGE_URL=http://concierge:4100
CONCIERGE_PRIMARY_CONFIG_DIR=/home/pedrogoiania/.claude_pedrogoiania
CONCIERGE_SECONDARY_CONFIG_DIR=/home/pedrogoiania/.claude
```

In `apps/server/src/config.ts`, add to the zod schema `CONCIERGE_URL: z.string().url().optional()` and `CONCIERGE_SECRET: z.string().optional()`, and expose `concierge: env.CONCIERGE_URL && env.CONCIERGE_SECRET ? { url: env.CONCIERGE_URL, secret: env.CONCIERGE_SECRET } : undefined` next to `transcription`. Unset means the chat answers 503, the same shape the mic already uses.

In `.github/workflows/deploy.yml`, after the agent steps, add:

```yaml
      - name: Testes concierge
        run: npm test -w @termhub/concierge
      - name: Typecheck + build concierge
        run: npm run typecheck -w @termhub/concierge && npm run build -w @termhub/concierge
```

- [ ] **Step 9: Document it**

In `README.md`, after the "Global terminal (MCP)" section, add a "Chat concierge" subsection: what the container is, that it holds no credential, the two mounted config dirs, `CONCIERGE_SECRET`, and that the chat answers 503 when the service is not configured.

- [ ] **Step 10: Verify the build and commit**

```bash
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/w" -w /w node:20 \
  sh -c 'npm run typecheck -w @termhub/concierge && npm run build -w @termhub/concierge && npm test -w @termhub/concierge'
rm -rf .npm
git add apps/concierge docker/concierge package.json package-lock.json docker-compose.yml .env.example .github/workflows/deploy.yml README.md apps/server/src/config.ts
git commit -m "Concierge: headless Claude Code runner in its own container"
```

---

### Task 3: Parse the stream-json frames

**Files:**
- Create: `apps/server/src/chat/stream.ts`
- Create: `apps/server/src/chat/fixtures/stream-basic.ndjson` (recorded, see step 1)
- Test: `apps/server/src/chat/stream.test.ts`

**Interfaces:**
- Produces: `ChatFrame` union and `parseFrame(line: string): ChatFrame | null`.
- Consumes: nothing.

- [ ] **Step 1: Record a real fixture first**

Do not guess the CLI's frame shape. On jarvis, with the concierge account:

```bash
CLAUDE_CONFIG_DIR=$HOME/.claude_pedrogoiania claude -p --output-format stream-json --include-partial-messages \
  --disallowed-tools Bash,Read,Write,Edit,WebFetch,WebSearch <<< 'diga apenas: oi' \
  > apps/server/src/chat/fixtures/stream-basic.ndjson
```

Read the file and write the parser against the frames it actually contains. If a field below does not match the recording, **the recording wins** — fix the parser and the test, not the fixture.

- [ ] **Step 2: Write the failing test**

`apps/server/src/chat/stream.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { parseFrame } from './stream.js';

const fixture = readFileSync(join(import.meta.dirname, 'fixtures/stream-basic.ndjson'), 'utf8').split('\n').filter(Boolean);

it('turns a recorded run into text deltas and a final usage', () => {
  const frames = fixture.map(parseFrame).filter((f) => f !== null);
  expect(frames.some((f) => f!.type === 'text')).toBe(true);
  expect(frames.at(-1)!.type).toBe('done');
});

it('reads a tool call and its result', () => {
  const call = parseFrame(JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: 'tu_1', name: 'mcp__termhub__list_tabs', input: { project_id: 'p1' } }] },
  }));
  expect(call).toEqual({ type: 'action', tool: 'list_tabs', tool_use_id: 'tu_1', args: { project_id: 'p1' } });

  const result = parseFrame(JSON.stringify({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1', is_error: true, content: [{ type: 'text', text: 'Este token não tem o escopo `terminals`' }] }] },
  }));
  expect(result).toEqual({ type: 'action_result', tool_use_id: 'tu_1', ok: false });
});

it('reports the runner error line the container appends', () => {
  expect(parseFrame(JSON.stringify({ type: 'termhub_error', code: 1, message: 'claude exited with 1' }))).toEqual({ type: 'error', message: 'claude exited with 1' });
});

it('ignores a malformed line instead of throwing', () => {
  expect(parseFrame('not json')).toBeNull();
  expect(parseFrame(JSON.stringify({ type: 'something_new' }))).toBeNull();
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test -w @termhub/server -- src/chat/stream`
Expected: FAIL — `Cannot find module './stream.js'`.

- [ ] **Step 4: Write the parser**

`apps/server/src/chat/stream.ts`:

```ts
/** What the chat cares about in one `stream-json` line. Everything else is ignored on purpose:
 * the CLI's frame set grows, and an unknown frame must never break a conversation. */
export type ChatFrame =
  | { type: 'text'; delta: string }
  | { type: 'action'; tool: string; tool_use_id: string; args: unknown }
  | { type: 'action_result'; tool_use_id: string; ok: boolean }
  | { type: 'done'; session_id?: string; usage?: unknown }
  | { type: 'error'; message: string };

/** `mcp__termhub__list_tabs` -> `list_tabs`; anything else is kept as it came. */
const toolName = (raw: string) => (raw.startsWith('mcp__termhub__') ? raw.slice('mcp__termhub__'.length) : raw);

export function parseFrame(line: string): ChatFrame | null {
  let f: Record<string, unknown>;
  try {
    f = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  const type = f.type;

  if (type === 'stream_event') {
    const event = f.event as { type?: string; delta?: { type?: string; text?: string } } | undefined;
    if (event?.type === 'content_block_delta' && event.delta?.type === 'text_delta' && event.delta.text) return { type: 'text', delta: event.delta.text };
    return null;
  }
  if (type === 'assistant') {
    const content = (f.message as { content?: unknown[] } | undefined)?.content ?? [];
    for (const block of content as { type?: string; id?: string; name?: string; input?: unknown }[]) {
      if (block.type === 'tool_use' && block.id && block.name) return { type: 'action', tool: toolName(block.name), tool_use_id: block.id, args: block.input ?? {} };
    }
    return null;
  }
  if (type === 'user') {
    const content = (f.message as { content?: unknown[] } | undefined)?.content ?? [];
    for (const block of content as { type?: string; tool_use_id?: string; is_error?: boolean }[]) {
      if (block.type === 'tool_result' && block.tool_use_id) return { type: 'action_result', tool_use_id: block.tool_use_id, ok: block.is_error !== true };
    }
    return null;
  }
  if (type === 'result') return { type: 'done', session_id: typeof f.session_id === 'string' ? f.session_id : undefined, usage: f.usage };
  if (type === 'termhub_error') return { type: 'error', message: String(f.message ?? 'runner failed') };
  return null;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -w @termhub/server -- src/chat/stream`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/chat/stream.ts apps/server/src/chat/stream.test.ts apps/server/src/chat/fixtures
git commit -m "Chat: parse the CLI's stream-json frames into chat events"
```

---

### Task 4: Mint the concierge's short-lived token

**Files:**
- Create: `apps/server/src/chat/token.ts`
- Test: `apps/server/src/chat/token.test.ts`

**Interfaces:**
- Consumes: `repos.apiTokens.listByUser / create / revoke`, `newApiToken()` and `ApiTokenScope` from `apps/server/src/auth/api-tokens.js`.
- Produces: `CONCIERGE_TOKEN_NAME`, `mintConciergeToken(repos, userId, scopes): Promise<string>` (returns the plain token, which is never stored anywhere).

- [ ] **Step 1: Write the failing test**

`apps/server/src/chat/token.test.ts`:

```ts
import { expect, it, vi } from 'vitest';
import type { Repositories } from '../db/repositories/index.js';
import { API_TOKEN_RE } from '../auth/api-tokens.js';
import { CONCIERGE_TOKEN_NAME, mintConciergeToken } from './token.js';

function repos(existing: { id: string; name: string; revoked_at: string | null }[] = []) {
  const apiTokens = {
    listByUser: vi.fn(async () => existing),
    create: vi.fn(async (userId: string, input: unknown, hash: string) => ({ id: 'tok_new', userId, input, hash })),
    revoke: vi.fn(async () => undefined),
  };
  return { apiTokens } as unknown as Repositories & { apiTokens: typeof apiTokens };
}

it('creates a token that looks like an API token and never returns the hash', async () => {
  const r = repos();
  const token = await mintConciergeToken(r, 'u1', ['read']);
  expect(token).toMatch(API_TOKEN_RE);
  const [, input, hash] = r.apiTokens.create.mock.calls[0];
  expect(input).toMatchObject({ name: CONCIERGE_TOKEN_NAME, scopes: ['read'] });
  expect((input as { expiresAt: Date }).expiresAt.getTime()).toBeGreaterThan(Date.now());
  expect(hash).not.toContain(token);
});

it('revokes the previous concierge token and leaves the user other tokens alone', async () => {
  const r = repos([
    { id: 'tok_old', name: CONCIERGE_TOKEN_NAME, revoked_at: null },
    { id: 'tok_mine', name: 'meu notebook', revoked_at: null },
    { id: 'tok_dead', name: CONCIERGE_TOKEN_NAME, revoked_at: '2026-09-01T00:00:00.000Z' },
  ]);
  await mintConciergeToken(r, 'u1', ['read']);
  expect(r.apiTokens.revoke.mock.calls).toEqual([['tok_old', 'u1']]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w @termhub/server -- src/chat/token`
Expected: FAIL — `Cannot find module './token.js'`.

- [ ] **Step 3: Write the implementation**

`apps/server/src/chat/token.ts`:

```ts
import { newApiToken, type ApiTokenScope } from '../auth/api-tokens.js';
import type { Repositories } from '../db/repositories/index.js';

/** Name of the token the server mints for the concierge. It is rotated on every run, so a leaked
 * one is useless within a day and the audit trail in api_token_events stays per-run. */
export const CONCIERGE_TOKEN_NAME = 'concierge (automático)';
const TTL_MS = 24 * 60 * 60 * 1000;

/** Mints a fresh token for the concierge and revokes the previous one. The plain token is returned
 * to the caller and stored nowhere — the runner receives it per request. */
export async function mintConciergeToken(repos: Repositories, userId: string, scopes: ApiTokenScope[]): Promise<string> {
  const previous = (await repos.apiTokens.listByUser(userId)).filter((t) => t.name === CONCIERGE_TOKEN_NAME && t.revoked_at === null);
  for (const t of previous) await repos.apiTokens.revoke(t.id, userId);

  const { token, hash } = newApiToken();
  await repos.apiTokens.create(userId, { name: CONCIERGE_TOKEN_NAME, scopes, expiresAt: new Date(Date.now() + TTL_MS) }, hash);
  return token;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -w @termhub/server -- src/chat/token`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/chat/token.ts apps/server/src/chat/token.test.ts
git commit -m "Chat: mint and rotate a short-lived token for the concierge"
```

---

### Task 5: The chat service (one message, end to end)

**Files:**
- Create: `apps/server/src/chat/service.ts`
- Create: `apps/server/src/chat/runner.ts` (HTTP client for the container)
- Test: `apps/server/src/chat/service.test.ts`

**Interfaces:**
- Consumes: `ChatRepository` (Task 1), `parseFrame` (Task 3), `mintConciergeToken` (Task 4), `config.concierge`.
- Produces:
  - `RunnerClient` = `{ run(input: RunnerInput): AsyncIterable<string> }` with `RunnerInput = { session_id: string; resume: boolean; text: string; config_dir: string; model?: string | null; token: string }`.
  - `httpRunner(): RunnerClient` (reads `config.concierge`).
  - `ChatService` with `send(user: User, text: string): Promise<ChatMessage>` (the assistant row, already complete) and `conversationFor(user)`.
  - `chatBus` events are published here (Task 6 owns the bus module).

- [ ] **Step 1: Write the failing test**

`apps/server/src/chat/service.test.ts` — a fake runner returns recorded lines, so no CLI and no container:

```ts
import { beforeEach, expect, it, vi } from 'vitest';
import type { Repositories } from '../db/repositories/index.js';
import type { User } from '../db/repositories/types.js';
import { ChatService, type RunnerClient } from './service.js';

const user = { id: 'u1', email: 'p@test', role_id: 'role_authenticated' } as unknown as User;

function build(lines: string[] | (() => AsyncIterable<string>)) {
  const conversation = { id: 'c1', user_id: 'u1', title: null, cli_session_id: null, model: null, review_mode: false, last_message_at: null, created_at: '' };
  const messages: { id: string; role: string; text: string; error_code: string | null }[] = [];
  const chat = {
    getOrCreateForUser: vi.fn(async () => conversation),
    setCliSession: vi.fn(async (_id: string, s: string | null) => void (conversation.cli_session_id = s)),
    addMessage: vi.fn(async (m: { role: string; text: string }) => {
      const row = { id: `m${messages.length + 1}`, role: m.role, text: m.text, error_code: null };
      messages.push(row);
      return row;
    }),
    updateMessage: vi.fn(async (id: string, patch: { text?: string; error_code?: string | null }) => {
      const row = messages.find((m) => m.id === id)!;
      if (patch.text !== undefined) row.text = patch.text;
      if (patch.error_code !== undefined) row.error_code = patch.error_code;
      return row;
    }),
    listMessages: vi.fn(async () => messages),
  };
  const repos = { chat, apiTokens: { listByUser: vi.fn(async () => []), create: vi.fn(async () => ({})), revoke: vi.fn(async () => undefined) } } as unknown as Repositories;
  const runner: RunnerClient = {
    run: vi.fn(() => (typeof lines === 'function' ? lines() : (async function* () { for (const l of lines) yield l; })())),
  };
  return { service: new ChatService({ repos, runner, configDirs: { primary: '/accounts/primary' } }), chat, runner, messages, conversation };
}

const delta = (text: string) => JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } });
const done = (session = '3f1e9b1e-0000-4000-8000-000000000001') => JSON.stringify({ type: 'result', session_id: session, usage: { input_tokens: 5 } });

beforeEach(() => vi.clearAllMocks());

it('stores the question, the answer, and the session id the CLI reports', async () => {
  const { service, chat, messages, conversation } = build([delta('Nada '), delta('rodando.'), done()]);
  const answer = await service.send(user, 'o que está rodando?');

  expect(messages.map((m) => [m.role, m.text])).toEqual([
    ['user', 'o que está rodando?'],
    ['assistant', 'Nada rodando.'],
  ]);
  expect(answer.text).toBe('Nada rodando.');
  expect(conversation.cli_session_id).toBe('3f1e9b1e-0000-4000-8000-000000000001');
  expect(chat.setCliSession).toHaveBeenCalled();
});

it('resumes the session on the next message', async () => {
  const { service, runner, conversation } = build([delta('ok'), done()]);
  conversation.cli_session_id = '3f1e9b1e-0000-4000-8000-000000000001';
  await service.send(user, 'e agora?');
  expect(vi.mocked(runner.run).mock.calls[0][0]).toMatchObject({ resume: true, session_id: '3f1e9b1e-0000-4000-8000-000000000001' });
});

it('refuses a second message while one is still being answered', async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  const { service } = build(() => (async function* () { await gate; yield delta('ok'); yield done(); })());

  const first = service.send(user, 'primeira');
  await expect(service.send(user, 'segunda')).rejects.toThrow(/ainda está respondendo/i);
  release();
  await first;
});

it('keeps the partial answer and marks the message when the runner dies', async () => {
  const { service, messages } = build(() => (async function* () { yield delta('comecei a olhar'); throw new Error('claude exited with 1'); })());
  const answer = await service.send(user, 'olha lá');
  expect(answer.error_code).toBe('RUNNER_FAILED');
  expect(messages.at(-1)!.text).toBe('comecei a olhar');
});

it('records an action and its failed result without breaking the answer', async () => {
  const call = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu_1', name: 'mcp__termhub__open_tab', input: { project_id: 'p1' } }] } });
  const result = JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1', is_error: true }] } });
  const { service } = build([call, result, delta('não consegui abrir a aba'), done()]);
  const answer = await service.send(user, 'abre uma aba');
  expect(answer.text).toBe('não consegui abrir a aba');
  expect(answer.error_code).toBeNull();
});

it('starts a fresh session when resuming the old one fails', async () => {
  const { service, runner, conversation } = build(() => (async function* () { throw new Error('No conversation found with session ID'); })());
  conversation.cli_session_id = '3f1e9b1e-0000-4000-8000-000000000001';
  vi.mocked(runner.run).mockImplementationOnce(() => (async function* () { throw new Error('No conversation found with session ID'); })());
  vi.mocked(runner.run).mockImplementationOnce(() => (async function* () { yield delta('oi'); yield done('3f1e9b1e-0000-4000-8000-000000000002'); })());

  const answer = await service.send(user, 'oi');
  expect(vi.mocked(runner.run).mock.calls[1][0]).toMatchObject({ resume: false });
  expect(answer.text).toBe('oi');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w @termhub/server -- src/chat/service`
Expected: FAIL — `Cannot find module './service.js'`.

- [ ] **Step 3: Write the runner client**

`apps/server/src/chat/runner.ts`:

```ts
import { config } from '../config.js';
import { HttpError } from '../lib/errors.js';
import type { RunnerClient, RunnerInput } from './service.js';

/** Talks to the concierge container over the compose network. Never logs the body: it carries the
 * user's message and a live token. */
export function httpRunner(): RunnerClient {
  return {
    run: (input: RunnerInput) => {
      const settings = config.concierge;
      if (!settings) throw new HttpError(503, 'O chat não está configurado neste servidor', 'CONCIERGE_DISABLED');
      return (async function* () {
        const res = await fetch(`${settings.url}/run`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-concierge-secret': settings.secret },
          body: JSON.stringify({ ...input, mcp_url: config.mcpUrl ?? `${config.publicUrl}/mcp` }),
        });
        if (!res.ok || !res.body) throw new HttpError(502, 'O concierge não respondeu', 'CONCIERGE_FAILED');
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          for (const line of lines) if (line.trim()) yield line;
        }
        if (buffer.trim()) yield buffer;
      })();
    },
  };
}
```

- [ ] **Step 4: Write the service**

`apps/server/src/chat/service.ts`:

```ts
import { randomUUID } from 'node:crypto';
import type { Repositories } from '../db/repositories/index.js';
import type { ChatConversation, ChatMessage } from '../db/repositories/chat.js';
import type { User } from '../db/repositories/types.js';
import { HttpError } from '../lib/errors.js';
import { chatBus } from './bus.js';
import { parseFrame } from './stream.js';
import { mintConciergeToken } from './token.js';

export interface RunnerInput {
  session_id: string;
  resume: boolean;
  text: string;
  config_dir: string;
  model?: string | null;
  token: string;
}
export interface RunnerClient {
  run(input: RunnerInput): AsyncIterable<string>;
}

/** The CLI says this when --resume names a session the account's config dir does not have. */
const isMissingSession = (e: unknown) => /No conversation found|session ID/i.test(e instanceof Error ? e.message : '');

export class ChatService {
  /** One run per conversation: two `claude -p` processes on the same --session-id would race. */
  private running = new Set<string>();

  constructor(private deps: { repos: Repositories; runner: RunnerClient; configDirs: { primary: string; secondary?: string } }) {}

  conversationFor(user: User): Promise<ChatConversation> {
    return this.deps.repos.chat.getOrCreateForUser(user.id);
  }

  async send(user: User, text: string): Promise<ChatMessage> {
    const conversation = await this.conversationFor(user);
    if (this.running.has(conversation.id)) throw new HttpError(409, 'O concierge ainda está respondendo a mensagem anterior', 'CHAT_BUSY');
    this.running.add(conversation.id);
    try {
      const question = await this.deps.repos.chat.addMessage({ conversation_id: conversation.id, role: 'user', text });
      chatBus.publish({ type: 'message', user_id: user.id, message: question });

      let answer = await this.deps.repos.chat.addMessage({ conversation_id: conversation.id, role: 'assistant', text: '' });
      chatBus.publish({ type: 'message', user_id: user.id, message: answer });

      const token = await mintConciergeToken(this.deps.repos, user.id, ['read']);
      const sessionId = conversation.cli_session_id ?? randomUUID();
      const input: RunnerInput = {
        session_id: sessionId,
        resume: conversation.cli_session_id !== null,
        text,
        config_dir: this.deps.configDirs.primary,
        model: conversation.model,
        token,
      };

      let collected = '';
      let usage: unknown = null;
      let failure: string | null = null;

      const consume = async (run: RunnerInput) => {
        for await (const line of this.deps.runner.run(run)) {
          const frame = parseFrame(line);
          if (!frame) continue;
          if (frame.type === 'text') {
            collected += frame.delta;
            chatBus.publish({ type: 'delta', user_id: user.id, message_id: answer.id, delta: frame.delta });
          } else if (frame.type === 'action') {
            chatBus.publish({ type: 'action', user_id: user.id, message_id: answer.id, tool: frame.tool, tool_use_id: frame.tool_use_id, args: frame.args });
          } else if (frame.type === 'action_result') {
            chatBus.publish({ type: 'action_result', user_id: user.id, message_id: answer.id, tool_use_id: frame.tool_use_id, ok: frame.ok });
          } else if (frame.type === 'done') {
            usage = frame.usage ?? null;
            if (frame.session_id && frame.session_id !== conversation.cli_session_id) await this.deps.repos.chat.setCliSession(conversation.id, frame.session_id);
          } else if (frame.type === 'error') {
            failure = frame.message;
          }
        }
      };

      try {
        await consume(input);
      } catch (e) {
        // A resume that the account cannot honour is not a failure: start a fresh session once.
        if (input.resume && isMissingSession(e)) {
          const fresh = { ...input, resume: false, session_id: randomUUID() };
          await this.deps.repos.chat.setCliSession(conversation.id, null);
          try {
            await consume(fresh);
          } catch (again) {
            failure = again instanceof Error ? again.message : 'runner failed';
          }
        } else {
          failure = e instanceof Error ? e.message : 'runner failed';
        }
      }

      answer = await this.deps.repos.chat.updateMessage(answer.id, { text: collected, usage, error_code: failure ? 'RUNNER_FAILED' : null });
      chatBus.publish({ type: 'message', user_id: user.id, message: answer });
      return answer;
    } finally {
      this.running.delete(conversation.id);
    }
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -w @termhub/server -- src/chat/service`
Expected: PASS (6 tests). `./bus.js` comes from Task 6 — create it first if this task runs before it (the module is ten lines; see Task 6 step 3).

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/chat/service.ts apps/server/src/chat/runner.ts apps/server/src/chat/service.test.ts
git commit -m "Chat: turn one message into a concierge run and a stored answer"
```

---

### Task 6: HTTP routes, the bus and `/ws/chat`

**Files:**
- Create: `apps/server/src/chat/bus.ts`, `apps/server/src/chat/ws.ts`, `apps/server/src/routes/chat.ts`
- Modify: `apps/server/src/auth/permissions.ts` (`RESOURCES` += `chat`), `apps/server/src/app.ts` (register the plugin and the WS)
- Test: `apps/server/src/routes/chat.test.ts`

**Interfaces:**
- Consumes: `ChatService` (Task 5).
- Produces: `GET /api/chat` → `{ conversation, messages }`; `POST /api/chat/messages` `{ text }` → `{ message }`; `chatBus.publish/subscribe`; `registerChatWs(router, { log })`.

- [ ] **Step 1: Write the failing test**

`apps/server/src/routes/chat.test.ts`:

```ts
import Fastify from 'fastify';
import { expect, it, vi } from 'vitest';
import { applyErrorHandler } from '../lib/errors.js';
import { chatRoutes } from './chat.js';

function build(send = vi.fn(async () => ({ id: 'm2', role: 'assistant', text: 'Nada rodando.' }))) {
  const service = {
    conversationFor: vi.fn(async () => ({ id: 'c1', user_id: 'u1', review_mode: false })),
    send,
  };
  const repos = { chat: { listMessages: vi.fn(async () => [{ id: 'm1', role: 'user', text: 'oi' }]) } };
  const app = Fastify();
  applyErrorHandler(app);
  app.decorateRequest('scope', null);
  app.addHook('preHandler', async (req) => {
    (req as unknown as { scope: unknown }).scope = { user: { id: 'u1' }, viewAs: { kind: 'self' }, ownerId: 'u1', createAs: 'u1' };
  });
  app.register((a) => chatRoutes(a, repos as never, { service: service as never }), { prefix: '/chat' });
  return { app, service };
}

it('returns the conversation with its messages', async () => {
  const { app } = build();
  const res = await app.inject({ method: 'GET', url: '/chat' });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toMatchObject({ conversation: { id: 'c1' }, messages: [{ id: 'm1', text: 'oi' }] });
});

it('sends a message and answers with the assistant row', async () => {
  const { app, service } = build();
  const res = await app.inject({ method: 'POST', url: '/chat/messages', payload: { text: 'o que está rodando?' } });
  expect(res.statusCode).toBe(201);
  expect(res.json().message.text).toBe('Nada rodando.');
  expect(service.send.mock.calls[0][1]).toBe('o que está rodando?');
});

it('rejects an empty or oversized message', async () => {
  const { app } = build();
  expect((await app.inject({ method: 'POST', url: '/chat/messages', payload: { text: '   ' } })).statusCode).toBe(400);
  expect((await app.inject({ method: 'POST', url: '/chat/messages', payload: { text: 'x'.repeat(8001) } })).statusCode).toBe(400);
});

it('passes the service busy error through as 409', async () => {
  const { HttpError } = await import('../lib/errors.js');
  const { app } = build(vi.fn(async () => { throw new HttpError(409, 'O concierge ainda está respondendo a mensagem anterior', 'CHAT_BUSY'); }));
  const res = await app.inject({ method: 'POST', url: '/chat/messages', payload: { text: 'segunda' } });
  expect(res.statusCode).toBe(409);
  expect(res.json().code).toBe('CHAT_BUSY');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w @termhub/server -- src/routes/chat`
Expected: FAIL — `Cannot find module './chat.js'`.

- [ ] **Step 3: Write the bus**

`apps/server/src/chat/bus.ts`:

```ts
import { EventEmitter } from 'node:events';
import type { ChatMessage } from '../db/repositories/chat.js';

/** What the browser is told while an answer is being written. Terminal content never travels here:
 * an action carries the tool and its arguments, never a captured screen (spec §7.1). */
export type ChatEvent =
  | { type: 'message'; user_id: string; message: ChatMessage }
  | { type: 'delta'; user_id: string; message_id: string; delta: string }
  | { type: 'action'; user_id: string; message_id: string; tool: string; tool_use_id: string; args: unknown }
  | { type: 'action_result'; user_id: string; message_id: string; tool_use_id: string; ok: boolean };

class ChatBus {
  private emitter = new EventEmitter();
  constructor() {
    this.emitter.setMaxListeners(0);
  }
  publish(event: ChatEvent): void {
    this.emitter.emit('chat', event);
  }
  subscribe(listener: (event: ChatEvent) => void): () => void {
    this.emitter.on('chat', listener);
    return () => this.emitter.off('chat', listener);
  }
}

export const chatBus = new ChatBus();
```

- [ ] **Step 4: Write the routes**

`apps/server/src/routes/chat.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Repositories } from '../db/repositories/index.js';
import type { ChatService } from '../chat/service.js';

const messageBody = z.object({ text: z.string().trim().min(1).max(8000) });

export async function chatRoutes(app: FastifyInstance, repos: Repositories, deps: { service: ChatService }) {
  app.get('/', async (request) => {
    const conversation = await deps.service.conversationFor(request.scope.user);
    return { conversation, messages: await repos.chat.listMessages(conversation.id) };
  });

  app.post('/messages', { config: { action: 'create' } }, async (request, reply) => {
    const { text } = messageBody.parse(request.body);
    const message = await deps.service.send(request.scope.user, text);
    return reply.code(201).send({ message });
  });
}
```

- [ ] **Step 5: Write the WS**

`apps/server/src/chat/ws.ts` — the socket carries **no history**: the client fetches `GET /api/chat`
on open, which is what makes a reconnect mid-answer safe.

```ts
import { WebSocketServer, WebSocket } from 'ws';
import type { FastifyBaseLogger } from 'fastify';
import type { createUpgradeRouter } from '../ws/router.js';
import { chatBus } from './bus.js';

/** `/ws/chat`: pushes the concierge's deltas and action trail to the browser, for the signed-in
 * user only. No history and no terminal content — the client reads the conversation over REST. */
export function registerChatWs(router: ReturnType<typeof createUpgradeRouter>, deps: { log: FastifyBaseLogger }): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  const log = deps.log.child({ mod: 'chat-ws' });

  router.add(/^\/ws\/chat\/?$/, async ({ req, socket, head, scope }) => {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
      const w = ws as WebSocket & { isAlive?: boolean };
      w.isAlive = true;
      ws.on('pong', () => (w.isAlive = true));

      const unsubscribe = chatBus.subscribe((event) => {
        if (event.user_id !== scope.user.id) return;
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(event));
      });
      log.info({ userId: scope.user.id }, 'chat conectado');
      ws.on('close', () => {
        unsubscribe();
        log.info({ userId: scope.user.id }, 'chat desconectado');
      });
      ws.on('error', () => unsubscribe());
    });
  });

  const interval = setInterval(() => {
    for (const ws of wss.clients) {
      const w = ws as WebSocket & { isAlive?: boolean };
      if (w.isAlive === false) {
        w.terminate();
        continue;
      }
      w.isAlive = false;
      w.ping();
    }
  }, 30_000);
  wss.on('close', () => clearInterval(interval));
  return wss;
}
```

- [ ] **Step 6: Wire it into the app**

In `apps/server/src/auth/permissions.ts` add `{ key: 'chat', label: 'Chat' }` to `RESOURCES`. In `apps/server/src/app.ts`:

```ts
import { chatRoutes } from './routes/chat.js';
import { ChatService } from './chat/service.js';
import { httpRunner } from './chat/runner.js';
import { registerChatWs } from './chat/ws.js';
// …next to registerMonitorWs:
registerChatWs(upgrades, { log: fastify.log });
// …inside the /api block, next to the other guarded registrations:
const chat = new ChatService({ repos, runner: httpRunner(), configDirs: { primary: '/accounts/primary', secondary: '/accounts/secondary' } });
await guarded('chat', (a) => chatRoutes(a, repos, { service: chat }), '/chat');
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npm test -w @termhub/server -- src/routes/chat src/chat`
Expected: PASS (all chat tests, 12+).

- [ ] **Step 8: Commit**

```bash
git add apps/server/src/chat/bus.ts apps/server/src/chat/ws.ts apps/server/src/routes/chat.ts apps/server/src/routes/chat.test.ts apps/server/src/auth/permissions.ts apps/server/src/app.ts
git commit -m "Chat: REST endpoints, event bus and the /ws/chat stream"
```

---

### Task 7: The chat screen

**Files:**
- Create: `apps/web/src/pages/ChatPage.tsx`, `apps/web/src/lib/chat.tsx`
- Modify: `apps/web/src/lib/api.ts` (two methods), `apps/web/src/lib/types.ts` (`ChatConversation`, `ChatMessage`, `ChatEvent`), `apps/web/src/App.tsx` (route `/chat`), `apps/web/src/components/Sidebar.tsx` (entry "Chat")
- Test: `apps/web/src/pages/ChatPage.test.tsx`

**Interfaces:**
- Consumes: `GET /api/chat`, `POST /api/chat/messages`, `/ws/chat` (Task 6).
- Produces: `api.chat()`, `api.sendChatMessage(text)`, `useChatStream()`.

- [ ] **Step 1: Write the failing test**

`apps/web/src/pages/ChatPage.test.tsx` (follow the existing `ApiTokensView.test.tsx` for mocking `../lib/api`):

```tsx
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi, beforeEach } from 'vitest';
import { ChatPage } from './ChatPage';

vi.mock('../lib/api', () => ({
  api: {
    chat: vi.fn(async () => ({ conversation: { id: 'c1', review_mode: false }, messages: [{ id: 'm1', role: 'user', text: 'oi', error_code: null }] })),
    sendChatMessage: vi.fn(async () => ({ message: { id: 'm3', role: 'assistant', text: 'pronto', error_code: null } })),
  },
}));
vi.mock('../lib/chat', () => ({ useChatStream: vi.fn(() => ({ events: [], connected: true })) }));

beforeEach(() => vi.clearAllMocks());

it('shows the stored conversation', async () => {
  render(<ChatPage />);
  expect(await screen.findByText('oi')).toBeInTheDocument();
});

it('sends what was typed and clears the box', async () => {
  const { api } = await import('../lib/api');
  render(<ChatPage />);
  const box = await screen.findByPlaceholderText(/pergunte/i);
  await userEvent.type(box, 'o que está rodando?');
  await userEvent.click(screen.getByRole('button', { name: /enviar/i }));
  await waitFor(() => expect(api.sendChatMessage).toHaveBeenCalledWith('o que está rodando?'));
  expect(box).toHaveValue('');
});

it('re-reads the conversation whenever the socket (re)connects', async () => {
  // Review Focus 5: /ws/chat carries no history, so a reconnect mid-answer must refetch.
  const { api } = await import('../lib/api');
  const { useChatStream } = await import('../lib/chat');
  vi.mocked(useChatStream).mockImplementation((onReconnect: () => void) => {
    onReconnect();
    return { events: [], connected: true };
  });
  render(<ChatPage />);
  await waitFor(() => expect(vi.mocked(api.chat).mock.calls.length).toBeGreaterThanOrEqual(2));
});

it('says when an answer did not finish', async () => {
  const { api } = await import('../lib/api');
  vi.mocked(api.chat).mockResolvedValueOnce({ conversation: { id: 'c1', review_mode: false }, messages: [{ id: 'm1', role: 'assistant', text: 'comecei', error_code: 'RUNNER_FAILED' }] } as never);
  render(<ChatPage />);
  expect(await screen.findByText(/não terminou/i)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w @termhub/web -- src/pages/ChatPage`
Expected: FAIL — cannot resolve `./ChatPage`.

- [ ] **Step 3: Add the types and API methods**

In `apps/web/src/lib/types.ts`:

```ts
export interface ChatConversation { id: string; title: string | null; model: string | null; review_mode: boolean; last_message_at: string | null }
export interface ChatMessage { id: string; conversation_id: string; role: 'user' | 'assistant'; text: string; error_code: string | null; created_at: string }
export type ChatEvent =
  | { type: 'message'; message: ChatMessage }
  | { type: 'delta'; message_id: string; delta: string }
  | { type: 'action'; message_id: string; tool: string; tool_use_id: string; args: unknown }
  | { type: 'action_result'; message_id: string; tool_use_id: string; ok: boolean };
```

In `apps/web/src/lib/api.ts`, inside the exported `api` object:

```ts
  chat: () => request<{ conversation: ChatConversation; messages: ChatMessage[] }>('GET', '/chat'),
  sendChatMessage: (text: string) => request<{ message: ChatMessage }>('POST', '/chat/messages', { text }),
```

- [ ] **Step 4: Write the stream hook**

`apps/web/src/lib/chat.tsx`:

```tsx
import { useEffect, useRef, useState } from 'react';
import type { ChatEvent } from './types';

/** Subscribes to /ws/chat. The socket has no history, so `onReconnect` re-reads the conversation
 * over REST — that is what makes a reconnect in the middle of an answer safe. */
export function useChatStream(onReconnect: () => void): { events: ChatEvent[]; connected: boolean } {
  const [events, setEvents] = useState<ChatEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const reconnect = useRef(onReconnect);
  reconnect.current = onReconnect;

  useEffect(() => {
    let ws: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let closed = false;
    let attempt = 0;

    const open = () => {
      ws = new WebSocket(`${location.origin.replace(/^http/, 'ws')}/ws/chat`);
      ws.onopen = () => {
        attempt = 0;
        setConnected(true);
        reconnect.current();
      };
      ws.onmessage = (m) => {
        try {
          setEvents((prev) => [...prev.slice(-500), JSON.parse(m.data as string) as ChatEvent]);
        } catch {
          /* ignore a frame we cannot read */
        }
      };
      ws.onclose = () => {
        setConnected(false);
        if (closed) return;
        attempt += 1;
        timer = setTimeout(open, Math.min(1000 * attempt, 10_000));
      };
    };
    open();
    return () => {
      closed = true;
      clearTimeout(timer);
      ws?.close();
    };
  }, []);

  return { events, connected };
}
```

- [ ] **Step 5: Write the page**

`apps/web/src/pages/ChatPage.tsx` — all copy in pt-BR:

```tsx
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { useChatStream } from '../lib/chat';
import type { ChatMessage } from '../lib/types';

export function ChatPage() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { messages } = await api.chat();
    setMessages(messages);
  }, []);
  useEffect(() => void load(), [load]);

  const { events, connected } = useChatStream(load);

  /** Deltas and the action trail of the answer being written, keyed by message. */
  const live = useMemo(() => {
    const deltas = new Map<string, string>();
    const actions = new Map<string, { tool: string; ok?: boolean }[]>();
    for (const e of events) {
      if (e.type === 'delta') deltas.set(e.message_id, (deltas.get(e.message_id) ?? '') + e.delta);
      if (e.type === 'action') actions.set(e.message_id, [...(actions.get(e.message_id) ?? []), { tool: e.tool }]);
      if (e.type === 'message') setTimeout(() => void load(), 0);
    }
    return { deltas, actions };
  }, [events, load]);

  const send = async () => {
    const value = text.trim();
    if (!value || sending) return;
    setSending(true);
    setError(null);
    try {
      await api.sendChatMessage(value);
      setText('');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Não foi possível enviar');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="chat">
      <h1>Chat</h1>
      {!connected && <p className="chat-offline">Reconectando…</p>}
      <ol className="chat-messages">
        {messages.map((m) => (
          <li key={m.id} className={m.role === 'user' ? 'chat-mine' : 'chat-theirs'}>
            <p>{m.text || live.deltas.get(m.id) || (m.role === 'assistant' ? 'pensando…' : '')}</p>
            {(live.actions.get(m.id) ?? []).map((a, i) => (
              <small key={i} className="chat-action">{a.tool}</small>
            ))}
            {m.error_code && <small className="chat-error">A resposta não terminou — tente de novo.</small>}
          </li>
        ))}
      </ol>
      {error && <p className="chat-error">{error}</p>}
      <div className="chat-compose">
        <textarea
          value={text}
          placeholder="Pergunte ou peça algo às suas máquinas"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <button type="button" onClick={() => void send()} disabled={sending}>Enviar</button>
      </div>
    </div>
  );
}
```

Route it in `App.tsx` (`<Route path="/chat" element={<ChatPage />} />`, inside the `Layout` element) and add a "Chat" entry to `apps/web/src/components/Sidebar.tsx` next to the existing links.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm test -w @termhub/web -- src/pages/ChatPage`
Expected: PASS (3 tests).

- [ ] **Step 7: Full verification before pushing**

```bash
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/w" -w /w node:20 \
  sh -c 'npm run typecheck -w @termhub/server && npm test -w @termhub/server && npm test -w @termhub/web && npm run build -w @termhub/web && npm run build -w @termhub/landing'
rm -rf .npm
```
Expected: all green. Then the manual smoke test on jarvis, which is the only thing these tests cannot prove:

```bash
docker compose --env-file /mnt/hd2tb/projetos/termhub/.env -f docker-compose.yml --profile prod up -d --build concierge
docker compose --env-file /mnt/hd2tb/projetos/termhub/.env logs --tail 20 concierge
```
Then open `/chat` in the app, ask "quais máquinas estão online?", and confirm: the answer streams, the trail shows `list_machines`, and `select tool, ok from api_token_events order by created_at desc limit 3` shows the call under a `concierge (automático)` token.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/pages/ChatPage.tsx apps/web/src/pages/ChatPage.test.tsx apps/web/src/lib/chat.tsx apps/web/src/lib/api.ts apps/web/src/lib/types.ts apps/web/src/App.tsx apps/web/src/components/Sidebar.tsx
git commit -m "Chat: the conversation screen with its live stream"
```
