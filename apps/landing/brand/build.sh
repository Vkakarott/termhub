#!/usr/bin/env sh
# Builds the downloadable brand kit served at /brand/ into public/brand/:
# the mark and logo as PNG, the logo variant for light backgrounds (derived
# from public/logo.svg, so there is a single source), the 4:3 social posts
# from brand/social/ (they embed the logo/mark, like og/og-image.svg), a
# README with the palette and a .zip with everything. Runs librsvg inside Docker like
# og/build.sh (the host has no rsvg/node). Re-run after touching
# public/favicon.svg or public/logo.svg and commit the output.
set -eu
cd "$(dirname "$0")/.."
docker run --rm -e "OWNER=$(id -u):$(id -g)" -v "$PWD:/w" -w /w alpine:3.20 sh -euc '
  apk add --no-cache -q rsvg-convert zip font-inter font-jetbrains-mono
  out=public/brand
  rm -rf "$out"; mkdir -p "$out"

  # sources, under the names people download
  cp public/favicon.svg "$out/termhub-mark.svg"
  cp public/logo.svg "$out/termhub-logo.svg"
  # light background: wordmark "term" and tagline take dark tones; the mark stays as is
  sed -e "s/fill=\"#e6e8ee\"/fill=\"#0f101a\"/" -e "/<path/s/fill=\"#9aa1b1\"/fill=\"#646e87\"/" \
    public/logo.svg > "$out/termhub-logo-on-light.svg"

  for s in 1024 512 180 96; do
    rsvg-convert -w "$s" -h "$s" "$out/termhub-mark.svg" -o "$out/termhub-mark-$s.png"
  done
  rsvg-convert -w 1120 "$out/termhub-logo.svg" -o "$out/termhub-logo.png"
  rsvg-convert -w 1120 -b "#ffffff" "$out/termhub-logo-on-light.svg" -o "$out/termhub-logo-on-light.png"

  # social posts: 4:3, 1600x1200 (LinkedIn and Instagram landscape); <image href> is
  # resolved next to the SVG, so render from a temp dir holding the logo and mark
  tmp=$(mktemp -d); cp brand/social/*.svg public/logo.svg public/favicon.svg "$tmp"
  for f in brand/social/*.svg; do
    n=$(basename "$f" .svg)
    rsvg-convert -w 1600 -h 1200 "$tmp/$n.svg" -o "$out/termhub-$n.png"
  done

  cat > "$out/README.md" <<EOF
# termhub brand kit

Files
- termhub-mark.svg / termhub-mark-{1024,512,180,96}.png — the mark (app icon, favicon, avatar)
- termhub-logo.svg / termhub-logo.png — mark + wordmark + tagline, for dark backgrounds (transparent PNG)
- termhub-logo-on-light.svg / termhub-logo-on-light.png — the same for light backgrounds
- termhub-social-*.png — 4:3 posts (1600x1200) for LinkedIn and Instagram: logo only, tagline in pt and en

Colors
- Gradient (CTA): #5b63d3 -> #7c87f7
- Accent: #98a4f7
- Canvas: #0f101a
- Surface: #151621
- Border: #1f2433
- Text: #e6e8ee
- Frost: #c9d3ee
- Muted: #646e87

Type
- Inter (interface and text)
- JetBrains Mono (wordmark and terminal)

Usage rules and previews: https://termhub.dev/brand/
The name is always "termhub", lowercase.
EOF

  # -X drops per-file timestamps/uids so rebuilding without changes keeps the zip identical
  (cd "$out" && zip -q -X -r termhub-brand.zip . -x termhub-brand.zip)
  chown -R "$OWNER" "$out"
'
ls -l public/brand
