# MCP Terminals Implementation Plan (global terminal, PR 4 of 5)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Claude Code session holding a termhub API token with the `terminals` scope can open a terminal tab, type into it, press a key, run a command and read what came back, and close the tabs it opened — on agent, local and ssh machines alike, through `https://termhub.dev/mcp`.

**Architecture:** Three new named agent RPCs (`tmux.ensure`, `tmux.sendText`, `tmux.sendKey`) join `packages/agent-protocol`; the agent runs them as fixed `tmux` argv, never shell text. A new server module `terminal/session-ops.ts` exposes the same three operations over all machine types (agent → `agentRpc`, local/ssh → `runOnMachine` + `shellQuote`), and `monitor/send-keys.ts` is reimplemented on top of it, which also removes the 409 that blocks typing into agent machines from the web monitor today. A new `control/terminals.ts` holds the five write operations as plain `(ctx, input)` functions over the owner scope, and `mcp/tools.ts` exposes them as tools gated by scope `terminals` ∩ the user's `terminals:write` grant.

**Tech Stack:** TypeScript (ESM, NodeNext), Fastify 5, Prisma 6, zod 3.25, vitest 3, `@modelcontextprotocol/sdk` 1.30, tmux on the machines.

**Spec:** `docs/superpowers/specs/2026-09-18-global-terminal-mcp-design.md` — §4.2 (scope `terminals`, minus `start_agent`), §4.3 (the three RPCs), §6 (errors), §7 (testing), §8 item 4.

**Deliberately out of scope, with the reason:**

- **`start_agent`** — spec §4.4, PR 5. It needs the `DETECT_TOOLS` additions and the launch table, and it is the one tool that types a command line built from a provider table.
- **The `tasks` scope tools** (spec §5.3: `list_tasks`, `create_task`, `add_subtasks`, `update_task`, `move_task`, `delete_task`) — they are a thin layer over the already-merged `TasksRepository` and share no code with this PR beyond `ControlContext`. They get their own short plan so this branch stays reviewable; spec §8 groups them with terminals only because both were "the next PR" when it was written.

## Global Constraints

- **Scope `terminals`** already exists in `API_TOKEN_SCOPES` (`apps/server/src/auth/api-tokens.ts:8`) and `ApiToken.scopes` is a Prisma `String[]` — **no migration is needed for the scope**. Effective permission stays **token scopes ∩ the user's `resource:action` grants**.
- All five tools use `resource: 'terminals'`, `action: 'write'`.
- **`send_input`: 4000-character cap** (`INPUT_MAX_CHARS`, already exported by `monitor/send-keys.ts`). Text longer than that is a tool error, never a truncation.
- **`send_key` accepts one key from a closed list**: `Enter`, `Escape`, `C-c`, `Up`, `Down`, `Tab`, `y`, `n`, `1`–`9`. Anything else is rejected by the schema.
- **Enter is always sent as a separate `send-keys` call after a ~300 ms pause**, never in the same burst as the text — TUIs like Claude Code treat a burst as a paste. This is existing behavior in `sendKeysToSession`; keep it.
- **A tab in `waiting_permission` refuses `send_input` unless `answering_permission: true`**, and the refusal quotes the pending question (`tab.state_text`).
- **Agent machines need agent ≥ `0.2.0`.** Every operation that calls one of the three new RPCs on an `agent` machine first calls `requireAgentVersion(machine, TERMINAL_RPC_MIN_AGENT_VERSION)`, which throws `HttpError(409, …, 'AGENT_OUTDATED')`. An offline agent passes that gate and fails later as `MACHINE_OFFLINE`.
- **`PROTOCOL_VERSION` stays 1** — the three RPCs are additive. `apps/agent/package.json` goes to **`0.2.0`** and is published by tagging `agent-v0.2.0` (see Task 8).
- **Never shell text to an agent.** The agent receives `tmux` argv only. Local/ssh keep going through `runOnMachine` with every user value passed through `shellQuote`.
- **Terminal content is never logged and never stored in `api_token_events`** — metadata only (tab id, machine id, sizes, duration, error code).
- **Tool names, schemas, code, comments and commits in English; every tool error message in pt-BR and actionable.**
- **Migrations stay backward compatible**: `tabs.created_by_token_id` is a nullable additive column, so the previous color keeps serving during the blue/green switch.
- This host has **no Node**: every command runs in Docker (see Setup). Server commands need `DATABASE_URL` set.

## Setup (once, before Task 1)

```bash
cd ~/termhub-wt-terminals
git fetch origin && git merge --ff-only origin/main
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -e npm_config_update_notifier=false -v "$PWD:/w" -w /w node:20 sh -c 'npm ci --no-audit --no-fund && npm run prisma:generate && npm run build:packages'; rm -rf .npm
```

Shorthand used by every step below (inline it; shell functions do not persist between tool calls):

```bash
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -e npm_config_update_notifier=false -e DATABASE_URL=postgresql://x:x@localhost:5432/x -v "$PWD:/w" -w /w node:20 sh -c '<cmd>'; rm -rf .npm
```

`<cmd>` for the agent's real-tmux test needs tmux inside the container; that one step uses the image `node:20` plus an apt install, spelled out in Task 2 Step 5.

## Review Focus

1. **`send_input` into a tab whose tmux session is gone** (killed on the machine, or never started because no browser ever attached). Expected: the session is created on the spot by `tmux.ensure` in the project's cwd, so the text lands in a live session instead of vanishing. → Task 4 and Task 6 tests.
2. **A tab sitting in `waiting_permission` receiving `send_input` without `answering_permission: true`.** Expected: a tool error that quotes the pending question and says to resend with `answering_permission: true`; nothing is typed. → Task 6 test.
3. **An agent machine running agent `0.1.6` (no new RPCs).** Expected: `AGENT_OUTDATED` with the "atualize o agente" message, audited under that code — not an 8 s timeout. → Task 4 test.
4. **`close_tab` on a tab the user opened in the browser** (`created_by_token_id` is null). Expected: refused unless `force: true`; with `force: true` the session is killed and the row removed. → Task 6 test.
5. **Text containing `'`, `;`, newlines and `$(…)` sent to an ssh machine.** Expected: typed literally into the session, never executed by the remote shell — `shellQuote` keeps it inert, and the newline goes in as a literal key, not as an Enter. → Task 3 test.

---

### Task 1: The three RPCs in the protocol package

**Files:**
- Modify: `packages/agent-protocol/src/rpc.ts`
- Test: `packages/agent-protocol/src/rpc.test.ts`

**Interfaces:**
- Consumes: `def(params, result, timeoutMs)`, `sessionName`, `machinePath` (all already in `rpc.ts`).
- Produces:
  - `TMUX_KEYS: readonly string[]` and `tmuxKey` (zod enum) exported from `@termhub/agent-protocol`.
  - `RPC['tmux.ensure']`: params `{ session, cwd }` → result `{ created: boolean }`.
  - `RPC['tmux.sendText']`: params `{ session, text, enter }` → result `{ sent: true }`.
  - `RPC['tmux.sendKey']`: params `{ session, key }` → result `{ sent: true }`.

- [ ] **Step 1: Write the failing test**

Append to `packages/agent-protocol/src/rpc.test.ts`:

```ts
describe('terminal RPCs', () => {
  it('tmux.ensure takes a session and an absolute or ~ cwd', () => {
    expect(RPC['tmux.ensure'].params.safeParse({ session: 'termhub-p1-t1', cwd: '/home/u/app' }).success).toBe(true);
    expect(RPC['tmux.ensure'].params.safeParse({ session: 'termhub-p1-t1', cwd: '~/app' }).success).toBe(true);
    expect(RPC['tmux.ensure'].params.safeParse({ session: 'termhub-p1-t1', cwd: 'app' }).success).toBe(false);
    expect(RPC['tmux.ensure'].params.safeParse({ session: 'bad name', cwd: '/tmp' }).success).toBe(false);
  });

  it('tmux.sendText caps the text at 4000 chars and keeps enter explicit', () => {
    expect(RPC['tmux.sendText'].params.safeParse({ session: 's', text: 'oi', enter: true }).success).toBe(true);
    expect(RPC['tmux.sendText'].params.safeParse({ session: 's', text: '', enter: true }).success).toBe(true);
    expect(RPC['tmux.sendText'].params.safeParse({ session: 's', text: 'x'.repeat(4001), enter: false }).success).toBe(false);
    expect(RPC['tmux.sendText'].params.safeParse({ session: 's', text: 'oi' }).success).toBe(false);
  });

  it('tmux.sendKey only accepts the closed key list', () => {
    for (const key of ['Enter', 'Escape', 'C-c', 'Up', 'Down', 'Tab', 'y', 'n', '1', '9']) {
      expect(RPC['tmux.sendKey'].params.safeParse({ session: 's', key }).success).toBe(true);
    }
    for (const key of ['C-d', 'q', '0', 'Left', '']) {
      expect(RPC['tmux.sendKey'].params.safeParse({ session: 's', key }).success).toBe(false);
    }
  });

  it('gives the terminal RPCs a 10 s budget (a machine that does not answer fails fast)', () => {
    expect(RPC['tmux.ensure'].timeoutMs).toBe(10_000);
    expect(RPC['tmux.sendText'].timeoutMs).toBe(10_000);
    expect(RPC['tmux.sendKey'].timeoutMs).toBe(10_000);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npm test -w @termhub/agent-protocol -- rpc.test.ts`
Expected: FAIL — `Cannot read properties of undefined (reading 'params')` for `RPC['tmux.ensure']`.

- [ ] **Step 3: Add the RPCs**

In `packages/agent-protocol/src/rpc.ts`, next to `aiProvider` (after line 8), add the key list:

```ts
/** The only keys a terminal tool may press (spec §4.2): no arbitrary key names reach tmux. */
export const TMUX_KEYS = ['Enter', 'Escape', 'C-c', 'Up', 'Down', 'Tab', 'y', 'n', '1', '2', '3', '4', '5', '6', '7', '8', '9'] as const;
export const tmuxKey = z.enum(TMUX_KEYS);
export type TmuxKey = (typeof TMUX_KEYS)[number];

export const TEXT_MAX_CHARS = 4000;
```

Then, inside the `RPC` object, right after `'tmux.capture'` (line 25):

