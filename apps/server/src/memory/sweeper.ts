import type { FastifyBaseLogger } from 'fastify';
import { defaultEmbedder, memoryCode, type Embedder } from '../chat/embeddings.js';
import type { Repositories } from '../db/repositories/index.js';
import { embedPendingItems, indexTasks } from './index-items.js';

/** How often the sweeper ticks (spec 2026-09-26 concierge memory §4): the same cadence as TER-57's
 *  decision sweeper. */
export const MEMORY_SWEEP_INTERVAL_MS = 10 * 60 * 1000;

/**
 * Keeps the concierge's free-text memory complete without holding up anything else (spec §4): re-
 * indexes every owner's changed cards (`indexTasks`, one pass per owner with at least one task), then
 * embeds whatever that pass or a live writer (`indexMessage`/`indexActions`/`indexNote`) left without a
 * vector (`embedPendingItems`, batched 32). `indexTasks` is always run with no embedder of its own —
 * embedding every card it just wrote is this function's own next step, in one batched request, rather
 * than one request per owner. Runs once right away and then every `intervalMs`; the timer is `unref`'d
 * so it never keeps the process (or a test run) alive, and the caller must not `await` this function —
 * its first run must not block app startup. `embedder` left out entirely resolves `defaultEmbedder()`
 * (the configured service, if any); passing `null` explicitly (as opposed to leaving it out) turns
 * embedding off on purpose — indexing still runs (cards stay searchable by full text even without a
 * vector). A `running` guard skips a tick that overlaps the previous one still in flight. A failure
 * indexing one owner does not stop the next owner, and a failure indexing every owner still lets the
 * embed step run. Never throws out of a tick: each step logs its own outcome, counts and codes only —
 * never a title, a text or a query.
 */
export function startMemorySweeper(repos: Repositories, log: Pick<FastifyBaseLogger, 'info' | 'warn'>, embedder?: Embedder | null, intervalMs = MEMORY_SWEEP_INTERVAL_MS): () => void {
  const embed = embedder !== undefined ? embedder : defaultEmbedder();
  let running = false;

  const indexAllOwners = async (): Promise<void> => {
    const owners = await repos.tasks.listOwnersWithTasks();
    let indexed = 0;
    for (const ownerId of owners) {
      try {
        indexed += await indexTasks(repos, ownerId, { embedder: null, log });
      } catch (err) {
        log.warn({ code: memoryCode(err) }, 'memory card indexing failed for an owner');
      }
    }
    if (indexed > 0) log.info({ indexed }, 'memory cards indexed');
  };

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      try {
        await indexAllOwners();
      } catch (err) {
        log.warn({ code: memoryCode(err) }, 'memory card indexing failed');
      }
      if (!embed) return;
      try {
        const embedded = await embedPendingItems(repos, embed);
        if (embedded > 0) log.info({ embedded }, 'memory items embedded');
      } catch (err) {
        log.warn({ code: memoryCode(err) }, 'memory embed sweep failed');
      }
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref();
  void tick();
  return () => clearInterval(timer);
}
