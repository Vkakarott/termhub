# Zero-downtime deploys for terminals — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A blue/green deploy no longer breaks open terminals: the retiring colour hands its sockets over, the new colour waits for agents that are moving, and clients reconnect at once.

**Architecture:** Keep the single active colour behind the proxy nginx. The server gains a drain on SIGTERM (agents first, then every WebSocket, with close code 1012), a readiness endpoint, and a short wait for an agent that was connected moments ago. The web clients treat 1012 as "reconnect now". `deploy/blue-green.sh` stops the old colour right after the switch with a 30 s stop timeout instead of sleeping 30 s and letting Docker SIGKILL it.

**Tech Stack:** Fastify 5 + `ws` (apps/server), React + vitest/jsdom (apps/web), bash + docker compose (deploy).

**Spec:** `docs/superpowers/specs/2026-09-27-zero-downtime-deploy-design.md`

## Global Constraints

- Close code for "server restarting / agent moving": **1012**, reason `service restart` (drain) or `agent reconnecting` (lost agent). Defined once in the server as `RESTART_CLOSE = 1012` (`apps/server/src/ws/drain.ts`); `@termhub/agent-protocol` and `@termhub/agent` are not changed (no agent release).
- "Moving" agent: offline on this instance and `agent_last_seen_at` less than **150 s** old. Wait at most **15 s**.
- Drain overall timeout: **15 s**. Compose `stop_grace_period: 30s`; the script stops with `-t 30`.
- `/api/ready`: `SELECT 1` with a **2 s** timeout; 503 `{ok:false, reason:'database'|'draining'}`.
- Web reconnect after 1012: **250–750 ms**, without spending an attempt.
- `DRAIN_DELAY` in `blue-green.sh`: default **3 s**.
- UI copy stays pt-BR; code, comments, commits in English. Terminal content is never logged.
- Workspaces addressed by package name. Tests: `npm test -w @termhub/server -- <file>` / `npm test -w @termhub/web -- <file>`. This host has no Node: run through Docker, e.g.
  `docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/w" -w /w node:22 sh -c 'npm ci --ignore-scripts=false >/dev/null && npm run build:packages >/dev/null && npm test -w @termhub/server -- src/agent/registry.test.ts'` (then `rm -rf .npm`). Server tests that touch Postgres need `TERMHUB_DB_TESTS=1` and a `th-*` database container; the tests in this plan do not.

## Review Focus

