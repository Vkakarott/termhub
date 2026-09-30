# Mobile favorites and Home tab — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pin projects as favorites from the phone's Chats list (the web's Favoritos) and add a Home tab, first in the bar, that lists only the favorites.

**Architecture:** The phone's project list (`GET /api/m/v1/chat/projects`) gains `favorite_position`, read from the user's Favoritos group; a new idempotent `PUT /api/m/v1/chat/projects/:id/favorite` writes it through a new repository method. The app keeps the projects in the chat store it already has, adds an optimistic `setFavorite`, a shared project row with a pin and a long-press sheet, and a Home screen that filters the same list.

**Tech Stack:** Fastify + zod + Prisma (server, vitest), `@termhub/mobile-api` (zod contract, vitest), Expo / expo-router / zustand / NativeWind (app, jest with the `logic` and `ui` projects).

**Spec:** `docs/superpowers/specs/2026-09-30-mobile-favorites-home-design.md`

**Execution:** inline, in this session, test first (chosen by the maintainer on 2026-09-30).

## Global Constraints

- UI copy in pt-BR, exactly as spec §4. Code, comments, commits and docs in English.
- Routes never import Prisma; every request input is validated with zod.
- The favorite is the device user's own (`request.scope.user.id`), never a "view as" owner's.
- `GET chat/projects` must not write: it reads groups with `projectGroups.read`, never `list`.
- No migration, no new native dependency (no new app build is needed to keep today's app working).
- App viewmodels and models import neither React Native nor `expo-router` (the `logic` jest project fails otherwise).
- The mobile app reads the contract from `packages/mobile-api/dist`: run `npm run build -w @termhub/mobile-api` after every contract change.

## Review Focus

1. A project persisted by an older app build has no `favorite_position` (it is `undefined`, the store is not re-parsed): it must count as not pinned and must not break the sort. Test in Task 5 (`favoriteProjects`).
2. Two taps on the pin before the first answer: the end state is the last tap's, and a failed earlier request must not undo a later one. Test in Task 5 (store).
3. Favoritos holds members the phone is not shown (archived, or of another scope): positions stay dense over the shown ones. Test in Task 3 (route).
4. The write fails (offline, `404`): the row goes back and the banner says why. Test in Task 5 (store).
5. A project unpinned on the web while Home is open: it leaves Home on the next focus. Test in Task 7 (Home reloads on focus).

---

### Task 1: Contract

**Files:** Modify `packages/mobile-api/src/chat.ts`; Test `packages/mobile-api/src/chat.test.ts`.

**Produces:** `chatProjectItem.favorite_position: number | null` (default `null`), `projectFavoriteBody = z.object({ favorite: z.boolean() })`, type `TProjectFavoriteBody`.

- [ ] Failing tests: `chatProjectsResponse` parses a project with no `favorite_position` to `null`, keeps `2`, refuses `1.5`; `projectFavoriteBody` accepts `{ favorite: true }`, refuses `{}` and `{ favorite: 'yes' }`.
- [ ] Run `npm test -w @termhub/mobile-api` — fails (`projectFavoriteBody` is not exported).
- [ ] Implement:

```ts
export const chatProjectItem = z.object({
  id: z.string(),
  name: z.string(),
  key: z.string(),
  busy: z.boolean(),
  pending_confirmations: z.number().int(),
  last_message_at: z.string().nullable(),
  /** 0-based place in the person's Favoritos (the web sidebar's group), or null when the project is
   * not pinned. Defaults to null so an app newer than its server shows no pins instead of failing. */
  favorite_position: z.number().int().nullable().default(null),
});
/** `PUT chat/projects/:id/favorite`: the wanted end state, so a repeat is harmless. */
export const projectFavoriteBody = z.object({ favorite: z.boolean() });
export type TProjectFavoriteBody = z.infer<typeof projectFavoriteBody>;
```

- [ ] Tests pass; `npm run build -w @termhub/mobile-api`. Commit `Mobile API: favorite position on chat projects`.

### Task 2: Repository

**Files:** Modify `apps/server/src/db/repositories/project-groups.ts`; Test `apps/server/src/db/repositories/project-groups.db.test.ts` (Postgres, `TERMHUB_DB_TESTS=1`).

**Produces:** `ProjectGroupsRepository.setFavorite(userId: string, projectId: string, favorite: boolean): Promise<void>`.

- [ ] Failing tests (same fixture as the file's other tests: `userId`, `otherId`, `p[0..2]`):
  - pins on first use create Favoritos and append: `setFavorite(u, p[1], true)`, `setFavorite(u, p[0], true)` → `read(u)` favorites `project_ids` is `[p[1], p[0]]`.
  - idempotent: pinning `p[1]` again keeps `[p[1], p[0]]`; unpinning `p[2]` (never pinned) changes nothing.
  - unpin removes only that one: `setFavorite(u, p[1], false)` → `[p[0]]`.
  - another user's Favoritos is untouched: `read(otherId)` is `[]`.
  - two racing pins of the same project both resolve and leave one item.
- [ ] Run against a throwaway Postgres (`th-test-db`) — fails (`setFavorite` is not a function).
- [ ] Implement:

```ts
  /** Pins or unpins one project in Favoritos: states the end result, so a repeat is a no-op. A new
   *  pin goes last, as the sidebar's pin does. The phone's write: it changes one member without
   *  sending the whole list, which a stale phone would otherwise overwrite. */
  async setFavorite(userId: string, projectId: string, favorite: boolean): Promise<void> {
    await this.ensureFavorites(userId);
    try {
      await this.db.$transaction(async (tx) => {
        const fav = await tx.projectGroup.findUniqueOrThrow({ where: { userId_systemKey: { userId, systemKey: FAVORITES_KEY } }, select: { id: true } });
        if (!favorite) {
          await tx.projectGroupItem.deleteMany({ where: { groupId: fav.id, projectId } });
          return;
        }
        const agg = await tx.projectGroupItem.aggregate({ where: { groupId: fav.id }, _max: { position: true }, _count: true });
        if (await tx.projectGroupItem.findUnique({ where: { groupId_projectId: { groupId: fav.id, projectId } } })) return;
        if (agg._count >= MAX_ITEMS) throw new ProjectGroupRuleError('LIMIT', `Limite de ${MAX_ITEMS} projetos por grupo`);
        await tx.projectGroupItem.create({ data: { groupId: fav.id, projectId, position: (agg._max.position ?? -1) + 1 } });
      });
    } catch (e) {
      // the other racer pinned it first: it is pinned, which is all we wanted
      if ((e as { code?: string }).code !== 'P2002') throw e;
    }
  }
```

- [ ] Tests pass. Commit `Project groups: pin or unpin one favorite`.

### Task 3: Server routes

**Files:** Modify `apps/server/src/routes/m-chat.ts`; Test `apps/server/src/routes/m-chat.test.ts` (the harness gains `repos.projectGroups = { read, list, setFavorite }` and a `favorites?: string[]` option).

**Consumes:** Task 1's schemas, Task 2's `setFavorite`, `projectGroups.read(userId)`.

- [ ] Failing tests:
  - `GET /chat/projects` with `favorites: ['p2', 'gone', 'p1']` → `p2` has `favorite_position: 0`, `p1` has `1` (dense: `gone` is not a project of the user); with no Favoritos row every project has `null`; `projectGroups.read` was called with `'u1'` and `list` never.
  - the existing `toEqual` of `GET /chat/projects` gains `favorite_position: null`.
  - `PUT /chat/projects/p1/favorite { favorite: true }` → `204`, `setFavorite('u1', 'p1', true)`; `{ favorite: false }` → `204`, `setFavorite('u1', 'p1', false)`.
  - `PUT` for a project `findByIdsForOwner` does not return → `404`, `setFavorite` not called.
  - `PUT` with `{}` → `400`.
  - with `viewAsOwner: 'u2'` the write still goes to `'u1'`'s Favoritos (groups are the signed-in user's).
  - a `LIMIT` rule error → `400`.
- [ ] Run `npx vitest run src/routes/m-chat.test.ts` in `apps/server` — fails.
- [ ] Implement in `mobileChatRoutes`: read the groups next to the three reads of `GET /projects`, build `placeOf` from the favorites' members filtered to the listed projects; add the `PUT` with `projectIdParam = z.object({ id: z.string().min(1).max(64) })`, `projectFavoriteBody.parse(request.body)`, `findByIdsForOwner([id], user.id)` → `notFound('Projeto não encontrado')`, `ProjectGroupRuleError` → `HttpError(400, e.message, e.code)`, `reply.code(204).send()`.
- [ ] Tests pass; `npm run typecheck -w @termhub/server`. Commit `Mobile chat: favorite position and a route to pin a project`.

### Task 4: App API and mock server

**Files:** Modify `apps/mobile/src/services/api/types.ts`, `client.ts`, `mock/state.ts`, `mock/handlers/chat.ts`; Test `apps/mobile/src/services/api/mock/chat.e2e.test.ts`.

**Produces:** `MobileApi.setProjectFavorite(auth: Auth, projectId: string, favorite: boolean): Promise<void>`; `MockState.favorites: string[]` (pinned project ids, in order; starts empty).

- [ ] Failing tests: a fresh mock lists every project with `favorite_position: null`; after `setProjectFavorite(auth, 'p-reactivando', true)` then `'p-termhub'`, `chatProjects` gives positions `0` and `1`; pinning twice keeps one entry; unpinning the first makes `p-termhub` `0`; an unknown project rejects with status `404`.
- [ ] Run `npx jest --selectProjects logic src/services/api/mock/chat.e2e.test.ts` in `apps/mobile` — fails.
- [ ] Implement: `setProjectFavorite: (a, projectId, favorite) => empty('PUT', \`/api/m/v1/chat/projects/${encodeURIComponent(projectId)}/favorite\`, { token: a.accessToken, body: { favorite } })`; the mock route verifies auth with `htm: 'PUT'`, parses `projectFavoriteBody`, `404 NOT_FOUND 'Projeto não encontrado'`, edits `state.favorites`, answers `204`; `GET projects` adds `favorite_position: indexOf` or `null`.
- [ ] Tests pass. Commit `Mobile: API client and mock for project favorites`.

### Task 5: App model and store

**Files:** Create `apps/mobile/src/features/home/model/favorites.ts` (+ `.test.ts`); Modify `apps/mobile/src/features/chat/viewmodel/createChatStore.ts`; Test `createChatStore.test.ts`.

**Produces:**

```ts
// features/home/model/favorites.ts
export function isFavorite(project: { favorite_position?: number | null }): boolean;
/** The pinned projects, in Favoritos order. */
export function favoriteProjects<T extends { favorite_position?: number | null }>(projects: T[]): T[];
// ChatState
setFavorite(projectId: string, favorite: boolean): Promise<void>;
```

- [ ] Failing tests, model: sorts by position and drops `null`; a project with no field (older persisted state) is not pinned and does not throw; the input array is not mutated.
- [ ] Failing tests, store:
  - `setFavorite('p-termhub', true)` sets `favorite_position` before the request answers (assert right after the call, before awaiting) and the mock lists it pinned afterwards.
  - a second pin goes after the first (`0`, then `1`); unpin sets `null`.
  - failure (`jest.spyOn(api, 'setProjectFavorite').mockRejectedValueOnce(new ApiError(404, 'NOT_FOUND', 'Projeto não encontrado'))`) restores the previous value and sets `error` to the message.
  - pin then unpin at once, the pin's request failing late: the project ends not pinned (the failed request's rollback does not overwrite the later tap).
