import { parentPort } from 'node:worker_threads';

/** A parser that never comes back: the runner's timeout must terminate it. */
parentPort!.postMessage({ type: 'ready' });
for (;;) {
  // busy: never yields to the event loop
}
