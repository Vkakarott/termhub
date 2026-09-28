# Permission dialog markers (TER-374) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `permissionDialogVisible(screen)` recognises every Claude Code 2.1.283 / Codex 0.157.1 approval dialog (not only "Do you want" + `Esc to cancel`), so a terminal grant asks instead of pressing a key into one.

**Architecture:** One pure function in `apps/server/src/chat/permission-dialog.ts` gains a second rule: a marker phrase above a selected-option line (`❯`/`›`/`>` + `N.`) within the last 25 non-blank lines. `promptVisible` is untouched. Screen fixtures under `apps/server/src/chat/fixtures/permission-dialogs/`.

**Tech Stack:** TypeScript, vitest (server workspace `@termhub/server`).

**Spec:** `docs/superpowers/specs/2026-09-28-permission-dialog-markers-design.md`

## Global Constraints

- Markers exactly (spec §3): generic "do you want to", "do you wish to", "would you like to"; specific "enter plan mode", "exit plan mode", "ready to code", "allow reads outside", "approve the command", "approve this command", "run this command", "use this skill", "allow claude to", "trust this directory", "a project you created or one you trust", "needs your approval", "approve network access". Compared lower-cased, letters and digits only.
- Selected-option line: `/^\s*[❯›>]\s*\d+\./`. The marker must be above the last such line, both inside `lastNonBlankLines(screen, PROMPT_MARKER_LINES)` (25).
- The old rule (footer `Esc to cancel` on the last line + "Do you want") stays an alternative (OR).
- `promptVisible` behaviour unchanged; its existing tests must pass untouched.
- Never log screen text. Code, comments, commits in English; commit body ends with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- No Node on the host: run through Docker from the worktree root:
  `docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -e npm_config_update_notifier=false -e DATABASE_URL=postgresql://x:x@127.0.0.1:1/x -v "$PWD:/w" -w /w node:22 sh -c '<cmd>'` (`D '<cmd>'` below). Install once: `D 'npm ci && npm run build:packages && npm run prisma:generate'`.

---

### Task 1: Fixtures, the marker rule and its tests

**Files:**
- Create: `apps/server/src/chat/fixtures/permission-dialogs/*.txt` (listed below)
- Create: `apps/server/src/chat/permission-dialog.test.ts`
- Modify: `apps/server/src/chat/permission-dialog.ts`
- Modify: `apps/server/src/chat/gate-runtime.terminal.test.ts` (one case)

**Interfaces:**
- Produces: `permissionDialogVisible(screen: string): boolean` (same signature, wider rule); exported `PERMISSION_MARKERS: readonly string[]` (the raw phrases, for tests/docs).

- [ ] **Step 1: Fixtures.** Create these files (UTF-8, `\n` line ends). Every positive one ends like the real capture `fixtures/tab-questions/screen-permission.txt`: some transcript above, a rule line, the dialog.

