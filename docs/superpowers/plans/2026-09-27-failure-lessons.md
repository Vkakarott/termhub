# Failure lessons Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let what an agent learned fixing an error be found again by the next agent, on any machine of the same person: lessons as `docs/lessons/*.md` in the repository and as fenced blocks in the project note, indexed into TER-95's memory, searchable through `search_memory`, and verified by the person before they are trusted.

**Architecture:** Stacked on TER-95 (`memory_items`, `apps/server/src/memory/`, `control/memory.ts`, the docs sweeper and the `memory` scope). Two new memory kinds (`lesson`, `project_note`), four nullable columns on `memory_items` (verification, hiding, meta), a pure `lessons/` module (file parser, note fences, save merge, secret floor), a locked append/merge path for the project note, the `record_lesson` MCP tool, lesson routes and a "Lições" list on the Memória do chat screen (web + mobile), and the instructions for agents (CLAUDE.md block, `docs/lessons/README.md`, `start_agent` reminder, concierge prompt line).

**Tech Stack:** Fastify + Prisma 6 + Postgres 16 + pgvector, zod, Vitest; `@modelcontextprotocol/sdk`; React (web, Vitest + Testing Library); Expo / React Native (mobile, Jest); `@termhub/agent` + `@termhub/agent-protocol` + `@termhub/machine-ops`.

**Spec:** `docs/superpowers/specs/2026-09-27-failure-lessons-design.md` (decisions D1–D14). Depends on `docs/superpowers/specs/2026-09-26-concierge-memory-mcp-design.md` and its plan `docs/superpowers/plans/2026-09-26-concierge-memory-mcp.md` (TER-95): **do not start before TER-95's implementation branch exists**; branch from it (stacked PR) or from `main` once it merged.

## Global Constraints

- Own worktree and branch (`feat/ter-205-failure-lessons`) created from TER-95's implementation branch or from an up-to-date `origin/main` that contains it. Other tabs merge in parallel; rebase on `origin/main` before pushing.
- Every npm command runs in Docker from the worktree root: `docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/w" -w /w node:22 sh -c '<cmd>'`, then `rm -rf .npm`. Run `npm ci` that way first if `node_modules` is missing. Non-DB server tests need `-e DATABASE_URL=postgresql://x:x@localhost:5432/x`.
- DB tests: throwaway pgvector DB `th-test-db` from `docker/db` on `127.0.0.1:55432` (same commands as TER-57/TER-95 plans), run with `--network host -e TERMHUB_DB_TESTS=1 -e DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55432/termhub`. Never touch production containers (`termhub-*`, `proxy-*`, `*-app-*`).
- Before the last commit: `npm run typecheck -w @termhub/server && npm run build -w @termhub/web && npm run build -w @termhub/landing`, plus the server, web and mobile suites touched.
- Commits in English, imperative subject ≤ 72 chars, ending with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- UI copy in pt-BR; code, comments and identifiers in English; match the surrounding comment style.
- Routes never import Prisma (repositories only); every input validated with zod; chat routes under `guarded('chat', …)`; projects and tabs through `ctx.scoped` / `scoped(repos, request)`.
- Never log symptoms, lesson text, note content, paths or queries: ids, counts and codes only.
- Migrations additive and nullable; the migration name sorts after the newest one on `main` at execution time.
- Lessons are always trust `derived` and never back `answer_tab_question` `mode: "auto"`.
- Web and mobile ship together.
- Limits: `LESSONS_PER_HOUR = 20`; note ≤ 200 000 chars; `symptom` 1–300, `cause`/`fix` 1–2000; tags ≤ 10 × 40 chars; meta strings ≤ 300 chars.
- `@termhub/agent` version bump is the release (CI publishes); never `npm publish` by hand.

## Review Focus

