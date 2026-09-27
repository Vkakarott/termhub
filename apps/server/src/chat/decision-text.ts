import type { DecisionAnswer } from '../db/repositories/chat-decisions.js';
import type { ChoicePayload } from './tab-question-payload.js';

export type ChoiceItem = ChoicePayload['questions'][number];

export interface ItemAnswer {
  selected: number[];
  text?: string;
}

export interface SuggestionItem {
  question_index: number;
  decision_id: string;
  similarity: number;
  selected: number[];
  text?: string;
  source: { question: string; project_name: string | null; answered_at: string };
}

export interface TabQuestionSuggestion {
  items: SuggestionItem[];
}

/**
 * Normalizes a label for comparison: removes accents, case insensitive, strips punctuation/spaces.
 * "Não, obrigado!" → "nao obrigado"
 */
export function labelKey(label: string): string {
  return label
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '');
}

/** Bumped whenever `embedText` changes shape: every stored vector is tagged with it (`embedTag`), so
 *  vectors of another version are never compared and the sweeper re-embeds them (TER-204). */
export const EMBED_TEXT_VERSION = 'q1';

/**
 * The text a decision is embedded by (TER-204): the question alone, lower-cased, whitespace collapsed,
 * trailing `?!.:;` stripped. Header and option labels are left out on purpose: measured on real and
 * synthetic pairs, they pushed opposite yes/no questions ("Aceitar" × "Descartar as mudanças") over the
 * threshold and pulled a repeat with a new header under it; `mapAnswer` still requires the past labels
 * to exist among the new options.
 */
export function embedText(item: { question: string }): string {
  return item.question.replace(/\s+/g, ' ').trim().replace(/[?!.:;\s]+$/, '').toLowerCase();
}

/** The `embed_model` value stored with a vector: the service's model name plus the text version. */
export function embedTag(model: string): string {
  return `${model}#${EMBED_TEXT_VERSION}`;
}

/**
 * Converts an answer (selected indexes + optional text) to a DecisionAnswer (labels + optional text).
 */
export function answerToDecision(item: ChoiceItem, a: ItemAnswer): DecisionAnswer {
  const labels = a.selected.map((i) => item.options[i]!.label);
  if (a.text !== undefined) {
    return { labels, text: a.text };
  }
  return { labels };
}

/**
 * Maps a past decision (labels) to a new answer (indexes) on the given item.
 * Returns null if:
 * - any label doesn't match any option by labelKey
 * - single-select gets more than one label
 * - answer is empty (no labels and no text)
 * A past answer with both labels and text maps to the labels only.
 */
export function mapAnswer(past: DecisionAnswer, item: ChoiceItem): ItemAnswer | null {
  // If there's free text and no labels, just return it.
  if (past.labels.length === 0 && past.text?.trim()) {
    return { selected: [], text: past.text };
  }

  // If there are labels, map them to indexes.
  if (past.labels.length > 0) {
    // Single-select can't have more than one label.
    if (!item.multi_select && past.labels.length > 1) {
      return null;
    }

    const selected: number[] = [];
    for (const label of past.labels) {
      const key = labelKey(label);
      const index = item.options.findIndex((o) => labelKey(o.label) === key);
      if (index === -1) {
        // Label doesn't exist in new options.
        return null;
      }
      selected.push(index);
    }

    // Sort indexes for consistency.
    selected.sort((a, b) => a - b);

    // Check for duplicates: reachable if two labels normalise to the same key.
    if (new Set(selected).size !== selected.length) {
      return null;
    }

    // Labels win over any free text: the card sends one or the other, so a suggestion carrying both
    // could never equal what the person sends and would never count as accepted.
    return { selected };
  }

  // Empty answer (no labels, no text).
  return null;
}

/**
 * Checks if two answers are the same: selected as a set, text trimmed and compared.
 */
export function sameAnswer(a: ItemAnswer, b: ItemAnswer): boolean {
  // Compare selected as sets.
  const aSet = new Set(a.selected);
  const bSet = new Set(b.selected);

  if (aSet.size !== bSet.size) {
    return false;
  }

  for (const x of aSet) {
    if (!bSet.has(x)) {
      return false;
    }
  }

  // Compare text trimmed.
  const aText = a.text?.trim() ?? '';
  const bText = b.text?.trim() ?? '';

  return aText === bText;
}
