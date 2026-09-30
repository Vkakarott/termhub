/**
 * Whether a tab is showing a Claude Code dialog right now, read from a plain capture of its screen. Kept
 * apart from `tab-question-answer.ts` (which re-exports all of it) so the chat gate can use the same
 * rule without importing the answer flow, which reaches back into the gate through `service.ts`.
 */
import type { TabQuestion } from '../db/repositories/tab-questions.js';
import type { ChoicePayload } from './tab-question-payload.js';

/** How much of the pane the excerpt shown with a question reads. */
export const SCREEN_EXCERPT_LINES = 20;
/** The footer both Claude Code dialogs end with ("… · Esc to cancel", "Esc to cancel · Tab to amend"). */
export const DIALOG_FOOTER = 'Esc to cancel';
/** How far above the footer the question's marker may sit: the dialog block, not the scrollback. */
export const PROMPT_MARKER_LINES = 25;

/**
 * Letters and digits only: whitespace (Claude Code wraps a long question over indented rows) and
 * every mark the terminal may render differently from the tool's input (markdown backticks and
 * asterisks, curled quotes, dashes) are dropped on both sides of the comparison.
 */
const squash = (s: string) => s.replace(/[^\p{L}\p{N}]/gu, '');
/** The last `lines` non-blank rows of a capture, as one string. */
export function lastNonBlankLines(text: string, n = SCREEN_EXCERPT_LINES): string {
  return text
    .split('\n')
    .filter((l) => l.trim() !== '')
    .slice(-n)
    .join('\n');
}

/** Codex's approval menu ends on this line; its question dialog ends on "… enter to submit answer/all …". */
const CODEX_APPROVAL_FOOTER = 'press enter to confirm or esc to cancel';
const CODEX_QUESTION_FOOTER = 'enter to submit';

/**
 * `promptVisible` for a Codex row (Codex 0.159.2): the same two-part rule with Codex's footers. The last
 * non-blank line is the menu's own footer (a tab back at its composer never passes), and the block holds
 * the dialog's marker: "Would you like to" / "Do you want to" for an approval, the first question's text
 * for a question.
 */
function codexPromptVisible(block: string, row: Pick<TabQuestion, 'kind' | 'payload'>): boolean {
  const last = block.slice(block.lastIndexOf('\n') + 1).toLowerCase();
  const shown = squashLower(block);
  if (row.kind === 'choice') {
    if (!last.includes(CODEX_QUESTION_FOOTER)) return false;
    const marker = squash((row.payload as ChoicePayload).questions[0]?.question ?? '').slice(0, 80);
    return marker !== '' && squash(block).includes(marker);
  }
  if (!last.includes(CODEX_APPROVAL_FOOTER)) return false;
  return shown.includes(squashLower('would you like to')) || shown.includes(squashLower('do you want to'));
}

/**
 * The live check (spec §5.3): the question must be the dialog the tab is showing *now*. Two things,
 * both required. The last non-blank line is a dialog's footer (`DIALOG_FOOTER`), so a tab back at
 * its normal prompt never passes, whatever its scrollback says. And the marker sits within the last
 * `PROMPT_MARKER_LINES` non-blank lines, that is inside the dialog block: the first question's text for
 * a choice, "Do you want" for a permission (Claude Code asks "Do you want to proceed?" or "Do you want
 * to make this edit…?"; the tool's name alone is not enough, it stays in the scrollback). Both sides are
 * reduced to letters and digits (`squash`) before comparing.
 */
export function promptVisible(screen: string, row: Pick<TabQuestion, 'kind' | 'payload'>): boolean {
  const block = lastNonBlankLines(screen, PROMPT_MARKER_LINES);
  if ((row.payload as { agent?: string }).agent === 'codex') return codexPromptVisible(block, row);
  if (!block.slice(block.lastIndexOf('\n') + 1).includes(DIALOG_FOOTER)) return false;
  const shown = squash(block);
  if (row.kind === 'choice') {
    const marker = squash((row.payload as ChoicePayload).questions[0]?.question ?? '').slice(0, 80);
    // A question with no letters or digits leaves no marker, and '' is in every screen.
    return marker !== '' && shown.includes(marker);
  }
  return shown.includes(squash('Do you want'));
}

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
/** The selected option of a numbered menu: Claude Code draws `❯ 1. Yes`, Codex `› 1. Yes, proceed (y)`
 * (`>` is Claude Code's ASCII fallback). Group 1 is the cursor character (to tell a real menu's cursor
 * apart from a quoted list's `>`), group 2 the number (to find its sibling options). */
const SELECTED_OPTION = /^\s*([❯›>])\s*(\d+)\./;
/** An option that is not selected: a number and a dot, no cursor. */
const PLAIN_OPTION = /^\s*(\d+)\./;
/** A box-drawing rule: Claude Code draws its input box between two of them. ASCII dashes are not a rule —
 * they are as likely a command preview's output (`printf '%s\n' '----------'`) as a real input box. */
