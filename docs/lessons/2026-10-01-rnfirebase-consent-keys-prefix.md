---
symptom: "Firebase ad consent defaults in firebase.json ignored: keys written as google_analytics_default_allow_*"
tags: [mobile, firebase, analytics, consent]
evidence: fixed
card: TER-628
agent: claude
date: 2026-10-01
---
## Cause

`apps/mobile/firebase.json` named the consent defaults `google_analytics_default_allow_*`. That is the name
of the Android meta-data / Info.plist entries RNFirebase *generates*, not the key it *reads*. The keys in
`firebase.json` are `analytics_default_allow_analytics_storage`, `analytics_default_allow_ad_storage`,
`analytics_default_allow_ad_user_data` and `analytics_default_allow_ad_personalization_signals`. An unknown
key is silently ignored, so the ad signals stayed at Google's default (granted).

## Fix

Use the unprefixed keys in `apps/mobile/firebase.json`. `app-config.test.ts` now also checks every key under
`react-native` against `@react-native-firebase/app/firebase-schema.json`.

## How to check

- `npm test -w @termhub/mobile -- src/app-config.test.ts`.
- After `expo prebuild`, Android: `./gradlew :app:processDebugMainManifest`, then grep the merged manifest for
  `google_analytics_default_allow_ad_storage` with value `false`.
- iOS: the build phase writes `GOOGLE_ANALYTICS_DEFAULT_ALLOW_AD_STORAGE` = `NO` into the built Info.plist.
