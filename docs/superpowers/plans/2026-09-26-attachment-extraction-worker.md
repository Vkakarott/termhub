# Attachment extraction in a worker thread (TER-196) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Parse PDF, Word and Excel attachments in a `worker_threads` Worker with a 512 MB heap
limit and a 60 s timeout that really terminates the worker, so a hostile file can no longer freeze
the server's event loop.

**Architecture:** The parsers move unchanged out of `extract.ts` into a thread-agnostic
`parsers.ts`. A new worker entry (`extract-worker.ts`) runs one parse per isolate. A runner
(`worker-runner.ts`) spawns a fresh Worker per job, arms the timeout, maps the worker's events to
`ExtractError`, and always terminates the worker before settling. `extract()` keeps its signature
and routes `pdf`, `docx` and `xlsx` through the runner. The queue is not changed.

**Tech Stack:** Node 22 `worker_threads`, TypeScript (NodeNext ESM), vitest 3, tsx (dev and tests
only), unpdf, mammoth, exceljs.

**Spec:** `docs/superpowers/specs/2026-09-26-attachment-extraction-worker-design.md` (read it
first; it records the decisions and the reasons for them).

## Global Constraints

- Node: CI runs node 22, and the production image is `node:22-alpine`. Local verification runs through Docker (`node:22`) because the host has no Node.
- Workspaces are addressed by package name: `-w @termhub/server`.
- Heap limit: `EXTRACT_WORKER_HEAP_MB = 512` (`resourceLimits.maxOldGenerationSizeMb`).
- Timeout: `EXTRACT_TIMEOUT_MS = 60_000`, counted from the spawn. On expiry, `terminate()` runs, and then `ATTACHMENT_INVALID`.
- Error codes are unchanged, and nothing new reaches a client. The only new code path is a **retryable** `ATTACHMENT_INVALID` when the worker fails to start.
- There is one fresh Worker per job and no pool. The queue stays one job at a time, and `queue.ts` is not modified.
- `text`, `image` and whisper (audio and video) stay on the main thread.
- Nothing inside the worker logs. Logs never carry file bytes, extracted text or parser error messages (only error `name`s).
- Code, comments, commit messages and docs are in English. There is no UI copy in this change.
- No new dependency, no migration, no API change.

## Review Focus

- A `Buffer` from `fs.readFile` can be a view into a larger, shared `ArrayBuffer`. The runner must copy before transferring and must never detach the caller's buffer (the test is in Task 3).
- A parser error message can quote the file ("Unexpected token 'SEGREDO'…"). Only the error `name` may cross back from the worker (the test is in Task 2, fixture `throw.ts`).
- The production `.js` worker entry has to resolve from `dist/`, without tsx. A mistake there shows up only in production, as start failures (the dist smoke test is in Task 5).
- A worker that posts its result and then exits must settle once, with the result, and never turn into an "exited" failure (the test is in Task 2, the success case plus the settle-once assertion).
- After a timeout or out-of-memory failure, the next job must run normally in a fresh isolate (the tests are in Task 2 and in Task 4 at the queue level).

## File Structure

`apps/server/src/chat/attachments/`:
- `errors.ts` (create): `ExtractError` and `ExtractErrorCode`, moved from `extract.ts` so the worker never imports the whisper code.
- `parsers.ts` (create): `parseDocument(kind, file, zipBudget)`, the pdf, docx and xlsx parsers, the ZIP guard, the caps and `capText`. It knows nothing about threads.
- `parsers.test.ts` (create): the in-thread tests that need `vi.spyOn` on exceljs, moved out of `extract.test.ts`.
- `extract-worker.ts` (create): the worker entry, one job per isolate.
- `worker-runner.ts` (create): `runInWorker`, `defaultWorkerUrl`, `EXTRACT_WORKER_HEAP_MB` and the message types.
- `worker-runner.test.ts` (create).
- `extract.ts` (modify): dispatch only. `pdf`, `docx` and `xlsx` go through the runner, and `withTimeout` is removed.
- `extract.test.ts` (modify).
- `queue.test.ts` (modify): integration tests with the real worker.

`apps/server/test/workers/` (create): the fixture workers `spin.ts`, `hog.ts`, `throw.ts` and `exit.ts`.

`docs/superpowers/specs/2026-09-26-chat-redesign-attachments-design.md` (modify §5.4).

## How to run tests (every task)

The checkout host has no Node. From the worktree root, install once and then run vitest through
Docker:

