# Board hierarchy, backlog, custom columns and card URLs — design

Date: 2026-09-24. Status: **draft for review, not implemented.** Second of two specs; the first,
`2026-09-22-projects-decoupled-from-machines-design.md`, is shipped (PR #111) and gave every project
the `key` and `next_task_number` this one uses.

## 1. Goal

Today a task is an open line of text on a fixed four-column kanban (`backlog`, `todo`, `doing`,
`done`), with one level of subtasks shown as a checklist. There are no kinds of work, no backlog
separate from the board, the columns cannot be changed, and a card has no address of its own.

After this change:

- Every card has a **type**: `epic`, `story`, `task`, `subtask`, `bug`, `spike`.
- **The epic is mandatory.** `story`, `task`, `bug` and `spike` always belong to an epic of the same
  project. A `subtask` belongs to a `story` or a `task`. An epic has no parent.
- Two views per project: **Board** (kanban) and **Backlog** (a list grouped by epic). The backlog is
  a state of its own, outside the board columns, and the Backlog page shows only backlog items.
- **Board columns are per project and customizable.** The user names them ("Em revisão", "QA",
  "Bloqueado"…) and gives each one a fixed **category**: `todo`, `doing` or `done`. The system
  reasons with the category, the user sees the name.
- A project setting picks the **agent column**: where a task goes when an agent starts on it. With
  no setting, it is the first `doing` column. "Done" for the system is the first `done` column.
- The board shows the types chosen in a **type filter** (default: story, task, bug, spike).
- Every card has a **number** and a **URL**, Jira style: `TER-123` (project key + sequential number),
  opened at `/project/TER-123`.

Decisions taken with the owner on 2026-09-22 (brainstorm of the first spec), kept as they were:
epic mandatory, orphans go to a default epic; filterable board; custom columns with a category;
agent column setting with the `doing` fallback; subtasks stay a checklist inside the parent card;
card URL `/project/KEY-N`; the three tasks in production may be discarded.

Out of scope, deliberately: moving project URLs to the key (`/projects/:id/...` stays; only cards get
key URLs), sharing a board with other users, WIP limits, swimlanes, sprints, story points,
reordering epics by hand, moving a card to another project, and new ticket-provider mappings.

## 2. Data model

The design is **additive**: no column is dropped or re-purposed, so the previous release keeps
working during the blue/green switch (CLAUDE.md rule). In particular `parent_id` keeps meaning
"subtask of", and the epic link is a new column.

### `tasks`

| column | change |
|---|---|
| `type` | new, enum `TaskType` (`epic, story, task, subtask, bug, spike`), `NOT NULL DEFAULT 'task'` |
| `number` | new, `Int NOT NULL DEFAULT 0`, assigned by a database trigger (below); `@@unique([projectId, number])` |
| `epic_id` | new, nullable FK → `tasks.id`, `ON DELETE SET NULL`. Set on story/task/bug/spike; null on epic and subtask |
| `column_id` | new, nullable FK → `task_columns.id`, `ON DELETE SET NULL`. Set on every top-level card that is not in the backlog |
| `status` | unchanged enum `backlog/todo/doing/done`. Now the **category** of the card: `backlog` = in the backlog, otherwise the category of its column. Kept in sync on every write |
| `parent_id` | unchanged meaning: only a subtask has it, and it points to a story or a task |
| `position` | unchanged column, new scope (see below) |

Indexes: `@@unique([projectId, number])`, `@@index([columnId, position])`, `@@index([epicId, status, position])`.
The existing `[projectId, status, position]` and `[parentId, position]` stay.

**Position scope.** Board card: among cards of the same `column_id`. Backlog item: among backlog items
of the same `epic_id` (an epic in the backlog: among backlog epics of the project). Subtask: among
siblings (`parent_id`), as today.

**Numbering.** A `BEFORE INSERT` trigger on `tasks` sets `number` when it is `0` or null:
`UPDATE projects SET next_task_number = next_task_number + 1 WHERE id = NEW.project_id RETURNING next_task_number - 1`.
The row lock on the project serializes concurrent inserts, numbers never repeat and are never reused
after a delete. Being in the database, it also numbers rows written by the previous release during
the switch. Prisma sees `number Int @default(0)`; the returned row carries the real number.

### `task_columns` (new)

| column | type |
|---|---|
| `id` | `String @id` (`newId()`) |
| `project_id` | FK → `projects.id`, `ON DELETE CASCADE` |
| `name` | `String`, 1–40 chars, trimmed |
| `category` | `TaskStatus`, `CHECK (category <> 'backlog')` |
| `position` | `Int` |
| `created_at` | `DateTime @default(now())` |

`@@index([projectId, position])`. A project always has at least one column of each category.
At most 12 columns per project. Names are not unique (the user decides).

Default columns for a new project: "A fazer" (`todo`), "Fazendo" (`doing`), "Feito" (`done`).

### `projects`

| column | change |
|---|---|
| `agent_column_id` | new, nullable FK → `task_columns.id`, `ON DELETE SET NULL`. Null = automatic (first `doing` column) |
| `next_task_number` | now used by the numbering trigger |

### Unchanged

`tickets` (still `TaskStatus`), `notes`, `project_setups`, the ticket providers' status mapping (it
works on the category, which is still `status`).

