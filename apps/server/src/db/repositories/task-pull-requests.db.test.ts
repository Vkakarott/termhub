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
