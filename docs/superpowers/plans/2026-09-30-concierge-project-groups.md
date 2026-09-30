# Concierge Project Groups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The concierge sees how the person groups their projects: in its tools, in the project chat's prompt and in the account-wide chat's prompt.

**Architecture:** One read of the sidebar groups, scoped to the user and to the projects they can see (`control/groups.ts`), feeds three tools (`list_projects`, `list_project_groups`, `find`) and two prompts. The repository gains a read that never writes. The account-wide index goes only to streamed runs.

**Tech Stack:** Fastify, Prisma, zod, vitest (`apps/server`).

**Spec:** `docs/superpowers/specs/2026-09-30-concierge-project-groups-design.md`. Read it before any task: sections 2, 3 and 4 are the rules and the exact texts.

## Global Constraints

- Code comments, identifiers, commit messages and pull request texts are in English. UI copy and error messages shown to the person stay in Portuguese (pt-BR). The prompts told to the model are in English, as they are today.
- Commit subject: imperative, at most 72 characters, prefixed by the area (`Concierge:`, `Chat:`, `Docs:`). A short body says why.
- Nothing of the person's content is logged: no group name, no project name. Log ids and a failure's label (`failureLabel(err)`).
- Routes never import Prisma. Every tool input is validated with zod.
- Groups are read for the context's own user (`ctx.scope.user.id`), projects for the scope's owner (`ctx.scope.ownerId`). A project outside the scope never appears, in a tool result or in a prompt.
- Favoritos is never a group for the concierge, and "Outros" does not exist for it.
- No database migration. No change in `apps/web`, `apps/mobile` nor `packages`.
- The error of an unknown group, verbatim: code `GROUP_NOT_FOUND`, message `Grupo não encontrado`.
- The texts of the two prompts are in section 4 of the spec, verbatim.
- In a pull request or commit text, never write close, fix or resolve (in any form) next to an issue number unless the issue must close. Cite with `Part of #170`.
- One commit per step that says "Commit". Never amend a commit that was already pushed.

### Running things on this machine (hulk, macOS)

```bash
export DATABASE_URL=postgresql://postgres:postgres@localhost:5432/termhub   # only parsed, no database is needed
npm test -w @termhub/server -- <paths>
npm run typecheck -w @termhub/server
```

- `grep` and `cat` are aliased in the interactive shell; in scripts use `/usr/bin/grep` and `/bin/cat`.
- There is no Postgres here. Tests named `*.db.test.ts` are skipped without `TERMHUB_DB_TESTS=1`; CI runs them. Write them with care: read the neighbouring cases of the same file for the helpers.
- **Known failures of the baseline on this machine, not caused by this plan:** three or four tests about `xlsx` and `docx` in `apps/server/src/chat/attachments`, and the codex case of `src/mcp/start-agent.e2e.test.ts`. They pass in CI. Do not touch them. Any other failure is yours.

---

### Task 1: The tools see the groups

**Files:**
- Modify: `apps/server/src/db/repositories/project-groups.ts`
- Test: `apps/server/src/db/repositories/project-groups.db.test.ts`
- Create: `apps/server/src/control/groups.ts`
- Test: `apps/server/src/control/groups.test.ts`
- Modify: `apps/server/src/control/inventory.ts`
- Test: `apps/server/src/control/inventory.test.ts`
- Modify: `apps/server/src/mcp/tools.ts`, `apps/server/src/chat/gate.ts`
- Test: `apps/server/src/mcp/route.test.ts`, the gate's test file that lists the read tools
- Modify: `README.md` (the paragraph "Tools available today")

**Interfaces:**
- Consumes: `ProjectGroupsRepository`, `ControlContext`, `normalizeName` of `inventory.ts`.
- Produces, for Task 2: `groupsOf(ctx, opts?)` and `GroupView` from `apps/server/src/control/groups.ts`; `ProjectGroupsRepository.read(userId)`.

- [ ] **Step 1: Write the failing database test of `read`**

In `apps/server/src/db/repositories/project-groups.db.test.ts`, with the file's own setup (its way of creating a user and of reading rows directly):

