# Attachments: document extraction in a worker thread with a real timeout (TER-196) — design

Card: **TER-196** (epic TER-1 · Chat). Follows `2026-09-26-chat-redesign-attachments-design.md` §5.4
(TER-98). Subtasks are listed in the implementation plan
(`docs/superpowers/plans/2026-09-26-attachment-extraction-worker.md`).

## 1. Problem

`apps/server/src/chat/attachments/extract.ts` parses PDF (`unpdf`), Word (`mammoth`) and Excel
(`exceljs`) on the server's own thread. The 60 s timeout (`withTimeout`) only races a promise: when
it fires, the queue moves on but the parser keeps running. A pathological file within the limits
(20 MB upload, 200 MB inflated) can still hold the event loop for seconds, which freezes HTTP and the
terminals' WebSockets for every user. mammoth's XML processing is almost entirely synchronous, which
makes it the most likely culprit. In a measurement, a 9 MB xlsx took 3.1 s of CPU, with short stalls
after the streaming.

## 2. Goal and non-goals

Goal: the three document parsers run off the main thread, in a `worker_threads` Worker that has a heap
limit and is terminated for real when the timeout fires. The server stays responsive while a file is
parsed, and a file that runs out of time or memory becomes `ATTACHMENT_INVALID` without taking the
server down.

The observable contract stays the same:
- the extracted text and `meta` are identical for every file that extracts today;
- the error codes are the same (`ATTACHMENT_INVALID` for a bad document);
- the attempt accounting (`meta.attempts`, `MAX_PARSE_ATTEMPTS`) and the queue (one job at a time,
  boot re-queue, hourly re-queue) are unchanged.

Non-goals:
- Whisper (audio and video) stays an HTTP call from the main thread; it is already out of process.
- `text` (UTF-8 decode) and `image` (header read) stay in process. Both are linear and bounded by the
  20 MB upload, taking milliseconds.
- No parallelism: the queue still runs one job at a time.
- No CPU priority or nice level for the worker; a thread cannot be niced on its own (§8).

## 3. Decisions

Decided by the implementer on the requester's instruction ("decida sozinho pela sua recomendação e
registre as decisões e o motivo no spec"), 2026-09-26.

| Topic | Decision | Why |
|---|---|---|
| Worker lifetime | **A fresh Worker per job**, terminated when the job ends, whatever the outcome. No pool. | The queue runs one job at a time, so a pool buys nothing. A fresh isolate starts with an empty heap, so no state or leak from a hostile file carries over to the next one. Start-up cost was measured at ~180 ms (under tsx, which is slower than production), which is small next to a parse. |
| What runs in the worker | The **whole** pdf/docx/xlsx path: the ZIP guard (`guardZip`: directory check plus `inflatedBytes`) and the parser. | The guard inflates up to 200 MB. Its zlib work runs on the thread pool, but the loop that drives it does not, and keeping the guard beside the parser keeps "one file, one isolate". |
| Heap limit | `resourceLimits.maxOldGenerationSizeMb = 512` (`EXTRACT_WORKER_HEAP_MB`). Other limits keep Node's defaults. | That leaves room for pdf.js on a 20 MB PDF and for exceljs's shared strings, and it is still far below the host's memory. Out of memory becomes `ATTACHMENT_INVALID` (the file's fault, so it is not retried). |
| Timeout | Keep `EXTRACT_TIMEOUT_MS = 60 000`, counted from the spawn. On expiry: `await worker.terminate()`, then `ATTACHMENT_INVALID` ("extraction timed out"). | That is the same budget as today; the difference is that it now stops the work. Waiting for `terminate()` before settling means the next job can never overlap a dying parser. |
| Worker that fails to start | A worker whose script fails to load (an error before its `ready` message) is an `ExtractError('ATTACHMENT_INVALID', …, { retryable: true })`, and it is logged as a server fault. | A broken build is not the file's fault. The existing retryable path leaves the row `pending` for the hourly re-queue until `MAX_PARSE_ATTEMPTS` runs out, which leaves a window to deploy a fix without failing every upload for good. |
| Input transfer | The file is copied into its own `ArrayBuffer` and **transferred** (`transferList`) through `workerData`, not cloned. | A Buffer from `fs.readFile` may share a larger backing store, and transferring it would detach bytes that belong to someone else. One 20 MB memcpy costs milliseconds, and the transfer itself is free. |
| Output | The worker posts `{ ok: true, extracted }` or `{ ok: false, code, message }`. `extracted` is at most `TEXT_CAP` characters plus small `meta`, cloned back. | This is the same `Extracted` shape as today. Error names cross the boundary as strings, never file content. |
| Loading the worker in dev and tests | The worker URL is `new URL('./extract-worker.js', import.meta.url)`. When the calling module is `.ts` (tsx in dev, vitest in tests), it uses `./extract-worker.ts` with `execArgv: ['--import', 'tsx']`. Production (`dist/*.js`) uses neither. | Vitest does not transform code inside a Worker. tsx is already a devDependency, and the probe below showed that it loads a `.ts` worker (with `.js` import specifiers) under vitest on node:22. Production needs nothing new: `tsc` already emits every file under `src/`. |
| Queue | **No change** to `queue.ts`. It already awaits `extract`, and the runner settles only after the worker has exited. | This keeps the change small, and the queue's tests keep guarding attempts and deferral. |
| `withTimeout` | Removed from `extract.ts`, together with its test. The runner owns the only parse timeout. | After the move it would only wrap the synchronous text decode, where a timeout means nothing. |
| Shutdown | Nothing added. `index.ts` calls `process.exit` after `fastify.close()`, which kills a running worker. The attempt was already counted, so the next boot re-queues the row, exactly as today. | This matches today's crash and deploy semantics. |

