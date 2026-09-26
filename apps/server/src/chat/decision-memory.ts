import type { FastifyBaseLogger } from 'fastify';
import { z } from 'zod';
import type { AnsweredChoiceRow, ChatDecision, NewDecision } from '../db/repositories/chat-decisions.js';
import type { Repositories } from '../db/repositories/index.js';
import type { TabQuestion } from '../db/repositories/tab-questions.js';
import { answerToDecision, decisionText, mapAnswer, sameAnswer, type SuggestionItem, type TabQuestionSuggestion } from './decision-text.js';
import { defaultEmbedder, EMBED_TIMEOUT_MS, EmbedError, type Embedder } from './embeddings.js';
import { choiceAnswerBody, DESCRIPTION_MAX, HEADER_MAX, LABEL_MAX, QUESTION_MAX, type ChoiceAnswer, type ChoicePayload } from './tab-question-payload.js';

/** Neighbours asked per question of a `choice` payload (spec 2026-09-26 §4). */
export const SUGGEST_K = 5;

export interface MemoryDeps {
  embedder: Embedder | null;
  threshold: number;
  timeoutMs?: number;
  log: Pick<FastifyBaseLogger, 'info' | 'warn'>;
}

/** Rejects with `EmbedError('SUGGEST_TIMEOUT')` if `p` has not settled within `ms`, calling `onTimeout`
 *  right before doing so; `p` itself keeps running (there is no cancelling an in-flight fetch or query
 *  from here), but the caller stops waiting — `onTimeout` is how it tells `p`'s continuation that. */
function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout();
      reject(new EmbedError('SUGGEST_TIMEOUT'));
    }, ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/** The failure code worth logging: an `EmbedError`'s own code, a Prisma error's `.code`, else a
 *  generic one — never the error's `message`, which may quote the question or the answer. */
function memoryCode(err: unknown): string {
  if (err instanceof EmbedError) return err.code;
  if (typeof err === 'object' && err !== null && 'code' in err && typeof (err as { code: unknown }).code === 'string') {
    return (err as { code: string }).code;
  }
  return 'SUGGEST_FAILED';
}

/**
 * A suggestion to pre-select on a freshly opened `choice` question, drawn from the person's own past
 * decisions (spec 2026-09-26 §4): suggest only, never sent — nothing here touches the tab. Best effort
 * throughout, and never throws: a slow or failing embeddings service, an unlucky query, the setting
 * being off, or a payload with nothing similar all resolve to `null` rather than delay or fail the
 * card. Never logs question or answer text, only ids, counts, codes and similarity numbers.
 */
export async function suggestFor(repos: Pick<Repositories, 'users' | 'chatDecisions'>, row: TabQuestion, deps: MemoryDeps): Promise<TabQuestionSuggestion | null> {
  if (row.kind !== 'choice' || !deps.embedder) return null;
  const embedder = deps.embedder;
  const items = (row.payload as ChoicePayload).questions;
  if (items.length === 0) return null;

  // Set once the caller has stopped waiting (the timeout fired): `work()` below keeps running past
  // that point (nothing here cancels an in-flight embed or query), and must not bump counters or log
  // a "found" line for a suggestion the card was already published without.
  let abandoned = false;

  const work = async (): Promise<TabQuestionSuggestion | null> => {
    if (!(await repos.users.chatSuggestions(row.user_id))) return null;
    const { vectors } = await embedder.embed(items.map(decisionText));
    const found: SuggestionItem[] = [];
    for (const [i, item] of items.entries()) {
      const near = await repos.chatDecisions.nearest(row.user_id, vectors[i]!, { multiSelect: item.multi_select, k: SUGGEST_K });
      // Newest first among the ones close enough: a fresher decision beats a stronger but stale match.
      const candidates = near.filter((n) => n.similarity >= deps.threshold).sort((a, b) => b.created_at.localeCompare(a.created_at));
      for (const c of candidates) {
        const mapped = mapAnswer(c.answer, item);
        if (!mapped) continue; // the past labels no longer match this question's options — try the next
        found.push({ question_index: i, decision_id: c.id, similarity: c.similarity, ...mapped, source: { question: c.question, project_name: c.project_name, answered_at: c.created_at } });
        break;
      }
    }
    if (found.length === 0 || abandoned) return null;
    await repos.chatDecisions.bumpSuggested(found.map((f) => f.decision_id));
    const best = Math.round(Math.max(...found.map((f) => f.similarity)) * 1000) / 1000;
    deps.log.info({ tabQuestionId: row.id, items: found.length, best }, 'decision suggestion found');
    return { items: found };
  };

  try {
    return await withTimeout(work(), deps.timeoutMs ?? EMBED_TIMEOUT_MS, () => {
      abandoned = true;
    });
  } catch (err) {
    deps.log.warn({ tabQuestionId: row.id, code: memoryCode(err) }, 'decision suggestion skipped');
    return null;
  }
}