`claude-edit.txt`
```
● Update(src/app.ts)
────────────────────────────────────────────────────────────────────────────────
 Edit file
 src/app.ts
   12 -  const port = 3000;
   12 +  const port = Number(process.env.PORT ?? 3000);
 Do you want to make this edit to app.ts?
 ❯ 1. Yes
   2. Yes, allow all edits during this session (shift+tab)
   3. No, and tell Claude what to do differently (esc)
 Esc to cancel
```
`claude-webfetch.txt`
```
● Fetch(https://example.com/docs)
────────────────────────────────────────────────────────────────────────────────
 Fetch
   https://example.com/docs
 Do you want to allow Claude to fetch this content?
 ❯ 1. Yes
   2. Yes, and don't ask again for example.com
   3. No, and tell Claude what to do differently (esc)
```
`claude-network.txt`
```
────────────────────────────────────────────────────────────────────────────────
 Network request outside of sandbox
   registry.npmjs.org:443
 Do you want to allow this connection?
 ❯ 1. Yes
   2. Yes, and don't ask again for registry.npmjs.org
   3. No, and tell Claude what to do differently
```
`claude-exit-plan.txt`
```
● Here is Claude's plan:
  1. Add the migration
  2. Update the repository
────────────────────────────────────────────────────────────────────────────────
 Ready to code?
 Claude has written up a plan and is ready to execute. Would you like to proceed?
 ❯ 1. Yes, and auto-accept edits
   2. Yes, and manually approve edits
   3. No, keep planning
```
`claude-enter-plan.txt`
```
────────────────────────────────────────────────────────────────────────────────
 Enter plan mode?
 Claude wants to enter plan mode to explore and design an implementation approach.
 ❯ 1. Yes, enter plan mode
   2. No, start implementing now
```
`claude-skill.txt`
```
────────────────────────────────────────────────────────────────────────────────
 Use skill "deploy"
 Use this skill?
 Claude may use instructions, code, or files from this Skill.
 ❯ 1. Yes
   2. Yes, and don't ask again for deploy
   3. No
```
`claude-reads-outside.txt`
```
────────────────────────────────────────────────────────────────────────────────
 Read outside the working directories
 Allow reads outside the working directories?
 ❯ 1. Yes, keep allowing reads outside the working directories
   2. No, block reads outside the working directories from now on
   3. No, ask again next time
```
`claude-trust.txt`
```
────────────────────────────────────────────────────────────────────────────────
 Accessing workspace:
 /home/dev/new-project
 Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source
 project, or work from your team). If not, take a moment to review what's in this folder first.
 ❯ 1. Yes, I trust this folder
   2. No, exit
 Enter to confirm · Esc to cancel
```
`codex-command.txt`
```
• Running tests before the migration
  Would you like to run the following command?
  $ npm test -w @termhub/server
› 1. Yes, proceed (y)
  2. Yes, and don't ask again for commands that start with `npm test` (p)
  3. No, and tell Codex what to do differently (esc)
  Press enter to confirm or esc to cancel
```
`codex-edits.txt`
```
  Would you like to make the following edits?
  src/app.ts (+1 -1)
› 1. Yes, proceed (y)
  2. Yes, and don't ask again for these files (a)
  3. No, and tell Codex what to do differently (esc)
```
`codex-permissions.txt`
```
  Would you like to grant these permissions?
  write: /home/dev/project/dist
› 1. Yes, grant these permissions for this turn
  2. Yes, grant these permissions for this session
  3. No, continue without running it
```
`codex-network.txt`
```
  Do you want to approve network access to "registry.npmjs.org"?
› 1. Yes, just this once
  2. Yes, and allow this host for this conversation
  3. No, and block this host in the future
```
Negatives:
`claude-prompt.txt`
```
● Done. The migration is in place and the tests pass.
────────────────────────────────────────────────────────────────────────────────
❯ 
────────────────────────────────────────────────────────────────────────────────
  ? for shortcuts
```
`claude-exit-menu.txt`
```
────────────────────────────────────────────────────────────────────────────────
 Background work is running
 The following will stop when you exit:
   • npm run dev
 ❯ 1. Exit and stop tasks
   2. Move to background and exit
```
`claude-prose-question.txt`
```
● I wrote the plan to docs/plan.md. Would you like to proceed?
────────────────────────────────────────────────────────────────────────────────
❯ 
────────────────────────────────────────────────────────────────────────────────
  ? for shortcuts
```
`claude-cursor-above-marker.txt`
```
 ❯ 1. Exit and stop tasks
   2. Move to background and exit
● Do you want to proceed? That was the question in the old dialog.
────────────────────────────────────────────────────────────────────────────────
  ? for shortcuts
```
(For "dialog scrolled away", the test builds it: `claude-exit-plan.txt` followed by 30 lines of `● line N` and `claude-prompt.txt`.)

- [ ] **Step 2: Failing tests** `permission-dialog.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { permissionDialogVisible, promptVisible } from './permission-dialog.js';

const fx = (name: string) => readFileSync(new URL(`./fixtures/permission-dialogs/${name}`, import.meta.url), 'utf8');
const real = readFileSync(new URL('./fixtures/tab-questions/screen-permission.txt', import.meta.url), 'utf8');

describe('permissionDialogVisible', () => {
  it('still sees the real Claude Code Bash capture', () => expect(permissionDialogVisible(real)).toBe(true));
  it.each([
    'claude-edit.txt', 'claude-webfetch.txt', 'claude-network.txt', 'claude-exit-plan.txt', 'claude-enter-plan.txt', 'claude-skill.txt',
    'claude-reads-outside.txt', 'claude-trust.txt', 'codex-command.txt', 'codex-edits.txt', 'codex-permissions.txt', 'codex-network.txt',
  ])('sees %s', (f) => expect(permissionDialogVisible(fx(f))).toBe(true));
  it.each(['claude-prompt.txt', 'claude-exit-menu.txt', 'claude-prose-question.txt', 'claude-cursor-above-marker.txt'])('ignores %s', (f) =>
    expect(permissionDialogVisible(fx(f))).toBe(false));
  it('ignores a dialog that scrolled away', () => {
    const filler = Array.from({ length: 30 }, (_, i) => `● line ${i}`).join('\n');
    expect(permissionDialogVisible(`${fx('claude-exit-plan.txt')}\n${filler}\n${fx('claude-prompt.txt')}`)).toBe(false);
  });
});

describe('promptVisible stays strict', () => {
  it('does not accept a permission dialog without the Esc footer', () =>
    expect(promptVisible(fx('claude-exit-plan.txt'), { kind: 'permission', payload: { tool_name: 'ExitPlanMode' } })).toBe(false));
});
```

