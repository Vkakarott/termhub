#!/usr/bin/env bash
# Publishes the current JS bundle as an over-the-air update to the xprem server, on both platforms.
#
#   EOO_TOKEN=… bash scripts/ota-publish.sh                  # message: the last commit's subject
#   EOO_TOKEN=… bash scripts/ota-publish.sh -m "what changed"
#
# The update goes to the `production` branch under runtime version `expo.version` (app.json), so
# only binaries of that exact version take it: publish from the commit the store build was cut
# from, plus JS-only changes. Anything that touches native code (a new native module, a config
# plugin, app.json fields prebuild reads) needs a new binary with a bumped `expo.version` instead.
#
# EOO_TOKEN is an API token of the termhub app, created in the xprem dashboard (API tokens).
# Extra arguments go to `eoas publish` (e.g. --rollout-percentage 20).
set -euo pipefail

cd "$(dirname "$0")/.."

: "${EOO_TOKEN:?set EOO_TOKEN to a termhub API token from the xprem dashboard}"

# The same values the store builds bake in (scripts/ios-release.sh); without them the bundle
# would fall back to mock mode (src/services/api/index.ts).
export EXPO_PUBLIC_API_MODE=http
export EXPO_PUBLIC_TERMHUB_URL=https://termhub.dev

npm run build:contract
npx -y eoas@3 publish --branch production --platform all --nonInteractive "$@"
