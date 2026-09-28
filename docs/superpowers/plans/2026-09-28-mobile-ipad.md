# Mobile app on the iPad Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `@termhub/mobile` a universal iPhone + iPad app whose Chats tab splits into list + conversation on wide windows and whose other screens keep a readable width.

**Architecture:** One pure module (`src/ui/layout.ts`) holds the breakpoint and widths; a hook (`useWideLayout`) reads the window width, so rotation, Split View and Slide Over all go through the same path. The conversation body becomes a reusable `ConversationView` that the `/chat/[id]` route and the Chats split both render. `app.json` flips `supportsTablet`; Expo's own plugin writes the iPad orientations.

**Tech Stack:** Expo 57, React Native 0.86, expo-router, NativeWind 4, zustand, Jest (`logic` + `ui` projects, jest-expo, @testing-library/react-native).

**Spec:** `docs/superpowers/specs/2026-09-28-mobile-ipad-design.md`

## Global Constraints

- `WIDE_MIN_WIDTH = 700`, `SPLIT_LIST_WIDTH = 320`, `MAX_READABLE_WIDTH = 720`, `SHEET_MAX_WIDTH = 560` (points).
- `app.json`: `ios.supportsTablet: true`, no `ios.requireFullScreen`, `orientation: "portrait"` unchanged. Do not touch `expo.version`, `ios.buildNumber` or `eas.json` (the TER-104 release branch on the Mac changes those).
- UI copy in pt-BR; code, comments and commits in English.
- `src/ui/layout.ts` must not import React Native (it is tested in the `logic` project, which throws on RN imports).
- Widths are applied as inline `style` from the constants (not NativeWind arbitrary classes), so tests can read them with `StyleSheet.flatten`.
- On a compact window (every iPhone) behaviour and existing tests stay unchanged.
- Run Jest/typecheck through Docker (jarvis has no Node), from the worktree root:
  `docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/w" -w /w node:22 sh -c 'npm run build:contract -w @termhub/mobile >/dev/null && npx -w @termhub/mobile jest <pattern>'` then `rm -rf .npm`. If `node_modules` is missing in the worktree, run `npm ci` in the same container first.

## Review Focus

- Rotating / resizing while a conversation is selected (wide → compact → wide): the selection must survive and come back; Task 4 pins it.
- A pushed `/chat/<id>` (deep link, notification) switches the store's active conversation; back in the Chats tab the pane must show its own selection again. Task 4 pins it (re-open on focus).
- The embedded pane must not show "Voltar" (it would `router.back()` out of the tabs); Task 3 pins it.
- The keyboard-avoiding offset in the embedded pane: it is measured with `measureInWindow`, so it keeps working; no test (native layout), manual check §5.3.
- The thread column's `maxWidth` must be on the `FlatList` content container, not the list (the inverted list must still fill the height); Task 3 pins it.

---

### Task 1: Layout constants, wide-layout hook and the universal build config

**Files:**
- Create: `apps/mobile/src/ui/layout.ts`
- Create: `apps/mobile/src/ui/layout.test.ts`
- Create: `apps/mobile/src/ui/use-wide-layout.ts`
- Modify: `apps/mobile/src/ui/index.ts` (export both)
- Modify: `apps/mobile/app.json` (`ios.supportsTablet`)
- Create: `apps/mobile/src/app-config.test.ts`

**Interfaces:**
- Produces: `WIDE_MIN_WIDTH`, `SPLIT_LIST_WIDTH`, `MAX_READABLE_WIDTH`, `SHEET_MAX_WIDTH` (numbers), `isWide(width: number): boolean` from `@/ui/layout`; `useWideLayout(): boolean` from `@/ui/use-wide-layout`; both re-exported by `@/ui`.

- [ ] **Step 1: Write the failing tests**

