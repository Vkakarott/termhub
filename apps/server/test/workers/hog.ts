import { parentPort } from 'node:worker_threads';

/** A parser that eats its heap: the worker's resourceLimits must stop it, not the process. */
parentPort!.postMessage({ type: 'ready' });
const held: string[] = [];
for (;;) held.push('x'.repeat(1_000_000) + Math.random());
