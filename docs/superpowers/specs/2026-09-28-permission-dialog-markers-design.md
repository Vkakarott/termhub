# Chat gate: recognise more permission dialogs on screen — design

Card: **TER-374** (epic TER-1 · Chat), follow-up of TER-325 (spec 2026-09-27-chat-terminal-grant-design.md §2
"Detecting a permission dialog", §8). Server-only: no UI, no API, no mobile change.

Every decision below was taken without the user (2026-09-28, asked to decide by recommendation); the
reason is written next to each one.

## 1. Problem

Before a terminal grant ("Liberar teclas e shell nesta aba" / "Liberar tudo neste projeto") presses a key or
types into a tab, the gate captures the tab's last lines and asks the user instead when a permission dialog
is on screen (`permissionDialogVisible`, `apps/server/src/chat/permission-dialog.ts`). Today that check is
`promptVisible`'s rule for a permission row: the last non-blank line contains Claude Code's footer
`Esc to cancel` **and** "Do you want" is in the last 25 non-blank lines.

That misses every dialog worded otherwise, and every dialog without that footer:

- Claude Code: "Would you like to proceed?" (exit plan mode), "Enter plan mode?", "Use this skill?",
  "Allow reads outside the working directories?", "Approve this command?", "Run this command?", the
  workspace trust dialog ("Is this a project you created or one you trust?"), …
- Codex (which `start_agent` also runs): "Would you like to run the following command?", "Would you like to
  make the following edits?", "Would you like to grant these permissions?", "Do you want to approve network
  access to …", and its footer is not `Esc to cancel`.

On a tab without monitor hooks (or in the moment before the hook reports `waiting_permission`), a granted
Enter / `1` / `y` could answer such a dialog.

## 2. Where the texts come from

The strings were read from the shipped binaries, not guessed: Claude Code **2.1.283** (the version on jarvis,
`strings` of `~/.local/share/claude/versions/2.1.283`) and Codex **0.157.1** (`@openai/codex@0.157.1-linux-x64`,
`strings` of `vendor/x86_64-unknown-linux-musl/bin/codex`). The real Claude Code permission capture already in
the repo (`fixtures/tab-questions/screen-permission.txt`) fixes the layout: the question, then the numbered
options with the `❯` cursor on the selected one, then the footer.

## 3. Decisions

