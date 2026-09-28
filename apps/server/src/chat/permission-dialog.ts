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

/** Whether the screen shows a Claude Code permission dialog right now — `promptVisible`'s rule for a
 * `permission` row, without a row. Used by the gate before a terminal grant presses a key (TER-325). */
export const permissionDialogVisible = (screen: string): boolean => promptVisible(screen, { kind: 'permission', payload: { tool_name: '' } });
