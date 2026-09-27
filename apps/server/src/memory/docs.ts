import { buildDocsReadScript, buildDocsScanScript, parseDocsRead, parseDocsScan } from '@termhub/machine-ops';
import { memoryCode } from '../chat/embeddings.js';
import { agentRpc, requireAgentVersion } from '../agent/errors.js';
import type { Repositories } from '../db/repositories/index.js';
import type { NewMemoryItem } from '../db/repositories/memory-items.js';
import type { Machine } from '../db/repositories/types.js';
import { HttpError } from '../lib/errors.js';
import { runOnMachine, shellQuote } from '../terminal/machine-exec.js';
import { chunkMarkdown } from './chunk.js';
import { embedInserted, type MemoryDeps } from './index-items.js';
import { cleanMemoryText, ITEM_TEXT_MAX } from './text.js';

/** First agent release that answers `docs.scan` / `docs.read` (spec 2026-09-26 concierge memory D15). */
export const DOCS_MIN_AGENT_VERSION = '0.8.0';
/** At most this many paths per `docs.read` call (the RPC's own `max(20)`, spec §4). */
export const DOCS_READ_BATCH = 20;

/** A failure's code for the log: its own `code` (an `HttpError`'s, a Prisma one's), else a generic one. */
const failureCode = (err: unknown): string => {
  const code = memoryCode(err);
  return code === 'SUGGEST_FAILED' ? 'DOCS_FAILED' : code;
};

/** Same budgets as the agent RPC catalog gives `docs.scan` / `docs.read` (15 s / 20 s). */
const SCAN_TIMEOUT_MS = 15_000;
const READ_TIMEOUT_MS = 20_000;

/**
 * How the docs sweeper reaches a machine's checkout: both calls return the raw stdout of the
 * `@termhub/machine-ops` docs scripts, which `parseDocsScan` / `parseDocsRead` read back. A failure
 * (offline, unreachable, outdated agent, timeout) throws — ideally an `HttpError` with a `code`, which
 * is all the caller ever logs.
 */
export interface DocsExec {
  scan(machine: Machine, cwd: string): Promise<string>;
  read(machine: Machine, cwd: string, paths: string[]): Promise<string>;
}

async function runDocsScript(machine: Machine, script: string, timeoutMs: number): Promise<string> {
  const r = await runOnMachine(machine, { file: '/bin/sh', args: ['-c', script] }, script, timeoutMs);
  if (r.timedOut) throw new HttpError(504, 'A máquina demorou para responder', 'MACHINE_TIMEOUT');
  if (r.code !== 0) throw new HttpError(502, 'Máquina inacessível', 'MACHINE_UNREACHABLE');
  return r.stdout;
}

/**
 * The real `DocsExec`: an `agent` machine has no shell from the server (`runOnMachine` refuses it), so
 * it goes through the `docs.scan` / `docs.read` RPCs — after `requireAgentVersion`, since an agent
 * older than 0.8.0 does not know those methods and *drops* the frame (its `serverMessage` parse fails
 * before dispatch), which would otherwise cost a full RPC timeout per link every pass instead of an
 * immediate `AGENT_OUTDATED`. An offline agent surfaces as `AGENT_OFFLINE` from `agentRpc`. An
 * `ssh`/`local` machine runs the very same script through `runOnMachine`, with the cwd and every path
 * `shellQuote`d — and those paths only ever come from a validated scan (`DOC_PATH_RE`).
 */
export const machineDocsExec: DocsExec = {
  async scan(machine, cwd) {
    if (machine.type === 'agent') {
      requireAgentVersion(machine, DOCS_MIN_AGENT_VERSION);
      return (await agentRpc(machine, 'docs.scan', { cwd })).stdout;
    }
    return runDocsScript(machine, buildDocsScanScript(shellQuote(cwd)), SCAN_TIMEOUT_MS);
  },
  async read(machine, cwd, paths) {
    if (machine.type === 'agent') {
      requireAgentVersion(machine, DOCS_MIN_AGENT_VERSION);
      return (await agentRpc(machine, 'docs.read', { cwd, paths })).stdout;
    }
    return runDocsScript(machine, buildDocsReadScript(shellQuote(cwd), paths.map(shellQuote)), READ_TIMEOUT_MS);
  },
};

/** One project ↔ machine link as the docs pass sees it: `owner_id` is the project's owner. */
export interface DocsLink {
  id: string;
  project_id: string;
  owner_id: string;
  cwd: string;
  machine: Machine;
}

/** Reads every path in `paths` in batches of ≤ `DOCS_READ_BATCH`. `docs.read` returns a *prefix* of
 *  what it was asked for (it stops before the file that would cross its byte budget) and silently
 *  skips a file that vanished or grew past the size limit since the scan: so after each call the
 *  queue resumes right after the last path that came back — a path skipped before it is dropped
 *  (it will be looked at again on the next pass) — and a call that returns none of its batch drops
 *  that whole batch. Every call removes at least one path, so this always ends. Throws on the first
 *  failed call; nothing is written by then. */
async function readAll(exec: DocsExec, link: DocsLink, paths: string[]): Promise<Map<string, string>> {
  const texts = new Map<string, string>();
  let queue = paths;
  while (queue.length > 0) {
    const batch = queue.slice(0, DOCS_READ_BATCH);
    const got = parseDocsRead(await exec.read(link.machine, link.cwd, batch));
    let last = -1;
    batch.forEach((p, i) => {
      const text = got.get(p);
      if (text === undefined) return;
      texts.set(p, text);
      last = i;
    });
    queue = queue.slice(last === -1 ? batch.length : last + 1);
  }
  return texts;
}

