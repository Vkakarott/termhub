import { parentPort } from 'node:worker_threads';

/** An uncaught throw of a non-Error value: Node delivers it to the parent's `error` listener as-is
 * (e.g. `null`), so the handler must not assume it has `.code`/`.name`. */
parentPort!.postMessage({ type: 'ready' });
setTimeout(() => {
  throw null;
}, 0);