Probe (throwaway, scratchpad, 2026-09-26, node:22 + vitest 3.2.7 + tsx 4.23): a `.ts` worker that
imports a `.ts` helper started in ~180 ms; `terminate()` stopped a busy loop; filling the heap under
`maxOldGenerationSizeMb: 64` raised an `error` event with `code: 'ERR_WORKER_OUT_OF_MEMORY'` while the
parent kept running; a later worker then ran normally.

## 4. Design

### 4.1 Units

All units live in `apps/server/src/chat/attachments/`:

- **`parsers.ts`** (new, moved from `extract.ts`): `parseDocument(kind: 'pdf' | 'docx' | 'xlsx',
  file: Buffer, zipBudget: number): Promise<Extracted>`, plus the private `fromPdf`, `fromDocx`,
  `fromXlsx`, `guardZip`, `cellText`, `escapeCell` and `capText`. It holds the constants that the
  parsers use (`TEXT_CAP`, `XLSX_MAX_ROWS`, `XLSX_MAX_COLS`, `ZIP_EXPANDED_MAX_BYTES`), and `extract.ts`
  re-exports them so importers do not change. `ExtractError` moves to a small `errors.ts`, so the
  worker never imports the whisper and fetch code. This module is plain code that knows nothing about
  threads, so it can be unit-tested in-thread (spies on exceljs work here).
- **`extract-worker.ts`** (new): the worker entry. It posts `{ type: 'ready' }` once its imports have
  loaded, reads `workerData = { kind, file: Uint8Array, zipBudget }`, calls `parseDocument`, and posts
  one result message. An `ExtractError` maps to its code; any other throw maps to `ATTACHMENT_INVALID`
  with the error's `name` (never its message, which could quote the file). Nothing is logged in the
  worker.
- **`worker-runner.ts`** (new): `runInWorker(job, opts): Promise<Extracted>`, where
  `opts = { timeoutMs, heapMb, workerUrl }` (`--import tsx` is added when the URL ends in `.ts`). It spawns the worker, arms the timeout, maps
  the events (§4.2), always awaits `terminate()` before settling, and settles exactly once. It also
  exports `defaultWorker()`, which picks the `.ts` or `.js` entry and its `execArgv` (§3). It never
  logs content, and the caller logs metadata.
- **`extract.ts`** (slimmer): `extract()` keeps its signature. `pdf`, `docx` and `xlsx` go through
  `runInWorker`, while `image`, `text` and whisper stay as they are. `ExtractDeps` gains two optional
  fields for tests only: `workerUrl?: URL` and `heapMb?: number`.

### 4.2 Event mapping in the runner

| Event | Result |
|---|---|
| `message {ok: true}` | resolve `extracted` |
| `message {ok: false, code}` | reject `ExtractError(code)` |
| `error` with `code === 'ERR_WORKER_OUT_OF_MEMORY'` | reject `ExtractError('ATTACHMENT_INVALID', 'extraction out of memory')` |
| `error` before `ready` | reject `ExtractError('ATTACHMENT_INVALID', 'extraction worker failed to start', { retryable: true })` |
| any other `error` (an uncaught throw in the worker) | reject `ExtractError('ATTACHMENT_INVALID', err.name)` |
| `exit` without a result | reject `ExtractError('ATTACHMENT_INVALID', 'extraction worker exited')` |
| timeout | `await terminate()`, then reject `ExtractError('ATTACHMENT_INVALID', 'extraction timed out')` |

The first event settles the job, and later events are ignored. In every case the timer is cleared
and the worker is terminated (a no-op if it already exited) before the promise settles.

### 4.3 Data flow

```
queue.runOne ─ markAttempt ─ store.read(file) ─ extract(kind, file)
                                                  │ pdf/docx/xlsx
                                                  ▼
                               runInWorker ── copy → transfer ──▶ Worker(heap 512 MB)
                                   │  timer 60 s                  guardZip → parser
                                   │◀──────── {ok, extracted | code} ──┘
                                   └ terminate() → settle → queue setExtracted / setFailed
```