## 3. Rules

### Hierarchy

| type | parent | epic | notes |
|---|---|---|---|
| `epic` | — | — | cannot be deleted while it has cards (`EPIC_HAS_CHILDREN`) |
| `story`, `task` | — | required, an epic of the same project | may have subtasks |
| `bug`, `spike` | — | required, an epic of the same project | no subtasks |
| `subtask` | required, a `story` or `task` of the same project | null (inherited from the parent) | checklist inside the parent card, never on the board |

- **Default epic** of a project: the one with the lowest `number`. When a story/task/bug/spike is
  created without `epic_id` (quick add, MCP, ticket import), it goes to the default epic; if the
  project has none, an epic "Geral" is created in the same transaction.
- **Type changes** are allowed only among `story`, `task`, `bug`, `spike`. A card with subtasks cannot
  become `bug` or `spike` (`HAS_SUBTASKS`). Epic and subtask never change type (`TYPE_LOCKED`).
- **Moving to another epic**: `epic_id` may change to any epic of the same project.
- Deleting a story/task deletes its subtasks (as today). Deleting an epic with cards is refused;
  the user moves or deletes the cards first.

### Columns

- A card on the board has `column_id` set and `status = column.category`.
- Setting a status without a column (MCP `update_task`, the subtask checkbox, a provider-driven
  move) puts a top-level card at the top of the **first column of that category**; `backlog` clears
  `column_id` and puts it at the top of its epic's backlog.
- `start_agent` with `task_id` moves the card to the **agent column** (`agent_column_id`, else the
  first `doing` column), unless it is already in a `doing` column.
- Deleting a column moves its cards to the end of the first other column of the same category.
  Deleting or re-categorizing the last column of a category is refused (`COLUMN_LAST_OF_CATEGORY`).
- Changing a column's category updates `status` of its cards in the same transaction.
- If the agent column is deleted, `agent_column_id` falls back to null (automatic).

### Healing rows from the previous release

During the blue/green switch the old container may insert a top-level task with `epic_id` and
`column_id` null, or create a project without columns. `TasksRepository.listByProject` runs a cheap
`normalize(projectId)` first, in one transaction: create the default columns if the project has none;
attach non-epic top-level cards with no epic to the default epic; give non-backlog top-level cards
with no column the first column of their category (appended). The same normalization makes a
`SET NULL` from a deleted column harmless.

## 4. Repositories

`apps/server/src/db/repositories/tasks.ts` changes:

- "Top-level" stops meaning `parentId: null` and becomes `type != 'subtask'`. Board and counts use
  `type in (story, task, bug, spike)` (epics are containers, not work).