1. A machine that has really been offline for hours: opening its terminal must fail at once (no 15 s hang). → Task 1 test "does not wait for a stale machine", Task 2 test "fails at once for a long-offline machine".
2. The browser closes its socket while the server is still waiting for a moving agent: no PTY may be opened afterwards (leak toward the agent's channel limit). → Task 2 test "client gone during the wait".
3. A real process exit (`exit` typed in the shell) must still end as "Sessão encerrada", not loop reconnecting. → Task 2 test "real exit still sends exit"; Task 5 test "exit frame then 1012 stays closed".
4. A WebSocket upgrade arriving while draining is refused (503), so the old colour does not pick up a new client and then kill it. → Task 4 test "refuses upgrades while draining".
5. The drain must finish even if one socket ignores the close handshake. → Task 4 test "terminates sockets that do not close within the budget".

---

### Task 1: Registry — `waitOnline`, `awaitAgent`, touch on disconnect

**Files:**
- Modify: `apps/server/src/agent/registry.ts`
- Modify: `apps/server/src/agent/ws.ts` (close handler)
- Test: `apps/server/src/agent/registry.test.ts`, `apps/server/src/agent/ws.test.ts`

**Interfaces:**
- Produces:
  - `export const MOVING_WINDOW_MS = 150_000; export const MOVING_WAIT_MS = 15_000;` (registry.ts)
  - `AgentRegistry.waitOnline(machineId: string, timeoutMs: number): Promise<boolean>`
  - `AgentRegistry.awaitAgent(machine: Pick<Machine, 'id' | 'type' | 'agent_last_seen_at'>, opts?: { now?: number; timeoutMs?: number }): Promise<boolean>` — `true` when online (at once if already); a non-agent machine returns `true` immediately (nothing to wait for); an offline agent machine returns `false` at once if not moving, otherwise the result of `waitOnline`.
  - `AgentRegistry.closeAll(code: number, reason: string): number` — closes every connection, returns how many.

- [ ] **Step 1: Write the failing tests** (append to `registry.test.ts`, reusing its `fakeConn`)

```ts
describe('AgentRegistry.waitOnline / awaitAgent', () => {
  const agentMachine = (lastSeen: string | null) => ({ id: 'm1', type: 'agent' as const, agent_last_seen_at: lastSeen });

  it('resolves true at once when already online', async () => {
    const r = new AgentRegistry(); r.attach('m1', fakeConn('m1'));
    await expect(r.waitOnline('m1', 1000)).resolves.toBe(true);
  });
  it('resolves true when the agent attaches during the wait', async () => {
    vi.useFakeTimers();
    const r = new AgentRegistry();
    const p = r.waitOnline('m1', 5000);
    await vi.advanceTimersByTimeAsync(1000);
    r.attach('m1', fakeConn('m1'));
    await expect(p).resolves.toBe(true);
    expect(r.listenerCount('online')).toBe(0);
    vi.useRealTimers();
  });
  it('resolves false on timeout and removes its listener', async () => {
    vi.useFakeTimers();
    const r = new AgentRegistry();
    const p = r.waitOnline('m1', 5000);
    await vi.advanceTimersByTimeAsync(5000);
    await expect(p).resolves.toBe(false);
    expect(r.listenerCount('online')).toBe(0);
    vi.useRealTimers();
  });
  it('ignores another machine coming online', async () => {
    vi.useFakeTimers();
    const r = new AgentRegistry();
    const p = r.waitOnline('m1', 2000);
    r.attach('m2', fakeConn('m2'));
    await vi.advanceTimersByTimeAsync(2000);
    await expect(p).resolves.toBe(false);
    vi.useRealTimers();
  });
  it('awaitAgent: a non-agent machine passes at once', async () => {
    await expect(new AgentRegistry().awaitAgent({ id: 'm1', type: 'ssh', agent_last_seen_at: null } as never)).resolves.toBe(true);
  });
  it('awaitAgent: does not wait for a stale machine', async () => {
    const now = Date.parse('2026-09-28T00:10:00Z');
    const r = new AgentRegistry(); const spy = vi.spyOn(r, 'waitOnline');
    await expect(r.awaitAgent(agentMachine('2026-09-28T00:00:00Z'), { now })).resolves.toBe(false);
    await expect(r.awaitAgent(agentMachine(null), { now })).resolves.toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });
  it('awaitAgent: waits for a machine seen within the moving window', async () => {
    const now = Date.parse('2026-09-28T00:10:00Z');
    const r = new AgentRegistry(); const spy = vi.spyOn(r, 'waitOnline').mockResolvedValue(true);
    await expect(r.awaitAgent(agentMachine('2026-09-28T00:08:00Z'), { now })).resolves.toBe(true);
    expect(spy).toHaveBeenCalledWith('m1', MOVING_WAIT_MS);
  });
  it('closeAll closes every connection with the given code', () => {
    const r = new AgentRegistry(); const a = fakeConn('m1'); const b = fakeConn('m2');
    r.attach('m1', a); r.attach('m2', b);
    expect(r.closeAll(1012, 'service restart')).toBe(2);
    expect(a.close).toHaveBeenCalledWith(1012, 'service restart');
    expect(b.close).toHaveBeenCalledWith(1012, 'service restart');
    expect(r.isOnline('m1')).toBe(false);
  });
});
```
Import `MOVING_WAIT_MS` from `./registry.js` at the top of the test file.

- [ ] **Step 2: Run** `npm test -w @termhub/server -- src/agent/registry.test.ts` → FAIL (`waitOnline is not a function`).

- [ ] **Step 3: Implement** in `registry.ts` (add `import type { Machine } from '../db/repositories/types.js';`):

```ts
/** An agent offline here but seen this recently is moving between instances (deploy, reconnect): worth a short wait. */
export const MOVING_WINDOW_MS = 150_000;
/** How long a caller waits for a moving agent before answering "offline". */
export const MOVING_WAIT_MS = 15_000;
```
Methods on `AgentRegistry`:

```ts
  /** Resolves true once `machineId` is attached (at once if it already is), false after `timeoutMs`. */
  waitOnline(machineId: string, timeoutMs: number): Promise<boolean> {
    if (this.conns.has(machineId)) return Promise.resolve(true);
    return new Promise((resolve) => {
      const onOnline = (id: string) => {
        if (id !== machineId) return;
        clearTimeout(timer);
        this.off('online', onOnline);
        resolve(true);
      };
      const timer = setTimeout(() => {
        this.off('online', onOnline);
        resolve(false);
      }, timeoutMs);
      this.on('online', onOnline);
    });
  }

  /**
   * Whether the machine's agent can be used now, waiting a little for one that is moving: offline here but seen
   * moments ago, which is what a blue/green switch or a quick reconnect looks like (spec 2026-09-27 §5.3). A machine
   * long gone answers false at once. Non-agent machines have nothing to wait for.
   */
  async awaitAgent(machine: Pick<Machine, 'id' | 'type' | 'agent_last_seen_at'>, opts: { now?: number; timeoutMs?: number } = {}): Promise<boolean> {
    if (machine.type !== 'agent') return true;
    if (this.conns.has(machine.id)) return true;
    const seen = machine.agent_last_seen_at ? Date.parse(machine.agent_last_seen_at) : NaN;
    if (!Number.isFinite(seen) || (opts.now ?? Date.now()) - seen > MOVING_WINDOW_MS) return false;
    return this.waitOnline(machine.id, opts.timeoutMs ?? MOVING_WAIT_MS);
  }

  /** Closes every agent connection (the drain on shutdown); returns how many there were. */
  closeAll(code: number, reason: string): number {
    const all = [...this.conns.values()];
    for (const conn of all) conn.close(code, reason);
    return all.length;
  }
```
Note `setMaxListeners`: many terminals may wait at once; call `this.setMaxListeners(0)` in a constructor (`constructor() { super(); this.setMaxListeners(0); }`).

- [ ] **Step 4: Run** the registry tests → PASS.

- [ ] **Step 5: Touch on disconnect — failing test.** In `agent/ws.test.ts`, find the existing test that connects an agent and asserts `touchAgent` was called on hello; add a test next to it that closes the agent socket and expects a second `touchAgent(machineId, { lastSeenAt: expect.any(Date) })` call after close (poll with `await vi.waitFor(() => expect(touchAgent).toHaveBeenCalledTimes(2))`). Follow that file's existing helpers for starting the server and the fake repos.

- [ ] **Step 6: Implement** in `agent/ws.ts`, inside `conn.on('close', …)` after the log line:

```ts
            // When it left, not only when it was last polled: the other colour reads this to tell an agent that is
            // moving over (a deploy) from one long gone (spec 2026-09-27 §5.3).
            void touch();
```
`touch` is declared with `const` after this listener; move the `const touch = …` declaration above `conn.on('close', …)` so it is in scope.

- [ ] **Step 7: Run** `npm test -w @termhub/server -- src/agent/` → PASS. **Commit:**
```bash
git add apps/server/src/agent/registry.ts apps/server/src/agent/registry.test.ts apps/server/src/agent/ws.ts apps/server/src/agent/ws.test.ts
git commit -m "Agent registry: wait for an agent that is moving between instances"
```

---

### Task 2: Terminal WebSocket — lost agent is 1012, wait for a moving agent

**Files:**
- Create: `apps/server/src/ws/drain.ts` (only the constant for now; Task 4 fills it in)
- Modify: `apps/server/src/terminal/pty-session.ts` (`PtySessionHandlers`)
- Modify: `apps/server/src/agent/pty.ts`
- Modify: `apps/server/src/terminal/ws.ts`
- Test: `apps/server/src/agent/pty.test.ts`, `apps/server/src/terminal/ws.test.ts`

**Interfaces:**
- Consumes: `agents.awaitAgent(machine)` (Task 1).
- Produces: `export const RESTART_CLOSE = 1012;` in `ws/drain.ts`; `PtySessionHandlers.onLost?: () => void`.

- [ ] **Step 1: Failing tests — `agent/pty.test.ts`:**

```ts
  it('reports a lost agent connection as onLost, not as an exit', async () => {
    const channel = fakeChannel(); const registry = fakeRegistry(channel);
    const onExit = vi.fn(); const onLost = vi.fn();
    await AgentPtySession.open(registry, fakeMachine(), '/tmp', fakeTab(), {}, { onData: vi.fn(), onExit, onLost });
    const handlers = (registry.openPty as unknown as ReturnType<typeof vi.fn>).mock.calls[0][2] as PtyHandlers;
    handlers.onExit(null);
    expect(onLost).toHaveBeenCalledOnce();
    expect(onExit).not.toHaveBeenCalled();
  });
  it('still reports a real exit code as onExit', async () => {
    const channel = fakeChannel(); const registry = fakeRegistry(channel);
    const onExit = vi.fn(); const onLost = vi.fn();
    await AgentPtySession.open(registry, fakeMachine(), '/tmp', fakeTab(), {}, { onData: vi.fn(), onExit, onLost });
    const handlers = (registry.openPty as unknown as ReturnType<typeof vi.fn>).mock.calls[0][2] as PtyHandlers;
    handlers.onExit(0);
    expect(onExit).toHaveBeenCalledWith(0);
    expect(onLost).not.toHaveBeenCalled();
  });
  it('falls back to onExit(1) for a lost connection when no onLost is given', async () => {
    const channel = fakeChannel(); const registry = fakeRegistry(channel); const onExit = vi.fn();
    await AgentPtySession.open(registry, fakeMachine(), '/tmp', fakeTab(), {}, { onData: vi.fn(), onExit });
    const handlers = (registry.openPty as unknown as ReturnType<typeof vi.fn>).mock.calls[0][2] as PtyHandlers;
    handlers.onExit(null);
    expect(onExit).toHaveBeenCalledWith(1);
  });
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** `pty-session.ts`:

```ts
export interface PtySessionHandlers {
  onData: (data: string) => void;
  onExit: (code: number, signal?: number) => void;
  /** The connection to the machine dropped (an agent reconnecting, a deploy) — the tmux session itself lives on. */
  onLost?: () => void;
}
```
`agent/pty.ts`:

```ts
        onExit: (code) => {
          // null = the agent connection closed under the channel, not the process exiting (spec 2026-09-27 §5.4)
          if (code === null && handlers.onLost) handlers.onLost();
          else handlers.onExit(code ?? 1);
        },
```
Run pty tests → PASS.

- [ ] **Step 4: Failing tests — `terminal/ws.test.ts`.** The suite mocks `createPtySession`; also mock the registry's `awaitAgent`. Add at the top next to the other hoisted mocks: `awaitAgentMock: vi.fn()` and

```ts
vi.mock('../agent/registry.js', async (orig) => {
  const mod = await orig<typeof import('../agent/registry.js')>();
  return { ...mod, agents: { awaitAgent: (...a: unknown[]) => awaitAgentMock(...a) } };
});
```
with `awaitAgentMock.mockResolvedValue(true)` in the suite's `beforeEach`. Tests (use the file's existing helpers for starting the server/connecting a client and collecting messages/close):

```ts
  it('closes 1012 without an exit frame when the agent connection is lost', async () => {
    let handlers!: { onLost?: () => void };
    createPtySessionMock.mockImplementation(async (_m, _c, _t, _s, h) => { handlers = h; return { pid: null, write() {}, resize() {}, kill: vi.fn() }; });
    const { messages, closed } = await connectClient();   // existing helper name in this file may differ — use it
    await waitForMessage(messages, 'ready');
    handlers.onLost!();
    const { code, reason } = await closed;
    expect(code).toBe(1012);
    expect(reason).toBe('agent reconnecting');
    expect(messages.some((m) => m.type === 'exit')).toBe(false);
  });
  it('real exit still sends exit + 1000', async () => { /* same setup, call handlers.onExit(0): expect {type:'exit',code:0} and close 1000 */ });
  it('waits for a moving agent before opening the pty', async () => {
    let release!: (v: boolean) => void;
    awaitAgentMock.mockReturnValue(new Promise<boolean>((r) => (release = r)));
    createPtySessionMock.mockResolvedValue({ pid: null, write() {}, resize() {}, kill: vi.fn() });
    const { messages } = await connectClient();
    await new Promise((r) => setTimeout(r, 50));
    expect(createPtySessionMock).not.toHaveBeenCalled();
    release(true);
    await waitForMessage(messages, 'ready');
    expect(createPtySessionMock).toHaveBeenCalledOnce();
  });
  it('fails at once for a long-offline machine', async () => {
    awaitAgentMock.mockResolvedValue(false);
    createPtySessionMock.mockRejectedValue(new AgentOfflineError('agent offline: m1'));
    const { messages, closed } = await connectClient();
    expect((await closed).code).toBe(1011);
    expect(messages).toContainEqual({ type: 'error', message: 'Agente desconectado' });
  });
  it('client gone during the wait: no pty is opened', async () => {
    let release!: (v: boolean) => void;
    awaitAgentMock.mockReturnValue(new Promise<boolean>((r) => (release = r)));
    const { ws } = await connectClient();
    ws.close();
    await new Promise((r) => setTimeout(r, 50));
    release(true);
    await new Promise((r) => setTimeout(r, 50));
    expect(createPtySessionMock).not.toHaveBeenCalled();
  });
```
Write the "real exit" test in full following the first one. Adapt helper names to what `ws.test.ts` already defines (read its helpers first; add small ones if missing).

- [ ] **Step 5: Run** → FAIL. **Step 6: Implement.** Create `apps/server/src/ws/drain.ts`:

```ts
/** Close code for "this server is restarting / the machine is reconnecting": clients reconnect at once (spec 2026-09-27). */
export const RESTART_CLOSE = 1012;
```
In `terminal/ws.ts` import `agents` from `../agent/registry.js` and `RESTART_CLOSE` from `../ws/drain.js`. In `handleConnection`, after the early-disconnect listeners are registered and before `createPtySession`:

```ts
  // An agent that is moving between instances (a deploy) gets a few seconds to arrive instead of an error.
  await agents.awaitAgent(ctx.machine);
  if (clientGone) {
    ws.off('close', onEarlyDisconnect);
    ws.off('error', onEarlyDisconnect);
    return;
  }
```
and add to the handlers passed to `createPtySession`:

```ts
        onLost: () => {
          // The machine's connection dropped, the tmux session did not: the browser reconnects right away.
          log.info({ tabId: ctx.tab.id, machineId: ctx.machine.id }, 'agent connection lost');
          ws.close(RESTART_CLOSE, 'agent reconnecting');
        },
```
- [ ] **Step 7: Run** `npm test -w @termhub/server -- src/terminal/ src/agent/` → PASS. **Commit:**
```bash
git add apps/server/src/ws/drain.ts apps/server/src/terminal apps/server/src/agent/pty.ts apps/server/src/agent/pty.test.ts
git commit -m "Terminal: reconnect instead of ending when the agent connection drops"
```

---

### Task 3: Wait for a moving agent in the chat host and the terminal control

**Files:**
- Modify: `apps/server/src/chat/host.ts` (`HostAgents` interface + `resolveHost`)
- Modify: `apps/server/src/control/terminals.ts` (`assertReady` → async)
- Modify: `apps/server/src/control/screen.ts` (`readScreen`)
- Modify: `apps/server/src/agent/errors.ts` (`agentRpc`)
- Test: the existing tests of those modules (`chat/host.test.ts`, `control/terminals.test.ts`, `control/screen.test.ts`, `agent/errors.test.ts` — use whichever exist; create `agent/errors.test.ts` cases if absent)

**Interfaces:**
- Consumes: `AgentRegistry.awaitAgent` (Task 1).
- Produces: `HostAgents` gains `awaitAgent(machine: Pick<Machine,'id'|'type'|'agent_last_seen_at'>): Promise<boolean>`.

- [ ] **Step 1: Failing tests.**
  - host: a context whose `agents.capabilities` returns `null` until `awaitAgent` resolves, then `['claude']`; `resolveHost` answers `ready` (not `offline`) and `awaitAgent` was called with the chosen machine. A second test: `awaitAgent` resolves `false` → `{ kind: 'offline' }`.
  - control/terminals: with `agents.awaitAgent` mocked to resolve `true` after the machine attaches (use a real `AgentRegistry` from the test's existing setup or spy `agents.awaitAgent`), a send/read on a moving machine proceeds; with it resolving `false`, the call rejects with the existing offline error (503 `AGENT_OFFLINE`).
  - control/screen: same pair for `readScreen`.
  - errors: `agentRpc` awaits `agents.awaitAgent(machine)` before `agents.rpc` (spy both; assert call order).

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.**
  - `chat/host.ts`: add `awaitAgent` to `HostAgents`; in `resolveHost`, right before `const capabilities = ctx.agents.capabilities(machine.id);` add `await ctx.agents.awaitAgent(machine);` with the comment `// a host moving between instances (a deploy) gets a few seconds before the message is answered "offline"`. Update every place that builds a `HostContext` (grep `agents:` in `chat/`) — the real one passes the `agents` singleton, which already has the method; test fakes add `awaitAgent: async () => true`.
  - `control/terminals.ts`:
    ```ts
    async function assertReady(machine: Machine): Promise<void> {
      if (machine.type !== 'agent') return;
      if (!(await agents.awaitAgent(machine))) throw offline();
      requireAgentVersion(machine, TERMINAL_RPC_MIN_AGENT_VERSION); // HttpError 409 AGENT_OUTDATED
    }
    ```
    and `await assertReady(machine)` at every call site (grep `assertReady(`).
  - `control/screen.ts`: `if (machine.type === 'agent' && !(await agents.awaitAgent(machine))) throw offline();`
  - `agent/errors.ts` `agentRpc`: first line inside `try`: `await agents.awaitAgent(machine);` (an offline result falls through to `agents.rpc`, which throws `AgentOfflineError` → `toHttpError` → 503 as today).
- [ ] **Step 4: Run** `npm test -w @termhub/server -- src/chat/host src/control src/agent` and `npm run typecheck -w @termhub/server` → PASS. **Commit:** `Chat and terminal control: wait for an agent moving between instances`.

---

### Task 4: Drain on SIGTERM and `/api/ready`

**Files:**
- Modify: `apps/server/src/ws/drain.ts`
- Modify: `apps/server/src/ws/router.ts` (refuse upgrades while draining)
- Modify: `apps/server/src/app.ts` (collect the WebSocket servers, `/api/ready`, return `drain`, resume sweep on `online`)
- Modify: `apps/server/src/mobile/app.ts` only if needed to expose its `chatWs` (it already returns/holds it — check)
- Modify: `apps/server/src/index.ts`
- Test: `apps/server/src/ws/drain.test.ts` (new), `apps/server/src/ws/router.test.ts`, a route test for `/api/ready` next to the existing app-level tests (`routes/machines.test.ts` shows how `buildApp` is exercised)

**Interfaces:**
- Consumes: `RESTART_CLOSE` (Task 2), `agents.closeAll` (Task 1).
- Produces (`ws/drain.ts`):
  ```ts
  export interface Lifecycle { readonly draining: boolean; startDraining(): void }
  export function createLifecycle(): Lifecycle;
  export async function closeSockets(servers: Iterable<WebSocketServer>, opts: { code?: number; reason?: string; budgetMs?: number }): Promise<void>;
  export async function drain(deps: { lifecycle: Lifecycle; suspend: () => Promise<void>; closeAgents: () => number; servers: WebSocketServer[]; log: FastifyBaseLogger; budgetMs?: number }): Promise<void>;
  ```
  `buildApp()` returns `{ fastify, repos, auth, drain: () => Promise<void> }`. `createUpgradeRouter(server, { auth, lifecycle? })`.

- [ ] **Step 1: Failing tests — `ws/drain.test.ts`** (real `ws` servers on an ephemeral http port):

```ts
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { closeSockets, createLifecycle, drain, RESTART_CLOSE } from './drain.js';

async function serverWithClient() {
  const wss = new WebSocketServer({ noServer: true });
  const server = http.createServer();
  server.on('upgrade', (req, socket, head) => wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req)));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const client = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}/`);
  const closed = new Promise<{ code: number; reason: string }>((r) => client.on('close', (code, reason) => r({ code, reason: reason.toString() })));
  await new Promise((r) => client.on('open', r));
  return { wss, server, client, closed };
}

