import { parentPort, workerData } from 'node:worker_threads';
import { ExtractError } from './errors.js';
import { parseDocument } from './parsers.js';
import type { WorkerJob, WorkerReply } from './worker-runner.js';

/**
 * The extraction worker's entry (spec 2026-09-26 attachment-extraction-worker §4.1): one document
 * per isolate, then the thread ends. `ready` goes out once the parsers have loaded, so the runner
 * can tell a broken build from a broken file. A parser's error message can quote the file, so only
 * its name crosses back. Nothing is logged here.
 */
const port = parentPort!;
const post = (reply: WorkerReply) => port.postMessage(reply);
post({ type: 'ready' });

const job = workerData as WorkerJob;
try {
  const extracted = await parseDocument(job.kind, Buffer.from(job.file.buffer, job.file.byteOffset, job.file.byteLength), job.zipBudget);
  post({ type: 'result', ok: true, extracted });
} catch (err) {
  if (err instanceof ExtractError) post({ type: 'result', ok: false, code: err.code, message: err.message });
  else post({ type: 'result', ok: false, code: 'ATTACHMENT_INVALID', message: err instanceof Error ? err.name : 'parse failed' });
}
