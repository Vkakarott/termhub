#!/usr/bin/env bash
# Builds the Android app for Firebase App Distribution on a Mac, without EAS.
#
#   bash scripts/android-release.sh                         # prebuild, assemble build/android/termhub.apk
#   bash scripts/android-release.sh --upload "what changed" # same, then send it to the testers' group
#
# The APK is signed with the keystore of Expo's template (android/app/debug.keystore, the same file
# on every prebuild), so each build installs over the last one. Good for App Distribution only.
#
# The upload runs under the Google account signed in to the Firebase CLI (`npx firebase-tools login`).
#
# Bump `expo.version` and `expo.android.versionCode` in app.json before each upload: a phone only
# takes an update whose version code is not below the installed one.
set -euo pipefail

cd "$(dirname "$0")/.."

FIREBASE_APP_ID="${FIREBASE_APP_ID:-1:863778957053:android:52934d5fd88b7859aac094}"
TESTERS="${TESTERS:-termhub-testers}"
UPLOAD=0
NOTES=""
if [ "${1:-}" = "--upload" ]; then
  UPLOAD=1
  NOTES="${2:-}"
  [ -n "$NOTES" ] || { echo "usage: $0 --upload \"release notes\"" >&2; exit 2; }
fi

# Baked into the JS bundle by Metro during the Gradle build; without them the app would fall back
# to mock mode (src/services/api/index.ts).
export EXPO_PUBLIC_API_MODE=http
export EXPO_PUBLIC_TERMHUB_URL=https://termhub.dev

# Its own folder under build/: scripts/ios-release.sh clears the rest of build/ for its archive.
OUT_DIR="$PWD/build/android"
APK="$OUT_DIR/termhub.apk"
rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"

npm run build:contract
npx expo prebuild --platform android --clean

(cd android && ./gradlew assembleRelease --console=plain)
cp android/app/build/outputs/apk/release/app-release.apk "$APK"
echo "Built $APK"

if [ "$UPLOAD" = 1 ]; then
  npx -y firebase-tools@latest appdistribution:distribute "$APK" \
    --app "$FIREBASE_APP_ID" \
    --groups "$TESTERS" \
    --release-notes "$NOTES"
fi
