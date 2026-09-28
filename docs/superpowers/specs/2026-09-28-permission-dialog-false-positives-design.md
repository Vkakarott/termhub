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
| What counts as a menu | The selected-option line (the **last** `/^\s*[❯›>]\s*(\d+)\./` line in the window, as today) must have a **sibling option**: a *plain* numbered line (`/^\s*(\d+)\./`, no cursor character) whose number is the cursor's number ± 1, searched across the **whole window** in both directions — `lines` is already just the last `PROMPT_MARKER_LINES` non-blank rows, so that window is the only bound. Without a sibling, the new rules do not fire (the old footer + "Do you want" rule still does). | Every approval menu of Claude Code and Codex has at least two options ("Yes / No"), drawn on consecutive rows (a wrapped label or a description line may sit between them). A prompt line stands alone; a typed multi-line list is below the prompt with no cursor, so the numbers do not line up with a sibling unless the user typed exactly "1." then "2." — see "Input box". The 3-line reach of round 0 missed a menu whose option text wraps in a narrow pane (fix round 1, which widened it to `SIBLING_REACH_UP = 8` lines above the cursor with no limit below); a still-narrower pane wrapping an option over more than 8 continuation rows missed it again with the cursor on the *last* option, so round 2 removed the upward cap too — the window itself is the only limit, in either direction. |
| One cursor per menu | A second cursor line counts against the menu **only when it sits on an index immediately adjacent to the cursor (± 1) and its number is also the cursor's ± 1**. A cursor further away, at any distance, is never checked against this rule. | A menu selects exactly one option, and a quoted list looks exactly like that: `> 1.` / `> 2.`, consecutive rows, consecutive numbers, every row carrying the `>`. The first round rejected on *any* second cursor within the sibling reach, which also rejected a real Codex dialog whose own approval question echoes the message that triggered it — Codex (and Claude) redraw the user's or concierge's just-sent input in the transcript with the same `›`/`❯` prefix, so a message starting with a number (`› 1. roda a migration`) sitting a few lines above the real menu was mistaken for a second cursor (fix round 1, unsafe direction: a real dialog was missed). An echoed message is never on the line directly touching the menu's own options — there is always at least the question and, for edits, the file line between them — so narrowing the check to adjacency keeps rejecting the quoted list (its `>` lines are always consecutive) while no longer rejecting an echo. |
| Input box | If the non-blank line **directly above** the cursor line is a horizontal rule (only `─`, `━` or `-`, at least 10 of them), the cursor line is the input box, not a menu. | Claude Code draws its input between two rules; its dialogs put a title and a question between the rule and the options, never the cursor right under it. This also covers a typed numbered list (`❯ 1. corrige` then `2. roda`), which the sibling rule alone would accept. |
| Keep `>` in the cursor class | Kept. | It is the ASCII fallback of Claude Code's pointer; the one-cursor rule is what rejects the quoted list, so dropping `>` is not needed and would risk missing a real dialog. |
| Direction of the change | The new rules only remove matches. Every positive fixture of TER-374 (all `fixtures/permission-dialogs/*` positives and the real capture `fixtures/tab-questions/screen-permission.txt`) must still be recognised. Fix round 1 found two ways the round-0 rules over-removed (an echoed message rejected as a second cursor, a wrapped option missed by the fixed reach) and loosened both; round 2 found the round-1 reach still too narrow for a very narrow pane and removed the cap entirely, without adding any new match the earlier rounds did not already make. | Missing a real dialog is the unsafe direction. |
| `promptVisible` | Unchanged. | Out of scope (TER-374 §3). |

## 3. Implementation sketch

