# Chat gate: don't drop a real menu as a quoted list or an input box — design

Card: **TER-397** (epic TER-1 · Chat), follow-up of TER-380 (spec 2026-09-28-permission-dialog-false-positives-design.md
§6). Server-only: `menuCursor` in `apps/server/src/chat/permission-dialog.ts`.

Every decision below was taken without the user (2026-09-28, asked to decide by recommendation); the reason is
written next to each one.

## 1. Problem

`menuCursor` drops the selected option (so `permissionDialogVisible` answers "no dialog" and a terminal grant sends
the key) in two cases meant to catch false positives, and both also catch real dialogs:

1. **Adjacent second cursor.** The line right above or below the cursor starts with `>`, `›` or `❯` and carries the
   neighbouring number. Meant for a quoted list (`> 1.` / `> 2.`). A Codex dialog whose command preview ends, just
   above `› 1. Yes, proceed (y)`, with a line like `> 2. Add the scope column` is dropped too.
2. **Rule right above the cursor** (10+ `─`, `━` or `-`). Meant for Claude Code's input box. A dialog whose last row
   above the options is a line of dashes (a command preview printing `----------`) is dropped too.

Rare, but on the unsafe side.

## 2. Decisions

| Topic | Decision | Why |
|---|---|---|
| Quoted list | An adjacent second cursor (index ± 1, number ± 1) drops the menu only when it uses the **same cursor character** as the cursor. | A quoted list repeats its `>` on every row. A real menu's cursor is `❯` (Claude Code) or `›` (Codex); a preview line starting with `>` next to it is a different character. The sibling rule (a plain `N.` option somewhere in the window) still rejects a quoted list that has no plain numbered line, so this check is only a second guard. |
| Input box | The cursor is the input box only when the line right above it is a rule of **box-drawing characters** (`─` or `━`, 10+) **and** another such rule appears **below** the cursor in the window. `-` no longer counts as a rule. | Claude Code draws its input between two `─` rules (the typed text, one or more rows, sits between them). Its dialogs never have a closing rule under the options, and a command preview's dashes are ASCII `-`. |
| Direction | Both changes only turn "no dialog" into "dialog" for layouts that were dropped; every TER-380 negative must stay rejected and every TER-374/TER-380 positive stay recognised. | Missing a real dialog is the unsafe side. |
| Remaining edge | Claude Code's ASCII fallback cursor `>` next to a quoted `> 2.` line would still be dropped. | The fallback never appears in termhub's tmux (UTF-8); recorded, not handled. |

## 3. Implementation sketch

```ts
const SELECTED_OPTION = /^\s*([❯›>])\s*(\d+)\./;   // group 1: the cursor character, group 2: the number
const RULE = /^\s*[─━]{10,}\s*$/;

function menuCursor(lines: string[]): number {
  // …find the last SELECTED_OPTION line as today…
  if (cursor > 0 && RULE.test(lines[cursor - 1]!) && lines.slice(cursor + 1).some((l) => RULE.test(l))) return -1;
  const [, mark, num] = SELECTED_OPTION.exec(lines[cursor]!)!;
  const n = Number(num);
  for (const i of [cursor - 1, cursor + 1]) {
    const m = i >= 0 && i < lines.length ? SELECTED_OPTION.exec(lines[i]!) : null;
    if (m && m[1] === mark && Math.abs(Number(m[2]) - n) === 1) return -1;
  }
  // …sibling search unchanged…
}
```

## 4. Tests

New positives in `fixtures/permission-dialogs/` (must be recognised):
- `codex-quote-above-options.txt` — a Codex command preview whose last row is `> 2. Add the scope column`, right above
  `› 1. Yes, proceed (y)`.
- `codex-dashes-above-options.txt` — a preview whose last row is `----------` right above the options.
- `codex-box-rule-above-options.txt` — a preview whose last row is a `──────────` line right above the options, with no
  rule below them.

Every existing case in `permission-dialog.test.ts` unchanged (TER-380 negatives: typed prompt, typed list, quoted list,
Codex composer — all still rejected).

## 5. Out of scope

- The ASCII-fallback edge (§2); `promptVisible`.
