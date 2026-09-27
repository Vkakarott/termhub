# Project Chat Dock Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the web project chat from a global overlay into the project window (a dock beside the page), with open/closed, width and "tela cheia" remembered per project, and the chats left behind kept alive across project switches.

**Architecture:** `ProjectPage` publishes the project on screen to `ProjectChatProvider`. The provider keeps per-project preferences in `localStorage` and a small keep-alive list of mounted panels. `ChatDock`, rendered in `Layout` after `main`, shows the current project's `ChatPanel` as a resizable flex column. The other alive panels stay mounted off screen (`inert`), so switching never remounts them.

**Tech Stack:** React 19, react-router 6, Tailwind, vitest + @testing-library/react (jsdom 25).

**Spec:** `docs/superpowers/specs/2026-09-26-project-chat-dock-design.md`

## Global Constraints

- Web only (`@termhub/web`). No server, mobile or migration change.
- UI copy in pt-BR; code, comments, commits in English (`CLAUDE.md`).
- `ChatPanel` and everything under it (`ChatThread`, `ChatComposer`, cards) are not modified.
- Storage key `termhub:project-chat`; width min 320, max 720, default 420; keyboard step 16 px.
- `MAX_ALIVE_CHATS = 3`.
- Narrow window = `(max-width: 767px)` (Tailwind `md`), same query `Layout` uses today.
- Every `localStorage` access is wrapped in try/catch.
- Escape never closes the docked chat.
- Commands: tests `npm test -w @termhub/web -- <path>`; final verification through Docker (`CLAUDE.md`), since the host has no Node:
  `docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/w" -w /w node:20 sh -c 'npm ci && npm test -w @termhub/web -- <path>'`.
  Inside a dev container that already has `node_modules`, drop `npm ci`.

## Review Focus

1. **Switching projects mid-answer** — the panel left behind must not remount. Pinned by the mount-counter test in Task 5 and the manual check in Task 9.
2. **Corrupt or foreign `localStorage` value** (`"null"`, an array, `width: "abc"`, `width: 99999`) — defaults and clamping, never a crash. Task 1.
3. **Rendering order of alive panels** — a keyed reorder moves DOM nodes and can reset scroll. Panels render in a stable (sorted) order. Task 5 test.
4. **Drag over a terminal** — xterm must not steal the pointer, and the width commits once on release (one PTY resize). Task 4 test (`onCommit` called once, overlay present while dragging).
5. **Leaving a project page** (to Máquinas, Configurações) — no dock is shown and nothing stays "current". Task 3 (`useChatScope` cleanup) and Task 5 test.

---

## File map

| File | Status | Responsibility |
|---|---|---|
| `apps/web/src/lib/project-chat-prefs.ts` | create | Per-project `{open,width,maximized}`: load/sanitize/save, width clamp |
| `apps/web/src/lib/chat-pool.ts` | create | Keep-alive list: `touchAlive`, `dropAlive`, `MAX_ALIVE_CHATS` |
| `apps/web/src/lib/narrow-window.ts` | create | `useNarrowWindow()` moved out of `Layout.tsx` (shared by `Layout` and `ChatDock`) |
| `apps/web/src/lib/project-chat.tsx` | modify | Provider: current project, prefs, alive, status feed; `useChatScope` |
| `apps/web/src/components/chat/ChatResizer.tsx` | create | Separator: drag (commit on release), keyboard, double click |
| `apps/web/src/components/chat/ChatDock.tsx` | create | The dock: shown / maximized / narrow / hidden panels |
| `apps/web/src/components/chat/ChatToggleButton.tsx` | create | Page-header 💬 with `aria-pressed` and status dot |
| `apps/web/src/components/Layout.tsx` | modify | Render `ChatDock` after `main`; hide `main` when maximized |
| `apps/web/src/pages/ProjectPage.tsx` | modify | `useChatScope(project.id)`; header 💬 |
| `apps/web/src/components/Sidebar.tsx` | modify | 💬 navigates + opens, or toggles on the current project |
| `apps/web/src/components/chat/ChatDrawer.tsx` + test | delete | Replaced by `ChatDock` |

---

### Task 1: Per-project chat preferences

**Files:**
- Create: `apps/web/src/lib/project-chat-prefs.ts`
- Test: `apps/web/src/lib/project-chat-prefs.test.ts`

**Interfaces:**
- Produces:
  - `interface ChatPref { open: boolean; width: number; maximized: boolean }`
  - `type ChatPrefs = Record<string, ChatPref>`
  - `CHAT_PREFS_KEY = 'termhub:project-chat'`, `CHAT_MIN_WIDTH = 320`, `CHAT_MAX_WIDTH = 720`, `CHAT_DEFAULT_WIDTH = 420`
  - `DEFAULT_CHAT_PREF: ChatPref`
  - `clampChatWidth(w: unknown): number`
  - `loadChatPrefs(storage?: Storage): ChatPrefs`
  - `saveChatPrefs(prefs: ChatPrefs, storage?: Storage): void`
  - `prefOf(prefs: ChatPrefs, id: string): ChatPref`
  - `withPref(prefs: ChatPrefs, id: string, patch: Partial<ChatPref>): ChatPrefs`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { CHAT_DEFAULT_WIDTH, CHAT_PREFS_KEY, clampChatWidth, DEFAULT_CHAT_PREF, loadChatPrefs, prefOf, saveChatPrefs, withPref } from './project-chat-prefs';

/** A Storage stand-in: a Map, and a switch that makes every call throw (blocked or full storage). */
function memoryStorage(initial: Record<string, string> = {}, broken = false): Storage {
  const m = new Map(Object.entries(initial));
  const guard = () => {
    if (broken) throw new Error('blocked');
  };
  return {
    get length() { return m.size; },
    clear: () => m.clear(),
    key: (i) => [...m.keys()][i] ?? null,
    getItem: (k) => (guard(), m.get(k) ?? null),
    setItem: (k, v) => (guard(), void m.set(k, v)),
    removeItem: (k) => void m.delete(k),
  };
}

describe('clampChatWidth', () => {
  it('keeps a width inside 320–720, clamps outside, and defaults a non-number to 420', () => {
    expect(clampChatWidth(500)).toBe(500);
    expect(clampChatWidth(100)).toBe(320);
    expect(clampChatWidth(99999)).toBe(720);
    expect(clampChatWidth(450.7)).toBe(450);
    expect(clampChatWidth('abc')).toBe(CHAT_DEFAULT_WIDTH);
    expect(clampChatWidth(Number.NaN)).toBe(CHAT_DEFAULT_WIDTH);
    expect(clampChatWidth(undefined)).toBe(CHAT_DEFAULT_WIDTH);
  });
});

describe('loadChatPrefs', () => {
  it('reads and sanitizes each entry', () => {
    const s = memoryStorage({
      [CHAT_PREFS_KEY]: JSON.stringify({
        p1: { open: true, width: 500, maximized: false },
        p2: { open: 'yes', width: 5, maximized: 1 },
        p3: 'garbage',
      }),
    });
    expect(loadChatPrefs(s)).toEqual({
      p1: { open: true, width: 500, maximized: false },
      p2: { open: false, width: 320, maximized: false },
    });
  });

  it.each(['null', '[]', '"x"', '{not json', '42'])('falls back to no entries for %s', (raw) => {
    expect(loadChatPrefs(memoryStorage({ [CHAT_PREFS_KEY]: raw }))).toEqual({});
  });

  it('falls back to no entries when storage throws', () => {
    expect(loadChatPrefs(memoryStorage({}, true))).toEqual({});
  });
});

describe('saveChatPrefs', () => {
  it('writes JSON under the key', () => {
    const s = memoryStorage();
    saveChatPrefs({ p1: { open: true, width: 400, maximized: true } }, s);
    expect(JSON.parse(s.getItem(CHAT_PREFS_KEY)!)).toEqual({ p1: { open: true, width: 400, maximized: true } });
  });

  it('swallows a blocked storage', () => {
    expect(() => saveChatPrefs({}, memoryStorage({}, true))).not.toThrow();
  });
});

