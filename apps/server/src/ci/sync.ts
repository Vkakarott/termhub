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