```bash
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/w" -w /w node:22 sh -c 'npm ci --no-audit --no-fund'
# then, per run (replace the path/filter):
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/w" -w /w/apps/server node:22 \
  sh -c 'npx vitest run src/chat/attachments'
rm -rf .npm
```

Below, `VT <args>` stands for the second command with `<args>` in place of `src/chat/attachments`.

---

### Task 1: Split the parsers out of `extract.ts` (pure refactor)

**Files:**
- Create: `apps/server/src/chat/attachments/errors.ts`
- Create: `apps/server/src/chat/attachments/parsers.ts`
- Create: `apps/server/src/chat/attachments/parsers.test.ts`
- Modify: `apps/server/src/chat/attachments/extract.ts`
- Modify: `apps/server/src/chat/attachments/extract.test.ts`

**Interfaces:**
- Produces (from `errors.ts`): `type ExtractErrorCode = 'ATTACHMENT_INVALID' | 'TRANSCRIPTION_UNAVAILABLE' | 'TRANSCRIPTION_FAILED'`; `class ExtractError extends Error { code; retryable; constructor(code, message?, opts?: { retryable?: boolean }) }`, both unchanged.
- Produces (from `parsers.ts`): `type DocumentKind = 'pdf' | 'docx' | 'xlsx'`; `interface Extracted { text: string | null; meta: Record<string, unknown> }`; `parseDocument(kind: DocumentKind, file: Buffer, zipBudget: number): Promise<Extracted>`; `capText(text: string): { text: string; truncated: boolean }`; the constants `TEXT_CAP`, `ZIP_EXPANDED_MAX_BYTES`, `XLSX_MAX_ROWS` and `XLSX_MAX_COLS`.
- `extract.ts` keeps exporting `ExtractError`, `ExtractErrorCode`, `Extracted`, `TEXT_CAP`, `XLSX_MAX_ROWS`, `XLSX_MAX_COLS`, `ZIP_EXPANDED_MAX_BYTES`, `EXTRACT_TIMEOUT_MS`, `WHISPER_TIMEOUT_MS`, `ExtractDeps`, `imageDimensions`, `extract` and (until Task 3) `withTimeout`, so no importer changes.

- [ ] **Step 1: Move the exceljs spy tests to `parsers.test.ts` so they call `parseDocument` directly (failing: the module does not exist yet)**

Cut these two tests out of `extract.test.ts`: "xlsx: a local entry the directory does not list is refused before the streaming reader…" and "xlsx: read through the streaming WorkbookReader, one row at a time…". Paste them into the new file, with `extract(kind, buf, 'application/x', deps)` rewritten as `parseDocument(kind, buf, budget)`:

```ts
import ExcelJS from 'exceljs';
import { describe, expect, it, vi } from 'vitest';
import { withUnlistedEntry } from '../../../test/zip.js';
import { ExtractError } from './errors.js';
import { ZIP_EXPANDED_MAX_BYTES, parseDocument } from './parsers.js';

/**
 * In-thread: spies on exceljs only see the thread they run in, so what they assert (which reader
 * ran) is tested here, against the parsers themselves. `extract.test.ts` covers the same parsers
 * through the worker.
 */
const code = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return 'resolved';
  } catch (err) {
    return err instanceof ExtractError ? err.code : `other:${String(err)}`;
  }
};

describe('parseDocument (in-thread)', () => {
  it('xlsx: a local entry the directory does not list is refused before the streaming reader (which walks local headers) sees it', async () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('S').addRow(['x']);
    const genuine = Buffer.from(await wb.xlsx.writeBuffer());
    const strings = `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${'<si><t>aaaaaaaaaaaaaaaa</t></si>'.repeat(40_000)}</sst>`;
    const hidden = withUnlistedEntry(genuine, 'xl/sharedStrings.xml', strings);
    expect(hidden.length).toBeLessThan(genuine.length + 16 * 1024);
    const parse = vi.spyOn(ExcelJS.stream.xlsx.WorkbookReader.prototype, 'parse');
    try {
      expect(await code(parseDocument('xlsx', hidden, 256 * 1024))).toBe('ATTACHMENT_INVALID');
      expect(parse).not.toHaveBeenCalled();
      expect((await parseDocument('xlsx', genuine, 256 * 1024)).meta).toMatchObject({ sheets: [{ name: 'S', rows: 1, cols: 1 }] });
    } finally {
      parse.mockRestore();
    }
  });

  it('xlsx: read through the streaming WorkbookReader, one row at a time, never a whole-workbook load', async () => {
    const streamed = vi.spyOn(ExcelJS.stream.xlsx.WorkbookReader.prototype, 'parse');
    const loaded = vi.spyOn(Object.getPrototypeOf(new ExcelJS.Workbook().xlsx) as ExcelJS.Xlsx, 'load');
    try {
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('Gaps');
      ws.getRow(1).values = ['a', 'b'];
      ws.getRow(3).values = ['c'];
      const r = await parseDocument('xlsx', Buffer.from(await wb.xlsx.writeBuffer()), ZIP_EXPANDED_MAX_BYTES);
      expect(streamed).toHaveBeenCalledTimes(1);
      expect(loaded).not.toHaveBeenCalled();
      expect(r.text).toBe('## Gaps\n| a | b |\n| --- | --- |\n|  |  |\n| c |  |');
      expect(r.meta).toEqual({ sheets: [{ name: 'Gaps', rows: 3, cols: 2 }], truncated: false });
    } finally {
      streamed.mockRestore();
      loaded.mockRestore();
    }
  });
});
```

