import { parentPort } from 'node:worker_threads';

/** A worker that leaves without answering. */
parentPort!.postMessage({ type: 'ready' });
process.exit(0);
