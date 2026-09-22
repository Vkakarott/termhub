# The public city: showing what your robots are doing — design

Date: 2026-09-22. Status: **implemented on `feat/public-city`, pending review and merge.**
The link preview card (`GET /api/public/city/:nickname/card.png`) rasterises with Alpine's
`rsvg-convert` and `font-inter` `apk` packages — the same ones `apps/landing/og/build.sh` already
uses on `alpine:3.20` — since the server's runtime image is `node:22-alpine`, not the Debian package
names (`librsvg2-bin`) a rasteriser is more commonly reached for. The card's mark is a small,
self-contained redraw of `public/logo.svg`'s terminal-window icon (no `<image href>`, so rasterising
the card needs no second file on disk); it does not reproduce that logo's full outlined wordmark path.
Builds on `2026-09-21-office-world-design.md` (the office city, in production) and
`2026-09-22-agent-activity-design.md` (the activity under each person, in production).

## 1. Goal

A person marks one of their projects as public. That publishes the city: the machine that hosts
the project, that project's room, and every tab in it. Anyone with the link watches the robots
work — the same picture the owner sees at `/office`, on a page that needs no account and does not
pass through Cloudflare Access.

The link is meant to be shared. Someone who has never heard of termhub lands on a living city,
sees what the machines are doing right now, and finds the way in.

Success:

- The owner of a machine flips one switch in the product and the link works immediately.
- A visitor with no account sees the robots move and their activity labels change live, within a
  second or two of the change, with no reload.
- Nothing private travels. The public payload is built field by field by a mapper of its own, so
  a field added to `Tab` later cannot reach the public wire by accident.
- Turning the switch off is immediate: the link answers 404 and the open public sockets drop.

## 2. What exists today

Verified in the repo on 2026-09-22:

- **The office.** `buildOfficeSnapshot` (`apps/server/src/office/snapshot.ts`) returns the floor of
  **one** machine: the machine, a room per non-archived project, its tabs, and the board's task
  counts when the person may see them. The city across machines is assembled in the browser
  (`useOfficeSnapshots` + `buildCityModel`), and the routes are `/office` (the city),
  `/office/:machineId` (one building) and `?room=<projectId>` (one room). The scene is PixiJS under
  `apps/web/src/office/scene/`.
- **The activity.** `Tab.activity` carries one of six categories, set while a tab is working and
  cleared when it leaves working; the office overlay shows it in pt-BR under the person.
- **The live push.** `monitorBus` feeds `/ws/monitor` (`apps/server/src/monitor/ws.ts`), which sends
  one message per tab change, filtered by the caller's scope. The upgrade router
  (`apps/server/src/ws/router.ts`) already distinguishes authenticated routes from **public** ones
  (`PublicUpgradeHandler`: "public upgrade routes authenticate themselves; no cookie user/scope"),
  and rejects a browser whose `Origin` does not match the served host.
- **Public REST routes.** Everything under the API is authenticated by `buildAuthHook` unless the
  route declares `config: { public: true }` — how `/api/hooks/events`, `/mcp` and `/api/waitlist`
  work today. Office routes are guarded under the `projects` resource.
- **Ownership.** A `Machine` has an `ownerId`; everything under it (projects, tabs, tasks, notes, AI
  accounts) is visible only to that owner and to admins acting as them. A `Project` belongs to a
  machine. A `User` has no nickname today.
- **Deployment.** `termhub.dev` / `www.termhub.dev` is the landing host and has **no Access**: it
  serves the static landing container at `/`, plus one `location` per public path proxied to the app
  container (`/api/waitlist`, `/api/hooks/events`, `/mcp`), each with a per-client request budget.
  `app.termhub.dev` is the app, behind Access. Both the app and the landing are Vite SPAs that serve
  their files from `/assets/`. The landing already carries `og/` and `brand/`.

## 3. Scope

**In:** the public switch on a project; the nickname that addresses a city; a public snapshot and a
public websocket, both built by a mapper of their own; the public page at
`termhub.dev/city/@nickname` with the same three depths as `/office`; the share button; the link's
preview card; the sign-up call to action on the public page.

**Out (recorded for later):** choosing which tabs of a public project appear — a public project
publishes all of them, by design; terminal content, which never becomes public at any setting;
comments, reactions or visitor counters; a directory of public cities; custom domains; more than one
owner per machine.

## 4. What "public" means

**The switch is on the project.** `Project` gains `isPublic Boolean @default(false)`. The person who
flips it is the **owner of the machine that hosts the project** — the relation the database already
uses to decide who sees what. An admin acting as that owner inherits it, as everywhere else.

**Publishing one project publishes three things at once**, and the switch's own screen must say so in
plain words before it flips:

- the project — its name;
- the machine that hosts it — its name, and the fact that it exists;
- every tab in that project, with the same fields the office shows today: the tab's name, its state,
  its activity, its progress, and the project's task counts.

The owner's own nickname and display name become public with the first project, since the page says
whose city it is. Nothing else about the account travels: not the email, not the role, not the other
machines.

**Parity with `/office` is a deliberate decision, and it carries a cost the owner accepts.** Tab names
and the bound task's title are free text, written for oneself and not for an audience: they carry
client names, ticket numbers and worse. The alternative — a robot with no name, only its activity —
was considered and set aside, because the point of the city is to be legible. The switch says what
becomes readable; the person decides.

