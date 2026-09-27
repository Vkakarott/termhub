# Progress panel: % per card and epic, agents at work, finish estimate and CI — design

Card: **TER-183** (epic TER-182 "Visão gerencial"). Requested 2026-09-26.

## 1. Goal

While one epic is being worked by several agents in parallel, show in one place: how far each card
and the epic are, which agents are working on what (and who is stuck waiting for the user), roughly
how long is left, and — in phase 2 — the state of each card's pull request, its CI and the deploy.

Two phases, shipped separately:

- **Phase 1 — no external dependency.** Progress %, agents, estimate, start/finish timestamps. Web
  and the mobile app.
- **Phase 2 — GitHub.** Link PRs to cards, show PR state, CI checks and the deploy workflow in the
  panel and on the card, kept fresh by polling.

Success: the user opens "Progresso" in a project (web) or the "Progresso" tab (phone) and, without
opening any terminal, knows which cards move, which agent needs them, and a rough "quanto falta".

## 2. What exists today (read before designing)

- `tasks` rows: top-level cards (story/task/bug/spike) grouped by an epic (`epic_id`), subtasks one
  level deep (`parent_id`). `nestTasks` already returns `subtask_counts {done,total}`. Only
  `created_at`/`updated_at` are stored — no start or finish time.
- A card (or a subtask) points at the terminal tab running it: `tasks.tab_id` (set by `start_agent`
  through `control/agents.ts`, which also calls `startWork`: a card moves to the agent column, a
  subtask becomes `doing`).
- A tab carries the live monitor state: `state` (`working`, `waiting_input`, `waiting_permission`,
  `idle`, `error`), `state_at`, `state_seen_at`, `activity`/`activity_verb`, `rate_limited_at`.
  `NEEDS_YOU = waiting_input | waiting_permission` (`monitor/state.ts`).
- `tab_events` records each state change, but is **capped at 200 rows per tab** and cascades away
  with the tab — it cannot be the long-term source of "time worked".
- The web keeps tab states live over the monitor WebSocket (`lib/monitor.tsx`, `useMonitor()`).
- The phone talks to `/api/m/v1` (device token + DPoP) with the zod contract in
  `packages/mobile-api`; it has no board, only Chats / Notificações / Ajustes.
- GitHub: an account-level `Integration` (provider `github`, encrypted PAT) and the project setup's
  `repo { integration_id, full_name, base_branch, branch_pattern: '{ticket}-{slug}' }`. Today it is
  only used to import issues as tickets.

## 3. Decisions (made without asking, with the reason)