/**
 * One `NewDecision` per question of an answered `choice` row (spec 2026-09-26 §4.3): `options` drop
 * `recommended` (never stored — a suggestion is only ever ranked on similarity and recency, not on
 * what Claude Code recommended when it was asked). `userId` is the caller's to give: `answered_by` for
 * a live answer, the same column read straight off `AnsweredChoiceRow` for the sweeper's backfill. An
 * unanswered row (`answer` still null — should not happen, the caller only calls this once claimed)
 * gives no decisions rather than throwing.
 */
export function decisionsOf(row: Pick<TabQuestion, 'id' | 'project_id' | 'conversation_id' | 'payload' | 'answer'>, userId: string): NewDecision[] {
  if (!row.answer) return [];
  const payload = row.payload as ChoicePayload;
  const answer = row.answer as ChoiceAnswer;
  const decisions: NewDecision[] = [];
  for (const [i, item] of payload.questions.entries()) {
    const a = answer.answers[i];
    if (!a) continue; // shape already checked at answer time (checkChoiceAnswer); guard anyway
    decisions.push({
      user_id: userId,
      project_id: row.project_id,
      conversation_id: row.conversation_id,
      tab_question_id: row.id,
      question_index: i,
      header: item.header,
      question: item.question,
      options: item.options.map((o) => ({ label: o.label, description: o.description })),
      multi_select: item.multi_select,
      answer: answerToDecision(item, { selected: a.selected, text: a.text }),
    });
  }
  return decisions;
}

/**
 * Embeds a freshly inserted batch of decisions right away, best effort: on failure the row is simply
 * left without a vector for the sweeper (`embedPending`) to pick up later. Never throws — the caller
 * fires this without awaiting it, so an unhandled rejection here would otherwise escape unnoticed.
 */
async function embedInserted(repos: Pick<Repositories, 'chatDecisions'>, embedder: Embedder, rows: ChatDecision[], log: Pick<FastifyBaseLogger, 'warn'>, timeoutMs?: number): Promise<void> {
  try {
    const { model, vectors } = await withTimeout(embedder.embed(rows.map(decisionText)), timeoutMs ?? EMBED_TIMEOUT_MS, () => {});
    await Promise.all(rows.map((r, i) => repos.chatDecisions.setEmbedding(r.id, vectors[i]!, model)));
  } catch (err) {
    log.warn({ count: rows.length, code: memoryCode(err) }, 'decision embed failed');
  }
}

/**
 * Remembers an answered `choice` question (spec 2026-09-26 §4.3), right after its keys reached the
 * tab: never throws, so a db hiccup here must not turn an already-sent answer into a failed request.
 * `insertMany` is idempotent (unique on `tab_question_id, question_index`), so a retried call inserts
 * nothing twice. Accepted counting compares the suggestion this card was opened with, if any, against
 * what was actually sent (`sameAnswer`): a suggestion item whose selection the person kept counts as
 * accepted, one they changed does not. Embedding the freshly inserted rows is fire-and-forget — it
 * must not hold up the response for up to `EMBED_TIMEOUT_MS`, and a row left unembedded here is
 * finished later by the sweeper (`embedPending`). With no embedder at all, embedding is skipped
 * entirely and left for the sweeper. Never logs the question or the answer, only ids and codes.
 */
export async function recordDecisions(repos: Pick<Repositories, 'chatDecisions'>, row: TabQuestion, deps: Omit<MemoryDeps, 'threshold'>): Promise<void> {
  if (row.kind !== 'choice') return;
  try {
    const userId = row.answered_by ?? row.user_id;
    const decisions = decisionsOf(row, userId);
    if (decisions.length === 0) return;
    const inserted = await repos.chatDecisions.insertMany(decisions);
    if (inserted.length === 0) return;

    const suggestion = row.suggestion;
    if (suggestion) {
      const answer = row.answer as ChoiceAnswer;
      const acceptedIds = suggestion.items
        .filter((item) => {
          const a = answer.answers[item.question_index];
          return a !== undefined && sameAnswer({ selected: item.selected, text: item.text }, { selected: a.selected, text: a.text });
        })
        .map((item) => item.decision_id);
      if (acceptedIds.length > 0) await repos.chatDecisions.bumpAccepted(acceptedIds);
    }

    if (deps.embedder) void embedInserted(repos, deps.embedder, inserted, deps.log, deps.timeoutMs);
  } catch (err) {
    deps.log.warn({ tabQuestionId: row.id, code: memoryCode(err) }, 'decision record failed');
  }
}

