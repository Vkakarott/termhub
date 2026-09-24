# iOS Simulator over the termhub agent — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the existing WDA-based iOS simulator tab work on `agent` machines, with the same flow and UX it had over SSH.

**Architecture:** The agent protocol gains a loopback-only `tcp` stream kind (ports restricted to the WDA ranges) plus named `sim.*` / `wda.*` RPCs whose scripts live in `@termhub/machine-ops`. On the server a new `Tunnel` implementation listens on two local ports and pipes each accepted connection into a `tcp` channel, so `WdaClient`, the MJPEG reader, the session manager and `/ws/sim` stay untouched. The web app only unblocks the setup card and renders two new error messages.

**Tech Stack:** TypeScript, zod, `ws`, `node:net`, vitest, Fastify, React. Tests and typechecks run through Docker (`node:20`) because the host has no Node.

**Spec:** `docs/superpowers/specs/2026-09-24-ios-simulator-over-agent-design.md`

**Board:** epic **TER-7** on the TER project. One task below per card: TER-47, TER-43, TER-37, TER-31, TER-24, TER-17, TER-14, TER-11, TER-8. The orchestrator moves the card to *Fazendo* when a task starts and to *Feito* when it ends, and ticks its subtasks (listed per task as `☐ TER-nn`) as the matching steps land. Implementers do not touch the board.

## Global Constraints

- Branch: `feat/ios-simulator-agent` (created from `origin/main`; the spec is already committed there). Commit after every task; commit messages in English, imperative subject ≤ 72 chars, and end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- The host (jarvis) has no Node. Every `npm` command in this plan is written as `TH_NODE <command>`, which means:
  ```bash
  docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/w" -w /w node:20 sh -c '<command>'; rm -rf .npm
  ```
  Run it from the repo root. Example: `TH_NODE npm test -w @termhub/agent-protocol` ⇒ `docker run … sh -c 'npm test -w @termhub/agent-protocol'; rm -rf .npm`.
- `apps/server` and `apps/agent` consume the workspace packages through their `dist/` (package `main`). **After any change under `packages/`, run `TH_NODE npm run build:packages` before testing or typechecking the server or the agent**, or the old build is what gets tested.
- Never touch production containers (see CLAUDE.md). No `docker compose` here; only the throwaway `node:20` run above.
- The agent never receives shell text from the server: every machine operation is a named RPC with a constant script from `@termhub/machine-ops`; values reach a script only as shell variables assigned with `shellQuote` (server) or as `env` (agent).
- `port` for a `tcp` channel is only ever `8100–8199` or `9100–9199`, loopback only, validated by zod on both sides and re-checked by the agent's manager.
- `PROTOCOL_VERSION` stays `1`. Agent version becomes `0.5.0` (from `0.4.4`). Publishing is done by CI on merge; never `npm publish`.
- UI copy and error messages shown to people stay in pt-BR: `Agente desconectado`, `Máquina sem canais livres`, `Conecte o agente para preparar o simulador`, `Atualize o agente desta máquina (npm i -g @termhub/agent, versão 0.5.0 ou mais nova) para usar o simulador`.
- Logs carry metadata only (machine id, channel, port, byte counts, close codes); never frames, never typed text.
- No Prisma migration in this plan.

## Review Focus

1. **A `tcp` open for a port inside the ranges but with nothing listening** (WDA runner still starting): the agent must answer `open_error` with `code: 'refused'`, the server must destroy only that local socket, and the session manager's `/status` polling must keep going — covered by Task 3 (refused test) and Task 5 (refused does not fail the tunnel).
2. **A `tcp` open on the last free channel or beyond** (64 in use): the viewer must see `Máquina sem canais livres` and the connection to the machine must survive — Task 5 test with a registry that throws `ChannelLimitError`.
3. **Agent reconnects mid-session** (deploy): every `tcp` channel dies with the socket; the tunnel must report `onClose` once so the session manager recovers, not once per channel — Task 5 test "offline fires onClose exactly once".
4. **A MJPEG chunk larger than the frame limit** (a JPEG at scale 50 is ~160 KB, but a burst of buffered TCP data can exceed 1 MiB): `sendStream` must slice, never send an oversized frame that closes the whole agent socket with 1009 — Task 3 slicing test through a real `ws` server with `maxPayload: MAX_FRAME`.
5. **Server sends `resize` on a `tcp` channel or a `tcp` open with an out-of-range port** (a buggy or hostile server): the agent must refuse (`open_error invalid`) and never connect anywhere else than loopback — Task 3 range test with the default `allowPort`, Task 1 schema tests.

---

### Task 1: Protocol — `tcp` channel, `sim` capability, `sim.*`/`wda.*` RPCs  (card **TER-47**)

Subtasks: ☐ TER-48 open tcp + ports · ☐ TER-49 refused/reset · ☐ TER-50 CAPABILITY_SIM · ☐ TER-51 RPC catalog · ☐ TER-52 schema tests

**Files:**
- Modify: `packages/agent-protocol/src/rpc.ts`
- Modify: `packages/agent-protocol/src/messages.ts`
- Test: `packages/agent-protocol/src/rpc.test.ts`, `packages/agent-protocol/src/messages.test.ts`

**Interfaces:**
- Produces (from `@termhub/agent-protocol`): `UDID_RE: RegExp`, `udid: ZodString`, `isWdaPort(port: number): boolean`, `wdaPort: ZodNumber`, `CAPABILITY_SIM = 'sim'`, `tcpOpenParams` / `type TcpOpenParams = { port: number }`, `serverMessage` accepting `{ type: 'open', kind: 'tcp', params: TcpOpenParams }`, `rpcErrorSchema.code` including `'refused'`, `closedReason` including `'reset'`, and RPC entries `sim.list`, `sim.boot`, `wda.runner.start`, `wda.runner.alive`, `wda.runner.tail`, `wda.setup.start`, `wda.setup.state` with the params/results/timeouts of spec §3.3.

- [ ] **Step 1: Write the failing RPC catalog tests** (TER-51, TER-52)

Append to `packages/agent-protocol/src/rpc.test.ts` inside `describe('rpc catalog')`, and update the method list assertion:

```ts
  it('lists the v1 methods', () => {
    expect([...RPC_METHODS].sort()).toEqual([
      'agent.update', 'ai.credential', 'file.paste', 'fs.list', 'fs.mkdir', 'hooks.install', 'hooks.uninstall', 'hw.probe',
      'sim.boot', 'sim.list', 'tmux.capture', 'tmux.ensure', 'tmux.kill', 'tmux.list', 'tmux.sendKey', 'tmux.sendText', 'tools.detect',
      'wda.runner.alive', 'wda.runner.start', 'wda.runner.tail', 'wda.setup.start', 'wda.setup.state',
    ]);
  });
  it('validates udids and the WDA port ranges for the simulator rpcs', () => {
    const good = 'BAE07EB5-8CA8-4C6E-819A-A0240342FF00';
    expect(RPC['sim.boot'].params.safeParse({ udid: good }).success).toBe(true);
    expect(RPC['sim.boot'].params.safeParse({ udid: 'x; rm -rf /' }).success).toBe(false);
    expect(RPC['sim.boot'].timeoutMs).toBe(60_000);
    expect(RPC['sim.list'].timeoutMs).toBe(15_000);
    expect(RPC['wda.runner.start'].params.safeParse({ udid: good, wda_port: 8137, mjpeg_port: 9137 }).success).toBe(true);
    expect(RPC['wda.runner.start'].params.safeParse({ udid: good, wda_port: 8200, mjpeg_port: 9137 }).success).toBe(false);
    expect(RPC['wda.runner.start'].params.safeParse({ udid: good, wda_port: 8137, mjpeg_port: 22 }).success).toBe(false);
    expect(RPC['wda.runner.tail'].params.safeParse({ udid: good, lines: 30 }).success).toBe(true);
    expect(RPC['wda.runner.tail'].params.safeParse({ udid: good, lines: 0 }).success).toBe(false);
    expect(RPC['wda.runner.tail'].params.safeParse({ udid: good, lines: 201 }).success).toBe(false);
    expect(RPC['wda.setup.start'].params.safeParse({}).success).toBe(true);
    expect(RPC['wda.setup.state'].result.safeParse({ stdout: 'STATE:idle\n' }).success).toBe(true);
    expect(RPC['wda.runner.alive'].result.safeParse({ alive: true }).success).toBe(true);
    expect(RPC['wda.runner.tail'].result.safeParse({ lines: ['a', 'b'] }).success).toBe(true);
    expect(RPC['wda.runner.start'].result.safeParse({ started: false }).success).toBe(true);
  });
  it('knows the WDA port ranges', () => {
    expect(isWdaPort(8100)).toBe(true);
    expect(isWdaPort(8199)).toBe(true);
    expect(isWdaPort(9100)).toBe(true);
    expect(isWdaPort(9199)).toBe(true);
    expect(isWdaPort(8099)).toBe(false);
    expect(isWdaPort(8200)).toBe(false);
    expect(isWdaPort(9200)).toBe(false);
    expect(isWdaPort(80)).toBe(false);
    expect(isWdaPort(8100.5)).toBe(false);
  });
  it('accepts refused as an rpc error code', () => {
    expect(rpcErrorSchema.safeParse({ code: 'refused', message: 'nothing listening' }).success).toBe(true);
  });
```

Add `isWdaPort` to the import line: `import { RPC, RPC_METHODS, isWdaPort, rpcErrorSchema } from './rpc.js';`

- [ ] **Step 2: Write the failing message tests** (TER-48, TER-49, TER-50)

Append to `packages/agent-protocol/src/messages.test.ts`, inside the top-level `describe('control messages')`:

```ts
  describe('the tcp channel kind', () => {
    it('parses an open with kind: tcp and a port inside the WDA ranges', () => {
      const msg = serverMessage.parse({ type: 'open', ch: 2, kind: 'tcp', params: { port: 8137 } });
      if (msg.type !== 'open' || msg.kind !== 'tcp') throw new Error('expected an open/tcp message');
      expect(tcpOpenParams.parse(msg.params)).toEqual({ port: 8137 });
      expect(serverMessage.safeParse({ type: 'open', ch: 2, kind: 'tcp', params: { port: 9199 } }).success).toBe(true);
    });
    it('rejects ports outside 8100-8199 / 9100-9199, a host field, and non-integers', () => {
      for (const port of [22, 80, 8099, 8200, 9099, 9200, 65535, 8137.5]) {
        expect(serverMessage.safeParse({ type: 'open', ch: 2, kind: 'tcp', params: { port } }).success).toBe(false);
      }
      expect(tcpOpenParams.safeParse({ port: 8137, host: '10.0.0.1' }).success).toBe(false);
      expect(tcpOpenParams.safeParse({}).success).toBe(false);
    });
    it('rejects kind: tcp paired with pty-shaped params', () => {
      expect(serverMessage.safeParse({ type: 'open', ch: 2, kind: 'tcp', params: { session: 'a', cwd: '/tmp', cols: 80, rows: 24 } }).success).toBe(false);
    });
    it('accepts reset as a closed reason', () => {
      expect(agentMessage.safeParse({ type: 'closed', ch: 2, code: null, reason: 'reset' }).success).toBe(true);
    });
    it('names the sim capability', () => {
      expect(CAPABILITY_SIM).toBe('sim');
      expect(helloMessage.parse({ ...hello, capabilities: ['claude', 'sim'] }).capabilities).toContain('sim');
    });
  });
```

Extend the import: `import { agentMessage, CAPABILITY_SIM, claudeOpenParams, helloMessage, ptyOpenParams, serverMessage, tcpOpenParams, PROTOCOL_VERSION } from './messages.js';`

`tcpOpenParams` must be a `z.object(...).strict()` so the `host` field test fails as intended.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `TH_NODE npm test -w @termhub/agent-protocol`
Expected: FAIL — `isWdaPort`, `tcpOpenParams`, `CAPABILITY_SIM` are not exported; the method list differs.

- [ ] **Step 4: Implement the protocol additions**

In `packages/agent-protocol/src/rpc.ts`, after `export const aiProvider = …`:

```ts
/** Simulator UDID as `xcrun simctl` prints it. The same regex lives in `@termhub/machine-ops`
 *  (`simulator.ts`), which cannot depend on this package; the server's tests assert they match. */
export const UDID_RE = /^[A-Fa-f0-9-]{8,64}$/;
export const udid = z.string().regex(UDID_RE);

/** The only ports a `tcp` channel may reach on the machine: the WDA runner's HTTP (8100–8199) and MJPEG
 *  (9100–9199) ports, derived from the UDID in `apps/server/src/simulator/ports.ts`. Loopback only. */
export function isWdaPort(port: number): boolean {
  return Number.isInteger(port) && ((port >= 8100 && port <= 8199) || (port >= 9100 && port <= 9199));
}
export const wdaPort = z.number().int().refine(isWdaPort, 'port outside the WDA ranges');
```

Change `rpcErrorSchema.code` to `z.enum(['eperm', 'notfound', 'no_tmux', 'timeout', 'invalid', 'internal', 'failed', 'refused'])` and add to its doc comment: `` `refused`: a `tcp` open found nothing listening on the port (ECONNREFUSED). ``

Add to the `RPC` object, before the closing `} as const;`:

```ts
  /** iOS simulator over the agent (spec 2026-09-24): raw `xcrun simctl list devices -j`; the server parses it. */
  'sim.list': def(z.object({}), z.object({ stdout: z.string() }), 15_000),
  /** `xcrun simctl boot`; combined output, "already booted" included — the server decides what is a failure. */
  'sim.boot': def(z.object({ udid }), z.object({ stdout: z.string() }), 60_000),
  /** Starts the WDA runner in its tmux session; `started: false` when the session already existed. */
  'wda.runner.start': def(z.object({ udid, wda_port: wdaPort, mjpeg_port: wdaPort }), z.object({ started: z.boolean() }), 10_000),
  'wda.runner.alive': def(z.object({ udid }), z.object({ alive: z.boolean() })),
  'wda.runner.tail': def(z.object({ udid, lines: z.number().int().min(1).max(200) }), z.object({ lines: z.array(z.string()) })),
  /** Writes ~/.termhub/wda-setup.sh and runs it in tmux `termhub-wda-setup`; `started: false` when already running. */
  'wda.setup.start': def(z.object({}), z.object({ started: z.boolean() }), 10_000),
  /** Raw `STATE:/VERSION:/TAIL:` text; `parseSetupOutput` on the server reads it. */
  'wda.setup.state': def(z.object({}), z.object({ stdout: z.string() })),
```

In `packages/agent-protocol/src/messages.ts`:

- Import: `import { rpcErrorSchema, rpcMethod, sessionName, machinePath, wdaPort } from './rpc.js';`
- `closedReason`: add `'reset'` → `z.enum(['cli_missing', 'run_failed', 'killed', 'missing_session', 'cli_rejected', 'reset'])`, with a comment line: `// \`reset\`: a tcp channel's local socket reset or errored after it had connected.`
- After `CAPABILITY_CLAUDE_SYSTEM_PROMPT`:
  ```ts
  /** The agent runs the iOS simulator operations (`sim.*` / `wda.*` RPCs) and opens `tcp` channels to the WDA
   *  ports (spec 2026-09-24). Advertised on macOS only; the server requires it before any of those. */
  export const CAPABILITY_SIM = 'sim';
  ```
- After `claudeOpenParams`:
  ```ts
  /** A raw TCP pipe to `127.0.0.1:<port>` on the machine. No host on purpose: loopback only, and only the
   *  WDA port ranges — the agent re-checks before connecting. `strict` so a future `host` cannot sneak in. */
  export const tcpOpenParams = z.object({ port: wdaPort }).strict();
  const openTcp = z.object({ type: z.literal('open'), ch: channel, kind: z.literal('tcp'), params: tcpOpenParams });
  ```
- Add `openTcp` to the `serverMessage` union after `openClaude`.
- Add `export type TcpOpenParams = z.infer<typeof tcpOpenParams>;` at the bottom.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `TH_NODE npm test -w @termhub/agent-protocol`
Expected: PASS (all files).

- [ ] **Step 6: Rebuild the packages and typecheck the consumers**