```ts
it('read answers the groups in sidebar order and never creates Favoritos', async () => {
  const userId = await newUser();               // the helper the file already uses
  expect(await repo.read(userId)).toEqual([]);
  expect(await db.projectGroup.count({ where: { userId } })).toBe(0);

  const a = await repo.create(userId, 'Triunfo');   // `create` makes Favoritos first
  const b = await repo.create(userId, 'Faculdade');
  const read = await repo.read(userId);
  expect(read.map((g) => g.name)).toEqual(['Favoritos', 'Triunfo', 'Faculdade']);
  expect(read.map((g) => g.kind)).toEqual(['favorites', 'custom', 'custom']);
  expect(read.map((g) => g.id).slice(1)).toEqual([a.id, b.id]);
  expect(await repo.list(userId)).toEqual(read);
});
```

Adapt the names of the helpers to the file. It cannot run here: CI runs it.

- [ ] **Step 2: Write `read`**

In `apps/server/src/db/repositories/project-groups.ts`, replace `list` by:

```ts
  /** The user's groups in sidebar order, Favoritos included when its row exists. Never writes: what a
   *  tool call or a prompt reads (`list` creates Favoritos on first use, which the sidebar wants). */
  async read(userId: string): Promise<ProjectGroup[]> {
    const rows = await this.db.projectGroup.findMany({ where: { userId }, orderBy: [{ position: 'asc' }, { createdAt: 'asc' }], include: INCLUDE });
    return rows.map(view);
  }

  async list(userId: string): Promise<ProjectGroup[]> {
    await this.ensureFavorites(userId);
    return this.read(userId);
  }
```

Run: `npm run typecheck -w @termhub/server`
Expected: PASS.

- [ ] **Step 3: Write the failing tests of `groupsOf`**

`apps/server/src/control/groups.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import type { ProjectGroup } from '../db/repositories/project-groups.js';
import type { ControlContext } from './context.js';
import { groupsOf, listProjectGroups } from './groups.js';

const project = (id: string, over: { name?: string; status?: string; owner_id?: string } = {}) => ({ id, key: id.toUpperCase(), name: over.name ?? id, status: over.status ?? 'active', owner_id: over.owner_id ?? 'u1' });
const projects = [project('p1', { name: 'notify' }), project('p2', { name: 'painel-triunfo' }), project('p3', { name: 'Velho', status: 'archived' }), project('p4', { name: 'Escreva+' }), project('px', { name: 'alheio', owner_id: 'u2' })];
const group = (id: string, name: string, project_ids: string[], kind: 'favorites' | 'custom' = 'custom', position = 0): ProjectGroup => ({ id, name, kind, position, project_ids });

function ctx(groups: ProjectGroup[], scope: { userId?: string; ownerId?: string } = {}): ControlContext {
  const userId = scope.userId ?? 'u1';
  const ownerId = scope.ownerId ?? userId;
  const read = vi.fn(async (id: string) => (id === 'u1' ? groups : []));
  const list = vi.fn(async (f: { owner?: string | null }) => projects.filter((p) => f.owner == null || p.owner_id === f.owner));
  return { repos: { projectGroups: { read }, projects: { list } }, scope: { user: { id: userId }, viewAs: { kind: 'self' }, ownerId, createAs: ownerId } } as unknown as ControlContext;
}

describe('groupsOf', () => {
  it('answers the custom groups in sidebar order, members in the group order, Favoritos apart', async () => {
    const c = ctx([group('gf', 'Favoritos', ['p4', 'p1'], 'favorites', 0), group('g1', 'Triunfo', ['p2', 'p1'], 'custom', 1), group('g2', 'Faculdade', ['p4'], 'custom', 2)]);
    const { groups, favorites } = await groupsOf(c);
    expect(groups).toEqual([
      { id: 'g1', name: 'Triunfo', projects: [{ id: 'p2', key: 'P2', name: 'painel-triunfo', status: 'active' }, { id: 'p1', key: 'P1', name: 'notify', status: 'active' }] },
      { id: 'g2', name: 'Faculdade', projects: [{ id: 'p4', key: 'P4', name: 'Escreva+', status: 'active' }] },
    ]);
    expect([...favorites].sort()).toEqual(['p1', 'p4']);
  });

  it('leaves out a project outside the scope and an archived one', async () => {
    const { groups, favorites } = await groupsOf(ctx([group('gf', 'Favoritos', ['px', 'p3'], 'favorites'), group('g1', 'Triunfo', ['px', 'p3', 'p1'])]));
    expect(groups[0].projects.map((p) => p.id)).toEqual(['p1']);
    expect(favorites.size).toBe(0);
  });

  it('keeps archived members when asked to', async () => {
    const { groups, favorites } = await groupsOf(ctx([group('gf', 'Favoritos', ['p3'], 'favorites'), group('g1', 'Triunfo', ['p3', 'p1'])]), { archived: true });
    expect(groups[0].projects.map((p) => p.id)).toEqual(['p3', 'p1']);
    expect([...favorites]).toEqual(['p3']);
  });

  it('lists a group with no visible project, empty: it exists in the sidebar', async () => {
    expect((await groupsOf(ctx([group('g1', 'Vazio', []), group('g2', 'Só alheio', ['px'])]))).groups).toEqual([
      { id: 'g1', name: 'Vazio', projects: [] },
      { id: 'g2', name: 'Só alheio', projects: [] },
    ]);
  });

  it('reads the groups of the user and the projects of the scope', async () => {
    const c = ctx([group('g1', 'Triunfo', ['p1'])], { userId: 'u1', ownerId: 'u2' });
    const { groups } = await groupsOf(c);
    expect(c.repos.projectGroups.read).toHaveBeenCalledWith('u1');
    expect(c.repos.projects.list).toHaveBeenCalledWith({ owner: 'u2' });
    // p1 is not a project of u2: the group is there, its member is not.
    expect(groups).toEqual([{ id: 'g1', name: 'Triunfo', projects: [] }]);
  });
});

describe('listProjectGroups', () => {
  it('answers the groups, and nothing about favourites', async () => {
    expect(await listProjectGroups(ctx([group('gf', 'Favoritos', ['p1'], 'favorites'), group('g1', 'Triunfo', ['p1'])]))).toEqual({
      groups: [{ id: 'g1', name: 'Triunfo', projects: [{ id: 'p1', key: 'P1', name: 'notify', status: 'active' }] }],
    });
  });
});
```

