# @termhub/mobile

The termhub chat as a native app (iOS and Android), built with Expo and `expo-router`, against an in-memory mock of the server (see "Mock mode" below) while the real one is built in parallel. Design: `docs/superpowers/specs/2026-09-24-mobile-chat-app-design.md` (the *product* spec — §11 is the app, §9 push and notifications) and `docs/superpowers/specs/2026-09-24-mobile-app-mock-design.md` (the *app* architecture this workspace implements — the folder layout, the mock and everything below is delivered against it). The server side (`/api/m/v1`, `/ws/m/chat`, device enrolment, push) is delivered separately, by `docs/superpowers/plans/2026-09-24-mobile-chat-server.md`.

## Architecture

MVVM by feature, `src/features/<feature>/{model,viewmodel,view}`: views never call the API directly, and viewmodels never import React Native or `expo-router` (the `logic` jest project enforces the second rule — it throws if either is imported).

```
app/                             expo-router routes — thin, each file renders one feature view
  index.tsx                      Início — "Continuar com e-mail"
  enrol/waiting.tsx               Aguardando aprovação (verification code, simulated approval in mock mode)
  enrol/create-pin.tsx            Criar PIN
  unlock.tsx                      Desbloquear (PIN / biometrics)
  (tabs)/_layout.tsx              the three tabs; Notificações carries the unread badge
  (tabs)/index.tsx                Chats
  (tabs)/notifications.tsx        Notificações
  (tabs)/settings.tsx             Ajustes
  chat/[id].tsx                   a conversation (deep link target: termhub://chat/<conversation_id>)

src/features/
  session/    enrolment, PIN and activation, unlock, silent renewal, relock, biometrics, leaving/revocation
  chat/       projects, a conversation, live events, decisions, the account-wide chat's host picker
  notifications/  the account's notification history and unread count (a live `confirmation` also
                   taps into the chat store's socket — see `viewmodel/createNotificationsStore.ts`)
  settings/   this device (`GET devices/self`), the key diagnostic, and Ajustes' remaining sections
              (biometrics, the chat host and the theme each already live in their own store above)
  theme/      the light/dark/system preference
  shared/     signals (e.g. `sessionEnded`, which every persisted store resets on), relative-time

src/services/
  api/        MobileApi = HttpMobileApi over a Transport (FetchTransport for `http`, MockTransport
              for `mock`); api/contract/ is the zod contract copied from packages/mobile-api;
              api/mock/ is the whole in-memory server (router, state, fixtures, DPoP verification)
  key/        the DeviceKey port — SoftwareDeviceKey (P-256, @noble/curves, SecureStore-backed;
              backs mock mode and every Jest run) and HardwareDeviceKey (@pagopa/io-react-native-crypto,
              Secure Enclave / Keystore; backs http mode on a real device)
  vault.ts    the SecureStore wrapper for the app's few secrets (a closed set of `VaultKey`s)
  storage.ts  the MMKV instance and the zustand StateStorage every persisted store uses

src/ui/       Screen, Text, Button, Field, PinPad, Sheet, Card, Banner… (NativeWind v4)
src/theme/tokens.ts  the termhub palette (CSS variables), both colour schemes
test/         jest setup, fakes for MMKV/SecureStore/expo-device/expo-local-authentication/the
              hardware key module, and shared test helpers (`test/helpers/enrolled-session.ts`,
              `test/helpers/ui-stores.ts`)
```

### Mock mode

`EXPO_PUBLIC_API_MODE=mock` (the default — see `.env.example`) makes `src/services/api/index.ts` build the app's one `MobileApi` over `MockTransport` instead of `FetchTransport`: an in-memory implementation of the exact same contract (`src/services/api/contract/`), answering the same URLs with the same status codes, bodies and socket frames a real server would. Nothing else in the app knows the difference — the same `HttpMobileApi` client builds DPoP proofs, retries once on a renewed token and so on, whether the transport underneath is real or not. This is how the app runs on the simulator, on a phone with no server, and in every Jest test.

Two things exist only under `mock`: the *Aguardando aprovação* screen's "Simular aprovação na web" / "Simular recusa" buttons (`mockControls`, `null` in `http` mode — nothing approves a request by itself otherwise), and `src/features/settings/model/key-diagnostic.ts` using `SoftwareDeviceKey` instead of `HardwareDeviceKey` for the "Diagnóstico da chave" row (a dedicated vault key/tag, `key.diagnostic` / `dev.termhub.diagnostic`, never the enrolled device key either way).

### How the flow works