1. **A person's save erasing an agent's lesson** (editor open while `record_lesson` appends) — Task 3 DB test "concurrent append and save keep both".
2. **An agent forging the person's text or a verified lesson** — fences neutralised (Task 2), unclosed fence indexed as the person's text never as a lesson (Task 2), verification tied to the content hash (Task 1).
3. **An old agent** (TER-95's 0.8.0) — `docs/lessons` paths go in their own `docs.read` call, so its refusal loses only lessons (Task 4).
4. **Another person's lessons** — list, verify, forget and search all filter by owner (Tasks 1, 6).

---

### Task 1: Migration and repository (kinds, verification, hiding, meta)

**Files:**
- Modify: `apps/server/prisma/schema.prisma` (`MemoryItem`)
- Create: `apps/server/prisma/migrations/20260927200000_failure_lessons/migration.sql` (bump the timestamp to sort after `main`'s newest)
- Modify: `apps/server/src/db/repositories/memory-items.ts`
- Test: `apps/server/src/db/repositories/memory-items.db.test.ts`

**Interfaces:**
- Consumes: TER-95 `MemoryItemsRepository`, `MemoryItem`, `NewMemoryItem`, `MemoryFilter`.
- Produces:
  ```ts
  export type MemoryKind = 'task' | 'message' | 'action' | 'doc' | 'note' | 'lesson' | 'project_note';
  export interface LessonMeta { evidence: 'observed' | 'fixed' | 'confirmed'; card: string | null; pr: string | null; tags: string[]; agent: string | null; tab_id: string | null; origin: 'file' | 'note'; path: string | null }
  // MemoryItem gains: meta: LessonMeta | null; verified: boolean; verified_at: string | null
  // NewMemoryItem gains: meta?: LessonMeta | null
  setVerified(id: string, ownerId: string, byUserId: string): Promise<boolean>;   // verified_at=now, verified_by, verified_hash=content_hash; only kind 'lesson' chunk 0 of the owner
  clearVerified(id: string, ownerId: string): Promise<boolean>;
  hideSource(id: string, ownerId: string): Promise<boolean>;                      // hidden_hash=content_hash on every chunk of the item's source
  listLessons(ownerId: string, o: { q?: string; projectId?: string; cursor?: string; limit: number }): Promise<{ items: MemoryItem[]; next_cursor: string | null }>; // chunk 0 only, not hidden, newest source_at first
  findLessonForOwner(id: string, ownerId: string): Promise<MemoryItem | null>;
  latestSourceAt(kind: 'project_note', ownerId: string): Promise<Map<string, string>>; // project_id → newest source_at
  countNoteLessonsSince(ownerId: string, since: Date): Promise<number>;           // kind 'lesson', meta.origin 'note', chunk 0, created_at ≥ since
  ```

- [ ] **Step 1: Failing DB tests** in `memory-items.db.test.ts` (seed two users, one project each, reuse the file's helpers):
  - `upsertMany` of a `lesson` with `meta` stores and returns it; `verified` false.
  - `setVerified` → `verified` true; re-upsert with the same text keeps it; re-upsert with a changed text → `verified` false (hash differs) and `verified_at` still set.
  - `setVerified` of another owner's item → false, nothing changed; of a `doc` item → false.
  - `hideSource` → `nearest`, `textSearch` and `listLessons` skip every chunk of that source; a re-upsert with the same content stays hidden; with a new content it comes back.
  - `countNoteLessonsSince` counts only the owner's note lessons after `since`.
  - `listLessons` returns chunk 0 only, filters by `q` (ILIKE title/text), by project, and pages with the cursor.
- [ ] **Step 2: Run — expect FAIL** (`docker run --network host … node:22 sh -c 'npx vitest run --root apps/server src/db/repositories/memory-items.db.test.ts'` with the DB env).
- [ ] **Step 3: Implement.** Migration:
  ```sql
  ALTER TABLE "memory_items" ADD COLUMN "verified_at" TIMESTAMP(3);
  ALTER TABLE "memory_items" ADD COLUMN "verified_by" TEXT;
  ALTER TABLE "memory_items" ADD COLUMN "verified_hash" TEXT;
  ALTER TABLE "memory_items" ADD COLUMN "hidden_hash" TEXT;
  ALTER TABLE "memory_items" ADD COLUMN "meta" JSONB;
  ALTER TABLE "memory_items" ADD CONSTRAINT "memory_items_verified_by_fkey" FOREIGN KEY ("verified_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  ```
  Schema fields with the same names (`verifiedAt DateTime? @map("verified_at")`, `verifiedBy String? @map("verified_by")` + relation `verifier User? @relation("MemoryItemVerifier", …)`, `verifiedHash`, `hiddenHash`, `meta Json?`), and the `kind` doc comment gains `lesson | project_note`. In the repository: the upsert's `ON CONFLICT … DO UPDATE SET` list does **not** touch `verified_*`/`hidden_hash`; it sets `meta = EXCLUDED.meta`. Every read that returns rows to callers (`nearest`, `textSearch`, `listLessons`, `findManyForOwner`) adds `AND (m.hidden_hash IS NULL OR m.hidden_hash <> m.content_hash)`. The mapper computes `verified = verified_at != null && verified_hash === content_hash`. Keep the prisma drift check green: no index on the new columns.
- [ ] **Step 4: Run — expect PASS**, plus `npx prisma migrate diff --from-migrations apps/server/prisma/migrations --to-schema-datamodel apps/server/prisma/schema.prisma --shadow-database-url … --exit-code` as TER-95 does.
- [ ] **Step 5: Commit** `git commit -m "Memory: lesson kinds, verification and hiding on memory items"`

---

### Task 2: Pure lesson helpers

**Files:**
- Create: `apps/server/src/lessons/file.ts`, `apps/server/src/lessons/note.ts`, `apps/server/src/lessons/secrets.ts`
- Test: `apps/server/src/lessons/file.test.ts`, `note.test.ts`, `secrets.test.ts`

**Interfaces:**
- Consumes: `LessonMeta` (Task 1), `chunkMarkdown`, `Chunk` (TER-95 `memory/chunk.ts`), `cleanMemoryText` (TER-95 `memory/text.ts`).
- Produces:
  ```ts
  // file.ts
  export const LESSONS_DIR = 'docs/lessons/';
  export function isLessonPath(path: string): boolean;              // docs/lessons/<name>.md, not README.md
  export interface ParsedLesson { title: string; chunks: Chunk[]; meta: LessonMeta }
  export function parseLessonFile(path: string, md: string): ParsedLesson;
  // note.ts
  export interface NoteLesson { id: string; at: string; tab: string | null; body: string; start: number; end: number }
  export interface NoteSection { index: number; heading: string; text: string }
  export function splitNote(content: string): { sections: NoteSection[]; lessons: NoteLesson[] };
  export function neutralise(s: string): string;                     // '<!--' → '<!‐‐', '-->' → '‐‐>' (U+2010), control/bidi cleaned
  export interface LessonInput { symptom: string; cause: string; fix: string; evidence: LessonMeta['evidence']; card?: string; pr?: string }
  export function renderLessonBlock(id: string, at: Date, tab: string | null, l: LessonInput): string;
  export function appendLessonBlock(content: string, block: string): string;  // under '## Lições', created at the end if missing
  export function removeLessonBlock(content: string, id: string): string;
  export function mergeNoteSave(current: string, submitted: string, baseUpdatedAt: Date): string;
  export function lessonIndexText(body: string): { title: string; text: string }; // "Sintoma/Causa/Correção" from the rendered block
  // secrets.ts
  export function containsSecret(parts: string[]): boolean;
  ```

- [ ] **Step 1: Write the failing tests.**
  ```ts
  // file.test.ts
  import { describe, expect, it } from 'vitest';
  import { isLessonPath, parseLessonFile } from './file.js';

  const md = `---
  symptom: "P3009: migrate found failed migrations"
  tags: [prisma, deploy]
  evidence: fixed
  card: TER-57
  pr: https://github.com/engenhariainversa/termhub/pull/169
  agent: claude
  date: 2026-09-26
  ---
  ## Cause
  The migration failed half-way in prod.

  ## Fix
  prisma migrate resolve --rolled-back, then redeploy.
  `;

  describe('lesson files', () => {
    it('recognises lesson paths and skips the README', () => {
      expect(isLessonPath('docs/lessons/2026-09-26-p3009.md')).toBe(true);
      expect(isLessonPath('docs/lessons/README.md')).toBe(false);
      expect(isLessonPath('docs/lessons/sub/x.md')).toBe(false);
      expect(isLessonPath('docs/superpowers/specs/a.md')).toBe(false);
    });
    it('reads the front matter into meta and titles the lesson with the symptom', () => {
      const l = parseLessonFile('docs/lessons/2026-09-26-p3009.md', md);
      expect(l.title).toBe('P3009: migrate found failed migrations');
      expect(l.meta).toEqual({ evidence: 'fixed', card: 'TER-57', pr: 'https://github.com/engenhariainversa/termhub/pull/169', tags: ['prisma', 'deploy'], agent: 'claude', tab_id: null, origin: 'file', path: 'docs/lessons/2026-09-26-p3009.md' });
      expect(l.chunks.map((c) => c.text).join('\n')).toContain('migrate resolve');
      expect(l.chunks.every((c) => !c.text.includes('symptom:'))).toBe(true);
    });
    it('falls back to the path and default evidence without front matter, and caps values', () => {
      const l = parseLessonFile('docs/lessons/x.md', `## Fix\nDo it.\n`);
      expect(l.title).toBe('docs/lessons/x.md');
      expect(l.meta.evidence).toBe('observed');
      const long = parseLessonFile('docs/lessons/y.md', `---\nsymptom: ${'a'.repeat(400)}\ntags: [${Array.from({ length: 15 }, (_, i) => 't' + i).join(', ')}]\nevidence: bogus\n---\nx`);
      expect(long.title.length).toBe(300);
      expect(long.meta.tags).toHaveLength(10);
      expect(long.meta.evidence).toBe('observed');
    });
  });
  ```
  ```ts
  // note.test.ts
  import { describe, expect, it } from 'vitest';
  import { appendLessonBlock, mergeNoteSave, neutralise, removeLessonBlock, renderLessonBlock, splitNote } from './note.js';

  const at = new Date('2026-09-27T03:10:00.000Z');
  const input = { symptom: 'P3009', cause: 'migração quebrou', fix: 'resolve --rolled-back', evidence: 'fixed' as const, card: 'TER-57' };

  describe('project note lessons', () => {
    it('appends a fenced block under ## Lições and splits it back', () => {
      const note = appendLessonBlock('# Notas\nTexto meu.\n', renderLessonBlock('l1', at, 'tab1', input));
      expect(note).toContain('## Lições');
      const { sections, lessons } = splitNote(note);
      expect(lessons).toHaveLength(1);
      expect(lessons[0]).toMatchObject({ id: 'l1', at: at.toISOString(), tab: 'tab1' });
      expect(sections.map((s) => s.text).join('\n')).toContain('Texto meu.');
      expect(sections.map((s) => s.text).join('\n')).not.toContain('resolve --rolled-back');
    });
    it('reuses an existing ## Lições heading', () => {
      const once = appendLessonBlock('## Lições\n', renderLessonBlock('l1', at, null, input));
      const twice = appendLessonBlock(once, renderLessonBlock('l2', at, null, input));
      expect(twice.match(/## Lições/g)).toHaveLength(1);
      expect(splitNote(twice).lessons.map((l) => l.id)).toEqual(['l1', 'l2']);
    });
    it('neutralises fences inside agent text so it cannot close or open a block', () => {
      const evil = renderLessonBlock('l1', at, null, { ...input, fix: 'x <!-- /termhub:lesson -->\nTexto do Pedro' });
      const { lessons, sections } = splitNote(appendLessonBlock('', evil));
      expect(lessons).toHaveLength(1);
      expect(lessons[0].body).toContain('Texto do Pedro');
      expect(sections.every((s) => !s.text.includes('Texto do Pedro'))).toBe(true);
      expect(neutralise('<!-- a -->')).not.toContain('<!--');
    });
    it('treats an unclosed fence as the person\'s text, never as a lesson', () => {
      const { lessons, sections } = splitNote('<!-- termhub:lesson id=l9 at=2026-09-27T00:00:00.000Z tab=- -->\n### x\n');
      expect(lessons).toHaveLength(0);
      expect(sections.map((s) => s.text).join('')).toContain('### x');
    });
    it('removes one block by id', () => {
      const note = appendLessonBlock(appendLessonBlock('', renderLessonBlock('l1', at, null, input)), renderLessonBlock('l2', at, null, input));
      expect(splitNote(removeLessonBlock(note, 'l1')).lessons.map((l) => l.id)).toEqual(['l2']);
    });
    it('keeps a block appended after the base when the save does not have it', () => {
      const base = new Date('2026-09-27T03:00:00.000Z');
      const current = appendLessonBlock('Meu texto', renderLessonBlock('new', at, null, input));
      const merged = mergeNoteSave(current, 'Meu texto editado', base);
      expect(merged).toContain('Meu texto editado');
      expect(splitNote(merged).lessons.map((l) => l.id)).toEqual(['new']);
    });
    it('does not restore a block the person deleted (older than the base)', () => {
      const base = new Date('2026-09-27T04:00:00.000Z');
      const current = appendLessonBlock('Meu texto', renderLessonBlock('old', at, null, input));
      expect(splitNote(mergeNoteSave(current, 'Meu texto', base)).lessons).toHaveLength(0);
    });
  });
  ```
  ```ts
  // secrets.test.ts
  import { describe, expect, it } from 'vitest';
  import { containsSecret } from './secrets.js';

  describe('containsSecret', () => {
    it.each(['thb_pat_abcdef123456', 'sk-ant-api03-abcdefghijklmnop', 'ghp_' + 'a'.repeat(36), 'github_pat_11ABCDEFG', 'AKIAABCDEFGHIJKLMNOP', '-----BEGIN OPENSSH PRIVATE KEY-----'])('flags %s', (s) => {
      expect(containsSecret(['ok', `valor ${s} aqui`])).toBe(true);
    });
    it('lets ordinary text through', () => {
      expect(containsSecret(['Rode prisma migrate resolve', 'sk é abreviação', 'task-12'])).toBe(false);
    });
  });
  ```
- [ ] **Step 2: Run — expect FAIL** (`npx vitest run --root apps/server src/lessons`).
- [ ] **Step 3: Implement.** Key shapes:
  ```ts
  // note.ts
  const OPEN = /^<!-- termhub:lesson id=([a-z0-9_]{1,40}) at=(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z) tab=([a-z0-9]{1,64}|-) -->$/;
  const CLOSE = '<!-- /termhub:lesson -->';
  const EVIDENCE_PT = { observed: 'observada', fixed: 'corrigida', confirmed: 'confirmada' } as const;

  export function renderLessonBlock(id: string, at: Date, tab: string | null, l: LessonInput): string {
    const line = (s: string) => neutralise(s).replace(/\n+/g, ' ');
    const evidence = [EVIDENCE_PT[l.evidence], l.card, l.pr].filter(Boolean).map((s) => line(s!)).join(' · ');
    return [
      `<!-- termhub:lesson id=${id} at=${at.toISOString()} tab=${tab ?? '-'} -->`,
      `### ${line(l.symptom)}`,
      `- **Causa:** ${line(l.cause)}`,
      `- **Correção:** ${line(l.fix)}`,
      `- **Evidência:** ${evidence}`,
      CLOSE,
    ].join('\n');
  }
  ```
  `splitNote` walks lines: a line matching `OPEN` starts a block only if a `CLOSE` line follows before the next `OPEN`; otherwise the line stays in the person's text. Person text (with the blocks removed) goes through `chunkMarkdown('Notas do projeto', text)` for `sections`. `mergeNoteSave(current, submitted, base)`: `const keep = splitNote(current).lessons.filter((l) => new Date(l.at) > base && !submitted.includes(`id=${l.id} `))`, then `keep.reduce((c, l) => appendLessonBlock(c, current.slice(l.start, l.end)), submitted)`. `containsSecret` uses `/thb_pat_[A-Za-z0-9]{8,}|sk-[A-Za-z0-9-]{16,}|ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{8,}|AKIA[A-Z0-9]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----/`.
- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit** `git commit -m "Lessons: parse lesson files, fence note blocks, merge note saves"`

---

### Task 3: Project note — locked append, merged save, block removal

**Files:**
- Modify: `apps/server/src/db/repositories/notes.ts`, `apps/server/src/routes/notes.ts`
- Test: `apps/server/src/db/repositories/notes.db.test.ts` (create), `apps/server/src/routes/notes.test.ts` (create or extend)

**Interfaces:**
- Consumes: `appendLessonBlock`, `removeLessonBlock`, `mergeNoteSave` (Task 2).
- Produces:
  ```ts
  export const NOTE_MAX = 200_000;
  export class NoteTooLargeError extends Error {}
  // NotesRepository
  appendBlock(projectId: string, block: string): Promise<Note>;                      // SELECT … FOR UPDATE, append, NOTE_MAX check
  saveMerged(projectId: string, content: string, baseUpdatedAt: Date | null): Promise<Note>; // base null → plain upsert (old clients)
  removeBlock(projectId: string, lessonId: string): Promise<Note | null>;
  ```

- [ ] **Step 1: Failing tests.** DB: `appendBlock` on a project without a note creates it; two concurrent `appendBlock` calls keep both blocks; `appendBlock` + `saveMerged(content without the block, base = before the append)` keeps the block and the new text; `saveMerged` with `base` after a block's `at` drops the block the person deleted; `appendBlock` past 200 000 chars throws `NoteTooLargeError`. Route: `PUT /projects/:id/note` with `base_updated_at` calls `saveMerged` and returns the merged note; without it behaves as today; a bad date → 400.
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement.** Lock inside `this.db.$transaction(async (tx) => { await tx.$executeRaw`INSERT INTO notes (id, project_id, content, updated_at) VALUES (${newId()}, ${projectId}, '', now()) ON CONFLICT (project_id) DO NOTHING`; const [row] = await tx.$queryRaw<…>`SELECT id, content FROM notes WHERE project_id = ${projectId} FOR UPDATE`; … tx.note.update(…) })`. The route body becomes `z.object({ content: z.string().max(NOTE_MAX), base_updated_at: z.string().datetime().optional() })`; after saving, `void indexProjectNote(...)` is wired in Task 4.
- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit** `git commit -m "Notes: locked lesson append and merged saves"`

---

### Task 4: Indexing — note, lesson files, agent scan of docs/lessons

**Files:**
- Create: `apps/server/src/memory/note.ts` (+ `note.test.ts`)
- Modify: `apps/server/src/memory/docs.ts` (+ test), `apps/server/src/memory/sweeper.ts` (+ test), `apps/server/src/routes/notes.ts` (index after save)
- Modify: `packages/agent-protocol/src/rpc.ts` (+ test: `docPath` accepts `docs/lessons/<name>.md`), `packages/machine-ops/src/docs-script.ts` (+ test: scan lists `docs/lessons/*.md`), `apps/agent/package.json` (patch bump over TER-95's version, e.g. `0.8.1`)

**Interfaces:**
- Consumes: Tasks 1–3; TER-95 `indexDocsForLink`, `MemoryDeps`, `DocsExec`.
- Produces:
  ```ts
  export function indexProjectNote(repos: Repositories, projectId: string, deps: MemoryDeps): Promise<{ sections: number; lessons: number }>; // never throws
  ```

- [ ] **Step 1: Failing tests.**
  - `note.test.ts`: a note with text and two blocks → upserts `project_note` items (trust `person`, `source_id` `note:<pid>`, chunk per section) and two `lesson` items (trust `derived`, `source_id` `note:<pid>:<lessonId>`, `meta.origin 'note'`, `meta.tab_id`, title = symptom); a block removed since the last run → `deleteBySource('lesson', …)`; fewer sections → `deleteChunksFrom('project_note', 'note:<pid>', n)`; a failing repo → resolves, logs `{ projectId, code }` only.
  - `docs.test.ts`: scan lists `docs/lessons/a.md` and `docs/superpowers/specs/s.md` → two `read` calls (lessons separate); the lesson becomes `kind 'lesson'` with `meta.origin 'file'` and `path`; `read` rejecting only for the lessons call (old agent) → specs still indexed, lessons untouched (no deletion).
  - `sweeper.test.ts`: a project whose note `updated_at` is newer than `latestSourceAt('project_note')` is re-indexed.
  - `docs-script.test.ts`: `docs/lessons/x.md` listed, `docs/lessons/sub/y.md` not; `rpc.test.ts`: `docs/lessons/../x.md` refused.
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement.** In `docs.ts`, partition changed paths by `isLessonPath`; specs/plans keep TER-95's path; lessons use `parseLessonFile` → items `{ kind: 'lesson', trust: 'derived', title, text: chunk.text, meta, source_hash: sha }`. `docs/lessons/README.md` is never requested. In `routes/notes.ts` after `saveMerged`: `void indexProjectNote(repos, id, memoryDeps)`.
- [ ] **Step 4: Run — expect PASS** (server, `packages/agent-protocol`, `packages/machine-ops`, `apps/agent` suites).
- [ ] **Step 5: Commit** `git commit -m "Memory: index project notes and docs/lessons files"`

---

### Task 5: MCP — `record_lesson`, gate, `search_memory` for lessons

**Files:**
- Create: `apps/server/src/control/lessons.ts` (+ `lessons.test.ts`)
- Modify: `apps/server/src/mcp/tools.ts`, `apps/server/src/chat/gate.ts` (+ test), `apps/server/src/control/memory.ts` (`MEMORY_REF`, kinds, lesson fields) (+ test), `apps/server/src/mcp/tools.test.ts`

**Interfaces:**
- Consumes: Tasks 1–4; TER-95 `searchMemory`, `MemoryResult`, `selfMediatedTools`.
- Produces:
  ```ts
  export const LESSONS_PER_HOUR = 20;
  export function recordLesson(ctx: ControlContext, a: { project_id: string; symptom: string; cause: string; fix: string; evidence?: 'observed' | 'fixed' | 'confirmed'; card?: string; pr?: string; tab_id?: string }, deps?: MemoryDeps): Promise<{ lesson_id: string; ref: string }>;
  // MemoryResult gains for kind 'lesson': verified: boolean; evidence: string; origin: 'file' | 'note'; path: string | null; tab_id: string | null; card: string | null; pr: string | null
  // MEMORY_REF = /^(decision|task|message|action|doc|note|lesson|project_note):[a-z0-9]{1,64}$/
  ```

- [ ] **Step 1: Failing tests.** `lessons.test.ts`: project through `ctx.scoped.project` (foreign → 404); `tab_id` through `ctx.scoped.tab` and must belong to the project (`ControlError('TAB_OTHER_PROJECT', …)`); a secret in any field → `ControlError('LESSON_SECRET', 'A lição parece conter um segredo (token ou chave); tire-o e tente de novo')`, nothing written; the 21st lesson in an hour → `ControlError('LESSONS_RATE_LIMITED', 'Limite de 20 lições por hora atingido; tente mais tarde')` (`memoryItems.countNoteLessonsSince(owner, now − 1 h)`); a full note → `ControlError('NOTE_FULL', 'A anotação do projeto chegou ao limite de 200 000 caracteres')`; success appends via `notes.appendBlock`, calls `indexProjectNote`, returns `{ lesson_id, ref: 'lesson:<item id>' }`. `gate.test.ts`: `actionClass('record_lesson', {})` is `'self_mediated'`. `tools.test.ts`: `record_lesson` listed only with scope `memory` and grant `notes:update`. `memory.test.ts`: `kinds: ['lesson']` searches only lessons; a lesson result carries `verified`/`evidence`/`origin`.
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement.** Tool entry:
  ```ts
  {
    name: 'record_lesson',
    description:
      'Record a failure lesson in the project note: the error symptom (its literal signature), the cause and the fix, with evidence (observed, fixed or confirmed) and optionally the card ref and PR. Use it after fixing an error that was not obvious, so the next agent on any machine finds it with search_memory (kinds ["lesson"]). If you can commit to the repository, prefer a docs/lessons/*.md file in the same PR (format in docs/lessons/README.md). Never include secrets, tokens or customer data. The lesson stays unverified until the person verifies it. Max 20 per hour.',
    scope: 'memory', resource: 'notes', action: 'update',
    input: { project_id: id, symptom: z.string().trim().min(1).max(300), cause: z.string().trim().min(1).max(2000), fix: z.string().trim().min(1).max(2000), evidence: z.enum(['observed', 'fixed', 'confirmed']).optional(), card: z.string().regex(/^[A-Z][A-Z0-9]{0,9}-\d{1,6}$/).optional(), pr: z.string().url().max(300).optional(), tab_id: id.optional() },
    run: (ctx, a) => recordLesson(ctx, a as Parameters<typeof recordLesson>[1]),
  },
  ```
  `gate.ts`: add `'record_lesson'` to `selfMediatedTools` with a comment line ("writes an unverified, visible block the person can forget — spec TER-205 D11"). `search_memory`'s description gains the lessons sentence from the spec §5 and its `kinds` enum gains `lesson`, `project_note`.
- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit** `git commit -m "MCP: record_lesson and lessons in search_memory"`

---

### Task 6: Lessons HTTP API and mobile contracts

**Files:**
- Modify: `apps/server/src/routes/chat-memory.ts` (+ test)
- Modify: `packages/mobile-api/src/chat.ts` (+ its test if present)

**Interfaces:**
- Produces:
  ```ts
  // packages/mobile-api
  export const lessonItemSchema = z.object({ id: z.string(), project: z.object({ id: z.string(), name: z.string() }).nullable(), title: z.string(), excerpt: z.string(), origin: z.enum(['file', 'note']), path: z.string().nullable(), tab_id: z.string().nullable(), card: z.string().nullable(), pr: z.string().nullable(), evidence: z.enum(['observed', 'fixed', 'confirmed']), verified: z.boolean(), verified_at: z.string().nullable(), created_at: z.string() });
  export const lessonListSchema = z.object({ lessons: z.array(lessonItemSchema), next_cursor: z.string().nullable() });
  export const lessonForgetSchema = z.object({ ok: z.literal(true), note: z.string().optional() });
  ```
  Routes (both mounts): `GET /lessons` (chat:read), `POST /lessons/:id/verify` and `DELETE /lessons/:id/verify` (chat:update), `DELETE /lessons/:id` (chat:delete).

- [ ] **Step 1: Failing tests.** List only the requester's lessons with `q`, `project_id` (checked through `scoped(repos, request).project`) and cursor; verify/unverify another user's id → 404; forget a note lesson → `notes.removeBlock` then `deleteBySource('lesson', …)`; forget a file lesson → `hideSource` and `note: 'O arquivo continua no repositório; apague-o por um PR para sumir de vez'`; the mobile mount returns the same shapes (parse with the contract schemas).
- [ ] **Step 2: Run — expect FAIL.** **Step 3: Implement** following the existing decisions routes in the same file. **Step 4: PASS.**
- [ ] **Step 5: Commit** `git commit -m "Chat memory: lessons list, verify and forget (web and mobile API)"`

---

### Task 7: Web — Lições on the memory page, NotesEditor merge

**Files:**
- Modify: `apps/web/src/pages/ChatMemoryPage.tsx` (+ test), `apps/web/src/lib/api.ts`, `apps/web/src/lib/types.ts`, `apps/web/src/components/NotesEditor.tsx` (+ test)

- [ ] **Step 1: Failing tests.** Memory page: renders a "Lições" section with symptom, project, origin ("arquivo docs/lessons/…" / "anotação do projeto"), evidence and a "verificada" badge; "Verificar" calls `api.chat.lessons.verify(id)` and flips the badge; "Desfazer verificação" calls `unverify`; "Esquecer" asks "Esquecer esta lição?" and removes the row, showing the server's `note` when present; the search box filters. NotesEditor: `save` sends `base_updated_at`; when the response content differs from what was sent and nothing was typed since, the textarea shows the server content and the status line says "lição adicionada por um agente"; typed text since the request is never overwritten.
- [ ] **Step 2: Run — expect FAIL** (`npx vitest run --root apps/web src/pages/ChatMemoryPage.test.tsx src/components/NotesEditor.test.tsx`).
- [ ] **Step 3: Implement.** `api.notes.save(projectId, content, baseUpdatedAt?)`; `api.chat.lessons = { list, verify, unverify, forget }`. The keep-alive save on unload also sends `base_updated_at`.
- [ ] **Step 4: Run — expect PASS**, then `npm run build -w @termhub/web`.
- [ ] **Step 5: Commit** `git commit -m "Web: lessons on the memory page, notes keep agent lessons"`

---

### Task 8: Mobile — Lições on the memory screen

**Files:**
- Modify: `apps/mobile/src/features/chat/view/chat-memory-screen.tsx`, `apps/mobile/src/features/chat/viewmodel/createChatMemoryStore.ts`, `apps/mobile/src/services/api/client.ts`, the mock handlers in `apps/mobile/src/services/api/mock/handlers/chat.ts` (+ tests next to each)

- [ ] **Step 1: Failing tests.** Store: loads lessons, verify/unverify update the item, forget removes it and exposes the server note; screen: the "Lições" section, the badge, the three actions (forget behind an `Alert` confirm), empty state "Nenhuma lição ainda".
- [ ] **Step 2: Run — expect FAIL** (mobile Jest via the workspace test script). **Step 3: Implement** mirroring the decisions list in the same store/screen. **Step 4: PASS.**
- [ ] **Step 5: Commit** `git commit -m "Mobile: lessons on the chat memory screen"`

---

### Task 9: Instructions for agents

**Files:**
- Modify: `apps/server/src/control/agents.ts` (+ test), `apps/server/src/chat/concierge-prompt.ts` (+ test), `CLAUDE.md`
- Create: `docs/lessons/README.md`, `docs/lessons/2026-09-26-p3009-failed-migration.md`

**Interfaces:**
- Produces: `export const LESSONS_REMINDER = 'Antes de depurar um erro, procure em docs/lessons/ e nas lições do projeto; ao resolver um erro que não era óbvio, registre uma lição (formato em docs/lessons/README.md).';` and `export function withLessonsReminder(prompt: string): string` (`${prompt}\n\n${LESSONS_REMINDER}`).

- [ ] **Step 1: Failing tests.** `startAgent` types a launch line whose prompt ends with the reminder; a prompt that fits alone but not with the reminder is refused with the existing too-long error; `resumeLine` does not add it (a resumed session already had it). Concierge prompt: the Memória block contains `kinds: ["lesson"]` and stays within the 4000-char budget test TER-95 added.
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement.** In `startAgent`, `const prompt = withLessonsReminder(checkPrompt(a.prompt))` then `checkPrompt(prompt)` again (the limit counts the reminder). Concierge line (pt-BR, like the block): "Se uma aba travar num erro, procure lições (search_memory com kinds [\"lesson\"]) e passe à aba as verificadas; depois que uma aba corrigir um erro não óbvio, registre a lição com record_lesson se ela não tiver escrito uma." `CLAUDE.md` gains the "Failure lessons" section from spec §8. `docs/lessons/README.md`: the format of spec D4 and the rules (one lesson per file, literal symptom, no secrets). The example lesson: TER-57's P3009 (a failed migration blocks the deploy; `prisma migrate resolve --rolled-back`; check with `docker ps --filter name=termhub-app` healthy) with `card: TER-57`.
- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit** `git commit -m "Lessons: tell agents where lessons live and how to write one"`

---

### Task 10: Verification and spec adjustments

- [ ] **Step 1:** Full checks (Global Constraints command), server unit + DB suites against `th-test-db`, web and mobile suites, `packages/*` suites, the prisma drift check.
- [ ] **Step 2: Smoke** with throwaway containers (`th-test-db`, `th-embed-test`): seed a user and project; call `/mcp` with a personal token (`read`, `memory`) → `record_lesson` → the note has the block; `search_memory` `{ query: "P3009", kinds: ["lesson"] }` → the lesson with `verified: false`; `POST /api/chat/lessons/:id/verify` → search shows `verified: true`; `PUT` the note without the block and with an older `base_updated_at` → the block stays. Remove the `th-*` containers.
- [ ] **Step 3:** Add "§12 Adjustments found while implementing" to the spec with every deviation.
- [ ] **Step 4: Commit** `git commit -m "Docs: failure lessons adjustments after implementation"`