Run: `npm test -w @termhub/server -- src/control/groups.test.ts`
Expected: FAIL, the module does not exist.

- [ ] **Step 4: Write `control/groups.ts`**

```ts
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
 * left out unless `archived` is set. A read only: it never creates the Favoritos row.
 *
 * Groups are personal and projects belong to an owner, so the two reads take different ids — the same
 * rule as `routes/project-groups.ts`.
 */
export async function groupsOf(ctx: Pick<ControlContext, 'repos' | 'scope'>, opts: { archived?: boolean } = {}): Promise<{ groups: GroupView[]; favorites: Set<string> }> {
  const [rows, projects] = await Promise.all([ctx.repos.projectGroups.read(ctx.scope.user.id), ctx.repos.projects.list({ owner: ctx.scope.ownerId })]);
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
```

Run: `npm test -w @termhub/server -- src/control/groups.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing tests of `list_projects` and `find`**

In `apps/server/src/control/inventory.test.ts`: the `repos` of `ctx()` gains `projectGroups: { read: vi.fn(async (userId: string) => (userId === 'u1' ? groups : [])) }`, with a module-level

```ts
const groups: ProjectGroup[] = [
  { id: 'gf', name: 'Favoritos', kind: 'favorites', position: 0, project_ids: ['p2'] },
  { id: 'g1', name: 'Comunidade', kind: 'custom', position: 1, project_ids: ['p1', 'p3', 'px'] },
  { id: 'g2', name: 'Pessoal', kind: 'custom', position: 2, project_ids: ['p2'] },
  { id: 'g3', name: 'pessoal', kind: 'custom', position: 3, project_ids: ['p1'] },
];
```

Cases:

```ts
describe('listProjects and the groups', () => {
  it('carries the groups of each project and whether it is a favourite', async () => {
    const { projects } = await listProjects(ctx(), {});
    const byId = Object.fromEntries(projects.map((p) => [p.id, p]));
    expect(byId.p1.groups).toEqual([{ id: 'g1', name: 'Comunidade' }, { id: 'g3', name: 'pessoal' }]);
    expect(byId.p1.favorite).toBe(false);
    expect(byId.p2.groups).toEqual([{ id: 'g2', name: 'Pessoal' }]);
    expect(byId.p2.favorite).toBe(true);
  });

  it('an archived project keeps its groups when it is asked for', async () => {
    const { projects } = await listProjects(ctx(), { include_archived: true });
    expect(projects.find((p) => p.id === 'p3')!.groups).toEqual([{ id: 'g1', name: 'Comunidade' }]);
  });

  it('keeps only the projects of a group, by id', async () => {
    expect((await listProjects(ctx(), { group: 'g1' })).projects.map((p) => p.id)).toEqual(['p1']);
  });

  it('matches a group by name without case or accents, and two groups of one name both count', async () => {
    expect((await listProjects(ctx(), { group: 'COMUNIDADE' })).projects.map((p) => p.id)).toEqual(['p1']);
    expect((await listProjects(ctx(), { group: 'pessoal' })).projects.map((p) => p.id).sort()).toEqual(['p1', 'p2']);
  });

  it('refuses a group that does not exist, Favoritos included', async () => {
    await expect(listProjects(ctx(), { group: 'Triunfo' })).rejects.toMatchObject({ code: 'GROUP_NOT_FOUND', message: 'Grupo não encontrado' });
    await expect(listProjects(ctx(), { group: 'Favoritos' })).rejects.toMatchObject({ code: 'GROUP_NOT_FOUND' });
    await expect(listProjects(ctx(), { group: 'gf' })).rejects.toMatchObject({ code: 'GROUP_NOT_FOUND' });
  });
});

