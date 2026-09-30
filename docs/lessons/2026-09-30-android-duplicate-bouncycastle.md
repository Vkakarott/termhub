---
symptom: "Execution failed for task ':app:checkReleaseDuplicateClasses'. Duplicate class org.bouncycastle.LICENSE found in modules bcprov-jdk15to18-1.81.jar and bcprov-jdk18on-1.77.jar"
tags: [mobile, android, gradle, expo-updates, bouncycastle]
evidence: fixed
pr: https://github.com/engenhariainversa/termhub/pull/258
agent: claude
date: 2026-09-30
---
## Cause

Two flavours of BouncyCastle in one APK: `expo-updates` (manifest code signing) depends on
`bcutil/bcprov-jdk15to18:1.81`, and `@pagopa/io-react-native-crypto` (the device key) on
`bcprov/bcpkix/bcutil-jdk18on:1.77`. Different artifact names, same classes, so Gradle keeps both
and the release fails its duplicate-class check. Debug builds (`npm run android`) do not run that
check, so it only shows up in `scripts/android-release.sh`.

Right after, the same release can fail with `Unexpected failure during lint analysis ...
OutOfMemoryError: Metaspace` in `:react-native-screens:lintVitalAnalyzeRelease`: the template's
`org.gradle.jvmargs` (2 GB heap, 512 MB metaspace) is too small for the release lint.

## Fix

`apps/mobile/plugins/with-single-bouncycastle.js` (listed in `app.json` plugins) appends a
`dependencySubstitution` to `android/build.gradle` that swaps every `*-jdk18on` module for its
`*-jdk15to18:1.81` twin (same API). `scripts/android-release.sh` passes
`-Dorg.gradle.jvmargs="-Xmx4g -XX:MaxMetaspaceSize=1g"` to Gradle.

## How to check

`cd apps/mobile/android && ./gradlew :app:dependencies --configuration releaseRuntimeClasspath | grep bouncycastle`
lists only `-jdk15to18` modules, and `npm run release:android -w @termhub/mobile` ends with
`BUILD SUCCESSFUL`. On a device, Ajustes → Diagnóstico da chave still says "ok" on every step.