- `TaskInput` gains `type?`, `epic_id?`, `column_id?`. `create` validates the table in §3, resolves
  the default epic, and places the card at the top of its column (or of its epic's backlog).
- `move(id, target, position)` where `target` is `{ column_id }` or `{ status }` (`status` resolves to
  the first column of the category, `backlog` to the backlog). Gap closing/opening now works per
  `column_id` (board) or per `epic_id` + backlog.
- `update` accepts `type`, `epic_id` with the rules above; a status change goes through `move`.
- `delete` refuses an epic with cards.
- `openCountByProject`, `listDoing`, `officeProgress` count story/task/bug/spike only.
- New `findByRef(key, number)`.
- `nestTasks` nests subtasks under their parent as today; the list response also carries `columns`.

New `apps/server/src/db/repositories/task-columns.ts`: `list(projectId)`, `ensureDefaults(projectId)`,
`create`, `rename`, `setCategory`, `move(id, position)`, `delete`, all transactional with the rules in
§3. `ProjectsRepository.create` calls `ensureDefaults` in its transaction.

Rule errors extend `TaskRuleCode`: `EPIC_REQUIRED`, `EPIC_NOT_FOUND`, `PARENT_TYPE`, `HAS_SUBTASKS`,
`TYPE_LOCKED`, `EPIC_HAS_CHILDREN`, `COLUMN_NOT_FOUND`, `COLUMN_LAST_OF_CATEGORY`, `TOO_MANY_COLUMNS`.

## 5. API

All routes stay under the `tasks` resource, loaded through `scoped(...)`.

### Tasks

- `GET /projects/:id/tasks` → `{ tasks, columns, agent_column_id }`. Each task gains `type`, `number`,
  `ref` (`"TER-12"`), `epic_id`, `column_id`. Epics are included (the backlog needs them).
- `POST /projects/:id/tasks` body gains `type` (default `task`), `epic_id`, `column_id`. `status`
  stays accepted (`backlog` or a category).
- `PATCH /tasks/:id` gains `type`, `epic_id`.
- `POST /tasks/:id/move` body `{ column_id, position }` or `{ status, position }` (exactly one).
- `GET /tasks/by-ref/:ref` (`ref` = `KEY-N`, case-insensitive key) → `{ task, project_id }`. 404 when
  the key or the number does not exist **or** the project is outside the caller's scope.

### Columns

- `GET /projects/:id/columns` → `{ columns, agent_column_id }`
- `POST /projects/:id/columns` `{ name, category }` → 201, appended at the end.
- `PATCH /columns/:id` `{ name?, category? }`
- `POST /columns/:id/move` `{ position }`
- `DELETE /columns/:id` → `{ ok, moved_tasks }`
- `PUT /projects/:id/agent-column` `{ column_id: string | null }`

### Other routes touched

- `POST /projects/:id/tickets/import`: imported tasks are `type: task`, in the backlog of the default
  epic (end of it, as today).
- `POST /tasks/:id/push-status`: unchanged (uses `status`).
- Dashboard, office, projects list: counts per §4.

## 6. MCP tools

- `list_tasks`: output adds `type`, `ref`, `url`, `epic_id`, `column` (`{id, name, category}`) and a
  top-level `columns` array; new filters `type` and `epic_id`. Description updated: epics group the
  work, the board shows columns by name.
- `create_task`: gains `type` and `epic_id` (optional; default epic when absent). Creating `type:
  "epic"` is allowed.
- `update_task`: gains `type` and `epic_id`.
- `move_task`: accepts `column_id` **or** `status`.
- `start_agent`: description says the task moves to the project's agent column.
- `find`: new kind `task`, matching a ref (`TER-12`) exactly.
- Every task in a tool result carries `url` = `${publicUrl}/project/${ref}`; `boardUrl` stays.
- Chat gate and the chat action trail keep their classification; the trail shows `ref` before the title.

## 7. Frontend

### Project sections

`ProjectPage` sections become: Terminais, **Board** (path `tasks`, label "Board"), **Backlog** (path
`backlog`), Tickets, Notas, Setup. The open-task badge stays on Board.

### Board

- One column per `task_columns` row, in order, horizontal scroll when they do not fit (min width
  ~260px). Column header shows the name and a small category marker.
- Toolbar: type filter (chips "História", "Tarefa", "Bug", "Spike", "Épico"; default all but Épico)
  and epic filter (select, default all), remembered per project in `localStorage` (try/catch).
- Quick add per column creates a `task` in the default epic; the editor changes type and epic.
- Cards show a type marker, the ref (`TER-12`), the title, the epic name in small text, the subtask
  counter and the terminal link as today. The "→ next" button moves to the next column by position.
- Drag and drop between columns stays native HTML5, now keyed by `column_id`.

### Backlog

- One section per epic (default epic first, then by number), header with ref, title and progress
  ("3/8 feitas" over its non-backlog cards). Inside, the epic's backlog items by position, draggable
  within the section.
- Each row: type marker, ref, title, subtask counter, actions "Enviar para o board" (first `todo`
  column) and open.
- Quick add per epic ("+ item (Enter)", type selector) and "+ Novo épico" at the top.

### Card editor and URLs

- The editor opens from the URL: `/project/:ref`. Clicking a card navigates there; closing goes back
  to the section it came from (`/projects/:id/tasks` or `/backlog`).
- `/project/:ref` resolves the ref with `GET /tasks/by-ref/:ref`, renders the project's Board with the
  editor open, and shows "Card não encontrado" for a 404.
- Editor: title "TER-12", type select (rules of §3), epic select, column select (or "Backlog"),
  description, subtasks (story/task only), external ref, terminal, delete, and a "Copiar link" button.
- The server's SPA fallback already serves `/project/*`; no server change.

### Settings

`ProjectSettings` gains a "Colunas do board" block: list in order with rename, category select
("A fazer", "Fazendo", "Feito"), up/down, delete (confirm tells how many cards move and where), "+
coluna", and "Coluna do agente" (select: "Automática (primeira Fazendo)" + every column).

### Elsewhere

Home cards, sidebar badge, office progress and tickets view keep working through the counts; labels
that said "task" in pt-BR copy use the type labels where a type is known.

## 8. Migration

One migration, `20260924000000_board_hierarchy`, additive:

1. `CREATE TYPE "TaskType"`; add `tasks.type`, `number`, `epic_id`, `column_id`; create
   `task_columns`; add `projects.agent_column_id`; FKs as §2.
2. Subtasks: `type = 'subtask'` where `parent_id` is not null.
3. Columns: three default columns per project (ids `'tc' || project_id || '1..3'`).
4. `column_id` for top-level tasks not in the backlog, by status; positions kept.
5. Default epic "Geral" (`status = 'backlog'`) for every project with top-level tasks; `epic_id` of
   those tasks set to it.
6. Numbers per project, by `created_at` (epic first); `next_task_number = max + 1`.
7. Unique index `(project_id, number)`, then the numbering trigger and function.

The old release keeps reading `status`, `position` and `parent_id` with their old meaning. It will
show the "Geral" epics as ordinary backlog cards for the switch window; harmless.

## 9. Errors

`TaskRuleError` → 400, except `EPIC_HAS_CHILDREN` and `COLUMN_LAST_OF_CATEGORY` → 409. pt-BR messages:
"Escolha um épico", "Épico não encontrado", "Subtarefa só pode ficar em uma história ou tarefa",
"Tire as subtarefas antes de mudar para bug ou spike", "Épico e subtarefa não mudam de tipo",
"Este épico ainda tem cards", "Coluna não encontrada", "O board precisa de ao menos uma coluna de
cada tipo", "Limite de 12 colunas".

## 10. Testing (vitest)

- **Repositories (DB tests):** create per type with the hierarchy table; default epic created once
  under concurrency; numbering sequential and concurrent-safe, never reused; move by column and by
  status; column delete moves cards; last-of-category refused; category change updates status;
  normalize heals legacy rows; counts exclude epics and subtasks; `findByRef`.
- **Routes:** zod bodies, `move` exactly-one-of, `by-ref` 404 outside the scope, column routes.
- **MCP:** new fields, `move_task` by column, `find` by ref, `start_agent` to the agent column.
- **Migration:** script over a pre-migration dump with a project, a top-level task per status and a
  subtask: columns, epic, numbers, `next_task_number` and trigger checked.
- **Web:** board renders custom columns and the filter; backlog groups by epic; `/project/TER-12`
  opens the editor; settings column block.

## 11. Rollout

The migration is additive and the old release keeps working, so the normal blue/green deploy
applies. The three existing production tasks are migrated, not dropped (it is cheap). After deploy:
check that every project has three columns, `next_task_number` is above the highest number, and
that creating a card from the board and from MCP returns a `ref`.