describe('find and the groups', () => {
  it('resolves a group by name, among the default kinds', async () => {
    const { matches } = await find(ctx(), { query: 'comunidade' });
    expect(matches).toContainEqual({ kind: 'group', id: 'g1', name: 'Comunidade', machine_id: null, machine_name: null, score: 3 });
  });

  it('only groups when asked for groups, and never Favoritos', async () => {
    expect((await find(ctx(), { query: 'pessoal', kinds: ['group'] })).matches.map((m) => m.id).sort()).toEqual(['g2', 'g3']);
    expect((await find(ctx(), { query: 'favoritos', kinds: ['group'] })).matches).toEqual([]);
  });

  it('needs the grant to read projects', async () => {
    expect((await find(ctx(['machines:read']), { query: 'comunidade' })).matches.filter((m) => m.kind === 'group')).toEqual([]);
  });
});
```

Existing cases of `listProjects` that compare whole project objects gain `groups` and `favorite` in what they expect.

Run: `npm test -w @termhub/server -- src/control/inventory.test.ts`
Expected: the new tests FAIL.

- [ ] **Step 6: Change `listProjects` and `find`**

In `apps/server/src/control/inventory.ts`:

```ts
import { groupsOf, type GroupView } from './groups.js';

/** The groups `wanted` names: by id first, then by name without case or accents (two groups of one
 *  name both count). None is a refusal: an empty list would read as "the group has no projects". */
function groupsNamed(groups: GroupView[], wanted: string): GroupView[] {
  const byId = groups.filter((g) => g.id === wanted);
  if (byId.length) return byId;
  const name = normalizeName(wanted);
  const byName = groups.filter((g) => normalizeName(g.name) === name);
  if (!byName.length) throw new ControlError('GROUP_NOT_FOUND', 'Grupo não encontrado');
  return byName;
}

