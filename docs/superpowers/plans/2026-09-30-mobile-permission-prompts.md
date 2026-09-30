# Mobile permission prompts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ask for notifications with a primer after the first sent chat message, and ask for ad measurement consent (ATT on iOS) with a Home card after the PIN, instead of the bare OS prompt at session start.

**Architecture:** A new `permissions` feature holds a persisted zustand store over injected OS/Firebase services. Features talk through payload-free signals (`sessionStarted`, `messageSent`, `pushGranted`) in `src/features/shared/signals.ts`, as `sessionEnded` already does. Views: a global primer sheet, a Home card, two Ajustes sections. Native: `expo-tracking-transparency`, Firebase with AdSupport, consent defaults denied in `firebase.json`, app version bump.

**Tech Stack:** Expo SDK 57, React Native 0.86, expo-router, zustand + MMKV, NativeWind, `expo-notifications`, `expo-tracking-transparency@~57.0.2`, `@react-native-firebase/analytics@^26.4`, Jest (`logic` and `ui` projects).

**Spec:** `docs/superpowers/specs/2026-09-30-mobile-permission-prompts-design.md`

## Global Constraints

- All work in `apps/mobile` (`@termhub/mobile`); address the workspace by package name (`-w @termhub/mobile`).
- UI copy is pt-BR, exactly as written in this plan; code, comments, commits in English.
- Models, viewmodels and services never import `react-native` or `expo-router` (the `logic` jest project throws).
- **Ship as ONE pull request.** Every push to `main` touching `apps/mobile/**` publishes an OTA for the current `expo.version`; the JS here imports a new native module, so the version bump (Task 7) must land together with Tasks 1–6. Never merge a task alone.
- App version: `0.4.0` → `0.5.0` in `apps/mobile/app.json` (`expo.version`) and `apps/mobile/package.json`; `expo.android.versionCode` `5` → `6`.
- Ad consent default is denied; `analytics_storage` stays granted.
- Every native call is wrapped: failure leaves state unchanged and never throws out of an action.
- Run tests from the repo root: `npm test -w @termhub/mobile -- <path>`; typecheck: `npm run typecheck -w @termhub/mobile`.

## Review Focus

1. **iOS person who refused ATT, then flips the Ajustes switch on** → system settings open; the switch stays off until they return and ATT reads `authorized` (Task 3 test "settings on with ATT denied opens system settings").
2. **Person who granted ads, then turned tracking off in iOS Settings** → next session start downgrades to `denied` and tells Firebase (Task 3 test "syncAdConsent downgrades").
3. **Failed send (host offline)** → no primer; the primer comes with the first *successful* send, even if it is a retry (Task 1 chat test, Task 3 test "first messageSent only").
4. **Android below 13 / permission already granted** → primer never shows, because the OS status is not `undetermined` (Task 3 test "decided status never opens").
5. **Firebase native module missing (old dev client) or ATT call throwing** → actions finish, state consistent, no crash (Task 2 analytics test, Task 3 test "native failures").

---

### Task 1: Signals, push service that never prompts, session and chat emit

**Files:**
- Modify: `apps/mobile/src/features/shared/signals.ts` (append)
- Modify: `apps/mobile/src/services/push.ts:26-43`
- Modify: `apps/mobile/src/features/session/viewmodel/createSessionStore.ts:132-151`
- Modify: `apps/mobile/src/features/session/model/session.types.ts:32-34` (doc comment only)
- Modify: `apps/mobile/src/features/chat/viewmodel/createChatStore.ts:17,658-661`
- Test: `apps/mobile/src/services/push.test.ts`, `apps/mobile/src/features/session/viewmodel/createSessionStore.test.ts`, `apps/mobile/src/features/chat/viewmodel/createChatStore.test.ts`

**Interfaces:**
- Produces: `sessionStarted`, `messageSent`, `pushGranted` (each `{ subscribe(fn): () => void; emit(): void }`) from `@/features/shared/signals`; `type NotificationStatus = 'granted' | 'denied' | 'undetermined'`, `notificationStatus(): Promise<NotificationStatus>`, `requestNotifications(): Promise<NotificationStatus>` from `@/services/push`.

- [ ] **Step 1: Write the failing push tests.** In `src/services/push.test.ts`, replace the test `'asks for the permission when not granted yet, and gives up when refused'` with the following, and add `notificationStatus, requestNotifications` to the import from `./push`:

```ts
  it('never asks for the permission: no token until it is granted (permission prompts spec §3.3)', async () => {
    notifications.getPermissionsAsync!.mockResolvedValueOnce({ status: 'undetermined' });
    expect(await expoPushToken()).toBeNull();
    expect(notifications.requestPermissionsAsync).not.toHaveBeenCalled();
    expect(notifications.getExpoPushTokenAsync).not.toHaveBeenCalled();
  });
});

describe('notification permission', () => {
  it('notificationStatus reads the OS status without prompting', async () => {
    notifications.getPermissionsAsync!.mockResolvedValueOnce({ status: 'denied' });
    expect(await notificationStatus()).toBe('denied');
    expect(notifications.requestPermissionsAsync).not.toHaveBeenCalled();
  });

  it('requestNotifications creates the Android channel first, then prompts', async () => {
    notifications.requestPermissionsAsync!.mockResolvedValueOnce({ status: 'granted' });
    expect(await requestNotifications()).toBe('granted');
    const channel = notifications.setNotificationChannelAsync!.mock.invocationCallOrder[0]!;
    const prompt = notifications.requestPermissionsAsync!.mock.invocationCallOrder[0]!;
    expect(channel).toBeLessThan(prompt);
  });
```