```ts
const SELECTED_OPTION = /^\s*[❯›>]\s*(\d+)\./;
const PLAIN_OPTION = /^\s*(\d+)\./;
const RULE = /^\s*[─━-]{10,}\s*$/;

/** The selected option's index in `lines` if it heads a real menu, else -1. */
function menuCursor(lines: string[]): number {
  let cursor = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (SELECTED_OPTION.test(lines[i]!)) { cursor = i; break; }
  if (cursor < 0) return -1;
  if (cursor > 0 && RULE.test(lines[cursor - 1]!)) return -1; // the input box
  const n = Number(SELECTED_OPTION.exec(lines[cursor]!)![1]);
  for (const i of [cursor - 1, cursor + 1]) { // an adjacent second cursor with a consecutive number: a quoted list
    if (i < 0 || i >= lines.length) continue;
    const m = SELECTED_OPTION.exec(lines[i]!);
    if (m && Math.abs(Number(m[1]) - n) === 1) return -1;
  }
  let sibling = false;
  for (let i = 0; i < lines.length; i++) { // the whole window, both directions
    if (i === cursor) continue;
    const m = PLAIN_OPTION.exec(lines[i]!);
    if (m && Math.abs(Number(m[1]) - n) === 1) sibling = true;
  }
  return sibling ? cursor : -1;
}
```

`permissionDialogVisible` uses `menuCursor(lines)` where it now searches for the cursor; the rest is unchanged.

Fix round 1 changed two things from the round-0 sketch: `SIBLING_REACH` (a single symmetric bound) became
`SIBLING_REACH_UP` alone, with the downward search running to the end of `lines`; and the second-cursor check
moved from "any cursor within the sibling reach" to "a cursor on an index immediately adjacent to `cursor`",
keeping the ± 1 number test. Fix round 2 removed `SIBLING_REACH_UP` too: the sibling loop now runs over the
whole of `lines` (index `0` to `lines.length - 1`) in both directions — the window itself is the only limit.

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
- Fix round 1 adds, all positives:
  - `codex-echo-above-dialog.txt` — a sent `› 1. roda a migration` echoed in the transcript, then a real
    Codex edit-approval dialog (question, file line, options `1.`/`2.`/`3.`) right after. Exercises the
    narrowed one-cursor rule: the echo is a second cursor three lines above the menu's own cursor, not
    adjacent to it.
  - `claude-option-description-narrow.txt` — `claude-option-description.txt`'s dialog with the question and
    the first option's description each wrapped over several short rows, so the second option sits 4 lines
    below the cursor (still within the unlimited downward search) and the question sits **below** the rule
    with no dialog-breaking gap.
  - `claude-cursor-last-option-narrow.txt` — `claude-cursor-last-option.txt`'s dialog with the middle
    option's label wrapped over 5 rows, so the cursor (on the last option) has its sibling 5 lines above it —
    exercises `SIBLING_REACH_UP = 8` (round 1).
  - All four round-0 negatives (`claude-typed-numbered-prompt.txt`, `claude-typed-numbered-list.txt`,
    `claude-quoted-list.txt`, `codex-typed-numbered-prompt.txt`) must stay rejected.
- Fix round 2 adds one positive, built inline in the test (no new fixture file): `claude-cursor-last-
  option-narrow.txt`'s shape with option 2 wrapped over 10 continuation rows instead of 4, pushing its
  sibling 11 lines above the cursor — past `SIBLING_REACH_UP = 8` — to exercise the removed cap. All earlier
  positives and negatives (round 0 and round 1) stay unchanged.

## 5. Out of scope

- `promptVisible`; agents other than Claude Code and Codex.

## 6. Known leftovers (safe side)

Still turn a keystroke into a confirmation card, all in the safe direction (over-matching, never a missed
dialog):

- A **sent numbered list** echoed in the transcript on its own (no real menu near it): the user or the
  concierge types a multi-line numbered `send_input` (`1. …` / `2. …`), and a nearby approval phrase in the
  model's own prose is enough to pass the marker check above a cursor that happens to have a sibling —
  `menuCursor` cannot tell an echoed *list* apart from a real one without knowing which side of the PTY
  drew it.
- A **multi-line list typed into Codex's composer** before it is sent: the composer buffer can itself hold
  several numbered rows (unlike Claude Code's single-line input box), which then reads exactly like a real
  Codex menu to `menuCursor`.
- A **10+ dash rule that happens to sit right above a real cursor** for a reason other than Claude Code's
  input box (e.g. a model prints its own separator line right before quoting a numbered list that starts
  with a cursor-like character) would be rejected as the input box even though it is not one; this is the
  same direction as the two above (safe) and not the one round 1 was scoped to fix.