In `extract.test.ts`, remove `vi` from the vitest import if nothing else uses it. The whisper tests use `vi.fn`, so check with `grep -n "vi\." extract.test.ts`.

- [ ] **Step 2: Run and see it fail**

Run: `VT src/chat/attachments/parsers.test.ts`
Expected: FAIL: `Cannot find module './parsers.js'` (or `./errors.js`).

- [ ] **Step 3: Create `errors.ts`**

Move the `ExtractErrorCode` type and the `ExtractError` class **verbatim** from `extract.ts` (the lines from `export type ExtractErrorCode` through the end of the class), with this header:

```ts
/**
 * The attachment extraction errors (spec 2026-09-26 chat-redesign-attachments §5.4). Its own module
 * so the extraction worker (`extract-worker.ts`) can map errors without importing the whisper path.
 */
```

- [ ] **Step 4: Create `parsers.ts`**

Move from `extract.ts`, **verbatim**, keeping their comments: the `Readable`, `ExcelJS`, `mammoth` and `unpdf` imports; the zip imports; `TEXT_CAP`, `ZIP_EXPANDED_MAX_BYTES`, `XLSX_MAX_ROWS`, `XLSX_MAX_COLS`, `Extracted`, `convertToMarkdown`, `NO_IMAGES`, `NamedSheet`, `capText` (now `export`ed), `guardZip`, `fromPdf`, `fromDocx`, `cellText`, `escapeCell` and `fromXlsx`. Import `ExtractError` from `./errors.js`. Then add:

```ts
/**
 * The three document parsers behind one call (spec 2026-09-26 attachment-extraction-worker §4.1).
 * Plain code that knows nothing about threads: `extract-worker.ts` runs it in a Worker, and the
 * in-thread tests call it directly.
 */
export type DocumentKind = 'pdf' | 'docx' | 'xlsx';

export function parseDocument(kind: DocumentKind, file: Buffer, zipBudget: number): Promise<Extracted> {
  switch (kind) {
    case 'pdf':
      return fromPdf(file);
    case 'docx':
      return fromDocx(file, zipBudget);
    case 'xlsx':
      return fromXlsx(file, zipBudget);
  }
}
```

The module's top doc comment is the one currently at the top of `extract.ts` ("What the concierge will be able to read of a file…"). Move it here, and give `extract.ts` a short one: "Dispatches an attachment to its extractor (spec 2026-09-26 §5.4): documents to `parsers.ts`, audio and video to whisper."

- [ ] **Step 5: Slim `extract.ts` down to the dispatch (still in-thread)**

Top of the file:

```ts
import type { AttachmentKind } from '@termhub/mobile-api';
import { ExtractError } from './errors.js';
import { type Extracted, ZIP_EXPANDED_MAX_BYTES, capText, parseDocument } from './parsers.js';

export { ExtractError, type ExtractErrorCode } from './errors.js';
export { type Extracted, TEXT_CAP, XLSX_MAX_COLS, XLSX_MAX_ROWS, ZIP_EXPANDED_MAX_BYTES } from './parsers.js';
```

Keep `EXTRACT_TIMEOUT_MS`, `WHISPER_TIMEOUT_MS`, `ExtractDeps`, `withTimeout`, `imageDimensions`, `transcribe` and `parsed`. In `extract()`, replace the three document cases with:

```ts
    case 'pdf':
    case 'docx':
    case 'xlsx':
      return parsed(() => parseDocument(kind, file, zipBudget), timeoutMs);
```

- [ ] **Step 6: Run the attachment tests and typecheck**

Run: `VT src/chat/attachments`
Expected: PASS (every existing test, plus the 2 moved ones).
Run: `docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/w" -w /w node:22 npm run typecheck -w @termhub/server`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/chat/attachments/{errors,parsers,parsers.test,extract,extract.test}.ts
git commit -m "Attachments: split the document parsers out of extract.ts

No behaviour change. The parsers become thread-agnostic so the next
commit can run them in a worker; the exceljs spy tests move with them,
since spies do not cross threads."
```

---

### Task 2: Worker entry and runner (timeout, heap limit, terminate)

**Files:**
- Create: `apps/server/src/chat/attachments/extract-worker.ts`
- Create: `apps/server/src/chat/attachments/worker-runner.ts`
- Create: `apps/server/src/chat/attachments/worker-runner.test.ts`
- Create: `apps/server/test/workers/spin.ts`, `hog.ts`, `throw.ts`, `exit.ts`

**Interfaces:**
- Consumes: `parseDocument`, `DocumentKind`, `Extracted` (from `parsers.ts`); `ExtractError`, `ExtractErrorCode` (from `errors.ts`).
- Produces (from `worker-runner.ts`):
  - `EXTRACT_WORKER_HEAP_MB = 512`
  - `interface WorkerJob { kind: DocumentKind; file: Uint8Array; zipBudget: number }`
  - `type WorkerReply = { type: 'ready' } | { type: 'result'; ok: true; extracted: Extracted } | { type: 'result'; ok: false; code: ExtractErrorCode; message: string }`
  - `interface RunOptions { timeoutMs: number; heapMb: number; workerUrl: URL }`
  - `defaultWorkerUrl(): URL`
  - `runInWorker(kind: DocumentKind, file: Buffer, zipBudget: number, opts: RunOptions): Promise<Extracted>`

- [ ] **Step 1: Write the fixture workers** (they follow the `WorkerReply` protocol and post literal objects)

`apps/server/test/workers/spin.ts`:
```ts
import { parentPort } from 'node:worker_threads';

/** A parser that never comes back: the runner's timeout must terminate it. */
parentPort!.postMessage({ type: 'ready' });
for (;;) {
  // busy: never yields to the event loop
}
```

`apps/server/test/workers/hog.ts`:
```ts
import { parentPort } from 'node:worker_threads';

/** A parser that eats its heap: the worker's resourceLimits must stop it, not the process. */
parentPort!.postMessage({ type: 'ready' });
const held: string[] = [];
for (;;) held.push('x'.repeat(1_000_000) + Math.random());
```

`apps/server/test/workers/throw.ts`:
```ts
import { parentPort } from 'node:worker_threads';

/** An uncaught throw whose message quotes "the file": only the error name may reach the parent. */
parentPort!.postMessage({ type: 'ready' });
setTimeout(() => {
  throw new TypeError("Unexpected token 'SEGREDO-DO-ARQUIVO'");
}, 0);
```

`apps/server/test/workers/exit.ts`:
```ts
import { parentPort } from 'node:worker_threads';

