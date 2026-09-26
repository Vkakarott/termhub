import type { FastifyBaseLogger } from 'fastify';
import type { Repositories } from '../db/repositories/index.js';
import type { TabQuestion } from '../db/repositories/tab-questions.js';
import { decisionText, mapAnswer, type SuggestionItem, type TabQuestionSuggestion } from './decision-text.js';
import { EMBED_TIMEOUT_MS, EmbedError, type Embedder } from './embeddings.js';
import type { ChoicePayload } from './tab-question-payload.js';

/** Neighbours asked per question of a `choice` payload (spec 2026-09-26 §4). */
export const SUGGEST_K = 5;

export interface MemoryDeps {
  embedder: Embedder | null;
  threshold: number;
  timeoutMs?: number;
  log: Pick<FastifyBaseLogger, 'info' | 'warn'>;
}

/** Rejects with `EmbedError('SUGGEST_TIMEOUT')` if `p` has not settled within `ms`; `p` itself keeps
 *  running (there is no cancelling an in-flight fetch or query from here), but the caller stops waiting. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new EmbedError('SUGGEST_TIMEOUT')), ms);
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

  const work = async (): Promise<TabQuestionSuggestion | null> => {
    if (!(await repos.users.chatSuggestions(row.user_id))) return null;
    const items = (row.payload as ChoicePayload).questions;
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
    if (found.length === 0) return null;
    await repos.chatDecisions.bumpSuggested(found.map((f) => f.decision_id));
    const best = Math.round(Math.max(...found.map((f) => f.similarity)) * 1000) / 1000;
    deps.log.info({ tabQuestionId: row.id, items: found.length, best }, 'decision suggestion found');
    return { items: found };
  };

  try {
    return await withTimeout(work(), deps.timeoutMs ?? EMBED_TIMEOUT_MS);
  } catch (err) {
    deps.log.warn({ tabQuestionId: row.id, code: memoryCode(err) }, 'decision suggestion skipped');
    return null;
  }
}
