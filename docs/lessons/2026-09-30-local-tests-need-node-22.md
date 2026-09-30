---
symptom: "extraction worker failed to start / ReferenceError: navigator is not defined (tests pass in CI, fail locally)"
tags: [tests, node, docker, vitest, local-dev]
evidence: fixed
card: TER-589
agent: claude
date: 2026-09-30
---
## Cause

CI runs the tests on Node 22 (`node-version: 22` in `.github/workflows/deploy.yml`), and the local
verification in `CLAUDE.md` runs in `node:20`. Two groups of tests need Node 22:

- `apps/server/src/chat/attachments/*` (the real extraction worker) fails on Node 20 with
  `extraction worker failed to start`.
- `apps/web/src/office/scene/*` fails with `ReferenceError: navigator is not defined`. Node 21+ has a
  global `navigator`; Node 20 does not.

Also, the `*.e2e.test.ts` files (`start_agent`, terminals, gate) need `tmux`. CI installs it; a plain
`node` container does not have it, so locally they are skipped silently and a broken fixture (for
example a repository the code now reads, missing from the e2e fake) only shows up in CI.

Neither failure has anything to do with the branch under test. They fail the same way on any checkout
under Node 20.

## Fix

Run the test suites in `node:22`, like CI does, with tmux for the e2e files. Typecheck and build in
`node:20` are fine.

```bash
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/w" -w /w node:22 \
  sh -c 'cd apps/server && npx vitest run src/chat/attachments && cd ../web && npx vitest run src/office'
# e2e: tmux needs root to install, so give the files back to your user afterwards
docker run --rm -e HOME=/tmp -e DATABASE_URL=postgresql://x:x@localhost:5432/x -v "$PWD:/w" -w /w node:22 \
  sh -c "apt-get update -qq && apt-get install -y -qq tmux >/dev/null; cd apps/server && npx vitest run e2e; chown -R $(id -u):$(id -g) /w/apps/server"
rm -rf .npm
```

## How to check

Under `node:22`, `src/chat/attachments` reports 120 tests passed and `src/office` reports 117 tests
passed; `npx vitest run e2e` with tmux reports 5 files and 76 tests passed instead of skipping them.
The same commands under `node:20` fail as in `symptom`.
