# @termhub/mobile

The termhub chat as a native app (iOS and Android), built with Expo and `expo-router`. Design: `docs/superpowers/specs/2026-09-24-mobile-chat-app-design.md` (§11 is the app). The server side (`/api/m/v1`, `/ws/m/chat`, device enrolment, push) is delivered by `docs/superpowers/plans/2026-09-24-mobile-chat-server.md`; the app's own implementation plan is written against that contract once it ships.

## What is here today

The workspace, its configuration and a placeholder for every screen of §11.2, so the app plan can replace screens one at a time:

```
app/
  _layout.tsx           root Stack
  index.tsx             Início — "Continuar com e-mail"
  enrol/waiting.tsx     Aguardando aprovação (verification code)
  enrol/create-pin.tsx  Criar PIN
  unlock.tsx            Desbloquear (PIN / biometrics)
  (tabs)/index.tsx      Chats
  (tabs)/notifications.tsx
  (tabs)/settings.tsx   Ajustes
  chat/[id].tsx         the conversation (deep link target: termhub://chat/<conversation_id>)
src/lib/                pure logic, tested in plain Node (jest project `logic`)
src/ui/                 React Native components (jest project `ui`)
test/                   jest setup and stubs
```

Dependencies already installed for the plan (spec §11.1): `@pagopa/io-react-native-crypto` (hardware-bound P-256 key; its behaviour on a real device is the plan's first check), `expo-secure-store`, `expo-local-authentication`, `@noble/hashes` (scrypt for the PIN wrap), `expo-notifications`, `expo-audio`, `expo-file-system`, `react-native-markdown-display`.

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

`expo start` reads `EXPO_PUBLIC_TERMHUB_URL` from `apps/mobile/.env` (copy `.env.example`) to point at a local or staging server. Production builds bake `https://termhub.dev` in through `eas.json`; there is no server picker in the app (spec §11.1).

Before a production build: APNs key and FCM v1 service account in EAS credentials (`npx eas credentials`), store listings, and the reviewer notes of spec §12.3.

## Conventions

- Code, comments and commits in English; every string a person sees in pt-BR.
- Bundle / package id `dev.termhub.app`, URL scheme `termhub`.
- Pure logic goes in `src/lib` and must not import React Native: the `logic` jest project runs it in plain Node and fails otherwise.
- The monorepo pins a single React version (root `package.json` `overrides`); Expo SDK upgrades bump it for every workspace.
