# City by project — design

Date: 2026-09-24. Status: **implemented on `feat/city-by-project`, pending review and merge.** Supersedes the "what a city is"
amendment of `2026-09-22-public-city-design.md` and §4 (levels) of `2026-09-21-office-world-design.md`.

## 1. Goal

Today the office and the public city are keyed by machine: a building is a machine, a room is a
(project, machine) pair, and a project linked to two machines shows as two rooms in two buildings.
Since projects were decoupled from machines, the project is the unit everywhere else in the app
(sidebar, Início, Setup). The city follows:

- **A building is a project.** Inside it, the desks are the project's agents (its terminal tabs),
  whatever machine each one runs on. There is no room level any more: city › project.
- **The machine becomes a detail of the desk** in the private office (a small tag with the machine's
  name/subtitle, and the offline state), and disappears from the public city.
- The private office and the public city share one model and one reader.

Success: `/office` shows one building per project; clicking it shows its agents; the public city
`termhub.dev/city/@nick` shows one building per published project and never a machine name; every
existing test area is adapted.

Out of scope: a "por máquina" view (Máquinas and Hardware keep the per-machine perspective), changes
to the pixel-art scene beyond what the new levels need, short links per building.

## 2. Model

### 2.1 Server DTO (private) — `apps/server/src/office/snapshot.ts`

```ts
OfficeCity {
  projects: OfficeBuilding[];          // the scope's non-archived projects, by name
  machines: OfficeMachine[];           // every machine a desk refers to
}
OfficeBuilding { project: Project; public_id: string /* publicId('project', id) */; tabs: OfficeTab[]; tasks: OfficeTaskCounts | null }
OfficeTab = Tab & { alive: boolean; progress: OfficeTabProgress | null }   // Tab already carries machine_id
OfficeMachine { id; name; subtitle; type; online: boolean; reachable: boolean | null /* tmux probe: null when not probed */ }
```

`buildOfficeCity({ projects, tabs, machines, probes, simulatorReady, progress })` is pure and
unit-tested: a building per project (empty ones kept), tabs grouped by `project_id`, `alive` =
simulator → `simulatorReady(udid)`; terminal → the tab's machine probe is `reachable` and the session
is in its `sessions`.

### 2.2 Route — `GET /api/office?fresh=0|1`

Replaces `GET /api/office/:machineId`. Under `guarded('projects', read)`. One request for the whole
city: projects in scope (`repos.projects.list({ owner })`, non-archived), their tabs
(`repos.tabs.listByProjects`), the machines those tabs run on (in scope), `officeProgress` when
`tasks:read`, and one `probeTmuxSessionsCached(machine, { fresh })` per machine **in parallel**
(the response waits for the slowest probe, bounded by the existing timeouts; probes are memoised
15 s/60 s as today). `listByProjectsOnMachine` stays for the MCP.

### 2.3 Public DTO — `apps/server/src/public/city.ts`

```ts
PublicRobot   { id, name, kind, state, state_at, activity, activity_verb, alive, progress }   // unchanged
PublicBuilding { id /* publicId('project') */, name, robots: PublicRobot[] }
PublicCity     { nickname, owner_name, short_url, buildings }
```

`toPublicCity` names every field; nothing about machines exists in the public shape. Frames:
`{ type: 'robot', building, robot }` and `{ type: 'robot_gone', building, robot }`.

`publicId` keeps kinds `'project' | 'tab'`; `'machine'`, `'room'` and `publicRoomId` are removed.
`Machine.public_id` is removed from the mapper (no consumer); `Project.public_id` is added
(`publicId('project', id)`) so the share button has it without a new endpoint.

### 2.4 What a public city contains — `apps/server/src/public/read.ts`

- Buildings: the owner's projects that are `is_public` and not archived (owner re-checked), by name.
  A published project **always** appears, even with no agents ("sem agentes agora").
- Robots: the building's tabs whose `machine_id` is a machine **owned by the city owner**. A tab on
  someone else's machine is never shown (conservative: its name is not the owner's to publish).
