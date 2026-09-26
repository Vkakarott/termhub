import type { TabQuestion, TabQuestionItem, TabQuestionSuggestionItem } from '../../lib/types';

/** What `409 TAB_PROMPT_CHANGED` reads as on a card. */
export const PROMPT_CHANGED_TEXT = 'A pergunta mudou na aba';

/** Why an answer did not reach the tab, by the code the server stored. */
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

/** "Sugestão da memória" under a pre-selected question (spec 2026-09-26 chat decision memory §5.1):
 * where the pre-selection came from, so "Responder" clicked as-is answers what it says here. `item`'s
 * `selected` is already in this question's own option indexes. */
export function suggestionLine(item: TabQuestionItem, hint: TabQuestionSuggestionItem): string {
  const answer = hint.text ?? hint.selected.map((i) => item.options[i]?.label ?? '?').join(', ');
  const date = new Date(hint.source.answered_at).toLocaleDateString('pt-BR');
  const project = hint.source.project_name ?? 'sem projeto';
  return `Sugestão da memória: você respondeu «${answer}» a «${hint.source.question}» em ${project}, ${date}`;
}

/** Every event carries the whole card: replace it by id, or append it. */
export function upsertTabQuestion(list: TabQuestion[], q: TabQuestion): TabQuestion[] {
  return list.some((x) => x.id === q.id) ? list.map((x) => (x.id === q.id ? q : x)) : [...list, q];
}