Run: `TH_NODE npm run build:packages && npm run typecheck -w @termhub/server && npm run typecheck -w @termhub/agent`
Expected: PASS. (The agent's `Handlers` type is a mapped type over `RpcMethod`, so `apps/agent/src/rpc/index.ts` will now fail to typecheck: the new methods have no handler yet.) If it fails only with "Property 'sim.list' is missing … in type Handlers", add temporary stubs to `apps/agent/src/rpc/index.ts` so the tree stays green until Task 4:

```ts
const notYet = async (): Promise<never> => {
  throw new RpcFailure('internal', 'not implemented');
};
```
and in `handlers`: `'sim.list': notYet, 'sim.boot': notYet, 'wda.runner.start': notYet, 'wda.runner.alive': notYet, 'wda.runner.tail': notYet, 'wda.setup.start': notYet, 'wda.setup.state': notYet,` (import `RpcFailure` from `'../exec.js'` at the top if it is not already imported as a value). Task 4 replaces these.

- [ ] **Step 7: Commit**

```bash
git add packages/agent-protocol apps/agent/src/rpc/index.ts
git commit -m "Protocol: tcp channel kind, sim capability and sim/wda rpcs

Adds the loopback-only tcp stream kind restricted to the WDA port
ranges, the refused error code and reset close reason, the sim
capability and the named RPCs the agent-side simulator needs
(spec 2026-09-24-ios-simulator-over-agent-design.md §3).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Move the simulator scripts to `@termhub/machine-ops`  (card **TER-43**)

Subtasks: ☐ TER-44 simulator.ts · ☐ TER-45 server imports · ☐ TER-46 script tests

**Files:**
- Create: `packages/machine-ops/src/simulator.ts`, `packages/machine-ops/src/simulator.test.ts`
- Modify: `packages/machine-ops/src/index.ts`
- Modify: `apps/server/src/simulator/machine.ts`, `apps/server/src/simulator/setup.ts`, `apps/server/src/simulator/ports.ts`
- Test: `apps/server/src/simulator/machine.test.ts` (one new test), `apps/server/src/simulator/setup.test.ts` (unchanged, must still pass)

**Interfaces:**
- Produces (from `@termhub/machine-ops`): `WDA_DIR`, `WDA_SETUP_SESSION`, `UDID_RE`, `assertUdid(udid)`, `runnerSessionName(udid)`, `withVars(vars: Record<string,string>, script: string): string`, and the constants `SIMCTL_LIST_SCRIPT`, `SIMCTL_BOOT_SCRIPT` (`$UDID`), `WDA_RUNNER_START_SCRIPT` (`$SESSION $UDID $WDA_PORT $MJPEG_PORT`), `WDA_RUNNER_ALIVE_SCRIPT` (`$SESSION`), `WDA_RUNNER_TAIL_SCRIPT` (`$SESSION $LINES`), `WDA_SETUP_SH` (file content), `WDA_SETUP_START_SCRIPT`, `WDA_SETUP_STATE_SCRIPT`.
- Consumes: `shellQuote` from `./shell.js`.

- [ ] **Step 1: Write the failing machine-ops tests** (TER-46)

`packages/machine-ops/src/simulator.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  SIMCTL_BOOT_SCRIPT,
  SIMCTL_LIST_SCRIPT,
  UDID_RE,
  WDA_DIR,
  WDA_RUNNER_ALIVE_SCRIPT,
  WDA_RUNNER_START_SCRIPT,
  WDA_RUNNER_TAIL_SCRIPT,
  WDA_SETUP_SESSION,
  WDA_SETUP_SH,
  WDA_SETUP_START_SCRIPT,
  WDA_SETUP_STATE_SCRIPT,
  assertUdid,
  runnerSessionName,
  withVars,
} from './simulator.js';

const UDID = 'BAE07EB5-8CA8-4C6E-819A-A0240342FF00';

describe('udid and session names', () => {
  it('accepts simctl udids and rejects shell syntax', () => {
    expect(UDID_RE.test(UDID)).toBe(true);
    expect(() => assertUdid(UDID)).not.toThrow();
    expect(() => assertUdid('abc; rm -rf /')).toThrow(/UDID/);
    expect(() => assertUdid('')).toThrow();
  });
  it('derives the tmux session name from the first 8 chars of the udid, lowercased', () => {
    expect(runnerSessionName(UDID)).toBe('termhub-wda-bae07eb5');
  });
});

describe('withVars', () => {
  it('prefixes shell assignments, single-quoted, before the script', () => {
    expect(withVars({ UDID: UDID, LINES: '30' }, 'echo "$UDID"')).toBe(`UDID='${UDID}'; LINES='30'; echo "$UDID"`);
  });
  it('quotes a value with a single quote so it cannot break out', () => {
    expect(withVars({ X: "a'b" }, 'true')).toBe(`X='a'\\''b'; true`);
  });
});

