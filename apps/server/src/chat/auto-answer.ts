import { config } from '../config.js';
import type { ChatDecision } from '../db/repositories/chat-decisions.js';
import type { Repositories } from '../db/repositories/index.js';
import type { AutoAnswer, TabQuestion } from '../db/repositories/tab-questions.js';
import type { MemoryRefKind } from '../control/memory.js';
import { mapAnswer, sameAnswer } from './decision-text.js';
import type { ChoiceAnswer, ChoicePayload } from './tab-question-payload.js';
import { publishTabQuestions } from './tab-questions.js';

/**
 * Why `answer_tab_question`'s `mode: 'auto'` became a suggestion (spec 2026-09-26 concierge memory
 * §5.4): the person's switch is off (D8); the person already cancelled a countdown on this card; no
 * cited person decision equals the proposed answer (D6); the card names an irreversible act (D7's
 * blocklist); a multi-question card is backed for some of its questions but not all (D7); or the
 * backing decisions are about questions below the similarity floor, or it could not be measured (D6,
 * `AUTO_ANSWER_MIN_SIMILARITY`, fail closed). When several apply, the most decisive is reported:
 * `switch_off` > `cancelled_by_person` > `blocked` > `multi_question_partial` > `no_person_precedent`
 * > `not_similar`.
 */
export type Downgrade = 'switch_off' | 'cancelled_by_person' | 'no_person_precedent' | 'blocked' | 'multi_question_partial' | 'not_similar';

export interface ScheduleInput {
  row: TabQuestion;
  answer: ChoiceAnswer;
  by: 'memory' | 'concierge';
  reason: string;
  sources: { kind: MemoryRefKind; id: string }[];
}

/**
 * Whether one question's proposed answer is exactly what one of `decisions` answered, once that past
 * answer is mapped onto this question's own options (`mapAnswer`: labels compared by `labelKey`, so
 * case and accents do not matter; a free-text past answer compares as text, trimmed).
 */
export function decisionBacks(d: ChatDecision, item: ChoicePayload['questions'][number], a: ChoiceAnswer['answers'][number]): boolean {
  const mapped = mapAnswer(d.answer, item);
  return mapped !== null && sameAnswer(mapped, { selected: a.selected, text: a.text });
}

/**
 * The server's own check behind D6 — the model never decides this: every question of the card must
 * have at least one of the cited decisions (already verified as the caller's own `chat_decisions`
 * rows, trust `person`) whose past answer maps onto that question and equals the proposed answer. A
 * card with two questions and a precedent for only one is not backed.
 */
export function precedentBacks(decisions: ChatDecision[], payload: ChoicePayload, answer: ChoiceAnswer): boolean {
  if (answer.answers.length !== payload.questions.length) return false;
  return payload.questions.every((item, i) => decisions.some((d) => decisionBacks(d, item, answer.answers[i]!)));
}

/**
 * Starts a countdown on a still-open `choice` card (spec §6): `auto_answer` in `scheduled`, due
 * `AUTO_ANSWER_DELAY_SECONDS` (default 60 s) from `now`, then the card is republished so every open
 * screen shows the countdown with "Cancelar" and "Responder agora". `setAutoAnswer` is conditional on
 * the row still `open` with no countdown already running, so a card that moved on, or one another
 * caller scheduled first, resolves `null` with nothing published. Sending is the sweeper's job, never
 * this function's. Logs nothing: the reason and answer are the person's words.
 */
export async function scheduleAutoAnswer(repos: Repositories, input: ScheduleInput, now = new Date()): Promise<TabQuestion | null> {
  const auto: AutoAnswer = {
    answer: input.answer,
    by: input.by,
    reason: input.reason,
    sources: input.sources,
    due_at: new Date(now.getTime() + config.autoAnswerDelayMs).toISOString(),
    status: 'scheduled',
  };
  const row = await repos.tabQuestions.setAutoAnswer(input.row.id, auto);
  if (!row) return null;
  await publishTabQuestions(repos, 'tab_question', [row]);
  return row;
}
