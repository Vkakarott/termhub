# Concierge subagents: panel, gate origin, resume — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show and cancel the concierge's background subagents (web + app), name the subagent that asked on a gate card, and resume a live concierge process after a server restart or deploy.

**Architecture:** The server already reads the CLI's stream-json in `LiveRun`. It learns three new frame kinds (task lifecycle, subagent tool calls, control responses), persists subagents in `chat_subagents`, and writes `stop_task` control lines into the live process. The MCP route forwards `_meta["claudecode/toolUseId"]` to the gate, which links a proposal to its subagent. `chat_live_runs` keeps each live process's open turns, with a heartbeat. A `preClose` hook releases them on shutdown, and a 30 s sweep in every instance resumes released or stale ones on the same CLI session.

**Tech Stack:** Fastify + Prisma 7 (Postgres) + zod + vitest (server), React + vitest + testing-library (web), Expo RN + jest + testing-library/react-native (app), `@termhub/mobile-api` zod contract.

**Spec:** `docs/superpowers/specs/2026-09-26-concierge-subagents-panel-design.md` (read it first, especially §3 Decisions and §7).

## Global Constraints

- UI copy in pt-BR, exact strings:
  - panel button "Subagentes (n)";
  - status labels "rodando", "cancelando…", "concluído", "falhou", "cancelado", "interrompido";
  - "Cancelar", "Não foi possível cancelar", "há N min" / "levou N min" ("menos de 1 min" under a minute);
  - card origin line "Pedido pelo subagente «descrição»".
- Code, comments, commit messages in English; imperative subject ≤ 72 chars; every commit ends with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- Routes never import Prisma; every request input validated with zod; chat routes stay under `guarded('chat', …)`; owner scoping through the conversation (`findByIdForUser`).
- Never log terminal content, prompts, descriptions, `turns[].text` or control error text. Log ids and labels only (`failureLabel`).
- Migration additive only (`CREATE TABLE`, `ADD COLUMN` nullable, `CREATE INDEX`). Name: `20260927100000_chat_subagents_resume`.
- No `@termhub/agent` version bump (control lines already pass through, spec §2).
- Every chat feature ships in web **and** app.
- Verification runs in Docker (no Node on host). Use the helper `SCRATCH/check.sh '<cmds>'`, where SCRATCH is `/tmp/claude-1000/-home-pedrogoiania-termhub/fab31e9f-34a1-4a9c-ae11-d05a6014a6a7/scratchpad`. It runs `<cmds>` in `node:22` at the worktree root `/home/pedrogoiania/termhub-ter301` with the throwaway Postgres `th-ter301-db` (`DATABASE_URL`, `TERMHUB_DB_TESTS=1` set). After a schema or package change, run first: `npm run prisma:generate >/dev/null && npm run build:packages >/dev/null && (cd apps/server && npx prisma migrate deploy)`.
- Single server test file: `SCRATCH/check.sh 'npx vitest run --root apps/server src/chat/stream.test.ts'`. Web: `npx vitest run --root apps/web <file>`. App: `npm test -w @termhub/mobile -- <pattern>`.
- Never touch production containers; the only throwaway container is `th-ter301-db`.

## Review Focus

1. **The CLI answers `stop_task` with an error, or never answers.** The row must go back to `running` and the screens must show "Não foi possível cancelar". It must never stay "cancelando…" forever. Test in Task 4 (control error) and Task 5 (30 s timeout rollback).
2. **The gate call arrives before the subagent's tool frame, or after.** Both orders end with the card naming the subagent. A `_meta` from another conversation or with a malformed id must never attach an origin. Tests in Tasks 3 and 4.
3. **Blue/green overlap.** The new instance must not resume a run the old instance still owns (fresh heartbeat, not released). Two instances sweeping at once must resume a run only once. Tests in Tasks 2 and 6.
4. **A resumed turn whose answer the old instance already finished** (a race at shutdown) must be skipped, not answered twice. If the host never comes back, the turns close with `HOST_GONE` after 15 min, never "pensando…" forever. Test in Task 6.
5. **Cancel on someone else's subagent id, or after the process ended.** The first is a 404 (never a 409 that confirms the id exists). The second is a 409 `SUBAGENT_GONE`, and the row becomes `interrupted`. Tests in Task 5.

---

## File map

| File | Responsibility |
|---|---|
| `apps/server/src/chat/stream.ts` (modify) | New `ChatFrame` variants: `subagent_started`, `subagent_status`, `subagent_tool`, `control_response` |
| `apps/server/prisma/schema.prisma` + migration (modify/create) | `ChatSubagent`, `ChatLiveRun`, `chat_actions.tool_use_id/subagent_id` |
| `apps/server/src/db/repositories/chat-subagents.ts` (create) | Subagent rows: insert/update/list panel window/mark interrupted |
| `apps/server/src/db/repositories/chat-live-runs.ts` (create) | Live-run rows: upsert/heartbeat/release/claim/list resumable/delete |
| `apps/server/src/db/repositories/chat-actions.ts` (modify) | `tool_use_id`, `subagent_id` on insert; `setSubagentByToolUse` |
| `apps/server/src/db/repositories/chat.ts` (modify) | `findMessagesByIds` |
| `apps/server/src/db/repositories/chat-actions-view.ts` (modify) | `ChatActionCard.subagent` |
| `apps/server/src/chat/subagent-origin.ts` (create) | In-memory `tool_use_id → {conversationId, subagentId}` map |
| `apps/server/src/chat/subagent-view.ts` (create) | `SubagentView`, status mapping, the panel window constants |
| `apps/server/src/mcp/route.ts`, `apps/server/src/chat/gate-runtime.ts` (modify) | Forward `_meta` tool-use id; store origin |
| `apps/server/src/chat/live-run.ts` (modify) | Subagent registry, `stopTask`, control responses, late origin binding, `addNote`, `onTurnsChanged` |
| `apps/server/src/chat/service.ts` (modify) | `subagentsFor`, `cancelSubagent`, live-run persistence, `suspendAll`, `resumeSweep` |
| `apps/server/src/chat/resume.ts` (create) | Resume note text, stored-turn (de)serialization |
| `apps/server/src/chat/bus.ts` (modify) | `subagent`, `subagent_cancel_failed` events; `confirmation.subagent` |
| `apps/server/src/routes/chat.ts`, `apps/server/src/routes/m-chat.ts` (modify) | GET `subagents`; POST cancel |
| `apps/server/src/app.ts` (modify) | Heartbeat + sweep timers, `preClose` suspend |
| `apps/server/src/chat/concierge-prompt.ts` (modify) | Two prompt lines |
| `packages/mobile-api/src/events.ts` (+ `src/chat.ts`) (modify) | `subagentViewSchema`, events, `chatActionSchema.subagent` |
| `apps/server/src/mobile/events-parity.test.ts` (modify) | Samples for the new events |
| `apps/web/src/lib/types.ts`, `lib/api.ts`, `components/chat/ChatPanel.tsx`, `ChatActionCard.tsx`, `ChatActionGroup.tsx` (modify); `components/chat/ChatSubagents.tsx` (create) | Web panel + origin |
| `apps/mobile/src/features/chat/model/events.ts`, `viewmodel/createChatStore.ts`, `view/conversation-screen.tsx`, `view/action-card.tsx`, `view/action-group-card.tsx`, `view/subagents-sheet.tsx` (create), `services/api/client.ts`, `contract/local.ts`, mock handlers (modify) | App panel + origin |

---

### Task 1: Stream frames for subagents and control responses

**Files:**
- Modify: `apps/server/src/chat/stream.ts`
- Test: `apps/server/src/chat/stream.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type SubagentStatus = 'running' | 'stopping' | 'completed' | 'failed' | 'stopped' | 'interrupted';
  // new ChatFrame variants:
  | { type: 'subagent_started'; task_id: string; tool_use_id: string; description: string; subagent_type: string | null }
  | { type: 'subagent_status'; task_id: string; status: 'completed' | 'failed' | 'stopped' }
  | { type: 'subagent_tool'; parent_tool_use_id: string; tool_use_id: string; tool: string } // tool without mcp__termhub__ prefix
  | { type: 'control_response'; request_id: string; ok: boolean }
  export function cliTaskStatus(raw: unknown): 'completed' | 'failed' | 'stopped' | null
  ```

- [ ] **Step 1: Write the failing tests** (append to `stream.test.ts`; frame shapes copied from `fixtures/stream-background.ndjson`)

