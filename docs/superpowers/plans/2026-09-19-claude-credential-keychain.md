# Plan: read the live Claude Code credential on macOS (keychain, per config dir)

## Problem (verified on the Mac mini, 2026-09-19)

`credentialScript('claude')` in `packages/machine-ops/src/ai-credentials.ts` prints
`$D/.credentials.json` when the file exists and only falls back to the macOS keychain
item `Claude Code-credentials` when it does not. On macOS, Claude Code keeps the live
OAuth token in the keychain and the `.credentials.json` copies go stale, so the
Settings → AI accounts card shows "Claude Code token expired" for every Claude account
on a Mac even though `claude` works. It also ignores that Claude Code uses a
**per-config-dir keychain item** when `CLAUDE_CONFIG_DIR` is set:
`Claude Code-credentials-<first 8 hex chars of sha256(absolute config dir path)>`.
Empirically: sha256("/Users/pedrogoiania/.claude-drhorton")[:8] = `857a56c3` and the
item `Claude Code-credentials-857a56c3` holds that account's live token; the default
`~/.claude` uses the unsuffixed item.

## Global constraints

- Backward compatible in both directions: a 0.1.6 agent still returns a single JSON
  document; the new server must parse that. A new agent talking to the deployed server
  happens only after the server deploys (server deploys on merge; agent publishes from
  the same push), but keep the new agent output parseable by the old `JSON.parse`
  path as far as possible is NOT required — separator approach is fine.
- Keep credential content out of logs (never log stdout).
- Shell rules from CLAUDE.md: POSIX sh only, `security`/`shasum` may be missing —
  every command must be guarded with `2>/dev/null || true` so the script still exits 0.
- Do not change behaviour for `chatgpt`, `gemini`, `antigravity`.
- Code comments and commit messages in English.

## Task 1 — machine-ops: emit every candidate credential

File: `packages/machine-ops/src/ai-credentials.ts` (+ new `ai-credentials.test.ts`).

Change the `claude` branch of `credentialScript` to print **all** candidates, each
followed by a separator line, in this order:

1. `$D/.credentials.json` if it is a file (`cat`).
2. On Darwin only (`uname -s` = Darwin):
   a. the per-dir keychain item: compute `H=$(printf %s "$D" | shasum -a 256 2>/dev/null | cut -c1-8)`
      — strip a trailing `/` from `$D` first (`D=${D%/}`), and only if `$H` is non-empty
      run `security find-generic-password -s "Claude Code-credentials-$H" -w 2>/dev/null`;
   b. the unsuffixed item `Claude Code-credentials`, **only when** `"$D" = "$HOME/.claude"`
      (for any other dir the unsuffixed item belongs to a different account and must not
      be considered).

Export a constant `CREDENTIAL_SEPARATOR = '---termhub-credential---'` from the same
module (and re-export from `index.ts` if the package re-exports explicitly). After each
candidate print `printf '\n%s\n' "$SEP"` so the server can split. Guard every command so
the script exits 0 even when nothing is found (an empty stdout means "no credential").

Tests (vitest, in `packages/machine-ops/src/ai-credentials.test.ts`): assert the script
contains the file path, the suffixed keychain lookup using `shasum -a 256`, the
`$HOME/.claude` guard for the unsuffixed item, and the separator; assert the other
providers' scripts are unchanged (no separator). Additionally, one test that actually
runs the generated script with `/bin/sh` against a temp dir containing a fake
`.credentials.json` on a non-Darwin path (mock `uname` by prepending a temp bin dir with
a `uname` script that prints `Linux` to PATH) and checks stdout = file content +
separator.

## Task 2 — server: pick the freshest candidate

File: `apps/server/src/ai/claude.ts` (+ `claude.test.ts`).

`parseCredential(stdout)`: split on `CREDENTIAL_SEPARATOR` (imported from
`@termhub/machine-ops`), trim each chunk, drop empties, `JSON.parse` each chunk that
parses (ignore chunks that do not parse or lack `claudeAiOauth.accessToken`), and return
the candidate with the **largest `expiresAt`** (a candidate without `expiresAt` counts as
0, i.e. loses to any dated one but still wins when it is the only one). If no chunk yields
a token, throw `new Error('Claude Code credential has no OAuth token')` as today. A plain
single JSON document without any separator must keep working (old agents).

Tests: single doc (old format) → parsed; file stale + keychain fresh → keychain token;
garbage chunk + valid chunk → valid; no valid chunk → throws.

Also update the `expired` hint in `fetchUsage` to:
`'Run `claude` on that machine once; it refreshes the token on use (on macOS the live token lives in the keychain).'`

## Task 3 — agent: bump and document

- `apps/agent/package.json`: version `0.1.6` → `0.1.7` (the publish workflow publishes
  on version change).
- `apps/agent/src/rpc/ai.test.ts`: if it asserts the exact script text, update it.
- README.md: in the AI accounts section (search for "credentials.json" or "keychain"),
  one sentence saying that on macOS the agent reads the keychain item for the configured
  dir and picks the freshest credential, so an agent ≥ 0.1.7 is needed on Macs.

Run `npm test -w @termhub/machine-ops -w @termhub/server -w @termhub/agent` (or the
per-workspace equivalents) and `npm run typecheck` for server and agent.
