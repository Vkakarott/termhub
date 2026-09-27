# Attachment follow-ups (TER-197 to TER-201) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the five small cards from the TER-98 review: reserve the image thumbnail's size
(TER-197), renew an expired token before signing an image in the app (TER-198), manage focus in the
web dialogs (TER-199), audit which attachment `read_attachment` read (TER-200), and guard against a
stale committed Prisma client (TER-201).

**Architecture:** Five independent, local changes. One additive migration (a nullable
`api_token_events.attachment_id`) and a one-line change to the MCP audit. A pure `thumbSize` helper
on web and app. The app's chat store asks the session to renew a stale token before signing. A
`useDialogFocus` hook next to `useEscapeLayer`, used by `Modal` and `ImageViewer`. One CI step.

**Tech Stack:** Fastify 5, Prisma 7.10 (Postgres 16 + pgvector image), vitest; React 19 + Tailwind 3
+ vitest/testing-library (web); Expo / React Native + zustand + jest-expo/testing-library (app).

**Spec:** `docs/superpowers/specs/2026-09-26-attachment-followups-design.md`. Read it first; §
numbers below refer to it.

## Global Constraints

- UI copy stays pt-BR; code, comments, commit messages in English (`CLAUDE.md`).
- The host has no Node: every command runs in `node:20` through Docker, from the worktree root:
  `docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/w" -w /w node:20 sh -c '<cmd>'`.
  Run `rm -rf .npm` after (cache the container leaves).
- Server tests that import `config.ts` need `-e DATABASE_URL=postgresql://test:test@localhost:5432/test`
  (never dialled by unit tests).
- Throwaway containers are named `th-ter200-*`. Never stop, remove or reuse a production container
  name (`termhub-*`, `proxy-*`, `*-app-*`).
- Migrations are additive (the previous release keeps serving during blue/green).
- Terminal content and attachment content never reach logs or the audit; only ids.
- Web thumbnail box 240 px, min side 48 px; app box 160 px, min side 64 px (§1).
- `read_attachment` ids match `^[a-z0-9]{1,64}$` (§4).
- Nothing is pushed. One commit per task.

## Review Focus

1. **A `Modal` whose content already has an `autoFocus` field** (search, rename, `ConfirmDialog`)
   must keep focus there after the new hook runs — Task 8 tests it.
2. **An image message sent seconds ago** has `meta: null` until extraction reports; the thumbnail
   must render like today and then switch to the reserved size without breaking — Task 4 and 5 test
   the `null` path.
3. **Ten thumbnails appearing with a stale token** must trigger one renewal, not ten — Task 6 tests
   concurrent calls against the real session store.
4. **A refused `read_attachment` call with a file name in `id`** must not put the name in the
   audit — Task 2 tests it.
5. **A dialog closed after its opener disappeared** (the row re-rendered away) must not throw —
   Task 8 tests a detached opener.

## One-time setup (before Task 1)

```bash
cd <worktree root>
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/w" -w /w node:20 sh -c 'npm ci && npm run build:packages && npm run prisma:generate -w @termhub/server'
rm -rf .npm
```

Expected: install finishes; `git status` shows no change under `apps/server/src/generated`.

---

## Card TER-200 — audit the attachment id

### Task 1: `api_token_events.attachment_id` (schema, migration, repository)

**Files:**
- Modify: `apps/server/prisma/schema.prisma` (model `ApiTokenEvent`, ~line 591)
- Create: `apps/server/prisma/migrations/20260927010000_api_token_event_attachment/migration.sql`
- Modify: `apps/server/src/db/repositories/api-tokens.ts` (`ApiTokenEventInput`, `recordEvent`)
- Regenerate: `apps/server/src/generated/prisma/**`
- Test: `apps/server/src/db/repositories/api-tokens.db.test.ts`

**Interfaces:**
- Produces: `ApiTokenEventInput.attachment_id?: string | null`, stored as `attachmentId`
  (`attachment_id`).

- [ ] **Step 1: Write the failing test** — append inside the `describe.skipIf(...)` block of
  `api-tokens.db.test.ts`:

```ts
  it('records the attachment a read_attachment call read, and null for the others', async () => {
    const t = await make(userId);
    await repo.recordEvent({ token_id: t.id, tool: 'read_attachment', attachment_id: 'abc123', ok: true, duration_ms: 4 });
    await repo.recordEvent({ token_id: t.id, tool: 'list_machines', ok: true, duration_ms: 1 });
    const rows = await db.apiTokenEvent.findMany({ where: { tokenId: t.id }, orderBy: { tool: 'asc' } });
    expect(rows.map((r) => [r.tool, r.attachmentId])).toEqual([
      ['list_machines', null],
      ['read_attachment', 'abc123'],
    ]);
  });
```

- [ ] **Step 2: Start the throwaway Postgres (pgvector image) and run the test to see it fail**

```bash
docker build -t th-ter200-pgvector docker/db
docker ps --filter name=th-ter200-db --format '{{.Names}}' | grep -q th-ter200-db || \
  docker run -d --rm --name th-ter200-db -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=termhub th-ter200-pgvector
docker run --rm --network container:th-ter200-db -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/w" -w /w/apps/server \
  -e TERMHUB_DB_TESTS=1 -e DATABASE_URL=postgresql://postgres:postgres@localhost:5432/termhub node:20 \
  sh -c 'npx prisma migrate deploy && npx vitest run src/db/repositories/api-tokens.db.test.ts'
```