/** The stored shape of a `choice` row's `payload` column (spec §5, backfill): already normalised by
 *  `parseAskUserQuestion` when the question was opened, so validated here on its own terms rather than
 *  through that function (which parses Claude Code's raw `AskUserQuestion` tool input instead — a
 *  different shape). A row whose `payload` or `answer` fails to parse is skipped by the backfill: the
 *  sweeper never guesses at a shape it does not recognise. */
const storedChoicePayload = z.object({
  questions: z
    .array(
      z.object({
        question: z.string().min(1).max(QUESTION_MAX),
        header: z.string().max(HEADER_MAX),
        multi_select: z.boolean(),
        options: z.array(z.object({ label: z.string().min(1).max(LABEL_MAX), description: z.string().max(DESCRIPTION_MAX) })).min(2).max(4),
      }),
    )
    .min(1)
    .max(4),
});

/**
 * Turns already-answered `choice` questions that predate this feature (or were answered while the
 * embeddings service was down) into decisions (spec §5): one batch of `listAnsweredChoicesWithoutDecision`,
 * each row validated against the stored shapes before use — a row that does not parse is skipped
 * rather than failing the whole sweep. Returns the number of decisions inserted (not rows visited: a
 * multi-question row gives several).
 */
export async function backfillDecisions(repos: Pick<Repositories, 'chatDecisions'>, limit = 32): Promise<number> {
  const rows: AnsweredChoiceRow[] = await repos.chatDecisions.listAnsweredChoicesWithoutDecision(limit);
  let count = 0;
  for (const row of rows) {
    const payload = storedChoicePayload.safeParse(row.payload);
    const answer = choiceAnswerBody.safeParse(row.answer);
    if (!payload.success || !answer.success) continue;
    const decisions = decisionsOf({ id: row.id, project_id: row.project_id, conversation_id: row.conversation_id, payload: payload.data as unknown as ChoicePayload, answer: answer.data }, row.answered_by);
    if (decisions.length === 0) continue;
    const inserted = await repos.chatDecisions.insertMany(decisions);
    count += inserted.length;
  }
  return count;
}

/**
 * Embeds the sweeper's backlog (spec §5): rows `recordDecisions` inserted with no embedder configured,
 * or whose fire-and-forget embed failed. One request for the whole batch, one `setEmbedding` per row.
 * Errors propagate to the caller (`startDecisionSweeper`), which logs them — this function does not.
 */
export async function embedPending(repos: Pick<Repositories, 'chatDecisions'>, embedder: Embedder, limit = 32): Promise<number> {
  const rows = await repos.chatDecisions.listToEmbed(limit);
  if (rows.length === 0) return 0;
  const { model, vectors } = await embedder.embed(rows.map(decisionText));
  await Promise.all(rows.map((r, i) => repos.chatDecisions.setEmbedding(r.id, vectors[i]!, model)));
  return rows.length;
}

/** How often the sweeper ticks (spec §5): backfill first, embed second. */
export const SWEEP_INTERVAL_MS = 10 * 60 * 1000;

/**
 * Keeps the memory complete without holding up anything else (spec §5): backfills decisions from
 * questions answered before this feature shipped (or while the embeddings service was down), then
 * embeds whatever that backfill or a live answer left without a vector. Runs once right away and then
 * every `intervalMs`; the timer is `unref`'d so it never keeps the process (or a test run) alive, and
 * the caller must not `await` this function — its first run must not block app startup. `embedder`
 * left out entirely resolves `defaultEmbedder()` (the configured service, if any); passing `null`
 * explicitly (as opposed to leaving it out) turns embedding off on purpose — only backfill then runs.
 * Never throws out of a tick: each step logs its own outcome, counts and codes only.
 */
export function startDecisionSweeper(repos: Repositories, log: Pick<FastifyBaseLogger, 'info' | 'warn'>, embedder?: Embedder | null, intervalMs = SWEEP_INTERVAL_MS): () => void {
  const embed = embedder !== undefined ? embedder : defaultEmbedder();
  const tick = async () => {
    try {
      const backfilled = await backfillDecisions(repos);
      if (backfilled > 0) log.info({ backfilled }, 'chat decisions backfilled');
    } catch (err) {
      log.warn({ code: memoryCode(err) }, 'chat decision backfill failed');
    }
    if (!embed) return;
    try {
      const embedded = await embedPending(repos, embed);
      if (embedded > 0) log.info({ embedded }, 'chat decisions embedded');
    } catch (err) {
      log.warn({ code: memoryCode(err) }, 'chat decision embed sweep failed');
    }
  };
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref();
  void tick();
  return () => clearInterval(timer);
}