`apps/mobile/src/ui/layout.test.ts`:
```ts
import { isWide, MAX_READABLE_WIDTH, SHEET_MAX_WIDTH, SPLIT_LIST_WIDTH, WIDE_MIN_WIDTH } from './layout';

describe('layout', () => {
  it('is wide from 700 pt: the iPad mini in portrait (744) splits, Slide Over and iPhones do not', () => {
    expect(WIDE_MIN_WIDTH).toBe(700);
    expect(isWide(320)).toBe(false); // Slide Over
    expect(isWide(390)).toBe(false); // iPhone
    expect(isWide(699)).toBe(false);
    expect(isWide(700)).toBe(true);
    expect(isWide(744)).toBe(true); // iPad mini, portrait
    expect(isWide(1024)).toBe(true);
  });

  it('leaves the conversation at least 380 pt next to the list', () => {
    expect(WIDE_MIN_WIDTH - SPLIT_LIST_WIDTH).toBeGreaterThanOrEqual(380);
    expect(MAX_READABLE_WIDTH).toBe(720);
    expect(SHEET_MAX_WIDTH).toBe(560);
  });
});
```

`apps/mobile/src/app-config.test.ts`:
```ts
// The universal build (spec 2026-09-28 iPad §2.1, §2.2): Expo's `withRequiresFullScreen` writes every
// iPad orientation when the tablet is supported and full screen is not required; the iPhone keeps
// `orientation`'s portrait.
const { expo } = require('../app.json') as { expo: { orientation: string; ios: Record<string, unknown> } };

describe('app.json', () => {
  it('builds for the iPad too, with multitasking (no full-screen requirement)', () => {
    expect(expo.ios.supportsTablet).toBe(true);
    expect(expo.ios.requireFullScreen).toBeUndefined();
    expect(expo.ios.isTabletOnly).toBeUndefined();
  });

  it('keeps the iPhone in portrait', () => {
    expect(expo.orientation).toBe('portrait');
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run (Docker, see Global Constraints): `npx -w @termhub/mobile jest src/ui/layout src/app-config`
Expected: FAIL — `Cannot find module './layout'`; `supportsTablet` is `false`.

- [ ] **Step 3: Implement**

`apps/mobile/src/ui/layout.ts`:
```ts
/**
 * Widths for tablets and multitasking (spec 2026-09-28 iPad §2.3, §2.4). Pure on purpose: no React
 * Native import, so the `logic` project tests it.
 */

/** From this window width on, Chats shows the list and the conversation side by side: the iPad mini
 * in portrait (744) splits; Slide Over (320), a 50/50 Split View on an 11" iPad (~590) and every
 * iPhone (portrait only, ≤ 440) stay compact. */
export const WIDE_MIN_WIDTH = 700;
/** The list pane of the split. */
export const SPLIT_LIST_WIDTH = 320;
/** Past this, text and forms stop being comfortable to read: content is centred in a column. */
export const MAX_READABLE_WIDTH = 720;
/** The bottom sheets' panel, centred, on a wide window. */
export const SHEET_MAX_WIDTH = 560;

export function isWide(width: number): boolean {
  return width >= WIDE_MIN_WIDTH;
}
```

`apps/mobile/src/ui/use-wide-layout.ts`:
```ts
import { useWindowDimensions } from 'react-native';
import { isWide } from './layout';

/** Whether the app's window is wide enough for the split layout. Follows the window, not the
 * device: rotation, Split View and Slide Over resizes all re-render through it. */
export function useWideLayout(): boolean {
  return isWide(useWindowDimensions().width);
}
```

`apps/mobile/src/ui/index.ts`: add `export * from './layout';` and `export * from './use-wide-layout';` (alphabetical order with the others).

`apps/mobile/app.json`: `"supportsTablet": false` → `"supportsTablet": true`. Nothing else.

- [ ] **Step 4: Run to verify they pass**

Run: `npx -w @termhub/mobile jest src/ui/layout src/app-config`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/src/ui/layout.ts apps/mobile/src/ui/layout.test.ts apps/mobile/src/ui/use-wide-layout.ts apps/mobile/src/ui/index.ts apps/mobile/app.json apps/mobile/src/app-config.test.ts
git commit -m "Mobile: build for the iPad and add the wide-layout breakpoint"
```

---

### Task 2: Readable width for `Screen` and `Sheet`

**Files:**
- Modify: `apps/mobile/src/ui/screen.tsx`
- Modify: `apps/mobile/src/ui/sheet.tsx`
- Create: `apps/mobile/src/ui/screen.test.tsx`
- Create: `apps/mobile/src/ui/sheet.test.tsx`

