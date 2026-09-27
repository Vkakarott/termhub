import type { FastifyBaseLogger } from 'fastify';
import { config } from '../config.js';
import { controlContextFor, type ControlContext } from '../control/context.js';
import type { ChatDecision } from '../db/repositories/chat-decisions.js';
import type { Repositories } from '../db/repositories/index.js';
import type { AutoAnswer, TabQuestion } from '../db/repositories/tab-questions.js';
import { toTabQuestionView, type TabQuestionView } from '../db/repositories/tab-questions-view.js';
import type { MemoryRefKind } from '../control/memory.js';
import { HttpError, notFound } from '../lib/errors.js';
import { autoAnswerBlocked } from '../memory/blocklist.js';
import { mapAnswer, sameAnswer } from './decision-text.js';
import { failureLabel } from './service.js';
import { answerTabQuestion, codeOf, isQuestionRow } from './tab-question-answer.js';
import { checkChoiceAnswer, type ChoiceAnswer, type ChoicePayload } from './tab-question-payload.js';
import { publishTabQuestions, type TabQuestionEventType } from './tab-questions.js';

type Log = Pick<FastifyBaseLogger, 'info' | 'warn'>;

/** The repeat path's reason (spec §6, D9a): shown on the card and told to the concierge as is. */
export const REPEAT_REASON = 'Mesma pergunta respondida antes';
/** How often the sender sweeper ticks (spec §6). */
export const AUTO_ANSWER_SWEEP_MS = 5_000;
/** How many due countdowns one tick sends at most; the rest wait for the next tick. */
const SWEEP_BATCH = 20;

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
  const row = await storeAutoAnswer(repos, input, now);
  if (!row) return null;
  await publishTabQuestions(repos, 'tab_question', [row]);
  return row;
}

/** `scheduleAutoAnswer` without the publish: the repeat path runs inside `openTabQuestion`, which
 * announces the card itself, once, countdown included. */
async function storeAutoAnswer(repos: Repositories, input: ScheduleInput, now: Date): Promise<TabQuestion | null> {
  const auto: AutoAnswer = {
    answer: input.answer,
    by: input.by,
    reason: input.reason,
    sources: input.sources,
    due_at: new Date(now.getTime() + config.autoAnswerDelayMs).toISOString(),
    status: 'scheduled',
  };
  return (await repos.tabQuestions.setAutoAnswer(input.row.id, auto)) ?? null;
}

/**
 * The repeat path (spec §6, D9a): a fresh `choice` card whose TER-57 suggestion already found a person
 * precedent for every one of its questions — an item with a non-empty `decision_id`, which `suggestFor`
 * only gives at `DECISION_SUGGEST_THRESHOLD` (0.98, near-verbatim), so no other similarity floor applies
 * here — starts a countdown on that suggestion by itself, with no LLM call. Everything else is a plain
 * suggested card (`null`): the switch off (D8), a concierge item (it cites no decision of its own), a
 * card with a question left unsuggested, an answer that no longer fits the payload, a card that already
 * had a countdown, or a blocklist hit (D7) on any header, question, suggested label or text. The row is
 * not published here (`openTabQuestion` does it, once). Logs nothing.
 */
export async function maybeScheduleRepeat(repos: Repositories, row: TabQuestion, now = new Date()): Promise<TabQuestion | null> {
  if (row.kind !== 'choice' || row.status !== 'open' || row.auto_answer || !row.suggestion) return null;
  const payload = row.payload as ChoicePayload;
  const items = payload.questions.map((_q, i) => row.suggestion!.items.find((it) => it.question_index === i && it.decision_id !== '' && it.by !== 'concierge'));
  if (items.some((it) => it === undefined)) return null;
  const answer: ChoiceAnswer = { answers: items.map((it) => ({ selected: it!.selected, ...(it!.text !== undefined ? { text: it!.text } : {}) })) };
  if (checkChoiceAnswer(payload, answer)) return null;
  const parts = payload.questions.flatMap((q, i) => {
    const a = answer.answers[i]!;
    return [q.header, q.question, ...a.selected.map((s) => q.options[s]?.label ?? ''), ...(a.text !== undefined ? [a.text] : [])];
  });
  if (autoAnswerBlocked(parts)) return null;
  if (!(await repos.users.chatAutodecide(row.user_id))) return null;
  const ids = [...new Set(items.map((it) => it!.decision_id))];
  return storeAutoAnswer(repos, { row, answer, by: 'memory', reason: REPEAT_REASON, sources: ids.map((id) => ({ kind: 'decision' as const, id })) }, now);
}

/** Which event a card that changed goes out on, by where the row stands now. */
const eventFor = (row: TabQuestion): TabQuestionEventType => (row.status === 'open' ? 'tab_question' : row.status === 'answered' || row.status === 'failed' ? 'tab_question_answered' : 'tab_question_closed');

