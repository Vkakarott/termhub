import { describe, expect, it } from 'vitest';
import { minimalDocx } from '../../../test/zip.js';
import { ExtractError } from './errors.js';
import { ZIP_EXPANDED_MAX_BYTES } from './parsers.js';
import { EXTRACT_WORKER_HEAP_MB, defaultWorkerUrl, runInWorker } from './worker-runner.js';

const fixture = (name: string) => new URL(`../../../test/workers/${name}`, import.meta.url);
const opts = (workerUrl: URL, over: { timeoutMs?: number; heapMb?: number } = {}) => ({ timeoutMs: 10_000, heapMb: EXTRACT_WORKER_HEAP_MB, workerUrl, ...over });
const failure = async (p: Promise<unknown>): Promise<ExtractError> => {
  try {
    await p;
  } catch (err) {
    if (err instanceof ExtractError) return err;
    throw err;
  }
  throw new Error('resolved');
};
const docx = () => minimalDocx(['Olá mundo'], { deflate: true });

describe('runInWorker', () => {
  it('parses a document in the real worker entry and settles once, with the result', async () => {
    const r = await runInWorker('docx', docx(), ZIP_EXPANDED_MAX_BYTES, opts(defaultWorkerUrl()));
    expect(r).toEqual({ text: 'Olá mundo', meta: { truncated: false } });
  }, 20_000);

  it('a parser error inside the worker keeps its code (ATTACHMENT_INVALID for garbage)', async () => {
    const err = await failure(runInWorker('docx', Buffer.from('not a zip'), ZIP_EXPANDED_MAX_BYTES, opts(defaultWorkerUrl())));
    expect(err.code).toBe('ATTACHMENT_INVALID');
    expect(err.retryable).toBe(false);
  }, 20_000);

  it('a parser that never answers is terminated at the timeout, and the main event loop kept ticking meanwhile', async () => {
    let last = Date.now();
    let maxGap = 0;
    const tick = setInterval(() => {
      const now = Date.now();
      maxGap = Math.max(maxGap, now - last);
      last = now;
    }, 10);
    const started = Date.now();
    try {
      const err = await failure(runInWorker('pdf', Buffer.from('x'), 1, opts(fixture('spin.ts'), { timeoutMs: 1_500 })));
      expect(err.code).toBe('ATTACHMENT_INVALID');
      expect(err.message).toBe('extraction timed out');
      expect(err.retryable).toBe(false);
    } finally {
      clearInterval(tick);
    }
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(maxGap).toBeLessThan(250);
  }, 20_000);

  it('a parser that runs out of heap is ATTACHMENT_INVALID, and this process survives', async () => {
    const err = await failure(runInWorker('xlsx', Buffer.from('x'), 1, opts(fixture('hog.ts'), { heapMb: 32 })));
    expect(err.code).toBe('ATTACHMENT_INVALID');
    expect(err.message).toBe('extraction out of memory');
    expect(err.retryable).toBe(false);
  }, 30_000);

  it('an uncaught throw in the worker gives the error name only, never its message', async () => {
    const err = await failure(runInWorker('pdf', Buffer.from('x'), 1, opts(fixture('throw.ts'))));
    expect(err.code).toBe('ATTACHMENT_INVALID');
    expect(err.message).toBe('TypeError');
    expect(err.message).not.toContain('SEGREDO');
    expect(err.retryable).toBe(false);
  }, 20_000);

  it('an uncaught throw of a non-Error value (e.g. `throw null`) is ATTACHMENT_INVALID, and this process survives', async () => {
    const err = await failure(runInWorker('pdf', Buffer.from('x'), 1, opts(fixture('throw-null.ts'))));
    expect(err.code).toBe('ATTACHMENT_INVALID');
    expect(err.retryable).toBe(false);
  }, 20_000);

  // TER-314: the uncaught error and the `ready` message travel on different ports, so with many
  // workers at once the error sometimes lands first. It must still be the file's failure, never
  // a retryable start failure. worker-runner.order.test.ts forces that order deterministically.
  it('many uncaught throws at once are all extraction failures, never retryable start failures', async () => {
    const jobs = Array.from({ length: 24 }, (_, i) => failure(runInWorker('pdf', Buffer.from('x'), 1, opts(fixture(i % 2 ? 'throw.ts' : 'throw-null.ts')))));
    const errs = await Promise.all(jobs);
    expect(errs.filter((e) => e.retryable).map((e) => e.message)).toEqual([]);
    expect(errs.every((e) => e.code === 'ATTACHMENT_INVALID')).toBe(true);
  }, 60_000);

  it('a worker that exits without answering is ATTACHMENT_INVALID', async () => {
    const err = await failure(runInWorker('pdf', Buffer.from('x'), 1, opts(fixture('exit.ts'))));
    expect(err.code).toBe('ATTACHMENT_INVALID');
    expect(err.message).toBe('extraction worker exited');
    expect(err.retryable).toBe(false);
  }, 20_000);

  it('a worker entry that cannot load is a retryable failure (a broken build is not the file’s fault)', async () => {
    const err = await failure(runInWorker('pdf', Buffer.from('x'), 1, opts(fixture('missing.ts'))));
    expect(err.code).toBe('ATTACHMENT_INVALID');
    expect(err.message).toBe('extraction worker failed to start');
    expect(err.retryable).toBe(true);
  }, 20_000);

  it('after a timeout and an out-of-memory failure, the next job runs normally in a fresh isolate', async () => {
    await failure(runInWorker('pdf', Buffer.from('x'), 1, opts(fixture('spin.ts'), { timeoutMs: 500 })));
    await failure(runInWorker('pdf', Buffer.from('x'), 1, opts(fixture('hog.ts'), { heapMb: 32 })));
    expect((await runInWorker('docx', docx(), ZIP_EXPANDED_MAX_BYTES, opts(defaultWorkerUrl()))).text).toBe('Olá mundo');
  }, 40_000);
});