**Interfaces:**
- Consumes: `MAX_READABLE_WIDTH`, `SHEET_MAX_WIDTH` from `./layout` (Task 1).
- Produces: `Screen` gains `width?: 'readable' | 'full'` (default `'readable'`); the readable column is the View with `testID="screen-column"`. `Sheet`'s panel View has `testID="sheet-panel"`.

- [ ] **Step 1: Write the failing tests**

`apps/mobile/src/ui/screen.test.tsx`:
```tsx
import { render, screen } from '@testing-library/react-native';
import { StyleSheet, Text } from 'react-native';
import { Screen } from './screen';

const column = () => StyleSheet.flatten(screen.getByTestId('screen-column').props.style);

describe('Screen', () => {
  it('centres its content in a readable column by default', async () => {
    await render(<Screen><Text>oi</Text></Screen>);
    expect(column()).toMatchObject({ width: '100%', maxWidth: 720, alignSelf: 'center' });
    expect(screen.getByText('oi')).toBeTruthy();
  });

  it('keeps the readable column when scrolling', async () => {
    await render(<Screen scroll><Text>oi</Text></Screen>);
    expect(column()).toMatchObject({ maxWidth: 720 });
  });

  it('spans the whole window with width="full"', async () => {
    await render(<Screen width="full"><Text>oi</Text></Screen>);
    expect(column().maxWidth).toBeUndefined();
  });
});
```

`apps/mobile/src/ui/sheet.test.tsx`:
```tsx
import { render, screen } from '@testing-library/react-native';
import { StyleSheet, Text } from 'react-native';
import { Sheet } from './sheet';

describe('Sheet', () => {
  it('centres its panel at 560 pt on a wide window', async () => {
    await render(
      <Sheet open onClose={() => undefined} title="Título">
        <Text>corpo</Text>
      </Sheet>,
    );
    expect(StyleSheet.flatten(screen.getByTestId('sheet-panel').props.style)).toMatchObject({ width: '100%', maxWidth: 560, alignSelf: 'center' });
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx -w @termhub/mobile jest src/ui/screen src/ui/sheet`
Expected: FAIL — no element with testID `screen-column` / `sheet-panel`.

- [ ] **Step 3: Implement**

`apps/mobile/src/ui/screen.tsx`:
```tsx
import type { ReactNode } from 'react';
import { ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { MAX_READABLE_WIDTH } from './layout';

type Props = { children: ReactNode; scroll?: boolean; padded?: boolean; width?: 'readable' | 'full' };

/** A readable column (spec 2026-09-28 iPad §2.4): on a wide window the content is centred at
 * `MAX_READABLE_WIDTH`; `width="full"` is for screens that lay out their own widths (Chats' split,
 * the conversation). On a phone both are the same. */
const READABLE = { width: '100%', maxWidth: MAX_READABLE_WIDTH, alignSelf: 'center' } as const;

export function Screen({ children, scroll = false, padded = true, width = 'readable' }: Props) {
  const paddingClassName = padded ? 'px-6 py-4' : '';
  const columnStyle = width === 'readable' ? READABLE : undefined;
  return (
    <SafeAreaView className="flex-1 bg-app-bg">
      {scroll ? (
        <ScrollView className="flex-1">
          <View testID="screen-column" style={columnStyle} className={paddingClassName}>
            {children}
          </View>
        </ScrollView>
      ) : (
        <View testID="screen-column" style={columnStyle} className={`flex-1 ${paddingClassName}`}>
          {children}
        </View>
      )}
    </SafeAreaView>
  );
}
```

`apps/mobile/src/ui/sheet.tsx`: import `SHEET_MAX_WIDTH` from `./layout`, and change the panel to
```tsx
        <View testID="sheet-panel" style={{ width: '100%', maxWidth: SHEET_MAX_WIDTH, alignSelf: 'center' }} className="rounded-t-3xl bg-app-surface p-6">
```

- [ ] **Step 4: Run to verify they pass, then the whole `ui` project**

