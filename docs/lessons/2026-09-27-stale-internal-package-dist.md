---
symptom: "TS2305: Module '"@termhub/mobile-api"' has no exported member 'PullRequestBadge'"
tags: [typescript, monorepo, packages]
evidence: fixed
card: TER-205
agent: claude
date: 2026-09-27
---
## Cause

Internal workspace packages (`@termhub/mobile-api`, `agent-protocol`, `machine-ops`, …) resolve to
their built `dist/` — the package's `package.json` `"main"`/`"types"`/`"exports"` all point at
`./dist`, not the source. After pulling or rebasing onto a `main` that changed one of these packages'
source, `npm ci` alone leaves `dist/` stale: the server typecheck then sees the old, pre-rebase exports
and fails with `TS2305` in files the current change never touched.

## Fix

Run `npm run build:packages` from the repo root before `npm run typecheck -w @termhub/server` — the CI
workflow (`.github/workflows/deploy.yml`) does the same, which is why CI was green while a local
typecheck right after a rebase was not.

On jarvis (the host has no Node), run it through Docker — the pattern `CLAUDE.md` uses, with `node:22`,
the Node version CI runs (`.github/workflows/deploy.yml`):

```bash
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/w" -w /w node:22 \
  sh -c 'npm run build:packages && npm run typecheck -w @termhub/server'
rm -rf .npm
```

## How to check

The typecheck exits 0 with no `TS2305` errors.
