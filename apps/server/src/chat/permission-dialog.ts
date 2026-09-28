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
 * (`>` is Claude Code's ASCII fallback). The number is captured to find its sibling options. */
const SELECTED_OPTION = /^\s*[❯›>]\s*(\d+)\./;
/** An option that is not selected: a number and a dot, no cursor. */
const PLAIN_OPTION = /^\s*(\d+)\./;
/** A horizontal rule: Claude Code draws its input box between two of them. */
const RULE = /^\s*[─━-]{10,}\s*$/;
/** How far above the cursor a sibling option may sit: a wrapped label or a multi-line description can
 * push it up several rows in a narrow pane. Downward has no limit — the window itself (`PROMPT_MARKER_LINES`)
 * is the only bound, since the remaining options are always listed right after, never past more prose. */
const SIBLING_REACH_UP = 8;

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
 * round 1). A menu has a plain sibling option (the cursor's number ± 1), searched up to
 * `SIBLING_REACH_UP` lines above the cursor and with no limit below it (a wrapped label or a multi-line
 * description in a narrow pane); a cursor right under a rule is Claude Code's input box (`❯ 1. …` typed
 * by the user or the concierge). A second cursor immediately adjacent to it (index ± 1) whose number is
 * also the cursor's ± 1 is a quoted list (`> 1.` / `> 2.`, every row prefixed) — that alone is rejected;
 * an echoed `› 1. …` message sitting further above a real Codex dialog is not, since a sent message is
 * never adjacent to the dialog's own options.
 */
function menuCursor(lines: string[]): number {
  let cursor = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (SELECTED_OPTION.test(lines[i]!)) { cursor = i; break; }
  if (cursor < 0) return -1;
  if (cursor > 0 && RULE.test(lines[cursor - 1]!)) return -1;
  const n = Number(SELECTED_OPTION.exec(lines[cursor]!)![1]);
  for (const i of [cursor - 1, cursor + 1]) {
    if (i < 0 || i >= lines.length) continue;
    const m = SELECTED_OPTION.exec(lines[i]!);
    if (m && Math.abs(Number(m[1]) - n) === 1) return -1;
  }
  let sibling = false;
  for (let i = Math.max(0, cursor - SIBLING_REACH_UP); i < lines.length; i++) {
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
 * a real menu next to an echoed message above it or an option wrapped over several rows (TER-380).
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
