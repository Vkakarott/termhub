# Chat decision memory: embed the normalised question only — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Suggest past decisions for near-verbatim repeats more often and never for opposite-verb look-alikes, by embedding only the normalised question text instead of `header + question + options`, with the same model and dimension.

**Architecture:** `decision-text.ts` gets `embedText` (lower-cased question, whitespace collapsed, trailing punctuation stripped) and `embedTag` (`<model>#q1`). Every vector written to `chat_decisions.embed_model` carries that tag; `nearest` only compares rows whose tag equals the query's, and `listToEmbed` also returns rows embedded under an older text version so the existing sweeper re-embeds them. No migration: `embed_model` already exists and stays `text`.

**Tech Stack:** TypeScript, Fastify, Prisma raw SQL on Postgres + pgvector, vitest.

**Spec:** `docs/superpowers/specs/2026-09-26-chat-decision-memory-design.md` (§4, §9) and the measurements in card TER-204.

## Global Constraints

- Model stays `sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2`, column stays `vector(384)`; no Prisma migration.
- `DECISION_SUGGEST_THRESHOLD` default stays `0.98`.
- Backward compatible with the previous release running side by side (blue/green): the old container writes untagged `embed_model` and full-text vectors; the new one must not compare against those and must re-embed them.
- Never log question or answer text (only ids, counts, codes, similarity numbers).
- Code comments and identifiers in English; UI copy untouched.

## Review Focus

- A row embedded by the previous release (untagged `embed_model`, e.g. `sentence-transformers/…`) must never be returned by `nearest` for a tagged query, and must be picked up by `listToEmbed` → re-embedded with the tag.
- Rows with `embedding IS NULL` must come before stale-version rows in `listToEmbed` (a fresh decision should not wait behind a backlog of re-embeds).
- `embedText` of a question that is only punctuation/whitespace yields an empty string; the embed service rejects nothing for that, but it must not throw in TS.
- A tag must match exactly, not by prefix: `m#q1` must not match `m#q10` or `m2#q1`.
- The embed service's `model` field is whatever the service reports; the tag is built from the response, not from config.

---

### Task 1: `embedText` and `embedTag`

**Files:**
- Modify: `apps/server/src/chat/decision-text.ts`
- Test: `apps/server/src/chat/decision-text.test.ts`

**Interfaces:**
- Produces: `export const EMBED_TEXT_VERSION = 'q1'`; `export function embedText(item: { question: string }): string`; `export function embedTag(model: string): string` (returns `` `${model}#${EMBED_TEXT_VERSION}` ``). `decisionText` stays for now (Task 3 removes it).

- [ ] **Step 1: Write the failing tests** (append to `decision-text.test.ts`, import the new names)

```ts
describe('embedText', () => {
  it('is the question alone, lower-cased, without trailing punctuation', () => {
    expect(embedText({ question: 'Usar git worktree para isolar o trabalho?' })).toBe('usar git worktree para isolar o trabalho');
  });
  it('ignores header and options, so a changed header or reordered options embed the same', () => {
    const a = { header: 'Isolamento', question: 'Usar worktree?', options: [{ label: 'Sim' }, { label: 'Não' }] };
    const b = { header: 'Git', question: 'Usar worktree?', options: [{ label: 'Não' }, { label: 'Sim' }, { label: 'Talvez' }] };
    expect(embedText(a)).toBe(embedText(b));
  });
  it('collapses whitespace and strips every trailing ?!.:; plus surrounding spaces', () => {
    expect(embedText({ question: '  Fazer   commit\n agora ?! ' })).toBe('fazer commit agora');
    expect(embedText({ question: 'Pronto.' })).toBe('pronto');
  });
  it('keeps inner punctuation and accents', () => {
    expect(embedText({ question: 'Salvar em docs/plans, ou não?' })).toBe('salvar em docs/plans, ou não');
  });
  it('gives an empty string for a question that is only punctuation', () => {
    expect(embedText({ question: ' ?! ' })).toBe('');
  });
});

describe('embedTag', () => {
  it('appends the text version to the model name', () => {
    expect(EMBED_TEXT_VERSION).toBe('q1');
    expect(embedTag('sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2')).toBe('sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2#q1');
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run (from the worktree root): `docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/w" -w /w node:22 sh -c 'npx vitest run apps/server/src/chat/decision-text.test.ts --root apps/server'`
Expected: FAIL, `embedText` / `embedTag` / `EMBED_TEXT_VERSION` not exported. (Requires `node_modules`; if missing, run `npm ci` in the same container first.)