- `alive` as today (`publicAlive` with the tab's machine memo; cold memo → `state !== null`).
- Memo (4 s) and invalidation unchanged in spirit: cleared on `PublicChange`, `OwnerGone`,
  `TabRemoved`, machine owner change/delete (which only remove robots now) and unlink.

`publicBus`: `RoomsGone` becomes `RobotsGone { machine_id, project_id? }` — it clears the memo and
makes open sockets drop the affected robots (they are gone from the street, the building stays).
`unpublished` still closes the socket when its last building leaves; `owner-gone` unchanged.

`ws.ts` forwards a monitor change when `change.owner_id === owner.id`, `project_id ∈ published` and
`machine_id ∈ ownedMachines` (both sets resolved at admission and kept in sync by the bus as today).

### 2.5 URLs and depths

- Private: `/office` (city) and `/office/:projectId` (building). `?room=` is gone; `?focus=1` stays.
- Public: `/city/@nick` and `/city/@nick/<projectPublicId>`. `?room=` is ignored. An unknown building
  id falls back to the city (already the behaviour), so links shared under the old scheme still open
  the city.
- Card: `?building=` only. Copy: city "N projetos · M agentes trabalhando"; building
  "<projeto> — M agentes trabalhando". Meta description at building depth: "<projeto>, um dos
  projetos publicados de X".

## 3. Private office (web)

### 3.1 Model — `apps/web/src/office/model.ts`

```ts
DeskModel  += machine: { name: string; subtitle: string | null; online: boolean }
BuildingModel { id: projectId; name; label; lit; notice: 'offline' | 'silent' | null; needsYou; progress: OfficeTaskCounts | null; desks: DeskModel[] }
CityModel  { buildings: BuildingModel[]; needsYou }
FocusTarget = { kind: 'city' } | { kind: 'building'; projectId }
```

- `buildCityModel(city: OfficeCity, liveTab)` — one building per project; a desk is `dimmed` when its
  machine is offline or unreachable; `notice`: `'offline'` when every machine of the building's desks
  is offline, `'silent'` when some tmux probe failed. A failed read is not a building notice: there is
  one read for the whole city, so the page says it ("Não foi possível carregar o escritório" before the
  first read, "Escritório desatualizado: não foi possível atualizar" when a later one fails).
- `lit` = the building has at least one alive desk or needs you; empty buildings are unlit.
- `resolveFocus(city, projectId)`; `missingTabIds` compares the city's tab ids with the monitor's for
  the scope's projects.

### 3.2 Scene

- Layout: `layoutCity` places one block per building; inside, `layoutFloor` places the desks on one
  floor (no rooms, no room signs). Shape key `b{d:kind}`.
- `BuildingSign` merges today's machine and room signs: name, "d/t tarefas", needs-you count, and the
  notice ("offline", "sem resposta").
- `DeskOverlay` label: the tab name; a second muted line with the machine (`name`, or
  `name · subtitle` when it fits `SUBTITLE_CAP`), hidden on the public city (the city model gives no
  machine).
- Handlers: `onPickBuilding(projectId)`, `onPickDesk(deskId, projectId)`, `onPickSign(projectId)`,
  `onGoUp()`. `focus({kind:'building'})` frames the block.

### 3.3 Page — `pages/OfficePage.tsx`

- `useOfficeCity()` replaces `useOfficeSnapshots`: one `api.office(fresh)` read, refreshed every 60 s,
  on focus/visibility (≥ 10 s apart) and when the monitor names a tab the city lacks.
- Ladder: building → city → exit focus. Auto-drill into the only project.
- Trail: `Cidade › <projeto>`. `StatusNotices` per building (from `notice`; "N máquinas offline", named on hover), plus the page-level "desatualizado" notice when a re-read fails.
- Share (`shareResultFor(target, userId, nickname, publicCityUrl, shortUrl, projects)`):
  city → short link/base; building → `${base}/${project.public_id}`; `unpublished` when the project
  is not public; `foreign` when its owner is not the viewer. `offstreet` is gone.
- Harness: `?projects=&desks=&project=&churn=`.

## 4. Public city page (web bundle)

- `url.ts`: `Rest { building }`; `?room=` ignored. `api.ts`: `toBuildingEntries(city)` → the office
  model's input (no machines; desks `online: true`, `reachable: true`). Frames applied by building id.
- Trail `Cidade › <projeto>`; `up()` building → city. Copy link: city → short link; building → long URL.
- `share/compose.ts` and `sound.ts` walk `buildings → desks`.

## 5. Settings and copy

- Minha cidade: the "Aparece em <máquinas>" line goes; each project shows "publicado · N agentes
  agora" or "não publicado". The confirm panel says: "Publicar deixa visível, para quem tiver o link,
  o nome do projeto e cada agente (aba) dele que roda nas suas máquinas, com o que cada um está
  fazendo, além do seu nome e apelido. Agentes em máquinas de outras pessoas não aparecem."
- The spec docs above get a short "superseded by city-by-project" note at the top of the amended
  sections.

## 6. Privacy invariants (tests)

- The public snapshot and every frame contain no machine id, name or subtitle, and no tab of a
  machine the owner does not own — pinned with real secrets in fixtures and against a real Postgres.
- A private (unpublished) project is never a building; an archived one neither.
- `Project.public_id` reaches only the authenticated app; the public bundle imports nothing new.

## 7. Migration of behaviour

- No database migration.
- Old share links: building ids of the old scheme (machine HMACs) and `?room=` resolve to the city.
- `/office/:machineId` bookmarks resolve to the city (unknown project id).

## 8. Testing

Server: `buildOfficeCity` (grouping, alive per machine probe, empty buildings, tasks), the route
(scope, parallel probes, `fresh`, a failing probe marks the machine unreachable without failing the
request), public read (published-only, owned-machine robots only, empty building kept, order), DTO
negatives, ws (forwarding rule, `RobotsGone`, unpublish closes), card and meta copy, `publicId`
golden for `'project'`, publish/unlink/owner-change bus events.

Web: model (buildings, desks with machine, dimmed/notice/lit, focus, missing tabs), layout shape,
signs, OfficePage (routes, ladder, auto-drill, trail, notices, share results), city bundle (url,
adapter, frames, trail, copy link), compose/sound counts, MyCityView copy, harness.

Real-browser smoke (Playwright): private office with fixtures (buildings, desk tags with machine),
public city (no machine text anywhere in the DOM or the scene labels), old links falling back.
