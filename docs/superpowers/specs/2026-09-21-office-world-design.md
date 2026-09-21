# Office world: an animated, navigable view of a machine's projects and tabs — design

Date: 2026-09-21. Status: **design approved section by section in conversation; awaiting review
of this written spec.** Supersedes the open questions of
`2026-09-19-office-world-brainstorm.md`, which stays as the record of the idea.

## 1. Goal

A view where one machine's work is drawn as an isometric pixel-art office floor: each project is
a room, each terminal tab is a person at a desk, each simulator tab is a phone on a desk. It is
functional, not decorative. It answers, at a glance and from across the room: what is being
worked on, who needs you, how far along each piece of work is — and it takes you to the terminal
with one click.

Success for v1:

- Opening `/office` shows every project and tab of a machine, live, with no reload needed for a
  state change to show.
- A tab that starts needing you is noticeable from the floor view without reading any text.
- Clicking a person opens that tab's terminal; clicking a room sign opens the project.
- Progress is shown only when it comes from a real source, and says which source.
- The main bundle does not grow: the renderer loads only when the view opens.

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

**In v1:** the floor of one machine and its rooms, the camera between the two, live states,
progress from the agent's todo list and from the kanban, the estimate for the agent source, the
`/office` route with focus mode, an in-house generated art pack, removal of the spike.

**Out of v1, recorded for v2:** the world level (machines as buildings on a street), an estimate
for kanban progress, an accumulator for incremental task tools if section 7's check shows it is
needed, culling of off-screen rooms, third-party or commissioned art packs, sound.

## 4. Levels and navigation

**One continuous scene per machine, not separate screens.** The whole floor is one scene: the
projects' rooms side by side with the people inside. Entering a room is a camera move (eased zoom
and pan), not a scene change. Separate scenes per level were rejected: they need fake
transitions and they hide a raised hand in another room.

Two camera rests:

- **Floor.** All rooms framed. People are small and unlabelled. The marker of someone who needs
  you keeps a fixed size on screen, so it reads from far away. Each room has a sign with the
  project name, its progress (section 7) and a counter such as "2 precisam de você".
- **Room.** One room framed: tab names, progress bars and full animations.

Interaction:

- On the floor, clicking a room moves the camera into it.
- `Esc`, a "voltar ao andar" button, or zooming out past a threshold returns to the floor.
- Clicking a person's head opens the terminal in a new browser tab at
  `/projects/<projectId>?tab=<tabId>`, at both levels.
- Clicking a room's sign opens the project (`/projects/<projectId>`).
- Wheel zoom (at the cursor) and drag pan stay free at all times. A drag longer than a few
  pixels never counts as a click.

**Auto-drill.** A machine with exactly one project that has tabs opens straight into that
room. An account with a single machine opens straight into that machine.

**Several machines in v1.** A selector at the top switches machine; each entry shows a dot when
someone on that machine needs you. The v2 world level replaces the selector.

**URL is the state.** `/office` (auto-drill), `/office/:machineId`, `?room=<projectId>`,
`?focus=1`. Reloading or sharing the link lands in the same place; the browser's back button
leaves the room.

**Which rooms exist.** `active` projects always get a room, empty and lit when they have no
tabs. `paused` projects get a dark room. `archived` projects are not drawn.

## 5. Generated layout

Everything is derived from data by pure functions with no renderer in them:
`layoutRoom(tabCount)` and `layoutFloor(rooms[]) → { rooms[], bounds }`. The scene only draws the
result. This is the part that survives a change of art or renderer.

**Desks in a room.** As in the spike: rows of desks with a one-tile aisle around each, the room a
little wider than deep. Desk order is `Tab.position`, the same order as the tab bar, so the third
tab is always the third desk. Room size follows the tab count, with a minimum of 5×3 tiles.

**Rooms on the floor.** Rooms have different sizes, so they are placed by shelf packing: in
`Project.position` order, filling a row up to a target width and then starting the next row,
with a two-tile corridor between rows and one tile between neighbours. The target width is chosen
so the projected floor is close to the screen's proportion (about 16:10). A uniform grid was
rejected for wasting space when one room has twelve tabs and another has one; a treemap was
rejected for reordering rooms on every change.