```ts
  /** Idempotent: creates the detached session in `cwd` when it is missing. `created` says whether it had to. */
  'tmux.ensure': def(z.object({ session: sessionName, cwd: machinePath }), z.object({ created: z.boolean() }), 10_000),
  /** Types `text` literally, then (with `enter`) presses Enter on its own after a short pause. */
  'tmux.sendText': def(z.object({ session: sessionName, text: z.string().max(TEXT_MAX_CHARS), enter: z.boolean() }), z.object({ sent: z.literal(true) }), 10_000),
  'tmux.sendKey': def(z.object({ session: sessionName, key: tmuxKey }), z.object({ sent: z.literal(true) }), 10_000),
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `npm test -w @termhub/agent-protocol`
Expected: PASS, including the pre-existing per-method timeout test.

- [ ] **Step 5: Commit**

```bash
git add packages/agent-protocol/src/rpc.ts packages/agent-protocol/src/rpc.test.ts
git commit -m "Agent protocol: add tmux.ensure, tmux.sendText and tmux.sendKey"
```

---

### Task 2: The agent handlers

**Files:**
- Modify: `apps/agent/src/rpc/tmux.ts`
- Modify: `apps/agent/src/rpc/index.ts`
- Modify: `apps/agent/package.json` (version → `0.2.0`)
- Test: `apps/agent/src/rpc/tmux.test.ts` (argv), `apps/agent/src/rpc/tmux.real.test.ts` (real tmux)

**Interfaces:**
- Consumes: `run(file, args, opts)`, `tmuxPath()`, `RpcFailure` from `apps/agent/src/exec.js`; `RpcParams`/`RpcResult` from Task 1.
- Produces: `ensure(params)`, `sendText(params)`, `sendKey(params)` in `apps/agent/src/rpc/tmux.ts`, registered in the `handlers` map.

**Why the target strings differ:** `kill-session` takes a *target-session*, so `-t =name` resolves. `capture-pane` and `send-keys` take a *target-pane*, and with no client attached tmux only resolves an exact (`=`) target-pane when it is colon-qualified — hence `=name:` (this is already why `capture` uses the colon; the comment is in the file).

- [ ] **Step 1: Write the failing argv test**

Append to `apps/agent/src/rpc/tmux.test.ts`:

```ts
describe('ensure', () => {
  it('does nothing when the session is already there', async () => {
    run.mockResolvedValueOnce({ code: 0, stdout: '', stderr: '', timedOut: false });
    await expect(ensure({ session: 's1', cwd: '/home/u/app' })).resolves.toEqual({ created: false });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith('tmux', ['has-session', '-t', '=s1']);
  });

  it('creates a detached session in cwd when it is missing', async () => {
    run.mockResolvedValueOnce({ code: 1, stdout: '', stderr: "can't find session", timedOut: false });
    run.mockResolvedValueOnce({ code: 0, stdout: '', stderr: '', timedOut: false });
    await expect(ensure({ session: 's1', cwd: '/home/u/app' })).resolves.toEqual({ created: true });
    expect(run).toHaveBeenLastCalledWith('tmux', ['new-session', '-d', '-s', 's1', '-c', '/home/u/app']);
  });

  it('says the directory is the problem when tmux cannot start there', async () => {
    run.mockResolvedValueOnce({ code: 1, stdout: '', stderr: '', timedOut: false });
    run.mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'no such file or directory\n', timedOut: false });
    await expect(ensure({ session: 's1', cwd: '/gone' })).rejects.toMatchObject({ code: 'failed', message: expect.stringContaining('no such file') });
  });
});

describe('sendText', () => {
  it('types the text literally and sends Enter separately', async () => {
    run.mockResolvedValue({ code: 0, stdout: '', stderr: '', timedOut: false });
    await expect(sendText({ session: 's1', text: 'echo oi', enter: true })).resolves.toEqual({ sent: true });
    expect(run.mock.calls.map((c) => c[1])).toEqual([
      ['send-keys', '-t', '=s1:', '-l', '--', 'echo oi'],
      ['send-keys', '-t', '=s1:', 'Enter'],
    ]);
  });

  it('sends only Enter when the text is empty', async () => {
    run.mockResolvedValue({ code: 0, stdout: '', stderr: '', timedOut: false });
    await sendText({ session: 's1', text: '', enter: true });
    expect(run.mock.calls.map((c) => c[1])).toEqual([['send-keys', '-t', '=s1:', 'Enter']]);
  });

  it('reports a missing session instead of pretending it typed', async () => {
    run.mockResolvedValueOnce({ code: 1, stdout: '', stderr: "can't find pane", timedOut: false });
    await expect(sendText({ session: 's1', text: 'oi', enter: false })).rejects.toMatchObject({ code: 'notfound' });
  });
});

describe('sendKey', () => {
  it('presses one key', async () => {
    run.mockResolvedValue({ code: 0, stdout: '', stderr: '', timedOut: false });
    await expect(sendKey({ session: 's1', key: 'C-c' })).resolves.toEqual({ sent: true });
    expect(run).toHaveBeenCalledWith('tmux', ['send-keys', '-t', '=s1:', 'C-c']);
  });
});
```

Extend the existing import at the top of the file to `import { capture, ensure, kill, list, sendKey, sendText } from './tmux.js';`.

- [ ] **Step 2: Run it to make sure it fails**

Run: `npm test -w @termhub/agent -- tmux.test.ts`
Expected: FAIL — `ensure is not a function`.

- [ ] **Step 3: Implement the handlers**

Append to `apps/agent/src/rpc/tmux.ts` (keep `processFailure` as the first thing every handler checks):

```ts
/** Target-pane form: tmux only resolves an exact ('=') target-pane when it is colon-qualified (see capture). */
const pane = (session: string) => `=${session}:`;

/** The message tmux printed, first line, for an error meant for the user. */
const why = (stderr: string, fallback: string) => stderr.trim().split('\n')[0] || fallback;

export async function ensure(params: RpcParams<'tmux.ensure'>): Promise<RpcResult<'tmux.ensure'>> {
  const has = await run(tmuxPath(), ['has-session', '-t', `=${params.session}`]);
  const hasFailure = processFailure(has);
  if (hasFailure) throw hasFailure;
  if (has.code === 0) return { created: false };

  const made = await run(tmuxPath(), ['new-session', '-d', '-s', params.session, '-c', params.cwd]);
  const madeFailure = processFailure(made);
  if (madeFailure) throw madeFailure;
  // A bad cwd is the usual reason, and the user is the one who can fix it.
  if (made.code !== 0) throw new RpcFailure('failed', why(made.stderr, 'tmux new-session falhou'), params.cwd);
  return { created: true };
}

export async function sendText(params: RpcParams<'tmux.sendText'>): Promise<RpcResult<'tmux.sendText'>> {
  if (params.text) {
    const typed = await run(tmuxPath(), ['send-keys', '-t', pane(params.session), '-l', '--', params.text]);
    const failure = processFailure(typed);
    if (failure) throw failure;
    if (typed.code !== 0) throw new RpcFailure('notfound', why(typed.stderr, 'session not found'));
    // TUIs read a burst of bytes as a paste, so Enter has to arrive on its own.
    if (params.enter) await new Promise((r) => setTimeout(r, ENTER_PAUSE_MS));
  }
  if (params.enter) {
    const entered = await run(tmuxPath(), ['send-keys', '-t', pane(params.session), 'Enter']);
    const failure = processFailure(entered);
    if (failure) throw failure;
    if (entered.code !== 0) throw new RpcFailure('notfound', why(entered.stderr, 'session not found'));
  }
  return { sent: true };
}

export async function sendKey(params: RpcParams<'tmux.sendKey'>): Promise<RpcResult<'tmux.sendKey'>> {
  const r = await run(tmuxPath(), ['send-keys', '-t', pane(params.session), params.key]);
  const failure = processFailure(r);
  if (failure) throw failure;
  if (r.code !== 0) throw new RpcFailure('notfound', why(r.stderr, 'session not found'));
  return { sent: true };
}
```

At the top of the file, next to the imports, add the pause constant:

```ts
/** Pause between the typed text and the Enter that submits it (same value the server used before). */
export const ENTER_PAUSE_MS = 300;
```

Register them in `apps/agent/src/rpc/index.ts`, inside `handlers`, after `'tmux.capture': tmux.capture,`:

```ts
  'tmux.ensure': tmux.ensure,
  'tmux.sendText': tmux.sendText,
  'tmux.sendKey': tmux.sendKey,
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `npm test -w @termhub/agent`
Expected: PASS (the `handlers` map is exhaustive by type, so a missing entry would already be a typecheck error).

- [ ] **Step 5: Write the real-tmux test**

`apps/agent/src/rpc/tmux.real.test.ts` — runs against a **private tmux server** (`-L`), never the one the test host may be running:

```ts
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { capture, ensure, kill, sendKey, sendText } from './tmux.js';

const SOCKET = `termhub-test-${process.pid}`;
const SESSION = `termhub-real-${process.pid}`;

const hasTmux = (() => {
  try {
    execFileSync('tmux', ['-V'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

// TMUX_PATH is what exec.ts reads; the wrapper pins every call to our own socket.
const wrapper = mkdtempSync(join(tmpdir(), 'tmux-wrap-'));

describe.skipIf(!hasTmux)('tmux RPCs against a real tmux', () => {
  beforeAll(() => {
    const path = join(wrapper, 'tmux');
    execFileSync('sh', ['-c', `printf '#!/bin/sh\\nexec tmux -L %s "$@"\\n' ${SOCKET} > ${path} && chmod +x ${path}`]);
    process.env.TMUX_PATH = path;
  });

  afterAll(() => {
    try {
      execFileSync('tmux', ['-L', SOCKET, 'kill-server'], { stdio: 'ignore' });
    } catch {
      /* no server to kill */
    }
    rmSync(wrapper, { recursive: true, force: true });
    delete process.env.TMUX_PATH;
  });

  it('creates the session once, types into it and reads it back', async () => {
    expect(await ensure({ session: SESSION, cwd: tmpdir() })).toEqual({ created: true });
    expect(await ensure({ session: SESSION, cwd: tmpdir() })).toEqual({ created: false });

    await sendText({ session: SESSION, text: 'echo termhub-ok', enter: true });
    await new Promise((r) => setTimeout(r, 800));
    const { text } = await capture({ session: SESSION, lines: 50 });
    expect(text).toContain('termhub-ok');

    await sendKey({ session: SESSION, key: 'C-c' });
    expect(await kill({ session: SESSION })).toEqual({ killed: true });
  });

  it('refuses to type into a session that is not there', async () => {
    await expect(sendText({ session: `${SESSION}-gone`, text: 'x', enter: false })).rejects.toMatchObject({ code: 'notfound' });
  });
});
```

