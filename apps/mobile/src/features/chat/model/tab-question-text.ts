// Copied from apps/web/src/components/chat/tab-question-text.ts — keep the two in step (same pt-BR copy).
import type { TabQuestion, TabQuestionItem, TabQuestionSuggestionItem } from './types';

/** Why an answer did not reach the tab, by the code the server stored. A row only ever becomes
 * `failed` from a send error — never from `TAB_PROMPT_CHANGED`, which the 409 on the answer call
 * itself already says (`CHAT_MSG.tabPromptChanged`), so that code has no entry here. */
const FAILURE_TEXT: Record<string, string> = {
  MACHINE_OFFLINE: 'a máquina está offline',
  AGENT_OUTDATED: 'o agente da máquina está desatualizado',
};

export const tabLabel = (q: TabQuestion): string => (q.tab_name ? `A aba «${q.tab_name}»` : 'Uma aba');

export function statusLabel(q: TabQuestion): string {
  switch (q.status) {
    case 'open':
      return '';
    case 'answered':
      return 'Respondida';
    case 'answered_in_tab':
      return 'Respondida na aba';
    case 'expired':
      return 'Expirada';
    case 'failed':
      return `Falhou — ${FAILURE_TEXT[q.error_code ?? ''] ?? 'não foi possível digitar na aba'}`;
  }
}

/** The read-only summary a closed card keeps: each question and what was answered, when the chat answered it. */
export function answerSummary(q: TabQuestion): string[] {
  if (q.kind === 'permission') {
    if (!q.answer) return [];
    return [q.answer.allow ? 'Permitido' : q.answer.text ? `Negado: «${q.answer.text}»` : 'Negado'];
  }
  const answers = q.answer?.answers;
  return q.payload.questions.map((item, i) => {
    const a = answers?.[i];
    if (!a) return item.question;
    return `${item.question} → ${a.text ?? a.selected.map((s) => item.options[s]?.label ?? '?').join(', ')}`;
  });
}

/** "Sugestão da memória" under a pre-selected question (chat decision memory spec 2026-09-26 §5.1),
 * copied from `apps/web/src/components/chat/tab-question-text.ts` (`suggestionLine`) — same pt-BR
 * copy. `item`'s `selected` is already in this question's own option indexes. */
export function suggestionLine(item: TabQuestionItem, hint: TabQuestionSuggestionItem): string {
  const answer = hint.text ?? hint.selected.map((i) => item.options[i]?.label ?? '?').join(', ');
  const date = new Date(hint.source.answered_at).toLocaleDateString('pt-BR');
  const project = hint.source.project_name ?? 'sem projeto';
  return `Sugestão da memória: você respondeu «${answer}» a «${hint.source.question}» em ${project}, ${date}`;
}