describe('scripts only read their parameters from variables', () => {
  it('simctl scripts', () => {
    expect(SIMCTL_LIST_SCRIPT).toBe('xcrun simctl list devices -j');
    expect(SIMCTL_BOOT_SCRIPT).toContain('xcrun simctl boot "$UDID"');
  });
  it('runner scripts use $SESSION/$UDID/$WDA_PORT/$MJPEG_PORT/$LINES and the WDA checkout', () => {
    expect(WDA_RUNNER_START_SCRIPT).toContain('tmux new-session -d -s "$SESSION"');
    expect(WDA_RUNNER_START_SCRIPT).toContain('-destination id=$UDID');
    expect(WDA_RUNNER_START_SCRIPT).toContain('USE_PORT=$WDA_PORT MJPEG_SERVER_PORT=$MJPEG_PORT');
    expect(WDA_RUNNER_START_SCRIPT).toContain(WDA_DIR);
    expect(WDA_RUNNER_ALIVE_SCRIPT).toContain(`tmux has-session -t "=$SESSION"`);
    expect(WDA_RUNNER_TAIL_SCRIPT).toContain(`tmux capture-pane -p -t "=$SESSION"`);
    expect(WDA_RUNNER_TAIL_SCRIPT).toContain('tail -n "$LINES"');
  });
  it('setup scripts: file content, start (idempotent) and state', () => {
    expect(WDA_SETUP_SH).toContain('git clone --depth 1 https://github.com/appium/WebDriverAgent');
    expect(WDA_SETUP_SH).toContain('CODE_SIGNING_ALLOWED=NO');
    expect(WDA_SETUP_SH).toContain('wda-setup.status');
    expect(WDA_SETUP_START_SCRIPT).toContain(`tmux has-session -t '=${WDA_SETUP_SESSION}'`);
    expect(WDA_SETUP_START_SCRIPT).toContain('echo STARTED:no');
    expect(WDA_SETUP_START_SCRIPT).toContain('echo STARTED:yes');
    expect(WDA_SETUP_START_SCRIPT).toContain(WDA_SETUP_SH);
    expect(WDA_SETUP_STATE_SCRIPT).toContain('echo STATE:running');
    expect(WDA_SETUP_STATE_SCRIPT).toContain('echo VERSION:');
    expect(WDA_SETUP_STATE_SCRIPT).toContain('echo TAIL:');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `TH_NODE npm test -w @termhub/machine-ops`
Expected: FAIL — `./simulator.js` not found.

- [ ] **Step 3: Create `packages/machine-ops/src/simulator.ts`** (TER-44)

```ts
import { shellQuote } from './shell.js';

/**
 * iOS simulator scripts (WebDriverAgent runner, `xcrun simctl`, WDA setup). The server runs them over
 * ssh/local through `runOnMachine` and the agent through `sh()`; both only ever pass values as shell
 * variables (`withVars` / env), never by interpolating into the script text.
 */

export const WDA_DIR = '$HOME/.termhub/WebDriverAgent';
export const WDA_SETUP_SESSION = 'termhub-wda-setup';

/** Same regex as `UDID_RE` in `@termhub/agent-protocol` (which cannot import this package). */
export const UDID_RE = /^[A-Fa-f0-9-]{8,64}$/;
export function assertUdid(udid: string): void {
  if (!UDID_RE.test(udid)) throw new Error(`UDID inválido: ${udid}`);
}

/** tmux session where the WDA runner of one device runs on the machine. */
export function runnerSessionName(udid: string): string {
  return `termhub-wda-${udid.slice(0, 8).toLowerCase()}`;
}

/** `A='x'; B='y'; <script>` — values single-quoted so they are data to the shell, never syntax. */
export function withVars(vars: Record<string, string>, script: string): string {
  const assigns = Object.entries(vars).map(([k, v]) => `${k}=${shellQuote(v)}`);
  return `${assigns.join('; ')}; ${script}`;
}

export const SIMCTL_LIST_SCRIPT = 'xcrun simctl list devices -j';
/** Reads $UDID. "already booted" comes back on stdout with exit 0 (the `|| true`); the caller decides. */
export const SIMCTL_BOOT_SCRIPT = 'xcrun simctl boot "$UDID" 2>&1 || true';

/** Reads $SESSION, $UDID, $WDA_PORT, $MJPEG_PORT. Exit 1 with "duplicate session" when it already runs. */
export const WDA_RUNNER_START_SCRIPT =
  `tmux new-session -d -s "$SESSION" "cd ${WDA_DIR} && xcodebuild test-without-building -project WebDriverAgent.xcodeproj ` +
  `-scheme WebDriverAgentRunner -destination id=$UDID -derivedDataPath DerivedData USE_PORT=$WDA_PORT MJPEG_SERVER_PORT=$MJPEG_PORT"`;
/** Reads $SESSION; prints yes/no. */
export const WDA_RUNNER_ALIVE_SCRIPT = `tmux has-session -t "=$SESSION" 2>/dev/null && echo yes || echo no`;
/** Reads $SESSION, $LINES; last non-empty lines of the runner's pane. */
export const WDA_RUNNER_TAIL_SCRIPT = `tmux capture-pane -p -t "=$SESSION" 2>/dev/null | grep -v '^$' | tail -n "$LINES"`;

/** Content of ~/.termhub/wda-setup.sh: clone/pull + build-for-testing, log and status under ~/.termhub. */
export const WDA_SETUP_SH = [
  '#!/bin/sh',
  'export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"',
  'mkdir -p "$HOME/.termhub"',
  'rm -f "$HOME/.termhub/wda-setup.status"',
  '{',
  `  if [ -d "${WDA_DIR}/.git" ]; then git -C "${WDA_DIR}" pull --ff-only; else git clone --depth 1 https://github.com/appium/WebDriverAgent "${WDA_DIR}"; fi &&`,
  `  cd "${WDA_DIR}" &&`,
  "  xcodebuild build-for-testing -project WebDriverAgent.xcodeproj -scheme WebDriverAgentRunner -destination 'generic/platform=iOS Simulator' -derivedDataPath DerivedData CODE_SIGNING_ALLOWED=NO",
  '} > "$HOME/.termhub/wda-setup.log" 2>&1',
  'echo $? > "$HOME/.termhub/wda-setup.status"',
  '',
].join('\n');

/** Writes the setup script and starts it in tmux, unless it is already running. Prints STARTED:yes|no. */
export const WDA_SETUP_START_SCRIPT = [
  `if tmux has-session -t '=${WDA_SETUP_SESSION}' 2>/dev/null; then echo STARTED:no; exit 0; fi`,
  `mkdir -p "$HOME/.termhub" && cat > "$HOME/.termhub/wda-setup.sh" <<'TERMHUB_EOF'`,
  WDA_SETUP_SH + 'TERMHUB_EOF',
  `chmod +x "$HOME/.termhub/wda-setup.sh" && tmux new-session -d -s ${WDA_SETUP_SESSION} 'sh "$HOME/.termhub/wda-setup.sh"' && echo STARTED:yes`,
].join('\n');

/** STATE:/VERSION:/TAIL: lines; always exits 0. */
export const WDA_SETUP_STATE_SCRIPT = `
if tmux has-session -t '=${WDA_SETUP_SESSION}' 2>/dev/null; then echo STATE:running;
elif [ -f "$HOME/.termhub/wda-setup.status" ]; then
  if [ "$(cat "$HOME/.termhub/wda-setup.status")" = 0 ]; then echo STATE:ok; else echo STATE:failed; fi;
else echo STATE:idle; fi
echo VERSION:$(sed -n 's/.*"version": *"\\([^"]*\\)".*/\\1/p' "${WDA_DIR}/package.json" 2>/dev/null | head -1)
echo TAIL:
tail -n 40 "$HOME/.termhub/wda-setup.log" 2>/dev/null
exit 0`;
```

Note `WDA_SETUP_SH` ends with `\n` (the trailing `''` element), so `WDA_SETUP_SH + 'TERMHUB_EOF'` puts the heredoc terminator on its own line, exactly as `setup.ts` builds it today.

Add `export * from './simulator.js';` to `packages/machine-ops/src/index.ts`.

- [ ] **Step 4: Run the machine-ops tests**

Run: `TH_NODE npm test -w @termhub/machine-ops`
Expected: PASS.

- [ ] **Step 5: Point the server at the shared scripts, behaviour unchanged** (TER-45)

`apps/server/src/simulator/ports.ts`: delete the local `runnerSessionName` and add `export { runnerSessionName } from '@termhub/machine-ops';` (keep `fnv1a`, `WdaPorts`, `wdaPorts`).

`apps/server/src/simulator/machine.ts` becomes:

```ts
import {
  SIMCTL_BOOT_SCRIPT,
  SIMCTL_LIST_SCRIPT,
  WDA_RUNNER_ALIVE_SCRIPT,
  WDA_RUNNER_START_SCRIPT,
  WDA_RUNNER_TAIL_SCRIPT,
  assertUdid,
  runnerSessionName,
  withVars,
} from '@termhub/machine-ops';
import type { Machine } from '../db/repositories/types.js';
import { conflict } from '../lib/errors.js';
import { killTmuxSession, runOnMachine, type ExecResult } from '../terminal/machine-exec.js';
import type { WdaPorts } from './ports.js';

export { WDA_DIR } from '@termhub/machine-ops';

export interface Simulator {
  udid: string;
  name: string;
  runtime: string;
  state: string;
}

const PATH_PREFIX = 'export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"; ';

/** Runs a sh script on a local/ssh machine with the login PATH. */
export function runScript(machine: Machine, script: string, timeoutMs = 15_000): Promise<ExecResult> {
  const full = PATH_PREFIX + script;
  return runOnMachine(machine, { file: '/bin/sh', args: ['-lc', full] }, full, timeoutMs);
}

// parseSimctlList and isBootFailure: unchanged (keep the existing code verbatim)

export async function listSimulators(machine: Machine): Promise<Simulator[]> {
  if (machine.type === 'agent') throw conflict('Simulador indisponível em máquinas com agente');
  const r = await runScript(machine, SIMCTL_LIST_SCRIPT);
  if (r.code !== 0) throw new Error(r.stderr.trim() || 'falha ao listar simuladores');
  return parseSimctlList(r.stdout);
}

export async function bootSimulator(machine: Machine, udid: string): Promise<void> {
  assertUdid(udid);
  const r = await runScript(machine, withVars({ UDID: udid }, SIMCTL_BOOT_SCRIPT), 60_000);
  const out = r.stdout + r.stderr;
  if (isBootFailure(out)) throw new Error(`simctl boot falhou: ${out.trim()}`);
}

export async function runnerAlive(machine: Machine, udid: string): Promise<boolean> {
  assertUdid(udid);
  const r = await runScript(machine, withVars({ SESSION: runnerSessionName(udid) }, WDA_RUNNER_ALIVE_SCRIPT));
  return r.stdout.includes('yes');
}

export async function startRunner(machine: Machine, udid: string, ports: WdaPorts): Promise<void> {
  assertUdid(udid);
  const vars = { SESSION: runnerSessionName(udid), UDID: udid, WDA_PORT: String(ports.wdaPort), MJPEG_PORT: String(ports.mjpegPort) };
  const r = await runScript(machine, withVars(vars, WDA_RUNNER_START_SCRIPT));
  if (r.code !== 0 && !r.stderr.includes('duplicate session')) throw new Error(r.stderr.trim() || 'falha ao iniciar o runner do WDA');
}

export async function stopRunner(machine: Machine, udid: string): Promise<void> {
  assertUdid(udid);
  await killTmuxSession(machine, runnerSessionName(udid));
}

export async function runnerTail(machine: Machine, udid: string, lines = 30): Promise<string[]> {
  assertUdid(udid);
  const r = await runScript(machine, withVars({ SESSION: runnerSessionName(udid), LINES: String(lines) }, WDA_RUNNER_TAIL_SCRIPT));
  return r.stdout.split('\n').filter((l) => l.trim());
}
```

(The `machine.type === 'agent'` throw in `listSimulators` stays for now; Task 6 replaces it.)

`apps/server/src/simulator/setup.ts`: replace the local script text with the shared constants:

```ts
import { WDA_SETUP_SESSION, WDA_SETUP_SH, WDA_SETUP_START_SCRIPT, WDA_SETUP_STATE_SCRIPT } from '@termhub/machine-ops';
import type { Machine } from '../db/repositories/types.js';
import { conflict } from '../lib/errors.js';
import { runScript } from './machine.js';

export { WDA_SETUP_SESSION };

export interface WdaSetupState { … unchanged … }

/** Kept for callers/tests: the file the machine runs inside tmux. */
export function wdaSetupScript(): string {
  return WDA_SETUP_SH;
}

// parseSetupOutput: unchanged

export async function wdaSetupState(machine: Machine): Promise<WdaSetupState> {
  const r = await runScript(machine, WDA_SETUP_STATE_SCRIPT);
  if (r.code !== 0 && !r.stdout) throw new Error(r.stderr.trim() || 'máquina inacessível');
  return parseSetupOutput(r.stdout);
}

export async function startWdaSetup(machine: Machine): Promise<void> {
  const current = await wdaSetupState(machine);
  if (current.state === 'running') throw conflict('Preparação do WDA já está em andamento');
  // One script: writes ~/.termhub/wda-setup.sh and starts it in tmux so it survives an ssh/server drop.
  const r = await runScript(machine, WDA_SETUP_START_SCRIPT);
  if (r.code !== 0 || !r.stdout.includes('STARTED:')) throw new Error(r.stderr.trim() || 'falha ao iniciar o setup no tmux');
}
```

Delete the old `STATE_SCRIPT` constant and the old body of `wdaSetupScript`.

- [ ] **Step 6: Add the regex-parity test on the server**

Append to `apps/server/src/simulator/machine.test.ts`:

```ts
import { UDID_RE as PROTOCOL_UDID_RE } from '@termhub/agent-protocol';
import { UDID_RE as OPS_UDID_RE } from '@termhub/machine-ops';

describe('udid regex parity', () => {
  it('agent-protocol and machine-ops validate udids the same way', () => {
    expect(PROTOCOL_UDID_RE.source).toBe(OPS_UDID_RE.source);
    expect(PROTOCOL_UDID_RE.flags).toBe(OPS_UDID_RE.flags);
  });
});
```

(Put the imports at the top of the file with the existing ones.)

- [ ] **Step 7: Rebuild packages, run server tests and typecheck**

Run: `TH_NODE npm run build:packages && npm test -w @termhub/server -- src/simulator && npm run typecheck -w @termhub/server`
Expected: PASS — `machine.test.ts`, `setup.test.ts`, `session-manager.test.ts`, `ports.test.ts` all green (session-manager mocks the backend, so nothing there changes).

- [ ] **Step 8: Commit**

```bash
git add packages/machine-ops apps/server/src/simulator
git commit -m "Simulator: move the WDA scripts to @termhub/machine-ops

The agent will run the same simctl/runner/setup scripts as named RPCs,
so the text moves to the shared package and values only reach it as
shell variables (withVars). Server behaviour unchanged.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Agent — `tcp` channel manager with flow control  (card **TER-37**)

Subtasks: ☐ TER-38 tcp.ts · ☐ TER-39 dispatch routing · ☐ TER-40 pause/resume · ☐ TER-41 slicing in sendStream · ☐ TER-42 tests

**Files:**
- Create: `apps/agent/src/tcp.ts`, `apps/agent/src/tcp.test.ts`
- Modify: `apps/agent/src/dispatch.ts`, `apps/agent/src/client.ts`, `apps/agent/src/run.ts`
- Test: `apps/agent/src/dispatch.test.ts`, `apps/agent/src/client.test.ts`

**Interfaces:**
- Consumes: `TcpOpenParams`, `isWdaPort`, `MAX_FRAME`, `HEADER_BYTES` from `@termhub/agent-protocol`; `AgentSocket` from `./client.js`.
- Produces: `interface TcpManager { open(ch, params: TcpOpenParams, socket): Promise<void>; write(ch, data): boolean; close(ch): void; closeAll(): void }` (in `dispatch.ts`), `createTcpManager(deps: TcpManagerDeps): TcpManager` (in `tcp.ts`), `DispatcherDeps.tcp`, `AgentSocket.bufferedAmount?(): number`, and `sendStream` that slices at `MAX_FRAME - HEADER_BYTES` bytes.

- [ ] **Step 1: Write the failing tcp manager tests** (TER-42)

`apps/agent/src/tcp.test.ts`:

```ts
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentSocket } from './client.js';
import { createTcpManager } from './tcp.js';

interface FakeSocket extends AgentSocket {
  sendControl: ReturnType<typeof vi.fn>;
  sendStream: ReturnType<typeof vi.fn>;
  buffered: number;
}

function makeSocket(): FakeSocket {
  const s = {
    sendControl: vi.fn(),
    sendStream: vi.fn(),
    buffered: 0,
    bufferedAmount: () => s.buffered,
  };
  return s;
}

/** A TCP echo server on an ephemeral loopback port; `received` collects what clients wrote. */
function echoServer(): Promise<{ port: number; server: net.Server; sockets: net.Socket[]; received: Buffer[] }> {
  const sockets: net.Socket[] = [];
  const received: Buffer[] = [];
  const server = net.createServer((sock) => {
    sockets.push(sock);
    sock.on('data', (d) => {
      received.push(d);
      sock.write(d);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ port: (server.address() as AddressInfo).port, server, sockets, received })));
}

const waitFor = (pred: () => boolean, ms = 2000) =>
  vi.waitFor(() => expect(pred()).toBe(true), { timeout: ms, interval: 10 });

const servers: net.Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
});

describe('createTcpManager', () => {
  it('opens a channel to a loopback port, pipes both ways and reports closed once', async () => {
    const { port, server, sockets, received } = await echoServer();
    servers.push(server);
    const socket = makeSocket();
    const tcp = createTcpManager({ log: vi.fn(), allowPort: () => true });

    await tcp.open(1, { port }, socket);
    expect(socket.sendControl).toHaveBeenCalledWith({ type: 'opened', ch: 1 });

    expect(tcp.write(1, Buffer.from('ping'))).toBe(true);
    await waitFor(() => received.length > 0);
    expect(Buffer.concat(received).toString()).toBe('ping');
    await waitFor(() => socket.sendStream.mock.calls.length > 0);
    expect(socket.sendStream).toHaveBeenCalledWith(1, Buffer.from('ping'));

    sockets[0].end();
    await waitFor(() => socket.sendControl.mock.calls.some((c) => c[0].type === 'closed'));
    await new Promise((r) => setTimeout(r, 50));
    expect(socket.sendControl.mock.calls.filter((c) => c[0].type === 'closed')).toHaveLength(1);
    expect(socket.sendControl).toHaveBeenCalledWith({ type: 'closed', ch: 1, code: null });
    expect(tcp.write(1, Buffer.from('late'))).toBe(false);
  });

  it('answers open_error refused when nothing listens on the port', async () => {
    const { port, server } = await echoServer();
    servers.pop();
    await new Promise<void>((r) => server.close(() => r()));
    const socket = makeSocket();
    const tcp = createTcpManager({ log: vi.fn(), allowPort: () => true });
    await tcp.open(2, { port }, socket);
    expect(socket.sendControl).toHaveBeenCalledWith({ type: 'open_error', ch: 2, error: { code: 'refused', message: 'connection refused' } });
    expect(socket.sendControl).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'opened' }));
  });

  it('refuses a port outside the WDA ranges with the default allowPort, without connecting', async () => {
    const { port, server, sockets } = await echoServer();
    servers.push(server);
    const socket = makeSocket();
    const tcp = createTcpManager({ log: vi.fn() });
    await tcp.open(3, { port }, socket); // ephemeral port: never inside 8100-8199 / 9100-9199
    expect(socket.sendControl).toHaveBeenCalledWith({ type: 'open_error', ch: 3, error: { code: 'invalid', message: 'port not allowed' } });
    await new Promise((r) => setTimeout(r, 50));
    expect(sockets).toHaveLength(0);
  });

  it('refuses a channel number already in use', async () => {
    const { port, server } = await echoServer();
    servers.push(server);
    const socket = makeSocket();
    const tcp = createTcpManager({ log: vi.fn(), allowPort: () => true });
    await tcp.open(4, { port }, socket);
    await tcp.open(4, { port }, socket);
    expect(socket.sendControl).toHaveBeenCalledWith({ type: 'open_error', ch: 4, error: { code: 'invalid', message: 'channel in use' } });
    tcp.closeAll();
  });

  it('close(ch) destroys the socket and acks closed exactly once', async () => {
    const { port, server, sockets } = await echoServer();
    servers.push(server);
    const socket = makeSocket();
    const tcp = createTcpManager({ log: vi.fn(), allowPort: () => true });
    await tcp.open(5, { port }, socket);
    tcp.close(5);
    await waitFor(() => sockets[0].destroyed || sockets[0].readyState === 'closed');
    await new Promise((r) => setTimeout(r, 50));
    expect(socket.sendControl.mock.calls.filter((c) => c[0].type === 'closed')).toHaveLength(1);
  });

  it('pauses the local socket while the websocket buffer is above the high-water mark and resumes below the low-water mark', async () => {
    const { port, server, sockets } = await echoServer();
    servers.push(server);
    const socket = makeSocket();
    const tcp = createTcpManager({ log: vi.fn(), allowPort: () => true, highWater: 100, lowWater: 10, resumePollMs: 5 });
    await tcp.open(6, { port }, socket);

    socket.buffered = 500; // "the websocket is congested"
    tcp.write(6, Buffer.alloc(200, 1)); // echoed back → one data event → pause
    await waitFor(() => socket.sendStream.mock.calls.length >= 1);
    await waitFor(() => sockets[0] !== undefined && tcp.isPaused(6));

    socket.buffered = 0; // drained
    await waitFor(() => !tcp.isPaused(6));
    tcp.closeAll();
  });

  it('closeAll drops every channel without sending closed', async () => {
    const { port, server } = await echoServer();
    servers.push(server);
    const socket = makeSocket();
    const tcp = createTcpManager({ log: vi.fn(), allowPort: () => true });
    await tcp.open(7, { port }, socket);
    await tcp.open(8, { port }, socket);
    socket.sendControl.mockClear();
    tcp.closeAll();
    await new Promise((r) => setTimeout(r, 50));
    expect(socket.sendControl).not.toHaveBeenCalled();
    expect(tcp.write(7, Buffer.from('x'))).toBe(false);
  });
});
```

`isPaused(ch)` is a test-facing accessor on the manager (documented as such); keep it in the `TcpManager` type as optional? No: add it to the concrete return type only — declare the factory's return as `TcpManager & { isPaused(ch: number): boolean }`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `TH_NODE npm test -w @termhub/agent -- src/tcp.test.ts`
Expected: FAIL — `./tcp.js` not found.

- [ ] **Step 3: Add `bufferedAmount` to `AgentSocket` and slice in `sendStream`** (TER-41)

In `apps/agent/src/client.ts`:

```ts
export interface AgentSocket {
  sendControl(msg: AgentMessage): void;
  /** Sends `data` on channel `ch`, sliced so no single frame exceeds MAX_FRAME (the server closes the
   *  whole socket with 1009 above that, taking every terminal on the machine with it). */
  sendStream(ch: number, data: Buffer): void;
  /** Bytes queued on the WebSocket and not yet handed to the kernel; the tcp manager's flow control
   *  reads it. Optional so test doubles built before it existed keep compiling (they read as 0). */
  bufferedAmount?(): number;
}

/** Largest stream payload one frame may carry: the frame limit minus the channel header. */
export const MAX_STREAM_PAYLOAD = MAX_FRAME - HEADER_BYTES;
```

Import `MAX_FRAME` and `HEADER_BYTES` from `@termhub/agent-protocol`. In `connectOnce`'s `ws.on('open')`:

```ts
      socket = {
        sendControl: (msg) => ws.send(encodeFrame(CONTROL_CHANNEL, JSON.stringify(msg))),
        sendStream: (ch, data) => {
          if (data.length <= MAX_STREAM_PAYLOAD) {
            ws.send(encodeFrame(ch, data));
            return;
          }
          for (let off = 0; off < data.length; off += MAX_STREAM_PAYLOAD) ws.send(encodeFrame(ch, data.subarray(off, off + MAX_STREAM_PAYLOAD)));
        },
        bufferedAmount: () => ws.bufferedAmount,
      };
```

Test, appended to `apps/agent/src/client.test.ts` (use the file's existing `startServer` helper; read it first — it returns `{ port, stop }` and takes `onConnection(ws)`; the server side must be started with `maxPayload: MAX_FRAME` for this test, so add an optional `maxPayload?: number` option to `startServer` that is passed to its `new WebSocketServer({ …, maxPayload })`):

```ts
  it('sendStream slices a payload larger than MAX_FRAME into frames the server accepts', async () => {
    const frames: number[] = [];
    let closedWith = 0;
    const srv = startServer({
      acceptAll: true,
      maxPayload: MAX_FRAME,
      onConnection: (ws) => {
        ws.on('message', (data) => {
          const f = decodeFrame(asBuffer(data));
          if (f.ch === 7) frames.push(f.payload.length);
        });
        ws.on('close', (code) => (closedWith = code));
      },
    });
    try {
      const { socket, closed } = await connectOnce({ url: `http://127.0.0.1:${srv.port}`, token: TOKEN, hello: baseHello, onServerMessage: () => {}, onStream: () => {}, log: noopLog() });
      const big = Buffer.alloc(MAX_FRAME * 2 + 1000, 7);
      socket.sendStream(7, big);
      await vi.waitFor(() => expect(frames.reduce((a, b) => a + b, 0)).toBe(big.length), { timeout: 5000 });
      expect(Math.max(...frames)).toBeLessThanOrEqual(MAX_FRAME - HEADER_BYTES);
      expect(frames.length).toBe(3);
      expect(closedWith).toBe(0);
      void closed;
    } finally {
      await srv.stop();
    }
  });
```

Add `HEADER_BYTES, MAX_FRAME` to the protocol import and `vi` to the vitest import in that test file. Run: `TH_NODE npm test -w @termhub/agent -- src/client.test.ts` → PASS.

- [ ] **Step 4: Create `apps/agent/src/tcp.ts`** (TER-38, TER-40)

```ts
import net from 'node:net';
import type { TcpOpenParams } from '@termhub/agent-protocol';
import { isWdaPort } from '@termhub/agent-protocol';
import type { AgentSocket } from './client.js';
import type { TcpManager } from './dispatch.js';

export interface TcpManagerDeps {
  log: (msg: string, meta?: object) => void;
  /** Which ports may be reached. Defaults to the WDA ranges (`isWdaPort`); tests inject `() => true`. */
  allowPort?: (port: number) => boolean;
  /** Pause reading the local socket when the WebSocket has this many bytes queued. Default 4 MiB. */
  highWater?: number;
  /** Resume once the queue is back under this. Default 1 MiB. */
  lowWater?: number;
  /** How often to re-check the queue while paused. Default 50 ms. */
  resumePollMs?: number;
}

interface Channel {
  sock: net.Socket;
  paused: boolean;
  resumeTimer: ReturnType<typeof setInterval> | null;
  /** Set by close()/closeAll(): the server dropped its side; nothing more is forwarded or acked. */
  closed: boolean;
  sendClosed(reason?: 'reset'): void;
}

const DEFAULT_HIGH_WATER = 4 * 1024 * 1024;
const DEFAULT_LOW_WATER = 1024 * 1024;
const DEFAULT_RESUME_POLL_MS = 50;

function isRefused(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === 'ECONNREFUSED';
}

/**
 * Raw TCP pipes to loopback ports on this machine (the WDA runner's HTTP and MJPEG ports), one per
 * channel. Same shape as the PTY and Claude managers so `dispatch.ts` only routes by kind. Flow
 * control: when the WebSocket queue passes `highWater`, the local socket is paused, which pushes the
 * pressure back to the local server (WDA holds frames) instead of growing this process's memory or
 * starving the terminals that share the socket.
 */
export function createTcpManager(deps: TcpManagerDeps): TcpManager & { isPaused(ch: number): boolean } {
  const channels = new Map<number, Channel>();
  const allowPort = deps.allowPort ?? isWdaPort;
  const highWater = deps.highWater ?? DEFAULT_HIGH_WATER;
  const lowWater = deps.lowWater ?? DEFAULT_LOW_WATER;
  const resumePollMs = deps.resumePollMs ?? DEFAULT_RESUME_POLL_MS;

  const control = (socket: AgentSocket, msg: Parameters<AgentSocket['sendControl']>[0]) => {
    try {
      socket.sendControl(msg);
    } catch (err) {
      deps.log('tcp control send failed', { type: msg.type, error: err instanceof Error ? err.message : String(err) });
    }
  };

  const stopResumeTimer = (entry: Channel) => {
    if (entry.resumeTimer) clearInterval(entry.resumeTimer);
    entry.resumeTimer = null;
  };

  const drop = (ch: number, entry: Channel) => {
    entry.closed = true;
    stopResumeTimer(entry);
    if (channels.get(ch) === entry) channels.delete(ch);
    entry.sock.destroy();
  };

  return {
    async open(ch, params: TcpOpenParams, socket: AgentSocket): Promise<void> {
      if (channels.has(ch)) {
        control(socket, { type: 'open_error', ch, error: { code: 'invalid', message: 'channel in use' } });
        return;
      }
      if (!allowPort(params.port)) {
        deps.log('tcp open refused: port not allowed', { ch, port: params.port });
        control(socket, { type: 'open_error', ch, error: { code: 'invalid', message: 'port not allowed' } });
        return;
      }

      const sock = net.connect({ host: '127.0.0.1', port: params.port });
      let opened = false;
      let closedSent = false;
      const entry: Channel = {
        sock,
        paused: false,
        resumeTimer: null,
        closed: false,
        sendClosed: (reason) => {
          if (closedSent) return;
          closedSent = true;
          control(socket, reason ? { type: 'closed', ch, code: null, reason } : { type: 'closed', ch, code: null });
        },
      };
      channels.set(ch, entry);

      await new Promise<void>((resolve) => {
        sock.once('connect', () => {
          opened = true;
          deps.log('tcp opened', { ch, port: params.port });
          control(socket, { type: 'opened', ch });
          resolve();
        });
        sock.once('error', (err: NodeJS.ErrnoException) => {
          if (sock.connecting || !sock.remoteAddress) {
            // Failed before connecting: the server never sees `opened`, so it gets open_error, not closed.
            channels.delete(ch);
            stopResumeTimer(entry);
            deps.log('tcp open failed', { ch, port: params.port, code: err.code ?? 'unknown' });
            control(socket, { type: 'open_error', ch, error: isRefused(err) ? { code: 'refused', message: 'connection refused' } : { code: 'internal', message: 'connect failed' } });
            resolve();
            return;
          }
          // Errored after connecting: reported by the 'close' handler below as reason 'reset'.
          deps.log('tcp socket error', { ch, port: params.port, code: err.code ?? 'unknown' });
          entry.sock.destroy();
        });
      });
      if (!channels.has(ch)) return; // open failed above

      sock.on('data', (chunk: Buffer) => {
        if (entry.closed) return;
        try {
          socket.sendStream(ch, chunk);
        } catch (err) {
          deps.log('tcp stream send failed', { ch, error: err instanceof Error ? err.message : String(err) });
          return;
        }
        const queued = socket.bufferedAmount?.() ?? 0;
        if (queued > highWater && !entry.paused) {
          entry.paused = true;
          sock.pause();
          deps.log('tcp paused', { ch, queued });
          entry.resumeTimer = setInterval(() => {
            if (entry.closed) {
              stopResumeTimer(entry);
              return;
            }
            if ((socket.bufferedAmount?.() ?? 0) <= lowWater) {
              stopResumeTimer(entry);
              entry.paused = false;
              sock.resume();
              deps.log('tcp resumed', { ch });
            }
          }, resumePollMs);
        }
      });
      sock.on('close', (hadError: boolean) => {
        if (!opened) return; // a refused connect already answered open_error above
        stopResumeTimer(entry);
        if (channels.get(ch) === entry) channels.delete(ch);
        if (entry.closed) return; // close()/closeAll() already handled it
        deps.log('tcp closed', { ch, port: params.port, hadError });
        entry.sendClosed(hadError ? 'reset' : undefined);
      });
    },

    write(ch, data): boolean {
      const entry = channels.get(ch);
      if (!entry || entry.closed) return false;
      entry.sock.write(data);
      return true;
    },

    close(ch): void {
      const entry = channels.get(ch);
      if (!entry) return;
      drop(ch, entry);
      // Always ack: the server keeps the number reserved until it sees `closed`.
      entry.sendClosed();
    },

    closeAll(): void {
      for (const [ch, entry] of channels) drop(ch, entry);
    },

    isPaused(ch): boolean {
      return channels.get(ch)?.paused ?? false;
    },
  };
}
```

On ECONNREFUSED Node emits `error` and then `close`: the `opened` flag is what keeps that later `close` from sending a `closed` for a channel the server only ever saw fail to open.

- [ ] **Step 5: Route `kind: 'tcp'` in the dispatcher** (TER-39)

In `apps/agent/src/dispatch.ts`:

```ts
import type { ClaudeOpenParams, PtyOpenParams, RpcMethod, ServerMessage, TcpOpenParams } from '@termhub/agent-protocol';

/** Raw TCP pipes to the WDA ports (`src/tcp.ts`). Same contract as the Claude manager: `write` says
 *  whether the channel is its own, and it reports its own open/close outcomes to the server. */
export interface TcpManager {
  open(ch: number, params: TcpOpenParams, socket: AgentSocket): Promise<void>;
  write(ch: number, data: Buffer): boolean;
  close(ch: number): void;
  closeAll(): void;
}

export interface DispatcherDeps {
  handlers: Handlers;
  pty: PtyManager;
  claude: ClaudeManager;
  tcp: TcpManager;
  log: (msg: string, meta?: object) => void;
}
```

In `createDispatcher`, the `open` case:

```ts
        const opened =
          msg.kind === 'claude' ? deps.claude.open(msg.ch, msg.params, socket)
          : msg.kind === 'tcp' ? deps.tcp.open(msg.ch, msg.params, socket)
          : deps.pty.open(msg.ch, msg.params, socket);
```

and the `close` case adds `deps.tcp.close(msg.ch);`. `resize` stays PTY-only (a `tcp` channel ignores it: the PTY manager finds no entry and returns).

Update `apps/agent/src/dispatch.test.ts`: add

```ts
function makeTcp(): TcpManager {
  return { open: vi.fn().mockResolvedValue(undefined), write: vi.fn().mockReturnValue(false), close: vi.fn(), closeAll: vi.fn() };
}
```

import `TcpManager`, pass `tcp: makeTcp()` in every `createDispatcher({...})` call, and add two tests:

```ts
  it('routes open kind: tcp to the tcp manager', () => {
    const { socket } = makeSocket();
    const tcp = makeTcp();
    const dispatch = createDispatcher({ handlers: makeHandlers(), pty: makePty(), claude: makeClaude(), tcp, log: vi.fn() });
    dispatch({ type: 'open', ch: 9, kind: 'tcp', params: { port: 8137 } }, socket);
    expect(tcp.open).toHaveBeenCalledWith(9, { port: 8137 }, socket);
  });
  it('close reaches the tcp manager too', () => {
    const { socket } = makeSocket();
    const tcp = makeTcp();
    const dispatch = createDispatcher({ handlers: makeHandlers(), pty: makePty(), claude: makeClaude(), tcp, log: vi.fn() });
    dispatch({ type: 'close', ch: 9 }, socket);
    expect(tcp.close).toHaveBeenCalledWith(9);
  });
```

- [ ] **Step 6: Wire the manager into `runAgent`**

In `apps/agent/src/run.ts`: `import { createTcpManager } from './tcp.js';`, then in `runAgent`:

```ts
  const pty = createPtyManager({ log: opts.log });
  const claude = createClaudeManager({ log: opts.log });
  const tcp = createTcpManager({ log: opts.log });
  const dispatch = createDispatcher({ handlers, pty, claude, tcp, log: opts.log });
  …
        onStream: (ch, data) => {
          if (!claude.write(ch, data) && !tcp.write(ch, data)) pty.write(ch, data);
        },
  …
        onDisconnect: () => {
          pty.closeAll();
          claude.closeAll();
          tcp.closeAll();
        },
```

- [ ] **Step 7: Run the agent tests and typecheck**

Run: `TH_NODE npm test -w @termhub/agent && npm run typecheck -w @termhub/agent`
Expected: PASS. If `pty.test.ts` or `claude/run.test.ts` fail to compile because their fake sockets lack `bufferedAmount`, that means it was made required by mistake — it must stay optional.

- [ ] **Step 8: Commit**

```bash
git add apps/agent/src
git commit -m "Agent: tcp channel manager with flow control

Pipes a channel to a loopback WDA port, pauses the local socket while
the WebSocket queue is above 4 MiB, and slices stream payloads so no
frame can exceed the server's 1 MiB limit (spec §4.1, §4.2).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Agent — `sim.*`/`wda.*` RPC handlers, `sim` capability, version 0.5.0  (card **TER-31**)

Subtasks: ☐ TER-32 sim.ts/wda.ts · ☐ TER-33 validate udid/ports in the agent · ☐ TER-34 capability on macOS · ☐ TER-35 tests · ☐ TER-36 version bump

**Files:**
- Create: `apps/agent/src/rpc/sim.ts`, `apps/agent/src/rpc/wda.ts`, `apps/agent/src/rpc/sim.test.ts`, `apps/agent/src/rpc/wda.test.ts`
- Modify: `apps/agent/src/rpc/index.ts` (replace the Task 1 stubs), `apps/agent/src/run.ts`, `apps/agent/package.json`
- Test: `apps/agent/src/run.test.ts`

**Interfaces:**
- Consumes: scripts and helpers from `@termhub/machine-ops` (Task 2); `sh`, `agentEnv`, `RpcFailure` from `../exec.js`.
- Produces: handlers `sim.list`, `sim.boot`, `wda.runnerStart`, `wda.runnerAlive`, `wda.runnerTail`, `wda.setupStart`, `wda.setupState`; `capabilitiesFor(os: SupportedOs): string[]` in `run.ts`.

- [ ] **Step 1: Write the failing handler tests** (TER-35)

`apps/agent/src/rpc/sim.test.ts`:

```ts
import { SIMCTL_BOOT_SCRIPT, SIMCTL_LIST_SCRIPT } from '@termhub/machine-ops';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { sh } = vi.hoisted(() => ({ sh: vi.fn() }));
vi.mock('../exec.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../exec.js')>();
  return { ...actual, sh };
});

import { boot, list } from './sim.js';

const UDID = 'BAE07EB5-8CA8-4C6E-819A-A0240342FF00';
const ok = (stdout: string) => ({ code: 0, stdout, stderr: '', timedOut: false });

beforeEach(() => sh.mockReset());

describe('sim.list', () => {
  it('runs the constant simctl list script and passes stdout through', async () => {
    sh.mockResolvedValue(ok('{"devices":{}}'));
    await expect(list({})).resolves.toEqual({ stdout: '{"devices":{}}' });
    expect(sh).toHaveBeenCalledWith(SIMCTL_LIST_SCRIPT, expect.objectContaining({ timeoutMs: 14_000 }));
  });
  it('reports a timeout and a non-zero exit as failed with the machine message', async () => {
    sh.mockResolvedValue({ code: null, stdout: '', stderr: '', timedOut: true });
    await expect(list({})).rejects.toMatchObject({ code: 'timeout' });
    sh.mockResolvedValue({ code: 1, stdout: '', stderr: 'xcrun: error: unable to find utility "simctl"', timedOut: false });
    await expect(list({})).rejects.toMatchObject({ code: 'failed', message: 'xcrun: error: unable to find utility "simctl"' });
  });
});

describe('sim.boot', () => {
  it('passes the udid through the environment, never the script text', async () => {
    sh.mockResolvedValue(ok(''));
    await expect(boot({ udid: UDID })).resolves.toEqual({ stdout: '' });
    const [script, opts] = sh.mock.calls[0];
    expect(script).toBe(SIMCTL_BOOT_SCRIPT);
    expect(script).not.toContain(UDID);
    expect(opts.env.UDID).toBe(UDID);
    expect(opts.env.PATH).toContain('/opt/homebrew/bin');
    expect(opts.timeoutMs).toBe(59_000);
  });
  it('rejects an invalid udid before running anything', async () => {
    await expect(boot({ udid: 'x; rm -rf /' })).rejects.toMatchObject({ code: 'invalid' });
    expect(sh).not.toHaveBeenCalled();
  });
  it('returns combined stdout+stderr so the server can read "already booted"', async () => {
    sh.mockResolvedValue({ code: 0, stdout: '', stderr: 'Unable to boot device in current state: Booted', timedOut: false });
    await expect(boot({ udid: UDID })).resolves.toEqual({ stdout: 'Unable to boot device in current state: Booted' });
  });
});
```

`apps/agent/src/rpc/wda.test.ts`:

```ts
import { WDA_RUNNER_ALIVE_SCRIPT, WDA_RUNNER_START_SCRIPT, WDA_RUNNER_TAIL_SCRIPT, WDA_SETUP_START_SCRIPT, WDA_SETUP_STATE_SCRIPT } from '@termhub/machine-ops';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { sh } = vi.hoisted(() => ({ sh: vi.fn() }));
vi.mock('../exec.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../exec.js')>();
  return { ...actual, sh };
});

import { runnerAlive, runnerStart, runnerTail, setupStart, setupState } from './wda.js';

const UDID = 'BAE07EB5-8CA8-4C6E-819A-A0240342FF00';
const SESSION = 'termhub-wda-bae07eb5';
const ok = (stdout: string) => ({ code: 0, stdout, stderr: '', timedOut: false });

beforeEach(() => sh.mockReset());

describe('wda.runner.start', () => {
  it('runs the constant script with SESSION/UDID/WDA_PORT/MJPEG_PORT in the environment', async () => {
    sh.mockResolvedValue(ok(''));
    await expect(runnerStart({ udid: UDID, wda_port: 8137, mjpeg_port: 9137 })).resolves.toEqual({ started: true });
    const [script, opts] = sh.mock.calls[0];
    expect(script).toBe(WDA_RUNNER_START_SCRIPT);
    expect(opts.env).toEqual(expect.objectContaining({ SESSION, UDID, WDA_PORT: '8137', MJPEG_PORT: '9137' }));
  });
  it('reports started: false when the tmux session already exists', async () => {
    sh.mockResolvedValue({ code: 1, stdout: '', stderr: `duplicate session: ${SESSION}`, timedOut: false });
    await expect(runnerStart({ udid: UDID, wda_port: 8137, mjpeg_port: 9137 })).resolves.toEqual({ started: false });
  });
  it('rejects ports outside the WDA ranges and bad udids before running', async () => {
    await expect(runnerStart({ udid: UDID, wda_port: 8200, mjpeg_port: 9137 })).rejects.toMatchObject({ code: 'invalid' });
    await expect(runnerStart({ udid: 'nope!', wda_port: 8137, mjpeg_port: 9137 })).rejects.toMatchObject({ code: 'invalid' });
    expect(sh).not.toHaveBeenCalled();
  });
  it('maps tmux missing to no_tmux and any other failure to failed', async () => {
    sh.mockResolvedValue({ code: 127, stdout: '', stderr: 'sh: tmux: command not found', timedOut: false });
    await expect(runnerStart({ udid: UDID, wda_port: 8137, mjpeg_port: 9137 })).rejects.toMatchObject({ code: 'no_tmux' });
    sh.mockResolvedValue({ code: 1, stdout: '', stderr: 'boom', timedOut: false });
    await expect(runnerStart({ udid: UDID, wda_port: 8137, mjpeg_port: 9137 })).rejects.toMatchObject({ code: 'failed', message: 'boom' });
  });
});

describe('wda.runner.alive / tail', () => {
  it('alive reads yes/no', async () => {
    sh.mockResolvedValue(ok('yes\n'));
    await expect(runnerAlive({ udid: UDID })).resolves.toEqual({ alive: true });
    expect(sh.mock.calls[0][0]).toBe(WDA_RUNNER_ALIVE_SCRIPT);
    expect(sh.mock.calls[0][1].env.SESSION).toBe(SESSION);
    sh.mockResolvedValue(ok('no\n'));
    await expect(runnerAlive({ udid: UDID })).resolves.toEqual({ alive: false });
  });
  it('tail passes LINES and splits non-empty lines', async () => {
    sh.mockResolvedValue(ok('a\n\nb\n'));
    await expect(runnerTail({ udid: UDID, lines: 30 })).resolves.toEqual({ lines: ['a', 'b'] });
    expect(sh.mock.calls[0][0]).toBe(WDA_RUNNER_TAIL_SCRIPT);
    expect(sh.mock.calls[0][1].env).toEqual(expect.objectContaining({ SESSION, LINES: '30' }));
  });
});

describe('wda.setup.start / state', () => {
  it('start reads STARTED:yes|no', async () => {
    sh.mockResolvedValue(ok('STARTED:yes\n'));
    await expect(setupStart({})).resolves.toEqual({ started: true });
    expect(sh.mock.calls[0][0]).toBe(WDA_SETUP_START_SCRIPT);
    sh.mockResolvedValue(ok('STARTED:no\n'));
    await expect(setupStart({})).resolves.toEqual({ started: false });
  });
  it('start without a STARTED line is a failure with the machine message', async () => {
    sh.mockResolvedValue({ code: 1, stdout: '', stderr: 'no space left', timedOut: false });
    await expect(setupStart({})).rejects.toMatchObject({ code: 'failed', message: 'no space left' });
  });
  it('state passes stdout through', async () => {
    sh.mockResolvedValue(ok('STATE:idle\nVERSION:\nTAIL:\n'));
    await expect(setupState({})).resolves.toEqual({ stdout: 'STATE:idle\nVERSION:\nTAIL:\n' });
    expect(sh.mock.calls[0][0]).toBe(WDA_SETUP_STATE_SCRIPT);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `TH_NODE npm test -w @termhub/agent -- src/rpc/sim.test.ts src/rpc/wda.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement the handlers** (TER-32, TER-33)

`apps/agent/src/rpc/sim.ts`:

```ts
import type { RpcParams, RpcResult } from '@termhub/agent-protocol';
import { SIMCTL_BOOT_SCRIPT, SIMCTL_LIST_SCRIPT, UDID_RE } from '@termhub/machine-ops';
import { RpcFailure, agentEnv, sh, type RunResult } from '../exec.js';

/** Re-validated here even though zod already did: the shell only ever sees a udid this regex passed. */
export function checkUdid(udid: string): void {
  if (!UDID_RE.test(udid)) throw new RpcFailure('invalid', 'invalid udid');
}

/** A timeout is a timeout; anything else non-zero is reported with the machine's own first stderr line. */
export function scriptFailure(r: RunResult, what: string): RpcFailure | null {
  if (r.timedOut) return new RpcFailure('timeout', `${what} timed out`);
  if (r.error === 'enoent') return new RpcFailure('internal', '/bin/sh not found');
  if (r.code !== 0) {
    const why = r.stderr.trim().split('\n')[0] || r.stdout.trim().split('\n')[0] || `${what} exited with code ${r.code}`;
    return /tmux: (command )?not found/.test(r.stderr) ? new RpcFailure('no_tmux', 'tmux not found') : new RpcFailure('failed', why);
  }
  return null;
}

export async function list(_params: RpcParams<'sim.list'>): Promise<RpcResult<'sim.list'>> {
  // 14 s: under the server's 15 s so the agent reports the timeout itself.
  const r = await sh(SIMCTL_LIST_SCRIPT, { timeoutMs: 14_000 });
  const failure = scriptFailure(r, 'sim.list');
  if (failure) throw failure;
  return { stdout: r.stdout };
}

export async function boot(params: RpcParams<'sim.boot'>): Promise<RpcResult<'sim.boot'>> {
  checkUdid(params.udid);
  const r = await sh(SIMCTL_BOOT_SCRIPT, { timeoutMs: 59_000, env: { ...agentEnv(), UDID: params.udid } });
  const failure = scriptFailure(r, 'sim.boot');
  if (failure) throw failure;
  // The script ends with `|| true`, so "already booted" arrives here as text; the server reads it.
  return { stdout: r.stdout + r.stderr };
}
```

`apps/agent/src/rpc/wda.ts`:

```ts
import type { RpcParams, RpcResult } from '@termhub/agent-protocol';
import { isWdaPort } from '@termhub/agent-protocol';
import {
  WDA_RUNNER_ALIVE_SCRIPT,
  WDA_RUNNER_START_SCRIPT,
  WDA_RUNNER_TAIL_SCRIPT,
  WDA_SETUP_START_SCRIPT,
  WDA_SETUP_STATE_SCRIPT,
  runnerSessionName,
} from '@termhub/machine-ops';
import { RpcFailure, agentEnv, sh } from '../exec.js';
import { checkUdid, scriptFailure } from './sim.js';

function env(vars: Record<string, string>): NodeJS.ProcessEnv {
  return { ...agentEnv(), ...vars };
}

export async function runnerStart(params: RpcParams<'wda.runner.start'>): Promise<RpcResult<'wda.runner.start'>> {
  checkUdid(params.udid);
  if (!isWdaPort(params.wda_port) || !isWdaPort(params.mjpeg_port)) throw new RpcFailure('invalid', 'port outside the WDA ranges');
  const vars = { SESSION: runnerSessionName(params.udid), UDID: params.udid, WDA_PORT: String(params.wda_port), MJPEG_PORT: String(params.mjpeg_port) };
  const r = await sh(WDA_RUNNER_START_SCRIPT, { timeoutMs: 9_000, env: env(vars) });
  if (r.code !== 0 && r.stderr.includes('duplicate session')) return { started: false };
  const failure = scriptFailure(r, 'wda.runner.start');
  if (failure) throw failure;
  return { started: true };
}

export async function runnerAlive(params: RpcParams<'wda.runner.alive'>): Promise<RpcResult<'wda.runner.alive'>> {
  checkUdid(params.udid);
  const r = await sh(WDA_RUNNER_ALIVE_SCRIPT, { env: env({ SESSION: runnerSessionName(params.udid) }) });
  const failure = scriptFailure(r, 'wda.runner.alive');
  if (failure) throw failure;
  return { alive: r.stdout.includes('yes') };
}

export async function runnerTail(params: RpcParams<'wda.runner.tail'>): Promise<RpcResult<'wda.runner.tail'>> {
  checkUdid(params.udid);
  const r = await sh(WDA_RUNNER_TAIL_SCRIPT, { env: env({ SESSION: runnerSessionName(params.udid), LINES: String(params.lines) }) });
  const failure = scriptFailure(r, 'wda.runner.tail');
  if (failure) throw failure;
  return { lines: r.stdout.split('\n').filter((l) => l.trim()) };
}

export async function setupStart(_params: RpcParams<'wda.setup.start'>): Promise<RpcResult<'wda.setup.start'>> {
  const r = await sh(WDA_SETUP_START_SCRIPT, { timeoutMs: 9_000 });
  const failure = scriptFailure(r, 'wda.setup.start');
  if (failure) throw failure;
  if (r.stdout.includes('STARTED:no')) return { started: false };
  if (r.stdout.includes('STARTED:yes')) return { started: true };
  throw new RpcFailure('failed', r.stderr.trim().split('\n')[0] || 'setup did not start');
}

export async function setupState(_params: RpcParams<'wda.setup.state'>): Promise<RpcResult<'wda.setup.state'>> {
  const r = await sh(WDA_SETUP_STATE_SCRIPT);
  const failure = scriptFailure(r, 'wda.setup.state');
  if (failure) throw failure;
  return { stdout: r.stdout };
}
```

Note the `sim.list` test expects `sh(SIMCTL_LIST_SCRIPT, expect.objectContaining({ timeoutMs: 14_000 }))` and the `sim.boot` test expects `opts.env.PATH` to contain Homebrew — `agentEnv()` provides it.

In `apps/agent/src/rpc/index.ts`, remove the Task 1 `notYet` stubs and register:

```ts
import * as sim from './sim.js';
import * as wda from './wda.js';
…
  'sim.list': sim.list,
  'sim.boot': sim.boot,
  'wda.runner.start': wda.runnerStart,
  'wda.runner.alive': wda.runnerAlive,
  'wda.runner.tail': wda.runnerTail,
  'wda.setup.start': wda.setupStart,
  'wda.setup.state': wda.setupState,
```

- [ ] **Step 4: Advertise `sim` on macOS** (TER-34)

In `apps/agent/src/run.ts`, replace the `CAPABILITIES` constant with:

```ts
import { CAPABILITY_CLAUDE, CAPABILITY_CLAUDE_SYSTEM_PROMPT, CAPABILITY_SIM, CLOSE } from '@termhub/agent-protocol';

/** Baseline capabilities every agent has. */
export const CAPABILITIES = [CAPABILITY_CLAUDE, CAPABILITY_CLAUDE_SYSTEM_PROMPT];

/** What this agent understands beyond a terminal. The simulator (`sim`) needs Xcode's simctl and the WDA
 *  runner, which only exist on macOS, so a Linux agent never claims it. */
export function capabilitiesFor(osName: SupportedOs): string[] {
  return osName === 'macos' ? [...CAPABILITIES, CAPABILITY_SIM] : [...CAPABILITIES];
}
```

Use `capabilities: capabilitiesFor(osName)` in `buildHello` and in `checkServerConnection`'s probe hello. Add to `apps/agent/src/run.test.ts` (next to the existing `buildHello`/`detectOs` tests; read the file's imports first):

```ts
describe('capabilitiesFor', () => {
  it('claims sim on macOS only', () => {
    expect(capabilitiesFor('macos')).toEqual(expect.arrayContaining(['claude', 'claude.system_prompt', 'sim']));
    expect(capabilitiesFor('linux')).not.toContain('sim');
    expect(capabilitiesFor('linux')).toEqual(expect.arrayContaining(['claude', 'claude.system_prompt']));
  });
});
```

If `run.test.ts` asserts the exact `capabilities` array of a `hello`, update that assertion to `capabilitiesFor(<os used>)`.

- [ ] **Step 5: Bump the version** (TER-36)

`apps/agent/package.json`: `"version": "0.5.0"`. If `apps/agent/src/version.ts` reads the version from `package.json` at build time nothing else changes; if it hard-codes it, update it too (check `version.test.ts`).

- [ ] **Step 6: Run the agent tests and typecheck**

Run: `TH_NODE npm test -w @termhub/agent && npm run typecheck -w @termhub/agent`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/agent
git commit -m "Agent: 0.5.0 — simulator rpcs and the sim capability

sim.list/sim.boot and wda.runner.*/wda.setup.* run the shared scripts
from @termhub/machine-ops with values passed only through the
environment; macOS agents advertise the sim capability (spec §4.3, §4.4).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Server — agent tunnel (`agent-tunnel.ts`) and `openTcp`  (card **TER-24**)

Subtasks: ☐ TER-25 openTcp · ☐ TER-26 agent-tunnel.ts · ☐ TER-27 offline → onClose · ☐ TER-28 openTunnel dispatch · ☐ TER-29 WdaClient keep-alive · ☐ TER-30 tests

**Files:**
- Modify: `apps/server/src/agent/connection.ts`, `apps/server/src/agent/registry.ts`
- Create: `apps/server/src/simulator/agent-tunnel.ts`, `apps/server/src/simulator/agent-tunnel.test.ts`
- Modify: `apps/server/src/simulator/tunnel.ts`, `apps/server/src/simulator/wda-client.ts`
- Test: `apps/server/src/agent/connection.test.ts` (one test), `apps/server/src/simulator/tunnel.test.ts` (one test)

**Interfaces:**
- Consumes: `TcpOpenParams` (Task 1); `Tunnel`, `findFreePort` from `./tunnel.js`; `ChannelLimitError`, `AgentRpcError`, `AgentChannel`, `ChannelHandlers` from `../agent/connection.js`; `AgentOfflineError` from `../agent/registry.js`.
- Produces: `AgentConnection.openTcp(params, handlers): Promise<AgentChannel>`, `AgentRegistry.openTcp(machineId, params, handlers)`, `openAgentTunnel(machineId, remote: WdaPorts, registry: TunnelRegistry, opts?): Promise<Tunnel>`, `AGENT_OFFLINE_MESSAGE = 'Agente desconectado'`, `NO_CHANNELS_MESSAGE = 'Máquina sem canais livres'`, `openTunnel` dispatching `agent` machines to it.

- [ ] **Step 1: `openTcp` on the connection and the registry** (TER-25)

`apps/server/src/agent/connection.ts`: import `type TcpOpenParams` from the protocol and add after `openClaude`:

```ts
  /** A raw TCP pipe to a loopback WDA port on the machine (`apps/agent/src/tcp.ts`). Same handshake as
   *  the other kinds; bytes flow both ways once it is open. */
  openTcp(params: TcpOpenParams, handlers: ChannelHandlers): Promise<AgentChannel> {
    return this.openChannel(handlers, (ch) => ({ type: 'open', ch, kind: 'tcp', params }));
  }
```

`apps/server/src/agent/registry.ts`: import `type TcpOpenParams` and add:

```ts
  /** A tcp pipe to a WDA port on that machine (the simulator's agent tunnel). */
  openTcp(machineId: string, params: TcpOpenParams, handlers: ChannelHandlers): Promise<AgentChannel> {
    const conn = this.conns.get(machineId);
    if (!conn) {
      return Promise.reject(new AgentOfflineError(`agent offline: ${machineId}`));
    }
    return conn.openTcp(params, handlers);
  }
```

Test in `apps/server/src/agent/connection.test.ts` (read the file first: it has a fake socket helper and a way to feed `hello`; follow the pattern of the existing `openClaude` test if there is one, else of `openPty`):

```ts
  it('openTcp sends open kind: tcp with the port and resolves on opened', async () => {
    // build a connection with the file's fake socket helper, feed a valid hello
    const p = conn.openTcp({ port: 8137 }, { onData: vi.fn(), onExit: vi.fn() });
    const sent = lastControlMessage(); // whatever helper the file uses to read the socket's last send
    expect(sent).toEqual({ type: 'open', ch: 1, kind: 'tcp', params: { port: 8137 } });
    feedControl({ type: 'opened', ch: 1 });
    await expect(p).resolves.toMatchObject({ ch: 1 });
  });
```

Adapt `lastControlMessage` / `feedControl` to the helpers that file already defines (do not invent new ones if equivalents exist).

- [ ] **Step 2: Write the failing agent-tunnel tests** (TER-30)

`apps/server/src/simulator/agent-tunnel.test.ts`:

```ts
import { EventEmitter } from 'node:events';
import net from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import type { AgentChannel, ChannelHandlers } from '../agent/connection.js';
import { AgentRpcError, ChannelLimitError } from '../agent/connection.js';
import { AgentOfflineError } from '../agent/registry.js';
import { AGENT_OFFLINE_MESSAGE, NO_CHANNELS_MESSAGE, openAgentTunnel, type TunnelRegistry } from './agent-tunnel.js';

/** A registry whose tcp channels are in-memory loops: what the "machine" answers is scripted per test. */
function fakeRegistry(opts: { online?: boolean; onOpen?: (port: number, handlers: ChannelHandlers) => AgentChannel | Error } = {}) {
  const emitter = new EventEmitter();
  const opened: { port: number; handlers: ChannelHandlers; channel: AgentChannel }[] = [];
  const registry: TunnelRegistry = {
    isOnline: () => opts.online ?? true,
    openTcp: vi.fn(async (_machineId: string, params: { port: number }, handlers: ChannelHandlers) => {
      const res = opts.onOpen?.(params.port, handlers);
      if (res instanceof Error) throw res;
      const channel: AgentChannel = res ?? { ch: opened.length + 1, write: vi.fn(), close: vi.fn() };
      opened.push({ port: params.port, handlers, channel });
      return channel;
    }),
    on: (event, cb) => emitter.on(event, cb),
    off: (event, cb) => emitter.off(event, cb),
  };
  return { registry, opened, emitter };
}

function connect(port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const s = net.connect({ port, host: '127.0.0.1' });
    s.once('connect', () => resolve(s));
    s.once('error', reject);
  });
}

const waitFor = (pred: () => boolean) => vi.waitFor(() => expect(pred()).toBe(true), { timeout: 2000, interval: 10 });

describe('openAgentTunnel', () => {
  it('listens on two local ports and opens one tcp channel per accepted connection, to the remote port', async () => {
    const { registry, opened } = fakeRegistry();
    const t = await openAgentTunnel('m1', { wdaPort: 8137, mjpegPort: 9137 }, registry);
    expect(t.wdaPort).not.toBe(8137);
    expect(t.mjpegPort).not.toBe(9137);

    const a = await connect(t.wdaPort);
    await waitFor(() => opened.length === 1);
    expect(opened[0].port).toBe(8137);
    const b = await connect(t.mjpegPort);
    await waitFor(() => opened.length === 2);
    expect(opened[1].port).toBe(9137);

    a.destroy();
    b.destroy();
    t.close();
  });

  it('pipes local bytes into channel.write and channel data back to the local socket', async () => {
    const { registry, opened } = fakeRegistry();
    const t = await openAgentTunnel('m1', { wdaPort: 8137, mjpegPort: 9137 }, registry);
    const sock = await connect(t.wdaPort);
    await waitFor(() => opened.length === 1);
    const received: Buffer[] = [];
    sock.on('data', (d) => received.push(d));

    sock.write('GET /status HTTP/1.1\r\n\r\n');
    await waitFor(() => (opened[0].channel.write as ReturnType<typeof vi.fn>).mock.calls.length > 0);
    expect(Buffer.concat((opened[0].channel.write as ReturnType<typeof vi.fn>).mock.calls.map((c) => Buffer.from(c[0]))).toString()).toBe('GET /status HTTP/1.1\r\n\r\n');

    opened[0].handlers.onData(Buffer.from('HTTP/1.1 200 OK\r\n'));
    await waitFor(() => received.length > 0);
    expect(Buffer.concat(received).toString()).toBe('HTTP/1.1 200 OK\r\n');
    sock.destroy();
    t.close();
  });

  it('closing the local socket closes the channel, and channel exit destroys the local socket', async () => {
    const { registry, opened } = fakeRegistry();
    const t = await openAgentTunnel('m1', { wdaPort: 8137, mjpegPort: 9137 }, registry);
    const a = await connect(t.wdaPort);
    await waitFor(() => opened.length === 1);
    a.end();
    await waitFor(() => (opened[0].channel.close as ReturnType<typeof vi.fn>).mock.calls.length === 1);

    const b = await connect(t.wdaPort);
    await waitFor(() => opened.length === 2);
    const ended = new Promise<void>((r) => b.once('close', () => r()));
    opened[1].handlers.onExit(null);
    await ended;
    t.close();
  });

  it('a refused channel destroys only that local socket; the tunnel stays up', async () => {
    const { registry, opened } = fakeRegistry({ onOpen: () => new AgentRpcError({ code: 'refused', message: 'connection refused' }) });
    const onClose = vi.fn();
    const t = await openAgentTunnel('m1', { wdaPort: 8137, mjpegPort: 9137 }, registry);
    t.onClose(onClose);
    const a = await connect(t.wdaPort);
    await new Promise<void>((r) => a.once('close', () => r()));
    expect(opened).toHaveLength(0);
    expect(onClose).not.toHaveBeenCalled();
    // still listening
    const b = await connect(t.wdaPort);
    await new Promise<void>((r) => b.once('close', () => r()));
    t.close();
  });

  it('the channel limit fails the tunnel with the "no channels" message', async () => {
    const { registry } = fakeRegistry({ onOpen: () => new ChannelLimitError('too many channels') });
    const onClose = vi.fn();
    const t = await openAgentTunnel('m1', { wdaPort: 8137, mjpegPort: 9137 }, registry);
    t.onClose(onClose);
    const a = await connect(t.wdaPort);
    await new Promise<void>((r) => a.once('close', () => r()));
    await waitFor(() => onClose.mock.calls.length === 1);
    expect(onClose.mock.calls[0][0]).toBeInstanceOf(Error);
    expect((onClose.mock.calls[0][0] as Error).message).toBe(NO_CHANNELS_MESSAGE);
    t.close();
  });

  it('refuses to open when the agent is offline, with the pt-BR message', async () => {
    const { registry } = fakeRegistry({ online: false });
    await expect(openAgentTunnel('m1', { wdaPort: 8137, mjpegPort: 9137 }, registry)).rejects.toThrow(AGENT_OFFLINE_MESSAGE);
  });

  it('an offline event for this machine fires onClose exactly once, destroys local sockets and stops listening', async () => {
    const { registry, opened, emitter } = fakeRegistry();
    const onClose = vi.fn();
    const t = await openAgentTunnel('m1', { wdaPort: 8137, mjpegPort: 9137 }, registry);
    t.onClose(onClose);
    const a = await connect(t.wdaPort);
    const b = await connect(t.mjpegPort);
    await waitFor(() => opened.length === 2);

    emitter.emit('offline', 'other-machine');
    expect(onClose).not.toHaveBeenCalled();

    emitter.emit('offline', 'm1');
    opened[0].handlers.onExit(null);
    opened[1].handlers.onExit(null);
    await waitFor(() => a.destroyed && b.destroyed);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect((onClose.mock.calls[0][0] as Error).message).toBe(AGENT_OFFLINE_MESSAGE);
    await expect(connect(t.wdaPort)).rejects.toThrow();
    expect(emitter.listenerCount('offline')).toBe(0);
  });

  it('close() is idempotent and never fires onClose', async () => {
    const { registry } = fakeRegistry();
    const onClose = vi.fn();
    const t = await openAgentTunnel('m1', { wdaPort: 8137, mjpegPort: 9137 }, registry);
    t.onClose(onClose);
    t.close();
    t.close();
    await new Promise((r) => setTimeout(r, 20));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('an AgentOfflineError from openTcp (race with a disconnect) fails the tunnel with the offline message', async () => {
    const { registry } = fakeRegistry({ onOpen: () => new AgentOfflineError('agent offline: m1') });
    const onClose = vi.fn();
    const t = await openAgentTunnel('m1', { wdaPort: 8137, mjpegPort: 9137 }, registry);
    t.onClose(onClose);
    const a = await connect(t.wdaPort);
    await new Promise<void>((r) => a.once('close', () => r()));
    await waitFor(() => onClose.mock.calls.length === 1);
    expect((onClose.mock.calls[0][0] as Error).message).toBe(AGENT_OFFLINE_MESSAGE);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `TH_NODE npm test -w @termhub/server -- src/simulator/agent-tunnel.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Create `apps/server/src/simulator/agent-tunnel.ts`** (TER-26, TER-27)

```ts
import net from 'node:net';
import type { TcpOpenParams } from '@termhub/agent-protocol';
import { AgentClosedError, AgentRpcError, ChannelLimitError, type AgentChannel, type ChannelHandlers } from '../agent/connection.js';
import { AgentOfflineError } from '../agent/registry.js';
import type { WdaPorts } from './ports.js';
import { findFreePort, type Tunnel } from './tunnel.js';

/** What the tunnel needs from the agent registry (`agents` in production; a fake in tests). */
export interface TunnelRegistry {
  isOnline(machineId: string): boolean;
  openTcp(machineId: string, params: TcpOpenParams, handlers: ChannelHandlers): Promise<AgentChannel>;
  on(event: 'offline', cb: (machineId: string) => void): unknown;
  off(event: 'offline', cb: (machineId: string) => void): unknown;
}

export const AGENT_OFFLINE_MESSAGE = 'Agente desconectado';
export const NO_CHANNELS_MESSAGE = 'Máquina sem canais livres';

interface Options {
  log?: (msg: string, meta?: object) => void;
}

/**
 * The agent-machine counterpart of the ssh `-L` tunnel: two local listeners whose every accepted
 * connection becomes a `tcp` channel to the WDA port on the machine. Downstream (`WdaClient`, the
 * MJPEG reader, the session manager) keeps seeing "two local ports" and does not change.
 *
 * A refused channel (runner still starting) only drops that one local socket — the session manager
 * keeps polling `/status`. Anything else that keeps channels from opening (agent offline, channel
 * limit) and the agent going offline end the tunnel through `onClose`, once, so the session manager
 * runs its usual recovery.
 */
export async function openAgentTunnel(machineId: string, remote: WdaPorts, registry: TunnelRegistry, opts: Options = {}): Promise<Tunnel> {
  const log = opts.log ?? (() => {});
  if (!registry.isOnline(machineId)) throw new Error(AGENT_OFFLINE_MESSAGE);

  const closeCbs: ((err?: Error) => void)[] = [];
  const sockets = new Set<net.Socket>();
  const servers: net.Server[] = [];
  let closed = false;

  const teardown = () => {
    registry.off('offline', onOffline);
    for (const s of sockets) s.destroy();
    sockets.clear();
    for (const srv of servers) srv.close();
  };
  const fail = (err: Error) => {
    if (closed) return;
    closed = true;
    log('túnel do agente caiu', { machineId, error: err.message });
    teardown();
    for (const cb of closeCbs) cb(err);
  };
  const onOffline = (id: string) => {
    if (id === machineId) fail(new Error(AGENT_OFFLINE_MESSAGE));
  };
  registry.on('offline', onOffline);

  const forward = async (remotePort: number): Promise<number> => {
    const port = await findFreePort();
    const server = net.createServer((sock) => {
      if (closed) {
        sock.destroy();
        return;
      }
      sockets.add(sock);
      sock.pause();
      let channel: AgentChannel | null = null;
      sock.on('close', () => {
        sockets.delete(sock);
        channel?.close();
      });
      sock.on('error', () => sock.destroy());
      registry
        .openTcp(machineId, { port: remotePort }, {
          onData: (data) => {
            if (!sock.destroyed) sock.write(data);
          },
          onExit: () => sock.destroy(),
        })
        .then((ch) => {
          if (sock.destroyed) {
            ch.close();
            return;
          }
          channel = ch;
          sock.on('data', (d: Buffer) => ch.write(d));
          sock.resume();
        })
        .catch((err: unknown) => {
          sock.destroy();
          if (err instanceof AgentRpcError && err.rpcError.code === 'refused') {
            log('porta do WDA ainda não responde', { machineId, port: remotePort });
            return;
          }
          if (err instanceof ChannelLimitError) return fail(new Error(NO_CHANNELS_MESSAGE));
          if (err instanceof AgentOfflineError || err instanceof AgentClosedError) return fail(new Error(AGENT_OFFLINE_MESSAGE));
          fail(err instanceof Error ? err : new Error(String(err)));
        });
    });
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => resolve());
    });
    return port;
  };

  let wdaPort: number;
  let mjpegPort: number;
  try {
    [wdaPort, mjpegPort] = await Promise.all([forward(remote.wdaPort), forward(remote.mjpegPort)]);
  } catch (err) {
    closed = true;
    teardown();
    throw err;
  }
  log('túnel do agente aberto', { machineId, wdaPort, mjpegPort, remote });

  return {
    wdaPort,
    mjpegPort,
    close() {
      if (closed) return;
      closed = true;
      teardown();
    },
    onClose(cb) {
      closeCbs.push(cb);
    },
  };
}
```

- [ ] **Step 5: Run the agent-tunnel tests**

Run: `TH_NODE npm test -w @termhub/server -- src/simulator/agent-tunnel.test.ts`
Expected: PASS. If the "offline event" test hangs on `a.destroyed && b.destroyed`, check that `teardown()` destroys the sockets synchronously (it does) and that the fake channels' `onExit` are invoked by the test (they are).

- [ ] **Step 6: Dispatch `openTunnel` by machine type** (TER-28)

In `apps/server/src/simulator/tunnel.ts`, at the top of `openTunnel`:

```ts
import { agents } from '../agent/registry.js';
import { openAgentTunnel } from './agent-tunnel.js';
…
export async function openTunnel(machine: Machine, remote: WdaPorts, opts: OpenTunnelOptions = {}): Promise<Tunnel> {
  if (machine.type === 'local') {
    return { wdaPort: remote.wdaPort, mjpegPort: remote.mjpegPort, close() {}, onClose() {} };
  }
  if (machine.type === 'agent') return openAgentTunnel(machine.id, remote, agents);
  … ssh branch unchanged …
```

Watch for an import cycle: `agent-tunnel.ts` imports `findFreePort`/`Tunnel` from `tunnel.ts`, and `tunnel.ts` imports `openAgentTunnel`. Both are ESM function exports used at call time, so the cycle is harmless, but to keep it simple move `findFreePort` and the `Tunnel` interface into a new `apps/server/src/simulator/tunnel-types.ts`, re-export them from `tunnel.ts` (`export { findFreePort, type Tunnel } from './tunnel-types.js';`) and import them from `tunnel-types.js` in `agent-tunnel.ts`. Existing importers of `findFreePort` from `./tunnel.js` keep working.

Test in `apps/server/src/simulator/tunnel.test.ts`:

```ts
describe('openTunnel agent', () => {
  it('máquina de agente offline falha com a mensagem do agente, sem abrir ssh', async () => {
    const machine = { ...sshMachine(), type: 'agent' as const, host: null, ssh_user: null };
    await expect(openTunnel(machine, { wdaPort: 8101, mjpegPort: 9101 }, { sshBin: '/nonexistent/ssh' })).rejects.toThrow('Agente desconectado');
  });
});
```

(`agents` has no connection for that id in a unit test, so `isOnline` is false.)

- [ ] **Step 7: WdaClient keep-alive** (TER-29)

`WdaClient` uses the global `fetch` (undici), whose default dispatcher already keeps connections alive (pipelining 1, 4 s idle timeout); there is no `http.Agent` to configure. Add this comment above the `call` method in `apps/server/src/simulator/wda-client.ts` so the next reader does not go looking for one:

```ts
  // `fetch` (undici) reuses its connection between calls by default (keep-alive, 4 s idle), so a burst
  // of taps travels over one tcp channel on an agent machine instead of one channel per request.
```

No code change; the e2e test in Task 7 asserts two sequential requests do not open two channels.

- [ ] **Step 8: Run the server tests and typecheck**

Run: `TH_NODE npm test -w @termhub/server -- src/simulator src/agent/connection.test.ts src/agent/registry.test.ts && npm run typecheck -w @termhub/server`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/server/src/agent apps/server/src/simulator
git commit -m "Server: agent tunnel for the simulator over tcp channels

openTunnel dispatches agent machines to two local listeners whose
connections become tcp channels on the agent socket; offline and the
channel limit end the tunnel once so the session manager recovers (spec §5.1).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Server — simulator operations by RPC and routes unblocked for agents  (card **TER-17**)

Subtasks: ☐ TER-18 agent branches · ☐ TER-19 requireSimCapable · ☐ TER-20 remove the three 409s · ☐ TER-21 wda refresh after setup · ☐ TER-22 error messages on /ws/sim · ☐ TER-23 tests

**Files:**
- Modify: `apps/server/src/agent/errors.ts`, `apps/server/src/simulator/machine.ts`, `apps/server/src/simulator/setup.ts`, `apps/server/src/routes/machines.ts`, `apps/server/src/routes/projects.ts`, `apps/server/src/routes/tabs.ts`
- Create: `apps/server/src/simulator/machine.agent.test.ts`, `apps/server/src/routes/machines.simulator.test.ts`
- Test: `apps/server/src/agent/errors.test.ts`

**Interfaces:**
- Consumes: `agentRpc`, `agents`, `CAPABILITY_SIM`; parsers `parseSimctlList`, `isBootFailure`, `parseSetupOutput`.
- Produces: `requireSimCapable(machine: Machine): void` and `SIM_MIN_AGENT_VERSION = '0.5.0'` in `agent/errors.ts`.

- [ ] **Step 1: Write the failing tests for the agent branches** (TER-23)

`apps/server/src/simulator/machine.agent.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { agentRpc, runOnMachine } = vi.hoisted(() => ({ agentRpc: vi.fn(), runOnMachine: vi.fn() }));
vi.mock('../agent/errors.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../agent/errors.js')>()), agentRpc }));
vi.mock('../terminal/machine-exec.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../terminal/machine-exec.js')>()), runOnMachine }));

import type { Machine } from '../db/repositories/types.js';
import { bootSimulator, listSimulators, runnerAlive, runnerTail, startRunner } from './machine.js';
import { startWdaSetup, wdaSetupState } from './setup.js';

const machine: Machine = { id: 'm1', name: 'mac', host: null, ssh_user: null, ssh_port: 22, type: 'agent', os: 'macos', capabilities: ['xcodebuild', 'wda'], checked_at: null, owner_id: null, owner_name: null, created_at: '' };
const UDID = 'BAE07EB5-8CA8-4C6E-819A-A0240342FF00';

beforeEach(() => {
  agentRpc.mockReset();
  runOnMachine.mockReset();
});

describe('simulator operations on an agent machine go through named rpcs, never runOnMachine', () => {
  it('listSimulators → sim.list, parsed on the server', async () => {
    agentRpc.mockResolvedValue({ stdout: JSON.stringify({ devices: { 'com.apple.CoreSimulator.SimRuntime.iOS-26-3': [{ udid: UDID, name: 'iPhone 16e', state: 'Booted', isAvailable: true }] } }) });
    await expect(listSimulators(machine)).resolves.toEqual([{ udid: UDID, name: 'iPhone 16e', runtime: 'iOS 26.3', state: 'Booted' }]);
    expect(agentRpc).toHaveBeenCalledWith(machine, 'sim.list', {});
    expect(runOnMachine).not.toHaveBeenCalled();
  });
  it('bootSimulator → sim.boot; "already booted" is not a failure, "Invalid device" is', async () => {
    agentRpc.mockResolvedValue({ stdout: 'Unable to boot device in current state: Booted' });
    await expect(bootSimulator(machine, UDID)).resolves.toBeUndefined();
    expect(agentRpc).toHaveBeenCalledWith(machine, 'sim.boot', { udid: UDID });
    agentRpc.mockResolvedValue({ stdout: 'Invalid device: X' });
    await expect(bootSimulator(machine, UDID)).rejects.toThrow(/simctl boot falhou/);
    expect(runOnMachine).not.toHaveBeenCalled();
  });
  it('startRunner / runnerAlive / runnerTail → wda.runner.*', async () => {
    agentRpc.mockResolvedValue({ started: true });
    await startRunner(machine, UDID, { wdaPort: 8137, mjpegPort: 9137 });
    expect(agentRpc).toHaveBeenCalledWith(machine, 'wda.runner.start', { udid: UDID, wda_port: 8137, mjpeg_port: 9137 });
    agentRpc.mockResolvedValue({ alive: true });
    await expect(runnerAlive(machine, UDID)).resolves.toBe(true);
    expect(agentRpc).toHaveBeenCalledWith(machine, 'wda.runner.alive', { udid: UDID });
    agentRpc.mockResolvedValue({ lines: ['x', 'y'] });
    await expect(runnerTail(machine, UDID, 30)).resolves.toEqual(['x', 'y']);
    expect(agentRpc).toHaveBeenCalledWith(machine, 'wda.runner.tail', { udid: UDID, lines: 30 });
    expect(runOnMachine).not.toHaveBeenCalled();
  });
  it('wdaSetupState / startWdaSetup → wda.setup.*', async () => {
    agentRpc.mockResolvedValue({ stdout: 'STATE:idle\nVERSION:\nTAIL:\n' });
    await expect(wdaSetupState(machine)).resolves.toEqual({ state: 'idle', version: null, tail: [] });
    expect(agentRpc).toHaveBeenCalledWith(machine, 'wda.setup.state', {});
    agentRpc.mockReset();
    agentRpc.mockResolvedValueOnce({ stdout: 'STATE:idle\nVERSION:\nTAIL:\n' }).mockResolvedValueOnce({ started: true });
    await expect(startWdaSetup(machine)).resolves.toBeUndefined();
    expect(agentRpc).toHaveBeenLastCalledWith(machine, 'wda.setup.start', {});
    expect(runOnMachine).not.toHaveBeenCalled();
  });
  it('startWdaSetup answers 409 when the setup already runs', async () => {
    agentRpc.mockResolvedValue({ stdout: 'STATE:running\nVERSION:\nTAIL:\n' });
    await expect(startWdaSetup(machine)).rejects.toMatchObject({ statusCode: 409 });
  });
});
```

Append to `apps/server/src/agent/errors.test.ts` (read how `agents` can be given a fake connection: `registry.test.ts` attaches a fake `AgentConnection`-like object with `hello`; reuse that pattern; `agents.reset()` in `afterEach`):

```ts
describe('requireSimCapable', () => {
  afterEach(() => agents.reset());
  const base = { id: 'm-sim', name: 'mac', host: null, ssh_user: null, ssh_port: 22, os: 'macos', capabilities: [], checked_at: null, owner_id: null, owner_name: null, created_at: '' } as unknown as Machine;
  it('passes non-agent machines through', () => {
    expect(() => requireSimCapable({ ...base, type: 'ssh' })).not.toThrow();
  });
  it('answers 503 AGENT_OFFLINE when the agent is not connected', () => {
    expect(() => requireSimCapable({ ...base, type: 'agent' })).toThrow(expect.objectContaining({ statusCode: 503, code: 'AGENT_OFFLINE' }));
  });
  it('answers 409 AGENT_OUTDATED when the connected agent lacks the sim capability', () => {
    attachFake('m-sim', { agent_version: '0.4.4', capabilities: [] }); // helper from registry.test.ts's pattern
    expect(() => requireSimCapable({ ...base, type: 'agent' })).toThrow(expect.objectContaining({ statusCode: 409, code: 'AGENT_OUTDATED' }));
  });
  it('passes when the agent claims sim', () => {
    attachFake('m-sim', { agent_version: '0.5.0', capabilities: ['sim'] });
    expect(() => requireSimCapable({ ...base, type: 'agent' })).not.toThrow();
  });
});
```

Define `attachFake` in this test file (the same minimal shape `registry.test.ts`'s `fakeConn` uses):

```ts
function attachFake(machineId: string, hello: { agent_version: string; capabilities: string[] }): void {
  const listeners: Record<string, ((...a: unknown[]) => void)[]> = {};
  const conn = {
    machineId,
    hello: { agent_version: hello.agent_version, os: 'macos', tools: ['tmux', 'xcodebuild'], capabilities: hello.capabilities },
    connectedAt: Date.now(),
    close: vi.fn(function (code: number, reason?: string) {
      (listeners.close ?? []).forEach((l) => l(code, reason));
    }),
    rpc: vi.fn(),
    openPty: vi.fn(),
    openClaude: vi.fn(),
    openTcp: vi.fn(),
    on(ev: string, l: (...a: unknown[]) => void) {
      (listeners[ev] ??= []).push(l);
      return this;
    },
  } as unknown as import('./connection.js').AgentConnection;
  agents.attach(machineId, conn);
}
```

(In `routes/machines.simulator.test.ts` the import path is `'../agent/connection.js'`.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `TH_NODE npm test -w @termhub/server -- src/simulator/machine.agent.test.ts src/agent/errors.test.ts`
Expected: FAIL — agent branches missing, `requireSimCapable` not exported.

- [ ] **Step 3: `requireSimCapable`** (TER-19)

In `apps/server/src/agent/errors.ts`:

```ts
import { CAPABILITY_SIM } from '@termhub/agent-protocol';

/** First agent release that advertises `sim` (simulator rpcs + tcp channels). */
export const SIM_MIN_AGENT_VERSION = '0.5.0';

/**
 * The iOS simulator on an agent machine needs the agent online and claiming `sim`. Non-agent machines
 * (ssh/local) pass through: their checks live in the ssh code path. An offline agent is 503 like every
 * other agent call; a connected one without the capability is told, in one sentence, to update.
 */
export function requireSimCapable(machine: Machine): void {
  if (machine.type !== 'agent') return;
  if (!agents.isOnline(machine.id)) throw new HttpError(503, 'Agente desconectado', 'AGENT_OFFLINE');
  const capabilities = agents.capabilities(machine.id) ?? [];
  if (!capabilities.includes(CAPABILITY_SIM)) {
    throw new HttpError(409, `Atualize o agente desta máquina (npm i -g @termhub/agent, versão ${SIM_MIN_AGENT_VERSION} ou mais nova) para usar o simulador`, 'AGENT_OUTDATED');
  }
}
```

- [ ] **Step 4: Agent branches in `machine.ts` and `setup.ts`** (TER-18)

`apps/server/src/simulator/machine.ts`: add `import { agentRpc } from '../agent/errors.js';`, remove the `conflict` import if now unused, and:

```ts
export async function listSimulators(machine: Machine): Promise<Simulator[]> {
  if (machine.type === 'agent') {
    const { stdout } = await agentRpc(machine, 'sim.list', {});
    return parseSimctlList(stdout);
  }
  …
}

export async function bootSimulator(machine: Machine, udid: string): Promise<void> {
  assertUdid(udid);
  if (machine.type === 'agent') {
    const { stdout } = await agentRpc(machine, 'sim.boot', { udid });
    if (isBootFailure(stdout)) throw new Error(`simctl boot falhou: ${stdout.trim()}`);
    return;
  }
  …
}

export async function runnerAlive(machine: Machine, udid: string): Promise<boolean> {
  assertUdid(udid);
  if (machine.type === 'agent') return (await agentRpc(machine, 'wda.runner.alive', { udid })).alive;
  …
}

export async function startRunner(machine: Machine, udid: string, ports: WdaPorts): Promise<void> {
  assertUdid(udid);
  if (machine.type === 'agent') {
    await agentRpc(machine, 'wda.runner.start', { udid, wda_port: ports.wdaPort, mjpeg_port: ports.mjpegPort });
    return;
  }
  …
}

export async function runnerTail(machine: Machine, udid: string, lines = 30): Promise<string[]> {
  assertUdid(udid);
  if (machine.type === 'agent') return (await agentRpc(machine, 'wda.runner.tail', { udid, lines })).lines;
  …
}
```

`apps/server/src/simulator/setup.ts`:

```ts
import { agentRpc } from '../agent/errors.js';
…
export async function wdaSetupState(machine: Machine): Promise<WdaSetupState> {
  if (machine.type === 'agent') return parseSetupOutput((await agentRpc(machine, 'wda.setup.state', {})).stdout);
  …
}

export async function startWdaSetup(machine: Machine): Promise<void> {
  const current = await wdaSetupState(machine);
  if (current.state === 'running') throw conflict('Preparação do WDA já está em andamento');
  if (machine.type === 'agent') {
    const { started } = await agentRpc(machine, 'wda.setup.start', {});
    if (!started) throw conflict('Preparação do WDA já está em andamento');
    return;
  }
  …
}
```

`agentRpc` already converts offline/timeout/rpc failures to `HttpError`s whose `message` the session manager shows as `status: error` — that is how `Agente desconectado` reaches the viewer (TER-22), together with the tunnel's `AGENT_OFFLINE_MESSAGE` / `NO_CHANNELS_MESSAGE` from Task 5.

- [ ] **Step 5: Routes** (TER-20, TER-21)

`apps/server/src/routes/machines.ts`: import `requireSimCapable`, `agentRpc` from `'../agent/errors.js'`, then:

```ts
  app.get('/:id/simulators', async (request) => {
    const { id } = idParam.parse(request.params);
    const machine = await scoped(repos, request).machine(id);
    requireSimCapable(machine);
    requireMac(machine);
    return { simulators: await listSimulators(machine) };
  });

  app.get('/:id/simulator/setup', async (request) => {
    const { id } = idParam.parse(request.params);
    const machine = await scoped(repos, request).machine(id);
    requireSimCapable(machine);
    const state = await wdaSetupState(machine);
    if (state.state === 'ok' && !machine.capabilities.includes('wda')) {
      if (machine.type === 'agent') {
        // The agent reported its tools at hello time, before WDA existed: ask again and store the answer.
        const det = await agentRpc(machine, 'tools.detect', {});
        await repos.machines.setDetected(id, det.os, det.tools);
      } else {
        const status = await machineStatus(machine);
        if (status.online) await repos.machines.setDetected(id, status.os, status.capabilities);
      }
    }
    return state;
  });

  app.post('/:id/simulator/setup', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const machine = await scoped(repos, request).machine(id);
    requireSimCapable(machine);
    requireMac(machine);
    await startWdaSetup(machine);
    return reply.code(202).send({ ok: true });
  });
```

`apps/server/src/routes/projects.ts` (`POST /:id/tabs`): after `const kind = …`, add `if (kind === 'simulator') requireSimCapable(machine);` (import from `'../agent/errors.js'`).

`apps/server/src/routes/tabs.ts` (`PATCH /:id`): after the `Só tabs de simulador têm aparelho` check, add `if (body.simulator_udid !== undefined) requireSimCapable(machine);`.

Grep to confirm no `Simulador indisponível em máquinas com agente` remains: `grep -rn "indisponível em máquinas com agente" apps/server/src` → no output.

- [ ] **Step 6: Route tests** (TER-23)

`apps/server/src/routes/machines.simulator.test.ts`, built on the harness of `machines.test.ts` (copy its `makeMachine` and `buildApp` helpers — or import them if they are exported; if not, copy the minimal parts: Fastify + `applyErrorHandler` + the `preHandler` that sets `request.scope`/`request.user`, and a `repos` stub with `machines.findById`, `machines.setDetected`). Mock `../simulator/machine.js` and `../simulator/setup.js` so no script runs:

```ts
const { listSimulators, wdaSetupState, startWdaSetup, agentRpc } = vi.hoisted(() => ({ listSimulators: vi.fn(), wdaSetupState: vi.fn(), startWdaSetup: vi.fn(), agentRpc: vi.fn() }));
vi.mock('../simulator/machine.js', () => ({ listSimulators }));
vi.mock('../simulator/setup.js', () => ({ wdaSetupState, startWdaSetup }));
vi.mock('../agent/errors.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../agent/errors.js')>()), agentRpc }));

describe('simulator routes on agent machines', () => {
  afterEach(() => agents.reset());
  it('GET /:id/simulators answers 503 AGENT_OFFLINE when the agent is offline', async () => {
    const app = buildApp({ m1: makeMachine({ type: 'agent', os: 'macos', capabilities: ['xcodebuild'] }) });
    const res = await app.inject({ method: 'GET', url: '/m1/simulators' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ code: 'AGENT_OFFLINE' });
  });
  it('answers 409 AGENT_OUTDATED when the connected agent has no sim capability', async () => {
    attachFake('m1', { agent_version: '0.4.4', capabilities: [] });
    const app = buildApp({ m1: makeMachine({ type: 'agent', os: 'macos', capabilities: ['xcodebuild'] }) });
    const res = await app.inject({ method: 'GET', url: '/m1/simulators' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'AGENT_OUTDATED' });
    expect(res.json().message).toContain('0.5.0');
  });
  it('lists simulators when the agent claims sim', async () => {
    attachFake('m1', { agent_version: '0.5.0', capabilities: ['sim'] });
    listSimulators.mockResolvedValue([{ udid: 'A', name: 'iPhone', runtime: 'iOS 26.3', state: 'Booted' }]);
    const app = buildApp({ m1: makeMachine({ type: 'agent', os: 'macos', capabilities: ['xcodebuild'] }) });
    const res = await app.inject({ method: 'GET', url: '/m1/simulators' });
    expect(res.statusCode).toBe(200);
    expect(res.json().simulators).toHaveLength(1);
  });
  it('GET /:id/simulator/setup refreshes capabilities through tools.detect once the setup is ok', async () => {
    attachFake('m1', { agent_version: '0.5.0', capabilities: ['sim'] });
    wdaSetupState.mockResolvedValue({ state: 'ok', tail: [], version: '16.12.8' });
    agentRpc.mockResolvedValue({ os: 'macos', tools: ['xcodebuild', 'wda'] });
    const { app, setDetected } = buildAppWithSpies({ m1: makeMachine({ type: 'agent', os: 'macos', capabilities: ['xcodebuild'] }) });
    const res = await app.inject({ method: 'GET', url: '/m1/simulator/setup' });
    expect(res.statusCode).toBe(200);
    expect(agentRpc).toHaveBeenCalledWith(expect.objectContaining({ id: 'm1' }), 'tools.detect', {});
    expect(setDetected).toHaveBeenCalledWith('m1', 'macos', ['xcodebuild', 'wda']);
  });
  it('POST /:id/simulator/setup starts the setup on a capable agent', async () => {
    attachFake('m1', { agent_version: '0.5.0', capabilities: ['sim'] });
    startWdaSetup.mockResolvedValue(undefined);
    const app = buildApp({ m1: makeMachine({ type: 'agent', os: 'macos', capabilities: ['xcodebuild'] }) });
    const res = await app.inject({ method: 'POST', url: '/m1/simulator/setup' });
    expect(res.statusCode).toBe(202);
  });
});
```

`buildAppWithSpies` is `buildApp` that also returns the `repos.machines.setDetected` spy; write it as a thin wrapper in this file. `attachFake` copied from Step 1 (with the `'../agent/connection.js'` import path).

- [ ] **Step 7: Run the server tests and typecheck**

Run: `TH_NODE npm test -w @termhub/server && npm run typecheck -w @termhub/server`
Expected: PASS (the whole server suite; `machines.test.ts` must still pass — if a test there asserted the old 409 for agent machines, update it to expect 503 `AGENT_OFFLINE`).

- [ ] **Step 8: Commit**

```bash
git add apps/server/src
git commit -m "Server: simulator operations over agent rpcs, routes unblocked

Agent machines list/boot simulators and manage the WDA runner and
setup through the named rpcs; the simulator routes require the sim
capability (409 AGENT_OUTDATED) instead of refusing agents outright,
and the wda capability is refreshed through tools.detect after setup.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: End-to-end tunnel test in CI  (card **TER-14**)

Subtasks: ☐ TER-15 in-process agent + stub server on a WDA port · ☐ TER-16 server opens the tunnel and reads the answer

**Files:**
- Create: `apps/server/src/simulator/agent-tunnel.e2e.test.ts`

**Interfaces:**
- Consumes: `runAgent` (agent source), `registerAgentWs`, `createUpgradeRouter`, `agents`, `openTunnel` (Task 5), `newAgentToken`.

- [ ] **Step 1: Write the e2e test** (TER-15, TER-16)

`apps/server/src/simulator/agent-tunnel.e2e.test.ts` — same scaffold as `apps/server/src/agent/e2e.test.ts` (copy its `fakeLog`, `listen`, `shutdown`, the `vi.mock` of `../auth/*`, the `machine` fixture with `type: 'agent'`, `os: 'macos'`, and the `repos` stub with `findByAgentTokenHash`/`touchAgent`), minus everything tmux-related:

```ts
import http from 'node:http';
import net from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
… (imports as in agent/e2e.test.ts: createUpgradeRouter, registerAgentWs, agents, newAgentToken, runAgent, AgentConfig)
import { openTunnel } from './tunnel.js';

/** A WDA port from the allowed range; the stub answers one fixed HTTP response. */
const WDA_PORT = 8199;
const MJPEG_PORT = 9199;

function startStub(port: number): Promise<net.Server | null> {
  return new Promise((resolve) => {
    const server = net.createServer((sock) => {
      sock.on('data', () => {
        sock.write('HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 22\r\n\r\n{"value":{"ready":true}}');
      });
    });
    server.once('error', () => resolve(null)); // EADDRINUSE on a dev Mac with a real WDA: skip below
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

describe('agent e2e: server tunnel <-> agent tcp channel <-> local WDA port', () => {
  let server: http.Server;
  let port: number;
  let stub: net.Server | null;
  let agentController: AbortController;
  let agentRunPromise: Promise<void>;
  let machine: Machine;

  beforeAll(async () => {
    stub = await startStub(WDA_PORT);
    if (!stub) return;
    const { token, hash } = newAgentToken();
    machine = { … as in agent/e2e.test.ts but id: 'm-sim', os: 'macos' … } as unknown as Machine;
    const repos = { machines: { findById: vi.fn(async () => machine), findByAgentTokenHash: vi.fn(async (h: string) => (h === hash ? machine : undefined)), touchAgent: vi.fn(async () => {}) } } as unknown as Repositories;
    server = http.createServer();
    const router = createUpgradeRouter(server, { auth: {} as AuthContext });
    registerAgentWs(router, { repos, log: fakeLog() });
    port = await listen(server);
    const agentConfig: AgentConfig = { url: `http://127.0.0.1:${port}`, token, machine_id: '', machine_name: '', created_at: new Date().toISOString() };
    agentController = new AbortController();
    agentRunPromise = runAgent(agentConfig, { signal: agentController.signal, log: () => {} }).catch((err) => {
      if (!agentController.signal.aborted) throw err;
    });
    await vi.waitFor(() => expect(agents.isOnline('m-sim')).toBe(true), { timeout: 10_000, interval: 100 });
  });

  afterAll(async () => {
    agentController?.abort();
    await agentRunPromise?.catch(() => {});
    if (server) await shutdown(server);
    if (stub) await new Promise<void>((r) => stub!.close(() => r()));
  });

  it('reads the stub WDA /status through the tunnel, reusing one channel for two requests', { timeout: 20_000 }, async () => {
    if (!stub) return; // port taken on this machine
    const t = await openTunnel(machine, { wdaPort: WDA_PORT, mjpegPort: MJPEG_PORT });
    try {
      const res = await fetch(`http://127.0.0.1:${t.wdaPort}/status`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ value: { ready: true } });
      const channelsAfterFirst = agents.openChannels('m-sim');
      const res2 = await fetch(`http://127.0.0.1:${t.wdaPort}/status`);
      expect(res2.status).toBe(200);
      expect(agents.openChannels('m-sim')).toBeLessThanOrEqual(channelsAfterFirst); // keep-alive: no second channel
    } finally {
      t.close();
    }
    await vi.waitFor(() => expect(agents.openChannels('m-sim')).toBe(0), { timeout: 5_000, interval: 50 });
    expect(agents.isOnline('m-sim')).toBe(true);
  });

  it('an unreachable WDA port yields a failed request but keeps the agent connection', { timeout: 20_000 }, async () => {
    if (!stub) return;
    const t = await openTunnel(machine, { wdaPort: 8198, mjpegPort: 9198 }); // nothing listens there
    try {
      await expect(fetch(`http://127.0.0.1:${t.wdaPort}/status`)).rejects.toThrow();
    } finally {
      t.close();
    }
    expect(agents.isOnline('m-sim')).toBe(true);
  });
});
```

Note on the agent side the `sim` capability is claimed on macOS only, but the tunnel does not check capabilities (the routes do), so this test runs on the Linux CI runner.

- [ ] **Step 2: Run it**

Run: `TH_NODE npm run build:packages && npm test -w @termhub/server -- src/simulator/agent-tunnel.e2e.test.ts`
Expected: PASS (2 tests). If the first request hangs, check that `openAgentTunnel` calls `sock.resume()` after the channel opens (Task 5), and that the agent's `tcp` manager forwards `data` after `opened`.

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/simulator/agent-tunnel.e2e.test.ts
git commit -m "Server: end-to-end test of the simulator tunnel over the agent

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Web — setup card for agents and the new error messages  (card **TER-11**)

Subtasks: ☐ TER-12 SimulatorSetupCard · ☐ TER-13 SimulatorView messages

**Files:**
- Modify: `apps/web/src/components/SimulatorSetupCard.tsx`, `apps/web/src/components/SimulatorView.tsx`

- [ ] **Step 1: `SimulatorSetupCard` for agent machines** (TER-12)

In `apps/web/src/components/SimulatorSetupCard.tsx`:

1. Delete the `if (machine.type === 'agent') { return (… disponível em breve …) }` block.
2. Add state for the two agent conditions next to the existing `error` state:
   ```tsx
   const [agentBlock, setAgentBlock] = useState<'offline' | 'outdated' | null>(null);
   const [outdatedMessage, setOutdatedMessage] = useState<string | null>(null);
   const [updating, setUpdating] = useState(false);
   ```
3. In `load`'s `catch`, before the generic message:
   ```tsx
   } catch (e) {
     if (cancelledRef.current) return;
     if (e instanceof ApiError && e.code === 'AGENT_OFFLINE') {
       setAgentBlock('offline');
       setError(null);
       timer.current = setTimeout(() => void load(), POLL_MS); // the agent may come back
       return;
     }
     if (e instanceof ApiError && e.code === 'AGENT_OUTDATED') {
       setAgentBlock('outdated');
       setOutdatedMessage(e.message);
       setError(null);
       return;
     }
     setError(e instanceof ApiError ? e.message : 'Erro ao consultar o setup');
   }
   ```
   and at the top of the `try` (after a successful `api.machines.wdaSetup`) `setAgentBlock(null);`.
4. An update action for the outdated case:
   ```tsx
   const updateAgent = async () => {
     setUpdating(true);
     try {
       await api.machines.updateAgent(machine.id);
       setOutdatedMessage('Atualizando o agente… ele reinicia e reconecta em instantes.');
       timer.current = setTimeout(() => void load(), POLL_MS * 3);
     } catch (e) {
       setError(e instanceof ApiError ? e.message : 'Erro ao atualizar o agente');
     } finally {
       setUpdating(false);
     }
   };
   ```
5. Render the two blocks before the `if (!isMac)` return:
   ```tsx
   if (agentBlock === 'offline') {
     return (
       <div className="rounded-md border border-line bg-bg p-2 text-xs text-fg-dim">
         <p className="mb-0.5 font-medium text-fg-muted">Simulador iOS</p>
         <p>Conecte o agente para preparar o simulador.</p>
       </div>
     );
   }
   if (agentBlock === 'outdated') {
     return (
       <div className="rounded-md border border-line bg-bg p-2 text-xs">
         <div className="flex items-center gap-2">
           <p className="font-medium text-fg-muted">Simulador iOS</p>
           <button type="button" className="btn-ghost ml-auto px-2 py-0.5" onClick={() => void updateAgent()} disabled={updating}>
             {updating ? '…' : 'Atualizar agente'}
           </button>
         </div>
         <p className="mt-1 text-fg-dim">{outdatedMessage}</p>
         {error && <p className="mt-1 text-danger">{error}</p>}
       </div>
     );
   }
   ```
6. The `useEffect` that calls `load` is gated on `isMac`; for an agent machine `os`/`capabilities` come from `hello` so `isMac` is already right. Keep the gate.

- [ ] **Step 2: `SimulatorView` messages** (TER-13)

The view already renders `message` under the state label with the Reconectar button for `state === 'error'`, so `Agente desconectado` and `Máquina sem canais livres` (sent by the session manager as `status: error` with `message`) display without new code. Make the label match the cause: in `STATE_LABEL` keep `error: 'Erro'`, and where the overlay renders `<p>{STATE_LABEL[state]}</p>`, change to:

```tsx
<p>{state === 'error' && message === 'Agente desconectado' ? 'Agente desconectado' : STATE_LABEL[state]}</p>
{message && message !== 'Agente desconectado' && <p className="text-xs text-danger">{message}</p>}
```

so the offline case reads as one line instead of "Erro / Agente desconectado".

- [ ] **Step 3: Typecheck, test and build the web app**

Run: `TH_NODE npm run typecheck -w @termhub/web && npm test -w @termhub/web && npm run build -w @termhub/web`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/SimulatorSetupCard.tsx apps/web/src/components/SimulatorView.tsx
git commit -m "Web: simulator setup card works for agent machines

Shows the offline and outdated-agent states with an update button
instead of "disponível em breve", and reads the agent-offline error as
one line in the simulator tab (spec §6).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: README and the manual check on the Mac mini  (card **TER-8**)

Subtasks: ☐ TER-9 README paragraph · ☐ TER-10 manual script (done by the user on the Mac mini; not automatable here)

**Files:**
- Modify: `README.md` (section `### Connect a machine with the agent`)

- [ ] **Step 1: README** (TER-9)

Append to the end of the `### Connect a machine with the agent` section:

```markdown
**iOS simulator over the agent.** A Mac with Xcode shows a "Simulador iOS" card in its edit form: *Preparar* clones and builds WebDriverAgent in `~/.termhub/WebDriverAgent` (inside the tmux session `termhub-wda-setup`), after which projects linked to that machine get the simulator button next to "+" in the tab bar. A simulator tab boots the device, starts the WDA runner in tmux (`termhub-wda-<udid8>`) and streams its MJPEG output to the browser at the LAN (scale 50 / quality 50) or Remoto (25 / 30) preset, with tap, drag, keyboard, Home/Lock/Rotate and PNG screenshots. On an agent machine every step is a named RPC (`sim.*`, `wda.*`) and the runner's HTTP and MJPEG ports are reached through `tcp` channels on the agent's WebSocket: loopback only, ports 8100–8199 and 9100–9199 only. The agent advertises the `sim` capability from 0.5.0 (macOS only); an older agent gets `409 AGENT_OUTDATED` with the update sentence, an offline one `503 AGENT_OFFLINE`. Design: `docs/superpowers/specs/2026-09-24-ios-simulator-over-agent-design.md`.
```

- [ ] **Step 2: Full verification before the PR**

Run: `TH_NODE npm run build:packages && npm test && npm run typecheck -w @termhub/server && npm run typecheck -w @termhub/agent && npm run build -w @termhub/web && npm run build -w @termhub/landing`
Expected: PASS end to end (the tmux e2e suite skips inside the `node:20` container, which has no tmux; CI runs it).

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "README: iOS simulator over the agent

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

- [ ] **Step 4: Manual script for the Mac mini** (TER-10 — for the user, after the agent 0.5.0 is published and the server deployed)

1. In Máquinas, open the Mac mini (agent) and click *Atualizar* in the Agente card (or wait for auto-update); the version must read 0.5.0.
2. In the same form, the "Simulador iOS" card shows *não preparado*: click *Preparar*, watch the log tail, wait for *pronto · WDA <version>*.
3. Open a project linked to the Mac mini: the simulator button appears next to "+". Create a simulator tab and pick the iPhone in the device picker.
4. Expect *Ligando o simulador…* → *Subindo o WebDriverAgent…* → *Conectado* with the fps counter moving.
5. Tap an app icon, drag the home screen, type in a text field, press Home, download a screenshot.
6. Switch *Qualidade* to Remoto and back to LAN; the fps/bandwidth changes.
7. On the Mac, restart the agent (`termhub-agent service uninstall && termhub-agent service install`, or kill the process and let launchd restart it): the tab shows *Agente desconectado* then reconnects to the same runner without a new boot.
8. Close the tab; after 5 minutes `tmux ls` on the Mac no longer lists `termhub-wda-<udid8>`.

Report anything that deviates as a bug card under TER-7.

---

## Self-review notes

- Spec coverage: §3 → Task 1; §4.1–4.2 → Task 3; §4.3–4.4 → Tasks 2, 4; §5.1 → Task 5; §5.2–5.4 → Task 6; §6 → Task 8; §7 → tests in Tasks 3, 5, 6; §8 → Tasks 3–7; §9 → Task 9 and the version bump in Task 4; §10 file list → matches the tasks' file lists (plus `tunnel-types.ts` to avoid an import cycle).
- Names used across tasks: `TcpManager`/`createTcpManager`/`bufferedAmount`/`MAX_STREAM_PAYLOAD` (3, 4), `openTcp` (5, 7), `openAgentTunnel`/`TunnelRegistry`/`AGENT_OFFLINE_MESSAGE`/`NO_CHANNELS_MESSAGE` (5, 6), `requireSimCapable`/`SIM_MIN_AGENT_VERSION` (6), `withVars` and the script constants (2, 4), `checkUdid`/`scriptFailure` (4).
- Review Focus items 1–5 map to tests in Tasks 3 (refused, range, slicing), 5 (channel limit, offline once) and 1 (schema).
