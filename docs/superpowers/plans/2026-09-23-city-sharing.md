# City Sharing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a public city easy to spread: every city gets a short link (`77a.it/<nickname>`, created through TypeToAccess or pasted by the owner), and anyone on a public city page can download or share a story image, a post image and a 10-second story video with sound of the city as it is right now.

**Architecture:** Two PRs. **Part A (short link)** adds two nullable columns on `users`, a tiny HTTP client that is the only code talking to TypeToAccess (`public/typetoaccess.ts`), a service that creates the partner link on the first nickname claim and lazily afterwards (`public/short-link.ts`), three authenticated routes under `/api/auth/me/city-link`, `short_url` in `PublicCity` (named in `toPublicCity`), and the UI in "Minha cidade" and the office share button. **Part B (media)** gives `OfficeScene` a post-render frame hook and a camera lock, and adds `apps/web/src/city/share/` — a pure compositor (`layoutFor`/`drawFrame`), still capture, a real-time `MediaRecorder` recording with a synthesised Web Audio soundscape, delivery through the share sheet or a download, and a share panel in the public city's top bar. All media work happens in the visitor's browser; nothing new on the server in Part B.

**Tech Stack:** Fastify 5 + Prisma 7 + zod 3 (server), React 18 + PixiJS 8.21 + Vite 6 (web), Vitest 3 + Testing Library (jsdom), Canvas 2D, `HTMLCanvasElement.captureStream`, `MediaRecorder`, Web Audio, Web Share API level 2.

**Spec:** `docs/superpowers/specs/2026-09-23-city-sharing-design.md` (builds on `docs/superpowers/specs/2026-09-22-public-city-design.md`, including its "Amended after merge with projects-decoupled" section).

## Global Constraints

- Code, comments, identifiers, commit messages, PR titles/descriptions and repo docs in **English**; **UI copy in Portuguese (pt-BR)**, exactly as written in this plan.
- The host has **no Node**. Every npm/npx command runs from the repo root as
  `docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/w" -w /w node:20 sh -c '<cmd>'`, then `rm -rf .npm`.
  Below, `DOCKER '<cmd>'` means exactly that pair. Never pipe a test/typecheck/build command through `tail`/`head` in a way that hides its exit code.
- `apps/server/src/config.ts` calls `process.exit(1)` when `DATABASE_URL` is missing, and many server test files import it (through `auth/routes.ts`, for example). Every server unit-test command therefore sets a dummy one **inside** the container: `DATABASE_URL=postgresql://unused:unused@127.0.0.1:1/unused`. Below, `SRVTEST <files>` means
  `DOCKER 'DATABASE_URL=postgresql://unused:unused@127.0.0.1:1/unused npx -w @termhub/server vitest run <files>'`.
  Web tests: `WEBTEST <files>` means `DOCKER 'npx -w @termhub/web vitest run <files>'`.
- After a fresh `npm ci`, the server typecheck needs `npm run prisma:generate && npm run build:packages` first. The Prisma client under `apps/server/src/generated/` **is committed**: regenerate it after a schema change and commit it with the schema.
- **DB tests** need `TERMHUB_DB_TESTS=1` and a throwaway `postgres:16` started with `--rm` and a `th-` name prefix (never a production container name). Below, `DBTEST <files>` means exactly:
  ```bash
  docker run -d --rm --name th-citysharing-db -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=termhub -p 127.0.0.1:55439:5432 postgres:16
  until docker exec th-citysharing-db pg_isready -h 127.0.0.1 -U postgres -d termhub >/dev/null 2>&1; do sleep 1; done
  docker run --rm --network host -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/w" -w /w node:20 sh -c 'export DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55439/termhub TERMHUB_DB_TESTS=1; cd apps/server && npx prisma migrate deploy && npx vitest run <files>'
  rm -rf .npm
  docker stop th-citysharing-db
  ```
  (`--network host` is the one addition to the standard command: the test container must reach the throwaway database. `-h 127.0.0.1` makes `pg_isready` wait for the real server, not the init-time one that listens only on the socket.)
- **Never touch production**: never stop, remove, restart or reuse the name of `termhub-*`, `proxy-*` or any `*-app-*` container; never run `deploy/blue-green.sh`; never read from or write to `/mnt/hd2tb/projetos/termhub` (the production checkout). Work only in the worktree.
- Address workspaces by package name (`-w @termhub/server`, `-w @termhub/web`), never by path.
- **Routes never import Prisma**; go through `apps/server/src/db/repositories`. **Every request input is validated with zod.** **Log metadata only**: a user id, a status code, which slug kind was used — never the API key, never a request body, never a tab name or terminal content.
- **The privacy rule:** every public byte is produced by `toPublicCity` / `toPublicRobot` / `toPublicRobotFrame` / `toPublicRobotGone` in `apps/server/src/public/city.ts`, which **name every field they emit**. `short_url` is added there by name. Never spread a `User`, `Tab`, `Project` or `Machine` into a public payload.
- **The public bundle rule:** `apps/web/src/city/**` (including the new `apps/web/src/city/share/**`) imports only from `apps/web/src/office/**`, `apps/web/src/lib/types.ts`, its own `city/` files and npm packages — never `lib/api.ts`, `lib/auth.tsx`, `lib/public-city.ts`, `lib/city-link.ts`, `lib/monitor.tsx` or `App.tsx`. `apps/web/src/city/bundle.test.ts` guards the built output; Task B7 adds a source-level guard.
- **PixiJS is imported only under `apps/web/src/office/scene/` and `apps/web/src/office/pack/`.** The share code reaches the canvas only through `OfficeScene.onFrame`.
- **Migrations are additive** and backward compatible with the previous release (the old container keeps serving during the blue/green switch). Name a new migration after the latest existing one: the latest is `20260923110000_instance_secrets`, so this plan's is `20260923130000_city_short_link`.
- **TypeToAccess is never called in tests.** Every test injects a fake `ShortLinkHttp` (or a fake `fetch` into the client). The real API key lives only in the server environment (`TYPETOACCESS_API_KEY`); the browser never talks to TypeToAccess.
- Every commit ends with the trailer line `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>` (after a blank line). Commit messages follow the repo style: `Area: imperative subject` (≤ 72 chars).
- Branches: **Part A** on `feat/city-short-link`, cut from `docs/city-sharing` (which carries the spec and this plan). **Part B** on `feat/city-share-media`, cut from `main` after Part A is merged (or from `feat/city-short-link` if it is not merged yet — Part B reads `PublicCity.short_url`, which Part A adds). Do not push to `main`.

## Review Focus

1. **A nickname claim while TypeToAccess is slow or down.** `PATCH /api/auth/me/nickname` must answer as fast as it does today; the partner call runs after the write and nothing waits for it. Pinned in Task A3 (`onNicknameClaimed` returns while `createLink` is still pending) and Task A4 (the route calls the hook synchronously and answers 200).
2. **Claiming a nickname and opening "Minha cidade" right away.** The claim's background attempt and `GET /me/city-link`'s lazy retry must not create two partner links (each counts against the quota, and the second would get a random slug because the first took the nickname). Pinned in Task A3 (two concurrent `ensurePartner` calls share one `createLink`, and the claim's attempt counts for the 10-minute limit).
3. **A pasted custom link that goes somewhere else** — another person's city, this city with a query string, or a `77a.it` link that does not redirect at all. It must be refused with where it really points; a trailing slash or an upper-case host on the right URL must be accepted. Pinned in Tasks A3 (`sameCityUrl`) and A4 (the route's `400 SHORT_LINK_MISMATCH` body).
4. **The share sheet dismissed by the person.** Closing the native share sheet (`AbortError`) must not start a download behind their back; any other share failure must fall back to a download. Pinned in Task B3.
5. **The tab hidden mid-recording** (the person switches apps on a phone). Browsers pause animation frames in a hidden tab, so the recording is cancelled, the panel says why and offers to record again, and the camera is unlocked. Pinned in Task B6.
6. **A long link on the media** — no short link and a 30-character nickname (`termhub.dev/city/@` + 30 characters). A link on an image is useless if it is cut, so the compositor shrinks the type before it would ever ellipsise a link. Pinned in Task B2.

---

## File Structure

```
Part A — short link
apps/server/prisma/schema.prisma                                  User.cityShortUrlPartner / cityShortUrlCustom
apps/server/prisma/migrations/20260923130000_city_short_link/migration.sql   NEW
apps/server/src/generated/prisma/**                               regenerated (committed)
apps/server/src/db/repositories/types.ts                          User.city_short_url_partner / _custom, mapUser
apps/server/src/db/repositories/users.ts                          setCityShortUrlPartner, setCityShortUrlCustom
apps/server/src/db/repositories/users.db.test.ts                  the two writes against Postgres
apps/server/src/public/typetoaccess.ts                     NEW    the only module that talks to TypeToAccess / 77a.it
apps/server/src/public/typetoaccess.test.ts                NEW    against a fake fetch
apps/server/src/public/short-link.ts                       NEW    ShortLinkService: partner, lazy retry, custom, restore
apps/server/src/public/short-link.test.ts                  NEW
apps/server/src/routes/city-link.ts                        NEW    GET/PUT /me/city-link, DELETE /me/city-link/custom
apps/server/src/routes/city-link.test.ts                   NEW
apps/server/src/auth/routes.ts                                    onNicknameClaimed hook on the first claim
apps/server/src/auth/nickname-route.test.ts                       the hook
apps/server/src/config.ts                                         TYPETOACCESS_API_KEY -> config.typeToAccess
apps/server/src/app.ts                                            ShortLinkService wiring, cityLinkRoutes under /auth
apps/server/src/public/city.ts / city.test.ts                     PublicCity.short_url, named in toPublicCity
apps/server/src/public/read.ts                                    passes the owner's effective short link
apps/server/src/routes/public-city.test.ts                        short_url on the wire
.env.example, README.md                                           the new variable

apps/web/src/lib/types.ts                                         CityLink; PublicCity.short_url
apps/web/src/lib/api.ts                                           api.auth.cityLink / setCustomCityLink / clearCustomCityLink
apps/web/src/lib/public-city.ts / public-city.test.ts             displayLink()
apps/web/src/lib/city-link.ts                              NEW    useCityLink(active)
apps/web/src/lib/city-link.test.tsx                        NEW
apps/web/src/components/MyCityView.tsx / .test.tsx                "Link curto" section
apps/web/src/pages/OfficePage.tsx / .test.tsx                     city-depth share uses the short link

Part B — media
apps/web/src/office/scene/camera.ts                               Camera.locked
apps/web/src/office/scene/camera.lock.test.ts              NEW    (jsdom)
apps/web/src/office/scene/OfficeScene.ts                          onFrame(), lockCamera()
apps/web/src/city/share/compose.ts                         NEW    layoutFor, drawFrame, shareInfoFor, liveLine, displayLink
apps/web/src/city/share/compose.test.ts                    NEW
apps/web/src/city/share/images.ts                          NEW    FrameSource, captureStill, fileNameFor
apps/web/src/city/share/images.test.ts                     NEW
apps/web/src/city/share/deliver.ts                         NEW    canShareFile, shareOrDownload, downloadFile
apps/web/src/city/share/deliver.test.ts                    NEW
apps/web/src/city/share/sound.ts                           NEW    soundEvents, createSoundscape
apps/web/src/city/share/sound.test.ts                      NEW
apps/web/src/city/share/record.ts                          NEW    pickMimeType, canRecordVideo, runRecorder, recordStory
apps/web/src/city/share/record.test.ts                     NEW
apps/web/src/city/share/CopyLinkButton.tsx                 NEW
apps/web/src/city/share/SharePanel.tsx                     NEW
apps/web/src/city/share/SharePanel.test.tsx                NEW
apps/web/src/city/CityPage.tsx / CityPage.test.tsx                "Compartilhar" button + panel; "Copiar link" when the scene failed
apps/web/src/city/bundle.test.ts                                  source-level import guard
apps/web/src/components/MyCityView.tsx / .test.tsx                "Abrir minha cidade para compartilhar"
```

---
# Part A — short link (PR 1)

### Task A1: Two short-link columns on the account

**Files:**
- Modify: `apps/server/prisma/schema.prisma` (`model User`, after `nickname`)
- Create: `apps/server/prisma/migrations/20260923130000_city_short_link/migration.sql`
- Modify: `apps/server/src/generated/prisma/**` (regenerated, committed)
- Modify: `apps/server/src/db/repositories/types.ts` (`interface User`, `mapUser`)
- Modify: `apps/server/src/db/repositories/users.ts`
- Test: `apps/server/src/db/repositories/users.db.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `User.city_short_url_partner: string | null` and `User.city_short_url_custom: string | null` on the server DTO (so on `request.user` and in `GET /api/auth/me`, whose `toPublicUser` spreads the DTO — the person's own data).
  - `UsersRepository.setCityShortUrlPartner(userId: string, url: string): Promise<boolean>` — writes only when the row has no partner link yet; `false` when one was already stored.
  - `UsersRepository.setCityShortUrlCustom(userId: string, url: string | null): Promise<User>` — sets or clears the custom link, returns the updated user.

- [ ] **Step 1: Write the failing repository test.** In `apps/server/src/db/repositories/users.db.test.ts`, inside the existing `describe.skipIf(...)('UsersRepository (Postgres)', ...)`, after the nickname tests:

```ts
  // The partner link is written once (TypeToAccess cannot edit or delete a link, so a second one
  // would be a wasted link, not a correction); the custom one comes and goes over it.
  it('keeps the first partner short link and lets a custom one come and go over it', async () => {
    const a = await repo.create({ email: `${newId()}@x.dev`, name: 'A', role_id: SYSTEM_ROLE_IDS.authenticated });
    try {
      expect(a.city_short_url_partner).toBeNull();
      expect(a.city_short_url_custom).toBeNull();
      expect(await repo.setCityShortUrlPartner(a.id, 'https://77a.it/pedro')).toBe(true);
      expect(await repo.setCityShortUrlPartner(a.id, 'https://77a.it/x9k2')).toBe(false);
      const custom = await repo.setCityShortUrlCustom(a.id, 'https://77a.it/meu-link');
      expect(custom.city_short_url_custom).toBe('https://77a.it/meu-link');
      expect(custom.city_short_url_partner).toBe('https://77a.it/pedro');
      const cleared = await repo.setCityShortUrlCustom(a.id, null);
      expect(cleared.city_short_url_custom).toBeNull();
      expect((await repo.findById(a.id))?.city_short_url_partner).toBe('https://77a.it/pedro');
    } finally {
      await db.user.deleteMany({ where: { id: a.id } });
    }
  });
```

- [ ] **Step 2: Run it to see it fail.** `DBTEST src/db/repositories/users.db.test.ts` — Expected: FAIL (`repo.setCityShortUrlPartner is not a function`; `a.city_short_url_partner` is `undefined`, not `null`).

- [ ] **Step 3: Schema and migration.** In `apps/server/prisma/schema.prisma`, `model User`, right after the `nickname` line:

```prisma
  /// The short link termhub created for this person's city through TypeToAccess (partner). Written once.
  cityShortUrlPartner String? @map("city_short_url_partner")
  /// A short link the person pasted to replace the partner one; the effective link is custom ?? partner.
  cityShortUrlCustom  String? @map("city_short_url_custom")
```

Create `apps/server/prisma/migrations/20260923130000_city_short_link/migration.sql`:

```sql
-- The public city's short link: the one termhub created through TypeToAccess, and one the person
-- may paste to replace it. Additive and nullable: the previous container neither selects nor
-- writes these columns during the blue/green switch.
ALTER TABLE "users" ADD COLUMN "city_short_url_partner" TEXT;
ALTER TABLE "users" ADD COLUMN "city_short_url_custom" TEXT;
```

Then `DOCKER 'npm run prisma:generate'`.

- [ ] **Step 4: DTO and repository.** In `apps/server/src/db/repositories/types.ts`, in `export interface User`, after `nickname: string | null;`:

```ts
  /** the short link termhub created for the city through TypeToAccess; null = none yet */
  city_short_url_partner: string | null;
  /** a short link the person pasted instead; the effective one is custom ?? partner */
  city_short_url_custom: string | null;
```

and in `mapUser`, after `nickname: u.nickname,`:

```ts
  city_short_url_partner: u.cityShortUrlPartner,
  city_short_url_custom: u.cityShortUrlCustom,
```

In `apps/server/src/db/repositories/users.ts`, after `findByNickname`:

```ts
  /**
   * Stores the partner short link, only when the row has none yet: the condition is part of the
   * write, so two attempts racing (two app colors, say) cannot overwrite each other. False = one
   * was already there, and it stays.
   */
  async setCityShortUrlPartner(userId: string, url: string): Promise<boolean> {
    const { count } = await this.db.user.updateMany({ where: { id: userId, cityShortUrlPartner: null }, data: { cityShortUrlPartner: url } });
    return count === 1;
  }

  /** Sets (a pasted short link) or clears (null: back to the partner one) the custom short link. */
  async setCityShortUrlCustom(userId: string, url: string | null): Promise<User> {
    return mapUser(await this.db.user.update({ where: { id: userId }, data: { cityShortUrlCustom: url } }));
  }
```

- [ ] **Step 5: Run it to see it pass, and check the migration matches the schema.** `DBTEST src/db/repositories/users.db.test.ts` — Expected: PASS. Then, still with the throwaway database up (run the first two lines of the `DBTEST` recipe again if you stopped it), confirm no drift exactly as CI does:

```bash
docker run --rm --network host -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/w" -w /w node:20 sh -c 'export DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55439/termhub; cd apps/server && npx prisma migrate deploy && npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code'
rm -rf .npm
docker stop th-citysharing-db
```

Expected: exit code 0 ("No difference detected"). Then `DOCKER 'npm run typecheck -w @termhub/server'` — Expected: PASS (only `mapUser` builds a `User`, so nothing else needs the two new fields).

- [ ] **Step 6: Commit.**

```bash
git add apps/server/prisma apps/server/src/generated apps/server/src/db/repositories/types.ts apps/server/src/db/repositories/users.ts apps/server/src/db/repositories/users.db.test.ts
git commit -m "Accounts: store the public city's short links

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task A2: The TypeToAccess client

**Files:**
- Create: `apps/server/src/public/typetoaccess.ts`
- Test: `apps/server/src/public/typetoaccess.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:

```ts
export const TYPETOACCESS_LINKS_URL = 'https://api.typetoaccess.it/v1/links';
export const SHORT_LINK_TIMEOUT_MS = 5_000;
export type CreateLinkOutcome = { kind: 'created'; shortUrl: string } | { kind: 'slug_taken' } | { kind: 'failed'; status: number | null };
export interface ShortLinkHttp {
  /** POST /v1/links. Never throws: a network error or a timeout is { kind: 'failed', status: null }. */
  createLink(input: { url: string; slug?: string }): Promise<CreateLinkOutcome>;
  /** One GET of `url` with redirects NOT followed: the absolute Location it answers, or null when it is not a redirect. Throws on a network error or a timeout. */
  locationOf(url: string): Promise<string | null>;
}
export function createTypeToAccessClient(opts: { apiKey: string; fetchImpl?: typeof fetch; timeoutMs?: number }): ShortLinkHttp;
```

- [ ] **Step 1: Write the failing test.** Create `apps/server/src/public/typetoaccess.test.ts` (no real network: every call goes to a fake `fetch`):

```ts
import { describe, expect, it, vi } from 'vitest';
import { createTypeToAccessClient, TYPETOACCESS_LINKS_URL } from './typetoaccess.js';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const CREATED = { id: 'l1', slug: 'pedro', url: 'https://termhub.dev/city/@pedro', shortUrl: 'https://77a.it/pedro', clickCount: 0, createdAt: '2026-09-23T10:00:00.000Z' };

