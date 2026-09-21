# Chat UI: full screen, rendered text, mobile first — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the concierge chat into a full-screen, phone-first conversation whose answers are rendered Markdown and whose confirmation cards sit inline in the thread.

**Architecture:** The page keeps every behaviour shipped in steps 1 and 2 — the same REST load, the same `/ws/chat` stream, the same gate cards and decisions — and changes only how it is presented. Three pure modules carry the logic that deserves tests (`markdown.ts` for sanitised rendering, `chat-timeline.ts` for the single ordered thread, `chat-scroll.ts` for when to follow new content), the shell is split so `/chat` renders without the sidebar, and the view is broken into small presentational components. One server-side change is needed: the action card must carry the row's `created_at`, because a card cannot be placed in a chronological thread without it.

**Tech Stack:** React 18 + React Router 7 + Tailwind 3 (`apps/web`), `marked` + `dompurify` (already dependencies, used by `NotesEditor.tsx`), Vitest + @testing-library/react, Fastify 5 (`apps/server`, Task 1 only).

**Spec:** `docs/superpowers/specs/2026-09-20-chat-concierge-design.md` — this plan implements the presentation layer of §6 (the chat surface). The visual decisions themselves were approved in conversation, and are restated here as Global Constraints; where this plan and the spec disagree about *appearance*, this plan wins, and where they disagree about *behaviour*, the spec wins.

## Global Constraints

- **No new dependencies.** `marked` and `dompurify` are already in `apps/web/package.json`; nothing else may be added. No Tailwind plugins.
- **UI copy in pt-BR; code, comments, commit messages and PR text in English.** (Repository CLAUDE.md.)
- **Model text is untrusted.** Every string that came from the concierge — message text, a card's `summary` — can carry content a model read off a real terminal screen. Assistant message bodies are rendered through `renderMarkdown` (sanitised) and nothing else; a card's `summary` stays plain text and is never passed to `dangerouslySetInnerHTML`. The user's own message text is never parsed as Markdown.
- **The existing tests are the behavioural contract.** `apps/web/src/pages/ChatPage.test.tsx` (21 tests) and `ChatPage.stream.test.tsx` must stay green. Where the new design deliberately changes a behaviour, change that one test and say why in the commit message; never delete a test to make a rewrite pass.
- **Colours come from the Tailwind tokens** already in `apps/web/tailwind.config.js` (`bg`, `bg-2`…`bg-4`, `fg`, `fg-muted`, `fg-dim`, `line`, `accent`, `warn`, `danger`, `ok`, `attention`). No hex literals in components.
- **Green means:** `npm run typecheck --workspaces --if-present` (there is no root `typecheck` script), `npm test -w @termhub/web`, and — for Task 1 — `npm test -w @termhub/server`. The web baseline on this branch is 21 files / 181 tests passing.
- **Reuse `.prose-termhub`** (already in `apps/web/src/index.css`) for rendered Markdown instead of writing a second set of Markdown styles.
- Only Task 1 touches `apps/server`. Tasks 2-6 are `apps/web` only.

## Review Focus