describe('drain', () => {
  it('closes every client with 1012', async () => {
    const a = await serverWithClient();
    await closeSockets([a.wss], { reason: 'service restart' });
    await expect(a.closed).resolves.toEqual({ code: RESTART_CLOSE, reason: 'service restart' });
    a.server.close();
  });
  it('terminates sockets that do not close within the budget', async () => {
    const a = await serverWithClient();
    // a client that never answers the close handshake
    (a.client as unknown as { _socket: { pause(): void } })._socket.pause();
    const started = Date.now();
    await closeSockets([a.wss], { budgetMs: 200 });
    expect(Date.now() - started).toBeLessThan(1500);
    expect(a.wss.clients.size).toBe(0);
    a.server.close();
  });
  it('drain: marks draining, suspends, closes agents before the other sockets', async () => {
    const order: string[] = [];
    const lifecycle = createLifecycle();
    const a = await serverWithClient();
    a.client.on('close', () => order.push('socket'));
    await drain({
      lifecycle,
      suspend: async () => { order.push(`suspend:${lifecycle.draining}`); },
      closeAgents: () => { order.push('agents'); return 1; },
      servers: [a.wss],
      log: { info: vi.fn(), warn: vi.fn() } as never,
    });
    await a.closed;
    expect(order).toEqual(['suspend:true', 'agents', 'socket']);
    a.server.close();
  });
  it('drain: a failing suspend does not stop the rest', async () => {
    const a = await serverWithClient(); const closeAgents = vi.fn(() => 0);
    await drain({ lifecycle: createLifecycle(), suspend: async () => { throw new Error('db down'); }, closeAgents, servers: [a.wss], log: { info: vi.fn(), warn: vi.fn() } as never });
    expect(closeAgents).toHaveBeenCalled();
    await expect(a.closed).resolves.toMatchObject({ code: RESTART_CLOSE });
    a.server.close();
  });
});
```
Router test (in `ws/router.test.ts`, following its existing setup): with `lifecycle.startDraining()` called, an upgrade to a registered route gets HTTP 503 and the handler is not called — both for a cookie route and a public route.

`/api/ready` test (follow `routes/machines.test.ts`'s way of building the app and injecting): `GET /api/ready` → 200 `{ ok: true }`; after `await app.drain()`, → 503 `{ ok: false, reason: 'draining' }`. The database-down case: unit-test the handler through an exported `readinessCheck(query: () => Promise<unknown>, lifecycle: Lifecycle, timeoutMs = 2000)` in `drain.ts` with a query that rejects → `{ status: 503, body: { ok: false, reason: 'database' } }`, and one that never resolves → same after the timeout (use fake timers).

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement `ws/drain.ts`:**

```ts
import type { FastifyBaseLogger } from 'fastify';
import { WebSocket, type WebSocketServer } from 'ws';

