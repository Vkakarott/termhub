# Progress panel — Phase 2 (GitHub PRs, CI and deploy) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Link each card to its GitHub pull requests and show the PR state, its CI (GitHub Actions) and the deploy workflow — in the progress panel (web and phone) and on the card — refreshed by server-side polling (TER-183 phase 2).

**Architecture:** The project setup's existing GitHub integration token (`repo.integration_id`, `repo.full_name`) is used by a 60 s scheduler that lists the repo's recent PRs with ETags, links them to cards by ref (`TER-183` in branch/title/body) into a new `task_pull_requests` table, and refreshes CI (workflow runs for the head SHA) and deploy (runs of `repo.deploy_workflow` on the merge commit) for watched PRs. The progress read model of phase 1 carries PR badges and an epic CI summary; the card editor lists the card's PRs.

**Tech Stack:** Fastify + zod + Prisma 6 (Postgres), GitHub REST v3 through `fetch`, React + Vite + vitest/RTL (web), Expo + jest/RNTL (app), `@termhub/mobile-api`.

**Spec:** `docs/superpowers/specs/2026-09-26-progress-panel-design.md` (§3 D11–D14, §5). **Requires phase 1 merged** (`docs/superpowers/plans/2026-09-26-progress-panel-phase1.md`).

## Global Constraints

- Work in a git worktree of your own on branch `feat/ter-183-progress-phase2` from `origin/main` after phase 1 is merged. No push, no merge, no deploy unless the user asks.
- Docker prefix `DOCKER '<command>'`, throwaway DB `th-ter183-db` on `th-ter183-net`, and the test commands are exactly those of phase 1's Global Constraints (recreate the DB/network if they were removed). Never touch a container that is not `th-*`.
- Commit messages in English, imperative subject ≤ 72 chars, ending with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- UI copy pt-BR exactly as written here; code/comments/identifiers in English.
- The GitHub token never leaves the server: never logged, never in a response. Logs carry project id, repo, PR number, HTTP status only.
- The integration used must be `provider = github` **and** owned by the project's owner; otherwise the project is skipped (a setup can never borrow another user's token).
- Only GitHub Actions workflow runs are read (`/repos/{r}/pulls`, `/repos/{r}/actions/runs`); the token needs *Pull requests: read* and *Actions: read* (fine-grained) or `repo` (classic).
- Migration backward compatible: a new table only; the previous release ignores it.
- After each task, tick the matching subtask of TER-183 on the board (termhub MCP `update_task`, `status: done`).

## Review Focus

- A PR whose body mentions `TER-18` must **not** link TER-183 and vice versa (`TER-1830`, `ter-183` lowercase links, `XTER-183` does not) — pinned in Task 3.
- A PR that **stops mentioning** a card (title edited) must drop that link on the next sync — pinned in Task 2 and Task 5.
- A ref to a **subtask** links its parent card; a ref to an **epic** or to a number that does not exist links nothing — pinned in Task 5.
- A token that answers **401/403/404** marks the project with an error shown on the panel and does not wipe existing links — pinned in Task 5.
- A **re-run** of a failed workflow that now passes reads `passed` (latest run per workflow wins) — pinned in Task 3.

---

### Task 1: Setup field "Workflow de deploy"

**Files:**
- Modify: `apps/server/src/setup/schema.ts` (`repoSchema`), `apps/web/src/lib/types.ts` (`ProjectSetupData.repo`), `apps/web/src/components/SetupForm.tsx` (repo section; the default object built when an integration is picked)
- Test: `apps/server/src/setup/schema.test.ts` (create if absent)

**Interfaces:**
- Produces: `repo.deploy_workflow: string | null` (trimmed, ≤ 200 chars, default `null`) in `ProjectSetupData` on server and web.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { normalizeSetup, SETUP_VERSION } from './schema.js';

describe('setup repo.deploy_workflow', () => {
  it('defaults to null for a setup saved before the field existed', () => {
    const data = normalizeSetup({ repo: { integration_id: 'i1', full_name: 'acme/app' } }, SETUP_VERSION);
    expect(data.repo?.deploy_workflow).toBeNull();
  });
  it('keeps a trimmed workflow name', () => {
    const data = normalizeSetup({ repo: { integration_id: 'i1', full_name: 'acme/app', deploy_workflow: '  deploy.yml ' } }, SETUP_VERSION);
    expect(data.repo?.deploy_workflow).toBe('deploy.yml');
  });
});
```

- [ ] **Step 2: Run** `DOCKER 'npx -w @termhub/server vitest run src/setup/schema.test.ts'` — Expected: FAIL (`deploy_workflow` undefined).

- [ ] **Step 3: Implement** — in `repoSchema`, after `draft_pr`:

```ts
  /** GitHub Actions workflow whose run on the merge commit is "the deploy" (file name or display name); null = not tracked */
  deploy_workflow: z.string().trim().min(1).max(200).nullable().default(null),
```

Web `types.ts`: add `deploy_workflow: string | null;` to `ProjectSetupData.repo`. `SetupForm.tsx`: add `deploy_workflow: null` to the default repo object built when an integration is picked, and after the "Padrão da branch" row:

```tsx
                <Row label="Workflow de deploy">
                  <input
                    className="input font-mono"
                    placeholder="deploy.yml"
                    value={data.repo.deploy_workflow ?? ''}
                    onChange={(e) => patch('repo', { ...data.repo!, deploy_workflow: e.target.value.trim() ? e.target.value : null })}
                  />
                </Row>
```

- [ ] **Step 4: Run** the test and `DOCKER 'npm run typecheck -w @termhub/server && npm run build -w @termhub/web'` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/setup apps/web/src/lib/types.ts apps/web/src/components/SetupForm.tsx
git commit -m "Setup: name the deploy workflow of the project's repository"
```

---

### Task 2: Table `task_pull_requests` and its repository

**Files:**
- Modify: `apps/server/prisma/schema.prisma` (new model; back-relations on `Project` and `Task`)
- Create: `apps/server/prisma/migrations/20260927010000_task_pull_requests/migration.sql`, `apps/server/src/db/repositories/task-pull-requests.ts`, `apps/server/src/db/repositories/task-pull-requests.db.test.ts`
- Modify: `apps/server/src/db/repositories/index.ts` (`taskPullRequests`)

**Interfaces:**
- Produces:
  ```ts
  export type PrState = 'open' | 'closed' | 'merged';
  export type CiState = 'none' | 'running' | 'passed' | 'failed';
  export interface CiSummary { total: number; passed: number; failed: number; running: number; failing: string[] }
  export interface PullRequestInfo { repo: string; number: number; url: string; title: string; head_ref: string; head_sha: string; state: PrState; draft: boolean; merged_at: Date | null; merge_commit_sha: string | null }
  export interface TaskPullRequest extends PullRequestInfo { id: string; project_id: string; task_id: string; ci_state: CiState; ci_summary: CiSummary; deploy_state: CiState; deploy_url: string | null; synced_at: string }
  export const WATCH_MERGED_FOR_MS = 24 * 3600_000;
  class TaskPullRequestsRepository {
    replaceLinks(projectId: string, pr: PullRequestInfo, taskIds: string[]): Promise<void>;
    updateCi(projectId: string, repo: string, number: number, fields: { ci_state?: CiState; ci_summary?: CiSummary; deploy_state?: CiState; deploy_url?: string | null }): Promise<void>;
    listByTasks(taskIds: string[]): Promise<TaskPullRequest[]>;
    listWatched(projectId: string, now?: Date): Promise<TaskPullRequest[]>;
  }
  ```

- [ ] **Step 1: Write the failing test** (`task-pull-requests.db.test.ts`):

```ts
import { PrismaPg } from '@prisma/adapter-pg';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../generated/prisma/client.js';
import { newId } from '../../lib/ids.js';
import { TaskPullRequestsRepository, type PullRequestInfo } from './task-pull-requests.js';

describe.skipIf(process.env.TERMHUB_DB_TESTS !== '1')('TaskPullRequestsRepository (Postgres)', () => {
  let db: PrismaClient;
  let repo: TaskPullRequestsRepository;
  let projectId: string;
  let a: string;
  let b: string;

  beforeAll(() => {
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
    repo = new TaskPullRequestsRepository(db);
  });

  beforeEach(async () => {
    projectId = newId();
    [a, b] = [newId(), newId()];
    await db.project.create({ data: { id: projectId, key: 'PR' + projectId.replace(/[^a-z0-9]/gi, '').slice(0, 6).toUpperCase(), name: 'p' } });
    await db.task.createMany({ data: [{ id: a, projectId, title: 'a' }, { id: b, projectId, title: 'b' }] });
    return async () => {
      await db.project.delete({ where: { id: projectId } });
    };
  });

  const pr = (over: Partial<PullRequestInfo> = {}): PullRequestInfo => ({
    repo: 'acme/app', number: 7, url: 'https://github.com/acme/app/pull/7', title: 'TER-1 thing', head_ref: 'TER-1-thing', head_sha: 'abc',
    state: 'open', draft: false, merged_at: null, merge_commit_sha: null, ...over,
  });

  it('links a PR to several cards and drops a card that no longer matches', async () => {
    await repo.replaceLinks(projectId, pr(), [a, b]);
    expect((await repo.listByTasks([a, b])).map((r) => r.task_id).sort()).toEqual([a, b].sort());
    await repo.replaceLinks(projectId, pr({ title: 'renamed' }), [a]);
    const rows = await repo.listByTasks([a, b]);
    expect(rows.map((r) => [r.task_id, r.title])).toEqual([[a, 'renamed']]);
  });

  it('keeps CI fields across a re-link and updates them by PR', async () => {
    await repo.replaceLinks(projectId, pr(), [a]);
    await repo.updateCi(projectId, 'acme/app', 7, { ci_state: 'failed', ci_summary: { total: 2, passed: 1, failed: 1, running: 0, failing: ['CI'] } });
    await repo.replaceLinks(projectId, pr({ head_sha: 'def' }), [a]);
    const [row] = await repo.listByTasks([a]);
    expect(row).toMatchObject({ head_sha: 'def', ci_state: 'failed', ci_summary: { failing: ['CI'] }, deploy_state: 'none' });
  });

  it('watches open PRs and PRs merged in the last 24 h whose deploy is not final', async () => {
    const now = new Date('2026-09-27T12:00:00Z');
    await repo.replaceLinks(projectId, pr({ number: 1 }), [a]);
    await repo.replaceLinks(projectId, pr({ number: 2, state: 'merged', merged_at: new Date('2026-09-27T10:00:00Z'), merge_commit_sha: 'm2' }), [a]);
    await repo.replaceLinks(projectId, pr({ number: 3, state: 'merged', merged_at: new Date('2026-09-25T10:00:00Z'), merge_commit_sha: 'm3' }), [a]);
    await repo.replaceLinks(projectId, pr({ number: 4, state: 'merged', merged_at: new Date('2026-09-27T11:00:00Z'), merge_commit_sha: 'm4' }), [a]);
    await repo.updateCi(projectId, 'acme/app', 4, { deploy_state: 'passed' });
    await repo.replaceLinks(projectId, pr({ number: 5, state: 'closed' }), [a]);
    expect((await repo.listWatched(projectId, now)).map((r) => r.number).sort()).toEqual([1, 2]);
  });
});
```