- [ ] **Step 3: Implement** (in `decision-text.ts`, next to `decisionText`)

```ts
/** Bumped whenever `embedText` changes shape: every stored vector is tagged with it (`embedTag`), so
 *  vectors of another version are never compared and the sweeper re-embeds them (TER-204). */
export const EMBED_TEXT_VERSION = 'q1';

/**
 * The text a decision is embedded by (TER-204): the question alone, lower-cased, whitespace collapsed,
 * trailing `?!.:;` stripped. Header and option labels are left out on purpose: measured on real and
 * synthetic pairs, they pushed opposite yes/no questions ("Aceitar" × "Descartar as mudanças") over the
 * threshold and pulled a repeat with a new header under it; `mapAnswer` still requires the past labels
 * to exist among the new options.
 */
export function embedText(item: { question: string }): string {
  return item.question.replace(/\s+/g, ' ').trim().replace(/[?!.:;\s]+$/u, '').toLowerCase();
}

/** The `embed_model` value stored with a vector: the service's model name plus the text version. */
export function embedTag(model: string): string {
  return `${model}#${EMBED_TEXT_VERSION}`;
}
```

- [ ] **Step 4: Run to verify they pass** — same command, expected PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/chat/decision-text.ts apps/server/src/chat/decision-text.test.ts
git commit -m "Chat memory: add embedText and embedTag for question-only vectors"
```

---

### Task 2: repository — compare only same-tag vectors, re-embed stale ones

**Files:**
- Modify: `apps/server/src/db/repositories/chat-decisions.ts` (`listToEmbed` ~line 174, `nearest` ~line 184)
- Test: `apps/server/src/db/repositories/chat-decisions.db.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1 (the repository takes plain strings).
- Produces:
  - `listToEmbed(limit: number, tag: string): Promise<Pick<ChatDecision, 'id' | 'header' | 'question' | 'options'>[]>` — rows with `embedding IS NULL`, plus rows whose `embed_model` is null or does **not end with** `tag` (the caller passes `'#q1'`); null embeddings first, then oldest first.
  - `nearest(userId, vector, opts: { multiSelect: boolean; k: number; embedModel: string })` — adds `AND d.embed_model = ${opts.embedModel}` (exact match).

- [ ] **Step 1: Update and add DB tests**

Change the existing `listToEmbed` test call to `repo.listToEmbed(1000, '#q1')` and its `setEmbedding(decisionAId, vec(1), 'm')` to `'m#q1'`. In the `nearest` test, change every `setEmbedding(..., 'm')` to `'m#q1'` and the call to `repo.nearest(userId, vec(1), { multiSelect: false, k: 5, embedModel: 'm#q1' })`. Then add:

```ts
  it('listToEmbed also returns rows embedded under another text version, null embeddings first', async () => {
    const [stale] = await repo.insertMany([newDecision({ tab_question_id: newId(), header: 'Velha', question: 'Embedding antigo?' })]);
    await repo.setEmbedding(stale!.id, vec(3), 'm'); // previous release: untagged
    const [other] = await repo.insertMany([newDecision({ tab_question_id: newId(), header: 'Outra', question: 'Versao q10?' })]);
    await repo.setEmbedding(other!.id, vec(4), 'm#q10'); // a suffix that only starts like '#q1'
    const [fresh] = await repo.insertMany([newDecision({ tab_question_id: newId(), header: 'Nova', question: 'Sem embedding?' })]);

    const ids = (await repo.listToEmbed(1000, '#q1')).map((d) => d.id);
    expect(ids).toContain(stale!.id);
    expect(ids).toContain(other!.id);
    expect(ids.indexOf(fresh!.id)).toBeLessThan(ids.indexOf(stale!.id));

    await repo.setEmbedding(stale!.id, vec(3), 'm#q1');
    await repo.setEmbedding(other!.id, vec(4), 'm#q1');
    await repo.setEmbedding(fresh!.id, vec(5), 'm#q1');
    const after = (await repo.listToEmbed(1000, '#q1')).map((d) => d.id);
    expect(after).not.toContain(stale!.id);
    expect(after).not.toContain(other!.id);
    expect(after).not.toContain(fresh!.id);
  });

  it('nearest only compares vectors with exactly the same embed_model', async () => {
    const [untagged] = await repo.insertMany([newDecision({ tab_question_id: newId(), header: 'SemTag', question: 'Vetor antigo?' })]);
    await repo.setEmbedding(untagged!.id, vec(7), 'm');
    const [longer] = await repo.insertMany([newDecision({ tab_question_id: newId(), header: 'Q10', question: 'Outra versao?' })]);
    await repo.setEmbedding(longer!.id, vec(7), 'm#q10');
    const [tagged] = await repo.insertMany([newDecision({ tab_question_id: newId(), header: 'ComTag', question: 'Vetor novo?' })]);
    await repo.setEmbedding(tagged!.id, vec(7), 'm#q1');

    const ids = (await repo.nearest(userId, vec(7), { multiSelect: false, k: 50, embedModel: 'm#q1' })).map((n) => n.id);
    expect(ids).toContain(tagged!.id);
    expect(ids).not.toContain(untagged!.id);
    expect(ids).not.toContain(longer!.id);
  });
