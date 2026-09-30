import type { Project } from '../db/repositories/types.js';
import type { ControlContext } from './context.js';

export interface GroupProject {
  id: string;
  key: string;
  name: string;
  status: string;
}

/** One of the person's own sidebar groups, as the concierge sees it. */
export interface GroupView {
  id: string;
  name: string;
  projects: GroupProject[];
}

/**
 * The person's sidebar groups for the concierge (spec 2026-09-30): the custom groups of the context's
 * own user, in sidebar order, each with the projects the scope can see, in the group's order.
 * Favoritos is not a group here: its visible members come apart, as `favorites`. Archived projects are
 * left out unless `archived` is set. A read only: it never creates the Favoritos row. A caller that
 * already listed the scope's projects passes them as `projects`, so they are not read twice.
 *
 * Groups are personal and projects belong to an owner, so the two reads take different ids — the same
 * rule as `routes/project-groups.ts`.
 */
export async function groupsOf(
  ctx: Pick<ControlContext, 'repos' | 'scope'>,
  opts: { archived?: boolean; projects?: readonly Pick<Project, 'id' | 'key' | 'name' | 'status'>[] } = {},
): Promise<{ groups: GroupView[]; favorites: Set<string> }> {
  const [rows, projects] = await Promise.all([ctx.repos.projectGroups.read(ctx.scope.user.id), opts.projects ?? ctx.repos.projects.list({ owner: ctx.scope.ownerId })]);
  const visible = new Map(projects.filter((p) => opts.archived || p.status !== 'archived').map((p) => [p.id, p]));
  const members = (ids: string[]): GroupProject[] =>
    ids.flatMap((id) => {
      const p = visible.get(id);
      return p ? [{ id: p.id, key: p.key, name: p.name, status: p.status }] : [];
    });
  const favorites = new Set(rows.filter((g) => g.kind === 'favorites').flatMap((g) => members(g.project_ids).map((p) => p.id)));
  const groups = rows.filter((g) => g.kind === 'custom').map((g) => ({ id: g.id, name: g.name, projects: members(g.project_ids) }));
  return { groups, favorites };
}

/** `list_project_groups`: the groups in sidebar order, without Favoritos and without "Outros". */
export async function listProjectGroups(ctx: ControlContext): Promise<{ groups: GroupView[] }> {
  return { groups: (await groupsOf(ctx)).groups };
}