Run: `npx -w @termhub/mobile jest src/ui/screen src/ui/sheet` → PASS.
Run: `npx -w @termhub/mobile jest --selectProjects ui` → PASS (no screen relied on the column having no style).

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/src/ui/screen.tsx apps/mobile/src/ui/sheet.tsx apps/mobile/src/ui/screen.test.tsx apps/mobile/src/ui/sheet.test.tsx
git commit -m "Mobile: keep screens and sheets at a readable width on the iPad"
```

---

### Task 3: `ConversationView`, embeddable, with a readable thread and composer

**Files:**
- Modify: `apps/mobile/src/features/chat/view/conversation-screen.tsx`
- Modify: `apps/mobile/src/features/chat/view/conversation-screen.test.tsx` (append a `describe`)

**Interfaces:**
- Consumes: `MAX_READABLE_WIDTH` from `@/ui` (Task 1); `Screen`'s `width` prop (Task 2).
- Produces: `export function ConversationView({ routeId, embedded }: { routeId: string; embedded?: boolean })` in `conversation-screen.tsx`; `ConversationScreen` stays the route's default export and renders `<ConversationView routeId={id} />`. Test ids: the composer column View `testID="conversation-composer-column"`.

- [ ] **Step 1: Write the failing tests** — append to `conversation-screen.test.tsx` (it already mocks the stores, `expo-router` with `mockId = 'p-termhub'`, enrols in `beforeAll`, and defines `SEEDED_USER`; reuse them; `StyleSheet` is already imported):

```tsx
describe('ConversationView (iPad, spec 2026-09-28 §2.3/§2.4)', () => {
  it('embedded: shows the thread without a "Voltar" button', async () => {
    await render(<ConversationView routeId="p-termhub" embedded />);
    expect(await screen.findByText(SEEDED_USER, undefined, { timeout: 15_000 })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Voltar' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Nova conversa' })).toBeTruthy();
  });

  it('as the route: keeps "Voltar"', async () => {
    await render(<ConversationScreen />);
    await screen.findByText(SEEDED_USER, undefined, { timeout: 15_000 });
    expect(screen.getByRole('button', { name: 'Voltar' })).toBeTruthy();
  });

  it('centres the thread and the composer in a readable column; the list itself fills the pane', async () => {
    await render(<ConversationView routeId="p-termhub" embedded />);
    await screen.findByText(SEEDED_USER, undefined, { timeout: 15_000 });
    const list = screen.getByTestId('conversation-thread');
    expect(StyleSheet.flatten(list.props.contentContainerStyle)).toMatchObject({ width: '100%', maxWidth: 720, alignSelf: 'center' });
    expect(StyleSheet.flatten(list.props.style)?.maxWidth).toBeUndefined();
    expect(StyleSheet.flatten(screen.getByTestId('conversation-composer-column').props.style)).toMatchObject({ width: '100%', maxWidth: 720, alignSelf: 'center' });
  });
});
```
Also add `ConversationView` to the file's import: `import { ConversationScreen, ConversationView } from './conversation-screen';`.

Note: if `contentContainerStyle` is not exposed on the host element found by `getByTestId` (the FlatList renders a ScrollView host that receives it), read it from `screen.UNSAFE_getByType(FlatList).props.contentContainerStyle` instead (import `FlatList` from `react-native`). Keep whichever works; both assert the same thing.

- [ ] **Step 2: Run to verify they fail**

Run: `npx -w @termhub/mobile jest src/features/chat/view/conversation-screen`
Expected: FAIL — `ConversationView` is not exported.

- [ ] **Step 3: Implement** in `conversation-screen.tsx`:

1. Rename the current `export function ConversationScreen()` to `export function ConversationView({ routeId, embedded = false }: { routeId: string; embedded?: boolean })`; delete its `useLocalSearchParams` line and replace every `id` that referred to the route param with `routeId` (only the `openByRoute` effect uses it: `useEffect(() => { if (routeId) void openByRoute(routeId); }, [routeId, openByRoute]);`). Keep `useRouter` (chat-grants push, goBack).
2. Update its doc comment: "The conversation (spec §11.2) … `routeId` is a conversation id (a deep link), a project id or `general` — the store resolves which. `embedded` is the iPad split's right pane (spec 2026-09-28 §2.3): no "Voltar", the list next to it is the way out."
3. `<Screen padded={false}>` → `<Screen padded={false} width="full">`.
4. `<Button label="Voltar" … />` → `{embedded ? null : <Button label="Voltar" variant="ghost" onPress={goBack} />}`; when embedded, give the title row's left padding back: the header row's className becomes `` `flex-row items-center gap-2 border-b border-app-border py-2 ${embedded ? 'px-4' : 'px-2'}` ``.
5. The thread `FlatList`: add `testID="conversation-thread"` and `contentContainerStyle={READABLE_COLUMN}` (keep `contentContainerClassName="gap-3 px-4 py-4"`).
6. The composer wrapper `<View>` → `<View testID="conversation-composer-column" style={READABLE_COLUMN}>`.
7. Module scope:
```tsx
/** The thread and the composer never stretch past a readable width (spec 2026-09-28 iPad §2.4); the
 * header and the list's own frame still span the pane. */