```

- [ ] **Step 2: Run to verify they fail** against a throwaway pgvector DB:

```bash
docker run -d --name th-ter204-db -e POSTGRES_PASSWORD=t -e POSTGRES_DB=termhub pgvector/pgvector:pg16
# wait until: docker exec th-ter204-db pg_isready -U postgres
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp --network container:th-ter204-db -v "$PWD:/w" -w /w \
  -e DATABASE_URL=postgresql://postgres:t@127.0.0.1:5432/termhub -e TERMHUB_DB_TESTS=1 node:22 \
  sh -c 'npx -w @termhub/server prisma migrate deploy && npx vitest run src/db/repositories/chat-decisions.db.test.ts --root apps/server'
```
Expected: FAIL (the stale row is not listed; the untagged row is returned by `nearest`; TS type error on `embedModel` is fine at runtime under vitest).

- [ ] **Step 3: Implement** in `chat-decisions.ts`

```ts
  /** The sweeper's backlog, at most `limit` rows: never embedded (first, oldest first), then embedded
   *  under another text version — `embed_model` not ending with `tag` (`'#q1'`), e.g. a row the previous
   *  release wrote untagged during a blue/green overlap (TER-204). `embedding` is `Unsupported` in
   *  Prisma, so this and every other read that touches it goes through raw SQL. */
  async listToEmbed(limit: number, tag: string): Promise<Pick<ChatDecision, 'id' | 'header' | 'question' | 'options'>[]> {
    const rows = await this.db.$queryRaw<{ id: string; header: string; question: string; options: unknown }[]>`
      SELECT id, header, question, options FROM "chat_decisions"
      WHERE embedding IS NULL OR embed_model IS NULL OR right(embed_model, length(${tag})) <> ${tag}
      ORDER BY (embedding IS NULL) DESC, created_at ASC LIMIT ${limit}`;
    return rows.map((r) => ({ id: r.id, header: r.header, question: r.question, options: r.options as DecisionOption[] }));
  }
```

In `nearest`: signature `opts: { multiSelect: boolean; k: number; embedModel: string }`, add `AND d.embed_model = ${opts.embedModel}` to the `WHERE`, and extend its doc comment: "Only rows embedded with exactly `embedModel` (model + text version, `embedTag`): a vector of another model or text version is not comparable."

- [ ] **Step 4: Run to verify they pass** — same command, expected PASS for the whole file.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/db/repositories/chat-decisions.ts apps/server/src/db/repositories/chat-decisions.db.test.ts
git commit -m "Chat memory: compare only same-version vectors, re-embed stale ones"
```

---

### Task 3: wire the memory to `embedText`/`embedTag`, drop `decisionText`, docs

**Files:**
- Modify: `apps/server/src/chat/decision-memory.ts` (`suggestFor`, `embedInserted`, `embedPending`)
- Modify: `apps/server/src/chat/decision-text.ts` + `decision-text.test.ts` (remove `decisionText` and its test)
- Test: `apps/server/src/chat/decision-memory.test.ts`
- Modify: `apps/server/src/config.ts` (comment of `DECISION_SUGGEST_THRESHOLD`), `README.md` (line ~154 paragraph), `docs/superpowers/specs/2026-09-26-chat-decision-memory-design.md` (new bullet at the end of §9)

