import { parentPort } from 'node:worker_threads';

/** An uncaught throw whose message quotes "the file": only the error name may reach the parent. */
parentPort!.postMessage({ type: 'ready' });
setTimeout(() => {
  throw new TypeError("Unexpected token 'SEGREDO-DO-ARQUIVO'");
}, 0);