**Stability.**

- A state change moves nothing.
- A tab created or closed rebuilds that room. If the room's size changed, the floor is repacked
  and rooms slide to their new place with a tween of about 300 ms; nothing teleports.
- During a repack the camera follows the room in focus, so the framing is not lost.

**Walls and depth.** Each room has only its two back walls; nothing in front covers the people.
Depth order is by tile (`gx + gy`) across the whole floor, in one sorted container. Names,
markers and progress bars live in a separate overlay layer above the scene, positioned from the
scene's coordinates every frame — so furniture never covers them.

**Data sources.** Rooms and desks come from `useData()` (projects and their tabs), so tabs that
never reported a state still get a desk. `useMonitor()` contributes only the live state of each
desk.

**Limits.** Past roughly 600 visible desks, culling of off-screen rooms becomes necessary. No
account is near that. v1 does not implement culling; it keeps the scene organised by room so
culling can be added without restructuring.

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

**Sprite contract.** What makes the art replaceable:

- One Pixi spritesheet atlas with fixed frame names: `person/<anim>/<n>`, `desk`, `chair`,
  `monitor/on`, `monitor/off`, `phone/on`, `phone/off`, `floor/a`, `floor/b`, `wall/left`,
  `wall/right`. Animations: `sit`, `type`, `raise`, `sleep`, `shake`.
- A `manifest.json` next to it declares the tile size, each sprite's anchor (the point that
  touches the tile), frames per second per animation, and the head point of a person (used to
  place the "!" and as the click target).
- The scene knows only the manifest. A pack lives in `apps/web/public/office/<pack>/`; changing
  the art is changing that folder.
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

## 7. Progress and estimate

Today `interpretClaude` in `apps/server/src/monitor/state.ts` receives `PreToolUse` and keeps only
the fact that the tab is busy; the tool input is discarded on purpose, because it is content.

**Three sources, in priority order:**

1. **The agent's own todo list.** When a `PreToolUse` event is for the `TodoWrite` tool, its
   `tool_input.todos` carries the whole list with statuses. The server extracts exactly three
   things — the count done, the total, and the title of the `in_progress` item capped at 120
   characters — and drops the rest. The full list is never stored and never logged. This is an
   explicit, narrow exception to the discard rule and is documented as such in `state.ts`.
2. **The kanban.** With no agent progress, the task in `doing` whose `Task.tabId` is the tab.
   If it has subtasks, done/total of the subtasks; if it has none, the title only, with no bar.
3. **Nothing.** With neither, no bar, no percentage, no estimate is drawn.

**To be checked first in implementation.** Recent Claude Code versions replaced `TodoWrite` with
incremental tools (`TaskCreate`, `TaskUpdate`) that send one change at a time instead of the
list. Counting with those needs a per-session accumulator on the server and possibly the
`PostToolUse` hook, since a task's id exists only in the tool's response. The first task of the
plan captures real payloads from the enrolled machines to see which shape arrives. If it is the
incremental one, v1 supports `TodoWrite` where it exists and falls back to the kanban elsewhere;
the accumulator becomes its own follow-up and does not block the view. Codex has no equivalent
and always falls back to the kanban.

**Storage.** Four nullable columns on `Tab`: `progress_done`, `progress_total`,
`progress_label`, `progress_started_at`. The migration is additive, so the previous container
keeps working during the blue/green switch. The columns are cleared on `SessionStart` and
`SessionEnd`. The `/ws/monitor` push already carries the `Tab`, so the fields reach the browser
with no protocol change.

**Kanban in the browser.** One read endpoint, `GET /api/office/:machineId`, returns kanban
progress per tab and task counts per project. The machine is loaded through
`scoped(repos, request).machine(id)`, the params are validated with zod, and the repositories are
the only path to Prisma. The browser re-reads it on window focus and every 60 s; the kanban
changes slowly and does not need a push.

**Display.**

- In a room: a small bar over the desk with `3/7`, and the active item's title on hover. When the
  list completes, the bar turns green for a few seconds and then goes away.
- On the floor: each room's sign shows the project's progress, `done / (todo + doing + done)`;
  the backlog does not count.