export async function listProjects(ctx: ControlContext, input: { machine_id?: string; include_archived?: boolean; group?: string }) {
  if (input.machine_id) await ctx.scoped.machine(input.machine_id);
  const [projects, names, { groups, favorites }] = await Promise.all([
    ctx.repos.projects.list({ machine_id: input.machine_id, owner: ctx.scope.ownerId }),
    machineNames(ctx),
    // Archived members too: `include_archived` decides below, as for every other project.
    groupsOf(ctx, { archived: true }),
  ]);
  const only = input.group === undefined ? null : new Set(groupsNamed(groups, input.group).flatMap((g) => g.projects.map((p) => p.id)));
  const links = await ctx.repos.projectMachines.listByProjects(projects.map((p) => p.id));
  return {
    projects: projects
      .filter((p) => (input.include_archived || p.status !== 'archived') && (only === null || only.has(p.id)))
      .map((p) => ({
        id: p.id,
        key: p.key,
        name: p.name,
        status: p.status,
        description: p.description,
        // The person's own sidebar groups (spec 2026-09-30); Favoritos is a pin, not a group.
        groups: groups.filter((g) => g.projects.some((m) => m.id === p.id)).map((g) => ({ id: g.id, name: g.name })),
        favorite: favorites.has(p.id),
        machines: links.filter((l) => l.project_id === p.id).map((l) => ({ machine_id: l.machine_id, machine_name: names.get(l.machine_id) ?? null, cwd: l.cwd })),
      })),
  };
}
```

`normalizeName` is declared below `listProjects` in the file as a function declaration: it is hoisted, no move is needed.

In `find`: `FindKind` gains `'group'`; the default kinds become `['machine', 'project', 'ai_account', 'task', 'group']`; after the projects line:

```ts
  if (kinds.has('group') && canProjects) for (const g of (await groupsOf(ctx)).groups) add('group', g.id, g.name, null);
```

Update the comment of `find` ("… and the person's own project groups").

Run: `npm test -w @termhub/server -- src/control && npm run typecheck -w @termhub/server`
Expected: PASS.

- [ ] **Step 7: Register the tools**

In `apps/server/src/mcp/tools.ts`:

1. Import `listProjectGroups` from `'../control/groups.js'`.
2. `list_projects`: the input gains `group: z.string().trim().min(1).max(64).optional()`, the cast of `run` gains `group?: string`, and the description becomes:

```
List projects: id, key (used in card numbers and URLs), name, status, the person's own sidebar groups each one is in (groups: [{ id, name }]; favorite: true when pinned in Favoritos) and the machines each one is linked to with the working directory on each. Archived ones are hidden unless include_archived; machine_id keeps only projects linked to that machine; group (a group's id or name) keeps only the projects of that group.
```

3. A new tool right after `list_projects`:

```ts
  {
    name: 'list_project_groups',
    description:
      "List the person's own sidebar groups, in sidebar order, each with its projects (id, key, name, status). A group is how the person thinks of the work: projects of one group are related. Favoritos is not a group (see favorite in list_projects) and projects in no group are not listed here. Archived projects are left out.",
    scope: 'read', resource: 'projects', action: 'read', input: {},
    run: (ctx) => listProjectGroups(ctx),
  },
```

4. `find`: the enum of `kinds` and the cast of `run` gain `'group'`; the description says "across machines, projects (name or key), the person's project groups, AI accounts and cards…".

In `apps/server/src/chat/gate.ts`, `readTools` gains `'list_project_groups'` right after `'list_projects'`.

In `apps/server/src/mcp/route.test.ts`, the exact list of the first test of `POST /mcp tools` gains `'list_project_groups'` in its sorted place. Look for any other exact list of tool names in the tests of `apps/server/src/mcp` and `apps/server/src/chat` (the gate's classification tests, the concierge token's tool list) and add the tool there too. The token of a tab (`TAB_TOKEN_TOOLS`) does not get it.

In `README.md`, the paragraph "Tools available today": `list_projects` also says "the person's sidebar groups (`groups`, `favorite`; `group` filters by a group's id or name)", `list_project_groups` is added after it ("the person's own sidebar groups in order, each with its projects; Favoritos and ungrouped projects are not groups"), and `find` says it also resolves project groups.

Run: `npm test -w @termhub/server -- src/mcp src/chat src/control && npm run typecheck -w @termhub/server`
Expected: PASS, except the known failures.

- [ ] **Step 8: Commit**

```bash
git add apps/server/src README.md
git commit -m "Concierge: the tools see the person's project groups" -m "The concierge guessed how projects group from their folders. list_projects now carries each project's sidebar groups and takes a group, list_project_groups lists them in order, and find resolves a group by name. A read never creates the Favoritos row."
```

---

### Task 2: The chats are told the groups

**Files:**
- Modify: `apps/server/src/chat/project-prompt.ts`
- Test: `apps/server/src/chat/project-prompt.test.ts`
- Modify: `apps/server/src/chat/service.ts` (`promptFor`, the three places a streamed run starts)
- Test: `apps/server/src/chat/service.test.ts`
- Modify: `docs/superpowers/plans/2026-09-29-chat-and-machine-agent-roadmap.md` (Front 5)

**Interfaces:**
- Consumes: `groupsOf(ctx, opts?)` and `GroupView` of Task 1.
- Produces: nothing other tasks use.

- [ ] **Step 1: Write the failing tests of the prompts**

In `apps/server/src/chat/project-prompt.test.ts`:

```ts
import { accountSystemPrompt, projectSystemPrompt } from './project-prompt.js';