```ts
describe('subagent frames', () => {
  it('maps task_started to subagent_started', () => {
    const line = JSON.stringify({ type: 'system', subtype: 'task_started', task_id: 'af47', tool_use_id: 'toolu_A', description: 'Write text about lighthouses', subagent_type: 'general-purpose', is_backgrounded: true, prompt: 'secret prompt' });
    expect(parseFrame(line)).toEqual({ type: 'subagent_started', task_id: 'af47', tool_use_id: 'toolu_A', description: 'Write text about lighthouses', subagent_type: 'general-purpose' });
  });
  it('caps the description at 200 chars and drops a task_started without ids', () => {
    const long = 'x'.repeat(300);
    expect((parseFrame(JSON.stringify({ type: 'system', subtype: 'task_started', task_id: 't', tool_use_id: 'u', description: long })) as { description: string }).description).toHaveLength(200);
    expect(parseFrame(JSON.stringify({ type: 'system', subtype: 'task_started', description: 'd' }))).toBeNull();
  });
  it('maps task_updated and task_notification statuses', () => {
    expect(parseFrame(JSON.stringify({ type: 'system', subtype: 'task_updated', task_id: 't', patch: { status: 'completed', end_time: 1 } }))).toEqual({ type: 'subagent_status', task_id: 't', status: 'completed' });
    expect(parseFrame(JSON.stringify({ type: 'system', subtype: 'task_notification', task_id: 't', status: 'killed', summary: 'x' }))).toEqual({ type: 'subagent_status', task_id: 't', status: 'stopped' });
    for (const s of ['stopped', 'cancelled']) expect(cliTaskStatus(s)).toBe('stopped');
    expect(cliTaskStatus('failed')).toBe('failed');
    expect(parseFrame(JSON.stringify({ type: 'system', subtype: 'task_updated', task_id: 't', patch: { status: 'running' } }))).toBeNull();
    expect(parseFrame(JSON.stringify({ type: 'system', subtype: 'task_updated', task_id: 't', patch: { end_time: 1 } }))).toBeNull();
  });
  it('reports a subagent termhub tool call, and nothing else of a subagent', () => {
    const tool = { type: 'assistant', parent_tool_use_id: 'toolu_A', message: { content: [{ type: 'tool_use', id: 'toolu_B', name: 'mcp__termhub__send_input', input: { text: 'x' } }] } };
    expect(parseFrame(JSON.stringify(tool))).toEqual({ type: 'subagent_tool', parent_tool_use_id: 'toolu_A', tool_use_id: 'toolu_B', tool: 'send_input' });
    const other = { ...tool, message: { content: [{ type: 'tool_use', id: 'toolu_C', name: 'Agent', input: {} }] } };
    expect(parseFrame(JSON.stringify(other))).toBeNull();
    const text = { type: 'assistant', parent_tool_use_id: 'toolu_A', message: { content: [{ type: 'text', text: 'hi' }] } };
    expect(parseFrame(JSON.stringify(text))).toBeNull();
  });
  it('maps control_response success and error without the error text', () => {
    expect(parseFrame(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: 'stop-1' } }))).toEqual({ type: 'control_response', request_id: 'stop-1', ok: true });
    expect(parseFrame(JSON.stringify({ type: 'control_response', response: { subtype: 'error', request_id: 'stop-1', error: 'not supported' } }))).toEqual({ type: 'control_response', request_id: 'stop-1', ok: false });
    expect(parseFrame(JSON.stringify({ type: 'control_response', response: { subtype: 'success' } }))).toBeNull();
  });
});
```
Also import `cliTaskStatus` at the top of the test file.

- [ ] **Step 2: Run to verify failure** — `SCRATCH/check.sh 'npx vitest run --root apps/server src/chat/stream.test.ts'` → FAIL (`cliTaskStatus` not exported, frames null).

- [ ] **Step 3: Implement** in `stream.ts`:
  - add the variants to `ChatFrame` with doc comments;
  - export `SubagentStatus` and `cliTaskStatus`:
    ```ts
    export function cliTaskStatus(raw: unknown): 'completed' | 'failed' | 'stopped' | null {
      if (raw === 'completed' || raw === 'failed') return raw;
      if (raw === 'killed' || raw === 'stopped' || raw === 'cancelled') return 'stopped';
      return null;
    }
    ```
  - in `parseFrame`, replace the blanket `if (typeof f.parent_tool_use_id === 'string') return null;` with:
    ```ts
    if (typeof f.parent_tool_use_id === 'string') {
      // A subagent's own frames stay out of the chat. Only its termhub tool calls are read: they are
      // how a gated proposal is traced back to the subagent that made it (spec 2026-09-26 panel §5.1).
      if (type !== 'assistant') return null;
      const content = (f.message as { content?: unknown[] } | undefined)?.content ?? [];
      for (const block of content as { type?: string; id?: string; name?: string }[]) {
        if (block.type === 'tool_use' && block.id && block.name?.startsWith('mcp__termhub__')) return { type: 'subagent_tool', parent_tool_use_id: f.parent_tool_use_id, tool_use_id: block.id, tool: toolName(block.name) };
      }
      return null;
    }
    ```
  - before the `background_tasks_changed` line:
    ```ts
    if (type === 'system' && f.subtype === 'task_started') {
      if (typeof f.task_id !== 'string' || typeof f.tool_use_id !== 'string') return null;
      return { type: 'subagent_started', task_id: f.task_id, tool_use_id: f.tool_use_id, description: String(f.description ?? '').slice(0, 200), subagent_type: typeof f.subagent_type === 'string' ? f.subagent_type : null };
    }
    if (type === 'system' && (f.subtype === 'task_updated' || f.subtype === 'task_notification')) {
      const raw = f.subtype === 'task_updated' ? (f.patch as { status?: unknown } | undefined)?.status : f.status;
      const status = cliTaskStatus(raw);
      return typeof f.task_id === 'string' && status ? { type: 'subagent_status', task_id: f.task_id, status } : null;
    }
    if (type === 'control_response') {
      const r = f.response as { subtype?: unknown; request_id?: unknown } | undefined;
      return typeof r?.request_id === 'string' ? { type: 'control_response', request_id: r.request_id, ok: r.subtype === 'success' } : null;
    }
    ```
  - Check that no existing `switch` over `ChatFrame.type` in `service.ts`/`live-run.ts` needs exhaustiveness (they use `if` chains, which ignore new types).

- [ ] **Step 4: Run** the same command → PASS, and `npx vitest run --root apps/server src/chat/` → all pass (the existing "subagent frames ignored" test still holds for text/stream_event frames).

- [ ] **Step 5: Commit** — `git add apps/server/src/chat/stream.ts apps/server/src/chat/stream.test.ts && git commit -m "Chat stream: read subagent lifecycle, tool calls and control responses"`

---

### Task 2: Schema, migration and repositories

**Files:**
- Modify: `apps/server/prisma/schema.prisma` (add models from spec §4 verbatim; add `subagents ChatSubagent[]` and `liveRun ChatLiveRun?` back-relations to `ChatConversation`; add `toolUseId String? @map("tool_use_id")`, `subagentId String? @map("subagent_id")` and `@@index([conversationId, toolUseId])` to `ChatAction`)
- Create: `apps/server/prisma/migrations/20260927100000_chat_subagents_resume/migration.sql`
- Create: `apps/server/src/db/repositories/chat-subagents.ts`, `chat-live-runs.ts`, and their `.db.test.ts`
- Modify: `apps/server/src/db/repositories/chat-actions.ts`, `chat.ts`, `index.ts` (register `chatSubagents`, `chatLiveRuns` in `Repositories` exactly like `chatGrants`)
- Test: `chat-actions.db.test.ts`, `chat.db.test.ts` (extend)