**The address is a nickname.** `User` gains `nickname String? @unique`: lowercase letters, digits and
hyphens, 3 to 30 characters, not one of the reserved words the routes need (`city`, `api`, `ws`,
`admin`, `www`, `static`, `assets`). It is asked **at sign-up**, as part of creating the account, and
asked once on the first publish for accounts that predate it. A city exists when its owner has a
nickname and at least one public project; until then the switch asks for the nickname rather than
failing.

## 5. The public surfaces

Three of them, all on the host that has no Access, all declared public on the server.

**`GET /api/public/city/:nickname`** — the snapshot: the machines that host public projects, the
public rooms of each, and the robots of each room. It reads the same data the office reads, but it is
**not** the office snapshot with fields removed. It is built by a mapper of its own —
`toPublicCity` — that names every field it emits. That is the whole privacy design: a field added to
`Tab`, `Project` or `Machine` tomorrow does not appear here unless someone writes it in.

**`/ws/public/:nickname`** — the live channel, registered as a public upgrade route, subscribing to
the same `monitorBus` that already receives the hook events. It publishes a change only when the
change belongs to a public project of that city, and it publishes it through the same mapper. It is
not `/ws/monitor` with a filter: a visitor never reaches the channel a signed-in person uses, and the
two payloads are different types.

**`termhub.dev/city/@nickname`** — the page, in the same three depths as `/office`:
the city, `/city/@nickname/<machine>` one building, and `?room=<project>` one room. The share button
in the app copies the link for the depth the person is looking at.

Two rules that belong to these surfaces:

- **Opaque identifiers.** The public payload carries no real machine, project or tab id. Each is
  replaced by an id derived for the city (an HMAC of the real id with a server secret, truncated),
  stable while the page is open and across reconnects, and useless anywhere else. A real id in a
  visitor's hands is an invitation to try the private route that takes it.
- **Unpublishing is immediate.** Turning the switch off drops the room from the snapshot, makes a
  deep link to it answer 404, stops its changes on the channel, and closes the public sockets that
  were watching it. Otherwise whoever already had the tab open keeps watching something that is no
  longer public.

The nginx `location` blocks follow the ones that already exist for the waitlist and the hooks: a
per-client request budget on the snapshot, a cap on concurrent anonymous sockets, and a small payload
limit. **Nothing changes in Cloudflare Access**: Access is bound to `app.termhub.dev`, and these paths
live on `termhub.dev`, which has none.

## 6. The bundle that ships

The app and the landing are two Vite SPAs, both serving their files from `/assets/`. Pointing
`/city/` at the app container would put the two in the same asset path, and one would break the
other.

So the public page is a **second entry point built from the app's own source**, with base `/city/`.
It imports the same office scene — the same drawing, the same people, the same camera — and is built
into its own directory, served by the app container under `/city/`. The separation is not cosmetic:
what ships to the street does not contain the private router, the private API client or the sidebar.
They are not hidden there; they are not there.

## 7. What the visitor sees

The city, exactly as the owner sees it, minus everything that is not public. The same scene, the same
labels, the same movement. No sidebar, no actions, no terminal — the camera and the three depths are
all a visitor gets.

Above it, one slim bar: whose city this is, and an invitation to create an account. The landing
already has the waitlist form and its public route, so the call to action leads somewhere that exists
rather than to a page to be built.

The link's preview card is rendered per depth — the city, a building or a room — with the city's
name and what is happening in it. The landing already keeps its cards under `og/`, and these follow
the same path.

A machine with no public project is not in the payload. A city whose owner has published nothing, or
whose nickname does not exist, answers 404 — not an empty city, which would confirm the nickname.

## 8. Risks

- **The free text is the real exposure, and it was accepted knowingly.** Tab names and task titles are
  written for oneself. The switch's screen is the only place that can warn, so its words matter more
  than the code around them.
- **Anonymous sockets cost more than anonymous requests.** A public city that gets attention holds
  open connections for people who will never sign in. The per-client budget and the connection cap
  are the whole defence; if that is not enough, the fallback is to serve the public city from a
  cached snapshot with a slower refresh, which is a change of one layer, not of the design.
- **A "needs you" marker reveals rhythm.** A visitor can tell when a person is away from their
  machine. That is the honest consequence of showing a living city.
- **Nicknames are claimed first-come inside the instance**, and a claimed nickname is an address
  someone else cannot have. Reserved words are handled; squatting between users of one instance is
  not, and does not need to be yet.
- **Two bundles drift.** The public entry can fall behind the app's scene when the scene changes. It
  imports the same modules rather than copying them, which is what keeps the drift to the entry
  point itself.

## 9. Testing

- **The mapper**: for a city with a public and a private project, the output contains the public
  room and nothing of the private one — asserted by comparing the emitted keys against the DTO, so a
  new field on `Tab` fails the test instead of leaking.
- **The snapshot route**: an unknown nickname 404s; a nickname whose projects are all private 404s;
  the ids in the body match no real id in the database.
- **The channel**: a change on a public tab arrives; a change on a private tab of the same machine
  does not; flipping the switch off closes the socket.
- **The switch**: only the machine's owner may flip it; flipping it without a nickname asks for one
  instead of publishing.
- **The bundle**: the built public entry does not contain the private API client — asserted over the
  build output, not by reading the source.
- **The page**: the three depths render from a public snapshot with no session, and the share button
  produces the link for the depth being viewed.