const p = { name: 'notify', key: 'NOT' };
const links = [{ machine: 'jarvis', cwd: '/srv/notify' }];

describe('the groups line of a project chat', () => {
  it('names the group and its sibling projects, after the machines', () => {
    const text = projectSystemPrompt(p, links, [], [{ name: 'Triunfo', siblings: ['painel-triunfo', 'speedbike-app'] }]);
    expect(text).toContain('Its machines and directories: jarvis → /srv/notify\nIts groups in the person\'s sidebar: "Triunfo" (with "painel-triunfo", "speedbike-app").');
  });

  it('lists several groups, and says when a group has no other project', () => {
    const text = projectSystemPrompt(p, links, [], [{ name: 'Triunfo', siblings: ['painel-triunfo'] }, { name: 'Clientes', siblings: [] }]);
    expect(text).toContain('Its groups in the person\'s sidebar: "Triunfo" (with "painel-triunfo"); "Clientes" (no other project).');
  });

  it('says nothing for a project in no group', () => {
    expect(projectSystemPrompt(p, links, [], [])).not.toContain('Its groups');
    expect(projectSystemPrompt(p, links)).toBe(projectSystemPrompt(p, links, [], []));
  });

  it('cuts a long list at 600 characters, and the whole prompt stays within 4000', () => {
    const siblings = Array.from({ length: 200 }, (_, i) => `projeto-com-nome-comprido-${i}`);
    const manyLinks = Array.from({ length: 200 }, (_, i) => ({ machine: `maquina-${i}`, cwd: `/srv/um/caminho/bem/comprido/${i}` }));
    const text = projectSystemPrompt(p, manyLinks, ['board'], [{ name: 'Triunfo', siblings }]);
    const line = text.split('\n').find((l) => l.startsWith('Its groups'))!;
    expect(line.length).toBeLessThanOrEqual('Its groups in the person\'s sidebar: '.length + 600 + 1);
    expect(line).toContain('…');
    expect(text.length).toBeLessThanOrEqual(4000);
    expect(text).toContain('Keep answers short unless asked for detail.');
  });

  it('a name with a line break stays on its line', () => {
    const text = projectSystemPrompt(p, links, [], [{ name: 'Tri\nunfo', siblings: ['a\n\nb'] }]);
    expect(text).toContain('"Tri unfo" (with "a b")');
  });
});

describe('the index of the account-wide chat', () => {
  it('lists the groups and their projects, and points to the tool', () => {
    expect(accountSystemPrompt([{ name: 'Triunfo', projects: ['notify', 'painel-triunfo'] }, { name: 'Faculdade', projects: ['Escreva+'] }])).toBe(
      'The person groups their projects in the sidebar like this. A group is how they think of the work: projects of one group are related.\n' +
        '- "Triunfo": "notify", "painel-triunfo"\n' +
        '- "Faculdade": "Escreva+"\n' +
        'Use list_project_groups for ids and status, and list_projects with group to work on one group.',
    );
  });

  it('leaves out a group with no project, and answers null when nothing is left', () => {
    expect(accountSystemPrompt([{ name: 'Vazio', projects: [] }, { name: 'Triunfo', projects: ['notify'] }])).not.toContain('Vazio');
    expect(accountSystemPrompt([{ name: 'Vazio', projects: [] }])).toBeNull();
    expect(accountSystemPrompt([])).toBeNull();
  });

  it('stays within 4000 characters and keeps the pointer to the tool', () => {
    const groups = Array.from({ length: 50 }, (_, g) => ({ name: `grupo-${g}`, projects: Array.from({ length: 40 }, (_, i) => `projeto-${g}-${i}`) }));
    const text = accountSystemPrompt(groups)!;
    expect(text.length).toBeLessThanOrEqual(4000);
    expect(text).toContain('…');
    expect(text.endsWith('Use list_project_groups for ids and status, and list_projects with group to work on one group.')).toBe(true);
  });
});
```

If `'board'` is not a member of `STANDING_GRANT_KINDS`, use its first member.

Run: `npm test -w @termhub/server -- src/chat/project-prompt.test.ts`
Expected: FAIL.

- [ ] **Step 2: Write the prompts**

In `apps/server/src/chat/project-prompt.ts`:

```ts
/** The most the groups line of a project chat takes of the prompt: room for about forty names. */
const GROUPS_MAX = 600;