const READABLE_COLUMN = { width: '100%', maxWidth: MAX_READABLE_WIDTH, alignSelf: 'center' } as const;
```
   and `MAX_READABLE_WIDTH` added to the `@/ui` import.
8. The route component, at the end of the file:
```tsx
/** The `/chat/[id]` route: the conversation full screen, with "Voltar". */
export function ConversationScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <ConversationView routeId={id} />;
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx -w @termhub/mobile jest src/features/chat/view/conversation-screen` → PASS (the new describe and every existing test).
Run: `npm run typecheck -w @termhub/mobile` (Docker) → no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/src/features/chat/view/conversation-screen.tsx apps/mobile/src/features/chat/view/conversation-screen.test.tsx
git commit -m "Mobile: embeddable conversation view with a readable column"
```

---

### Task 4: Chats split on wide windows

**Files:**
- Modify: `apps/mobile/src/features/chat/view/chats-screen.tsx`
- Create: `apps/mobile/src/features/chat/view/chats-screen.wide.test.tsx`
- Modify: `apps/mobile/README.md` (a short "iPad" section)

**Interfaces:**
- Consumes: `useWideLayout`, `SPLIT_LIST_WIDTH`, `EmptyState`, `Screen` (`width="full"`) from `@/ui`; `ConversationView` from `./conversation-screen` (Task 3).
- Produces: nothing new for other tasks. Test ids: `chats-list-pane`, `chats-detail-pane`.

- [ ] **Step 1: Write the failing test** — `chats-screen.wide.test.tsx` (a separate file because it mocks `useWindowDimensions` for the whole file):

