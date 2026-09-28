#!/usr/bin/env bash
# Builds the iOS app for TestFlight on a Mac, without EAS.
#
#   bash scripts/ios-release.sh            # prebuild, archive, export build/export/termhub.ipa
#   bash scripts/ios-release.sh --upload   # same, then upload the build to App Store Connect
#
# Signing is Xcode's automatic signing for team S873WHF2TZ, under the Apple ID signed in to
# Xcode (Settings → Accounts). The distribution certificate is cloud-managed: its private key
# never sits in the local keychain, Xcode signs the export through Apple, and
# `-allowProvisioningUpdates` lets it create or refresh the App Store profile.
#
# Bump `expo.version` and/or `expo.ios.buildNumber` in app.json before each upload: App Store
# Connect refuses a build number it has already seen for the same version.
set -euo pipefail

cd "$(dirname "$0")/.."

TEAM_ID="${TEAM_ID:-S873WHF2TZ}"
UPLOAD=0
[ "${1:-}" = "--upload" ] && UPLOAD=1

# Baked into the JS bundle by Metro during the Xcode build phase; without them the app would
# fall back to mock mode (src/services/api/index.ts).
export EXPO_PUBLIC_API_MODE=http
export EXPO_PUBLIC_TERMHUB_URL=https://termhub.dev

BUILD_DIR="$PWD/build"
ARCHIVE="$BUILD_DIR/termhub.xcarchive"
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"

npm run build:contract
npx expo prebuild --platform ios --clean

xcodebuild archive \
  -workspace ios/termhub.xcworkspace \
  -scheme termhub \
  -configuration Release \
  -destination 'generic/platform=iOS' \
  -archivePath "$ARCHIVE" \
  -allowProvisioningUpdates \
  DEVELOPMENT_TEAM="$TEAM_ID" \
  CODE_SIGN_STYLE=Automatic

export_with() {
  local destination="$1" out="$2"
  cat > "$BUILD_DIR/ExportOptions-$destination.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>$destination</string>
  <key>teamID</key><string>$TEAM_ID</string>
  <key>signingStyle</key><string>automatic</string>
  <key>uploadSymbols</key><true/>
  <key>manageAppVersionAndBuildNumber</key><false/>
</dict>
</plist>
PLIST
  xcodebuild -exportArchive \
    -archivePath "$ARCHIVE" \
    -exportOptionsPlist "$BUILD_DIR/ExportOptions-$destination.plist" \
    -exportPath "$out" \
    -allowProvisioningUpdates
}

export_with export "$BUILD_DIR/export"

if [ "$UPLOAD" = 1 ]; then
  export_with upload "$BUILD_DIR/upload"
fi