/** A group of the project, for its chat: the group's name and the other projects in it. */
export interface PromptGroup {
  name: string;
  siblings: string[];
}

/** A name as it goes into a prompt: one line, quoted. It is the person's own text. */
const quoted = (s: string): string => `"${s.replace(/\s+/g, ' ').trim()}"`;
const cut = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** The line telling the model which sidebar groups the project is in and what else is in them, or ''. */
const groupsLine = (groups: PromptGroup[]): string => {
  if (!groups.length) return '';
  const parts = groups.map((g) => `${quoted(g.name)} (${g.siblings.length ? `with ${g.siblings.map(quoted).join(', ')}` : 'no other project'})`);
  return `\nIts groups in the person's sidebar: ${cut(parts.join('; '), GROUPS_MAX)}.`;
};
```

`projectSystemPrompt` gains the fourth parameter `groups: PromptGroup[] = []`; `const groupLine = groupsLine(groups);`; `room` also subtracts `groupLine.length`; the return becomes `` `${head}Its machines and directories: ${list}${groupLine}${standingLine}${tail}` ``. Its comment says the groups line counts against the same budget.

And, at the end of the file:

```ts
const INDEX_HEAD = 'The person groups their projects in the sidebar like this. A group is how they think of the work: projects of one group are related.\n';
const INDEX_TAIL = '\nUse list_project_groups for ids and status, and list_projects with group to work on one group.';

/**
 * What the account-wide chat is told about the person's projects (spec 2026-09-30 §4): a short index,
 * groups and their projects by name. Names only — ids, status and the rest are `list_project_groups`'
 * business. Null when there is no group with a project: then the chat is told nothing, as before.
 */
export function accountSystemPrompt(groups: { name: string; projects: string[] }[]): string | null {
  const lines = groups.filter((g) => g.projects.length > 0).map((g) => `- ${quoted(g.name)}: ${g.projects.map(quoted).join(', ')}`);
  if (!lines.length) return null;
  return `${INDEX_HEAD}${cut(lines.join('\n'), MAX - INDEX_HEAD.length - INDEX_TAIL.length)}${INDEX_TAIL}`;
}
```

Run: `npm test -w @termhub/server -- src/chat/project-prompt.test.ts`
Expected: PASS.

- [ ] **Step 3: Write the failing tests of the service**

In `apps/server/src/chat/service.test.ts`. The `repos` of `build` gains `projectGroups: { read: vi.fn(async (userId: string) => (userId === user.id ? groupRows : [])) }` and `projects.list: vi.fn(async (f: { owner?: string | null }) => (f.owner === user.id ? projectRows : []))`, where `groupRows` and `projectRows` come from a new option of `build` (`groups?: ProjectGroup[]`, `projects?: ...`) and default to `[]` and to `[project]` (the `p1` the harness already has). Return `projectGroups` from `build` so a test can change what it answers.

Cases, next to the tests that read `append_system_prompt`:

1. `a project chat is told its group and the sibling projects`: groups `[{ id: 'g1', name: 'Triunfo', kind: 'custom', position: 0, project_ids: ['p1', 'p2'] }]`, projects `p1` (`app`) and `p2` (`painel`); a message in project `p1`; the run's `append_system_prompt` contains `Its groups in the person's sidebar: "Triunfo" (with "painel").`.
2. `moving the project to another group changes the next run`: after the first run, `projectGroups.read` answers the project in `Faculdade`; the second run's prompt names `Faculdade` and not `Triunfo`.
3. `the account-wide chat gets the index on a streamed host`: `streaming: true`, a message in the account-wide chat; the prompt starts with the orchestrator's rules and contains `- "Triunfo": "app", "painel"`.
4. `the account-wide chat gets no prompt on a one-shot host, groups or not`: the same groups, no `streaming`; `append_system_prompt ?? null` is null. The three existing tests that pin this stay as they are.
5. `a failed read of the groups costs the groups, not the message`: `projectGroups.read.mockRejectedValue(new Error('down'))`; the project chat's run starts, its prompt has no groups line; the account-wide streamed run starts with the orchestrator's rules only. Spy on `console.error` and expect no group or project name in what was logged.
6. `another user's groups never appear`: `projectGroups.read` answers groups only for another id; the prompts carry none.
7. `a queued message and a resumed run carry the index too`: a streamed account-wide run started by `launchQueued` (a message queued behind a run that ended its input), and one started by `resumeSweep`; both prompts contain the index. Use the neighbouring tests of the queue and of the resume as the model.

