# Project chat docked in the project window — design

Card: **TER-202** (story, epic TER-1 Chat). Requested 2026-09-26. Web only: the mobile app already
works per conversation. The layout has to line up with TER-98
(`docs/superpowers/specs/2026-09-26-chat-redesign-attachments-design.md`), which is already on `main`.

The person asked for the spec and plan to be decided without questions. Every choice below is a
recommendation, with the reason next to it (§9 lists them in one place).

## 1. Goals

1. The project chat is part of the project window, next to the terminals, not an overlay above the
   whole app.
2. Each project has its own chat. Switching projects shows that project's chat, or none if it is
   closed there.
3. Open/closed, width and "tela cheia" are remembered per project. Leaving termhub with the chat open
   and coming back shows it open; engenharia inversa, where it was closed, shows only the terminals.
4. Switching projects does not drop the conversation or the answer being streamed for the chat left
   behind. Confirmations and questions of another project keep arriving and show as a dot.
5. The phone keeps a full-screen chat, and the account chat at `/chat` stays as it is.

Non-goals:
- Server-side storage of the preference (see §9, D3).
- Any change to `ChatPanel`'s inside: thread, cards, composer, attachments (TER-98 and the cards in
  progress own those).
- The mobile app.
- A chat on pages that are not a project (home, Máquinas, Configurações, Escritório).
- Keeping the terminals of a project mounted after leaving it (they are keyed by project today, and
  that does not change).

## 2. What the code does today (read 2026-09-26, `origin/main` d3fb69c)

- `components/chat/ChatDrawer.tsx` is mounted once in `Layout`, outside the routes. It is
  `position: fixed`, 420 px wide on the right, `z-40`, **over** `main`, so no terminal ever re-fits
  (spec 2026-09-23 §5.2). On a phone it is full screen, with `trackAppHeight()` and the
  `chat-locked` body class.
- `lib/project-chat.tsx` (`ProjectChatProvider`) holds a single `openProjectId`. `toggle(id)` opens
  that project's chat, swaps to it from another one, or closes it. It also runs
  `ProjectChatStatusFeed` (`GET /api/chat/projects` + `/ws/chat`), which gives each project a
  `{busy, pending}` status.
- The drawer renders `<ChatPanel key={openProjectId} projectId={openProjectId} />`. Switching project
  **remounts** the panel. It re-reads the conversation over REST, but the deltas of an answer already
  being written exist nowhere else, so the partial text disappears until the final `message` event.
  The composer's draft and the scroll position are lost too.
- The drawer is opened only from the sidebar (`ProjectRow`'s 💬, which shows a dot when the chat is
  busy or has something pending). It is not tied to the page on screen: the termhub chat stays on
  screen over engenharia inversa's terminals. That is the bug the card describes.
- Escape closes the drawer (`useEscapeLayer`).
- `ProjectPage` renders `PageHeader` and a body with the section (`TerminalsView` stays mounted
  across sections of the same project). `CardPage` (`/project/:ref`) renders `ProjectPage` too.
- `Terminal.tsx` re-fits on every size change of its element (ResizeObserver + rAF), and each
  re-fit sends a `resize` to the PTY. `TerminalsView` ignores 0×0 readings, so `display: none` is
  safe for it.
- Each `ChatPanel` opens its own `/ws/chat` socket (`useChatStream`), and so does the status feed.

## 3. Approaches considered

**A. Dock in `Layout`, next to `main`, fed by the page's current project (chosen).** `Layout`'s row
becomes `[sidebar | main | chat dock]`. `ProjectPage` tells the provider which project is on screen.
The dock shows that project's chat when it is open there. The panels of the few projects visited
last stay mounted, hidden, so their state survives a switch.
- Pros: `ChatPanel` stays keyed siblings under one parent, so nothing is remounted or reparented.
  The dock is outside the routes, so a switch between two projects (same route element, or `CardPage`
  → `ProjectPage`) never touches it. No change to `ProjectPage`'s body.
- Cons: the dock is beside the page, header included. The page header gets shorter; the chat has its
  own 44 px header on the same line. That reads as one split window.

**B. Dock inside `ProjectPage`'s body, beside the section.** Closer to "junto dos terminais", but the
panel would live inside the route. Leaving the project (Configurações, Máquinas) would unmount it,
and keeping state across projects would need portals that move DOM nodes between parents (scroll
lost, ResizeObservers firing at 0×0, hard to test).

