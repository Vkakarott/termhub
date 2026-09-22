# Projects decoupled from machines — design

Date: 2026-09-22. Status: **approved design, not implemented.** First of two specs; the second
(task hierarchy, backlog, custom kanban columns, card URLs) builds on this one and is written
after it.

## 1. Goal

Today a project is a child of a machine: `projects.machine_id` + `projects.cwd`. Deleting a
machine from the sidebar cascades into its projects and takes tasks, notes, tickets and setup with
it. That is the immediate problem. The longer goal is sharing a project's board with other users
who run the work on their own computers, which is impossible while a project belongs to one
machine.

After this change:

- A project belongs to a user, not to a machine. Deleting a machine keeps the project and
  everything under it; only the machine link and its terminal tabs go.
- A project can be linked to zero or more machines, each with its own working directory. A tab
  runs on one of those machines.
- Every project has a short key (`HUB`, `TERMHUB`), unique across the whole instance, validated at
  creation. The second spec numbers cards with it (`TERMHUB-42`) and uses it in URLs.
- Everything that works today (terminals, tasks, notes, tickets, Office, MCP tools, agent
  registry) keeps working through the new relations.

Out of scope, deliberately: sharing itself (a `project_members` table comes later and does not
change this model), task changes (second spec), URL changes (second spec).

Data compatibility with the previous release is **not** required for this migration: the owner
confirmed the three tasks in production can be discarded. The migration still keeps projects,
machines and tabs, because it is cheap to do so.

## 2. Data model

### `projects`

| column | change |
|---|---|
| `machine_id`, `cwd` | **removed** |
| `owner_id` | new, FK `users.id`, `SetNull` (an orphan project after its owner is deleted, like `machines.owner_id`) |
| `key` | new, `String @unique`. 2–10 chars, `^[A-Z][A-Z0-9]{1,9}$` |
| `next_task_number` | new, `Int @default(1)`. Reserved for the second spec's card numbering; unused here |

Index on `owner_id`.

### `project_machines` (new)