**Interfaces:**
- Produces:
  ```ts
  // chat-subagents.ts
  export interface ChatSubagent { id: string; conversation_id: string; task_id: string; tool_use_id: string; description: string; subagent_type: string | null; status: SubagentStatus; started_at: string; ended_at: string | null }
  export class ChatSubagentsRepository {
    start(input: { conversation_id: string; task_id: string; tool_use_id: string; description: string; subagent_type: string | null }): Promise<ChatSubagent> // upsert on (conversation_id, task_id): a repeated task_started returns the existing row unchanged
    setStatus(id: string, status: SubagentStatus): Promise<ChatSubagent | undefined> // sets ended_at for completed|failed|stopped|interrupted, clears it otherwise; undefined when the row is gone
    findByIdForUser(id: string, userId: string): Promise<ChatSubagent | undefined> // joins conversation.user_id
    listForPanel(conversationId: string, now?: Date): Promise<ChatSubagent[]> // running|stopping, plus ended within PANEL_RECENT_MS; newest first; max 20
    interruptRunning(conversationId: string): Promise<ChatSubagent[]> // running|stopping → interrupted; returns the changed rows
    listByIds(ids: string[]): Promise<ChatSubagent[]>
  }
  // chat-live-runs.ts
  export interface StoredTurn { question_id: string | null; answer_id: string | null; text: string }
  export interface ChatLiveRun { conversation_id: string; user_id: string; instance_id: string; heartbeat_at: string; released_at: string | null; turns: StoredTurn[]; created_at: string }
  export class ChatLiveRunsRepository {
    save(input: { conversation_id: string; user_id: string; instance_id: string; turns: StoredTurn[] }): Promise<void> // upsert; resets heartbeat_at=now, released_at=null
    heartbeat(instanceId: string): Promise<number>
    release(instanceId: string, turnsByConversation?: Map<string, StoredTurn[]>): Promise<number> // released_at=now for this instance's rows; replaces turns where given
    listResumable(instanceId: string, staleBefore: Date): Promise<ChatLiveRun[]> // instance_id <> me AND (released_at IS NOT NULL OR heartbeat_at < staleBefore)
    claim(conversationId: string, fromInstance: string, toInstance: string, staleBefore: Date): Promise<boolean> // conditional UPDATE (same predicate + instance_id = from); true when 1 row
    delete(conversationId: string, instanceId: string): Promise<void> // only this instance's row
  }
  // chat-actions.ts: InsertPendingInput gains tool_use_id?: string | null; subagent_id?: string | null; ChatAction gains both fields
  setSubagentByToolUse(conversationId: string, toolUseId: string, subagentId: string): Promise<ChatAction[]> // only rows with subagent_id IS NULL; returns updated rows
  // chat.ts
  findMessagesByIds(conversationId: string, ids: string[]): Promise<ChatMessage[]>
  // subagent-view.ts (create in this task; types only + constants)
  export const PANEL_RECENT_MS = 10 * 60 * 1000; export const PANEL_MAX = 20;
  export type SubagentStatus = …  // re-export from stream.ts
  export interface SubagentView { id: string; description: string; subagent_type: string | null; status: SubagentStatus; started_at: string; ended_at: string | null }
  export const toSubagentView = (s: ChatSubagent): SubagentView => ({ id: s.id, description: s.description, subagent_type: s.subagent_type, status: s.status, started_at: s.started_at, ended_at: s.ended_at });
  ```

- [ ] **Step 1: Migration SQL** (`migration.sql`):
```sql
-- TER-301: concierge subagents panel, gate origin and resume after restart. Additive only.
CREATE TABLE "chat_subagents" (
  "id" TEXT NOT NULL,
  "conversation_id" TEXT NOT NULL,
  "task_id" TEXT NOT NULL,
  "tool_use_id" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "subagent_type" TEXT,
  "status" TEXT NOT NULL,
  "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "ended_at" TIMESTAMP(3),
  CONSTRAINT "chat_subagents_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "chat_subagents_conversation_id_task_id_key" ON "chat_subagents"("conversation_id", "task_id");
CREATE INDEX "chat_subagents_conversation_id_started_at_idx" ON "chat_subagents"("conversation_id", "started_at");
ALTER TABLE "chat_subagents" ADD CONSTRAINT "chat_subagents_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "chat_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "chat_live_runs" (
  "conversation_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "instance_id" TEXT NOT NULL,
  "heartbeat_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "released_at" TIMESTAMP(3),
  "turns" JSONB NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "chat_live_runs_pkey" PRIMARY KEY ("conversation_id")
);
CREATE INDEX "chat_live_runs_heartbeat_at_idx" ON "chat_live_runs"("heartbeat_at");
ALTER TABLE "chat_live_runs" ADD CONSTRAINT "chat_live_runs_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "chat_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "chat_actions" ADD COLUMN "tool_use_id" TEXT, ADD COLUMN "subagent_id" TEXT;
CREATE INDEX "chat_actions_conversation_id_tool_use_id_idx" ON "chat_actions"("conversation_id", "tool_use_id");
```
Check the real table name of conversations in `schema.prisma` (`@@map`) and the timestamp type other chat tables use (`TIMESTAMP(3)` vs `TIMESTAMPTZ`), and match them.

- [ ] **Step 2: Write failing db tests.** Use the setup pattern of `chat-grants.db.test.ts` (`describe.skipIf(process.env.TERMHUB_DB_TESTS !== '1')`, user + conversation created in `beforeAll`, deleted in `afterAll`). `chat-subagents.db.test.ts`:
```ts
it('starts once per task and lists running plus recently ended, newest first', async () => {
  const a = await repo.start({ conversation_id: conv, task_id: 't1', tool_use_id: 'u1', description: 'Buscar CI', subagent_type: 'general-purpose' });
  const again = await repo.start({ conversation_id: conv, task_id: 't1', tool_use_id: 'u1', description: 'outro', subagent_type: null });
  expect(again.id).toBe(a.id);
  expect(again.description).toBe('Buscar CI');
  const b = await repo.start({ conversation_id: conv, task_id: 't2', tool_use_id: 'u2', description: 'Abrir aba', subagent_type: null });
  await repo.setStatus(b.id, 'completed');
  const old = await repo.start({ conversation_id: conv, task_id: 't3', tool_use_id: 'u3', description: 'Velho', subagent_type: null });
  await repo.setStatus(old.id, 'failed');
  const later = new Date(Date.now() + PANEL_RECENT_MS + 60_000);
  expect((await repo.listForPanel(conv)).map((s) => s.task_id)).toEqual(['t3', 't2', 't1']);
  expect((await repo.listForPanel(conv, later)).map((s) => s.task_id)).toEqual(['t1']);
});
it('sets ended_at on final states and clears it when back to running', async () => {
  const s = await repo.start({ conversation_id: conv, task_id: 't4', tool_use_id: 'u4', description: 'd', subagent_type: null });
  expect((await repo.setStatus(s.id, 'stopping'))?.ended_at).toBeNull();
  expect((await repo.setStatus(s.id, 'stopped'))?.ended_at).not.toBeNull();
});
it('finds by id only for the owner and interrupts running ones', async () => {
  const s = await repo.start({ conversation_id: conv, task_id: 't5', tool_use_id: 'u5', description: 'd', subagent_type: null });
  expect(await repo.findByIdForUser(s.id, otherUserId)).toBeUndefined();
  expect((await repo.findByIdForUser(s.id, userId))?.id).toBe(s.id);
  const changed = await repo.interruptRunning(conv);
  expect(changed.map((c) => c.id)).toContain(s.id);
  expect(changed.every((c) => c.status === 'interrupted')).toBe(true);
});
```
`chat-live-runs.db.test.ts`:
```ts
it('saves, heartbeats and deletes only its own row', async () => {
  await repo.save({ conversation_id: conv, user_id: userId, instance_id: 'A', turns: [{ question_id: 'q', answer_id: 'a', text: 'oi' }] });
  expect(await repo.heartbeat('A')).toBe(1);
  await repo.delete(conv, 'B');
  expect(await repo.listResumable('B', new Date(Date.now() - 90_000))).toHaveLength(0); // fresh, not released
  await repo.delete(conv, 'A');
  expect(await repo.listResumable('B', new Date(Date.now() + 1000))).toHaveLength(0);
});
it('lists released or stale rows of other instances, and claims exactly once', async () => {
  await repo.save({ conversation_id: conv, user_id: userId, instance_id: 'A', turns: [] });
  expect(await repo.listResumable('A', new Date(Date.now() + 1000))).toHaveLength(0); // never its own
  await repo.release('A', new Map([[conv, [{ question_id: 'q2', answer_id: 'a2', text: 'x' }]]]));
  const [row] = await repo.listResumable('B', new Date(Date.now() - 90_000));
  expect(row.turns).toEqual([{ question_id: 'q2', answer_id: 'a2', text: 'x' }]);
  const staleBefore = new Date(Date.now() - 90_000);
  const results = await Promise.all([repo.claim(conv, 'A', 'B', staleBefore), repo.claim(conv, 'A', 'C', staleBefore)]);
  expect(results.filter(Boolean)).toHaveLength(1);
  await db.chatLiveRun.deleteMany({ where: { conversationId: conv } });
});
it('treats a stale heartbeat as resumable', async () => {
  await repo.save({ conversation_id: conv, user_id: userId, instance_id: 'A', turns: [] });
  await db.chatLiveRun.update({ where: { conversationId: conv }, data: { heartbeatAt: new Date(Date.now() - 120_000) } });
  expect(await repo.listResumable('B', new Date(Date.now() - 90_000))).toHaveLength(1);
});
```
Extend `chat-actions.db.test.ts`: insertPending with `tool_use_id: 'toolu_X'`, then `setSubagentByToolUse(conv, 'toolu_X', 'sa1')` returns 1 row with `subagent_id: 'sa1'`, and a second call returns `[]`. The same tool_use_id in another conversation is not touched. Extend `chat.db.test.ts`: `findMessagesByIds` returns only ids of that conversation.