/** A worker that leaves without answering. */
parentPort!.postMessage({ type: 'ready' });
process.exit(0);
```

- [ ] **Step 2: Write the failing runner tests**

`apps/server/src/chat/attachments/worker-runner.test.ts`:
```ts
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
  }, 20_000);

  it('a worker that exits without answering is ATTACHMENT_INVALID', async () => {
    const err = await failure(runInWorker('pdf', Buffer.from('x'), 1, opts(fixture('exit.ts'))));
    expect(err.code).toBe('ATTACHMENT_INVALID');
    expect(err.message).toBe('extraction worker exited');
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
```

- [ ] **Step 3: Run and see it fail**

Run: `VT src/chat/attachments/worker-runner.test.ts`
Expected: FAIL: `Cannot find module './worker-runner.js'`.

- [ ] **Step 4: Write `worker-runner.ts`**

```ts
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
    worker.on('error', (err: Error & { code?: string }) => {
      const failure =
        err.code === 'ERR_WORKER_OUT_OF_MEMORY' ? new ExtractError('ATTACHMENT_INVALID', 'extraction out of memory') : !ready ? startFailure() : new ExtractError('ATTACHMENT_INVALID', err.name);
      finish(() => reject(failure));
    });
    worker.on('exit', () => finish(() => reject(new ExtractError('ATTACHMENT_INVALID', 'extraction worker exited'))));
  });
}
```

- [ ] **Step 5: Write `extract-worker.ts`**

```ts
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
```

(The ZIP guard's `ExtractError` messages, such as "zip refused: over budget", are fixed strings. They never contain file bytes.)

- [ ] **Step 6: Run the runner tests**

Run: `VT src/chat/attachments/worker-runner.test.ts`
Expected: PASS (8 tests). If "settles once, with the result" fails as "extraction worker exited", the `exit` event is winning over `message`. Node emits every message the worker posted before `exit`, so check that `finish` is not being called from somewhere else before you change the ordering.

- [ ] **Step 7: Typecheck**

Run: `docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/w" -w /w node:22 npm run typecheck -w @termhub/server`
Expected: no errors. (`apps/server/test/workers/*` is outside `tsconfig.json`'s `include`; vitest compiles them through tsx.)

- [ ] **Step 8: Commit**

```bash
git add apps/server/src/chat/attachments/{extract-worker,worker-runner,worker-runner.test}.ts apps/server/test/workers
git commit -m "Attachments: worker runner with a heap limit and a real timeout

One fresh Worker per parse. The timeout terminates it, running out of
heap is an invalid attachment, and a worker that cannot load is
retryable, because a broken build is not the file's fault."
```

---

### Task 3: Route pdf, docx and xlsx through the worker

**Files:**
- Modify: `apps/server/src/chat/attachments/extract.ts`
- Modify: `apps/server/src/chat/attachments/extract.test.ts`

**Interfaces:**
- Consumes: `runInWorker`, `defaultWorkerUrl`, `EXTRACT_WORKER_HEAP_MB` (Task 2).
- Produces: `ExtractDeps` gains two test-only fields, `workerUrl?: URL` and `heapMb?: number`. `withTimeout` is no longer exported. `extract()`'s signature is unchanged.

- [ ] **Step 1: Write the failing tests** (add to `extract.test.ts`, in the `describe('extract: pdf, docx, xlsx')` block)

```ts
  it('documents are parsed in a worker: a parser that never answers is stopped by the timeout', async () => {
    const spin = new URL('../../../test/workers/spin.ts', import.meta.url);
    const started = Date.now();
    const err = await extract('pdf', Buffer.from('%PDF-1.4'), 'application/pdf', { ...noWhisper, workerUrl: spin, timeoutMs: 1_000 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExtractError);
    expect((err as ExtractError).code).toBe('ATTACHMENT_INVALID');
    // Only the worker path says this: the in-thread unpdf would fail at once with its own error name.
    expect((err as ExtractError).message).toBe('extraction timed out');
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 20_000);
  it('a file that is a view into a larger buffer is extracted, and the caller’s buffer is left intact', async () => {
    const doc = minimalDocx(['Olá mundo'], { deflate: true });
    const slab = Buffer.alloc(doc.length + 64, 7);
    doc.copy(slab, 32);
    const view = slab.subarray(32, 32 + doc.length);
    expect((await extract('docx', view, 'application/x', noWhisper)).text).toBe('Olá mundo');
    expect(slab.byteLength).toBe(doc.length + 64);
    expect(slab[0]).toBe(7);
    expect(view.equals(doc)).toBe(true);
  }, 20_000);
```

Also delete the test `withTimeout turns a parser that never answers into an invalid attachment` and drop `withTimeout` from the import.

- [ ] **Step 2: Run and see it fail**

Run: `VT src/chat/attachments/extract.test.ts`
Expected: the spin test FAILS: vitest does not typecheck, so `workerUrl` is ignored, the parse runs in-thread, and unpdf rejects `%PDF-1.4` at once, so the message is unpdf's error name instead of `extraction timed out`. The "view into a larger buffer" test already passes; it is a guard for Step 3's copy-before-transfer.

- [ ] **Step 3: Implement in `extract.ts`**

Imports:
```ts
import { EXTRACT_WORKER_HEAP_MB, defaultWorkerUrl, runInWorker } from './worker-runner.js';
```
Remove `withTimeout`. Add to `ExtractDeps`:
```ts
  /** Tests only; production uses `defaultWorkerUrl()`. */
  workerUrl?: URL;
  /** Tests only; production uses `EXTRACT_WORKER_HEAP_MB`. */
  heapMb?: number;
```
Change the doc comment of `EXTRACT_TIMEOUT_MS` to: `/** A document parse's budget, counted from the worker's spawn; the worker is terminated when it runs out. */`

Replace `parsed` with a text-only helper and route the documents:
```ts
/** The UTF-8 decode stays on this thread: linear and bounded by the upload size. A bad byte is an invalid attachment. */
function decodeText(file: Buffer): Extracted {
  try {
    const c = capText(new TextDecoder('utf-8', { fatal: true }).decode(file));
    return { text: c.text, meta: { truncated: c.truncated } };
  } catch {
    throw new ExtractError('ATTACHMENT_INVALID', 'not utf-8');
  }
}
```
and in `extract()`:
```ts
    case 'text':
      return decodeText(file);
    case 'pdf':
    case 'docx':
    case 'xlsx':
      // Off the event loop, in a worker with its own heap limit and a timeout that stops it (TER-196).
      return runInWorker(kind, file, zipBudget, { timeoutMs, heapMb: deps.heapMb ?? EXTRACT_WORKER_HEAP_MB, workerUrl: deps.workerUrl ?? defaultWorkerUrl() });
```
`extract` is `async`, so a throw from `decodeText` still becomes a rejection.

- [ ] **Step 4: Run tests and typecheck**

Run: `VT src/chat/attachments`
Expected: PASS. Every pdf, docx and xlsx case in `extract.test.ts` now goes through the worker; they are slower (~0.2–0.5 s each) but give the same results.
Run: the typecheck command from Task 1, Step 6. Expected: no errors (`grep -rn withTimeout apps/server/src/chat/attachments` finds nothing).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/chat/attachments/{extract,extract.test}.ts
git commit -m "Attachments: parse PDF, Word and Excel in a worker thread

A pathological file within the size limits could hold the event loop for
seconds, and the old timeout only stopped waiting for it. Documents now
parse off the main thread; text, images and whisper stay where they were."
```

---

### Task 4: Queue integration with the real worker

**Files:**
- Modify: `apps/server/src/chat/attachments/queue.test.ts`

**Interfaces:**
- Consumes: `extract` (with the test-only `workerUrl` and `timeoutMs`), `createExtractionQueue`, `MAX_PARSE_ATTEMPTS`, and `minimalDocx` from `test/zip.ts`.
- Produces: tests only; `queue.ts` is not changed.

- [ ] **Step 1: Write the tests**

Change the import `import { ExtractError, type extract } from './extract.js';` to `import { ExtractError, extract } from './extract.js';` (`typeof extract` keeps working), and add `import { minimalDocx } from '../../../test/zip.js';`. Append:

```ts
describe('extraction queue with the real worker (TER-196)', () => {
  const SPIN = new URL('../../../test/workers/spin.ts', import.meta.url);
  const MISSING = new URL('../../../test/workers/missing.ts', import.meta.url);

  it('a parse that runs out of time fails its row, and the next job runs and extracts', async () => {
    const extractImpl = ((kind, file, mime, w) => extract(kind, file, mime, kind === 'pdf' ? { ...w, workerUrl: SPIN, timeoutMs: 1_000 } : w)) as typeof extract;
    const { queue, files, onDone } = build([row({ id: 'hang', kind: 'pdf' }), row({ id: 'doc', kind: 'docx', name: 'a.docx' })], extractImpl);
    files.read.mockImplementation(async (_u: string, id: string) => (id === 'doc' ? minimalDocx(['Olá mundo']) : Buffer.from('%PDF-1.4')));
    queue.enqueue('hang');
    queue.enqueue('doc');
    await queue.idle();
    expect(onDone.mock.calls.map((c) => [c[0].id, c[0].status, c[0].error_code, c[0].extracted_text])).toEqual([
      ['hang', 'failed', 'ATTACHMENT_INVALID', null],
      ['doc', 'ready', null, 'Olá mundo'],
    ]);
  }, 30_000);

  it('a worker that cannot start leaves the row pending for the hourly re-queue, then fails it when the attempts run out', async () => {
    const extractImpl = ((kind, file, mime, w) => extract(kind, file, mime, { ...w, workerUrl: MISSING })) as typeof extract;
    const { queue, repo, store, log } = build([row({ id: 'first' }), row({ id: 'last', meta: { attempts: MAX_PARSE_ATTEMPTS - 1 } })], extractImpl);
    queue.enqueue('first');
    queue.enqueue('last');
    await queue.idle();
    expect(store.get('first')!.status).toBe('pending');
    expect(repo.setFailed).toHaveBeenCalledWith('last', 'ATTACHMENT_INVALID');
    expect(log.info).toHaveBeenCalledWith(expect.objectContaining({ attachmentId: 'first', kind: 'pdf', code: 'ATTACHMENT_INVALID' }), 'attachment extraction deferred');
  }, 30_000);
});
```

- [ ] **Step 2: Run**

Run: `VT src/chat/attachments/queue.test.ts`
Expected: PASS without touching `queue.ts`. These are guard tests for behaviour Tasks 2–3 already deliver. If one fails, the bug is in the runner or `extract.ts`, not in the queue: fix it there, and keep `queue.ts` unchanged (spec §3).

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/chat/attachments/queue.test.ts
git commit -m "Attachments queue: cover a timed-out and an unstartable worker

A parse that times out fails only its own row and the next job runs; a
worker entry that cannot load keeps the row pending until the attempts
run out."
```

---

### Task 5: Docs and full verification (including the production `.js` entry)

**Files:**
- Modify: `docs/superpowers/specs/2026-09-26-chat-redesign-attachments-design.md` (§5.4)

- [ ] **Step 1: Update §5.4 of the attachments spec**

Replace the bullet `- \`extract.ts\` dispatches per kind. Each extractor has a 60 s timeout and caps its output at **200 000 characters**, setting \`meta.truncated\`.` with:

```markdown
- `extract.ts` dispatches per kind, and every extractor caps its output at **200 000 characters**,
  setting `meta.truncated`. pdf, docx and xlsx (ZIP guard included) run in a `worker_threads`
  Worker, a fresh one per job, with a 512 MB heap limit and a 60 s timeout that **terminates** the
  worker. Timing out or running out of heap is `ATTACHMENT_INVALID`, and a worker that fails to load
  is retried by the hourly re-queue (`2026-09-26-attachment-extraction-worker-design.md`, TER-196).
  text, image and whisper stay on the main thread.
```

- [ ] **Step 2: The full attachment suite, typecheck and the CLAUDE.md builds**

```bash
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/w" -w /w node:22 sh -c '
  npm run typecheck -w @termhub/server &&
  (cd apps/server && npx vitest run src/chat/attachments) &&
  npm run build -w @termhub/server && npm run build -w @termhub/web && npm run build -w @termhub/landing'
```
Expected: typecheck clean, every attachment test green, and all three builds succeed.

- [ ] **Step 3: Confirm that the compiled `.js` worker entry runs without tsx (production path)**

```bash
ls apps/server/dist/chat/attachments/extract-worker.js
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/w" -w /w/apps/server node:22 node --input-type=module -e "
import ExcelJS from 'exceljs';
import { extract } from './dist/chat/attachments/extract.js';
import { defaultWorkerUrl } from './dist/chat/attachments/worker-runner.js';
if (!defaultWorkerUrl().pathname.endsWith('/dist/chat/attachments/extract-worker.js')) throw new Error('wrong entry: ' + defaultWorkerUrl());
const wb = new ExcelJS.Workbook(); wb.addWorksheet('S').addRow(['ok']);
const r = await extract('xlsx', Buffer.from(await wb.xlsx.writeBuffer()), 'x', { whisperUrl: null, language: null });
console.log(JSON.stringify(r));
"
rm -rf .npm
```
Expected: `{"text":"## S\n| ok |\n| --- |","meta":{"sheets":[{"name":"S","rows":1,"cols":1}],"truncated":false}}`. `extract-worker.js` exists. There is no "failed to start" error, and there is no `--import tsx`.

- [ ] **Step 4: The server's full suite (it needs Postgres, the way CI runs it)**

Run the whole `@termhub/server` suite against a throwaway Postgres named `th-test-db` (never a prod container name, per CLAUDE.md), with the same `DATABASE_URL` shape as CI (`.github/workflows`). Expected: green. If Postgres is not available, say so explicitly in the hand-off, and rely on the `check` job in CI.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs/2026-09-26-chat-redesign-attachments-design.md
git commit -m "Attachments spec: extraction runs in a worker with a real timeout"
```
