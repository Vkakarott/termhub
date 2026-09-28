import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ExtractError } from './errors.js';

/**
 * Event order a real Worker can produce but not on demand (TER-314). A worker's uncaught throw
 * reaches the parent on Node's internal port, its `postMessage` replies on the public one, and the
 * two are not ordered: under load `error` can arrive before a `ready` the worker sent first. Node
 * only guarantees that the public port is drained before `exit` (`kOnExit` in
 * lib/internal/worker.js). The fake below replays that order deterministically.
 */
class FakeWorker extends EventEmitter {
  static last: FakeWorker;
  constructor() {
    super();
    FakeWorker.last = this;
  }
  terminate = vi.fn(async () => 1);
}
vi.mock('node:worker_threads', () => ({ Worker: FakeWorker }));

const { runInWorker } = await import('./worker-runner.js');

const run = () => runInWorker('pdf', Buffer.from('x'), 1, { timeoutMs: 10_000, heapMb: 64, workerUrl: new URL('file:///never-loaded.js') });
const failure = async (p: Promise<unknown>): Promise<ExtractError> => {
  try {
    await p;
  } catch (err) {
    if (err instanceof ExtractError) return err;
    throw err;
  }
  throw new Error('resolved');
};

describe('runInWorker, when the uncaught error overtakes the ready message', () => {
  let p: Promise<unknown>;
  beforeEach(() => {
    p = run();
  });

  it('a non-Error throw after ready is still an extraction failure, not a retryable start failure', async () => {
    const w = FakeWorker.last;
    w.emit('error', null);
    w.emit('message', { type: 'ready' });
    w.emit('exit', 1);
    const err = await failure(p);
    expect(err.code).toBe('ATTACHMENT_INVALID');
    expect(err.message).toBe('extraction failed');
    expect(err.retryable).toBe(false);
  });

  it('an Error throw after ready gives its name, not retryable', async () => {
    const w = FakeWorker.last;
    w.emit('error', new TypeError("Unexpected token 'SEGREDO-DO-ARQUIVO'"));
    w.emit('message', { type: 'ready' });
    w.emit('exit', 1);
    const err = await failure(p);
    expect(err.message).toBe('TypeError');
    expect(err.retryable).toBe(false);
  });

  it('an error with no ready before exit is still a retryable start failure', async () => {
    const w = FakeWorker.last;
    w.emit('error', Object.assign(new Error('Cannot find module'), { code: 'ERR_MODULE_NOT_FOUND' }));
    w.emit('exit', 1);
    const err = await failure(p);
    expect(err.message).toBe('extraction worker failed to start');
    expect(err.retryable).toBe(true);
  });

  it('out of memory is reported as such whatever the order', async () => {
    const w = FakeWorker.last;
    w.emit('error', Object.assign(new Error('oom'), { code: 'ERR_WORKER_OUT_OF_MEMORY' }));
    w.emit('exit', 1);
    const err = await failure(p);
    expect(err.message).toBe('extraction out of memory');
    expect(err.retryable).toBe(false);
  });
});