```tsx
import { act, fireEvent, render, screen } from '@testing-library/react-native';

jest.mock('@/features/session/viewmodel/useSessionStore', () => ({ useSessionStore: require('../../../../test/helpers/ui-stores').stores.store }));
jest.mock('@/features/chat/viewmodel/useChatStore', () => ({ useChatStore: require('../../../../test/helpers/ui-stores').stores.chat }));
// The conversation pane's microphone: never records here.
jest.mock('@/features/chat/viewmodel/use-voice', () => ({
  useVoice: () => ({ state: 'idle', seconds: 0, error: null, notice: null, start: jest.fn(), stop: jest.fn(), cancel: jest.fn() }),
  useRecorder: () => ({ state: 'idle', seconds: 0, error: null, start: jest.fn(async () => undefined), stop: jest.fn(async () => null), cancel: jest.fn() }),
}));

/** The window the screen sees: an iPad in landscape unless a test resizes it. */
const mockWindow = { width: 1024, height: 768, scale: 2, fontScale: 1 };
jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({ __esModule: true, default: () => mockWindow }));

const mockPush = jest.fn();
let mockFocus: (() => void) | null = null;
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, back: jest.fn(), replace: jest.fn(), canGoBack: () => true }),
  useFocusEffect: (cb: () => void) => {
    require('react').useEffect(() => {
      mockFocus = cb;
      cb();
    }, [cb]);
  },
  useLocalSearchParams: () => ({}),
  Link: ({ children }: { children: unknown }) => children,
}));

import { useChatStore } from '@/features/chat/viewmodel/useChatStore';
import { enrolStores } from '../../../../test/helpers/ui-stores';
import { ChatsScreen } from './chats-screen';

const LOAD = { timeout: 15_000 };
/** The seeded `p-termhub` thread's first message (mock fixtures). */
const SEEDED_USER = 'Como estão as abas do projeto?';

beforeAll(async () => {
  await enrolStores();
});

beforeEach(() => {
  mockWindow.width = 1024;
  mockWindow.height = 768;
  mockPush.mockClear();
});

describe('Chats on a wide window (iPad, spec 2026-09-28 §2.3)', () => {
  it('shows the list and, until one is chosen, an empty pane', async () => {
    await render(<ChatsScreen />);
    expect(await screen.findByText('termhub', undefined, LOAD)).toBeTruthy();
    expect(screen.getByTestId('chats-list-pane')).toBeTruthy();
    expect(screen.getByText('Escolha uma conversa')).toBeTruthy();
  });

  it('opens a chat in the pane next to the list, not as a pushed screen', async () => {
    await render(<ChatsScreen />);
    await fireEvent.press(await screen.findByRole('button', { name: /^termhub/ }, LOAD));
    expect(await screen.findByText(SEEDED_USER, undefined, LOAD)).toBeTruthy();
    expect(mockPush).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Voltar' })).toBeNull();
    expect(screen.getByRole('button', { name: /^termhub/ }).props.accessibilityState).toMatchObject({ selected: true });
    expect(screen.queryByText('Escolha uma conversa')).toBeNull();
  });

  it('collapses to the list when the window narrows, and brings the chat back when it widens', async () => {
    const view = await render(<ChatsScreen />);
    await fireEvent.press(await screen.findByRole('button', { name: /^termhub/ }, LOAD));
    await screen.findByText(SEEDED_USER, undefined, LOAD);

    mockWindow.width = 390; // Slide Over / a narrow Split View
    await view.rerender(<ChatsScreen />);
    expect(screen.queryByTestId('chats-detail-pane')).toBeNull();
    expect(screen.queryByText(SEEDED_USER)).toBeNull();
    // Compact again: a tap pushes, as on a phone.
    await fireEvent.press(screen.getByRole('button', { name: /^Chat geral/ }));
    expect(mockPush).toHaveBeenLastCalledWith('/chat/general');

    mockWindow.width = 1024;
    await view.rerender(<ChatsScreen />);
    expect(await screen.findByText(SEEDED_USER, undefined, LOAD)).toBeTruthy();
  });

  it('re-opens its own chat when the tab regains focus after a pushed one took over the store', async () => {
    await render(<ChatsScreen />);
    await fireEvent.press(await screen.findByRole('button', { name: /^termhub/ }, LOAD));
    await screen.findByText(SEEDED_USER, undefined, LOAD);

    // A notification tap pushed the account-wide chat, which became the store's active one.
    await act(() => useChatStore.getState().openByRoute('general'));
    expect(useChatStore.getState().activeProject).toBeNull();

    await act(async () => mockFocus?.());
    expect(useChatStore.getState().activeProject).toBe('p-termhub');
    expect(await screen.findByText(SEEDED_USER, undefined, LOAD)).toBeTruthy();
  });
});
```

Note for the implementer: check `useChatStore.getState().openByRoute`'s return type and `activeProject` values in `createChatStore.ts` before relying on `null` for `general` (the conversation screen treats `activeProject === null` as "Chat geral"). If `mockFocus` holds a stale callback after re-renders, it still calls the latest `loadProjects`/selection because the effect re-captures `cb` when it changes — keep the focus callback's deps including the selection.

- [ ] **Step 2: Run to verify it fails**

Run: `npx -w @termhub/mobile jest src/features/chat/view/chats-screen`
Expected: the new file FAILS (no `chats-list-pane`); `chats-screen.test.tsx` still PASSES.

- [ ] **Step 3: Implement** — `chats-screen.tsx`:

```tsx
import { useFocusEffect, useRouter, type Href } from 'expo-router';
import { useCallback, useState } from 'react';
import { FlatList, Pressable, RefreshControl, Text, View } from 'react-native';
import { relativeTime } from '@/features/shared/relative-time';
import { AppText, Banner, EmptyState, Screen, SPLIT_LIST_WIDTH, useWideLayout } from '@/ui';
import { useChatStore } from '../viewmodel/useChatStore';
import { ConversationView } from './conversation-screen';

type Row = { route: string; name: string; busy: boolean; pending: number; lastMessageAt: string | null };

function ChatRow({ row, selected, onPress }: { row: Row; selected: boolean; onPress(): void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={row.name}
      accessibilityState={{ selected }}
      onPress={onPress}
      className={`flex-row items-center gap-3 border-b border-app-border px-6 py-4 ${selected ? 'bg-app-surface' : ''}`}
    >
      {/* …the row's content, unchanged… */}
    </Pressable>
  );
}
```
(Keep the row's children exactly as they are today.)

In `ChatsScreen`:
```tsx
  const wide = useWideLayout();
  const openByRoute = useChatStore((s) => s.openByRoute);
  /** The chat in the split's right pane (spec 2026-09-28 iPad §2.3). Kept while the window is
   * compact, so widening it again brings the same chat back. */
  const [selected, setSelected] = useState<string | null>(null);

  // On every focus, not only on mount: the tabs stay mounted under a pushed conversation, so a
  // decision or a finished answer there would otherwise leave this list stale. The split's pane is
  // re-opened too: a pushed conversation (a deep link, a notification) made itself the store's
  // active one, and the pane shows the active one.
  useFocusEffect(
    useCallback(() => {
      void loadProjects();
      if (wide && selected) void openByRoute(selected);
    }, [loadProjects, openByRoute, wide, selected]),
  );

  const open = (route: string) => (wide ? setSelected(route) : router.push(`/chat/${route}` as Href));

  const list = (
    <>
      <View className="gap-3 px-6 pb-2 pt-4">
        <AppText variant="title">Chats</AppText>
        {error ? <Banner tone="danger" text={error} /> : null}
      </View>
      <FlatList
        data={rows}
        keyExtractor={(row) => row.route}
        extraData={wide ? selected : null}
        renderItem={({ item }) => <ChatRow row={item} selected={wide && item.route === selected} onPress={() => open(item.route)} />}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void loadProjects()} />}
      />
    </>
  );

  if (!wide) return <Screen padded={false}>{list}</Screen>;
  return (
    <Screen padded={false} width="full">
      <View className="flex-1 flex-row">
        <View testID="chats-list-pane" style={{ width: SPLIT_LIST_WIDTH }} className="border-r border-app-border">
          {list}
        </View>
        <View testID="chats-detail-pane" className="flex-1">
          {selected ? <ConversationView key={selected} routeId={selected} embedded /> : <EmptyState title="Escolha uma conversa" hint="Selecione um chat na lista ao lado." />}
        </View>
      </View>
    </Screen>
  );
```
Note: the compact branch keeps `Screen padded={false}` with the default readable width — on a phone that is identical to today. The focus effect must not re-open on the first mount when nothing is selected (the `selected` guard covers it). `ConversationView` is keyed by route so switching chats resets its local state (sheets, "Ver separadas").

`apps/mobile/README.md`: after the "Manual checklist" section, add:

```markdown
## iPad

The build is universal (`ios.supportsTablet: true`): the iPhone stays in portrait, the iPad rotates freely and supports Split View and Slide Over (Expo writes every `UISupportedInterfaceOrientations~ipad` because full screen is not required). From 700 pt of window width Chats shows the list and the conversation side by side; other screens keep a 720 pt column. Design and manual check: `docs/superpowers/specs/2026-09-28-mobile-ipad-design.md` (§5). Enter-to-send on a hardware keyboard is not there yet (spec §2.5).
```

- [ ] **Step 4: Run to verify**

Run: `npx -w @termhub/mobile jest src/features/chat/view/chats-screen` → both files PASS.
Run the whole mobile suite and typecheck (Docker): `npm run typecheck -w @termhub/mobile && npm test -w @termhub/mobile` → PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/src/features/chat/view/chats-screen.tsx apps/mobile/src/features/chat/view/chats-screen.wide.test.tsx apps/mobile/README.md
git commit -m "Mobile: list and conversation side by side on the iPad"
```