- [ ] **Step 6: Run the real-tmux test**

```bash
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -e npm_config_update_notifier=false -v "$PWD:/w" -w /w node:20 \
  sh -c 'apt-get update -qq && apt-get install -y -qq tmux >/dev/null && npm test -w @termhub/agent -- tmux.real.test.ts'; rm -rf .npm
```

Expected: PASS, 2 tests. Without tmux (CI image without it) the suite reports them as skipped, not failed — that is what `describe.skipIf` is for.

- [ ] **Step 7: Bump the agent version**

In `apps/agent/package.json`, set `"version": "0.2.0"`.

- [ ] **Step 8: Commit**

```bash
git add apps/agent/src/rpc/tmux.ts apps/agent/src/rpc/tmux.test.ts apps/agent/src/rpc/tmux.real.test.ts apps/agent/src/rpc/index.ts apps/agent/package.json
git commit -m "Agent: run tmux.ensure, tmux.sendText and tmux.sendKey (0.2.0)"
```

---

### Task 3: Server-side session operations for every machine type

**Files:**
- Create: `apps/server/src/terminal/session-ops.ts`
- Test: `apps/server/src/terminal/session-ops.test.ts`
- Modify: `apps/server/src/monitor/send-keys.ts` (reimplement on top)
- Modify: `apps/server/src/routes/tabs.ts:75-76` (drop the agent 409)

**Interfaces:**
- Consumes: `agentRpc`, `requireAgentVersion` (`apps/server/src/agent/errors.js`); `runOnMachine`, `shellQuote`, `assertSessionName`, `REMOTE_PATH_PREFIX` (`apps/server/src/terminal/machine-exec.js`); `TMUX_KEYS`, `TmuxKey` (`@termhub/agent-protocol`).
- Produces:
  - `TERMINAL_RPC_MIN_AGENT_VERSION = '0.2.0'`
  - `ensureSession(machine, session, cwd): Promise<{ created: boolean }>`
  - `sendTextToSession(machine, session, text, enter): Promise<void>`
  - `sendKeyToSession(machine, session, key: TmuxKey): Promise<void>`
  - each throws `HttpError` on failure (`AGENT_OUTDATED`, or whatever `toHttpError` produced).

- [ ] **Step 1: Write the failing test**

