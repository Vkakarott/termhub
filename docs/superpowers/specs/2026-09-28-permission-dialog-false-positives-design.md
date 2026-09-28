# Chat gate: a prompt or a quoted list is not a permission menu — design

Card: **TER-380** (epic TER-1 · Chat), follow-up of TER-374 (spec 2026-09-28-permission-dialog-markers-design.md).
Server-only: one pure function, no UI, API or mobile change.

Every decision below was taken without the user (2026-09-28, asked to decide by recommendation); the reason
is written next to each one.

## 1. Problem

`permissionDialogVisible` (`apps/server/src/chat/permission-dialog.ts`) treats the screen as showing a
permission dialog when an approval phrase sits above a "selected option" line (`/^\s*[❯›>]\s*\d+\./`), or an
approval-only option label sits at or below it, in the last 25 non-blank lines. Two things that are not a
menu pass as one:

- **Claude Code's input box.** Its prompt line starts with `❯ ` too. When the typed text starts with `1. …`
  (the user's or the concierge's `send_input`), the line reads `❯ 1. …`, and if the model's previous answer
  ended with "Would you like to…?", the gate sees a dialog. Codex's composer prompt (`› `) has the same shape.
- **A quoted numbered list** in the model's prose: `> 1. …` / `> 2. …` under such a sentence.

The effect is on the safe side — a keystroke a terminal grant would cover becomes a confirmation card — but it
defeats the grant exactly in the long autonomous sessions TER-325 was for.

## 2. Decisions

| Topic | Decision | Why |
|---|---|---|
| What counts as a menu | The selected-option line (the **last** `/^\s*[❯›>]\s*(\d+)\./` line in the window, as today) must have a **sibling option**: a *plain* numbered line (`/^\s*(\d+)\./`, no cursor character) whose number is the cursor's number ± 1, within the 3 non-blank lines above or below it. Without a sibling, the new rules do not fire (the old footer + "Do you want" rule still does). | Every approval menu of Claude Code and Codex has at least two options ("Yes / No"), drawn on consecutive rows (a wrapped label or a description line may sit between them). A prompt line stands alone; a typed multi-line list is below the prompt with no cursor, so the numbers do not line up with a sibling unless the user typed exactly "1." then "2." — see "Input box". |
| One cursor per menu | If a numbered line next to the cursor (within the same 3 lines) **also** starts with a cursor character, it is not a menu. | A menu selects exactly one option. A quoted list is `> 1.` / `> 2.`: every row carries the `>`. |
| Input box | If the non-blank line **directly above** the cursor line is a horizontal rule (only `─`, `━` or `-`, at least 10 of them), the cursor line is the input box, not a menu. | Claude Code draws its input between two rules; its dialogs put a title and a question between the rule and the options, never the cursor right under it. This also covers a typed numbered list (`❯ 1. corrige` then `2. roda`), which the sibling rule alone would accept. |
| Keep `>` in the cursor class | Kept. | It is the ASCII fallback of Claude Code's pointer; the one-cursor rule is what rejects the quoted list, so dropping `>` is not needed and would risk missing a real dialog. |
| Direction of the change | The new rules only remove matches. Every positive fixture of TER-374 (all `fixtures/permission-dialogs/*` positives and the real capture `fixtures/tab-questions/screen-permission.txt`) must still be recognised. | Missing a real dialog is the unsafe direction. |
| `promptVisible` | Unchanged. | Out of scope (TER-374 §3). |

## 3. Implementation sketch

```ts
const SELECTED_OPTION = /^\s*[❯›>]\s*(\d+)\./;
const PLAIN_OPTION = /^\s*(\d+)\./;
const RULE = /^\s*[─━-]{10,}\s*$/;
const SIBLING_REACH = 3;

/** The selected option's index in `lines` if it heads a real menu, else -1. */
function menuCursor(lines: string[]): number {
  let cursor = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (SELECTED_OPTION.test(lines[i]!)) { cursor = i; break; }
  if (cursor < 0) return -1;
  if (cursor > 0 && RULE.test(lines[cursor - 1]!)) return -1; // the input box
  const n = Number(SELECTED_OPTION.exec(lines[cursor]!)![1]);
  let sibling = false;
  for (let i = Math.max(0, cursor - SIBLING_REACH); i <= Math.min(lines.length - 1, cursor + SIBLING_REACH); i++) {
    if (i === cursor) continue;
    if (SELECTED_OPTION.test(lines[i]!)) return -1; // a second cursor: a quoted list, not a menu
    const m = PLAIN_OPTION.exec(lines[i]!);
    if (m && Math.abs(Number(m[1]) - n) === 1) sibling = true;
  }
  return sibling ? cursor : -1;
}
```

`permissionDialogVisible` uses `menuCursor(lines)` where it now searches for the cursor; the rest is unchanged.

## 4. Tests

- New negatives in `fixtures/permission-dialogs/`:
  - `claude-typed-numbered-prompt.txt` — model prose ending "Would you like to proceed?", then the input box
    `❯ 1. corrige o teste` between rules and the status line.
  - `claude-typed-numbered-list.txt` — same, with a typed two-line list `❯ 1. corrige o teste` / `  2. roda a
    migration` in the input box.
  - `claude-quoted-list.txt` — prose "Would you like to proceed with one of these?" then `> 1. …` / `> 2. …`
    / `> 3. …`.
  - `codex-typed-numbered-prompt.txt` — Codex prose "Would you like to run the migration?" then the composer
    line `› 1. yes, run it` alone.
- Every existing positive still recognised (the existing `it.each` lists run unchanged), plus a positive whose
  cursor is on the **last** option (`❯ 3. No`), and one with a description line between two options.

## 5. Out of scope

- `promptVisible`; agents other than Claude Code and Codex.
