// Copied from apps/web/src/components/chat/tab-suggestion-text.ts — keep the two in step (same pt-BR copy).
import type { TabSuggestion } from './types';

/** Why the text did not reach the tab, by the code the server stored. */
const FAILURE_TEXT: Record<string, string> = {
  MACHINE_OFFLINE: 'a máquina está offline',
  AGENT_OUTDATED: 'o agente da máquina está desatualizado',
};

/**
 * While open the card offers Claude Code's suggestion for a tab that finished its turn — it asks nothing (spec
 * 2026-09-26 TER-203 §5); once closed it says what the tab had suggested. Keep in step with the web's copy.
 */
export const suggestionTitle = (s: TabSuggestion): string => {
  if (s.status === 'open') {
    const who = s.payload.agent === 'codex' ? 'o Codex perguntou:' : 'o Claude Code sugere:';
    return s.tab_name ? `«${s.tab_name}» terminou — ${who}` : `Uma aba terminou — ${who}`;
  }
  if (s.payload.agent === 'codex') {
    // A Codex reply card asked; the chat's answer (sent, or claimed and failed) is what the card shows under it.
    const asked = s.tab_name ? `«${s.tab_name}» perguntou` : 'Uma aba perguntou';
    return s.status === 'answered' || s.status === 'failed' ? `${asked}; você respondeu:` : `${asked}:`;
  }
  return s.tab_name ? `«${s.tab_name}» sugere:` : 'Uma aba sugere:';
};

/** Under an open card's title: a suggestion never needs an answer (spec 2026-09-26 TER-203 §5). */
export const SUGGESTION_HINT = 'Não precisa responder.';

/** A Codex reply card (`payload.agent === 'codex'`) is a question ending the Codex's turn: the person answers. */
export const CODEX_REPLY_HINT = 'Responda aqui ou na aba.';
/** The empty input of a Codex reply card, and its accessible name. */
export const CODEX_REPLY_PLACEHOLDER = 'Sua resposta';

export const suggestionHint = (s: TabSuggestion): string => (s.payload.agent === 'codex' ? CODEX_REPLY_HINT : SUGGESTION_HINT);

/** How much of the agent's message a collapsed card shows. */
export const CONTEXT_PREVIEW_MAX = 400;

/**
 * The collapsed context of a suggestion card (spec 2026-09-26 §6.4): the message's last paragraph — the text
 * after its last blank line; the question usually closes the message — up to `max` characters, keeping the
 * end and marking the cut with "…". Never starts on half a surrogate pair. Keep in step with the web's copy.
 */
export function lastParagraph(text: string, max: number): string {
  const paragraphs = text.trim().split(/\n[ \t]*\n/);
  const last = (paragraphs[paragraphs.length - 1] ?? '').trim();
  if (last.length <= max) return last;
  let tail = last.slice(last.length - (max - 1));
  const first = tail.charCodeAt(0);
  if (first >= 0xdc00 && first <= 0xdfff) tail = tail.slice(1);
  return `…${tail.trimStart()}`;
}

export function suggestionStatusLabel(s: TabSuggestion): string {
  switch (s.status) {
    case 'open':
      return '';
    case 'answered':
      return 'Enviada';
    case 'dismissed':
      return 'Dispensada';
    case 'answered_in_tab':
      return 'Respondida na aba';
    case 'expired':
      return 'Expirada';
    case 'failed':
      return `Falhou — ${FAILURE_TEXT[s.error_code ?? ''] ?? 'não foi possível digitar na aba'}`;
  }
}

/** Every event carries the whole card: replace it by id, or append it. */
export function upsertTabSuggestion(list: TabSuggestion[], s: TabSuggestion): TabSuggestion[] {
  return list.some((x) => x.id === s.id) ? list.map((x) => (x.id === s.id ? s : x)) : [...list, s];
}
