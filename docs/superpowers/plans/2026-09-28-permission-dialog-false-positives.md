# Permission dialog false positives (TER-380) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `permissionDialogVisible` stops treating Claude Code's input box (`❯ 1. …`), a Codex composer line and a quoted list (`> 1.` / `> 2.`) as a permission menu, while every real dialog of TER-374 stays recognised.

**Architecture:** One helper `menuCursor(lines)` in `apps/server/src/chat/permission-dialog.ts` replaces the bare cursor search: the cursor needs a plain sibling option (number ± 1 within 3 lines), no second cursor nearby, and must not sit right under a horizontal rule.

**Tech Stack:** TypeScript, vitest (`@termhub/server`).

**Spec:** `docs/superpowers/specs/2026-09-28-permission-dialog-false-positives-design.md`

## Global Constraints

- `SELECTED_OPTION = /^\s*[❯›>]\s*(\d+)\./`, `PLAIN_OPTION = /^\s*(\d+)\./`, `RULE = /^\s*[─━-]{10,}\s*$/`, `SIBLING_REACH = 3` (spec §2-3). `>` stays in the cursor class.
- The change only removes matches: every existing positive in `permission-dialog.test.ts` and `gate-runtime.terminal.test.ts` keeps passing unchanged. `promptVisible` unchanged.
- Code/comments/commits English; commit body ends with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- Docker only (no Node on host), from the worktree root: `docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -e npm_config_update_notifier=false -e DATABASE_URL=postgresql://x:x@127.0.0.1:1/x -v "$PWD:/w" -w /w node:22 sh -c '<cmd>'` (`D` below). Install once: `D 'npm ci --no-audit --no-fund && npm run build:packages && npm run prisma:generate'`. Vitest runs from the workspace root, so pass paths relative to `apps/server` (e.g. `npx -w @termhub/server vitest run src/chat/permission-dialog.test.ts`).

---

### Task 1: Menu check, fixtures and tests

**Files:**
- Create: `apps/server/src/chat/fixtures/permission-dialogs/{claude-typed-numbered-prompt,claude-typed-numbered-list,claude-quoted-list,codex-typed-numbered-prompt,claude-cursor-last-option,claude-option-description}.txt`
- Modify: `apps/server/src/chat/permission-dialog.ts`, `apps/server/src/chat/permission-dialog.test.ts`

**Interfaces:** `permissionDialogVisible(screen: string): boolean` unchanged signature.

- [ ] **Step 1: Fixtures** (UTF-8, `\n`):

`claude-typed-numbered-prompt.txt`
```
● I wrote the plan to docs/plan.md. Would you like to proceed?
────────────────────────────────────────────────────────────────────────────────
❯ 1. corrige o teste
────────────────────────────────────────────────────────────────────────────────
  Opus 5.5 (1M context) | ctx 4% (43k/1000k)
  ⏵⏵ auto mode on (shift+tab to cycle)
```
`claude-typed-numbered-list.txt`
```
● I wrote the plan to docs/plan.md. Would you like to proceed?
────────────────────────────────────────────────────────────────────────────────
❯ 1. corrige o teste
  2. roda a migration
────────────────────────────────────────────────────────────────────────────────
  ? for shortcuts
```
`claude-quoted-list.txt`
```
● Would you like to proceed with one of these?
  > 1. Keep the current schema
  > 2. Add the scope column
  > 3. Split the table
────────────────────────────────────────────────────────────────────────────────
❯ 
────────────────────────────────────────────────────────────────────────────────
  ? for shortcuts
```
`codex-typed-numbered-prompt.txt`
```
• Would you like to run the migration now?

› 1. yes, run it

  ⏎ send   ⇧⏎ newline   ⌃T transcript   ⌃C quit
```
`claude-cursor-last-option.txt` (positive)
```
────────────────────────────────────────────────────────────────────────────────
 Bash command
   rm -rf dist
 Do you want to proceed?
   1. Yes
   2. Yes, and don't ask again for rm commands in /home/dev/project
 ❯ 3. No, and tell Claude what to do differently (esc)
```
`claude-option-description.txt` (positive)
```
────────────────────────────────────────────────────────────────────────────────
 Enter plan mode?
 Claude wants to enter plan mode to explore and design an implementation approach.
 ❯ 1. Yes, enter plan mode
      Claude will explore the codebase and present a plan for your approval.
   2. No, start implementing now
```