const RULE = /^\s*[─━]{10,}\s*$/;

/**
 * Option labels that exist only in an approval menu, never in a routine one (spec 2026-09-28 TER-374
 * §3 "Approval options", fix round 1). Codex draws its question *above* the command, so a long
 * multi-line command (a heredoc, say) can push the question out of the last `PROMPT_MARKER_LINES`
 * non-blank lines while the menu itself — cursor and options — is still inside that window. Matched
 * from the selected-option line to the end of the block (the menu, not the command above it), the same
 * way as `PERMISSION_MARKERS`.
 */
export const APPROVAL_OPTIONS: readonly string[] = [
  'and tell codex what to do differently', 'and tell claude what to do differently', 'yes, proceed', "don't ask again",
  'grant these permissions', 'just this once', 'continue without running it',
];
const OPTIONS = APPROVAL_OPTIONS.map(squashLower);

/**
 * The index in `lines` of the selected option of a real menu, or -1 (spec 2026-09-28 TER-380, fix
 * round 2; TER-397 narrowed both rejections below). A menu has a plain sibling option (the cursor's
 * number ± 1), searched across the whole window — `lines` is already just the last
 * `PROMPT_MARKER_LINES` non-blank rows, so that window is the only bound in either direction (a wrapped
 * label or a multi-line description can push a sibling many rows away in a narrow pane, round 2); a
 * cursor sitting inside Claude Code's input box (drawn between two box-drawing rules, `─`/`━`, one
 * above the cursor and one further below it) is typed text (`❯ 1. …` typed by the user or the
 * concierge), not a dialog — a rule made of ASCII dashes is not enough, since a Codex command preview's
 * last line can print `----------` right above a real menu (TER-397). A second cursor immediately
 * adjacent to it (index ± 1) that repeats the *same* cursor character with a number also the cursor's ±
 * 1 is a quoted list (`> 1.` / `> 2.`, every row prefixed with the same mark) — that alone is rejected;
 * a Codex preview line like `> 2. Add the scope column` right above a real `› 1. …` menu uses a
 * different cursor character, so it no longer drops the menu (TER-397). An echoed `› 1. …` message
 * sitting further above a real Codex dialog is not rejected either, since a sent message is never
 * adjacent to the dialog's own options (round 1).
 */
function menuCursor(lines: string[]): number {
  let cursor = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (SELECTED_OPTION.test(lines[i]!)) { cursor = i; break; }
  if (cursor < 0) return -1;
  if (cursor > 0 && RULE.test(lines[cursor - 1]!) && lines.slice(cursor + 1).some((l) => RULE.test(l))) return -1;
  const [, mark, num] = SELECTED_OPTION.exec(lines[cursor]!)!;
  const n = Number(num);
  for (const i of [cursor - 1, cursor + 1]) {
    if (i < 0 || i >= lines.length) continue;
    const m = SELECTED_OPTION.exec(lines[i]!);
    if (m && m[1] === mark && Math.abs(Number(m[2]) - n) === 1) return -1;
  }
  let sibling = false;
  for (let i = 0; i < lines.length; i++) {
    if (i === cursor) continue;
    const m = PLAIN_OPTION.exec(lines[i]!);
    if (m && Math.abs(Number(m[1]) - n) === 1) sibling = true;
  }
  return sibling ? cursor : -1;
}

/**
 * Whether the screen shows an agent's permission dialog right now. Used by the gate before a terminal
 * grant presses a key (TER-325), so it leans towards "yes": `promptVisible`'s rule for a permission row
 * (footer + "Do you want"), or — for dialogs worded otherwise or without that footer — a marker phrase
 * above the menu's selected option, or an approval option at or below it, both inside the last
 * `PROMPT_MARKER_LINES` non-blank lines. The cursor keeps the model's own prose ("Would you like to
 * proceed?") from counting, and the approval-options half keeps a long command from pushing the
 * question itself out of the window (TER-374 fix round 1); a menu with no marker or approval option
 * (Claude Code's exit menu, `/resume`) is not a permission and stays free (TER-374). `menuCursor` rejects
 * a typed input box, a Codex composer line and a quoted list before either half runs, while still finding
 * a real menu next to an echoed message above it or an option wrapped over any number of rows in the
 * window (TER-380).
 */
export function permissionDialogVisible(screen: string): boolean {
  if (promptVisible(screen, { kind: 'permission', payload: { tool_name: '' } })) return true;
  const lines = lastNonBlankLines(screen, PROMPT_MARKER_LINES).split('\n');
  const cursor = menuCursor(lines);
  if (cursor < 0) return false;
  const above = squashLower(lines.slice(0, cursor).join('\n'));
  if (MARKERS.some((m) => above.includes(m))) return true;
  const menu = squashLower(lines.slice(cursor).join('\n'));
  return OPTIONS.some((o) => menu.includes(o));
}
