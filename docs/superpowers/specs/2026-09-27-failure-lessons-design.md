# Failure lessons: what an agent learned fixing an error, found again by the next one — design

Card: **TER-205** (epic TER-1 · Chat). Origin: spike TER-110 (a post on "swarm knowledge protocols" /
failure-memory). Builds on **TER-95** (`memory_items`, `search_memory`, the docs sweeper, the `memory`
token scope; spec `2026-09-26-concierge-memory-mcp-design.md`) and **TER-57** (the embed service and
the Memória do chat screen). Related cards: TER-212 (the termhub MCP inside agent tabs) and TER-217
(export lessons to the repository), which this design absorbs (§11). Subtasks are listed in the plan
(`docs/superpowers/plans/2026-09-27-failure-lessons.md`).

Project rule: everything the chat does must work in the mobile app too, in the same delivery.

## 1. Problem

An agent in one tab spends 40 minutes on an error that another tab, on another machine of the same
person, fixed yesterday. What an agent learned while debugging is lost when its tab closes: TER-57
remembers only answers to choice questions, and TER-95 indexes cards, messages, specs and plans, not
"this error means that, fix it like this".

## 2. Decisions

D1–D3 were chosen by Pedro in the brainstorm (2026-09-27); the rest are Claude's recommendation, taken
alone as asked.