Run: `npm test -w @termhub/server -- src/chat/service.test.ts`
Expected: the new tests FAIL.

- [ ] **Step 4: Tell the chats**

In `apps/server/src/chat/service.ts`:

1. Imports: `groupsOf`, `type GroupView` from `'../control/groups.js'`; `accountSystemPrompt` from `'./project-prompt.js'`.
2. Two private methods, right before `promptFor`:

```ts
  /** The person's sidebar groups, for a prompt (spec 2026-09-30). The user's own scope, never "view
   *  as". A failure costs the groups, never the message: logged by its label, no name in it. */
  private async groupsFor(user: User): Promise<GroupView[]> {
    try {
      return (await groupsOf({ repos: this.deps.repos, scope: { user, viewAs: { kind: 'self' }, ownerId: user.id, createAs: user.id } })).groups;
    } catch (err) {
      console.error('chat: the project groups could not be read', { user_id: user.id, error: failureLabel(err) });
      return [];
    }
  }

  /** The index of the account-wide chat, for a streamed run only: the one-shot path sends the
   *  account-wide chat no prompt at all. Null for a project chat, whose prompt is `promptFor`'s. */
  private async accountIndexFor(user: User, conversation: ChatConversation, machineId: string): Promise<string | null> {
    if (conversation.project_id !== null || !this.streams(machineId)) return null;
    return accountSystemPrompt((await this.groupsFor(user)).map((g) => ({ name: g.name, projects: g.projects.map((p) => p.name) })));
  }
```

3. `promptFor`, before its `return`:

```ts
    const groups = (await this.groupsFor(user))
      .filter((g) => g.projects.some((m) => m.id === project.id))
      .map((g) => ({ name: g.name, siblings: g.projects.filter((m) => m.id !== project.id).map((m) => m.name) }));
```

   and `groups` as the fourth argument of `projectSystemPrompt`.

4. The three places a streamed run starts. In each, right after `const appendSystemPrompt = await this.promptFor(user, conversation);`, add

```ts
    const accountIndex = await this.accountIndexFor(user, conversation, host.machine.id);
```

   and pass `streamedSystemPrompt(appendSystemPrompt ?? accountIndex)` to `runLive`. In `startNow` both reads stay **before** the busy check and the lock, where `promptFor` already is: an `await` between the check and `running.add` would let a second message start a second run. The one-shot calls of `finishRun` keep receiving `appendSystemPrompt`.

Run: `npm test -w @termhub/server -- src/chat src/control src/mcp src/routes && npm run typecheck -w @termhub/server`
Expected: PASS, except the known failures.

- [ ] **Step 5: Update the roadmap**

In `docs/superpowers/plans/2026-09-29-chat-and-machine-agent-roadmap.md`, Front 5: tick its items, name this plan and its spec, and record what was left out on purpose (the sidebar's wording, the index on the one-shot path).

- [ ] **Step 6: Commit**

```bash
git add apps/server/src docs/superpowers/plans/2026-09-29-chat-and-machine-agent-roadmap.md
git commit -m "Chat: tell the concierge how the person groups their projects" -m "A project chat is told its sidebar groups and the projects that share them, and the account-wide chat gets a short index on the streamed path. Moving a project between groups reaches the very next run. A failed read costs the groups, never the message."
```
