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
| Similarity | Local embeddings container (the whisper pattern) + **pgvector** in Postgres (exact cosine scan over the user's rows, no ANN index — §3.3). |
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
- Unset `EMBED_URL` or `EMBED_SECRET` (in compose `EMBED_URL` falls back to `http://embed:8000`, so
  there it is an empty `EMBED_SECRET` that turns the memory off), a down service or a timeout (2 s)
  → no suggestion and no embedding for now;
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

Indexes: `(user_id, created_at)`; unique
`(tab_question_id, question_index)` where `tab_question_id` is not null (recording is idempotent,
and the backfill can run any number of times). Prisma declares `embedding` as
`Unsupported("vector(384)")?`; reads and writes of it are raw SQL in the repository
`db/repositories/chat-decisions.ts`.

No index on `embedding`: `nearest` is an exact cosine scan of the requesting user's rows (filtered by
`user_id`). One person's decisions are few (hundreds to low thousands), so the scan is cheap, and it
never loses a true match the way an HNSW index does when it post-filters by user. It also keeps the
schema expressible in Prisma, which the CI drift check (`prisma migrate diff --exit-code`) requires.

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
   `multi_select`, cosine similarity ≥ `DECISION_SUGGEST_THRESHOLD` (env, default `0.98`, measured in §9).
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
- **Embed:** decisions with `embedding IS NULL`, in batches of 32. (Re-embedding after a model change
  is out of scope; every row records its `embed_model` so it can be done later.)

Without embeddings only the embed step is skipped: the backfill still runs, since decisions are
recorded regardless (§4.5). Errors are logged by count.

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
| `GET /api/chat/decisions?q=&cursor=` | `GET /api/m/v1/chat/decisions?q=&cursor=` | newest first, 50 per page; `q` is a case-insensitive substring over header, question, project name and the answer's labels/text |
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
- on a card with several questions, each question tab that carries a suggestion is labelled
  "<header> · sugerida", and "Responder" stays disabled until every suggested question has been
  viewed at least once (the one shown first counts), so no pre-selected answer is sent unseen.

Answered/closed cards show no suggestion line.

### 5.2 "Memória do chat" screen

- Web: a page `/chat/memoria`, linked from the chat header ("Memória"). Switch "Sugerir respostas
  com base nas minhas decisões", a note when embeddings are unavailable ("Sugestões indisponíveis
  neste servidor"), a search field, and the list (question, answer, project, date,
  "sugerida N× · aceita M×", "Esquecer" with confirm), paginated.
- Mobile: the same screen (route `/chat-memory`) reached from a "Memória do chat" row in the Ajustes
  tab, same content, "Esquecer" with a native confirm. No PIN (consistent with TER-56 cards).

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

## 9. Adjustments found while implementing

- **Mobile entry point.** The "Memória do chat" screen is reached from a row in the Ajustes tab
  (route `/chat-memory`), as §5.2 already says; the web page is linked from the chat header.
- **Re-embedding on a model change** stays out of scope (§4.4); `embed_model` is stored per row so
  it can be added later.
