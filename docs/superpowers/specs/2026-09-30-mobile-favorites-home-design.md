# Mobile: pin projects as favorites, and a Home tab — design

Card: **TER-541**. Server (`/api/m/v1`), contract (`@termhub/mobile-api`) and the phone app
(`@termhub/mobile`). No web change, no migration.

Decisions 1 to 3 of the table were taken by the maintainer on 2026-09-30; the others follow from the
code and are written with their reason.

## 1. Problem

Read from the code at `54f4f831`.

The web sidebar has **Favoritos**: a system group of `project_groups` (one per user, ordered
members), toggled by the pin on a project row. The phone shows its projects in the Chats tab, one
row per project, and knows nothing about favorites: `GET /api/m/v1/chat/projects` does not say which
projects are pinned, and the phone has no route to pin one. Someone with many projects scrolls the
whole list to reach the three they work on.

## 2. Decisions

| Topic | Decision | Why |
|---|---|---|
| How to pin on the phone | A pin button on each project row of Chats, and a long press on the row that opens a sheet with the same action. "Chat geral" has neither. | Maintainer's choice. The pin is the web's own affordance; the long press is the platform's habit. |
| Where the app opens | Always on Home, the first tab, with or without favorites. | Maintainer's choice. |
| What Home shows | Only the favorites, in the web's order. No recent projects, no suggestions. | The card: "por enquanto a Home mostra só os favoritos". |
| Same favorite as the web | The Favoritos group of the device's user. Never a "view as" owner's. | Groups are personal (`routes/project-groups.ts` keys them by the signed-in user). |
| Wire shape | `favorite_position: number \| null` on each project of `chat/projects`: `null` is not pinned, otherwise the 0-based place among the pinned projects the phone is shown. One field, so "pinned" and "where" cannot disagree. | The phone sorts Home by it. An installed app ignores the new field (zod strips unknown keys). |
| Older server | The field defaults to `null` in the contract. | A phone newer than its server shows no pins instead of failing to parse. |
| Write route | `PUT /api/m/v1/chat/projects/:id/favorite` with `{ favorite: boolean }`, answering `204`. It states the wanted end state, so a repeat or a double tap is harmless. | The web's `PUT /project-groups/memberships` replaces the whole ordered list, which a phone with a stale list would overwrite. |
| Where a new pin goes | At the end of Favoritos. | What the web's pin does. |
| A read does not write | `GET chat/projects` reads the groups with `read`, which never creates the Favoritos row. The `PUT` creates it on first use. | A `GET` must not write. |
| Which projects can be pinned | Any project of the user (`projects.findByIdsForOwner`), archived or not; anything else is `404`. | The same set the list is built from. Archived ones are hidden from the list by the rule that already exists. |
| No PIN | The write asks for no PIN proof. | It is a personal view preference, as on the web. The PIN guards actions on machines. |
| Pinning in the app | Optimistic: the row changes at once and goes back, with the error banner, when the server refuses. | One tap, no spinner. |
| Unpinning from Home | Home rows carry the same pin and the same long press. | The row is one component; without it a wrong pin could only be undone from another tab. |
| Tapping a Home row | Pushes the project's chat (`/chat/<project id>`) on every window size. | It is the route deep links and notifications already use, iPad included. A second split view is not worth its cost for a short list. |
| Home on a wide window | The readable centred column (`Screen`'s default). | Spec 2026-09-28 iPad §2.4. |
| Back from a conversation with no history | Goes to Chats (`/(tabs)/chats`), not to the tabs' index. | It is what it does today; the index is now Home. |
| Live sync | None. Each side sees the other's change when it reloads its list: the phone on tab focus and pull to refresh, the web on page load. | The list is already reloaded on focus. No event exists for groups. |
| Logs and analytics | Nothing new is logged. The screen names sent to analytics change: `/(tabs)` is now Home and Chats is `/(tabs)/chats`. | Route patterns only, no ids. |

## 3. Shapes

Contract (`packages/mobile-api/src/chat.ts`):

```ts
export const chatProjectItem = z.object({
  // …the fields of today
  /** 0-based place in the person's Favoritos, or null when the project is not pinned. */
  favorite_position: z.number().int().nullable().default(null),
});
export const projectFavoriteBody = z.object({ favorite: z.boolean() });
```

Repository (`ProjectGroupsRepository`):

```ts
/** Pins or unpins one project in Favoritos. Idempotent; a new pin goes last. */
setFavorite(userId: string, projectId: string, favorite: boolean): Promise<void>
```

It creates Favoritos on first use, then in one transaction adds the item at `max(position) + 1` or
deletes it. A racing insert of the same pin (`P2002`) is a success. More than `MAX_ITEMS` members is
the `LIMIT` rule error, answered as `400`.

Server (`routes/m-chat.ts`):

- `GET /projects` adds `favorite_position`: the index of the project in the Favoritos members,
  counted over the projects of the user only, so positions are dense.
- `PUT /projects/:id/favorite`: params and body validated with zod, the project resolved through
  `projects.findByIdsForOwner([id], user.id)` (`404` "Projeto não encontrado"), then `setFavorite`.

App:

- `MobileApi.setProjectFavorite(auth, projectId, favorite)`; the mock server keeps an ordered list of
  pinned ids, answers the same route and fills `favorite_position`. The mock starts with no pins.
- Chat store: `setFavorite(projectId, favorite)` — optimistic write of `favorite_position`
  (`max + 1`, or `null`), rollback and `error` on failure.
- `features/home/model/favorites.ts`: `favoriteProjects(projects)` — the pinned ones, by position. A
  project persisted by an older app version has no field: it counts as not pinned.
- `features/chat/view/project-row.tsx`: the row of Chats, moved out of `chats-screen.tsx`, with the
  pin and the long press. The row is a `View` holding two sibling buttons (the row itself and the
  pin), so a screen reader reaches both.
- `features/chat/view/favorite-sheet.tsx`: the long-press sheet, one action.
- `features/home/view/home-screen.tsx`, routed from `app/(tabs)/index.tsx`; Chats moves to
  `app/(tabs)/chats.tsx`.

## 4. Copy (pt-BR)

| Where | Text |
|---|---|
| Tab | `Home` |
| Home title, section | `Home`, `Favoritos` |
| Pin label, not pinned / pinned | `Fixar <nome> em Favoritos` / `Tirar <nome> de Favoritos` |
| Sheet action | `Fixar em Favoritos` / `Tirar de Favoritos` |
| Empty title | `Nenhum projeto fixado` |
| Empty hint | `Na aba Chats, toque no alfinete de um projeto, ou segure a linha, para fixá-lo aqui.` |
| Empty button | `Ver projetos` (goes to Chats) |
| Write failed | The chat store's usual banner: the server's message, or `Não foi possível falar com o servidor. Tente de novo.` |

The pin labels are the web's (`Fixar em Favoritos`, `Tirar de Favoritos`) with the project's name.

## 5. Impact on other users

- **Default, for everyone, once they install the next app build:** a new first tab, Home, and the app
  opens on it. Someone who never pinned a project sees the empty state and is one tap ("Ver
  projetos", or the Chats tab) away from the list the app used to open on. This is a product decision
  of the maintainer, not an opt-in.
- Favorites are per user: nothing is pinned for anyone, and one person's pins are never another's.
- The server change alone changes nothing for anyone: the installed app ignores the new field and
  never calls the new route. The web is not touched.

## 6. Tests

- Repository (Postgres): `setFavorite` pins last, is idempotent both ways, creates Favoritos on
  first use, keeps other users' groups untouched.
- Route: `GET /projects` carries dense positions in group order and `null` for the rest, and never
  calls `list`; `PUT` pins and unpins, `404` for a project of someone else, `400` for a bad body.
- Contract: the default for a server that sends no field.
- App logic: `favoriteProjects`, the store's optimistic write and its rollback, the mock route.
- App screens: the pin and the long press on Chats; Home's list, order, empty state, navigation and
  unpin; the tab bar's first tab.
- By hand on the simulator: iPhone and iPad, mock mode.

## 7. Out of scope

- Reordering favorites on the phone (the web's drag and drop stays the only way).
- Recent or suggested projects on an empty Home.
- Tab and agent state per project on Home: the phone's API has the chat's state only (answering,
  pending confirmations, last message), and that is what the row shows.
- Live sync of pins between the web and the phone.
- A TestFlight or Play build.