describe('createTypeToAccessClient', () => {
  it('creates a link with the bearer key, the city url and the slug', async () => {
    const fetchImpl = vi.fn(async () => json(201, CREATED));
    const client = createTypeToAccessClient({ apiKey: 'k-secret', fetchImpl });
    expect(await client.createLink({ url: 'https://termhub.dev/city/@pedro', slug: 'pedro' })).toEqual({ kind: 'created', shortUrl: 'https://77a.it/pedro' });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(TYPETOACCESS_LINKS_URL);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer k-secret');
    expect(JSON.parse(String(init.body))).toEqual({ url: 'https://termhub.dev/city/@pedro', slug: 'pedro' });
  });

  it('sends no slug at all when none is asked for (a random one)', async () => {
    const fetchImpl = vi.fn(async () => json(201, { ...CREATED, slug: 'x9k2', shortUrl: 'https://77a.it/x9k2' }));
    const client = createTypeToAccessClient({ apiKey: 'k', fetchImpl });
    expect(await client.createLink({ url: 'https://termhub.dev/city/@pedro' })).toEqual({ kind: 'created', shortUrl: 'https://77a.it/x9k2' });
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ url: 'https://termhub.dev/city/@pedro' });
  });

  it('tells a taken slug apart from every other failure', async () => {
    const client = (res: Response | Error) => createTypeToAccessClient({ apiKey: 'k', fetchImpl: vi.fn(async () => { if (res instanceof Error) throw res; return res; }) });
    expect(await client(json(409, { error: 'taken' })).createLink({ url: 'u', slug: 'pedro' })).toEqual({ kind: 'slug_taken' });
    expect(await client(json(429, {})).createLink({ url: 'u' })).toEqual({ kind: 'failed', status: 429 });
    expect(await client(json(500, {})).createLink({ url: 'u' })).toEqual({ kind: 'failed', status: 500 });
    expect(await client(json(402, { error: 'quota' })).createLink({ url: 'u' })).toEqual({ kind: 'failed', status: 402 });
    expect(await client(new TypeError('fetch failed')).createLink({ url: 'u' })).toEqual({ kind: 'failed', status: null });
    // a 201 whose body is not what the API documents is not a link
    expect(await client(json(201, { nope: true })).createLink({ url: 'u' })).toEqual({ kind: 'failed', status: 201 });
  });

  it('gives up after the timeout instead of holding the caller', async () => {
    const fetchImpl = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason))));
    const client = createTypeToAccessClient({ apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch, timeoutMs: 20 });
    expect(await client.createLink({ url: 'u' })).toEqual({ kind: 'failed', status: null });
  });

  it('reads where a short link points without following it', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 301, headers: { location: 'https://TERMHUB.dev/city/@pedro/' } }));
    const client = createTypeToAccessClient({ apiKey: 'k', fetchImpl });
    expect(await client.locationOf('https://77a.it/pedro')).toBe('https://termhub.dev/city/@pedro/');
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://77a.it/pedro');
    expect(init.redirect).toBe('manual');
  });

  it('answers null for a link that does not redirect, and throws when it cannot be reached', async () => {
    const ok = createTypeToAccessClient({ apiKey: 'k', fetchImpl: vi.fn(async () => new Response('page', { status: 200 })) });
    expect(await ok.locationOf('https://77a.it/nada')).toBeNull();
    const noLocation = createTypeToAccessClient({ apiKey: 'k', fetchImpl: vi.fn(async () => new Response(null, { status: 302 })) });
    expect(await noLocation.locationOf('https://77a.it/nada')).toBeNull();
    const down = createTypeToAccessClient({ apiKey: 'k', fetchImpl: vi.fn(async () => { throw new TypeError('fetch failed'); }) });
    await expect(down.locationOf('https://77a.it/nada')).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run it to see it fail.** `SRVTEST src/public/typetoaccess.test.ts` — Expected: FAIL, `Cannot find module './typetoaccess.js'`.

- [ ] **Step 3: Implement.** Create `apps/server/src/public/typetoaccess.ts`:

```ts
import { z } from 'zod';

/**
 * TypeToAccess, the partner that shortens public-city links (77a.it/<slug>). This module is the only
 * code that talks to it or to 77a.it, so every test stubs it and none ever reaches the real API.
 * The key is a server secret: it never leaves this process and is never logged.
 */
export const TYPETOACCESS_LINKS_URL = 'https://api.typetoaccess.it/v1/links';
export const SHORT_LINK_TIMEOUT_MS = 5_000;

// Only the field this code uses is required; the API also answers id, slug, url, clickCount, createdAt.
const createdSchema = z.object({ shortUrl: z.string().url() });

export type CreateLinkOutcome = { kind: 'created'; shortUrl: string } | { kind: 'slug_taken' } | { kind: 'failed'; status: number | null };

export interface ShortLinkHttp {
  /** POST /v1/links. Never throws: a network error or a timeout is { kind: 'failed', status: null }. */
  createLink(input: { url: string; slug?: string }): Promise<CreateLinkOutcome>;
  /** One GET of `url` with redirects NOT followed: the absolute Location it answers, or null when it is not a redirect. Throws on a network error or a timeout. */
  locationOf(url: string): Promise<string | null>;
}

export function createTypeToAccessClient(opts: { apiKey: string; fetchImpl?: typeof fetch; timeoutMs?: number }): ShortLinkHttp {
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? SHORT_LINK_TIMEOUT_MS;
  return {
    async createLink({ url, slug }) {
      let res: Response;
      try {
        res = await doFetch(TYPETOACCESS_LINKS_URL, {
          method: 'POST',
          headers: { authorization: `Bearer ${opts.apiKey}`, 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(slug ? { url, slug } : { url }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        return { kind: 'failed', status: null };
      }
      if (res.status === 409) {
        await res.body?.cancel().catch(() => {});
        return { kind: 'slug_taken' };
      }
      if (res.status !== 201 && res.status !== 200) {
        await res.body?.cancel().catch(() => {});
        return { kind: 'failed', status: res.status };
      }
      const parsed = createdSchema.safeParse(await res.json().catch(() => null));
      return parsed.success ? { kind: 'created', shortUrl: parsed.data.shortUrl } : { kind: 'failed', status: res.status };
    },

    async locationOf(url) {
      const res = await doFetch(url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
      await res.body?.cancel().catch(() => {});
      if (res.status < 300 || res.status >= 400) return null;
      const location = res.headers.get('location');
      if (!location) return null;
      try {
        // absolute, with the host lower-cased by the URL parser
        return new URL(location, url).toString();
      } catch {
        return null;
      }
    },
  };
}
```

- [ ] **Step 4: Run it to see it pass.** `SRVTEST src/public/typetoaccess.test.ts` — Expected: PASS (6 tests).

- [ ] **Step 5: Commit.**

```bash
git add apps/server/src/public/typetoaccess.ts apps/server/src/public/typetoaccess.test.ts
git commit -m "Public city: a client for the TypeToAccess short-link API

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task A3: The short-link service

**Files:**
- Create: `apps/server/src/public/short-link.ts`
- Test: `apps/server/src/public/short-link.test.ts`

**Interfaces:**
- Consumes: `User` with `city_short_url_partner` / `city_short_url_custom`, `UsersRepository.setCityShortUrlPartner` / `setCityShortUrlCustom` (Task A1); `ShortLinkHttp`, `CreateLinkOutcome` (Task A2).
- Produces:

```ts
export const SHORT_LINK_RETRY_MS = 10 * 60 * 1000;
export function normalizeCustomShortUrl(input: string): string | null;      // 'https://77a.it/<slug>' or null
export function sameCityUrl(location: string, expected: string): boolean;
export function effectiveShortUrl(u: Pick<User, 'city_short_url_partner' | 'city_short_url_custom'>): string | null;
export interface CityLinkView { enabled: boolean; city_url: string | null; short_url: string | null; source: 'custom' | 'partner' | null; partner_url: string | null }
export type SetCustomOutcome =
  | { ok: true; user: User }
  | { ok: false; code: 'SHORT_LINK_INVALID' }
  | { ok: false; code: 'SHORT_LINK_MISMATCH'; location: string | null }
  | { ok: false; code: 'SHORT_LINK_UNREACHABLE' };
export class ShortLinkService {
  constructor(deps: { users: Pick<UsersRepository, 'setCityShortUrlPartner' | 'setCityShortUrlCustom'>; http: ShortLinkHttp | null; cityBaseUrl: string; log: FastifyBaseLogger; now?: () => number });
  get enabled(): boolean;
  cityUrlOf(nickname: string): string;                 // `${cityBaseUrl}/@${nickname}`
  view(user: User): CityLinkView;
  ensurePartner(user: User): Promise<string | null>;   // rate-limited, deduplicated, never throws
  onNicknameClaimed(user: User): void;                 // fire and forget
  setCustom(user: User, input: string): Promise<SetCustomOutcome>;
  clearCustom(user: User): Promise<User>;
}
```

- [ ] **Step 1: Write the failing test.** Create `apps/server/src/public/short-link.test.ts`:

```ts
import type { FastifyBaseLogger } from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { User } from '../db/repositories/types.js';
import { effectiveShortUrl, normalizeCustomShortUrl, sameCityUrl, SHORT_LINK_RETRY_MS, ShortLinkService } from './short-link.js';
import type { CreateLinkOutcome, ShortLinkHttp } from './typetoaccess.js';

const BASE = 'https://termhub.dev/city';

const user = (over: Partial<User> = {}): User => ({
  id: 'u1', email: 'p@x.dev', name: 'Pedro', avatar_url: null, nickname: 'pedro', password_hash: null, google_id: null,
  role: 'member', role_id: null, invited_at: null, last_login_at: null, created_at: '2026-09-23T00:00:00.000Z',
  city_short_url_partner: null, city_short_url_custom: null, ...over,
});

/** The users repository as the service sees it, over an in-memory row per user. */
function fakeUsers(...seed: User[]) {
  const rows = new Map(seed.map((u) => [u.id, u]));
  return {
    rows,
    setCityShortUrlPartner: vi.fn(async (id: string, url: string) => {
      const u = rows.get(id)!;
      if (u.city_short_url_partner) return false;
      rows.set(id, { ...u, city_short_url_partner: url });
      return true;
    }),
    setCityShortUrlCustom: vi.fn(async (id: string, url: string | null) => {
      const u = { ...rows.get(id)!, city_short_url_custom: url };
      rows.set(id, u);
      return u;
    }),
  };
}

/** TypeToAccess as the service sees it: createLink answers the queued outcomes in order. */
function fakeHttp(outcomes: CreateLinkOutcome[] = [], location: string | null | Error = null) {
  return {
    createLink: vi.fn(async (_input: { url: string; slug?: string }) => outcomes.shift() ?? ({ kind: 'failed', status: 500 } as CreateLinkOutcome)),
    locationOf: vi.fn(async (_url: string) => {
      if (location instanceof Error) throw location;
      return location;
    }),
  } satisfies ShortLinkHttp;
}

const log = () => ({ info: vi.fn(), warn: vi.fn() }) as unknown as FastifyBaseLogger & { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> };

function service(opts: { http?: ReturnType<typeof fakeHttp> | null; users?: ReturnType<typeof fakeUsers>; now?: () => number } = {}) {
  const users = opts.users ?? fakeUsers(user());
  const http = opts.http === undefined ? fakeHttp() : opts.http;
  const logger = log();
  const s = new ShortLinkService({ users, http, cityBaseUrl: BASE, log: logger, now: opts.now });
  return { s, users, http, logger };
}

describe('the partner link', () => {
  it('is created with the nickname as the slug and stored', async () => {
    const { s, users, http } = service({ http: fakeHttp([{ kind: 'created', shortUrl: 'https://77a.it/pedro' }]) });
    expect(await s.ensurePartner(user())).toBe('https://77a.it/pedro');
    expect(http!.createLink).toHaveBeenCalledWith({ url: 'https://termhub.dev/city/@pedro', slug: 'pedro' });
    expect(users.rows.get('u1')?.city_short_url_partner).toBe('https://77a.it/pedro');
  });

  it('falls back to a random slug once when the nickname is taken', async () => {
    const { s, users, http } = service({ http: fakeHttp([{ kind: 'slug_taken' }, { kind: 'created', shortUrl: 'https://77a.it/x9k2' }]) });
    expect(await s.ensurePartner(user())).toBe('https://77a.it/x9k2');
    expect(http!.createLink).toHaveBeenCalledTimes(2);
    expect(http!.createLink.mock.calls[1][0]).toEqual({ url: 'https://termhub.dev/city/@pedro' });
    expect(users.rows.get('u1')?.city_short_url_partner).toBe('https://77a.it/x9k2');
  });

  it('stores nothing when the partner fails, and logs metadata only', async () => {
    for (const outcome of [{ kind: 'failed', status: 500 }, { kind: 'failed', status: 429 }, { kind: 'failed', status: null }] as CreateLinkOutcome[]) {
      const { s, users, logger } = service({ http: fakeHttp([outcome]) });
      expect(await s.ensurePartner(user())).toBeNull();
      expect(users.setCityShortUrlPartner).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('Bearer');
    }
    // a random slug that is taken too is a failure, not a loop
    const { s, http } = service({ http: fakeHttp([{ kind: 'slug_taken' }, { kind: 'slug_taken' }]) });
    expect(await s.ensurePartner(user())).toBeNull();
    expect(http!.createLink).toHaveBeenCalledTimes(2);
  });

  it('does nothing without a key, without a nickname, or when a partner link already exists', async () => {
    const off = service({ http: null });
    expect(off.s.enabled).toBe(false);
    expect(await off.s.ensurePartner(user())).toBeNull();
    const on = service();
    expect(await on.s.ensurePartner(user({ nickname: null }))).toBeNull();
    expect(await on.s.ensurePartner(user({ city_short_url_partner: 'https://77a.it/pedro' }))).toBe('https://77a.it/pedro');
    expect(on.http!.createLink).not.toHaveBeenCalled();
  });

  it('tries at most once per user every 10 minutes', async () => {
    let now = 1_000_000;
    const { s, http } = service({ http: fakeHttp([]), now: () => now });
    expect(await s.ensurePartner(user())).toBeNull();
    expect(await s.ensurePartner(user())).toBeNull();
    expect(http!.createLink).toHaveBeenCalledTimes(1);
    now += SHORT_LINK_RETRY_MS - 1;
    expect(await s.ensurePartner(user())).toBeNull();
    expect(http!.createLink).toHaveBeenCalledTimes(1);
    now += 1;
    await s.ensurePartner(user());
    expect(http!.createLink).toHaveBeenCalledTimes(2);
    // another person is not held back by this one's attempts
    const users = fakeUsers(user(), user({ id: 'u2', nickname: 'ana' }));
    const two = service({ http: fakeHttp([]), users, now: () => now });
    await two.s.ensurePartner(user());
    await two.s.ensurePartner(user({ id: 'u2', nickname: 'ana' }));
    expect(two.http!.createLink).toHaveBeenCalledTimes(2);
  });

  // Review Focus 2: the claim's background attempt and an immediate GET /me/city-link must not
  // create two links (each costs quota, and the second would get a random slug).
  it('shares one attempt between concurrent callers', async () => {
    let finish!: (o: CreateLinkOutcome) => void;
    const http = fakeHttp();
    http.createLink.mockImplementationOnce(() => new Promise<CreateLinkOutcome>((resolve) => (finish = resolve)));
    const { s } = service({ http });
    const a = s.ensurePartner(user());
    const b = s.ensurePartner(user());
    finish({ kind: 'created', shortUrl: 'https://77a.it/pedro' });
    expect(await a).toBe('https://77a.it/pedro');
    expect(await b).toBe('https://77a.it/pedro');
    expect(http.createLink).toHaveBeenCalledTimes(1);
  });

  // Review Focus 1: the nickname route must not wait for the partner.
  it('onNicknameClaimed returns at once, while the partner is still answering', async () => {
    const http = fakeHttp();
    http.createLink.mockImplementationOnce(() => new Promise<CreateLinkOutcome>(() => {}));
    const { s } = service({ http });
    const t0 = Date.now();
    expect(s.onNicknameClaimed(user())).toBeUndefined();
    expect(Date.now() - t0).toBeLessThan(50);
    expect(http.createLink).toHaveBeenCalledTimes(1);
  });
});

describe('the custom link', () => {
  it('accepts only https://77a.it/<slug>, canonicalised', () => {
    expect(normalizeCustomShortUrl('https://77a.it/meu-link')).toBe('https://77a.it/meu-link');
    expect(normalizeCustomShortUrl('  HTTPS://77A.IT/Meu_Link/  ')).toBe('https://77a.it/Meu_Link');
    for (const bad of ['', '77a.it/pedro', 'http://77a.it/pedro', 'https://77a.it/', 'https://evil.it/pedro', 'https://77a.it.evil.com/pedro', 'https://77a.it/a/b', 'https://77a.it/pedro?x=1', 'https://user@77a.it/pedro', `https://77a.it/${'a'.repeat(65)}`]) {
      expect(normalizeCustomShortUrl(bad)).toBeNull();
    }
  });

  // Review Focus 3
  it('matches the city url tolerating a trailing slash and the case of the host, nothing else', () => {
    const city = 'https://termhub.dev/city/@pedro';
    expect(sameCityUrl('https://termhub.dev/city/@pedro', city)).toBe(true);
    expect(sameCityUrl('https://termhub.dev/city/@pedro/', city)).toBe(true);
    expect(sameCityUrl('https://TermHub.DEV/city/@pedro', city)).toBe(true);
    for (const other of ['https://termhub.dev/city/@ana', 'http://termhub.dev/city/@pedro', 'https://termhub.dev/city/@pedro?utm=x', 'https://termhub.dev/city/@pedro#top', 'https://termhub.dev/city/@pedro/b1', 'https://evil.dev/city/@pedro', 'not a url']) {
      expect(sameCityUrl(other, city)).toBe(false);
    }
  });

  it('is stored only when it redirects to this person’s city', async () => {
    const { s, users, http } = service({ http: fakeHttp([], 'https://termhub.dev/city/@pedro/') });
    const out = await s.setCustom(user(), 'https://77a.it/meu-link');
    expect(out).toMatchObject({ ok: true, user: { city_short_url_custom: 'https://77a.it/meu-link' } });
    expect(http!.locationOf).toHaveBeenCalledWith('https://77a.it/meu-link');
    expect(users.rows.get('u1')?.city_short_url_custom).toBe('https://77a.it/meu-link');
  });

  it('is refused, saying where it points, when it goes elsewhere or nowhere', async () => {
    const elsewhere = service({ http: fakeHttp([], 'https://termhub.dev/city/@ana') });
    expect(await elsewhere.s.setCustom(user(), 'https://77a.it/meu-link')).toEqual({ ok: false, code: 'SHORT_LINK_MISMATCH', location: 'https://termhub.dev/city/@ana' });
    expect(elsewhere.users.setCityShortUrlCustom).not.toHaveBeenCalled();
    const nowhere = service({ http: fakeHttp([], null) });
    expect(await nowhere.s.setCustom(user(), 'https://77a.it/meu-link')).toEqual({ ok: false, code: 'SHORT_LINK_MISMATCH', location: null });
    const down = service({ http: fakeHttp([], new TypeError('fetch failed')) });
    expect(await down.s.setCustom(user(), 'https://77a.it/meu-link')).toEqual({ ok: false, code: 'SHORT_LINK_UNREACHABLE' });
  });

  it('never requests a link that is not a 77a.it link', async () => {
    const { s, http } = service({ http: fakeHttp([], 'https://termhub.dev/city/@pedro') });
    expect(await s.setCustom(user(), 'https://evil.it/pedro')).toEqual({ ok: false, code: 'SHORT_LINK_INVALID' });
    expect(http!.locationOf).not.toHaveBeenCalled();
  });

  it('clearing it makes the partner link effective again, creating one if there is none', async () => {
    const withPartner = user({ city_short_url_partner: 'https://77a.it/pedro', city_short_url_custom: 'https://77a.it/meu' });
    const a = service({ users: fakeUsers(withPartner) });
    const cleared = await a.s.clearCustom(withPartner);
    expect(effectiveShortUrl(cleared)).toBe('https://77a.it/pedro');
    expect(a.http!.createLink).not.toHaveBeenCalled();

    const noPartner = user({ city_short_url_custom: 'https://77a.it/meu' });
    const b = service({ users: fakeUsers(noPartner), http: fakeHttp([{ kind: 'created', shortUrl: 'https://77a.it/pedro' }]) });
    expect(effectiveShortUrl(await b.s.clearCustom(noPartner))).toBe('https://77a.it/pedro');
  });
});

describe('the view', () => {
  it('says which link is effective and where it came from', () => {
    const { s } = service();
    expect(s.view(user())).toEqual({ enabled: true, city_url: 'https://termhub.dev/city/@pedro', short_url: null, source: null, partner_url: null });
    expect(s.view(user({ city_short_url_partner: 'https://77a.it/pedro' }))).toMatchObject({ short_url: 'https://77a.it/pedro', source: 'partner' });
    expect(s.view(user({ city_short_url_partner: 'https://77a.it/pedro', city_short_url_custom: 'https://77a.it/meu' }))).toMatchObject({ short_url: 'https://77a.it/meu', source: 'custom', partner_url: 'https://77a.it/pedro' });
    expect(s.view(user({ nickname: null })).city_url).toBeNull();
    expect(service({ http: null }).s.view(user()).enabled).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to see it fail.** `SRVTEST src/public/short-link.test.ts` — Expected: FAIL, `Cannot find module './short-link.js'`.

- [ ] **Step 3: Implement.** Create `apps/server/src/public/short-link.ts`:

```ts
import type { FastifyBaseLogger } from 'fastify';
import type { User } from '../db/repositories/types.js';
import type { UsersRepository } from '../db/repositories/users.js';
import type { ShortLinkHttp } from './typetoaccess.js';

/**
 * The public city's short link (spec 2026-09-23 §3). termhub creates one through TypeToAccess when
 * a nickname is claimed (the "partner" link, nickname as slug, random on a clash), and the person may
 * paste a link of their own to replace it. The effective one is custom ?? partner. The nickname is
 * locked once set, so the city URL — and so every link to it — never goes stale.
 */

/** One attempt per user per this long: the lazy retry must not turn every visit to "Minha cidade" into an API call. */
export const SHORT_LINK_RETRY_MS = 10 * 60 * 1000;

const CUSTOM = /^https:\/\/77a\.it\/([A-Za-z0-9][A-Za-z0-9_-]{0,63})\/?$/i;

/** A pasted custom link as `https://77a.it/<slug>`, or null when it is not one. The slug keeps its case. */
export function normalizeCustomShortUrl(input: string): string | null {
  const m = CUSTOM.exec(input.trim());
  return m ? `https://77a.it/${m[1]}` : null;
}

/** Whether a redirect's Location is this city's URL: a trailing slash and the host's case are tolerated, nothing else. */
export function sameCityUrl(location: string, expected: string): boolean {
  let a: URL;
  let b: URL;
  try {
    a = new URL(location);
    b = new URL(expected);
  } catch {
    return false;
  }
  const path = (u: URL) => {
    const p = u.pathname.replace(/\/+$/, '');
    try {
      return decodeURIComponent(p);
    } catch {
      return p;
    }
  };
  return a.protocol === b.protocol && a.host === b.host && path(a) === path(b) && a.search === '' && a.hash === '' && a.username === '' && a.password === '';
}

export function effectiveShortUrl(u: Pick<User, 'city_short_url_partner' | 'city_short_url_custom'>): string | null {
  return u.city_short_url_custom ?? u.city_short_url_partner ?? null;
}

/** What GET/PUT/DELETE /me/city-link answer. */
export interface CityLinkView {
  /** TYPETOACCESS_API_KEY is set: partner links are created and a custom one can be set */
  enabled: boolean;
  /** the long address, null until the person has a nickname */
  city_url: string | null;
  /** the link to hand out; null = use city_url */
  short_url: string | null;
  source: 'custom' | 'partner' | null;
  partner_url: string | null;
}

export type SetCustomOutcome =
  | { ok: true; user: User }
  | { ok: false; code: 'SHORT_LINK_INVALID' }
  | { ok: false; code: 'SHORT_LINK_MISMATCH'; location: string | null }
  | { ok: false; code: 'SHORT_LINK_UNREACHABLE' };

type UsersPort = Pick<UsersRepository, 'setCityShortUrlPartner' | 'setCityShortUrlCustom'>;

export class ShortLinkService {
  /** user id -> when the last partner attempt started (in memory: a restart may try once more, which is fine) */
  private readonly attempts = new Map<string, number>();
  /** user id -> the attempt in flight, shared by every caller that arrives while it runs */
  private readonly inflight = new Map<string, Promise<string | null>>();
  private readonly now: () => number;

  constructor(private readonly deps: { users: UsersPort; http: ShortLinkHttp | null; cityBaseUrl: string; log: FastifyBaseLogger; now?: () => number }) {
    this.now = deps.now ?? Date.now;
  }

  /** Without a key the whole feature is off: no calls, no editing, the long link everywhere. */
  get enabled(): boolean {
    return this.deps.http !== null;
  }

  cityUrlOf(nickname: string): string {
    return `${this.deps.cityBaseUrl}/@${encodeURIComponent(nickname)}`;
  }

  view(user: User): CityLinkView {
    const custom = user.city_short_url_custom;
    const partner = user.city_short_url_partner;
    return {
      enabled: this.enabled,
      city_url: user.nickname ? this.cityUrlOf(user.nickname) : null,
      short_url: custom ?? partner ?? null,
      source: custom ? 'custom' : partner ? 'partner' : null,
      partner_url: partner,
    };
  }

  /** Right after a first nickname claim: starts the partner link and returns at once (the route never waits for it). */
  onNicknameClaimed(user: User): void {
    void this.ensurePartner(user);
  }

  /**
   * The partner link: the stored one, or one attempt to create it — at most one per user every
   * SHORT_LINK_RETRY_MS, and one at a time (concurrent callers share it). Never throws; null when
   * there is none (yet).
   */
  ensurePartner(user: User): Promise<string | null> {
    const http = this.deps.http;
    if (!http || !user.nickname) return Promise.resolve(null);
    if (user.city_short_url_partner) return Promise.resolve(user.city_short_url_partner);
    const running = this.inflight.get(user.id);
    if (running) return running;
    const now = this.now();
    for (const [id, at] of this.attempts) if (now - at >= SHORT_LINK_RETRY_MS) this.attempts.delete(id);
    if (this.attempts.has(user.id)) return Promise.resolve(null);
    this.attempts.set(user.id, now);
    const attempt = this.createPartner(http, user.id, user.nickname).finally(() => this.inflight.delete(user.id));
    this.inflight.set(user.id, attempt);
    return attempt;
  }

  private async createPartner(http: ShortLinkHttp, userId: string, nickname: string): Promise<string | null> {
    const url = this.cityUrlOf(nickname);
    let slug: 'nickname' | 'random' = 'nickname';
    try {
      let out = await http.createLink({ url, slug: nickname });
      if (out.kind === 'slug_taken') {
        slug = 'random';
        out = await http.createLink({ url });
      }
      if (out.kind !== 'created') {
        this.deps.log.warn({ userId, slug, status: out.kind === 'failed' ? out.status : 409 }, 'short link: partner link not created');
        return null;
      }
      const stored = await this.deps.users.setCityShortUrlPartner(userId, out.shortUrl);
      this.deps.log.info({ userId, slug, stored }, 'short link: partner link created');
      return stored ? out.shortUrl : null;
    } catch (err) {
      this.deps.log.warn({ userId, slug, err: err instanceof Error ? err.message : String(err) }, 'short link: partner link not created');
      return null;
    }
  }

  /** A pasted link replaces the partner one only when it redirects (not followed) to this person's city. */
  async setCustom(user: User, input: string): Promise<SetCustomOutcome> {
    const http = this.deps.http;
    const shortUrl = normalizeCustomShortUrl(input);
    if (!http || !user.nickname || !shortUrl) return { ok: false, code: 'SHORT_LINK_INVALID' };
    let location: string | null;
    try {
      location = await http.locationOf(shortUrl);
    } catch (err) {
      this.deps.log.warn({ userId: user.id, err: err instanceof Error ? err.message : String(err) }, 'short link: custom link unreachable');
      return { ok: false, code: 'SHORT_LINK_UNREACHABLE' };
    }
    if (!location || !sameCityUrl(location, this.cityUrlOf(user.nickname))) {
      this.deps.log.info({ userId: user.id, redirects: location !== null }, 'short link: custom link refused');
      return { ok: false, code: 'SHORT_LINK_MISMATCH', location };
    }
    return { ok: true, user: await this.deps.users.setCityShortUrlCustom(user.id, shortUrl) };
  }

  /** Back to the partner link; when there is none yet, one is created as on a first claim. */
  async clearCustom(user: User): Promise<User> {
    const updated = await this.deps.users.setCityShortUrlCustom(user.id, null);
    if (updated.city_short_url_partner) return updated;
    const partner = await this.ensurePartner(updated);
    return partner ? { ...updated, city_short_url_partner: partner } : updated;
  }
}
```

- [ ] **Step 4: Run it to see it pass.** `SRVTEST src/public/short-link.test.ts` — Expected: PASS (all tests in the three describes).

- [ ] **Step 5: Commit.**

```bash
git add apps/server/src/public/short-link.ts apps/server/src/public/short-link.test.ts
git commit -m "Public city: create, retry and replace the city's short link

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---
### Task A4: The routes, the claim hook and the configuration

**Files:**
- Create: `apps/server/src/routes/city-link.ts`
- Test: `apps/server/src/routes/city-link.test.ts`
- Modify: `apps/server/src/auth/routes.ts` (`authRoutes` signature, `PATCH /me/nickname`)
- Test: `apps/server/src/auth/nickname-route.test.ts`
- Modify: `apps/server/src/config.ts`, `apps/server/src/app.ts`, `.env.example`, `README.md`

**Interfaces:**
- Consumes: `ShortLinkService`, `effectiveShortUrl`, `CityLinkView` (Task A3); `createTypeToAccessClient` (Task A2); `User.city_short_url_*` (Task A1).
- Produces:
  - `GET /api/auth/me/city-link` → `200 CityLinkView` (awaits one lazy partner attempt when the key is set, the person has a nickname and no short link).
  - `PUT /api/auth/me/city-link` with `{ short_url: string }` → `200 CityLinkView`; `400 { code: 'VALIDATION' }` for a body that is not that shape; `400 { code: 'SHORT_LINK_INVALID' }`; `400 { error, code: 'SHORT_LINK_MISMATCH', location: string | null }`; `502 { code: 'SHORT_LINK_UNREACHABLE' }`; `404 { code: 'SHORT_LINK_DISABLED' }` without the key; `409 { code: 'NICKNAME_REQUIRED' }` without a nickname.
  - `DELETE /api/auth/me/city-link/custom` → `200 CityLinkView`; `404 SHORT_LINK_DISABLED` without the key.
  - `cityLinkRoutes(app: FastifyInstance, deps: { shortLinks: ShortLinkService }): Promise<void>`.
  - `authRoutes(app, ctx, opts?: { onNicknameClaimed?: (user: User) => void })` — calls the hook once, synchronously, after a **first** successful claim (the account had no nickname before).
  - `config.typeToAccess: { apiKey: string } | null`.

The three routes live in their own plugin, registered under the same `/auth` prefix as `authRoutes` (like `/me/nickname`, they are the signed-in person's own settings: authenticated, no resource grant — "Minha cidade" is for every account). The auth hook already enforces the session and CSRF on PUT/DELETE.

- [ ] **Step 1: Write the failing route tests.** Create `apps/server/src/routes/city-link.test.ts`, following the house pattern (a bare Fastify, `applyErrorHandler`, a `preHandler` that injects `request.user`), with the real `ShortLinkService` over a fake `ShortLinkHttp` and an in-memory users port:

```ts
import Fastify from 'fastify';
import type { FastifyBaseLogger } from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { User } from '../db/repositories/types.js';
import { applyErrorHandler } from '../lib/errors.js';
import { SHORT_LINK_RETRY_MS, ShortLinkService } from '../public/short-link.js';
import type { CreateLinkOutcome, ShortLinkHttp } from '../public/typetoaccess.js';
import { cityLinkRoutes } from './city-link.js';

const user = (over: Partial<User> = {}): User => ({
  id: 'u1', email: 'p@x.dev', name: 'Pedro', avatar_url: null, nickname: 'pedro', password_hash: null, google_id: null,
  role: 'member', role_id: null, invited_at: null, last_login_at: null, created_at: '2026-09-23T00:00:00.000Z',
  city_short_url_partner: null, city_short_url_custom: null, ...over,
});

function build(opts: { user?: User; http?: ShortLinkHttp | null; now?: () => number } = {}) {
  const me = opts.user ?? user();
  const rows = new Map([[me.id, me]]);
  const users = {
    setCityShortUrlPartner: vi.fn(async (id: string, url: string) => {
      const u = rows.get(id)!;
      if (u.city_short_url_partner) return false;
      rows.set(id, { ...u, city_short_url_partner: url });
      return true;
    }),
    setCityShortUrlCustom: vi.fn(async (id: string, url: string | null) => {
      const u = { ...rows.get(id)!, city_short_url_custom: url };
      rows.set(id, u);
      return u;
    }),
  };
  const log = { info: vi.fn(), warn: vi.fn() } as unknown as FastifyBaseLogger;
  const shortLinks = new ShortLinkService({ users, http: opts.http === undefined ? httpWith() : opts.http, cityBaseUrl: 'https://termhub.dev/city', log, now: opts.now });
  const app = Fastify();
  applyErrorHandler(app);
  app.addHook('preHandler', async (request) => {
    request.user = me as never;
  });
  app.register((a) => cityLinkRoutes(a, { shortLinks }), { prefix: '/auth' });
  return { app, users, rows };
}

function httpWith(outcomes: CreateLinkOutcome[] = [], location: string | null = null) {
  return { createLink: vi.fn(async () => outcomes.shift() ?? ({ kind: 'failed', status: 500 } as CreateLinkOutcome)), locationOf: vi.fn(async () => location) };
}

describe('GET /auth/me/city-link', () => {
  it('without a key: the feature is off and nothing is called', async () => {
    const { app } = build({ http: null });
    const res = await app.inject({ method: 'GET', url: '/auth/me/city-link' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ enabled: false, city_url: 'https://termhub.dev/city/@pedro', short_url: null, source: null, partner_url: null });
  });

  it('creates the missing partner link on the way (the lazy retry)', async () => {
    const http = httpWith([{ kind: 'created', shortUrl: 'https://77a.it/pedro' }]);
    const { app } = build({ http });
    const res = await app.inject({ method: 'GET', url: '/auth/me/city-link' });
    expect(res.json()).toMatchObject({ enabled: true, short_url: 'https://77a.it/pedro', source: 'partner' });
    expect(http.createLink).toHaveBeenCalledWith({ url: 'https://termhub.dev/city/@pedro', slug: 'pedro' });
  });

  it('retries at most once per 10 minutes when the partner keeps failing', async () => {
    let now = 5_000_000;
    const http = httpWith([]);
    const { app } = build({ http, now: () => now });
    await app.inject({ method: 'GET', url: '/auth/me/city-link' });
    await app.inject({ method: 'GET', url: '/auth/me/city-link' });
    expect(http.createLink).toHaveBeenCalledTimes(1);
    now += SHORT_LINK_RETRY_MS;
    await app.inject({ method: 'GET', url: '/auth/me/city-link' });
    expect(http.createLink).toHaveBeenCalledTimes(2);
  });

  it('does not call the partner when a custom link is set, nor before a nickname exists', async () => {
    const http = httpWith();
    await build({ http, user: user({ city_short_url_custom: 'https://77a.it/meu' }) }).app.inject({ method: 'GET', url: '/auth/me/city-link' });
    const noNick = await build({ http, user: user({ nickname: null }) }).app.inject({ method: 'GET', url: '/auth/me/city-link' });
    expect(noNick.json()).toMatchObject({ city_url: null, short_url: null });
    expect(http.createLink).not.toHaveBeenCalled();
  });
});

describe('PUT /auth/me/city-link', () => {
  const put = (app: ReturnType<typeof build>['app'], payload: unknown) => app.inject({ method: 'PUT', url: '/auth/me/city-link', payload: payload as object });

  it('stores a custom link that redirects to this city', async () => {
    const { app, rows } = build({ user: user({ city_short_url_partner: 'https://77a.it/pedro' }), http: httpWith([], 'https://termhub.dev/city/@pedro') });
    const res = await put(app, { short_url: 'https://77a.it/meu-link' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ short_url: 'https://77a.it/meu-link', source: 'custom', partner_url: 'https://77a.it/pedro' });
    expect(rows.get('u1')?.city_short_url_custom).toBe('https://77a.it/meu-link');
  });

  // Review Focus 3
  it('refuses a link that points elsewhere, with where it points in the message and the body', async () => {
    const { app, users } = build({ http: httpWith([], 'https://termhub.dev/city/@ana') });
    const res = await put(app, { short_url: 'https://77a.it/meu-link' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'SHORT_LINK_MISMATCH', location: 'https://termhub.dev/city/@ana' });
    expect(res.json().error).toContain('https://termhub.dev/city/@ana');
    expect(res.json().error).toContain('https://termhub.dev/city/@pedro');
    expect(users.setCityShortUrlCustom).not.toHaveBeenCalled();
  });

  it('refuses a link that is not https://77a.it/<slug>, and a body that is not { short_url }', async () => {
    const http = httpWith([], 'https://termhub.dev/city/@pedro');
    const { app } = build({ http });
    expect((await put(app, { short_url: 'https://bit.ly/pedro' })).json().code).toBe('SHORT_LINK_INVALID');
    expect((await put(app, { url: 'https://77a.it/pedro' })).json().code).toBe('VALIDATION');
    expect((await put(app, { short_url: 'x'.repeat(301) })).statusCode).toBe(400);
    expect(http.locationOf).not.toHaveBeenCalled();
  });

  it('answers 502 when the link cannot be opened', async () => {
    const http = { createLink: vi.fn(), locationOf: vi.fn(async () => { throw new TypeError('fetch failed'); }) };
    const res = await put(build({ http }).app, { short_url: 'https://77a.it/meu-link' });
    expect(res.statusCode).toBe(502);
    expect(res.json().code).toBe('SHORT_LINK_UNREACHABLE');
  });

  it('is off without a key, and needs a nickname', async () => {
    expect((await put(build({ http: null }).app, { short_url: 'https://77a.it/meu' })).statusCode).toBe(404);
    const res = await put(build({ user: user({ nickname: null }) }).app, { short_url: 'https://77a.it/meu' });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('NICKNAME_REQUIRED');
  });
});

describe('DELETE /auth/me/city-link/custom', () => {
  it('goes back to the partner link', async () => {
    const { app } = build({ user: user({ city_short_url_partner: 'https://77a.it/pedro', city_short_url_custom: 'https://77a.it/meu' }) });
    const res = await app.inject({ method: 'DELETE', url: '/auth/me/city-link/custom' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ short_url: 'https://77a.it/pedro', source: 'partner' });
  });

  it('creates the partner link when there is none yet', async () => {
    const http = httpWith([{ kind: 'created', shortUrl: 'https://77a.it/pedro' }]);
    const res = await build({ http, user: user({ city_short_url_custom: 'https://77a.it/meu' }) }).app.inject({ method: 'DELETE', url: '/auth/me/city-link/custom' });
    expect(res.json()).toMatchObject({ short_url: 'https://77a.it/pedro', source: 'partner' });
  });

  it('is off without a key', async () => {
    expect((await build({ http: null }).app.inject({ method: 'DELETE', url: '/auth/me/city-link/custom' })).statusCode).toBe(404);
  });
});
```

- [ ] **Step 2: Write the failing hook test.** In `apps/server/src/auth/nickname-route.test.ts`, append a new describe at the end of the file (its own builder, since the existing `buildApp` has no third argument):

```ts
describe('PATCH /auth/me/nickname and the short link', () => {
  function buildWithHook(user: { id: string; nickname: string | null }, onNicknameClaimed: (u: unknown) => void) {
    const app = Fastify();
    applyErrorHandler(app);
    app.addHook('preHandler', async (request) => {
      request.user = user as never;
      request.scope = { user, viewAs: { kind: 'self' }, ownerId: user.id, createAs: user.id } as never;
    });
    const repos = { users: { setNickname, findByNickname: vi.fn(async () => undefined) } } as unknown as Repositories;
    app.register((a) => authRoutes(a, { repos } as never, { onNicknameClaimed }), { prefix: '/auth' });
    return app;
  }

  beforeEach(() => setNickname.mockReset().mockResolvedValue('ok'));

  it('asks for the partner link once, after the first claim is written', async () => {
    const onNicknameClaimed = vi.fn();
    const res = await buildWithHook({ id: 'u1', nickname: null }, onNicknameClaimed).inject({ method: 'PATCH', url: '/auth/me/nickname', payload: { nickname: 'Pedro' } });
    expect(res.statusCode).toBe(200);
    expect(onNicknameClaimed).toHaveBeenCalledTimes(1);
    expect(onNicknameClaimed.mock.calls[0][0]).toMatchObject({ id: 'u1', nickname: 'pedro' });
    expect(setNickname.mock.invocationCallOrder[0]).toBeLessThan(onNicknameClaimed.mock.invocationCallOrder[0]);
  });

  it('does not ask on a re-sent nickname, on a refusal, or on a lost race', async () => {
    const onNicknameClaimed = vi.fn();
    await buildWithHook({ id: 'u1', nickname: 'pedro' }, onNicknameClaimed).inject({ method: 'PATCH', url: '/auth/me/nickname', payload: { nickname: 'pedro' } });
    await buildWithHook({ id: 'u1', nickname: null }, onNicknameClaimed).inject({ method: 'PATCH', url: '/auth/me/nickname', payload: { nickname: 'city' } });
    setNickname.mockResolvedValue('taken');
    await buildWithHook({ id: 'u1', nickname: null }, onNicknameClaimed).inject({ method: 'PATCH', url: '/auth/me/nickname', payload: { nickname: 'pedro' } });
    setNickname.mockResolvedValue('locked');
    await buildWithHook({ id: 'u1', nickname: null }, onNicknameClaimed).inject({ method: 'PATCH', url: '/auth/me/nickname', payload: { nickname: 'pedro' } });
    expect(onNicknameClaimed).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run them to see them fail.** `SRVTEST src/routes/city-link.test.ts src/auth/nickname-route.test.ts` — Expected: FAIL (`Cannot find module './city-link.js'`; `onNicknameClaimed` never called).

- [ ] **Step 4: Implement the routes.** Create `apps/server/src/routes/city-link.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { unauthorized } from '../lib/errors.js';
import { effectiveShortUrl, type ShortLinkService } from '../public/short-link.js';

const customBody = z.object({ short_url: z.string().trim().min(1).max(300) });

/**
 * The signed-in person's city short link (Settings → Minha cidade). Authenticated, no resource
 * grant, like /me/nickname: every account has a city. Registered under /auth beside authRoutes.
 */
export async function cityLinkRoutes(app: FastifyInstance, deps: { shortLinks: ShortLinkService }) {
  const links = deps.shortLinks;

  app.get('/me/city-link', async (request) => {
    if (!request.user) throw unauthorized();
    let user = request.user;
    // the lazy retry (spec §3.3): a claimed nickname, the key set and no short link yet — one
    // attempt, rate-limited per user inside the service, and shared with a claim still running
    if (links.enabled && user.nickname && !effectiveShortUrl(user)) {
      const partner = await links.ensurePartner(user);
      if (partner) user = { ...user, city_short_url_partner: partner };
    }
    return links.view(user);
  });

  app.put('/me/city-link', async (request, reply) => {
    if (!request.user) throw unauthorized();
    if (!links.enabled) return reply.code(404).send({ error: 'O link curto não está disponível nesta instância', code: 'SHORT_LINK_DISABLED' });
    const nickname = request.user.nickname;
    if (!nickname) return reply.code(409).send({ error: 'Escolha seu apelido antes', code: 'NICKNAME_REQUIRED' });
    const { short_url } = customBody.parse(request.body);
    const out = await links.setCustom(request.user, short_url);
    if (out.ok) {
      request.log.info({ userId: request.user.id }, 'short link: custom link set');
      return links.view(out.user);
    }
    if (out.code === 'SHORT_LINK_INVALID') return reply.code(400).send({ error: 'Use um link no formato https://77a.it/seu-link', code: out.code });
    if (out.code === 'SHORT_LINK_UNREACHABLE') return reply.code(502).send({ error: 'Não foi possível abrir esse link agora. Tente de novo.', code: out.code });
    const cityUrl = links.cityUrlOf(nickname);
    const error = out.location
      ? `Esse link leva para ${out.location}, não para a sua cidade (${cityUrl}).`
      : `Esse link não leva para a sua cidade (${cityUrl}).`;
    return reply.code(400).send({ error, code: out.code, location: out.location });
  });

  app.delete('/me/city-link/custom', async (request, reply) => {
    if (!request.user) throw unauthorized();
    if (!links.enabled) return reply.code(404).send({ error: 'O link curto não está disponível nesta instância', code: 'SHORT_LINK_DISABLED' });
    const user = await links.clearCustom(request.user);
    request.log.info({ userId: request.user.id }, 'short link: custom link cleared');
    return links.view(user);
  });
}
```

- [ ] **Step 5: Implement the claim hook.** In `apps/server/src/auth/routes.ts`, change the signature:

```ts
export async function authRoutes(app: FastifyInstance, ctx: AuthContext, opts: { onNicknameClaimed?: (user: User) => void } = {}) {
```

and in `app.patch('/me/nickname', ...)`, replace the two last lines of the handler

```ts
    request.log.info({ userId: request.user.id }, 'nickname: claimed');
    return { user: await withRole({ ...request.user, nickname: parsed.value }) };
```

with

```ts
    request.log.info({ userId: request.user.id }, 'nickname: claimed');
    const claimed = { ...request.user, nickname: parsed.value };
    // A first claim only (re-sending the nickname you hold is a no-op): the city's short link is
    // started here, after the write, and nothing waits for it — the partner can be slow or down.
    if (!request.user.nickname) opts.onNicknameClaimed?.(claimed);
    return { user: await withRole(claimed) };
```

(`User` is already imported in this file from `../db/repositories/types.js`.)

- [ ] **Step 6: Configuration and wiring.** In `apps/server/src/config.ts`, in `envSchema`, after `ALPHA_COMMUNITY_URL`:

```ts
  /**
   * TypeToAccess API key (a partner of termhub): creates each public city's short link
   * (77a.it/<nickname>). Unset = the short-link feature is off — no calls, no UI — and the long city
   * link is used everywhere, as on a self-hosted instance.
   */
  TYPETOACCESS_API_KEY: z.string().min(1).optional(),
```

and in `export const config`, after `alphaCommunityUrl: env.ALPHA_COMMUNITY_URL,`:

```ts
  typeToAccess: env.TYPETOACCESS_API_KEY ? { apiKey: env.TYPETOACCESS_API_KEY } : null,
```

In `apps/server/src/app.ts`, add the imports next to the other public/route imports:

```ts
import { cityLinkRoutes } from './routes/city-link.js';
import { ShortLinkService } from './public/short-link.js';
import { createTypeToAccessClient } from './public/typetoaccess.js';
```

right after `const access = createAccessAllowlist(config.cloudflareAccess);`:

```ts
  const shortLinks = new ShortLinkService({
    users: repos.users,
    http: config.typeToAccess ? createTypeToAccessClient({ apiKey: config.typeToAccess.apiKey }) : null,
    cityBaseUrl: config.publicCityUrl,
    log: fastify.log.child({ mod: 'short-link' }),
  });
```

and replace `await api.register((a) => authRoutes(a, auth), { prefix: '/auth' });` with:

```ts
      await api.register((a) => authRoutes(a, auth, { onNicknameClaimed: (u) => shortLinks.onNicknameClaimed(u) }), { prefix: '/auth' });
      await api.register((a) => cityLinkRoutes(a, { shortLinks }), { prefix: '/auth' });
```

In `.env.example`, after the `PUBLIC_CITY_URL` block:

```bash
# TypeToAccess (partner of termhub): creates each public city's short link, 77a.it/<nickname>.
# Empty = no short links: the long /city/@nickname link is used everywhere.
# TYPETOACCESS_API_KEY=
```

In `README.md`, in the environment table, after the `ALPHA_COMMUNITY_URL` row:

```markdown
| `TYPETOACCESS_API_KEY` | TypeToAccess key: creates each public city's short link (`77a.it/<nickname>`) and lets owners paste their own in Minha cidade; unset = long city links only |
```

- [ ] **Step 7: Run the tests and the typecheck.** `SRVTEST src/routes/city-link.test.ts src/auth/nickname-route.test.ts` — Expected: PASS (the existing nickname tests included: they call `authRoutes` with two arguments, and the third defaults to `{}`). Then `DOCKER 'npm run typecheck -w @termhub/server'` — Expected: PASS.

- [ ] **Step 8: Commit.**

```bash
git add apps/server/src/routes/city-link.ts apps/server/src/routes/city-link.test.ts apps/server/src/auth/routes.ts apps/server/src/auth/nickname-route.test.ts apps/server/src/config.ts apps/server/src/app.ts .env.example README.md
git commit -m "Public city: short-link routes and partner link on first claim

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task A5: `short_url` in the public payload

**Files:**
- Modify: `apps/server/src/public/city.ts` (`PublicCity`, `toPublicCity`)
- Modify: `apps/server/src/public/read.ts` (`readPublicCity`)
- Test: `apps/server/src/public/city.test.ts`, `apps/server/src/routes/public-city.test.ts`
- Modify: `apps/web/src/lib/types.ts` (`PublicCity`), `apps/web/src/city/CityPage.test.tsx` (fixture only)

**Interfaces:**
- Consumes: `effectiveShortUrl` (Task A3); `User.city_short_url_*` (Task A1).
- Produces: `PublicCity.short_url: string | null` on the server and in `apps/web/src/lib/types.ts`; `toPublicCity(input: { nickname; ownerName; shortUrl: string | null; buildings })`.

- [ ] **Step 1: Write the failing tests.** In `apps/server/src/public/city.test.ts`:
  - in the first test (`'emits exactly the fields the public city is allowed to carry'`), change the city-level key assertion to
    ```ts
    expect(Object.keys(city).sort()).toEqual(['buildings', 'nickname', 'owner_name', 'short_url']);
    ```
  - add `shortUrl: null` to the input object of **every** `toPublicCity({...})` call in the file (five calls), right after `ownerName: 'Pedro'`;
  - add this test at the end of the `describe`:
    ```ts
    // The short link is public by nature — it is printed on images meant for strangers — and it is
    // the one field of the owner's account that travels, named here and nowhere else.
    it('carries the owner’s short link, or null', () => {
      const withLink = toPublicCity({ nickname: 'pedro', ownerName: 'Pedro', shortUrl: 'https://77a.it/pedro', buildings: [] });
      expect(withLink.short_url).toBe('https://77a.it/pedro');
      expect(toPublicCity({ nickname: 'pedro', ownerName: 'Pedro', shortUrl: null, buildings: [] }).short_url).toBeNull();
    });
    ```

In `apps/server/src/routes/public-city.test.ts`, in `buildApp()`, change the `pedro` stub user to carry short links:

```ts
        nickname === 'pedro'
          ? { id: 'u1', name: 'Pedro', city_short_url_partner: 'https://77a.it/pedro', city_short_url_custom: null }
```

and add to `describe('GET /public/city/:nickname', ...)`:

```ts
  it('carries the owner’s effective short link, and null for a city without one', async () => {
    const { app } = buildApp();
    expect((await app.inject({ method: 'GET', url: '/public/city/pedro' })).json().short_url).toBe('https://77a.it/pedro');
    expect((await app.inject({ method: 'GET', url: '/public/city/terceiro' })).json().short_url).toBeNull();
  });
```

- [ ] **Step 2: Run them to see them fail.** `SRVTEST src/public/city.test.ts src/routes/public-city.test.ts` — Expected: FAIL (`short_url` missing from the keys and from the body).

- [ ] **Step 3: Implement.** In `apps/server/src/public/city.ts`:

```ts
export interface PublicCity { nickname: string; owner_name: string; short_url: string | null; buildings: PublicBuilding[] }
```

and in `toPublicCity`, add `shortUrl: string | null;` to the input type after `ownerName: string;`, and emit it by name after `owner_name`:

```ts
    owner_name: input.ownerName,
    // the owner's effective short link (custom ?? partner): printed on share images, public by nature
    short_url: input.shortUrl,
```

In `apps/server/src/public/read.ts`, import `effectiveShortUrl` and pass it:

```ts
import { effectiveShortUrl } from './short-link.js';
```

```ts
  return toPublicCity({ nickname, ownerName: owner.name, shortUrl: effectiveShortUrl(owner), buildings });
```

In `apps/web/src/lib/types.ts`, in `export interface PublicCity`, after `owner_name: string;`:

```ts
  /** the owner's short link (77a.it/…), or null: use the long /city/@nickname address */
  short_url: string | null;
```

In `apps/web/src/city/CityPage.test.tsx`, add `short_url: null` to the `CITY` fixture after `owner_name: 'Pedro'` (the fixture is typed `PublicCity`).

- [ ] **Step 4: Run them to see them pass, plus the other public tests.** `SRVTEST src/public src/routes/public-city.test.ts` — Expected: PASS (the card and city-page tests build `PublicCity` literals without `short_url`; they do not read it and test files are outside `tsc`). Then `WEBTEST src/city` — Expected: PASS. Then `DOCKER 'npm run typecheck -w @termhub/server && npm run typecheck -w @termhub/web'` — Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add apps/server/src/public/city.ts apps/server/src/public/city.test.ts apps/server/src/public/read.ts apps/server/src/routes/public-city.test.ts apps/web/src/lib/types.ts apps/web/src/city/CityPage.test.tsx
git commit -m "Public city: carry the owner's short link in the snapshot

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---
### Task A6: "Link curto" in Minha cidade

**Files:**
- Modify: `apps/web/src/lib/types.ts` (new `CityLink`), `apps/web/src/lib/api.ts` (`api.auth`)
- Modify: `apps/web/src/lib/public-city.ts`; Test: `apps/web/src/lib/public-city.test.ts`
- Create: `apps/web/src/lib/city-link.ts`; Test: `apps/web/src/lib/city-link.test.tsx`
- Modify: `apps/web/src/components/MyCityView.tsx`; Test: `apps/web/src/components/MyCityView.test.tsx`

**Interfaces:**
- Consumes: `GET/PUT /api/auth/me/city-link`, `DELETE /api/auth/me/city-link/custom` and the `CityLinkView` shape (Task A4).
- Produces:
  - `interface CityLink { enabled: boolean; city_url: string | null; short_url: string | null; source: 'custom' | 'partner' | null; partner_url: string | null }` in `lib/types.ts`.
  - `api.auth.cityLink(): Promise<CityLink>`, `api.auth.setCustomCityLink(short_url: string): Promise<CityLink>`, `api.auth.clearCustomCityLink(): Promise<CityLink>`.
  - `displayLink(url: string): string` in `lib/public-city.ts` (drops the scheme and a trailing slash: `https://77a.it/pedro` → `77a.it/pedro`).
  - `useCityLink(active: boolean): CityLinkState` in `lib/city-link.ts`, with `interface CityLinkState { link: CityLink | null; saving: boolean; error: string | null; setCustom(shortUrl: string): Promise<boolean>; restorePartner(): Promise<void> }`. Task A7 uses it in the office.

- [ ] **Step 1: Write the failing tests.** In `apps/web/src/lib/public-city.test.ts`, change the import to `import { cityLinkFor, displayLink } from './public-city';` and append:

```ts
describe('displayLink', () => {
  it('shows a link the way people type it', () => {
    expect(displayLink('https://77a.it/pedro')).toBe('77a.it/pedro');
    expect(displayLink('http://th.example.org/city/@pedro/')).toBe('th.example.org/city/@pedro');
  });
});
```

Create `apps/web/src/lib/city-link.test.tsx`:

```tsx
// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CityLink } from './types';

const { getMock, putMock, deleteMock } = vi.hoisted(() => ({ getMock: vi.fn(), putMock: vi.fn(), deleteMock: vi.fn() }));
vi.mock('./api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./api')>()),
  api: { auth: { cityLink: getMock, setCustomCityLink: putMock, clearCustomCityLink: deleteMock } },
}));

import { ApiError } from './api';
import { useCityLink } from './city-link';

const PARTNER: CityLink = { enabled: true, city_url: 'https://termhub.dev/city/@pedro', short_url: 'https://77a.it/pedro', source: 'partner', partner_url: 'https://77a.it/pedro' };

beforeEach(() => {
  getMock.mockReset().mockResolvedValue(PARTNER);
  putMock.mockReset();
  deleteMock.mockReset();
});

describe('useCityLink', () => {
  it('asks nothing while inactive (no nickname yet)', () => {
    const { result } = renderHook(() => useCityLink(false));
    expect(result.current.link).toBeNull();
    expect(getMock).not.toHaveBeenCalled();
  });

  it('loads the link when active', async () => {
    const { result } = renderHook(() => useCityLink(true));
    await waitFor(() => expect(result.current.link).toEqual(PARTNER));
  });

  it('keeps the server’s refusal as the error and says the save failed', async () => {
    putMock.mockRejectedValue(new ApiError(400, 'Esse link leva para https://termhub.dev/city/@ana, não para a sua cidade (https://termhub.dev/city/@pedro).', 'SHORT_LINK_MISMATCH'));
    const { result } = renderHook(() => useCityLink(true));
    await waitFor(() => expect(result.current.link).not.toBeNull());
    let ok = true;
    await act(async () => {
      ok = await result.current.setCustom('https://77a.it/meu');
    });
    expect(ok).toBe(false);
    expect(result.current.error).toMatch(/leva para https:\/\/termhub\.dev\/city\/@ana/);
    expect(result.current.link).toEqual(PARTNER);
  });

  it('takes the answer of a save and of a restore as the new link', async () => {
    const custom: CityLink = { ...PARTNER, short_url: 'https://77a.it/meu', source: 'custom' };
    putMock.mockResolvedValue(custom);
    deleteMock.mockResolvedValue(PARTNER);
    const { result } = renderHook(() => useCityLink(true));
    await waitFor(() => expect(result.current.link).not.toBeNull());
    await act(async () => {
      expect(await result.current.setCustom('https://77a.it/meu')).toBe(true);
    });
    expect(result.current.link).toEqual(custom);
    await act(async () => {
      await result.current.restorePartner();
    });
    expect(result.current.link).toEqual(PARTNER);
  });
});
```

In `apps/web/src/components/MyCityView.test.tsx`, right after the existing `vi.hoisted(...)` block, add a second one and its mock (before `import { MyCityView } from './MyCityView';`):

```tsx
const { cityLinkState } = vi.hoisted(() => ({
  cityLinkState: {
    active: null as boolean | null,
    current: {
      link: null as import('../lib/types').CityLink | null,
      saving: false,
      error: null as string | null,
      setCustom: vi.fn(async (_url: string) => true),
      restorePartner: vi.fn(async () => {}),
    },
  },
}));
vi.mock('../lib/city-link', () => ({
  useCityLink: (active: boolean) => {
    cityLinkState.active = active;
    return cityLinkState.current;
  },
}));
```

In the file's top-level `beforeEach`, add:

```tsx
  cityLinkState.active = null;
  cityLinkState.current = { ...cityLinkState.current, link: null, saving: false, error: null };
  cityLinkState.current.setCustom.mockReset().mockResolvedValue(true);
  cityLinkState.current.restorePartner.mockReset().mockResolvedValue(undefined);
```

and append:

```tsx
describe('MyCityView short link', () => {
  const PARTNER = { enabled: true, city_url: 'https://termhub.dev/city/@pedro', short_url: 'https://77a.it/pedro', source: 'partner' as const, partner_url: 'https://77a.it/pedro' };
  const section = () => screen.getByRole('region', { name: 'Link curto' });

  it('asks for the link only once there is a nickname', () => {
    renderView();
    expect(cityLinkState.active).toBe(true);
    cleanup();
    authState.current = { ...authState.current, user: { ...baseUser, nickname: null } };
    renderView();
    expect(cityLinkState.active).toBe(false);
  });

  it('shows nothing while the instance has no short links', () => {
    cityLinkState.current = { ...cityLinkState.current, link: { enabled: false, city_url: 'https://termhub.dev/city/@pedro', short_url: null, source: null, partner_url: null } };
    renderView();
    expect(screen.queryByRole('region', { name: 'Link curto' })).toBeNull();
  });

  it('shows the partner link with its note, and copies it whole', async () => {
    const writeText = vi.fn(async () => {});
    Object.assign(navigator, { clipboard: { writeText } });
    cityLinkState.current = { ...cityLinkState.current, link: PARTNER };
    renderView();
    expect(within(section()).getByText('Link curto: 77a.it/pedro')).toBeTruthy();
    expect(within(section()).getByText('Criado pelo TypeToAccess, parceiro do termhub')).toBeTruthy();
    await act(async () => {
      fireEvent.click(within(section()).getByRole('button', { name: /^copiar$/i }));
    });
    expect(writeText).toHaveBeenCalledWith('https://77a.it/pedro');
  });

  it('pastes a link of one’s own, and shows the server’s refusal', async () => {
    cityLinkState.current = { ...cityLinkState.current, link: PARTNER, error: 'Esse link leva para https://termhub.dev/city/@ana, não para a sua cidade (https://termhub.dev/city/@pedro).' };
    cityLinkState.current.setCustom.mockResolvedValue(false);
    renderView();
    fireEvent.click(within(section()).getByRole('button', { name: 'Usar meu próprio link curto' }));
    expect(within(section()).getByRole('link', { name: 'typetoaccess.it' }).getAttribute('href')).toBe('https://typetoaccess.it');
    fireEvent.change(within(section()).getByLabelText('Seu link curto'), { target: { value: 'https://77a.it/meu' } });
    await act(async () => {
      fireEvent.click(within(section()).getByRole('button', { name: 'Salvar' }));
    });
    expect(cityLinkState.current.setCustom).toHaveBeenCalledWith('https://77a.it/meu');
    expect(within(section()).getByRole('alert').textContent).toMatch(/leva para https:\/\/termhub\.dev\/city\/@ana/);
    // a refused link keeps the form open with what was typed
    expect((within(section()).getByLabelText('Seu link curto') as HTMLInputElement).value).toBe('https://77a.it/meu');
  });

  it('goes back to the partner link from a custom one', async () => {
    cityLinkState.current = { ...cityLinkState.current, link: { ...PARTNER, short_url: 'https://77a.it/meu', source: 'custom' } };
    renderView();
    expect(within(section()).getByText('Link curto: 77a.it/meu')).toBeTruthy();
    expect(within(section()).queryByText('Criado pelo TypeToAccess, parceiro do termhub')).toBeNull();
    await act(async () => {
      fireEvent.click(within(section()).getByRole('button', { name: 'Voltar ao link da parceria' }));
    });
    expect(cityLinkState.current.restorePartner).toHaveBeenCalled();
  });

  it('says when the short link is not there yet', () => {
    cityLinkState.current = { ...cityLinkState.current, link: { ...PARTNER, short_url: null, source: null, partner_url: null } };
    renderView();
    expect(within(section()).getByText(/o link curto ainda não foi criado/i)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run them to see them fail.** `WEBTEST src/lib/public-city.test.ts src/lib/city-link.test.tsx src/components/MyCityView.test.tsx` — Expected: FAIL (`displayLink` is not exported; `./city-link` does not exist; no "Link curto" region).

- [ ] **Step 3: Types, API client and the helper.** In `apps/web/src/lib/types.ts`, after the `PublicCity` interface:

```ts
/** GET/PUT /api/auth/me/city-link: the signed-in person's city address and its short link. */
export interface CityLink {
  /** the instance has a TypeToAccess key: partner links are created and a custom one can be set */
  enabled: boolean;
  /** the long address, null until the person has a nickname */
  city_url: string | null;
  /** the link to hand out: the custom one, else the partner one; null = use city_url */
  short_url: string | null;
  source: 'custom' | 'partner' | null;
  partner_url: string | null;
}
```

In `apps/web/src/lib/api.ts`, add `CityLink` to the long `import type { ... } from './types';` list, and inside `auth: { ... }`, after `setNickname`:

```ts
    /** The city address and its short link. May create the partner link on the way (the server rate-limits that). */
    cityLink: () => request<CityLink>('GET', '/auth/me/city-link'),
    /** 400 SHORT_LINK_INVALID, 400 SHORT_LINK_MISMATCH (the message says where the link really goes), 502 SHORT_LINK_UNREACHABLE */
    setCustomCityLink: (short_url: string) => request<CityLink>('PUT', '/auth/me/city-link', { short_url }),
    /** back to the partner link */
    clearCustomCityLink: () => request<CityLink>('DELETE', '/auth/me/city-link/custom'),
```

In `apps/web/src/lib/public-city.ts`, append:

```ts
/** A link the way people type it: no scheme, no trailing slash (https://77a.it/pedro → 77a.it/pedro). */
export function displayLink(url: string): string {
  return url.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
}
```

Create `apps/web/src/lib/city-link.ts`:

```ts
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from './api';
import type { CityLink } from './types';

export interface CityLinkState {
  link: CityLink | null;
  saving: boolean;
  /** the server's own words for the last refused save (e.g. where a pasted link really points) */
  error: string | null;
  /** true when the link was saved */
  setCustom(shortUrl: string): Promise<boolean>;
  restorePartner(): Promise<void>;
}

/**
 * The signed-in person's short link. `active` = they have a nickname: before that there is no city
 * to link to, and nothing is asked. A read that fails leaves `link` null — every caller falls back
 * to the long city address, which always works.
 */
export function useCityLink(active: boolean): CityLinkState {
  const [link, setLink] = useState<CityLink | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!active) {
      setLink(null);
      return;
    }
    let cancelled = false;
    api.auth
      .cityLink()
      .then((l) => {
        if (!cancelled) setLink(l);
      })
      .catch(() => {
        /* the long link stands in */
      });
    return () => {
      cancelled = true;
    };
  }, [active]);

  const run = useCallback(async (call: () => Promise<CityLink>): Promise<boolean> => {
    setSaving(true);
    setError(null);
    try {
      setLink(await call());
      return true;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível salvar. Tente de novo.');
      return false;
    } finally {
      setSaving(false);
    }
  }, []);

  const setCustom = useCallback((shortUrl: string) => run(() => api.auth.setCustomCityLink(shortUrl)), [run]);
  const restorePartner = useCallback(async () => {
    await run(() => api.auth.clearCustomCityLink());
  }, [run]);

  return { link, saving, error, setCustom, restorePartner };
}
```

- [ ] **Step 4: The section in Minha cidade.** In `apps/web/src/components/MyCityView.tsx`:

  - replace the first five import lines (up to and including the `../lib/public-city` one; the `../lib/types`, `./NicknameDialog` and `./PublishControl` imports stay) with

    ```tsx
    import { useEffect, useMemo, useState } from 'react';
    import { Link } from 'react-router-dom';
    import { useAuth } from '../lib/auth';
    import { useCityLink, type CityLinkState } from '../lib/city-link';
    import { useData } from '../lib/data';
    import { cityLinkFor, displayLink } from '../lib/public-city';
    ```

  - in `MyCityView`, after `const link = cityLinkFor(publicCityUrl, nickname);`, add

    ```tsx
      const short = useCityLink(!!nickname);
    ```

  - right after the closing `</section>` of the "Link da cidade" section, add `<ShortLinkSection state={short} />`;

  - replace the whole `function CityLink(...)` at the end of the file with:

    ```tsx
    /** Copy-to-clipboard with the button's own feedback, shared by the city link and the short link. */
    function useCopy(): [CopyStatus, (text: string) => Promise<void>] {
      const [status, setStatus] = useState<CopyStatus>('idle');
      useEffect(() => {
        if (status === 'idle') return;
        const id = setTimeout(() => setStatus('idle'), 2500);
        return () => clearTimeout(id);
      }, [status]);
      const copy = async (text: string) => {
        try {
          await navigator.clipboard.writeText(text);
          setStatus('copied');
        } catch {
          setStatus('failed');
        }
      };
      return [status, copy];
    }

    const copyLabel = (status: CopyStatus) => (status === 'copied' ? 'Copiado' : status === 'failed' ? 'Não foi possível copiar' : 'Copiar');

    function CityLink({ url }: { url: string }) {
      const [status, copy] = useCopy();
      return (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <code className="min-w-0 flex-1 truncate rounded bg-bg-3 px-2 py-1 font-mono text-xs">{url}</code>
          <button type="button" className="btn-ghost text-xs" onClick={() => void copy(url)}>
            {copyLabel(status)}
          </button>
          <a href={url} target="_blank" rel="noopener noreferrer" className="btn-ghost text-xs">
            Abrir
          </a>
        </div>
      );
    }

    /**
     * The city's short link (spec 2026-09-23 §3.5): the partner one TypeToAccess created, or one the
     * person pasted. Hidden when the instance has no short links and none is stored, and before the
     * person has a nickname (no city to link to).
     */
    function ShortLinkSection({ state }: { state: CityLinkState }) {
      const { link, saving, error, setCustom, restorePartner } = state;
      const [status, copy] = useCopy();
      const [editing, setEditing] = useState(false);
      const [draft, setDraft] = useState('');

      if (!link?.city_url || (!link.enabled && !link.short_url)) return null;

      const save = async (e: React.FormEvent) => {
        e.preventDefault();
        if (await setCustom(draft.trim())) {
          setEditing(false);
          setDraft('');
        }
      };

      return (
        <section aria-label="Link curto" className="rounded-lg border border-line bg-bg-2 p-4">
          <h2 className="text-sm font-semibold">Link curto</h2>
          {link.short_url ? (
            <>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-sm font-semibold">{`Link curto: ${displayLink(link.short_url)}`}</span>
                <button type="button" className="btn-ghost text-xs" onClick={() => void copy(link.short_url!)}>
                  {copyLabel(status)}
                </button>
              </div>
              {link.source === 'partner' && <p className="mt-1 text-xs text-fg-dim">Criado pelo TypeToAccess, parceiro do termhub</p>}
              {link.source === 'custom' && link.enabled && (
                <button type="button" className="btn-ghost mt-2 text-xs" disabled={saving} onClick={() => void restorePartner()}>
                  Voltar ao link da parceria
                </button>
              )}
            </>
          ) : (
            <p className="mt-2 text-sm text-fg-muted">O link curto ainda não foi criado. Enquanto isso, use o link da cidade acima.</p>
          )}
          {link.enabled &&
            (editing ? (
              <form className="mt-3 space-y-2" onSubmit={(e) => void save(e)}>
                <p className="text-xs text-fg-muted">
                  Crie um link em{' '}
                  <a href="https://typetoaccess.it" target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">
                    typetoaccess.it
                  </a>{' '}
                  que leve para {link.city_url} e cole aqui.
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    aria-label="Seu link curto"
                    className="input min-w-0 flex-1 text-sm"
                    placeholder="https://77a.it/…"
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                  />
                  <button type="submit" className="btn-primary text-xs" disabled={saving || !draft.trim()}>
                    Salvar
                  </button>
                  <button type="button" className="btn-ghost text-xs" onClick={() => setEditing(false)}>
                    Cancelar
                  </button>
                </div>
                {error && (
                  <p role="alert" className="text-xs text-danger">
                    {error}
                  </p>
                )}
              </form>
            ) : (
              <button type="button" className="btn-ghost mt-2 text-xs" onClick={() => setEditing(true)}>
                Usar meu próprio link curto
              </button>
            ))}
        </section>
      );
    }
    ```

  (`input`, `btn-primary` and `btn-ghost` are the app's own classes in `apps/web/src/index.css`; `text-danger` is the error colour `NicknameDialog.tsx` already uses.)

- [ ] **Step 5: Run them to see them pass.** `WEBTEST src/lib/public-city.test.ts src/lib/city-link.test.tsx src/components/MyCityView.test.tsx` — Expected: PASS (the existing "MyCityView link" tests too: with the mocked hook returning `link: null`, there is still exactly one "Copiar" button on the page). Then `DOCKER 'npm run typecheck -w @termhub/web'` — Expected: PASS.

- [ ] **Step 6: Commit.**

```bash
git add apps/web/src/lib/types.ts apps/web/src/lib/api.ts apps/web/src/lib/public-city.ts apps/web/src/lib/public-city.test.ts apps/web/src/lib/city-link.ts apps/web/src/lib/city-link.test.tsx apps/web/src/components/MyCityView.tsx apps/web/src/components/MyCityView.test.tsx
git commit -m "Minha cidade: show, replace and restore the city's short link

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task A7: The office share button uses the short link at city depth

**Files:**
- Modify: `apps/web/src/pages/OfficePage.tsx` (`OfficePage`, `shareResultFor`)
- Test: `apps/web/src/pages/OfficePage.test.tsx`

**Interfaces:**
- Consumes: `useCityLink(active: boolean): CityLinkState` (Task A6).
- Produces: `shareResultFor(target, userId, nickname, publicCityUrl, shortUrl: string | null, machines, byMachine)` — at `target.kind === 'city'` the link is `shortUrl ?? <long city link>`; building and room depths keep their long links.

- [ ] **Step 1: Write the failing tests.** In `apps/web/src/pages/OfficePage.test.tsx`, add after the existing `vi.hoisted(...)` block (before the `vi.mock` lines):

```tsx
const { cityLinkState } = vi.hoisted(() => ({ cityLinkState: { current: { link: null as { short_url: string | null } | null } } }));
vi.mock('../lib/city-link', () => ({ useCityLink: () => cityLinkState.current }));
```

In the top-level `beforeEach`, add `cityLinkState.current = { link: null };`. Inside `describe('OfficePage share button', ...)`, after the first test (`"copies the city's own address when something anywhere is published"`), add:

```tsx
  it('copies the short link at the city, when there is one', async () => {
    const writeText = stubClipboard();
    authState.current = { ...authState.current, user: { id: 'u1', nickname: 'pedro' } as User };
    cityLinkState.current = { link: { short_url: 'https://77a.it/pedro' } };
    twoMachinesOnePublished();
    renderPage('/office');
    await act(async () => {});

    fireEvent.click(screen.getByRole('button', { name: /compartilhar/i }));
    await act(async () => {});
    expect(writeText).toHaveBeenCalledWith('https://77a.it/pedro');
  });

  it('keeps the long link inside a building even with a short link (only the city has one)', async () => {
    const writeText = stubClipboard();
    authState.current = { ...authState.current, user: { id: 'u1', nickname: 'pedro' } as User };
    cityLinkState.current = { link: { short_url: 'https://77a.it/pedro' } };
    twoMachinesOnePublished();
    renderPage('/office/m1');
    await act(async () => {});

    fireEvent.click(screen.getByRole('button', { name: /compartilhar/i }));
    await act(async () => {});
    expect(writeText).toHaveBeenCalledWith('https://termhub.dev/city/@pedro/m1-pub');
  });
```

- [ ] **Step 2: Run them to see them fail.** `WEBTEST src/pages/OfficePage.test.tsx` — Expected: FAIL on the short-link test (the long link is copied); the building test passes already.

- [ ] **Step 3: Implement.** In `apps/web/src/pages/OfficePage.tsx`, import the hook:

```tsx
import { useCityLink } from '../lib/city-link';
```

in `OfficePage`, right after `const { can, user, publicCityUrl } = useAuth();`:

```tsx
  // the city's short link, when the instance makes one: only the city depth uses it (a building or a room has none)
  const cityLink = useCityLink(!!user?.nickname);
```

replace the `shareResult` line with:

```tsx
  const shareResult = shareResultFor(target, user?.id, user?.nickname ?? null, publicCityUrl, cityLink.link?.short_url ?? null, machines, byMachine);
```

and in `shareResultFor`, add the parameter after `publicCityUrl: string | null,`:

```tsx
  /** the owner's short link (77a.it/…), used at the city depth only */
  shortUrl: string | null,
```

and in its `if (target.kind === 'city')` branch replace the first line with:

```tsx
    if (base && machines.some((m) => roomsOf(m).some((r) => onStreet(m, r)))) return { kind: 'link', url: shortUrl ?? base };
```

- [ ] **Step 4: Run them to see them pass.** `WEBTEST src/pages/OfficePage.test.tsx` — Expected: PASS (all share tests, old and new).

- [ ] **Step 5: Verify Part A as a whole.**
  - `DOCKER 'DATABASE_URL=postgresql://unused:unused@127.0.0.1:1/unused npm test -w @termhub/server && npm test -w @termhub/web'` — Expected: PASS (DB files skip without `TERMHUB_DB_TESTS`).
  - `DBTEST src/db/repositories/users.db.test.ts src/public/read.db.test.ts` — Expected: PASS.
  - `DOCKER 'npm run typecheck -w @termhub/server && npm run build -w @termhub/web && npm run build:city -w @termhub/web && npm run build -w @termhub/landing'` — Expected: PASS.
  - `WEBTEST src/city/bundle.test.ts` (after the `build:city` above) — Expected: PASS (the city bundle still carries none of the private app; `lib/city-link.ts` is app-only).

- [ ] **Step 6: Commit.**

```bash
git add apps/web/src/pages/OfficePage.tsx apps/web/src/pages/OfficePage.test.tsx
git commit -m "Office: share the city's short link at city depth

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

Part A ends here: it is PR 1 ("Public city: short link through TypeToAccess"). Deploying it needs `TYPETOACCESS_API_KEY` in the production `.env` — the person who owns the environment sets it; this plan never edits production files.

---
# Part B — media (PR 2)

Everything below runs in the visitor's browser. The share code lives in `apps/web/src/city/share/` and imports only `../../office/**`, `../../lib/types` and its own siblings (Global Constraints). jsdom has no WebGL, no 2D canvas, no `MediaRecorder` and no Web Audio: the pure parts (`layoutFor`, `pickMimeType`, `soundEvents`) carry the logic and are tested directly; the rest is tested against small fakes, and the scene itself through a fake `OfficeScene`, as `CityPage.test.tsx` already does.

### Task B1: A frame hook and a camera lock on the scene

**Files:**
- Modify: `apps/web/src/office/scene/camera.ts` (`Camera`)
- Create: `apps/web/src/office/scene/camera.lock.test.ts`
- Modify: `apps/web/src/office/scene/OfficeScene.ts`

**Interfaces:**
- Consumes: nothing from Part B.
- Produces:
  - `Camera.locked: boolean` — while true, wheel and drag do not move the camera and `onUserMove` does not fire.
  - `OfficeScene.onFrame(cb: (canvas: HTMLCanvasElement) => void): () => void` — `cb` runs right after each render (Pixi's `renderer.runners.postrender`), with the canvas just drawn; returns the unsubscribe. A throwing listener never stops the scene.
  - `OfficeScene.lockCamera(locked: boolean): void` — locks the camera against wheel/drag and defers every re-framing (a resize, a new focus target) until unlocked; on unlock, a deferred framing is applied once.

- [ ] **Step 1: Write the failing test.** Create `apps/web/src/office/scene/camera.lock.test.ts` (jsdom has no `PointerEvent`; the camera only reads `clientX`/`clientY`, so a `MouseEvent` with the pointer event's type stands in):

```ts
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Camera } from './camera';

const cameras: Camera[] = [];
function camera() {
  const canvas = document.createElement('canvas');
  document.body.appendChild(canvas);
  const cam = new Camera(canvas);
  cameras.push(cam);
  return { cam, canvas };
}

const wheel = (canvas: HTMLCanvasElement) => canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: -200, clientX: 10, clientY: 10, cancelable: true }));
function drag(canvas: HTMLCanvasElement) {
  canvas.dispatchEvent(new MouseEvent('pointerdown', { clientX: 0, clientY: 0 }));
  window.dispatchEvent(new MouseEvent('pointermove', { clientX: 40, clientY: 30 }));
  window.dispatchEvent(new MouseEvent('pointerup'));
}

afterEach(() => {
  cameras.splice(0).forEach((c) => c.destroy());
  document.body.innerHTML = '';
});

describe('Camera.locked', () => {
  it('moves with the wheel and a drag while unlocked', () => {
    const { cam, canvas } = camera();
    const moved = vi.fn();
    cam.onUserMove = moved;
    wheel(canvas);
    expect(cam.target.scale).not.toBe(1);
    const before = { ...cam.target };
    drag(canvas);
    expect(cam.target.x).toBe(before.x + 40);
    expect(moved).toHaveBeenCalled();
  });

  it('ignores the wheel and a drag while locked, and says nothing moved', () => {
    const { cam, canvas } = camera();
    const moved = vi.fn();
    cam.onUserMove = moved;
    cam.locked = true;
    const before = { ...cam.target };
    wheel(canvas);
    drag(canvas);
    expect(cam.target).toEqual(before);
    expect(moved).not.toHaveBeenCalled();
    cam.locked = false;
    drag(canvas);
    expect(cam.target.x).toBe(before.x + 40);
  });
});
```

- [ ] **Step 2: Run it to see it fail.** `WEBTEST src/office/scene/camera.lock.test.ts` — Expected: FAIL in the locked test (the target moves).

- [ ] **Step 3: Implement the lock in the camera.** In `apps/web/src/office/scene/camera.ts`, in `class Camera`, after `onUserMove: (() => void) | null = null;`:

```ts
  /** while recording a video: wheel and drag are ignored, so the picture does not shake */
  locked = false;
```

and change the three handlers in the constructor:

```ts
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (this.locked) return;
      const r = canvas.getBoundingClientRect();
      this.target = zoomAt(this.target, e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0015));
      this.onUserMove?.();
    };
    const onDown = (e: PointerEvent) => {
      this.dragged = 0;
      // a locked camera starts no drag at all (a tap on a room still counts as a click)
      last = this.locked ? null : { x: e.clientX, y: e.clientY };
    };
```

(`onMove` already returns when `last` is null, so it needs no change.)

- [ ] **Step 4: Run it to see it pass.** `WEBTEST src/office/scene/camera.lock.test.ts src/office/scene/camera.test.ts` — Expected: PASS.

- [ ] **Step 5: The scene's frame hook and lock.** In `apps/web/src/office/scene/OfficeScene.ts`:

  - after the field `frameMs = 0;`, add:

    ```ts
      /** called right after every render with the canvas just drawn: the only moment a WebGL canvas can be read */
      private readonly frameListeners = new Set<(canvas: HTMLCanvasElement) => void>();
      /** while a video is recorded: no wheel, no drag, no re-framing */
      private cameraLocked = false;
      /** a framing asked for while the camera was locked, applied once it unlocks */
      private framingDeferred = false;
    ```

  - in `mount`, right after `this.camera = new Camera(app.canvas);`, add `this.camera.locked = this.cameraLocked;`;

  - in `mount`, right after the three `app.ticker.add(...)` lines, add:

    ```ts
        // Pixi's post-render runner fires inside render(), right after the draw calls — the frame is
        // still in the WebGL drawing buffer, so a 2D canvas can copy it (share images, the video)
        const postrender = {
          postrender: () => {
            for (const cb of this.frameListeners) {
              try {
                cb(app.canvas);
              } catch {
                /* a failing share must never stop the city from drawing */
              }
            }
          },
        };
        app.renderer.runners.postrender.add(postrender);
    ```

    and in the `this.cleanup = () => { ... }` body, add `app.renderer.runners.postrender.remove(postrender);`;

  - after `get rendererName()`, add:

    ```ts
      /** Subscribes to every rendered frame (see `frameListeners`); returns the unsubscribe. */
      onFrame(cb: (canvas: HTMLCanvasElement) => void): () => void {
        this.frameListeners.add(cb);
        return () => {
          this.frameListeners.delete(cb);
        };
      }

      /**
       * Freezes the framing for a recording: wheel and drag are ignored, and a re-framing (a resize, a
       * new target from a tap or Back) waits until the lock is released, which applies it once.
       */
      lockCamera(locked: boolean): void {
        this.cameraLocked = locked;
        if (this.camera) this.camera.locked = locked;
        if (!locked && this.framingDeferred) {
          this.framingDeferred = false;
          this.frameTarget(false);
        }
      }
    ```

  - in `private frameTarget(snap: boolean)`, right after `if (!this.camera) return;`, add:

    ```ts
        if (this.cameraLocked) {
          this.framingDeferred = true;
          return;
        }
    ```

- [ ] **Step 6: Typecheck and the scene's callers.** `DOCKER 'npm run typecheck -w @termhub/web'` — Expected: PASS (`app.renderer.runners.postrender` is a `SystemRunner` in pixi.js 8.21: `add(item)` / `remove(item)`, where `item.postrender` is called on emit). Then `WEBTEST src/pages/OfficePage.test.tsx src/city/CityPage.test.tsx` — Expected: PASS (both replace `OfficeScene` with a fake; nothing they use changed).

- [ ] **Step 7: Commit.**

```bash
git add apps/web/src/office/scene/camera.ts apps/web/src/office/scene/camera.lock.test.ts apps/web/src/office/scene/OfficeScene.ts
git commit -m "Office scene: a post-render frame hook and a camera lock

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task B2: The compositor

**Files:**
- Create: `apps/web/src/city/share/compose.ts`
- Test: `apps/web/src/city/share/compose.test.ts`

**Interfaces:**
- Consumes: `CityModel` from `apps/web/src/office/model.ts`; `PublicCity` (with `short_url`, Task A5) from `apps/web/src/lib/types.ts`.
- Produces:

```ts
export type ShareFormat = 'story' | 'post';
export const FORMAT_SIZE: Record<ShareFormat, { width: number; height: number }>;   // story 1080×1920, post 1920×1080
export interface ShareInfo { ownerName: string; working: number; waiting: number; /** printed as is: the short link or the long one, without the scheme */ shortLink: string }
export interface Rect { x: number; y: number; w: number; h: number }
export interface TextBlock { text: string; x: number; y: number; size: number; weight: 400 | 600 | 700; tone: 'fg' | 'muted' | 'accent'; align: 'left' | 'center'; maxWidth: number }
export interface ShareLayout { format: ShareFormat; width: number; height: number; scene: Rect; mark: TextBlock; title: TextBlock; live: TextBlock; link: TextBlock; invite: TextBlock }
export const GLYPH: number;                                    // average glyph width / font size, the layout's text budget
export function ellipsize(text: string, maxChars: number): string;
export function liveLine(working: number, waiting: number): string;
export function displayLink(url: string): string;
export function countsOf(model: CityModel): { working: number; waiting: number };
export function shareInfoFor(city: PublicCity, model: CityModel, longUrl: string): ShareInfo;
export function layoutFor(format: ShareFormat, info: ShareInfo): ShareLayout;
export function drawFrame(ctx: CanvasRenderingContext2D, layout: ShareLayout, scene: CanvasImageSource & { width: number; height: number }): void;
```

- [ ] **Step 1: Write the failing test.** Create `apps/web/src/city/share/compose.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import type { CityModel, DeskModel } from '../../office/model';
import type { PublicCity } from '../../lib/types';
import { countsOf, displayLink, drawFrame, ellipsize, FORMAT_SIZE, GLYPH, layoutFor, liveLine, shareInfoFor, type ShareInfo, type ShareLayout, type TextBlock } from './compose';

const info = (over: Partial<ShareInfo> = {}): ShareInfo => ({ ownerName: 'Pedro', working: 3, waiting: 1, shortLink: '77a.it/pedro', ...over });
const blocks = (l: ShareLayout): TextBlock[] => [l.mark, l.title, l.live, l.link, l.invite];
const estimated = (b: TextBlock) => [...b.text].length * b.size * GLYPH;

describe('layoutFor', () => {
  for (const format of ['story', 'post'] as const) {
    it(`keeps every ${format} rectangle and line inside the canvas`, () => {
      const l = layoutFor(format, info());
      expect({ width: l.width, height: l.height }).toEqual(FORMAT_SIZE[format]);
      expect(l.scene.x).toBeGreaterThanOrEqual(0);
      expect(l.scene.y).toBeGreaterThanOrEqual(0);
      expect(l.scene.x + l.scene.w).toBeLessThanOrEqual(l.width);
      expect(l.scene.y + l.scene.h).toBeLessThanOrEqual(l.height);
      for (const b of blocks(l)) {
        const left = b.align === 'center' ? b.x - b.maxWidth / 2 : b.x;
        expect(left).toBeGreaterThanOrEqual(0);
        expect(left + b.maxWidth).toBeLessThanOrEqual(l.width);
        expect(b.y - b.size).toBeGreaterThanOrEqual(0);
        expect(b.y).toBeLessThanOrEqual(l.height);
        expect(estimated(b)).toBeLessThanOrEqual(b.maxWidth + 0.001);
        // no text over the scene
        const overlapsScene = b.x >= l.scene.x && b.x <= l.scene.x + l.scene.w && b.y - b.size < l.scene.y + l.scene.h && b.y > l.scene.y;
        expect(overlapsScene).toBe(false);
      }
    });
  }

  it('gives the scene about 70% of a story and 62% of a post', () => {
    expect(layoutFor('story', info()).scene.h / 1920).toBeCloseTo(0.7, 1);
    expect(layoutFor('post', info()).scene.w / 1920).toBeCloseTo(0.62, 2);
  });

  it('ellipsises a long owner name', () => {
    const l = layoutFor('story', info({ ownerName: 'Pedro de Alcântara Francisco Antônio João Carlos Xavier de Paula' }));
    expect(l.title.text.startsWith('Cidade de Pedro')).toBe(true);
    expect(l.title.text.endsWith('…')).toBe(true);
    expect(estimated(l.title)).toBeLessThanOrEqual(l.title.maxWidth);
  });

  it('says who is waiting only when somebody is', () => {
    expect(layoutFor('story', info({ working: 3, waiting: 1 })).live.text).toBe('3 agentes trabalhando agora · 1 esperando você');
    expect(layoutFor('story', info({ working: 3, waiting: 0 })).live.text).toBe('3 agentes trabalhando agora');
  });

  // Review Focus 6: a link on an image is useless if it is cut, so it shrinks instead
  it('shrinks a long link instead of cutting it, in both formats', () => {
    const long = `termhub.dev/city/@${'a'.repeat(30)}`;
    for (const format of ['story', 'post'] as const) {
      const short = layoutFor(format, info());
      const l = layoutFor(format, info({ shortLink: long }));
      expect(l.link.text).toBe(long);
      expect(l.link.size).toBeLessThan(short.link.size);
      expect(estimated(l.link)).toBeLessThanOrEqual(l.link.maxWidth + 0.001);
    }
  });

  it('carries the invitation', () => {
    expect(layoutFor('post', info()).invite.text).toBe('Participe do beta grátis');
  });
});

describe('the words', () => {
  it('counts in pt-BR', () => {
    expect(liveLine(1, 0)).toBe('1 agente trabalhando agora');
    expect(liveLine(0, 2)).toBe('Nenhum agente trabalhando agora · 2 esperando você');
  });
  it('ellipsises by characters, never past the budget', () => {
    expect(ellipsize('abcdef', 10)).toBe('abcdef');
    expect(ellipsize('abcdef', 4)).toBe('abc…');
  });
  it('shows a link without its scheme', () => {
    expect(displayLink('https://77a.it/pedro')).toBe('77a.it/pedro');
    expect(displayLink('https://termhub.dev/city/@pedro/')).toBe('termhub.dev/city/@pedro');
  });
});

describe('shareInfoFor', () => {
  const desk = (id: string, pose: DeskModel['pose']) => ({ id, pose }) as DeskModel;
  const model = { needsYou: 2, machines: [{ id: 'b1', floor: { rooms: [{ id: 'r1', desks: [desk('a', 'type'), desk('b', 'type'), desk('c', 'raise'), desk('d', 'sleep')] }] } }] } as unknown as CityModel;
  const city: PublicCity = { nickname: 'pedro', owner_name: 'Pedro', short_url: null, buildings: [] };

  it('counts robots drawn typing, and the raised hands the model already counts', () => {
    expect(countsOf(model)).toEqual({ working: 2, waiting: 2 });
  });

  it('prints the short link when there is one, else the long one', () => {
    expect(shareInfoFor({ ...city, short_url: 'https://77a.it/pedro' }, model, 'https://termhub.dev/city/@pedro').shortLink).toBe('77a.it/pedro');
    expect(shareInfoFor(city, model, 'https://termhub.dev/city/@pedro').shortLink).toBe('termhub.dev/city/@pedro');
  });
});

describe('drawFrame', () => {
  function fakeCtx() {
    return {
      save: vi.fn(), restore: vi.fn(), fillRect: vi.fn(), drawImage: vi.fn(), fillText: vi.fn(),
      createLinearGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
      imageSmoothingEnabled: true, fillStyle: '' as unknown, font: '', textAlign: 'left', textBaseline: 'alphabetic',
    };
  }

  it('paints the scene pixel-sharp, covering its box, and every line of text', () => {
    const ctx = fakeCtx();
    const l = layoutFor('story', info());
    // a wide scene canvas: covering a tall box crops its sides, centred
    drawFrame(ctx as unknown as CanvasRenderingContext2D, l, { width: 2000, height: 1000 } as HTMLCanvasElement);
    expect(ctx.imageSmoothingEnabled).toBe(false);
    const [, sx, sy, sw, sh, dx, dy, dw, dh] = ctx.drawImage.mock.calls[0] as number[];
    expect([dx, dy, dw, dh]).toEqual([l.scene.x, l.scene.y, l.scene.w, l.scene.h]);
    expect(sh).toBeCloseTo(1000);
    expect(sw / sh).toBeCloseTo(l.scene.w / l.scene.h);
    expect(sx).toBeCloseTo((2000 - sw) / 2);
    expect(sy).toBeCloseTo(0);
    const texts = ctx.fillText.mock.calls.map((c) => c[0]);
    expect(texts).toEqual(expect.arrayContaining(['termhub', 'Cidade de Pedro', '77a.it/pedro', 'Participe do beta grátis']));
  });

  it('draws no scene from an empty canvas instead of dividing by zero', () => {
    const ctx = fakeCtx();
    drawFrame(ctx as unknown as CanvasRenderingContext2D, layoutFor('post', info()), { width: 0, height: 0 } as HTMLCanvasElement);
    expect(ctx.drawImage).not.toHaveBeenCalled();
    expect(ctx.fillText).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it to see it fail.** `WEBTEST src/city/share/compose.test.ts` — Expected: FAIL, `Cannot find module './compose'`.

- [ ] **Step 3: Implement.** Create `apps/web/src/city/share/compose.ts`:

```ts
/**
 * The share compositor (spec 2026-09-23 §2.2): one frame of a story (1080×1920) or a post
 * (1920×1080) — a header, the live scene and a footer with the link and the beta invitation. The
 * layout is pure (rectangles and strings, no DOM), so it is tested as numbers; `drawFrame` only
 * paints what the layout decided. Part of the public bundle: it imports only the office model and
 * the public types.
 */
import type { CityModel } from '../../office/model';
import type { PublicCity } from '../../lib/types';

export type ShareFormat = 'story' | 'post';

export const FORMAT_SIZE: Record<ShareFormat, { width: number; height: number }> = {
  story: { width: 1080, height: 1920 },
  post: { width: 1920, height: 1080 },
};

export interface ShareInfo {
  ownerName: string;
  working: number;
  waiting: number;
  /** printed as is: the short link when there is one, else the long city link — without the scheme */
  shortLink: string;
}

export interface Rect { x: number; y: number; w: number; h: number }

export interface TextBlock {
  text: string;
  /** `align: 'center'` = the centre of the line; otherwise its left edge */
  x: number;
  /** the baseline */
  y: number;
  size: number;
  weight: 400 | 600 | 700;
  tone: 'fg' | 'muted' | 'accent';
  align: 'left' | 'center';
  maxWidth: number;
}

export interface ShareLayout {
  format: ShareFormat;
  width: number;
  height: number;
  scene: Rect;
  mark: TextBlock;
  title: TextBlock;
  live: TextBlock;
  link: TextBlock;
  invite: TextBlock;
}

/** The city page's tokens (tailwind.config.js) and the brand's accent gradient. */
const COLORS = { bg: '#0f1115', line: '#2a2f3a', fg: '#e6e8ee', muted: '#9aa1b1', accentFrom: '#5b63d3', accentTo: '#7c87f7' };
const FONT = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

/**
 * Average glyph width of FONT as a fraction of its size, on the generous side: the layout cannot
 * measure text (no DOM), so it budgets characters with this, and `fillText`'s own maxWidth squeezes
 * whatever a real font still overruns.
 */
export const GLYPH = 0.56;

export function ellipsize(text: string, maxChars: number): string {
  const chars = [...text];
  if (chars.length <= maxChars) return text;
  return `${chars.slice(0, Math.max(1, maxChars - 1)).join('').trimEnd()}…`;
}

const budget = (size: number, maxWidth: number) => Math.max(1, Math.floor(maxWidth / (size * GLYPH)));

/** Plain text: ellipsised to its budget. */
function line(text: string, at: Omit<TextBlock, 'text'>): TextBlock {
  return { ...at, text: ellipsize(text, budget(at.size, at.maxWidth)) };
}

/** A link: the type shrinks (down to `min`) before a single character is cut — a cut link does not work. */
function linkLine(text: string, at: Omit<TextBlock, 'text'>, min: number): TextBlock {
  let size = at.size;
  while (size > min && [...text].length > budget(size, at.maxWidth)) size -= 2;
  return line(text, { ...at, size });
}

export function liveLine(working: number, waiting: number): string {
  const first = working === 0 ? 'Nenhum agente trabalhando agora' : `${working} ${working === 1 ? 'agente trabalhando' : 'agentes trabalhando'} agora`;
  return waiting > 0 ? `${first} · ${waiting} esperando você` : first;
}

export function displayLink(url: string): string {
  return url.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
}

/** What the page draws right now: robots drawn typing (every working robot), and raised hands. */
export function countsOf(model: CityModel): { working: number; waiting: number } {
  let working = 0;
  for (const machine of model.machines) for (const room of machine.floor.rooms) for (const desk of room.desks) if (desk.pose === 'type') working += 1;
  return { working, waiting: model.needsYou };
}

export function shareInfoFor(city: PublicCity, model: CityModel, longUrl: string): ShareInfo {
  return { ownerName: city.owner_name, ...countsOf(model), shortLink: displayLink(city.short_url ?? longUrl) };
}

export function layoutFor(format: ShareFormat, info: ShareInfo): ShareLayout {
  const { width, height } = FORMAT_SIZE[format];
  const title = `Cidade de ${info.ownerName}`;
  const live = liveLine(info.working, info.waiting);
  const invite = 'Participe do beta grátis';

  if (format === 'story') {
    // header 300 · scene 70% (1344) · footer 276
    const pad = 72;
    const inner = width - pad * 2;
    const headerH = 300;
    const scene: Rect = { x: 0, y: headerH, w: width, h: Math.round(height * 0.7) };
    const footer = scene.y + scene.h;
    return {
      format, width, height, scene,
      mark: line('termhub', { x: pad, y: 104, size: 44, weight: 700, tone: 'accent', align: 'left', maxWidth: inner }),
      title: line(title, { x: pad, y: 190, size: 64, weight: 700, tone: 'fg', align: 'left', maxWidth: inner }),
      live: line(live, { x: pad, y: 258, size: 32, weight: 400, tone: 'muted', align: 'left', maxWidth: inner }),
      link: linkLine(info.shortLink, { x: width / 2, y: footer + 128, size: 76, weight: 700, tone: 'accent', align: 'center', maxWidth: inner }, 32),
      invite: line(invite, { x: width / 2, y: footer + 212, size: 42, weight: 600, tone: 'fg', align: 'center', maxWidth: inner }),
    };
  }

  // post: the scene on the left (62%), a text column on the right
  const scene: Rect = { x: 0, y: 0, w: Math.round(width * 0.62), h: height };
  const pad = 48;
  const colX = scene.w + pad;
  const colW = width - colX - pad;
  return {
    format, width, height, scene,
    mark: line('termhub', { x: colX, y: 150, size: 40, weight: 700, tone: 'accent', align: 'left', maxWidth: colW }),
    title: line(title, { x: colX, y: 250, size: 48, weight: 700, tone: 'fg', align: 'left', maxWidth: colW }),
    live: line(live, { x: colX, y: 320, size: 24, weight: 400, tone: 'muted', align: 'left', maxWidth: colW }),
    link: linkLine(info.shortLink, { x: colX, y: 800, size: 56, weight: 700, tone: 'accent', align: 'left', maxWidth: colW }, 22),
    invite: line(invite, { x: colX, y: 880, size: 36, weight: 600, tone: 'fg', align: 'left', maxWidth: colW }),
  };
}

/** Paints one frame. `scene` is the office canvas as it was just rendered (OfficeScene.onFrame). */
export function drawFrame(ctx: CanvasRenderingContext2D, layout: ShareLayout, scene: CanvasImageSource & { width: number; height: number }): void {
  ctx.save();
  ctx.imageSmoothingEnabled = false; // pixel art stays pixel art
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, layout.width, layout.height);

  // the scene, scaled to cover its box and centred on what the camera shows
  const r = layout.scene;
  if (scene.width > 0 && scene.height > 0) {
    const k = Math.max(r.w / scene.width, r.h / scene.height);
    const sw = r.w / k;
    const sh = r.h / k;
    ctx.drawImage(scene, (scene.width - sw) / 2, (scene.height - sh) / 2, sw, sh, r.x, r.y, r.w, r.h);
  }

  // hairlines between the bands, in the page's `line` colour
  ctx.fillStyle = COLORS.line;
  if (layout.format === 'story') {
    ctx.fillRect(0, r.y - 2, layout.width, 2);
    ctx.fillRect(0, r.y + r.h, layout.width, 2);
  } else {
    ctx.fillRect(r.x + r.w, 0, 2, layout.height);
  }

  for (const b of [layout.mark, layout.title, layout.live, layout.link, layout.invite]) {
    ctx.font = `${b.weight} ${b.size}px ${FONT}`;
    ctx.textAlign = b.align;
    ctx.textBaseline = 'alphabetic';
    if (b.tone === 'accent') {
      const x0 = b.align === 'center' ? b.x - b.maxWidth / 2 : b.x;
      const gradient = ctx.createLinearGradient(x0, 0, x0 + b.maxWidth, 0);
      gradient.addColorStop(0, COLORS.accentFrom);
      gradient.addColorStop(1, COLORS.accentTo);
      ctx.fillStyle = gradient;
    } else {
      ctx.fillStyle = b.tone === 'fg' ? COLORS.fg : COLORS.muted;
    }
    ctx.fillText(b.text, b.x, b.y, b.maxWidth);
  }
  ctx.restore();
}
```

- [ ] **Step 4: Run it to see it pass.** `WEBTEST src/city/share/compose.test.ts` — Expected: PASS. (The overlap check: story text sits above `scene.y` or below `scene.y + scene.h`; post text sits right of `scene.w`.)

- [ ] **Step 5: Commit.**

```bash
git add apps/web/src/city/share/compose.ts apps/web/src/city/share/compose.test.ts
git commit -m "City: compose story and post frames of the live scene

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---
### Task B3: Stills and delivery

**Files:**
- Create: `apps/web/src/city/share/images.ts`, `apps/web/src/city/share/deliver.ts`
- Test: `apps/web/src/city/share/images.test.ts`, `apps/web/src/city/share/deliver.test.ts`

**Interfaces:**
- Consumes: `layoutFor`, `drawFrame`, `FORMAT_SIZE`, `ShareFormat`, `ShareInfo` (Task B2); `OfficeScene.onFrame` shape (Task B1).
- Produces:

```ts
// images.ts
export interface FrameSource { onFrame(cb: (canvas: HTMLCanvasElement) => void): () => void }   // OfficeScene satisfies it
export function captureStill(source: FrameSource, format: ShareFormat, info: ShareInfo, timeoutMs?: number): Promise<Blob>;  // PNG
export function fileNameFor(nickname: string, kind: ShareFormat, ext: 'png' | 'mp4' | 'webm'): string;  // termhub-cidade-<nickname>-<kind>.<ext>
// deliver.ts
export type Delivery = 'shared' | 'dismissed' | 'downloaded';
export function canShareFile(file: File): boolean;
export function downloadFile(blob: Blob, name: string): void;
export function shareOrDownload(file: File): Promise<Delivery>;
```

- [ ] **Step 1: Write the failing tests.** Create `apps/web/src/city/share/images.test.ts`:

```ts
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureStill, fileNameFor, type FrameSource } from './images';

const info = { ownerName: 'Pedro', working: 1, waiting: 0, shortLink: '77a.it/pedro' };

/** A scene whose next render the test triggers by hand. */
function fakeSource() {
  const listeners = new Set<(c: HTMLCanvasElement) => void>();
  const source: FrameSource = {
    onFrame: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
  const render = () => [...listeners].forEach((cb) => cb({ width: 800, height: 600 } as HTMLCanvasElement));
  return { source, listeners, render };
}

const ctx = { save: vi.fn(), restore: vi.fn(), fillRect: vi.fn(), drawImage: vi.fn(), fillText: vi.fn(), createLinearGradient: vi.fn(() => ({ addColorStop: vi.fn() })) };
/** the size of every canvas turned into an image */
let encoded: string[] = [];

beforeEach(() => {
  encoded = [];
  // jsdom has no 2D canvas: the compositor's own tests cover what gets painted
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (this: HTMLCanvasElement, cb: BlobCallback, type?: string) {
    encoded.push(`${this.width}x${this.height}`);
    cb(new Blob(['png'], { type }));
  });
});

afterEach(() => vi.restoreAllMocks());

describe('captureStill', () => {
  it('draws the next rendered frame at the format’s size, as a PNG, and lets go of the scene', async () => {
    const { source, listeners, render } = fakeSource();
    const pending = captureStill(source, 'story', info);
    expect(listeners.size).toBe(1);
    render();
    const blob = await pending;
    expect(blob.type).toBe('image/png');
    expect(encoded).toEqual(['1080x1920']);
    expect(ctx.drawImage).toHaveBeenCalled();
    expect(listeners.size).toBe(0);
  });

  it('gives up when no frame comes (a hidden tab stops rendering)', async () => {
    const { source, listeners } = fakeSource();
    await expect(captureStill(source, 'post', info, 20)).rejects.toThrow(/no frame/);
    expect(listeners.size).toBe(0);
  });
});

describe('fileNameFor', () => {
  it('names the files after the city', () => {
    expect(fileNameFor('pedro', 'story', 'png')).toBe('termhub-cidade-pedro-story.png');
    expect(fileNameFor('pedro', 'post', 'png')).toBe('termhub-cidade-pedro-post.png');
    expect(fileNameFor('pedro', 'story', 'mp4')).toBe('termhub-cidade-pedro-story.mp4');
  });
});
```

Create `apps/web/src/city/share/deliver.test.ts`:

```ts
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canShareFile, shareOrDownload } from './deliver';

const file = () => new File(['x'], 'termhub-cidade-pedro-story.png', { type: 'image/png' });
let clicked: HTMLAnchorElement[] = [];

function shareSheet(opts: { canShare: boolean; share?: () => Promise<void> }) {
  Object.defineProperty(navigator, 'canShare', { configurable: true, value: vi.fn(() => opts.canShare) });
  Object.defineProperty(navigator, 'share', { configurable: true, value: vi.fn(opts.share ?? (async () => {})) });
}

beforeEach(() => {
  clicked = [];
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    clicked.push(this);
  });
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:file') });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
});

afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(navigator, 'canShare', { configurable: true, value: undefined });
  Object.defineProperty(navigator, 'share', { configurable: true, value: undefined });
});

describe('delivery', () => {
  it('opens the share sheet where it accepts the file', async () => {
    shareSheet({ canShare: true });
    expect(canShareFile(file())).toBe(true);
    expect(await shareOrDownload(file())).toBe('shared');
    expect(navigator.share).toHaveBeenCalledWith({ files: [expect.any(File)] });
    expect(clicked).toHaveLength(0);
  });

  it('downloads where there is no share sheet, or it refuses files', async () => {
    expect(canShareFile(file())).toBe(false);
    expect(await shareOrDownload(file())).toBe('downloaded');
    shareSheet({ canShare: false });
    expect(await shareOrDownload(file())).toBe('downloaded');
    expect(clicked.map((a) => a.download)).toEqual(['termhub-cidade-pedro-story.png', 'termhub-cidade-pedro-story.png']);
  });

  // Review Focus 4
  it('does nothing more when the person closes the share sheet', async () => {
    shareSheet({ canShare: true, share: async () => { throw new DOMException('closed', 'AbortError'); } });
    expect(await shareOrDownload(file())).toBe('dismissed');
    expect(clicked).toHaveLength(0);
  });

  it('falls back to a download when the share sheet rejects the file', async () => {
    shareSheet({ canShare: true, share: async () => { throw new DOMException('no', 'NotAllowedError'); } });
    expect(await shareOrDownload(file())).toBe('downloaded');
    expect(clicked).toHaveLength(1);
  });

  it('treats a canShare that throws as no share sheet', () => {
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => { throw new TypeError('bad'); } });
    Object.defineProperty(navigator, 'share', { configurable: true, value: vi.fn() });
    expect(canShareFile(file())).toBe(false);
  });
});
```

- [ ] **Step 2: Run them to see them fail.** `WEBTEST src/city/share/images.test.ts src/city/share/deliver.test.ts` — Expected: FAIL, the modules do not exist.

- [ ] **Step 3: Implement.** Create `apps/web/src/city/share/images.ts`:

```ts
/**
 * Stills (spec 2026-09-23 §2.3): one composed frame on an offscreen canvas at the output size, as a
 * PNG. The WebGL scene can only be read right after it renders, so the still is drawn inside the
 * next frame callback — never by reading the scene's canvas later.
 */
import { drawFrame, FORMAT_SIZE, layoutFor, type ShareFormat, type ShareInfo } from './compose';

/** What the share code needs from the scene: OfficeScene.onFrame. */
export interface FrameSource {
  onFrame(cb: (canvas: HTMLCanvasElement) => void): () => void;
}

export function captureStill(source: FrameSource, format: ShareFormat, info: ShareInfo, timeoutMs = 2_000): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const size = FORMAT_SIZE[format];
    const canvas = document.createElement('canvas');
    canvas.width = size.width;
    canvas.height = size.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return reject(new Error('no 2d canvas'));
    let settled = false;
    let off: () => void = () => {};
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      off();
      reject(new Error('no frame from the scene'));
    }, timeoutMs);
    off = source.onFrame((scene) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      drawFrame(ctx, layoutFor(format, info), scene);
      // unsubscribe outside the render loop that is calling us
      queueMicrotask(() => off());
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('the canvas gave no image'))), 'image/png');
    });
  });
}

export function fileNameFor(nickname: string, kind: ShareFormat, ext: 'png' | 'mp4' | 'webm'): string {
  return `termhub-cidade-${nickname}-${kind}.${ext}`;
}
```

Create `apps/web/src/city/share/deliver.ts`:

```ts
/**
 * Getting a file out of the page (spec 2026-09-23 §2.6): the native share sheet where it accepts
 * the file (on a phone, Instagram is in it), a download everywhere else. Closing the sheet is the
 * person's answer, not a failure: nothing is downloaded behind their back.
 */
export type Delivery = 'shared' | 'dismissed' | 'downloaded';

export function canShareFile(file: File): boolean {
  try {
    return typeof navigator.share === 'function' && typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] });
  } catch {
    return false;
  }
}

export function downloadFile(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // long enough for the browser to start reading it
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export async function shareOrDownload(file: File): Promise<Delivery> {
  if (!canShareFile(file)) {
    downloadFile(file, file.name);
    return 'downloaded';
  }
  try {
    await navigator.share({ files: [file] });
    return 'shared';
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return 'dismissed';
    downloadFile(file, file.name);
    return 'downloaded';
  }
}
```

- [ ] **Step 4: Run them to see them pass.** `WEBTEST src/city/share/images.test.ts src/city/share/deliver.test.ts` — Expected: PASS. (In the first images test, `listeners.size` is 0 after `await pending` because the microtask that unsubscribes runs before the awaited promise resumes.)

- [ ] **Step 5: Commit.**

```bash
git add apps/web/src/city/share/images.ts apps/web/src/city/share/images.test.ts apps/web/src/city/share/deliver.ts apps/web/src/city/share/deliver.test.ts
git commit -m "City: capture share stills and deliver files

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task B4: The city soundscape

**Files:**
- Create: `apps/web/src/city/share/sound.ts`
- Test: `apps/web/src/city/share/sound.test.ts`

**Interfaces:**
- Consumes: `CityModel`, `DeskModel` from `apps/web/src/office/model.ts`.
- Produces:

```ts
export type SoundEvent = { kind: 'typing'; typists: number } | { kind: 'ding'; desk: string };
export function soundEvents(prev: CityModel | null, next: CityModel): SoundEvent[];
export interface Soundscape { readonly stream: MediaStream; play(events: SoundEvent[]): void; stop(): void }
export function createSoundscape(ctx: AudioContext): Soundscape;   // recording only: connected to a MediaStreamAudioDestinationNode, never to ctx.destination
```

A robot "types" when its desk is drawn typing (`pose === 'type'`: every working robot, whatever its activity); a robot "raises its hand" when its desk's `marker` becomes `'input'` or `'permission'` — the same test the model uses for `needsYou`. Desks are keyed `machineId:deskId`, since two machines may carry the same tab id.

- [ ] **Step 1: Write the failing test.** Create `apps/web/src/city/share/sound.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { CityModel, DeskModel } from '../../office/model';
import { soundEvents } from './sound';

const desk = (id: string, pose: DeskModel['pose'], marker: DeskModel['marker'] = null) => ({ id, pose, marker }) as DeskModel;
const city = (...machines: Array<[string, DeskModel[]]>): CityModel =>
  ({ needsYou: 0, machines: machines.map(([id, desks]) => ({ id, floor: { rooms: [{ id: `${id}-r`, desks }] } })) }) as unknown as CityModel;

describe('soundEvents', () => {
  it('starts the clicks with the robots typing when the clip starts, and no dings', () => {
    expect(soundEvents(null, city(['b1', [desk('a', 'type'), desk('b', 'type'), desk('c', 'raise', 'input')]]))).toEqual([{ kind: 'typing', typists: 2 }]);
    expect(soundEvents(null, city(['b1', [desk('a', 'sleep')]]))).toEqual([]);
  });

  it('follows the number of typing robots', () => {
    const before = city(['b1', [desk('a', 'type'), desk('b', 'sit')]]);
    const after = city(['b1', [desk('a', 'type'), desk('b', 'type')]]);
    expect(soundEvents(before, after)).toEqual([{ kind: 'typing', typists: 2 }]);
    expect(soundEvents(after, before)).toEqual([{ kind: 'typing', typists: 1 }]);
  });

  it('dings once per newly raised hand, input or permission', () => {
    const before = city(['b1', [desk('a', 'type'), desk('b', 'type')]]);
    const after = city(['b1', [desk('a', 'raise', 'input'), desk('b', 'raise', 'permission')]]);
    expect(soundEvents(before, after)).toEqual([
      { kind: 'typing', typists: 0 },
      { kind: 'ding', desk: 'b1:a' },
      { kind: 'ding', desk: 'b1:b' },
    ]);
    // a hand that stays up does not ding again, nor does an error marker
    expect(soundEvents(after, after)).toEqual([]);
    expect(soundEvents(before, city(['b1', [desk('a', 'shake', 'error'), desk('b', 'type')]]))).toEqual([{ kind: 'typing', typists: 1 }]);
  });

  it('tells two machines’ desks with the same id apart', () => {
    const before = city(['b1', [desk('a', 'raise', 'input')]], ['b2', [desk('a', 'sit')]]);
    const after = city(['b1', [desk('a', 'raise', 'input')]], ['b2', [desk('a', 'raise', 'input')]]);
    expect(soundEvents(before, after)).toEqual([{ kind: 'ding', desk: 'b2:a' }]);
  });

  it('plays nothing when nothing changed', () => {
    const same = city(['b1', [desk('a', 'type'), desk('b', 'raise', 'input')]]);
    expect(soundEvents(same, city(['b1', [desk('a', 'type'), desk('b', 'raise', 'input')]]))).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to see it fail.** `WEBTEST src/city/share/sound.test.ts` — Expected: FAIL, `Cannot find module './sound'`.

- [ ] **Step 3: Implement.** Create `apps/web/src/city/share/sound.ts`:

```ts
/**
 * The city soundscape (spec 2026-09-23 §2.5), synthesised with Web Audio — no audio files, no
 * rights: a low hum, keyboard clicks as dense as the robots typing, and a soft ding when a robot
 * raises its hand. It exists only inside a recording: the output goes to a
 * MediaStreamAudioDestinationNode, never to the speakers, so the page itself stays silent.
 */
import type { CityModel } from '../../office/model';

export type SoundEvent = { kind: 'typing'; typists: number } | { kind: 'ding'; desk: string };

function read(model: CityModel): { typists: number; raised: Set<string> } {
  let typists = 0;
  const raised = new Set<string>();
  for (const machine of model.machines) {
    for (const room of machine.floor.rooms) {
      for (const desk of room.desks) {
        if (desk.pose === 'type') typists += 1;
        if (desk.marker === 'input' || desk.marker === 'permission') raised.add(`${machine.id}:${desk.id}`);
      }
    }
  }
  return { typists, raised };
}

/** What to play between two snapshots of the model the page draws. `prev` null = the clip starts. */
export function soundEvents(prev: CityModel | null, next: CityModel): SoundEvent[] {
  const now = read(next);
  if (!prev) return now.typists > 0 ? [{ kind: 'typing', typists: now.typists }] : [];
  const before = read(prev);
  const events: SoundEvent[] = [];
  if (now.typists !== before.typists) events.push({ kind: 'typing', typists: now.typists });
  for (const desk of now.raised) if (!before.raised.has(desk)) events.push({ kind: 'ding', desk });
  return events;
}

export interface Soundscape {
  readonly stream: MediaStream;
  play(events: SoundEvent[]): void;
  stop(): void;
}

/** Clicks per second each typing robot contributes, and the most one tick schedules. */
const KEYS_PER_SECOND = 6;
const TICK_MS = 50;
const MAX_CLICKS_PER_TICK = 4;

export function createSoundscape(ctx: AudioContext): Soundscape {
  const out = ctx.createMediaStreamDestination();
  const master = ctx.createGain();
  master.gain.value = 0.8;
  master.connect(out);

  // the hum: a low sine and its octave, barely there
  const hum = ctx.createOscillator();
  hum.type = 'sine';
  hum.frequency.value = 55;
  const humOctave = ctx.createOscillator();
  humOctave.type = 'sine';
  humOctave.frequency.value = 110;
  const humGain = ctx.createGain();
  humGain.gain.value = 0.05;
  hum.connect(humGain);
  humOctave.connect(humGain);
  humGain.connect(master);
  hum.start();
  humOctave.start();

  // one key click: 30 ms of noise with a steep decay, reused for every click
  const click = ctx.createBuffer(1, Math.max(1, Math.floor(ctx.sampleRate * 0.03)), ctx.sampleRate);
  const data = click.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length) ** 4;
  const clickAt = (when: number) => {
    const src = ctx.createBufferSource();
    src.buffer = click;
    src.playbackRate.value = 0.85 + Math.random() * 0.3;
    const g = ctx.createGain();
    g.gain.value = 0.18;
    src.connect(g);
    g.connect(master);
    src.start(when);
  };

  let typists = 0;
  const timer = setInterval(() => {
    const expected = (typists * KEYS_PER_SECOND * TICK_MS) / 1000;
    let n = Math.floor(expected) + (Math.random() < expected % 1 ? 1 : 0);
    n = Math.min(n, MAX_CLICKS_PER_TICK);
    for (let i = 0; i < n; i++) clickAt(ctx.currentTime + Math.random() * (TICK_MS / 1000));
  }, TICK_MS);

  const ding = () => {
    const t = ctx.currentTime;
    for (const [freq, level] of [[880, 0.16], [1320, 0.06]] as const) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const g = ctx.createGain();
      g.gain.setValueAtTime(level, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
      osc.connect(g);
      g.connect(master);
      osc.start(t);
      osc.stop(t + 1);
    }
  };

  return {
    stream: out.stream,
    play(events) {
      for (const e of events) {
        if (e.kind === 'typing') typists = e.typists;
        else ding();
      }
    },
    stop() {
      clearInterval(timer);
      hum.stop();
      humOctave.stop();
      master.disconnect();
    },
  };
}
```

- [ ] **Step 4: Run it to see it pass.** `WEBTEST src/city/share/sound.test.ts` — Expected: PASS. Then `DOCKER 'npm run typecheck -w @termhub/web'` — Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add apps/web/src/city/share/sound.ts apps/web/src/city/share/sound.test.ts
git commit -m "City: a synthesised soundscape for the story video

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task B5: Recording the story video

**Files:**
- Create: `apps/web/src/city/share/record.ts`
- Test: `apps/web/src/city/share/record.test.ts`

**Interfaces:**
- Consumes: `layoutFor`, `drawFrame`, `FORMAT_SIZE`, `ShareInfo` (Task B2); `FrameSource` (Task B3); `createSoundscape`, `soundEvents` (Task B4); `CityModel`.
- Produces:

```ts
export const STORY_VIDEO_MS = 10_000;
export const VIDEO_TYPES: readonly string[];   // mp4 avc1+mp4a → mp4 → webm vp9+opus → webm
export function pickMimeType(isTypeSupported: (type: string) => boolean): string | null;
export function extensionFor(mimeType: string): 'mp4' | 'webm';
export function isWebm(mimeType: string): boolean;
export function canRecordVideo(): boolean;     // MediaRecorder + captureStream + a supported type
export class RecordingCancelled extends Error {}
export interface RecordingResult { blob: Blob; mimeType: string }
export interface Recording { done: Promise<RecordingResult>; cancel(): void }
export function runRecorder(opts: { stream: MediaStream; mimeType: string; durationMs: number; onProgress?: (elapsedMs: number) => void; cleanup: () => void }): Recording;
export function recordStory(opts: { source: FrameSource; info: () => ShareInfo; model: () => CityModel; durationMs?: number; onProgress?: (elapsedMs: number) => void }): Recording;
```

`runRecorder` is the testable mechanics (a `MediaRecorder` over any stream, stopped at `durationMs` or on `cancel`); `recordStory` wires the real browser pieces around it — a 1080×1920 canvas redrawn on every scene frame, `captureStream(30)`, the soundscape — and is covered through the share panel's tests with it mocked.

- [ ] **Step 1: Write the failing test.** Create `apps/web/src/city/share/record.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { extensionFor, isWebm, pickMimeType, RecordingCancelled, runRecorder, VIDEO_TYPES } from './record';

describe('pickMimeType', () => {
  it('prefers MP4 with H.264 and AAC, then plain MP4, then WebM', () => {
    expect(VIDEO_TYPES).toEqual(['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm']);
    expect(pickMimeType(() => true)).toBe('video/mp4;codecs=avc1.42E01E,mp4a.40.2');
    expect(pickMimeType((t) => t === 'video/mp4' || t.startsWith('video/webm'))).toBe('video/mp4');
    expect(pickMimeType((t) => t.startsWith('video/webm'))).toBe('video/webm;codecs=vp9,opus');
    expect(pickMimeType((t) => t === 'video/webm')).toBe('video/webm');
  });

  it('answers null when nothing is supported, or the question throws', () => {
    expect(pickMimeType(() => false)).toBeNull();
    expect(pickMimeType(() => { throw new Error('nope'); })).toBeNull();
  });

  it('names the file after the container', () => {
    expect(extensionFor('video/mp4;codecs=avc1.42E01E,mp4a.40.2')).toBe('mp4');
    expect(extensionFor('video/webm;codecs=vp9,opus')).toBe('webm');
    expect(isWebm('video/webm')).toBe(true);
    expect(isWebm('video/mp4')).toBe(false);
  });
});

class FakeRecorder {
  static last: FakeRecorder;
  state: 'inactive' | 'recording' = 'inactive';
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public stream: unknown, public options: { mimeType: string }) {
    FakeRecorder.last = this;
  }
  start() {
    this.state = 'recording';
  }
  stop() {
    this.state = 'inactive';
    this.ondataavailable?.({ data: new Blob(['video'], { type: this.options.mimeType }) });
    this.onstop?.();
  }
}

describe('runRecorder', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('MediaRecorder', FakeRecorder);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('records for the whole duration, reporting progress, then lets go of everything', async () => {
    const onProgress = vi.fn();
    const cleanup = vi.fn();
    const rec = runRecorder({ stream: {} as MediaStream, mimeType: 'video/mp4', durationMs: 10_000, onProgress, cleanup });
    expect(FakeRecorder.last.options.mimeType).toBe('video/mp4');
    await vi.advanceTimersByTimeAsync(7_000);
    expect(onProgress).toHaveBeenLastCalledWith(7_000);
    expect(cleanup).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3_000);
    const result = await rec.done;
    expect(result.mimeType).toBe('video/mp4');
    expect(result.blob.size).toBeGreaterThan(0);
    expect(onProgress).toHaveBeenLastCalledWith(10_000);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('cancelling rejects with RecordingCancelled and still lets go of everything', async () => {
    const cleanup = vi.fn();
    const rec = runRecorder({ stream: {} as MediaStream, mimeType: 'video/webm', durationMs: 10_000, cleanup });
    const settled = rec.done.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(2_000);
    rec.cancel();
    expect(await settled).toBeInstanceOf(RecordingCancelled);
    expect(cleanup).toHaveBeenCalledTimes(1);
    rec.cancel(); // a second cancel is harmless
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('a recorder error rejects with an error that is not a cancel', async () => {
    const rec = runRecorder({ stream: {} as MediaStream, mimeType: 'video/webm', durationMs: 10_000, cleanup: vi.fn() });
    const settled = rec.done.catch((e: unknown) => e);
    FakeRecorder.last.onerror?.();
    const err = await settled;
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(RecordingCancelled);
  });
});
```

- [ ] **Step 2: Run it to see it fail.** `WEBTEST src/city/share/record.test.ts` — Expected: FAIL, `Cannot find module './record'`.

- [ ] **Step 3: Implement.** Create `apps/web/src/city/share/record.ts`:

```ts
/**
 * The 10-second story video (spec 2026-09-23 §2.4), recorded in real time in the visitor's
 * browser: a 1080×1920 canvas redrawn with the compositor on every scene frame gives the video
 * track (captureStream), the synthesised soundscape gives the audio track, and a MediaRecorder
 * writes both. No server work.
 */
import type { CityModel } from '../../office/model';
import { drawFrame, FORMAT_SIZE, layoutFor, type ShareInfo } from './compose';
import type { FrameSource } from './images';
import { createSoundscape, soundEvents } from './sound';

export const STORY_VIDEO_MS = 10_000;

/** First supported wins: MP4 is what Instagram takes; WebM is the fallback some browsers only have. */
export const VIDEO_TYPES: readonly string[] = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm'];

export function pickMimeType(isTypeSupported: (type: string) => boolean): string | null {
  for (const type of VIDEO_TYPES) {
    try {
      if (isTypeSupported(type)) return type;
    } catch {
      /* a browser that throws on the question cannot record the answer */
    }
  }
  return null;
}

export const isWebm = (mimeType: string): boolean => mimeType.startsWith('video/webm');
export const extensionFor = (mimeType: string): 'mp4' | 'webm' => (isWebm(mimeType) ? 'webm' : 'mp4');

/** MediaRecorder, canvas capture and at least one type this browser can write. */
export function canRecordVideo(): boolean {
  if (typeof MediaRecorder === 'undefined' || typeof HTMLCanvasElement === 'undefined') return false;
  if (typeof HTMLCanvasElement.prototype.captureStream !== 'function') return false;
  return pickMimeType((t) => MediaRecorder.isTypeSupported(t)) !== null;
}

export class RecordingCancelled extends Error {
  constructor() {
    super('recording cancelled');
    this.name = 'RecordingCancelled';
  }
}

export interface RecordingResult { blob: Blob; mimeType: string }
export interface Recording { done: Promise<RecordingResult>; cancel(): void }

const PROGRESS_MS = 250;

export function runRecorder(opts: { stream: MediaStream; mimeType: string; durationMs: number; onProgress?: (elapsedMs: number) => void; cleanup: () => void }): Recording {
  const recorder = new MediaRecorder(opts.stream, { mimeType: opts.mimeType });
  const chunks: Blob[] = [];
  let outcome: 'recorded' | 'cancelled' | 'failed' = 'recorded';
  let tick: ReturnType<typeof setInterval> | null = null;
  const started = Date.now();

  const done = new Promise<RecordingResult>((resolve, reject) => {
    recorder.ondataavailable = (e: BlobEvent) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    recorder.onstop = () => {
      if (tick) clearInterval(tick);
      opts.cleanup();
      if (outcome === 'cancelled') reject(new RecordingCancelled());
      else if (outcome === 'failed') reject(new Error('the recorder failed'));
      else resolve({ blob: new Blob(chunks, { type: opts.mimeType }), mimeType: opts.mimeType });
    };
    recorder.onerror = () => {
      outcome = 'failed';
      if (recorder.state !== 'inactive') recorder.stop();
      else recorder.onstop?.(new Event('stop'));
    };
  });

  recorder.start(PROGRESS_MS);
  tick = setInterval(() => {
    const elapsed = Math.min(Date.now() - started, opts.durationMs);
    opts.onProgress?.(elapsed);
    if (elapsed >= opts.durationMs && recorder.state === 'recording') recorder.stop();
  }, PROGRESS_MS);

  return {
    done,
    cancel() {
      if (recorder.state === 'inactive') return;
      outcome = 'cancelled';
      recorder.stop();
    },
  };
}

export function recordStory(opts: { source: FrameSource; info: () => ShareInfo; model: () => CityModel; durationMs?: number; onProgress?: (elapsedMs: number) => void }): Recording {
  const mimeType = pickMimeType((t) => MediaRecorder.isTypeSupported(t));
  const canvas = document.createElement('canvas');
  canvas.width = FORMAT_SIZE.story.width;
  canvas.height = FORMAT_SIZE.story.height;
  const ctx = canvas.getContext('2d');
  if (!mimeType || !ctx) return { done: Promise.reject(new Error('this browser cannot record the video')), cancel: () => {} };

  const audio = new AudioContext();
  const sound = createSoundscape(audio);
  let heard: CityModel | null = null;
  // redraw on every scene frame; the counts and the sounds follow the model the page draws
  const off = opts.source.onFrame((scene) => {
    drawFrame(ctx, layoutFor('story', opts.info()), scene);
    const model = opts.model();
    if (model !== heard) {
      sound.play(soundEvents(heard, model));
      heard = model;
    }
  });
  const video = canvas.captureStream(30);
  const stream = new MediaStream([...video.getVideoTracks(), ...sound.stream.getAudioTracks()]);

  return runRecorder({
    stream,
    mimeType,
    durationMs: opts.durationMs ?? STORY_VIDEO_MS,
    onProgress: opts.onProgress,
    cleanup: () => {
      off();
      sound.stop();
      stream.getTracks().forEach((t) => t.stop());
      void audio.close();
    },
  });
}
```

- [ ] **Step 4: Run it to see it pass.** `WEBTEST src/city/share/record.test.ts` — Expected: PASS. Then `DOCKER 'npm run typecheck -w @termhub/web'` — Expected: PASS (`BlobEvent`, `MediaRecorder`, `captureStream` and `AudioContext` are in TypeScript's DOM lib, which `tsconfig.app.json` includes).

- [ ] **Step 5: Commit.**

```bash
git add apps/web/src/city/share/record.ts apps/web/src/city/share/record.test.ts
git commit -m "City: record a 10-second story video with sound

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---
### Task B6: The share panel

**Files:**
- Create: `apps/web/src/city/share/CopyLinkButton.tsx`, `apps/web/src/city/share/SharePanel.tsx`
- Test: `apps/web/src/city/share/SharePanel.test.tsx`

**Interfaces:**
- Consumes: `shareInfoFor`, `ShareFormat` (Task B2); `captureStill`, `fileNameFor`, `FrameSource` (Task B3); `canShareFile`, `shareOrDownload`, `downloadFile` (Task B3); `canRecordVideo`, `recordStory`, `RecordingCancelled`, `extensionFor`, `isWebm`, `STORY_VIDEO_MS`, `Recording` (Task B5); `PublicCity` with `short_url` (Task A5); `CityModel`.
- Produces:

```ts
export function CopyLinkButton(props: { url: string; className?: string }): JSX.Element;   // "Copiar link" / "Link copiado"
export interface ShareScene extends FrameSource { lockCamera(locked: boolean): void }     // OfficeScene satisfies it
export function SharePanel(props: {
  scene: ShareScene;
  city: PublicCity;
  model: CityModel;
  /** the city's long address: the media footers print it when there is no short link */
  cityUrl: string;
  /** what "Copiar link" copies: the short link at the city, the long link of the building or room in view */
  copyUrl: string;
  onClose(): void;
}): JSX.Element;
```

The panel is a `role="dialog"` named "Compartilhar a cidade". Phases: the options; "Preparando a imagem…"; recording ("Gravando… 7 s", a progress bar, "Cancelar"); done (a preview, then "Compartilhar" where the share sheet accepts the file, "Baixar", and "Gravar de novo" for the video or "Voltar" for an image); stopped (the page was hidden: "Gravar de novo"; a failure: "Voltar"). The camera is locked for exactly as long as a recording runs, whatever ends it.

- [ ] **Step 1: Write the failing test.** Create `apps/web/src/city/share/SharePanel.test.tsx`:

```tsx
// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PublicCity } from '../../lib/types';
import { buildCityModel } from '../../office/model';
import { toMachineEntries } from '../api';

const { recordStory, canRecordVideo, captureStill, canShareFile, shareOrDownload, downloadFile } = vi.hoisted(() => ({
  recordStory: vi.fn(),
  canRecordVideo: vi.fn(() => true),
  captureStill: vi.fn(),
  canShareFile: vi.fn(() => false),
  shareOrDownload: vi.fn(async () => 'shared'),
  downloadFile: vi.fn(),
}));
vi.mock('./record', async (importOriginal) => ({ ...(await importOriginal<typeof import('./record')>()), recordStory, canRecordVideo }));
vi.mock('./images', async (importOriginal) => ({ ...(await importOriginal<typeof import('./images')>()), captureStill }));
vi.mock('./deliver', () => ({ canShareFile, shareOrDownload, downloadFile }));

import { RecordingCancelled, type RecordingResult } from './record';
import { SharePanel, type ShareScene } from './SharePanel';

const CITY: PublicCity = {
  nickname: 'pedro',
  owner_name: 'Pedro',
  short_url: 'https://77a.it/pedro',
  buildings: [{ id: 'b1', name: 'Jarvis', rooms: [{ id: 'r1', name: 'Engage Easy', robots: [{ id: 'x1', name: 'aba 1', kind: 'terminal', state: 'working', state_at: '2026-09-23T10:00:00.000Z', activity: 'coding', alive: true, progress: null }] }] }],
};
const MODEL = buildCityModel(toMachineEntries(CITY), () => undefined);

let scene: ShareScene & { lockCamera: ReturnType<typeof vi.fn> };
const onClose = vi.fn();

function fakeRecording() {
  let resolve!: (r: RecordingResult) => void;
  let reject!: (e: unknown) => void;
  const done = new Promise<RecordingResult>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const rec = { done, cancel: vi.fn(() => reject(new RecordingCancelled())), resolve, reject };
  recordStory.mockReturnValue(rec);
  return rec;
}

const progress = (ms: number) =>
  act(() => {
    recordStory.mock.calls.at(-1)![0].onProgress(ms);
  });

function setHidden(hidden: boolean) {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
}

function renderPanel() {
  return render(<SharePanel scene={scene} city={CITY} model={MODEL} cityUrl="https://termhub.dev/city/@pedro" copyUrl="https://77a.it/pedro" onClose={onClose} />);
}

beforeEach(() => {
  scene = { onFrame: vi.fn(() => () => {}), lockCamera: vi.fn() };
  recordStory.mockReset();
  canRecordVideo.mockReset().mockReturnValue(true);
  captureStill.mockReset();
  canShareFile.mockReset().mockReturnValue(false);
  shareOrDownload.mockReset().mockResolvedValue('shared');
  downloadFile.mockReset();
  onClose.mockReset();
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:preview') });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
  setHidden(false);
});

afterEach(() => {
  cleanup();
  setHidden(false);
});

describe('SharePanel', () => {
  it('offers the two images, the video and the link', () => {
    renderPanel();
    expect(screen.getByRole('dialog', { name: 'Compartilhar a cidade' })).toBeTruthy();
    for (const name of ['Story (imagem)', 'Post (imagem)', 'Vídeo para story (10 s, com som)', 'Copiar link']) {
      expect(screen.getByRole('button', { name })).toBeTruthy();
    }
    fireEvent.click(screen.getByRole('button', { name: 'Fechar' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('disables the video where the browser cannot record, keeping the images', () => {
    canRecordVideo.mockReturnValue(false);
    renderPanel();
    expect((screen.getByRole('button', { name: 'Vídeo para story (10 s, com som)' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Seu navegador não grava vídeo; as imagens continuam disponíveis.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Story (imagem)' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('records with progress and the camera locked, and cancels back to the options', async () => {
    const rec = fakeRecording();
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Vídeo para story (10 s, com som)' }));
    expect(scene.lockCamera).toHaveBeenLastCalledWith(true);
    expect(recordStory.mock.calls[0][0].source).toBe(scene);
    progress(7_000);
    expect(screen.getByText('Gravando… 7 s')).toBeTruthy();
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('7');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    });
    expect(rec.cancel).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Story (imagem)' })).toBeTruthy();
    expect(scene.lockCamera).toHaveBeenLastCalledWith(false);
  });

  // Review Focus 5
  it('stops when the page is hidden, says why, and offers to record again', async () => {
    const rec = fakeRecording();
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Vídeo para story (10 s, com som)' }));
    setHidden(true);
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(rec.cancel).toHaveBeenCalled();
    expect(screen.getByText(/a gravação parou porque a página saiu da tela/i)).toBeTruthy();
    expect(scene.lockCamera).toHaveBeenLastCalledWith(false);
    setHidden(false);
    fakeRecording();
    fireEvent.click(screen.getByRole('button', { name: 'Gravar de novo' }));
    expect(recordStory).toHaveBeenCalledTimes(2);
  });

  it('hands a finished video to the share sheet where it can, warning about WebM', async () => {
    canShareFile.mockReturnValue(true);
    const rec = fakeRecording();
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Vídeo para story (10 s, com som)' }));
    await act(async () => {
      rec.resolve({ blob: new Blob(['v'], { type: 'video/webm' }), mimeType: 'video/webm;codecs=vp9,opus' });
    });
    expect(screen.getByText('O Instagram pode não aceitar WebM. No celular, use o Safari ou o Chrome.')).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Compartilhar' }));
    });
    expect((shareOrDownload.mock.calls[0][0] as File).name).toBe('termhub-cidade-pedro-story.webm');
    expect(screen.getByRole('button', { name: 'Gravar de novo' })).toBeTruthy();
  });

  it('only downloads where there is no share sheet, and says nothing about WebM for an MP4', async () => {
    const rec = fakeRecording();
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Vídeo para story (10 s, com som)' }));
    await act(async () => {
      rec.resolve({ blob: new Blob(['v'], { type: 'video/mp4' }), mimeType: 'video/mp4' });
    });
    expect(screen.queryByRole('button', { name: 'Compartilhar' })).toBeNull();
    expect(screen.queryByText(/webm/i)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Baixar' }));
    expect(downloadFile).toHaveBeenCalledWith(expect.any(File), 'termhub-cidade-pedro-story.mp4');
  });

  it('makes a story image of the live city, with its short link and counts', async () => {
    captureStill.mockResolvedValue(new Blob(['png'], { type: 'image/png' }));
    renderPanel();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Story (imagem)' }));
    });
    expect(captureStill).toHaveBeenCalledWith(scene, 'story', { ownerName: 'Pedro', working: 1, waiting: 0, shortLink: '77a.it/pedro' });
    expect(screen.getByRole('img', { name: 'Prévia da imagem' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Baixar' }));
    expect(downloadFile).toHaveBeenCalledWith(expect.any(File), 'termhub-cidade-pedro-story.png');
    fireEvent.click(screen.getByRole('button', { name: 'Voltar' }));
    expect(screen.getByRole('button', { name: 'Post (imagem)' })).toBeTruthy();
  });

  it('says so when an image cannot be made', async () => {
    captureStill.mockRejectedValue(new Error('no frame from the scene'));
    renderPanel();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Post (imagem)' }));
    });
    expect(screen.getByText('Não foi possível gerar o arquivo.')).toBeTruthy();
  });

  it('copies the link it was given', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    renderPanel();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copiar link' }));
    });
    expect(writeText).toHaveBeenCalledWith('https://77a.it/pedro');
    expect(screen.getByRole('button', { name: 'Link copiado' })).toBeTruthy();
  });

  it('cancels a recording when the panel goes away', () => {
    const rec = fakeRecording();
    const { unmount } = renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Vídeo para story (10 s, com som)' }));
    unmount();
    expect(rec.cancel).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it to see it fail.** `WEBTEST src/city/share/SharePanel.test.tsx` — Expected: FAIL, `Cannot find module './SharePanel'`.

- [ ] **Step 3: Implement.** Create `apps/web/src/city/share/CopyLinkButton.tsx`:

```tsx
import { useEffect, useState } from 'react';

/** "Copiar link", with its own feedback. Used by the share panel and, when the scene cannot draw, by the top bar. */
export function CopyLinkButton({ url, className }: { url: string; className?: string }) {
  const [status, setStatus] = useState<'idle' | 'copied' | 'failed'>('idle');

  useEffect(() => {
    if (status === 'idle') return;
    const id = setTimeout(() => setStatus('idle'), 2500);
    return () => clearTimeout(id);
  }, [status]);

  const copy = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('no clipboard API');
      await navigator.clipboard.writeText(url);
      setStatus('copied');
    } catch {
      setStatus('failed');
    }
  };

  return (
    <button type="button" className={className} onClick={() => void copy()} title={url}>
      {status === 'copied' ? 'Link copiado' : status === 'failed' ? `Copie: ${url}` : 'Copiar link'}
    </button>
  );
}
```

Create `apps/web/src/city/share/SharePanel.tsx`:

```tsx
import { useEffect, useRef, useState } from 'react';
import type { CityModel } from '../../office/model';
import type { PublicCity } from '../../lib/types';
import { shareInfoFor, type ShareFormat } from './compose';
import { CopyLinkButton } from './CopyLinkButton';
import { canShareFile, downloadFile, shareOrDownload } from './deliver';
import { captureStill, fileNameFor, type FrameSource } from './images';
import { canRecordVideo, extensionFor, isWebm, recordStory, RecordingCancelled, STORY_VIDEO_MS, type Recording } from './record';

/** What the panel needs from the scene: its frames, and a camera it can hold still. OfficeScene is one. */
export interface ShareScene extends FrameSource {
  lockCamera(locked: boolean): void;
}

type Phase =
  | { kind: 'menu' }
  | { kind: 'busy' }
  | { kind: 'recording'; elapsedMs: number }
  | { kind: 'done'; file: File; preview: string; video: boolean; webm: boolean }
  | { kind: 'stopped'; reason: 'hidden' | 'failed'; video: boolean };

const OPTION = 'w-full rounded-md border border-line bg-bg-3 px-3 py-2 text-left text-sm text-fg hover:bg-bg-4 disabled:cursor-not-allowed disabled:opacity-50';
const ACTION = 'rounded-md border border-line px-3 py-1.5 text-sm text-fg hover:bg-bg-3';
const PRIMARY = 'rounded-md bg-accent px-3 py-1.5 text-sm font-semibold text-white hover:bg-accent-hover';

/**
 * Compartilhar (spec 2026-09-23 §2.6): a story image, a post image, a 10-second story video with
 * sound, and the link — all made here, in the visitor's browser, from the scene the page draws.
 */
export function SharePanel({ scene, city, model, cityUrl, copyUrl, onClose }: { scene: ShareScene; city: PublicCity; model: CityModel; cityUrl: string; copyUrl: string; onClose(): void }) {
  const [phase, setPhase] = useState<Phase>({ kind: 'menu' });
  const [videoOk] = useState(canRecordVideo);
  const recording = useRef<Recording | null>(null);
  /** the running recording was stopped because the page was hidden, not by the person */
  const stoppedByHide = useRef(false);
  // the counts and the sounds follow the city while it records, not the city when the button was pressed
  const modelRef = useRef(model);
  useEffect(() => {
    modelRef.current = model;
  }, [model]);
  const info = () => shareInfoFor(city, modelRef.current, cityUrl);

  useEffect(() => {
    if (phase.kind !== 'done') return;
    const url = phase.preview;
    return () => URL.revokeObjectURL(url);
  }, [phase]);

  // a hidden tab stops drawing frames, so the video would freeze: stop and say so
  useEffect(() => {
    const onVisibility = () => {
      if (!document.hidden || !recording.current) return;
      stoppedByHide.current = true;
      recording.current.cancel();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  // closing the panel mid-recording stops it (and so unlocks the camera)
  useEffect(() => () => recording.current?.cancel(), []);

  const finish = (blob: Blob, name: string, video: boolean, webm: boolean) => {
    const file = new File([blob], name, { type: blob.type });
    setPhase({ kind: 'done', file, preview: URL.createObjectURL(file), video, webm });
  };

  const still = async (format: ShareFormat) => {
    setPhase({ kind: 'busy' });
    try {
      finish(await captureStill(scene, format, info()), fileNameFor(city.nickname, format, 'png'), false, false);
    } catch {
      setPhase({ kind: 'stopped', reason: 'failed', video: false });
    }
  };

  const video = async () => {
    stoppedByHide.current = false;
    setPhase({ kind: 'recording', elapsedMs: 0 });
    scene.lockCamera(true);
    const rec = recordStory({ source: scene, info, model: () => modelRef.current, durationMs: STORY_VIDEO_MS, onProgress: (elapsedMs) => setPhase({ kind: 'recording', elapsedMs }) });
    recording.current = rec;
    try {
      const { blob, mimeType } = await rec.done;
      finish(blob, fileNameFor(city.nickname, 'story', extensionFor(mimeType)), true, isWebm(mimeType));
    } catch (err) {
      if (stoppedByHide.current) setPhase({ kind: 'stopped', reason: 'hidden', video: true });
      else if (err instanceof RecordingCancelled) setPhase({ kind: 'menu' });
      else setPhase({ kind: 'stopped', reason: 'failed', video: true });
    } finally {
      recording.current = null;
      scene.lockCamera(false);
    }
  };

  const seconds = phase.kind === 'recording' ? Math.floor(phase.elapsedMs / 1000) : 0;
  const total = STORY_VIDEO_MS / 1000;

  return (
    <div role="dialog" aria-label="Compartilhar a cidade" className="space-y-3 rounded-b-xl border border-line bg-bg-2 p-4 shadow-xl sm:rounded-lg">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-fg">Compartilhar</h2>
        <button type="button" aria-label="Fechar" className="rounded px-2 text-fg-muted hover:text-fg" onClick={onClose}>
          ×
        </button>
      </div>

      {phase.kind === 'menu' && (
        <div className="grid gap-2">
          <button type="button" className={OPTION} onClick={() => void still('story')}>
            Story (imagem)
          </button>
          <button type="button" className={OPTION} onClick={() => void still('post')}>
            Post (imagem)
          </button>
          <button type="button" className={OPTION} disabled={!videoOk} onClick={() => void video()}>
            Vídeo para story (10 s, com som)
          </button>
          {!videoOk && <p className="text-xs text-fg-dim">Seu navegador não grava vídeo; as imagens continuam disponíveis.</p>}
          <CopyLinkButton url={copyUrl} className={OPTION} />
        </div>
      )}

      {phase.kind === 'busy' && <p className="text-sm text-fg-muted">Preparando a imagem…</p>}

      {phase.kind === 'recording' && (
        <div className="space-y-2">
          <p className="text-sm text-fg">{`Gravando… ${seconds} s`}</p>
          <div role="progressbar" aria-label="Progresso da gravação" aria-valuemin={0} aria-valuemax={total} aria-valuenow={seconds} className="h-1.5 overflow-hidden rounded bg-bg-4">
            <div className="h-full bg-accent transition-[width]" style={{ width: `${Math.min(100, (phase.elapsedMs / STORY_VIDEO_MS) * 100)}%` }} />
          </div>
          <p className="text-xs text-fg-dim">A cidade continua ao vivo enquanto grava.</p>
          <button type="button" className={ACTION} onClick={() => recording.current?.cancel()}>
            Cancelar
          </button>
        </div>
      )}

      {phase.kind === 'done' && (
        <div className="space-y-2">
          {phase.video ? (
            <video src={phase.preview} controls playsInline className="max-h-72 w-full rounded bg-black" />
          ) : (
            <img src={phase.preview} alt="Prévia da imagem" className="max-h-72 w-full rounded object-contain" />
          )}
          {phase.webm && <p className="text-xs text-warn">O Instagram pode não aceitar WebM. No celular, use o Safari ou o Chrome.</p>}
          <div className="flex flex-wrap gap-2">
            {canShareFile(phase.file) && (
              <button type="button" className={PRIMARY} onClick={() => void shareOrDownload(phase.file)}>
                Compartilhar
              </button>
            )}
            <button type="button" className={ACTION} onClick={() => downloadFile(phase.file, phase.file.name)}>
              Baixar
            </button>
            {phase.video ? (
              <button type="button" className={ACTION} onClick={() => void video()}>
                Gravar de novo
              </button>
            ) : (
              <button type="button" className={ACTION} onClick={() => setPhase({ kind: 'menu' })}>
                Voltar
              </button>
            )}
          </div>
        </div>
      )}

      {phase.kind === 'stopped' && (
        <div className="space-y-2">
          <p className="text-sm text-fg-muted">
            {phase.reason === 'hidden' ? 'A gravação parou porque a página saiu da tela: o navegador pausa a cidade em segundo plano.' : 'Não foi possível gerar o arquivo.'}
          </p>
          {phase.reason === 'hidden' || phase.video ? (
            <button type="button" className={ACTION} onClick={() => void video()}>
              Gravar de novo
            </button>
          ) : (
            <button type="button" className={ACTION} onClick={() => setPhase({ kind: 'menu' })}>
              Voltar
            </button>
          )}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run it to see it pass.** `WEBTEST src/city/share/SharePanel.test.tsx` — Expected: PASS. Then `DOCKER 'npm run typecheck -w @termhub/web'` — Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add apps/web/src/city/share/CopyLinkButton.tsx apps/web/src/city/share/SharePanel.tsx apps/web/src/city/share/SharePanel.test.tsx
git commit -m "City: the share panel for images, video and the link

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task B7: The panel on the city page, the way in from Minha cidade, and the guards

**Files:**
- Modify: `apps/web/src/city/CityPage.tsx`; Test: `apps/web/src/city/CityPage.test.tsx`
- Modify: `apps/web/src/components/MyCityView.tsx`; Test: `apps/web/src/components/MyCityView.test.tsx`
- Modify: `apps/web/src/city/bundle.test.ts`

**Interfaces:**
- Consumes: `SharePanel`, `ShareScene`, `CopyLinkButton` (Task B6); `OfficeScene.onFrame` / `lockCamera` (Task B1); `PublicCity.short_url` (Task A5); `cityPath`, `Rest` from `apps/web/src/city/url.ts`.
- Produces: a "Compartilhar" button in the public city's top bar (disabled until the scene has a model; replaced by "Copiar link" when the scene cannot draw); an "Abrir minha cidade para compartilhar" link in Minha cidade; a source-level test that `apps/web/src/city/**` imports only what the bundle rule allows.

- [ ] **Step 1: Write the failing tests.** In `apps/web/src/city/CityPage.test.tsx`:

  - in the hoisted `class FakeOfficeScene`, add the two new methods and a way to fail the mount:

    ```tsx
        static failMount = false;
        onFrame = vi.fn(() => () => {});
        lockCamera = vi.fn();
    ```

    and replace `async mount(): Promise<void> {}` with

    ```tsx
        async mount(): Promise<void> {
          if (FakeOfficeScene.failMount) throw new Error('no WebGL');
        }
    ```

  - in the top-level `beforeEach`, add `FakeOfficeScene.failMount = false;`;
  - append:

    ```tsx
    describe('CityPage sharing', () => {
      const withLink = { ...CITY, short_url: 'https://77a.it/pedro' };
      // these tests read the rest from the address bar, so each starts at the city itself
      beforeEach(() => history.replaceState(null, '', '/city/@pedro'));
      function stubClipboard() {
        const writeText = vi.fn(async () => {});
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
        return writeText;
      }

      it('keeps Compartilhar disabled until the city is drawn', async () => {
        fetchMock.mockReturnValueOnce(new Promise(() => {}));
        render(<CityPage nickname="pedro" />);
        expect((screen.getByRole('button', { name: 'Compartilhar' }) as HTMLButtonElement).disabled).toBe(true);
      });

      it('opens the share panel, whose link is the short link at the city', async () => {
        const writeText = stubClipboard();
        fetchMock.mockResolvedValueOnce(json(withLink));
        render(<CityPage nickname="pedro" />);
        await screen.findByText(/Cidade de Pedro/);
        fireEvent.click(screen.getByRole('button', { name: 'Compartilhar' }));
        const panel = screen.getByRole('dialog', { name: 'Compartilhar a cidade' });
        expect(panel).toBeTruthy();
        await act(async () => {
          fireEvent.click(screen.getByRole('button', { name: 'Copiar link' }));
        });
        expect(writeText).toHaveBeenCalledWith('https://77a.it/pedro');
      });

      it('copies the long link of a building: only the city has a short link', async () => {
        const writeText = stubClipboard();
        history.replaceState(null, '', '/city/@pedro/b1');
        fetchMock.mockResolvedValueOnce(json(withLink));
        render(<CityPage nickname="pedro" />);
        await screen.findByText(/Cidade de Pedro/);
        fireEvent.click(screen.getByRole('button', { name: 'Compartilhar' }));
        await act(async () => {
          fireEvent.click(screen.getByRole('button', { name: 'Copiar link' }));
        });
        expect(writeText).toHaveBeenCalledWith(`${location.origin}/city/@pedro/b1`);
      });

      it('hides Compartilhar when the scene cannot draw, and keeps Copiar link in the page', async () => {
        const writeText = stubClipboard();
        FakeOfficeScene.failMount = true;
        fetchMock.mockResolvedValueOnce(json(withLink));
        render(<CityPage nickname="pedro" />);
        await screen.findByText('Seu navegador não conseguiu desenhar a cidade.');
        expect(screen.queryByRole('button', { name: 'Compartilhar' })).toBeNull();
        await act(async () => {
          fireEvent.click(screen.getByRole('button', { name: 'Copiar link' }));
        });
        expect(writeText).toHaveBeenCalledWith('https://77a.it/pedro');
      });
    });
    ```

In `apps/web/src/components/MyCityView.test.tsx`, inside `describe('MyCityView link', ...)`, add:

```tsx
  it('leads to the public page to make images and the video there', () => {
    renderView();
    const open = screen.getByRole('link', { name: 'Abrir minha cidade para compartilhar' });
    expect(open.getAttribute('href')).toBe('https://termhub.dev/city/@pedro');
    expect(open.getAttribute('target')).toBe('_blank');
  });
```

In `apps/web/src/city/bundle.test.ts`, change the first import line to `import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';`, the second to `import { dirname, join, relative, resolve } from 'node:path';`, and append:

```ts
const SRC = new URL('..', import.meta.url).pathname;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

/**
 * The same rule, read from the source: runs everywhere (no build needed), and names the file and the
 * import that broke it. The city may import the office, the public types, its own files and packages.
 */
describe('the public bundle source', () => {
  it('imports nothing of the private app', () => {
    const bad: string[] = [];
    for (const file of sources(join(SRC, 'city'))) {
      for (const m of readFileSync(file, 'utf8').matchAll(/(?:from\s+|import\s*\(\s*|import\s+)['"]([^'"]+)['"]/g)) {
        const spec = m[1];
        if (!spec.startsWith('.')) continue;
        const target = relative(SRC, resolve(dirname(file), spec));
        if (target.startsWith('city/') || target.startsWith('office/') || target === 'lib/types' || target === 'lib/types.ts') continue;
        bad.push(`${relative(SRC, file)} -> ${spec}`);
      }
    }
    expect(bad).toEqual([]);
  });
});
```

- [ ] **Step 2: Run them to see them fail.** `WEBTEST src/city/CityPage.test.tsx src/components/MyCityView.test.tsx src/city/bundle.test.ts` — Expected: FAIL (no "Compartilhar" button; no "Abrir minha cidade para compartilhar" link). The new bundle-source test already passes — it guards what the next step adds.

- [ ] **Step 3: Implement the city page.** In `apps/web/src/city/CityPage.tsx`:

  - add the imports:

    ```tsx
    import { CopyLinkButton } from './share/CopyLinkButton';
    import { SharePanel } from './share/SharePanel';
    ```

  - after `const [betaOpen, setBetaOpen] = useBetaCard();`, add `const [shareOpen, setShareOpen] = useState(false);`;
  - after the `if (missing) { ... }` early return and before `const here = ...`, add:

    ```tsx
      // the city's own address: the media footers print it when there is no short link
      const cityUrl = `${location.origin}${cityPath(nickname, { building: null, room: null })}`;
      // "Copiar link": only the city has a short link; a building or a room keeps its long address
      const restUrl = target.kind === 'city' ? null : `${location.origin}${cityPath(nickname, { building: target.machineId, room: target.kind === 'room' ? target.roomId : null })}`;
      const copyUrl = restUrl ?? city?.short_url ?? cityUrl;
      // media are made from the scene: nothing to share before it has a city to draw
      const canShare = !!city && model.machines.length > 0;
    ```

  - in the top bar, as the first child of `<span className="ml-auto flex items-center gap-3">`, before the "O que é o termhub?" link:

    ```tsx
              {failed ? (
                <CopyLinkButton url={copyUrl} className="rounded px-2 py-1 hover:bg-bg-3 hover:text-fg" />
              ) : (
                <button
                  type="button"
                  disabled={!canShare}
                  aria-expanded={shareOpen}
                  onClick={() => setShareOpen((open) => !open)}
                  className="rounded px-2 py-1 hover:bg-bg-3 hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Compartilhar
                </button>
              )}
    ```

  - inside `<div className="relative min-h-0 flex-1">`, after the `{betaOpen && (...)}` block:

    ```tsx
            {shareOpen && !failed && canShare && city && sceneRef.current && (
              // full width under the bar on a phone, a card in the top-right corner from `sm` up
              <div className="absolute inset-x-0 top-0 z-20 max-h-full overflow-y-auto sm:left-auto sm:right-4 sm:top-4 sm:w-[22rem]">
                <SharePanel scene={sceneRef.current} city={city} model={model} cityUrl={cityUrl} copyUrl={copyUrl} onClose={() => setShareOpen(false)} />
              </div>
            )}
    ```

- [ ] **Step 4: Implement the way in from Minha cidade.** In `apps/web/src/components/MyCityView.tsx`, in the "Link da cidade" section, right after `<CityLink url={link} />`:

```tsx
            <a href={link} target="_blank" rel="noopener noreferrer" className="mt-2 inline-block text-xs text-accent hover:underline">
              Abrir minha cidade para compartilhar
            </a>
            <p className="text-xs text-fg-dim">Imagens para story e post e um vídeo de 10 s com som saem da própria página da cidade, no botão Compartilhar.</p>
```

- [ ] **Step 5: Run them to see them pass.** `WEBTEST src/city src/components/MyCityView.test.tsx` — Expected: PASS (every CityPage test, old and new, the share tests and the bundle-source test; the built-output bundle test skips locally until the next step builds it).

- [ ] **Step 6: Verify Part B as a whole.**
  - `DOCKER 'npm run build:city -w @termhub/web && npx -w @termhub/web vitest run src/city/bundle.test.ts'` — Expected: PASS: the built public bundle still contains none of the private markers.
  - `DOCKER 'DATABASE_URL=postgresql://unused:unused@127.0.0.1:1/unused npm test -w @termhub/server && npm test -w @termhub/web'` — Expected: PASS.
  - `DOCKER 'npm run typecheck -w @termhub/server && npm run build -w @termhub/web && npm run build -w @termhub/landing'` — Expected: PASS.
  - Manual check in a browser (a local dev server, never production): open a public city on a phone-sized viewport, press "Compartilhar", make a story image and a post image (the scene is sharp, the link and the invitation legible), record the video (the counter runs to 10 s, the camera does not move on a drag, the file plays with the hum and clicks), switch tabs mid-recording (the panel says it stopped), and on a phone check that "Compartilhar" opens the share sheet with Instagram in it.

- [ ] **Step 7: Commit.**

```bash
git add apps/web/src/city/CityPage.tsx apps/web/src/city/CityPage.test.tsx apps/web/src/components/MyCityView.tsx apps/web/src/components/MyCityView.test.tsx apps/web/src/city/bundle.test.ts
git commit -m "City: share images and a video from the public city page

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

Part B ends here: it is PR 2 ("Public city: share images and a story video").

---

## Self-Review

**1. Spec coverage.**

| Spec | Task |
| --- | --- |
| §2.1 `onFrame` (post-render hook), `lockCamera` (drags, wheel, resize re-framing) | B1 |
| §2.2 `layoutFor` story/post bands, tokens, accent gradient, `imageSmoothingEnabled = false`, live line with the waiting clause only when > 0 | B2 |
| §2.3 PNG stills, file names | B3 |
| §2.4 1080×1920 canvas redrawn per frame, `captureStream(30)`, audio track, 10 s, type order, `pickMimeType` pure, `.mp4`/`.webm`, cancel on `visibilitychange` | B5 (mechanics), B6 (hidden page) |
| §2.5 hum, clicks by typing robots, ding per raised hand, `soundEvents` pure, sound only in the recording | B4 |
| §2.6 button in the top bar for every visitor, four options, recording state, preview + Compartilhar/Baixar/Gravar de novo, share sheet vs download, fallback on rejection, no-MediaRecorder message, WebM warning, hidden when the scene failed with "Copiar link" kept, disabled until the scene has a model; "Abrir minha cidade para compartilhar" | B6, B7 |
| §3.1 partner API, optional `TYPETOACCESS_API_KEY`, feature off without it | A2, A4 |
| §3.2 two nullable columns, additive migration, `custom ?? partner` | A1, A3 |
| §3.3 creation after the first claim without delaying it, nickname slug then random on 409, 5 s timeout, failure stores nothing and logs metadata, lazy retry from `GET /me/city-link` limited to one per user per 10 min in memory | A2, A3, A4 |
| §3.4 `PUT /me/city-link` (`https://77a.it/<slug>`, no redirect follow, Location = city URL with trailing slash and host case tolerated, `400 SHORT_LINK_MISMATCH` with the URL), `DELETE /me/city-link/custom` (restore, create when missing) | A3, A4 |
| §3.5 Minha cidade (link, note, own link with typetoaccess.it and the server's message, restore); office share at city depth only; `short_url` in `PublicCity` named in `toPublicCity`, used by "Copiar link" and the footers | A5, A6, A7, B2, B7 |
| §4 media only from the page's model; key only on the server; share code imports nothing private, guard kept | B2–B7, A2, B7 (source guard) |
| §5 every listed test | A1–A7, B1–B7 |
| §6 two PRs, short link first | Part A, Part B |

**2. Placeholder scan.** No step says "TBD", "handle edge cases" or "similar to Task N"; every code step carries its code, every run step its command and expected result.

**3. Type consistency.** `ShortLinkHttp.createLink/locationOf` (A2) are what `ShortLinkService` calls (A3) and what the route tests fake (A4). `CityLinkView` (server, A3) and `CityLink` (web, A6) have the same five fields. `toPublicCity`'s `shortUrl` (A5) is fed by `effectiveShortUrl` (A3). `FrameSource` (B3) is the shape of `OfficeScene.onFrame` (B1); `ShareScene` (B6) adds `lockCamera` (B1). `ShareInfo.shortLink` is always a display string (`displayLink` in B2). `recordStory`'s options (B5) are what the panel passes (B6). `fileNameFor(nickname, kind, ext)` is called with `ShareFormat` kinds only.

**4. Review Focus.** Each line is pinned by a test in the task that owns the code: 1 → A3 and A4, 2 → A3, 3 → A3 and A4, 4 → B3, 5 → B6, 6 → B2.
