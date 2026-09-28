import { Worker } from 'node:worker_threads';
import { ExtractError, type ExtractErrorCode } from './errors.js';
import type { DocumentKind, Extracted } from './parsers.js';

/**
 * Runs one document parse in its own Worker (spec 2026-09-26 attachment-extraction-worker): a fresh
 * isolate per job, a heap limit, and a timeout that terminates the worker instead of abandoning it.
 * The promise settles exactly once, and only after the worker is gone, so the next job never
 * overlaps a dying parser. Nothing here logs; the queue logs metadata.
 */
export const EXTRACT_WORKER_HEAP_MB = 512;

export interface WorkerJob {
  kind: DocumentKind;
  file: Uint8Array;
  zipBudget: number;
}
export type WorkerReply = { type: 'ready' } | { type: 'result'; ok: true; extracted: Extracted } | { type: 'result'; ok: false; code: ExtractErrorCode; message: string };
export interface RunOptions {
  timeoutMs: number;
  heapMb: number;
  workerUrl: URL;
}

/**
 * The entry next to this module: `.js` in production (`dist/`), `.ts` under tsx and vitest, which
 * do not transform a Worker's code, so a `.ts` entry is loaded with `--import tsx` (`execArgvFor`).
 *
 * `extract-worker.ts` is never imported — the only path to it is the `new URL` below — so it reaches
 * `dist` solely because `apps/server/tsconfig.json` compiles everything under `src`
 * (`include: ["src"]`). Narrowing that include would silently drop it from the build, and every
 * document would then fail to start.
 */
export function defaultWorkerUrl(): URL {
  return new URL(`./extract-worker.${import.meta.url.endsWith('.ts') ? 'ts' : 'js'}`, import.meta.url);
}
const execArgvFor = (url: URL): string[] => (url.pathname.endsWith('.ts') ? ['--import', 'tsx'] : []);
const startFailure = () => new ExtractError('ATTACHMENT_INVALID', 'extraction worker failed to start', { retryable: true });

export function runInWorker(kind: DocumentKind, file: Buffer, zipBudget: number, opts: RunOptions): Promise<Extracted> {
  // A Buffer can be a view into a larger, shared ArrayBuffer (the pool, a readFile slab): copy it
  // into one of its own, then transfer that — never the caller's.
  const bytes = new Uint8Array(file.byteLength);
  bytes.set(file);
  return new Promise<Extracted>((resolve, reject) => {
    let worker: Worker;
    try {
      const job: WorkerJob = { kind, file: bytes, zipBudget };
      worker = new Worker(opts.workerUrl, { workerData: job, transferList: [bytes.buffer], execArgv: execArgvFor(opts.workerUrl), resourceLimits: { maxOldGenerationSizeMb: opts.heapMb } });
    } catch {
      reject(startFailure());
      return;
    }
    let ready = false;
    let settled = false;
    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker
        .terminate()
        .catch(() => undefined)
        .then(settle);
    };
    const timer = setTimeout(() => finish(() => reject(new ExtractError('ATTACHMENT_INVALID', 'extraction timed out'))), opts.timeoutMs);
    worker.on('message', (m: WorkerReply) => {
      if (m.type === 'ready') {
        ready = true;
        return;
      }
      if (m.ok) finish(() => resolve(m.extracted));
      else finish(() => reject(new ExtractError(m.code, m.message)));
    });
    // An uncaught throw reaches the parent on Node's internal port and `ready` on the public one,
    // with no order between them: under load `error` can overtake a `ready` the worker sent first
    // (TER-314). Node drains the public port before it emits `exit`, so the error is only kept
    // here and classified there, once `ready` is final. The worker is dying anyway after `error`.
    let errored = false;
    let thrown: unknown;
    worker.on('error', (err: unknown) => {
      if (errored) return;
      errored = true;
      thrown = err;
    });
    worker.on('exit', () => {
      if (!errored) {
        finish(() => reject(new ExtractError('ATTACHMENT_INVALID', 'extraction worker exited')));
        return;
      }
      // A worker's uncaught throw reaches here as whatever value was thrown, not necessarily an
      // Error (`throw null` delivers `null`): never assume `.code`/`.name` exist.
      const code = (thrown as { code?: string } | null | undefined)?.code;
      const name = (thrown as { name?: string } | null | undefined)?.name;
      const failure =
        code === 'ERR_WORKER_OUT_OF_MEMORY'
          ? new ExtractError('ATTACHMENT_INVALID', 'extraction out of memory')
          : !ready
            ? startFailure()
            : new ExtractError('ATTACHMENT_INVALID', name ?? 'extraction failed');
      finish(() => reject(failure));
    });
  });
}