| column | |
|---|---|
| `id` | String id |
| `project_id` | FK `projects.id`, Cascade |
| `machine_id` | FK `machines.id`, Cascade |
| `cwd` | absolute path on that machine (same validation as today's `projects.cwd`) |
| `position` | Int, order in the project's machine list |
| `created_at` | |

Unique `(project_id, machine_id)`. Index on `machine_id`.

Deleting a machine cascades its links and (through `tabs.machine_id`) its tabs. Deleting a project
cascades its links.

### `tabs`

- `machine_id`: new, FK `machines.id`, **required**, Cascade. A tab is a tmux session on one
  machine; the project alone no longer says which.
- Index on `machine_id`.

The `cwd` of a new tab is read from the `project_machines` row at open time and is not stored on
the tab (as today).

### Unchanged

`tasks`, `notes`, `tickets`, `project_setups` stay children of the project. `chat_conversations.
machine_id` is the machine's "terminal geral" and is unrelated to projects.

## 3. Ownership and scoping (`apps/server/src/auth/scope.ts`)

- `Scoped.project(id)` checks `project.owner_id` against the scope and returns `{ project }` only.
  Callers that today destructure `machine` from it change to one of:
  - `Scoped.projectMachine(projectId, machineId)` → `{ project, machine, link }`. 404 unless the
    project is in scope, the machine is in scope and the link exists.
  - `Scoped.projectMachines(projectId)` → `{ project, machines: Array<{ machine, link }> }` for
    callers that act on every linked machine (delete project, list tabs).
- `Scoped.tab(id)` resolves the machine through `tab.machine_id` and returns
  `{ tab, project, machine }` as today.
- Machine ownership stays as it is. Linking requires both the project and the machine to be in
  scope, so a user cannot attach someone else's machine to their project.
- Repositories that filter tabs by owner (`findByIdsForOwner`, `listWithState`,
  `countsByMachine`, `countBusyByMachine`, `findByTmuxSession`) switch from
  `project.machine.ownerId` / `project.machineId` to `machine.ownerId` / `machineId` on the tab.
- `ProjectsRepository.list({ owner })` and `findByIdsForOwner` filter on `ownerId` directly.
  `list({ machine_id })` filters through `machines: { some: { machineId } }`.

Rows created in a request take `scope.createAs` as `owner_id`, like machines do.

## 4. Repositories

- `ProjectsRepository`: `create` takes `{ owner_id, key, name, description? }`; `update` no longer
  accepts `cwd`; `key` is never updatable. New `isKeyAvailable(key)`.
- New `ProjectMachinesRepository` (`apps/server/src/db/repositories/project-machines.ts`):
  `listByProject`, `listByMachine`, `find(projectId, machineId)`, `link({ project_id, machine_id,
  cwd })`, `updateCwd`, `unlink(projectId, machineId)`, `reorder`.
- `TabsRepository.create(projectId, machineId, name, opts)`.
- Types in `types.ts`: `Project` gains `owner_id`, `key`, `next_task_number`, loses `machine_id`,
  `cwd`. New `ProjectMachine { id, project_id, machine_id, cwd, position, created_at }`. `Tab`
  gains `machine_id`.

## 5. API

Under `guarded('projects', …)` unless noted.

### Projects

- `GET /projects` — each project now carries `machines: Array<{ machine_id, cwd, position }>`.
  Optional `?machine_id=` keeps filtering.
- `GET /projects/:id` — same shape.
- `GET /projects/key-available?key=HUB` — `{ available: boolean, reason?: 'invalid' | 'taken' }`.
  Used live by the create form.
- `POST /projects` — body `{ name, key, description?, status?, machine_id?, cwd?, create_dir? }`.
  `machine_id` and `cwd` must come together; when present the project is created already linked
  (today's one-step flow). Invalid or taken `key` → 400 with a pt-BR message.
- `PATCH /projects/:id` — `name`, `description`, `status`. `key` and `cwd` are rejected.
- `DELETE /projects/:id` — kills the tmux sessions of its tabs on **every** linked machine, then
  deletes (cascade).

### Project machines

- `GET /projects/:id/machines` — `Array<{ machine_id, cwd, position, machine: { id, name, type,
  online } }>`.
- `POST /projects/:id/machines` — `{ machine_id, cwd, create_dir? }`. Directory checked/created
  with `ensureDirectory` as today. 409 if already linked.
- `PATCH /projects/:id/machines/:machineId` — `{ cwd, create_dir? }` or `{ position }`.
- `DELETE /projects/:id/machines/:machineId` — closes that machine's tabs of this project (kill
  tmux, delete rows) and removes the link. Response `{ closed_tabs: number }`. No blocking; the
  UI confirms with the count first.

### Tabs

- `GET /projects/:id/tabs` — each tab carries `machine_id`. The tmux alive check runs once per
  linked machine; a machine that is down marks only its own tabs as not alive.
- `POST /projects/:id/tabs` — body gains `machine_id`, optional. Rules: one linked machine → it
  is used; several → required (400 "Escolha a máquina"); none → 400 "Vincule uma máquina ao
  projeto". The simulator capability check runs against the chosen machine.

### Other routes touched

- `routes/office.ts`, `office/snapshot.ts`: rooms are per `(machine, project)` link, people per
  tab placed by `tab.machine_id`. A project linked to two machines has a room on each block.
- `routes/dashboard.ts`, `control/inventory.ts`: group by project through links.
- `routes/hooks.ts`, `agent/registry.ts`, `agent/ws.ts`, `agent/connection.ts`: tab lookup by
  tmux session filters by `tabs.machine_id`.
- `simulator/session-manager.ts`: machine from `tab.machine_id`.
- `control/agents.ts` (`start_agent`): machine from the chosen link, see MCP.
- `setup/tickets-sync.ts`: unchanged (project-level).

## 6. MCP tools (`apps/server/src/mcp/tools.ts`)

- `list_projects`: description becomes "List projects: key, name, and the machines it is linked
  to with the working directory on each". Output gains `key` and `machines: [{ machine_id, cwd }]`.
  `machine_id` filter kept.
- `open_tab`, `start_agent`: input gains `machine_id` (optional) with the same resolution rule as
  the route. The error text tells the agent to pass one when the project has several.
- `list_tabs`: `machine_id` filter uses `tabs.machine_id`.
- `find`: also matches project keys.
- Task tools: unchanged.

## 7. Frontend (`apps/web`)

### State (`lib/data.tsx`)

`projects` is loaded as a top-level list (`GET /projects`), each with `machines`. `machines` stays
as today. Helpers: `projectsOfMachine(machineId)`, `machinesOfProject(projectId)`.

### Sidebar

Two sections: **Projetos** on top (key, name, open-task count), **Máquinas** below (status only;
no project tree under a machine). Selecting a project keeps today's routes `/projects/:id/...`.

### Create project (modal)

Fields: nome, chave (auto-suggested from the name: initials of the words, or the first letters
of a single word, uppercased; editable; availability checked with a debounced call to
`key-available`, showing "disponível" / "já em uso" / "formato inválido"), descrição, and an
optional block **Máquina** with the machine select and the existing `DirectoryBrowser`. Submit
without a machine creates a project with board and notes only.

### Project settings (`ProjectSettings.tsx`)

New block **Máquinas**: the list of links (machine name, status, cwd), "Vincular máquina"
(select + `DirectoryBrowser`), edit cwd, and "Desvincular" with a confirm that states how many
tabs will close. The key is shown read-only.

### Terminals tab

- One linked machine: "Novo terminal" opens directly.
- Several: the button is a dropdown listing the machines; the last used one is preselected
  (`localStorage`, per project).
- None: an empty state "Este projeto não tem máquina vinculada" with a link to settings.
- Each tab shows a small badge with the machine name when the project has more than one machine.

### Home and Office

`HomePage` groups by project. The Office draws a room per link (section 5).

## 8. Migration

One Prisma migration, `projects_decoupled_from_machines`, in this order:

1. `ALTER TABLE projects ADD owner_id, key, next_task_number` (key nullable at this step).
2. `CREATE TABLE project_machines`; `ALTER TABLE tabs ADD machine_id` (nullable at this step).
3. Backfill with SQL in the migration:
   - `projects.owner_id = machines.owner_id` through `projects.machine_id`.
   - one `project_machines` row per project from `(machine_id, cwd)`, position 0.
   - `tabs.machine_id = projects.machine_id` through `tabs.project_id`.
   - `projects.key` generated from the name: uppercase initials of the words (or the first 3
     letters of a single word), letters and digits only, prefixed with `P` when it would start
     with a digit; on collision append `2`, `3`, … Done in plain SQL with a loop, or by a
     one-off script run inside the migration; the result must satisfy the unique constraint.
4. `ALTER TABLE tabs ALTER machine_id SET NOT NULL`; `projects.key SET NOT NULL` + unique index;
   drop `projects.machine_id` and `projects.cwd`.

A project whose machine has no owner ends up with `owner_id = NULL` (orphan), visible only to
admins in "all", like an orphan machine today.

## 9. Errors

New `ProjectRuleError` codes, mapped to 400/409 with pt-BR messages in the route layer:

- `KEY_INVALID`, `KEY_TAKEN`
- `MACHINE_ALREADY_LINKED`, `MACHINE_NOT_LINKED`
- `MACHINE_REQUIRED` (tab open with several links), `NO_MACHINE` (tab open with none)

Anything out of scope answers 404 as today.

## 10. Testing (vitest)

- **Repositories**: link / update cwd / unlink; unlink closes that machine's tabs of that project
  only; project list by owner; tab creation refuses a machine not linked to the project; key
  validation and uniqueness; `isKeyAvailable`.
- **Scoping**: user A cannot read B's project, cannot link B's machine to A's project, cannot open
  a tab on it. Admin "view as all" sees everything; "view as B" sees only B's.
- **Routes**: create with and without machine; `key-available`; open tab with one, several
  (without `machine_id` → 400) and zero machines; delete machine keeps the project and its
  tasks; delete project kills sessions on every machine; unlink returns `closed_tabs`.
- **MCP**: `list_projects` shape; `open_tab` resolution rule; `find` by key.
- **Migration**: run the migration against a seeded database with two machines (one without
  owner), projects with the same name, tabs and tasks; assert owners, links, keys (unique, valid)
  and `tabs.machine_id`.

## 11. Rollout

Single deploy. The migration is not backward compatible with the current release (the previous
container fails on the dropped columns), so the blue/green switch must not keep the old color
serving after the migration runs: run the migration as part of the new color's startup and
switch immediately, or take the short downtime. This is accepted for this release.