| # | Decision | Why |
|---|----------|-----|
| D1 | Store `started_at`, `done_at` on `tasks`, written by a **database trigger** on status change, not by the repository. | Every status write (web, MCP `update_task`, `start_agent`, ticket import, and the *previous release* during a blue/green switch) goes through the trigger, so no path forgets it. `tasks_assign_number` is the precedent. Two nullable columns keep the migration backward compatible. |
| D2 | Store "time an agent actually worked" as `tasks.active_seconds` (integer), incremented when a linked tab **leaves** `working` (interval = previous event → now, capped at 2 h), and attributed to the **top-level card**. | "Descontar o tempo parado esperando o usuário" means counting only working time. `tab_events` is capped and dies with the tab, so the total must live on the card. Attributing to the card keeps one number per card even when several tabs (or a subtask's tab) worked on it. The 2 h cap bounds a hook that died mid-turn. |
| D3 | Progress is counted in **work units**: each subtask is one unit; a card without subtasks is one unit (0 until done). Epic % = done units / total units, **backlog cards included**. | Averaging card percentages makes a 1-subtask card weigh as much as a 12-subtask one. Units are what the user sees ticking. Backlog counts because it is still scope of the epic; the panel shows the backlog part separately so a big backlog does not look like slowness. |
| D4 | Estimate per card = remaining units × pace, shown as a **range** (`~20–45 min`). Pace = `active_seconds / done units` ("tempo de agente"); when the card has no agent time (worked by hand, or hooks not installed) fall back to wall clock between the card's start and its last finished unit ("tempo corrido"), and say which basis was used. No estimate before **2** done units. Range factors: `[×0.5, ×2]` with 2–4 samples, `[×0.7, ×1.5]` with 5+. | The card asks for an approximate range, not a number. Two samples is the minimum that is not a guess; the band narrows as data grows. Showing the basis keeps the number honest. |
| D5 | Epic estimate = **the longest** estimate among its cards in `doing`, plus "N cards sem estimativa" for the rest. Not a sum. | Cards in an epic run in parallel (that is the scenario of the card); summing would over-estimate by the number of agents. Cards not started have no pace, so they are counted, not guessed. |
| D6 | The estimate is **work time**, not a clock time. When an agent of the card is waiting for the user, the panel says so next to it ("parado esperando você há 12 min") instead of moving an ETA. | Wall-clock ETA depends on when the user answers, which the panel cannot know. Stating the pause is the useful signal. |
| D7 | One server read model, `GET /api/progress?project_id=&scope=active|all`, shared by the web and a phone twin `GET /api/m/v1/progress`. `scope=active` (default): epics with at least one card in a `doing` column; `all`: every epic with at least one card, fully done epics last. | One builder, two transports, as the chat already does. "Active" is the "tocando um épico" view; "all" is for the project page. |
| D8 | Agents in the payload only when the caller also has `terminals:read`; otherwise `agents: null` and the UI hides that column. Route guarded as `tasks` (read). | Tab state and its pending question belong to the `terminals` resource; `tasks:read` alone must not leak it. |
| D9 | Web: a new project section **"Progresso"** (`/projects/:id/progress`) next to Board/Backlog. Tab states are overlaid live from `useMonitor()`; the rest refetches every 15 s while the page is visible. | The monitor already streams tab states; percentages and estimates change at subtask pace, 15 s is plenty and needs no new WebSocket event. |
| D10 | Phone: a fourth tab **"Progresso"** listing active epics across all the user's projects (`scope=active`, no project filter), refreshed on focus, every 20 s while focused, and by pull-to-refresh. Read-only. | The app has no project navigation; the cross-project active view is exactly "o que está andando agora". No terminal on the phone, so agents are shown, not opened. |
| D11 | Phase 2 uses the **existing GitHub integration token** of the project setup (`repo.integration_id`) and **server-side polling** every 60 s with ETags. Rejected: `gh` on the machine (depends on the machine being online and a remote exec per poll) and a GitHub App with webhooks (needs app registration and a public webhook path through Cloudflare Access in front of `app.termhub.dev`). Webhooks stay a later optimisation behind the same table. | Zero new infrastructure, one credential the user already configured, and ETag'd polls of a few PRs fit easily inside 5 000 req/h. |
| D12 | CI and deploy come from **GitHub Actions workflow runs** (`/actions/runs?head_sha=`), not the Checks API. CI = runs for the PR head SHA; deploy = runs of the configured `repo.deploy_workflow` on the merge commit. Token needs *Pull requests: read* and *Actions: read*. | One endpoint for both, works with fine-grained PATs, and matches how termhub itself ships ("CI e Deploy"). External CIs (not Actions) are out of scope for now. |
| D13 | PR ↔ card link: the project key ref (`TER-183`, case-insensitive, word boundary) in the **head branch, title or body**. A ref to a subtask links its parent card. Many-to-many (a PR can close two cards). | The default branch pattern is `{ticket}-{slug}` and agents already write the ref in titles; no manual linking UI needed. |
| D14 | PR data lives in a new table `task_pull_requests` (one row per card × PR), written only by the sync. | The panel, the card page and the phone read it without calling GitHub; the old release ignores a table it does not know. |

## 4. Phase 1 — design

### 4.1 Data

Migration `20260927000000_task_progress`:

```sql
ALTER TABLE "tasks" ADD COLUMN "started_at" TIMESTAMP(3), ADD COLUMN "done_at" TIMESTAMP(3),
  ADD COLUMN "active_seconds" INTEGER NOT NULL DEFAULT 0;
-- best effort for existing rows: a finished card's last write is when it finished
UPDATE "tasks" SET "done_at" = "updated_at" WHERE "status" = 'done';
CREATE FUNCTION "tasks_track_progress_times"() RETURNS trigger ...
  -- doing and no started_at        -> started_at = now()
  -- done and (INSERT or was not done) -> done_at = now()
  -- anything but done              -> done_at = NULL (reopened)
CREATE TRIGGER ... BEFORE INSERT OR UPDATE OF "status" ON "tasks" FOR EACH ROW ...
```

`started_at` is never cleared (a card that goes back to todo keeps when it first started). A subtask
ticked straight from todo to done has `done_at` but no `started_at` — that is fine, the estimator
only needs finish times.

Prisma: `startedAt DateTime? @map("started_at")`, `doneAt DateTime? @map("done_at")`,
`activeSeconds Int @default(0) @map("active_seconds")`. `mapTask` exposes `started_at`, `done_at`,
`active_seconds` (web `Task` type too).

### 4.2 Accumulating agent time

`TabsRepository.recordEvent`, inside its existing transaction and before inserting the new event:
read the tab's latest event; if its kind is `working`, add `min(at − latest.created_at, 7200 s)` to
`active_seconds` of `SELECT DISTINCT COALESCE(parent_id, id) FROM tasks WHERE tab_id = $tab`. A
`working → working` event also closes the interval (its time counts once, and the new event opens
the next one). No row linked = nothing written. `clearState` (tmux gone) does not add time
(undercount, accepted).

### 4.3 Pure core (`apps/server/src/progress/`)

- `estimate.ts` — `estimateCard(input, now)` → `{ kind: 'done' } | { kind: 'none', reason: 'not_started' | 'few_samples' } | { kind: 'range', low_s, high_s, basis: 'agent_time' | 'wall_clock', samples }`. Rules of D4. Rounding: below 1 h, to 5 min (min 5 min); from 1 h, to 30 min.
- `aggregate.ts` — `aggregateEpic(epic, cards, tabsById, now)` builds the read model: per card units, %, estimate, agents (distinct tabs of the card and of its subtasks, still existing), and per epic units (with backlog units apart), %, estimate (D5), agent counts (`working`, `needs_you`, `idle`), `needs_you` list first.

Both are pure and unit-tested; no Prisma.

### 4.4 Read model (JSON)

```ts
interface ProgressResponse { epics: EpicProgress[]; generated_at: string }
interface EpicProgress {
  id: string; ref: string; title: string; project: { id: string; key: string; name: string };
  units: { done: number; total: number; backlog_total: number }; percent: number; // 0..100 integer
  estimate: Estimate; cards_without_estimate: number;
  agents: { working: number; needs_you: number; idle: number } | null;
  cards: CardProgress[]; // doing first, then todo, done, backlog; board position inside each
}
interface CardProgress {
  id: string; ref: string; title: string; type: string; status: 'backlog'|'todo'|'doing'|'done';
  column_name: string | null; units: { done: number; total: number }; percent: number;
  started_at: string | null; done_at: string | null; active_seconds: number; estimate: Estimate;
  agents: AgentOnCard[] | null;
}
interface AgentOnCard {
  tab_id: string; tab_name: string; machine_name: string; subtask_ref: string | null;
  state: TabState | null; state_at: string | null; needs_you: boolean;
  activity: string | null; activity_verb: string | null; rate_limited: boolean;
}
```

The zod version lives in `packages/mobile-api/src/progress.ts` (the phone's contract); the web mirrors
it in `lib/types.ts` like every other type.

### 4.5 Server

- `TasksRepository.listForProgress({ owner, projectId })`: epics and their non-subtask cards and
  subtasks, only of the owner's projects, one query per level, project key and column name joined.
- `progress/build.ts` — `buildProgress(repos, { owner, projectId, scope, includeAgents }, now)`:
  loads rows, the tabs referenced by `tab_id` (batched `findByIdsForOwner`), their machines' names,
  runs `aggregate`, filters by scope, sorts epics by "needs you" then most recent activity.
- `routes/progress.ts` at `/progress`, `guarded('tasks', …)` (add nothing to `RESOURCES`): zod query
  `{ project_id?: id, scope?: 'active'|'all' }`; a `project_id` goes through
  `scoped(repos, request).project(id)` (404 outside the scope); `includeAgents =
  canAccess(repos, user, 'terminals', 'read')`.
- Phone: `routes/m-progress.ts` under `guarded('tasks', …, '/progress')` in `mobile/app.ts`, same
  builder, response parsed through the contract in tests.

### 4.6 Web

- `lib/progress.ts`: `formatEstimate`, `formatSince`, `overlayLiveTabs(progress, monitorItems)`
  (replace `state/state_at/needs_you/activity` of each agent by the live tab when the monitor has it).
- `components/ProgressPanel.tsx`: header strip "N agentes esperando você" (links to the tab),
  toggle "Só ativos / Todos", one block per epic: title, bar with %, `done/total` units (+ backlog
  apart), estimate, agent counters; card rows with bar, %, estimate or reason, and agent chips (state
  colour, "há 12 min", verb). Needs-you chips are amber and sorted first; clicking a chip opens the
  project's terminal with `?tab=<id>`; clicking the card opens `/project/:ref`.
- `pages/ProjectPage.tsx`: section `{ key: 'progress', label: 'Progresso', path: 'progress' }`.
- Refresh: fetch on mount, every 15 s while `document.visibilityState === 'visible'`, live tab overlay
  always.

UI copy (pt-BR): "Progresso", "Só ativos", "Todos", "esperando você", "pedindo permissão",
"trabalhando", "parado", "erro", "estimativa após 2 subtarefas", "ainda não começou",
"tempo de agente", "tempo corrido", "~{a}–{b} de trabalho", "{n} cards sem estimativa",
"backlog: {n}", "Nenhum épico em andamento".

### 4.7 Phone

- `services/api`: `progress(auth, { scope })` on the real client and the mock transport.
- `features/progress/`: `model/format.ts` (same rules as the web formatter, tested), `viewmodel/`
  store (load, refresh, polling start/stop with focus, session error handling like the notifications
  store), `view/progress-screen.tsx` (FlatList of epics, collapsible cards, pull-to-refresh, empty
  state "Nenhum épico em andamento").
- `app/(tabs)/progress.tsx` + a fourth `Tabs.Screen` "Progresso" (SF Symbol `chart.bar` /
  Material `bar_chart`).

### 4.8 Errors and edge cases

- Card with no subtasks and not done: 0 %, estimate `none/not_started` or `few_samples`.
- Subtasks added while running: total grows, % may drop — correct, shown as is.
- Tab deleted: `tasks.tab_id` goes null (FK `SetNull`); the card keeps its `active_seconds`.
- A reopened card (done → doing) clears `done_at` and keeps counting.
- Scope: rows of another owner never enter (`owner` filter in the query, `scoped` for `project_id`).
- Logs: ids and counts only.

### 4.9 Testing (phase 1)

Trigger and accumulation: Postgres tests (`*.db.test.ts`, `TERMHUB_DB_TESTS=1`). Estimator,
aggregator, formatters: pure unit tests. Routes: inject tests with scope and the `terminals:read`
gate. Web: RTL for the panel and the section. Phone: jest store + screen tests against the mock
transport.

## 5. Phase 2 — design

### 5.1 Setup

`repoSchema` gains `deploy_workflow: string | null` (workflow file name or display name, e.g.
`deploy.yml` / `CI e Deploy`; default null = no deploy tracking). JSON setup, no migration, default
keeps old rows valid. The Setup form gets one text field "Workflow de deploy". CI tracking turns on by
itself when `repo.integration_id` and `repo.full_name` are set and the integration belongs to the
project's owner (checked on every sync, so a setup can never borrow another user's token).

### 5.2 Data

Migration `20260927010000_task_pull_requests`:

```
task_pull_requests(
  id text pk, project_id → projects cascade, task_id → tasks cascade,
  repo text, number int, url text, title text, head_ref text, head_sha text,
  state text  -- open | closed | merged
  draft bool, merged_at timestamptz null, merge_commit_sha text null,
  ci_state text     -- none | running | passed | failed
  ci_summary jsonb  -- { total, passed, failed, running, failing: string[≤5] }
  deploy_state text -- none | running | passed | failed
  deploy_url text null, synced_at timestamp, updated_at timestamp,
  unique(task_id, repo, number), index(project_id, state)
)
```

`TaskPullRequestsRepository`: `replaceLinks(projectId, pr, taskIds)` (upsert the PR's rows, drop the
ones whose card no longer matches), `updateCi(projectId, repo, number, fields)`,
`listByTasks(taskIds)`, `listWatched(projectId)` (open, or merged < 24 h with deploy not final).

### 5.3 GitHub client (`integrations/github-ci.ts`)

- `listPulls(token, repo, etag)` → `{ notModified } | { etag, pulls }` — `GET /repos/{r}/pulls?state=all&sort=updated&direction=desc&per_page=30` with `If-None-Match`.
- `listRuns(token, repo, { head_sha, event? })` → workflow runs (name, path, status, conclusion, html_url).
- Errors: 401/403/404 → typed error the sync logs once per project and surfaces as
  `ci_error` on the epic ("GitHub: sem acesso ao repositório"); 403 with `x-ratelimit-remaining: 0`
  → skip the project until `x-ratelimit-reset`.

### 5.4 Pure rules (`progress/ci.ts`)

- `refsIn(text, key)` → card numbers (`\b${key}-(\d+)\b`, `i`), from head ref, title, body.
- `ciStateOf(runs)` → `none` (no runs) | `running` (any queued/in_progress) | `failed` (any
  conclusion failure/timed_out/cancelled/action_required) | `passed`.
- `deployStateOf(runs, workflow)` → same scale restricted to runs whose `name` or file name equals
  `deploy_workflow`.

### 5.5 Sync

`ci/sync.ts` — `syncProjectCi(deps, projectId)`: read setup + integration (owner check, decrypt),
list pulls (ETag kept in memory per project), for each PR resolve refs → card ids (subtask → parent),
`replaceLinks`; for each watched link fetch runs (open PR: head SHA → CI; merged: merge commit →
deploy) and `updateCi`. `ci/scheduler.ts` — every 60 s, projects with CI on and (a card in doing or
a watched PR). Both colours may poll during a blue/green grace period: writes are idempotent.

### 5.6 Exposure

- `CardProgress` gains `pull_requests: PullRequestBadge[]` (number, url, title, state, draft,
  ci_state, ci_summary, deploy_state, deploy_url); `EpicProgress` gains `ci: { open, failed, running,
  deployed } | null` and `ci_error: string | null`. Contract updated in `mobile-api`.
- Web panel: badges "PR #12", CI dot (verde/amarelo/vermelho, tooltip with failing workflow names),
  "deploy ✓/…/✗" linking to GitHub.
- Card page: section "Pull requests" from `GET /api/tasks/:id/pull-requests` (guarded `tasks`).
- Phone: same badges, links open in the browser.

### 5.7 Testing (phase 2)

GitHub client with a stubbed `fetch` (ETag, errors, rate limit). Pure rules table-driven. Sync with a
fake client and the Postgres repository. Scheduler selection. Web and phone badges.

## 6. Out of scope

- Webhooks / GitHub App; non-Actions CI providers; GitLab.
- Burn-down charts, history per day, per-user throughput.
- Estimates for cards that never started; clock-time ETAs.
- Editing anything from the panel (it is read-only; moves stay on the board).
- MCP tool for progress (the chat can read `list_tasks`; add later if asked).

## 7. Risks

- **Estimate quality.** Subtasks vary in size; the range is wide on purpose and hidden below 2
  samples. Agent time depends on hooks; without hooks the wall-clock fallback includes pauses.
- **Blue/green window.** The previous release does not accumulate `active_seconds` (small
  undercount during a deploy); the trigger works for both.
- **Hook gaps.** A `working` interval with no closing event until much later is capped at 2 h;
  `clearState` loses the open interval.
- **Backfill.** `done_at = updated_at` for old done cards is approximate; it only affects estimates of
  cards already running at deploy time.
- **GitHub token scope** (phase 2). Classic PATs with `repo` work; fine-grained need Pull requests +
  Actions read. A missing permission shows as `ci_error`, never as a silent "no PR".
- **Rate limit** (phase 2). 60 s × projects with work in progress; ETag'd list calls that return 304
  do not count. Backs off on `x-ratelimit-remaining: 0`.
- **Performance.** `listForProgress` for `scope=active` across all projects reads every epic's cards;
  fine at the current size (hundreds of cards), indexed by `(epic_id, status, position)`.
