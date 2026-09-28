# Permission dialog unsafe edges (TER-397) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `menuCursor` stops dropping a real approval menu whose preview line above the options starts with `> 2.` or is a line of dashes / box rule, while still rejecting Claude Code's input box and a quoted list.

**Architecture:** Two narrowed checks in `menuCursor` (`apps/server/src/chat/permission-dialog.ts`): the adjacent-cursor rejection requires the same cursor character; the input-box rejection requires a `─`/`━` rule above the cursor and another one below it.

**Tech Stack:** TypeScript, vitest (`@termhub/server`).

**Spec:** `docs/superpowers/specs/2026-09-28-permission-dialog-unsafe-edges-design.md`

## Global Constraints

- `SELECTED_OPTION = /^\s*([❯›>])\s*(\d+)\./` (group 1 cursor char, group 2 number); `RULE = /^\s*[─━]{10,}\s*$/`.
- Only turns dropped layouts into recognised ones: every existing case in `permission-dialog.test.ts` and `gate-runtime.terminal.test.ts` passes unchanged. `promptVisible` unchanged.
- English code/comments/commits; commit body ends with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- Docker only, from the worktree root: `docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -e npm_config_update_notifier=false -e DATABASE_URL=postgresql://x:x@127.0.0.1:1/x -v "$PWD:/w" -w /w node:22 sh -c '<cmd>'` (`D`). Install once: `D 'npm ci --no-audit --no-fund && npm run build:packages && npm run prisma:generate'`. Vitest paths are relative to `apps/server` (`src/chat/...`).

---

### Task 1: Narrow both rejections, with positive fixtures

**Files:**
- Create: `apps/server/src/chat/fixtures/permission-dialogs/{codex-quote-above-options,codex-dashes-above-options,codex-box-rule-above-options}.txt`
- Modify: `apps/server/src/chat/permission-dialog.ts`, `apps/server/src/chat/permission-dialog.test.ts`

- [ ] **Step 1: Fixtures** (UTF-8, `\n`):

`codex-quote-above-options.txt`
```
• Writing the notes before the migration
  Would you like to run the following command?
  $ printf '%s\n' '> 1. Keep the current schema' \
  > 2. Add the scope column
› 1. Yes, proceed (y)
  2. Yes, and don't ask again for commands that start with `printf` (p)
  3. No, and tell Codex what to do differently (esc)
```
`codex-dashes-above-options.txt`
```
• Printing the report header
  Would you like to run the following command?
  $ printf 'report\n'
  ----------
› 1. Yes, proceed (y)
  2. Yes, and don't ask again for commands that start with `printf` (p)
  3. No, and tell Codex what to do differently (esc)
```
`codex-box-rule-above-options.txt`
```
• Printing the report header
  Would you like to run the following command?
  $ printf 'report\n'
  ────────────────────
› 1. Yes, proceed (y)
  2. Yes, and don't ask again for commands that start with `printf` (p)
  3. No, and tell Codex what to do differently (esc)
```

- [ ] **Step 2: Failing tests** — add the three names to the "sees %s" `it.each` list in `permission-dialog.test.ts`. Change nothing else.
- [ ] **Step 3: Run, expect FAIL** — `D 'npx -w @termhub/server vitest run src/chat/permission-dialog.test.ts'`: the three new positives fail.
- [ ] **Step 4: Implement** in `menuCursor` / the constants:
  - `const SELECTED_OPTION = /^\s*([❯›>])\s*(\d+)\./;` — group 1 the cursor character, group 2 the number. Update every `exec(...)[1]` that read the number to `[2]` (in `menuCursor`; check nothing else in the file uses the old group).
  - `const RULE = /^\s*[─━]{10,}\s*$/;` — doc: Claude Code's input box is drawn between two box-drawing rules; ASCII dashes are content (a command preview), not a rule.
  - Input box: `if (cursor > 0 && RULE.test(lines[cursor - 1]!) && lines.slice(cursor + 1).some((l) => RULE.test(l))) return -1;`
  - Adjacent cursor: reject only when `m[1] === mark && Math.abs(Number(m[2]) - n) === 1`, where `mark` is the cursor's own group 1.
  - Update `menuCursor`'s doc comment: the two narrowed rules and why (TER-397: a preview line `> 2.` or `----------`/`────` right above a real Codex menu must not drop it).
- [ ] **Step 5: Run, expect PASS**, then `D 'npx -w @termhub/server vitest run src/chat && npm run typecheck -w @termhub/server'`.
- [ ] **Step 6: Commit** — `Chat gate: don't drop a real menu as a quoted list or an input box (TER-397)`.

### Task 2: Verification

- [ ] `D 'npm run typecheck -w @termhub/server && npm run build -w @termhub/web && npm run build -w @termhub/landing && npm test -w @termhub/server'`; `rm -rf .npm`.
