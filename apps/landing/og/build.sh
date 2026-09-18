#!/usr/bin/env sh
# Rasterizes og/og-image.svg (which embeds public/logo.svg) into public/og-image.png (1200x630)
# and the PNG favicons, with librsvg inside Docker (the host has no rsvg/node).
set -eu
cd "$(dirname "$0")/.."
docker run --rm -e "OWNER=$(id -u):$(id -g)" -v "$PWD:/w" -w /w alpine:3.20 sh -euc '
  apk add --no-cache -q rsvg-convert font-inter
  tmp=$(mktemp -d); cp og/og-image.svg public/logo.svg "$tmp"
  rsvg-convert -w 1200 -h 630 "$tmp/og-image.svg" -o public/og-image.png
  rsvg-convert -w 180 -h 180 public/favicon.svg -o public/apple-touch-icon.png
  rsvg-convert -w 96 -h 96 public/favicon.svg -o public/favicon-96.png
  chown "$OWNER" public/og-image.png public/apple-touch-icon.png public/favicon-96.png
'