Expected: FAIL — TypeScript/Prisma rejects `attachment_id` / `attachmentId` is `undefined`.

- [ ] **Step 3: Schema, migration, repository**

In `schema.prisma`, model `ApiTokenEvent`, after `tabId`:

```prisma
  /// The attachment a read_attachment call read (spec 2026-09-26 attachment follow-ups §4). Only the id.
  attachmentId String?  @map("attachment_id")
```

`migration.sql`:

```sql
-- Which attachment a read_attachment call read (TER-200). Additive: the previous release never names it.
ALTER TABLE "api_token_events" ADD COLUMN "attachment_id" TEXT;
```

In `api-tokens.ts`, `ApiTokenEventInput` gains `attachment_id?: string | null;` after `tab_id`, and
`recordEvent`'s `data` gains `attachmentId: e.attachment_id ?? null,` after `tabId`.

Regenerate the client:

```bash
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/w" -w /w node:20 sh -c 'npm run prisma:generate -w @termhub/server'
```

- [ ] **Step 4: Run the test again** (same command as Step 2). Expected: PASS, and the rest of the
  file still passes.

- [ ] **Step 5: Commit**

```bash
git add apps/server/prisma apps/server/src/db/repositories/api-tokens.ts apps/server/src/db/repositories/api-tokens.db.test.ts apps/server/src/generated/prisma
git commit -m "MCP audit: add api_token_events.attachment_id"
```

### Task 2: record the id in the MCP audit

**Files:**
- Modify: `apps/server/src/mcp/route.ts` (`idsOf` ~line 31, its call in `audit` ~line 94)
- Test: `apps/server/src/mcp/route.test.ts` (`describe('read_attachment')`)

**Interfaces:**
- Consumes: `ApiTokenEventInput.attachment_id` (Task 1).
- Produces: `idsOf(tool: string, args: unknown)` → `{ machine_id, project_id, tab_id, attachment_id }`.

- [ ] **Step 1: Write the failing tests** — inside `describe('read_attachment')`:

```ts
  it('audits the attachment id, and never the image, the name or the text', async () => {
    vi.mocked(readAttachment).mockResolvedValue({ content: [{ type: 'image', data: 'QUJD', mimeType: 'image/png' }, { type: 'text', text: '«foto.png» imagem 2×2' }] });
    const { app, apiTokens } = build({ grants: chatGrants, attachments: store });
    await rpc(app, call('read_attachment', { id: 'abc123' }));
    await flush();
    expect(apiTokens.recordEvent.mock.calls[0][0]).toMatchObject({ tool: 'read_attachment', attachment_id: 'abc123', ok: true });
    expect(JSON.stringify(apiTokens.recordEvent.mock.calls)).not.toMatch(/QUJD|foto\.png|imagem/);
  });

  it('a refused call keeps a name passed as id out of the audit', async () => {
    const { app, apiTokens } = build({ grants: chatGrants, attachments: store });
    await rpc(app, call('read_attachment', { id: 'Relatório Final.pdf' }));
    await flush();
    expect(apiTokens.recordEvent.mock.calls[0][0]).toMatchObject({ tool: 'read_attachment', attachment_id: null, ok: false, error_code: 'INVALID_ARGS' });
    expect(JSON.stringify(apiTokens.recordEvent.mock.calls)).not.toMatch(/Relat/);
  });

  it('only read_attachment fills attachment_id', async () => {
    const { app, apiTokens } = build({ grants: chatGrants, attachments: store });
    await rpc(app, call('list_machines', { id: 'abc123' }));
    await flush();
    expect(apiTokens.recordEvent.mock.calls[0][0].attachment_id).toBeNull();
  });
```

- [ ] **Step 2: Run to see them fail**

```bash
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -e DATABASE_URL=postgresql://test:test@localhost:5432/test -v "$PWD:/w" -w /w/apps/server node:20 sh -c 'npx vitest run src/mcp/route.test.ts'
```

Expected: the three new tests FAIL (`attachment_id` is `undefined`).

- [ ] **Step 3: Implement** — replace `idsOf` in `route.ts`:

```ts
/** read_attachment's own id rule: a refused call's raw `id` (a file name, say) never reaches the audit. */
const ATTACHMENT_ID = /^[a-z0-9]{1,64}$/;
const idsOf = (tool: string, args: unknown) => {
  const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;
  const attachmentId = tool === 'read_attachment' && typeof a.id === 'string' && ATTACHMENT_ID.test(a.id) ? a.id : null;
  return { machine_id: auditId(a.machine_id), project_id: auditId(a.project_id), tab_id: auditId(a.tab_id), attachment_id: attachmentId };
};
```

and in `audit`, `...idsOf(args)` becomes `...idsOf(tool, args)`.

- [ ] **Step 4: Run the file again** (Step 2 command). Expected: all PASS, including the older
  audit tests (they use `toMatchObject`, so the new key does not break them).

- [ ] **Step 5: Typecheck and commit**

```bash
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/w" -w /w node:20 sh -c 'npm run typecheck -w @termhub/server'
git add apps/server/src/mcp/route.ts apps/server/src/mcp/route.test.ts
git commit -m "MCP audit: record which attachment read_attachment read"
```