In `gate-runtime.terminal.test.ts`, next to the existing "a permission dialog on screen asks…" case, add:

```ts
it('an exit-plan-mode dialog on screen asks, with no Esc footer (TER-374)', async () => {
  seedTabGrant('t1');
  vi.mocked(readScreen).mockResolvedValueOnce({ tab_id: 't1', lines: 40, styled: false, text: readFileSync(new URL('./fixtures/permission-dialogs/claude-exit-plan.txt', import.meta.url), 'utf8') });
  expect(await call('send_key', { tab_id: 't1', key: 'Enter' })).toMatchObject({ code: 'CONFIRMATION_PENDING' });
  expect(run).not.toHaveBeenCalled();
});
```
(import `readFileSync` from `node:fs` at the top.)

- [ ] **Step 3: Run, expect FAIL** — `D 'npx -w @termhub/server vitest run apps/server/src/chat/permission-dialog.test.ts apps/server/src/chat/gate-runtime.terminal.test.ts'`: the non-`Do you want`+footer positives and the gate case fail; negatives and the real capture pass.

- [ ] **Step 4: Implement** in `permission-dialog.ts` (below `promptVisible`, replacing the one-line `permissionDialogVisible`):

```ts
/**
 * Questions and titles of the approval dialogs of Claude Code 2.1.283 and Codex 0.157.1, read from the
 * shipped binaries (spec 2026-09-28 TER-374 §2-3). The generic three cover almost every approval
 * question; the rest are titles not phrased as "do you / would you". Over-matching only turns a
 * keystroke into a confirmation card, never the other way round.
 */
export const PERMISSION_MARKERS: readonly string[] = [
  'do you want to', 'do you wish to', 'would you like to',
  'enter plan mode', 'exit plan mode', 'ready to code', 'allow reads outside', 'approve the command', 'approve this command',
  'run this command', 'use this skill', 'allow claude to', 'trust this directory', 'a project you created or one you trust',
  'needs your approval', 'approve network access',
];
const squashLower = (s: string) => squash(s).toLowerCase();
const MARKERS = PERMISSION_MARKERS.map(squashLower);
/** The selected option of a numbered menu: Claude Code draws `❯ 1. Yes`, Codex `› 1. Yes, proceed (y)`. */
const SELECTED_OPTION = /^\s*[❯›>]\s*\d+\./;

/**
 * Whether the screen shows an agent's permission dialog right now. Used by the gate before a terminal
 * grant presses a key (TER-325), so it leans towards "yes": `promptVisible`'s rule for a permission row
 * (footer + "Do you want"), or — for dialogs worded otherwise or without that footer — a marker phrase
 * above the menu's selected option, both inside the last `PROMPT_MARKER_LINES` non-blank lines. The
 * cursor keeps the model's own prose ("Would you like to proceed?") from counting; a menu with no
 * marker (Claude Code's exit menu, `/resume`) is not a permission and stays free (TER-374).
 */
export function permissionDialogVisible(screen: string): boolean {
  if (promptVisible(screen, { kind: 'permission', payload: { tool_name: '' } })) return true;
  const lines = lastNonBlankLines(screen, PROMPT_MARKER_LINES).split('\n');
  let cursor = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (SELECTED_OPTION.test(lines[i]!)) { cursor = i; break; }
  if (cursor < 0) return false;
  const above = squashLower(lines.slice(0, cursor).join('\n'));
  return MARKERS.some((m) => above.includes(m));
}
```

- [ ] **Step 5: Run, expect PASS**, then the whole chat folder and typecheck: `D 'npx -w @termhub/server vitest run apps/server/src/chat && npm run typecheck -w @termhub/server'`.
- [ ] **Step 6: Commit** — `Chat gate: recognise more permission dialogs on screen (TER-374)`.

### Task 2: Verification

- [ ] `D 'npm run typecheck -w @termhub/server && npm run build -w @termhub/web && npm run build -w @termhub/landing && npm test -w @termhub/server'`; `rm -rf .npm`.