/** Close code for "this server is restarting / the machine is reconnecting": clients reconnect at once (spec 2026-09-27). */
export const RESTART_CLOSE = 1012;
const DRAIN_BUDGET_MS = 15_000;
const SOCKET_BUDGET_MS = 3_000;

export interface Lifecycle {
  readonly draining: boolean;
  startDraining(): void;
}

export function createLifecycle(): Lifecycle {
  let draining = false;
  return {
    get draining() {
      return draining;
    },
    startDraining() {
      draining = true;
    },
  };
}

/** Closes every client of these servers with `code`, then terminates whatever has not finished the handshake in `budgetMs`. */
export async function closeSockets(servers: Iterable<WebSocketServer>, opts: { code?: number; reason?: string; budgetMs?: number } = {}): Promise<void> {
  const clients = [...servers].flatMap((s) => [...s.clients]);
  const done = clients.map((ws) => new Promise<void>((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) return resolve();
    ws.once('close', () => resolve());
    ws.close(opts.code ?? RESTART_CLOSE, opts.reason ?? 'service restart');
  }));
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([Promise.all(done), new Promise<void>((r) => (timer = setTimeout(r, opts.budgetMs ?? SOCKET_BUDGET_MS)))]);
  clearTimeout(timer);
  for (const ws of clients) if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
}