| # | Topic | Decision | Why |
|---|---|---|---|
| D1 | Where a lesson lives | **In the project repository**, one markdown file per lesson under `docs/lessons/`, committed with the fix. | Works for any agent (Claude, Codex, with or without the termhub MCP: `grep` is enough), travels between machines with the repo, provenance is the git history and the PR, review is the PR review. |
| D2 | Project note too | Lessons can **also** be written into the project's note (the markdown "Notas" of a project), by the person (editing it) and by agents through a new MCP tool `record_lesson`. | Pedro's request: the note is the project's shared notebook; a lesson that does not belong in the repo (infra, a machine quirk) still has a home. |
| D3 | How agents are told | **Both**: a short block in the project's `CLAUDE.md`/`AGENTS.md` (the termhub repo first, by this delivery), and a one-line reminder appended by `start_agent` to the first prompt. | The instructions file reaches every session (opened by termhub or not, Claude or Codex); the reminder covers projects that do not have the block yet. |
| D4 | File format | `docs/lessons/YYYY-MM-DD-<slug>.md` with a YAML front matter (`symptom`, `tags`, `evidence`, `card`, `pr`, `agent`, `date`) and three sections (`## Cause`, `## Fix`, `## How to check`). Language: the repository's docs language (English in termhub). | A fixed shape keeps lessons greppable by `symptom` and lets the indexer build a good title without an LLM. MisakaNet's frontmatter (confidence/evidence + PRs) is the reference. |
| D5 | Indexing files | TER-95's docs sweeper also reads `docs/lessons/*.md` (same RPCs `docs.scan`/`docs.read`, same caps). A file under `docs/lessons/` becomes items of kind **`lesson`**, trust `derived`, title = the `symptom` (fallback: the path), chunked like a doc. | Reuses the whole TER-95 path (agent RPC, sha256 skip, chunking, embedding sweeper). |
| D6 | Indexing the note | The project note becomes a new source: kind **`project_note`** (trust `person`) for the person's text, split by heading like a doc, and kind **`lesson`** (trust `derived`) for each block an agent appended. Re-indexed when the note is saved (and by the memory sweeper when `updated_at` is newer than the items). | Only the person edits the note's free text through the screen, so it is `person`; agent text is fenced in marked blocks so it can never be mistaken for the person's. |
| D7 | Agent blocks in the note | `record_lesson` appends, under a `## Lições` heading it creates at the end if missing, a block `<!-- termhub:lesson id=<id> at=<ISO> tab=<tab id or -> -->` … `<!-- /termhub:lesson -->`. Any `<!--`/`-->` in the agent's text is neutralised before writing. The rendered note hides the markers (DOMPurify drops comments). | A deterministic fence: the indexer's trust split and the save merge (D9) both key on it, and an agent cannot open or close a fence from inside its own text. |
| D8 | Verification before trust | A lesson starts **not verified**. The Memória do chat screen (web and mobile) gets a "Lições" list: Verificar, Abrir origem, Esquecer. "Verificar" stores who and the hash of the lesson text; a changed text drops the mark. `search_memory` returns `verified` and `evidence` for lessons, and its description tells the model to prefer verified lessons and to treat the rest as hypotheses to check. Lessons never back `answer_tab_question` `mode: "auto"` (TER-95 D2/D6 already forbid any `derived` source). | The post's point: "a protocol without verification shares garbage as fast as truth". The mark is the person's act; the hash keeps an edited lesson from inheriting it. |
| D9 | Note saves vs. appends | The note stays one document with autosave. `PUT /projects/:id/note` gains an optional `base_updated_at`: when the note changed since then, the server keeps the lesson blocks whose `at` is newer than `base_updated_at` and that are missing from the submitted content, appending them to the submission (inside `## Lições`). Appends and saves take a row lock on the note. The editor adopts the returned content when it differs and nothing was typed since. | A person with the editor open would otherwise erase a lesson an agent just appended. Server-side merge covers the keep-alive save on page unload, where a 409 would lose the person's edits. A block the person deleted was loaded before, so its `at` is older than the base and it stays deleted. |
| D10 | `record_lesson` | MCP tool, scope `memory` (TER-95 D14), grant `notes:update`. Input: `project_id`, `symptom` (1–300), `cause` (1–2000), `fix` (1–2000), `evidence?` (`observed`\|`fixed`\|`confirmed`, default `fixed`), `card?` (a ref like `TER-12`), `pr?` (URL), `tab_id?`. Checks the project and tab through `ctx.scoped`. Caps: 20 lessons per user per hour, note ≤ 200 000 chars (the PUT limit). Returns `{ lesson_id, ref }`. | The same cap idea as TER-95's notes: a loop or an injection cannot flood the note. The note limit is the existing one. |
| D11 | Gate | `record_lesson` is **self-mediated** on a gated (concierge) token, like `record_decision`: no confirmation card, because the effect is a visible, forgettable, unverified block. Listed explicitly in `gate.ts`. | Asking to confirm every lesson would stop the concierge from recording one while the person is away, and an unverified lesson changes nothing on its own. |
| D12 | Concierge | The orchestrator prompt's "Memória" block (TER-95 D17) gains one line: when a tab is stuck on an error, search memory for lessons (`kinds: ["lesson"]`) and hand the tab the verified ones; after a tab fixes a non-trivial error, record a lesson if the tab did not write one. No new wake path. | The "tab entered `error`" signal only means a Claude API failure (`StopFailure`), not "stuck on a bug"; a server-side reaction to it would fire on the wrong thing. The concierge already watches tabs when asked. |
| D13 | `start_agent` reminder | `launchLine` receives the prompt with one sentence appended (pt-BR, like the product): "Antes de depurar um erro, procure em docs/lessons/ e nas lições do projeto; ao resolver um erro que não era óbvio, registre uma lição (formato em docs/lessons/README.md)." The prompt limit (4000) counts the reminder; a prompt that no longer fits is refused as today. | Short, fixed, and it points to the format instead of repeating it. |
| D14 | `docs/lessons/README.md` | This delivery adds `docs/lessons/README.md` to the termhub repo (the format, one example) and the CLAUDE.md block. Other projects get the block by their own PR; the product does not write into repositories. | termhub never pushes into a person's repository on its own; the README is what the reminder and the block point to. |

## 3. Data

All additive and nullable/defaulted; the previous release never reads them (blue/green safe).

- `memory_items.kind` (TER-95, a text column) gains the values `lesson` and `project_note`. `MemoryKind`
  in the repository and the `kinds` enum of `search_memory` gain both.