- **An assistant answer carrying HTML.** A `<script>`, an `onerror=` attribute or a `javascript:` link — the shapes a prompt injected into a terminal screen would aim for — must render as inert text or be dropped, never execute. (Tasks 2 and 5.)
- **An unterminated code fence mid-stream.** Every delta re-renders a partial document; an open ``` must render progressively without throwing. (Task 2.)
- **`window.matchMedia` absent.** jsdom has none, and neither do old browsers; the Enter-key policy must fall back to "Enter sends" instead of crashing the page. (Task 6.)
- **The user scrolled up while an answer streams.** New deltas must not yank the viewport back down; but the user's own send always returns to the bottom. (Task 6.)
- **Ordering that does not depend on render order.** An action whose `created_at` ties with a message, and an actions array that arrives in any order relative to messages, must produce one deterministic thread. (Task 3.)

---

### Task 1: The action card carries its own timestamp

A card cannot be placed in a chronological thread without one, and the row has had `created_at` all along — it is simply not copied into the card shape.

**Files:**
- Modify: `apps/server/src/db/repositories/chat-actions-view.ts` (`ChatActionCard`, `toCard`)
- Modify: `apps/server/src/chat/bus.ts` (the `confirmation` event shape)
- Modify: `apps/server/src/chat/gate-runtime.ts` (the `chatBus.publish` call that emits `confirmation`)
- Modify: `apps/web/src/lib/types.ts` (`ChatAction`)
- Test: `apps/server/src/db/repositories/chat-actions-view.test.ts`, `apps/server/src/mcp/gate.e2e.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `ChatActionCard.created_at: string` (ISO 8601, the row's own `created_at`) on `GET /api/chat`'s `actions[]` and on the `confirmation` bus event; the web `ChatAction` interface gains the same required field. Task 3 orders the thread by it.

- [ ] **Step 1: Write the failing tests**

In `chat-actions-view.test.ts`, one test: a card carries the row's `created_at` unchanged. Use the file's existing row factory and assert the exact value the row was given, not "a string" — a card built from `new Date()` would pass a shape check and silently reorder the thread.

In `gate.e2e.test.ts`, the test "publishes the question to the chat, with the arguments and no terminal content" (around line 541) asserts the event's **exact key set** with `Object.keys(collected[0]).sort()` (line 548) and then its full shape. Add `created_at` to both — the key-set assertion is deliberately exhaustive, so this test fails until the field is emitted, and it is the only place that needs touching.

- [ ] **Step 2: Run them and watch them fail**

`npm test -w @termhub/server -- chat-actions-view gate.e2e` — expect failures naming `created_at` as undefined.

- [ ] **Step 3: Add the field**

`created_at` on `ChatActionCard`, copied in `toCard`; on the `confirmation` event in `bus.ts`; emitted from `row.created_at` in `gate-runtime.ts`; and on `ChatAction` in the web `types.ts` (required, not optional — every producer sets it, and an optional field would let Task 3 silently sort by `undefined`).

- [ ] **Step 4: Green**

`npm test -w @termhub/server` and `npm run typecheck --workspaces --if-present`.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src apps/web/src/lib/types.ts
git commit -m "Chat: put the action row's created_at on the card, so it can be placed in the thread"
```

---

### Task 2: One sanitised Markdown renderer, shared

**Files:**
- Create: `apps/web/src/lib/markdown.ts`
- Create: `apps/web/src/lib/markdown.test.ts`
- Modify: `apps/web/src/components/NotesEditor.tsx` (use the shared function instead of its own inline `marked`/`DOMPurify` pair)

**Interfaces:**
- Consumes: nothing.
- Produces: `renderMarkdown(text: string): string` — GFM, `breaks: true`, sanitised HTML, safe to hand to `dangerouslySetInnerHTML`. Tasks 5 uses it for assistant bodies; `NotesEditor` uses it for the notes preview. It is the only place in `apps/web` that may call `marked` or `DOMPurify`.

- [ ] **Step 1: Write the failing tests**

`markdown.test.ts` (`// @vitest-environment jsdom` — DOMPurify needs a DOM), one assertion per test:

1. `**oi**` becomes a `<strong>`.
2. A fenced block becomes `<pre><code>`, and its contents are not interpreted as Markdown.
3. `<script>alert(1)</script>` produces no `script` element in the output (assert by parsing the result, not by substring matching).
4. `<img src=x onerror="alert(1)">` produces no `onerror` attribute.
5. `[x](javascript:alert(1))` produces an anchor without a `javascript:` href.
6. An unterminated fence — `"texto\n```bash\nnpm test"` — returns a string and does not throw (this is every streamed delta in Task 5).
7. `breaks: true` holds: a single newline inside a paragraph becomes a `<br>`, because the concierge writes answers as prose with hard wraps.
8. The empty string returns the empty string (an assistant row exists before any delta arrives).

- [ ] **Step 2: Run them and watch them fail**

`npm test -w @termhub/web -- markdown` — expect a module-not-found error.

- [ ] **Step 3: Write `renderMarkdown`**

Mirror `NotesEditor.tsx:13,96`: `marked.setOptions({ gfm: true, breaks: true })` once at module scope, then `DOMPurify.sanitize(marked.parse(text, { async: false }) as string)`. Do not pass `ALLOWED_TAGS`-style options unless a test above demands it — DOMPurify's defaults already drop `script` and event handlers, and a hand-written allowlist is a second thing to keep right. Document in a comment *why* the function exists (one place where untrusted model text becomes HTML), not what the two library calls do.

- [ ] **Step 4: Point `NotesEditor` at it**

Replace its inline pair with `renderMarkdown`, drop its now-unused imports and its local `marked.setOptions`. `npm test -w @termhub/web` must stay green, including `WaitlistView`/notes tests.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/markdown.ts apps/web/src/lib/markdown.test.ts apps/web/src/components/NotesEditor.tsx
git commit -m "Web: one sanitised Markdown renderer, shared by notes and (next) the chat"
```

---

### Task 3: The thread is one ordered list

**Files:**
- Create: `apps/web/src/lib/chat-timeline.ts`
- Create: `apps/web/src/lib/chat-timeline.test.ts`

**Interfaces:**
- Consumes: `ChatMessage` and `ChatAction` from `apps/web/src/lib/types.ts` (the latter now carrying `created_at`, Task 1).
- Produces:
  ```ts
  export type ChatEntry = { kind: 'message'; at: string; message: ChatMessage } | { kind: 'action'; at: string; action: ChatAction };
  export function chatTimeline(messages: ChatMessage[], actions: ChatAction[]): ChatEntry[];
  ```
  Task 5 renders exactly this array, in order, as the single `<ol>`.

- [ ] **Step 1: Write the failing tests**

`chat-timeline.test.ts` (plain environment, no DOM):

1. Messages and actions interleave by `created_at`: given two messages at 00:00 and 00:02 and an action at 00:01, the order is message, action, message.
2. A tie is deterministic and puts the message first: a message and an action with the identical `created_at` always come out in that order, and swapping the input arrays does not change the output.
3. Input order does not matter: the same two arrays shuffled produce an identical result (compare the id sequence).
4. Neither input array is mutated (`messages` and `actions` are React state; sorting them in place is a re-render bug that only shows up under StrictMode).
5. An empty conversation returns `[]`.
6. Every entry's `at` equals the underlying row's `created_at`, so the caller never has to reach into the union to sort or group again.

- [ ] **Step 2: Run them and watch them fail**

`npm test -w @termhub/web -- chat-timeline`.

- [ ] **Step 3: Implement**

A pure function: map both inputs into entries, concatenate copies, and sort by `at` with a stable tiebreak on `kind` (`message` before `action`). Comment the *why* of the tiebreak: a card is always proposed during the answer it belongs to, so on equal timestamps it reads correctly after the message.

- [ ] **Step 4: Green**

`npm test -w @termhub/web -- chat-timeline`.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/chat-timeline.ts apps/web/src/lib/chat-timeline.test.ts
git commit -m "Web: merge chat messages and gate cards into one ordered thread"
```

---

### Task 4: `/chat` renders without the app chrome

**Files:**
- Modify: `apps/web/src/components/Layout.tsx` (extract the shell; keep the sidebar layout)
- Create: `apps/web/src/components/ChatLayout.tsx`
- Create: `apps/web/src/components/ChatLayout.test.tsx`
- Modify: `apps/web/src/App.tsx` (route `/chat` through the new layout)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `AppShell` (exported from `Layout.tsx`): the auth guard plus `DataProvider` → `MonitorProvider` → `ToastProvider` → `NeedsYouToasts` + `Toaster`, rendering `<Outlet />`. `Layout` becomes `AppShell`'s child that adds the sidebar; `ChatLayout` is `AppShell`'s child that adds nothing but a thin header. Task 5 renders inside `ChatLayout`.

- [ ] **Step 1: Write the failing test**

`ChatLayout.test.tsx` (`// @vitest-environment jsdom`), rendering `ChatLayout` inside a `MemoryRouter` with a child route that renders a marker:

1. It renders the routed child.
2. It renders no `nav` element (`screen.queryByRole('navigation')` is null) — this is the "sem menus" requirement, and it is what a future refactor would silently undo.
3. It offers a labelled way back to the app: a link whose `href` is `/` (query it by its accessible name — the test must not care whether the glyph is `←` or a word).

Nesting matters: `AppShell` is the piece that needs the auth/data/monitor providers, and `ChatLayout` must need none of them, so this test mocks nothing. If it turns out to need a provider mock, the split is wrong — move that dependency up into `AppShell`.

- [ ] **Step 2: Run it and watch it fail**

`npm test -w @termhub/web -- ChatLayout`.

- [ ] **Step 3: Split the shell**

Extract `AppShell` from `Layout` — a pure move: the loading message, the `Navigate` to `/login`, the three providers and the two overlay components stay exactly as they are, so a chat page still receives monitor pushes and toasts. `Layout` keeps the sidebar/rail and its `localStorage` collapse state. Write `ChatLayout`: a full-height column (`h-[100dvh]`, `overflow-hidden`) with a thin header carrying the back link and room for the page's own status text, then `<Outlet />` in a `min-h-0 flex-1` region. In `App.tsx`, nest `Layout`'s existing routes and a new `ChatLayout` route with `/chat` under one `AppShell` route.

- [ ] **Step 4: Green**

`npm test -w @termhub/web` (all 22 files) and `npm run typecheck --workspaces --if-present`. Every existing route test must still pass: the providers moved, nothing changed about them.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/App.tsx apps/web/src/components/Layout.tsx apps/web/src/components/ChatLayout.tsx apps/web/src/components/ChatLayout.test.tsx
git commit -m "Web: give the chat its own full-height layout, without the sidebar"
```

---

### Task 5: The conversation reads like a conversation

The visual heart of the change: one ordered thread, assistant answers as rendered Markdown in plain text (no bubble), the user's own words in a bubble on the right, gate cards inline where they were proposed, all inside a reading-width column.

**Files:**
- Create: `apps/web/src/components/chat/ChatTurn.tsx` (one message: user bubble or assistant prose)
- Create: `apps/web/src/components/chat/ChatActionCard.tsx` (one gate card with its buttons)
- Modify: `apps/web/src/pages/ChatPage.tsx` (state and wiring stay; the list becomes `chatTimeline` + these two components)
- Test: `apps/web/src/pages/ChatPage.test.tsx` (the contract; extend, do not rewrite)

**Interfaces:**
- Consumes: `renderMarkdown` (Task 2), `chatTimeline`/`ChatEntry` (Task 3), `ChatLayout` (Task 4).
- Produces: `ChatTurn` and `ChatActionCard` as presentational components — every decision (`decidingId`, `queuedNotes`, `live`) stays in `ChatPage` and arrives as props. Task 6 replaces the composer in the same page.

- [ ] **Step 1: Write the failing tests**

Add to `ChatPage.test.tsx`, reusing its `msg`/`action` factories and mocks (give the factories a `created_at` per case where ordering matters):

1. An assistant answer of `"**pronto**"` renders a `strong` element — the answer is Markdown, not a literal.
2. A user message of `"**oi**"` renders the asterisks literally — the user's text is never parsed.
3. An assistant answer containing `<script>alert(1)</script>` puts no `script` element in the document.
4. A pending card sits between the two messages it belongs between: with a user message at 00:00, an action at 00:01 and an assistant message at 00:02, the single list's items appear in that order (assert on the list's `li` text in order, so a card rendered in a separate list below fails this test).
5. There is exactly one list on the page (`screen.getAllByRole('list')` has length 1) — the old two-list layout is what this task removes.
6. A streaming delta renders as Markdown too, not as raw text (deliver a `delta` event with `**parcial**` and assert the `strong`).

- [ ] **Step 2: Run them and watch them fail**

`npm test -w @termhub/web -- ChatPage` — expect 6 new failures and the 21 existing tests still passing.

- [ ] **Step 3: Build the view**

`ChatTurn`: user → a bubble on the right (`whitespace-pre-wrap`, no Markdown); assistant → left-aligned prose in a `.prose-termhub` container fed by `renderMarkdown`, with the same "pensando…" and "não terminou" rules the page already computes (they arrive as props — this component must not re-derive them). Keep the tool chips, quieter. `ChatActionCard`: the sentence as plain text, `Autorizar`/`Recusar` while pending, the status label once decided, the queued note underneath — the same strings as today, since those are asserted by the existing tests. `ChatPage`: render `chatTimeline(messages, actions)` as the single `<ol>`, column centred at a reading width (`mx-auto w-full max-w-3xl`), horizontal padding that survives a phone (`px-4`).

- [ ] **Step 4: Green**

`npm test -w @termhub/web` — the new tests and all 21 originals. `npm run typecheck --workspaces --if-present`.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/chat apps/web/src/pages/ChatPage.tsx apps/web/src/pages/ChatPage.test.tsx
git commit -m "Chat: one thread, rendered answers, cards where they were proposed"
```

---

### Task 6: The composer, on a phone

**Files:**
- Create: `apps/web/src/lib/chat-scroll.ts`
- Create: `apps/web/src/lib/chat-scroll.test.ts`
- Create: `apps/web/src/components/chat/ChatComposer.tsx`
- Modify: `apps/web/src/pages/ChatPage.tsx` (use the composer; follow new content only when it should)
- Modify: `apps/web/src/index.css` (only if a safe-area rule cannot be expressed with Tailwind utilities)
- Test: `apps/web/src/pages/ChatPage.test.tsx`

**Interfaces:**
- Consumes: everything above.
- Produces:
  ```ts
  export function isNearBottom(el: Pick<HTMLElement, 'scrollTop' | 'scrollHeight' | 'clientHeight'>, slack?: number): boolean; // default slack 48px
  export function enterSends(): boolean; // false on a coarse pointer (touch keyboard), true otherwise and whenever matchMedia is unavailable
  ```

- [ ] **Step 1: Write the failing tests**

`chat-scroll.test.ts`:
1. `isNearBottom` is true when `scrollTop + clientHeight` is within the slack of `scrollHeight`, false when it is far above.
2. It is true for the zero-height element jsdom gives every test (`scrollTop: 0, scrollHeight: 0, clientHeight: 0`) — a list nobody has scrolled counts as at the bottom, which is what keeps the existing "scrolls to the newest message" test meaningful instead of quietly inverting it.
3. `enterSends()` is `false` when `matchMedia('(pointer: coarse)')` matches, `true` when it does not, and `true` when `window.matchMedia` is undefined (delete it for that case and restore it after).

In `ChatPage.test.tsx`:
4. With a coarse pointer, Enter in the box does not send (`sendMock` not called) and the text stays.
5. With a fine pointer, Enter still sends — the existing behaviour, pinned so Task 6 cannot silently take desktop Enter away.
6. When the user has scrolled up and a delta arrives, `scrollTop` does not change. Set the list's `scrollTop`/`scrollHeight`/`clientHeight` so `isNearBottom` is false **and then fire a `scroll` event on the list** (`fireEvent.scroll(list)`) — that event is the only thing that tells the page the reader moved. Without it this test would be asserting the opposite of test 2.
7. Sending a message returns the view to the bottom even from scrolled-up (`scrollTop` becomes `scrollHeight`).

- [ ] **Step 2: Run them and watch them fail**

`npm test -w @termhub/web -- chat-scroll ChatPage`.

- [ ] **Step 3: Implement**

`chat-scroll.ts`: two small pure functions, `enterSends` guarding `typeof window.matchMedia === 'function'`. `ChatComposer`: the textarea and send button lifted out of `ChatPage` unchanged in behaviour — same `placeholder` ("Pergunte ou peça algo às suas máquinas", asserted by existing tests), same button label, same disabled rules — plus a height that grows with the content up to a cap and then scrolls, and `Enter` obeying `enterSends()` (Shift+Enter always a newline). `ChatPage`: keep a `stick` ref initialised to `true` and updated **only** from the list's `onScroll` handler via `isNearBottom`; the existing "pin to the bottom" effect reads it and does nothing while it is false; `send` sets it true before the request. Do not recompute `isNearBottom` inside the effect from the element's live geometry: jsdom lays nothing out, so a never-scrolled list would read as "far from the bottom" and the page would stop following new messages in every test and in any browser the moment content is shorter than the viewport. Composer pinned to the bottom of the column with `pb-[env(safe-area-inset-bottom)]` so the iPhone home bar does not sit on the button.

- [ ] **Step 4: Green**

`npm test -w @termhub/web`, `npm run typecheck --workspaces --if-present`, and `npm run build -w @termhub/web` (Tailwind's arbitrary-value classes are only checked at build time).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/chat-scroll.ts apps/web/src/lib/chat-scroll.test.ts apps/web/src/components/chat/ChatComposer.tsx apps/web/src/pages/ChatPage.tsx apps/web/src/pages/ChatPage.test.tsx apps/web/src/index.css
git commit -m "Chat: a composer that works with a thumb, and a view that stops fighting the reader"
```
