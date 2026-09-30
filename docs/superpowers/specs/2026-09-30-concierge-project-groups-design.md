# Concierge: project groups — design

Card: **TER-419** (#170), epic TER-1. Front 5 of the roadmap
(`2026-09-29-chat-and-machine-agent-roadmap-design.md`). Server only.

Every decision below was taken without the user (2026-09-30, asked to plan and execute by
recommendation); the reason is written next to each one.

## 1. Problem

Read from the code at `ebaffe10`.

The sidebar groups projects (Favoritos, the person's own groups, "Outros"). The concierge does not see
any of it: `list_projects` answers id, key, name, status, description and machines; `find` resolves
machines, projects, accounts, cards and tickets; the project chat is told the project's name, key and
folders; the account-wide chat is told nothing about projects. Asked "o que está acontecendo no
Triunfo?", the concierge guesses the group from the folder paths.

## 2. Decisions

| Topic | Decision | Why |
|---|---|---|
| Whose groups | The groups of the token's owner, or of the user whose chat runs. Never a "view as" owner's. | Groups are personal. A token and a chat always act as their own user (`controlContextFor`). |
| Which projects | Only the projects `repos.projects.list({ owner })` answers for that scope. A member outside it is left out, in tools and in prompts. | The same filter as `routes/project-groups.ts`. |
| A read does not write | A new repository method reads the groups without creating the Favoritos row. | `list` creates it on first use. A tool call or a prompt must not write. |
| Favoritos | Never a group for the concierge. It is `favorite: true` on the project. | It is a pin, not a subject. The issue asks for it. |
| "Outros" | Does not exist for the concierge. A project in no group has `groups: []`. | It is the sidebar's name for the rest, not a group. |
| Archived projects | Hidden from `list_project_groups` and from both prompts. `list_projects` keeps its own `include_archived`. | The concierge should not be pointed at work that is over. |
| `group` filter of `list_projects` | An id or a name. The id is tried first. A name matches without case or accents, as `find` does. Two groups with the same name both match. No match is an error, `GROUP_NOT_FOUND`, "Grupo não encontrado". | An empty list for a mistyped name would read as "the group has no projects". |
| `find` | Kind `group`, part of the default kinds. Needs `projects:read`. | "Triunfo" must resolve without the model knowing which kind to ask for. |
| Project prompt | One line after the machines: the groups of the project, each with its sibling projects by name. At most 600 characters, cut with "…". It counts in the 4000 characters the prompt already has. | The machines list is what absorbs the cut today, and it keeps doing so. 600 is room for about 40 names. |
| Account-wide chat | A short index, groups and their projects by name, on the streamed path only. At most 4000 characters, cut with "…", ending with a pointer to `list_project_groups`. No groups, no index. | The one-shot path sends no prompt for the account-wide chat, and three tests pin that. Streamed runs already send the orchestrator's rules, so the agent is known to forward a prompt. |
| A failed read of the groups | The prompt goes without them. The failure is logged by its label. | Groups are context. They must not cost a message. |
| Names in a prompt | Whitespace runs, line breaks included, become one space. | A name is the person's own text, but a line break in it would break the line it sits in. |
| Logs | Nothing of this is logged: no group name, no project name. | They are the person's content. |
| The sidebar's wording | Not changed. | Moving a project between groups now changes what the chat is told. The issue asks to make that clear in the UI; it is a copy decision, left for a card of its own. |
| Phone | Nothing to do. | The phone's chat runs the same service and the same tools. No screen and no contract change. |
| No migration | The model exists since #122. | — |

## 3. Shapes

```ts
// apps/server/src/db/repositories/project-groups.ts
/** The user's groups in sidebar order, Favoritos included when it exists. Never writes. */
read(userId: string): Promise<ProjectGroup[]>

// apps/server/src/control/groups.ts — new
export interface GroupView { id: string; name: string; projects: { id: string; key: string; name: string; status: string }[] }
/** The custom groups of the context's user, in sidebar order, with their visible, not archived
 *  projects in the group's order; and the ids of the visible projects marked as favourites. */
export async function groupsOf(ctx: Pick<ControlContext, 'repos' | 'scope'>): Promise<{ groups: GroupView[]; favorites: Set<string> }>
export async function listProjectGroups(ctx: ControlContext): Promise<{ groups: GroupView[] }>

// apps/server/src/control/inventory.ts
listProjects(ctx, input: { machine_id?: string; include_archived?: boolean; group?: string })
// each project gains: groups: { id: string; name: string }[]; favorite: boolean
export type FindKind = 'machine' | 'project' | 'ai_account' | 'task' | 'ticket' | 'group'

// apps/server/src/chat/project-prompt.ts
export interface PromptGroup { name: string; siblings: string[] }
projectSystemPrompt(project, links, standing = [], groups: PromptGroup[] = []): string
/** The index of the account-wide chat, or null when the person has no group with a project. */
export function accountSystemPrompt(groups: { name: string; projects: string[] }[]): string | null
```

`list_project_groups` answers `{ groups: [{ id, name, projects: [{ id, key, name, status }] }] }`. A
group with no visible project is listed with an empty list: it exists in the sidebar.

## 4. Texts of the prompts

The prompts are in English, as the rest of them. Names are quoted.

Project chat, one line after "Its machines and directories: …":

```
Its groups in the person's sidebar: "Triunfo" (with "notify", "painel-triunfo", "speedbike-app"); "Clientes" (no other project).
```

A project in no group gets no line.

Account-wide chat, after the orchestrator's rules:

```
The person groups their projects in the sidebar like this. A group is how they think of the work: projects of one group are related.
- "Triunfo": "notify", "painel-triunfo", "speedbike-app"
- "Faculdade": "Escreva+", "factcheck"
Use list_project_groups for ids and status, and list_projects with group to work on one group.
```

A group with no project is left out of the index.

## 5. Where the account-wide index is read

`ChatService` reads it next to `promptFor`, before the conversation's lock is taken, and only when the
conversation is the account-wide one and the host streams. It is passed to `streamedSystemPrompt` in
the three places a streamed run starts (`startNow`, `resume`, `launchQueuedNow`). `promptFor` keeps
answering `null` for the account-wide chat, so the one-shot path is untouched.

## 6. Tests

- `project-groups.db.test.ts`: `read` answers the groups in order and creates nothing, for a user
  with no row at all and for one with groups.
- `control/groups.test.ts`: only custom groups; sidebar order; members in the group's order; a project
  outside the scope is left out; an archived one is left out; Favoritos becomes `favorites`; the
  groups read are the user's, not the owner's of a "view as" scope.
- `control/inventory.test.ts`: `list_projects` carries `groups` and `favorite`; `group` by id, by name
  without case or accents, two groups of the same name, no match (`GROUP_NOT_FOUND`); `find` resolves
  a group, leaves Favoritos out, and needs `projects:read`.
- `mcp/route.test.ts`: the exact list of tools gains `list_project_groups`.
- `chat/gate` tests: `list_project_groups` is a read, never asked.
- `project-prompt.test.ts`: the line, with one group, several, none, no sibling; the 600-character
  cut; the whole prompt stays within 4000; a name with a line break.
- `concierge-prompt.test.ts` or `project-prompt.test.ts`: the index; no group, `null`; the
  4000-character cut keeps the pointer to the tool.
- `service.test.ts`: a project chat's prompt names its group and siblings, and a move between groups
  changes the next run; the account-wide chat gets the index on a streamed host and no prompt on a
  one-shot host (the three existing tests stay as they are); a failed read of the groups sends the
  prompt without them; another user's groups never appear.

## 7. Out of scope

- A description of the group, relations between projects, and writes through the MCP (the issue's
  "Evolução").
- The sidebar saying that groups are context for the chat.
- The index on the one-shot path.