- `memory_items.verified_at timestamp(3)` nullable, `verified_by text` nullable (user id, FK → users,
  set null), `verified_hash text` nullable (the item's `content_hash` when it was verified). `verified`
  = `verified_at is not null and verified_hash = content_hash`.
- `memory_items.hidden_hash text` nullable: set by "Esquecer" on a file lesson to the item's
  `content_hash`; search and the lessons list skip rows where `hidden_hash = content_hash`. A changed
  file (new hash) comes back as a new, unverified lesson.
- `memory_items.meta jsonb` nullable: for `lesson`, `{ evidence, card, pr, tags, agent, tab_id,
  machine_id, origin: 'file' | 'note', path? }` (the parsed front matter or the `record_lesson`
  input). Never a place for free text: every value is capped (tags ≤ 10 × 40 chars, strings ≤ 300).
- `source_id` for lessons: a file chunk keeps TER-95's doc form `<project_machine_id>:<path>`; a note
  block is `note:<project_id>:<lesson id>`; a note section is `note:<project_id>` with `chunk_index` =
  section index.
- Verification and hiding survive re-indexing: the upsert by `(kind, source_id, chunk_index)` leaves
  the `verified_*` and `hidden_hash` columns alone, and `verified` is computed against the new `content_hash`.

## 4. Indexing

In `apps/server/src/memory/` (TER-95's module).

- **Files** (`docs.ts`): the scan script's directory list gains `docs/lessons`, and `docPath` in
  `agent-protocol` accepts `docs/lessons/<name>.md`. A path under `docs/lessons/` is indexed as
  `lesson`: `parseLessonFile(md)` reads the front matter (a small line parser for `key: value` and
  `key: [a, b]`; anything else is ignored), title = `symptom` (≤ 300 chars) or the path, text = the body
  chunked by `chunkMarkdown`, `meta` from the front matter plus `origin: 'file'` and `path`.
  `docs/lessons/README.md` is skipped. An agent older than the one that knows `docs/lessons` just
  returns fewer files (the RPC validates paths, so the server version-gates nothing).
- **Note** (`note.ts`): `splitNote(content)` → `{ sections: {heading, text}[], lessons: {id, at, tab,
  text}[] }` (fences parsed strictly: an unclosed fence is text of the person's section and is indexed
  as `project_note`, never as a lesson). `indexProjectNote(repos, projectId)` upserts both kinds and
  deletes items of blocks/sections no longer present. Called after every note save and every
  `record_lesson` (best effort, `void`), and by the memory sweeper for notes whose `updated_at` is newer
  than their newest item (covers a crash between save and index).
- A lesson block's text as indexed: `"Sintoma: …\nCausa: …\nCorreção: …"`, title = symptom.
- Embedding: unchanged (TER-95's sweeper and immediate embed).

## 5. MCP

- `record_lesson` (D10). The block written:

  ```markdown
  <!-- termhub:lesson id=l_ab12 at=2026-09-27T03:10:00.000Z tab=u439n1764mpw -->
  ### P3009: migrate found failed migrations
  - **Causa:** …
  - **Correção:** …
  - **Evidência:** corrigida · TER-57 · https://github.com/…/pull/169
  <!-- /termhub:lesson -->
  ```

- `search_memory` (TER-95): `kinds` accepts `lesson` and `project_note`; each lesson result carries
  `verified`, `evidence`, `origin`, `path` or `tab`, `card`, `pr`. The description gains: "Lições
  (`kind: lesson`) são o que um agente aprendeu corrigindo um erro: prefira as verificadas; as não
  verificadas são hipóteses a conferir."
- `gate.ts`: `record_lesson` in the self-mediated set (D11). `list_tabs`/`read_screen` unchanged.

## 6. HTTP API (web and mobile)

Under the chat memory routes (`guarded('chat', …)`, mounted at `/api/chat` and `/api/m/v1/chat`):

- `GET /lessons?q=&project_id=&cursor=` → `{ lessons: [{ id, project: {id, name}, title, excerpt,
  origin, path?, tab?, card?, pr?, evidence, verified, verified_at?, created_at }], next_cursor }` — the
  owner's `lesson` items, one row per source (chunk 0), newest first, ILIKE on title/text.
- `POST /lessons/:id/verify` and `DELETE /lessons/:id/verify` (unverify).
- `DELETE /lessons/:id` ("Esquecer"): for a note block, removes the block from the note (under the
  note lock) and its items; for a file lesson, sets `hidden_hash` (§3) on its items so the sweeper does
  not bring the same content back. The response says that the file itself stays in the
  repository ("O arquivo continua no repositório; apague-o por um PR para sumir de vez").
- Contracts in `packages/mobile-api` (`chat.ts`), non-strict zod objects.
- `PUT /projects/:id/note` accepts `base_updated_at` (D9).

## 7. Clients

- Web `ChatMemoryPage.tsx` and mobile `chat-memory-screen.tsx`: a third section "Lições" (after
  "Decisões" and TER-95's "Anotações do concierge"): search box, list rows with the symptom, project,
  origin ("arquivo docs/lessons/…" or "anotação do projeto"), evidence, a "verificada" badge, and the
  actions Verificar/Desfazer verificação, Abrir origem (web: the PR/card link or the project's Notas;
  mobile: the PR/card link), Esquecer (with the confirm text from §6).
- Web `NotesEditor.tsx`: sends `base_updated_at` (the note's `updated_at` it last loaded or saved),
  adopts the returned content when it differs from what it sent and nothing was typed since, and shows
  "lição adicionada por um agente" in the status line when that happens.

## 8. Instructions for agents

`CLAUDE.md` of termhub gains (English, like the file):

```markdown
## Failure lessons

- Before debugging an error, search `docs/lessons/` (`grep -ril "<error text>" docs/lessons`) and, when the termhub MCP is available, `search_memory` with `kinds: ["lesson"]`.
- After fixing an error that was not obvious, add `docs/lessons/YYYY-MM-DD-<slug>.md` in the same PR (format in `docs/lessons/README.md`). Never paste secrets, tokens or customer data into a lesson.
```

`docs/lessons/README.md` holds the format of D4 and one real example from this repo's history
(TER-57's P3009 migration lesson).

## 9. Security

- **Prompt injection.** A lesson is text an agent wrote after reading terminal output: it is `derived`,
  labelled as data in `search_memory`, never an automatic-answer source, and unverified until the
  person marks it. Screens and command output are still never indexed (TER-95 D4); `record_lesson`
  stores what the agent wrote, not what the screen showed.
- **Fence forgery.** `<!--`/`-->` inside `record_lesson` fields are replaced before writing (D7); the
  indexer only recognises fences at the start of a line with the exact shape; an unclosed fence is the
  person's text.
- **Secrets.** Lessons end up in repositories and notes: the tool description and the CLAUDE.md block
  say never to include secrets; the server refuses a `record_lesson` whose fields match a small list of token
  patterns (`thb_pat_`, `sk-`, `ghp_`, `github_pat_`, `AKIA` + 16 characters, `-----BEGIN … PRIVATE KEY`)
  with a pt-BR error. The list is a floor, not a scanner.
- **Scope.** Everything filters by owner; `project_id` and `tab_id` go through `ctx.scoped`; the
  lessons routes check the item's `owner_id`.
- **Logs.** ids, counts and codes only; never symptoms, text or paths.

## 10. Testing

- Unit: `parseLessonFile` (front matter variants, missing fields, README skipped); `splitNote` (fences,
  unclosed fence, marker inside text, headings); fence neutralising; the D9 merge (new block kept,
  deleted old block not restored, no base → plain overwrite); secret patterns; `record_lesson` checks,
  cap and note-size limit; the reminder appended by `launchLine`'s caller and the 4000 limit.
- DB: `memory_items` lesson upsert keeps `verified_*`, `verified` drops on hash change; note lock
  (concurrent append + save keeps both); hidden lesson stays hidden after re-index, comes back on a new hash.
- MCP route: `record_lesson` listed only with scope `memory` + `notes:update`; self-mediated on a gated
  token; `search_memory` `kinds: ["lesson"]` returns `verified`/`evidence`.
- Docs sweeper: `docs/lessons/*.md` listed and indexed as `lesson`, README skipped; agent script
  parity (ssh/local) for the new directory.
- Web and mobile: Lições list (verify, unverify, forget with confirmation), NotesEditor adopting merged
  content.

## 11. Out of scope and related cards

- **TER-212** (MCP inside agent tabs, scoped per-tab token): still needed for tabs to call
  `record_lesson`/`search_memory`; until then tabs use `docs/lessons/` and `grep`, and the concierge
  writes to the note. This design does not change TER-212's scope.
- **TER-217** (export lessons to the repository): absorbed — lessons are born in the repository (D1).
  The card is closed pointing here.
- Sharing lessons between people, public lesson networks, consensus between agents: out (TER-110).
- Writing into a person's repository from the server (e.g. moving a note lesson to `docs/lessons/` by a
  PR): out; the person or an agent in a tab does it.
