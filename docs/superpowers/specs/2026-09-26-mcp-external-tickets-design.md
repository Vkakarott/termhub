# MCP: external tickets (Linear, Jira, GitHub) — several sources per project

Date: 2026-09-26 · Card: to be created after this spec is approved.

## Goal

The concierge (and any personal API token) can work with the tickets that project integrations bring
in from Linear, Jira and GitHub issues, in two flows with the same weight:

- **Take a ticket and work on it** — "pega o EI-123": find the ticket by its key, import it as a card,
  start an agent on the card (`start_agent` with `task_id`).
- **Triage what arrived** — "o que tem de novo no Linear?": list the tickets not imported yet, filter
  them, send the chosen ones to the backlog.

Along the way, three limits of today's ticket sync go away: one ticket source per project, a silent cap
of 100 tickets per sync, and an ambiguous GitHub identifier (`#12`).

## What exists today (origin/main 939f2fa)

- `integrations/{github,linear,jira}.ts` implement `TicketProvider` (`testConnection`, `listTickets`,
  `updateStatus`). GitHub lists repo issues (PRs filtered out), Linear team issues, Jira JQL results.
  All three ask for 100 items and do not paginate.
- The project setup (`project_setups.data`, zod in `setup/schema.ts`) has a single `tickets` source
  `{ provider, integration_id, scope, filter, include_done, sync_minutes }`.
- `setup/tickets-sync.ts` syncs that source into the `tickets` staging table (upsert by
  `(project_id, external_key)`, prune of non-imported tickets by `integration_id`) and mirrors the
  provider state into `tasks.external_ref` of imported cards. A scheduler runs it every `sync_minutes`.
- Routes: `GET /projects/:id/tickets`, `POST /projects/:id/tickets/import`,
  `POST /projects/:id/tickets/sync`, `POST /tasks/:id/push-status`. The web has a Tickets view and the
  setup form. The mobile app has nothing about tickets.
- The MCP has no ticket tool; `list_tasks` hides `external_ref`.

## Names

The same idea has names that collide today (`identifier`, `external_key`, `id`, `ref`, `external_ref`,
`ticketRef()`), and "ref" means both the card and the link to the ticket. From now on: **"ref" is always
the card, "key" is always the ticket.**

| New name | What it is | Example | Today |
|---|---|---|---|
| `ticket.key` | Human key, unique in the project: what people and agents type, search and see | `EI-123`, `PROJ-45`, `engenhariainversa/termhub#12` | `identifier` |
| `ticket.title` | The ticket's title | "Login quebra no Safari" | same |
| `ticket.provider_id` | The provider API's id, for calls only | Linear uuid, `PROJ-45`, `12` | `ExternalTicket.id`, `externalId()` |
| `ticket.sync_key` | Internal dedup key of the sync; never shown | `linear:<uuid>`, `github:owner/repo#12` | `external_key` |
| `task.ref` | The termhub card ref, only | `TER-12` | same |
| `task.ticket` | The card's link to its ticket | `{ key, url, state, provider, source }` | `external_ref` / `ticketRef()` |

**Database columns keep their names** (`identifier`, `external_key`, `tasks.external_ref`,
`tasks.external_key`): the previous container keeps reading them during a deploy and after a
rollback. The new names live in Prisma (`@map`), in the repositories' types, and in the API/MCP output.

## Ticket key and how it is shown

- Linear and Jira keys stay as they are (`EI-123`, `PROJ-45`); they are unique in their workspace.
- GitHub's key becomes `owner/repo#12` (was `#12`). Existing rows are rewritten by the next sync (the
  upsert already overwrites the identifier). Titles of cards already imported do not change.
- **Title and subtitle, like machines:** a card linked to a ticket shows the ticket's title as its
  title and the key on a subtitle line under it. Import no longer prefixes the title with the key
  (today `EI-123 Título`); cards imported before keep their title (no mass rewrite). The Tickets view
  shows the same title + key-subtitle pair.
- **Key lookup** (`get_ticket`, `find`, `import_tickets`) accepts: the exact key (`EI-123`,
  `owner/repo#12`, case-insensitive), the ticket URL, `repo#12`, and `#12`. The short GitHub forms
  resolve only when they match exactly one ticket in the project; otherwise the answer is
  `TICKET_AMBIGUOUS` listing the candidate keys. Without `project_id`, only exact keys and URLs are
  accepted, across the projects in the user's scope; the same key in two projects (two projects on one
  Linear team) is `TICKET_AMBIGUOUS` listing `project / key`.

## Several ticket sources per project