- [ ] **Step 2: Failing tests** — in `permission-dialog.test.ts`, add `'claude-cursor-last-option.txt', 'claude-option-description.txt'` to the "sees %s" list and `'claude-typed-numbered-prompt.txt', 'claude-typed-numbered-list.txt', 'claude-quoted-list.txt', 'codex-typed-numbered-prompt.txt'` to the "ignores %s" list. Leave every other case as it is.

- [ ] **Step 3: Run, expect FAIL** — `D 'npx -w @termhub/server vitest run src/chat/permission-dialog.test.ts'`: the four new negatives fail (recognised today); the two new positives already pass.

- [ ] **Step 4: Implement** in `permission-dialog.ts`: replace `const SELECTED_OPTION = /^\s*[❯›>]\s*\d+\./;` and the cursor loop in `permissionDialogVisible` with:

```ts
/** The selected option of a numbered menu: Claude Code draws `❯ 1. Yes`, Codex `› 1. Yes, proceed (y)`
 * (`>` is Claude Code's ASCII fallback). The number is captured to find its sibling options. */
const SELECTED_OPTION = /^\s*[❯›>]\s*(\d+)\./;
/** An option that is not selected: a number and a dot, no cursor. */
const PLAIN_OPTION = /^\s*(\d+)\./;
/** A horizontal rule: Claude Code draws its input box between two of them. */
const RULE = /^\s*[─━-]{10,}\s*$/;
/** How many non-blank lines away a sibling option may be (a wrapped label or a description line). */
const SIBLING_REACH = 3;

/**
 * The index in `lines` of the selected option of a real menu, or -1 (spec 2026-09-28 TER-380). A menu
 * has a plain sibling option (the cursor's number ± 1) within `SIBLING_REACH` lines and exactly one
 * cursor; a cursor right under a rule is Claude Code's input box (`❯ 1. …` typed by the user or the
 * concierge), a lone `› 1. …` is Codex's composer, and `> 1.` / `> 2.` is a quoted list — none of them a
 * permission.
 */
function menuCursor(lines: string[]): number {
  let cursor = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (SELECTED_OPTION.test(lines[i]!)) { cursor = i; break; }
  if (cursor < 0) return -1;
  if (cursor > 0 && RULE.test(lines[cursor - 1]!)) return -1;
  const n = Number(SELECTED_OPTION.exec(lines[cursor]!)![1]);
  let sibling = false;
  for (let i = Math.max(0, cursor - SIBLING_REACH); i <= Math.min(lines.length - 1, cursor + SIBLING_REACH); i++) {
    if (i === cursor) continue;
    if (SELECTED_OPTION.test(lines[i]!)) return -1;
    const m = PLAIN_OPTION.exec(lines[i]!);
    if (m && Math.abs(Number(m[1]) - n) === 1) sibling = true;
  }
  return sibling ? cursor : -1;
}
```
and in `permissionDialogVisible`:
```ts
  const lines = lastNonBlankLines(screen, PROMPT_MARKER_LINES).split('\n');
  const cursor = menuCursor(lines);
  if (cursor < 0) return false;
```
(keep the marker-above and approval-options checks after it as they are). Update `permissionDialogVisible`'s doc comment with one sentence pointing at `menuCursor` (TER-380).

- [ ] **Step 5: Run, expect PASS**, then `D 'npx -w @termhub/server vitest run src/chat && npm run typecheck -w @termhub/server'`.
- [ ] **Step 6: Commit** — `Chat gate: a prompt or a quoted list is not a permission menu (TER-380)`.

### Task 2: Verification

- [ ] `D 'npm run typecheck -w @termhub/server && npm run build -w @termhub/web && npm run build -w @termhub/landing && npm test -w @termhub/server'`; `rm -rf .npm`.