`apps/server/src/terminal/session-ops.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Machine } from '../db/repositories/types.js';
import { HttpError } from '../lib/errors.js';

const { agentRpc, requireAgentVersion, runOnMachine } = vi.hoisted(() => ({
  agentRpc: vi.fn(),
  requireAgentVersion: vi.fn(),
  runOnMachine: vi.fn(),
}));
vi.mock('../agent/errors.js', () => ({ agentRpc, requireAgentVersion }));
vi.mock('./machine-exec.js', async (orig) => ({ ...(await orig<typeof import('./machine-exec.js')>()), runOnMachine }));

const { ensureSession, sendKeyToSession, sendTextToSession, TERMINAL_RPC_MIN_AGENT_VERSION } = await import('./session-ops.js');

const machine = (type: Machine['type']): Machine => ({ id: 'm1', name: 'jarvis', type, os: 'linux', capabilities: ['tmux'], owner_id: 'u1' }) as Machine;

beforeEach(() => vi.clearAllMocks());

describe('agent machines', () => {
  it('checks the agent version before every operation and calls the named RPC', async () => {
    agentRpc.mockResolvedValue({ created: true });
    await ensureSession(machine('agent'), 's1', '/home/u/app');
    expect(requireAgentVersion).toHaveBeenCalledWith(expect.objectContaining({ id: 'm1' }), TERMINAL_RPC_MIN_AGENT_VERSION);
    expect(agentRpc).toHaveBeenCalledWith(expect.objectContaining({ id: 'm1' }), 'tmux.ensure', { session: 's1', cwd: '/home/u/app' });
    expect(runOnMachine).not.toHaveBeenCalled();
  });

  it('lets an outdated agent fail before anything is typed', async () => {
    requireAgentVersion.mockImplementation(() => {
      throw new HttpError(409, 'Atualize o agente desta máquina', 'AGENT_OUTDATED');
    });
    await expect(sendTextToSession(machine('agent'), 's1', 'oi', true)).rejects.toMatchObject({ code: 'AGENT_OUTDATED' });
    expect(agentRpc).not.toHaveBeenCalled();
  });

  it('sends text and key through their own RPCs', async () => {
    agentRpc.mockResolvedValue({ sent: true });
    await sendTextToSession(machine('agent'), 's1', 'echo oi', true);
    expect(agentRpc).toHaveBeenCalledWith(expect.anything(), 'tmux.sendText', { session: 's1', text: 'echo oi', enter: true });
    await sendKeyToSession(machine('agent'), 's1', 'C-c');
    expect(agentRpc).toHaveBeenCalledWith(expect.anything(), 'tmux.sendKey', { session: 's1', key: 'C-c' });
  });
});

describe('local and ssh machines', () => {
  it('quotes every value it puts in the remote command', async () => {
    runOnMachine.mockResolvedValue({ code: 0, stdout: '', stderr: '', timedOut: false });
    await sendTextToSession(machine('ssh'), 's1', "rm -rf /; echo '$(whoami)'\n", false);
    const remote = runOnMachine.mock.calls[0][2] as string;
    expect(remote).toContain(`'rm -rf /; echo '\\''$(whoami)'\\''`);
    expect(remote.startsWith('export PATH=')).toBe(true);
    // the local argv form gets the same script, unquoted by any shell of ours
    expect(runOnMachine.mock.calls[0][1]).toMatchObject({ file: 'sh', args: ['-c', expect.stringContaining('send-keys')] });
  });

  it('creates the session with has-session || new-session', async () => {
    runOnMachine.mockResolvedValue({ code: 0, stdout: 'created\n', stderr: '', timedOut: false });
    await expect(ensureSession(machine('local'), 's1', '/home/u/app')).resolves.toEqual({ created: true });
    const remote = runOnMachine.mock.calls[0][2] as string;
    expect(remote).toContain("tmux has-session -t '=s1'");
    expect(remote).toContain("tmux new-session -d -s 's1' -c '/home/u/app'");
  });

  it('turns a non-zero exit into an HttpError the user can act on', async () => {
    runOnMachine.mockResolvedValue({ code: 1, stdout: '', stderr: 'no such file or directory\n', timedOut: false });
    await expect(ensureSession(machine('ssh'), 's1', '/gone')).rejects.toMatchObject({ statusCode: 502, message: expect.stringContaining('no such file') });
  });

  it('says the machine did not answer on a timeout', async () => {
    runOnMachine.mockResolvedValue({ code: null, stdout: '', stderr: '', timedOut: true });
    await expect(sendKeyToSession(machine('ssh'), 's1', 'Enter')).rejects.toMatchObject({ code: 'MACHINE_TIMEOUT', message: 'A máquina não respondeu' });
  });

  it('rejects a session name that is not ours before touching the machine', async () => {
    await expect(sendKeyToSession(machine('ssh'), 'bad name', 'Enter')).rejects.toBeInstanceOf(Error);
    expect(runOnMachine).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npm test -w @termhub/server -- session-ops.test.ts`
Expected: FAIL — `Cannot find module './session-ops.js'`.

- [ ] **Step 3: Implement**

`apps/server/src/terminal/session-ops.ts`:

```ts
import { type TmuxKey } from '@termhub/agent-protocol';
import { agentRpc, requireAgentVersion } from '../agent/errors.js';
import type { Machine } from '../db/repositories/types.js';
import { HttpError } from '../lib/errors.js';
import { REMOTE_PATH_PREFIX, assertSessionName, runOnMachine, shellQuote } from './machine-exec.js';

/** The agent release that answers tmux.ensure / tmux.sendText / tmux.sendKey (spec §4.3). */
export const TERMINAL_RPC_MIN_AGENT_VERSION = '0.2.0';

/** Pause between the typed text and the Enter that submits it: TUIs read a burst of bytes as a paste. */
const ENTER_PAUSE = '0.3';
const TIMEOUT_MS = 10_000;

/** Runs one tmux script on a local/ssh machine; the agent branch never reaches here. */
async function shell(machine: Machine, script: string): Promise<string> {
  const r = await runOnMachine(machine, { file: 'sh', args: ['-c', script] }, `${REMOTE_PATH_PREFIX}${script}`, TIMEOUT_MS);
  if (r.timedOut) throw new HttpError(504, 'A máquina não respondeu', 'MACHINE_TIMEOUT');
  if (r.code !== 0) throw new HttpError(502, r.stderr.trim().split('\n')[0] || 'Falha ao falar com o tmux da máquina', 'MACHINE_FAILED');
  return r.stdout;
}

/** Makes sure the tab's tmux session exists, detached, in the project's directory. Idempotent. */
export async function ensureSession(machine: Machine, session: string, cwd: string): Promise<{ created: boolean }> {
  assertSessionName(session);
  if (machine.type === 'agent') {
    requireAgentVersion(machine, TERMINAL_RPC_MIN_AGENT_VERSION);
    return agentRpc(machine, 'tmux.ensure', { session, cwd });
  }
  const name = shellQuote(session);
  const out = await shell(
    machine,
    `tmux has-session -t ${shellQuote(`=${session}`)} 2>/dev/null || { tmux new-session -d -s ${name} -c ${shellQuote(cwd)} && echo created; }`,
  );
  return { created: out.includes('created') };
}

/** Types `text` literally into the session and, with `enter`, presses Enter on its own afterwards. */
export async function sendTextToSession(machine: Machine, session: string, text: string, enter: boolean): Promise<void> {
  assertSessionName(session);
  if (machine.type === 'agent') {
    requireAgentVersion(machine, TERMINAL_RPC_MIN_AGENT_VERSION);
    await agentRpc(machine, 'tmux.sendText', { session, text, enter });
    return;
  }
  const target = shellQuote(`=${session}:`);
  const parts: string[] = [];
  if (text) parts.push(`tmux send-keys -t ${target} -l -- ${shellQuote(text)}`);
  if (enter) {
    if (text) parts.push(`sleep ${ENTER_PAUSE}`);
    parts.push(`tmux send-keys -t ${target} Enter`);
  }
  if (parts.length === 0) return;
  await shell(machine, parts.join(' && '));
}

/** Presses one key from the closed list (spec §4.2) in the session. */
export async function sendKeyToSession(machine: Machine, session: string, key: TmuxKey): Promise<void> {
  assertSessionName(session);
  if (machine.type === 'agent') {
    requireAgentVersion(machine, TERMINAL_RPC_MIN_AGENT_VERSION);
    await agentRpc(machine, 'tmux.sendKey', { session, key });
    return;
  }
  // `key` comes from TMUX_KEYS, so it is already a fixed token; quoting it keeps the rule "quote everything".
  await shell(machine, `tmux send-keys -t ${shellQuote(`=${session}:`)} ${shellQuote(key)}`);
}
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `npm test -w @termhub/server -- session-ops.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Reimplement `sendKeysToSession` on top of it**

Replace the body of `apps/server/src/monitor/send-keys.ts` (keep the exported name and shape — the monitor route depends on both):

```ts
import type { Machine } from '../db/repositories/types.js';
import { sendTextToSession } from '../terminal/session-ops.js';

export const INPUT_MAX_CHARS = 4000;

/**
 * Types `text` into the tab's tmux session (literal keys) and, with `enter`, presses Enter after a
 * short pause. Works on agent machines too (named RPCs) as well as local/ssh, with or without a
 * terminal attached in the browser.
 */
export async function sendKeysToSession(machine: Machine, session: string, text: string, enter: boolean): Promise<{ ok: boolean; error: string | null }> {
  if (text.length > INPUT_MAX_CHARS) throw new Error('Texto longo demais');
  try {
    await sendTextToSession(machine, session, text, enter);
    return { ok: true, error: null };
  } catch (e) {
    // The monitor route reports the failure in the response body instead of a 5xx; keep that contract.
    return { ok: false, error: e instanceof Error ? e.message : 'tmux send-keys falhou' };
  }
}
```

- [ ] **Step 6: Let agent machines use the monitor's input route**

In `apps/server/src/routes/tabs.ts`, delete the two lines at `:75-76`:

```ts
    // sendKeysToSession runs shell on the machine; agents only answer named RPCs and have none for this yet
    if (machine.type === 'agent') throw conflict('Envio de texto pelo monitor ainda não disponível em máquinas com agente');
```

Drop `conflict` from the import on line 7 if nothing else in the file uses it (check with `grep -n 'conflict' apps/server/src/routes/tabs.ts`).

- [ ] **Step 7: Run the affected suites**

Run: `npm test -w @termhub/server -- session-ops.test.ts send-keys tabs`
Expected: PASS. Any existing test asserting the 409 for agent machines must be rewritten to assert the text now goes through (it is the behavior change this step ships).

- [ ] **Step 8: Commit**

```bash
git add apps/server/src/terminal/session-ops.ts apps/server/src/terminal/session-ops.test.ts apps/server/src/monitor/send-keys.ts apps/server/src/routes/tabs.ts apps/server/src/routes/tabs.test.ts
git commit -m "Terminal: one session-ops layer for agent, local and ssh machines"
```

---

### Task 4: Stable error codes for the agent path

**Files:**
- Modify: `apps/server/src/agent/errors.ts:11-33` (`toHttpError`)
- Test: `apps/server/src/agent/errors.test.ts`

This is follow-up 3 of PR #63: `api_token_events.error_code` currently records `'ERROR'` for everything that comes out of `toHttpError`, because the `HttpError`s it builds carry no `code`.

**Interfaces:**
- Produces: every `HttpError` from `toHttpError` carries a code — `AGENT_OFFLINE` (503), `AGENT_TIMEOUT` (504), `MACHINE_EPERM` (403), `MACHINE_NOT_FOUND` (404), `NO_TMUX` (502), `MACHINE_INVALID` (400), `MACHINE_FAILED` (502).

- [ ] **Step 1: Write the failing test**

Append to `apps/server/src/agent/errors.test.ts`:

```ts
describe('toHttpError codes', () => {
  it('gives every agent failure a code the audit can be read by', () => {
    expect(toHttpError(new AgentOfflineError('x'))).toMatchObject({ statusCode: 503, code: 'AGENT_OFFLINE' });
    expect(toHttpError(new AgentTimeoutError('x'))).toMatchObject({ statusCode: 504, code: 'AGENT_TIMEOUT' });
    expect(toHttpError(new AgentRpcError({ code: 'eperm', message: 'x' }))).toMatchObject({ statusCode: 403, code: 'MACHINE_EPERM' });
    expect(toHttpError(new AgentRpcError({ code: 'notfound', message: 'x' }))).toMatchObject({ statusCode: 404, code: 'MACHINE_NOT_FOUND' });
    expect(toHttpError(new AgentRpcError({ code: 'no_tmux', message: 'x' }))).toMatchObject({ statusCode: 502, code: 'NO_TMUX' });
    expect(toHttpError(new AgentRpcError({ code: 'invalid', message: 'x' }))).toMatchObject({ statusCode: 400, code: 'MACHINE_INVALID' });
    expect(toHttpError(new AgentRpcError({ code: 'failed', message: 'pasta não existe' }))).toMatchObject({ statusCode: 502, code: 'MACHINE_FAILED', message: 'pasta não existe' });
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npm test -w @termhub/server -- agent/errors.test.ts`
Expected: FAIL — `code` is `undefined`.

- [ ] **Step 3: Add the codes**

In `apps/server/src/agent/errors.ts`, pass a third argument to every `new HttpError(...)` inside `toHttpError`, keeping the existing statuses and messages exactly as they are: `'AGENT_OFFLINE'`, `'AGENT_TIMEOUT'`, `'MACHINE_EPERM'`, `'MACHINE_NOT_FOUND'`, `'NO_TMUX'`, `'MACHINE_INVALID'`, `'MACHINE_FAILED'` and, for the `default:` branch, `'MACHINE_FAILED'`.

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `npm test -w @termhub/server -- agent`
Expected: PASS. `control/screen.test.ts` also passes: `readScreen` maps 503 to its own `MACHINE_OFFLINE` before the code is read.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/agent/errors.ts apps/server/src/agent/errors.test.ts
git commit -m "Agent: give every machine failure a stable error code"
```

---

### Task 5: The token on the control context, and who opened a tab

**Files:**
- Modify: `apps/server/prisma/schema.prisma` (`Tab.createdByTokenId`)
- Create: `apps/server/prisma/migrations/<timestamp>_tab_created_by_token/migration.sql`
- Modify: `apps/server/src/db/repositories/types.ts` (`Tab.created_by_token_id`)
- Modify: `apps/server/src/db/repositories/tabs.ts` (`create` option, `countOpenByToken`)
- Modify: `apps/server/src/control/context.ts` (`ControlContext.token`)
- Modify: `apps/server/src/mcp/route.ts:57` (pass the token)
- Test: `apps/server/src/db/repositories/tabs.test.ts`

This is follow-up 4 of PR #63 plus the column spec §4.2 asks for.

**Interfaces:**
- Produces:
  - `Tab.created_by_token_id: string | null`
  - `repos.tabs.create(projectId, name, opts: { kind?, simulator_udid?, created_by_token_id?: string | null })`
  - `repos.tabs.countOpenByToken(tokenId: string): Promise<number>`
  - `ControlContext.token?: { id: string; scopes: readonly ApiTokenScope[] }`
  - `controlContextFor(repos, user, token?)`

- [ ] **Step 1: Write the failing test**

Append to `apps/server/src/db/repositories/tabs.test.ts`:

```ts
it('records which token opened a tab and counts the ones still open', async () => {
  const a = await repos.tabs.create(project.id, 'T1', { created_by_token_id: 'tok1' });
  await repos.tabs.create(project.id, 'T2', { created_by_token_id: 'tok1' });
  await repos.tabs.create(project.id, 'T3');

  expect(a.created_by_token_id).toBe('tok1');
  expect(await repos.tabs.countOpenByToken('tok1')).toBe(2);
  expect(await repos.tabs.countOpenByToken('tok2')).toBe(0);

  await repos.tabs.delete(a.id);
  expect(await repos.tabs.countOpenByToken('tok1')).toBe(1);
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npm test -w @termhub/server -- tabs.test.ts`
Expected: FAIL — `countOpenByToken is not a function`.

- [ ] **Step 3: Migrate the schema**

In `apps/server/prisma/schema.prisma`, `model Tab`, next to the other optional columns:

```prisma
  /// API token that opened this tab through /mcp (null: opened in the browser). Used by close_tab and the per-token open-tab limit.
  createdByTokenId String?  @map("created_by_token_id")

  @@index([createdByTokenId])
```

Write the migration by hand (the DB is only reachable from the running container; CI checks the diff):

`apps/server/prisma/migrations/<timestamp>_tab_created_by_token/migration.sql`

```sql
-- Additive and nullable: the previous release keeps serving while this runs.
ALTER TABLE "tabs" ADD COLUMN "created_by_token_id" TEXT;
CREATE INDEX "tabs_created_by_token_id_idx" ON "tabs"("created_by_token_id");
```

Use a timestamp newer than the last migration directory (`ls apps/server/prisma/migrations | tail -1`).

- [ ] **Step 4: Implement the repository changes**

`apps/server/src/db/repositories/types.ts`, in `interface Tab`, after `simulator_udid`:

```ts
  created_by_token_id: string | null;
```

`apps/server/src/db/repositories/tabs.ts`: add the field to the row mapper next to `simulator_udid`, widen `create`'s options and add the count:

```ts
  async create(projectId: string, name: string, opts: { kind?: TabKind; simulator_udid?: string | null; created_by_token_id?: string | null } = {}): Promise<Tab> {
```

inside the `data` object of that create:

```ts
      createdByTokenId: opts.created_by_token_id ?? null,
```

and, next to `delete`:

```ts
  /** Tabs this token opened that still exist — the per-token open-tab limit (spec §4.2). */
  async countOpenByToken(tokenId: string): Promise<number> {
    return this.db.tab.count({ where: { createdByTokenId: tokenId } });
  }
```

- [ ] **Step 5: Put the token on the context**

`apps/server/src/control/context.ts`:

```ts
import type { ApiTokenScope } from '../auth/api-tokens.js';
```

add to `ControlContext`:

```ts
  /** The API token this request came in with, when it came through /mcp (absent for web sessions). */
  token?: { id: string; scopes: readonly ApiTokenScope[] };
```

and widen the factory:

```ts
export function controlContextFor(repos: Repositories, user: User, token?: { id: string; scopes: readonly ApiTokenScope[] }): ControlContext {
  const scope: Scope = { user, viewAs: { kind: 'self' }, ownerId: user.id, createAs: user.id };
  return { repos, scope, scoped: new Scoped(repos, scope), can: (resource, action) => canAccess(repos, user, resource, action), token };
}
```

In `apps/server/src/mcp/route.ts:57`, pass it:

```ts
    request.mcp = { token: auth.token, ctx: controlContextFor(repos, auth.user, { id: auth.token.id, scopes: auth.token.scopes }) };
```

- [ ] **Step 6: Run the tests and make sure they pass**

```bash
npm test -w @termhub/server -- tabs.test.ts mcp
npm run typecheck -w @termhub/server
```

Expected: PASS. Then confirm the migration matches the schema, the same check CI runs:

```bash
npx --prefix apps/server prisma migrate diff --from-migrations apps/server/prisma/migrations --to-schema-datamodel apps/server/prisma/schema.prisma --shadow-database-url "$SHADOW_DATABASE_URL" --exit-code
```

- [ ] **Step 7: Commit**

```bash
git add apps/server/prisma apps/server/src/db/repositories apps/server/src/control/context.ts apps/server/src/mcp/route.ts
git commit -m "Tabs: record which API token opened a tab"
```

---

### Task 6: The terminal control operations

**Files:**
- Create: `apps/server/src/control/terminals.ts`
- Test: `apps/server/src/control/terminals.test.ts`

**Interfaces:**
- Consumes: `ctx.scoped.project/tab`, `ctx.repos.tabs`, `ensureSession`/`sendTextToSession`/`sendKeyToSession` (Task 3), `captureScreen` (`agent/screen.js`), `killTmuxSession` (`terminal/machine-exec.js`), `waitForState` + `SCREEN_DEFAULT_LINES` (`control/screen.js`), `agents.isOnline`, `ControlError`.
- Produces:
  - `MAX_TABS_PER_TOKEN = 10`, `RUN_DEFAULT_SECONDS = 30`, `RUN_MAX_SECONDS = 90`
  - `openTab(ctx, { project_id, name? }): Promise<{ tab_id, name, project_id, tmux_session, created }>`
  - `sendInput(ctx, { tab_id, text, enter?, answering_permission? }): Promise<{ tab_id, sent: true }>`
  - `sendKey(ctx, { tab_id, key }): Promise<{ tab_id, key, sent: true }>`
  - `runCommand(ctx, { tab_id, command, timeout_seconds?, lines? }, signal?): Promise<{ tab_id, state, timed_out, lines, text }>`
  - `closeTab(ctx, { tab_id, force? }): Promise<{ tab_id, killed: boolean }>`

**Design decisions this task locks in:**

- **Every write first makes sure the session exists** (`ensureSession` with the project's `cwd`). A tab whose session was killed on the machine would otherwise swallow the text silently.
- **The machine must be online and new enough, checked before anything is written.** For `agent` machines, `agents.isOnline` fails as `MACHINE_OFFLINE` (spec §4.4: "Nothing is queued for offline machines") and `requireAgentVersion` fails as `AGENT_OUTDATED` — both **before** `open_tab` creates a row, so an outdated machine does not leave an empty tab behind. `session-ops.ts` repeats the version check for callers that do not come through here (the monitor's input route).
- **`run_command` settles like this:** send the command with Enter, then, if the tab has monitor state, `waitForState`; if it does not (no hooks on that machine), poll the screen every second and stop once two consecutive captures are identical. Either way it returns the screen and `timed_out`, never an error for a slow command.

- [ ] **Step 1: Write the failing test**

`apps/server/src/control/terminals.test.ts` (mock the machine boundary, drive the real operations):

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../lib/errors.js';

const { captureScreen, ensureSession, isOnline, killTmuxSession, requireAgentVersion, sendKeyToSession, sendTextToSession } = vi.hoisted(() => ({
  captureScreen: vi.fn(),
  ensureSession: vi.fn(),
  isOnline: vi.fn(() => true),
  killTmuxSession: vi.fn(),
  requireAgentVersion: vi.fn(),
  sendKeyToSession: vi.fn(),
  sendTextToSession: vi.fn(),
}));
vi.mock('../agent/screen.js', () => ({ captureScreen }));
vi.mock('../agent/registry.js', () => ({ agents: { isOnline } }));
vi.mock('../agent/errors.js', () => ({ requireAgentVersion }));
vi.mock('../terminal/session-ops.js', () => ({ ensureSession, sendKeyToSession, sendTextToSession, TERMINAL_RPC_MIN_AGENT_VERSION: '0.2.0' }));
vi.mock('../terminal/machine-exec.js', () => ({ killTmuxSession }));

const { closeTab, MAX_TABS_PER_TOKEN, openTab, runCommand, sendInput, sendKey } = await import('./terminals.js');

const machine = { id: 'm1', name: 'jarvis', type: 'agent', os: 'linux', capabilities: ['tmux'], owner_id: 'u1' };
const project = { id: 'p1', name: 'app', cwd: '/home/u/app', machine_id: 'm1', status: 'active' };
const tab = (over: Record<string, unknown> = {}) => ({ id: 't1', project_id: 'p1', name: 'Terminal 1', kind: 'terminal', tmux_session: 'termhub-p1-t1', state: null, state_text: null, state_at: null, created_by_token_id: 'tok1', ...over });

function ctxWith(over: Record<string, unknown> = {}) {
  const tabs = {
    create: vi.fn(async (_p, name) => tab({ name })),
    listByProject: vi.fn(async () => []),
    countOpenByToken: vi.fn(async () => 0),
    delete: vi.fn(async () => true),
    findById: vi.fn(async () => tab()),
    ...(over.tabs as object),
  };
  return {
    repos: { tabs },
    scope: { ownerId: 'u1', createAs: 'u1' },
    scoped: {
      project: vi.fn(async () => ({ project, machine })),
      tab: vi.fn(async () => ({ tab: (over.tab as object) ?? tab(), project, machine })),
    },
    can: vi.fn(async () => true),
    token: { id: 'tok1', scopes: ['terminals'] },
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  // clearAllMocks keeps implementations: a test that made requireAgentVersion throw would leak into the next one.
  requireAgentVersion.mockReset();
  isOnline.mockReturnValue(true);
  ensureSession.mockResolvedValue({ created: true });
});

describe('openTab', () => {
  it('creates the tab, starts its session in the project cwd and records the token', async () => {
    const ctx = ctxWith();
    const r = await openTab(ctx, { project_id: 'p1' });
    expect(ctx.repos.tabs.create).toHaveBeenCalledWith('p1', 'Terminal 1', { created_by_token_id: 'tok1' });
    expect(ensureSession).toHaveBeenCalledWith(machine, 'termhub-p1-t1', '/home/u/app');
    expect(r).toMatchObject({ tab_id: 't1', created: true });
  });

  it('stops at the per-token limit instead of filling the project with tabs', async () => {
    const ctx = ctxWith({ tabs: { countOpenByToken: vi.fn(async () => MAX_TABS_PER_TOKEN) } });
    await expect(openTab(ctx, { project_id: 'p1' })).rejects.toMatchObject({ code: 'TAB_LIMIT' });
    expect(ctx.repos.tabs.create).not.toHaveBeenCalled();
  });

  it('refuses when the machine is offline', async () => {
    isOnline.mockReturnValue(false);
    const ctx = ctxWith();
    await expect(openTab(ctx, { project_id: 'p1' })).rejects.toMatchObject({ code: 'MACHINE_OFFLINE' });
    expect(ctx.repos.tabs.create).not.toHaveBeenCalled();
  });

  it('refuses an outdated agent before creating a tab that could not be used', async () => {
    requireAgentVersion.mockImplementation(() => {
      throw new HttpError(409, 'Atualize o agente desta máquina', 'AGENT_OUTDATED');
    });
    const ctx = ctxWith();
    await expect(openTab(ctx, { project_id: 'p1' })).rejects.toMatchObject({ code: 'AGENT_OUTDATED' });
    expect(ctx.repos.tabs.create).not.toHaveBeenCalled();
  });
});

describe('sendInput', () => {
  it('makes sure the session is there before typing', async () => {
    await sendInput(ctxWith(), { tab_id: 't1', text: 'oi', enter: true });
    expect(ensureSession).toHaveBeenCalled();
    expect(sendTextToSession).toHaveBeenCalledWith(machine, 'termhub-p1-t1', 'oi', true);
  });

  it('refuses a pending permission unless the caller says it is answering it', async () => {
    const ctx = ctxWith({ tab: tab({ state: 'waiting_permission', state_text: 'Permitir escrever em src/app.ts?' }) });
    await expect(sendInput(ctx, { tab_id: 't1', text: 'sim' })).rejects.toMatchObject({ code: 'WAITING_PERMISSION', message: expect.stringContaining('Permitir escrever em src/app.ts?') });
    expect(sendTextToSession).not.toHaveBeenCalled();
    await expect(sendInput(ctx, { tab_id: 't1', text: 'sim', answering_permission: true })).resolves.toMatchObject({ sent: true });
  });

  it('refuses text over the cap instead of cutting it', async () => {
    await expect(sendInput(ctxWith(), { tab_id: 't1', text: 'x'.repeat(4001) })).rejects.toMatchObject({ code: 'TEXT_TOO_LONG' });
  });

  it('refuses a tab that is not a terminal', async () => {
    const ctx = ctxWith({ tab: tab({ kind: 'simulator', tmux_session: null }) });
    await expect(sendInput(ctx, { tab_id: 't1', text: 'oi' })).rejects.toMatchObject({ code: 'NOT_A_TERMINAL' });
  });
});

describe('sendKey', () => {
  it('presses the key in the session', async () => {
    await expect(sendKey(ctxWith(), { tab_id: 't1', key: 'C-c' })).resolves.toMatchObject({ key: 'C-c', sent: true });
    expect(sendKeyToSession).toHaveBeenCalledWith(machine, 'termhub-p1-t1', 'C-c');
  });
});

describe('runCommand', () => {
  it('types the command, waits for the screen to settle and returns it', async () => {
    captureScreen.mockResolvedValueOnce('running…').mockResolvedValue('$ echo oi\noi\n$');
    const r = await runCommand(ctxWith(), { tab_id: 't1', command: 'echo oi', timeout_seconds: 5 });
    expect(sendTextToSession).toHaveBeenCalledWith(machine, 'termhub-p1-t1', 'echo oi', true);
    expect(r).toMatchObject({ tab_id: 't1', timed_out: false, text: '$ echo oi\noi\n$' });
  });

  it('comes back with the screen and timed_out when the command keeps going', async () => {
    let n = 0;
    captureScreen.mockImplementation(async () => `busy ${n++}`);
    const r = await runCommand(ctxWith(), { tab_id: 't1', command: 'sleep 60', timeout_seconds: 2 });
    expect(r.timed_out).toBe(true);
    expect(r.text).toContain('busy');
  });
});

describe('closeTab', () => {
  it('kills the session and removes a tab this token opened', async () => {
    killTmuxSession.mockResolvedValue(true);
    await expect(closeTab(ctxWith(), { tab_id: 't1' })).resolves.toEqual({ tab_id: 't1', killed: true });
  });

  it('refuses a tab opened somewhere else unless force is given', async () => {
    const ctx = ctxWith({ tab: tab({ created_by_token_id: null }) });
    await expect(closeTab(ctx, { tab_id: 't1' })).rejects.toMatchObject({ code: 'NOT_YOURS' });
    await expect(closeTab(ctx, { tab_id: 't1', force: true })).resolves.toMatchObject({ tab_id: 't1' });
  });

  it('still removes the tab when the session could not be killed', async () => {
    killTmuxSession.mockRejectedValue(new Error('offline'));
    const ctx = ctxWith();
    await expect(closeTab(ctx, { tab_id: 't1' })).resolves.toEqual({ tab_id: 't1', killed: false });
    expect(ctx.repos.tabs.delete).toHaveBeenCalledWith('t1');
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npm test -w @termhub/server -- terminals.test.ts`
Expected: FAIL — `Cannot find module './terminals.js'`.

- [ ] **Step 3: Implement**

`apps/server/src/control/terminals.ts`:

```ts
import type { TmuxKey } from '@termhub/agent-protocol';
import { requireAgentVersion } from '../agent/errors.js';
import { agents } from '../agent/registry.js';
import { captureScreen } from '../agent/screen.js';
import type { Machine, Project, Tab } from '../db/repositories/types.js';
import { HttpError } from '../lib/errors.js';
import { killTmuxSession } from '../terminal/machine-exec.js';
import { ensureSession, sendKeyToSession, sendTextToSession, TERMINAL_RPC_MIN_AGENT_VERSION } from '../terminal/session-ops.js';
import { ControlError, type ControlContext } from './context.js';
import { SCREEN_DEFAULT_LINES, SCREEN_MAX_LINES, waitForState } from './screen.js';

/** Tabs one token may keep open at a time (spec §4.2): a runaway loop cannot bury the project in tabs. */
export const MAX_TABS_PER_TOKEN = 10;
export const INPUT_MAX_CHARS = 4000;
export const RUN_DEFAULT_SECONDS = 30;
export const RUN_MAX_SECONDS = 90;
const SETTLE_POLL_MS = 1000;

const clamp = (v: number | undefined, def: number, max: number) => Math.max(1, Math.min(max, Math.trunc(v ?? def)));

const offline = () => new ControlError('MACHINE_OFFLINE', 'A máquina está offline: o termhub-agent dela não está conectado');

/** Online and new enough to answer the terminal RPCs — checked before anything is created or typed. */
function assertReady(machine: Machine): void {
  if (machine.type !== 'agent') return;
  if (!agents.isOnline(machine.id)) throw offline();
  requireAgentVersion(machine, TERMINAL_RPC_MIN_AGENT_VERSION); // HttpError 409 AGENT_OUTDATED
}

/** A terminal tab with a session name, on a machine that can answer right now. */
async function terminal(ctx: ControlContext, tabId: string): Promise<{ tab: Tab; project: Project; machine: Machine; session: string }> {
  const { tab, project, machine } = await ctx.scoped.tab(tabId);
  if (tab.kind !== 'terminal' || !tab.tmux_session) throw new ControlError('NOT_A_TERMINAL', 'Esta aba não é um terminal');
  assertReady(machine);
  return { tab, project, machine, session: tab.tmux_session };
}

/** Opens a tab and starts its tmux session detached, so it is alive without a browser attached. */
export async function openTab(ctx: ControlContext, input: { project_id: string; name?: string }): Promise<{ tab_id: string; name: string; project_id: string; tmux_session: string | null; created: boolean }> {
  const { project, machine } = await ctx.scoped.project(input.project_id);
  assertReady(machine);

  if (ctx.token) {
    const open = await ctx.repos.tabs.countOpenByToken(ctx.token.id);
    if (open >= MAX_TABS_PER_TOKEN) {
      throw new ControlError('TAB_LIMIT', `Este token já tem ${open} abas abertas (limite de ${MAX_TABS_PER_TOKEN}): feche alguma com close_tab antes de abrir outra`);
    }
  }

  const existing = await ctx.repos.tabs.listByProject(project.id);
  const name = input.name?.trim() || `Terminal ${existing.filter((t) => t.kind === 'terminal').length + 1}`;
  const tab = await ctx.repos.tabs.create(project.id, name, { created_by_token_id: ctx.token?.id ?? null });

  try {
    const { created } = await ensureSession(machine, tab.tmux_session as string, project.cwd);
    return { tab_id: tab.id, name: tab.name, project_id: project.id, tmux_session: tab.tmux_session, created };
  } catch (e) {
    // The tab is kept on purpose (spec §4.4): the error carries its id so the screen can be inspected.
    // The original code travels with it, so the audit row says what actually failed.
    const code = e instanceof ControlError || e instanceof HttpError ? (e.code ?? 'SESSION_FAILED') : 'SESSION_FAILED';
    throw new ControlError(code, `A aba ${tab.id} foi criada, mas a sessão tmux não subiu: ${e instanceof Error ? e.message : 'erro desconhecido'}`);
  }
}

/** Types text into the tab. `enter` defaults to true: the point is almost always to submit it. */
export async function sendInput(ctx: ControlContext, input: { tab_id: string; text: string; enter?: boolean; answering_permission?: boolean }): Promise<{ tab_id: string; sent: true }> {
  if (input.text.length > INPUT_MAX_CHARS) throw new ControlError('TEXT_TOO_LONG', `Texto longo demais: ${input.text.length} caracteres, máximo ${INPUT_MAX_CHARS}`);
  const { tab, project, machine, session } = await terminal(ctx, input.tab_id);
  if (tab.state === 'waiting_permission' && !input.answering_permission) {
    throw new ControlError('WAITING_PERMISSION', `Esta aba está esperando uma permissão: "${tab.state_text ?? 'pergunta não registrada'}". Se a sua resposta é para essa pergunta, repita com answering_permission: true.`);
  }
  await ensureSession(machine, session, project.cwd);
  await sendTextToSession(machine, session, input.text, input.enter ?? true);
  return { tab_id: tab.id, sent: true };
}

/** Presses one key from the closed list in the tab. */
export async function sendKey(ctx: ControlContext, input: { tab_id: string; key: TmuxKey }): Promise<{ tab_id: string; key: TmuxKey; sent: true }> {
  const { tab, project, machine, session } = await terminal(ctx, input.tab_id);
  await ensureSession(machine, session, project.cwd);
  await sendKeyToSession(machine, session, input.key);
  return { tab_id: tab.id, key: input.key, sent: true };
}

/**
 * Types a command, presses Enter and comes back with the screen once the tab settles. There is no
 * exit code — this is an interactive session, not a process runner. A command still running when the
 * timeout hits is not an error: the screen comes back with `timed_out: true`.
 */
export async function runCommand(
  ctx: ControlContext,
  input: { tab_id: string; command: string; timeout_seconds?: number; lines?: number },
  signal?: AbortSignal,
): Promise<{ tab_id: string; state: string | null; timed_out: boolean; lines: number; text: string }> {
  const { tab, project, machine, session } = await terminal(ctx, input.tab_id);
  if (input.command.length > INPUT_MAX_CHARS) throw new ControlError('TEXT_TOO_LONG', `Comando longo demais: ${input.command.length} caracteres, máximo ${INPUT_MAX_CHARS}`);
  const timeoutMs = clamp(input.timeout_seconds, RUN_DEFAULT_SECONDS, RUN_MAX_SECONDS) * 1000;
  const lines = clamp(input.lines, SCREEN_DEFAULT_LINES, SCREEN_MAX_LINES);

  await ensureSession(machine, session, project.cwd);
  await sendTextToSession(machine, session, input.command, true);

  const deadline = Date.now() + timeoutMs;
  let timedOut = false;
  let state: string | null = null;

  if (tab.state !== null) {
    // The machine has monitor hooks: the tool itself reports when it stopped working.
    const waited = await waitForState(ctx, { tab_id: tab.id, timeout_seconds: Math.ceil(timeoutMs / 1000) }, signal);
    timedOut = waited.timed_out;
    state = waited.state;
  } else {
    // No hooks: settle on the screen instead — two identical captures in a row mean nothing is moving.
    let previous: string | null = null;
    for (;;) {
      if (signal?.aborted) break;
      const now = await captureScreen(machine, session, lines);
      if (previous !== null && now === previous) break;
      previous = now;
      if (Date.now() + SETTLE_POLL_MS >= deadline) {
        timedOut = true;
        break;
      }
      await new Promise((r) => setTimeout(r, SETTLE_POLL_MS));
    }
  }

  return { tab_id: tab.id, state, timed_out: timedOut, lines, text: await captureScreen(machine, session, lines) };
}

/** Kills the tab's session and removes it. Only tabs this token opened, unless `force`. */
export async function closeTab(ctx: ControlContext, input: { tab_id: string; force?: boolean }): Promise<{ tab_id: string; killed: boolean }> {
  const { tab, machine } = await ctx.scoped.tab(input.tab_id);
  if (!input.force && ctx.token && tab.created_by_token_id !== ctx.token.id) {
    throw new ControlError('NOT_YOURS', 'Esta aba não foi aberta por este token: repita com force: true se quer fechá-la mesmo assim');
  }
  let killed = false;
  if (tab.tmux_session) {
    try {
      killed = await killTmuxSession(machine, tab.tmux_session);
    } catch {
      // An unreachable machine must not leave the tab behind; the row goes either way.
      killed = false;
    }
  }
  await ctx.repos.tabs.delete(tab.id);
  return { tab_id: tab.id, killed };
}
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `npm test -w @termhub/server -- terminals.test.ts`
Expected: PASS, 15 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/control/terminals.ts apps/server/src/control/terminals.test.ts
git commit -m "Control: open, type into, run in and close terminal tabs"
```

---

### Task 7: The five tools, shared argument parsing and the route nits

**Files:**
- Modify: `apps/server/src/mcp/tools.ts`
- Modify: `apps/server/src/mcp/route.ts`
- Test: `apps/server/src/mcp/route.test.ts`

This also closes follow-up 5 of PR #63 (one `parseArgs` shared by the route pre-check and the SDK) and the two nits: the stale comment about the empty tool list, and a notification (a JSON-RPC message with no `id`) getting a body back.

**Interfaces:**
- Consumes: Task 6 operations; `TMUX_KEYS` from `@termhub/agent-protocol`.
- Produces:
  - `parseArgs(tool: ToolDef, args: unknown): { ok: true; value: Record<string, unknown> } | { ok: false }` exported from `mcp/tools.ts`.
  - `TOOLS` gains `open_tab`, `send_input`, `send_key`, `run_command`, `close_tab`, all `scope: 'terminals'`, `resource: 'terminals'`, `action: 'write'`.

- [ ] **Step 1: Write the failing test**

Append to `apps/server/src/mcp/route.test.ts`, using the helpers already in that file — `build({ token, grants, limiter })`, `token(over)`, `rpc(app, body, auth?)`, `call(name, args)` and `flush()` (`route.test.ts:20-48`). Add `sendInput` to the mocked control modules at the top of the file:

```ts
vi.mock('../control/terminals.js', async (orig) => ({ ...(await orig<typeof import('../control/terminals.js')>()), sendInput: vi.fn() }));
```
and import it next to the other mocked operations (`import { sendInput } from '../control/terminals.js';`).

```ts
describe('terminals scope', () => {
  const terminalsToken = token({ scopes: ['read', 'terminals'] });
  const writeGrants = ['machines:read', 'projects:read', 'terminals:read', 'terminals:write'];

  it('hides the write tools from a read-only token and names the scope when one is called', async () => {
    const { app, apiTokens } = build({ grants: writeGrants });
    const list = await rpc(app, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect(list.json().result.tools.map((t: { name: string }) => t.name)).not.toContain('send_input');

    const refused = await rpc(app, call('send_input', { tab_id: 't1', text: 'oi' }));
    expect(refused.json().result.isError).toBe(true);
    expect(refused.json().result.content[0].text).toContain('escopo `terminals`');
    await flush();
    expect(apiTokens.recordEvent.mock.calls[0][0]).toMatchObject({ tool: 'send_input', ok: false, error_code: 'TOOL_NOT_ALLOWED', tab_id: 't1' });
  });

  it('offers the write tools to a terminals token whose user has the grant', async () => {
    const { app } = build({ token: terminalsToken, grants: writeGrants });
    const list = await rpc(app, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect(list.json().result.tools.map((t: { name: string }) => t.name)).toEqual(expect.arrayContaining(['open_tab', 'send_input', 'send_key', 'run_command', 'close_tab']));
  });

  it('keeps the write tools from a token whose user lost the terminals:write grant', async () => {
    const { app } = build({ token: terminalsToken, grants: ['terminals:read'] });
    const list = await rpc(app, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect(list.json().result.tools.map((t: { name: string }) => t.name)).not.toContain('send_input');
  });

  it('refuses a key outside the closed list before the machine is touched', async () => {
    const { app, apiTokens } = build({ token: terminalsToken, grants: writeGrants });
    const r = await rpc(app, call('send_key', { tab_id: 't1', key: 'C-d' }));
    expect(r.json().error ?? r.json().result.isError).toBeTruthy();
    await flush();
    expect(apiTokens.recordEvent.mock.calls[0][0]).toMatchObject({ tool: 'send_key', ok: false, error_code: 'INVALID_ARGS' });
  });

  it('never records what was typed', async () => {
    vi.mocked(sendInput).mockResolvedValue({ tab_id: 't1', sent: true });
    const { app, apiTokens } = build({ token: terminalsToken, grants: writeGrants });
    await rpc(app, call('send_input', { tab_id: 't1', text: 'SENHA-SECRETA' }));
    await flush();
    expect(JSON.stringify(apiTokens.recordEvent.mock.calls)).not.toMatch(/SENHA-SECRETA/);
    expect(apiTokens.recordEvent.mock.calls[0][0]).toMatchObject({ tool: 'send_input', tab_id: 't1', ok: true });
  });

  it('answers a notification with 202 and no body', async () => {
    const { app } = build();
    const res = await rpc(app, { jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(res.statusCode).toBe(202);
    expect(res.body).toBe('');
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npm test -w @termhub/server -- route.test.ts`
Expected: FAIL — `open_tab` is not in the tool list.

- [ ] **Step 3: Add `parseArgs` and the five tools**

In `apps/server/src/mcp/tools.ts`, import the operations and the key list:

```ts
import { TMUX_KEYS } from '@termhub/agent-protocol';
import { closeTab, INPUT_MAX_CHARS, openTab, runCommand, RUN_MAX_SECONDS, sendInput, sendKey } from '../control/terminals.js';
```

Add the shared parser right after the `id` constant:

```ts
/** One place that turns raw tool arguments into validated ones — used by the route pre-check and by the SDK. */
export function parseArgs(tool: ToolDef, args: unknown): { ok: true; value: Record<string, unknown> } | { ok: false } {
  const parsed = z.object(tool.input).safeParse(args ?? {});
  return parsed.success ? { ok: true, value: parsed.data as Record<string, unknown> } : { ok: false };
}
```

Append to `TOOLS`:

```ts
  {
    name: 'open_tab',
    description: 'Open a terminal tab in a project and start its tmux session detached, so it keeps running with no browser attached.',
    scope: 'terminals', resource: 'terminals', action: 'write',
    input: { project_id: id, name: z.string().trim().min(1).max(60).optional() },
    run: (ctx, a) => openTab(ctx, a as { project_id: string; name?: string }),
  },
  {
    name: 'send_input',
    description: `Type text into a terminal tab (max ${INPUT_MAX_CHARS} chars) and press Enter unless enter is false. A tab waiting for a permission needs answering_permission: true.`,
    scope: 'terminals', resource: 'terminals', action: 'write',
    input: { tab_id: id, text: z.string().max(INPUT_MAX_CHARS), enter: z.boolean().optional(), answering_permission: z.boolean().optional() },
    run: (ctx, a) => sendInput(ctx, a as { tab_id: string; text: string; enter?: boolean; answering_permission?: boolean }),
  },
  {
    name: 'send_key',
    description: `Press one key in a terminal tab: ${TMUX_KEYS.join(', ')}.`,
    scope: 'terminals', resource: 'terminals', action: 'write',
    input: { tab_id: id, key: z.enum(TMUX_KEYS) },
    run: (ctx, a) => sendKey(ctx, a as { tab_id: string; key: (typeof TMUX_KEYS)[number] }),
  },
  {
    name: 'run_command',
    description: `Type a command in a terminal tab, press Enter, wait for the tab to settle (default 30 s, max ${RUN_MAX_SECONDS}) and return the screen. There is no exit code: it is an interactive session.`,
    scope: 'terminals', resource: 'terminals', action: 'write',
    input: { tab_id: id, command: z.string().min(1).max(INPUT_MAX_CHARS), timeout_seconds: z.number().int().min(1).max(RUN_MAX_SECONDS).optional(), lines: z.number().int().min(1).max(SCREEN_MAX_LINES).optional() },
    run: (ctx, a, signal) => runCommand(ctx, a as { tab_id: string; command: string; timeout_seconds?: number; lines?: number }, signal),
  },
  {
    name: 'close_tab',
    description: 'Kill a terminal tab’s tmux session and remove the tab. Only tabs this token opened, unless force is true.',
    scope: 'terminals', resource: 'terminals', action: 'write',
    input: { tab_id: id, force: z.boolean().optional() },
    run: (ctx, a) => closeTab(ctx, a as { tab_id: string; force?: boolean }),
  },
```

- [ ] **Step 4: Use `parseArgs` in the route and fix the two nits**

In `apps/server/src/mcp/route.ts`:

1. In the pre-check (`:137`), replace the inline `z.object(tool.input).safeParse(...)` with `!parseArgs(tool, msg.params.arguments).ok`, and drop the now-unused `z` import if nothing else uses it.
2. Replace the stale comment above the empty-tool-list handler (`:99-100`) with what the code actually does: `// With no tools at all the SDK would answer "Method not found" to tools/list; answer an empty list instead.`
3. Answer notifications with `202` and an empty body — a JSON-RPC message with no `id` expects no result:

```ts
    // A notification (no `id`) gets no body: answering one with `id: null` is a protocol error on the client side.
    if (msg && typeof msg === 'object' && !('id' in msg) && typeof msg.method === 'string') return reply.code(202).send();
```

Put it right after `withDefaultArguments` runs and before the `tools/call` pre-check.

- [ ] **Step 5: Run the tests and make sure they pass**

```bash
npm test -w @termhub/server -- mcp
npm run typecheck -w @termhub/server
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/mcp/tools.ts apps/server/src/mcp/route.ts apps/server/src/mcp/route.test.ts
git commit -m "MCP: open_tab, send_input, send_key, run_command and close_tab"
```

---

### Task 8: Integration test, docs and the agent release

**Files:**
- Test: `apps/server/src/mcp/terminals.e2e.test.ts`
- Modify: `README.md` (the MCP section from PR #63)
- Modify: `docs/superpowers/specs/2026-09-18-global-terminal-mcp-design.md` (§4.2, if this plan deviated)

- [ ] **Step 1: Write the round-trip test**

`apps/server/src/mcp/terminals.e2e.test.ts` — the `open_tab` → `send_input` → `read_screen` round trip spec §7 asks for. Nothing between the route and the machine is mocked: the real `control/terminals.ts`, `terminal/session-ops.ts` and `agent/screen.ts` run, and the only stand-in is the agent connection itself (the `attachFakeConn` pattern from `apps/server/src/agent/ops.test.ts:38-53`), holding a tiny in-memory tmux that remembers what was typed.

```ts
import Fastify from 'fastify';
import { beforeEach, expect, it, vi } from 'vitest';
import type { AgentConnection } from '../agent/connection.js';
import { agents } from '../agent/registry.js';
import { hashApiToken } from '../auth/api-tokens.js';
import { canAccess } from '../auth/permissions.js';
import type { Repositories } from '../db/repositories/index.js';
import { applyErrorHandler } from '../lib/errors.js';
import { mcpRoutes } from './route.js';

vi.mock('../auth/permissions.js', async (orig) => ({ ...(await orig<typeof import('../auth/permissions.js')>()), canAccess: vi.fn(async () => true) }));

const SECRET = 'thb_pat_' + 'A'.repeat(43);
const machine = { id: 'm1', name: 'jarvis', type: 'agent', os: 'linux', capabilities: ['tmux'], owner_id: 'u1' };
const project = { id: 'p1', name: 'app', cwd: '/home/u/app', machine_id: 'm1', status: 'active', owner_id: 'u1' };

/** The fake machine: one tmux session whose screen is whatever was typed into it. */
function attachFakeTmux(typed: string[]) {
  const conn = {
    machineId: machine.id,
    hello: { agent_version: '0.2.0', os: 'linux', tools: ['tmux'] },
    connectedAt: Date.now(),
    close: vi.fn(),
    openPty: vi.fn(),
    on() {
      return this;
    },
    rpc: vi.fn(async (method: string, params: unknown) => {
      const p = params as { text?: string };
      if (method === 'tmux.ensure') return { created: true };
      if (method === 'tmux.sendText') {
        typed.push(p.text ?? '');
        return { sent: true };
      }
      if (method === 'tmux.capture') return { text: typed.join('\n') };
      throw new Error(`unexpected rpc ${method}`);
    }),
  } as unknown as AgentConnection;
  agents.attach(machine.id, conn);
  return conn;
}

function build() {
  const tabs = new Map<string, Record<string, unknown>>();
  const apiTokens = {
    findActiveByHash: vi.fn(async (h: string) => (h === hashApiToken(SECRET) ? { id: 'tok1', user_id: 'u1', name: 'jarvis', scopes: ['read', 'terminals'], expires_at: null, revoked_at: null, last_used_at: null, created_at: '' } : undefined)),
    touchLastUsed: vi.fn(async () => {}),
    recordEvent: vi.fn(async () => {}),
  };
  const repos = {
    apiTokens,
    users: { findById: vi.fn(async () => ({ id: 'u1', role_id: 'r' })) },
    machines: { findById: vi.fn(async () => machine), list: vi.fn(async () => [machine]) },
    projects: { findById: vi.fn(async () => project) },
    tasks: { listByProject: vi.fn(async () => []) },
    tabs: {
      listByProject: vi.fn(async () => [...tabs.values()]),
      countOpenByToken: vi.fn(async () => 0),
      findById: vi.fn(async (id: string) => tabs.get(id)),
      delete: vi.fn(async (id: string) => tabs.delete(id)),
      create: vi.fn(async (projectId: string, name: string, opts: { created_by_token_id?: string | null } = {}) => {
        const id = `t${tabs.size + 1}`;
        const tab = { id, project_id: projectId, name, kind: 'terminal', tmux_session: `termhub-${projectId}-${id}`, simulator_udid: null, position: 0, state: null, state_text: null, state_tool: null, state_at: null, state_seen_at: null, created_at: '', created_by_token_id: opts.created_by_token_id ?? null };
        tabs.set(id, tab);
        return tab;
      }),
    },
  } as unknown as Repositories;

  const app = Fastify();
  applyErrorHandler(app);
  app.register((a) => mcpRoutes(a, { repos, version: '0.0.0-test' }));
  return { app, apiTokens };
}

const callTool = (app: ReturnType<typeof Fastify>, name: string, args: object) =>
  app.inject({
    method: 'POST',
    url: '/mcp',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${SECRET}` },
    payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
  });

const payloadOf = (res: { json(): { result: { content: { text: string }[]; isError?: boolean } } }) => JSON.parse(res.json().result.content[0].text);

beforeEach(() => {
  agents.reset();
  vi.mocked(canAccess).mockResolvedValue(true);
});

it('opens a tab, types into it and reads the text back', async () => {
  const typed: string[] = [];
  const conn = attachFakeTmux(typed);
  const { app, apiTokens } = build();

  const opened = await callTool(app, 'open_tab', { project_id: 'p1' });
  const { tab_id } = payloadOf(opened);
  expect(conn.rpc).toHaveBeenCalledWith('tmux.ensure', { session: `termhub-p1-${tab_id}`, cwd: '/home/u/app' }, undefined);

  await callTool(app, 'send_input', { tab_id, text: 'echo termhub', enter: true });
  const screen = await callTool(app, 'read_screen', { tab_id, lines: 10 });
  expect(payloadOf(screen).text).toContain('echo termhub');

  await new Promise((r) => setTimeout(r, 0));
  const rows = apiTokens.recordEvent.mock.calls.map((c) => c[0]);
  expect(rows.map((r) => r.tool)).toEqual(['open_tab', 'send_input', 'read_screen']);
  expect(rows.every((r) => r.ok)).toBe(true);
  // metadata only: nothing typed and nothing on the screen is ever stored
  expect(JSON.stringify(rows)).not.toContain('echo termhub');
});

it('tells the caller to update an agent that does not know the new RPCs', async () => {
  const conn = attachFakeTmux([]);
  (conn as unknown as { hello: { agent_version: string } }).hello.agent_version = '0.1.6';
  const { app, apiTokens } = build();

  const r = await callTool(app, 'open_tab', { project_id: 'p1' });
  expect(r.json().result.isError).toBe(true);
  expect(r.json().result.content[0].text).toContain('Atualize o agente');
  await new Promise((r) => setTimeout(r, 0));
  expect(apiTokens.recordEvent.mock.calls[0][0]).toMatchObject({ tool: 'open_tab', ok: false, error_code: 'AGENT_OUTDATED' });
});
```

The `rpc` assertion's third argument is the per-call timeout `AgentConnection.rpc` receives (`undefined` here, so the method's own `timeoutMs` applies) — check the real call shape if that assertion fails rather than loosening it to `expect.anything()`.

- [ ] **Step 2: Run it**

Run: `npm test -w @termhub/server -- terminals.e2e.test.ts`
Expected: PASS, and the last assertion is the one that proves spec §7's "`send_input` text absent from `api_token_events`".

- [ ] **Step 3: Update the README**

In the MCP section, list the `terminals` tools next to the `read` ones, and add the sentence that matters to someone handing out a token: a `terminals` token can type into any terminal the owner can see, so it should be created only for a machine the owner trusts, and revoked from Settings when the session is done.

- [ ] **Step 4: Full check before pushing**

```bash
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -e npm_config_update_notifier=false -v "$PWD:/w" -w /w node:20 \
  sh -c 'npm run typecheck -w @termhub/server && npm test -w @termhub/server && npm test -w @termhub/agent && npm test -w @termhub/agent-protocol && npm run build -w @termhub/web && npm run build -w @termhub/landing'; rm -rf .npm
```

Expected: everything green. Then the migration drift check from Task 5 Step 6.

- [ ] **Step 5: Commit and open the PR**

```bash
git add README.md docs/superpowers apps/server/src/mcp/terminals.e2e.test.ts
git commit -m "Docs: describe the terminals tools of /mcp"
git push -u origin feat/mcp-terminals
```

PR body: what changed, the verification table, and the **after-merge** steps below.

- [ ] **Step 6: After the PR merges — publish the agent**

The tools fail with `AGENT_OUTDATED` on every machine until its agent is updated, so this is not optional:

```bash
git checkout main && git pull
git tag agent-v0.2.0 && git push origin agent-v0.2.0   # triggers .github/workflows/publish-agent.yml
```

Then, on each machine: `npm i -g @termhub/agent@0.2.0` and restart it. Check with `list_machines` that the machine reports the new version.

---

## Self-review notes

- **Spec coverage:** §4.2 — `open_tab` (Task 6), `send_input` (6), `send_key` (6), `run_command` (6), `close_tab` (6), `created_by_token_id` and the open-tab limit (Task 5 + 6); `start_agent` is explicitly deferred to PR 5. §4.3 — the three RPCs (Tasks 1–2), `sendKeysToSession` rebuilt on them and the monitor 409 removed (Task 3), `requireAgentVersion` with `AGENT_OUTDATED` (Task 3), `PROTOCOL_VERSION` unchanged (Task 1). §6 — tool errors are `ControlError`s with pt-BR messages, and the scope refusal already comes from `refusalMessage` (Task 7). §7 — agent RPCs against real tmux on a `-L` socket (Task 2), the `open_tab` → `send_input` → `read_screen` round trip and "typed text never in the audit" (Task 8), `shellQuote` inertness (Task 3).
- **Deviation from the spec, to be recorded in §4.2 if it stands:** the spec says `run_command` "waits for the tab to settle"; this plan defines settling as `wait_for_state` when the tab has monitor state and a two-identical-captures poll when it does not, and it always returns the screen with `timed_out` rather than erroring on a slow command.
- **`INPUT_MAX_CHARS` is defined twice** — in `monitor/send-keys.ts` (existing, used by the REST route) and in `control/terminals.ts`. If the implementer prefers, import the existing one instead; what must not happen is two different values.
