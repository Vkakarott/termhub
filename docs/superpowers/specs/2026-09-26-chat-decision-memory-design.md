# Chat: decision memory — suggesting answers from past decisions — design

Card: **TER-57** (epic TER-1 · Chat). Builds on TER-56 (`tab_questions`, spec
`2026-09-25-chat-tab-questions-design.md`). Subtasks are listed in the implementation plan
(`docs/superpowers/plans/2026-09-26-chat-decision-memory.md`).

Project rule: everything the chat does must work in the mobile app too, in the same delivery.

## 1. Problem

The chat shows a tab's `AskUserQuestion` as a card (TER-56) and the user answers it with one click.
Agents ask the same kinds of questions over and over ("worktree or branch?", "TDD?", "which spec
location?"), across projects. Nothing remembers the answers: each card starts blank, and
`chat_messages` holds no structured question/answer pair to learn from.

## 2. Decisions

Closed in brainstorming (2026-09-26). The user approved §3 and then asked the rest to follow the
recommendations below without further questions.

| Topic | Decision |
|---|---|
| What is remembered | Each **question** of a `choice` tab question answered from the chat becomes a `chat_decisions` row (question, header, options, answer, project, conversation, date) with an embedding. An `AskUserQuestion` with 3 questions gives 3 decisions. |
| Permissions | **Never** remembered nor suggested: the row carries only the tool name, far too little context to decide on (and a wrong "yes" is the dangerous direction). |
| Behaviour on a match | **Suggest only.** The card opens with the past answer pre-selected, says where it came from, and the user's click still answers. Nothing is ever sent to a tab without a click. |
| Scope of the search | **Global per user**: every decision of the same user, any project, one threshold. The card names the source project. |
| Similarity | Local embeddings container (the whisper pattern) + **pgvector** in Postgres (HNSW, cosine). |
| DB image | A termhub image `FROM postgres:16-alpine` with pgvector compiled in, not the Debian `pgvector/pgvector:pg16`: same Postgres binary and libc (musl) as today, so collations do not change and no `REINDEX` is needed on the prod volume. |
| Management | A "Memória do chat" screen on **web and mobile** (list, search, forget, on/off switch), plus "Esquecer esta decisão" on the card. |
| Free-text relays by the concierge | Not captured. A tab question that reaches the chat is a card now; the concierge relays text only for machines on the old hook script, where there is no structured question to pair it with. |
| Backfill | From `tab_questions` rows already answered from the chat (structured, since TER-56). `chat_messages` is not mined (no question/options in it). |

## 3. Infrastructure and data

### 3.1 Database image and extension

- `docker/db/Dockerfile`: `FROM postgres:16-alpine`, builds pgvector (pinned tag) with the Alpine
  build deps in one layer and removes them. The compose `db` service gets `build: docker/db` and
  `image: termhub-db`.
- Migration `…_chat_decisions` starts with `CREATE EXTENSION IF NOT EXISTS vector;`.
- CI (`check` job): the Postgres service image becomes `pgvector/pgvector:pg16` (disposable test
  DB; libc does not matter there).
- **Production is not touched by this delivery.** The prod `termhub-db-1` must be recreated from the
  new image **before the merge**; otherwise the migration fails on the new color, its healthcheck
  never passes and `blue-green.sh` aborts (the old color keeps serving, but deploys are stuck). This
  is recorded as a pending item on the card. CI does not recreate `db` (it is shared by both colors).

### 3.2 Embeddings service

- `docker/embed/` (Python 3.12-slim, `fastembed`, model
  `sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2`, 384 dimensions, ONNX on CPU, no
  torch). Weights download into an `embed-models` volume on first start.
- API: `GET /health` (200 once loaded, 503 before); `POST /embed` with
  `{"texts": [..≤ 32 strings, each ≤ 2000 chars]}` → `{"model": "...", "dim": 384, "vectors": [[...]]}`.
  Every request needs `Authorization: Bearer $EMBED_SECRET`; an empty secret refuses everything.
  The log carries counts and timings, never texts.
- Compose service `embed` (profiles dev/prod, `restart: unless-stopped`), reachable only on the
  compose network. The app reads `EMBED_URL` (default `http://embed:8000` in compose) and
  `EMBED_SECRET`. CI's deploy job gets an `embed` step like `whisper` (recreated only when its image
  or config changes).