| Topic | Decision | Why |
|---|---|---|
| Shape of the new rule | A permission dialog is on screen when, inside the last `PROMPT_MARKER_LINES` (25) non-blank lines, a **marker phrase** appears **above** a **selected-option line** (`❯`, `›` or `>` followed by `N.`). The old rule (footer + "Do you want") stays as an alternative: either one is enough. | Both agents draw their dialogs as a numbered menu with a cursor on the selected option; requiring it keeps the model's own prose ("Would you like me to…?") from counting, and does not depend on each dialog's footer. Keeping the old rule means nothing that was recognised before stops being recognised. |
| Marker phrases | Generic: "do you want to", "do you wish to", "would you like to". Specific: "enter plan mode", "exit plan mode", "ready to code", "allow reads outside", "approve the command", "approve this command", "run this command", "use this skill", "allow claude to", "trust this directory", "a project you created or one you trust", "needs your approval", "approve network access". Compared lower-cased and reduced to letters and digits, like `promptVisible` does. | The generic three cover almost every Claude Code and Codex approval question; the specific ones cover the titles that are not phrased as "do you / would you". Over-matching only turns a keystroke into a confirmation card — the safe direction. |
| Routine menus stay free | Menus with no marker and no approval option (Claude Code's "Exit and stop tasks / Move to background and exit", `/resume`, `/model`, `claude agents`) are not recognised. | TER-325's point is that those keys run without a card. |
| Approval options (fix round 1) | Codex draws its question *above* the command ("Would you like to run the following command?" then `$ …` then the menu), so a long multi-line command (a heredoc, say) can push the question itself out of the last `PROMPT_MARKER_LINES` non-blank lines while the menu — cursor and options — stays inside that window; `permissionDialogVisible` would then miss it and a granted key would run the command, the unsafe direction. Add a second phrase list, **approval options** — "and tell codex what to do differently", "and tell claude what to do differently", "yes, proceed", "don't ask again", "grant these permissions", "just this once", "continue without running it" — matched from the selected-option line to the end of the block (the menu itself), the same squash-and-lower-case as the markers. The dialog is now visible when the old rule holds, or a cursor is found and (a marker sits above it **or** an approval option sits at or below it). | These labels exist only in an approval menu, never in a routine one, so matching them is still one-sided towards "yes". Keeping the option list separate from the marker list keeps the "menu vs. command" split explicit and lets `/resume`'s numbered list (which has a cursor but no marker and no approval-shaped option) stay unrecognised. |
| `promptVisible` (answering a tab question) | **Unchanged.** | There the error has the opposite cost: a false "visible" presses a key into whatever is on screen. Its strict rule (footer + the row's own marker) is right; answering plan-mode or Codex dialogs from a card is a separate feature. |
| Fixtures | Synthetic screens in `apps/server/src/chat/fixtures/permission-dialogs/`, one per dialog, laid out like the real capture (question, `❯`/`›` options, footer) with the exact strings from §2; plus negatives. | Capturing each dialog live needs agents running and approving on a real account. The texts are the shipped ones; the layout is the real one. |
| Screen text | Never logged (unchanged). | CLAUDE.md. |

## 4. Implementation

`permission-dialog.ts`:

```ts
/** Questions and titles of the approval dialogs of Claude Code 2.1.283 and Codex 0.157.1 (spec
 * 2026-09-28 §3), squashed like the screen. */
const PERMISSION_MARKERS = [...].map(squashLower);
/** Option labels that exist only in an approval menu (spec §3 "Approval options", fix round 1). */
const APPROVAL_OPTIONS = [...].map(squashLower);
/** A selected option of a numbered menu: Claude Code draws `❯ 1. Yes`, Codex `› 1. Yes, proceed (y)`. */
const SELECTED_OPTION = /^\s*[❯›>]\s*\d+\./;

export function permissionDialogVisible(screen: string): boolean {
  if (promptVisible(screen, { kind: 'permission', payload: { tool_name: '' } })) return true;
  const lines = lastNonBlankLines(screen, PROMPT_MARKER_LINES).split('\n');
  const cursor = findLastIndex(lines, (l) => SELECTED_OPTION.test(l));
  if (cursor < 0) return false;
  const above = squashLower(lines.slice(0, cursor).join('\n'));
  if (PERMISSION_MARKERS.some((m) => above.includes(m))) return true;
  const menu = squashLower(lines.slice(cursor).join('\n'));
  return APPROVAL_OPTIONS.some((o) => menu.includes(o));
}
```

## 5. Tests

`permission-dialog.test.ts` over the fixtures:

- Recognised: Claude Code Bash (the existing real capture), file edit ("Do you want to make this edit to…"),
  WebFetch ("Do you want to allow Claude to fetch this content?"), network ("Do you want to allow this
  connection?"), exit plan mode ("Would you like to proceed?"), enter plan mode, skill ("Use this skill?"),
  reads outside ("Allow reads outside the working directories?"), workspace trust; Codex command, edits,
  permissions, network.
- Not recognised: Claude Code's normal prompt; the exit menu ("Move to background and exit"); a
  `/resume`-style list (a numbered session menu with a cursor, no marker, no approval option); the model's
  prose ending "Would you like to proceed?" with no option cursor; a dialog that scrolled away (marker only
  above the last 25 non-blank lines); a menu whose cursor is **above** the marker text.
- Fix round 1: a Codex command over ~30 lines (a heredoc) whose question scrolled out of the window is still
  recognised, by an approval option ("yes, proceed") at the cursor line itself; the exit menu stays
  unrecognised even under the new approval-options check; the same dialog over CRLF line endings; a
  footer-less question wrapped over two lines.
- `gate-runtime.terminal.test.ts`: a granted `send_key` on a tab whose screen shows the exit-plan-mode dialog
  (no `Esc to cancel` footer needed) is asked.

## 6. Out of scope

- Answering these dialogs from the chat's question cards (`promptVisible`).
- Live captures from real sessions; other agents than Claude Code and Codex.