- **Threshold calibrated: default `0.98`, not `0.85`.** Measured with the real `th-embed` service
  (`paraphrase-multilingual-MiniLM-L12-v2`) on `decisionText`-shaped inputs (header + question +
  "Opções: …"), pt-BR and English:

  | Kind | Pair | Cosine |
  |---|---|---|
  | same decision | verbatim question, options reordered | 0.995 |
  | same decision | verbatim question, one extra option | 0.992 |
  | same decision | skill question, punctuation changed | 0.992 |
  | same decision | verbatim question, different header | 0.987 |
  | same decision | "Rodar os testes agora?" / "Executar a suíte de testes agora?" | 0.964 |
  | same decision | skill question, small wording change (en) | 0.954 |
  | same decision | "Should I commit these changes now?" / "Commit these changes now?" | 0.953 |
  | same decision | "Fazer commit agora?" / "Faço o commit agora?" | 0.951 |
  | same decision | worktree vs branch, pt / en | 0.902 |
  | same decision | "Qual abordagem seguir?" / "Como executar o plano?" | 0.875 |
  | same decision | "Onde salvar o spec?" / "Where should the spec go?" | 0.860 |
  | same decision | commit now or later, pt / en | 0.850 |
  | same decision | commit now, two pt-BR phrasings | 0.819 |
  | same decision | worktree, two pt-BR phrasings | 0.796 |
  | same decision | push the branch, two en phrasings | 0.659 |
  | same decision | TDD, two pt-BR phrasings | 0.640 |
  | same decision | TDD, two en phrasings | 0.562 |
  | **must not match** | "Adicionar testes para este caso?" / "Pular os testes deste caso?" (Sim/Não) | **0.974** |
  | **must not match** | "Fazer merge na main?" / "Abrir um PR para a main?" (Sim/Não) | **0.959** |
  | **must not match** | deploy to staging / to production (pt) | 0.910 |
  | must not match | deploy to staging / to production (en) | 0.876 |
  | must not match | install / remove the same library (Sim/Não) | 0.874 |
  | must not match | "Commit now?" / "Push now?" (en, same header) | 0.844 |
  | must not match | restart / stop the app container | 0.808 |
  | must not match | "Fazer commit agora?" / "Fazer push agora?" (same header) | 0.799 |
  | must not match | run the tests / run the lint now | 0.793 |
  | must not match | delete the branch / delete the worktree | 0.762 |
  | must not match | merge locally / discard the branch | 0.744 |
  | must not match | spec location / plan location | 0.538 |
  | must not match | commit / push, different headers | 0.504 |
  | must not match | worktree / deploy (Sim/Não) | 0.395 |
  | must not match | delete generated files / run the test suite | 0.306 |
  | must not match | TDD / new migration (Sim/Não) | 0.275 |
  | unrelated | season / database | 0.259 |
  | unrelated | button colour / test framework | 0.159 |
  | unrelated | worktree / button colour | 0.148 |

  No threshold separates paraphrases from near-misses: short yes/no questions are dominated by the
  shared header and "Sim | Não", so opposite actions ("adicionar"/"pular" testes) score 0.974 while
  a true cross-language paraphrase scores 0.86–0.90 and some same-language paraphrases 0.56–0.66.
  A wrong pre-selection is worse than none, so the default is precision-first: `0.98` catches the
  near-verbatim repeats (≥ 0.987 — the common case, since skills and agents ask the same question
  in the same words) and gives up paraphrases. The env variable lets an instance trade precision for
  recall. End-to-end check against the real DB and service (repository + `httpEmbedder` +
  `suggestFor`): a stored "Usar git worktree para isolar o trabalho?" → Sim is suggested for the
  same question with an extra option (0.996), not for "Criar um worktree isolado para esta
  tarefa?" (0.741, which the old `0.85` would have missed as well), and "Qual framework de testes?"
  gets nothing (0.347).
- **The sweeper backfills even without an embedder**; only the embed step is skipped (§4.4 fixed).
- **Backfill guards.** It ignores rows answered in the last minute (the live recording in §4.3 is
  still in flight for them), and rows whose payload or answer cannot be parsed or no longer fit are
  skipped through an in-memory skip set instead of being re-selected on every run.
- **The suggestion is published only while the row is still open.** `setSuggestion` updates open
  rows only; when it returns nothing no card is republished, and after a slow lookup that found no
  suggestion the row is re-read and announced only if still open.
- **Memory routes use the default method actions** (`GET` → `chat:read`, `PATCH` → `chat:update`,
  `DELETE` → `chat:delete`). The BETA role has chat CRUD; a custom role with only `chat:read` can list but not
  forget or switch.
- **Mobile:** the store owns the search debounce and it is cancelled when the screen unmounts; a
  failed forget shows "Não foi possível esquecer a decisão".
- **No HNSW index on `embedding`** (§3.3). Prisma cannot express it, so the CI drift check
  (`prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code`) exited
  2 with "Removed index on columns (embedding)" and would have blocked every deploy. The index was
  dropped from the (not yet deployed) migration: `nearest` is an exact cosine scan filtered by
  `user_id`, cheap at one person's scale, and it removes a recall problem too — HNSW with the default
  `ef_search = 40` post-filters by user and can drop a user's true matches. Verified on a fresh
  pgvector DB: `migrate deploy`, then the CI drift command exits 0 ("No difference detected").
- **Search covers the project name and the answer's values.** `q` matches header, question,
  `projects.name` and the answer's `labels[]`/`text` values; it no longer matches the raw
  `answer::text`, where the jsonb keys "labels"/"text" matched every row.
- **Labels win over text when mapping a past answer** (§4.2 step 4). A past answer holding both
  labels and free text maps to the labels only: the card sends one or the other, so a suggestion
  carrying both could never equal what the person sends and would never count as accepted.
- **Compose comment corrected.** `EMBED_URL` falls back to the embed service when unset, so an empty
  `EMBED_SECRET` (not an unset `EMBED_URL`) is what turns suggestions off in compose.
- **Multi-question cards: no unseen suggestion is sent** (§5.1). With several suggested questions,
  "Responder" was enabled at once and sent pre-selected answers of tabs the person never opened. Now
  each suggested tab is labelled " · sugerida" and "Responder" waits until every suggested question
  was viewed (the first one counts as viewed). Single-question cards are unchanged. Web and mobile.