- [ ] Run `npx jest --selectProjects logic src/features/home src/features/chat/viewmodel/createChatStore.test.ts` — fails.
- [ ] Implement `setFavorite`: compute `before` and `next` (`max(position) + 1` or `null`), `set` the projects, call the API; on failure put `before` back only when the project still holds `next`, then `fail(gen, e)`.
- [ ] Tests pass. Commit `Mobile: favorites in the chat store`.

### Task 6: Chats — pin and long press

**Files:** Create `apps/mobile/src/features/chat/view/project-row.tsx`, `favorite-sheet.tsx`; Modify `chats-screen.tsx`; Test `chats-screen.test.tsx`.

**Produces:**

```tsx
export type ProjectRowData = { route: string; name: string; detail?: string; busy: boolean; pending: number; lastMessageAt: string | null };
export function ProjectRow(props: { row: ProjectRowData; selected: boolean; onPress(): void; favorite?: { pinned: boolean; onToggle(): void; onLongPress(): void } }): JSX.Element;
export function FavoriteSheet(props: { project: { id: string; name: string; pinned: boolean } | null; onClose(): void; onToggle(): void }): JSX.Element;
```

- [ ] Failing tests (compact width, the file's existing mocks): every project row has a button `Fixar termhub em Favoritos`, "Chat geral" has none; pressing it calls the API with `true` and the label turns into `Tirar termhub de Favoritos`; a long press on the row opens the sheet titled with the project's name, and its `Fixar em Favoritos` pins and closes; pressing the row still pushes `/chat/p-termhub`.
- [ ] Run `npx jest --selectProjects ui src/features/chat/view/chats-screen` — fails.
- [ ] Implement: the row is a `View` (border, selected background) with two sibling `Pressable`s — the row (`flex-1`, label = name, `onLongPress`) and the pin (`Icon` `pin` / `pin.fill`, Android `keep`, 44 pt hit area). Names get `numberOfLines={1}`.
- [ ] Both Chats test files pass (`chats-screen.test.tsx`, `chats-screen.wide.test.tsx`). Commit `Mobile: pin a project from the Chats list`.

### Task 7: Home tab

**Files:** Create `apps/mobile/src/features/home/view/home-screen.tsx` (+ `.test.tsx`), `apps/mobile/app/(tabs)/chats.tsx`; Modify `apps/mobile/app/(tabs)/index.tsx`, `apps/mobile/app/(tabs)/_layout.tsx`, `apps/mobile/src/ui/empty-state.tsx`, `conversation-screen.tsx` and `chat-memory-screen.tsx` (back fallback → `/(tabs)/chats`) with their tests, `apps/mobile/README.md`.

- [ ] Failing tests, Home:
  - no pins → `Nenhum projeto fixado`, the hint of spec §4, and `Ver projetos` navigates to `/(tabs)/chats`.
  - pins `p-reactivando` then `p-termhub` → only those two rows, in that order, each with its key (`REA`, `TER`); `opapingou` is absent; the pending badge of termhub shows.
  - pressing a row pushes `/chat/p-termhub`.
  - pressing `Tirar termhub de Favoritos` removes the row.
  - a focus reloads the projects (Review Focus 5): unpin through the API directly, fire the focus callback, the row is gone.
  - while the first load runs with nothing persisted, the empty state is not shown.
- [ ] Failing tests, back fallback: `conversation-screen.test.tsx` and the chat-memory test expect `replace('/(tabs)/chats')`.
- [ ] Run `npx jest --selectProjects ui src/features/home src/features/chat/view/conversation-screen src/features/chat/view/chat-memory-screen` — fails.
- [ ] Implement `HomeScreen` (title `Home`, section `Favoritos`, `FlatList` of `ProjectRow` with `detail = key`, `RefreshControl`, `useFocusEffect(loadProjects)`, `Banner` on `error`, `EmptyState` with an `action`), `EmptyState`'s optional `action?: ReactNode`, the routes and the tab bar (`index` → Home with `house` / `house.fill` / `home`, then `chats`, `notifications`, `progress`, `settings`), the back fallbacks, the README's route list.
- [ ] Tests pass. Commit `Mobile: Home tab with the pinned projects`.

### Task 8: Verify

- [ ] `npm run build:packages`, then `npm test` and `npm run typecheck` for `@termhub/mobile-api`, `@termhub/server` and `@termhub/mobile`; `npm run build -w @termhub/web` is not affected but the server typecheck is.
- [ ] iPhone simulator, mock mode: enrol, land on Home's empty state, `Ver projetos`, pin with the button, pin with a long press, Home lists both in order, open one, unpin from Home.
- [ ] iPad simulator, mock mode: the same, plus the split in Chats (pin in the list pane) and Home's centred column.
- [ ] `superpowers:requesting-code-review` on the branch; fix what it finds.

### Task 9: Ship

- [ ] PR (English, with **Impact on other users**), CI green, merge, watch "CI e Deploy" to the health check, confirm on jarvis (`docker ps --filter name=termhub-app`, the two `curl`s through the proxy), move TER-541 to Feito.
