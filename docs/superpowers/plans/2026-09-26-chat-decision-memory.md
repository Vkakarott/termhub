# Chat decision memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each question of a tab's `AskUserQuestion` answered from the chat becomes a decision with an embedding, and a similar question later opens its card with the past answer pre-selected (suggest only, never auto-send), with a "Memória do chat" screen on web and mobile.

**Architecture:** A local `embed` container (fastembed) turns text into 384-d vectors; `chat_decisions` stores them in Postgres with pgvector (HNSW, cosine). `openTabQuestion` asks `suggestFor` before publishing a card and stores the result in `tab_questions.suggestion`; `answerTabQuestion` calls `recordDecisions` after the keys went through; a sweeper backfills and embeds. Everything memory-related is best effort: no embedder, a slow embedder or a DB error leaves today's behaviour untouched.

**Tech Stack:** Fastify + Prisma 6 (`@prisma/adapter-pg`) + Postgres 16 + pgvector, zod, Vitest; React (web, Vitest + Testing Library); Expo / React Native (mobile, Jest); Python 3.12 + fastembed (embed service).

**Spec:** `docs/superpowers/specs/2026-09-26-chat-decision-memory-design.md`

## Global Constraints

- Work only in `/home/pedrogoiania/termhub-wt-decision-memory` (branch `feat/chat-decision-memory`). No push, no merge, no deploy. Never touch a production container (`termhub-*`, `proxy-*`, `*-app-*`); throwaway containers are named `th-<something>`.
- The host has no Node: every npm command runs in Docker:
  `docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/w" -w /w node:20 sh -c '<cmd>'` from the worktree root, then `rm -rf .npm`. If `node_modules` is missing, run `npm ci` that way first.
- Non-DB server tests need `DATABASE_URL` set (any value): prefix `DATABASE_URL=postgresql://x:x@localhost:5432/x` with `-e`.
- Commit messages in English, imperative subject ≤ 72 chars, ending with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- UI copy in pt-BR; code, comments, identifiers in English. Match the surrounding comment density and idiom.
- Routes never import Prisma; go through `apps/server/src/db/repositories`. Every request input validated with zod. Chat routes are under `guarded('chat', …)`.
- Never log question/answer text or vectors: only ids, counts, similarity numbers, codes.
- Migrations additive and backward compatible with the previous release.
- Only `choice` tab questions are remembered or suggested; never `permission` nor `suggestion` rows.
- Nothing is ever sent to a tab without the user's click.
- Threshold default `0.85` cosine similarity (`DECISION_SUGGEST_THRESHOLD`), k = 5 neighbours, embed timeout 2 s, sweeper every 10 min, batches of 32, embed texts ≤ 32 per request and ≤ 2000 chars each.
- Embedding model `sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2`, 384 dimensions.

## Review Focus

1. **Embedder down, slow or misconfigured while a question opens** — the card must still appear at once without a suggestion (Task 4 test "publishes without suggestion when the embedder hangs").
2. **Past answer whose label no longer exists in the new question's options** — no pre-selection from that decision; fall through to the next candidate (Task 3 `mapAnswer` tests, Task 4 "skips a candidate that does not map").
3. **Recording must never turn a successful answer into an error, and must not record a failed send or a permission** (Task 5 tests).
4. **Another user's decisions** — never suggested, listed or deletable across users (Task 1 DB test on `nearest`/`deleteForUser`, Task 6 route tests).
5. **A card whose suggested decision was already forgotten** — "Esquecer" answers 204 and the card simply clears the line (Task 6 delete idempotency, Tasks 7/8 UI).

---

### Task 1: pgvector DB image, migration and `ChatDecisionsRepository`

