# Attachment follow-ups from the TER-98 review — design

Cards: **TER-197**, **TER-198**, **TER-199**, **TER-200**, **TER-201** (epic TER-1, Chat). They came
out of the review of TER-98 (spec `2026-09-26-chat-redesign-attachments-design.md`, merged in PR
#168). Each is small and independent; one section per card below. The implementation plan is
`docs/superpowers/plans/2026-09-26-attachment-followups.md`.

Read against `origin/main` d3fb69c on 2026-09-26. The person asked for the recommended option at
every choice, without questions; the decisions and their reasons are recorded in each section.

Project rule kept: what the chat does on the web it does in the app too (TER-197 and TER-198 touch
both; TER-199 is web-only by its nature, see §3).

## 1. TER-197 — reserve the image thumbnail's size

### What the code does today

- **Web.** `MessageAttachments.tsx` renders an image as
  `<img class="max-h-60 max-w-60 object-cover" loading="lazy">`. Until the file loads the `<img>` is
  0×0, then it grows up to 240×240. Above the bottom of the thread, where `ChatThread`'s
  `ResizeObserver` re-pin does not apply, the rows below jump.
- **App.** `message-attachments.tsx` renders a fixed `h-40 w-40` (160×160) box with
  `resizeMode="cover"`. The app does not jump, but every image is cropped to a square.
- **Server.** The extraction step writes `meta.width` and `meta.height` from the file header
  (`imageDimensions` in `chat/attachments/extract.ts`). Images get them within seconds of upload;
  a header the reader does not understand leaves them out.

### Decisions

| Topic | Decision | Why |
|---|---|---|
| How the size is reserved | An explicit `width` and `height` in px on the element, computed from `meta` to fit the box. Not CSS `aspect-ratio`. | `aspect-ratio` on an `<img>` with only `max-*` bounds still collapses before load, since there is no definite width to derive from. Explicit pixels are exact on both platforms and need no layout trick. |
| Box | Web: fit inside 240×240 (the current `max-*-60`). App: fit inside 160×160 (the current box). | Keeps each platform's current maximum; only the proportion changes. |
| Small or extreme proportions | Scale down only, never up. Each side is at least 48 px on the web and 64 px in the app; `object-cover` / `resizeMode="cover"` crops the excess. | A 4000×20 banner would otherwise render 240×1 px. 64 px in the app keeps "Toque para recarregar" tappable. |
| No usable `meta` | Keep today's behaviour exactly: web `max-*-60` without a size, app 160×160. | Old rows, headers that could not be read, and the seconds between send and extraction. |
| Where the math lives | A pure `thumbSize(meta, box, min)` in `apps/web/src/lib/attachments.ts` and a copy in `apps/mobile/src/features/chat/viewmodel/attachments.ts`. | The web depends on no workspace package (spec TER-98 §5.6 keeps the web copy of the attachment table for the same reason). The function is ten lines; a drift can only change a thumbnail's size. |
| App placeholders | The grey loading box and "Toque para recarregar" take the same size as the image. | Otherwise the row changes size when the image arrives, which is the bug. |
| Full-screen viewers | Unchanged. | They already use `object-contain` / `resizeMode="contain"` in a fixed viewport. |

`meta.width` and `meta.height` are used only when both are finite integers above 0. `meta` is typed
`Record<string, unknown>`, so the function checks the values instead of trusting them.

### Known limit

A JPEG with an EXIF rotation of 90° reports its pre-rotation size in the header, while the browser
and the app display it rotated. The reserved box then has the wrong orientation. The web client
redraws images on a canvas before upload, which bakes the rotation in, so this only concerns app
uploads that keep an EXIF rotation. The effect is a crop (cover), never a jump or a distortion. It
is not fixed here: fixing it needs an EXIF reader in the server's extraction step.

### Tests

- `thumbSize`: landscape, portrait, smaller than the box (not scaled up), extreme proportions
  (clamped to the minimum), and `meta` missing, zero, negative, non-numeric or `NaN` (→ `null`).
- Web: a thumbnail with `meta` has `style.width`/`style.height` before any `load` event; one
  without `meta` has no inline size and keeps `max-h-60`.
- App: the `Image` with `meta` has the fitted `width`/`height` in its style, and so do the loading
  box and "Toque para recarregar".

## 2. TER-198 — the app's image stuck on "Toque para recarregar" after the token expired

### What the code does today

- The chat store's `attachmentSource(id)` signs a DPoP proof with `session().auth()`: whatever
  access token the session holds, expired or not.
- Every other call goes through `call` / `uploadCall` in `services/api/client.ts`, which answer a
  `401 TOKEN_EXPIRED` with one single-flighted renewal and one retry. `<Image>` loads the url
  itself, so it never gets that treatment and cannot even see the status code.
- The session renews ahead of expiry with a `setTimeout`. While the app is in the background the
  timer does not run, so the app comes back with an expired token. The first image fails, the
  automatic re-sign uses the same token and fails again, and the thumbnail stays on "Toque para
  recarregar" until some other call happens to renew.
- Separately, tapping "Toque para recarregar" bumps `attempt`, but `useAttachmentSource` clears
  its `source` in an effect. For one commit the `<Image>` is mounted with the previous, already used
  proof, which fires one pointless request.

### Decisions

| Topic | Decision | Why |
|---|---|---|
| When to renew | **Before signing**: `attachmentSource` checks `session().tokenStale()` and, when true, awaits `session().renewToken()`, then signs with `session().auth()`. | `tokenStale()` already exists (TER-93: `expires_at − 60 s`, clock of the device that received `expires_in`, so no server skew). It catches exactly the reported case and costs nothing when the token is fresh. Renewing after an image error instead would renew on any failure (offline, a deleted file, a 404) with no status code to tell them apart. |
| Which renewal | The session store's `renewToken()`, which is single-flighted and is what the API client's `onTokenExpired` calls. | The card asks to reuse the existing path. Ten thumbnails appearing at once share one renewal. The PIN flow and TER-92 are not touched. |
| Renewal fails | Sign with whatever `auth()` gives. If the session relocked, `auth()` throws `LOCKED` and the image stays on its grey box behind the lock screen, as any other call does. | No new error path. The session store already shows "sessão expirada" and relocks when renewal is refused. |
| Port change | `SessionApi` (the chat store's view of the session) gains `tokenStale` and `renewToken`. | Both exist on `SessionState`; the `Pick` just did not include them. The test that builds a locked session by hand gains the two fields. |
| The stale proof on tap | `useAttachmentSource` keeps `{ attempt, source }` and returns the source only when its `attempt` equals the current one. | This is decided during render, not in an effect, so the stale proof is never mounted. |
| API client | Unchanged. `attachmentSource` in `client.ts` stays a pure signer. | The renewal decision belongs to the session, which the client does not import (it gets a callback). |

### Tests

- Chat store, with a stale token: `attachmentSource` calls `renewToken` once and the proof's `ath`
  matches the renewed token.
- Chat store, with a fresh token: `renewToken` is not called.
- Chat store: three concurrent `attachmentSource` calls with a stale token share one renewal
  (through the session store's single flight).
- View: after "Toque para recarregar", no `Image` is rendered with the previous proof before the
  new source arrives (the placeholder shows until then).
- The existing view test ("re-signs once on a failed load, then offers a tap") still passes.

## 3. TER-199 — focus in the image viewer (and the app's `Modal`)

### What the code does today

`ImageViewer` and `Modal` are `role="dialog" aria-modal="true"`, and Escape closes them through
`useEscapeLayer`. Neither moves focus in when it opens, keeps Tab inside, or returns focus to what
opened it when it closes. Closing the viewer with "Fechar" leaves focus on `<body>`, so a keyboard
user has to Tab from the top of the page.

### Decisions

| Topic | Decision | Why |
|---|---|---|
| Shape | One hook, `useDialogFocus(open, containerRef, initialFocusRef?)`, exported from `components/Modal.tsx` next to `useEscapeLayer`. Used by `ImageViewer` and `Modal`. | The card asks to fix both. Same file and style as the existing layer hook. No dependency (`focus-trap-react` would be one more package for about 40 lines). |
| Initial focus | If focus is already inside the dialog (an `autoFocus` field, `ConfirmDialog`'s confirm button), leave it. Otherwise focus `initialFocusRef` when given, else the container itself (`tabIndex={-1}`). `ImageViewer` passes its "Fechar" button. `Modal` passes nothing. | The card asks for "Fechar" in the viewer. For the many `Modal` users, focusing the × by default would move keyboard users onto "close" and show a focus ring on every open; the container is the neutral choice, and a screen reader announces the dialog's title. React applies `autoFocus` during commit, before the hook's effect, so checking `contains(activeElement)` keeps every existing `autoFocus`. |
| Trap | A `keydown` handler on the container: Tab on the last focusable goes to the first, Shift+Tab on the first (or on the container) goes to the last, and with nothing focusable Tab stays on the container. | Only events inside the dialog are handled, so stacked layers (a viewer over the chat drawer over a page) do not fight. |
| Focusable elements | `a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])`, filtered to those not `hidden` and not inside `[inert]`. | The usual list; jsdom has no layout, so visibility is not computed from boxes. |
| Returning focus | The element that had focus when the dialog opened is remembered. On close (or unmount) it gets focus back if it is still in the document; otherwise nothing is done. | The thumbnail survives a close; a row that re-rendered away does not, and focusing a detached node would be a no-op anyway. |
| The app | Out of scope. The card marks full-screen zoom and "any tap closes" as optional. | Pinch zoom needs a gesture library or a native module in the app; that is its own card if wanted. It is recorded as not done in the card when it closes. |

### Tests (testing-library)

- Viewer: opening moves focus to "Fechar"; Tab and Shift+Tab stay inside; closing with "Fechar"
  and with Escape returns focus to the thumbnail's button.
- Modal: opening focuses the dialog container; a child with `autoFocus` keeps focus; closing returns
  focus to the button that opened it; Tab wraps.
- The existing `MessageAttachments` tests still pass.

## 4. TER-200 — audit which attachment `read_attachment` read

### What the code does today

`mcp/route.ts` writes one `api_token_events` row per tool call with the token, the tool,
`machine_id`, `project_id` and `tab_id` taken from the raw arguments (`idsOf`), the outcome and the
duration. `read_attachment`'s argument is `id`, so its rows record nothing about which file was
read. The table is write-only in the code: rows are inserted and purged after 30 days, never
listed by the app.

### Decisions

| Topic | Decision | Why |
|---|---|---|
| Where | A new nullable column `attachment_id` on `api_token_events` (Prisma `attachmentId`). | The table already has one column per kind of id (`machine_id`, `project_id`, `tab_id`). A generic `target_id` would need the tool name to be read correctly and would invite storing ids of unknown kinds. Another kind later is another nullable column, which is equally cheap. |
| Migration | `ALTER TABLE "api_token_events" ADD COLUMN "attachment_id" TEXT;` No index, no foreign key. | Additive, so the previous release keeps inserting (it never names the column) during the blue/green window. No foreign key, like the other id columns: the row must outlive a deleted attachment. No index: nothing queries it, and an audit read is rare and can scan by `token_id`. |
| Which calls | Only when `tool === 'read_attachment'`, from `args.id`. | Other tools have an `id`-less shape or ids already covered. |
| Validation | The value is kept only if it matches the tool's own id rule, `^[a-z0-9]{1,64}$`; anything else is `null`. | Refused calls (`INVALID_ARGS`, `TOOL_NOT_ALLOWED`, rate limit) are audited with raw arguments. The existing `auditId` accepts any string up to 64 characters; a stricter rule here guarantees that no name or content fragment can reach the audit through this field. |
| What is never stored | The name, the mime, the base64 image, the extracted text and the page offset. | The card's rule; the same rule as terminal content. |
| TER-201 interaction | This is the schema change that regenerates the Prisma client; see §5. | — |

### Tests

- Route: a successful `read_attachment` records `attachment_id: 'abc123'`; the serialised audit
  call contains neither the base64 of the mocked image, nor the file name, nor the extracted text.
- Route: a refused call with `id: 'Relatório.pdf'` (invalid) records `attachment_id: null` and is
  still audited as `INVALID_ARGS`.
- Route: another tool with an `id` argument does not fill `attachment_id`.
- Repository (Postgres, `TERMHUB_DB_TESTS=1`): `recordEvent` writes `attachment_id`, and a row
  without it stays `null`.

## 5. TER-201 — commit the regenerated Prisma client

### Finding

On `origin/main` d3fb69c, `npm run prisma:generate` produces **no diff**: the generated client
already says `choice | permission | suggestion`. The regeneration was committed with TER-57 (commit
f1d2af4, "Chat decisions: pgvector image, table and repository", PR #169), which changed the
schema. The card's expected state is already reached. Checked on 2026-09-26 by running Prisma
7.10.0 (the lockfile's version) in a `node:20` container against this worktree.

### Decisions

| Topic | Decision | Why |
|---|---|---|
| The card | Closed as already done, with a description that names f1d2af4. | No diff to commit. |
| Stopping it from coming back | CI's `check` job gains one step right after `npm run prisma:generate`: `git diff --exit-code -- apps/server/src/generated`. A stale committed client then fails the check with the file names. | The drift came from a schema change committed without its regenerated client. CI already regenerates; comparing is one line. It blocks the deploy, which is the point: `CLAUDE.md` says a broken check blocks it. |
| Order | This step lands in the same branch as TER-200, after TER-200's regenerated client is committed. | TER-200 is the next schema change; with the guard in the same PR, the PR proves the guard passes. |
| The 500 kB chunk warning | Not handled. | The card itself says it deserves its own card; it is not related to Prisma. |

### Risk

The guard fails if CI's `npm ci` resolves a different Prisma version than the one used to generate
locally. The lockfile pins 7.10.0 and CI uses `npm ci`, so the only way to hit this is to generate
with another version; the failure message then shows the diff, which is the intended signal.

## 6. Isolation from the work in progress

| Card in progress | Touches | How this work stays out of its way |
|---|---|---|
| TER-196 (extraction in `worker_threads`) | `chat/attachments/extract.ts`, `queue.ts` | Not touched. TER-197 only reads `meta.width`/`height`, which that card keeps. |
| TER-202 (project chat panel on the web) | `ChatHost`, `ChatDrawer`, layout | Not touched. `useDialogFocus` is used by `ImageViewer` and `Modal` only. |
| TER-203 (suggestion card text) | `TabSuggestionCard`, tab-question context | Not touched. |
| TER-185 (external tickets, PR #172) | `mcp/tools.ts`, `mcp/route.ts`, migrations | TER-200 changes only `idsOf` in `route.ts` and adds a later migration. Whichever merges second rebases; both migrations are additive and independent. |
| TER-104 / TER-181 (TestFlight build) | the app release | TER-197 and TER-198 need a new app build to reach phones; they ride the next one. No server change is needed for them. |

## 7. Releases

- Server (TER-200, TER-201's CI step): one PR to `main`; the migration is additive and runs during
  the blue/green switch.
- Web (TER-197, TER-199): the same deploy.
- App (TER-197, TER-198): the next TestFlight build. No native module, no new permission.
- `@termhub/agent` is not touched, so no agent release.

## 8. Verification

- Server: `vitest` for `mcp/route.test.ts` and `api-tokens.db.test.ts` (against a throwaway
  Postgres named `th-ter200-db`), plus `npm run typecheck -w @termhub/server`.
- Web: `vitest` for the touched components and `lib/attachments`, `npm run build -w @termhub/web`.
- App: `jest` for the touched files, `npm run typecheck -w @termhub/mobile`.
- `prisma generate` on the branch produces no diff after TER-200's commit (the new CI step, run by
  hand).
- Landing build, as `CLAUDE.md` asks before a push.