- Unset `EMBED_URL`, a down service or a timeout (2 s) → no suggestion and no embedding for now;
  nothing else changes. The server client lives in `apps/server/src/chat/embeddings.ts`.

### 3.3 Table `chat_decisions`

| Column | Type | Notes |
|---|---|---|
| `id` | text PK | `newId()` |
| `user_id` | text FK → users, cascade | who answered; the search scope |
| `project_id` | text FK → projects, set null, nullable | the tab's project |
| `conversation_id` | text FK → chat_conversations, set null, nullable | |
| `tab_question_id` | text, nullable | the source row (not a FK: rows may go) |
| `question_index` | int | position inside the `AskUserQuestion` |
| `header` | text | |
| `question` | text | |
| `options` | jsonb | `[{ label, description }]` as normalised (no "(Recommended)") |
| `multi_select` | boolean | |
| `answer` | jsonb | `{ labels: string[], text?: string }` — labels, not indexes, so it maps onto another question's options |
| `embedding` | `vector(384)`, nullable | null until computed |
| `embed_model` | text, nullable | which model produced `embedding` |
| `suggested_count`, `accepted_count` | int, default 0 | |
| `created_at` | timestamp(3) | |

Indexes: HNSW on `embedding vector_cosine_ops`; `(user_id, created_at)`; unique
`(tab_question_id, question_index)` where `tab_question_id` is not null (recording is idempotent,
and the backfill can run any number of times). Prisma declares `embedding` as
`Unsupported("vector(384)")?`; reads and writes of it are raw SQL in the repository
`db/repositories/chat-decisions.ts`.

### 3.4 Other columns

- `tab_questions.suggestion jsonb` (nullable): see §4.2.
- `users.chat_suggestions boolean default true`: the switch.

All additive; the previous release never reads them.

## 4. Flow

### 4.1 Decision text

`decisionText({ header, question, options })` =
`"<header>\n<question>\nOpções: <label 1> | <label 2> | …"`. Descriptions are left out (they are
long and vary more than the question itself). Pure function, used both to embed a decision and to
embed an incoming question.

### 4.2 Suggesting (question opens)

In `openTabQuestion`, after `repos.tabQuestions.open(...)` returns a `choice` row and **before**
`tab_question` is published:

1. Skip when the conversation's user has `chat_suggestions = false` or embeddings are unavailable.
2. Embed every question's `decisionText` in one call.
3. Per question, `repos.chatDecisions.nearest(userId, vector, k = 5)`: rows with an embedding, same
   `multi_select`, cosine similarity ≥ `DECISION_SUGGEST_THRESHOLD` (env, default `0.85`).
4. Among those candidates, **most recent first** (a newer answer to the same question supersedes an
   older one), take the first that **maps** onto the new question: every past label equals one of
   the new options' labels (compared lowercase, letters and digits only); a past free-text answer
   maps as text. A single-select needs exactly one label or the text.
5. Store `suggestion = { items: [{ question_index, decision_id, similarity, selected: number[],
   text?: string, source: { question, project_name, answered_at } }] }` on the row (only questions
   that matched), increment `suggested_count` of each used decision, and publish the card with it.

The whole step is best effort under a 2 s budget: any error or timeout publishes the card without a
suggestion. It never throws into `noteHookEvent`. Logs: tab question id, counts and the best
similarity, never text.

### 4.3 Recording (question answered)

In `answerTabQuestion`, after the keys went through (`runKeyPlan` succeeded) and only for
`choice` rows:

1. For each question, insert a decision (`answer.labels` from the selected indexes, `text` from the
   free text) — `ON CONFLICT DO NOTHING` on `(tab_question_id, question_index)`.
2. For each suggestion item whose answer equals what the user sent, increment the decision's
   `accepted_count`.
3. Embed the new rows asynchronously (`void`), writing `embedding` + `embed_model`.

Recording is best effort: an error there is logged and never changes the HTTP result, like the
announce step that follows it today.

### 4.4 Sweeper

`startDecisionSweeper(repos, log)` (wired in `app.ts` next to `startTabQuestionExpiry`) runs once at
start and every 10 minutes:

- **Backfill:** answered `choice` rows of `tab_questions` with no decision yet → decisions (same
  code as §4.3 step 1).
- **Embed:** decisions with `embedding IS NULL` (or another `embed_model` than the service reports),
  in batches of 32.

Skipped entirely without embeddings; errors are logged by count.

### 4.5 Forgetting and the switch

- `DELETE` of a decision removes the row (hard delete). A card still pointing at it keeps working;
  "Esquecer" on it answers 204 even if already gone.
- `chat_suggestions = false` stops §4.2 only; decisions are still recorded (so turning it back on is
  useful at once).

### 4.6 API

All under the `chat` resource (`guarded('chat', …)`), all scoped to the requesting user
(`user_id = request.user.id`; decisions are personal, no admin view of other users):

| Web | Mobile | |
|---|---|---|
| `GET /api/chat/decisions?q=&cursor=` | `GET /api/m/v1/chat/decisions?q=&cursor=` | newest first, 50 per page; `q` is a case-insensitive substring over header/question/answer text |
| `DELETE /api/chat/decisions/:id` | `DELETE /api/m/v1/chat/decisions/:id` | 204 |
| `GET /api/chat/memory` | `GET /api/m/v1/chat/memory` | `{ enabled, available, count }` (`available` = embeddings configured) |
| `PATCH /api/chat/memory` | `PATCH /api/m/v1/chat/memory` | `{ enabled: boolean }` |

A decision view: `{ id, project_id, project_name, header, question, options, multi_select,
answer, suggested_count, accepted_count, created_at }` (never the vector). Inputs validated with
zod. Contracts added to `packages/mobile-api`.

### 4.7 Concierge

No change: an answered question still reaches the model on the next turn through `injected_at`.

## 5. Clients

### 5.1 Card (web `TabQuestionCard.tsx`, mobile `tab-question-card.tsx`)

`TabQuestionView` gains `suggestion` (nullable; older apps ignore it, zod objects are not strict).
On an **open** choice card with a suggestion item for a question:

- that question starts pre-selected (options) or with the text field filled;
- a line under it: "Sugestão da memória: você respondeu «X» a «pergunta» em <projeto>, <data>" and
  a link "Esquecer esta decisão" (calls `DELETE`, then clears the pre-selection);
- the user can change anything before "Responder"; nothing is sent without the click.

Answered/closed cards show no suggestion line.

### 5.2 "Memória do chat" screen

- Web: a page `/chat/memoria`, linked from the chat header ("Memória"). Switch "Sugerir respostas
  com base nas minhas decisões", a note when embeddings are unavailable ("Sugestões indisponíveis
  neste servidor"), a search field, and the list (question, answer, project, date,
  "sugerida N× · aceita M×", "Esquecer" with confirm), paginated.
- Mobile: the same screen reached from the chat screen's header menu, same content, "Esquecer" with
  a native confirm. No PIN (consistent with TER-56 cards).

## 6. Testing

- Server unit (fake repos / fake embedder): `decisionText`; label mapping (exact, case/accents,
  missing label, text answer, multi-select); suggestion selection (threshold, most recent wins,
  mismatched `multi_select`, switch off, embedder down or slow → no suggestion, publishes anyway);
  recording after a successful answer (not after a failed send, permission rows ignored, accepted
  count); sweeper (backfill idempotent, embed batches); routes (scope, zod, pagination, delete 204,
  memory get/patch).
- DB tests (`*.db.test.ts`, `TERMHUB_DB_TESTS=1`, pgvector image): migration, `nearest` ordering
  and filtering by user, unique index idempotency, raw vector write/read.
- Embed service: a Python unit test of the request validation and auth (model mocked), plus a
  manual smoke test in a `th-embed-test` container.
- Web and mobile component tests: card with suggestion (pre-selected, text filled, forget), memory
  screen (list, search, forget, switch, unavailable note).
- Mobile events parity test updated for the view field.

## 7. Out of scope

- Answering alone (auto-send) — explicitly rejected in favour of suggestions.
- Permission questions and tab suggestions (`kind = suggestion`).
- Mining `chat_messages`; capturing concierge free-text relays.
- A per-project scope or per-project switch.
- Recreating the production DB container (pending item, §3.1).