---

## Card TER-201 — the generated Prisma client

### Task 3: CI fails on a stale committed client

**Files:**
- Modify: `.github/workflows/deploy.yml` (the step `run: npm run prisma:generate`, ~line 27)

**Interfaces:** none.

- [ ] **Step 1: Confirm the finding of spec §5 on this branch** (after Task 1's regenerated client):

```bash
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/w" -w /w node:20 sh -c 'npm run prisma:generate -w @termhub/server'
git status --short apps/server/src/generated
```

Expected: no output. If there is a diff, commit it alone first as
`Prisma: commit the regenerated client` — that is the card's original ask.

- [ ] **Step 2: Add the guard** — right after the existing `prisma:generate` step in `deploy.yml`,
  with the same indentation as its neighbours:

```yaml
      - name: Generated Prisma client is committed
        run: git diff --exit-code -- apps/server/src/generated
```

- [ ] **Step 3: Prove the guard both ways locally**

```bash
echo '// drift' >> apps/server/src/generated/prisma/models/TabQuestion.ts
git diff --exit-code -- apps/server/src/generated; echo "exit=$?"   # expect exit=1
git checkout -- apps/server/src/generated
git diff --exit-code -- apps/server/src/generated; echo "exit=$?"   # expect exit=0
```

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/deploy.yml
git commit -m "CI: fail when the committed Prisma client is stale" -m "TER-201: main was already clean (regenerated in f1d2af4); this keeps it that way."
```

- [ ] **Step 5: Card note** — when ticking this subtask, describe on TER-201: already resolved by
  f1d2af4 (PR #169); the CI guard is what this branch adds; the 500 kB chunk warning is not handled.

---

## Card TER-197 — reserve the thumbnail's size

### Task 4: web thumbnail with its fitted size

**Files:**
- Modify: `apps/web/src/lib/attachments.ts` (add `thumbSize`)
- Test: `apps/web/src/lib/attachments.test.ts` (create it if absent; otherwise append)
- Modify: `apps/web/src/components/chat/MessageAttachments.tsx`
- Test: `apps/web/src/components/chat/MessageAttachments.test.tsx`

**Interfaces:**
- Produces: `thumbSize(meta: Record<string, unknown> | null, box: number, min: number): { width: number; height: number } | null`.

- [ ] **Step 1: Write the failing tests**

`attachments.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { thumbSize } from './attachments';

describe('thumbSize', () => {
  it('fits the long side to the box and keeps the proportion', () => {
    expect(thumbSize({ width: 1600, height: 1200 }, 240, 48)).toEqual({ width: 240, height: 180 });
    expect(thumbSize({ width: 1200, height: 1600 }, 240, 48)).toEqual({ width: 180, height: 240 });
  });
  it('never scales up', () => {
    expect(thumbSize({ width: 100, height: 50 }, 240, 48)).toEqual({ width: 100, height: 50 });
  });
  it('clamps an extreme proportion to the minimum side', () => {
    expect(thumbSize({ width: 4000, height: 20 }, 240, 48)).toEqual({ width: 240, height: 48 });
    expect(thumbSize({ width: 10, height: 10 }, 240, 48)).toEqual({ width: 48, height: 48 });
  });
  it.each([null, {}, { width: 0, height: 10 }, { width: -5, height: 10 }, { width: '800', height: 600 }, { width: Number.NaN, height: 600 }, { width: 800.5, height: 600 }])(
    'is null without usable dimensions: %o',
    (meta) => expect(thumbSize(meta as Record<string, unknown> | null, 240, 48)).toBeNull(),
  );
});
```

In `MessageAttachments.test.tsx`, add:

```ts
  it('reserves the fitted size of an image before it loads', () => {
    render(<MessageAttachments attachments={[att({ id: 'img1', name: 'foto.jpg', kind: 'image', mime: 'image/jpeg', meta: { width: 1600, height: 1200 } })]} />);
    const thumb = screen.getByRole('img', { name: 'foto.jpg' }) as HTMLImageElement;
    expect(thumb.style.width).toBe('240px');
    expect(thumb.style.height).toBe('180px');
  });

  it('keeps the old bounds when the image has no dimensions yet', () => {
    render(<MessageAttachments attachments={[att({ id: 'img1', name: 'foto.jpg', kind: 'image', mime: 'image/jpeg', meta: null })]} />);
    const thumb = screen.getByRole('img', { name: 'foto.jpg' }) as HTMLImageElement;
    expect(thumb.style.width).toBe('');
    expect(thumb.className).toContain('max-h-60');
  });
```

- [ ] **Step 2: Run to see them fail**

```bash
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/w" -w /w/apps/web node:20 sh -c 'npx vitest run src/lib/attachments.test.ts src/components/chat/MessageAttachments.test.tsx'
```

Expected: FAIL (`thumbSize` is not exported; `style.width` is empty).

- [ ] **Step 3: Implement**

`lib/attachments.ts`:

```ts
const isDimension = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0;

/**
 * The size a thumbnail takes before its file loads (TER-197): the image's own proportion, scaled down
 * to fit `box`, each side at least `min` (the rest is cropped by object-cover). Null when the server has
 * not (or could not) read the dimensions; the caller then keeps its unsized layout. The app keeps a copy.
 */
export function thumbSize(meta: Record<string, unknown> | null, box: number, min: number): { width: number; height: number } | null {
  const width = meta?.width;
  const height = meta?.height;
  if (!isDimension(width) || !isDimension(height)) return null;
  const scale = Math.min(1, box / width, box / height);
  const fit = (v: number) => Math.min(box, Math.max(min, Math.round(v * scale)));
  return { width: fit(width), height: fit(height) };
}
```

`MessageAttachments.tsx`: import `thumbSize` with the other `lib/attachments` imports, add
module constants and pass the style:

```tsx
/** 240 px at most on either side (`max-*-60` is 15rem); 48 px at least once the size is known. */
const THUMB_BOX = 240;
const THUMB_MIN = 48;
```

```tsx
          if (a.kind === 'image') {
            const size = thumbSize(a.meta, THUMB_BOX, THUMB_MIN);
            return (
              <li key={a.id}>
                <button type="button" className="block overflow-hidden rounded-lg" aria-label={`Abrir imagem ${a.name}`} onClick={() => setViewing(a)}>
                  {/* Sized from meta before it loads, so rows below do not move (TER-197). */}
                  <img src={api.chat.attachments.url(a.id)} alt={a.name} loading="lazy" className="max-h-60 max-w-60 object-cover" style={size ?? undefined} />
                </button>
              </li>
            );
          }
```

(Remove the old `{/* 240 px at most … */}` comment; the constant carries it.)

- [ ] **Step 4: Run again** (Step 2 command). Expected: PASS, including the three older tests.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/attachments.ts apps/web/src/lib/attachments.test.ts apps/web/src/components/chat/MessageAttachments.tsx apps/web/src/components/chat/MessageAttachments.test.tsx
git commit -m "Chat: reserve an image thumbnail's size from its dimensions"
```

### Task 5: app thumbnail with its fitted size

**Files:**
- Modify: `apps/mobile/src/features/chat/viewmodel/attachments.ts` (add `thumbSize`)
- Test: `apps/mobile/src/features/chat/viewmodel/attachments.test.ts` (append; create if absent)
- Modify: `apps/mobile/src/features/chat/view/message-attachments.tsx` (`AuthImage`, the thumbnail)
- Test: `apps/mobile/src/features/chat/view/message-attachments.test.tsx`

**Interfaces:**
- Produces: the same `thumbSize` signature as Task 4, in the app. `AuthImage` gains
  `size?: { width: number; height: number } | null`.

- [ ] **Step 1: Write the failing tests**

`attachments.test.ts` (append; add the import):

```ts
import { thumbSize } from './attachments';

describe('thumbSize', () => {
  it('fits the long side to the box and keeps the proportion', () => {
    expect(thumbSize({ width: 1600, height: 1200 }, 160, 64)).toEqual({ width: 160, height: 120 });
    expect(thumbSize({ width: 1200, height: 1600 }, 160, 64)).toEqual({ width: 120, height: 160 });
  });
  it('never scales up, and clamps to the minimum side', () => {
    expect(thumbSize({ width: 100, height: 80 }, 160, 64)).toEqual({ width: 100, height: 80 });
    expect(thumbSize({ width: 4000, height: 20 }, 160, 64)).toEqual({ width: 160, height: 64 });
  });
  it.each([null, {}, { width: 0, height: 10 }, { width: '800', height: 600 }, { width: Number.NaN, height: 600 }])('is null without usable dimensions: %o', (meta) => {
    expect(thumbSize(meta as Record<string, unknown> | null, 160, 64)).toBeNull();
  });
});
```

`message-attachments.test.tsx` (add `StyleSheet` to a `react-native` import):

```tsx
import { StyleSheet } from 'react-native';

  it('sizes the thumbnail, its loading box and its reload button from the dimensions', async () => {
    mockAttachmentSource.mockImplementationOnce(() => new Promise(() => {})); // never signs: the loading box stays
    const sized = { ...image, meta: { width: 1600, height: 1200 } };
    await render(<MessageAttachments attachments={[sized]} />);
    expect(StyleSheet.flatten(screen.getByTestId('attachment-placeholder').props.style)).toMatchObject({ width: 160, height: 120 });
  });

  it('sizes the loaded image from the dimensions too', async () => {
    await render(<MessageAttachments attachments={[{ ...image, meta: { width: 1200, height: 1600 } }]} />);
    const loaded = await screen.findByLabelText('foto.jpg');
    expect(StyleSheet.flatten(loaded.props.style)).toMatchObject({ width: 120, height: 160 });
  });

  it('keeps the square box when the image has no dimensions', async () => {
    await render(<MessageAttachments attachments={[image]} />);
    const loaded = await screen.findByLabelText('foto.jpg');
    // No explicit size: only what the `h-40 w-40` class gives (NativeWind may or may not turn it into style here).
    expect([undefined, 160]).toContain(StyleSheet.flatten(loaded.props.style)?.width);
  });
```

- [ ] **Step 2: Run to see them fail**

```bash
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/w" -w /w/apps/mobile node:20 sh -c 'npx jest src/features/chat/viewmodel/attachments.test.ts src/features/chat/view/message-attachments.test.tsx'
```

Expected: FAIL.

- [ ] **Step 3: Implement**

`viewmodel/attachments.ts` — the same function as the web (Task 4, Step 3), with the comment's last
sentence reading "The web keeps a copy." instead.

`message-attachments.tsx`:

```tsx
import { attachmentStatusText, formatBytes, thumbSize } from '../viewmodel/attachments';

/** The thumbnail's box (`h-40 w-40`), and its smallest side once the size is known (a tappable reload). */
const THUMB_BOX = 160;
const THUMB_MIN = 64;

type Size = { width: number; height: number };

function AuthImage({ attachment, className, resizeMode, size }: { attachment: TChatAttachment; className: string; resizeMode: 'cover' | 'contain'; size?: Size | null }) {
  const [load, dispatch] = useReducer(loadReducer, { attempt: 0, errors: 0 });
  const source = useAttachmentSource(attachment.id, load.attempt);
  const stuck = load.errors >= 2 && load.attempt < load.errors;
  // Every state takes the same box, so the row never changes size when the image arrives (TER-197).
  const style = size ?? undefined;
  if (stuck) {
    return (
      <Pressable accessibilityRole="button" accessibilityLabel="Toque para recarregar" onPress={() => dispatch('reload')} className={`${className} items-center justify-center bg-app-surface2`} style={style}>
        <Text className="text-xs text-app-muted">Toque para recarregar</Text>
      </Pressable>
    );
  }
  if (!source) return <View testID="attachment-placeholder" className={`${className} bg-app-surface2`} style={style} />;
  return <Image source={source} accessibilityLabel={attachment.name} resizeMode={resizeMode} className={className} style={style} onError={() => dispatch('error')} />;
}
```

and the thumbnail call:

```tsx
              <AuthImage attachment={a} className="h-40 w-40 rounded-lg" resizeMode="cover" size={thumbSize(a.meta, THUMB_BOX, THUMB_MIN)} />
```

The explicit `style` width/height overrides the `h-40 w-40` class. The full-screen viewer passes no
`size` and is unchanged.

- [ ] **Step 4: Run again** (Step 2 command) and the typecheck:

```bash
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/w" -w /w node:20 sh -c 'npm run typecheck -w @termhub/mobile'
```

Expected: PASS, including the older "re-signs once on a failed load" test.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/src/features/chat/viewmodel/attachments.ts apps/mobile/src/features/chat/viewmodel/attachments.test.ts apps/mobile/src/features/chat/view/message-attachments.tsx apps/mobile/src/features/chat/view/message-attachments.test.tsx
git commit -m "Mobile chat: size image thumbnails from their dimensions"
```

---

## Card TER-198 — the app image after the token expired

### Task 6: renew a stale token before signing an image

**Files:**
- Modify: `apps/mobile/src/features/chat/viewmodel/createChatStore.ts` (`SessionApi` ~line 36, `attachmentSource` ~line 624)
- Test: `apps/mobile/src/features/chat/viewmodel/createChatStore.test.ts` (next to "attachmentSource signs the download url", ~line 1017; and the hand-built locked session at ~line 753)

**Interfaces:**
- Consumes: `SessionState.tokenStale(): boolean`, `SessionState.renewToken(): Promise<string | null>` (existing, `features/session`).
- Produces: `SessionApi = Pick<SessionState, 'auth' | 'handleApiError' | 'requestPinProof' | 'requestPinProofs' | 'phase' | 'tokenStale' | 'renewToken'>`.

- [ ] **Step 1: Write the failing tests** — after the existing `attachmentSource` test:

```ts
  it('attachmentSource renews a stale token first and signs with the new one', async () => {
    const { chat, store } = await setup();
    await openAndConnect(chat, 'p-termhub');
    const state = store.getState();
    jest.spyOn(state, 'tokenStale').mockReturnValue(true);
    const renew = jest.spyOn(state, 'renewToken');
    const pending = chat.getState().attachmentSource('att1');
    await jest.advanceTimersByTimeAsync(0);
    const source = await pending;
    expect(renew).toHaveBeenCalledTimes(1);
    const fresh = await renew.mock.results[0]!.value;
    expect(fresh).toBeTruthy();
    expect(source.headers.Authorization).toBe(`Bearer ${fresh}`);
  });

  it('attachmentSource does not renew a fresh token', async () => {
    const { chat, store } = await setup();
    await openAndConnect(chat, 'p-termhub');
    const renew = jest.spyOn(store.getState(), 'renewToken');
    await chat.getState().attachmentSource('att1');
    expect(renew).not.toHaveBeenCalled();
  });

  it('thumbnails appearing together with a stale token share one renewal', async () => {
    const { chat, store, api } = await setup();
    await openAndConnect(chat, 'p-termhub');
    jest.spyOn(store.getState(), 'tokenStale').mockReturnValue(true);
    const token = jest.spyOn(api, 'token');
    const all = Promise.all(['a1', 'a2', 'a3'].map((id) => chat.getState().attachmentSource(id)));
    await jest.advanceTimersByTimeAsync(0);
    await all;
    expect(token).toHaveBeenCalledTimes(1);
  });
```

(`setupSession()` returns `store` and `api`; `setup()` spreads them. If the field is named
differently in `test/helpers/enrolled-session.ts`, use that name.)

- [ ] **Step 2: Run to see them fail**

```bash
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/w" -w /w/apps/mobile node:20 sh -c 'npx jest src/features/chat/viewmodel/createChatStore.test.ts -t attachmentSource'
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/w" -w /w/apps/mobile node:20 sh -c 'npx jest src/features/chat/viewmodel/createChatStore.test.ts -t "share one renewal"'
```

Expected: the renewal tests FAIL (`renewToken` never called).

- [ ] **Step 3: Implement**

`SessionApi`:

```ts
export type SessionApi = Pick<SessionState, 'auth' | 'handleApiError' | 'requestPinProof' | 'requestPinProofs' | 'phase' | 'tokenStale' | 'renewToken'>;
```

`attachmentSource`:

```ts
          async attachmentSource(id) {
            // `<Image>` fetches the url itself, so it never gets the client's TOKEN_EXPIRED retry. A
            // token that expired while the app slept (the renewal timer does not run in the
            // background) is renewed here first, through the session's single flight (TER-198).
            if (session().tokenStale()) await session().renewToken();
            return api.attachmentSource(session().auth(), id);
          },
```

The hand-built locked session at ~line 753 gains `tokenStale: () => true, renewToken: async () => null,`.
Any other object literal typed `SessionApi` that `tsc` flags gets the same two fields.

- [ ] **Step 4: Run the whole file and the typecheck**

```bash
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/w" -w /w/apps/mobile node:20 sh -c 'npx jest src/features/chat/viewmodel/createChatStore.test.ts'
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/w" -w /w node:20 sh -c 'npm run typecheck -w @termhub/mobile'
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/src/features/chat/viewmodel/createChatStore.ts apps/mobile/src/features/chat/viewmodel/createChatStore.test.ts
git commit -m "Mobile chat: renew a stale token before signing an image"
```

### Task 7: never mount an image with the previous proof

**Files:**
- Modify: `apps/mobile/src/features/chat/view/message-attachments.tsx` (`useAttachmentSource`)
- Test: `apps/mobile/src/features/chat/view/message-attachments.test.tsx`

**Interfaces:**
- Produces: `export function useAttachmentSource(id: string, attempt: number): Source | null` (now
  exported for the test; same signature).

- [ ] **Step 1: Write the failing test**

```tsx
import { renderHook } from '@testing-library/react-native';
import { MessageAttachments, useAttachmentSource } from './message-attachments';

  it('a new attempt never returns the previous proof, not even for one render', async () => {
    const seen: (string | null)[] = [];
    const { rerender } = await renderHook(({ attempt }) => {
      const s = useAttachmentSource('img1', attempt);
      seen.push(s?.headers.DPoP ?? null);
      return s;
    }, { initialProps: { attempt: 0 } });
    await waitFor(() => expect(seen).toContain('proof-1'));

    mockAttachmentSource.mockImplementationOnce(() => new Promise(() => {})); // the new proof is still being signed
    seen.length = 0;
    await act(async () => rerender({ attempt: 1 }));
    expect(seen).not.toContain('proof-1');
    expect(seen.at(-1)).toBeNull();
  });
```

(Merge the imports with the file's existing ones.)

- [ ] **Step 2: Run to see it fail**

```bash
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/w" -w /w/apps/mobile node:20 sh -c 'npx jest src/features/chat/view/message-attachments.test.tsx'
```

Expected: FAIL — `seen` contains `'proof-1'` from the render before the effect cleared it (or the
import fails because the hook is not exported).

- [ ] **Step 3: Implement**

```tsx
/** The signed `<Image source>` for a sent image: the store signs one DPoP proof per `attempt`, with the
 * token it holds then. `null` while a proof is being signed. A source is tied to the attempt it was
 * signed for and read during render, so a new attempt never mounts the previous, already used proof. */
export function useAttachmentSource(id: string, attempt: number): Source | null {
  const attachmentSource = useChatStore((s) => s.attachmentSource);
  const [signed, setSigned] = useState<{ id: string; attempt: number; source: Source } | null>(null);
  useEffect(() => {
    let live = true;
    attachmentSource(id)
      .then((source) => live && setSigned({ id, attempt, source }))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [attachmentSource, id, attempt]);
  return signed && signed.id === id && signed.attempt === attempt ? signed.source : null;
}
```

- [ ] **Step 4: Run again** (Step 2 command). Expected: PASS, including "re-signs once on a failed
  load, then offers a tap" and Task 5's tests.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/src/features/chat/view/message-attachments.tsx apps/mobile/src/features/chat/view/message-attachments.test.tsx
git commit -m "Mobile chat: tie an image's signed source to its attempt"
```

---

## Card TER-199 — focus in the web dialogs

### Task 8: `useDialogFocus`, used by `Modal`

**Files:**
- Modify: `apps/web/src/components/Modal.tsx` (add `useDialogFocus`; use it in `Modal`)
- Test: `apps/web/src/components/Modal.test.tsx` (create)

**Interfaces:**
- Produces: `export function useDialogFocus(open: boolean, containerRef: RefObject<HTMLElement | null>, initialFocusRef?: RefObject<HTMLElement | null>): (e: React.KeyboardEvent) => void`
  — the returned function is the container's `onKeyDown` (the Tab trap).

- [ ] **Step 1: Write the failing tests** — `Modal.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfirmDialog, Modal } from './Modal';

afterEach(() => cleanup());

function Harness({ autoFocus = false }: { autoFocus?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>Abrir</button>
      <Modal title="Renomear" open={open} onClose={() => setOpen(false)}>
        <input aria-label="Nome" autoFocus={autoFocus} />
        <button>Salvar</button>
      </Modal>
    </>
  );
}

describe('Modal focus', () => {
  it('moves focus into the dialog and gives it back to the opener on close', () => {
    render(<Harness />);
    const opener = screen.getByRole('button', { name: 'Abrir' });
    opener.focus();
    fireEvent.click(opener);
    expect(document.activeElement).toBe(screen.getByRole('dialog'));
    fireEvent.click(screen.getByRole('button', { name: 'Fechar' }));
    expect(document.activeElement).toBe(opener);
  });

  it('keeps an autoFocus field focused, and still gives focus back to the opener', () => {
    render(<Harness autoFocus />);
    const opener = screen.getByRole('button', { name: 'Abrir' });
    opener.focus();
    fireEvent.click(opener);
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Nome' }));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(document.activeElement).toBe(opener);
  });

  it('keeps ConfirmDialog on its confirm button', () => {
    render(<ConfirmDialog open title="Excluir" message="Certeza?" confirmLabel="Excluir" onConfirm={() => {}} onCancel={() => {}} />);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Excluir' }));
  });

  it('wraps Tab and Shift+Tab inside the dialog', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Abrir' }));
    const dialog = screen.getByRole('dialog');
    const close = screen.getByRole('button', { name: 'Fechar' });
    const save = screen.getByRole('button', { name: 'Salvar' });
    save.focus();
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(save);
  });

  it('does nothing when the opener is gone', () => {
    const { rerender } = render(<Modal title="X" open={false} onClose={() => {}}><p>x</p></Modal>);
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    rerender(<Modal title="X" open onClose={() => {}}><p>x</p></Modal>);
    opener.remove();
    expect(() => rerender(<Modal title="X" open={false} onClose={() => {}}><p>x</p></Modal>)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run to see them fail**

```bash
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/w" -w /w/apps/web node:20 sh -c 'npx vitest run src/components/Modal.test.tsx'
```

Expected: the first and the Tab tests FAIL; the autoFocus and ConfirmDialog tests may already
pass (they pin behaviour the hook must not break).

- [ ] **Step 3: Implement** — in `Modal.tsx` (add `type KeyboardEvent as ReactKeyboardEvent`, `type RefObject` to the react import):

```tsx
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const focusables = (root: HTMLElement) => Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => !el.hidden && !el.closest('[inert]'));

/**
 * Focus for a modal layer (TER-199): on open, focus goes in — unless something inside already took it
 * (an `autoFocus` field; React applies it during commit, before this effect) — to `initialFocusRef` or
 * else the container itself (give it `tabIndex={-1}`). Tab and Shift+Tab wrap inside through the returned
 * `onKeyDown`, which only sees keys pressed inside this dialog, so stacked layers do not fight. On close,
 * focus goes back to what had it before, if that is still in the document.
 */
export function useDialogFocus(open: boolean, containerRef: RefObject<HTMLElement | null>, initialFocusRef?: RefObject<HTMLElement | null>) {
  // The opener is read during the render that opens the dialog: by the time any effect runs, an
  // `autoFocus` child has already taken focus, and the opener would be lost.
  const opener = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  if (open && !wasOpen.current) opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  wasOpen.current = open;

  useEffect(() => {
    if (!open) return;
    const container = containerRef.current;
    if (container && !container.contains(document.activeElement)) (initialFocusRef?.current ?? container).focus();
    return () => {
      const back = opener.current;
      if (back && back.isConnected) back.focus();
    };
  }, [open, containerRef, initialFocusRef]);

  return (e: ReactKeyboardEvent) => {
    const container = containerRef.current;
    if (e.key !== 'Tab' || !container) return;
    const items = focusables(container);
    if (items.length === 0) {
      e.preventDefault();
      container.focus();
      return;
    }
    const first = items[0]!;
    const last = items[items.length - 1]!;
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === container)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  };
}
```

In `Modal`:

```tsx
export function Modal({ title, open, onClose, children, width = 'max-w-md', dismissible = true }: Props) {
  useEscapeLayer(open, onClose, dismissible);
  const dialogRef = useRef<HTMLDivElement>(null);
  const onKeyDown = useDialogFocus(open, dialogRef);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onMouseDown={dismissible ? onClose : undefined}>
      <div
        ref={dialogRef}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className={`flex max-h-[calc(100vh-2rem)] w-full ${width} flex-col rounded-lg border border-line bg-bg-2 shadow-2xl outline-none`}
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
```

(rest unchanged). `outline-none` hides the ring on the container itself; its children keep theirs.
`aria-label={title}` lets the test find the dialog by name and gives screen readers the title.

- [ ] **Step 4: Run the new file and every existing web test that renders a `Modal`**

```bash
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/w" -w /w node:20 sh -c 'npm test -w @termhub/web'
```

Expected: `Modal.test.tsx` PASSES. Compare failures against `origin/main`: the 5 office/scene
suites that fail there with "navigator is not defined" (pixi.js) are pre-existing; anything else
that fails is this task's to fix (most likely a test that asserted `document.activeElement` after
opening a modal).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/Modal.tsx apps/web/src/components/Modal.test.tsx
git commit -m "Modal: move focus in, trap Tab, give focus back on close"
```

### Task 9: the image viewer

**Files:**
- Modify: `apps/web/src/components/chat/ImageViewer.tsx`
- Test: `apps/web/src/components/chat/MessageAttachments.test.tsx`

**Interfaces:**
- Consumes: `useDialogFocus` (Task 8).

- [ ] **Step 1: Write the failing test**

```tsx
  it('focuses Fechar in the viewer, keeps Tab inside, and returns focus to the thumbnail', () => {
    render(<MessageAttachments attachments={[att({ id: 'img1', name: 'foto.jpg', kind: 'image', mime: 'image/jpeg' })]} />);
    const thumb = screen.getByRole('button', { name: 'Abrir imagem foto.jpg' });
    thumb.focus();
    fireEvent.click(thumb);
    const close = screen.getByRole('button', { name: 'Fechar' });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Tab' });
    expect(document.activeElement).toBe(close);
    fireEvent.click(close);
    expect(document.activeElement).toBe(thumb);

    fireEvent.click(thumb);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(document.activeElement).toBe(thumb);
  });
```

- [ ] **Step 2: Run to see it fail**

```bash
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/w" -w /w/apps/web node:20 sh -c 'npx vitest run src/components/chat/MessageAttachments.test.tsx'
```

Expected: FAIL (focus stays on the thumbnail, then falls to `body`).

- [ ] **Step 3: Implement** — `ImageViewer.tsx`:

```tsx
import { X } from 'lucide-react';
import { useRef } from 'react';
import { api } from '../../lib/api';
import type { ChatAttachment } from '../../lib/types';
import { useDialogFocus, useEscapeLayer } from '../Modal';

/**
 * A sent image, full size, over the page. Escape closes it through the app's layer stack, so an open
 * viewer answers Escape before the drawer or a modal under it; so does a click anywhere but the image.
 * Focus starts on "Fechar", stays inside, and goes back to the thumbnail on close (TER-199).
 */
export function ImageViewer({ attachment, onClose }: { attachment: ChatAttachment | null; onClose: () => void }) {
  useEscapeLayer(attachment !== null, onClose);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const onKeyDown = useDialogFocus(attachment !== null, dialogRef, closeRef);
  if (!attachment) return null;
  return (
    <div ref={dialogRef} tabIndex={-1} onKeyDown={onKeyDown} role="dialog" aria-modal="true" aria-label={attachment.name} className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-4 outline-none" onMouseDown={onClose}>
      <img src={api.chat.attachments.url(attachment.id)} alt={attachment.name} className="max-h-full max-w-full rounded object-contain" onMouseDown={(e) => e.stopPropagation()} />
      <button ref={closeRef} type="button" className="absolute right-4 top-4 rounded-full bg-black/50 p-2 text-white hover:bg-black/70" aria-label="Fechar" onClick={onClose}>
        <X size={18} aria-hidden="true" />
      </button>
    </div>
  );
}
```

- [ ] **Step 4: Run again** (Step 2 command). Expected: PASS, with the older viewer tests.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/chat/ImageViewer.tsx apps/web/src/components/chat/MessageAttachments.test.tsx
git commit -m "Chat image viewer: focus Fechar, trap Tab, return focus on close"
```

---

## Wrap-up (tracked on TER-197, the card linked to this work's tab)

### Task 10: full verification

**Files:** none changed unless a check fails.

- [ ] **Step 1: Suites, typecheck and builds**

```bash
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -e DATABASE_URL=postgresql://test:test@localhost:5432/test -v "$PWD:/w" -w /w node:20 sh -c \
  'npm test -w @termhub/server && npm test -w @termhub/web && npm test -w @termhub/mobile && npm run typecheck -w @termhub/server && npm run typecheck -w @termhub/mobile && npm run build -w @termhub/web && npm run build -w @termhub/landing'
rm -rf .npm
```

Expected: everything passes except the 5 web office/scene suites that already fail on `origin/main`
("navigator is not defined"); name them in the report if they still fail.

- [ ] **Step 2: DB suite and the Prisma guard**

```bash
docker run --rm --network container:th-ter200-db -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/w" -w /w/apps/server \
  -e TERMHUB_DB_TESTS=1 -e DATABASE_URL=postgresql://postgres:postgres@localhost:5432/termhub node:20 \
  sh -c 'npx prisma migrate deploy && npx vitest run src/db/repositories/api-tokens.db.test.ts'
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/w" -w /w node:20 sh -c 'npm run prisma:generate -w @termhub/server'
git diff --exit-code -- apps/server/src/generated && echo clean
docker stop th-ter200-db
```

Expected: PASS, `clean`, and the throwaway database stopped (by that exact name only).

- [ ] **Step 3: Report** — per card: what changed, the tests added, and what is left to the
  person: the app changes (TER-197, TER-198) reach phones only with the next TestFlight build
  (TER-104); TER-199's optional pinch zoom in the app was not done (spec §3); TER-201 was already
  resolved on `main` (f1d2af4) and this branch adds the CI guard.
