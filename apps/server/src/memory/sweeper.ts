import type { FastifyBaseLogger } from 'fastify';
import { defaultEmbedder, memoryCode, type Embedder } from '../chat/embeddings.js';
import type { Repositories } from '../db/repositories/index.js';
import { indexDocsForLink, type DocsExec } from './docs.js';
import { embedPendingItems, indexTasks } from './index-items.js';

/** How often the sweeper ticks (spec 2026-09-26 concierge memory §4): the same cadence as TER-57's
 *  decision sweeper. */
export const MEMORY_SWEEP_INTERVAL_MS = 10 * 60 * 1000;

/** The docs pass (spec D15: every 30 min) runs on the first tick and then on every this-many ticks. */
export const DOCS_EVERY_TICKS = 3;

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
 *
 * On the first tick and every `DOCS_EVERY_TICKS`th tick after (30 min at the default interval, spec
 * D15), a docs pass runs between the card pass and the embed step: `indexDocsForLink` for every project
 * link, one after the other (a machine is never asked for two links' docs at once), through `docsExec`
 * (`machineDocsExec` by default). A link whose machine is off is skipped by `indexDocsForLink` itself; a
 * repository failure on one link is logged `{ linkId, code }` and the next link still runs. The docs
 * pass shares the tick's `running` guard, so a slow pass (many ssh machines timing out) delays the next
 * tick instead of overlapping it.
 */
export function startMemorySweeper(
  repos: Repositories,
  log: Pick<FastifyBaseLogger, 'info' | 'warn'>,
  embedder?: Embedder | null,
  intervalMs = MEMORY_SWEEP_INTERVAL_MS,
  docsExec?: DocsExec,
): () => void {
  const embed = embedder !== undefined ? embedder : defaultEmbedder();
  let running = false;
  let ticks = 0;

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

  const indexAllDocs = async (): Promise<void> => {
    const links = await repos.projectMachines.listAllWithOwner();
    let read = 0;
    let removed = 0;
    for (const link of links) {
      try {
        const r = await indexDocsForLink(repos, link, { embedder: null, log, exec: docsExec });
        read += r.read;
        removed += r.removed;
      } catch (err) {
        log.warn({ linkId: link.id, code: memoryCode(err) }, 'memory docs indexing failed for a link');
      }
    }
    if (read > 0 || removed > 0) log.info({ links: links.length, read, removed }, 'memory docs indexed');
  };

  const tick = async () => {
    if (running) return;
    running = true;
    const docsTurn = ticks++ % DOCS_EVERY_TICKS === 0;
    try {
      try {
        await indexAllOwners();
      } catch (err) {
        log.warn({ code: memoryCode(err) }, 'memory card indexing failed');
      }
      if (docsTurn) {
        try {
          await indexAllDocs();
        } catch (err) {
          log.warn({ code: memoryCode(err) }, 'memory docs indexing failed');
        }
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