**Files:**
- Create: `docker/db/Dockerfile`
- Modify: `docker-compose.yml` (service `db`), `.github/workflows/deploy.yml` (check job's `services.postgres.image`)
- Modify: `apps/server/prisma/schema.prisma` (new model `ChatDecision`, `TabQuestion.suggestion`, `User.chatSuggestions`, relations)
- Create: `apps/server/prisma/migrations/20260926120000_chat_decisions/migration.sql`
- Create: `apps/server/src/db/repositories/chat-decisions.ts`
- Modify: `apps/server/src/db/repositories/index.ts` (register `chatDecisions`)
- Modify: `apps/server/src/db/repositories/users.ts` (`chatSuggestions`, `setChatSuggestions`)
- Test: `apps/server/src/db/repositories/chat-decisions.db.test.ts`

**Interfaces:**
- Produces (`chat-decisions.ts`):
  ```ts
  export interface DecisionOption { label: string; description: string }
  export interface DecisionAnswer { labels: string[]; text?: string }
  export interface ChatDecision {
    id: string; user_id: string; project_id: string | null; project_name: string | null;
    conversation_id: string | null; tab_question_id: string | null; question_index: number;
    header: string; question: string; options: DecisionOption[]; multi_select: boolean;
    answer: DecisionAnswer; embed_model: string | null;
    suggested_count: number; accepted_count: number; created_at: string;
  }
  export interface NewDecision {
    user_id: string; project_id: string | null; conversation_id: string | null; tab_question_id: string | null;
    question_index: number; header: string; question: string; options: DecisionOption[]; multi_select: boolean; answer: DecisionAnswer;
  }
  export interface DecisionNeighbour extends ChatDecision { similarity: number }
  export interface AnsweredChoiceRow { id: string; project_id: string; conversation_id: string; answered_by: string; payload: unknown; answer: unknown }
  export class ChatDecisionsRepository {
    insertMany(rows: NewDecision[]): Promise<ChatDecision[]>; // ON CONFLICT (tab_question_id, question_index) DO NOTHING; returns inserted rows
    setEmbedding(id: string, vector: number[], model: string): Promise<void>;
    listToEmbed(limit: number): Promise<Pick<ChatDecision, 'id' | 'header' | 'question' | 'options'>[]>; // embedding IS NULL, oldest first
    nearest(userId: string, vector: number[], opts: { multiSelect: boolean; k: number }): Promise<DecisionNeighbour[]>; // best first
    bumpSuggested(ids: string[]): Promise<void>;
    bumpAccepted(ids: string[]): Promise<void>;
    listForUser(userId: string, opts: { q?: string; cursor?: string; limit: number }): Promise<{ items: ChatDecision[]; next_cursor: string | null }>;
    deleteForUser(id: string, userId: string): Promise<boolean>;
    countForUser(userId: string): Promise<number>;
    listAnsweredChoicesWithoutDecision(limit: number): Promise<AnsweredChoiceRow[]>;
  }
  ```
- Produces (`users.ts`): `chatSuggestions(userId: string): Promise<boolean>` (true when the user row is missing too — callers only reach it for real users) and `setChatSuggestions(userId: string, enabled: boolean): Promise<void>`.
- Produces: `Repositories.chatDecisions: ChatDecisionsRepository`.

- [ ] **Step 1: DB image**

`docker/db/Dockerfile`:
```Dockerfile
# termhub's Postgres: the official postgres:16-alpine plus pgvector (spec 2026-09-26 §3.1).
# Same Postgres binary and libc (musl) as the image it replaces, so the existing data volume keeps
# its collations and needs no REINDEX. Built without LLVM bitcode and without -march=native so the
# image runs on any x86-64/arm64 host.
FROM postgres:16-alpine
ARG PGVECTOR_VERSION=0.8.0
RUN apk add --no-cache --virtual .build-deps git build-base \
 && git clone --branch "v${PGVECTOR_VERSION}" --depth 1 https://github.com/pgvector/pgvector.git /tmp/pgvector \
 && make -C /tmp/pgvector OPTFLAGS="" with_llvm=no \
 && make -C /tmp/pgvector OPTFLAGS="" with_llvm=no install \
 && rm -rf /tmp/pgvector \
 && apk del .build-deps
```
In `docker-compose.yml`, service `db`: replace `image: postgres:16-alpine` with
```yaml
    # postgres:16-alpine + pgvector (docker/db). Not recreated by blue-green.sh (it runs with --no-deps):
    # switching a running server to this image is a manual step (spec 2026-09-26 §3.1).
    build: docker/db
    image: termhub-db
```
In `.github/workflows/deploy.yml`, the check job's `services.postgres.image: postgres:16-alpine` → `pgvector/pgvector:pg16` (with a one-line comment: the test DB needs the `vector` extension).

Build and start a throwaway DB (never a `termhub-*` name):
```bash
docker build -t th-db-pgvector docker/db
docker run -d --name th-test-db -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=termhub -p 127.0.0.1:55432:5432 th-db-pgvector
docker exec th-test-db sh -c 'until pg_isready -U postgres; do sleep 1; done; psql -U postgres -d termhub -c "CREATE EXTENSION vector; SELECT extversion FROM pg_extension WHERE extname = '"'"'vector'"'"';"'
```
Expected: `0.8.0`. Then `docker exec th-test-db psql -U postgres -d termhub -c 'DROP EXTENSION vector;'` (the migration creates it).

- [ ] **Step 2: Schema + migration**

In `schema.prisma` add (near `TabQuestion`):
```prisma
/// A question of a tab's AskUserQuestion answered from the chat, remembered to suggest the answer to
/// similar questions later (spec 2026-09-26). `embedding` is pgvector, read and written in raw SQL.
model ChatDecision {
  id             String    @id
  userId         String    @map("user_id")
  user           User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  projectId      String?   @map("project_id")
  project        Project?  @relation(fields: [projectId], references: [id], onDelete: SetNull)
  conversationId String?   @map("conversation_id")
  conversation   ChatConversation? @relation(fields: [conversationId], references: [id], onDelete: SetNull)
  tabQuestionId  String?   @map("tab_question_id")
  questionIndex  Int       @map("question_index")
  header         String
  question       String
  options        Json
  multiSelect    Boolean   @map("multi_select")
  answer         Json
  embedding      Unsupported("vector(384)")?
  embedModel     String?   @map("embed_model")
  suggestedCount Int       @default(0) @map("suggested_count")
  acceptedCount  Int       @default(0) @map("accepted_count")
  createdAt      DateTime  @default(now()) @map("created_at")

  @@index([userId, createdAt])
  @@map("chat_decisions")
}
```
Add the back-relations `chatDecisions ChatDecision[]` on `User`, `Project` and `ChatConversation`; `suggestion Json?` on `TabQuestion`; `chatSuggestions Boolean @default(true) @map("chat_suggestions")` on `User` (doc comment: the "Memória do chat" switch). Follow the column style of neighbours (`@db.Timestamp(3)` if they use it — `TabQuestion` does: copy exactly how its `createdAt` is declared).

`migration.sql` (write it by hand; then check with `prisma migrate diff` that the schema matches, see Step 4):
```sql
-- Chat decision memory (spec 2026-09-26). Needs the pgvector image (docker/db).
CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE "users" ADD COLUMN "chat_suggestions" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "tab_questions" ADD COLUMN "suggestion" JSONB;

CREATE TABLE "chat_decisions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "project_id" TEXT,
    "conversation_id" TEXT,
    "tab_question_id" TEXT,
    "question_index" INTEGER NOT NULL,
    "header" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "options" JSONB NOT NULL,
    "multi_select" BOOLEAN NOT NULL,
    "answer" JSONB NOT NULL,
    "embedding" vector(384),
    "embed_model" TEXT,
    "suggested_count" INTEGER NOT NULL DEFAULT 0,
    "accepted_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "chat_decisions_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "chat_decisions_user_id_created_at_idx" ON "chat_decisions"("user_id", "created_at");
-- One decision per question of a tab question: recording and the backfill are idempotent.
CREATE UNIQUE INDEX "chat_decisions_tab_question_id_question_index_key" ON "chat_decisions"("tab_question_id", "question_index") WHERE "tab_question_id" IS NOT NULL;
CREATE INDEX "chat_decisions_embedding_idx" ON "chat_decisions" USING hnsw ("embedding" vector_cosine_ops);
ALTER TABLE "chat_decisions" ADD CONSTRAINT "chat_decisions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "chat_decisions" ADD CONSTRAINT "chat_decisions_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "chat_decisions" ADD CONSTRAINT "chat_decisions_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "chat_conversations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
```
(Check the real table names of users/projects/conversations in earlier migrations and use them.)

- [ ] **Step 3: Write the failing DB test** `chat-decisions.db.test.ts`, same skeleton as `tab-questions.db.test.ts` (users, project, conversation in `beforeAll`, cleanup in `afterAll`). A helper `vec(i: number)` builds a unit 384-d vector with a 1 at index `i` (and `mix(i, j, w)` a normalised blend) so similarities are exact. Cases:
  - `insertMany` returns the rows; inserting the same `(tab_question_id, question_index)` again returns `[]` and keeps one row.
  - `listToEmbed` returns rows without embedding; after `setEmbedding(id, vec(1), 'm')` it no longer does, and `embed_model` is `'m'`.
  - `nearest(userId, vec(1), { multiSelect: false, k: 5 })` returns the `vec(1)` row first with `similarity ≈ 1` (toBeCloseTo 5), a `mix(1, 2, 0.5)` row after it, never the other user's `vec(1)` row, never a `multi_select: true` row, never a row without embedding; `project_name` is the project's name.
  - `bumpSuggested`/`bumpAccepted` increment.
  - `listForUser` newest first, `q` matches question/header/answer text case-insensitively (`'COR'` finds "Qual cor?"), pagination with `limit: 1` gives a `next_cursor` that returns the next row, and only the user's rows.
  - `deleteForUser` true for own row, false for another user's row and for a missing id.
  - `countForUser`.
  - `listAnsweredChoicesWithoutDecision`: an `answered` choice tab question without decisions is returned; after `insertMany` of its decisions it is not; a `permission` row and an `open` choice row never are.
  - `users.chatSuggestions` default true; `setChatSuggestions(false)` → false.

- [ ] **Step 4: Run it — expect FAIL** (module missing)

```bash
docker run --rm --network host -u "$(id -u):$(id -g)" -e HOME=/tmp -e DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55432/termhub -e TERMHUB_DB_TESTS=1 -v "$PWD:/w" -w /w node:20 \
  sh -c 'cd apps/server && npx prisma generate && npx prisma migrate deploy && npx prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --shadow-database-url postgresql://postgres:postgres@127.0.0.1:55432/shadow --exit-code; cd /w && npx vitest run --root apps/server src/db/repositories/chat-decisions.db.test.ts'
```
(Create the shadow DB once: `docker exec th-test-db psql -U postgres -c 'CREATE DATABASE shadow'`. The diff may only report the HNSW/partial indexes Prisma cannot express — acceptable; anything else means the schema and SQL disagree.) Check how `prisma.config.ts` is used by the repo's scripts (`--config`), and adapt the commands.

- [ ] **Step 5: Implement `chat-decisions.ts`** (class shape as in Interfaces). Key SQL:
```ts
const toVector = (v: number[]) => `[${v.map((x) => (Number.isFinite(x) ? x : 0)).join(',')}]`;

async nearest(userId: string, vector: number[], opts: { multiSelect: boolean; k: number }): Promise<DecisionNeighbour[]> {
  const v = toVector(vector);
  const rows = await this.db.$queryRaw<RawDecision[]>`
    SELECT d.id, d.user_id, d.project_id, p.name AS project_name, d.conversation_id, d.tab_question_id, d.question_index,
           d.header, d.question, d.options, d.multi_select, d.answer, d.embed_model, d.suggested_count, d.accepted_count, d.created_at,
           1 - (d.embedding <=> ${v}::vector) AS similarity
    FROM chat_decisions d LEFT JOIN projects p ON p.id = d.project_id
    WHERE d.user_id = ${userId} AND d.embedding IS NOT NULL AND d.multi_select = ${opts.multiSelect}
    ORDER BY d.embedding <=> ${v}::vector
    LIMIT ${opts.k}`;
  return rows.map((r) => ({ ...mapRaw(r), similarity: Number(r.similarity) }));
}
```
`insertMany` uses `INSERT … ON CONFLICT ("tab_question_id", "question_index") WHERE "tab_question_id" IS NOT NULL DO NOTHING RETURNING …` (one statement per row inside a `$transaction` is fine: at most 4 rows). `setEmbedding`: `UPDATE chat_decisions SET embedding = ${v}::vector, embed_model = ${model} WHERE id = ${id}`. `listForUser`: keyset on `(created_at, id)`; the cursor is `base64url(JSON.stringify([created_at, id]))`, decoded defensively (an undecodable cursor → first page); `q` → `ILIKE '%' || q || '%'` over `header`, `question`, `answer::text` with `%`/`_`/`\` escaped. `listAnsweredChoicesWithoutDecision`:
```sql
SELECT q.id, q.project_id, q.conversation_id, q.answered_by, q.payload, q.answer
FROM tab_questions q
WHERE q.kind = 'choice' AND q.status = 'answered' AND q.answered_by IS NOT NULL AND q.answer IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM chat_decisions d WHERE d.tab_question_id = q.id)
ORDER BY q.answered_at ASC LIMIT ${limit}
```
Register in `index.ts`. Add the two `users.ts` methods (Prisma `findUnique`/`update` on `chatSuggestions`).

- [ ] **Step 6: Run the DB test — expect PASS**, plus the server typecheck:
`docker run … node:20 sh -c 'npm run typecheck -w @termhub/server'`.

- [ ] **Step 7: Commit**
```bash
git add docker/db docker-compose.yml .github/workflows/deploy.yml apps/server/prisma apps/server/src/db/repositories
git commit -m "Chat decisions: pgvector image, table and repository"
```

---

### Task 2: Embed service container

**Files:**
- Create: `docker/embed/Dockerfile`, `docker/embed/api.py`, `docker/embed/server.py`, `docker/embed/test_api.py`
- Modify: `docker-compose.yml` (service `embed`, volume `embed-models`, `EMBED_URL`/`EMBED_SECRET` in the app anchors next to `WHISPER_URL`), `.env.example` (document `EMBED_SECRET`), `.github/workflows/deploy.yml` (deploy job step for `embed`, like `whisper`)

**Interfaces:**
- Produces HTTP: `GET /health` → 200 `{"model": "...", "dim": 384}` once loaded, 503 before. `POST /embed` (header `Authorization: Bearer <EMBED_SECRET>`, body `{"texts": [...]}`) → 200 `{"model": "...", "dim": 384, "vectors": [[...]]}`; 401 bad/missing secret or empty `EMBED_SECRET`; 400 invalid body; 503 model not loaded.

- [ ] **Step 1: Failing Python test** `docker/embed/test_api.py` (stdlib `unittest`, imports only `api`):
```python
import unittest
from api import MAX_TEXTS, MAX_CHARS, BadRequest, authorized, parse_request