/**
 * One tick of the sender (spec §6): every due countdown, oldest first, at most `SWEEP_BATCH`. For each,
 * `claimAutoAnswer` (`scheduled → sent`, conditional) is the only thing that makes one process — one of
 * the two blue/green colors, or one of two overlapping ticks — the sender; a loser skips the row. The
 * winner sends through the ordinary answer path (`answerTabQuestion`) as the conversation's user with no
 * token — so the gate is not involved and the person's own grants, re-read now, apply — with `via:
 * 'auto'` (stored as `answered_via`, no decision recorded: D11) and no embedder. The live screen check,
 * the row's own `open` claim and every other check run as for a click. Then the cited decisions get
 * `auto_count + 1` (best effort: the keys are in the tab). Any failure — the user gone, a lost grant
 * (403), the prompt moved (409), the send itself (502) — closes the countdown as `failed` with the code
 * and republishes the card; nothing else is typed. Resolves how many were sent. Logs ids, `by` and codes
 * only — never the answer nor the reason.
 */
export async function sendDueAutoAnswers(repos: Repositories, log: Log, deps: { now?: () => Date; answer?: typeof answerTabQuestion } = {}): Promise<number> {
  const now = (deps.now ?? (() => new Date()))();
  const due = await repos.tabQuestions.listDueAutoAnswers(now, SWEEP_BATCH);
  let sent = 0;
  for (const row of due) {
    const claimed = await repos.tabQuestions.claimAutoAnswer(row.id, now);
    if (!claimed?.auto_answer) continue;
    const auto = claimed.auto_answer;
    try {
      const user = await repos.users.findById(claimed.user_id);
      if (!user) throw new HttpError(404, 'Usuário não encontrado', 'USER_GONE');
      await (deps.answer ?? answerTabQuestion)(controlContextFor(repos, user), claimed.id, auto.answer, { log, via: 'auto', embedder: null });
    } catch (err) {
      const code = codeOf(err, 'AUTO_ANSWER_FAILED');
      log.warn({ tabQuestionId: claimed.id, code }, 'auto answer failed');
      try {
        const failed = await repos.tabQuestions.finishAutoAnswer(claimed.id, 'failed', code);
        if (failed) await publishTabQuestions(repos, eventFor(failed), [failed]);
      } catch (recordErr) {
        // Best effort: the card still shows the question, and the countdown can no longer send.
        log.warn({ tabQuestionId: claimed.id, code: codeOf(recordErr, 'RECORD_FAILED') }, 'auto answer failure not recorded');
      }
      continue;
    }
    sent++;
    log.info({ tabQuestionId: claimed.id, by: auto.by }, 'auto answer sent');
    const ids = auto.sources.filter((s) => s.kind === 'decision').map((s) => s.id);
    try {
      if (ids.length) await repos.chatDecisions.bumpAuto(ids);
    } catch (err) {
      log.warn({ tabQuestionId: claimed.id, code: codeOf(err, 'BUMP_FAILED') }, 'auto answer count not bumped');
    }
  }
  return sent;
}

/**
 * Runs `sendDueAutoAnswers` right away and every `intervalMs` (5 s). A `running` guard skips a tick that
 * overlaps the previous one in this process; across processes the claim decides. The timer is `unref`'d,
 * and a tick never throws: a failed read logs its code. The returned function stops it.
 */
export function startAutoAnswerSweeper(repos: Repositories, log: Log, intervalMs = AUTO_ANSWER_SWEEP_MS): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await sendDueAutoAnswers(repos, log);
    } catch (err) {
      log.warn({ code: failureLabel(err) }, 'auto answer sweep failed');
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref();
  void tick();
  return () => clearInterval(timer);
}

/**
 * "Cancelar" on a countdown (spec §6): `scheduled → cancelled`, only on the caller's own card. The
 * proposed answer stays on the card as its pre-selection and the row stays `open`; every screen hears
 * it. 404 for a row that is not the caller's (or not a question), 409 `NOT_SCHEDULED` when no countdown
 * is running — already sent, failed, cancelled, or never there.
 */
export async function cancelAutoAnswer(ctx: ControlContext, id: string): Promise<TabQuestionView> {
  const userId = ctx.scope.user.id;
  const row = await ctx.repos.tabQuestions.findByIdForUser(id, userId);
  if (!isQuestionRow(row)) throw notFound('Pergunta não encontrada');
  const cancelled = await ctx.repos.tabQuestions.cancelAutoAnswer(id, userId);
  if (!cancelled) throw new HttpError(409, 'Não há resposta automática em contagem nesta pergunta', 'NOT_SCHEDULED');
  const [view] = await publishTabQuestions(ctx.repos, 'tab_question', [cancelled]);
  return view ?? toTabQuestionView(cancelled, null);
}