- The setup gains `ticket_sources: TicketSource[]`, each `{ provider, integration_id, scope, filter,
  sync_minutes }`. A source's identity is `(integration_id, scope)`; the same pair twice in one project
  is a 400 (`DUPLICATE_SOURCE`). The same integration may serve several scopes (one GitHub token, two
  repos; one Linear workspace, two teams). Each `integration_id` must be an integration in the user's
  scope, as the single source is checked today.
- **Compatibility:**
  - `normalizeSetup` turns a saved `tickets` into `ticket_sources[0]` when `ticket_sources` is absent.
  - On save, the server writes `ticket_sources` and **mirrors the first source into `tickets`**
    (`null` when there is none), so the previous container keeps syncing that source during a deploy
    or after a rollback.
  - `include_done` is dropped (see below); the mirror writes `include_done: false` so the old schema
    still parses it.
- **New column `tickets.scope`** (text, nullable), backfilled by the migration from `meta->>'scope'`.
  Additive: the old container ignores it. New rows always set it.
- **Prune by source:** `pruneMissing` deletes non-imported tickets by `(integration_id, scope)`
  instead of `integration_id` alone, so syncing one source never deletes another source's tickets.
  Rows with a null `scope` (never backfilled because `meta` lacked it) are pruned with the source of
  the same integration when the project has exactly one source on it.
- **Removing a source** from the setup deletes its non-imported tickets in the same save. Imported
  cards stay, with their link.
- **Sync** runs every source of the project, one after the other. A failing source does not stop the
  others; the result is per source:
  `{ sources: [{ provider, scope, fetched, created, updated, removed, truncated } | { provider, scope, error }], synced_at }`.
  The HTTP route answers 200 while at least one source succeeds, 502 when all fail.
- **Scheduler** keys its last-run map by `project_id + integration_id + scope` and honours each
  source's `sync_minutes`.
- **Push status** finds the source through `task.ticket.integration_id` (written from now on by
  import and sync); links written before fall back to matching `provider + scope`.

## Open tickets only, paginated

- The sync pulls open tickets only. `include_done` leaves the form and the schema (see compatibility
  above). Provider semantics of "open":
  - GitHub: `state=open`.
  - Linear: state type not in `completed`, `canceled`.
  - Jira: `statusCategory != Done`.
  - `filter` keeps narrowing as today (GitHub labels, Linear state names, Jira extra JQL).
- The three providers paginate (GitHub `Link` header / `page`, Linear `pageInfo.endCursor`, Jira
  `nextPageToken` or `startAt`, whichever the endpoint in use returns) up to **500 tickets per
  source**. Hitting the cap sets `truncated: true` on that source's result. `list_tickets` passes it
  on so the agent knows the list is partial.
- Tickets that were imported and then closed keep their card. The sync no longer sees them, so their
  mirrored state stops updating. That is the accepted trade-off of "open only".

## Shared logic: `control/tickets.ts`

Same pattern as `control/tasks.ts`: functions over a `ControlContext`, used by the REST routes and by
the MCP tools, so the two cannot drift. Everything is loaded through `ctx.scoped.project(...)` /
`ctx.scoped.task(...)` (404 outside the scope). Routes only validate input with zod and call these.

- `listTickets(ctx, { project_id, source?, status?, imported?, query?, limit? })`
  - `source`: `{ integration_id, scope }` or a scope string.
  - `query` matches key and title, case- and accent-insensitive.
  - `limit` defaults to 50, max 200.
- `getTicket(ctx, { key, project_id? })`: full description; the lookup rules above.
- `syncTickets(ctx, { project_id })`: runs `syncProjectTickets`. If the project's last sync finished
  less than 60 s ago, it returns that result with `cached: true` without calling the providers
  (in-memory per process; one active container at a time makes that enough).
- `importTickets(ctx, { project_id, keys?: string[], ticket_ids?: string[] })`: exactly one of the two,
  max 200. Creates linked cards in the default epic's backlog (today's route logic, moved here).
  An already imported ticket returns its existing card with `created: false`.
- `pushTicketStatus(ctx, { task_id })`: today's `push-status` logic, moved here.

`TicketsRepository` gains `findByKey(projectId, key)`, `searchByKey(ownerId, key)` (for
`find` without project), `listForTool(...)` with the filters, and the prune by source.
`setup/tickets-sync.ts` keeps `syncProjectTickets` and the scheduler, now per source.

## MCP tools

| Tool | Input | Token scope | Grant | Gate class |
|---|---|---|---|---|
| `list_tickets` | `project_id`, `source?`, `status?`, `imported?`, `query?`, `limit?` | `read` | `tickets:read` | read |
| `get_ticket` | `key`, `project_id?` | `read` | `tickets:read` | read |
| `sync_tickets` | `project_id` | `tasks` | `tickets:update` | write |
| `import_tickets` | `project_id`, `keys?` / `ticket_ids?` | `tasks` | `tasks:create` | write |
| `push_ticket_status` | `task_id` | `tasks` | `tasks:update` | irreversible |