- [ ] **Step 2: Run** `DOCKER 'npx -w @termhub/server vitest run src/db/repositories/task-pull-requests.db.test.ts'` — Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`schema.prisma` — new model (and `pullRequests TaskPullRequest[]` on both `Project` and `Task`):

```prisma
/// A GitHub pull request linked to a card by its ref (spec 2026-09-26 progress-panel §5.2). Written only by the CI sync.
model TaskPullRequest {
  id             String    @id
  projectId      String    @map("project_id")
  taskId         String    @map("task_id")
  /// owner/repo
  repo           String
  number         Int
  url            String
  title          String
  headRef        String    @map("head_ref")
  headSha        String    @map("head_sha")
  /// open | closed | merged
  state          String
  draft          Boolean   @default(false)
  mergedAt       DateTime? @map("merged_at")
  mergeCommitSha String?   @map("merge_commit_sha")
  /// none | running | passed | failed — GitHub Actions runs of head_sha
  ciState        String    @default("none") @map("ci_state")
  /// { total, passed, failed, running, failing: string[] (≤ 5 workflow names) }
  ciSummary      Json      @default("{}") @map("ci_summary")
  /// none | running | passed | failed — the setup's deploy workflow on merge_commit_sha
  deployState    String    @default("none") @map("deploy_state")
  deployUrl      String?   @map("deploy_url")
  syncedAt       DateTime  @default(now()) @map("synced_at")
  project        Project   @relation(fields: [projectId], references: [id], onDelete: Cascade)
  task           Task      @relation(fields: [taskId], references: [id], onDelete: Cascade)

  @@unique([taskId, repo, number])
  @@index([projectId, state])
  @@map("task_pull_requests")
}
```