- [ ] **Step 3: Run** `SCRATCH/check.sh 'npm run prisma:generate >/dev/null && (cd apps/server && npx prisma migrate deploy) && npx vitest run --root apps/server src/db/repositories/chat-subagents.db.test.ts src/db/repositories/chat-live-runs.db.test.ts src/db/repositories/chat-actions.db.test.ts src/db/repositories/chat.db.test.ts'` → FAIL (modules missing).

- [ ] **Step 4: Implement the repositories.** Follow `chat-grants.ts` style (Prisma client, `newId()`, map to snake_case interfaces, ISO strings).
  - `claim` must be a single conditional `updateMany`: `where: { conversationId, instanceId: from, OR: [{ releasedAt: { not: null } }, { heartbeatAt: { lt: staleBefore } }] }`, `data: { instanceId: to, releasedAt: null, heartbeatAt: new Date() }`; return `count === 1`.
  - `start` = `upsert` on the compound unique with `update: {}`.
  - `listForPanel`: `where: { conversationId, OR: [{ status: { in: ['running','stopping'] } }, { endedAt: { gte: new Date(now - PANEL_RECENT_MS) } }] }`, `orderBy: { startedAt: 'desc' }`, `take: PANEL_MAX`.
  - `insertPending`/`insertApproved` pass `toolUseId`/`subagentId`.
  - `setSubagentByToolUse` = `updateManyAndReturn` (Prisma 7) or `updateMany` + `findMany` on the same where.

- [ ] **Step 5: Run** the command of Step 3 → PASS. Drift check: `SCRATCH/check.sh 'cd apps/server && npx prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --shadow-database-url postgresql://postgres:postgres@127.0.0.1:55437/shadow --exit-code'`. Read `.github/workflows/deploy.yml` for the exact flags CI uses, and use those if they differ. Expect exit 0 (or only differences CI also tolerates). Also run `git status` and confirm that `src/generated` has no unrelated diff.

- [ ] **Step 6: Commit** — `git add apps/server/prisma apps/server/src/db/repositories apps/server/src/chat/subagent-view.ts apps/server/src/generated && git commit -m "Chat: tables for concierge subagents and live-run resume"`

---

### Task 3: Gate origin (MCP `_meta` → action row → card)

**Files:**
- Create: `apps/server/src/chat/subagent-origin.ts`, `apps/server/src/chat/subagent-origin.test.ts`
- Modify: `apps/server/src/mcp/route.ts:103-117`, `apps/server/src/chat/gate-runtime.ts` (`GatedCall`, `ask`, `executeGranted`, the `confirmation` publish), `apps/server/src/chat/bus.ts` (`confirmation` gains `subagent: {id: string; description: string} | null`), `apps/server/src/db/repositories/chat-actions-view.ts` (`ChatActionCard.subagent`, resolution in `describeActions`)
- Test: `apps/server/src/mcp/gate.e2e.test.ts` (or `route.test.ts`, whichever already drives `applyGate` through the route with a fake repo), `apps/server/src/db/repositories/chat-actions-view.test.ts`

**Interfaces:**
- Consumes: `ChatAction.tool_use_id/subagent_id`, `ChatSubagentsRepository.listByIds` (Task 2).
- Produces:
  ```ts
  // subagent-origin.ts
  export interface Origin { conversationId: string; subagentId: string }
  export const subagentOrigins: { remember(toolUseId: string, origin: Origin, now?: number): void; originOf(toolUseId: string, now?: number): Origin | undefined; clear(): void };
  export const TOOL_USE_ID = /^[A-Za-z0-9_-]{1,128}$/;
  export function toolUseIdOf(meta: unknown): string | undefined // reads meta['claudecode/toolUseId'], shape-checked
  // gate-runtime.ts
  GatedCall.tool_use_id?: string
  // chat-actions-view.ts
  ChatActionCard.subagent: { id: string; description: string } | null
  ```