- Grants mirror the REST routes (`/tickets/sync` is `tickets:update`, import is `tasks:create`,
  push-status is `tasks:update`), so a role that can do it on screen can do it by MCP, and no other.
- No new token scope.
- `push_ticket_status` changes a third-party system and notifies other people there: always
  confirmed in chat, never covered by a grant.
- `find` gains `kind: 'ticket'` with the lookup rules above; it returns the ticket and its card, if any.
- `list_tasks` (and every `TaskOut`) replaces `external_key` with `ticket: { key, url, state, provider } | null`,
  so the agent can connect TER-x ↔ EI-y.
- Descriptions spell out the two flows: `get_ticket` / `find` → `import_tickets` → `start_agent` with
  `task_id`; and `sync_tickets` (when freshness matters) → `list_tickets` with `imported: false` →
  `import_tickets`.
- Confirmation card sentences (pt-BR, product copy):
  - "sincronizar os tickets do projeto termhub (Linear EI, GitHub engenhariainversa/termhub)"
  - "importar 3 tickets para o backlog: EI-123, EI-130, engenhariainversa/termhub#12"
  - "mudar o EI-123 no Linear para Concluído (coluna Feito do TER-45)"

### Output shape

`TicketOut`:
- `id`, `key`, `title`;
- `description` (cut to 500 characters in lists, full in `get_ticket`);
- `state` (the provider's raw state), `status` (mapped);
- `url`, `source: { provider, scope }`;
- `priority`, `labels`, `assignee` when the provider has them;
- `synced_at`;
- `card: { ref, url } | null`.

No raw `meta`, no `sync_key`. `list_tickets` also returns `last_sync: { at, sources: [{ provider,
scope, truncated }] } | null`.

## Errors

`ControlError` with a code and an actionable pt-BR message:

- `NO_TICKET_SOURCE` ("Configure uma fonte de tickets no setup do projeto").
- `TICKET_NOT_FOUND`.
- `TICKET_AMBIGUOUS` (lists the candidate keys).
- `NOT_LINKED` (card without a ticket).
- `SOURCE_NOT_FOUND` (push on a card whose source was removed).
- `PROVIDER_ERROR` ("Linear respondeu 401: …", keeping today's 200-character cut so no payload leaks).
- `DUPLICATE_SOURCE` (setup save).

Ticket content is never logged; logs carry `projectId`, provider, scope and counts, as today.

## Web

- Setup › Tickets becomes a list of sources:
  - "Adicionar fonte" and remove;
  - per source: integration, scope (with the existing "listar" helper), filter and sync interval;
  - the "incluir concluídos" checkbox goes away;
  - a duplicate source is flagged in the form before saving.
- Tickets view:
  - a source filter;
  - each row shows the title with the key as subtitle and the source;
  - a banner when a source's last sync was truncated.
- Board and card detail: a card with `ticket` shows the key as a subtitle line (link to the ticket's URL).

## Testing

Vitest, repositories mocked as in `control/tasks.test.ts`; providers with `fetch` stubbed.

- `control/tickets.test.ts`:
  - scope (another owner's ticket → 404);
  - filters;
  - key lookup: exact, URL, `repo#12`, `#12` unique vs ambiguous, no project;
  - import by key and by id, idempotent;
  - push on an unlinked card;
  - sync throttle (`cached: true`).
- `setup/tickets-sync.test.ts`:
  - several sources;
  - one failing source isolated;
  - two sources on one integration do not prune each other;
  - removed source cleanup;
  - `integration_id` written into the link.
- `setup/schema.test.ts`:
  - `tickets` → `ticket_sources`;
  - first source mirrored into `tickets`;
  - `include_done` dropped;
  - duplicate source refused.
- `integrations/{github,linear,jira}.test.ts`:
  - pagination up to 500 and `truncated`;
  - open-only query;
  - GitHub key `owner/repo#12`.
- `chat/gate.test.ts`: class of each new tool.
- `mcp/tools.test.ts`: the tools appear for the right token scopes and grants and disappear without them.
- Route tests (`routes/tickets.test.ts`): still pass through `control/tickets.ts` (import, sync
  partial failure → 200, all failed → 502).
- Web: the sources form (add, remove, duplicate) and the key subtitle on a linked card.
- Final check: `npm run typecheck -w @termhub/server`, web and landing builds, through Docker as in
  CLAUDE.md.

## Out of scope

- Live search in a provider (JQL/Linear filter) bypassing the staging table.
- Ticket comments.
- Closed tickets.
- Tickets in the mobile app.
- Rewriting the titles of cards imported before this change.