**Interfaces:**
- Consumes: `embedText`, `embedTag`, `EMBED_TEXT_VERSION` (Task 1); `listToEmbed(limit, tag)`, `nearest(..., { embedModel })` (Task 2).

- [ ] **Step 1: Write the failing tests** in `decision-memory.test.ts`

```ts
  it('embeds the normalised question only and searches vectors of the same model and text version', async () => {
    const nearest = vi.fn(async () => []);
    const repos = { users: { chatSuggestions: vi.fn(async () => true) }, chatDecisions: { nearest, bumpSuggested: vi.fn(async () => {}) } };
    const e = embedder();
    await suggestFor(repos as never, row(), { embedder: e, threshold: 0.85, log: log() });
    expect(e.embed).toHaveBeenCalledWith(['qual cor']);
    expect(nearest).toHaveBeenCalledWith('u1', [1, 0], { multiSelect: false, k: 5, embedModel: 'm#q1' });
  });
```
(inside `describe('suggestFor')`). In `describe('embedPending')` change the existing expectations to `expect(chatDecisions.listToEmbed).toHaveBeenCalledWith(32, '#q1')`, `expect(e.embed).toHaveBeenCalledWith(['qual cor'])` and `expect(chatDecisions.setEmbedding).toHaveBeenCalledWith('d1', [1, 0], 'm#q1')`. In the `recordDecisions` test that checks the fire-and-forget embed (line ~185), change its `setEmbedding` expectation's model to `'m#q1'` and assert the embed call got the normalised question(s) (e.g. `['qual cor']`). Update any other `setEmbedding(…, 'm')` expectation in the file to `'m#q1'`.

- [ ] **Step 2: Run to verify they fail**
Run: `docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/w" -w /w node:22 sh -c 'npx vitest run src/chat --root apps/server'` — expected FAIL.

- [ ] **Step 3: Implement** in `decision-memory.ts`
  - import `embedTag, embedText, EMBED_TEXT_VERSION` instead of `decisionText`.
  - `suggestFor`: `const { model, vectors } = await embedder.embed(items.map(embedText));` and `nearest(row.user_id, vectors[i]!, { multiSelect: item.multi_select, k: SUGGEST_K, embedModel: embedTag(model) })`.
  - `embedInserted`: `embedder.embed(rows.map(embedText))`, `setEmbedding(r.id, vectors[i]!, embedTag(model))`.
  - `embedPending`: `repos.chatDecisions.listToEmbed(limit, '#' + EMBED_TEXT_VERSION)`, `embed(rows.map(embedText))`, `setEmbedding(..., embedTag(model))`; doc comment adds "and rows embedded under another text version (TER-204), which is how a deploy re-embeds the old ones".
  - Remove `decisionText` from `decision-text.ts` and its `describe('decisionText')` block from the test.
  - `config.ts`: replace the threshold comment with: "similarity threshold for suggesting past decisions (0..1), on the normalised question alone (TER-204): the worst opposite-meaning pair measured scores 0.948 and a repeat with another header or options scores 1.0; lower it to trade precision for paraphrases."
  - `README.md` ~line 154: after "…pgvector in Postgres;" say the vector is of the question alone, normalised (header and options are ignored; the past answer must still match the new options).
  - Spec §9: add a bullet "**Question-only embeddings (TER-204).**" summarising: embed `embedText` (normalised question), `embed_model` = `<model>#q1`, `nearest` exact tag match, sweeper re-embeds other versions; measured: worst opposite pair 0.989 → 0.948 on the held-out set, real near-verbatim repeats at 0.98 71% → 86%; paraphrases still not suggested; no model change was worth it (table in TER-204).

- [ ] **Step 4: Run** the chat unit tests (expected PASS), then the server typecheck: `docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/w" -w /w node:22 sh -c 'npm run typecheck -w @termhub/server'` (expected exit 0).

- [ ] **Step 5: Commit**

```bash
git add -A apps/server/src README.md docs/superpowers/specs/2026-09-26-chat-decision-memory-design.md
git commit -m "Chat memory: embed the normalised question only (TER-204)"
```