describe('prefOf / withPref', () => {
  it('defaults an unknown project to closed, 420, not maximized', () => {
    expect(prefOf({}, 'p9')).toEqual(DEFAULT_CHAT_PREF);
    expect(DEFAULT_CHAT_PREF).toEqual({ open: false, width: 420, maximized: false });
  });

  it('patches one project without touching others, clamping the width', () => {
    const before = { p1: { open: true, width: 500, maximized: false } };
    const after = withPref(before, 'p2', { open: true, width: 10 });
    expect(after).toEqual({ p1: before.p1, p2: { open: true, width: 320, maximized: false } });
    expect(before).toEqual({ p1: { open: true, width: 500, maximized: false } });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @termhub/web -- src/lib/project-chat-prefs.test.ts`
Expected: FAIL, cannot resolve `./project-chat-prefs`.

- [ ] **Step 3: Write the implementation**

```ts
/**
 * What the project chat dock remembers per project (spec 2026-09-26 project chat dock §4.1): whether
 * it is open, how wide it is and whether it fills the project window. One `localStorage` key for all
 * projects, like the pane layout (`lib/layout.ts`), since it is a per-screen preference.
 */
export interface ChatPref {
  open: boolean;
  width: number;
  maximized: boolean;
}
export type ChatPrefs = Record<string, ChatPref>;

export const CHAT_PREFS_KEY = 'termhub:project-chat';
/** The smallest width at which the chat composer (TER-98) still fits its buttons. */
export const CHAT_MIN_WIDTH = 320;
export const CHAT_MAX_WIDTH = 720;
/** The old drawer's width. */
export const CHAT_DEFAULT_WIDTH = 420;
export const DEFAULT_CHAT_PREF: ChatPref = { open: false, width: CHAT_DEFAULT_WIDTH, maximized: false };

export function clampChatWidth(w: unknown): number {
  if (typeof w !== 'number' || !Number.isFinite(w)) return CHAT_DEFAULT_WIDTH;
  return Math.min(CHAT_MAX_WIDTH, Math.max(CHAT_MIN_WIDTH, Math.floor(w)));
}

function sanitizePref(raw: unknown): ChatPref | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  return { open: r.open === true, width: clampChatWidth(r.width), maximized: r.maximized === true };
}

export function loadChatPrefs(storage: Storage = localStorage): ChatPrefs {
  let raw: unknown;
  try {
    const text = storage.getItem(CHAT_PREFS_KEY);
    raw = text ? JSON.parse(text) : undefined;
  } catch {
    return {};
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: ChatPrefs = {};
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    const pref = sanitizePref(value);
    if (pref) out[id] = pref;
  }
  return out;
}

export function saveChatPrefs(prefs: ChatPrefs, storage: Storage = localStorage): void {
  try {
    storage.setItem(CHAT_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* storage full or blocked: the preference lives in memory for this session */
  }
}

export const prefOf = (prefs: ChatPrefs, id: string): ChatPref => prefs[id] ?? DEFAULT_CHAT_PREF;

export function withPref(prefs: ChatPrefs, id: string, patch: Partial<ChatPref>): ChatPrefs {
  const next = { ...prefOf(prefs, id), ...patch };
  return { ...prefs, [id]: { ...next, width: clampChatWidth(next.width) } };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w @termhub/web -- src/lib/project-chat-prefs.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/project-chat-prefs.ts apps/web/src/lib/project-chat-prefs.test.ts
git commit -m "Project chat: remember open, width and maximized per project"
```

---

### Task 2: Keep-alive list of mounted chats

**Files:**
- Create: `apps/web/src/lib/chat-pool.ts`
- Test: `apps/web/src/lib/chat-pool.test.ts`

**Interfaces:**
- Produces: `MAX_ALIVE_CHATS = 3`; `touchAlive(alive: string[], id: string, max?: number): string[]`; `dropAlive(alive: string[], id: string): string[]`. Both return the same array when nothing changes (so React state does not re-render).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { dropAlive, MAX_ALIVE_CHATS, touchAlive } from './chat-pool';

describe('touchAlive', () => {
  it('puts the id first and keeps at most max ids', () => {
    expect(MAX_ALIVE_CHATS).toBe(3);
    let a: string[] = [];
    a = touchAlive(a, 'p1');
    a = touchAlive(a, 'p2');
    a = touchAlive(a, 'p3');
    expect(a).toEqual(['p3', 'p2', 'p1']);
    a = touchAlive(a, 'p4');
    expect(a).toEqual(['p4', 'p3', 'p2']);
    a = touchAlive(a, 'p2');
    expect(a).toEqual(['p2', 'p4', 'p3']);
  });

  it('returns the same array when the id is already first', () => {
    const a = ['p1', 'p2'];
    expect(touchAlive(a, 'p1')).toBe(a);
  });
});

describe('dropAlive', () => {
  it('removes the id, and returns the same array when it is not there', () => {
    const a = ['p1', 'p2'];
    expect(dropAlive(a, 'p1')).toEqual(['p2']);
    expect(dropAlive(a, 'p9')).toBe(a);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @termhub/web -- src/lib/chat-pool.test.ts`
Expected: FAIL, cannot resolve `./chat-pool`.

- [ ] **Step 3: Write the implementation**

```ts
/**
 * The project chats kept mounted (spec 2026-09-26 project chat dock §4.2), most recent first: the one
 * on screen and the ones left behind last. A mounted panel keeps its socket, its streamed text, its
 * draft and its scroll, so going back shows an answer that kept streaming. Three bounds the cost.
 */
export const MAX_ALIVE_CHATS = 3;

export function touchAlive(alive: string[], id: string, max = MAX_ALIVE_CHATS): string[] {
  if (alive[0] === id) return alive;
  return [id, ...alive.filter((x) => x !== id)].slice(0, max);
}

export function dropAlive(alive: string[], id: string): string[] {
  return alive.includes(id) ? alive.filter((x) => x !== id) : alive;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w @termhub/web -- src/lib/chat-pool.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/chat-pool.ts apps/web/src/lib/chat-pool.test.ts
git commit -m "Project chat: keep the last three chats mounted"
```

---

### Task 3: Provider — current project, preferences and alive panels

**Files:**
- Modify: `apps/web/src/lib/project-chat.tsx` (the whole `ProjectChatValue`, the default context and `ProjectChatProvider`; `ProjectChatStatusFeed` unchanged)
- Test: `apps/web/src/lib/project-chat.test.tsx` (replace the `Probe` and the "toggle opens, swaps and closes" and "works without a provider" tests; keep the status-feed tests)

**Interfaces:**
- Consumes: Task 1 (`ChatPref`, `DEFAULT_CHAT_PREF`, `loadChatPrefs`, `saveChatPrefs`, `prefOf`, `withPref`), Task 2 (`touchAlive`, `dropAlive`).
- Produces:

```ts
interface ProjectChatValue {
  currentProjectId: string | null;
  /** currentProjectId when its chat is open there, else null. */
  shownProjectId: string | null;
  setCurrentProject(id: string): void;
  /** Clears the current project only if it is still `id` (a page's cleanup). */
  releaseCurrentProject(id: string): void;
  pref(id: string): ChatPref;
  setOpen(id: string, open: boolean): void;
  toggle(id: string): void;
  setWidth(id: string, width: number): void;
  setMaximized(id: string, maximized: boolean): void;
  /** Mounted panels, most recent first; only projects whose chat is open. */
  alive: string[];
  status(id: string): { busy: boolean; pending: number };
}
export function useProjectChat(): ProjectChatValue;
export function useChatScope(projectId: string | null): void;
```

- [ ] **Step 1: Write the failing tests**

Replace `Probe`, the "toggle opens, swaps and closes" test and the "works without a provider" test in `project-chat.test.tsx` with the following. Add `localStorage.clear()` to `afterEach`. Import `useChatScope` next to `ProjectChatProvider, useProjectChat`.

```tsx
function Probe() {
  const c = useProjectChat();
  return (
    <>
      <span data-testid="current">{c.currentProjectId ?? 'none'}</span>
      <span data-testid="shown">{c.shownProjectId ?? 'none'}</span>
      <span data-testid="alive">{c.alive.join(',')}</span>
      <span data-testid="pref-p1">{JSON.stringify(c.pref('p1'))}</span>
      <span data-testid="p1">{JSON.stringify(c.status('p1'))}</span>
      <button onClick={() => c.toggle('p1')}>toggle p1</button>
      <button onClick={() => c.setOpen('p2', true)}>open p2</button>
      <button onClick={() => c.setWidth('p1', 999)}>wide p1</button>
      <button onClick={() => c.setMaximized('p1', true)}>max p1</button>
    </>
  );
}

/** A page that says which project is on screen, like ProjectPage. */
function Page({ id }: { id: string | null }) {
  useChatScope(id);
  return null;
}

const text = (id: string) => screen.getByTestId(id).textContent;
const click = (name: string) => act(() => screen.getByRole('button', { name }).click());

it('toggle opens and closes a project chat and remembers it in localStorage', () => {
  projectsMock.mockResolvedValue({ projects: [] });
  render(<ProjectChatProvider><Probe /></ProjectChatProvider>);
  click('toggle p1');
  expect(text('pref-p1')).toBe('{"open":true,"width":420,"maximized":false}');
  expect(JSON.parse(localStorage.getItem('termhub:project-chat')!).p1.open).toBe(true);
  click('toggle p1');
  expect(JSON.parse(localStorage.getItem('termhub:project-chat')!).p1.open).toBe(false);
});

it('starts from what localStorage remembers', () => {
  projectsMock.mockResolvedValue({ projects: [] });
  localStorage.setItem('termhub:project-chat', JSON.stringify({ p1: { open: true, width: 500, maximized: true } }));
  render(<ProjectChatProvider><Probe /></ProjectChatProvider>);
  expect(text('pref-p1')).toBe('{"open":true,"width":500,"maximized":true}');
});

it('clamps the width and stores maximized', () => {
  projectsMock.mockResolvedValue({ projects: [] });
  render(<ProjectChatProvider><Probe /></ProjectChatProvider>);
  click('wide p1');
  click('max p1');
  expect(text('pref-p1')).toBe('{"open":false,"width":720,"maximized":true}');
});

it('shows the chat of the project on screen only when it is open there', () => {
  projectsMock.mockResolvedValue({ projects: [] });
  const { rerender } = render(<ProjectChatProvider><Page id="p1" /><Probe /></ProjectChatProvider>);
  expect(text('current')).toBe('p1');
  expect(text('shown')).toBe('none');
  click('toggle p1');
  expect(text('shown')).toBe('p1');
  expect(text('alive')).toBe('p1');
  // p2's chat is open, but p2 is not on screen: nothing mounts for it yet
  click('open p2');
  expect(text('alive')).toBe('p1');
  rerender(<ProjectChatProvider><Page id="p2" /><Probe /></ProjectChatProvider>);
  expect(text('shown')).toBe('p2');
  // p1 stays mounted behind p2
  expect(text('alive')).toBe('p2,p1');
});

it('closing a chat unmounts it', () => {
  projectsMock.mockResolvedValue({ projects: [] });
  render(<ProjectChatProvider><Page id="p1" /><Probe /></ProjectChatProvider>);
  click('toggle p1');
  expect(text('alive')).toBe('p1');
  click('toggle p1');
  expect(text('alive')).toBe('');
  expect(text('shown')).toBe('none');
});

it('a page that goes away clears the current project; the next page takes over', () => {
  projectsMock.mockResolvedValue({ projects: [] });
  const { rerender } = render(<ProjectChatProvider><Page id="p1" /><Probe /></ProjectChatProvider>);
  rerender(<ProjectChatProvider><Probe /></ProjectChatProvider>);
  expect(text('current')).toBe('none');
  rerender(<ProjectChatProvider><Page id="p2" /><Probe /></ProjectChatProvider>);
  expect(text('current')).toBe('p2');
});

it('works without a provider (a component in isolation): nothing current, closed, no status', () => {
  render(<Probe />);
  expect(text('current')).toBe('none');
  expect(text('shown')).toBe('none');
  expect(text('pref-p1')).toBe('{"open":false,"width":420,"maximized":false}');
  expect(text('p1')).toBe('{"busy":false,"pending":0}');
});
```

The existing status-feed tests use `screen.getByTestId('p1')`, which the new `Probe` still renders, so they stay as they are.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -w @termhub/web -- src/lib/project-chat.test.tsx`
Expected: FAIL (`useChatScope` is not exported; `shownProjectId`/`alive`/`pref` undefined).

- [ ] **Step 3: Rewrite the context and provider**

Replace everything above `const REREAD_ON` in `lib/project-chat.tsx` with:

```tsx
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api } from './api';
import { useAuth } from './auth';
import { useChatStream } from './chat';
import { dropAlive, touchAlive } from './chat-pool';
import { DEFAULT_CHAT_PREF, loadChatPrefs, prefOf, saveChatPrefs, withPref, type ChatPref, type ChatPrefs } from './project-chat-prefs';
import type { ChatEvent, ProjectChatStatus } from './types';

/**
 * The project chat dock's state (spec 2026-09-26 project chat dock §4.3): which project's window is on
 * screen, what each project remembers about its chat, which chats stay mounted, and each project's
 * live status for the dots.
 */
interface ProjectChatValue {
  /** The project whose window is on screen (ProjectPage, CardPage), or null on any other page. */
  currentProjectId: string | null;
  /** `currentProjectId` when its chat is open there, else null: the one the dock shows. */
  shownProjectId: string | null;
  setCurrentProject(id: string): void;
  /** Clears the current project only if it is still `id`, so a page's cleanup never clears the next page's. */
  releaseCurrentProject(id: string): void;
  pref(id: string): ChatPref;
  setOpen(id: string, open: boolean): void;
  toggle(id: string): void;
  setWidth(id: string, width: number): void;
  setMaximized(id: string, maximized: boolean): void;
  /** Panels kept mounted, most recent first. Only projects whose chat is open. */
  alive: string[];
  /** Whether that project's chat is answering, and how many questions wait on the user. */
  status(id: string): { busy: boolean; pending: number };
}

const IDLE = { busy: false, pending: 0 };
/** Without a provider (a component rendered on its own, in a test): no project on screen, every chat closed and idle. */
const ProjectChatContext = createContext<ProjectChatValue>({
  currentProjectId: null,
  shownProjectId: null,
  setCurrentProject: () => {},
  releaseCurrentProject: () => {},
  pref: () => DEFAULT_CHAT_PREF,
  setOpen: () => {},
  toggle: () => {},
  setWidth: () => {},
  setMaximized: () => {},
  alive: [],
  status: () => IDLE,
});

export function ProjectChatProvider({ children }: { children: ReactNode }) {
  const [currentProjectId, setCurrentProjectId] = useState<string | null>(null);
  const [prefs, setPrefs] = useState<ChatPrefs>(() => loadChatPrefs());
  const [alive, setAlive] = useState<string[]>([]);
  const [statuses, setStatuses] = useState<Map<string, ProjectChatStatus>>(new Map());
  const { can } = useAuth();

  useEffect(() => saveChatPrefs(prefs), [prefs]);

  const shownProjectId = currentProjectId !== null && prefOf(prefs, currentProjectId).open ? currentProjectId : null;
  useEffect(() => {
    if (shownProjectId !== null) setAlive((a) => touchAlive(a, shownProjectId));
  }, [shownProjectId]);

  const patch = useCallback((id: string, p: Partial<ChatPref>) => setPrefs((cur) => withPref(cur, id, p)), []);
  // Stable, so `useChatScope`'s effect runs only when the page's project changes.
  const releaseCurrentProject = useCallback((id: string) => setCurrentProjectId((cur) => (cur === id ? null : cur)), []);
  const setOpen = useCallback(
    (id: string, open: boolean) => {
      patch(id, { open });
      // Closing unmounts the panel; it stops nothing on the server (a run finishes and is there on reopening).
      if (!open) setAlive((a) => dropAlive(a, id));
    },
    [patch],
  );

  const value = useMemo<ProjectChatValue>(
    () => ({
      currentProjectId,
      shownProjectId,
      setCurrentProject: setCurrentProjectId,
      releaseCurrentProject,
      pref: (id) => prefOf(prefs, id),
      setOpen,
      toggle: (id) => setOpen(id, !prefOf(prefs, id).open),
      setWidth: (id, width) => patch(id, { width }),
      setMaximized: (id, maximized) => patch(id, { maximized }),
      alive: alive.filter((id) => prefOf(prefs, id).open),
      status: (id) => {
        const s = statuses.get(id);
        return s ? { busy: s.busy, pending: s.pending_confirmations } : IDLE;
      },
    }),
    [currentProjectId, shownProjectId, prefs, alive, statuses, setOpen, patch, releaseCurrentProject],
  );
  return (
    <ProjectChatContext.Provider value={value}>
      {/* keep the existing comment block about the two permissions here, unchanged */}
      {can('chat') && can('terminals', 'read') && <ProjectChatStatusFeed onStatuses={setStatuses} />}
      {children}
    </ProjectChatContext.Provider>
  );
}
```

Keep the existing long comment above `ProjectChatStatusFeed` in the JSX exactly as it is (only the placeholder line above stands for it in this plan). At the end of the file, beside `useProjectChat`, add:

```tsx
/**
 * Says which project's window is on screen, for as long as the calling page is mounted with that id.
 * ProjectPage calls it, and so CardPage too, which renders ProjectPage.
 */
export function useChatScope(projectId: string | null): void {
  const { setCurrentProject, releaseCurrentProject } = useProjectChat();
  useEffect(() => {
    if (projectId === null) return;
    setCurrentProject(projectId);
    return () => releaseCurrentProject(projectId);
  }, [projectId, setCurrentProject, releaseCurrentProject]);
}
```

`setCurrentProjectId` (a state setter) and `releaseCurrentProject` (a `useCallback` with no dependencies) are stable, so the effect runs only when the page's project changes.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w @termhub/web -- src/lib/project-chat.test.tsx`
Expected: PASS (new tests and the untouched status-feed tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/project-chat.tsx apps/web/src/lib/project-chat.test.tsx
git commit -m "Project chat: follow the project on screen and remember each chat"
```

`Sidebar.tsx` and `ChatDrawer.tsx` still read `openProjectId` and will not typecheck until Tasks 6 and 8. Run the web typecheck only at the end of Task 8.

---

### Task 4: Width separator

**Files:**
- Create: `apps/web/src/components/chat/ChatResizer.tsx`
- Test: `apps/web/src/components/chat/ChatResizer.test.tsx`

**Interfaces:**
- Consumes: Task 1 (`CHAT_MIN_WIDTH`, `CHAT_MAX_WIDTH`, `CHAT_DEFAULT_WIDTH`, `clampChatWidth`).
- Produces: `CHAT_WIDTH_STEP = 16`; `widthFromPointer(asideRight: number, x: number): number`; `nudgeWidth(width: number, key: string): number | null`; `ChatResizer({ width, onCommit }: { width: number; onCommit: (w: number) => void })`. The component must be placed inside a `position: relative` parent whose right edge is the aside's right edge (it reads `parentElement.getBoundingClientRect().right`).

- [ ] **Step 1: Write the failing test**

```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatResizer, nudgeWidth, widthFromPointer } from './ChatResizer';

afterEach(cleanup);

describe('width math', () => {
  it('widthFromPointer measures from the aside right edge and clamps', () => {
    expect(widthFromPointer(1000, 500)).toBe(500);
    expect(widthFromPointer(1000, 900)).toBe(320);
    expect(widthFromPointer(1000, 0)).toBe(720);
  });

  it('nudgeWidth: ← widens, → narrows, Home/End go to max/min, other keys do nothing', () => {
    expect(nudgeWidth(420, 'ArrowLeft')).toBe(436);
    expect(nudgeWidth(420, 'ArrowRight')).toBe(404);
    expect(nudgeWidth(330, 'ArrowRight')).toBe(320);
    expect(nudgeWidth(420, 'Home')).toBe(720);
    expect(nudgeWidth(420, 'End')).toBe(320);
    expect(nudgeWidth(420, 'a')).toBeNull();
  });
});

/** jsdom 25 has no PointerEvent: a MouseEvent named like a pointer event carries clientX to React's handler. */
const pointer = (el: Element, type: string, clientX: number) => fireEvent(el, new MouseEvent(type, { bubbles: true, clientX }));

function mount(width = 420) {
  const onCommit = vi.fn();
  const { container } = render(
    <div style={{ position: 'relative' }}>
      <ChatResizer width={width} onCommit={onCommit} />
    </div>,
  );
  (container.firstChild as HTMLElement).getBoundingClientRect = () => ({ right: 1000 }) as DOMRect;
  return { onCommit, sep: screen.getByRole('separator', { name: 'Largura do chat' }) };
}

describe('ChatResizer', () => {
  it('exposes its value to assistive tech', () => {
    const { sep } = mount(500);
    expect(sep.getAttribute('aria-valuenow')).toBe('500');
    expect(sep.getAttribute('aria-valuemin')).toBe('320');
    expect(sep.getAttribute('aria-valuemax')).toBe('720');
    expect(sep.getAttribute('aria-orientation')).toBe('vertical');
  });

  it('commits once, on release, with an overlay over the page while dragging', () => {
    const { sep, onCommit } = mount();
    pointer(sep, 'pointerdown', 580);
    expect(screen.getByTestId('chat-resize-overlay')).toBeTruthy();
    pointer(sep, 'pointermove', 550);
    pointer(sep, 'pointermove', 500);
    expect(onCommit).not.toHaveBeenCalled();
    pointer(sep, 'pointerup', 500);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(500);
    expect(screen.queryByTestId('chat-resize-overlay')).toBeNull();
  });

  it('commits on each arrow key', () => {
    const { sep, onCommit } = mount();
    fireEvent.keyDown(sep, { key: 'ArrowLeft' });
    expect(onCommit).toHaveBeenLastCalledWith(436);
    fireEvent.keyDown(sep, { key: 'x' });
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it('double click goes back to 420', () => {
    const { sep, onCommit } = mount(600);
    fireEvent.doubleClick(sep);
    expect(onCommit).toHaveBeenCalledWith(420);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @termhub/web -- src/components/chat/ChatResizer.test.tsx`
Expected: FAIL, cannot resolve `./ChatResizer`.

- [ ] **Step 3: Write the implementation**

```tsx
import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { CHAT_DEFAULT_WIDTH, CHAT_MAX_WIDTH, CHAT_MIN_WIDTH, clampChatWidth } from '../../lib/project-chat-prefs';

export const CHAT_WIDTH_STEP = 16;

/** The dock is on the right: its width is the distance from the pointer to its right edge. */
export const widthFromPointer = (asideRight: number, x: number): number => clampChatWidth(asideRight - x);

export function nudgeWidth(width: number, key: string): number | null {
  switch (key) {
    case 'ArrowLeft':
      return clampChatWidth(width + CHAT_WIDTH_STEP);
    case 'ArrowRight':
      return clampChatWidth(width - CHAT_WIDTH_STEP);
    case 'Home':
      return CHAT_MAX_WIDTH;
    case 'End':
      return CHAT_MIN_WIDTH;
    default:
      return null;
  }
}

/**
 * The chat dock's left edge (spec 2026-09-26 project chat dock §4.6). A drag shows a line and commits
 * the width once, on release: the terminals beside the chat re-fit once and the PTY gets one resize,
 * instead of one per frame. A transparent overlay covers the page while dragging, so xterm never takes
 * the pointer.
 */
export function ChatResizer({ width, onCommit }: { width: number; onCommit: (w: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const right = useRef(0);
  const [dragX, setDragX] = useState<number | null>(null);

  const start = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    right.current = ref.current?.parentElement?.getBoundingClientRect().right ?? 0;
    try {
      ref.current?.setPointerCapture?.(e.pointerId);
    } catch {
      /* no capture (a synthetic event): the overlay still catches the moves */
    }
    setDragX(e.clientX);
  };
  const move = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (dragX !== null) setDragX(e.clientX);
  };
  const end = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (dragX === null) return;
    setDragX(null);
    onCommit(widthFromPointer(right.current, e.clientX));
  };

  return (
    <>
      <div
        ref={ref}
        role="separator"
        tabIndex={0}
        aria-label="Largura do chat"
        aria-orientation="vertical"
        aria-valuenow={width}
        aria-valuemin={CHAT_MIN_WIDTH}
        aria-valuemax={CHAT_MAX_WIDTH}
        title="Arraste para mudar a largura (duplo clique volta ao padrão)"
        className="absolute inset-y-0 -left-[3px] z-10 w-1.5 cursor-col-resize hover:bg-accent/40 focus-visible:bg-accent/60 focus-visible:outline-none"
        onPointerDown={start}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={() => setDragX(null)}
        onDoubleClick={() => onCommit(CHAT_DEFAULT_WIDTH)}
        onKeyDown={(e) => {
          const next = nudgeWidth(width, e.key);
          if (next === null) return;
          e.preventDefault();
          onCommit(next);
        }}
      />
      {dragX !== null && (
        <div data-testid="chat-resize-overlay" className="fixed inset-0 z-50 cursor-col-resize" onPointerMove={move} onPointerUp={end}>
          <div className="absolute inset-y-0 w-0.5 bg-accent" style={{ left: right.current - widthFromPointer(right.current, dragX) }} />
        </div>
      )}
    </>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w @termhub/web -- src/components/chat/ChatResizer.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/chat/ChatResizer.tsx apps/web/src/components/chat/ChatResizer.test.tsx
git commit -m "Project chat: resizable edge that commits the width on release"
```

---

### Task 5: `ChatDock`

**Files:**
- Create: `apps/web/src/lib/narrow-window.ts` (move `NARROW_QUERY`, `narrowNow` and `useNarrowWindow` out of `components/Layout.tsx`, unchanged, and export `useNarrowWindow`)
- Modify: `apps/web/src/components/Layout.tsx` (delete those three and import `useNarrowWindow` from `../lib/narrow-window`)
- Create: `apps/web/src/components/chat/ChatDock.tsx`
- Test: `apps/web/src/components/chat/ChatDock.test.tsx`

**Interfaces:**
- Consumes: Task 3 (`useProjectChat`: `alive`, `shownProjectId`, `pref`, `setOpen`, `setWidth`, `setMaximized`), Task 4 (`ChatResizer`), `useNarrowWindow()`, `trackAppHeight()` (`lib/viewport`), `useData().projects`.
- Produces: `ChatDock()`, no props. Renders nothing when there is nothing alive and nothing shown.

- [ ] **Step 1: Move `useNarrowWindow`**

Create `apps/web/src/lib/narrow-window.ts` with the three definitions cut from `Layout.tsx` (`NARROW_QUERY`, `narrowNow`, `useNarrowWindow`), adding `import { useEffect, useState } from 'react';` and `export` on `useNarrowWindow`. In `Layout.tsx` add `import { useNarrowWindow } from '../lib/narrow-window';`.

Run: `npm test -w @termhub/web -- src/components/Layout.test.tsx`
Expected: PASS (pure move).

- [ ] **Step 2: Write the failing test**

```tsx
// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ChatPref } from '../../lib/project-chat-prefs';

const mounts = vi.hoisted(() => new Map<string, number>());
vi.mock('./ChatPanel', async () => {
  const { useEffect } = await import('react');
  return {
    ChatPanel: ({ projectId }: { projectId: string }) => {
      useEffect(() => void mounts.set(projectId, (mounts.get(projectId) ?? 0) + 1), [projectId]);
      return <div>painel {projectId}</div>;
    },
  };
});
vi.mock('../../lib/data', () => ({ useData: () => ({ projects: [{ id: 'p1', name: 'termhub' }, { id: 'p2', name: 'engenharia inversa' }, { id: 'p3', name: 'outro' }] }) }));
const narrow = vi.hoisted(() => ({ value: false }));
vi.mock('../../lib/narrow-window', () => ({ useNarrowWindow: () => narrow.value }));
const chat = vi.hoisted(() => ({
  alive: [] as string[],
  shownProjectId: null as string | null,
  prefs: {} as Record<string, ChatPref>,
  setOpen: vi.fn(),
  setWidth: vi.fn(),
  setMaximized: vi.fn(),
}));
vi.mock('../../lib/project-chat', () => ({
  useProjectChat: () => ({ ...chat, pref: (id: string) => chat.prefs[id] ?? { open: false, width: 420, maximized: false } }),
}));

import { ChatDock } from './ChatDock';

const open = (width = 420, maximized = false): ChatPref => ({ open: true, width, maximized });
const renderDock = () => render(<MemoryRouter><ChatDock /></MemoryRouter>);

beforeEach(() => {
  mounts.clear();
  narrow.value = false;
  chat.alive = [];
  chat.shownProjectId = null;
  chat.prefs = {};
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it('renders nothing on a page that is not a project, or when the chat is closed', () => {
  const { container } = renderDock();
  expect(container.innerHTML).toBe('');
});

it('shows the current project chat beside the page, at its width, with its name', () => {
  chat.alive = ['p1'];
  chat.shownProjectId = 'p1';
  chat.prefs = { p1: open(500) };
  renderDock();
  const aside = screen.getByRole('complementary', { name: 'Chat · termhub' });
  expect(aside.style.width).toBe('500px');
  expect(aside.className).toContain('shrink-0');
  expect(screen.getByRole('separator', { name: 'Largura do chat' })).toBeTruthy();
  expect(screen.getByText('painel p1')).toBeTruthy();
});

it('keeps the chat left behind mounted, hidden and inert, when switching project', () => {
  chat.alive = ['p1'];
  chat.shownProjectId = 'p1';
  chat.prefs = { p1: open(), p2: open() };
  const { rerender } = renderDock();
  chat.alive = ['p2', 'p1'];
  chat.shownProjectId = 'p2';
  rerender(<MemoryRouter><ChatDock /></MemoryRouter>);
  expect(screen.getByRole('complementary', { name: 'Chat · engenharia inversa' })).toBeTruthy();
  // p1 is still in the DOM, but hidden from focus and screen readers
  const hidden = screen.getByText('painel p1').closest('aside')!;
  expect(hidden.hasAttribute('inert')).toBe(true);
  expect(hidden.getAttribute('aria-hidden')).toBe('true');
  expect(screen.queryByRole('complementary', { name: 'Chat · termhub' })).toBeNull();
  // back to p1: no remount, for either panel
  chat.alive = ['p1', 'p2'];
  chat.shownProjectId = 'p1';
  rerender(<MemoryRouter><ChatDock /></MemoryRouter>);
  expect(mounts.get('p1')).toBe(1);
  expect(mounts.get('p2')).toBe(1);
});

it('renders the alive panels in a stable order, whatever the recency order', () => {
  chat.alive = ['p2', 'p1', 'p3'];
  chat.shownProjectId = 'p2';
  chat.prefs = { p1: open(), p2: open(), p3: open() };
  renderDock();
  expect(screen.getAllByText(/^painel /).map((e) => e.textContent)).toEqual(['painel p1', 'painel p2', 'painel p3']);
});

it('✕ closes the chat, ⤢ maximizes it', () => {
  chat.alive = ['p1'];
  chat.shownProjectId = 'p1';
  chat.prefs = { p1: open() };
  renderDock();
  fireEvent.click(screen.getByRole('button', { name: 'Fechar chat' }));
  expect(chat.setOpen).toHaveBeenCalledWith('p1', false);
  fireEvent.click(screen.getByRole('button', { name: 'Tela cheia' }));
  expect(chat.setMaximized).toHaveBeenCalledWith('p1', true);
});

it('maximized: fills the row, no width and no separator; ⤡ goes back', () => {
  chat.alive = ['p1'];
  chat.shownProjectId = 'p1';
  chat.prefs = { p1: open(500, true) };
  renderDock();
  const aside = screen.getByRole('complementary', { name: 'Chat · termhub' });
  expect(aside.className).toContain('flex-1');
  expect(aside.style.width).toBe('');
  expect(screen.queryByRole('separator')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Sair da tela cheia' }));
  expect(chat.setMaximized).toHaveBeenCalledWith('p1', false);
});

it('narrow window: full screen, no separator and no maximize, body locked while shown', () => {
  narrow.value = true;
  chat.alive = ['p1'];
  chat.shownProjectId = 'p1';
  chat.prefs = { p1: open() };
  const { rerender } = renderDock();
  expect(screen.getByRole('complementary', { name: 'Chat · termhub' }).className).toContain('fixed');
  expect(screen.queryByRole('separator')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Tela cheia' })).toBeNull();
  expect(document.body.classList.contains('chat-locked')).toBe(true);
  chat.shownProjectId = null;
  rerender(<MemoryRouter><ChatDock /></MemoryRouter>);
  expect(document.body.classList.contains('chat-locked')).toBe(false);
});

it('Escape does not close the docked chat', () => {
  chat.alive = ['p1'];
  chat.shownProjectId = 'p1';
  chat.prefs = { p1: open() };
  renderDock();
  act(() => void fireEvent.keyDown(window, { key: 'Escape' }));
  expect(chat.setOpen).not.toHaveBeenCalled();
});

it('the separator commits the width of the shown project', () => {
  chat.alive = ['p1'];
  chat.shownProjectId = 'p1';
  chat.prefs = { p1: open() };
  renderDock();
  fireEvent.keyDown(screen.getByRole('separator', { name: 'Largura do chat' }), { key: 'ArrowLeft' });
  expect(chat.setWidth).toHaveBeenCalledWith('p1', 436);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -w @termhub/web -- src/components/chat/ChatDock.test.tsx`
Expected: FAIL, cannot resolve `./ChatDock`.

- [ ] **Step 4: Write the implementation**

```tsx
import { useEffect } from 'react';
import { useData } from '../../lib/data';
import { useNarrowWindow } from '../../lib/narrow-window';
import { useProjectChat } from '../../lib/project-chat';
import { trackAppHeight } from '../../lib/viewport';
import { ChatPanel } from './ChatPanel';
import { ChatResizer } from './ChatResizer';

/**
 * The project chat, docked in the project window (spec 2026-09-26 project chat dock §4.5). Rendered in
 * `Layout` right after `main`, so on desktop it is a column beside the page and the terminals re-fit
 * to the space left. Only the project on screen shows its chat, and only when it is open there.
 *
 * Every alive panel is rendered here, under this one parent and keyed by project, so showing another
 * one only changes classes: nothing remounts, and an answer keeps streaming into the panel left
 * behind. The hidden ones sit off screen with their last width (laid out, so the thread keeps its
 * scroll and never reads 0×0) and `inert`, so focus and screen readers skip them. They are rendered in
 * a stable order: a keyed reorder would move DOM nodes, which can reset their scroll.
 *
 * Escape does not close it: next to a terminal, Escape belongs to the program running there.
 */
export function ChatDock() {
  const { alive, shownProjectId, pref, setOpen, setWidth, setMaximized } = useProjectChat();
  const { projects } = useData();
  const narrow = useNarrowWindow();
  const fullScreen = narrow && shownProjectId !== null;

  // On a phone the chat covers the page, with the same viewport handling as `/chat` (ChatLayout), so the
  // composer stays above the keyboard and a drag on it does not pan the document.
  useEffect(() => (fullScreen ? trackAppHeight() : undefined), [fullScreen]);
  useEffect(() => {
    if (!fullScreen) return;
    document.body.classList.add('chat-locked');
    return () => document.body.classList.remove('chat-locked');
  }, [fullScreen]);

  const ids = [...new Set(shownProjectId ? [...alive, shownProjectId] : alive)].sort();
  if (ids.length === 0) return null;

  return (
    <>
      {ids.map((id) => {
        const shown = id === shownProjectId;
        const p = pref(id);
        const title = `Chat · ${projects.find((x) => x.id === id)?.name ?? 'projeto'}`;
        const docked = shown && !narrow && !p.maximized;
        const place = !shown
          ? 'fixed top-0 -left-[200vw] h-full'
          : narrow
            ? 'fixed inset-x-0 top-0 z-40 h-[var(--app-height,100svh)]'
            : p.maximized
              ? 'relative min-w-0 flex-1'
              : 'relative max-w-[60%] shrink-0';
        return (
          <aside
            key={id}
            aria-label={title}
            aria-hidden={shown ? undefined : true}
            inert={!shown}
            className={`flex flex-col border-l border-line bg-bg ${place}`}
            style={shown && (narrow || p.maximized) ? undefined : { width: p.width }}
          >
            {docked && <ChatResizer width={p.width} onCommit={(w) => setWidth(id, w)} />}
            <header className="flex h-11 shrink-0 items-center gap-2 border-b border-line bg-bg-2 px-3">
              <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-fg">{title}</h2>
              {!narrow && (
                <button
                  type="button"
                  className="rounded px-2 py-1 text-sm text-fg-dim hover:bg-bg-3 hover:text-fg"
                  aria-label={p.maximized ? 'Sair da tela cheia' : 'Tela cheia'}
                  title={p.maximized ? 'Sair da tela cheia' : 'Tela cheia'}
                  onClick={() => setMaximized(id, !p.maximized)}
                >
                  {p.maximized ? '⤡' : '⤢'}
                </button>
              )}
              <button type="button" className="rounded px-2 py-1 text-sm text-fg-dim hover:bg-bg-3 hover:text-fg" aria-label="Fechar chat" title="Fechar" onClick={() => setOpen(id, false)}>
                ✕
              </button>
            </header>
            <div className="flex min-h-0 flex-1 flex-col">
              <ChatPanel projectId={id} />
            </div>
          </aside>
        );
      })}
    </>
  );
}
```

If the web `tsc` rejects `inert={!shown}` (older `@types/react`), check `node_modules/@types/react/index.d.ts` for `inert?:`; React 19 types declare it as `boolean`.

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -w @termhub/web -- src/components/chat/ChatDock.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/lib/narrow-window.ts apps/web/src/components/Layout.tsx apps/web/src/components/chat/ChatDock.tsx apps/web/src/components/chat/ChatDock.test.tsx
git commit -m "Project chat: dock beside the project page, keeping chats alive"
```

---

### Task 6: Layout renders the dock, and hides `main` when maximized

**Files:**
- Modify: `apps/web/src/components/Layout.tsx` (`Layout` function)
- Delete: `apps/web/src/components/chat/ChatDrawer.tsx`, `apps/web/src/components/chat/ChatDrawer.test.tsx`
- Test: `apps/web/src/components/Layout.test.tsx` (swap the `ChatDrawer` mock; add a `Layout` test)

**Interfaces:**
- Consumes: Task 3 (`useProjectChat().shownProjectId`, `.pref`), Task 5 (`ChatDock`, `useNarrowWindow`), `useAuth().can`.
- Produces: `Layout` DOM: `<div class="flex h-full"> Chrome | <main> | <ChatDock/> </div>`.

- [ ] **Step 1: Write the failing test**

In `Layout.test.tsx`, replace `vi.mock('./chat/ChatDrawer', () => ({ ChatDrawer: () => null }));` with the mocks below, and add the test. Import `Layout` beside `Chrome`, and `Route, Routes` from `react-router-dom` if not already imported.

```tsx
vi.mock('./chat/ChatDock', () => ({ ChatDock: () => <aside aria-label="dock" /> }));
const dock = vi.hoisted(() => ({ shownProjectId: null as string | null, maximized: false }));
vi.mock('../lib/project-chat', () => ({
  ProjectChatProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useProjectChat: () => ({ shownProjectId: dock.shownProjectId, pref: () => ({ open: true, width: 420, maximized: dock.maximized }) }),
}));
vi.mock('../lib/auth', () => ({ useAuth: () => ({ can: () => true }) }));
// The banner reads the API on mount; not this test's concern.
vi.mock('./DeviceRequestBanner', () => ({ DeviceRequestBanner: () => null }));
```

```tsx
describe('Layout chat dock', () => {
  const mountLayout = () =>
    render(
      <MemoryRouter initialEntries={['/machines']}>
        <Routes>
          <Route element={<Layout />}>
            <Route path="/machines" element={<p>página</p>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

  it('puts the dock after main, in the same row', () => {
    mountLayout();
    const main = screen.getByRole('main');
    expect(main.nextElementSibling?.getAttribute('aria-label')).toBe('dock');
    expect(main.className).not.toContain('hidden');
  });

  it('hides main (still mounted) while the shown chat is maximized', () => {
    dock.shownProjectId = 'p1';
    dock.maximized = true;
    mountLayout();
    expect(screen.getByText('página')).toBeTruthy();
    expect(screen.getByText('página').closest('main')!.className).toContain('hidden');
    dock.shownProjectId = null;
    dock.maximized = false;
  });
});
```

If `Layout.test.tsx` already mocks `../lib/auth` or `../lib/project-chat` differently, merge into the existing mock rather than adding a second `vi.mock` for the same module.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @termhub/web -- src/components/Layout.test.tsx`
Expected: FAIL (the dock is not rendered after `main`).

- [ ] **Step 3: Implement**

In `Layout.tsx`: replace `import { ChatDrawer } from './chat/ChatDrawer';` with `import { ChatDock } from './chat/ChatDock';`, add `import { useAuth } from '../lib/auth';` if not there (it is, for `AppShell`) and `import { useProjectChat } from '../lib/project-chat';`. Change `Layout`'s JSX to:

```tsx
    <FocusProvider>
      <ProjectChatProvider>
        <LayoutRow collapsed={collapsed} setCollapsed={setCollapsed} onLeaveSettings={leaveSettings} />
      </ProjectChatProvider>
    </FocusProvider>
```

and add below `Layout`:

```tsx
/**
 * The app's row: sidebar, page, and the project chat dock after the page (spec 2026-09-26 project chat
 * dock §4.5). Inside the chat provider, since it reads whether the shown chat fills the window: then
 * the page is hidden, not unmounted, so the terminals behind it keep their sessions (TerminalsView
 * ignores the 0×0 reading).
 */
function LayoutRow({ collapsed, setCollapsed, onLeaveSettings }: { collapsed: boolean; setCollapsed: (v: boolean) => void; onLeaveSettings: () => void }) {
  const { can } = useAuth();
  const { shownProjectId, pref } = useProjectChat();
  const narrow = useNarrowWindow();
  const maximized = shownProjectId !== null && !narrow && pref(shownProjectId).maximized;
  return (
    <div className="flex h-full">
      <Chrome collapsed={collapsed} setCollapsed={setCollapsed} onLeaveSettings={onLeaveSettings} />
      <main className={`relative min-w-0 flex-1 ${maximized ? 'hidden' : ''}`}>
        <DeviceRequestBanner />
        <Outlet />
      </main>
      {can('chat') && <ChatDock />}
    </div>
  );
}
```

Delete `components/chat/ChatDrawer.tsx` and `components/chat/ChatDrawer.test.tsx` (`git rm`).

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w @termhub/web -- src/components/Layout.test.tsx src/components/chat/ChatDock.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/Layout.tsx apps/web/src/components/Layout.test.tsx
git rm apps/web/src/components/chat/ChatDrawer.tsx apps/web/src/components/chat/ChatDrawer.test.tsx
git commit -m "Layout: dock the project chat after the page instead of overlaying it"
```

---

### Task 7: Project page publishes its project and gets a 💬

**Files:**
- Create: `apps/web/src/components/chat/ChatToggleButton.tsx`
- Modify: `apps/web/src/pages/ProjectPage.tsx`
- Test: `apps/web/src/components/chat/ChatToggleButton.test.tsx`; `apps/web/src/pages/ProjectPage.test.tsx` (add `can` to the auth mock, one new test)

**Interfaces:**
- Consumes: Task 3 (`useChatScope`, `useProjectChat().pref`, `.toggle`, `.status`), `useAuth().can`.
- Produces: `ChatToggleButton({ projectId }: { projectId: string })`. It renders nothing without `can('chat')`.

- [ ] **Step 1: Write the failing test for the button**

```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ open: false, status: { busy: false, pending: 0 }, canChat: true, toggle: vi.fn() }));
vi.mock('../../lib/auth', () => ({ useAuth: () => ({ can: (r: string) => (r === 'chat' ? state.canChat : true) }) }));
vi.mock('../../lib/project-chat', () => ({
  useProjectChat: () => ({ pref: () => ({ open: state.open, width: 420, maximized: false }), toggle: state.toggle, status: () => state.status }),
}));

import { ChatToggleButton } from './ChatToggleButton';

afterEach(() => {
  cleanup();
  state.open = false;
  state.status = { busy: false, pending: 0 };
  state.canChat = true;
  vi.clearAllMocks();
});

it('toggles the project chat and says whether it is open', () => {
  render(<ChatToggleButton projectId="p1" />);
  const b = screen.getByRole('button', { name: 'Chat do projeto' });
  expect(b.getAttribute('aria-pressed')).toBe('false');
  fireEvent.click(b);
  expect(state.toggle).toHaveBeenCalledWith('p1');
});

it('is pressed while open', () => {
  state.open = true;
  render(<ChatToggleButton projectId="p1" />);
  expect(screen.getByRole('button', { name: 'Chat do projeto' }).getAttribute('aria-pressed')).toBe('true');
});

it('shows the attention dot while something waits on the person', () => {
  state.status = { busy: false, pending: 2 };
  render(<ChatToggleButton projectId="p1" />);
  const b = screen.getByRole('button', { name: 'Chat do projeto' });
  expect(b.getAttribute('title')).toBe('Chat do projeto — esperando sua confirmação');
  expect(b.querySelector('.bg-attention')).not.toBeNull();
});

it('renders nothing without the chat permission', () => {
  state.canChat = false;
  const { container } = render(<ChatToggleButton projectId="p1" />);
  expect(container.innerHTML).toBe('');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @termhub/web -- src/components/chat/ChatToggleButton.test.tsx`
Expected: FAIL, cannot resolve `./ChatToggleButton`.

- [ ] **Step 3: Implement the button**

```tsx
import { useAuth } from '../../lib/auth';
import { useProjectChat } from '../../lib/project-chat';

/**
 * The project header's 💬 (spec 2026-09-26 project chat dock §4.7): opens or closes this project's
 * docked chat. Same dot as the sidebar's: pulsing while it answers, attention while something waits
 * on the person.
 */
export function ChatToggleButton({ projectId }: { projectId: string }) {
  const { can } = useAuth();
  const { pref, toggle, status } = useProjectChat();
  if (!can('chat')) return null;
  const open = pref(projectId).open;
  const s = status(projectId);
  const active = s.busy || s.pending > 0;
  return (
    <button
      type="button"
      aria-label="Chat do projeto"
      aria-pressed={open}
      title={s.pending > 0 ? 'Chat do projeto — esperando sua confirmação' : s.busy ? 'Chat do projeto — respondendo' : 'Chat do projeto'}
      className={`relative rounded px-2 py-1 text-sm hover:bg-bg-3 ${open ? 'bg-accent/15 text-fg' : 'text-fg-muted hover:text-fg'}`}
      onClick={() => toggle(projectId)}
    >
      💬
      {active && <span className={`absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full ${s.pending > 0 ? 'bg-attention' : 'animate-pulse bg-accent'}`} />}
    </button>
  );
}
```

- [ ] **Step 4: Run the button test**

Run: `npm test -w @termhub/web -- src/components/chat/ChatToggleButton.test.tsx`
Expected: PASS.

- [ ] **Step 5: Write the failing ProjectPage test**

In `ProjectPage.test.tsx`: in `beforeEach`, give `authState.current` a `can: () => true` field (widen the hoisted type to `{ user: User | null; can?: (r: string, a?: string) => boolean }`). Add a mock and a test:

```tsx
const chatScope = vi.hoisted(() => ({ calls: [] as (string | null)[] }));
vi.mock('../lib/project-chat', () => ({
  useChatScope: (id: string | null) => void chatScope.calls.push(id),
  useProjectChat: () => ({ pref: () => ({ open: false, width: 420, maximized: false }), toggle: () => {}, status: () => ({ busy: false, pending: 0 }) }),
}));
```

```tsx
describe('ProjectPage chat', () => {
  it('says its project is on screen and has the 💬 in the header', () => {
    const proj = project();
    dataState.current = { ...dataState.current, projects: [proj] };
    chatScope.calls = [];
    renderPage(proj);
    expect(chatScope.calls).toContain('p1');
    expect(screen.getByRole('button', { name: 'Chat do projeto' }).closest('header')).not.toBeNull();
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `npm test -w @termhub/web -- src/pages/ProjectPage.test.tsx`
Expected: FAIL on the new test (no `useChatScope` call, no button).

- [ ] **Step 7: Implement in ProjectPage**

Add imports:

```tsx
import { useChatScope } from '../lib/project-chat';
import { ChatToggleButton } from '../components/chat/ChatToggleButton';
```

Right after `const project = projects.find((p) => p.id === id);` (before any early return, since it is a hook):

```tsx
  // Says which project's window is on screen, so the docked chat shows this project's chat (spec
  // 2026-09-26 project chat dock §4.4). Only for a project that exists: "não encontrado" has no chat.
  useChatScope(project?.id ?? null);
```

In `PageHeader`'s `actions`, after `<PublishControl project={project} />`:

```tsx
            <ChatToggleButton projectId={project.id} />
```

- [ ] **Step 8: Run tests**

Run: `npm test -w @termhub/web -- src/pages/ProjectPage.test.tsx src/pages/CardPage.test.tsx src/components/chat/ChatToggleButton.test.tsx`
Expected: PASS. If `CardPage.test.tsx` renders the real `ProjectPage` with an auth mock without `can`, add `can: () => true` there too.

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/components/chat/ChatToggleButton.tsx apps/web/src/components/chat/ChatToggleButton.test.tsx apps/web/src/pages/ProjectPage.tsx apps/web/src/pages/ProjectPage.test.tsx apps/web/src/pages/CardPage.test.tsx
git commit -m "Project page: show its own chat, with a toggle in the header"
```

---

### Task 8: Sidebar 💬 takes you to the project's chat

**Files:**
- Modify: `apps/web/src/components/Sidebar.tsx:1-12` (imports), `:75` (hook), `:254` (`chat` prop)
- Modify: `apps/web/src/components/ProjectRow.tsx:48-49` (comment only: "open in the dock")
- Test: `apps/web/src/components/Sidebar.test.tsx` (the `chat` mock and the "Sidebar project chat" block)

**Interfaces:**
- Consumes: Task 3 (`currentProjectId`, `pref`, `setOpen`, `toggle`, `status`), `useNavigate`.
- Produces: `ProjectRow`'s `chat.open` = `pref(p.id).open`; `chat.onToggle` = `openChat(p.id)`.

- [ ] **Step 1: Update the mock and write the failing tests**

Replace the hoisted `chat` object:

```tsx
const chat = vi.hoisted(() => ({
  currentProjectId: null as string | null,
  openIds: [] as string[],
  pref: (id: string) => ({ open: chat.openIds.includes(id), width: 420, maximized: false }),
  setOpen: vi.fn(),
  toggle: vi.fn(),
  status: vi.fn((_id: string) => ({ busy: false, pending: 0 })),
}));
```

In `afterEach`, replace `chat.openProjectId = null;` with `chat.currentProjectId = null; chat.openIds = [];`.

Change `renderSidebar` so tests can read the location:

```tsx
function Where() {
  return <span data-testid="where">{useLocation().pathname}</span>;
}
function renderSidebar() {
  return render(
    <MemoryRouter>
      <Sidebar />
      <Where />
    </MemoryRouter>,
  );
}
```

(add `useLocation` to the `react-router-dom` import). Replace the first and third tests of `describe('Sidebar project chat')`:

```tsx
  it('💬 on another project opens its chat and goes to it', () => {
    chat.currentProjectId = 'p1';
    renderSidebar();
    fireEvent.click(within(rowOf('gamma')).getByRole('button', { name: 'Chat do projeto' }));
    expect(chat.setOpen).toHaveBeenCalledWith('p3', true);
    expect(chat.toggle).not.toHaveBeenCalled();
    expect(screen.getByTestId('where').textContent).toBe('/projects/p3');
  });

  it('💬 on the project on screen toggles its chat and stays', () => {
    chat.currentProjectId = 'p3';
    renderSidebar();
    fireEvent.click(within(rowOf('gamma')).getByRole('button', { name: 'Chat do projeto' }));
    expect(chat.toggle).toHaveBeenCalledWith('p3');
    expect(chat.setOpen).not.toHaveBeenCalled();
    expect(screen.getByTestId('where').textContent).toBe('/');
  });

  it('keeps the 💬 shown without hover for every project whose chat is open', () => {
    chat.openIds = ['p3', 'p2'];
    renderSidebar();
    expect(within(rowOf('gamma')).getByRole('button', { name: 'Chat do projeto' }).parentElement).not.toHaveClass('hidden');
    expect(within(rowOf('beta')).getByRole('button', { name: 'Chat do projeto' }).parentElement).not.toHaveClass('hidden');
  });
```

`p2`/`beta` and `p3`/`gamma` are the ids the existing `seed()` uses (the current tests already rely on `p3` being gamma; check `seed()` for `p2` being beta and adjust the id if not).

The dot test ("keeps the 💬 shown without hover, with a dot…") asserts `beta`'s button is hidden. It still holds, since `openIds` is empty there.

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -w @termhub/web -- src/components/Sidebar.test.tsx`
Expected: FAIL (the sidebar still calls `toggle` and reads `openProjectId`).

- [ ] **Step 3: Implement**

In `Sidebar.tsx`: change `import { NavLink } from 'react-router-dom';` to `import { NavLink, useNavigate } from 'react-router-dom';`. After `const projectChat = useProjectChat();` add:

```tsx
  const navigate = useNavigate();
  // The chat lives in the project's window now (spec 2026-09-26 project chat dock §4.7): from anywhere
  // else, 💬 goes to the project with its chat open; on the project already on screen, it toggles.
  const openChat = (id: string) => {
    if (projectChat.currentProjectId === id) projectChat.toggle(id);
    else {
      projectChat.setOpen(id, true);
      navigate(`/projects/${id}`);
    }
  };
```

Change the `chat` prop at line 254 to:

```tsx
        chat={can('chat') ? { status: projectChat.status(p.id), open: projectChat.pref(p.id).open, onToggle: () => openChat(p.id) } : null}
```

In `ProjectRow.tsx`, update the comment at lines 48-49 from "or open in the drawer" to "or open in its project window".

- [ ] **Step 4: Run tests and the web typecheck**

Run: `npm test -w @termhub/web -- src/components/Sidebar.test.tsx src/components/Sidebar.dnd.test.tsx`
Expected: PASS. If `Sidebar.dnd.test.tsx` renders without a `project-chat` mock it uses the default context, which has every new field, so no change is needed there.

Run: `npm run typecheck -w @termhub/web`
Expected: no errors. `openProjectId` must have no reader left: `grep -rn openProjectId apps/web/src` prints nothing.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/Sidebar.tsx apps/web/src/components/Sidebar.test.tsx apps/web/src/components/ProjectRow.tsx
git commit -m "Sidebar: the chat button takes you to the project's chat"
```

---

### Task 9: Verification

**Files:** none new, unless a check fails.

- [ ] **Step 1: Whole web suite**

Run: `npm test -w @termhub/web`
Expected: PASS, except the suites that already fail on `main`. Compare with `git stash; npm test -w @termhub/web; git stash pop` if anything unrelated fails. The office/scene pixi.js suites are known to fail with "navigator is not defined" (TER-126 note).

- [ ] **Step 2: Typecheck and builds through Docker (`CLAUDE.md`)**

```bash
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/w" -w /w node:20 \
  sh -c 'npm run typecheck -w @termhub/server && npm run build -w @termhub/web && npm run build -w @termhub/landing'
rm -rf .npm
```

Expected: exit 0.

- [ ] **Step 3: Manual check in a browser** (dev stack, desktop width then 390 px)

- Open termhub's chat from the header 💬. Terminals shrink, and Claude Code in a pane redraws once.
- Drag the edge: only the line moves until release, then one re-fit. ←/→ on the focused edge, double click back to 420. At 320 px the composer's 📎, status and send button still fit.
- Ask something long and switch to engenharia inversa mid-answer. Only terminals show there. Come back: the answer kept streaming (no gap in the text), and the draft in the box is still there.
- Open a chat in a fourth project and check the first one re-reads on return.
- ⤢: the page disappears, the terminals keep their session when coming back with ⤡.
- Go to Máquinas: no chat. The sidebar 💬 of a project with a pending confirmation shows the dot. Clicking it goes to the project with the chat open.
- Reload the page: each project's open/closed, width and maximized come back.
- At 390 px: the chat is full screen, the composer stays above the keyboard, ✕ closes it.
- Escape inside a terminal with the chat open does not close the chat.

- [ ] **Step 4: Record results on the card**

Add the results (suites, builds, manual checks, anything left open) to the TER-202 card, per the board workflow. Commit any fix made in this task with its own message.