### 4.4 Spec §5.4 of the attachments design

Update `2026-09-26-chat-redesign-attachments-design.md` §5.4 so it states that pdf, docx and xlsx run
in a worker thread with a 512 MB heap and a timeout that terminates the worker. Everything else in
that section stays true.

## 5. Error handling and logging

- Error codes are unchanged. The only new failure reasons are internal messages (`out of memory`,
  `timed out`, `worker exited`, `failed to start`), which never reach a client: the client sees
  `ATTACHMENT_INVALID`.
- No new log call. The queue already logs `attachment extraction finished` with the id, kind, bytes,
  attempt, ms, status and code. A start failure shows up as `attachment extraction deferred` for a
  `pdf`, `docx` or `xlsx` row. No other failure is retryable for those kinds, so that line is the
  signal of a broken worker entry.
- Nothing inside the worker logs. Terminal and file content are never logged (project rule).

## 6. Testing

Vitest in `@termhub/server`. The worker tests run the real Worker through tsx.

- **`parsers.test.ts`** (in-thread): the pdf, docx and xlsx tests from `extract.test.ts` that use
  `vi.spyOn` on exceljs (the streaming reader, never a whole-workbook load, and the unlisted local
  entry refused before `parse`). Spies do not cross threads, so these tests must call
  `parseDocument` directly.
- **`extract.test.ts`**: every other pdf, docx and xlsx case stays, and it now exercises the real
  worker round trip. That covers identical output, ZIP bombs, lying directories, data descriptors,
  caps, and `ATTACHMENT_INVALID` for garbage. The `withTimeout` test goes away.
- **`worker-runner.test.ts`**, with fixture workers under `apps/server/test/workers/` that follow the
  same message protocol:
  - `spin.ts` (an endless loop): the runner rejects with `ATTACHMENT_INVALID` shortly after
    `timeoutMs` (about a second in the test, so the tsx start-up fits inside it), and the worker has exited, checked with `threadId` or an `exit`
    spy;
  - **the event loop stays responsive** while `spin.ts` runs: a main-thread `setInterval(…, 10)` keeps
    ticking, with a maximum gap well below the spin time;
  - `hog.ts` (fills the heap, `heapMb: 32`): rejects with `ATTACHMENT_INVALID` (out of memory), and
    the test process survives;
  - `throw.ts`, which throws a `TypeError` after `ready`: rejects with `ATTACHMENT_INVALID` and the
    error name only;
  - a missing worker file: rejects with a **retryable** `ATTACHMENT_INVALID`;
  - `exit.ts`, which calls `process.exit(0)` without posting: rejects with `ATTACHMENT_INVALID`;
  - after a timeout or out-of-memory failure, a normal job through the real `extract-worker.ts`
    still succeeds.
- **`queue.test.ts`**, integration with the real `extract` and a fixture `workerUrl`: a job that
  times out fails its row as `ATTACHMENT_INVALID`, and **the next queued job runs and extracts**. A
  job whose worker fails to start stays `pending` on attempt 1, then fails on attempt 2.
- **Production entry check** (plan, verification task): `npm run build -w @termhub/server`, then a
  node one-liner that imports `dist/chat/attachments/extract.js` and extracts a minimal docx and pdf
  through the compiled `.js` worker without tsx. The Docker image copies `apps/server/dist` whole, so
  the worker file ships.

## 7. Rollout

- No migration and no API or contract change, so it is backward compatible for blue/green by
  construction.
- No new dependency. `tsx` is already a devDependency, and production does not use it.
- No agent release.

## 8. Risks

- **External memory is not capped by `maxOldGenerationSizeMb`.** ArrayBuffers and Buffers (JSZip's
  inflated entries, zlib output) live outside the V8 heap. They are bounded by the 20 MB upload, the
  200 MB inflate guard (which runs first) and `TEXT_CAP`, so the worst case is several hundred MB on
  top of the heap, for at most 60 s. That is accepted, with the guard as the real bound.
- **The worker still uses a CPU core** for up to 60 s on a host shared with production. The change
  moves the cost off the event loop; it does not reduce it. Throttling it (a child process with
  `nice`, or a cgroup) is out of scope.
- **Loading the worker differs by environment** (`.ts` with tsx in dev and tests, `.js` in
  production). A path mistake would only show up in production, as start failures. It is mitigated by
  the dist check in §6 and by the retryable start failure (§3), which keeps rows pending instead of
  failing them.
- **Start-up cost per file** (~100–300 ms to load unpdf, mammoth and exceljs in a fresh isolate). It
  is invisible next to a parse and irrelevant with one job at a time.
- **The queue's `markAttempt` semantics now rarely matter** for pdf, docx and xlsx: a poison file can
  no longer crash the process. The cap stays as defence in depth and for deploys that land mid-parse.