class ParseRequest(unittest.TestCase):
    def test_accepts_a_list_of_texts(self):
        self.assertEqual(parse_request(b'{"texts": ["a", "b"]}'), ["a", "b"])
    def test_rejects_non_json_missing_or_empty(self):
        for body in (b"nope", b"{}", b'{"texts": []}', b'{"texts": "a"}', b'{"texts": [1]}'):
            with self.assertRaises(BadRequest):
                parse_request(body)
    def test_rejects_too_many_or_too_long(self):
        with self.assertRaises(BadRequest):
            parse_request(('{"texts": [%s]}' % ",".join(['"x"'] * (MAX_TEXTS + 1))).encode())
        with self.assertRaises(BadRequest):
            parse_request(('{"texts": ["%s"]}' % ("x" * (MAX_CHARS + 1))).encode())

class Authorized(unittest.TestCase):
    def test_needs_the_exact_bearer(self):
        self.assertTrue(authorized("Bearer s3cret", "s3cret"))
        self.assertFalse(authorized("Bearer nope", "s3cret"))
        self.assertFalse(authorized(None, "s3cret"))
    def test_empty_secret_refuses_everything(self):
        self.assertFalse(authorized("Bearer ", ""))

if __name__ == "__main__":
    unittest.main()
```
Run: `docker run --rm -v "$PWD/docker/embed:/e" -w /e python:3.12-slim python -m unittest -v` → FAIL (no `api`).

- [ ] **Step 2: `api.py`**
```python
"""Pure request handling for the embed service (no model import, so it is testable anywhere)."""
import hmac
import json

MAX_TEXTS = 32
MAX_CHARS = 2000


class BadRequest(ValueError):
    pass


def parse_request(body: bytes) -> list[str]:
    try:
        data = json.loads(body)
    except (ValueError, UnicodeDecodeError):
        raise BadRequest("body is not JSON")
    texts = data.get("texts") if isinstance(data, dict) else None
    if not isinstance(texts, list) or not texts or len(texts) > MAX_TEXTS:
        raise BadRequest(f"texts must be a list of 1..{MAX_TEXTS} strings")
    if not all(isinstance(t, str) and len(t) <= MAX_CHARS for t in texts):
        raise BadRequest(f"each text must be a string of at most {MAX_CHARS} characters")
    return texts


def authorized(header: str | None, secret: str) -> bool:
    """An empty secret refuses every request: the service must never run open on the network."""
    if not secret or not header or not header.startswith("Bearer "):
        return False
    return hmac.compare_digest(header[len("Bearer "):], secret)
```
Run the test → PASS.

- [ ] **Step 3: `server.py`** — same structure as `docker/whisper/server.py` (ThreadingHTTPServer, model loaded in a background thread, `/health` 503 until loaded, one lock around inference, logs only counts and ms):
```python
"""
Text embeddings for termhub's chat decision memory (spec 2026-09-26 §3.2), fastembed (ONNX) on CPU.

  GET  /health   200 {"model", "dim"} once the model is loaded (503 while downloading/loading)
  POST /embed    Authorization: Bearer $EMBED_SECRET, {"texts": [...]} -> {"model", "dim", "vectors"}

Texts are never written to disk nor logged: the log carries counts and timings only.
"""
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from api import BadRequest, authorized, parse_request

MODEL = os.environ.get("EMBED_MODEL", "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2")
SECRET = os.environ.get("EMBED_SECRET", "")
PORT = int(os.environ.get("PORT", "8000"))
THREADS = int(os.environ.get("EMBED_THREADS", "0")) or None
MAX_BYTES = 256 * 1024

model = None
dim = 0
lock = threading.Lock()


def load() -> None:
    global model, dim
    from fastembed import TextEmbedding
    started = time.time()
    m = TextEmbedding(MODEL, cache_dir="/models", threads=THREADS)
    dim = len(next(iter(m.embed(["warm up"]))))
    model = m
    print(f"model {MODEL} loaded (dim {dim}) in {time.time() - started:.1f}s", flush=True)