/**
 * Indexes one link's `docs/superpowers/{specs,plans}/*.md` into `memory_items` (spec 2026-09-26
 * concierge memory D15, §4): `docs.scan` lists each file's sha256; a file whose sha differs from the
 * `source_hash` its chunk 0 already carries (or that has no item yet) is read and re-chunked
 * (`chunkMarkdown`) — upserted as `kind: 'doc'`, trust `derived`, `source_id` `${link.id}:${path}`,
 * every chunk carrying the file's sha — through `replaceSourceChunks`, which trims the chunks past the
 * new count and upserts in one transaction, so a crash never leaves a stale tail behind a fresh chunk
 * 0. An unchanged file is never read. A stored file that the scan no longer lists has all its items
 * deleted. So does one the scan reports **over `DOCS_MAX_BYTES`** (sha `null`): it still exists, but
 * its content can no longer be read or verified, so its old chunks would be stale text nobody can
 * refresh.
 *
 * A file that chunks to nothing (empty or whitespace only) ends up with no items at all, so it has no
 * stored hash and is simply read again on the next pass — cheap, and rare.
 *
 * Every failure to reach the checkout — offline agent (`AGENT_OFFLINE`), agent older than 0.8.0
 * (`AGENT_OUTDATED`), unreachable ssh, a timeout, a missing cwd (`DOCS_NOTFOUND`), no sha256 tool on the
 * machine (`DOCS_NOHASH`), or a failed read call — returns `{ read: 0, removed: 0 }` with a single
 * `{ linkId, code }` log and **writes and deletes nothing**: a machine that is merely off must never
 * wipe what was indexed from it. So does a scan that succeeds with no file at all while the link has
 * docs stored (`DOCS_EMPTY`, see below). Repository failures propagate to the caller (the sweeper logs
 * them per link). Logs never carry a path, a title or text — the link id, counts and codes only.
 * `deps.exec` defaults to `machineDocsExec`. Returns how many files were (re-)indexed and how many
 * files' items were removed.
 */
export async function indexDocsForLink(
  repos: Pick<Repositories, 'memoryItems'>,
  link: DocsLink,
  deps: MemoryDeps & { exec?: DocsExec },
): Promise<{ read: number; removed: number }> {
  const exec = deps.exec ?? machineDocsExec;
  const skip = (code: string) => {
    deps.log.info({ linkId: link.id, code }, 'memory docs skipped for a link');
    return { read: 0, removed: 0 };
  };

  let scan: ReturnType<typeof parseDocsScan>;
  try {
    scan = parseDocsScan(await exec.scan(link.machine, link.cwd));
  } catch (err) {
    return skip(failureCode(err));
  }
  if (scan.err !== null) return skip(`DOCS_${scan.err.replace(/[^A-Za-z]/g, '').toUpperCase().slice(0, 20)}`);

  const prefix = `${link.id}:`;
  const known = await repos.memoryItems.listSourceHashes('doc', prefix);
  // A scan that succeeds but lists nothing while this link has docs stored is far more likely a
  // transient state (an unmounted disk, a branch switch mid-checkout) than every spec being deleted at
  // once: keep everything this pass (fix round 1 ruling). A non-empty scan deletes gone files as usual.
  if (scan.entries.length === 0 && known.size > 0) return skip('DOCS_EMPTY');
  const readable = new Map<string, string>(); // path → sha, only files that can still be read
  for (const e of scan.entries) if (e.sha256 !== null) readable.set(e.path, e.sha256);
  const changed = [...readable].filter(([path, sha]) => known.get(prefix + path) !== sha).map(([path]) => path);

  let texts = new Map<string, string>();
  if (changed.length > 0) {
    try {
      texts = await readAll(exec, link, changed);
    } catch (err) {
      return skip(failureCode(err));
    }
  }

  const now = new Date();
  for (const [path, text] of texts) {
    const sourceId = prefix + path;
    const chunks = chunkMarkdown(path, text);
    const items: NewMemoryItem[] = chunks.map((c, i) => ({
      // The project's owner at listing time. `ProjectsRepository` has no owner transfer today; if one is
      // ever added, doc items must be re-owned there too — an unchanged file (same hash) is never
      // re-upserted here, so its chunks would keep the old owner.
      owner_id: link.owner_id,
      project_id: link.project_id,
      kind: 'doc',
      source_id: sourceId,
      chunk_index: i,
      title: cleanMemoryText(c.title),
      text: cleanMemoryText(c.text).slice(0, ITEM_TEXT_MAX),
      trust: 'derived',
      source_at: now,
      source_hash: readable.get(path)!,
    }));
    const inserted = await repos.memoryItems.replaceSourceChunks('doc', sourceId, items);
    if (deps.embedder) void embedInserted(repos, deps.embedder, inserted, deps.log);
  }

  const gone = [...known.keys()].filter((sourceId) => !readable.has(sourceId.slice(prefix.length)));
  if (gone.length > 0) await repos.memoryItems.deleteBySource('doc', gone);

  return { read: texts.size, removed: gone.length };
}