/**
 * The handover on SIGTERM (spec 2026-09-27 §5.2): stop taking new sockets, release the live chat runs, send the agents to
 * the other colour, then every other client. Each step logs and carries on if it fails; the whole thing is bounded.
 */
export async function drain(deps: {
  lifecycle: Lifecycle;
  suspend: () => Promise<void>;
  closeAgents: () => number;
  servers: WebSocketServer[];
  log: Pick<FastifyBaseLogger, 'info' | 'warn'>;
  budgetMs?: number;
}): Promise<void> {
  const started = Date.now();
  deps.lifecycle.startDraining();
  const steps = (async () => {
    await deps.suspend().catch((err: unknown) => deps.log.warn({ err: err instanceof Error ? err.message : String(err) }, 'drain: suspend failed'));
    const agentsClosed = deps.closeAgents();
    await closeSockets(deps.servers);
    deps.log.info({ agents: agentsClosed, ms: Date.now() - started }, 'drain: sockets handed over');
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([steps, new Promise<void>((r) => (timer = setTimeout(() => { deps.log.warn({}, 'drain: budget exceeded'); r(); }, deps.budgetMs ?? DRAIN_BUDGET_MS)))]);
  clearTimeout(timer);
}

/** `/api/ready`: the database answers and this process is not draining. */
export async function readinessCheck(query: () => Promise<unknown>, lifecycle: Lifecycle, timeoutMs = 2_000): Promise<{ status: number; body: { ok: boolean; reason?: 'database' | 'draining' } }> {
  if (lifecycle.draining) return { status: 503, body: { ok: false, reason: 'draining' } };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([query(), new Promise((_, reject) => (timer = setTimeout(() => reject(new Error('timeout')), timeoutMs)))]);
    return { status: 200, body: { ok: true } };
  } catch {
    return { status: 503, body: { ok: false, reason: 'database' } };
  } finally {
    clearTimeout(timer);
  }
}
```
Note: agent sockets are closed by `closeAgents` (each `AgentConnection.close`) — the agent `WebSocketServer` is also in `servers`, and closing an already-closing socket is harmless.

- **Router:** `createUpgradeRouter(server, deps: { auth: AuthContext; lifecycle?: Lifecycle })`; first line inside the `upgrade` listener after the `socket.on('error')`: `if (deps.lifecycle?.draining) return rejectUpgrade(socket, 503, 'Service Unavailable');`
- **app.ts:**
  - `const lifecycle = createLifecycle();` and pass it to `createUpgradeRouter`.
  - Collect the servers: `const sockets: WebSocketServer[] = [registerTerminalWs(...), registerAgentWs(...), simWs, registerMonitorWs(...), registerChatWs(...), registerPublicWs(...)]` (check each register function's return type; `registerSimulatorWs` and `registerPublicWs` must return their `WebSocketServer` — change their return if they return something else, keeping existing callers working). Add the mobile chat server when `mobile` is set (`registerMobileApi`/`mobile/app.ts` holds `chatWs`; expose it on the returned object and push it).
  - Route: `api.get('/ready', { config: { public: true } }, async (_req, reply) => { const r = await readinessCheck(() => prisma.$queryRaw\`SELECT 1\`, lifecycle); return reply.code(r.status).send(r.body); });` — use whatever the repositories layer exposes for a raw ping (routes never import Prisma: add `ping(): Promise<void>` to an existing repository module, e.g. `db/repositories/index.ts` returns `{ ..., ping: () => prisma.$queryRaw\`SELECT 1\`.then(() => undefined) }`, and call `repos.ping()`).
  - Resume on agent online: `const onAgentOnline = debounce(() => void chat.resumeSweep().catch(() => {}), 1000)` — write a tiny local trailing-edge debounce (no new dependency): `let t: ReturnType<typeof setTimeout> | undefined; const onAgentOnline = () => { if (t) return; t = setTimeout(() => { t = undefined; void chat.resumeSweep().catch(() => {}); }, 1000); t.unref(); };` `agents.on('online', onAgentOnline);` and in `onClose`: `agents.off('online', onAgentOnline); clearTimeout(t);`
  - Return `drain: () => drain({ lifecycle, suspend: () => chat.suspendAll(), closeAgents: () => agents.closeAll(RESTART_CLOSE, 'service restart'), servers: sockets, log: fastify.log })`.
- **index.ts:**
  ```ts
  const { fastify, drain } = await buildApp();
  …
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    fastify.log.info(`${signal} recebido, encerrando...`);
    // Hand the sockets over first (spec 2026-09-27 §5.2): upgraded sockets would otherwise keep close() waiting until the kill.
    await drain();
    await fastify.close();
    process.exit(0);
  };
  ```
- [ ] **Step 4: Run** `npm test -w @termhub/server -- src/ws src/routes/machines` and typecheck → PASS.
- [ ] **Step 5: Commit** `Server: drain sockets on SIGTERM and answer /api/ready`.

---

### Task 5: Web clients reconnect at once on 1012

**Files:**
- Modify: `apps/web/src/lib/terminal-connection.ts`
- Modify: `apps/web/src/lib/chat.tsx`, `apps/web/src/lib/monitor.tsx`
- Test: `apps/web/src/lib/terminal-connection.test.ts`, `apps/web/src/lib/monitor.test.tsx` (and a chat test if one covers the socket; otherwise add a focused one for the delay helper)

**Interfaces:**
- Produces: `export function reconnectDelay(code: number, fallbackMs: number, rand = Math.random): number` in a new `apps/web/src/lib/reconnect.ts` — `code === 1012 ? 250 + 500 * rand() : fallbackMs`.

- [ ] **Step 1: Failing tests** (`terminal-connection.test.ts`, with its `FakeSocket` and fake timers):

```ts
  it('reconnects quickly on 1012 without spending an attempt', () => {
    const { states } = start();
    last().open(); last().message({ type: 'ready' });
    last().serverClose(1012);
    expect(states.at(-1)).toEqual(['reconnecting', 0]);
    vi.advanceTimersByTime(760);
    expect(FakeSocket.all).toHaveLength(2);
  });
  it('several 1012 in a row never reach offline', () => {
    const { states } = start();
    for (let i = 0; i < 12; i++) { last().serverClose(1012); vi.advanceTimersByTime(760); }
    expect(states.some(([s]) => s === 'offline')).toBe(false);
  });
  it('exit frame then 1012 stays closed', () => {
    const { states } = start();
    last().open(); last().message({ type: 'exit', code: 0 });
    last().serverClose(1012);
    expect(states.at(-1)?.[0]).toBe('closed');
    vi.advanceTimersByTime(2000);
    expect(FakeSocket.all).toHaveLength(1);
  });
```
`reconnect.test.ts`: `reconnectDelay(1012, 5000, () => 0) === 250`, `(…, () => 1) === 750`, `reconnectDelay(1006, 5000) === 5000`.
Monitor/chat: with a fake WebSocket, a close with code 1012 reopens within 750 ms; a close with 1006 waits the 5 s.

- [ ] **Step 2: Run** `npm test -w @termhub/web -- src/lib/terminal-connection.test.ts src/lib/reconnect.test.ts src/lib/monitor.test.tsx` → FAIL.
- [ ] **Step 3: Implement.**
  - `reconnect.ts`:
    ```ts
    /** 1012 = the server is restarting (a deploy) or the machine is reconnecting: come back right away (spec 2026-09-27 §5.5). */
    export const RESTART_CLOSE = 1012;
    export function reconnectDelay(code: number, fallbackMs: number, rand: () => number = Math.random): number {
      return code === RESTART_CLOSE ? 250 + 500 * rand() : fallbackMs;
    }
    ```
  - `terminal-connection.ts` `onclose`, after the `exited` and 1008/4001 checks:
    ```ts
      // A deploy or an agent reconnecting (1012): not a failure — come back right away and keep the attempts.
      if (ev.code === RESTART_CLOSE) {
        this.attempt = 0;
        this.setState('reconnecting');
        this.timer = setTimeout(() => this.open(), reconnectDelay(ev.code, 0));
        return;
      }
    ```
    (`open()` sets `'connecting'` when `attempt === 0`; keep "Reconectando…" by passing a flag: add `private restarting = false`, set it here, and in `open()` use `this.setState(this.attempt === 0 && !this.restarting ? 'connecting' : 'reconnecting')`; clear it on `ready`.) The test expects `['reconnecting', 0]`.
  - `chat.tsx` / `monitor.tsx`: `ws.onclose = (ev) => { …; if (!stopped) timer = setTimeout(open, reconnectDelay(ev.code, RECONNECT_MS)); };`
- [ ] **Step 4: Run** the web tests and `npm run build -w @termhub/web` → PASS. **Commit** `Web: reconnect at once when the server restarts (1012)`.

---

### Task 6: Deploy script, compose, workflow and docs

**Files:**
- Modify: `deploy/blue-green.sh` (`retire_old`, header comment)
- Modify: `docker-compose.yml` (`x-app` healthcheck → `/api/ready`, `stop_grace_period: 30s`)
- Modify: `.github/workflows/deploy.yml` (`workflow_dispatch`, deploy `if`)
- Modify: `CLAUDE.md` (the deploy paragraph), `README.md` if it describes the 30 s grace (grep "grace")

- [ ] **Step 1: `retire_old`** becomes:

```bash
# After the switch: a short pause so requests in flight on the old nginx workers finish against the old colour,
# then SIGTERM it. The server drains (spec 2026-09-27 §5.2): it releases its chat runs, sends the agents to the
# new colour with close 1012, then every browser socket, and exits. -t 30 is the upper bound before Docker kills
# it; exit 137 in the log below means the drain did not finish. Colors are only stopped, never removed, so a
# rollback is a plain `docker start`; legacy is renamed to termhub-app-legacy and stopped (not removed).
retire_old() {
  local old="$1"
  local delay="${DRAIN_DELAY:-3}"

  if [ "$DRY_RUN" = "1" ]; then
    log "DRY_RUN: sleep $delay (in-flight requests on the old nginx workers)"
  else
    sleep "$delay"
  fi

  case "$old" in
    blue | green)
      local t0=$SECONDS
      run "stop app-$old (drains; kept for rollback)" "${COMPOSE[@]}" stop -t 30 "app-$old"
      if [ "$DRY_RUN" != "1" ]; then
        log "app-$old stopped in $((SECONDS - t0))s, exit code $(docker inspect --format '{{.State.ExitCode}}' "termhub-app-$old" 2>/dev/null || echo '?')"
      fi
      ;;
    …legacy / none unchanged…
```
Keep the legacy/none branches and the `termhub-app-legacy` cleanup as they are. In `rollback()`, change the final stop to `"${COMPOSE[@]}" stop -t 30 "app-$current"`. Update the header comment ("retires the previously active container after a grace period … reconnect when it is finally stopped") to describe the drain. Add `DRAIN_DELAY` to the env var list in the header.

- [ ] **Step 2: Verify the script** without touching anything:
```bash
DRY_RUN=1 PROXY_CONF=/nonexistent STATE_FILE="$(mktemp -d)/active-color" bash deploy/blue-green.sh | tee /tmp/claude-dry.txt
grep -q 'stop -t 30' /tmp/claude-dry.txt && ! grep -q 'sleep 30' /tmp/claude-dry.txt && echo OK
bash -n deploy/blue-green.sh && echo SYNTAX-OK
```
(DRY_RUN still calls `docker ps` read-only to detect state; that is fine.)

- [ ] **Step 3: compose** (`x-app`):
```yaml
  # SIGTERM starts the drain (spec 2026-09-27 §5.2); 30 s bounds it before Docker kills the process.
  stop_grace_period: 30s
  healthcheck:
    # ready = the database answers and the process is not draining (/api/health only says the process is up)
    test: ["CMD-SHELL", "wget -qO- http://127.0.0.1:3000/api/ready || exit 1"]
```
Check: `docker compose -f docker-compose.yml -f docker-compose.proxy.yml --profile prod config >/dev/null && echo OK` (needs an env file; use `--env-file .env.example` if `.env` is absent).

- [ ] **Step 4: deploy.yml:** add `workflow_dispatch:` under `on:`; deploy job `if: (github.event_name == 'push' || github.event_name == 'workflow_dispatch') && github.ref == 'refs/heads/main'`. Comment: `# workflow_dispatch: re-run a deploy of main without an empty commit (e.g. to prove a deploy keeps terminals up).`

- [ ] **Step 5: Docs.** In `CLAUDE.md`, the "A push to `main` deploys…" bullet: replace "then retires the old container after a grace period — … open terminal WebSockets pinned to the old container reconnect (to the new one) when it stops" with a sentence saying the old container is stopped right after the switch and drains on SIGTERM (agents first, then browsers, close 1012), the new one waits a few seconds for agents that are moving, so open terminals show "Reconectando…" for a moment and keep their tmux session; `gh workflow run "CI e Deploy" --ref main` re-runs a deploy. Same change in README if it describes the grace period.

- [ ] **Step 6: Commit** `Deploy: drain the old colour instead of killing it after 30 s`.

---

### Task 7: Full verification, PR and production proof (controller, not a subagent)

- [ ] Rebase on `origin/main`; full check in Docker (node:22), same commands as the CI `check` job that matter here: `npm ci`, `npm run prisma:generate` (no diff in `apps/server/src/generated`), `npm run build:packages`, `npm test -w @termhub/server` (with a `th-ter320-db` pgvector container and `TERMHUB_DB_TESTS=1` + migrations), `npm test -w @termhub/web`, typecheck server, build web/server/landing.
- [ ] Push, open the PR (English), wait for CI green; before merging, `gh run list --workflow "CI e Deploy" --branch main --limit 3` shows nothing in progress (otherwise wait and rebase again).
- [ ] Merge; follow the deploy; health checks (`docker ps --filter name=termhub-app`, local proxy `Host: app.termhub.dev` → 200, `Host: termhub.dev` → 200). This deploy retires a colour running the old code (spec §6).
- [ ] Second deploy with a probe: a tmux counter in a probe tab, a poll of `read_screen` via the MCP once a second, then `gh workflow run "CI e Deploy" --ref main`. Expected: old colour exit code 0, no "agente desconectado" on the new colour for tabs of connected agents, probe gap ≤ a few seconds, counter continuous.
- [ ] On failure in production: `bash deploy/blue-green.sh --rollback`, stop, record on the card.
- [ ] Card TER-320 → Feito with PR and commit.
