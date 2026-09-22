# Office world: an animated, navigable view of the account's machines, projects and tabs — design

Date: 2026-09-21. Status: **v1 (one machine's floor) is in production since 2026-09-21 (PRs #89,
#90). v2 (the city: every machine in one scene) is implemented on branch `feat/office-city`,
pending review and merge.** Supersedes the open questions of `2026-09-19-office-world-brainstorm.md`,
which stays as the record of the idea.

## 1. Goal

A view where the account's work is drawn as a small isometric pixel-art city: each machine is a
city block holding its open office floor, each project is a room on that floor, each terminal tab
is a person at a desk, each simulator tab is a phone on a desk. It is
functional, not decorative. It answers, at a glance and from across the room: what is being
worked on, who needs you, how far along each piece of work is — and it takes you to the terminal
with one click.

Success for v1:

- Opening `/office` shows every project and tab of a machine, live, with no reload needed for a
  state change to show.
- A tab that starts needing you is noticeable from the floor view without reading any text.
- Clicking a person opens that tab's terminal; clicking a room sign opens the project.
- Progress is shown only when it comes from a real source; otherwise nothing is drawn.
- The main bundle does not grow: the renderer loads only when the view opens.

Success for v2, on top of v1's:

- Opening `/office` with several machines shows all of them at once, and someone who needs you on
  any machine is noticeable from the city view without reading any text.
- Moving between the city, a machine and a room never rebuilds the scene: it is a camera move.
- A machine that is slow or down delays only its own block.

## 2. What the spike established

The throwaway spike (`/spike/office`, PR #84, in production since 2026-09-21) answered the
renderer question. **PixiJS v8 is the renderer.** Measured:

- It embeds in React 18 as a plain class (`mount` / `destroy` / `setDesks`) mounted on a ref.
  Pixi v8's `init` is async, so an unmount in between must be handled; it is three lines.
- Behind `lazy()`, the main bundle is unchanged (898 kB); PixiJS ships in its own chunks
  (about 92 kB gzip plus the renderer chunk), fetched only when the route opens.
- CPU cost of one frame (our update plus Pixi's render submit), with placeholder `Graphics`
  art and one `Text` per desk: 0.6 ms at 40 desks, 2.7 ms at 200, 14.8 ms at 1000, 37 ms at 2000.
  Real accounts are in the tens of desks.
- A monitor push that changes only a tab's state updates that one desk; the room is not rebuilt.
- The camera (zoom at cursor, pan, eased framing) and the generated desk layout came to about
  80 lines together.

Two defects of the spike that this design fixes: labels drawn inside a desk's container are
covered by the desk in front (section 5), and `MonitorProvider` lists only tabs that have
reported a state, so tabs that never reported were missing from the room (section 5).

## 3. Scope

**In v1 (shipped):** the floor of one machine and its rooms, the camera between the two, live
states, progress from the kanban, the `/office` route with focus mode, an in-house generated art
pack, removal of the spike.

**In v2 (this revision):** the city level — every machine of the account as a block of one
continuous scene, with a third camera rest; snapshots of several machines read in parallel; a
server-side memo of the tmux probe per machine; a breadcrumb instead of the machine selector.

**Out of v2, recorded for later:** drawn streets, vehicles and closed buildings with façades;
culling of off-screen blocks; dragging blocks to reorder them; progress from the agent's own todo
list and any time estimate (section 7 explains why); third-party or commissioned art packs;
per-room slide tweens on a repack; a folder-based pack loader; sound; and carrying the probe's
"could not ask" / "asked, nothing is running" distinction into `GET /projects/:id/tabs`, which
still reads both as "no sessions".

## 4. Levels and navigation

**One continuous scene for the whole account, not separate screens.** The city is one scene: a
block per machine, each block holding that machine's open floor — the projects' rooms side by side
with the people inside. Entering a machine or a room is a camera move (eased zoom and pan), not a
scene change. Separate scenes per level were rejected: they need fake transitions and they hide a
raised hand somewhere else. Closed buildings with façades were rejected for the same reason — they
hide the people until you walk in — and for needing art the pack does not have. v1 had one scene
per machine and rebuilt it on a machine change; that seam is where v1 broke twice during review,
and v2 removes it: `/office/:machineId` is a camera target inside the same scene.

Three camera rests:

- **City.** Every block framed. Each machine has a large sign with its name, a counter such as
  "3 precisam de você", and "offline" / "sem resposta" when that applies. Room signs are hidden at
  this zoom; a room's floor colour still tells an active project from a paused one. People are
  small; the marker of someone who needs you keeps a fixed size on screen, so it reads from the
  city.
- **Machine.** One block framed — v1's floor view: room signs with the project name, its progress
  (section 7) and its own counter. Desk labels and progress bars stay off; a desk anywhere still
  reveals its full name on hover.
- **Room.** One room framed: tab names, progress bars and full animations, but only for the
  focused room's desks; any other desk stays unlabelled until hovered.

Interaction:

- Clicking a block (its floor outside any room, or the machine's sign) moves the camera to that
  machine. Clicking a room moves the camera into it, from the city as well as from the machine.
- `Esc` and the breadcrumb walk the full ladder — room, machine, city, then out of focus mode —
  one rung at a time. Zooming out past a threshold (the scene's own "go up") climbs the same
  room → machine → city rungs but never takes the last one: leaving focus mode is a deliberate
  act, not something a wheel or pinch gesture should do by itself. With a single machine the city
  rung does not exist, so either kind of "up" stops at the machine rest — for `Esc` that means
  leaving focus mode directly from there.
- A breadcrumb in the top bar, `Cidade › <machine> › <project>`, shows where the camera rests;
  each part is a link to that rest. It replaces v1's machine selector and "voltar ao andar" button.
- Clicking a person — the whole desk, person and furniture together, not only the head — opens the
  terminal in a new browser tab at `/projects/<projectId>?tab=<tabId>`, at every level.
- Clicking a room's sign opens the project (`/projects/<projectId>`).
- Wheel zoom (at the cursor) and drag pan stay free at all times. A drag longer than a few
  pixels never counts as a click.

**Auto-drill.** An account with a single machine opens `/office` straight at that machine: a city
of one block adds nothing. A machine with exactly one project that has tabs opens straight into
that room, when it is reached by auto-drill or by its own URL with no `?room=`. What is not a
choice is not asked: a machine reached "by hand" — a block clicked from the city, or a room left
with `Esc` — has its auto-drill into that machine's only room suppressed once, so stepping back
out of a room does not immediately drop the person straight back into it; a direct arrival at a
different machine (a fresh load, Back/Forward, another block clicked) still auto-drills normally,
since "by hand" is tracked per machine id and never leaks from one to another.

**URL is the state.** `/office` is the city, `/office/:machineId` a machine, `?room=<projectId>` a
room of it, `?focus=1` focus mode. v1's links keep working. Reloading or sharing the link lands in
the same place; entering a rest pushes history and leaving one replaces it, so the browser's back
button goes up and never re-enters.

**Which rooms exist.** `active` projects always get a room, empty and lit when they have no
tabs. `paused` projects get a dark room. `archived` projects are not drawn.

## 5. Generated layout

Everything is derived from data by pure functions with no renderer in them:
`layoutRoom(tabCount)`, `layoutFloor(rooms[])` and `layoutCity(floors[])`, the last two over one
shared `packShelves(rects, gaps)`. The scene only draws the result. This is the part that survives a change of art or renderer.

**Desks in a room.** As in the spike: rows of desks with a one-tile aisle around each, the room a
little wider than deep. Desk order is `Tab.position`, the same order as the tab bar, so the third
tab is always the third desk. Room size follows the tab count, with a minimum of 5×3 tiles.

**Rooms on the floor.** Rooms have different sizes, so they are placed by shelf packing: in
project name order (the order the sidebar already uses; projects have no position), filling a row up to a target width and then starting the next row,
with a two-tile corridor between rows and one tile between neighbours. The target width is chosen
so the projected floor is close to the screen's proportion (about 16:10). A uniform grid was
rejected for wasting space when one room has twelve tabs and another has one; a treemap was
rejected for reordering rooms on every change.

**Blocks in the city.** The same shelf packing one level up: blocks in machine name order (the
sidebar's order), a row filled up to a target width chosen for the screen's proportion, then the
next row, with a four-tile street between blocks and between rows — wider than a floor's two-tile
corridor, so where one machine ends reads without drawing anything. A room's origin is its
block's origin plus its own. A machine with no projects is a minimal empty block with its sign; a
machine whose snapshot could not be loaded is the same block with "não foi possível carregar".
Every block's ground is outlined, a 3 px line one shade lighter than its fill: filled alone, a
dark block sat only a few values away from the page background, so its footprint and the street
around it were simply not there — the machine people are waiting on became the least visible
thing in the city. The outline also tells two neighbouring blocks apart from each other, not only
from the street.

**Stability.**

- A machine going offline or coming back repaints its block in place (the dark palette a paused
  project already uses); nothing rebuilds. Its people and furniture dim with it — alpha 0.45,
  applied in place to what is already drawn, not a rebuild — but its markers do not: a raised
  hand must read the same whether or not its machine answers. On the block's sign only the name
  and the notice dim with the rest of the sign; the needs-you counter is set apart as its own
  piece of text and stays at full attention orange, since it is the one thing an offline machine
  must not say quietly.
- A machine's snapshot arriving, a machine added or removed, or a floor changing size rebuilds the
  city under the same camera rule as a floor rebuild below: block order is kept, later blocks may
  move, and the scene re-frames by itself only while the person has not moved the camera.

- A state change moves nothing.
- A project pausing or resuming repaints that room in place — its lights go on or off; nothing
  rebuilds.
- A tab created or closed rebuilds the floor: room order is kept, but the shelf-packing pass above
  can still move every room that comes after the one whose size changed. The rebuild eases the
  camera to the new framing rather than cutting to it, but only for the room in focus, if one is
  focused — past the very first build, the scene never re-frames the floor view by itself, so a
  person looking around the floor keeps the view they chose. Per-room slide tweens, so a resized
  room does not simply cut its neighbours to a new place, are a follow-up (section 3).

**Walls and depth.** Each room has only its two back walls, and they are partitions rather than
full walls: 28 px high, tall enough to read as a room but low enough that a room in front never
hides the floor and the people of the room behind it — every room and every person must read from
the floor view, and a full-height wall broke that for whatever sat behind it. Depth order is by
tile (`gx + gy`) across the whole city, in one sorted container. Names, markers and progress bars
live in a separate overlay layer above the scene, positioned from the scene's coordinates every
frame — so furniture never covers them.

**Data sources.** Rooms and desks come from the office snapshot endpoint (section 7), so tabs
that never reported a state still get a desk. `useMonitor()` contributes only the live state of
each desk.

**Detail by zoom.** A room's signs show once the camera scale reaches `ROOM_SIGN_SCALE` (0.7) or
the room belongs to the focused machine — inside a machine its own rooms are always named, since
that is what the person is looking at; elsewhere only once the zoom makes the name readable. A
machine's own sign shows the opposite: below `ROOM_SIGN_SCALE`, or whenever the machine is not the
focused one — the name of the machine you are already standing in is redundant until you zoom back
out of it. Never both for the machine the person is inside. Markers show at every zoom, at a fixed
screen size. Desk labels and bars follow the focused room, as in v1.

**Sign anchors.** A room's sign hangs over its own back corner. A machine's sign hangs over its
block's FRONT corner instead: every marker points upward out of its desk, so the ground below the
block's last row is the one part of a block that nothing of its own reaches into, which keeps the
sign clear of its own furniture and keeps it over the machine's own ground rather than drifting
across the street onto the block behind it. Both anchors are lifted above their world point in
SCREEN pixels — the block's world anchor shrinks with the zoom while the sign keeps its screen
size, so a sign that clears what is under it at close range would otherwise land right on top of
it once the camera pulls back; a machine's sign carries the larger lift, room for the diamond
under it to widen enough to hold the text. Past a point a long machine name no longer fits over a
block that has shrunk around a sign that has not: the machine sign's own scale gives way with the
camera, down to a floor of 0.72, never past legibility. Either sign is hidden outright once its
anchor point has left the viewport, or half a sign would stay glued to the screen edge.

**Limits.** Past roughly 600 visible desks, culling of off-screen rooms becomes necessary. The
city draws the whole account, which is still in the tens of desks. Culling is not implemented; the
scene stays organised by block and room so it can be added without restructuring.

## 6. States, animations and the sprite contract

One person per terminal tab. The mapping is a data table, not conditionals spread through the
scene:

| tab | animation | readable from the floor |
|---|---|---|
| `working` | typing, screen flickering | lit screen |
| `waiting_input` | hand raised | yellow "!" bouncing |
| `waiting_permission` | hand raised | orange "!" bouncing |
| `idle` | head down, "z" rising | — |
| `error` | shaking, red | fixed red "×" |
| `state = null` (never reported) | seated, still, dimmed | — |
| `alive = false` | empty chair, screen off | — |

- A simulator tab is a phone on the desk, screen lit when `alive`.
- **Seen.** When `state_seen_at` is later than `state_at`, the hand stays up but the "!" goes
  away — the same rule as the "vistos" group on the home page. The scene calls `tabNeedsYou()`
  from `lib/needs-you.ts`; it does not reimplement the rule.
- **Transitions.** A state change crossfades between sprites in 150 ms. A tab that starts
  waiting gets one pulse on its "!" to catch the eye. There is no sound; the existing toasts
  remain the notification.
- **Overlay.** Room signs, desk labels, markers and progress bars are text carrying its own
  outline, never an opaque plate behind it — anything opaque up in the overlay would hide the
  person or the room standing behind it.

**Sprite contract.** What makes the art replaceable:

- One Pixi spritesheet atlas with fixed frame names: `person/<anim>/body`, `person/<anim>/shirt`,
  `person/hair`, `desk`, `chair`, `monitor/on`, `monitor/off`, `phone/on`, `phone/off`. Animations:
  `sit`, `type`, `raise`, `sleep`, `shake`. Floor tiles and the room walls are not pack sprites at
  all — the scene draws them from colours, so they scale with the room instead of tiling a fixed
  texture; a person is not one sprite per state either, but three tinted layers over one
  silhouette (`body`, `shirt`, `hair`).
- A `manifest.json` next to it declares the tile size, each sprite's anchor (the point that
  touches the tile), frames per second per animation, and the head point of a person (where the
  "!" and the desk's overlay text hang; the click target is the whole desk container).
- The scene knows only the manifest. A pack is meant to live as a folder under
  `apps/web/public/office/<pack>/`, read through that same contract — but v1's pack has no such
  folder: it is painted at runtime, straight onto a canvas, by `office/pack/generated.ts`, which is
  enough for one pack. The folder-based loader is a follow-up, due with the first second pack
  (section 3).
- State colours are a tint applied to a white layer of the sprite (the shirt), not separate
  frames. This cuts the amount of art by the number of states.

**Variety.** Each tab gets a stable look from a hash of `tab.id` (skin and hair tone, four to six
variations by tint): the same tab is always the same person.

**Art for v1: an in-house pack generated by code.** A script builds the atlas as pixel art from
simple shapes — pixel grid, outline, two to four frames per animation. No licence risk, a
consistent style, available immediately. CC0 packs were rejected for v1 because free isometric
characters that sit, type and raise a hand practically do not exist, which would mix two styles;
a commissioned character sheet was deferred for cost and lead time. Both remain possible later
without code changes, through the contract above.

**Accessibility and cost.** With `prefers-reduced-motion`, continuous animations stop; pose and
markers remain. The ticker pauses while the browser tab is hidden.

## 7. Progress

**Checked before planning (2026-09-21).** The brainstorm's first source was the agent's own todo
list, read from the `PreToolUse` hook. On the machine that runs most of this account's agents
(Claude Code 2.1.278), 154 session transcripts from the last ten days hold about 6,000 tool calls
and **not one** `TodoWrite`, `TaskCreate` or `TaskUpdate`. The source does not exist in practice
today, so v1 does not build its ingestion: no change to `monitor/state.ts`, no new columns, no
estimate (the estimate only ever applied to that source). It is recorded for v2, to be revisited
if agents start emitting a list again. Tool input stays discarded, as it is now.

**Two sources, in priority order:**

1. **The kanban.** The task in `doing` whose `Task.tabId` is the tab. If it has subtasks,
   done/total of the subtasks; if it has none, the title only, with no bar.
2. **Nothing.** Without such a task, no bar and no percentage are drawn. No invented progress.

**One read endpoint per machine feeds the whole view.** `useData()` holds machines and projects but no tabs,
and `MonitorProvider` holds only tabs that reported a state. `GET /api/office/:machineId`
returns the floor snapshot: the machine's non-archived projects, every tab of each (with `alive`,
computed from one tmux session probe for the machine), kanban
progress per tab and task counts per project. The probe is what the project tabs route's plain
listing cannot do: an offline agent, a timed-out ssh and a machine whose tmux has no sessions all
answer the same empty set, so the snapshot carries a `reachable` flag and the browser knows when
`alive: false` means nothing. The machine is loaded through
`scoped(repos, request).machine(id)`, the params are validated with zod, and the repositories are
the only path to Prisma. The browser re-reads it on window focus, when the browser tab becomes
visible again, every 60 s while it is visible, and whenever the set
of tab ids the monitor knows about and the snapshot does not **grows** — not on every push: a tab
that can never appear in the snapshot (one that lives in an archived project, say) would otherwise
trigger a re-read forever, since it stays missing after every read. Growth is judged against ids
already asked for, so a tab that stays missing is asked for once, not on every render. Live state
from `useMonitor()` overrides only the state fields (`state`, `state_text`, `state_tool`,
`state_at`, `state_seen_at`), and only while it is the fresher of the two: with the WebSocket down
the monitor's copy ages (it resyncs every 3 min) while the snapshot keeps arriving, so the side
with the newer `state_at` wins. A tab's name, kind, order and everything else always come from the
snapshot — a rename is not pushed over `/ws/monitor`, so only a re-read of the snapshot would ever
carry it to the floor. A snapshot is used only once its `machine.id` matches the route's machine,
closing the one-render window where switching machines would otherwise draw the previous floor.

**Several machines, read in parallel by the browser.** `useOfficeSnapshots(machineIds)` issues one
`GET /api/office/:machineId` per machine, each with its own cadence, staleness guard and error, so
a block appears as soon as its machine answers and a slow or failing machine delays only itself.
A single "whole city" endpoint was rejected: it would answer only after every probe finished, and
one ssh machine that does not respond takes about 8 s to time out. A monitor push naming a tab the
snapshots lack re-reads only that tab's machine. The city is built from the blocks that have
arrived, in machine name order; "Carregando…" shows only while none has.

**The probe is memoised on the server.** The city multiplies probes — one per machine per minute
per open browser tab — so `probeTmuxSessions` results are kept per machine: 15 s for a reachable
answer, 60 s for an unreachable one. Several browser tabs, or the city next to a project page,
share one ssh round-trip, and a machine that stays down costs the account one ssh timeout a
minute instead of one per tab. Concurrent callers for the same machine — two browser tabs polling
in the same second, say — share the one probe already in flight rather than starting a second ssh
round-trip; only a settled result is written into the memo. Only the probe result is memoised;
projects, tabs and tasks are read from the database on every request. The server has no stored
online status for ssh machines (the browser polls it every 30 s), which is why the negative result
is cached here rather than looked up.

**`?fresh=1` bypasses the memo.** `GET /api/office/:machineId?fresh=1` skips the cached probe and
refreshes it, for the one case where the memo would actively mislead: a tab was just opened on the
machine, and a snapshot read within the memo's window would still say "no session" for it, which
the browser would then read as that tab having disappeared rather than as the memo being stale.
The browser sends `?fresh=1` only from `reload(machineId)` — a monitor push naming a tab that
machine's last snapshot does not have — never from its regular polling, so the account pays the
extra ssh round-trip on this path only when a new person really has to be found.

**Display.**

- In a room: a small bar under the desk's label with `3/7`. Hovering a desk, at either level,
  replaces the cut label with the tab's full name and puts the bound task's title on a second line
  under it, over everything else in the overlay. A task without subtasks draws no bar, so hovering
  is the only place it appears at all.
- On the floor: each room's sign shows the project's progress, `done / (todo + doing + done)`;
  the backlog does not count. A project with no tasks in those columns shows no progress.

**Privacy.** The snapshot carries the same `Project`, `Machine` and `Tab` records the person
already receives from `/projects`, `/machines` and `/monitor`, plus the task counts and the bound
task's title. Terminal content stays out, as everywhere else, and the route logs nothing beyond
ids and counts.

## 8. Where it lives in the app

**Route and entry.** `/office` (the city) and `/office/:machineId`, inside `Layout` (the view needs
`DataProvider` and `MonitorProvider`). A sidebar link "Escritório" next to Chat and Integrações,
in the same `NavLink` style, with the same dot the tabs use when someone needs you. The page is
`lazy()`, as in the spike.

**The scene's lifetime.** The Pixi scene is mounted once per visit to `/office`, not once per
render or per machine: it survives every path and query-string change (`/office/:machineId`,
`?room=`, `?focus=1`), which would otherwise tear it down and
rebuild a blank canvas on every click, since `useSearchParams`'s setter gets a new identity on
each change. `OfficePage`'s click handlers reach the current scene through a ref kept up to date
every render, so the mount effect itself never has to depend on them.

**Focus mode.** A button and the `F` key hide the sidebar and the page's top bar, leaving the
scene, the status notices below and a discreet "sair" together in a corner — a second monitor must
never show a frozen picture that looks live. The state is in the URL (`?focus=1`): the use case is
a second monitor left open all day, which must survive a reload. In focus, `Esc` goes up one camera rest at a
time and then leaves focus. It is a small context that `Layout` reads to skip rendering
`Sidebar` — not a second layout, and only `/office` honours it: elsewhere `?focus=1` would hide a
sidebar with nothing on the page to bring it back.

**Permissions.** No new entry in `RESOURCES`: the view is a projection of what the person can
already read. The link and the page require `can('projects', 'read')` and
`can('terminals', 'read')`. `GET /api/office/:machineId` is registered with
`guarded('projects', ...)`; kanban progress is included only with `tasks:read`, and without it
source 2 simply does not exist for that person. A click opens today's terminal URL, which already
enforces its own access.

**States of the page.**

- No machines: a message with a link to enroll the first one.
- Machine offline: its block goes dark and its sign says "offline" — no timestamp,
  `MachineStatus` does not carry one yet; people keep their last known state, since nothing pushes
  anything newer. At the machine and room rests the top bar also says "máquina offline".
- Machine reachable but its tmux not: the snapshot says `reachable: false`, and `alive: false` is
  then not evidence that anyone left. People keep their last known state and their raised hands;
  the block's sign says "sem resposta", and at the machine and room rests the notice "sem resposta
  do tmux: estado pode estar desatualizado" shows. A page-wide banner would not say which machine.
- A machine whose snapshot failed to load: an empty block saying "não foi possível carregar"; the
  rest of the city works.
- WebSocket down: a discreet "reconectando…" strip; the scene keeps the last snapshot, and
  `MonitorProvider` already resyncs.
- The notices sit in the top bar and, in focus mode, in the same corner as "sair do foco".
- No WebGL: Pixi falls back to its canvas renderer by itself; if that fails too, a message with a
  link to the home page.
- The route's chunk gone after a deploy: the lazy import reloads the page once (guarded in
  `sessionStorage` so a broken chunk cannot loop) and a second failure shows a "Recarregar" button
  from an error boundary, instead of unmounting the app into a white screen.

**Code structure.** Each unit has one job:

- `apps/web/src/office/layout/` — `iso.ts`, `shelves.ts` (the packing), `floor.ts`, `city.ts`.
  Pure, tested.
- `apps/web/src/office/model.ts` — `buildModel` (one floor) and `buildCityModel` (every machine,
  each with its floor and its loading status), from the snapshots and `useMonitor`. Pure, tested.
  It is the boundary between React and the scene.
- `apps/web/src/office/useOfficeSnapshots.ts` — the per-machine reads.
- `apps/web/src/office/scene/` — the only place PixiJS is imported outside `office/pack/`:
  `OfficeScene` (draws a city model; `focus(target)` frames the city, a machine or a room),
  `Camera`, `RoomView` (rooms and, now, a block's ground), `PersonView`, `Overlay` (`RoomSign`
  and, now, `MachineSign`). `detail.ts` sits beside them but imports no PixiJS itself — it is the
  pure rule for which signs a given zoom and focus show, unit-tested on its own.
- `apps/web/src/office/pack/` — manifest and atlas loader, and the script that generates the
  in-house atlas.
- `apps/web/src/pages/OfficePage.tsx` — URL state, focus mode, mounting.
- `apps/server/src/routes/office.ts` — the snapshot endpoint, over new repository reads;
  `apps/server/src/terminal/machine-exec.ts` — the tmux probe and its per-machine memo.

**Testing.** Vitest for the layout (`packShelves`, floor, city), `model.ts`, `detail.ts`'s sign
visibility rule, the snapshots hook (a slow machine does not hold the others, a failing one becomes
an error block, a newly missing tab re-reads only its machine), the probe memo (expiry, the longer
negative result, separate keys per machine, concurrent callers sharing one in-flight probe) and the
office route (scope, permissions, progress arithmetic). `OfficePage.test.tsx` pins the behaviour
that is easy to regress by hand-testing only the happy path: one scene instance kept across a visit
to the city, a machine, a room and back up — the canvas is never rebuilt or left blank; the
single-machine ladder, where the city rung does not exist and `Esc` from the machine rest leaves
focus mode directly; the auto-drill rules, including that a machine reached by hand (a clicked
block, a room left with `Esc`) is not auto-drilled into again, while a different machine reached
directly still is; focus mode preserved through every move up and down the ladder; the breadcrumb's
own links, and that its city part is left out with a single machine; and that a machine's own
notices (offline, unreachable tmux) surface in the top bar and, in focus mode, in its corner, but
never in the city rest, where only the block's own sign carries them. The Pixi scene itself is
verified by screenshot through the login-free harness, as in the spike, since jsdom has no WebGL.

**The spike.** `/spike/office` is removed in the same pull request that ships `/office`. `iso.ts`
and its tests are promoted to `office/layout/`; the rest of the spike is deleted; the login-free
harness stays as a development tool.

## 9. Risks

- **Adoption**: a pleasant view nobody opens after a week. The mitigation is usefulness — the
  click-through, the raised hand readable from the floor, focus mode on a second monitor — not
  the animation.
- **Progress will often be empty**: it needs a `doing` task bound to the tab, which today is
  mostly what the concierge and the board's "start in tab" create. Silence is the designed
  fallback, never invented progress.
- **Art effort**: the generated pack is the largest unknown in v1. The contract caps the damage:
  the view can ship with a plain pack and improve by swapping a folder.
- **Probe cost**: the city asks every machine, every minute. The server memo bounds it to one
  probe per machine per 15 s whatever the number of open tabs, and to one ssh timeout a minute
  for a machine that is down.
- **A city of two blocks may feel empty.** Auto-drill covers one machine; with two or three the
  city is sparse but still answers "who needs me, anywhere" in one look, which is its job.
- **Frame rate on real hardware** was not measured by the spike (headless browsers cap it). The
  CPU cost per frame was, and leaves wide margin; the spike's HUD in production gives the real
  number before implementation starts.