**C. Keep the overlay and bind it to the page.** The smallest change: the drawer follows the current
project and is remembered per project. It does not do what the card asks ("não um overlay global"):
the chat would still cover the terminals instead of sitting beside them.

A is the recommendation: it meets every point of the card with the least moving parts.

## 4. Design

### 4.1 Preferences (`lib/project-chat-prefs.ts`, new)

- One `localStorage` key, `termhub:project-chat`, holding
  `{ [projectId]: { open: boolean; width: number; maximized: boolean } }`.
- `loadChatPrefs(storage?)` parses and sanitizes: unknown shapes are dropped; `width` is clamped to
  `[CHAT_MIN_WIDTH, CHAT_MAX_WIDTH]` = `[320, 720]`, and a missing width becomes
  `CHAT_DEFAULT_WIDTH` = 420 (today's drawer). `saveChatPrefs(prefs, storage?)` writes, and swallows
  a full or blocked storage (the preference then lives in memory only, like `saveLayout`).
- `prefOf(prefs, id)` returns the stored entry, or `{ open: false, width: 420, maximized: false }`.
- Pure functions with an injectable `Storage`, like `lib/layout.ts`, so they are tested without the DOM.

### 4.2 The keep-alive pool (`lib/chat-pool.ts`, new)

- `touchAlive(alive, id, max)` puts `id` first and keeps at most `max` ids (most recent first).
- `dropAlive(alive, id)` removes one.
- `MAX_ALIVE_CHATS = 3`: the current project's chat plus the two left behind last. Each mounted panel
  holds a socket and folds deltas; three bounds that cost. A fourth project pushes the oldest out. If
  the person goes back to that one, it re-reads over REST, as the drawer does today.

### 4.3 Provider (`lib/project-chat.tsx`, changed)

The context value becomes:

```ts
interface ProjectChatValue {
  /** The project whose window is on screen (ProjectPage / CardPage), or null on any other page. */
  currentProjectId: string | null;
  setCurrentProject(id: string | null): void;
  /** That project's stored preference (open, width, maximized). */
  pref(id: string): ChatPref;
  /** Opens or closes that project's chat and remembers it. */
  setOpen(id: string, open: boolean): void;
  toggle(id: string): void;
  setWidth(id: string, width: number): void;
  setMaximized(id: string, maximized: boolean): void;
  /** Panels kept mounted, most recent first (§4.2). */
  alive: string[];
  status(id: string): { busy: boolean; pending: number };
}
```

- `prefs` state starts from `loadChatPrefs()` and is saved on every change.
- An effect keeps `alive` current. When `currentProjectId` is set and its chat is open, that id is
  touched. When a chat is closed, its id is dropped: closing unmounts the panel, which stops nothing
  on the server (same rule as today).
- `openProjectId` goes away. Its readers (`Sidebar`, `ChatDrawer`) are rewritten in this card.
- The status feed is unchanged.

### 4.4 The page says which project is on screen

`ProjectPage` calls `useChatScope(project?.id ?? null)`: an effect that calls
`setCurrentProject(id)` and, in its cleanup, sets it back to null only if it is still that id. This
covers `/projects/:id/*` and `/project/:ref` (`CardPage` renders `ProjectPage`). Every other page leaves
it null, so no chat is shown there.

### 4.5 `ChatDock` (`components/chat/ChatDock.tsx`, new; replaces `ChatDrawer`)

Rendered in `Layout`, as the flex row's last child after `main`, only when `can('chat')`.

- `shown` = `currentProjectId` when its pref is open, else null.
- It renders every id in `alive` as a keyed wrapper around `<ChatPanel projectId={id} />`. Same parent,
  same keys, so switching which one is shown changes only CSS classes and never remounts a panel.
  - **Shown, desktop:** an `aside` flex item with `width: <pref.width>px`, `max-width: 60%`,
    `shrink-0`, a left border, `bg-bg`.
  - **Shown, maximized (desktop):** the same `aside`, `flex-1`, no width. `Layout` hides `main` with
    `hidden` (`display: none`). The terminals stay mounted and `TerminalsView` already ignores 0×0.
  - **Shown, narrow window (< 768 px, `md`):** `fixed inset-x-0 top-0 z-40
    h-[var(--app-height,100svh)]`, full screen as today, with `trackAppHeight()` and the
    `chat-locked` class while shown. No resizer and no maximize button there.
  - **Hidden (alive but not shown):** `fixed top-0 -left-[200vw] h-full` with its last width, plus
    `inert` and `aria-hidden`. Off screen but laid out, so the thread keeps its scroll position and
    its ResizeObserver never reads 0×0. It still gets events and folds deltas, so the answer is there,
    complete, on return.
- **Header (44 px, `h-11`, `border-b`, matching `PageHeader` and TER-98's panel):**
  `Chat · <project name>`, then ⤢/⤡ ("Tela cheia" / "Sair da tela cheia", desktop only), then ✕
  ("Fechar chat"). ✕ calls `setOpen(id, false)`.
- The composer's draft, attachment chips, scroll position and streamed text live inside the panel,
  so they survive a switch as long as the panel stays in `alive`.
- **Escape no longer closes the chat.** The dock sits next to terminals where Escape belongs to the
  program running (vim, Claude Code). A confirm dialog opened from the panel still closes on Escape
  through `Modal`.
- The landmark is `aside` with `aria-label="Chat · <name>"`; the hidden wrappers are `inert`, so
  neither focus nor screen readers reach them.

### 4.6 Resizer (`components/chat/ChatResizer.tsx`, new)

- A 6 px `role="separator"` on the shown aside's left edge (desktop, not maximized), with
  `aria-orientation="vertical"`, `aria-valuenow/min/max` and `aria-label="Largura do chat"`.
- **Drag:** pointer capture. While dragging, a full-screen transparent overlay (so xterm does not take
  the pointer) and a 2 px accent line follow the pointer. The width is **committed once, on
  release**: `clamp(asideRight − x, 320, 720)`. The terminals re-fit once, not once per frame, so the
  PTY gets a single `resize` and a TUI such as Claude Code redraws once.
- **Keyboard:** ←/→ change the width by 16 px, committed at once. Home/End go to max/min.
- **Double click:** back to 420.
- The width math is a pure function (`widthFromPointer`, `nudgeWidth`) tested on its own.

### 4.7 Opening the chat

- **Page header:** `ProjectPage` gets a 💬 button in `PageHeader`'s actions (only with
  `can('chat')`). It has `aria-pressed` and the same dot as the sidebar (busy = pulsing accent,
  pending = attention). It calls `toggle(project.id)`.
- **Sidebar 💬:** if the project is not on screen, it navigates to `/projects/<id>` and opens the chat
  (`setOpen(id, true)`). If it is on screen, it toggles. The row's `open` reads `pref(id).open`. So
  the icon stays pinned for every project whose chat is open, which is how the person sees where they
  left chats open.
- **Other projects' activity:** unchanged. The sidebar dot comes from the status feed, whatever the
  pool holds. The page-header button shows the current project's dot.

### 4.8 Alignment with TER-98

- `ChatPanel`, `ChatThread`, `ChatComposer` and the cards are used as they are. This card changes no
  props and no internals, so the tabs working on TER-197, TER-203, TER-111 and TER-64 do not
  conflict with it.
- The composer layout (📎 on the left, status and the round button on the right) must fit the
  320 px minimum width. That is checked in the plan's manual pass.
- `ChatThread`'s ResizeObserver re-pins a thread stuck at the bottom when the width changes, so
  opening, resizing and maximizing keep the last message in view.
- The dock's header uses the same height and border as `PageHeader`, so the page and the chat read as
  one window split in two.

## 5. Data flow

```
ProjectPage ──useChatScope(id)──▶ ProjectChatProvider ──(currentProjectId, prefs, alive)──▶ ChatDock
   │ 💬 toggle(id)                     ▲  │ saveChatPrefs → localStorage
Sidebar 💬 ──navigate + setOpen────────┘  └─ status feed (/ws/chat) → dots
ChatDock ──ChatResizer commit──▶ setWidth(id)   ✕ → setOpen(id,false)   ⤢ → setMaximized
```

## 6. Error handling and edge cases

| Case | Result |
|---|---|
| `localStorage` blocked, full or corrupt | Defaults (closed, 420, not maximized); changes live in memory for the session. |
| Stored width outside 320–720 or not a number | Clamped, or 420. |
| Window narrower than width + main | `max-width: 60%` on the aside; `main` has `min-w-0`. |
| Project deleted or no longer in scope | `ProjectPage` shows "Projeto não encontrado" and no scope is set, so no dock. A stale pref entry is harmless. |
| A panel's `GET /api/chat` fails | As today: the panel's own error line. |
| Fourth project opened with a chat | The oldest hidden panel unmounts. Back there, it re-reads; an answer still streaming shows when it settles (today's behaviour). |
| User without `chat` | No dock, no header button, no sidebar 💬 (as today). |

## 7. Testing

- **Unit (vitest):** `project-chat-prefs` (load, sanitize, clamp, save failure), `chat-pool` (touch,
  cap, drop), resizer math.
- **Provider (testing-library):** open/close/toggle persist per project; `alive` follows current +
  open and drops on close; current project set and cleared by `useChatScope`.
- **`ChatDock`:** shows the current project's panel only when open; nothing on a non-project page;
  switching project keeps the first panel mounted (a mock panel with a mount counter proves no
  remount) and hides it (`inert`); ✕ closes and unmounts; maximize hides `main`; narrow window is full
  screen and sets `chat-locked`; Escape does not close.
- **`ChatResizer`:** keyboard changes and commits; the drag commits once on release, not on move.
- **`ProjectPage`:** header 💬 toggles, has `aria-pressed`, shows the dot.
- **`Sidebar`/`ProjectRow`:** 💬 on another project navigates and opens; on the current one toggles.
- **Manual (browser, desktop and phone width):** a streamed answer survives a switch to another
  project and back; terminal re-fits once on open/close/resize; the composer fits 320 px; Claude
  Code in a pane redraws cleanly after a resize.
- **Verification:** `npm test -w @termhub/web` and the Docker typecheck/build from `CLAUDE.md`.

## 8. Risks

1. **PTY resize on open, close and resize.** The old drawer avoided it on purpose. Now it is the
   point of the card. Mitigated by committing the width on release, so each action is one resize. A
   TUI redraw per action is expected.
2. **Floating terminal window clamped.** `TerminalsView` re-sanitizes its layout when the area
   shrinks and saves it. A floating window near the right edge moves left when the chat opens and
   does not move back when it closes. Accepted; noted for a follow-up if it bothers.
3. **Sockets and CPU.** Up to four `/ws/chat` sockets (status feed plus three panels), and hidden
   panels folding deltas. Bounded by `MAX_ALIVE_CHATS`. Sharing one socket is a separate refactor.
4. **`inert` and off-screen layout.** React 19 supports `inert`. An off-screen panel still lays out
   when it receives events. That is cheap at three panels.
5. **Parallel work.** Other tabs touch the chat components (TER-197, TER-203, TER-111, TER-64). This
   card changes `Layout`, `Sidebar`/`ProjectRow`, `ProjectPage` and `lib/project-chat.tsx`, and only
   wraps `ChatPanel`. Conflicts are most likely in `Sidebar.tsx` and `ProjectRow.tsx`. Rebase before
   the PR.
6. **Behaviour change: Escape.** People used to closing the drawer with Escape now use ✕ or 💬.
   Deliberate (§4.5).
7. **Preference per browser.** Another computer does not see the same open/closed state (D3).

## 9. Decisions (made without asking, per the request)

- **D1. Dock in `Layout`, beside `main` (approach A).** It meets every point of the card without
  reparenting DOM, and the chat survives navigation between projects and to other pages.
- **D2. Keep-alive pool of 3 panels.** "Trocar de projeto não derruba o streaming" cannot be met by a
  remount: the deltas already streamed exist only in the client. Keeping panels mounted fixes that,
  keeps the draft and the scroll too, and needs no server change. Three bounds the cost.
- **D3. `localStorage`, not the server.** The card allows either. A layout preference is per screen,
  like the pane layout (`termhub:layout:<id>`) and the sidebar, which are already in `localStorage`.
  It needs no migration and no API. It can move to the server later without changing the UI.
- **D4. Width committed on release, 320–720 px, default 420.** One PTY resize per action. 420 is
  today's drawer, 320 is the smallest width at which TER-98's composer fits.
- **D5. "Tela cheia" = maximize within the app on desktop, full screen on the phone.** The card asks
  to keep the full-screen mode. On a phone the chat is full screen as today. On desktop, ⤢ fills the
  project window (the sidebar stays). `/chat` is unchanged.
- **D6. No chat outside a project window.** The chat belongs to the project (the card's point). The
  sidebar 💬 takes the person to the project.
- **D7. Escape does not close the docked chat.** It belongs to the terminals next to it.
- **D8. `ChatPanel` untouched.** It keeps this card independent of TER-98's follow-ups and the other
  chat cards in progress.