Generate the SQL from the schema instead of writing it by hand (it must match Prisma's output for the drift check):

```bash
DOCKER 'npm run prisma:generate && cd apps/server && mkdir -p prisma/migrations/20260927010000_task_pull_requests && npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script > prisma/migrations/20260927010000_task_pull_requests/migration.sql && npx prisma migrate deploy'
```

Prepend a comment line to `migration.sql`: `-- CI panel (spec 2026-09-26 progress-panel §5.2): PRs linked to cards. New table only: the previous release ignores it.` Check the file holds only the `CREATE TABLE`, its indexes and the two foreign keys.

`task-pull-requests.ts`:

```ts
import type { PrismaClient } from '../prisma.js';
import { newId } from '../../lib/ids.js';

export type PrState = 'open' | 'closed' | 'merged';
export type CiState = 'none' | 'running' | 'passed' | 'failed';
export interface CiSummary { total: number; passed: number; failed: number; running: number; failing: string[] }
export interface PullRequestInfo {
  repo: string;
  number: number;
  url: string;
  title: string;
  head_ref: string;
  head_sha: string;
  state: PrState;
  draft: boolean;
  merged_at: Date | null;
  merge_commit_sha: string | null;
}
export interface TaskPullRequest extends PullRequestInfo {
  id: string;
  project_id: string;
  task_id: string;
  ci_state: CiState;
  ci_summary: CiSummary;
  deploy_state: CiState;
  deploy_url: string | null;
  synced_at: string;
}

/** A merged PR stays watched this long, for its deploy run. */
export const WATCH_MERGED_FOR_MS = 24 * 3600_000;
const EMPTY_SUMMARY: CiSummary = { total: 0, passed: 0, failed: 0, running: 0, failing: [] };

type Row = Awaited<ReturnType<PrismaClient['taskPullRequest']['findFirstOrThrow']>>;
const map = (r: Row): TaskPullRequest => ({
  id: r.id,
  project_id: r.projectId,
  task_id: r.taskId,
  repo: r.repo,
  number: r.number,
  url: r.url,
  title: r.title,
  head_ref: r.headRef,
  head_sha: r.headSha,
  state: r.state as PrState,
  draft: r.draft,
  merged_at: r.mergedAt,
  merge_commit_sha: r.mergeCommitSha,
  ci_state: r.ciState as CiState,
  ci_summary: { ...EMPTY_SUMMARY, ...(r.ciSummary as Partial<CiSummary>) },
  deploy_state: r.deployState as CiState,
  deploy_url: r.deployUrl,
  synced_at: r.syncedAt.toISOString(),
});

const prFields = (pr: PullRequestInfo) => ({
  url: pr.url,
  title: pr.title,
  headRef: pr.head_ref,
  headSha: pr.head_sha,
  state: pr.state,
  draft: pr.draft,
  mergedAt: pr.merged_at,
  mergeCommitSha: pr.merge_commit_sha,
  syncedAt: new Date(),
});

export class TaskPullRequestsRepository {
  constructor(private db: PrismaClient) {}

  /** The PR's rows become exactly `taskIds`: upserted (CI fields kept), the others deleted. */
  async replaceLinks(projectId: string, pr: PullRequestInfo, taskIds: string[]): Promise<void> {
    await this.db.$transaction(async (tx) => {
      await tx.taskPullRequest.deleteMany({ where: { projectId, repo: pr.repo, number: pr.number, taskId: { notIn: taskIds } } });
      for (const taskId of taskIds) {
        await tx.taskPullRequest.upsert({
          where: { taskId_repo_number: { taskId, repo: pr.repo, number: pr.number } },
          create: { id: newId(), projectId, taskId, repo: pr.repo, number: pr.number, ...prFields(pr) },
          update: prFields(pr),
        });
      }
    });
  }

  async updateCi(projectId: string, repo: string, number: number, fields: { ci_state?: CiState; ci_summary?: CiSummary; deploy_state?: CiState; deploy_url?: string | null }): Promise<void> {
    await this.db.taskPullRequest.updateMany({
      where: { projectId, repo, number },
      data: {
        ...(fields.ci_state ? { ciState: fields.ci_state } : {}),
        ...(fields.ci_summary ? { ciSummary: fields.ci_summary as object } : {}),
        ...(fields.deploy_state ? { deployState: fields.deploy_state } : {}),
        ...(fields.deploy_url !== undefined ? { deployUrl: fields.deploy_url } : {}),
        syncedAt: new Date(),
      },
    });
  }

  async listByTasks(taskIds: string[]): Promise<TaskPullRequest[]> {
    if (taskIds.length === 0) return [];
    return (await this.db.taskPullRequest.findMany({ where: { taskId: { in: taskIds } }, orderBy: [{ number: 'desc' }] })).map(map);
  }

  /** Open PRs, and PRs merged less than a day ago whose deploy is not passed/failed yet. */
  async listWatched(projectId: string, now = new Date()): Promise<TaskPullRequest[]> {
    const rows = await this.db.taskPullRequest.findMany({
      where: {
        projectId,
        OR: [{ state: 'open' }, { state: 'merged', mergedAt: { gt: new Date(now.getTime() - WATCH_MERGED_FOR_MS) }, deployState: { in: ['none', 'running'] } }],
      },
      orderBy: [{ number: 'desc' }],
    });
    return rows.map(map);
  }
}
```

Register `taskPullRequests: new TaskPullRequestsRepository(db)` in `index.ts`.

- [ ] **Step 4: Run** the test, then `DOCKER 'cd apps/server && npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code'` — Expected: PASS, exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/server/prisma apps/server/src/db/repositories
git commit -m "CI: store pull requests linked to cards"
```

---

### Task 3: Pure rules — refs, CI state, deploy state

**Files:**
- Create: `apps/server/src/ci/rules.ts`, `apps/server/src/ci/rules.test.ts`

**Interfaces:**
- Consumes: `CiState`, `CiSummary` (Task 2).
- Produces:
  ```ts
  export interface WorkflowRun { id: number; name: string; path: string; status: string; conclusion: string | null; html_url: string; created_at: string }
  export function refsIn(texts: Array<string | null>, key: string): number[]
  export function latestPerWorkflow(runs: WorkflowRun[]): WorkflowRun[]
  export function ciOf(runs: WorkflowRun[]): { state: CiState; summary: CiSummary }
  export function deployOf(runs: WorkflowRun[], workflow: string | null): { state: CiState; url: string | null }
  ```

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { ciOf, deployOf, refsIn, type WorkflowRun } from './rules.js';

const run = (over: Partial<WorkflowRun>): WorkflowRun => ({
  id: 1, name: 'CI e Deploy', path: '.github/workflows/deploy.yml', status: 'completed', conclusion: 'success',
  html_url: 'https://github.com/acme/app/actions/runs/1', created_at: '2026-09-27T12:00:00Z', ...over,
});

describe('refsIn', () => {
  it('finds refs of the project key in branch, title and body, once each', () => {
    expect(refsIn(['TER-183-progress-panel', 'Painel (TER-183, ter-184)', 'Closes TER-183'], 'TER')).toEqual([183, 184]);
  });
  it('does not match a longer number, another key or a ref glued to letters', () => {
    expect(refsIn(['TER-1830 XTER-18 TERM-18', null], 'TER')).toEqual([1830]);
    expect(refsIn(['TER-18'], 'TER')).not.toContain(183);
  });
});

describe('ciOf', () => {
  it('is none without runs', () => {
    expect(ciOf([]).state).toBe('none');
  });
  it('is running while any run is not completed', () => {
    expect(ciOf([run({ id: 1 }), run({ id: 2, path: 'b.yml', name: 'lint', status: 'in_progress', conclusion: null })]).state).toBe('running');
  });
  it('is failed with the failing workflow names', () => {
    const r = ciOf([run({ id: 1 }), run({ id: 2, path: 'b.yml', name: 'lint', conclusion: 'failure' })]);
    expect(r).toEqual({ state: 'failed', summary: { total: 2, passed: 1, failed: 1, running: 0, failing: ['lint'] } });
  });
  it('lets the latest run of a workflow win (a green re-run after a failure)', () => {
    const r = ciOf([run({ id: 1, conclusion: 'failure', created_at: '2026-09-27T12:00:00Z' }), run({ id: 2, conclusion: 'success', created_at: '2026-09-27T12:10:00Z' })]);
    expect(r.state).toBe('passed');
    expect(r.summary.total).toBe(1);
  });
  it('treats skipped and neutral as passed, cancelled and timed_out as failed', () => {
    expect(ciOf([run({ conclusion: 'skipped' }), run({ id: 2, path: 'n.yml', conclusion: 'neutral' })]).state).toBe('passed');
    expect(ciOf([run({ conclusion: 'cancelled' })]).state).toBe('failed');
    expect(ciOf([run({ conclusion: 'timed_out' })]).state).toBe('failed');
  });
});

describe('deployOf', () => {
  const runs = [run({ id: 1, name: 'CI e Deploy', path: '.github/workflows/deploy.yml', status: 'in_progress', conclusion: null }), run({ id: 2, name: 'Publish', path: '.github/workflows/publish.yml' })];
  it('is none without a configured workflow or a matching run', () => {
    expect(deployOf(runs, null)).toEqual({ state: 'none', url: null });
    expect(deployOf(runs, 'release.yml')).toEqual({ state: 'none', url: null });
  });
  it('matches by file name or display name', () => {
    expect(deployOf(runs, 'deploy.yml')).toEqual({ state: 'running', url: runs[0].html_url });
    expect(deployOf(runs, 'Publish').state).toBe('passed');
  });
});
```

- [ ] **Step 2: Run** `DOCKER 'npx -w @termhub/server vitest run src/ci/rules.test.ts'` — Expected: FAIL, module not found.

- [ ] **Step 3: Implement** `rules.ts`:

```ts
import type { CiState, CiSummary } from '../db/repositories/task-pull-requests.js';

/** The fields of a GitHub Actions workflow run the panel reads. */
export interface WorkflowRun {
  id: number;
  name: string;
  path: string;
  status: string;
  conclusion: string | null;
  html_url: string;
  created_at: string;
}

const FAILED = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure', 'stale']);
const MAX_FAILING = 5;

/** Card numbers of `key` refs ("TER-183", any case) in a PR's branch, title and body (spec D13). */
export function refsIn(texts: Array<string | null>, key: string): number[] {
  const re = new RegExp(`(?<![A-Za-z0-9])${key}-(\\d+)(?!\\d)`, 'gi');
  const found = new Set<number>();
  for (const text of texts) for (const m of (text ?? '').matchAll(re)) found.add(Number(m[1]));
  return [...found];
}

/** A re-run is a newer run of the same workflow file: only the latest one counts. */
export function latestPerWorkflow(runs: WorkflowRun[]): WorkflowRun[] {
  const byPath = new Map<string, WorkflowRun>();
  for (const r of runs) {
    const cur = byPath.get(r.path);
    if (!cur || r.created_at > cur.created_at || (r.created_at === cur.created_at && r.id > cur.id)) byPath.set(r.path, r);
  }
  return [...byPath.values()];
}

function stateOf(runs: WorkflowRun[]): CiState {
  if (runs.length === 0) return 'none';
  if (runs.some((r) => r.status !== 'completed')) return 'running';
  if (runs.some((r) => FAILED.has(r.conclusion ?? ''))) return 'failed';
  return 'passed';
}

export function ciOf(runs: WorkflowRun[]): { state: CiState; summary: CiSummary } {
  const latest = latestPerWorkflow(runs);
  const running = latest.filter((r) => r.status !== 'completed');
  const failed = latest.filter((r) => r.status === 'completed' && FAILED.has(r.conclusion ?? ''));
  return {
    state: stateOf(latest),
    summary: {
      total: latest.length,
      running: running.length,
      failed: failed.length,
      passed: latest.length - running.length - failed.length,
      failing: failed.map((r) => r.name).slice(0, MAX_FAILING),
    },
  };
}

/** The deploy: the latest run of the setup's workflow, matched by file name or display name. */
export function deployOf(runs: WorkflowRun[], workflow: string | null): { state: CiState; url: string | null } {
  if (!workflow) return { state: 'none', url: null };
  const mine = latestPerWorkflow(runs.filter((r) => r.name === workflow || r.path === workflow || r.path.endsWith(`/${workflow}`)));
  if (mine.length === 0) return { state: 'none', url: null };
  return { state: stateOf(mine), url: mine[0].html_url };
}
```

(Project keys are `[A-Z0-9]` — `lib/project-key.ts` — so interpolating `key` into the pattern is safe.)

- [ ] **Step 4: Run** the test — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/ci
git commit -m "CI: rules for card refs, CI state and deploy state"
```

---

### Task 4: GitHub client for pulls and workflow runs

**Files:**
- Create: `apps/server/src/integrations/github-ci.ts`, `apps/server/src/integrations/github-ci.test.ts`

**Interfaces:**
- Consumes: `WorkflowRun` (Task 3).
- Produces:
  ```ts
  export class GithubCiError extends Error { kind: 'auth' | 'not_found' | 'rate_limited' | 'http'; status: number; resetAt: Date | null }
  export interface GithubPull { number: number; html_url: string; title: string; body: string | null; state: 'open' | 'closed'; draft: boolean; merged_at: string | null; merge_commit_sha: string | null; head: { ref: string; sha: string } }
  export type PullsPage = { notModified: true } | { notModified: false; etag: string | null; pulls: GithubPull[] };
  export interface GithubCiClient {
    listPulls(token: string, repo: string, etag: string | null): Promise<PullsPage>;
    listRuns(token: string, repo: string, headSha: string): Promise<WorkflowRun[]>;
  }
  export function createGithubCiClient(fetchImpl?: typeof fetch): GithubCiClient
  ```

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, vi } from 'vitest';
import { createGithubCiClient, GithubCiError } from './github-ci.js';

const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

describe('github CI client', () => {
  it('lists recent pulls with the ETag and returns the new one', async () => {
    const fetchImpl = vi.fn(async () => json(200, [{ number: 7, html_url: 'u', title: 't', body: null, state: 'open', draft: false, merged_at: null, merge_commit_sha: null, head: { ref: 'TER-1', sha: 'abc' } }], { etag: 'W/"2"' }));
    const page = await createGithubCiClient(fetchImpl).listPulls('tok', 'acme/app', 'W/"1"');
    expect(page).toMatchObject({ notModified: false, etag: 'W/"2"', pulls: [{ number: 7 }] });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.github.com/repos/acme/app/pulls?state=all&sort=updated&direction=desc&per_page=30');
    expect(new Headers(init.headers).get('if-none-match')).toBe('W/"1"');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer tok');
  });

  it('reads 304 as not modified', async () => {
    const page = await createGithubCiClient(vi.fn(async () => new Response(null, { status: 304 }))).listPulls('tok', 'acme/app', 'W/"1"');
    expect(page).toEqual({ notModified: true });
  });

  it('lists workflow runs of a commit', async () => {
    const fetchImpl = vi.fn(async () => json(200, { workflow_runs: [{ id: 1, name: 'CI', path: '.github/workflows/ci.yml', status: 'completed', conclusion: 'success', html_url: 'r', created_at: '2026-09-27T12:00:00Z', extra: 1 }] }));
    const runs = await createGithubCiClient(fetchImpl).listRuns('tok', 'acme/app', 'abc');
    expect(runs).toEqual([{ id: 1, name: 'CI', path: '.github/workflows/ci.yml', status: 'completed', conclusion: 'success', html_url: 'r', created_at: '2026-09-27T12:00:00Z' }]);
    expect(fetchImpl.mock.calls[0][0]).toBe('https://api.github.com/repos/acme/app/actions/runs?head_sha=abc&per_page=50');
  });

  it('types auth, not found and rate-limit failures', async () => {
    const reset = String(Math.floor(Date.UTC(2026, 8, 27, 13) / 1000));
    const cases: Array<[Response, string]> = [
      [json(401, {}), 'auth'],
      [json(404, {}), 'not_found'],
      [json(403, {}, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset }), 'rate_limited'],
      [json(403, {}), 'auth'],
      [json(500, {}), 'http'],
    ];
    for (const [res, kind] of cases) {
      const err = await createGithubCiClient(vi.fn(async () => res)).listRuns('tok', 'acme/app', 'abc').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(GithubCiError);
      expect((err as GithubCiError).kind).toBe(kind);
    }
  });

  it('never puts the token in an error message', async () => {
    const err = (await createGithubCiClient(vi.fn(async () => json(401, { message: 'Bad credentials' }))).listPulls('secret-token', 'acme/app', null).catch((e: unknown) => e)) as Error;
    expect(err.message).not.toContain('secret-token');
  });
});
```

- [ ] **Step 2: Run** `DOCKER 'npx -w @termhub/server vitest run src/integrations/github-ci.test.ts'` — Expected: FAIL, module not found.

- [ ] **Step 3: Implement** `github-ci.ts`:

```ts
import type { WorkflowRun } from '../ci/rules.js';

const API = 'https://api.github.com';

export class GithubCiError extends Error {
  constructor(
    public kind: 'auth' | 'not_found' | 'rate_limited' | 'http',
    public status: number,
    public resetAt: Date | null = null,
  ) {
    super(`GitHub ${status} (${kind})`);
  }
}

export interface GithubPull {
  number: number;
  html_url: string;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  draft: boolean;
  merged_at: string | null;
  merge_commit_sha: string | null;
  head: { ref: string; sha: string };
}
export type PullsPage = { notModified: true } | { notModified: false; etag: string | null; pulls: GithubPull[] };

export interface GithubCiClient {
  listPulls(token: string, repo: string, etag: string | null): Promise<PullsPage>;
  listRuns(token: string, repo: string, headSha: string): Promise<WorkflowRun[]>;
}

function failure(res: Response): GithubCiError {
  if (res.status === 401) return new GithubCiError('auth', 401);
  if (res.status === 404) return new GithubCiError('not_found', 404);
  if ((res.status === 403 || res.status === 429) && res.headers.get('x-ratelimit-remaining') === '0') {
    const reset = Number(res.headers.get('x-ratelimit-reset'));
    return new GithubCiError('rate_limited', res.status, Number.isFinite(reset) && reset > 0 ? new Date(reset * 1000) : null);
  }
  if (res.status === 403) return new GithubCiError('auth', 403);
  return new GithubCiError('http', res.status);
}

/** Pulls and Actions runs for the CI panel (spec 2026-09-26 progress-panel §5.3). The token is only ever a header. */
export function createGithubCiClient(fetchImpl: typeof fetch = fetch): GithubCiClient {
  const get = (token: string, path: string, etag: string | null = null) =>
    fetchImpl(`${API}${path}`, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'user-agent': 'termhub',
        'x-github-api-version': '2022-11-28',
        ...(etag ? { 'if-none-match': etag } : {}),
      },
    });

  return {
    async listPulls(token, repo, etag) {
      const res = await get(token, `/repos/${repo}/pulls?state=all&sort=updated&direction=desc&per_page=30`, etag);
      if (res.status === 304) return { notModified: true };
      if (!res.ok) throw failure(res);
      return { notModified: false, etag: res.headers.get('etag'), pulls: (await res.json()) as GithubPull[] };
    },
    async listRuns(token, repo, headSha) {
      const res = await get(token, `/repos/${repo}/actions/runs?head_sha=${encodeURIComponent(headSha)}&per_page=50`);
      if (!res.ok) throw failure(res);
      const body = (await res.json()) as { workflow_runs: WorkflowRun[] };
      return body.workflow_runs.map(({ id, name, path, status, conclusion, html_url, created_at }) => ({ id, name, path, status, conclusion, html_url, created_at }));
    },
  };
}
```

- [ ] **Step 4: Run** the test — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/integrations/github-ci.ts apps/server/src/integrations/github-ci.test.ts
git commit -m "CI: GitHub client for pull requests and workflow runs"
```

---

### Task 5: `syncProjectCi` — link PRs to cards and refresh CI/deploy

**Files:**
- Create: `apps/server/src/ci/sync.ts`, `apps/server/src/ci/sync.test.ts`, `apps/server/src/ci/status.ts`

**Interfaces:**
- Consumes: Tasks 2–4; `repos.projectSetup.get`, `repos.projects.findById`, `repos.integrations.findById/getSecret`, `repos.tasks.findByRef`.
- Produces:
  ```ts
  // status.ts — per-process last error per project, read by the progress route
  export function setCiError(projectId: string, message: string | null): void
  export function ciErrorOf(projectId: string): string | null
  // sync.ts
  export interface CiSyncDeps { repos: Repositories; github: GithubCiClient; etags: Map<string, string>; now?: () => Date }
  export type CiSyncResult = { skipped: 'no_repo' | 'not_allowed' } | { pulls: number | null; checked: number }
  export async function syncProjectCi(deps: CiSyncDeps, projectId: string): Promise<CiSyncResult>
  ```
  Error messages (pt-BR, shown on the panel): `auth` → `GitHub: o token não tem acesso ao repositório`, `not_found` → `GitHub: repositório não encontrado`, `rate_limited` → `GitHub: limite de requisições atingido`, `http` → `GitHub: falha ao consultar (HTTP <status>)`. A `GithubCiError` is caught, recorded with `setCiError`, and rethrown for the scheduler's backoff; a successful sync clears it.

- [ ] **Step 1: Write the failing test** (`sync.test.ts`, in-memory fakes, no DB):

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Repositories } from '../db/repositories/index.js';
import type { GithubCiClient, GithubPull } from '../integrations/github-ci.js';
import { GithubCiError } from '../integrations/github-ci.js';
import { ciErrorOf } from './status.js';
import { syncProjectCi } from './sync.js';

const pull = (over: Partial<GithubPull> = {}): GithubPull => ({
  number: 7, html_url: 'https://github.com/acme/app/pull/7', title: 'Painel TER-2', body: 'Also TER-3 and TER-1 and TER-99', state: 'open', draft: false,
  merged_at: null, merge_commit_sha: null, head: { ref: 'TER-2-panel', sha: 'abc' }, ...over,
});
const cards: Record<number, { id: string; type: string; parent_id: string | null }> = {
  1: { id: 'epic', type: 'epic', parent_id: null },
  2: { id: 'card2', type: 'story', parent_id: null },
  3: { id: 'sub3', type: 'subtask', parent_id: 'card2' },
};

function setup(over: { integrationOwner?: string; provider?: string; repo?: object | null } = {}) {
  const replaceLinks = vi.fn(async () => {});
  const updateCi = vi.fn(async () => {});
  const listWatched = vi.fn(async () => [] as unknown[]);
  const repos = {
    projectSetup: { get: vi.fn(async () => ({ data: { repo: over.repo === undefined ? { integration_id: 'i1', full_name: 'acme/app', deploy_workflow: 'deploy.yml' } : over.repo } })) },
    projects: { findById: vi.fn(async () => ({ id: 'p1', key: 'TER', owner_id: 'u1' })) },
    integrations: {
      findById: vi.fn(async () => ({ id: 'i1', provider: over.provider ?? 'github', owner_id: over.integrationOwner ?? 'u1' })),
      getSecret: vi.fn(async () => 'tok'),
    },
    tasks: { findByRef: vi.fn(async (_p: string, n: number) => cards[n]) },
    taskPullRequests: { replaceLinks, updateCi, listWatched },
  } as unknown as Repositories;
  const github: GithubCiClient = {
    listPulls: vi.fn(async () => ({ notModified: false as const, etag: 'e2', pulls: [pull()] })),
    listRuns: vi.fn(async () => [{ id: 1, name: 'CI', path: '.github/workflows/ci.yml', status: 'completed', conclusion: 'failure', html_url: 'r', created_at: '2026-09-27T12:00:00Z' }]),
  };
  const etags = new Map<string, string>();
  return { deps: { repos, github, etags, now: () => new Date('2026-09-27T12:00:00Z') }, replaceLinks, updateCi, listWatched, github, etags };
}

beforeEach(() => vi.clearAllMocks());

describe('syncProjectCi', () => {
  it('links the PR to the cards it names, a subtask to its parent, never an epic or a missing number', async () => {
    const { deps, replaceLinks, etags } = setup();
    expect(await syncProjectCi(deps, 'p1')).toEqual({ pulls: 1, checked: 0 });
    expect(replaceLinks).toHaveBeenCalledWith('p1', expect.objectContaining({ repo: 'acme/app', number: 7, state: 'open', head_sha: 'abc' }), ['card2']);
    expect(etags.get('p1')).toBe('e2');
  });

  it('calls replaceLinks with no cards when the PR names none, so old links go', async () => {
    const { deps, replaceLinks, github } = setup();
    vi.mocked(github.listPulls).mockResolvedValue({ notModified: false, etag: null, pulls: [pull({ title: 'x', body: null, head: { ref: 'main-fix', sha: 'z' } })] });
    await syncProjectCi(deps, 'p1');
    expect(replaceLinks).toHaveBeenCalledWith('p1', expect.objectContaining({ number: 7 }), []);
  });

  it('maps a merged PR', async () => {
    const { deps, replaceLinks, github } = setup();
    vi.mocked(github.listPulls).mockResolvedValue({ notModified: false, etag: null, pulls: [pull({ state: 'closed', merged_at: '2026-09-27T11:00:00Z', merge_commit_sha: 'm' })] });
    await syncProjectCi(deps, 'p1');
    expect(replaceLinks).toHaveBeenCalledWith('p1', expect.objectContaining({ state: 'merged', merge_commit_sha: 'm', merged_at: new Date('2026-09-27T11:00:00Z') }), ['card2']);
  });

  it('refreshes CI of open watched PRs and deploy of merged ones, once per PR, even when the list is not modified', async () => {
    const { deps, updateCi, listWatched, github } = setup();
    vi.mocked(github.listPulls).mockResolvedValue({ notModified: true });
    listWatched.mockResolvedValue([
      { repo: 'acme/app', number: 7, state: 'open', head_sha: 'abc', merge_commit_sha: null },
      { repo: 'acme/app', number: 7, state: 'open', head_sha: 'abc', merge_commit_sha: null },
      { repo: 'acme/app', number: 5, state: 'merged', head_sha: 'old', merge_commit_sha: 'm5' },
    ]);
    expect(await syncProjectCi(deps, 'p1')).toEqual({ pulls: null, checked: 2 });
    expect(updateCi).toHaveBeenCalledWith('p1', 'acme/app', 7, { ci_state: 'failed', ci_summary: { total: 1, passed: 0, failed: 1, running: 0, failing: ['CI'] } });
    expect(updateCi).toHaveBeenCalledWith('p1', 'acme/app', 5, { deploy_state: 'none', deploy_url: null });
    expect(github.listRuns).toHaveBeenCalledWith('tok', 'acme/app', 'm5');
  });

  it('skips a project without repo, and one whose integration is not the owner’s GitHub', async () => {
    expect(await syncProjectCi(setup({ repo: null }).deps, 'p1')).toEqual({ skipped: 'no_repo' });
    expect(await syncProjectCi(setup({ integrationOwner: 'u2' }).deps, 'p1')).toEqual({ skipped: 'not_allowed' });
    expect(await syncProjectCi(setup({ provider: 'linear' }).deps, 'p1')).toEqual({ skipped: 'not_allowed' });
  });

  it('records a GitHub failure for the panel, keeps the links, and clears it after a good sync', async () => {
    const { deps, replaceLinks, github } = setup();
    vi.mocked(github.listPulls).mockRejectedValueOnce(new GithubCiError('auth', 401));
    await expect(syncProjectCi(deps, 'p1')).rejects.toBeInstanceOf(GithubCiError);
    expect(ciErrorOf('p1')).toBe('GitHub: o token não tem acesso ao repositório');
    expect(replaceLinks).not.toHaveBeenCalled();
    await syncProjectCi(deps, 'p1');
    expect(ciErrorOf('p1')).toBeNull();
  });
});
```

- [ ] **Step 2: Run** `DOCKER 'npx -w @termhub/server vitest run src/ci/sync.test.ts'` — Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`status.ts`:

```ts
/** Last CI sync error per project, in this process (spec §5.3); the progress route shows it on the epic. */
const errors = new Map<string, string>();

export function setCiError(projectId: string, message: string | null): void {
  if (message) errors.set(projectId, message);
  else errors.delete(projectId);
}

export function ciErrorOf(projectId: string): string | null {
  return errors.get(projectId) ?? null;
}
```

`sync.ts`:

```ts
import type { Repositories } from '../db/repositories/index.js';
import type { PullRequestInfo } from '../db/repositories/task-pull-requests.js';
import { GithubCiError, type GithubCiClient, type GithubPull } from '../integrations/github-ci.js';
import { ciOf, deployOf, refsIn } from './rules.js';
import { setCiError } from './status.js';

export interface CiSyncDeps {
  repos: Repositories;
  github: GithubCiClient;
  /** last ETag of the pulls list, per project (in memory: a restart costs one full list) */
  etags: Map<string, string>;
  now?: () => Date;
}
export type CiSyncResult = { skipped: 'no_repo' | 'not_allowed' } | { pulls: number | null; checked: number };

const MESSAGES: Record<GithubCiError['kind'], (status: number) => string> = {
  auth: () => 'GitHub: o token não tem acesso ao repositório',
  not_found: () => 'GitHub: repositório não encontrado',
  rate_limited: () => 'GitHub: limite de requisições atingido',
  http: (status) => `GitHub: falha ao consultar (HTTP ${status})`,
};

const infoOf = (repo: string, p: GithubPull): PullRequestInfo => ({
  repo,
  number: p.number,
  url: p.html_url,
  title: p.title,
  head_ref: p.head.ref,
  head_sha: p.head.sha,
  state: p.merged_at ? 'merged' : p.state,
  draft: p.draft,
  merged_at: p.merged_at ? new Date(p.merged_at) : null,
  merge_commit_sha: p.merged_at ? p.merge_commit_sha : null,
});

/** Card ids a PR names: a subtask counts for its parent; epics and unknown numbers count for nothing. */
async function cardsNamed(repos: Repositories, projectId: string, key: string, pull: GithubPull): Promise<string[]> {
  const ids = new Set<string>();
  for (const n of refsIn([pull.head.ref, pull.title, pull.body], key)) {
    const t = await repos.tasks.findByRef(projectId, n);
    if (!t || t.type === 'epic') continue;
    ids.add(t.parent_id ?? t.id);
  }
  return [...ids];
}

/** One project's CI sync (spec 2026-09-26 progress-panel §5.5). */
export async function syncProjectCi(deps: CiSyncDeps, projectId: string): Promise<CiSyncResult> {
  const { repos } = deps;
  const repo = (await repos.projectSetup.get(projectId)).data.repo;
  if (!repo?.integration_id || !repo.full_name) return { skipped: 'no_repo' };
  const [project, integration] = await Promise.all([repos.projects.findById(projectId), repos.integrations.findById(repo.integration_id)]);
  if (!project || !integration || integration.provider !== 'github' || integration.owner_id !== project.owner_id) return { skipped: 'not_allowed' };
  const token = await repos.integrations.getSecret(integration.id);
  if (!token) return { skipped: 'not_allowed' };

  try {
    let pulls: number | null = null;
    const page = await deps.github.listPulls(token, repo.full_name, deps.etags.get(projectId) ?? null);
    if (!page.notModified) {
      for (const pull of page.pulls) await repos.taskPullRequests.replaceLinks(projectId, infoOf(repo.full_name, pull), await cardsNamed(repos, projectId, project.key, pull));
      if (page.etag) deps.etags.set(projectId, page.etag);
      pulls = page.pulls.length;
    }
    const seen = new Set<number>();
    for (const w of await repos.taskPullRequests.listWatched(projectId, deps.now?.() ?? new Date())) {
      if (seen.has(w.number)) continue;
      seen.add(w.number);
      if (w.state === 'open') {
        const { state, summary } = ciOf(await deps.github.listRuns(token, w.repo, w.head_sha));
        await repos.taskPullRequests.updateCi(projectId, w.repo, w.number, { ci_state: state, ci_summary: summary });
      } else if (w.merge_commit_sha) {
        const { state, url } = deployOf(await deps.github.listRuns(token, w.repo, w.merge_commit_sha), repo.deploy_workflow);
        await repos.taskPullRequests.updateCi(projectId, w.repo, w.number, { deploy_state: state, deploy_url: url });
      }
    }
    setCiError(projectId, null);
    return { pulls, checked: seen.size };
  } catch (e) {
    if (e instanceof GithubCiError) setCiError(projectId, MESSAGES[e.kind](e.status));
    throw e;
  }
}
```

(`repos.tasks.findByRef(projectId, number)` already exists; it returns the `Task` with `type` and `parent_id`.)

- [ ] **Step 4: Run** the test and `DOCKER 'npm run typecheck -w @termhub/server'` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/ci
git commit -m "CI: sync pull requests, CI and deploy of a project"
```

---

### Task 6: Scheduler and wiring

**Files:**
- Create: `apps/server/src/ci/scheduler.ts`, `apps/server/src/ci/scheduler.test.ts`
- Modify: `apps/server/src/db/repositories/project-setup.ts` (`listWithRepo`), `apps/server/src/db/repositories/tasks.ts` (`hasDoing`), `apps/server/src/app.ts` (start/stop)

**Interfaces:**
- Consumes: `syncProjectCi` (Task 5), `createGithubCiClient` (Task 4), `repos.taskPullRequests.listWatched` (Task 2).
- Produces:
  ```ts
  // project-setup.ts
  listWithRepo(): Promise<{ project_id: string; data: ProjectSetupData }[]>   // repo.integration_id and repo.full_name set
  // tasks.ts
  hasDoing(projectId: string): Promise<boolean>   // a top-level work card in a doing column
  // scheduler.ts
  export const CI_POLL_MS = 60_000;
  export interface CiTickState { etags: Map<string, string>; pausedUntil: Map<string, number> }
  export async function ciTick(deps: { repos: Repositories; github: GithubCiClient; log: Log; now?: () => Date }, state: CiTickState): Promise<void>
  export function startCiSyncScheduler(repos: Repositories, log: Log, github?: GithubCiClient): () => void
  ```
  (`Log = { info(o: object, m: string): void; warn(o: object, m: string): void }`, the shape `startTicketSyncScheduler` takes.)

- [ ] **Step 1: Write the failing test** (`scheduler.test.ts`):

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Repositories } from '../db/repositories/index.js';
import { GithubCiError, type GithubCiClient } from '../integrations/github-ci.js';

const sync = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock('./sync.js', () => ({ syncProjectCi: (...a: unknown[]) => sync.fn(...a) }));

import { ciTick, type CiTickState } from './scheduler.js';

const NOW = new Date('2026-09-27T12:00:00Z');
const log = { info: vi.fn(), warn: vi.fn() };

function setup(doing: Record<string, boolean>, watched: Record<string, number>) {
  const repos = {
    projectSetup: { listWithRepo: vi.fn(async () => Object.keys(doing).map((id) => ({ project_id: id, data: {} }))) },
    tasks: { hasDoing: vi.fn(async (id: string) => doing[id]) },
    taskPullRequests: { listWatched: vi.fn(async (id: string) => Array.from({ length: watched[id] ?? 0 }, () => ({}))) },
  } as unknown as Repositories;
  const state: CiTickState = { etags: new Map(), pausedUntil: new Map() };
  return { deps: { repos, github: {} as GithubCiClient, log, now: () => NOW }, state };
}

beforeEach(() => {
  sync.fn.mockReset().mockResolvedValue({ pulls: 0, checked: 0 });
});

describe('ciTick', () => {
  it('syncs projects with a card in doing or a watched PR, and skips the others', async () => {
    const { deps, state } = setup({ p1: true, p2: false, p3: false }, { p2: 1 });
    await ciTick(deps, state);
    expect(sync.fn.mock.calls.map((c) => c[1])).toEqual(['p1', 'p2']);
  });

  it('pauses a rate-limited project until the reset, and keeps going with the others', async () => {
    const { deps, state } = setup({ p1: true, p2: true }, {});
    sync.fn.mockImplementation(async (_d: unknown, id: string) => {
      if (id === 'p1') throw new GithubCiError('rate_limited', 403, new Date('2026-09-27T12:30:00Z'));
      return { pulls: 0, checked: 0 };
    });
    await ciTick(deps, state);
    expect(state.pausedUntil.get('p1')).toBe(Date.parse('2026-09-27T12:30:00Z'));
    sync.fn.mockClear();
    await ciTick(deps, state);
    expect(sync.fn.mock.calls.map((c) => c[1])).toEqual(['p2']);
  });

  it('logs other failures without the token and continues', async () => {
    const { deps, state } = setup({ p1: true, p2: true }, {});
    sync.fn.mockRejectedValueOnce(new GithubCiError('auth', 401));
    await ciTick(deps, state);
    expect(sync.fn).toHaveBeenCalledTimes(2);
    expect(log.warn).toHaveBeenCalledWith({ projectId: 'p1', err: 'GitHub 401 (auth)' }, 'ci sync failed');
  });
});
```

- [ ] **Step 2: Run** `DOCKER 'npx -w @termhub/server vitest run src/ci/scheduler.test.ts'` — Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`project-setup.ts`:

```ts
  /** Projects whose setup names a repository and the integration to read it with (CI panel). */
  async listWithRepo(): Promise<{ project_id: string; data: ProjectSetupData }[]> {
    const rows = await this.db.projectSetup.findMany();
    return rows
      .map((r) => ({ project_id: r.projectId, data: normalizeSetup(r.data, r.version) }))
      .filter((r) => !!r.data.repo?.integration_id && !!r.data.repo.full_name);
  }
```

`tasks.ts` (next to `listDoing`):

```ts
  /** Whether the project has a top-level work card in a doing column (the CI poll's "work in progress"). */
  async hasDoing(projectId: string): Promise<boolean> {
    return (await this.db.task.count({ where: { projectId, status: 'doing', ...WORK }, take: 1 })) > 0;
  }
```

`scheduler.ts`:

```ts
import type { Repositories } from '../db/repositories/index.js';
import { createGithubCiClient, GithubCiError, type GithubCiClient } from '../integrations/github-ci.js';
import { syncProjectCi } from './sync.js';

export const CI_POLL_MS = 60_000;
/** A rate-limited project without a reset time waits this long. */
const DEFAULT_PAUSE_MS = 15 * 60_000;

type Log = { info: (o: object, m: string) => void; warn: (o: object, m: string) => void };
export interface CiTickState { etags: Map<string, string>; pausedUntil: Map<string, number> }

/** One pass: every project with a repo and work in progress (a card in doing, or a watched PR). */
export async function ciTick(deps: { repos: Repositories; github: GithubCiClient; log: Log; now?: () => Date }, state: CiTickState): Promise<void> {
  const now = deps.now?.() ?? new Date();
  const projects = await deps.repos.projectSetup.listWithRepo().catch(() => []);
  for (const { project_id: projectId } of projects) {
    if ((state.pausedUntil.get(projectId) ?? 0) > now.getTime()) continue;
    const busy = (await deps.repos.tasks.hasDoing(projectId)) || (await deps.repos.taskPullRequests.listWatched(projectId, now)).length > 0;
    if (!busy) continue;
    try {
      await syncProjectCi({ repos: deps.repos, github: deps.github, etags: state.etags, now: () => now }, projectId);
    } catch (e) {
      if (e instanceof GithubCiError && e.kind === 'rate_limited') state.pausedUntil.set(projectId, e.resetAt?.getTime() ?? now.getTime() + DEFAULT_PAUSE_MS);
      deps.log.warn({ projectId, err: (e as Error).message }, 'ci sync failed');
    }
  }
}

/** The CI panel's poll (spec 2026-09-26 progress-panel D11); both colours may run it during a switch — writes are idempotent. */
export function startCiSyncScheduler(repos: Repositories, log: Log, github: GithubCiClient = createGithubCiClient()): () => void {
  const state: CiTickState = { etags: new Map(), pausedUntil: new Map() };
  let running = false;
  const tick = async () => {
    if (running) return; // a slow GitHub never stacks passes
    running = true;
    try {
      await ciTick({ repos, github, log }, state);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), CI_POLL_MS);
  const first = setTimeout(() => void tick(), 10_000);
  return () => {
    clearInterval(timer);
    clearTimeout(first);
  };
}
```

`app.ts`: next to `startTicketSyncScheduler`: `const stopCiSync = startCiSyncScheduler(repos, fastify.log);` and `stopCiSync();` in the `onClose` hook (plus the import).

- [ ] **Step 4: Run** the test and `DOCKER 'npx -w @termhub/server vitest run src/ci src/app && npm run typecheck -w @termhub/server'` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/ci apps/server/src/db/repositories/project-setup.ts apps/server/src/db/repositories/tasks.ts apps/server/src/app.ts
git commit -m "CI: poll GitHub every minute for projects with work in progress"
```

---

### Task 7: PR badges and epic CI summary in the progress read model

**Files:**
- Modify: `packages/mobile-api/src/progress.ts` (+ `progress.test.ts`), `apps/server/src/db/repositories/progress.ts` (include PRs), `apps/server/src/progress/aggregate.ts` (+ test), `apps/server/src/routes/progress.ts` (+ test)

**Interfaces:**
- Consumes: `TaskPullRequest` rows (Task 2) through the `pullRequests` relation; `ciErrorOf` (Task 5).
- Produces (contract): `pullRequestBadge = { number, url, title, state: 'open'|'closed'|'merged', draft, ci_state, ci_summary: { total, passed, failed, running, failing: string[] }, deploy_state, deploy_url: string|null }`; `cardProgress.pull_requests: PullRequestBadge[]` (`.default([])`); `epicProgress.ci: { open: number; failed: number; running: number; deployed: number } | null` (`.default(null)`, null when no card has a PR) and `epicProgress.ci_error: string | null` (`.default(null)`). Row type: `ProgressCardRow.pull_requests: PullRequestBadge[]`.

- [ ] **Step 1: Write the failing tests**

`packages/mobile-api/src/progress.test.ts` — add:

```ts
  it('defaults the CI fields so an older server still parses', () => {
    const parsed = progressResponse.parse({ epics: [epic], generated_at: 'x' });
    expect(parsed.epics[0].ci).toBeNull();
    expect(parsed.epics[0].ci_error).toBeNull();
    expect(parsed.epics[0].cards[0].pull_requests).toEqual([]);
  });
```

`aggregate.test.ts` — extend the `card()` factory default with `pull_requests: []` and add:

```ts
describe('CI summary', () => {
  const badge = (over: Partial<PullRequestBadge>): PullRequestBadge => ({
    number: 1, url: 'u', title: 't', state: 'open', draft: false, ci_state: 'passed',
    ci_summary: { total: 1, passed: 1, failed: 0, running: 0, failing: [] }, deploy_state: 'none', deploy_url: null, ...over,
  });
  it('is null when no card has a PR', () => {
    expect(aggregateEpic(epic([card({ id: '2' })]), true).ci).toBeNull();
  });
  it('counts PRs once per number across cards', () => {
    const shared = badge({ number: 7, ci_state: 'failed' });
    const e = aggregateEpic(epic([
      card({ id: '2', pull_requests: [shared, badge({ number: 8, ci_state: 'running' })] }),
      card({ id: '3', pull_requests: [shared, badge({ number: 9, state: 'merged', deploy_state: 'passed' }), badge({ number: 10, state: 'merged', deploy_state: 'failed' })] }),
    ]), true);
    expect(e.ci).toEqual({ open: 2, failed: 2, running: 1, deployed: 1 });
    expect(e.cards[0].pull_requests.map((p) => p.number)).toEqual([7, 8]);
  });
});
```

(`failed` counts open PRs with CI failed plus merged PRs whose deploy failed; `running` counts CI running or deploy running; `deployed` counts deploy passed.)

`routes/progress.test.ts` — add `pull_requests: []` to the row fixtures, mock `../ci/status.js` with `ciErrorOf: (id: string) => (id === 'p1' ? 'GitHub: repositório não encontrado' : null)`, and assert `body.epics[0].ci_error` is that message.

- [ ] **Step 2: Run** `DOCKER 'npx -w @termhub/mobile-api vitest run && npx -w @termhub/server vitest run src/progress src/routes/progress.test.ts'` — Expected: FAIL.

- [ ] **Step 3: Implement**

Contract (`progress.ts`):

```ts
const ciState = z.enum(['none', 'running', 'passed', 'failed']);
export const pullRequestBadge = z.object({
  number: z.number().int().positive(),
  url: z.string(),
  title: z.string(),
  state: z.enum(['open', 'closed', 'merged']),
  draft: z.boolean(),
  ci_state: ciState,
  ci_summary: z.object({ total: count, passed: count, failed: count, running: count, failing: z.array(z.string()) }),
  deploy_state: ciState,
  deploy_url: z.string().nullable(),
});
export type PullRequestBadge = z.infer<typeof pullRequestBadge>;
```

Add `pull_requests: z.array(pullRequestBadge).default([])` to `cardProgress`, and to `epicProgress`: `ci: z.object({ open: count, failed: count, running: count, deployed: count }).nullable().default(null)`, `ci_error: z.string().nullable().default(null)`. Rebuild: `DOCKER 'npm run build -w @termhub/mobile-api'`.

`db/repositories/progress.ts`: add `pullRequests: { orderBy: [{ number: 'desc' }] }` to the cards `include`, and map each card's `pull_requests` from it:

```ts
          pull_requests: c.pullRequests.map((p) => ({
            number: p.number,
            url: p.url,
            title: p.title,
            state: p.state as 'open' | 'closed' | 'merged',
            draft: p.draft,
            ci_state: p.ciState as PullRequestBadge['ci_state'],
            ci_summary: { total: 0, passed: 0, failed: 0, running: 0, failing: [], ...(p.ciSummary as object) },
            deploy_state: p.deployState as PullRequestBadge['deploy_state'],
            deploy_url: p.deployUrl,
          })),
```

`aggregate.ts`: `ProgressCardRow` gains `pull_requests: PullRequestBadge[]`; `aggregateCard` copies it; `aggregateEpic` adds `ci: ciSummary(cards)` and `ci_error: null`:

```ts
function ciSummary(cards: CardProgress[]): EpicProgress['ci'] {
  const byNumber = new Map<number, PullRequestBadge>();
  for (const c of cards) for (const p of c.pull_requests) byNumber.set(p.number, p);
  if (byNumber.size === 0) return null;
  const ci = { open: 0, failed: 0, running: 0, deployed: 0 };
  for (const p of byNumber.values()) {
    if (p.state === 'open') ci.open++;
    if ((p.state === 'open' && p.ci_state === 'failed') || p.deploy_state === 'failed') ci.failed++;
    if ((p.state === 'open' && p.ci_state === 'running') || p.deploy_state === 'running') ci.running++;
    if (p.deploy_state === 'passed') ci.deployed++;
  }
  return ci;
}
```

`routes/progress.ts`: after aggregation, `epics.map((e) => ({ ...e, ci_error: ciErrorOf(e.project.id) }))` before `selectEpics` (import from `../ci/status.js`).

Update phase 1's fixtures that build `ProgressCardRow` (`progress.db.test.ts` needs none; `aggregate.test.ts` and `routes/progress.test.ts` do, as above).

- [ ] **Step 4: Run** the tests of Step 2, then `DOCKER 'npx -w @termhub/server vitest run src/db/repositories/progress.db.test.ts && npm run typecheck -w @termhub/server'` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/mobile-api/src apps/server/src
git commit -m "Progress: carry pull request badges and the epic CI summary"
```

---

### Task 8: Web — PR badges and CI line in the panel

**Files:**
- Modify: `apps/web/src/lib/types.ts` (mirror Task 7), `apps/web/src/lib/progress.ts` (+ test), `apps/web/src/components/ProgressPanel.tsx` (+ test)

**Interfaces:**
- Produces: web types `PullRequestBadge`, `CardProgress.pull_requests`, `EpicProgress.ci`, `EpicProgress.ci_error`; `lib/progress.ts`: `ciLabel(p: PullRequestBadge): string`, `epicCiLine(ci: NonNullable<EpicProgress['ci']>): string`; component `PullRequestBadges({ pulls }: { pulls: PullRequestBadge[] })` exported from `ProgressPanel.tsx` (reused in Task 9).

- [ ] **Step 1: Write the failing tests**

`lib/progress.test.ts`:

```ts
describe('ciLabel', () => {
  const p = (over: Partial<PullRequestBadge>): PullRequestBadge => ({ number: 7, url: 'u', title: 't', state: 'open', draft: false, ci_state: 'passed', ci_summary: { total: 2, passed: 2, failed: 0, running: 0, failing: [] }, deploy_state: 'none', deploy_url: null, ...over });
  it('describes an open PR by its CI', () => {
    expect(ciLabel(p({}))).toBe('CI verde');
    expect(ciLabel(p({ ci_state: 'running' }))).toBe('CI rodando');
    expect(ciLabel(p({ ci_state: 'failed', ci_summary: { total: 2, passed: 1, failed: 1, running: 0, failing: ['lint'] } }))).toBe('CI falhou: lint');
    expect(ciLabel(p({ ci_state: 'none' }))).toBe('sem CI');
  });
  it('describes a merged PR by its deploy, and a closed one as fechado', () => {
    expect(ciLabel(p({ state: 'merged', deploy_state: 'running' }))).toBe('deploy rodando');
    expect(ciLabel(p({ state: 'merged', deploy_state: 'passed' }))).toBe('deploy ok');
    expect(ciLabel(p({ state: 'merged', deploy_state: 'failed' }))).toBe('deploy falhou');
    expect(ciLabel(p({ state: 'merged', deploy_state: 'none' }))).toBe('mergeado');
    expect(ciLabel(p({ state: 'closed' }))).toBe('fechado');
  });
});

describe('epicCiLine', () => {
  it('summarises the epic PRs', () => {
    expect(epicCiLine({ open: 2, failed: 1, running: 1, deployed: 3 })).toBe('PRs: 2 abertos · 1 falhou · 1 rodando · 3 em produção');
    expect(epicCiLine({ open: 1, failed: 0, running: 0, deployed: 0 })).toBe('PRs: 1 aberto');
  });
});
```

`ProgressPanel.test.tsx` — give the fixture card `pull_requests: [{ number: 12, url: 'https://github.com/acme/app/pull/12', title: 'Painel', state: 'open', draft: true, ci_state: 'failed', ci_summary: { total: 2, passed: 1, failed: 1, running: 0, failing: ['lint'] }, deploy_state: 'none', deploy_url: null }]` and the epic `ci: { open: 1, failed: 1, running: 0, deployed: 0 }, ci_error: 'GitHub: repositório não encontrado'`; add:

```tsx
  it('shows PR badges, the epic CI line and a sync error', async () => {
    mount();
    const link = await screen.findByRole('link', { name: /PR #12/ });
    expect(link).toHaveAttribute('href', 'https://github.com/acme/app/pull/12');
    expect(link).toHaveTextContent('rascunho');
    expect(screen.getByText('CI falhou: lint')).toBeInTheDocument();
    expect(screen.getByText('PRs: 1 aberto · 1 falhou')).toBeInTheDocument();
    expect(screen.getByText('GitHub: repositório não encontrado')).toBeInTheDocument();
  });
```

(Add `pull_requests: []`, `ci: null`, `ci_error: null` to the other fixtures that need to type-check.)

- [ ] **Step 2: Run** `DOCKER 'npx -w @termhub/web vitest run src/lib/progress.test.ts src/components/ProgressPanel.test.tsx'` — Expected: FAIL.

- [ ] **Step 3: Implement**

`types.ts`: `PullRequestBadge` interface (same shape as the contract), `pull_requests: PullRequestBadge[]` on `CardProgress`, `ci: { open: number; failed: number; running: number; deployed: number } | null` and `ci_error: string | null` on `EpicProgress`.

`lib/progress.ts`:

```ts
/** One line per PR: an open PR by its CI, a merged one by its deploy (spec §5.6). */
export function ciLabel(p: PullRequestBadge): string {
  if (p.state === 'closed') return 'fechado';
  if (p.state === 'merged') return { none: 'mergeado', running: 'deploy rodando', passed: 'deploy ok', failed: 'deploy falhou' }[p.deploy_state];
  if (p.ci_state === 'failed') return p.ci_summary.failing.length ? `CI falhou: ${p.ci_summary.failing.join(', ')}` : 'CI falhou';
  return { none: 'sem CI', running: 'CI rodando', passed: 'CI verde' }[p.ci_state];
}

export function epicCiLine(ci: { open: number; failed: number; running: number; deployed: number }): string {
  const parts = [`${ci.open} ${ci.open === 1 ? 'aberto' : 'abertos'}`];
  if (ci.failed) parts.push(`${ci.failed} falhou`);
  if (ci.running) parts.push(`${ci.running} rodando`);
  if (ci.deployed) parts.push(`${ci.deployed} em produção`);
  return `PRs: ${parts.join(' · ')}`;
}
```

`ProgressPanel.tsx`:

```tsx
const CI_TONE: Record<string, string> = { passed: 'text-emerald-600', running: 'text-amber-600', failed: 'text-red-600', none: 'text-zinc-500' };

export function PullRequestBadges({ pulls }: { pulls: PullRequestBadge[] }) {
  if (pulls.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1">
      {pulls.map((p) => {
        const tone = p.state === 'merged' ? CI_TONE[p.deploy_state] : p.state === 'open' ? CI_TONE[p.ci_state] : CI_TONE.none;
        return (
          <span key={p.number} className="inline-flex items-center gap-1 text-xs">
            <a href={p.url} target="_blank" rel="noreferrer" className="rounded border border-zinc-300 px-1.5 py-0.5 hover:underline dark:border-zinc-700" title={p.title}>
              PR #{p.number}
              {p.draft ? ' · rascunho' : ''}
            </a>
            {p.state === 'merged' && p.deploy_url ? (
              <a href={p.deploy_url} target="_blank" rel="noreferrer" className={tone}>
                {ciLabel(p)}
              </a>
            ) : (
              <span className={tone}>{ciLabel(p)}</span>
            )}
          </span>
        );
      })}
    </div>
  );
}
```

Render `<PullRequestBadges pulls={card.pull_requests} />` in `CardRow` under the estimate; in `EpicBlock`'s stats row add `{epic.ci && <span>{epicCiLine(epic.ci)}</span>}` and, under the stats row, `{epic.ci_error && <p className="text-xs text-red-600">{epic.ci_error}</p>}`.

- [ ] **Step 4: Run** the tests — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src
git commit -m "Web: show pull requests, CI and deploy in the progress panel"
```

---

### Task 9: Pull requests on the card

**Files:**
- Modify: `apps/server/src/routes/tasks.ts` (+ `tasks.test.ts`), `apps/web/src/lib/api.ts`, `apps/web/src/components/TaskEditor.tsx` (+ `TaskEditor.test.tsx`)
- Create: `apps/web/src/components/CardPullRequests.tsx`, `apps/web/src/components/CardPullRequests.test.tsx`

**Interfaces:**
- Consumes: `repos.taskPullRequests.listByTasks` (Task 2), `PullRequestBadges` (Task 8).
- Produces: `GET /api/tasks/:id/pull-requests` → `{ pull_requests: PullRequestBadge[] }` (a subtask answers its parent's PRs); `api.tasks.pullRequests(id: string): Promise<{ pull_requests: PullRequestBadge[] }>`; `CardPullRequests({ taskId }: { taskId: string })`.

- [ ] **Step 1: Write the failing tests**

`tasks.test.ts` — add `taskPullRequests: { listByTasks: vi.fn(async (ids: string[]) => ids.includes('t1') ? [{ number: 7, url: 'u', title: 'x', state: 'open', draft: false, ci_state: 'passed', ci_summary: { total: 1, passed: 1, failed: 0, running: 0, failing: [] }, deploy_state: 'none', deploy_url: null, head_sha: 'abc', task_id: 't1' }] : []) }` to the stubbed repos, and:

```ts
describe('task routes: pull requests', () => {
  it('lists the card PRs as badges, without internal fields', async () => {
    const { app } = buildApp(store);
    const r = await app.inject({ method: 'GET', url: '/tasks/t1/pull-requests' });
    expect(r.statusCode).toBe(200);
    expect(r.json().pull_requests).toEqual([{ number: 7, url: 'u', title: 'x', state: 'open', draft: false, ci_state: 'passed', ci_summary: { total: 1, passed: 1, failed: 0, running: 0, failing: [] }, deploy_state: 'none', deploy_url: null }]);
  });
  it('answers the parent PRs for a subtask', async () => {
    const { app } = buildApp(store);
    expect((await app.inject({ method: 'GET', url: '/tasks/c1/pull-requests' })).json().pull_requests).toHaveLength(1);
  });
  it('is 404 outside the scope', async () => {
    const { app } = buildApp(store, 'u1');
    expect((await app.inject({ method: 'GET', url: '/tasks/x9/pull-requests' })).statusCode).toBe(404);
  });
});
```

`CardPullRequests.test.tsx`:

```tsx
// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const listMock = vi.fn();
vi.mock('../lib/api', () => ({ api: { tasks: { pullRequests: (...a: unknown[]) => listMock(...a) } } }));

import { CardPullRequests } from './CardPullRequests';

afterEach(cleanup);

describe('CardPullRequests', () => {
  it('lists the card PRs', async () => {
    listMock.mockResolvedValue({ pull_requests: [{ number: 7, url: 'https://github.com/acme/app/pull/7', title: 'x', state: 'merged', draft: false, ci_state: 'passed', ci_summary: { total: 1, passed: 1, failed: 0, running: 0, failing: [] }, deploy_state: 'passed', deploy_url: 'https://github.com/acme/app/actions/runs/1' }] });
    render(<CardPullRequests taskId="t1" />);
    expect(await screen.findByRole('link', { name: /PR #7/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'deploy ok' })).toHaveAttribute('href', 'https://github.com/acme/app/actions/runs/1');
    expect(listMock).toHaveBeenCalledWith('t1');
  });
  it('renders nothing without PRs', async () => {
    listMock.mockResolvedValue({ pull_requests: [] });
    const { container } = render(<CardPullRequests taskId="t1" />);
    await vi.waitFor(() => expect(listMock).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });
});
```

- [ ] **Step 2: Run** `DOCKER 'npx -w @termhub/server vitest run src/routes/tasks.test.ts && npx -w @termhub/web vitest run src/components/CardPullRequests.test.tsx'` — Expected: FAIL.

- [ ] **Step 3: Implement**

`routes/tasks.ts`, in `taskRoutes`:

```ts
  app.get('/:id/pull-requests', async (request) => {
    const { id } = idParam.parse(request.params);
    const { task } = await scoped(repos, request).task(id);
    const rows = await repos.taskPullRequests.listByTasks([task.parent_id ?? task.id]);
    const pull_requests = rows.map(({ number, url, title, state, draft, ci_state, ci_summary, deploy_state, deploy_url }) => ({ number, url, title, state, draft, ci_state, ci_summary, deploy_state, deploy_url }));
    return { pull_requests };
  });
```

`api.ts`, in `tasks`: `pullRequests: (id: string) => request<{ pull_requests: PullRequestBadge[] }>('GET', `/tasks/${id}/pull-requests`),`.

`CardPullRequests.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import type { PullRequestBadge } from '../lib/types';
import { PullRequestBadges } from './ProgressPanel';

/** The card's pull requests with CI and deploy (spec 2026-09-26 progress-panel §5.6); nothing when it has none. */
export function CardPullRequests({ taskId }: { taskId: string }) {
  const [pulls, setPulls] = useState<PullRequestBadge[]>([]);
  useEffect(() => {
    let alive = true;
    api.tasks.pullRequests(taskId).then(
      (r) => alive && setPulls(r.pull_requests),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [taskId]);
  if (pulls.length === 0) return null;
  return (
    <div className="space-y-1">
      <h3 className="text-xs font-medium uppercase text-zinc-500">Pull requests</h3>
      <PullRequestBadges pulls={pulls} />
    </div>
  );
}
```

`TaskEditor.tsx`: render `<CardPullRequests taskId={task.id} />` below the subtask list for an existing card (not while creating). In `TaskEditor.test.tsx`, add `vi.mock('./CardPullRequests', () => ({ CardPullRequests: ({ taskId }: { taskId: string }) => <div>prs-{taskId}</div> }))` and assert `prs-<id>` appears when editing an existing card.

- [ ] **Step 4: Run** the tests of Step 2 plus `src/components/TaskEditor.test.tsx` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/routes apps/web/src
git commit -m "Cards: list their pull requests with CI and deploy"
```

---

### Task 10: Phone — PR badges and CI line

**Files:**
- Modify: `apps/mobile/src/services/api/contract/local.ts` (alias `TPullRequestBadge`), `apps/mobile/src/services/api/mock/handlers/progress.ts` (fixture), `apps/mobile/src/features/progress/model/format.ts` (+ test), `apps/mobile/src/features/progress/view/progress-screen.tsx` (+ test)

**Interfaces:**
- Consumes: contract of Task 7.
- Produces: `ciLabel`, `epicCiLine` in the app's `format.ts` (same copy as the web's, Task 8).

- [ ] **Step 1: Write the failing tests** — `format.test.ts`: the `ciLabel`/`epicCiLine` cases of Task 8 (jest globals). `progress-screen.test.tsx`:

```tsx
  it('shows the CI line and the PR badges of an expanded card', async () => {
    await render(<ProgressScreen />);
    expect(await screen.findByText('PRs: 1 aberto · 1 falhou', {}, LOAD)).toBeTruthy();
    fireEvent.press(screen.getByText('Visão gerencial'));
    expect(screen.getByText('PR #12 · CI falhou: lint')).toBeTruthy();
  });
```

In `mockProgress`, give card `c-183` `pull_requests: [{ number: 12, url: 'https://github.com/acme/app/pull/12', title: 'Painel', state: 'open', draft: false, ci_state: 'failed', ci_summary: { total: 2, passed: 1, failed: 1, running: 0, failing: ['lint'] }, deploy_state: 'none', deploy_url: null }]` and the epic `ci: { open: 1, failed: 1, running: 0, deployed: 0 }, ci_error: null`.

- [ ] **Step 2: Run** `DOCKER 'npm test -w @termhub/mobile -- src/features/progress'` — Expected: FAIL.

- [ ] **Step 3: Implement** — copy `ciLabel`/`epicCiLine` from the web's `lib/progress.ts` into `format.ts` (typed with `TPullRequestBadge`). In `progress-screen.tsx`, under the epic estimate: `{epic.ci && <Text className="text-xs text-zinc-400">{epicCiLine(epic.ci)}</Text>}` and `{epic.ci_error && <Text className="text-xs text-red-400">{epic.ci_error}</Text>}`; under each expanded card's agents:

```tsx
            {c.pull_requests.map((p) => (
              <Pressable key={p.number} onPress={() => void Linking.openURL(p.state === 'merged' && p.deploy_url ? p.deploy_url : p.url)}>
                <Text className="text-xs text-indigo-300">{`PR #${p.number} · ${ciLabel(p)}`}</Text>
              </Pressable>
            ))}
```

(`Linking` from `react-native`.)

- [ ] **Step 4: Run** the tests and `DOCKER 'npm run typecheck -w @termhub/mobile'` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile
git commit -m "App: show pull requests and CI in the Progresso tab"
```

---

### Task 11: Full verification and a live check

**Files:** none new.

- [ ] **Step 1: Suites** — `DOCKER 'npm test -w @termhub/server && npm test -w @termhub/web && npm test -w @termhub/mobile && npx -w @termhub/mobile-api vitest run'` → all PASS.
- [ ] **Step 2: CLAUDE.md gate + drift** — `DOCKER 'npm run typecheck -w @termhub/server && npm run build -w @termhub/web && npm run build -w @termhub/landing && npm run typecheck -w @termhub/mobile && cd apps/server && npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code'` → exit 0.
- [ ] **Step 3: Live GitHub check (read-only)** — with a token the user provides for this check (never commit or log it), run the client once against `engenhariainversa/termhub` from a throwaway script in the scratchpad: `listPulls` returns recent PRs with an ETag; a second call with that ETag returns `{ notModified: true }`; `listRuns` on a recent merge commit returns the "CI e Deploy" run, and `deployOf(runs, 'deploy.yml')` reads `passed`. If the user prefers not to hand a token, skip and say so in the hand-off.
- [ ] **Step 4: Clean up** — `rm -rf .npm`; `git status --short` shows only intended files; remove `th-ter183-db`/`th-ter183-net`.
- [ ] **Step 5: Hand-off note** — tell the user: set "Workflow de deploy" (`deploy.yml`) in the termhub project's Setup and make sure its GitHub integration token has *Pull requests: read* and *Actions: read*; after deploy, open a PR with `TER-xx` in the branch and watch the badge move from "CI rodando" to "CI verde", then "deploy rodando" → "deploy ok" after the merge (≈1 min lag, the poll interval).
