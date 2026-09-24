# Mobile app — architecture and the mocked first cut — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The termhub phone app runs end to end on a development build with no server — enrolment, PIN, unlock, chats with streaming answers, action approval with the PIN, lock-out, device removal — through the real HTTP + WebSocket client over an in-memory transport that answers the server's contract.

**Architecture:** MVVM by feature (`src/features/<f>/{model,viewmodel,view}`), zustand stores persisted in MMKV as the viewmodels, secrets in SecureStore, NativeWind for styling. One `HttpMobileApi` over a `Transport` port; `MockTransport` routes the same URLs, validates with the same zod schemas and verifies DPoP proofs. The session store owns a phase machine the router reads.

**Tech Stack:** Expo SDK 57 / React Native 0.86 / React 19.2.3, expo-router, NativeWind 4 + Tailwind 3.4, zustand 5, react-native-mmkv 3, expo-secure-store, expo-local-authentication, @noble/hashes 2 + @noble/curves 2, @pagopa/io-react-native-crypto, react-native-markdown-display, zod 3; Jest (jest-expo) with the `logic` and `ui` projects.

**Spec:** `docs/superpowers/specs/2026-09-24-mobile-app-mock-design.md` (this plan's spec, **S§n**) and `docs/superpowers/specs/2026-09-24-mobile-chat-app-design.md` (the product spec, **P§n**). Read both first.

## Global Constraints

- Code, comments, commit messages in English; **every string a person sees in pt-BR** (CLAUDE.md).
- Views never call a service; viewmodels and models never import `react-native`, `expo-router` or anything under `src/ui` — the `logic` Jest project throws on `react-native` (S§2).
- Secrets (`request_secret`, access token, unwrapped `pin_secret`, private key, challenge) are **never** written to MMKV or logged; only `pin.wrapped`, `pin.salt`, `pin.biometric`, `key.private`, `device.id` go to SecureStore (S§5.1). Nothing in `console.*` ever prints a token, proof, PIN, secret or chat text.
- The PIN is never compared locally (P§5.4); `scrypt` params `N: 2 ** 14, r: 8, p: 1, dkLen: 32` (async, so the JS thread is not blocked); `pin_proof = base64url(HMAC-SHA256(pin_secret, challenge))`; decision proof message `${challenge}\n${actionId}\napprove` (P§5.6, `packages/mobile-api/src/proofs.ts`).
- DPoP proof: header `{ typ: 'dpop+jwt', alg: 'ES256', jwk }`, payload `{ htm, htu, iat, jti, ath?, chal? }`, `htu = canonicalHtu(TERMHUB_URL, path)`; ES256 signature = raw `r‖s` (64 bytes) base64url (P§5.2). `X-Termhub-App: <platform>/<x.y.z>+<build>` on every call (P§6).
- Contract schemas are copied verbatim from `packages/mobile-api/src` at commit `c6bab0a` (branch `feat/mobile-chat-server`) into `src/services/api/contract/`, with that commit in a header comment; local additions live only in `contract/local.ts`.
- Lifetimes, verbatim from P: access token 15 min; device request 10 min; activation window 10 min; challenge 60 s; `jti` window 5 min; `iat` skew ±60 s; PIN lock 15 min at 3 failures, revocation at 6; relock after 5 min in background; poll every `poll_after` ms (2000 in the mock).
- Green means: `npm test -w @termhub/mobile` and `npm run typecheck -w @termhub/mobile` (through Docker on jarvis: `S=<scratchpad>; $S/dn.sh 'npm test -w @termhub/mobile'`), plus the root `npm run build -w @termhub/web` untouched. Commit after every task.
- Route files under `app/` stay one-liners that render a view from `src/features/*/view`.

## Review Focus

1. **A `jti` reused by a flaky client retry.** The mock answers `401 PROOF_REPLAYED`, and the client must *not* renew the token for it (renewal is only for `TOKEN_EXPIRED`); the store shows the generic error. (Task 8, test "a replayed jti is 401 PROOF_REPLAYED and not a token renewal"; Task 6, test "only TOKEN_EXPIRED triggers renewal".)
2. **The person kills the app on the PIN screen after approval.** No device exists yet (P§4.5): a cold start must land on Início, not on Criar PIN or Desbloquear. (Task 10, test "waiting and pin_setup do not survive a restart".)
3. **A wrong PIN when the phone's clock is 3 minutes fast.** The proof's `iat` must use the corrected clock, otherwise every call fails as `PROOF_INVALID` and the person reads it as "PIN incorreto". (Task 6, test "iat is corrected by the Date skew"; Task 8, test "a proof outside the ±60 s window is PROOF_INVALID, not a PIN failure".)
4. **The socket drops while an answer streams.** On reconnect the thread must be re-read, never replayed, and deltas seen before the drop must not be glued twice. (Task 7, test "reconnect calls onReconnect and drops the old buffer"; Task 13, test "a reconnect re-reads the conversation".)
5. **A `decision` event for an action already decided from the phone.** The card must not flip back to pending or duplicate. (Task 13, test "a decision event updates the card by id and is idempotent".)

## File structure

```
apps/mobile/
  app/_layout.tsx                          root: polyfill, ThemeProvider, phase redirect (Task 11)
  app/index.tsx, enrol/*, unlock.tsx, (tabs)/*, chat/[id].tsx   one-liners over views
  global.css, tailwind.config.js, nativewind-env.d.ts, css.d.ts, babel.config.js, metro.config.js (Task 1)
  src/theme/tokens.ts                      palette for light/dark as CSS vars (Task 1)
  src/ui/*.tsx                             Screen, AppText, Button, Field, PinDots, PinPad, Sheet, Countdown, EmptyState, Banner (Task 1)
  src/features/theme/viewmodel/useThemeStore.ts, src/ui/theme-provider.tsx (Task 1)
  src/services/storage.ts, vault.ts        MMKV + zustand storage; SecureStore wrapper (Task 2)
  src/features/shared/signals.ts, relative-time.ts (Task 2)
  test/logic-setup.js, test/fakes/*.js     RN guard, MMKV/SecureStore/Device/LocalAuth fakes (Task 2)
  src/services/crypto/encoding.ts, random.ts, pin.ts   base64url/utf8, randomBytes, wrap/unwrap/proofs (Task 3)
  src/services/key/{types,software,hardware,jwk,index}.ts   DeviceKey port (Task 4)
  src/services/api/dpop.ts                 buildProof / verifyProof (Task 4)
  src/services/api/contract/*.ts, errors.ts, transport.ts (Task 5)
  src/services/api/client.ts, index.ts     HttpMobileApi (Task 6)
  src/services/api/socket.ts               ChatSocket (Task 7)
  src/services/api/mock/{state,router,transport,controls,fixtures,index}.ts (Tasks 8–9)
  src/features/session/{model,viewmodel,view}   (Tasks 10–11)
  src/features/chat/{model,viewmodel,view}      (Tasks 12–13)
  src/features/notifications/*, src/features/settings/*   (Task 14)
  apps/mobile/README.md                    updated (Task 14)
```

---

### Task 1: NativeWind, tokens, theme and the base UI kit

**Files:**
- Create: `apps/mobile/global.css`, `tailwind.config.js`, `nativewind-env.d.ts`, `css.d.ts`, `src/theme/tokens.ts`, `src/features/theme/viewmodel/useThemeStore.ts`, `src/ui/theme-provider.tsx`, `src/ui/screen.tsx`, `src/ui/text.tsx`, `src/ui/button.tsx`, `src/ui/field.tsx`, `src/ui/pin-dots.tsx`, `src/ui/pin-pad.tsx`, `src/ui/sheet.tsx`, `src/ui/countdown.tsx`, `src/ui/empty-state.tsx`, `src/ui/banner.tsx`, `src/ui/index.ts`
- Modify: `babel.config.js`, `metro.config.js`, `jest.config.js`, `tsconfig.json` (include the two `.d.ts`), `app/_layout.tsx` (wrap in `ThemeProvider`, import `global.css`), `src/ui/placeholder.tsx` (use the kit)
- Test: `src/ui/button.test.tsx`, `src/ui/pin-pad.test.tsx`

**Interfaces:**
- Produces: `Screen({ children, scroll?, padded? })`, `AppText({ variant: 'title'|'body'|'muted'|'code'|'label', children, className? })`, `Button({ label, onPress, variant?: 'primary'|'secondary'|'danger'|'ghost', loading?, disabled?, testID? })`, `Field({ label, value, onChangeText, placeholder?, keyboardType?, autoCapitalize?, secureTextEntry?, error?, testID? })`, `PinDots({ length: 6, filled: number, error?: boolean })`, `PinPad({ onDigit(d: string), onBackspace(), onBiometrics?(), disabled? })`, `Sheet({ open, onClose, title, children })`, `Countdown({ until: string, onExpire? })` renders `mm:ss`, `EmptyState({ title, hint })`, `Banner({ tone: 'info'|'danger', text })`. `useThemeStore` `{ theme: 'system'|'light'|'dark', setTheme }` persisted under `theme`. Colour utilities `bg-app-bg`, `bg-app-surface`, `border-app-border`, `text-app-text`, `text-app-muted`, `bg-app-accent`, `text-app-accent`, `bg-app-danger`, `text-app-ok`.

- [ ] **Step 1: Wire NativeWind**

`global.css`:
```css
@tailwind base;
@tailwind components;
@tailwind utilities;
```
`nativewind-env.d.ts`: `/// <reference types="nativewind/types" />` — `css.d.ts`: `declare module '*.css';`

`tailwind.config.js`:
```js
const keys = ['bg', 'surface', 'surface2', 'border', 'text', 'muted', 'accent', 'accent-soft', 'danger', 'ok'];
/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: 'class',
  content: ['./app/**/*.{ts,tsx}', './src/**/*.{ts,tsx}'],
  presets: [require('nativewind/preset')],
  theme: { extend: { colors: Object.fromEntries(keys.map((k) => [`app-${k}`, `var(--app-${k})`])) } },
  plugins: [],
};
```
`babel.config.js`:
```js
module.exports = function (api) {
  api.cache(true);
  return { presets: [['babel-preset-expo', { jsxImportSource: 'nativewind' }], 'nativewind/babel'] };
};
```
`metro.config.js`:
```js
const { getDefaultConfig } = require('expo/metro-config');
const { withNativeWind } = require('nativewind/metro');
// expo/metro-config detects the npm workspace root on its own; only NativeWind is layered on.
module.exports = withNativeWind(getDefaultConfig(__dirname), { input: './global.css' });
```
`tsconfig.json` `include`: add `"nativewind-env.d.ts", "css.d.ts"`.

`jest.config.js` — the `ui` project must transform nativewind and css-interop; keep jest-expo's own list and extend it:
```js
const expoPreset = require('jest-expo/jest-preset');
const [expoIgnore, ...restIgnore] = expoPreset.transformIgnorePatterns;
const uiTransformIgnore = [expoIgnore.replace('))', '|nativewind|react-native-css-interop|react-native-markdown-display))'), ...restIgnore];
```
and in the `ui` project: `transformIgnorePatterns: uiTransformIgnore,` plus `moduleNameMapper` gaining `'\\.css$': '<rootDir>/test/css-stub.js'` (file: `module.exports = {};`). The `logic` project's `moduleNameMapper` also maps `^@/(.*)$`.

- [ ] **Step 2: Tokens, theme store, provider**

`src/theme/tokens.ts`:
```ts
export type SchemeName = 'light' | 'dark';
export const tokens: Record<SchemeName, Record<string, string>> = {
  dark: { bg: '#0B0F19', surface: '#121828', surface2: '#1A2136', border: '#232B41', text: '#F3F4F6', muted: '#9CA3AF', accent: '#7C87F7', 'accent-soft': '#2A3170', danger: '#F87171', ok: '#4ADE80' },
  light: { bg: '#F7F8FC', surface: '#FFFFFF', surface2: '#EEF0F8', border: '#D9DDEA', text: '#0F1320', muted: '#5B6275', accent: '#5B63D3', 'accent-soft': '#E4E6FB', danger: '#DC2626', ok: '#15803D' },
};
export const cssVars = (scheme: SchemeName) => Object.fromEntries(Object.entries(tokens[scheme]).map(([k, v]) => [`--app-${k}`, v]));
```
`src/features/theme/viewmodel/useThemeStore.ts` (zustand + persist over `mmkvStateStorage` from Task 2 — until Task 2 lands, import it from a one-line `src/services/storage.ts` created here with the MMKV instance and the `StateStorage`; Task 2 only extends that file):
```ts
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { mmkvStateStorage } from '@/services/storage';
export type ThemePreference = 'system' | 'light' | 'dark';
interface ThemeState { theme: ThemePreference; setTheme(theme: ThemePreference): void }
export const useThemeStore = create<ThemeState>()(persist((set) => ({ theme: 'system', setTheme: (theme) => set({ theme }) }), { name: 'theme', storage: createJSONStorage(() => mmkvStateStorage) }));
```
`src/services/storage.ts` (initial):
```ts
import { MMKV } from 'react-native-mmkv';
import type { StateStorage } from 'zustand/middleware';
export const mmkv = new MMKV({ id: 'termhub' });
export const mmkvStateStorage: StateStorage = {
  getItem: (name) => mmkv.getString(name) ?? null,
  setItem: (name, value) => { mmkv.set(name, value); },
  removeItem: (name) => { mmkv.delete(name); },
};
```
`src/ui/theme-provider.tsx`:
```tsx
import { colorScheme, vars } from 'nativewind';
import { useEffect, useMemo, type ReactNode } from 'react';
import { View, useColorScheme } from 'react-native';
import { useThemeStore } from '@/features/theme/viewmodel/useThemeStore';
import { cssVars, type SchemeName } from '@/theme/tokens';

export function useSchemeName(): SchemeName {
  const pref = useThemeStore((s) => s.theme);
  const system = useColorScheme();
  return pref === 'system' ? (system === 'light' ? 'light' : 'dark') : pref;
}
export function ThemeProvider({ children }: { children: ReactNode }) {
  const scheme = useSchemeName();
  const style = useMemo(() => vars(cssVars(scheme)), [scheme]);
  useEffect(() => { colorScheme.set(scheme); }, [scheme]);
  return <View style={style} className="flex-1 bg-app-bg">{children}</View>;
}
```

- [ ] **Step 3: Write the failing UI tests**

`src/ui/button.test.tsx`:
```tsx
import { fireEvent, render, screen } from '@testing-library/react-native';
import { Button } from './button';

describe('Button', () => {
  it('calls onPress and exposes its label as the accessible name', async () => {
    const onPress = jest.fn();
    await render(<Button label="Continuar" onPress={onPress} />);
    fireEvent.press(screen.getByRole('button', { name: 'Continuar' }));
    expect(onPress).toHaveBeenCalledTimes(1);
  });
  it('does not fire while loading and shows the spinner', async () => {
    const onPress = jest.fn();
    await render(<Button label="Enviar" onPress={onPress} loading />);
    fireEvent.press(screen.getByRole('button', { name: 'Enviar' }));
    expect(onPress).not.toHaveBeenCalled();
    expect(screen.getByTestId('button-spinner')).toBeTruthy();
  });
});
```
`src/ui/pin-pad.test.tsx`:
```tsx
import { fireEvent, render, screen } from '@testing-library/react-native';
import { PinPad } from './pin-pad';

describe('PinPad', () => {
  it('reports digits and backspace, and shows the biometrics key only when offered', async () => {
    const onDigit = jest.fn();
    const onBackspace = jest.fn();
    await render(<PinPad onDigit={onDigit} onBackspace={onBackspace} />);
    fireEvent.press(screen.getByRole('button', { name: '7' }));
    fireEvent.press(screen.getByRole('button', { name: 'Apagar' }));
    expect(onDigit).toHaveBeenCalledWith('7');
    expect(onBackspace).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Biometria' })).toBeNull();
  });
});
```

- [ ] **Step 4: Run them and watch them fail**

Run: `npm test -w @termhub/mobile -- --selectProjects ui`. Expected: both suites fail (modules missing).

- [ ] **Step 5: The kit**

`src/ui/text.tsx`:
```tsx
import { Text, type TextProps } from 'react-native';
const variants = { title: 'text-2xl font-semibold text-app-text', body: 'text-base text-app-text', muted: 'text-sm text-app-muted', code: 'text-4xl font-semibold tracking-widest text-app-text', label: 'text-xs uppercase tracking-wide text-app-muted' } as const;
export function AppText({ variant = 'body', className = '', ...rest }: TextProps & { variant?: keyof typeof variants; className?: string }) {
  return <Text className={`${variants[variant]} ${className}`} {...rest} />;
}
```
`src/ui/button.tsx`:
```tsx
import { ActivityIndicator, Pressable, Text } from 'react-native';
type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';
const box: Record<Variant, string> = { primary: 'bg-app-accent', secondary: 'bg-app-surface2 border border-app-border', danger: 'bg-app-danger', ghost: '' };
const text: Record<Variant, string> = { primary: 'text-white', secondary: 'text-app-text', danger: 'text-white', ghost: 'text-app-accent' };
export function Button({ label, onPress, variant = 'primary', loading = false, disabled = false, testID }: { label: string; onPress(): void; variant?: Variant; loading?: boolean; disabled?: boolean; testID?: string }) {
  const off = disabled || loading;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled: off, busy: loading }} onPress={off ? undefined : onPress} testID={testID}
      className={`rounded-xl px-4 py-3.5 items-center justify-center ${box[variant]} ${off ? 'opacity-60' : ''}`}>
      {loading ? <ActivityIndicator testID="button-spinner" color="#fff" /> : <Text className={`text-base font-semibold ${text[variant]}`}>{label}</Text>}
    </Pressable>
  );
}
```
`src/ui/pin-pad.tsx` — a 3×4 grid of `Pressable`s with `accessibilityRole="button"` and `accessibilityLabel` = the digit, `'Apagar'` for backspace and `'Biometria'` for the optional key (rendered only when `onBiometrics` is given); `src/ui/pin-dots.tsx` — six 14px circles, filled ones `bg-app-accent`, all `bg-app-danger` when `error`; `src/ui/screen.tsx` — `SafeAreaView` from `react-native-safe-area-context` with `className="flex-1 bg-app-bg"` and an inner `View`/`ScrollView` with `px-6 py-4`; `src/ui/field.tsx` — label (`AppText label`), `TextInput` with `className="rounded-xl border border-app-border bg-app-surface px-4 py-3 text-base text-app-text"`, error line in `text-app-danger`; `src/ui/sheet.tsx` — `Modal transparent animationType="slide"` with a backdrop `Pressable` calling `onClose` and a bottom panel `bg-app-surface rounded-t-3xl p-6`; `src/ui/countdown.tsx` — `useEffect` interval of 1 s computing `max(0, until - now)` as `mm:ss`, calls `onExpire` once at zero; `src/ui/empty-state.tsx` and `src/ui/banner.tsx` — one `View` with texts. `src/ui/index.ts` re-exports everything. `src/ui/placeholder.tsx` now uses `Screen` + `AppText`.

`app/_layout.tsx`:
```tsx
import 'react-native-get-random-values';
import '../global.css';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { ThemeProvider, useSchemeName } from '@/ui/theme-provider';

function Navigator() {
  const scheme = useSchemeName();
  return (<><StatusBar style={scheme === 'dark' ? 'light' : 'dark'} /><Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: 'transparent' } }} /></>);
}
export default function RootLayout() { return <ThemeProvider><Navigator /></ThemeProvider>; }
```

- [ ] **Step 6: Green, then commit**

Run: `npm test -w @termhub/mobile && npm run typecheck -w @termhub/mobile`. Expected: PASS (the existing `app/index.test.tsx` still passes; `test/ui-setup.js` gains `jest.mock('react-native-mmkv', …)` with the in-memory fake of Task 2's `test/fakes/mmkv.js` — create that file now, Task 2 reuses it).

```bash
git add apps/mobile && git commit -m "Mobile: NativeWind, theme tokens and the base UI kit"
```

---

### Task 2: Storage, vault, signals and the logic-project fakes

**Files:**
- Modify: `apps/mobile/src/services/storage.ts` (add `resetPersistedStores()` helper), `jest.config.js` (logic project `setupFiles: ['<rootDir>/test/logic-setup.js']`), `test/ui-setup.js` (mock SecureStore/Device/LocalAuthentication too)
- Create: `src/services/vault.ts`, `src/features/shared/signals.ts`, `src/features/shared/relative-time.ts`, `test/logic-setup.js`, `test/fakes/mmkv.js`, `test/fakes/secure-store.js`, `test/fakes/expo-device.js`, `test/fakes/local-auth.js`
- Test: `src/services/vault.test.ts`, `src/features/shared/signals.test.ts`, `src/features/shared/relative-time.test.ts`

**Interfaces:**
- Produces: `vault.get(key): Promise<string|null>`, `vault.set(key, value, { biometric?: boolean })`, `vault.delete(key)`, `vault.clear()` over the closed key set `VaultKey = 'key.private' | 'pin.wrapped' | 'pin.salt' | 'pin.biometric' | 'device.id'`; `signal()` → `{ subscribe(fn): () => void; emit(): void }`; `sessionEnded` signal; `relativeTime(iso, now): string` ("agora", "há 3 min", "há 2 h", "ontem", "12/09").

- [ ] **Step 1: Fakes and the RN guard**

`test/fakes/mmkv.js`:
```js
/* global jest */
const store = new Map();
class MMKV { getString(k) { return store.get(k); } set(k, v) { store.set(k, String(v)); } delete(k) { store.delete(k); } contains(k) { return store.has(k); } getAllKeys() { return [...store.keys()]; } clearAll() { store.clear(); } }
module.exports = { MMKV, __store: store };
```
`test/fakes/secure-store.js`:
```js
const items = new Map();
module.exports = {
  __items: items,
  getItemAsync: async (k) => items.get(k) ?? null,
  setItemAsync: async (k, v) => { items.set(k, v); },
  deleteItemAsync: async (k) => { items.delete(k); },
  canUseBiometricAuthentication: () => true,
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY',
};
```
`test/fakes/expo-device.js`: `module.exports = { modelName: 'iPhone15,2', osVersion: '18.1', deviceName: 'iPhone de teste', osName: 'iOS' };` — `test/fakes/local-auth.js`: `module.exports = { hasHardwareAsync: async () => true, isEnrolledAsync: async () => true, authenticateAsync: async () => ({ success: true }) };`

`test/logic-setup.js`:
```js
/* global jest */
// MVVM guard (spec §2): models, viewmodels and services must run without React Native.
jest.mock('react-native', () => { throw new Error('react-native must not be imported by models, viewmodels or services'); });
jest.mock('expo-router', () => { throw new Error('expo-router must not be imported by models, viewmodels or services'); });
jest.mock('react-native-mmkv', () => require('./fakes/mmkv'));
jest.mock('expo-secure-store', () => require('./fakes/secure-store'));
jest.mock('expo-device', () => require('./fakes/expo-device'));
jest.mock('expo-application', () => ({ nativeApplicationVersion: '0.1.0', nativeBuildVersion: '1' }));
jest.mock('expo-local-authentication', () => require('./fakes/local-auth'));
jest.mock('expo-constants', () => ({ __esModule: true, default: { expoConfig: { scheme: 'termhub' } } }));
jest.mock('@pagopa/io-react-native-crypto', () => ({ generate: jest.fn(), sign: jest.fn(), getPublicKeyFixed: jest.fn(), deleteKey: jest.fn() }));
```
`jest.config.js`: logic project gains `setupFiles: ['<rootDir>/test/logic-setup.js']`; `test/ui-setup.js` gains the same `jest.mock` lines for mmkv, secure-store, expo-device, expo-application, expo-local-authentication and the crypto module (not the RN guard).

- [ ] **Step 2: Failing tests**

`src/services/vault.test.ts`:
```ts
import { __items } from '../../test/fakes/secure-store';
import { vault } from './vault';

describe('vault', () => {
  beforeEach(() => __items.clear());
  it('round-trips a value and clears every key it owns', async () => {
    await vault.set('pin.salt', 'abc');
    expect(await vault.get('pin.salt')).toBe('abc');
    await vault.set('device.id', 'd1');
    await vault.clear();
    expect(await vault.get('pin.salt')).toBeNull();
    expect(await vault.get('device.id')).toBeNull();
  });
});
```
`src/features/shared/signals.test.ts`: subscribe → emit calls the listener once; the returned unsubscribe stops it. `src/features/shared/relative-time.test.ts`: `relativeTime('2026-09-24T12:00:00Z', Date.parse('2026-09-24T12:00:20Z'))` → `'agora'`; 3 min → `'há 3 min'`; 2 h → `'há 2 h'`; 26 h → `'ontem'`; 5 days → `'19/09'`.

- [ ] **Step 3: Run, fail. Step 4: implement**

`src/services/vault.ts`:
```ts
import * as SecureStore from 'expo-secure-store';
export type VaultKey = 'key.private' | 'pin.wrapped' | 'pin.salt' | 'pin.biometric' | 'device.id';
const KEYS: VaultKey[] = ['key.private', 'pin.wrapped', 'pin.salt', 'pin.biometric', 'device.id'];
const opts = (biometric: boolean): SecureStore.SecureStoreOptions => ({ keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY, requireAuthentication: biometric, authenticationPrompt: 'Desbloquear o termhub' });
export const vault = {
  get: (key: VaultKey, biometric = false) => SecureStore.getItemAsync(key, opts(biometric)),
  set: (key: VaultKey, value: string, { biometric = false } = {}) => SecureStore.setItemAsync(key, value, opts(biometric)),
  delete: (key: VaultKey) => SecureStore.deleteItemAsync(key),
  clear: async () => { for (const k of KEYS) await SecureStore.deleteItemAsync(k).catch(() => undefined); },
};
```
`src/features/shared/signals.ts` — the Opa Pingou `signal()` verbatim plus `export const sessionEnded = signal();`. `relative-time.ts` as the test describes (`pt-BR` day/month with `padStart`).

- [ ] **Step 5: Green, commit**

```bash
git add apps/mobile && git commit -m "Mobile: MMKV storage, SecureStore vault, signals and the logic-project fakes"
```

---

### Task 3: Encoding, randomness and the PIN model

**Files:**
- Create: `src/services/crypto/encoding.ts`, `src/services/crypto/random.ts`, `src/services/crypto/pin.ts`
- Test: `src/services/crypto/encoding.test.ts`, `src/services/crypto/pin.test.ts`

**Interfaces:**
- Produces: `b64url(bytes: Uint8Array): string`, `fromB64url(s: string): Uint8Array`, `utf8(s: string): Uint8Array`, `fromUtf8(b: Uint8Array): string`; `randomBytes(n): Uint8Array`, `randomId(bytes = 16): string` (base64url); `deriveWrapKey(pin: string, salt: Uint8Array): Promise<Uint8Array>`, `wrapSecret(secret, key): Uint8Array` (XOR), `unwrapSecret(wrapped, key): Uint8Array` (same XOR), `pinProof(secret: Uint8Array, challenge: string): string`, `decisionProof(secret, challenge, actionId): string`, `PIN_RE = /^\d{6}$/`.

- [ ] **Step 1: Failing tests**

`encoding.test.ts`: `b64url(new Uint8Array([251, 255, 191]))` → `'-_-_'`; `fromB64url('-_-_')` → those bytes; round-trip of 0..255; no `=` padding ever; `fromUtf8(utf8('máquina'))` → `'máquina'`.

`pin.test.ts`:
```ts
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { b64url, utf8 } from './encoding';
import { decisionProof, deriveWrapKey, pinProof, unwrapSecret, wrapSecret } from './pin';

const secret = new Uint8Array(32).map((_, i) => i * 7 % 256);
const salt = new Uint8Array(16).fill(3);

describe('pin model', () => {
  it('wraps and unwraps with the right PIN', async () => {
    const k = await deriveWrapKey('123456', salt);
    expect(unwrapSecret(wrapSecret(secret, k), k)).toEqual(secret);
  });
  it('any PIN unwraps to 32 plausible bytes — nothing tells a wrong one apart offline', async () => {
    const wrapped = wrapSecret(secret, await deriveWrapKey('123456', salt));
    const wrong = unwrapSecret(wrapped, await deriveWrapKey('654321', salt));
    expect(wrong).toHaveLength(32);
    expect(wrong).not.toEqual(secret);
  });
  it('pin_proof is base64url(HMAC-SHA256(secret, challenge))', () => {
    expect(pinProof(secret, 'chal')).toBe(b64url(hmac(sha256, secret, utf8('chal'))));
  });
  it('decision proof signs challenge, action id and "approve", newline-separated', () => {
    expect(decisionProof(secret, 'c1', 'a1')).toBe(b64url(hmac(sha256, secret, utf8('c1\na1\napprove'))));
  });
});
```

- [ ] **Step 2: Run, fail. Step 3: implement**

`encoding.ts` — pure JS base64url with a 64-char alphabet table (no `Buffer`, no `atob`: Hermes has `atob` but the logic project must not depend on it); `utf8` via `TextEncoder`/`TextDecoder` (present in Hermes and Node). `random.ts`: `import { randomBytes } from '@noble/hashes/utils.js'` re-exported, and `randomId = (n = 16) => b64url(randomBytes(n))`. `pin.ts`:
```ts
import { hmac } from '@noble/hashes/hmac.js';
import { scryptAsync } from '@noble/hashes/scrypt.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { b64url, utf8 } from './encoding';
export const PIN_RE = /^\d{6}$/;
export const deriveWrapKey = (pin: string, salt: Uint8Array) => scryptAsync(utf8(pin), salt, { N: 2 ** 14, r: 8, p: 1, dkLen: 32 });
export const wrapSecret = (secret: Uint8Array, key: Uint8Array) => secret.map((b, i) => b ^ (key[i] ?? 0));
export const unwrapSecret = wrapSecret; // XOR is its own inverse; no tag on purpose (P§5.4)
export const pinProof = (secret: Uint8Array, challenge: string) => b64url(hmac(sha256, secret, utf8(challenge)));
export const decisionProof = (secret: Uint8Array, challenge: string, actionId: string) => b64url(hmac(sha256, secret, utf8(`${challenge}\n${actionId}\napprove`)));
```

- [ ] **Step 4: Green, commit** — `git commit -m "Mobile: base64url, randomness and the PIN wrap/proof model"`

---

### Task 4: The DeviceKey port and DPoP proofs

**Files:**
- Create: `src/services/key/types.ts`, `src/services/key/jwk.ts`, `src/services/key/software.ts`, `src/services/key/hardware.ts`, `src/services/key/index.ts`, `src/services/api/dpop.ts`
- Test: `src/services/key/software.test.ts`, `src/services/key/jwk.test.ts`, `src/services/api/dpop.test.ts`

**Interfaces:**
- Produces:
  ```ts
  interface DeviceKey { create(): Promise<P256Jwk>; exists(): Promise<boolean>; publicJwk(): Promise<P256Jwk>; sign(message: Uint8Array): Promise<Uint8Array> /* raw r‖s, 64 bytes */; destroy(): Promise<void> }
  type P256Jwk = { kty: 'EC'; crv: 'P-256'; x: string; y: string };
  jwkThumbprint(jwk: P256Jwk): string;                          // RFC 7638, base64url(sha256(canonical JSON))
  jwkFromUncompressed(point: Uint8Array): P256Jwk;               // 65 bytes 0x04‖X‖Y
  derToRaw(der: Uint8Array): Uint8Array;                         // ECDSA DER → r‖s (64)
  buildProof(key: DeviceKey, input: { htm: string; htu: string; iat: number; ath?: string; chal?: string }): Promise<string>;  // compact JWS
  verifyProof(jws: string, expected: { htm: string; htu: string; now: number; skewSeconds?: number; jwk: P256Jwk; ath?: string; chal?: string }): { ok: true; jti: string; iat: number } | { ok: false; reason: 'SIGNATURE' | 'HTM' | 'HTU' | 'IAT' | 'ATH' | 'CHAL' | 'MALFORMED' };
  export const deviceKey: DeviceKey;                             // software under mock mode / Jest, hardware otherwise
  ```

- [ ] **Step 1: Failing tests**

`software.test.ts`: `create()` returns a JWK with 43-char `x`/`y`; `exists()` false → true; `sign(utf8('m'))` is 64 bytes and verifies with `p256.verify(sig, utf8('m'), pubBytes, { prehash: true })` (`pubBytes` rebuilt from the JWK); `destroy()` makes `exists()` false and `sign` reject; the private key lives in the vault as `key.private` (base64url of 32 bytes) and survives a new `SoftwareDeviceKey()` instance.

`jwk.test.ts`: `jwkThumbprint` of the RFC 7638 §3.1 example EC key? That example is RSA; use a computed vector: thumbprint equals `b64url(sha256(utf8('{"crv":"P-256","kty":"EC","x":"' + x + '","y":"' + y + '"}')))` for a fixed `x`/`y`; `derToRaw` of a hand-built DER `30 44 02 20 <r 32> 02 20 <s 32>` → `r‖s`, and of `30 45 02 21 00 <r 32 with high bit> 02 20 <s>` (leading zero stripped) → 64 bytes.

`dpop.test.ts`:
```ts
it('builds a proof the verifier accepts, and refuses a wrong htu, a stale iat, a wrong ath and a bad signature', async () => {
  const key = new SoftwareDeviceKey(); const jwk = await key.create();
  const jws = await buildProof(key, { htm: 'POST', htu: 'https://termhub.dev/api/m/v1/session/token', iat: 1_000, ath: 'A', chal: 'C' });
  expect(jws.split('.')).toHaveLength(3);
  expect(verifyProof(jws, { htm: 'POST', htu: 'https://termhub.dev/api/m/v1/session/token', now: 1_030, jwk, ath: 'A', chal: 'C' })).toMatchObject({ ok: true, iat: 1_000 });
  expect(verifyProof(jws, { htm: 'POST', htu: 'https://termhub.dev/api/m/v1/session/challenge', now: 1_030, jwk, ath: 'A', chal: 'C' })).toEqual({ ok: false, reason: 'HTU' });
  expect(verifyProof(jws, { htm: 'POST', htu: 'https://termhub.dev/api/m/v1/session/token', now: 1_100, jwk, ath: 'A', chal: 'C' })).toEqual({ ok: false, reason: 'IAT' });
  expect(verifyProof(jws, { htm: 'POST', htu: 'https://termhub.dev/api/m/v1/session/token', now: 1_030, jwk, ath: 'B', chal: 'C' })).toEqual({ ok: false, reason: 'ATH' });
  const other = await new SoftwareDeviceKey().create();
  expect(verifyProof(jws, { htm: 'POST', htu: 'https://termhub.dev/api/m/v1/session/token', now: 1_030, jwk: other, ath: 'A', chal: 'C' })).toEqual({ ok: false, reason: 'SIGNATURE' });
});
```
(Two `SoftwareDeviceKey` instances share the vault key `key.private`: the test for "other" must use a second vault key — give the constructor an optional `vaultKey` override, default `'key.private'`.)

- [ ] **Step 2: Run, fail. Step 3: implement**

`jwk.ts`: `jwkFromUncompressed` splits bytes 1–32 / 33–64; `jwkThumbprint` builds the canonical JSON with keys in lexicographic order (`crv, kty, x, y`); `derToRaw` parses `30 len 02 len r 02 len s`, strips leading zeros and left-pads to 32 each; `jwkToUncompressed(jwk)` → 65 bytes.

`software.ts`:
```ts
import { p256 } from '@noble/curves/nist.js';
import { b64url, fromB64url } from '../crypto/encoding';
import { vault, type VaultKey } from '../vault';
import { jwkFromUncompressed } from './jwk';
import type { DeviceKey, P256Jwk } from './types';
export class SoftwareDeviceKey implements DeviceKey {
  constructor(private readonly vaultKey: VaultKey = 'key.private') {}
  private async secret() { const s = await vault.get(this.vaultKey); if (!s) throw new Error('KEY_MISSING'); return fromB64url(s); }
  async create() { const sk = p256.utils.randomSecretKey(); await vault.set(this.vaultKey, b64url(sk)); return jwkFromUncompressed(p256.getPublicKey(sk, false)); }
  async exists() { return (await vault.get(this.vaultKey)) !== null; }
  async publicJwk() { return jwkFromUncompressed(p256.getPublicKey(await this.secret(), false)); }
  async sign(message: Uint8Array) { return p256.sign(message, await this.secret(), { prehash: true, format: 'compact' }); }
  async destroy() { await vault.delete(this.vaultKey); }
}
```
`hardware.ts`: `HardwareDeviceKey` over `@pagopa/io-react-native-crypto` with `KEY_TAG = 'dev.termhub.device'`: `create` → `generate(KEY_TAG)` (on `KEY_ALREADY_EXISTS`, `deleteKey` then retry) and normalise with `getPublicKeyFixed`; `exists` → `getPublicKeyFixed` resolves; `sign(message)` → `sign(fromUtf8(message), KEY_TAG)` (the module signs a UTF-8 string with SHA256withECDSA and returns **DER in base64**: decode standard base64, then `derToRaw`); `destroy` → `deleteKey`. Note in a comment that `message` must therefore be valid UTF-8 — the JWS signing input is ASCII, which it is.

`index.ts`: `export const deviceKey: DeviceKey = process.env.EXPO_PUBLIC_API_MODE === 'http' && process.env.NODE_ENV !== 'test' ? new HardwareDeviceKey() : new SoftwareDeviceKey();` — the mock mode uses the software key so simulators work (S§2).

`dpop.ts`: `buildProof` → `header = { typ: 'dpop+jwt', alg: 'ES256', jwk: await key.publicJwk() }`, `payload = { htm, htu, iat, jti: randomId(), ...(ath && { ath }), ...(chal && { chal }) }`, `input = b64url(utf8(JSON.stringify(header))) + '.' + b64url(utf8(JSON.stringify(payload)))`, `sig = await key.sign(utf8(input))`, return `input + '.' + b64url(sig)`. `verifyProof` → split, parse (MALFORMED on any failure or wrong `typ`/`alg`), compare `htm`, `htu`, `|iat - now| <= skewSeconds (60)`, `ath`, `chal` (each expected value present ⇒ must match; expected absent ⇒ payload must not carry it), then `p256.verify(fromB64url(sig), utf8(input), jwkToUncompressed(jwk), { prehash: true })` — verify **against the caller's jwk**, never the header's (P§5.2).

- [ ] **Step 4: Green, commit** — `git commit -m "Mobile: DeviceKey port (software and hardware) and DPoP proofs"`

---

### Task 5: The contract, errors and the transport port

**Files:**
- Create: `src/services/api/contract/version.ts`, `enrolment.ts`, `session.ts`, `chat.ts`, `events.ts`, `notifications.ts`, `proofs.ts` (copied), `contract/local.ts`, `contract/index.ts`, `src/services/api/errors.ts`, `src/services/api/transport.ts`
- Test: `src/services/api/contract/local.test.ts`, `src/services/api/errors.test.ts`

**Interfaces:**
- Produces: every schema of `packages/mobile-api` under the same names; in `local.ts`: `chatMessageSchema` (= events' `chatMessage`), `chatActionSchema` (`{ id, tool, args, class, status, machine_id, project_id, tab_id, summary, created_at }`), `chatHostStateSchema` (the discriminated union of the web's `ChatHostState`), `chatConversationSchema` (`{ id, title, project_id, machine_id?, ai_account_id?, archived_at, last_message_at }`), `chatResponse = { conversation, messages, actions, host }`, `meResponse = { user: { id, email, name }, permissions: string[], device: deviceSelf }`, `setHostBody = { machine_id, ai_account_id? }`, `resetBody = { project_id? }`, `errorBody = { error: string, code: string, attempts_left?: number, retry_after?: number }`; types `z.infer` of each exported as `TDeviceRequestBody`, `TChatResponse`, `TChatEvent`, … (prefix `T`). `ApiError` class `{ status, code, message, retryAfter?: number, attemptsLeft?: number }` with `static fromBody(status, headers, text)`. `Transport` interface exactly as S§4.1, plus `FetchTransport` (fetch + `WebSocket` with headers as `new WebSocket(url, undefined, { headers })` — React Native's signature; under Jest it is never constructed).

- [ ] **Step 1: Copy the contract**

Copy the seven files from `~/termhub-wt-mobile-spec/packages/mobile-api/src/` (worktree of the server branch at `c6bab0a`; `git -C ~/termhub-wt-mobile-spec show c6bab0a:packages/mobile-api/src/<file>`), each with the header:
```ts
// Copied verbatim from packages/mobile-api/src/<file> @ c6bab0a (feat/mobile-chat-server).
// Replaced by `import … from '@termhub/mobile-api'` once that package is on main. Do not edit here.
```
Tests copied too (`enrolment.test.ts`, `proofs.test.ts`, `version.test.ts`), converted from vitest to jest imports (`import { describe, expect, it } from 'vitest'` → nothing; jest globals).

- [ ] **Step 2: Failing tests** — `local.test.ts`: `chatResponse.parse(fixture)` succeeds for a host `{ kind: 'ready', machine: { id, name }, configDir: null, account: { kind: 'default' }, sessionAtStake: false }` and refuses `host.kind: 'nope'`; `errors.test.ts`: `ApiError.fromBody(423, { 'retry-after': '900' }, '{"error":"Aparelho bloqueado","code":"DEVICE_LOCKED"}')` → `{ status: 423, code: 'DEVICE_LOCKED', message: 'Aparelho bloqueado', retryAfter: 900 }`; an unparsable body → `code: 'HTTP_423'`, message `'Erro do servidor (423)'`.

- [ ] **Step 3: Implement, green, commit** — `git commit -m "Mobile: the mobile-api contract copy, ApiError and the Transport port"`

---

### Task 6: `HttpMobileApi`

**Files:**
- Create: `src/services/api/client.ts`, `src/services/api/types.ts` (the `MobileApi` interface and `Auth`), `src/services/api/index.ts`
- Test: `src/services/api/client.test.ts`

**Interfaces:**
- Consumes: `Transport`, `buildProof`, `DeviceKey`, contract schemas, `ApiError`, `canonicalHtu`, `appHeader` (`src/lib/app-header.ts` moves to `src/services/api/app-header.ts`; `src/lib` is deleted).
- Produces: `MobileApi` exactly as S§4 (all methods, `events()` delegating to Task 7's `ChatSocket`), `Auth = { accessToken: string | null; proof(htm: string, path: string, extra?: { ath?: boolean; chal?: string }): Promise<string> }` — the client computes `ath` itself from `accessToken`; `createHttpMobileApi(opts: { transport: Transport; baseUrl: string; app: string; key: DeviceKey; onTokenExpired(): Promise<string | null>; now?: () => number }): MobileApi & { readonly skewSeconds: number }`; `api` (module singleton in `index.ts`) built from `EXPO_PUBLIC_API_MODE` (`mock` → `createMockTransport()` of Task 8, else `new FetchTransport()`) and `TERMHUB_URL`; `index.ts` also exports `setTokenRenewer(fn: () => Promise<string | null>)` — a module-level `let renewer` that `onTokenExpired` delegates to, so the session store (Task 10) registers itself without a require cycle — and `mockControls: MockControls | null` (the transport's controls in mock mode).

- [ ] **Step 1: Failing tests** (`client.test.ts`, with a `ScriptedTransport` that records requests and answers from a queue):

```ts
function scripted(answers: Array<{ status: number; headers?: Record<string, string>; body: unknown }>) {
  const calls: Array<{ method: string; url: string; headers: Record<string, string>; body?: string }> = [];
  const transport: Transport = {
    fetch: async (req) => { calls.push(req); const a = answers.shift()!; return { status: a.status, headers: { date: new Date(NOW * 1000).toUTCString(), ...(a.headers ?? {}) }, text: JSON.stringify(a.body) }; },
    connect: () => { throw new Error('not in this test'); },
  };
  return { transport, calls };
}
const NOW = 1_800_000_000;
const key = new SoftwareDeviceKey('pin.salt' as VaultKey /* any vault slot works under the fake */);
const make = (t: Transport, onTokenExpired = jest.fn(async () => null as string | null)) =>
  createHttpMobileApi({ transport: t, baseUrl: 'https://termhub.dev', app: 'ios/0.1.0+1', key, onTokenExpired, now: () => NOW * 1000 });

it('sends the app header, bearer and a DPoP proof bound to method, canonical url and token hash', async () => {
  const { transport, calls } = scripted([{ status: 200, body: { projects: [] } }]);
  const api = make(transport);
  await api.chatProjects({ accessToken: 'tok' });
  expect(calls[0].headers['X-Termhub-App']).toBe('ios/0.1.0+1');
  expect(calls[0].headers.Authorization).toBe('Bearer tok');
  const payload = JSON.parse(fromUtf8(fromB64url(calls[0].headers.DPoP.split('.')[1])));
  expect(payload).toMatchObject({ htm: 'GET', htu: 'https://termhub.dev/api/m/v1/chat/projects', ath: b64url(sha256(utf8('tok'))) });
  expect(calls[0].url).toBe('https://termhub.dev/api/m/v1/chat/projects');
});
it('corrects iat by the skew learned from the Date header', async () => {
  const { transport, calls } = scripted([{ status: 200, headers: { date: new Date((NOW + 180) * 1000).toUTCString() }, body: { projects: [] } }, { status: 200, body: { projects: [] } }]);
  const api = make(transport);
  await api.chatProjects({ accessToken: 'tok' }); await api.chatProjects({ accessToken: 'tok' });
  const second = JSON.parse(fromUtf8(fromB64url(calls[1].headers.DPoP.split('.')[1])));
  expect(second.iat).toBe(NOW + 180);
  expect(api.skewSeconds).toBe(180);
});
it('renews once on TOKEN_EXPIRED and retries with the new token; a second 401 surfaces', async () => {
  const { transport, calls } = scripted([{ status: 401, body: { error: 'x', code: 'TOKEN_EXPIRED' } }, { status: 200, body: { projects: [] } }]);
  const renew = jest.fn(async () => 'tok2');
  await make(transport, renew).chatProjects({ accessToken: 'tok' });
  expect(renew).toHaveBeenCalledTimes(1); expect(calls[1].headers.Authorization).toBe('Bearer tok2');
});
it('only TOKEN_EXPIRED triggers renewal: DEVICE_REVOKED, PROOF_REPLAYED and APP_TOO_OLD surface untouched', async () => {
  for (const [status, code] of [[401, 'DEVICE_REVOKED'], [401, 'PROOF_REPLAYED'], [426, 'APP_TOO_OLD']] as const) {
    const renew = jest.fn(async () => 'tok2');
    const { transport } = scripted([{ status, body: { error: 'x', code } }]);
    await expect(make(transport, renew).chatProjects({ accessToken: 'tok' })).rejects.toMatchObject({ status, code });
    expect(renew).not.toHaveBeenCalled();
  }
});
it('refuses a body that does not match the contract', async () => {
  const { transport } = scripted([{ status: 200, body: { nope: 1 } }]);
  await expect(make(transport).chatProjects({ accessToken: 'tok' })).rejects.toMatchObject({ status: 502, code: 'BAD_RESPONSE' });
});
it('activate and token carry no ath; token carries chal', async () => { /* inspect payloads of `activate` (no ath) and `token` (chal === body.challenge) */ });
```

- [ ] **Step 2: Run, fail. Step 3: implement**

`client.ts` core:
```ts
export function createHttpMobileApi(o: Opts): MobileApi & { readonly skewSeconds: number } {
  let skew = 0; // server seconds - device seconds
  const nowS = () => Math.floor((o.now ?? Date.now)() / 1000) + skew;
  const learn = (headers: Record<string, string>) => { const d = headers.date ?? headers.Date; if (d) { const t = Date.parse(d); if (!Number.isNaN(t)) skew = Math.round(t / 1000) - Math.floor((o.now ?? Date.now)() / 1000); } };
  const proofFor = async (htm: string, path: string, token: string | null, chal?: string) => buildProof(o.key, { htm, htu: canonicalHtu(o.baseUrl, path), iat: nowS(), ...(token ? { ath: b64url(sha256(utf8(token))) } : {}), ...(chal ? { chal } : {}) });
  async function call<T>(htm: string, path: string, schema: z.ZodType<T>, opts: { token?: string | null; body?: unknown; chal?: string; proof?: boolean; retry?: boolean } = {}): Promise<T> {
    const headers: Record<string, string> = { 'X-Termhub-App': o.app, Accept: 'application/json' };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
    if (opts.proof !== false) headers.DPoP = await proofFor(htm, path, opts.token ?? null, opts.chal);
    const res = await o.transport.fetch({ method: htm, url: o.baseUrl + path, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
    learn(res.headers);
    if (res.status >= 200 && res.status < 300) { const parsed = schema.safeParse(res.text ? JSON.parse(res.text) : {}); if (!parsed.success) throw new ApiError(502, 'BAD_RESPONSE', 'Resposta inesperada do servidor'); return parsed.data; }
    const err = ApiError.fromBody(res.status, res.headers, res.text);
    if (err.status === 401 && err.code === 'TOKEN_EXPIRED' && opts.token && opts.retry !== false) { const fresh = await renewOnce(); if (fresh) return call(htm, path, schema, { ...opts, token: fresh, retry: false }); }
    throw err;
  }
  let renewing: Promise<string | null> | null = null;
  const renewOnce = () => (renewing ??= o.onTokenExpired().finally(() => { renewing = null; }));
  // …one method per route, e.g.:
  const api: MobileApi = {
    mode: o.mode,
    requestDevice: (body) => call('POST', '/api/m/v1/devices/requests', deviceRequestResponse, { body, proof: false }),
    pollRequest: (id, secret) => call('GET', `/api/m/v1/devices/requests/${id}`, devicePollResponse, { token: secret, proof: false, retry: false }),
    activate: (body) => call('POST', '/api/m/v1/devices/activate', deviceActivateResponse, { body }),
    challenge: (body) => call('POST', '/api/m/v1/session/challenge', challengeResponse, { body, proof: false }),
    token: (body) => call('POST', '/api/m/v1/session/token', tokenResponse, { body, chal: body.challenge, retry: false }),
    me: (a) => call('GET', '/api/m/v1/me', meResponse, { token: a.accessToken }),
    // deviceSelf, revokeSelf (POST …/devices/self/revoke, emptyResponse), setPushToken (PUT …/push-token), chatProjects, chat (GET /api/m/v1/chat or ?project=), hostOptions, setHost, sendMessage, reset, decide (POST …/chat/actions/:id/decision), notifications (GET …/notifications?before=), markRead (POST …/notifications/:id/read)
    events: (auth, onEvent, onClose) => createChatSocket({ transport: o.transport, url: wsUrl(o.baseUrl), headers: () => socketHeaders(auth), onEvent, onClose, onServerTime: (iso) => learnIso(iso) }).close,
  };
  return Object.assign(api, { get skewSeconds() { return skew; } });
}
```
`pollRequest` sends `Authorization: Bearer <request_secret>` and **no** DPoP (P§4.3); `events()` is finished in Task 7 (stub it to throw until then). `Auth` in the interface is `{ accessToken: string }` — the proof factory of S§4 collapses into the client because the client owns the key; keep the type name.

- [ ] **Step 4: Green, commit** — `git commit -m "Mobile: HttpMobileApi with DPoP, skew correction and single renewal"`

---

### Task 7: The chat socket

**Files:**
- Create: `src/services/api/socket.ts`
- Modify: `src/services/api/client.ts` (wire `events()`), `src/services/api/transport.ts` (`FetchTransport.connect` with RN's `WebSocket` headers)
- Test: `src/services/api/socket.test.ts`

**Interfaces:**
- Produces: `createChatSocket(o: { transport: Transport; url: string; headers(): Promise<Record<string, string>>; onEvent(e: TChatEvent): void; onReconnect(): void; onClose(code: number, final: boolean): void; onServerTime(iso: string): void; backoff?: { min: number; max: number }; foreground?: { subscribe(fn: () => void): () => void } }): { close(): void }` — `final` is true on `4400`/`4401` (no reconnect). `api.events(auth, handlers)` takes `{ onEvent, onReconnect, onClose }`.

- [ ] **Step 1: Failing tests** with a fake transport whose `connect` captures handlers and returns `{ close }`:

- the first frame must be `hello` (`{ type: 'hello', protocol: 1, server_time }`): `onServerTime` gets it; a first frame that is not `hello` closes the socket and reconnects;
- every later frame is parsed with `chatEventSchema` and delivered; an unparsable frame is dropped, not fatal;
- `onReconnect` fires on every open;
- close `1006` → reconnect after `min` ms, then `min*2`, capped at `max`, reset after a successful open ("reconnect calls onReconnect and drops the old buffer": the events delivered before the drop are not re-delivered);
- close `4400` and `4401` → `onClose(code, true)` and **no** reconnect;
- a `foreground` emit while closed reconnects at once;
- `close()` stops everything (no reconnect timer left; use `jest.useFakeTimers()`).

- [ ] **Step 2: Run, fail. Step 3: implement** (`socket.ts`: a small state machine with `open()`, `scheduleReconnect()`, `stopped`, `attempt`, `timer`; `FetchTransport.connect` = `const ws = new WebSocket(url, undefined, { headers } as never)` → `ws.onopen/onmessage/onclose`, returning `{ close: () => ws.close() }`; `wsUrl(base) = base.replace(/^http/, 'ws') + '/ws/m/chat?v=1'`; `socketHeaders(auth)` = `Authorization` + a DPoP proof for `GET` `/ws/m/chat` with `ath`).

- [ ] **Step 4: Green, commit** — `git commit -m "Mobile: /ws/m/chat client with hello, backoff and terminal close codes"`

---

### Task 8: `MockTransport` — enrolment and session

**Files:**
- Create: `src/services/api/mock/state.ts` (types + `MockState`), `mock/router.ts` (`route(method, path, handler)`, `match`), `mock/transport.ts` (`createMockTransport(opts?: { latency?: [number, number]; now?: () => number }): Transport & { controls: MockControls }`), `mock/handlers/devices.ts`, `mock/handlers/session.ts`, `mock/handlers/me.ts`, `mock/controls.ts`, `mock/index.ts`
- Test: `src/services/api/mock/session.e2e.test.ts` (through `createHttpMobileApi`)

**Interfaces:**
- Produces: `MockControls = { approve(requestId): void; deny(requestId): void; expireNow(): void; lockNow(): void; revokeNow(): void; dropSocket(): void; pendingRequestIds(): string[] }`; `MockState` holds `requests: Map<id, { …, status, secretHash, code, publicKey, userId, expiresAt, activateUntil }>`, `devices: Map<id, { jwk, pinSecret, pinFailures, lockedUntil, status, revokedReason, pushToken, name, platform, model, os, createdAt }>`, `tokens: Map<token, { deviceId, expiresAt }>`, `challenges: Map<value, { deviceId, purpose, actionId, expiresAt, used }>`, `jtis: Map<deviceId, Map<jti, iat>>`, `sockets: Set<FakeSocket>`; `verify(req)` helper returns `{ device, token }` or throws a wire error `{ status, code, error }`.

- [ ] **Step 1: Failing e2e test** (`session.e2e.test.ts`):

```ts
const transport = createMockTransport({ latency: [0, 0], now: () => clock });
let clock = Date.parse('2026-09-24T12:00:00Z');
const key = new SoftwareDeviceKey();
const api = createHttpMobileApi({ transport, baseUrl: 'https://termhub.dev', app: 'ios/0.1.0+1', key, onTokenExpired: async () => null, now: () => clock });
const jwk = await key.create();
const device = { platform: 'ios' as const, model: 'iPhone15,2', os_version: '18.1', name: 'iPhone de teste' };

it('enrols, activates, unlocks and counts wrong PINs like the server', async () => {
  const req = await api.requestDevice({ email: 'Pedro@X.com', public_key: jwk, device, app_version: '0.1.0+1' });
  expect(req.verification_code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/);
  expect(await api.pollRequest(req.request_id, req.request_secret)).toEqual({ status: 'pending' });
  transport.controls.approve(req.request_id);
  expect(await api.pollRequest(req.request_id, req.request_secret)).toEqual({ status: 'approved' });
  const act = await api.activate({ request_id: req.request_id, request_secret: req.request_secret });
  const secret = fromB64url(act.pin_secret); expect(secret).toHaveLength(32);
  expect((await api.me({ accessToken: act.access_token })).device.id).toBe(act.device_id);
  // three wrong proofs lock for 15 minutes; a bad signature never counts
  for (let i = 0; i < 3; i++) { const c = await api.challenge({ device_id: act.device_id }); await expect(api.token({ device_id: act.device_id, challenge: c.challenge, pin_proof: 'wrong' })).rejects.toMatchObject({ status: 401, code: 'PIN_INVALID', attemptsLeft: 2 - i }); }
  const c = await api.challenge({ device_id: act.device_id });
  await expect(api.token({ device_id: act.device_id, challenge: c.challenge, pin_proof: pinProof(secret, c.challenge) })).rejects.toMatchObject({ status: 423, code: 'DEVICE_LOCKED', retryAfter: 900 });
  clock += 15 * 60_000 + 1;
  const c2 = await api.challenge({ device_id: act.device_id });
  const tok = await api.token({ device_id: act.device_id, challenge: c2.challenge, pin_proof: pinProof(secret, c2.challenge) });
  expect(tok.expires_in).toBe(900);
});
it('a replayed jti is 401 PROOF_REPLAYED and not a token renewal', …);           // reuse a captured DPoP header through the transport directly
it('a proof outside the ±60 s window is PROOF_INVALID, not a PIN failure', …);   // shift `clock` given to the client only
it('deny and expiry answer closed; an unknown id answers closed too', …);
it('six failures revoke: every call is DEVICE_REVOKED and the socket closes 4401', …);   // socket in Task 9; here assert the calls only
it('a wrong request_secret on activate is 401 and an activation after activate_until is 401', …);
it('the response to requestDevice has the same shape for any e-mail', …);       // two e-mails, same keys, same status
```

- [ ] **Step 2: Run, fail. Step 3: implement**

`transport.ts`: `fetch(req)` → `await latency()`, parse `new URL(req.url)`, find the route, build `ctx = { state, now, headers: lowercased(req.headers), body: req.body ? JSON.parse(req.body) : undefined, params, query }`, run the handler inside `try` and map a thrown `{ status, code, error }` (class `WireError`) to the response; every response carries `date: new Date(now()).toUTCString()` and `content-type: application/json`. Bodies are validated with the contract schemas (`deviceRequestBody.parse`, …; a `ZodError` → `400 VALIDATION`).

`handlers/devices.ts`: `POST /api/m/v1/devices/requests` — always `202` (rate limits are not modelled), code from the alphabet, `request_secret = randomId(24)` (store `sha256` of it), `expires_at = now + 10 min`, `poll_after: 2000`; `GET /devices/requests/:id` — bearer must equal the secret, `pending`/`approved`, anything else `closed` (expired: `now > expiresAt`); `POST /devices/activate` — DPoP required: `verifyProof(header, { htm, htu, now, jwk: request.publicKey })` (`ath` absent), `401 PROOF_INVALID` on failure; secret hash must match, status `approved`, `now <= activateUntil` → create device with `pinSecret = randomBytes(32)`, mint token, mark request `activated`.

`handlers/session.ts`: `POST /session/challenge` → `{ challenge: randomId(24), expires_at: now + 60 s }` stored with `purpose`/`actionId`; `POST /session/token` — **order**: challenge exists, unused, unexpired, same device (`401 CHALLENGE_INVALID`) → DPoP with `chal` verified against the device's JWK (`401 PROOF_INVALID`; **before** any counting) → `jti` not seen in 5 min (`401 PROOF_REPLAYED`) → device not revoked (`401 DEVICE_REVOKED`) → `lockedUntil > now` (`423 DEVICE_LOCKED`, `retry_after` seconds) → HMAC compare → wrong: `pinFailures++`, at 3 `lockedUntil = now + 15 min`, at 6 revoke (`revokedReason: 'pin_bruteforce'`, delete tokens, close sockets `4401`), respond `401 PIN_INVALID` with `attempts_left: max(0, 3 - failures % 3)` while not locked; right: `pinFailures = 0`, new token `{ access_token, expires_in: 900 }`. The `verify(req)` helper for authenticated routes: bearer → token row (`401 TOKEN_EXPIRED` if missing/expired), device (`401 DEVICE_REVOKED`), DPoP with `ath = b64url(sha256(token))`, `jti` window.

`handlers/me.ts`: `GET /me` → `{ user: { id: 'u1', email, name: 'Pedro' }, permissions: ['chat:read','chat:create','chat:update','devices:read','devices:update','devices:delete','terminals:read','terminals:create'], device }`; `GET /devices/self`; `POST /devices/self/revoke` (revoke, `reason: 'user'`); `PUT /push-token`.

`controls.ts` as listed; `expireNow` moves every pending request's `expiresAt` to the past; `lockNow` sets `lockedUntil`; `revokeNow` revokes the (single) device.

- [ ] **Step 4: Green, commit** — `git commit -m "Mobile: MockTransport — enrolment, DPoP verification, PIN counting"`

---

### Task 9: `MockTransport` — chat, socket and notifications

**Files:**
- Create: `mock/fixtures.ts`, `mock/handlers/chat.ts`, `mock/handlers/notifications.ts`, `mock/socket.ts` (`FakeSocket`, `connect()` of the transport)
- Test: `src/services/api/mock/chat.e2e.test.ts`

**Interfaces:**
- Produces: fixtures — projects `termhub` (key `TER`, one pending action `a-termhub-1`, summary "digitar `npm test` na aba api do projeto termhub, no jarvis"), `opapingou` (`OPM`), `reactivando` (`REA`), plus the account-wide chat (`project_id: null`), each with 3–6 messages dated within the last two days; `MockControls.dropSocket()` closes every open fake socket with `1006`.

- [ ] **Step 1: Failing e2e test** (helper `enrol()` repeats Task 8's happy path and returns `{ auth, secret, deviceId }`):

- `chatProjects` lists three projects with `pending_confirmations: 1` on `termhub`;
- `chat(auth, 'p-termhub')` returns the conversation, messages, one pending action and a `ready` host;
- `events()` receives `hello` first; `sendMessage(auth, { text: 'roda o teste', project_id: 'p-termhub' })` answers `202` with three ids, then (fake timers advanced) the socket delivers `message` (user), `message` (assistant, empty text), ≥ 3 `delta`s and a final `message` with the full text; `chatProjects` shows `busy: true` in between;
- a message containing `erro` ends with `error_code: 'HOST_GONE'` and empty text;
- a message containing `confirma` produces a `confirmation` event whose `action_id` is then in `chat().actions` as `pending`;
- `decide(auth, id, { decision: 'approve', challenge, pin_proof })` with `challenge` from `challenge({ device_id, purpose: 'decision', action_id: id })` and `decisionProof(secret, challenge, id)` → resolves; a `decision` event follows; the same call again → `409 ALREADY_DECIDED`; `deny` on a pending action needs nothing;
- `approve` with a `refresh`-purpose challenge or a proof for another action → `401 PIN_INVALID`;
- `reset` archives: `chat()` afterwards has no messages and a new `conversation.id`;
- `notifications` lists one row per `confirmation` and one per finished run, newest first, with `unread`; `markRead` drops `unread` by one;
- `controls.revokeNow()` closes the socket with `4401`; `controls.dropSocket()` closes with `1006`.

- [ ] **Step 2: Run, fail. Step 3: implement** — canned answers keyed by `/test|teste/` ("Rodei `npm test` no jarvis: 1066 testes passaram, 137 pulados. Nada quebrou."), `/deploy/`, `/status/`, default ("Entendi. Posso olhar as abas do projeto e te dizer o que está esperando você — quer que eu faça isso?"); streaming = the answer split into chunks of 12–30 chars, one `delta` every 250 ms (0 ms under `latency: [0, 0]` but still separate macrotasks so tests use fake timers); notification titles/bodies verbatim from P§9 ("termhub precisa de você" / "O chat do projeto termhub pediu confirmação para agir na aba api (jarvis)." and "Resposta pronta em termhub" / "O chat do projeto termhub terminou de responder."). The fake socket refuses `connect()` without a valid token + proof (`onClose(4401)` right after open) and closes `4400` when `v` is not `1`.

- [ ] **Step 4: Green, commit** — `git commit -m "Mobile: MockTransport — chats, streaming socket, decisions, notifications"`

---

### Task 10: The session store

**Files:**
- Create: `src/features/session/model/session.types.ts`, `src/features/session/model/device-info.ts` (reads expo-device / expo-application → `DeviceRequestBody['device']` and `app_version`), `src/features/session/viewmodel/useSessionStore.ts`, `src/features/session/viewmodel/createSessionStore.ts` (factory taking `{ api, key, vault, now, mockControls }` so tests inject; `useSessionStore` = the factory with the real singletons), `src/services/api/index.ts` (register `api.setTokenRenewer(() => useSessionStore.getState().renewToken())`)
- Test: `src/features/session/viewmodel/createSessionStore.test.ts`

**Interfaces:**
- Produces:
  ```ts
  type Phase = 'new' | 'waiting' | 'pin_setup' | 'locked' | 'unlocked';
  interface SessionState {
    phase: Phase; hydrated: boolean; deviceId: string | null; deviceName: string | null; email: string | null;
    biometricsEnabled: boolean; lastBackgroundAt: number | null; pendingRoute: string | null;
    request: { id: string; code: string; expiresAt: string } | null;   // in memory only
    lockedUntil: string | null; attemptsLeft: number | null; error: string | null; busy: boolean; notice: string | null;
    mockControls: MockControls | null;
    requestDevice(email: string): Promise<void>; cancelRequest(): void;
    createPin(pin: string, confirm: string): Promise<void>;
    unlock(pin: string): Promise<void>; unlockWithBiometrics(): Promise<void>;
    enableBiometrics(): Promise<boolean>; disableBiometrics(): Promise<void>;
    renewToken(): Promise<string | null>;                              // the client's renewer
    auth(): Auth;                                                      // throws when locked
    requestPinProof(actionId: string): Promise<{ challenge: string; pin_proof: string }>;  // resolved by the PIN sheet
    resolvePinPrompt(pin: string | 'biometrics'): Promise<void>; cancelPinPrompt(): void; pinPrompt: { actionId: string } | null;
    background(): void; foreground(): void; leave(): Promise<void>; wipe(reason?: string): Promise<void>;
  }
  ```
  Persisted (`partialize`): `phase` mapped through `persistablePhase` (`waiting`/`pin_setup`/`unlocked` → `new`/`new`/`locked`), `deviceId`, `deviceName`, `email`, `biometricsEnabled`, `lastBackgroundAt`.

- [ ] **Step 1: Failing tests** (store over `createMockTransport({ latency: [0, 0], now })` + `SoftwareDeviceKey` + the fakes; `jest.useFakeTimers()` for polling):

- "requests a device and waits": `phase` `waiting`, `request.code` 6 chars, `pollRequest` called every 2 s until `controls.approve()` → `pin_setup`;
- "a denied request goes back to new with a notice";
- "createPin refuses a mismatch and a non-6-digit PIN without calling the API";
- "activation wraps the secret: vault has pin.wrapped, pin.salt, device.id; MMKV never contains the secret or token" (scan `__store` values for the base64url secret);
- "waiting and pin_setup do not survive a restart" (persist → `persistablePhase`);
- "unlock with a wrong PIN says PIN incorreto with attempts left; three make it locked with lockedUntil; the right PIN after the lock unlocks";
- "background for 5 min then foreground relocks; 4 min does not";
- "renewToken is single-flighted and returns null when locked";
- "requestPinProof resolves when the prompt is answered with the right PIN and rejects on cancel";
- "leave revokes and wipes: vault empty, phase new; a DEVICE_REVOKED from any call wipes too" (call `me` after `controls.revokeNow()` through the store's `auth()`);
- "enableBiometrics stores the plain secret behind biometrics and unlockWithBiometrics uses it";
- "after activation and after every unlock, setPushToken is called once with a fake Expo token" (`ExponentPushToken[mock-<deviceId>]`, P§9: the flow exists even though nothing is delivered).

- [ ] **Step 2: Run, fail. Step 3: implement** per S§5.2–5.5. Key details: `busy`/`error` around every action; `unlock` computes `candidate` and only keeps it after `token()` succeeds; `auth()` returns `{ accessToken }` reading the in-memory token; `renewToken` uses the in-memory secret (null when absent → set `locked`); `wipe` = `vault.clear()`, `key.destroy()`, `sessionEnded.emit()`, `set(initial)`; the `AppState` listener lives in the view layer (`app/_layout.tsx` calls `background()`/`foreground()`), never in the store.

- [ ] **Step 4: Green, commit** — `git commit -m "Mobile: session store — enrolment, PIN, unlock, relock, biometrics, wipe"`

---

### Task 11: Session screens and navigation by phase

**Files:**
- Create: `src/features/session/view/start-screen.tsx`, `waiting-screen.tsx`, `create-pin-screen.tsx`, `unlock-screen.tsx`, `pin-prompt-sheet.tsx`, `src/features/session/view/use-phase-redirect.ts`
- Modify: `app/_layout.tsx`, `app/index.tsx`, `app/enrol/waiting.tsx`, `app/enrol/create-pin.tsx`, `app/unlock.tsx` (one-liners), `app/index.test.tsx` → moved to `src/features/session/view/start-screen.test.tsx`
- Test: `start-screen.test.tsx`, `waiting-screen.test.tsx`, `create-pin-screen.test.tsx`, `unlock-screen.test.tsx`

- [ ] **Step 1: Failing UI tests** (each mocks `@/features/session/viewmodel/useSessionStore` with a zustand store built by `createSessionStore` over the mock transport, `latency: [0, 0]`):

- Início: typing `pedro@x.com` and pressing "Continuar com e-mail" calls `requestDevice`; an invalid e-mail shows "Digite um e-mail válido" and calls nothing;
- Aguardando: shows `K7F-2QD` formatted from `request.code`, the countdown, and — with `mockControls` — the buttons "Simular aprovação na web" and "Simular recusa"; without `mockControls` neither;
- Criar PIN: six digits twice → `createPin`; a mismatch shows "Os PINs não são iguais";
- Desbloquear: six digits → `unlock`; with `attemptsLeft: 2` shows "PIN incorreto. 2 tentativas restantes."; with `lockedUntil` shows "Aparelho bloqueado" and the countdown, pad disabled; the "Biometria" key appears only when `biometricsEnabled`.

- [ ] **Step 2: Run, fail. Step 3: implement**

`use-phase-redirect.ts` (view layer, may import expo-router): `useEffect` on `phase` + `hydrated` + current segments → `router.replace` to `'/'`, `'/enrol/waiting'`, `'/enrol/create-pin'`, `'/unlock'`, `'/(tabs)'`; when `phase` becomes `unlocked` and `pendingRoute` is set, replace to it and clear. `app/_layout.tsx`: `AppState` listener → `background()`/`foreground()`; `Linking` initial URL / `useURL()` → if locked, `pendingRoute = path`; renders `<PinPromptSheet />` globally (reads `pinPrompt`, shows `PinPad` + "Autorizar esta ação" + "Biometria" key when enabled). Copy: "Continuar com e-mail", "Abra o termhub na web para aprovar este aparelho", "Expira em {mm:ss}", "Crie um PIN de 6 dígitos", "Repita o PIN", "Digite seu PIN", "Este aparelho foi removido da sua conta." (from `notice`).

- [ ] **Step 4: Green, commit** — `git commit -m "Mobile: session screens and routing by session phase"`

---

### Task 12: Chat model (copied from the web)

**Files:**
- Create: `src/features/chat/model/types.ts`, `timeline.ts`, `live.ts`, `filter.ts`, `copy.ts`
- Test: `timeline.test.ts` (the web's `chat-timeline.test.ts` ported), `live.test.ts`, `filter.test.ts`, `copy.test.ts`

**Interfaces:**
- Produces: `ChatMessage`, `ChatAction`, `ChatEvent`, `ChatHostState`, `ChatConversation` (from the contract types — `types.ts` re-exports `TChatMessage` etc. under the web's names); `chatTimeline(messages, actions): ChatEntry[]` verbatim; `foldLive(events: ChatEvent[]): { deltas: Map<string, string>; actions: Map<string, { tool: string }[]>; started: Set<string> }` (the `useMemo` body of `ChatPanel.tsx` lines ~267–290, extracted); `belongsTo(conversationId: string | null)(e: ChatEvent): boolean` (the `mine` rule: untagged → true; tagged → equal; `conversationId === null` → tagged dropped); `errorSentence(code: ChatErrorCode): string` (the `ChatTurn` table verbatim); `hostLine(host: ChatHostState): { text: string; tone: 'ok' | 'warn' | 'info' }` with the `ChatHost` sentences ("Esta conversa roda na máquina {name}, na conta padrão do Claude dela." / "na conta {label}"; "A máquina {name} está offline agora."; "Você tem mais de uma máquina: escolha em qual o chat vai rodar."; "O chat roda em uma máquina sua, e você ainda não cadastrou nenhuma."; "O agente da máquina {name} ainda não sabe rodar o chat. Atualize o agente dessa máquina para conversar por aqui.").

- [ ] Steps: copy `apps/web/src/lib/chat-timeline.ts` and its test; write `live.test.ts` (deltas concatenate per message id; `reset` drops them; an empty assistant `message` marks `started`; `action` events accumulate tools), `filter.test.ts`, `copy.test.ts` (one sentence per code, none empty); implement; green; `git commit -m "Mobile: chat model copied from the web — timeline, live fold, filter, copy"`.

---

### Task 13: Chat store and screens

**Files:**
- Create: `src/features/chat/viewmodel/createChatStore.ts`, `useChatStore.ts`, `src/features/chat/view/chats-screen.tsx`, `conversation-screen.tsx`, `message-bubble.tsx`, `action-card.tsx`, `composer.tsx`, `host-line.tsx`, `host-sheet.tsx`
- Modify: `app/(tabs)/index.tsx`, `app/chat/[id].tsx` (one-liners; the route param is the **conversation id**, the store maps it to the project)
- Test: `createChatStore.test.ts`, `chats-screen.test.tsx`, `conversation-screen.test.tsx`

**Interfaces:**
- Produces: `ChatState { projects: TChatProjectItem[]; conversations: Record<string /* project id or '' */, { conversation: ChatConversation | null; messages: ChatMessage[]; actions: ChatAction[]; host: ChatHostState | null; loaded: boolean; error: string | null }>; live: ChatEvent[]; connected: boolean; sending: boolean; decidingId: string | null; loadProjects(); open(projectId: string | null); close(); send(text); decide(actionId, decision); reset(); loadHostOptions(); setHost(machineId, aiAccountId?) ; conversationIdToProject(id): string | null | undefined }`. Persisted: `projects` and each conversation's `conversation/messages/actions/host` (not `live`).

- [ ] **Step 1: Failing store tests** (over the mock transport, session store unlocked by the Task 10 helper):

- `loadProjects` fills three projects; `open('p-termhub')` loads and subscribes; a `message` event re-reads the thread ("a reconnect re-reads the conversation": call `controls.dropSocket()`, advance timers, expect `chat` fetched again and `live` emptied);
- `send` answers at once (`sending` false after `202`) and the thread grows only through events; deltas fold into `foldLive(live)`;
- `decide(id, 'approve')` asks `requestPinProof(id)` and, once resolved, the card is `approved`; "a decision event updates the card by id and is idempotent" (feed the same `decision` twice; one card, status `approved`);
- `decide(id, 'deny')` needs no prompt; a `409` shows "Essa ação já foi decidida";
- events of another conversation never touch the open one (`belongsTo`);
- `reset` empties the thread.

- [ ] **Step 2: UI tests**: Chats lists "Chat geral" + three projects with "respondendo…" when `busy` and a badge with the pending count; Conversa renders bubbles (assistant as markdown), a streaming bubble with the folded deltas, "pensando…" for a started empty row, an `ActionCard` with "Autorizar"/"Recusar" — pressing Autorizar calls `decide(id, 'approve')`; the composer sends on the button and clears; the mic button is disabled with "em breve".

- [ ] **Step 3: Implement**, **Step 4: green, commit** — `git commit -m "Mobile: chat store, Chats and Conversa screens with PIN-gated approval"`

---

### Task 14: Notifications, settings, key diagnostic, README

**Files:**
- Create: `src/features/notifications/viewmodel/useNotificationsStore.ts` (+ `createNotificationsStore.ts`), `src/features/notifications/view/notifications-screen.tsx`, `src/features/settings/view/settings-screen.tsx`, `src/features/settings/model/key-diagnostic.ts` (`runKeyDiagnostic(key: DeviceKey): Promise<{ ok: boolean; steps: { name: string; ok: boolean; detail?: string }[] }>` — create/exists/publicJwk/sign+verify/destroy), `src/features/settings/view/key-diagnostic-sheet.tsx`
- Modify: `app/(tabs)/notifications.tsx`, `app/(tabs)/settings.tsx`, `app/(tabs)/_layout.tsx` (unread badge from the store), `apps/mobile/README.md`, `.env.example` (`EXPO_PUBLIC_API_MODE=mock`)
- Test: `createNotificationsStore.test.ts`, `notifications-screen.test.tsx`, `settings-screen.test.tsx`, `key-diagnostic.test.ts`

- [ ] Tests: notifications load newest first with `unread`; a `confirmation` event prepends a row; `markRead` clears it and the screen navigates to `chat/<conversation_id>`; settings shows the device name/model, the biometrics switch calling `enableBiometrics`/`disableBiometrics`, the host line, the theme picker (three options), the version, and "Sair e remover este aparelho" → confirmation sheet → `leave()`; the diagnostic over `SoftwareDeviceKey` reports every step `ok`.
- [ ] Implement; README: replace "What is here today" with the real map (features, ports, mock mode, `EXPO_PUBLIC_API_MODE`), the manual checklist of S§10 (dev build in mock mode: full flow; `Ajustes → Diagnóstico da chave` on iOS and Android), and how the HTTP mode is switched on when the server exists.
- [ ] Green (`npm test -w @termhub/mobile`, `npm run typecheck -w @termhub/mobile`, `npx expo-doctor` 21/21), commit — `git commit -m "Mobile: notifications, settings, key diagnostic and the README"` — push and update PR #134's description with the new scope.

---

## After the last task

- Whole-branch review (subagent-driven-development's final step), then the PR description lists the manual checklist.
- The contract copy is re-diffed against `packages/mobile-api` when the server PR merges; any drift is a one-file change under `contract/`.