- [ ] **Step 1: Failing tests.** `subagent-origin.test.ts`:
```ts
it('remembers and expires after an hour', () => {
  subagentOrigins.clear();
  subagentOrigins.remember('toolu_1', { conversationId: 'c', subagentId: 's' }, 0);
  expect(subagentOrigins.originOf('toolu_1', 1000)).toEqual({ conversationId: 'c', subagentId: 's' });
  expect(subagentOrigins.originOf('toolu_1', 60 * 60 * 1000 + 1)).toBeUndefined();
});
it('keeps at most 5000 entries, oldest out first', () => {
  subagentOrigins.clear();
  for (let i = 0; i < 5001; i++) subagentOrigins.remember(`t${i}`, { conversationId: 'c', subagentId: 's' }, 0);
  expect(subagentOrigins.originOf('t0', 0)).toBeUndefined();
  expect(subagentOrigins.originOf('t5000', 0)).toBeDefined();
});
it('reads the tool-use id from _meta only when it is id-shaped', () => {
  expect(toolUseIdOf({ 'claudecode/toolUseId': 'toolu_01JW' })).toBe('toolu_01JW');
  expect(toolUseIdOf({ 'claudecode/toolUseId': 'a b' })).toBeUndefined();
  expect(toolUseIdOf({ 'claudecode/toolUseId': 'x'.repeat(129) })).toBeUndefined();
  expect(toolUseIdOf(undefined)).toBeUndefined();
});
```
In the gate e2e test (read its harness first; it builds a token and calls the MCP route or `applyGate` directly):
  - a gated `send_input` with `tool_use_id: 'toolu_S'` after `subagentOrigins.remember('toolu_S', { conversationId: <the token's conversation>, subagentId: <a real chat_subagents row id or fake repo id> })` stores `tool_use_id='toolu_S'` and `subagent_id` on the row. The published `confirmation` carries `subagent: { id, description }`.
  - the same with an origin whose `conversationId` is another conversation → `subagent_id` null, `subagent: null`.
  - no `tool_use_id` → both null (today's card).
In `chat-actions-view.test.ts`: an action with `subagent_id` resolves `subagent: {id, description}` from `repos.chatSubagents.listByIds`. One whose subagent row belongs to another conversation resolves `null`. No subagent ids → `listByIds` is not called.

- [ ] **Step 2: Run** `SCRATCH/check.sh 'npx vitest run --root apps/server src/chat/subagent-origin.test.ts src/db/repositories/chat-actions-view.test.ts src/mcp/'` → FAIL.

- [ ] **Step 3: Implement.**
  - `subagent-origin.ts`: a `Map<string, Origin & { at: number }>` (insertion order = age). `remember` deletes then sets, evicts the first key while `size > 5000`. `originOf` drops and returns undefined past `60*60*1000`. `toolUseIdOf(meta)`: `const v = (meta as Record<string, unknown> | undefined)?.['claudecode/toolUseId']; return typeof v === 'string' && TOOL_USE_ID.test(v) ? v : undefined;`.
  - `mcp/route.ts`: widen the handler's `extra` type to `{ signal: AbortSignal; _meta?: unknown }` and pass `tool_use_id: toolUseIdOf(extra._meta)` in the `applyGate` call.
  - `gate-runtime.ts`: add a helper
    ```ts
    /** The subagent that made this call, if the live run saw its tool frame first and it is this conversation's. */
    const originFor = (call: GatedCall, conversationId: string) => {
      if (!call.tool_use_id) return { tool_use_id: null, subagent_id: null };
      const o = subagentOrigins.originOf(call.tool_use_id);
      return { tool_use_id: call.tool_use_id, subagent_id: o && o.conversationId === conversationId ? o.subagentId : null };
    };
    ```
    Spread `...originFor(call, conversationId)` into both `insertPending` and `insertApproved`. Add `subagent: card.subagent` to the `confirmation` publish.
  - `chat-actions-view.ts`: after the existing batched reads,
    `const subIds = [...new Set(actions.map((a) => a.subagent_id).filter((x): x is string => !!x))]; const subs = subIds.length ? await repos.chatSubagents.listByIds(subIds) : []; const subById = new Map(subs.map((s) => [s.id, s]));`
    Then per card: `const sa = action.subagent_id ? subById.get(action.subagent_id) : undefined; subagent: sa && sa.conversation_id === action.conversation_id ? { id: sa.id, description: sa.description } : null`.
  - Fix every place that builds a `ChatActionCard` or `confirmation` by hand (grep `summary:` in `apps/server/src`, including tests/fakes) so the typecheck passes.

- [ ] **Step 4: Run** Step 2's command → PASS, then `SCRATCH/check.sh 'npm run typecheck -w @termhub/server'`.

- [ ] **Step 5: Commit** — `git commit -am "Gate: record which subagent proposed an action"` (add the new files first).

---

### Task 4: LiveRun — subagent registry, cancel line, late origin, silent note, turn hook

**Files:**
- Modify: `apps/server/src/chat/live-run.ts`, `apps/server/src/chat/bus.ts`
- Test: `apps/server/src/chat/live-run.test.ts`

**Interfaces:**
- Consumes: Task 1 frames, Task 2 repos (`chatSubagents`, `chatActions.setSubagentByToolUse`), Task 3 `subagentOrigins`, `describeActions`, `actionClass`.
- Produces:
  ```ts
  // bus.ts new events
  | { type: 'subagent'; user_id: string; conversation_id: string; subagent: SubagentView }
  | { type: 'subagent_cancel_failed'; user_id: string; conversation_id: string; subagent_id: string }
  // live-run.ts
  LiveRunDeps gains:
    subagents: Pick<ChatSubagentsRepository, 'start' | 'setStatus' | 'interruptRunning'>;
    describeLate?: (actions: ChatAction[]) => Promise<void>; // re-publishes confirmation for late-bound actions (ChatService supplies it)
    chatActions: Pick<ChatActionsRepository, 'setSubagentByToolUse'>;
    onTurnsChanged?: (turns: StoredTurn[]) => void;           // fire-and-forget persistence hook
    suspended?: () => boolean;                                // true while ChatService.suspendAll runs
  LiveTurn.question: ChatMessage | null  // null only for a note (never added through add())
  class LiveRun {
    stopTask(taskId: string, subagentId: string): boolean   // false when input closed or write refused
    addNote(text: string): boolean                           // silent line; counted as pending until its replay
    storedTurns(): StoredTurn[]                               // current + waiting, in order (question_id/answer_id/text)
    rollbackStop(subagentId: string): Promise<void>          // stopping → running + subagent_cancel_failed (used by the 30 s timeout in Task 5)
  }
  export const STOP_REQUEST_PREFIX = 'stop-';                 // request_id = `stop-${subagentId}`
  ```

- [ ] **Step 1: Failing tests** (reuse `live-run.test.ts`'s fake stream / fake chat repo helpers; add a fake `subagents` repo that records calls and returns rows, and capture `chatBus` events the way the file already does):
```ts
it('registers a started subagent, updates its status and publishes both', async () => {
  // feed: turn replay, task_started(t1,u1,'Buscar CI'), result, then task_updated completed
  // expect subagents.start called with {task_id:'t1', tool_use_id:'u1', description:'Buscar CI'}
  // expect published 'subagent' events with status 'running' then 'completed'
});
it('interrupts running subagents when the stream ends', async () => {
  // feed task_started, end stream without status → subagents.interruptRunning(conv) called and 'subagent' published with 'interrupted' for each returned row
});
it('remembers the origin of a subagent termhub tool call and binds a late action', async () => {
  // feed task_started(t1,u1) then subagent_tool(parent u1, tool_use_id toolu_B, tool send_input)
  // expect subagentOrigins.originOf('toolu_B') = {conversationId, subagentId}
  // chatActions.setSubagentByToolUse returns [action] → describeLate called with [action]
});
it('does not look up actions for a subagent read tool', async () => {
  // subagent_tool with tool 'list_tabs' → origin remembered, setSubagentByToolUse NOT called
});
it('writes a stop_task control line and marks the row stopping', async () => {
  // with input open: stopTask('t1','sa1') → stream.write called with JSON {type:'control_request', request_id:'stop-sa1', request:{subtype:'stop_task', task_id:'t1'}}
  // subagents.setStatus('sa1','stopping') and 'subagent' published
});
it('refuses to stop once input is closed', async () => { /* after endInputIfIdle → stopTask returns false, no write */ });
it('rolls a failed stop back to running and says so', async () => {
  // control_response {request_id:'stop-sa1', ok:false} → setStatus('sa1','running') + 'subagent_cancel_failed' {subagent_id:'sa1'}
});
it('ignores control responses it did not ask for', async () => { /* request_id 'other' → nothing */ });
it('a note line is pending until its replay and its answer is a message of its own', async () => {
  // addNote('nota') writes a user line with a fresh uuid; endInputIfIdle does not close while pending;
  // replay of that uuid → then text → a new assistant row is created (turn null path); done → finished; then input may close
});
it('reports stored turns on every change', async () => {
  // onTurnsChanged called after add(), after turn_started, after finish; storedTurns() has question_id/answer_id/text
});
it('keeps open turns open when the run ends while suspended', async () => {
  // suspended() → true; stream ends → failOpen is NOT storing RUNNER_FAILED (see Task 6: runLive skips failOpen); here: failOpen not called by consume itself (consume never calls failOpen — assert no updateMessage with error_code)
});
```
Write each body fully in the file's existing style (the comments above say exactly what to feed and assert). Frames are JSON lines as in Task 1's tests.

- [ ] **Step 2: Run** `SCRATCH/check.sh 'npx vitest run --root apps/server src/chat/live-run.test.ts'` → FAIL.

- [ ] **Step 3: Implement** in `live-run.ts`:
  - fields: `private subagentsByTask = new Map<string, ChatSubagent>()`, `private subagentsByToolUse = new Map<string, ChatSubagent>()`, `private notes = new Set<string>()`, `private stopping = new Set<string>()` (subagent ids).
  - in `consume`:
    - `subagent_started` → `const row = await this.deps.subagents.start({...})`; store in both maps; publish `subagent` (`toSubagentView(row)`).
    - `subagent_status` → the row by task. If it is missing, ignore. `setStatus`, `this.stopping.delete(id)`, publish.
    - `subagent_tool` → the row by `parent_tool_use_id`. If it is missing, ignore. Then `subagentOrigins.remember(frame.tool_use_id, { conversationId, subagentId: row.id })`. Only when `actionClass(frame.tool, {}) !== 'read'` (import from `./gate.js`): `const bound = await this.deps.chatActions.setSubagentByToolUse(conv, frame.tool_use_id, row.id); if (bound.length) await this.deps.describeLate?.(bound);`.
    - `control_response` → only `request_id.startsWith(STOP_REQUEST_PREFIX)` with the id in `this.stopping`. If `!ok`, call `rollbackStop(id)`. If ok, nothing (the status frame follows).
    - `turn_started` for a uuid in `this.notes` → `this.notes.delete(uuid)`, finish any current turn as the existing code does for a non-matching path, and leave `current` null so the text goes to `answering()`. Mark `this.replayed = true`.
  - `endInputIfIdle` also requires `this.notes.size === 0`.
  - in the `finally` of `consume`: `const gone = await this.deps.subagents.interruptRunning(this.deps.conversationId).catch(() => [])`, then publish each. Do it before `this.stream = null`, inside a try so a DB error never masks the stream's end.
  - `stopTask(taskId, subagentId)`: if `!this.inputOpen || !this.stream?.write` return false. Write `JSON.stringify({ type: 'control_request', request_id: STOP_REQUEST_PREFIX + subagentId, request: { subtype: 'stop_task', task_id: taskId } })`. If the write returned false, return false. Otherwise `this.stopping.add(subagentId)` and return true. The caller (ChatService) sets the status and publishes (keeps `stopTask` sync).
  - `rollbackStop(id)`: if `this.stopping.delete(id)`, then `setStatus(id,'running')`, publish `subagent` and `subagent_cancel_failed`.
  - `addNote(text)`: like `add` but pushes the uuid into `notes`, not `waiting`. Before the process starts (`this.stream` null) keep it in a `pendingNotes: string[]` that `initialText()` emits **first**.
  - `storedTurns()`: `[...(current?.turn ? [current.turn] : []), ...current?.merged ?? [], ...waiting].map(t => ({ question_id: t.question?.id ?? null, answer_id: t.answer.id, text: t.text }))`. Call `this.deps.onTurnsChanged?.(this.storedTurns())` at the end of `add`, after `turn_started` handling, after `finish`, after `restart`.
  - `LiveTurn.question` becomes nullable. Adjust `restart`/`abandon`/`finish` re-publishing to skip a null question.
  - `bus.ts`: add the two events with doc comments. Import `SubagentView` from `./subagent-view.js`.

- [ ] **Step 4: Run** Step 2's command, then all of `src/chat/` → PASS. Typecheck server.

- [ ] **Step 5: Commit** — `git commit -am "Live run: track subagents, stop them on request, bind late origins"`

---

### Task 5: Service, routes and contract — panel list and cancel

**Files:**
- Modify: `apps/server/src/chat/service.ts`, `apps/server/src/routes/chat.ts`, `apps/server/src/routes/m-chat.ts`, `apps/server/src/chat/concierge-prompt.ts`, `packages/mobile-api/src/events.ts` (+ `src/index.ts` export if needed), `apps/server/src/mobile/events-parity.test.ts`
- Test: `apps/server/src/chat/service.test.ts`, `apps/server/src/routes/chat.test.ts` and the `m-chat` route test (whichever files exist; grep `describe(` for `/actions/:id/decision` to find them), `packages/mobile-api/src/events.test.ts` (or the existing schema test), `apps/server/src/chat/concierge-prompt.test.ts`

**Interfaces:**
- Consumes: Tasks 2–4.
- Produces:
  ```ts
  // ChatService
  subagentsFor(conversationId: string): Promise<SubagentView[]>
  cancelSubagent(user: User, subagentId: string): Promise<SubagentView> // throws notFound (404) foreign/missing; 409 SUBAGENT_NOT_RUNNING; 409 SUBAGENT_GONE
  export const CANCEL_TIMEOUT_MS = 30_000
  // routes: GET / adds `subagents`; POST /subagents/:id/cancel → 202 { subagent }
  // mobile-api
  export const subagentStatusSchema = z.enum(['running','stopping','completed','failed','stopped','interrupted']);
  export const subagentViewSchema = z.object({ id: z.string(), description: z.string(), subagent_type: z.string().nullable(), status: subagentStatusSchema, started_at: z.string(), ended_at: z.string().nullable() });
  export type TSubagentView = z.infer<typeof subagentViewSchema>;
  // chatActionSchema: subagent: z.object({ id: z.string(), description: z.string() }).nullable().optional()
  // chatEventSchema: + { type:'subagent', conversation_id, subagent } and { type:'subagent_cancel_failed', conversation_id, subagent_id }; confirmation gains the same optional `subagent`
  ```

- [ ] **Step 1: Failing tests.** `service.test.ts` (use the file's existing fakes for runner/repos; add fake `chatSubagents`):
  - cancel happy path: a live run with a `task_started` consumed. `cancelSubagent(user, id)` writes the control line (the fake stream records writes), returns `status: 'stopping'`, and publishes `subagent`.
  - cancel foreign id → `HttpError` 404 (`findByIdForUser` undefined).
  - cancel a `completed` row → 409 `SUBAGENT_NOT_RUNNING`.
  - cancel with no live run for the conversation → 409 `SUBAGENT_GONE`, row set to `interrupted`, `subagent` published.
  - cancel timeout: with `vi.useFakeTimers()`, no status after `CANCEL_TIMEOUT_MS` → `subagent_cancel_failed` published and row back to `running`. With a `subagent_status stopped` before the timer → no rollback.
  - `subagentsFor` maps `listForPanel` to views.
  Route tests (web + app): `POST /api/chat/subagents/:id/cancel` → 202 `{subagent}`. Foreign → 404. Id longer than 64 → 400 (zod). `GET /api/chat` includes `subagents: []`. Mirror for `/api/m/v1/chat/subagents/:id/cancel` and the mobile GET.
  mobile-api: `chatEventSchema.parse` accepts the two new events and a `confirmation` with and without `subagent`, and `chatActionSchema` accepts `subagent: null`.
  Parity test: add samples for `subagent` and `subagent_cancel_failed`.
  `concierge-prompt.test.ts`: the prompt mentions `cancel` and `restart` (`expect(ORCHESTRATOR_PROMPT).toMatch(/cancel/i)`, `toMatch(/restart/i)`).

- [ ] **Step 2: Run** `SCRATCH/check.sh 'npm run build:packages >/dev/null && npx vitest run --root apps/server src/chat/service.test.ts src/routes src/mobile/events-parity.test.ts src/chat/concierge-prompt.test.ts && npm test -w @termhub/mobile-api'` (check the package's test script name in `packages/mobile-api/package.json`) → FAIL.

- [ ] **Step 3: Implement.**
  - `ChatService`:
    ```ts
    async subagentsFor(conversationId: string): Promise<SubagentView[]> {
      return (await this.deps.repos.chatSubagents.listForPanel(conversationId)).map(toSubagentView);
    }
    async cancelSubagent(user: User, subagentId: string): Promise<SubagentView> {
      const row = await this.deps.repos.chatSubagents.findByIdForUser(subagentId, user.id);
      if (!row) throw notFound('Subagente não encontrado');
      if (row.status !== 'running') throw new HttpError(409, 'Este subagente não está rodando', 'SUBAGENT_NOT_RUNNING');
      const live = this.live.get(row.conversation_id);
      if (!live || !live.stopTask(row.task_id, row.id)) {
        const gone = await this.deps.repos.chatSubagents.setStatus(row.id, 'interrupted');
        if (gone) chatBus.publish({ type: 'subagent', user_id: user.id, conversation_id: row.conversation_id, subagent: toSubagentView(gone) });
        throw new HttpError(409, 'O processo deste subagente já terminou', 'SUBAGENT_GONE');
      }
      const stopping = (await this.deps.repos.chatSubagents.setStatus(row.id, 'stopping')) ?? row;
      chatBus.publish({ type: 'subagent', user_id: user.id, conversation_id: row.conversation_id, subagent: toSubagentView(stopping) });
      setTimeout(() => void live.rollbackStop(row.id).catch(() => {}), CANCEL_TIMEOUT_MS).unref?.();
      return toSubagentView(stopping);
    }
    ```
    `rollbackStop` is a no-op once the status frame removed the id from `stopping` (Task 4). Pass the new `LiveRunDeps` in `runLive`:
    - `subagents: this.deps.repos.chatSubagents`;
    - `chatActions: this.deps.repos.chatActions`;
    - `describeLate`: `async (rows) => { const cards = await describeActions(this.deps.repos, rows, user.id); for (const c of cards) chatBus.publish({ type: 'confirmation', user_id: user.id, conversation_id: conversation.id, action_id: c.id, tool: c.tool, args: c.args, class: c.class, machine_id: c.machine_id, project_id: c.project_id, tab_id: c.tab_id, summary: c.summary, created_at: c.created_at, subagent: c.subagent }); }`. Publish only rows still `pending`.
  - Routes: add `subagents: await deps.service.subagentsFor(conversation.id)` to both GETs (inside the existing `Promise.all`). Add the POST:
    ```ts
    const subagentIdParam = z.object({ id: z.string().min(1).max(64) });
    app.post('/subagents/:id/cancel', { config: { action: 'create' } }, async (request, reply) => {
      const { id } = subagentIdParam.parse(request.params);
      const subagent = await deps.service.cancelSubagent(request.scope.user, id);
      return reply.code(202).send({ subagent });
    });
    ```
    The mobile route goes in the same place in `m-chat.ts`, following that file's handler style.
  - `concierge-prompt.ts`: append two lines to `ORCHESTRATOR_PROMPT`:
    - `'- The person can cancel a subagent from the chat. Its notification then says it was stopped: acknowledge it in one short sentence and do not relaunch it unless asked.'`
    - `'- A message from the termhub server saying it restarted lists the subagents that were interrupted: relaunch in the background only those still worth doing, then answer the messages that follow.'`
  - mobile-api schemas as in Interfaces. Keep objects non-strict like their neighbours.

- [ ] **Step 4: Run** Step 2's command → PASS, then the server typecheck.

- [ ] **Step 5: Commit** — `git commit -am "Chat: list and cancel concierge subagents (web and app API)"`

---

### Task 6: Resume after restart or deploy

**Files:**
- Create: `apps/server/src/chat/resume.ts`, `apps/server/src/chat/resume.test.ts`
- Modify: `apps/server/src/chat/service.ts`, `apps/server/src/app.ts` (timers + `preClose`)
- Test: `apps/server/src/chat/service.test.ts` (new `describe('resume')`)

**Interfaces:**
- Consumes: `ChatLiveRunsRepository` (Task 2), `LiveRun.addNote/storedTurns/onTurnsChanged/suspended` (Task 4), `chat.findMessagesByIds`, `chatSubagents.interruptRunning`/`listForPanel`.
- Produces:
  ```ts
  // resume.ts
  export const HEARTBEAT_MS = 30_000; export const STALE_MS = 90_000; export const RESUME_WINDOW_MS = 15 * 60 * 1000; export const SWEEP_MS = 30_000;
  export function resumeNote(interrupted: string[], pendingTurns: number): string
  // ChatService
  readonly instanceId: string
  heartbeat(): Promise<void>
  suspendAll(): Promise<void>
  resumeSweep(now?: Date): Promise<void>
  ```

- [ ] **Step 1: Failing tests.** `resume.test.ts`:
```ts
it('names the interrupted subagents and the messages that follow', () => {
  const t = resumeNote(['Buscar CI', 'Abrir aba'], 2);
  expect(t).toContain('O servidor do termhub reiniciou');
  expect(t).toContain('«Buscar CI»');
  expect(t).toContain('«Abrir aba»');
  expect(t).toContain('2 mensagens');
});
it('says nothing about subagents when none were running', () => {
  expect(resumeNote([], 1)).not.toContain('subagente');
});
```
`service.test.ts` — `describe('resume')`, with fakes for `chatLiveRuns` (in-memory, same semantics as Task 2), `chatSubagents`, users (`repos.users.findById`) and a streaming host:
  - a live run saves its row on start and deletes it on a normal end;
  - `suspendAll()` releases the rows with the current turns (queued turns included, text = `runText ?? [attachmentContext(q.attachments), q.text].filter(Boolean).join('\n\n')`), interrupts running subagents, and the run's end then does **not** store `RUNNER_FAILED` on the open answers;
  - `resumeSweep()` on another instance id with a released row and a ready streaming host:
    - claims it;
    - starts a run whose first input line is the note, followed by the open turns, each with a fresh uuid;
    - answers each turn into its existing answer row;
    - skips a turn whose answer already has text or an `error_code`;
  - `resumeSweep()` leaves a row with a fresh heartbeat of another instance alone (blue/green overlap);
  - two services sweeping the same row → only one run starts;
  - a row older than `RESUME_WINDOW_MS` whose host is not ready → its answers get `HOST_GONE` and the row is deleted;
  - a row whose host is not ready inside the window → left in place;
  - a row for a conversation already running on this instance → left in place.

- [ ] **Step 2: Run** `SCRATCH/check.sh 'npx vitest run --root apps/server src/chat/resume.test.ts src/chat/service.test.ts'` → FAIL.

- [ ] **Step 3: Implement.**
  - `resume.ts`:
    ```ts
    export function resumeNote(interrupted: string[], pendingTurns: number): string {
      const subs = interrupted.length
        ? ` Estes subagentes estavam rodando e foram interrompidos: ${interrupted.map((d) => `«${d}»`).join(', ')}. Relance em segundo plano só os que ainda fizerem sentido.`
        : '';
      const turns = pendingTurns > 0 ? ` ${pendingTurns === 1 ? 'A mensagem' : `As ${pendingTurns} mensagens`} a seguir ficaram sem resposta e chegam de novo.` : '';
      return `[termhub] O servidor do termhub reiniciou e o processo desta conversa foi encerrado no meio do trabalho.${subs}${turns}`;
    }
    ```
    Use "2 mensagens" wording in the test consistently with this text (`As 2 mensagens`).
  - `ChatService`:
    - `readonly instanceId = randomUUID()`; `private suspending = false`.
    - In `runLive`, pass `onTurnsChanged: (turns) => void this.deps.repos.chatLiveRuns.save({ conversation_id: conversation.id, user_id: user.id, instance_id: this.instanceId, turns }).catch((e) => console.error('chat: live run not saved', { conversation_id: conversation.id, error: failureLabel(e) }))` and `suspended: () => this.suspending`. Save once right after `live.add` of the initial turns.
    - In `runLive` failure paths: `if (this.suspending) return;` before `live.failOpen(...)` (turns stay open). In `finally`, delete the row (`chatLiveRuns.delete(conversation.id, this.instanceId)`) only when `!this.suspending`.
    - `heartbeat()`: `await this.deps.repos.chatLiveRuns.heartbeat(this.instanceId)`.
    - `suspendAll()`:
      1. set `this.suspending = true`;
      2. build `Map<conversationId, StoredTurn[]>` from each `live.storedTurns()` plus that conversation's queued turns (see test);
      3. write rows for conversations that have queued turns but no live run: `save` then include them;
      4. `release(this.instanceId, map)`;
      5. `interruptRunning` for each conversation in the map.
      It never throws: wrap everything and log labels.
    - `resumeSweep(now = new Date())`:
      ```ts
      const staleBefore = new Date(now.getTime() - STALE_MS);
      for (const row of await repos.chatLiveRuns.listResumable(this.instanceId, staleBefore)) {
        if (this.running.has(row.conversation_id)) continue;
        const age = now.getTime() - Date.parse(row.released_at ?? row.heartbeat_at);
        const user = await repos.users.findById(row.user_id);
        const conversation = user && (await repos.chat.findByIdForUser(row.conversation_id, user.id));
        const host = conversation && conversation.archived_at === null ? await this.hostForConversation(user, conversation) : null;
        const ready = host?.kind === 'ready' && this.streams(host.machine.id);
        if (!ready) {
          if (age > RESUME_WINDOW_MS && (await repos.chatLiveRuns.claim(row.conversation_id, row.instance_id, this.instanceId, staleBefore))) await this.giveUp(row, user);
          continue;
        }
        if (!(await repos.chatLiveRuns.claim(row.conversation_id, row.instance_id, this.instanceId, staleBefore))) continue;
        await this.resume(user, conversation, host, row);
      }
      ```
      Wrap the per-row body in try/catch with a label log, so one bad row never stops the sweep.
    - `giveUp(row, user)`: for each stored turn with an `answer_id`, update the answer with `error_code: 'HOST_GONE'` when it has no text and no error, and publish `message` + `run_finished`. Then `chatLiveRuns.delete`.
    - `resume(user, conversation, host, row)`:
      1. take `this.running`;
      2. `findMessagesByIds` for the question and answer ids, and keep turns whose answer exists with `text === ''` and `error_code === null`;
      3. build `LiveTurn`s (`uuid: randomUUID()`, `settle` from `deferred()` with a `.promise.catch(() => {})`);
      4. `interrupted = (await chatSubagents.listForPanel(conversation.id)).filter(s => s.status === 'interrupted').map(s => s.description)`;
      5. call `runLive(..., turns, { note: resumeNote(interrupted, turns.length) })` (add that optional last parameter; `runLive` calls `live.addNote(note)` **before** adding the turns, so it is written first);
      6. `promptFor` + `streamedSystemPrompt` as `startIn` does.
      Release the lock if anything throws before the hand-off (mirror `startIn`'s `handedOff`).
  - `app.ts` (next to the existing hourly `purge` interval):
    ```ts
    const liveBeat = setInterval(() => void chat.heartbeat().catch(() => {}), HEARTBEAT_MS);
    const resumeTimer = setInterval(() => void chat.resumeSweep().catch(() => {}), SWEEP_MS);
    liveBeat.unref(); resumeTimer.unref();
    setTimeout(() => void chat.resumeSweep().catch(() => {}), 5_000).unref();
    fastify.addHook('preClose', async () => { await chat.suspendAll(); });
    ```
    Clear both intervals in the existing `onClose` hook. The instance is `chat` (`const chat = new ChatService(...)`, `app.ts:164`): use `chat.heartbeat()` etc.

- [ ] **Step 4: Run** Step 2's command → PASS. Then all server tests: `SCRATCH/check.sh 'npm test -w @termhub/server'` and the typecheck.

- [ ] **Step 5: Commit** — `git commit -am "Chat: resume a live concierge run after a restart or deploy"`

---

### Task 7: Web — subagents panel, card origin

**Files:**
- Create: `apps/web/src/components/chat/ChatSubagents.tsx`, `ChatSubagents.test.tsx`, `apps/web/src/lib/subagents.ts` (+ `.test.ts`)
- Modify: `apps/web/src/lib/types.ts` (`ChatAction.subagent?`, `SubagentView`, `ChatEvent` variants), `apps/web/src/lib/api.ts` (`api.chat` response `subagents?`, `api.cancelSubagent(id)`), `apps/web/src/components/chat/ChatPanel.tsx` (state, events, toolbar at L577-586, confirmation merge at L239-246), `ChatActionCard.tsx:45`, `ChatActionGroup.tsx:25`
- Test: `ChatActionCard.test.tsx`, `ChatActionGroup.test.tsx`, `ChatPanel.test.tsx`

**Interfaces:**
- Consumes: the contract from Task 5 (web keeps hand-written copies, no workspace dep).
- Produces:
  ```ts
  // lib/subagents.ts
  export const SUBAGENT_STATUS_LABEL: Record<SubagentStatus, string> = { running: 'rodando', stopping: 'cancelando…', completed: 'concluído', failed: 'falhou', stopped: 'cancelado', interrupted: 'interrompido' };
  export function elapsedLabel(s: SubagentView, now: number): string // 'há 3 min' while running|stopping; 'levou 2 min' once ended; 'menos de 1 min' under 60 s (prefixed the same way: 'há menos de 1 min' / 'levou menos de 1 min')
  export function upsertSubagent(list: SubagentView[], s: SubagentView): SubagentView[] // replace by id or prepend
  export const isActive = (s: SubagentView) => s.status === 'running' || s.status === 'stopping';
  // ChatSubagents props
  { subagents: SubagentView[]; failed: Set<string>; onCancel(id: string): void; now?: number }
  ```

- [ ] **Step 1: Failing tests.**
  `lib/subagents.test.ts`:
  - `elapsedLabel` for running 3 min → `'há 3 min'`;
  - ended after 2 min → `'levou 2 min'`;
  - 20 s → `'há menos de 1 min'`;
  - `upsertSubagent` replaces by id and prepends a new one.

  `ChatSubagents.test.tsx`:
  - renders the description, `'rodando'` and `'há 3 min'`;
  - "Cancelar" only on running lines, and clicking it calls `onCancel(id)`;
  - a `stopping` line shows `'cancelando…'` and no button;
  - an id in `failed` shows `'Não foi possível cancelar'`.

  `ChatActionCard.test.tsx`:
  - with `subagent: {id:'s', description:'Buscar CI'}` it shows `'Pedido pelo subagente «Buscar CI»'`;
  - without it, no such text.

  The same for `ChatActionGroup`.

  `ChatPanel.test.tsx` (use its existing fake socket/api helpers):
  - the GET returns one running subagent → the toolbar shows `'Subagentes (1)'`, and clicking it lists the subagent;
  - a `subagent` event with `completed` → the button disappears when nothing is active (the list may still show the recent row when opened elsewhere; the button shows only with active ones);
  - Cancelar → `api.cancelSubagent` called;
  - a `subagent_cancel_failed` event → the message appears;
  - a repeated `confirmation` event with `subagent` merges it into the existing card (the text appears).

- [ ] **Step 2: Run** `SCRATCH/check.sh 'npx vitest run --root apps/web src/lib/subagents.test.ts src/components/chat'` → FAIL.

- [ ] **Step 3: Implement.**
  - The `ChatSubagents` list uses the same Tailwind tokens as `ChatActionCard`. Each line is `description`, then status · elapsed, then the Cancelar button (`type="button"`, the `aria-label` names the description).
  - A 30 s `setInterval` in `ChatPanel` refreshes `now` only while the panel is open.
  - In `ChatPanel`:
    - `const [subagents, setSubagents] = useState<SubagentView[]>([])` from the GET;
    - `const [cancelFailed, setCancelFailed] = useState<Set<string>>(new Set())`;
    - `onEvent`: `subagent` → `setSubagents((l) => upsertSubagent(l, e.subagent))` and remove its id from `cancelFailed`; `subagent_cancel_failed` → add the id;
    - `confirmation`: when the id exists, `prev.map((a) => a.id === e.action_id && e.subagent ? { ...a, subagent: e.subagent } : a)`;
    - toolbar button `Subagentes ({active.length})` shown when `active.length > 0`, toggling the panel (a popover under the toolbar row);
    - `onCancel` calls `api.cancelSubagent(id)`, and on a 409 refreshes the list via the GET.
  - `ChatActionCard`/`ChatActionGroup`: `{action.subagent && <p className="text-xs text-fg-muted">Pedido pelo subagente «{action.subagent.description}»</p>}`. Match the muted text class the file already uses.
  - Check whether TER-202 (project chat dock) has merged into main at rebase time. If it has, the toolbar may have moved; follow the new location.

- [ ] **Step 4: Run** Step 2's command → PASS, then `SCRATCH/check.sh 'npm test -w @termhub/web && npm run build -w @termhub/web'`.

- [ ] **Step 5: Commit** — `git commit -am "Web chat: subagents panel with cancel and the gate card's origin"`

---

### Task 8: App — subagents sheet, card origin

**Files:**
- Create: `apps/mobile/src/features/chat/view/subagents-sheet.tsx` (+ test), `apps/mobile/src/features/chat/model/subagents.ts` (+ test)
- Modify: `apps/mobile/src/features/chat/model/events.ts` (`applyEvent`: `subagent`, `subagent_cancel_failed`, confirmation merge at L119-121, `actionFromConfirmation` copies `subagent`), `viewmodel/createChatStore.ts` (state `subagents`, `cancelFailed`, action `cancelSubagent`), `view/conversation-screen.tsx:181-188` (header button), `view/action-card.tsx:35`, `view/action-group-card.tsx:30`, `services/api/client.ts` (`cancelSubagent: (id) => POST /api/m/v1/chat/subagents/:id/cancel`), `services/api/contract/local.ts` (`chatResponse.subagents: z.array(subagentViewSchema).default([])`), mock backend `services/api/mock/handlers/chat.ts` + `mock/socket.ts`
- Test: `model/events.test.ts`, `viewmodel/createChatStore.test.ts`, `view/conversation-screen.test.tsx`, action card tests, `services/api/mock/chat.e2e.test.ts`

**Interfaces:**
- Consumes: `subagentViewSchema`, `TSubagentView` and the events from `@termhub/mobile-api` (Task 5).
- Produces: `model/subagents.ts` with the same `SUBAGENT_STATUS_LABEL`, `elapsedLabel`, `upsertSubagent` and `isActive` as the web (same copy). Store: `subagents: TSubagentView[]`, `cancelFailed: string[]`, `cancelSubagent(id: string): Promise<void>`.

- [ ] **Step 1: Failing tests.**
  - `subagents.test.ts`: same cases as the web's `lib/subagents.test.ts`.
  - `events.test.ts`:
    - `subagent` upserts;
    - `subagent_cancel_failed` adds to `cancelFailed`;
    - a later `subagent` for that id removes it;
    - a repeated `confirmation` with `subagent` merges;
    - `actionFromConfirmation` keeps `subagent`.
  - `createChatStore.test.ts`:
    - loading the chat fills `subagents`;
    - `cancelSubagent` calls the client;
    - a 409 reloads.
  - `conversation-screen.test.tsx`:
    - with one running subagent, the header shows `Subagentes (1)`;
    - pressing it opens the sheet with the description, "rodando", and "Cancelar", which calls the store.
  - Card tests: `Pedido pelo subagente «X»`.
  - `chat.e2e.test.ts` (mock backend): cancel round-trip.

- [ ] **Step 2: Run** `SCRATCH/check.sh 'npm test -w @termhub/mobile -- subagents events createChatStore conversation-screen action-card action-group-card chat.e2e'` → FAIL.

- [ ] **Step 3: Implement** following the store and view patterns already in these files. The sheet is the same modal/sheet component the app uses for the trusted-tabs list: find it from the header's trusted-tabs button and reuse its container. The copy is identical to the web's.

- [ ] **Step 4: Run** Step 2's command → PASS, then `SCRATCH/check.sh 'npm test -w @termhub/mobile && npm run typecheck -w @termhub/mobile'`. Use whatever typecheck script the app has, e.g. `npx tsc --noEmit -p apps/mobile`.

- [ ] **Step 5: Commit** — `git commit -am "App chat: subagents sheet with cancel and the gate card's origin"`

---

### Task 9: Verification, smoke, docs

**Files:**
- Modify: `docs/superpowers/specs/2026-09-26-concierge-always-free-design.md` §9 (point the three items to TER-301 and this spec)

- [ ] **Step 1: Full CI-equivalent** in Docker (node:22). Mirror `.github/workflows/deploy.yml`'s `check` job exactly (read it first); at least:
  `SCRATCH/check.sh 'npm run prisma:generate && npm run build:packages && (cd apps/server && npx prisma migrate deploy) && npm test -w @termhub/server && npm run typecheck -w @termhub/server && npm test -w @termhub/agent && npm run typecheck -w @termhub/agent && npm test -w @termhub/web && npm run build -w @termhub/web && npm test -w @termhub/mobile && npm run build -w @termhub/landing'`, plus the migration drift check and the generated-client diff check CI runs.
  Expected: all green. Compare any failure with `origin/main` before calling it pre-existing.
- [ ] **Step 2: Smoke with the real CLI (if the host allows it).**
  - Drive `claude -p --input-format stream-json --output-format stream-json --verbose --replay-user-messages` with one background subagent that sleeps.
  - Send the `stop_task` control line built by `LiveRun.stopTask`.
  - Expect a `control_response` success and a `task_updated`/`task_notification` whose status maps to `stopped`.
  - If the host refuses the probe, or the CLI answers an error, record it on the card (TER-301): the UI then shows "Não foi possível cancelar" (Review Focus 1), and a follow-up card is needed.
- [ ] **Step 3: Update** the old spec's §9 with one line per item → "Done in TER-301, see `2026-09-26-concierge-subagents-panel-design.md`".
- [ ] **Step 4: Commit** — `git commit -am "Spec: point the always-free leftovers to TER-301"`
- [ ] **Step 5: Clean up** — `docker rm -f th-ter301-db` (only this container), after the PR is merged.
