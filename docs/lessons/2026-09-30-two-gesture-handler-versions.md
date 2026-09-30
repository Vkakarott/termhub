---
symptom: "npm ls react-native-gesture-handler shows 3.3.0 (under expo-router) next to the 2.32.0 the app asked for"
tags: [mobile, expo, npm, native-modules, workspaces]
evidence: fixed
card: TER-447
agent: claude
date: 2026-09-30
---
## Cause

`expo-router` and `react-native-drawer-layout` list `react-native-gesture-handler` as a peer with a
loose range (`*`, `>= 2.0.0`). Before the app depended on it, npm auto-installed the latest one (3.3.0)
at the root `node_modules`. Adding `react-native-gesture-handler@~2.32.0` (the version Expo 57 pins in
`bundledNativeModules.json`) to `apps/mobile` then left **two copies**: 2.32.0 under
`apps/mobile/node_modules` and 3.3.0 at the root, which expo-router's own imports resolve. A native
module with two JS versions in one bundle means the router's gesture code talks to a native side it
was not written for. Nothing fails at install or in jest; it shows up only in a device build.

A plain `npm install` after adding a root `overrides` entry does not fix it either: the lockfile keeps
the old resolution (`npm ls` then reports `invalid ... overridden`).

## Fix

- Pin the version once for the whole tree in the root `package.json` `overrides`:
  `"react-native-gesture-handler": "~2.32.0"`.
- Drop the stale entries from `package-lock.json` (`node_modules/react-native-gesture-handler` and
  `apps/mobile/node_modules/react-native-gesture-handler`), remove those two folders, and run
  `npm install` again (through Docker on jarvis).

## How to check

`npm ls react-native-gesture-handler` shows only `2.32.0` (the app's, and `deduped` under expo-router
and react-native-drawer-layout), and there is a single `node_modules/react-native-gesture-handler`.
Do the same check whenever a native module that some library already lists as a peer is added.