(The `});` at the top closes the existing `describe('expoPushToken', …)`; delete that describe's original closing `});` so the braces balance.)

- [ ] **Step 2: Run them to see them fail.**
Run: `npm test -w @termhub/mobile -- src/services/push.test.ts`
Expected: FAIL — `requestPermissionsAsync` called once; `notificationStatus is not a function`.

- [ ] **Step 3: Implement in `src/services/push.ts`.** Replace the `expoPushToken` doc comment and function (lines 26–43) with:

```ts
/** The OS answer for notifications, in expo's words. */
export type NotificationStatus = 'granted' | 'denied' | 'undetermined';

/** Android's `default` channel: pushes land there, and Android 13+ only shows the permission
 * prompt once a channel exists (a no-op on iOS). */
async function ensureChannel(): Promise<void> {
  await Notifications.setNotificationChannelAsync(ANDROID_CHANNEL, {
    name: 'Notificações',
    importance: Notifications.AndroidImportance.HIGH,
  });
}

/** The current permission, never prompting. */
export async function notificationStatus(): Promise<NotificationStatus> {
  return (await Notifications.getPermissionsAsync()).status as NotificationStatus;
}

/** The OS prompt (once per install on iOS): only the permissions store calls it, from the primer
 * or Ajustes (permission prompts spec §2). */
export async function requestNotifications(): Promise<NotificationStatus> {
  await ensureChannel();
  return (await Notifications.requestPermissionsAsync()).status as NotificationStatus;
}

/**
 * This phone's Expo push token; `null` on a simulator (no token there), until the permission is
 * granted, or when the build has no EAS project id. It never prompts: the primer does.
 */
export async function expoPushToken(): Promise<string | null> {
  if (!Device.isDevice) return null;
  await ensureChannel();
  if ((await notificationStatus()) !== 'granted') return null;
  const projectId: unknown = Constants.expoConfig?.extra?.eas?.projectId;
  if (typeof projectId !== 'string') return null;
  return (await Notifications.getExpoPushTokenAsync({ projectId })).data;
}
```

Also update the file's header comment line 2–3 to: `// Service to the token this module reads; the session store registers it (`PUT push-token`) at every` / `// session start once the permission is granted, and the root layout opens the conversation a tapped push points at.`

- [ ] **Step 4: Run push tests.**
Run: `npm test -w @termhub/mobile -- src/services/push.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the signals.** Append to `src/features/shared/signals.ts`:

```ts

/**
 * Fired when a session starts — activation after "Criar PIN", or an unlock (permission prompts
 * spec §3.1). The permissions store re-reads the OS statuses and re-applies the ad consent.
 */
export const sessionStarted = signal();

/** Fired by the chat store after the server accepted a message (retries included). The permissions
 * store opens the notification primer on the first one. */
export const messageSent = signal();

/** Fired by the permissions store when the OS grants notifications: the session store registers
 * the push token at once instead of waiting for the next session. */
export const pushGranted = signal();
```

- [ ] **Step 6: Write the failing session test.** In `src/features/session/viewmodel/createSessionStore.test.ts`, change the import on line 8 to `import { pushGranted, sessionEnded, sessionStarted } from '@/features/shared/signals';` and append:

```ts
it('announces every session start, and registers the push token when the OS grants it (permission prompts spec §3.1)', async () => {
  const started = jest.fn();
  const off = sessionStarted.subscribe(started);
  const ctx = setup();
  await enrol(ctx);
  expect(started).toHaveBeenCalledTimes(1);

  const register = jest.spyOn(ctx.api, 'setPushToken');
  pushGranted.emit();
  await jest.advanceTimersByTimeAsync(0);
  expect(register).toHaveBeenCalledWith(expect.anything(), `ExponentPushToken[mock-${ctx.store.getState().deviceId}]`);
  off();
});

it('a pushGranted while locked registers nothing', async () => {
  const ctx = setup();
  await enrol(ctx);
  ctx.store.getState().background();
  await jest.advanceTimersByTimeAsync(RELOCK_AFTER_MS + 1);
  ctx.store.getState().foreground();
  expect(ctx.store.getState().phase).toBe('locked');
  const register = jest.spyOn(ctx.api, 'setPushToken');
  pushGranted.emit();
  await jest.advanceTimersByTimeAsync(0);
  expect(register).not.toHaveBeenCalled();
});
```

If the relock sequence differs, reuse the relock helper the file's existing "relocks after RELOCK_AFTER_MS in the background" test uses.

- [ ] **Step 7: Run to see it fail.**
Run: `npm test -w @termhub/mobile -- src/features/session/viewmodel/createSessionStore.test.ts -t "permission prompts|pushGranted"`
Expected: FAIL — `started` called 0 times; `setPushToken` not called.

- [ ] **Step 8: Implement in `createSessionStore.ts`.** Change the signals import (line 14) to `import { pushGranted, sessionEnded, sessionStarted } from '@/features/shared/signals';`. In `startSession`, after `socketWake.emit();` add `sessionStarted.emit();`. Right after the `startSession` definition (still inside the `persist` creator), add:

```ts
        // The primer granted notifications mid-session: register now, not at the next unlock.
        pushGranted.subscribe(() => {
          if (accessToken) registerPush(accessToken).catch(() => undefined);
        });
```

In `session.types.ts`, change the `pushToken` doc comment to: `/** This phone's Expo push token (`expo-notifications`), or `null` when there is none (a simulator, a permission not granted). Read at every session start outside mock mode, and again on `pushGranted`. */`

- [ ] **Step 9: Run session tests.**
Run: `npm test -w @termhub/mobile -- src/features/session/viewmodel/createSessionStore.test.ts`
Expected: PASS (all, including the existing ones).

- [ ] **Step 10: Write the failing chat test.** In `createChatStore.test.ts`, change line 7 to `import { appBackgrounded, messageSent } from '@/features/shared/signals';` and append:

```ts
it('announces a message the server accepted, never a failed one (permission prompts spec §3.1)', async () => {
  const { chat, api } = await setup();
  await openAndConnect(chat, 'p-termhub');
  const sent = jest.fn();
  const off = messageSent.subscribe(sent);
  jest.spyOn(api, 'sendMessage').mockRejectedValueOnce(new ApiError(409, 'HOST_OFFLINE', 'A máquina do chat está offline.'));
  await chat.getState().send('oi');
  expect(sent).not.toHaveBeenCalled();
  await expect(chat.getState().send('de novo')).resolves.toBe(true);
  expect(sent).toHaveBeenCalledTimes(1);
  off();
});
```

- [ ] **Step 11: Run to see it fail.**
Run: `npm test -w @termhub/mobile -- src/features/chat/viewmodel/createChatStore.test.ts -t "server accepted"`
Expected: FAIL — `sent` called 0 times.

- [ ] **Step 12: Implement.** In `createChatStore.ts` line 17: `import { appBackgrounded, messageSent, sessionEnded } from '@/features/shared/signals';`. In `send`, replace `set({ sending: false });` just before `// Events no longer re-read the thread…` with:

```ts
              set({ sending: false });
              messageSent.emit();
```

- [ ] **Step 13: Run chat, session and push suites.**
Run: `npm test -w @termhub/mobile -- src/features/chat/viewmodel/createChatStore.test.ts src/features/session src/services/push.test.ts`
Expected: PASS.

- [ ] **Step 14: Commit.**

```bash
git add apps/mobile/src/features/shared/signals.ts apps/mobile/src/services/push.ts apps/mobile/src/services/push.test.ts apps/mobile/src/features/session apps/mobile/src/features/chat/viewmodel/createChatStore.ts apps/mobile/src/features/chat/viewmodel/createChatStore.test.ts
git commit -m "Mobile: session start no longer prompts for notifications

Adds sessionStarted, messageSent and pushGranted signals for the
permission prompts; the push token is read only once granted."
```

---

### Task 2: Tracking and ad-consent services, native dependency and fakes

**Files:**
- Modify: `apps/mobile/package.json` (dependency, via npm)
- Create: `apps/mobile/src/services/tracking.ts`, `apps/mobile/src/services/tracking.test.ts`
- Modify: `apps/mobile/src/services/analytics.ts`
- Create: `apps/mobile/src/services/analytics.test.ts`
- Create: `apps/mobile/test/fakes/expo-tracking-transparency.js`, `apps/mobile/test/fakes/firebase-analytics.js`
- Modify: `apps/mobile/test/logic-setup.js`, `apps/mobile/test/ui-setup.js`

**Interfaces:**
- Produces: `type TrackingStatus = 'authorized' | 'denied' | 'undetermined' | 'unavailable'`, `trackingStatus(): Promise<TrackingStatus>`, `requestTracking(): Promise<TrackingStatus>` from `@/services/tracking`; `setAdConsent(granted: boolean): Promise<void>` from `@/services/analytics`.

- [ ] **Step 1: Install the module.**
Run (repo root): `npm install expo-tracking-transparency@~57.0.2 -w @termhub/mobile`
Expected: `apps/mobile/package.json` gains `"expo-tracking-transparency": "~57.0.2"`; `package-lock.json` changes.

- [ ] **Step 2: Add the fakes.** `test/fakes/expo-tracking-transparency.js`:

```js
// Stand-in for `expo-tracking-transparency` under jest: iOS with ATT available and not asked yet.
module.exports = {
  isAvailable: jest.fn(() => true),
  getTrackingPermissionsAsync: jest.fn(async () => ({ status: 'undetermined', granted: false, canAskAgain: true })),
  requestTrackingPermissionsAsync: jest.fn(async () => ({ status: 'granted', granted: true, canAskAgain: false })),
};
```

`test/fakes/firebase-analytics.js`:

```js
// Stand-in for `@react-native-firebase/analytics` under jest: no native module, calls recorded.
module.exports = {
  getAnalytics: jest.fn(() => ({})),
  logScreenView: jest.fn(async () => undefined),
  setConsent: jest.fn(async () => undefined),
};
```

In both `test/logic-setup.js` and `test/ui-setup.js`, after the `expo-notifications` line add:

```js
jest.mock('expo-tracking-transparency', () => require('./fakes/expo-tracking-transparency'));
jest.mock('@react-native-firebase/analytics', () => require('./fakes/firebase-analytics'));
```

- [ ] **Step 3: Write the failing tests.** `src/services/tracking.test.ts`:

```ts
import * as ATT from 'expo-tracking-transparency';
import { requestTracking, trackingStatus } from './tracking';

const att = ATT as unknown as Record<string, jest.Mock>;
beforeEach(() => jest.clearAllMocks());

it('maps the OS answer: granted is authorized', async () => {
  att.getTrackingPermissionsAsync!.mockResolvedValueOnce({ status: 'denied' });
  expect(await trackingStatus()).toBe('denied');
  expect(await requestTracking()).toBe('authorized');
  att.getTrackingPermissionsAsync!.mockResolvedValueOnce({ status: 'undetermined' });
  expect(await trackingStatus()).toBe('undetermined');
});

it('is unavailable where ATT does not exist (Android), and never prompts there', async () => {
  att.isAvailable!.mockReturnValue(false);
  expect(await trackingStatus()).toBe('unavailable');
  expect(await requestTracking()).toBe('unavailable');
  expect(att.requestTrackingPermissionsAsync).not.toHaveBeenCalled();
  att.isAvailable!.mockReturnValue(true);
});
```

`src/services/analytics.test.ts`:

```ts
import * as Analytics from '@react-native-firebase/analytics';
import { setAdConsent } from './analytics';

const analytics = Analytics as unknown as Record<string, jest.Mock>;
beforeEach(() => jest.clearAllMocks());

it('grants or denies the three ad signals together, and keeps analytics storage on', async () => {
  await setAdConsent(true);
  expect(analytics.setConsent).toHaveBeenLastCalledWith({}, { ad_storage: true, ad_user_data: true, ad_personalization: true, analytics_storage: true });
  await setAdConsent(false);
  expect(analytics.setConsent).toHaveBeenLastCalledWith({}, { ad_storage: false, ad_user_data: false, ad_personalization: false, analytics_storage: true });
});

it('never throws when the native module is missing', async () => {
  analytics.getAnalytics!.mockImplementationOnce(() => {
    throw new Error('native module missing');
  });
  await expect(setAdConsent(true)).resolves.toBeUndefined();
  analytics.setConsent!.mockRejectedValueOnce(new Error('boom'));
  await expect(setAdConsent(true)).resolves.toBeUndefined();
});
```

- [ ] **Step 4: Run to see them fail.**
Run: `npm test -w @termhub/mobile -- src/services/tracking.test.ts src/services/analytics.test.ts`
Expected: FAIL — cannot find module `./tracking`; `setAdConsent` is not a function.

- [ ] **Step 5: Implement.** `src/services/tracking.ts`:

```ts
// App Tracking Transparency (permission prompts spec §3.3). iOS only: where ATT does not exist
// (Android) the status is `unavailable` and nothing prompts.
import * as ATT from 'expo-tracking-transparency';

export type TrackingStatus = 'authorized' | 'denied' | 'undetermined' | 'unavailable';

const fromOs = (status: string): TrackingStatus => (status === 'granted' ? 'authorized' : status === 'undetermined' ? 'undetermined' : 'denied');

export async function trackingStatus(): Promise<TrackingStatus> {
  if (!ATT.isAvailable()) return 'unavailable';
  return fromOs((await ATT.getTrackingPermissionsAsync()).status);
}

/** The ATT prompt: iOS shows it once per install; later calls answer the stored status. */
export async function requestTracking(): Promise<TrackingStatus> {
  if (!ATT.isAvailable()) return 'unavailable';
  return fromOs((await ATT.requestTrackingPermissionsAsync()).status);
}
```

Replace `src/services/analytics.ts` with:

```ts
import { getAnalytics, logScreenView, setConsent } from '@react-native-firebase/analytics';

/** Logs a `screen_view` for an expo-router route pattern, e.g. `/chat/[id]`. Never throws. */
export function logScreen(route: string): void {
  try {
    logScreenView(getAnalytics(), { screen_name: route, screen_class: route }).catch(() => undefined);
  } catch {
    // Native module missing (e.g. an old dev client): analytics must never break the app.
  }
}

/** Google's ad consent signals (permission prompts spec §3.3): all three follow the person's
 * choice; analytics storage stays on (screen views are first-party). Never throws. */
export async function setAdConsent(granted: boolean): Promise<void> {
  try {
    await setConsent(getAnalytics(), { ad_storage: granted, ad_user_data: granted, ad_personalization: granted, analytics_storage: true });
  } catch {
    // Native module missing: the defaults in firebase.json (denied) stay in force.
  }
}
```

- [ ] **Step 6: Run the tests and the whole suite (the new mocks touch every file).**
Run: `npm test -w @termhub/mobile -- src/services/tracking.test.ts src/services/analytics.test.ts && npm test -w @termhub/mobile`
Expected: PASS.

- [ ] **Step 7: Commit.**

```bash
git add apps/mobile/package.json package-lock.json apps/mobile/src/services/tracking.ts apps/mobile/src/services/tracking.test.ts apps/mobile/src/services/analytics.ts apps/mobile/src/services/analytics.test.ts apps/mobile/test
git commit -m "Mobile: ATT and ad-consent services

Wraps expo-tracking-transparency and Firebase setConsent; both never
throw, and Android reports ATT as unavailable."
```

---

### Task 3: The permissions store

**Files:**
- Create: `apps/mobile/src/features/permissions/model/permissions.types.ts`
- Create: `apps/mobile/src/features/permissions/model/messages.ts`
- Create: `apps/mobile/src/features/permissions/viewmodel/createPermissionsStore.ts`
- Create: `apps/mobile/src/features/permissions/viewmodel/usePermissionsStore.ts`
- Test: `apps/mobile/src/features/permissions/viewmodel/createPermissionsStore.test.ts`
- Modify: `apps/mobile/test/helpers/ui-stores.ts`

**Interfaces:**
- Consumes: `sessionStarted`, `messageSent`, `pushGranted`, `sessionEnded` (Task 1); `NotificationStatus` (Task 1); `TrackingStatus` (Task 2).
- Produces: `createPermissionsStore(deps: PermissionsDeps)`, `showAdCard(s)`, `MAX_PUSH_PRIMER_DISMISSALS`, `usePermissionsStore`, state/actions as in `PermissionsState` below; `stores.permissions` and `stores.permissionDeps` in `test/helpers/ui-stores.ts`; copy constants in `model/messages.ts`.

- [ ] **Step 1: Types and copy.** `model/permissions.types.ts`:

```ts
import type { NotificationStatus } from '@/services/push';
import type { TrackingStatus } from '@/services/tracking';

export type { NotificationStatus, TrackingStatus };
export type AdConsent = 'unknown' | 'granted' | 'denied';

export interface PermissionsDeps {
  platform: 'ios' | 'android';
  notificationStatus(): Promise<NotificationStatus>;
  requestNotifications(): Promise<NotificationStatus>;
  trackingStatus(): Promise<TrackingStatus>;
  requestTracking(): Promise<TrackingStatus>;
  setAdConsent(granted: boolean): Promise<void>;
  openSystemSettings(): Promise<void>;
}

export interface PermissionsState {
  /** Persisted. */
  firstMessageSent: boolean;
  pushPrimerDismissals: number;
  adConsent: AdConsent;
  /** Memory only. */
  pushPrimerOpen: boolean;
  notificationStatus: NotificationStatus | null;
  trackingStatus: TrackingStatus | null;

  refreshStatuses(): Promise<void>;
  maybeOpenPushPrimer(): Promise<void>;
  acceptPush(): Promise<void>;
  dismissPush(): void;
  acceptAds(): Promise<void>;
  declineAds(): Promise<void>;
  setAdsFromSettings(on: boolean): Promise<void>;
  syncAdConsent(): Promise<void>;
  openSystemSettings(): Promise<void>;
}
```

`model/messages.ts`:

```ts
// pt-BR copy of the permission prompts (permission prompts spec §3.4).
export const PERMISSIONS_MSG = {
  pushTitle: 'Receba avisos das suas conversas',
  pushBody: 'O termhub avisa quando uma aba pede confirmação, faz uma pergunta ou responde no chat.',
  pushAccept: 'Ativar notificações',
  later: 'Agora não',
  adTitle: 'Ajude a medir nossos anúncios',
  adBody: 'Com sua permissão, usamos o identificador de publicidade do aparelho só para saber quais anúncios trouxeram novas pessoas ao termhub. Você pode mudar isso em Ajustes.',
  adAccept: 'Permitir',
  notificationStatus: {
    granted: 'Ativadas neste aparelho.',
    denied: 'Desativadas. Para receber avisos, ative nos Ajustes do sistema.',
    undetermined: 'Ainda não ativadas.',
  },
  openSettings: 'Abrir Ajustes do sistema',
  adsSwitch: 'Medição de anúncios',
  adsHint: 'Usa o identificador de publicidade do aparelho só para medir quais anúncios trouxeram novas pessoas ao termhub.',
} as const;
```

- [ ] **Step 2: Write the failing store tests.** `viewmodel/createPermissionsStore.test.ts`:

```ts
// The permissions store (permission prompts spec §3.2) over fake OS services.
import { messageSent, pushGranted, sessionEnded, sessionStarted } from '@/features/shared/signals';
import type { PermissionsDeps } from '../model/permissions.types';
import { createPermissionsStore, MAX_PUSH_PRIMER_DISMISSALS, showAdCard } from './createPermissionsStore';

function fakeDeps(over: Partial<PermissionsDeps> = {}) {
  return {
    platform: 'ios',
    notificationStatus: jest.fn(async () => 'undetermined'),
    requestNotifications: jest.fn(async () => 'granted'),
    trackingStatus: jest.fn(async () => 'undetermined'),
    requestTracking: jest.fn(async () => 'authorized'),
    setAdConsent: jest.fn(async () => undefined),
    openSystemSettings: jest.fn(async () => undefined),
    ...over,
  } as jest.Mocked<PermissionsDeps>;
}

const flush = () => new Promise<void>((r) => setImmediate(r));

beforeEach(() => sessionEnded.emit()); // clears the MMKV-backed state of earlier tests' stores

describe('notification primer', () => {
  it('opens on the first message the server accepted only', async () => {
    const deps = fakeDeps();
    const store = createPermissionsStore(deps);
    messageSent.emit();
    await flush();
    expect(store.getState().pushPrimerOpen).toBe(true);
    store.getState().dismissPush();
    messageSent.emit();
    await flush();
    expect(store.getState().pushPrimerOpen).toBe(false);
    expect(store.getState().firstMessageSent).toBe(true);
  });

  it('a decided status never opens it', async () => {
    for (const status of ['granted', 'denied'] as const) {
      const store = createPermissionsStore(fakeDeps({ notificationStatus: jest.fn(async () => status) }));
      await store.getState().maybeOpenPushPrimer();
      expect(store.getState().pushPrimerOpen).toBe(false);
    }
  });

  it(`stops after ${MAX_PUSH_PRIMER_DISMISSALS} dismissals`, async () => {
    const store = createPermissionsStore(fakeDeps());
    for (let i = 0; i < MAX_PUSH_PRIMER_DISMISSALS; i++) {
      await store.getState().maybeOpenPushPrimer();
      expect(store.getState().pushPrimerOpen).toBe(true);
      store.getState().dismissPush();
    }
    await store.getState().maybeOpenPushPrimer();
    expect(store.getState().pushPrimerOpen).toBe(false);
  });

  it('accept prompts, and a grant emits pushGranted', async () => {
    const deps = fakeDeps();
    const store = createPermissionsStore(deps);
    const granted = jest.fn();
    const off = pushGranted.subscribe(granted);
    await store.getState().maybeOpenPushPrimer();
    await store.getState().acceptPush();
    expect(store.getState()).toMatchObject({ pushPrimerOpen: false, notificationStatus: 'granted' });
    expect(granted).toHaveBeenCalledTimes(1);

    deps.requestNotifications.mockResolvedValueOnce('denied');
    await store.getState().acceptPush();
    expect(granted).toHaveBeenCalledTimes(1);
    off();
  });
});

describe('ad consent', () => {
  it('is unknown by default, and the card shows only once a status allows asking', async () => {
    const store = createPermissionsStore(fakeDeps());
    expect(store.getState().adConsent).toBe('unknown');
    expect(showAdCard(store.getState())).toBe(false); // status not read yet
    await store.getState().refreshStatuses();
    expect(showAdCard(store.getState())).toBe(true);
  });

  it('iOS: granted only when ATT authorizes', async () => {
    const deps = fakeDeps();
    const store = createPermissionsStore(deps);
    await store.getState().acceptAds();
    expect(store.getState().adConsent).toBe('granted');
    expect(deps.setAdConsent).toHaveBeenLastCalledWith(true);

    const denied = fakeDeps({ requestTracking: jest.fn(async () => 'denied') });
    const other = createPermissionsStore(denied);
    await other.getState().acceptAds();
    expect(other.getState().adConsent).toBe('denied');
    expect(denied.setAdConsent).toHaveBeenLastCalledWith(false);
  });

  it('Android: our own accept grants, with no system prompt', async () => {
    const deps = fakeDeps({ platform: 'android', trackingStatus: jest.fn(async () => 'unavailable') });
    const store = createPermissionsStore(deps);
    await store.getState().refreshStatuses();
    expect(showAdCard(store.getState())).toBe(true);
    await store.getState().acceptAds();
    expect(deps.requestTracking).not.toHaveBeenCalled();
    expect(store.getState().adConsent).toBe('granted');
    expect(showAdCard(store.getState())).toBe(false);
  });

  it('decline stores denied and tells Firebase', async () => {
    const deps = fakeDeps();
    const store = createPermissionsStore(deps);
    await store.getState().declineAds();
    expect(store.getState().adConsent).toBe('denied');
    expect(deps.setAdConsent).toHaveBeenLastCalledWith(false);
    expect(deps.requestTracking).not.toHaveBeenCalled();
  });

  it('settings on with ATT denied opens system settings and changes nothing', async () => {
    const deps = fakeDeps({ trackingStatus: jest.fn(async () => 'denied') });
    const store = createPermissionsStore(deps);
    await store.getState().declineAds();
    await store.getState().setAdsFromSettings(true);
    expect(deps.openSystemSettings).toHaveBeenCalledTimes(1);
    expect(deps.requestTracking).not.toHaveBeenCalled();
    expect(store.getState().adConsent).toBe('denied');
  });

  it('settings on with ATT undetermined asks; off declines', async () => {
    const deps = fakeDeps();
    const store = createPermissionsStore(deps);
    await store.getState().setAdsFromSettings(true);
    expect(store.getState().adConsent).toBe('granted');
    await store.getState().setAdsFromSettings(false);
    expect(store.getState().adConsent).toBe('denied');
    expect(deps.setAdConsent).toHaveBeenLastCalledWith(false);
  });

  it('syncAdConsent downgrades a grant iOS no longer authorizes, then re-applies it, on every session start', async () => {
    const deps = fakeDeps();
    const store = createPermissionsStore(deps);
    await store.getState().acceptAds();
    deps.trackingStatus.mockResolvedValue('denied');
    sessionStarted.emit();
    await flush();
    expect(store.getState().adConsent).toBe('denied');
    expect(deps.setAdConsent).toHaveBeenLastCalledWith(false);
  });

  it('an unknown consent is applied as denied at session start', async () => {
    const deps = fakeDeps();
    createPermissionsStore(deps);
    sessionStarted.emit();
    await flush();
    expect(deps.setAdConsent).toHaveBeenLastCalledWith(false);
  });
});

it('persists the choices, and a session end forgets them', async () => {
  const store = createPermissionsStore(fakeDeps());
  await store.getState().declineAds();
  store.getState().dismissPush();
  const again = createPermissionsStore(fakeDeps());
  expect(again.getState()).toMatchObject({ adConsent: 'denied', pushPrimerDismissals: 1, pushPrimerOpen: false });

  sessionEnded.emit();
  expect(again.getState()).toMatchObject({ adConsent: 'unknown', pushPrimerDismissals: 0, firstMessageSent: false });
});

it('native failures leave the state as it was and never throw', async () => {
  const boom = jest.fn(async () => {
    throw new Error('native');
  });
  const store = createPermissionsStore(fakeDeps({ notificationStatus: boom, requestNotifications: boom, trackingStatus: boom, requestTracking: boom, setAdConsent: boom, openSystemSettings: boom }));
  await expect(store.getState().maybeOpenPushPrimer()).resolves.toBeUndefined();
  expect(store.getState().pushPrimerOpen).toBe(false);
  await expect(store.getState().acceptPush()).resolves.toBeUndefined();
  await expect(store.getState().acceptAds()).resolves.toBeUndefined();
  expect(store.getState().adConsent).toBe('denied');
  await expect(store.getState().syncAdConsent()).resolves.toBeUndefined();
  await expect(store.getState().setAdsFromSettings(true)).resolves.toBeUndefined();
});
```

- [ ] **Step 3: Run to see them fail.**
Run: `npm test -w @termhub/mobile -- src/features/permissions`
Expected: FAIL — cannot find module `./createPermissionsStore`.

- [ ] **Step 4: Implement `viewmodel/createPermissionsStore.ts`.**

```ts
// The permission prompts (permission prompts spec §3.2): the notification primer after the first
// accepted message, and the ad measurement consent (ATT on iOS). A factory over injected OS and
// Firebase services, so the logic project drives it with fakes; `usePermissionsStore.ts` builds
// the app's one instance.
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { messageSent, pushGranted, sessionEnded, sessionStarted } from '@/features/shared/signals';
import { mmkvStateStorage } from '@/services/storage';
import type { AdConsent, PermissionsDeps, PermissionsState } from '../model/permissions.types';

/** "Agora não" twice and the primer is gone for good; Ajustes keeps the way in. */
export const MAX_PUSH_PRIMER_DISMISSALS = 2;

const initialData = {
  firstMessageSent: false,
  pushPrimerDismissals: 0,
  adConsent: 'unknown' as AdConsent,
  pushPrimerOpen: false,
  notificationStatus: null,
  trackingStatus: null,
};

/** The Home card: consent not decided yet and a status that still lets us ask (Android has no
 * ATT; iOS asks while undetermined, and an authorized ATT only needs our own yes). */
export function showAdCard(s: Pick<PermissionsState, 'adConsent' | 'trackingStatus'>): boolean {
  if (s.adConsent !== 'unknown') return false;
  return s.trackingStatus === 'unavailable' || s.trackingStatus === 'undetermined' || s.trackingStatus === 'authorized';
}

/** A native call that may fail (missing module, OS error): the fallback instead of a throw. */
async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

export function createPermissionsStore(deps: PermissionsDeps) {
  const store = create<PermissionsState>()(
    persist(
      (set, get) => ({
        ...initialData,

        async refreshStatuses() {
          const [notificationStatus, trackingStatus] = await Promise.all([safe(deps.notificationStatus, null), safe(deps.trackingStatus, null)]);
          set({ notificationStatus, trackingStatus });
        },

        async maybeOpenPushPrimer() {
          if (get().pushPrimerOpen || get().pushPrimerDismissals >= MAX_PUSH_PRIMER_DISMISSALS) return;
          const status = await safe(deps.notificationStatus, null);
          set({ notificationStatus: status });
          if (status === 'undetermined') set({ pushPrimerOpen: true });
        },

        async acceptPush() {
          set({ pushPrimerOpen: false });
          const status = await safe(deps.requestNotifications, null);
          if (status) set({ notificationStatus: status });
          if (status === 'granted') pushGranted.emit();
        },

        dismissPush() {
          set((s) => ({ pushPrimerOpen: false, pushPrimerDismissals: s.pushPrimerDismissals + 1 }));
        },

        async acceptAds() {
          let granted = true;
          if (deps.platform === 'ios') {
            const status = await safe(deps.requestTracking, null);
            if (status) set({ trackingStatus: status });
            granted = status === 'authorized';
          }
          set({ adConsent: granted ? 'granted' : 'denied' });
          await safe(() => deps.setAdConsent(granted), undefined);
        },

        async declineAds() {
          set({ adConsent: 'denied' });
          await safe(() => deps.setAdConsent(false), undefined);
        },

        async setAdsFromSettings(on) {
          if (!on) return get().declineAds();
          if (deps.platform === 'android') return get().acceptAds();
          const status = await safe(deps.trackingStatus, null);
          if (status) set({ trackingStatus: status });
          if (status === 'undetermined' || status === 'authorized') return get().acceptAds();
          // iOS never shows the ATT prompt twice: the system settings are the only way back.
          if (status) await safe(deps.openSystemSettings, undefined);
        },

        async syncAdConsent() {
          await get().refreshStatuses();
          const { adConsent, trackingStatus } = get();
          if (deps.platform === 'ios' && adConsent === 'granted' && trackingStatus !== null && trackingStatus !== 'authorized') set({ adConsent: 'denied' });
          await safe(() => deps.setAdConsent(get().adConsent === 'granted'), undefined);
        },

        async openSystemSettings() {
          await safe(deps.openSystemSettings, undefined);
        },
      }),
      {
        name: 'permissions',
        storage: createJSONStorage(() => mmkvStateStorage),
        partialize: (s) => ({ firstMessageSent: s.firstMessageSent, pushPrimerDismissals: s.pushPrimerDismissals, adConsent: s.adConsent }),
      },
    ),
  );

  sessionStarted.subscribe(() => {
    void store.getState().syncAdConsent();
  });
  messageSent.subscribe(() => {
    if (store.getState().firstMessageSent) return;
    store.setState({ firstMessageSent: true });
    void store.getState().maybeOpenPushPrimer();
  });
  sessionEnded.subscribe(() => {
    store.setState({ ...initialData });
  });

  return store;
}
```

Note on the failure test: `acceptAds` with `requestTracking` throwing gives `status === null` → `denied`, which is what the test expects.

- [ ] **Step 5: Run the store tests.**
Run: `npm test -w @termhub/mobile -- src/features/permissions`
Expected: PASS.

- [ ] **Step 6: The app instance.** `viewmodel/usePermissionsStore.ts`:

```ts
// The app's one permissions store, over the real OS and Firebase services. Importing it (the root
// layout does, through the primer sheet) subscribes it to the session and chat signals.
import * as Device from 'expo-device';
import { Linking } from 'react-native';
import { setAdConsent } from '@/services/analytics';
import { notificationStatus, requestNotifications } from '@/services/push';
import { requestTracking, trackingStatus } from '@/services/tracking';
import { createPermissionsStore } from './createPermissionsStore';

export const usePermissionsStore = createPermissionsStore({
  platform: Device.osName === 'iOS' || Device.osName === 'iPadOS' ? 'ios' : 'android',
  notificationStatus,
  requestNotifications,
  trackingStatus,
  requestTracking,
  setAdConsent,
  openSystemSettings: () => Linking.openSettings(),
});
```

- [ ] **Step 7: UI test helper.** In `test/helpers/ui-stores.ts` add the imports `import type { PermissionsDeps } from '@/features/permissions/model/permissions.types';` and `import { createPermissionsStore } from '@/features/permissions/viewmodel/createPermissionsStore';`, update the header comment's list with `usePermissionsStore`, and before `export const stores` add:

```ts
/** Fake OS answers for the permissions store: a screen test overrides one with `mockResolvedValueOnce`. */
const permissionDeps: jest.Mocked<PermissionsDeps> = {
  platform: 'ios',
  notificationStatus: jest.fn(async () => 'undetermined' as const),
  requestNotifications: jest.fn(async () => 'granted' as const),
  trackingStatus: jest.fn(async () => 'undetermined' as const),
  requestTracking: jest.fn(async () => 'authorized' as const),
  setAdConsent: jest.fn(async () => undefined),
  openSystemSettings: jest.fn(async () => undefined),
};
```

and inside `stores` add `permissions: createPermissionsStore(permissionDeps),` and `permissionDeps,`.

- [ ] **Step 8: Typecheck and run the suite.**
Run: `npm run typecheck -w @termhub/mobile && npm test -w @termhub/mobile`
Expected: PASS.

- [ ] **Step 9: Commit.**

```bash
git add apps/mobile/src/features/permissions apps/mobile/test/helpers/ui-stores.ts
git commit -m "Mobile: permissions store for the notification primer and ad consent"
```

---

### Task 4: Notification primer sheet and its triggers

**Files:**
- Create: `apps/mobile/src/features/permissions/view/push-primer-sheet.tsx`
- Test: `apps/mobile/src/features/permissions/view/push-primer-sheet.test.tsx`
- Modify: `apps/mobile/app/_layout.tsx` (import + mount next to `<PinPromptSheet />`, line ~115)
- Modify: `apps/mobile/src/features/notifications/view/notifications-screen.tsx:42-46`
- Modify: `apps/mobile/src/features/notifications/view/notifications-screen.test.tsx`

**Interfaces:**
- Consumes: `usePermissionsStore` (`pushPrimerOpen`, `acceptPush`, `dismissPush`, `maybeOpenPushPrimer`), `PERMISSIONS_MSG` (Task 3).
- Produces: `PushPrimerSheet()`.

- [ ] **Step 1: Write the failing test.** `view/push-primer-sheet.test.tsx`:

```tsx
import { act, fireEvent, render, screen } from '@testing-library/react-native';

jest.mock('@/features/permissions/viewmodel/usePermissionsStore', () => ({ usePermissionsStore: require('../../../../test/helpers/ui-stores').stores.permissions }));

import { stores } from '../../../../test/helpers/ui-stores';
import { PushPrimerSheet } from './push-primer-sheet';

const store = stores.permissions;
beforeEach(() => store.setState({ pushPrimerOpen: true, pushPrimerDismissals: 0, notificationStatus: 'undetermined' }));

it('explains, then asks the OS on "Ativar notificações"', async () => {
  await render(<PushPrimerSheet />);
  expect(screen.getByText('Receba avisos das suas conversas')).toBeTruthy();
  await act(async () => fireEvent.press(screen.getByText('Ativar notificações')));
  expect(stores.permissionDeps.requestNotifications).toHaveBeenCalled();
  expect(store.getState().pushPrimerOpen).toBe(false);
});

it('"Agora não" closes it and counts the dismissal', async () => {
  await render(<PushPrimerSheet />);
  await act(async () => fireEvent.press(screen.getByText('Agora não')));
  expect(store.getState()).toMatchObject({ pushPrimerOpen: false, pushPrimerDismissals: 1 });
});
```

- [ ] **Step 2: Run to see it fail.**
Run: `npm test -w @termhub/mobile -- src/features/permissions/view/push-primer-sheet.test.tsx`
Expected: FAIL — cannot find module `./push-primer-sheet`.

- [ ] **Step 3: Implement `view/push-primer-sheet.tsx`.**

```tsx
import { View } from 'react-native';
import { AppText, Button, Sheet } from '@/ui';
import { PERMISSIONS_MSG as MSG } from '../model/messages';
import { usePermissionsStore } from '../viewmodel/usePermissionsStore';

/** The notification primer (permission prompts spec §3.4): says what the termhub notifies before
 * the one-time OS prompt. Mounted once, globally, by `app/_layout.tsx`; `pushPrimerOpen` opens it. */
export function PushPrimerSheet() {
  const open = usePermissionsStore((s) => s.pushPrimerOpen);
  const acceptPush = usePermissionsStore((s) => s.acceptPush);
  const dismissPush = usePermissionsStore((s) => s.dismissPush);
  return (
    <Sheet open={open} onClose={dismissPush} title={MSG.pushTitle}>
      <View className="gap-4">
        <AppText>{MSG.pushBody}</AppText>
        <Button label={MSG.pushAccept} onPress={() => void acceptPush()} />
        <Button label={MSG.later} variant="ghost" onPress={dismissPush} />
      </View>
    </Sheet>
  );
}
```

- [ ] **Step 4: Run it.**
Run: `npm test -w @termhub/mobile -- src/features/permissions/view/push-primer-sheet.test.tsx`
Expected: PASS.

- [ ] **Step 5: Mount it.** In `app/_layout.tsx` add `import { PushPrimerSheet } from '@/features/permissions/view/push-primer-sheet';` next to the `PinPromptSheet` import, and render `<PushPrimerSheet />` right after `<PinPromptSheet />`.

- [ ] **Step 6: Notificações tab trigger — failing test first.** In `notifications-screen.test.tsx`, after the `useNotificationsStore` mock add:

```tsx
jest.mock('@/features/permissions/viewmodel/usePermissionsStore', () => ({ usePermissionsStore: require('../../../../test/helpers/ui-stores').stores.permissions }));
```

and append inside `describe('Notificações', …)`:

```tsx
  it('offers the notification primer on focus while the permission is undecided', async () => {
    stores.permissions.setState({ pushPrimerOpen: false, pushPrimerDismissals: 0 });
    await render(<NotificationsScreen />);
    await act(async () => undefined);
    expect(stores.permissions.getState().pushPrimerOpen).toBe(true);
  });
```

Run: `npm test -w @termhub/mobile -- src/features/notifications/view/notifications-screen.test.tsx`
Expected: FAIL — `pushPrimerOpen` false.

- [ ] **Step 7: Implement.** In `notifications-screen.tsx` import `import { usePermissionsStore } from '@/features/permissions/viewmodel/usePermissionsStore';`, read `const maybeOpenPushPrimer = usePermissionsStore((s) => s.maybeOpenPushPrimer);` and change the focus effect to:

```tsx
  // On every focus, like Chats: an approval or a new push seen elsewhere would otherwise leave
  // this list stale. Someone who opens this tab without notifications on is offered them.
  useFocusEffect(
    useCallback(() => {
      void load();
      void maybeOpenPushPrimer();
    }, [load, maybeOpenPushPrimer]),
  );
```

- [ ] **Step 8: Run the ui suite.**
Run: `npm test -w @termhub/mobile -- --selectProjects ui`
Expected: PASS. If another screen test renders `NotificationsScreen` (e.g. through the tabs layout) and now fails on the real `usePermissionsStore`, add the same `jest.mock` line to it.

- [ ] **Step 9: Commit.**

```bash
git add apps/mobile/src/features/permissions/view apps/mobile/app/_layout.tsx apps/mobile/src/features/notifications/view
git commit -m "Mobile: notification primer after the first message and on Notificações"
```

---

### Task 5: Ad consent card on Home

**Files:**
- Create: `apps/mobile/src/features/permissions/view/ad-consent-card.tsx`
- Test: `apps/mobile/src/features/permissions/view/ad-consent-card.test.tsx`
- Modify: `apps/mobile/src/features/home/view/home-screen.tsx:24-28,36-40`
- Modify: `apps/mobile/src/features/home/view/home-screen.test.tsx` (mock line)

**Interfaces:**
- Consumes: `usePermissionsStore` (`acceptAds`, `declineAds`, `refreshStatuses`), `showAdCard`, `PERMISSIONS_MSG` (Task 3).
- Produces: `AdConsentCard()`.

- [ ] **Step 1: Write the failing test.** `view/ad-consent-card.test.tsx`:

```tsx
import { act, fireEvent, render, screen } from '@testing-library/react-native';

jest.mock('@/features/permissions/viewmodel/usePermissionsStore', () => ({ usePermissionsStore: require('../../../../test/helpers/ui-stores').stores.permissions }));

import { stores } from '../../../../test/helpers/ui-stores';
import { AdConsentCard } from './ad-consent-card';

const store = stores.permissions;
beforeEach(() => store.setState({ adConsent: 'unknown', trackingStatus: 'undetermined' }));

it('asks while consent is unknown, and "Permitir" goes through ATT', async () => {
  await render(<AdConsentCard />);
  expect(screen.getByText('Ajude a medir nossos anúncios')).toBeTruthy();
  await act(async () => fireEvent.press(screen.getByText('Permitir')));
  expect(stores.permissionDeps.requestTracking).toHaveBeenCalled();
  expect(store.getState().adConsent).toBe('granted');
  expect(screen.queryByText('Ajude a medir nossos anúncios')).toBeNull();
});

it('"Agora não" declines and hides it', async () => {
  await render(<AdConsentCard />);
  await act(async () => fireEvent.press(screen.getByText('Agora não')));
  expect(store.getState().adConsent).toBe('denied');
  expect(screen.queryByText('Ajude a medir nossos anúncios')).toBeNull();
});

it('stays hidden once decided, or when iOS already refused ATT', async () => {
  store.setState({ adConsent: 'denied' });
  await render(<AdConsentCard />);
  expect(screen.queryByText('Ajude a medir nossos anúncios')).toBeNull();
  await act(async () => store.setState({ adConsent: 'unknown', trackingStatus: 'denied' }));
  expect(screen.queryByText('Ajude a medir nossos anúncios')).toBeNull();
});
```

- [ ] **Step 2: Run to see it fail.**
Run: `npm test -w @termhub/mobile -- src/features/permissions/view/ad-consent-card.test.tsx`
Expected: FAIL — cannot find module `./ad-consent-card`.

- [ ] **Step 3: Implement `view/ad-consent-card.tsx`.**

```tsx
import { View } from 'react-native';
import { AppText, Button } from '@/ui';
import { PERMISSIONS_MSG as MSG } from '../model/messages';
import { showAdCard } from '../viewmodel/createPermissionsStore';
import { usePermissionsStore } from '../viewmodel/usePermissionsStore';

/** The ad measurement consent (permission prompts spec §3.4), on Home until decided: "Permitir"
 * opens ATT on iOS; on Android it is our own yes. */
export function AdConsentCard() {
  const visible = usePermissionsStore(showAdCard);
  const acceptAds = usePermissionsStore((s) => s.acceptAds);
  const declineAds = usePermissionsStore((s) => s.declineAds);
  if (!visible) return null;
  return (
    <View className="gap-3 rounded-2xl border border-app-border bg-app-surface p-4">
      <AppText className="font-semibold">{MSG.adTitle}</AppText>
      <AppText variant="muted">{MSG.adBody}</AppText>
      <View className="flex-row gap-2">
        <View className="flex-1">
          <Button label={MSG.later} variant="secondary" onPress={() => void declineAds()} />
        </View>
        <View className="flex-1">
          <Button label={MSG.adAccept} onPress={() => void acceptAds()} />
        </View>
      </View>
    </View>
  );
}
```

- [ ] **Step 4: Run it.**
Run: `npm test -w @termhub/mobile -- src/features/permissions/view/ad-consent-card.test.tsx`
Expected: PASS.

- [ ] **Step 5: Put it on Home.** In `home-screen.tsx`: import `AdConsentCard` from `@/features/permissions/view/ad-consent-card` and `usePermissionsStore` from `@/features/permissions/viewmodel/usePermissionsStore`; read `const refreshStatuses = usePermissionsStore((s) => s.refreshStatuses);`; the focus effect becomes:

```tsx
  // On every focus: a pin changed in Chats, or on the web, shows up when the person comes back;
  // the OS statuses are re-read so the ad card follows a change made in the system settings.
  useFocusEffect(
    useCallback(() => {
      void loadProjects();
      void refreshStatuses();
    }, [loadProjects, refreshStatuses]),
  );
```

and the header block renders the card after the error banner:

```tsx
        {error ? <Banner tone="danger" text={error} /> : null}
        <AdConsentCard />
```

In `home-screen.test.tsx` add, with the other store mocks:

```tsx
jest.mock('@/features/permissions/viewmodel/usePermissionsStore', () => ({ usePermissionsStore: require('../../../../test/helpers/ui-stores').stores.permissions }));
```

- [ ] **Step 6: Run the ui suite.**
Run: `npm test -w @termhub/mobile -- --selectProjects ui`
Expected: PASS (existing Home assertions unaffected; the card text is extra).

- [ ] **Step 7: Commit.**

```bash
git add apps/mobile/src/features/permissions/view apps/mobile/src/features/home/view
git commit -m "Mobile: ad measurement consent card on Home"
```

---

### Task 6: Ajustes — Notificações and Privacidade sections

**Files:**
- Modify: `apps/mobile/src/features/settings/view/settings-screen.tsx`
- Modify: `apps/mobile/src/features/settings/view/settings-screen.test.tsx`

**Interfaces:**
- Consumes: `usePermissionsStore` (`notificationStatus`, `adConsent`, `refreshStatuses`, `acceptPush`, `openSystemSettings`, `setAdsFromSettings`), `PERMISSIONS_MSG` (Task 3).

- [ ] **Step 1: Write the failing tests.** In `settings-screen.test.tsx` add the mock line

```tsx
jest.mock('@/features/permissions/viewmodel/usePermissionsStore', () => ({ usePermissionsStore: require('../../../../test/helpers/ui-stores').stores.permissions }));
```

and append (import `stores` from the ui-stores helper if the file does not yet):

```tsx
describe('Notificações e Privacidade (permission prompts spec §2)', () => {
  it('a refused permission offers the system settings', async () => {
    stores.permissionDeps.notificationStatus.mockResolvedValueOnce('denied');
    await render(<SettingsScreen />);
    expect(await screen.findByText('Desativadas. Para receber avisos, ative nos Ajustes do sistema.')).toBeTruthy();
    await act(async () => fireEvent.press(screen.getByText('Abrir Ajustes do sistema')));
    expect(stores.permissionDeps.openSystemSettings).toHaveBeenCalled();
  });

  it('an undecided permission can be turned on from here', async () => {
    stores.permissionDeps.notificationStatus.mockResolvedValueOnce('undetermined');
    await render(<SettingsScreen />);
    await act(async () => fireEvent.press(await screen.findByText('Ativar notificações')));
    expect(stores.permissionDeps.requestNotifications).toHaveBeenCalled();
  });

  it('the ad measurement switch follows and changes the consent', async () => {
    stores.permissions.setState({ adConsent: 'granted' });
    await render(<SettingsScreen />);
    const toggle = screen.getByRole('switch', { name: 'Medição de anúncios' });
    expect(toggle.props.value).toBe(true);
    await act(async () => fireEvent(toggle, 'valueChange', false));
    expect(stores.permissions.getState().adConsent).toBe('denied');
  });
});
```

- [ ] **Step 2: Run to see them fail.**
Run: `npm test -w @termhub/mobile -- src/features/settings/view/settings-screen.test.tsx`
Expected: FAIL — texts not found.

- [ ] **Step 3: Implement.** In `settings-screen.tsx`:
  - imports: `AppState` added to the `react-native` import; `import { PERMISSIONS_MSG } from '@/features/permissions/model/messages';` and `import { usePermissionsStore } from '@/features/permissions/viewmodel/usePermissionsStore';`
  - reads in `SettingsScreen`:

```tsx
  const notificationStatus = usePermissionsStore((s) => s.notificationStatus);
  const adConsent = usePermissionsStore((s) => s.adConsent);
  const refreshStatuses = usePermissionsStore((s) => s.refreshStatuses);
  const acceptPush = usePermissionsStore((s) => s.acceptPush);
  const openSystemSettings = usePermissionsStore((s) => s.openSystemSettings);
  const setAdsFromSettings = usePermissionsStore((s) => s.setAdsFromSettings);

  // The OS statuses, now and whenever the person comes back from the system settings.
  useEffect(() => {
    void refreshStatuses();
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') void refreshStatuses();
    });
    return () => sub.remove();
  }, [refreshStatuses]);
```

  - after the "Biometria" section:

```tsx
        <Section title="Notificações">
          <AppText variant="muted">{PERMISSIONS_MSG.notificationStatus[notificationStatus ?? 'undetermined']}</AppText>
          {notificationStatus === 'undetermined' ? <Button label={PERMISSIONS_MSG.pushAccept} variant="secondary" onPress={() => void acceptPush()} /> : null}
          {notificationStatus === 'denied' ? <Button label={PERMISSIONS_MSG.openSettings} variant="secondary" onPress={() => void openSystemSettings()} /> : null}
        </Section>

        <Section title="Privacidade">
          <View className="flex-row items-center justify-between">
            <AppText>{PERMISSIONS_MSG.adsSwitch}</AppText>
            <Switch accessibilityLabel={PERMISSIONS_MSG.adsSwitch} value={adConsent === 'granted'} onValueChange={(value) => void setAdsFromSettings(value)} />
          </View>
          <AppText variant="muted">{PERMISSIONS_MSG.adsHint}</AppText>
        </Section>
```

  - update the component doc comment to mention notifications and privacy.

- [ ] **Step 4: Run the ui suite.**
Run: `npm test -w @termhub/mobile -- --selectProjects ui`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add apps/mobile/src/features/settings/view
git commit -m "Mobile: notifications and ad measurement in Ajustes"
```

---

### Task 7: Native configuration, version bump, docs

**Files:**
- Modify: `apps/mobile/app.json` (analytics plugin, new ATT plugin, version, versionCode)
- Modify: `apps/mobile/package.json` (`version`)
- Create: `apps/mobile/firebase.json`
- Modify: `apps/mobile/src/app-config.test.ts`
- Modify: `apps/mobile/README.md` (push "Registration" bullet; new "Permission prompts" paragraph)

- [ ] **Step 1: Write the failing config tests.** Append to `src/app-config.test.ts` (inside a new describe):

```ts
type Plugin = string | [string, Record<string, unknown>];
const plugins = (require('../app.json') as { expo: { plugins: Plugin[] } }).expo.plugins;
const pluginOptions = (name: string) => (plugins.find((p) => (Array.isArray(p) ? p[0] : p) === name) as [string, Record<string, unknown>] | undefined)?.[1];

describe('ad measurement (permission prompts spec §3.5)', () => {
  it('asks ATT with a pt-BR reason, and builds Firebase with the advertising id', () => {
    expect(pluginOptions('expo-tracking-transparency')?.userTrackingPermission).toMatch(/identificador de publicidade/);
    expect((pluginOptions('@react-native-firebase/analytics')?.ios as { withoutAdIdSupport?: boolean }).withoutAdIdSupport).toBe(false);
  });

  it('denies the ad signals by default, before any JS runs, and keeps analytics', () => {
    const rn = (require('../firebase.json') as { 'react-native': Record<string, boolean> })['react-native'];
    expect(rn).toEqual({
      google_analytics_default_allow_analytics_storage: true,
      google_analytics_default_allow_ad_storage: false,
      google_analytics_default_allow_ad_user_data: false,
      google_analytics_default_allow_ad_personalization_signals: false,
    });
  });
});
```

- [ ] **Step 2: Run to see it fail.**
Run: `npm test -w @termhub/mobile -- src/app-config.test.ts`
Expected: FAIL — plugin missing; cannot find `../firebase.json`.

- [ ] **Step 3: Implement config.**
  - `app.json`: in the `@react-native-firebase/analytics` plugin set `"withoutAdIdSupport": false`; right after that plugin add

```json
      [
        "expo-tracking-transparency",
        {
          "userTrackingPermission": "Usamos o identificador de publicidade só para medir quais anúncios trouxeram você ao termhub."
        }
      ],
```

  - `app.json`: `"version": "0.5.0"`, `"versionCode": 6`. `apps/mobile/package.json`: `"version": "0.5.0"`.
  - `apps/mobile/firebase.json`:

```json
{
  "react-native": {
    "google_analytics_default_allow_analytics_storage": true,
    "google_analytics_default_allow_ad_storage": false,
    "google_analytics_default_allow_ad_user_data": false,
    "google_analytics_default_allow_ad_personalization_signals": false
  }
}
```

- [ ] **Step 4: Run config tests.**
Run: `npm test -w @termhub/mobile -- src/app-config.test.ts`
Expected: PASS.

- [ ] **Step 5: Check the native projects pick it up.**
Run: `cd apps/mobile && npx expo prebuild --clean --no-install && grep -n "NSUserTrackingUsageDescription" ios/*/Info.plist && grep -n "RNFirebaseAnalyticsWithoutAdIdSupport" ios/Podfile; grep -rn "google_analytics_default_allow_ad_storage" ios android | head -3`
Expected: `NSUserTrackingUsageDescription` present; `RNFirebaseAnalyticsWithoutAdIdSupport` **absent** from the Podfile; the consent default shows up in the generated `firebase.json` build script or `Info.plist`/`AndroidManifest`. `ios/` and `android/` are gitignored — do not commit them.

- [ ] **Step 6: README.** In `apps/mobile/README.md`, change the push **Registration** bullet to: `- **Registration.** At every session start (activation or unlock, never a silent renewal), and right after the primer gets a grant, the session store asks for the phone's Expo push token and sends it, fire-and-forget. The token is read only once the permission is granted: the OS prompt comes from the notification primer (after the first message the server accepts, or on the Notificações tab) or from Ajustes, never from a session start. A simulator, a permission not granted or a build without extra.eas.projectId has no token, and nothing is sent. Mock mode keeps sending the fake ExponentPushToken[mock-…].` Then add under the push section:

```markdown
### Permission prompts

`src/features/permissions` (spec `docs/superpowers/specs/2026-09-30-mobile-permission-prompts-design.md`) asks for two things in context: notifications (a primer sheet, at most twice) and ad measurement (a Home card; ATT on iOS, our own yes on Android). Ad consent is denied by default in `firebase.json` and only granted by the person; it can be changed in Ajustes → Privacidade.
```

- [ ] **Step 7: Full verification.**
Run: `npm run typecheck -w @termhub/mobile && npm test -w @termhub/mobile`
Expected: PASS.

- [ ] **Step 8: Commit.**

```bash
git add apps/mobile/app.json apps/mobile/package.json apps/mobile/firebase.json apps/mobile/src/app-config.test.ts apps/mobile/README.md
git commit -m "Mobile 0.5.0: ATT and advertising id for ad measurement

New native module and AdSupport: a new binary, so the version moves
and older binaries keep their own OTA line."
```

---

### Task 8: Manual check on devices and the pull request

- [ ] **Step 1: iOS simulator (idb drives it; see the project memory on simulator automation).** Build a dev client: `cd apps/mobile && npx expo run:ios`. Fresh install, enrol in mock mode, create the PIN:
  - Home shows "Ajude a medir nossos anúncios"; "Permitir" shows the system ATT prompt with the pt-BR reason; after "Allow" the card is gone and Ajustes → Privacidade shows the switch on.
  - No notification prompt appeared at the PIN.
  - Open a chat, send a message: the primer sheet appears; "Ativar notificações" shows the system prompt.
  - Ajustes → Notificações shows "Ativadas neste aparelho."
  - Settings app → Privacy → Tracking → off; back in the app, lock and unlock: Ajustes → Privacidade switch is off.
- [ ] **Step 2: Android emulator (API 34).** `npx expo run:android`; same flow: the card has no system prompt behind "Permitir"; the primer's "Ativar notificações" shows the Android 13 prompt.
- [ ] **Step 3: Open ONE pull request** from `feat/mobile-permission-prompts` with every task's commits. Title: `Mobile: contextual permission prompts and ad measurement consent`. Body: summary, the spec path, "Needs a new binary (0.5.0)", the maintainer's manual steps (spec §6: App Store privacy label, Play Data safety, privacy policy, Google Ads link), and:

```markdown
## Impact on other users

Every phone app user gets it. Someone who has not decided on notifications no longer sees the bare OS prompt after "Criar PIN"; the primer comes after their first message. Ad measurement is opt-in per device, denied by default, reversible in Ajustes. Server, web and landing are unchanged.
```

- [ ] **Step 4:** After merge, the OTA workflow publishes under `0.5.0`, which no installed binary runs yet; 0.4.0 binaries keep their line. Ship the 0.5.0 binary through the documented release script.