class Handler(BaseHTTPRequestHandler):
    def _send(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        if self.path != "/health":
            return self._send(404, {"error": "not found"})
        if model is None:
            return self._send(503, {"error": "loading"})
        self._send(200, {"model": MODEL, "dim": dim})

    def do_POST(self) -> None:
        if self.path != "/embed":
            return self._send(404, {"error": "not found"})
        if not authorized(self.headers.get("Authorization"), SECRET):
            return self._send(401, {"error": "unauthorized"})
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > MAX_BYTES:
            return self._send(400, {"error": "bad length"})
        try:
            texts = parse_request(self.rfile.read(length))
        except BadRequest as err:
            return self._send(400, {"error": str(err)})
        if model is None:
            return self._send(503, {"error": "loading"})
        started = time.time()
        with lock:
            vectors = [v.tolist() for v in model.embed(texts)]
        print(f"embedded {len(texts)} texts in {(time.time() - started) * 1000:.0f}ms", flush=True)
        self._send(200, {"model": MODEL, "dim": dim, "vectors": vectors})

    def log_message(self, *_args) -> None:  # the default access log is noise; errors print above
        pass


if __name__ == "__main__":
    if not SECRET:
        print("EMBED_SECRET is empty: every /embed request will be refused", file=sys.stderr, flush=True)
    threading.Thread(target=load, daemon=True).start()
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
```
`Dockerfile` (copy whisper's): `FROM python:3.12-slim`, `ENV PIP_NO_CACHE_DIR=1 PYTHONUNBUFFERED=1`, `RUN pip install --no-cache-dir fastembed==<latest 0.x that installs on 3.12>` (pin the version you verified), `COPY api.py server.py ./`, `EXPOSE 8000`, a `HEALTHCHECK` on `/health` with `--start-period=180s`, `CMD ["python", "server.py"]`.

- [ ] **Step 4: Compose + env + CI.** Service (after `whisper`, same comment style):
```yaml
  # ── Text embeddings for the chat's decision memory (docker/embed): fastembed on CPU ──
  # Shared by dev and the blue/green pair like whisper; the app works without it (no suggestions).
  # Weights (~500 MB) land in the "embed-models" volume on first start.
  embed:
    profiles: ["dev", "prod"]
    build: docker/embed
    image: termhub-embed
    restart: unless-stopped
    environment:
      # Empty = the service refuses every request and the chat suggests nothing. openssl rand -base64 32
      EMBED_SECRET: ${EMBED_SECRET:-}
    volumes:
      - embed-models:/models
```
Add `embed-models:` under `volumes:`. In both app environments that set `WHISPER_URL`, add `EMBED_URL: ${EMBED_URL:-http://embed:8000}` and `EMBED_SECRET: ${EMBED_SECRET:-}`. `.env.example`: a commented `EMBED_SECRET=` line with the generation hint. Deploy job: a step `Embed (text embeddings for the chat memory; recreated only when its image or config changes)` running `docker compose … up -d --build --no-deps embed`, right after the Whisper step.

- [ ] **Step 5: Smoke test (throwaway container)**
```bash
docker build -t th-embed docker/embed
docker run -d --name th-embed-test -e EMBED_SECRET=t -v th-embed-models:/models -p 127.0.0.1:58000:8000 th-embed
until curl -sf 127.0.0.1:58000/health; do sleep 5; done
curl -s -H 'Authorization: Bearer t' -d '{"texts":["Usar git worktree?","Criar um worktree isolado?","Qual a cor do botão?"]}' 127.0.0.1:58000/embed | python3 -c 'import json,sys,math; d=json.load(sys.stdin); v=d["vectors"]; c=lambda a,b: sum(x*y for x,y in zip(a,b))/math.sqrt(sum(x*x for x in a)*sum(y*y for y in b)); print(d["dim"], round(c(v[0],v[1]),3), round(c(v[0],v[2]),3))'
curl -s -o /dev/null -w '%{http_code}\n' -d '{"texts":["x"]}' 127.0.0.1:58000/embed   # expect 401
docker rm -f th-embed-test
```
Expected: `384`, the first similarity clearly higher than the second, then `401`. Record the two numbers in the commit body (they inform the threshold). Keep the `th-embed-models` volume for Task 9.

- [ ] **Step 6: Commit**
```bash
git add docker/embed docker-compose.yml .env.example .github/workflows/deploy.yml
git commit -m "Embed service: local text embeddings for the chat memory"
```

---

### Task 3: Server embeddings client and pure decision helpers

**Files:**
- Modify: `apps/server/src/config.ts` (env + `config.embeddings`)
- Create: `apps/server/src/chat/embeddings.ts`, `apps/server/src/chat/embeddings.test.ts`
- Create: `apps/server/src/chat/decision-text.ts`, `apps/server/src/chat/decision-text.test.ts`

**Interfaces:**
- Produces (`config.ts`): env `EMBED_URL: z.string().url().optional()`, `EMBED_SECRET: z.string().optional()`, `DECISION_SUGGEST_THRESHOLD: z.coerce.number().min(0).max(1).default(0.85)`; `config.embeddings: { url: string; secret: string } | null` (null unless both URL and a non-empty secret are set) and `config.decisionSuggestThreshold: number`.
- Produces (`embeddings.ts`):
  ```ts
  export interface Embedder { embed(texts: string[]): Promise<{ model: string; vectors: number[][] }> } // throws EmbedError
  export class EmbedError extends Error { constructor(public code: string) }
  export const EMBED_TIMEOUT_MS = 2000;
  export function httpEmbedder(url: string, secret: string, fetchImpl?: typeof fetch, timeoutMs?: number): Embedder;
  export function defaultEmbedder(): Embedder | null; // from config.embeddings, memoised; null when unset
  ```
- Produces (`decision-text.ts`):
  ```ts
  import type { ChoicePayload } from './tab-question-payload.js';
  export type ChoiceItem = ChoicePayload['questions'][number];
  export interface ItemAnswer { selected: number[]; text?: string }
  export interface SuggestionItem { question_index: number; decision_id: string; similarity: number; selected: number[]; text?: string; source: { question: string; project_name: string | null; answered_at: string } }
  export interface TabQuestionSuggestion { items: SuggestionItem[] }
  export function decisionText(item: { header: string; question: string; options: { label: string }[] }): string;
  export function labelKey(label: string): string;
  export function answerToDecision(item: ChoiceItem, a: ItemAnswer): DecisionAnswer; // DecisionAnswer from chat-decisions.ts
  export function mapAnswer(past: DecisionAnswer, item: ChoiceItem): ItemAnswer | null;
  export function sameAnswer(a: ItemAnswer, b: ItemAnswer): boolean;
  ```

- [ ] **Step 1: Failing tests** `decision-text.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { answerToDecision, decisionText, labelKey, mapAnswer, sameAnswer } from './decision-text.js';

const item = (labels: string[], multi = false) => ({ question: 'Usar worktree?', header: 'Isolamento', multi_select: multi, options: labels.map((label) => ({ label, description: 'longa descrição', recommended: false })) });

describe('decisionText', () => {
  it('header, question and option labels — never descriptions', () => {
    expect(decisionText(item(['Sim', 'Não']))).toBe('Isolamento\nUsar worktree?\nOpções: Sim | Não');
  });
});

describe('labelKey', () => {
  it('ignores case, accents, spaces and punctuation', () => {
    expect(labelKey('  Não, obrigado! ')).toBe(labelKey('nao obrigado'));
  });
});

describe('answerToDecision', () => {
  it('stores labels, not indexes', () => {
    expect(answerToDecision(item(['A', 'B', 'C'], true), { selected: [0, 2] })).toEqual({ labels: ['A', 'C'] });
  });
  it('stores free text as text', () => {
    expect(answerToDecision(item(['A', 'B']), { selected: [], text: 'outra' })).toEqual({ labels: [], text: 'outra' });
  });
});

describe('mapAnswer', () => {
  it('maps labels onto the new options, whatever their order and case', () => {
    expect(mapAnswer({ labels: ['sim'] }, item(['Não', 'Sim']))).toEqual({ selected: [1] });
  });
  it('maps a multi-select answer to sorted indexes', () => {
    expect(mapAnswer({ labels: ['C', 'A'] }, item(['A', 'B', 'C'], true))).toEqual({ selected: [0, 2] });
  });
  it('a label that no longer exists maps to nothing', () => {
    expect(mapAnswer({ labels: ['Talvez'] }, item(['Sim', 'Não']))).toBeNull();
  });
  it('a single-select never gets two labels', () => {
    expect(mapAnswer({ labels: ['Sim', 'Não'] }, item(['Sim', 'Não']))).toBeNull();
  });
  it('free text maps as text', () => {
    expect(mapAnswer({ labels: [], text: 'usar a main' }, item(['Sim', 'Não']))).toEqual({ selected: [], text: 'usar a main' });
  });
  it('an empty answer maps to nothing', () => {
    expect(mapAnswer({ labels: [] }, item(['Sim', 'Não']))).toBeNull();
  });
});

describe('sameAnswer', () => {
  it('compares selections as sets and text trimmed', () => {
    expect(sameAnswer({ selected: [2, 0] }, { selected: [0, 2] })).toBe(true);
    expect(sameAnswer({ selected: [], text: ' a ' }, { selected: [], text: 'a' })).toBe(true);
    expect(sameAnswer({ selected: [0] }, { selected: [1] })).toBe(false);
  });
});
```
`embeddings.test.ts` (fake `fetch`):
```ts
import { describe, expect, it, vi } from 'vitest';
import { EmbedError, httpEmbedder } from './embeddings.js';

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

describe('httpEmbedder', () => {
  it('posts the texts with the bearer secret and returns model + vectors', async () => {
    const fetchImpl = vi.fn(async () => ok({ model: 'm', dim: 2, vectors: [[1, 0], [0, 1]] }));
    const e = httpEmbedder('http://embed:8000', 's3', fetchImpl as unknown as typeof fetch);
    await expect(e.embed(['a', 'b'])).resolves.toEqual({ model: 'm', vectors: [[1, 0], [0, 1]] });
    const [url, init] = fetchImpl.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe('http://embed:8000/embed');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer s3');
    expect(JSON.parse(init.body as string)).toEqual({ texts: ['a', 'b'] });
  });
  it('an HTTP error, a malformed body or a count mismatch is an EmbedError', async () => {
    for (const res of [new Response('x', { status: 503 }), ok({ nope: 1 }), ok({ model: 'm', dim: 2, vectors: [[1, 0]] })]) {
      const e = httpEmbedder('http://e', 's', (async () => res) as unknown as typeof fetch);
      await expect(e.embed(['a', 'b'])).rejects.toBeInstanceOf(EmbedError);
    }
  });
  it('gives up after the timeout', async () => {
    const hang = (_u: string, init: RequestInit) => new Promise<Response>((_r, reject) => init.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
    const e = httpEmbedder('http://e', 's', hang as unknown as typeof fetch, 20);
    await expect(e.embed(['a'])).rejects.toMatchObject({ code: 'EMBED_TIMEOUT' });
  });
  it('an empty list costs no request', async () => {
    const fetchImpl = vi.fn();
    await expect(httpEmbedder('http://e', 's', fetchImpl as unknown as typeof fetch).embed([])).resolves.toEqual({ model: '', vectors: [] });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run — expect FAIL**
`docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -e DATABASE_URL=postgresql://x:x@localhost:5432/x -v "$PWD:/w" -w /w node:20 sh -c 'npx vitest run --root apps/server src/chat/decision-text.test.ts src/chat/embeddings.test.ts'`

- [ ] **Step 3: Implement.** `labelKey = (s) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')`. `mapAnswer`: text → `{ selected: [], text }` when `labels` is empty and `text?.trim()`; otherwise every label must match exactly one option by `labelKey` (no duplicates), single-select requires exactly one, result sorted. `httpEmbedder`: `AbortController` + `setTimeout(timeoutMs)` (default `EMBED_TIMEOUT_MS`), zod-parse `{ model: string, vectors: number[][] }`, count must equal `texts.length`, codes `EMBED_HTTP_<status>`, `EMBED_BAD_RESPONSE`, `EMBED_TIMEOUT`, `EMBED_UNREACHABLE`. Config: add the three env keys next to `WHISPER_*` with a comment in the same style, and `embeddings`/`decisionSuggestThreshold` next to `transcription`.

- [ ] **Step 4: Run — expect PASS**; typecheck server.

- [ ] **Step 5: Commit** `git commit -m "Chat memory: embeddings client and decision text helpers"`

---

### Task 4: Suggest on open

**Files:**
- Create: `apps/server/src/chat/decision-memory.ts` (this task: `suggestFor`)
- Test: `apps/server/src/chat/decision-memory.test.ts`
- Modify: `apps/server/src/chat/tab-questions.ts` (`openTabQuestion` gets `deps?: { embedder?: Embedder | null; log?: … }` and calls `suggestFor` before publishing)
- Modify: `apps/server/src/db/repositories/tab-questions.ts` (`TabQuestion.suggestion`, `mapQuestion`, `setSuggestion(id, s): Promise<TabQuestion | undefined>`)
- Modify: `apps/server/src/db/repositories/tab-questions-view.ts` (`TabQuestionView.suggestion: TabQuestionSuggestion | null`, only while `status === 'open'`, else null)
- Modify: existing tests that build `TabQuestion` rows (`row()` helpers) to include `suggestion: null` where the type demands it.

**Interfaces:**
- Consumes: `Embedder`, `defaultEmbedder` (Task 3); `decisionText`, `mapAnswer`, `SuggestionItem`, `TabQuestionSuggestion` (Task 3); `repos.chatDecisions.nearest`, `bumpSuggested`, `repos.users.chatSuggestions` (Task 1).
- Produces:
  ```ts
  export const SUGGEST_K = 5;
  export interface MemoryDeps { embedder: Embedder | null; threshold: number; timeoutMs?: number; log: Pick<FastifyBaseLogger, 'info' | 'warn'> }
  export async function suggestFor(repos: Pick<Repositories, 'users' | 'chatDecisions'>, row: TabQuestion, deps: MemoryDeps): Promise<TabQuestionSuggestion | null>; // never throws
  ```

- [ ] **Step 1: Failing tests** `decision-memory.test.ts` — fake embedder `{ embed: vi.fn(async (texts) => ({ model: 'm', vectors: texts.map(() => [1, 0]) })) }`, fake repos with `users.chatSuggestions`, `chatDecisions.nearest` returning `DecisionNeighbour`s you build with a `neighbour(over)` helper (`similarity`, `created_at`, `answer`, `project_name`), `chatDecisions.bumpSuggested`. Cases:
  1. Pre-selects the most recent candidate above the threshold (two candidates 0.95 older with `['Não']` and 0.90 newer with `['Sim']` → `selected` is the index of "Sim"), with `source = { question, project_name, answered_at: created_at }`, and calls `bumpSuggested(['<that id>'])`.
  2. Ignores candidates below the threshold (0.84 with threshold 0.85 → `null`, no bump).
  3. Skips a candidate that does not map (newest has label "Talvez" not in options → the older mapping one is used).
  4. Multi-question payload: embeds all questions in **one** call, returns items only for questions that matched, each with its `question_index`; `nearest` called with each item's `multiSelect`.
  5. `null` without calling the embedder when: `row.kind !== 'choice'`, `deps.embedder === null`, `users.chatSuggestions` resolves false.
  6. Embedder rejects → `null`, `log.warn` with `{ tabQuestionId, code }` only (assert the log calls never contain the question text).
  7. Embedder hangs → resolves `null` within `timeoutMs: 20` (use real timers; the promise must settle).
  8. `nearest` rejects → `null`, warned.

Add to `tab-questions.test.ts`:
  - "attaches the suggestion before announcing the card": `openTabQuestion(repos, tab, input, { embedder, threshold: 0.85, log })` with `vi.mock('./decision-memory.js')` making `suggestFor` resolve `{ items: [...] }`, and `repos.tabQuestions.setSuggestion` resolving the row with it → the `tab_question` event's `question.suggestion` equals it.
  - "publishes without suggestion when suggestFor gives null" → `setSuggestion` not called, event `suggestion: null`.
  - Existing tests keep passing with no `deps` (default `defaultEmbedder()` is null in tests because `EMBED_URL` is unset).

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement `suggestFor`:**
```ts
export async function suggestFor(repos: Pick<Repositories, 'users' | 'chatDecisions'>, row: TabQuestion, deps: MemoryDeps): Promise<TabQuestionSuggestion | null> {
  if (row.kind !== 'choice' || !deps.embedder) return null;
  const embedder = deps.embedder;
  const work = async (): Promise<TabQuestionSuggestion | null> => {
    if (!(await repos.users.chatSuggestions(row.user_id))) return null;
    const items = (row.payload as ChoicePayload).questions;
    const { vectors } = await embedder.embed(items.map(decisionText));
    const found: SuggestionItem[] = [];
    for (const [i, item] of items.entries()) {
      const near = await repos.chatDecisions.nearest(row.user_id, vectors[i]!, { multiSelect: item.multi_select, k: SUGGEST_K });
      const candidates = near.filter((n) => n.similarity >= deps.threshold).sort((a, b) => b.created_at.localeCompare(a.created_at));
      for (const c of candidates) {
        const mapped = mapAnswer(c.answer, item);
        if (!mapped) continue;
        found.push({ question_index: i, decision_id: c.id, similarity: c.similarity, ...mapped, source: { question: c.question, project_name: c.project_name, answered_at: c.created_at } });
        break;
      }
    }
    if (found.length === 0) return null;
    await repos.chatDecisions.bumpSuggested(found.map((f) => f.decision_id));
    return { items: found };
  };
  try {
    return await withTimeout(work(), deps.timeoutMs ?? EMBED_TIMEOUT_MS);
  } catch (err) {
    deps.log.warn({ tabQuestionId: row.id, code: memoryCode(err) }, 'decision suggestion skipped');
    return null;
  }
}
```
(`withTimeout` rejects with `EmbedError('SUGGEST_TIMEOUT')`; `memoryCode` reads `.code` of `EmbedError`/Prisma errors, else `'SUGGEST_FAILED'`. Log `info` `{ tabQuestionId, items: found.length, best: max similarity rounded to 3 }` when something was found.)

In `openTabQuestion`, between the `open(...)` call and `publishTabQuestions(repos, 'tab_question', [question])`:
```ts
let shown = question;
if (question?.kind === 'choice') {
  const suggestion = await suggestFor(repos, question, { embedder: deps?.embedder !== undefined ? deps.embedder : defaultEmbedder(), threshold: config.decisionSuggestThreshold, log: deps?.log ?? silentLog });
  if (suggestion) shown = (await repos.tabQuestions.setSuggestion(question.id, suggestion).catch(() => undefined)) ?? { ...question, suggestion };
}
if (shown) await publishTabQuestions(repos, 'tab_question', [shown]);
return shown;
```
`noteHookEvent` passes its `log` in `deps`. `setSuggestion`: `update … where: { id }, data: { suggestion }` returning the mapped row. View: `suggestion: r.status === 'open' ? r.suggestion : null`.

- [ ] **Step 4: Run all server chat tests — expect PASS**: `npx vitest run --root apps/server src/chat src/db/repositories` (non-DB), typecheck.

- [ ] **Step 5: Commit** `git commit -m "Chat memory: suggest a past answer when a tab asks"`

---

### Task 5: Record on answer, and the sweeper

**Files:**
- Modify: `apps/server/src/chat/decision-memory.ts` (`recordDecisions`, `embedPending`, `backfillDecisions`, `startDecisionSweeper`)
- Modify: `apps/server/src/chat/tab-question-answer.ts` (call `recordDecisions` after a successful send; `AnswerDeps.embedder?`)
- Modify: `apps/server/src/app.ts` (start/stop the sweeper next to `startTabQuestionExpiry`)
- Test: `apps/server/src/chat/decision-memory.test.ts`, `apps/server/src/chat/tab-question-answer.test.ts`

**Interfaces:**
- Consumes: Task 1 repo methods; Task 3 `answerToDecision`, `sameAnswer`, `decisionText`; Task 4 `MemoryDeps`.
- Produces:
  ```ts
  export function decisionsOf(row: Pick<TabQuestion, 'id' | 'project_id' | 'conversation_id' | 'payload' | 'answer'>, userId: string): NewDecision[];
  export async function recordDecisions(repos: Pick<Repositories, 'chatDecisions'>, row: TabQuestion, deps: Omit<MemoryDeps, 'threshold'>): Promise<void>; // never throws
  export async function embedPending(repos: Pick<Repositories, 'chatDecisions'>, embedder: Embedder, limit?: number): Promise<number>; // rows embedded
  export async function backfillDecisions(repos: Pick<Repositories, 'chatDecisions'>, limit?: number): Promise<number>; // decisions inserted
  export const SWEEP_INTERVAL_MS = 10 * 60 * 1000;
  export function startDecisionSweeper(repos: Repositories, log: Pick<FastifyBaseLogger, 'info' | 'warn'>, embedder?: Embedder | null, intervalMs?: number): () => void;
  ```

- [ ] **Step 1: Failing tests** in `decision-memory.test.ts`:
  - `decisionsOf` of a 2-question answered row gives two `NewDecision`s (labels from indexes, text kept, `tab_question_id`, `question_index`, options without `recommended`), user = `answered_by`.
  - `recordDecisions` inserts via `insertMany`, bumps `accepted_count` only for suggestion items whose `selected`/`text` equal the answer (`sameAnswer`), then embeds the inserted rows (`setEmbedding` per row with the embedder's vectors, model from the response). Rows of kind `permission` → nothing at all. An `insertMany` rejection → warned, resolves.
  - With `embedder: null` it still inserts (embedding left for the sweeper).
  - `backfillDecisions` turns `listAnsweredChoicesWithoutDecision` rows into `insertMany` calls and returns the count; a row whose payload/answer does not parse (`choicePayload`/`choiceAnswerBody` zod) is skipped.
  - `embedPending` embeds `listToEmbed(32)` rows in one call and writes each; returns 0 without calling the embedder when nothing is pending.
  - `startDecisionSweeper` runs once immediately (fake timers: `vi.advanceTimersByTimeAsync(0)`) and again after `intervalMs`; the returned stop clears the timer; with no embedder it only backfills.

In `tab-question-answer.test.ts` (existing fakes gain `chatDecisions: { insertMany: vi.fn(async () => []), bumpAccepted: vi.fn(), setEmbedding: vi.fn() }`):
  - After a successful choice answer, `insertMany` was called with the row's decisions.
  - After a failed send (502), `insertMany` was not called.
  - A permission answer never calls it.
  - `insertMany` rejecting still answers 200 with the view.

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement.** In `answerTabQuestion`, right after the `'tab question answered'` log line:
```ts
// Remembering the decision is best effort (spec 2026-09-26 §4.3): the keys are already in the tab.
if (claimed.kind === 'choice') await recordDecisions(ctx.repos, claimed, { embedder: deps.embedder !== undefined ? deps.embedder : defaultEmbedder(), log: deps.log });
```
`recordDecisions`: `insertMany(decisionsOf(row, row.answered_by ?? row.user_id))`; accepted ids from `row.suggestion?.items` compared with `(row.answer as ChoiceAnswer).answers[item.question_index]`; then `void embedRows(...)` (fire and forget, its own catch/warn). `app.ts`: `const stopDecisionSweeper = startDecisionSweeper(repos, fastify.log);` and call it wherever `stopTabQuestionExpiry` is called on close.

- [ ] **Step 4: Run server tests — expect PASS**; typecheck.

- [ ] **Step 5: Commit** `git commit -m "Chat memory: remember answered questions, backfill and embed"`

---

### Task 6: API (web + mobile) and contracts

**Files:**
- Create: `apps/server/src/routes/chat-memory.ts` (a plugin function shared by both mounts), `apps/server/src/routes/chat-memory.test.ts`
- Modify: `apps/server/src/routes/chat.ts` and `apps/server/src/routes/m-chat.ts` (register the memory routes inside each: `await chatMemoryRoutes(app, repos)`)
- Create/Modify: `packages/mobile-api/src/chat.ts` (contracts), `packages/mobile-api/src/events.ts` (`suggestion` on `tabQuestionSchema` common part, optional+nullable), `apps/server/src/mobile/events-parity.test.ts` if it needs the field

**Interfaces:**
- Consumes: `repos.chatDecisions.listForUser/deleteForUser/countForUser`, `repos.users.chatSuggestions/setChatSuggestions`, `config.embeddings`.
- Produces HTTP (same paths under `/api/chat` and `/api/m/v1/chat`):
  - `GET /decisions?q=&cursor=` → `{ decisions: DecisionView[], next_cursor: string | null }` (50 per page; `q` ≤ 200 chars trimmed; `cursor` ≤ 500 chars)
  - `DELETE /decisions/:id` → 204 (also when missing / not the user's — idempotent, reveals nothing)
  - `GET /memory` → `{ enabled: boolean, available: boolean, count: number }`
  - `PATCH /memory` body `{ enabled: boolean }` → same shape as GET
  - `DecisionView = { id, project_id, project_name, header, question, options: {label, description}[], multi_select, answer: {labels: string[], text?: string}, suggested_count, accepted_count, created_at }`
- Produces (`@termhub/mobile-api`): `decisionViewSchema`, `decisionsResponse`, `chatMemoryResponse`, `chatMemoryPatchBody`, `tabQuestionSuggestionSchema` (`{ items: [{ question_index, decision_id, similarity, selected, text?, source: { question, project_name, answered_at } }] }`), and `suggestion: tabQuestionSuggestionSchema.nullable().optional()` in `tabQuestionCommon`.

- [ ] **Step 1: Failing route tests** `chat-memory.test.ts` — build Fastify like `chat.tab-questions.test.ts` (`applyErrorHandler`, fake scope user `u1`), `describe.each(['web','mobile'])` mounting `chatRoutes`/`mobileChatRoutes` with fake repos `{ chatDecisions: {...vi.fn}, users: {...vi.fn} }`. Cases: list passes `u1`, `q`, `cursor`, `limit: 50` and returns `{ decisions, next_cursor }` without any `embedding` key; `q` over 200 chars → 400; delete calls `deleteForUser('d1','u1')` → 204 both when it returns true and false; `GET /memory` → `{ enabled, available: false, count }` (no `EMBED_URL` in tests); `PATCH /memory {enabled:false}` → calls `setChatSuggestions('u1', false)`; `PATCH` with `{enabled:'no'}` → 400.
  Mobile-api test (`packages/mobile-api/src/chat.test.ts`): `decisionsResponse` parses a sample; `tabQuestionSchema` parses a question with `suggestion` and one without the key (older servers).

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement** `chat-memory.ts`:
```ts
const listQuery = z.object({ q: z.string().trim().max(200).optional(), cursor: z.string().max(500).optional() });
const idParam = z.object({ id: z.string().min(1).max(64) });
const memoryBody = z.object({ enabled: z.boolean() });
export const DECISIONS_PAGE = 50;

/** "Memória do chat" (spec 2026-09-26 §4.6): the user's own decisions and the suggestion switch. Mounted
 * by both the web chat and the phone's, under the `chat` resource; always the signed-in user's rows. */
export async function chatMemoryRoutes(app: FastifyInstance, repos: Repositories) {
  app.get('/decisions', async (request) => {
    const { q, cursor } = listQuery.parse(request.query);
    const { items, next_cursor } = await repos.chatDecisions.listForUser(request.scope.user.id, { q: q || undefined, cursor, limit: DECISIONS_PAGE });
    return { decisions: items.map(toDecisionView), next_cursor };
  });
  app.delete('/decisions/:id', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    await repos.chatDecisions.deleteForUser(id, request.scope.user.id);
    return reply.code(204).send();
  });
  const memory = async (userId: string) => ({ enabled: await repos.users.chatSuggestions(userId), available: config.embeddings !== null, count: await repos.chatDecisions.countForUser(userId) });
  app.get('/memory', async (request) => memory(request.scope.user.id));
  app.patch('/memory', async (request) => {
    const { enabled } = memoryBody.parse(request.body);
    await repos.users.setChatSuggestions(request.scope.user.id, enabled);
    return memory(request.scope.user.id);
  });
}
```
(`toDecisionView` drops `user_id`, `conversation_id`, `tab_question_id`, `question_index`, `embed_model`.) Check that `PATCH` maps to `update` and `DELETE` to `delete` on the `chat` resource (`actionForMethod`) and that roles that can use the chat have those grants — if the default member role lacks `chat:update`/`chat:delete`, set `{ config: { action: 'read' } }` on the PATCH/DELETE routes with a comment (these touch only the user's own memory) and add a test for it.

- [ ] **Step 4: Run server + mobile-api tests — PASS**; typecheck server.

- [ ] **Step 5: Commit** `git commit -m "Chat memory: list, forget and switch routes for web and phone"`

---

### Task 7: Web — suggestion on the card and the "Memória do chat" page

**Files:**
- Modify: `apps/web/src/lib/types.ts` (`TabQuestionSuggestion`, `TabQuestion*.suggestion?`, `ChatDecision`, `ChatMemory`), `apps/web/src/lib/api.ts` (`chatDecisions`, `forgetChatDecision`, `chatMemory`, `setChatMemory`)
- Modify: `apps/web/src/components/chat/TabQuestionCard.tsx` (pre-selection + line + "Esquecer esta decisão"), `apps/web/src/components/chat/ChatPanel.tsx` (pass `onForget`; header link "Memória" → `/chat/memoria`)
- Create: `apps/web/src/pages/ChatMemoryPage.tsx`, `apps/web/src/pages/ChatMemoryPage.test.tsx`
- Modify: `apps/web/src/App.tsx` (route `/chat/memoria` inside the `ChatLayout` group)
- Test: `apps/web/src/components/chat/TabQuestionCard.test.tsx` (extend the existing one or create it next to it)

**Interfaces:**
- Consumes: the HTTP API of Task 6 and `TabQuestionView.suggestion` (Task 4).
- Produces: `TabQuestionCardProps.onForget?: (decisionId: string) => Promise<void>`.

- [ ] **Step 1: Failing tests.** Card (Testing Library):
  - An open choice question with `suggestion.items[0] = { question_index: 0, selected: [1], source: { question: 'Usar worktree?', project_name: 'termhub', answered_at: '2026-09-20T10:00:00Z' }, … }` renders option 1 checked, the line `Sugestão da memória: você respondeu «Não» a «Usar worktree?» em termhub, 20/09/2026` (use the repo's existing date formatter if any; else `toLocaleDateString('pt-BR')`), and "Responder" enabled at once.
  - A text suggestion fills "Outra resposta".
  - Clicking "Esquecer esta decisão" calls `onForget('d1')`, then the line disappears and the pre-selection is cleared.
  - An answered card shows no suggestion line.
  Page:
  - Loads `GET /memory` and `GET /decisions`, lists question, answer ("Sim" or the text), project, date, `sugerida 2× · aceita 1×`.
  - Typing in "Buscar" re-queries with `q` (debounced ~300 ms; use fake timers).
  - "Esquecer" asks `window.confirm` and removes the row after the DELETE.
  - The switch "Sugerir respostas com base nas minhas decisões" PATCHes `{ enabled: false }`.
  - `available: false` shows "Sugestões indisponíveis neste servidor".
  - "Carregar mais" appears with `next_cursor` and appends the next page.

- [ ] **Step 2: Run — FAIL**: `docker run … node:20 sh -c 'npx vitest run --root apps/web src/components/chat/TabQuestionCard.test.tsx src/pages/ChatMemoryPage.test.tsx'`

- [ ] **Step 3: Implement.** In `ChoiceBody`, initialise from the suggestion:
```tsx
const [hint, setHint] = useState(() => question.suggestion?.items ?? []);
const [selected, setSelected] = useState<number[][]>(() => items.map((_, i) => hint.find((s) => s.question_index === i)?.selected ?? []));
const [texts, setTexts] = useState<string[]>(() => items.map((_, i) => hint.find((s) => s.question_index === i)?.text ?? ''));
```
Render the line under the current question's options when `hint` has its index (plain text, `text-xs text-fg-dim`), with a `btn-ghost`-styled link button "Esquecer esta decisão" calling `onForget` then removing that item from `hint` and resetting that question's selection/text. Answer summary helper for the page: labels joined with ", " or the text. Page layout follows `SettingsPage`/`ProjectSettings` idioms (same card and input classes).

- [ ] **Step 4: Run web tests (all) + `npm run build -w @termhub/web` — PASS.**

- [ ] **Step 5: Commit** `git commit -m "Web chat: suggested answers on tab questions and the memory page"`

---

### Task 8: Mobile — suggestion on the card and the memory screen

**Files:**
- Modify: `apps/mobile/src/services/api/contract.ts` (re-export the new mobile-api schemas/types as the file does for the others), `apps/mobile/src/services/api/client.ts` (`chatDecisions`, `forgetChatDecision`, `chatMemory`, `setChatMemory`), `apps/mobile/src/services/api/mock/handlers/chat.ts` (mock handlers)
- Modify: `apps/mobile/src/features/chat/view/tab-question-card.tsx` (pre-selection, line, "Esquecer esta decisão"), `apps/mobile/src/features/chat/viewmodel/createChatStore.ts` (`forgetDecision(decisionId)`), `apps/mobile/src/features/chat/model/types.ts` if the view type is declared there
- Create: `apps/mobile/app/chat-memory.tsx` (route), `apps/mobile/src/features/chat/view/chat-memory-screen.tsx`, `apps/mobile/src/features/chat/viewmodel/createChatMemoryStore.ts` (or the repo's equivalent viewmodel idiom), tests next to them
- Modify: `apps/mobile/src/features/settings/view/settings-screen.tsx` (a row "Memória do chat" that pushes `/chat-memory`)

**Interfaces:**
- Consumes: Task 6 contracts and routes.

- [ ] **Step 1: Failing tests** (Jest + the repo's RN testing setup, mirror `conversation-screen.test.tsx` / `settings-screen.test.tsx`):
  - Card with a suggestion renders the suggested option selected, the line "Sugestão da memória: você respondeu «Não» a «Usar worktree?» em termhub, 20/09/2026", "Esquecer esta decisão" calls the store's `forgetDecision('d1')` and clears it; a text suggestion fills the field.
  - Memory screen: lists decisions, search re-queries, "Esquecer" confirms (mock `Alert.alert` and press the destructive button) and removes the row, the switch calls `setChatMemory(false)`, `available: false` shows "Sugestões indisponíveis neste servidor", "Carregar mais" paginates.
  - Settings screen shows the "Memória do chat" row and navigates.
  - Mock handlers answer the four routes (the mock mode must keep working).

- [ ] **Step 2: Run — FAIL**: `docker run … node:20 sh -c 'npm test -w @termhub/mobile -- tab-question-card chat-memory settings-screen'`

- [ ] **Step 3: Implement**, mirroring the web behaviour and the existing mobile idioms (AppText, Button, `INPUT` class, store pattern of `createChatStore`). No PIN.

- [ ] **Step 4: Run all mobile tests + `npm run typecheck -w @termhub/mobile` — PASS.**

- [ ] **Step 5: Commit** `git commit -m "Mobile chat: suggested answers on tab questions and the memory screen"`

---

### Task 9: End-to-end verification and spec adjustments

**Files:**
- Modify: `docs/superpowers/specs/2026-09-26-chat-decision-memory-design.md` (§9 "Adjustments found while implementing")

- [ ] **Step 1: Full check in Docker** (repo's CLAUDE.md command plus all tests):
```bash
docker run --rm --network host -u "$(id -u):$(id -g)" -e HOME=/tmp -e DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55432/termhub -e TERMHUB_DB_TESTS=1 -v "$PWD:/w" -w /w node:20 \
  sh -c 'cd apps/server && npx prisma migrate deploy && cd /w && npm test -w @termhub/server && npm run typecheck -w @termhub/server && npm run build -w @termhub/web && npm test -w @termhub/web && npm run build -w @termhub/landing && npm run typecheck -w @termhub/mobile && npm test -w @termhub/mobile && npm test -w @termhub/mobile-api'
rm -rf .npm
```
(The web tests may need `npm run build:city -w @termhub/web` first, as in CI.) Expected: all green. Any failure → fix in the owning task's files, commit.

- [ ] **Step 2: Real embeddings against the real DB.** Start `th-embed-test` again (Task 2 Step 5 command, same volume), then a short script (`apps/server/scripts/` is **not** where it goes — put it in the scratchpad) using the built repository + `httpEmbedder('http://127.0.0.1:58000','t')`: insert decisions for "Usar git worktree para isolar o trabalho?" → `['Sim']` and "Qual cor usar no botão?" → `['Azul']`, `embedPending`, then `suggestFor` a new row "Criar um worktree isolado para esta tarefa?" with options `Sim | Não` — expect a suggestion of "Sim" — and "Qual framework de testes?" — expect none. Record the similarities; if the threshold 0.85 misses the paraphrase or accepts the unrelated one, adjust the default in `config.ts` and the spec, with the numbers.

- [ ] **Step 3: Clean up throwaway containers:** `docker rm -f th-embed-test th-test-db` (never any other container), `docker volume rm th-embed-models`, `docker image rm th-db-pgvector th-embed` is optional.

- [ ] **Step 4: Spec §9** — list what changed while implementing (e.g. the mobile screen's entry point in Ajustes, re-embedding on model change left out, threshold measured values).

- [ ] **Step 5: Commit** `git commit -m "Spec: record adjustments found while implementing (TER-57)"`