Enrolment (P§4): `requestDevice(email)` generates the device key, shows the verification code and polls until approved (or, in mock mode, the person taps "Simular aprovação"). Approval moves the session to `pin_setup`; `createPin` activates the device, wraps the server's `pin_secret` with a PIN-derived key (scrypt) in SecureStore, and the app is `unlocked`. From there: `locked` after 5 minutes in the background or a cold start (`unlock(pin)` never compares the PIN locally — every guess costs a server call, P§5.4); a wrong PIN three times locks the device for a while; biometrics is a SecureStore item guarded by `requireAuthentication`, a shortcut to the same unwrap. The chat store owns the app's one `/ws/m/chat` socket, opened by the first conversation `open()`; messages only ever land in state through socket events, never by appending locally on send. A `confirmation` event both updates the open conversation's action list and — through `subscribeEvents` — prepends a placeholder row into `useNotificationsStore` before the server's own notification row is fetched. "Sair e remover este aparelho" revokes the device and wipes every vault item and persisted store (`sessionEnded`).

### Env vars

See `.env.example`. `EXPO_PUBLIC_API_MODE` (`mock` | `http`, default `mock`) and `EXPO_PUBLIC_TERMHUB_URL` (only read in `http` mode, e.g. from `expo start`; a production build bakes `https://termhub.dev` in through `eas.json` instead — there is no server picker in the app, spec §11.1).

### Switching to a real server

Nothing in the app changes: once `docs/superpowers/plans/2026-09-24-mobile-chat-server.md` ships `/api/m/v1` and `/ws/m/chat`, set `EXPO_PUBLIC_API_MODE=http` (and, for a local/staging server, `EXPO_PUBLIC_TERMHUB_URL`) and `FetchTransport` takes over from `MockTransport` behind the same `MobileApi` — `HttpMobileApi`, the contract and every screen are already written against the real routes, not the mock's. This mode is untested against an actual server until one exists (design spec §11 "out of scope"); the mock only verifies the client speaks the contract correctly to itself.

## Running

Jarvis has no Node: run everything through Docker as CLAUDE.md shows, or on a Mac with Node 22.

```bash
npm run typecheck -w @termhub/mobile
npm test -w @termhub/mobile
```

The app needs a **development build** (native modules; Expo Go cannot load it):

```bash
cd apps/mobile
npx eas init                      # once per Expo account: writes extra.eas.projectId into app.json
npx eas build --profile development --platform ios      # or android; installs on a device/simulator
npm start                         # Metro; the development build connects to it
```

Copy `.env.example` to `.env` to set `EXPO_PUBLIC_API_MODE` / `EXPO_PUBLIC_TERMHUB_URL` for `expo start`; with no `.env` at all the app runs in mock mode by default, with no server needed. Production builds bake `https://termhub.dev` and `http` mode in through `eas.json`.

Before a production build: APNs key and FCM v1 service account in EAS credentials (`npx eas credentials`), store listings, and the reviewer notes of spec §12.3.

## Manual checklist (design spec §10)

Everything below is automated except this: run it by hand, on a development build, before trusting a change that touches enrolment, the PIN, biometrics or the key.

1. **Full flow, in mock mode** — on a development build with no server running:
   1. Início: enter an e-mail, see the verification code.
   2. Aguardando aprovação: "Simular aprovação na web".
   3. Criar PIN: set a 6-digit PIN.
   4. The app unlocks into the tabs.
   5. Send a message in a project chat and watch the answer stream in.
   6. Trigger a pending action (send a message containing "confirma") and approve it with the PIN.
   7. Lock the device with three wrong PINs in a row.
   8. Turn biometrics on, then off, in Ajustes.
   9. "Sair e remover este aparelho" in Ajustes, and confirm the app returns to Início.
2. **The key diagnostic** — `Ajustes → Diagnóstico da chave → "Testar a chave do aparelho"`, on both a real iOS device and a real Android device (P§11.1's first on-device check: this is what actually exercises `HardwareDeviceKey` against the Secure Enclave / Keystore — Jest always runs the software key instead). Every step (`create`, `exists`, `publicJwk`, `sign+verify`, `destroy`) should say "ok".

## Conventions

- Code, comments and commits in English; every string a person sees in pt-BR.
- Bundle / package id `dev.termhub.app`, URL scheme `termhub`.
- Pure logic (`model/`) and viewmodels must not import React Native or `expo-router`: the `logic` jest project runs them in plain Node and fails otherwise.
- The monorepo pins a single React version (root `package.json` `overrides`); Expo SDK upgrades bump it for every workspace.
