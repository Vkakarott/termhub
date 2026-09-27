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
