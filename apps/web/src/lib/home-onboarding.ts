import type { Machine, Project, ProjectGroup, Tab } from './types';

/**
 * Where the account stands on Início, from data the app already holds: the three required steps
 * (a machine, a project, an open terminal) in order, then the regular dashboard.
 */
export type HomeStep = 'loading' | 1 | 2 | 3 | 'dashboard';

export function homeStep(input: {
  loading: boolean;
  machines: Machine[];
  projects: Project[];
  openTabs: Tab[];
  /** the list could not be read: its emptiness means nothing, so the step it decides is never shown */
  machinesFailed?: boolean;
  projectsFailed?: boolean;
  openTabsFailed?: boolean;
}): HomeStep {
  if (input.loading) return 'loading';
  if (input.machines.length === 0) return input.machinesFailed ? 'dashboard' : 1;
  if (input.projects.length === 0) return input.projectsFailed ? 'dashboard' : 2;
  if (input.openTabs.length === 0) return input.openTabsFailed ? 'dashboard' : 3;
  return 'dashboard';
}

/** The projects step 3 suggests: the ones not archived first, at most `max`. */
export function starterProjects(projects: Project[], max = 3): Project[] {
  const live = projects.filter((p) => p.status !== 'archived');
  return (live.length ? live : projects).slice(0, max);
}

export type NextStep =
  | { kind: 'hooks'; machines: Machine[] }
  | { kind: 'city'; hasNickname: boolean }
  | { kind: 'favorites' };

/** The optional steps still missing on the dashboard; an item leaves as soon as it is done. */
export function nextSteps(input: {
  machines: Machine[];
  projects: Project[];
  groups: ProjectGroup[];
  nickname: string | null;
  canUpdateMachines: boolean;
}): NextStep[] {
  const steps: NextStep[] = [];
  // `hooks_installed_at` is null when the server knows the hooks are missing; undefined (an older
  // server) says nothing, so it never counts as missing
  const noHooks = input.machines.filter((m) => m.type === 'agent' && m.hooks_installed_at === null);
  if (input.canUpdateMachines && noHooks.length) steps.push({ kind: 'hooks', machines: noHooks });
  if (!input.nickname || !input.projects.some((p) => p.is_public)) steps.push({ kind: 'city', hasNickname: !!input.nickname });
  // only when Favoritos is known to be empty: a group list that failed to load has no Favoritos at all
  const favorites = input.groups.find((g) => g.kind === 'favorites');
  if (favorites && favorites.project_ids.length === 0) steps.push({ kind: 'favorites' });
  return steps;
}

/**
 * "Dispensar" on the next-steps card, per user and per browser. Storage can be missing or throw
 * (private mode, blocked site data): reads then say "not dismissed" and writes are dropped.
 */
const dismissKey = (userId: string) => `termhub:home:next-steps-dismissed:${userId}`;

export function loadNextStepsDismissed(userId: string): boolean {
  try {
    return localStorage.getItem(dismissKey(userId)) === '1';
  } catch {
    return false;
  }
}

export function saveNextStepsDismissed(userId: string): void {
  try {
    localStorage.setItem(dismissKey(userId), '1');
  } catch {
    /* not persisted: the card stays hidden until the page reloads */
  }
}