- A small icon tells the agent's list from the kanban, so the origin of a number is visible.

**Estimate.** Only for source 1 and only once `done ≥ 2`: time elapsed since
`progress_started_at`, divided by `done`, times what is left. Shown rounded and with a tilde
(`~5 min`, `~20 min`, `~1 h`), never as a countdown. It freezes while the tab is waiting for the
person, since that time is not the agent's. The kanban has no estimate in v1: human tasks have
no cadence that would make a number honest.

**Privacy.** The only text that travels is names and titles already shown on the home page and
the board, plus the active item's title. Terminal content stays out, as everywhere else.

## 8. Where it lives in the app

**Route and entry.** `/office` and `/office/:machineId`, inside `Layout` (the view needs
`DataProvider` and `MonitorProvider`). A sidebar link "Escritório" next to Chat and Integrações,
in the same `NavLink` style, with the same dot the tabs use when someone needs you. The page is
`lazy()`, as in the spike.

**Focus mode.** A button and the `F` key hide the sidebar and the page's top bar, leaving the
scene and a discreet "sair" in a corner. The state is in the URL (`?focus=1`): the use case is a
second monitor left open all day, which must survive a reload. In focus, `Esc` first leaves the
room and then leaves focus. It is a small context that `Layout` reads to skip rendering
`Sidebar` — not a second layout.

**Permissions.** No new entry in `RESOURCES`: the view is a projection of what the person can
already read. The link and the page require `can('projects', 'read')` and
`can('terminals', 'read')`. `GET /api/office/:machineId` is registered with
`guarded('projects', ...)`; kanban progress is included only with `tasks:read`, and without it
source 2 simply does not exist for that person. A click opens today's terminal URL, which already
enforces its own access.

**States of the page.**

- No machines: a message with a link to enroll the first one.
- Machine offline: the floor with the lights off and people still at their last known state,
  with "offline desde …".
- WebSocket down: a discreet "reconectando…" strip; the scene keeps the last snapshot, and
  `MonitorProvider` already resyncs.
- No WebGL: Pixi falls back to its canvas renderer by itself; if that fails too, a message with a
  link to the home page.

**Code structure.** Each unit has one job:

- `apps/web/src/office/layout/` — `iso.ts`, `floor.ts`. Pure, tested.
- `apps/web/src/office/model.ts` — builds the scene model from `useData`, `useMonitor` and the
  progress data. Pure, tested. It is the boundary between React and the scene.
- `apps/web/src/office/scene/` — `OfficeScene`, `Camera`, `RoomView`, `PersonView`, `Overlay`.
  The only code that knows PixiJS.
- `apps/web/src/office/pack/` — manifest and atlas loader, and the script that generates the
  in-house atlas.
- `apps/web/src/pages/OfficePage.tsx` — URL state, focus mode, mounting.
- `apps/server/src/monitor/state.ts` — the `TodoWrite` extraction;
  `apps/server/src/routes/office.ts` — the read endpoint.

**Testing.** Vitest for the layout, `model.ts` and the server's `TodoWrite` interpretation,
including a case asserting that the full list reaches neither the database nor the log. The Pixi
scene is verified by screenshot through the login-free harness, as in the spike, since jsdom has
no WebGL. The migration is tested against the previous release.

**The spike.** `/spike/office` is removed in the same pull request that ships `/office`. `iso.ts`
and its tests are promoted to `office/layout/`; the rest of the spike is deleted; the login-free
harness stays as a development tool.

## 9. Risks

- **Adoption**: a pleasant view nobody opens after a week. The mitigation is usefulness — the
  click-through, the raised hand readable from the floor, focus mode on a second monitor — not
  the animation.
- **The todo source may not exist** on current Claude Code versions (section 7). The design
  degrades to the kanban and to silence, never to invented progress.
- **Art effort**: the generated pack is the largest unknown in v1. The contract caps the damage:
  the view can ship with a plain pack and improve by swapping a folder.
- **Frame rate on real hardware** was not measured by the spike (headless browsers cap it). The
  CPU cost per frame was, and leaves wide margin; the spike's HUD in production gives the real
  number before implementation starts.
