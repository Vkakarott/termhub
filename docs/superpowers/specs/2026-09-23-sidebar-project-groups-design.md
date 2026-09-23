# Sidebar project groups — design

Date: 2026-09-23. Status: **approved design, not implemented.** Builds on
`feat/sidebar-agents-pins` (running agents under each project, the "Em execução" section,
collapse/expand all, `ProjectRow`, `useMonitor().openTabs`).

## 1. Goal

The sidebar lists every project, and the list grows past what one person works on at a time. The
owner wants to keep the list short: see what is running, see what they care about, hide the rest.

After this change the sidebar's project area is, top to bottom:

1. **Em execução** — automatic: every project with at least one open terminal tab. Not stored,
   not orderable, always first. Hidden when empty. (Already built.)
2. **Favoritos** — a group every user has by default. Orderable among the groups, cannot be
   deleted or renamed. The pin button on a project row adds it to / removes it from Favoritos.
3. **The user's own groups** — created, renamed, deleted and reordered by the user.
4. **Outros** — automatic: projects in no group. Always last, inside an accordion with a count
   ("Outros · 12"). The "mostrar arquivados" toggle lives here.

Groups are **tags, not folders**: a project can be in several groups at once, and a project that is
running also shows in Em execução. Groups belong to the logged-in user and follow them across
browsers and devices.

Out of scope: sharing groups with other users, groups anywhere but the sidebar (home cards,
Office, MCP), ordering inside Em execução or Outros.

## 2. Data model

### `project_groups`

| column | type | notes |
|---|---|---|
| `id` | text PK | cuid like other tables |
| `user_id` | FK `users.id`, `Cascade` | the real logged-in user, never the view-as owner |
| `name` | text | 1–40 chars after trim; duplicates allowed |
| `system_key` | text, nullable | `'favorites'` for Favoritos, null for user groups |
| `position` | int | order among the user's groups, 0-based |
| `created_at` | timestamptz | |

`@@unique([userId, systemKey])`: Postgres treats NULLs as distinct, so any number of user groups
and exactly one Favoritos per user. This is expressible in the Prisma schema (no raw partial
index), so the CI drift check stays meaningful.

### `project_group_items`

| column | type | notes |
|---|---|---|
| `group_id` | FK `project_groups.id`, `Cascade` | |
| `project_id` | FK `projects.id`, `Cascade` | deleting a project drops it from every group |
| `position` | int | order inside the group, 0-based |
| `created_at` | timestamptz | |

PK `(group_id, project_id)`. Index on `project_id` for the cascade.

Positions are rewritten densely (0..n-1) inside a transaction on every write that touches order;
lists are short (tens), so no fractional ordering.

## 3. Server

A `ProjectGroupsRepository` and routes under `/project-groups`, all requiring a session and the
`projects:read` permission (a group is a personal view, it does not change any project). Every
route acts on `request.user.id`'s groups; a group id of another user answers 404.

**Favoritos is created lazily**: every read and write first ensures the user's Favoritos row
(`upsert` on `(user_id, 'favorites')`, name `Favoritos`, position after the existing groups), so
there is no backfill migration and no race creates two.

| route | body | effect |
|---|---|---|
| `GET /project-groups` | — | `{ groups: [{ id, name, kind: 'favorites'\|'custom', position, project_ids: string[] }] }` ordered by position; `project_ids` ordered, **filtered to projects visible in the caller's current scope** |
| `POST /project-groups` | `{ name }` | creates a custom group at the end; 201 with the group |
| `PATCH /project-groups/:id` | `{ name }` | renames; Favoritos → 409 `SYSTEM_GROUP` |
| `DELETE /project-groups/:id` | — | deletes the group and its items; Favoritos → 409 `SYSTEM_GROUP` |
| `PUT /project-groups/order` | `{ ids: string[] }` | reorders; `ids` must be exactly the user's group ids (after the Favoritos ensure), else 400 `BAD_ORDER` |
| `PUT /project-groups/memberships` | `{ groups: [{ id, project_ids: string[] }] }` | replaces the ordered membership of each listed group, **atomically in one transaction** |

`memberships` is the single write for add, remove, reorder, move and copy: the client sends the
new ordered list of every group the gesture touched (a move sends source and target). Rules:

- Every `project_ids` entry must be a project the caller can read in the current scope; an unknown
  or out-of-scope id → 404 `PROJECT_NOT_FOUND`, nothing written. Duplicates in one list → 400.
- **Hidden members survive.** Items whose project is not visible in the current scope (e.g. an
  admin in view-as, or a project whose scope changed) are not in the client's list, so replacing
  would delete them. The server keeps them, after the visible ones, in their previous relative
  order.
- Limits: 50 groups per user, 500 items per group → 400 `LIMIT`.

Rule errors return `{ error, code }` in pt-BR like the other project routes.

## 4. Web

### Data

`lib/project-groups.tsx`: a provider/hook `useProjectGroups()` with `groups`, `reload`,
`createGroup`, `renameGroup`, `deleteGroup`, `reorderGroups`, `setMemberships`, and the derived
`isFavorite(projectId)` / `toggleFavorite(projectId)`. Loaded once with the rest of the data;
refetched when view-as changes. Every write is **optimistic**: the new state renders immediately,
the request goes out, and on failure the previous state comes back and a short error shows (the
existing toast mechanism if there is one, otherwise an inline message in the sidebar).

Pure helpers in `lib/project-groups-model.ts`, unit-tested without React:

- `buildSections(projects, groups, openTabs, showArchived)` → `[running, ...groups, others]`
  with the archived filter applied everywhere.
- `applyDrop(groups, drag, drop, { copy })` → the `memberships` payload and the next local state.

### Sidebar

- Section order as in §1. Each group header: name, count, chevron (collapse persisted in
  localStorage next to the existing per-project state, try/catch), hover actions ✎ rename
  (inline input, Enter saves, Esc cancels) and ✕ delete (ConfirmDialog: "Os projetos não são
  apagados"). Favoritos has neither. An empty group shows a dashed "arraste projetos para cá" hint.
- "+ grupo" next to the "Projetos" label (beside the collapse-all button) creates "Novo grupo" at
  the end and opens its rename input.
- Project row gains, in its hover actions: a pin (📌) that toggles Favoritos — always visible and
  filled when the project is in Favoritos, `aria-pressed`, labels "Fixar em Favoritos" /
  "Tirar de Favoritos"; and a "Grupos…" button opening a small popover with one checkbox per group
  (Favoritos first) plus "Novo grupo…". The popover is the keyboard and touch path; native
  drag-and-drop does not work on touch screens.

### Drag and drop

Native HTML5 drag-and-drop, the same approach as `TasksBoard`. A dragged project row carries
`{ projectId, fromGroupId | 'running' | 'others' }`.

| from → to | effect |
|---|---|
| Em execução or Outros → a group | adds the project at the drop index (already there: moves to that index) |
| group A → group B | **moves** (removed from A); with **Alt** (⌥) held at drop, **copies** (stays in A) |
| group A → group A | reorders |
| group A → Outros | removes from A only |
| anything → Em execução | not a drop target |

Group headers are draggable too and reorder the groups (`PUT /project-groups/order`); Em execução
and Outros stay fixed. The drop position shows as a thin accent line between rows / groups.
Dropping a project on a collapsed group's header adds it at the end.

The existing per-project collapse state, running agents under each project and collapse/expand all
keep working in every section; collapse-all acts on projects with agents across all sections.

## 5. Testing

- **Server, repository (Postgres):** Favoritos ensure is idempotent and unique per user; create,
  rename, delete; order validation; memberships replace atomically across two groups; hidden
  members preserved; cascade on project delete and user delete; limits.
- **Server, routes:** each route's happy path, 404 for another user's group, 409 on Favoritos
  rename/delete, 404 for an out-of-scope project, view-as uses the real user's groups but filters
  `project_ids` to the viewed scope.
- **Web, model:** `buildSections` (tags: a project in two groups shows in both; running and in a
  group shows in both; Outros = in no group; archived filter) and every `applyDrop` rule in the
  table, including Alt copy and reorder indices.
- **Web, components:** sidebar renders sections in order and hides empty automatic ones; pin
  toggles Favoritos with rollback on failure; the Grupos… popover adds/removes; create, rename,
  delete group; a drag-and-drop move fires the right `memberships` call (fireEvent drag events).

## 6. Delivery

One PR after `feat/sidebar-agents-pins` is merged: server commit(s) (schema + migration,
repository, routes), then web (model, provider, sidebar, drag-and-drop).
