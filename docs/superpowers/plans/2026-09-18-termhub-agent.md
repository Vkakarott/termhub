# termhub-agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the `agent` machine transport: a `@termhub/agent` CLI the user runs on a machine that connects outbound to the server over one multiplexed WebSocket, so terminals (PTY) and the fixed set of machine operations work without SSH.

**Architecture:** A shared protocol package defines binary frames (`[uint32 channel][payload]`, channel 0 = JSON control, n ≥ 1 = raw PTY bytes) and zod schemas for every message and RPC. On the server, `agent/` holds one `AgentConnection` per machine in a process-local `AgentRegistry`; every high-level machine operation (`listTmuxSessions`, `collectHardware`, `browseMachine`, `readCredential`, …) gets an `if (machine.type === 'agent')` branch that calls a **named RPC** — the server never sends shell text to an agent. `PtySession` becomes an interface with a local and an agent implementation, chosen by a factory; the browser WebSocket does not change. The agent (`apps/agent`) runs as the user (LaunchAgent / `systemd --user`), reconnects forever with backoff, and executes RPCs with `execFile` and compile-time constant scripts from `@termhub/machine-ops`.

**Tech Stack:** TypeScript (ESM, Node ≥ 20), Fastify, `ws`, `node-pty`, zod, Prisma/PostgreSQL, vitest, React (web), tsup (agent bundle).

**Spec:** `docs/superpowers/specs/2026-09-18-termhub-agent-design.md`

## Global Constraints

- Language: code, comments, commit messages in English; **UI copy in pt-BR**. Commit subject imperative, ≤ 72 chars, body explains why; trailer `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.
- Workspaces are addressed by package name (`-w @termhub/server`), never by path.
- Routes never import Prisma; go through `apps/server/src/db/repositories`. Every request input validated with zod. New route plugins register via `guarded(resource, plugin, prefix)`.
- The server **never** sends shell text to an agent; `runOnMachine`/`runOnMachineWithInput`/`sshBaseArgs` must throw for `agent` machines.
- Never log terminal content, `tmux.capture` text, credential contents or pasted files — metadata only (machine id, channel, method, duration, close code).
- Migrations are additive and backward compatible with the previous release (blue/green).
- Protocol constants: `PROTOCOL_VERSION = 1`; close codes `4401` (bad/revoked token), `4409` (reason `protocol` or `replaced`), `1008` (protocol violation); max 64 stream channels; frame limit 1 MiB except `file.paste` (20 MiB + 1 KiB); RPC timeouts 8 s default, `hw.probe` 15 s, `file.paste` 60 s; agent backoff 1 s → 30 s ×2 with ±20 % jitter; exit code 78 after 3 consecutive 4401 or on 4409 `protocol`.
- Token format `thb_ag_` + 32 random bytes base64url (43 chars); only `sha256` hex stored.
- Session names `^[A-Za-z0-9_-]+$`; paths absolute or `~`/`~/…`, no NUL/newline.
- The host that holds the checkout has no Node: run tests/typecheck through Docker:
  `docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/w" -w /w node:22 sh -c '<command>'` then `rm -rf .npm`. In a fresh worktree run `npm ci --ignore-scripts --no-audit --no-fund` inside the container first (node-pty/argon2 native builds need `apk add python3 make g++` when a test actually spawns a PTY — Task 15).
- Server tests need `DATABASE_URL` only for the drift check; unit tests here stub repositories.

---

## File structure

**Create**
- `packages/agent-protocol/{package.json,tsconfig.json,src/index.ts,src/frames.ts,src/messages.ts,src/rpc.ts,src/frames.test.ts,src/messages.test.ts,src/rpc.test.ts}`
- `packages/machine-ops/{package.json,tsconfig.json,src/index.ts,src/shell.ts,src/detect.ts,src/hardware-script.ts,src/fs-script.ts,src/paste.ts,src/ai-credentials.ts,src/pty.ts,src/detect.test.ts,src/paste.test.ts}`
- `apps/server/prisma/migrations/<ts>_machine_agent/migration.sql`
- `apps/server/src/agent/{token.ts,token.test.ts,connection.ts,connection.test.ts,registry.ts,registry.test.ts,ws.ts,pty.ts,screen.ts,ops.test.ts}`
- `apps/agent/{package.json,tsconfig.json,tsup.config.ts,src/cli.ts,src/config.ts,src/config.test.ts,src/client.ts,src/client.test.ts,src/dispatch.ts,src/dispatch.test.ts,src/pty.ts,src/rpc/index.ts,src/rpc/tmux.ts,src/rpc/tools.ts,src/rpc/hw.ts,src/rpc/fs.ts,src/rpc/ai.ts,src/rpc/paste.ts,src/rpc/tmux.test.ts,src/rpc/fs.test.ts,src/rpc/ai.test.ts,src/rpc/paste.test.ts,src/service/launchd.ts,src/service/systemd.ts,src/service/index.ts,src/service/service.test.ts,src/doctor.ts,src/doctor.test.ts}`
- `apps/server/src/agent/e2e.test.ts`
- `apps/web/src/components/AgentEnrollment.tsx`

**Modify**
- `package.json` (workspaces, test script), `Dockerfile`, `.github/workflows/deploy.yml`
- `apps/server/prisma/schema.prisma`, `apps/server/src/db/repositories/{machines.ts,types.ts}`
- `apps/server/src/terminal/{machine-exec.ts,pty-session.ts,ws.ts,machine-fs.ts,paste-file.ts}`, `apps/server/src/system/hardware.ts`, `apps/server/src/ai/{credentials.ts,claude.ts,chatgpt.ts,gemini.ts,antigravity.ts}`
- `apps/server/src/ws/router.ts`, `apps/server/src/app.ts`, `apps/server/src/routes/machines.ts`, `apps/server/src/simulator/machine.ts`
- `apps/web/src/lib/{types.ts,api.ts}`, `apps/web/src/components/MachineForm.tsx`, the machine card component (`apps/web/src/components/MachinesView.tsx` or wherever the card lives — find with `grep -rn "machines.status" apps/web/src`)
- `README.md`

---

### Task 1: Protocol package (`@termhub/agent-protocol`)

**Files:**
- Create: `packages/agent-protocol/package.json`, `tsconfig.json`, `src/index.ts`, `src/frames.ts`, `src/messages.ts`, `src/rpc.ts`, `src/frames.test.ts`, `src/messages.test.ts`, `src/rpc.test.ts`
- Modify: `package.json` (root: add `"packages/*"` to `workspaces`; add `npm test -w @termhub/agent-protocol` to the `test` script), `Dockerfile` (deps stage: `COPY packages/agent-protocol/package.json packages/agent-protocol/`), `.github/workflows/deploy.yml` (check job: `npm test -w @termhub/agent-protocol` after "Testes web")

**Interfaces:**
- Produces: `encodeFrame(ch: number, payload: Buffer | string): Buffer`, `decodeFrame(buf: Buffer): { ch: number; payload: Buffer }`, `CONTROL_CHANNEL = 0`, `PROTOCOL_VERSION = 1`, `MAX_CHANNELS = 64`, `MAX_FRAME = 1 MiB`, `MAX_PASTE_FRAME = 20 MiB + 1024`, `CLOSE = { UNAUTHORIZED: 4401, CONFLICT: 4409, VIOLATION: 1008 }`; zod schemas `helloMessage`, `agentMessage` (union of hello/rpc_result/opened/open_error/closed), `serverMessage` (union of rpc/open/resize/close); `RPC` record `{ [method]: { params: ZodType, result: ZodType, timeoutMs: number } }` with methods `tmux.list`, `tmux.kill`, `tmux.capture`, `tools.detect`, `hw.probe`, `fs.list`, `fs.mkdir`, `ai.credential`, `file.paste`; `rpcErrorSchema` `{code: 'eperm'|'notfound'|'no_tmux'|'timeout'|'invalid'|'internal', message: string, path?: string}`; types `RpcMethod`, `RpcParams<M>`, `RpcResult<M>`, `AgentMessage`, `ServerMessage`, `RpcError`.

- [ ] **Step 1: Scaffold the package**

`packages/agent-protocol/package.json`:
```json
{
  "name": "@termhub/agent-protocol",
  "version": "0.1.0",
  "private": true,
  "license": "MIT",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
  "scripts": { "build": "tsc -p tsconfig.json", "typecheck": "tsc -p tsconfig.json --noEmit", "test": "vitest run" },
  "dependencies": { "zod": "^3.24.1" },
  "devDependencies": { "typescript": "^5.7.3", "vitest": "^3.2.7" }
}
```
`packages/agent-protocol/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022", "module": "NodeNext", "moduleResolution": "NodeNext",
    "declaration": true, "outDir": "dist", "rootDir": "src", "strict": true,
    "skipLibCheck": true, "types": ["node"]
  },
  "include": ["src"], "exclude": ["src/**/*.test.ts"]
}
```
Add `"@types/node": "^22.10.2"` to devDependencies (match the server's version: `grep '"@types/node"' apps/server/package.json`). Use the same zod major the server uses (`grep '"zod"' apps/server/package.json`).

Root `package.json`: `"workspaces": ["apps/server", "apps/web", "apps/landing", "packages/*"]`.

- [ ] **Step 2: Write the failing frame tests**

`packages/agent-protocol/src/frames.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { CONTROL_CHANNEL, decodeFrame, encodeFrame } from './frames.js';

describe('frames', () => {
  it('round-trips a control frame with a JSON payload', () => {
    const buf = encodeFrame(CONTROL_CHANNEL, '{"type":"ping"}');
    expect(buf.length).toBe(4 + 15);
    expect(decodeFrame(buf)).toEqual({ ch: 0, payload: Buffer.from('{"type":"ping"}') });
  });
  it('round-trips a stream frame with raw bytes', () => {
    const bytes = Buffer.from([0x1b, 0x5b, 0x41, 0x00, 0xff]);
    const { ch, payload } = decodeFrame(encodeFrame(7, bytes));
    expect(ch).toBe(7);
    expect(payload.equals(bytes)).toBe(true);
  });
  it('supports an empty payload', () => {
    expect(decodeFrame(encodeFrame(3, Buffer.alloc(0)))).toEqual({ ch: 3, payload: Buffer.alloc(0) });
  });
  it('rejects a truncated frame', () => {
    expect(() => decodeFrame(Buffer.from([0, 0, 1]))).toThrow(/truncated/);
  });
  it('rejects a negative or non-integer channel', () => {
    expect(() => encodeFrame(-1, 'x')).toThrow();
    expect(() => encodeFrame(1.5, 'x')).toThrow();
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run (inside the Docker node container, after `npm ci --ignore-scripts`): `npm test -w @termhub/agent-protocol`
Expected: FAIL — cannot find module `./frames.js`.

- [ ] **Step 4: Implement frames**

`packages/agent-protocol/src/frames.ts`:
```ts
/** Wire format: every WebSocket message is [channel: uint32 BE][payload]. Channel 0 carries JSON control messages; n >= 1 carries raw PTY bytes. */
export const CONTROL_CHANNEL = 0;
export const HEADER_BYTES = 4;
export const MAX_CHANNELS = 64;
export const MAX_FRAME = 1024 * 1024;
export const MAX_PASTE_FRAME = 20 * 1024 * 1024 + 1024;

export function encodeFrame(ch: number, payload: Buffer | string): Buffer {
  if (!Number.isInteger(ch) || ch < 0 || ch > 0xffffffff) throw new Error(`invalid channel ${ch}`);
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const out = Buffer.allocUnsafe(HEADER_BYTES + body.length);
  out.writeUInt32BE(ch, 0);
  body.copy(out, HEADER_BYTES);
  return out;
}

export function decodeFrame(buf: Buffer): { ch: number; payload: Buffer } {
  if (buf.length < HEADER_BYTES) throw new Error('truncated frame');
  return { ch: buf.readUInt32BE(0), payload: buf.subarray(HEADER_BYTES) };
}
```

- [ ] **Step 5: Run the frame tests**

Run: `npm test -w @termhub/agent-protocol`
Expected: PASS (5 tests).

- [ ] **Step 6: Write the failing message/RPC schema tests**

`packages/agent-protocol/src/messages.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { agentMessage, helloMessage, serverMessage, PROTOCOL_VERSION } from './messages.js';

const hello = { type: 'hello', protocol: PROTOCOL_VERSION, agent_version: '0.1.0', os: 'macos', arch: 'arm64', hostname: 'mini', tmux: true, tools: ['claude', 'gh'] };

describe('control messages', () => {
  it('accepts a valid hello', () => expect(helloMessage.parse(hello)).toEqual(hello));
  it('rejects hello with an unknown os', () => expect(helloMessage.safeParse({ ...hello, os: 'windows' }).success).toBe(false));
  it('caps hostname length', () => expect(helloMessage.safeParse({ ...hello, hostname: 'x'.repeat(300) }).success).toBe(false));
  it('parses agent messages by type', () => {
    expect(agentMessage.parse({ type: 'rpc_result', id: 'r1', ok: true, result: { sessions: [] } }).type).toBe('rpc_result');
    expect(agentMessage.parse({ type: 'rpc_result', id: 'r1', ok: false, error: { code: 'eperm', message: 'no', path: '/x' } }).type).toBe('rpc_result');
    expect(agentMessage.parse({ type: 'opened', ch: 3 }).type).toBe('opened');
    expect(agentMessage.parse({ type: 'closed', ch: 3, code: 0 }).type).toBe('closed');
    expect(agentMessage.safeParse({ type: 'rpc', id: 'x', method: 'tmux.list', params: {} }).success).toBe(false);
  });
  it('parses server messages by type', () => {
    expect(serverMessage.parse({ type: 'rpc', id: 'r1', method: 'tmux.list', params: {} }).type).toBe('rpc');
    expect(serverMessage.parse({ type: 'open', ch: 1, kind: 'pty', params: { session: 'th-a', cwd: '/tmp', cols: 80, rows: 24 } }).type).toBe('open');
    expect(serverMessage.parse({ type: 'resize', ch: 1, cols: 100, rows: 30 }).type).toBe('resize');
    expect(serverMessage.parse({ type: 'close', ch: 1 }).type).toBe('close');
    expect(serverMessage.safeParse({ type: 'open', ch: 0, kind: 'pty', params: { session: 'a', cwd: '/', cols: 1, rows: 1 } }).success).toBe(false);
  });
});
```
`packages/agent-protocol/src/rpc.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { RPC, RPC_METHODS, rpcErrorSchema } from './rpc.js';

describe('rpc catalog', () => {
  it('lists the v1 methods', () => {
    expect([...RPC_METHODS].sort()).toEqual(['ai.credential', 'file.paste', 'fs.list', 'fs.mkdir', 'hw.probe', 'tmux.capture', 'tmux.kill', 'tmux.list', 'tools.detect']);
  });
  it('validates tmux session names', () => {
    expect(RPC['tmux.kill'].params.safeParse({ session: 'th-abc_1' }).success).toBe(true);
    expect(RPC['tmux.kill'].params.safeParse({ session: 'bad name' }).success).toBe(false);
    expect(RPC['tmux.capture'].params.safeParse({ session: 'a', lines: 6000 }).success).toBe(false);
  });
  it('validates paths for fs.list', () => {
    expect(RPC['fs.list'].params.safeParse({ path: '~/proj' }).success).toBe(true);
    expect(RPC['fs.list'].params.safeParse({ path: 'relative' }).success).toBe(false);
    expect(RPC['fs.list'].params.safeParse({ path: '/a\nb' }).success).toBe(false);
  });
  it('bounds file.paste', () => {
    expect(RPC['file.paste'].params.safeParse({ name: 'paste-1.png', data_b64: 'AAAA' }).success).toBe(true);
    expect(RPC['file.paste'].params.safeParse({ name: '../x', data_b64: 'AAAA' }).success).toBe(false);
    expect(RPC['file.paste'].timeoutMs).toBe(60_000);
    expect(RPC['hw.probe'].timeoutMs).toBe(15_000);
    expect(RPC['tmux.list'].timeoutMs).toBe(8_000);
  });
  it('shapes rpc errors', () => {
    expect(rpcErrorSchema.parse({ code: 'eperm', message: 'x', path: '/v' }).code).toBe('eperm');
    expect(rpcErrorSchema.safeParse({ code: 'boom', message: 'x' }).success).toBe(false);
  });
});
```

- [ ] **Step 7: Run them to verify they fail**

Run: `npm test -w @termhub/agent-protocol`
Expected: FAIL — modules `./messages.js` / `./rpc.js` not found.

- [ ] **Step 8: Implement `rpc.ts` and `messages.ts`**

`packages/agent-protocol/src/rpc.ts`:
```ts
import { z } from 'zod';

export const SESSION_RE = /^[A-Za-z0-9_-]+$/;
export const sessionName = z.string().min(1).max(128).regex(SESSION_RE);
/** Absolute, or "~" / "~/…" (expanded on the machine). No NUL or newline. */
export const machinePath = z.string().min(1).max(4096).refine((p) => (p === '~' || p.startsWith('~/') || p.startsWith('/')) && !/[\0\n\r]/.test(p), 'invalid path');
/** Sanitized file name: what paste-file.safeName() produces. */
export const pasteName = z.string().min(1).max(255).regex(/^[A-Za-z0-9._-]+$/);
export const aiProvider = z.enum(['claude', 'chatgpt', 'gemini', 'antigravity']);

export const rpcErrorSchema = z.object({
  code: z.enum(['eperm', 'notfound', 'no_tmux', 'timeout', 'invalid', 'internal']),
  message: z.string().max(2000),
  path: z.string().max(4096).optional(),
});
export type RpcError = z.infer<typeof rpcErrorSchema>;

const DEFAULT_TIMEOUT = 8_000;
const def = <P extends z.ZodTypeAny, R extends z.ZodTypeAny>(params: P, result: R, timeoutMs = DEFAULT_TIMEOUT) => ({ params, result, timeoutMs });

export const RPC = {
  'tmux.list': def(z.object({}), z.object({ sessions: z.array(sessionName) })),
  'tmux.kill': def(z.object({ session: sessionName }), z.object({ killed: z.boolean() })),
  'tmux.capture': def(z.object({ session: sessionName, lines: z.number().int().min(1).max(5000) }), z.object({ text: z.string() })),
  'tools.detect': def(z.object({}), z.object({ os: z.string().nullable(), tools: z.array(z.string().max(32)) })),
  'hw.probe': def(z.object({}), z.object({ stdout: z.string() }), 15_000),
  'fs.list': def(z.object({ path: machinePath }), z.object({ stdout: z.string() })),
  'fs.mkdir': def(z.object({ parent: machinePath, name: z.string().min(1).max(255).regex(/^[^/\\\0\n\r]+$/) }), z.object({ stdout: z.string() })),
  'ai.credential': def(z.object({ provider: aiProvider, config_dir: machinePath.nullable() }), z.object({ stdout: z.string() })),
  'file.paste': def(z.object({ name: pasteName, data_b64: z.string().min(1).max(28 * 1024 * 1024) }), z.object({ path: z.string() }), 60_000),
} as const;

export type RpcMethod = keyof typeof RPC;
export const RPC_METHODS = Object.keys(RPC) as RpcMethod[];
export const rpcMethod = z.enum(RPC_METHODS as [RpcMethod, ...RpcMethod[]]);
export type RpcParams<M extends RpcMethod> = z.infer<(typeof RPC)[M]['params']>;
export type RpcResult<M extends RpcMethod> = z.infer<(typeof RPC)[M]['result']>;
```
`packages/agent-protocol/src/messages.ts`:
```ts
import { z } from 'zod';
import { rpcErrorSchema, rpcMethod, sessionName, machinePath } from './rpc.js';

export const PROTOCOL_VERSION = 1;
export const CLOSE = { UNAUTHORIZED: 4401, CONFLICT: 4409, VIOLATION: 1008 } as const;

const channel = z.number().int().min(1).max(0xffffffff);
const rpcId = z.string().min(1).max(64);

export const helloMessage = z.object({
  type: z.literal('hello'),
  protocol: z.number().int().min(1),
  agent_version: z.string().max(32),
  os: z.enum(['macos', 'linux']),
  arch: z.string().max(16),
  hostname: z.string().max(255),
  tmux: z.boolean(),
  tools: z.array(z.string().max(32)).max(64),
});

export const agentMessage = z.discriminatedUnion('type', [
  helloMessage,
  z.object({ type: z.literal('rpc_result'), id: rpcId, ok: z.literal(true), result: z.unknown() }),
  z.object({ type: z.literal('rpc_result'), id: rpcId, ok: z.literal(false), error: rpcErrorSchema }),
  z.object({ type: z.literal('opened'), ch: channel }),
  z.object({ type: z.literal('open_error'), ch: channel, error: rpcErrorSchema }),
  z.object({ type: z.literal('closed'), ch: channel, code: z.number().int().nullable() }),
]);

export const ptyOpenParams = z.object({ session: sessionName, cwd: machinePath, cols: z.number().int().min(2).max(500), rows: z.number().int().min(2).max(200) });

export const serverMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('rpc'), id: rpcId, method: rpcMethod, params: z.unknown() }),
  z.object({ type: z.literal('open'), ch: channel, kind: z.literal('pty'), params: ptyOpenParams }),
  z.object({ type: z.literal('resize'), ch: channel, cols: z.number().int().min(2).max(500), rows: z.number().int().min(2).max(200) }),
  z.object({ type: z.literal('close'), ch: channel }),
]);

export type HelloMessage = z.infer<typeof helloMessage>;
export type AgentMessage = z.infer<typeof agentMessage>;
export type ServerMessage = z.infer<typeof serverMessage>;
export type PtyOpenParams = z.infer<typeof ptyOpenParams>;
```
Note: `z.discriminatedUnion` does not allow two members with the same literal `type` — if zod rejects the two `rpc_result` shapes, replace those two entries with one `z.object({ type: z.literal('rpc_result'), id: rpcId, ok: z.boolean(), result: z.unknown().optional(), error: rpcErrorSchema.optional() })` and keep the tests (they only check `.type`).

`packages/agent-protocol/src/index.ts`: `export * from './frames.js'; export * from './messages.js'; export * from './rpc.js';`

- [ ] **Step 9: Run all protocol tests and the typecheck**

Run: `npm test -w @termhub/agent-protocol && npm run typecheck -w @termhub/agent-protocol`
Expected: PASS.

- [ ] **Step 10: Wire Dockerfile and CI, commit**

Dockerfile deps stage, after the landing `COPY`: `COPY packages/agent-protocol/package.json packages/agent-protocol/`. CI check job: add a step `- name: Testes protocolo do agente` → `run: npm test -w @termhub/agent-protocol`. Root `test` script: `npm test -w @termhub/agent-protocol && npm test -w @termhub/server && npm test -w @termhub/web`.

```bash
git add package.json package-lock.json Dockerfile .github/workflows/deploy.yml packages/agent-protocol
git commit -m "Agent: add the agent-protocol package

Binary frame codec and zod schemas for the control messages and the
named RPC catalog shared by the server and the agent."
```
(`package-lock.json` changes when `npm install` runs in the container; run `npm install --package-lock-only --ignore-scripts` inside the Docker container to update it without a full install.)

---

### Task 2: Shared machine scripts (`@termhub/machine-ops`)

**Files:**
- Create: `packages/machine-ops/{package.json,tsconfig.json}`, `src/index.ts`, `src/shell.ts`, `src/detect.ts`, `src/hardware-script.ts`, `src/fs-script.ts`, `src/paste.ts`, `src/ai-credentials.ts`, `src/pty.ts`, `src/detect.test.ts`, `src/paste.test.ts`
- Modify: `apps/server/src/terminal/machine-exec.ts`, `apps/server/src/system/hardware.ts`, `apps/server/src/terminal/machine-fs.ts`, `apps/server/src/terminal/paste-file.ts`, `apps/server/src/terminal/pty-session.ts`, `apps/server/src/ai/{claude,chatgpt,gemini,antigravity}.ts`, `apps/server/package.json` (dependency `"@termhub/machine-ops": "*"`), `Dockerfile`, `.github/workflows/deploy.yml`, root `package.json` test script

**Interfaces:**
- Produces (all re-exported from `@termhub/machine-ops`): `shellQuote(s)`, `REMOTE_PATH_PREFIX`, `SESSION_RE`, `assertSessionName(name)`; `DETECT_TOOLS`, `DETECT_SCRIPT`, `parseDetect(stdout) → {os, capabilities}`; `HARDWARE_SCRIPT`; `buildFsListScript(quotedPath)`, `buildMkdirScript(quotedParent, quotedName)`, `EXPAND_HOME`; `PASTE_DIR`, `PASTE_MAX_BYTES`, `PASTE_KEEP_DAYS`, `safeName(original, ext)`, `sniffImage(buf)`, `EXT_BY_MIME`, `buildPasteScript(name)`; `credentialScript(provider) → string` (the `$D`-based sh snippet per provider); `UTF8_LOCALE`, `clampSize(size)`, `ptyEnv(base: NodeJS.ProcessEnv, shell: string) → Record<string,string>`.
- Server modules keep exporting the same names they export today (re-export from the package) so no other server file changes.

- [ ] **Step 1: Scaffold the package** — same `package.json`/`tsconfig.json` shape as Task 1 with name `@termhub/machine-ops`, no runtime deps. Root workspaces already include `packages/*`. Add `COPY packages/machine-ops/package.json packages/machine-ops/` to the Dockerfile deps stage and `npm test -w @termhub/machine-ops` to CI and the root `test` script.

- [ ] **Step 2: Write the failing tests for the moved pure functions**

`packages/machine-ops/src/detect.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { DETECT_SCRIPT, DETECT_TOOLS, parseDetect } from './detect.js';

describe('detect', () => {
  it('maps Darwin to macos and collects CAP lines', () => {
    expect(parseDetect('OS:Darwin\nCAP:tmux\nCAP:claude\n')).toEqual({ os: 'macos', capabilities: ['tmux', 'claude'] });
  });
  it('keeps linux lowercase and tolerates empty output', () => {
    expect(parseDetect('OS:Linux\n')).toEqual({ os: 'linux', capabilities: [] });
    expect(parseDetect('')).toEqual({ os: null, capabilities: [] });
  });
  it('probes every tool of the catalog', () => {
    for (const t of DETECT_TOOLS) expect(DETECT_SCRIPT).toContain(t);
    expect(DETECT_SCRIPT).toContain('CAP:wda');
  });
});
```
`packages/machine-ops/src/paste.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { buildPasteScript, safeName, sniffImage } from './paste.js';

describe('paste', () => {
  it('detects png and jpeg signatures', () => {
    expect(sniffImage(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe('image/png');
    expect(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]))).toBe('image/jpeg');
    expect(sniffImage(Buffer.from('hello'))).toBeNull();
  });
  it('produces a name with only safe characters', () => {
    expect(safeName('my file (1).PNG', 'png')).toMatch(/^paste-\d{8}-\d{6}-[A-Za-z0-9._-]+\.png$/);
    expect(safeName('../../etc/passwd', null)).not.toContain('/');
  });
  it('writes into the fixed paste dir and echoes the path', () => {
    const s = buildPasteScript('paste-1.png');
    expect(s).toContain('$HOME/.cache/termhub/paste');
    expect(s).toContain('cat > "$d/paste-1.png"');
    expect(s).toContain('mtime +7');
  });
});
```
Adjust the `safeName` regex to what the current implementation actually produces (`sed -n 30,58p apps/server/src/terminal/paste-file.ts`) — the test must describe current behaviour, not change it.

- [ ] **Step 3: Run to verify they fail** — `npm test -w @termhub/machine-ops` → FAIL (modules missing).

- [ ] **Step 4: Move the code**

Move, without behaviour change:
- `shellQuote`, `SESSION_RE`, `assertSessionName`, `REMOTE_PATH_PREFIX` from `machine-exec.ts` → `src/shell.ts`.
- `DETECT_TOOLS`, `WDA_RUNNER_APP`, `DETECT_SCRIPT`, `parseDetect` from `machine-exec.ts` → `src/detect.ts`.
- `LINUX`, `DARWIN`, `SCRIPT` (rename export `HARDWARE_SCRIPT`) from `system/hardware.ts` → `src/hardware-script.ts` (the parser `parse()` and its constants stay on the server: only the agent needs the script).
- `buildScript` (rename `buildFsListScript`), `EXPAND_HOME`, and a new `buildMkdirScript(quotedParent, quotedName)` extracted from `makeDirectory` in `machine-fs.ts` → `src/fs-script.ts` (parsers stay on the server).
- `PASTE_DIR`, `PASTE_MAX_BYTES`, `KEEP_DAYS` (export as `PASTE_KEEP_DAYS`), `sniffImage`, `EXT_BY_MIME`, `stamp`, `safeName`, and the script array from `saveFileOnMachine` as `buildPasteScript(name)` → `src/paste.ts`.
- Each adapter's `credentialScript()` body → `src/ai-credentials.ts`:
```ts
export type AiProvider = 'claude' | 'chatgpt' | 'gemini' | 'antigravity';
/** POSIX sh that prints the CLI credential; $D is the provider config dir (already set by the caller). */
export function credentialScript(provider: AiProvider): string { switch (provider) { case 'claude': return …; case 'chatgpt': return …; case 'gemini': return …; case 'antigravity': return …; } }
/** Default CLI config dir (relative to $HOME) per provider. */
export const DEFAULT_CONFIG_DIRS: Record<AiProvider, string> = { claude: '.claude', chatgpt: '.codex', gemini: '.gemini', antigravity: '.gemini' };
/** "~" and "~/x" are expanded on the target machine, never here. Returns the sh prefix that sets $D. */
export function configDirPrefix(configDir: string | null, defaultDir: string): string { … the body of credentials.ts expandDir() … }
```
- `UTF8_LOCALE`, `clampSize`, and the env object built in `PtySession`'s constructor as `ptyEnv(base, shell)` → `src/pty.ts`.

Then in each server module replace the moved code with `import { … } from '@termhub/machine-ops';` and keep re-exports where other server files import them (`export { shellQuote, assertSessionName, REMOTE_PATH_PREFIX, DETECT_TOOLS } from '@termhub/machine-ops';` in `machine-exec.ts`; `export { PASTE_MAX_BYTES, PASTE_DIR, safeName } from '@termhub/machine-ops';` in `paste-file.ts`). Adapters: `credentialScript() { return credentialScript('claude'); }` etc. `ai/index.ts`: `DEFAULT_DIRS` → import `DEFAULT_CONFIG_DIRS`.

- [ ] **Step 5: Run the whole server suite + typecheck**

Run: `npm run prisma:generate && npm test -w @termhub/machine-ops && npm test -w @termhub/server && npm run typecheck -w @termhub/server`
Expected: PASS, no behaviour change (the existing `ai/*.test.ts` and `simulator/machine.test.ts` cover the scripts).

- [ ] **Step 6: Commit**
```bash
git add packages/machine-ops apps/server Dockerfile .github package.json package-lock.json
git commit -m "Agent: extract machine scripts into machine-ops

Moves the sh scripts and pure helpers the server runs on machines into
a package the agent can embed, so the agent never receives script text
from the server. No behaviour change."
```

---

### Task 3: Data model — `agent` machine type and token fields

**Files:**
- Modify: `apps/server/prisma/schema.prisma`, `apps/server/src/db/repositories/types.ts`, `apps/server/src/db/repositories/machines.ts`
- Create: `apps/server/prisma/migrations/<timestamp>_machine_agent/migration.sql`, `apps/server/src/agent/token.ts`, `apps/server/src/agent/token.test.ts`

**Interfaces:**
- Produces: `MachineType = 'local' | 'ssh' | 'agent'`; `Machine` gains `agent_version: string | null`, `agent_last_seen_at: string | null`; `MachinesRepository.findByAgentTokenHash(hash): Promise<Machine | undefined>`, `rotateAgentToken(id, hash): Promise<void>`, `touchAgent(id, patch: { version?: string; os?: string | null; capabilities?: string[]; lastSeenAt: Date }): Promise<void>`; `newAgentToken(): { token: string; hash: string }`, `hashAgentToken(token): string`, `AGENT_TOKEN_RE`.

- [ ] **Step 1: Write the failing token tests**

`apps/server/src/agent/token.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { AGENT_TOKEN_RE, hashAgentToken, newAgentToken } from './token.js';

describe('agent token', () => {
  it('generates thb_ag_ + 43 base64url chars and a sha256 hash', () => {
    const { token, hash } = newAgentToken();
    expect(token).toMatch(AGENT_TOKEN_RE);
    expect(token.length).toBe('thb_ag_'.length + 43);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashAgentToken(token)).toBe(hash);
  });
  it('never repeats', () => expect(newAgentToken().token).not.toBe(newAgentToken().token));
});
```

- [ ] **Step 2: Run → FAIL** (`./token.js` missing).

- [ ] **Step 3: Implement `token.ts`**
```ts
import { createHash, randomBytes } from 'node:crypto';

export const AGENT_TOKEN_RE = /^thb_ag_[A-Za-z0-9_-]{43}$/;
export const hashAgentToken = (token: string): string => createHash('sha256').update(token).digest('hex');
/** 256-bit random token; only the hash is stored. */
export function newAgentToken(): { token: string; hash: string } {
  const token = `thb_ag_${randomBytes(32).toString('base64url')}`;
  return { token, hash: hashAgentToken(token) };
}
```

- [ ] **Step 4: Run → PASS.**

- [ ] **Step 5: Schema + migration**

`schema.prisma`: `enum MachineType { local ssh agent }` and in `model Machine` after `checkedAt`:
```prisma
  /// agent transport: sha256 of the enrollment token (null for local/ssh); the token itself is never stored
  agentTokenHash      String?   @unique @map("agent_token_hash")
  agentTokenCreatedAt DateTime? @map("agent_token_created_at")
  agentVersion        String?   @map("agent_version")
  agentLastSeenAt     DateTime? @map("agent_last_seen_at")
```
Migration (`npx prisma migrate dev --create-only --name machine_agent` inside the container with a throwaway Postgres is the normal path; the host has none, so write it by hand matching Prisma's output):
```sql
ALTER TYPE "MachineType" ADD VALUE 'agent';
ALTER TABLE "machines" ADD COLUMN "agent_token_hash" TEXT,
  ADD COLUMN "agent_token_created_at" TIMESTAMP(3),
  ADD COLUMN "agent_version" TEXT,
  ADD COLUMN "agent_last_seen_at" TIMESTAMP(3);
CREATE UNIQUE INDEX "machines_agent_token_hash_key" ON "machines"("agent_token_hash");
```
Check the enum's actual name in an existing migration (`grep -rn 'TYPE "MachineType"' apps/server/prisma/migrations | head -1`) and the timestamp folder format used there. Postgres cannot use a new enum value in the same transaction it was added: this migration only adds columns, which is fine.

- [ ] **Step 6: Repository and types**

`types.ts`: `export type MachineType = 'local' | 'ssh' | 'agent';` and in `Machine`: `agent_version: string | null; agent_last_seen_at: string | null;`; update `mapMachine` (`agent_version: m.agentVersion ?? null, agent_last_seen_at: m.agentLastSeenAt?.toISOString() ?? null`). Never map the hash.

`machines.ts`:
```ts
  async findByAgentTokenHash(hash: string): Promise<Machine | undefined> {
    const m = await this.db.machine.findUnique({ where: { agentTokenHash: hash }, include: withOwner });
    return m && m.type === 'agent' ? mapMachine(m) : undefined;
  }
  async rotateAgentToken(id: string, hash: string): Promise<void> {
    await this.db.machine.updateMany({ where: { id, type: 'agent' }, data: { agentTokenHash: hash, agentTokenCreatedAt: new Date() } });
  }
  /** Written on hello and once a minute while connected. */
  async touchAgent(id: string, patch: { version?: string; os?: string | null; capabilities?: string[]; lastSeenAt: Date }): Promise<void> {
    await this.db.machine.updateMany({
      where: { id },
      data: {
        agentLastSeenAt: patch.lastSeenAt,
        ...(patch.version !== undefined ? { agentVersion: patch.version } : {}),
        ...(patch.os !== undefined ? { os: patch.os, checkedAt: patch.lastSeenAt } : {}),
        ...(patch.capabilities !== undefined ? { capabilities: patch.capabilities } : {}),
      },
    });
  }
```
`MachineInput.type` already uses `MachineType`. In `create`, when `type === 'agent'` force `host/sshUser` null.

- [ ] **Step 7: Generate, typecheck, run tests**

Run: `npm run prisma:generate && npm run typecheck -w @termhub/server && npm test -w @termhub/server`
Expected: typecheck surfaces every `switch`/ternary on `machine.type` that is not exhaustive — fix each by treating `agent` explicitly (Tasks 7–8 add the real branches; for now make `runOnMachine`, `runOnMachineWithInput` and `sshBaseArgs` throw `new Error('Máquina do tipo agente não executa shell')` when `machine.type === 'agent'`, and `machineStatus` return `{ online: false, tmux: false, os: null, capabilities: [] }` for agents — replaced in Task 8).

- [ ] **Step 8: Commit**
```bash
git add apps/server/prisma apps/server/src/db apps/server/src/agent/token.ts apps/server/src/agent/token.test.ts apps/server/src/terminal/machine-exec.ts
git commit -m "Agent: add the agent machine type and token columns

Additive migration; only the sha256 of the enrollment token is stored.
Shell helpers refuse agent machines so a missed branch fails loudly."
```

---

### Task 4: `AgentConnection` (server side of the protocol)

**Files:**
- Create: `apps/server/src/agent/connection.ts`, `apps/server/src/agent/connection.test.ts`

**Interfaces:**
- Consumes: `@termhub/agent-protocol` (frames, `serverMessage`, `agentMessage`, `RPC`, `MAX_CHANNELS`, `CLOSE`).
- Produces:
```ts
export interface SocketLike extends EventEmitter { send(data: Buffer, cb?: (err?: Error) => void): void; close(code?: number, reason?: string): void; terminate(): void; ping(): void; readyState: number; }
export interface PtyHandlers { onData(data: Buffer): void; onExit(code: number | null): void; }
export interface AgentPtyChannel { readonly ch: number; write(data: Buffer | string): void; resize(cols: number, rows: number): void; close(): void; }
export class AgentTimeoutError extends Error {}; export class AgentRpcError extends Error { constructor(public readonly rpcError: RpcError) }; export class AgentClosedError extends Error {}
export class AgentConnection extends EventEmitter {
  constructor(socket: SocketLike, opts: { machineId: string; log: LoggerLike; now?: () => number });
  readonly machineId: string; hello: HelloMessage | null; readonly connectedAt: number;
  /** resolves with the validated hello or rejects (closes 1008) if it does not arrive in 5 s / is invalid */
  waitHello(timeoutMs?: number): Promise<HelloMessage>;
  rpc<M extends RpcMethod>(method: M, params: RpcParams<M>, timeoutMs?: number): Promise<RpcResult<M>>;
  openPty(params: PtyOpenParams, handlers: PtyHandlers): Promise<AgentPtyChannel>;
  close(code: number, reason?: string): void;
  heartbeat(): void; // call every 20 s: if no pong since last call → terminate
  // events: 'close' (code, reason)
}
```

- [ ] **Step 1: Write the failing tests**

`apps/server/src/agent/connection.test.ts`:
```ts
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { CLOSE, CONTROL_CHANNEL, decodeFrame, encodeFrame, PROTOCOL_VERSION } from '@termhub/agent-protocol';
import { AgentConnection, AgentTimeoutError } from './connection.js';

class FakeSocket extends EventEmitter {
  sent: Buffer[] = [];
  closed: { code?: number; reason?: string } | null = null;
  readyState = 1;
  send(data: Buffer) { this.sent.push(Buffer.from(data)); }
  close(code?: number, reason?: string) { this.closed = { code, reason }; this.readyState = 3; this.emit('close', code, Buffer.from(reason ?? '')); }
  terminate() { this.close(1006, ''); }
  ping() {}
  /** helpers */
  control() { return this.sent.filter((b) => decodeFrame(b).ch === CONTROL_CHANNEL).map((b) => JSON.parse(decodeFrame(b).payload.toString())); }
  streams(ch: number) { return this.sent.filter((b) => decodeFrame(b).ch === ch).map((b) => decodeFrame(b).payload); }
  recvControl(msg: object) { this.emit('message', encodeFrame(CONTROL_CHANNEL, JSON.stringify(msg)), true); }
  recvStream(ch: number, data: Buffer) { this.emit('message', encodeFrame(ch, data), true); }
}
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => log };
const hello = { type: 'hello', protocol: PROTOCOL_VERSION, agent_version: '0.1.0', os: 'linux', arch: 'x64', hostname: 'h', tmux: true, tools: ['tmux'] };
function connected() { const s = new FakeSocket(); const c = new AgentConnection(s, { machineId: 'm1', log }); const p = c.waitHello(); s.recvControl(hello); return { s, c, p }; }

describe('AgentConnection', () => {
  it('requires hello first and closes 1008 on anything else', async () => {
    const s = new FakeSocket(); const c = new AgentConnection(s, { machineId: 'm1', log });
    const p = c.waitHello();
    s.recvControl({ type: 'opened', ch: 1 });
    await expect(p).rejects.toThrow();
    expect(s.closed?.code).toBe(CLOSE.VIOLATION);
  });
  it('resolves hello and exposes it', async () => {
    const { c, p } = connected();
    expect((await p).hostname).toBe('h');
    expect(c.hello?.os).toBe('linux');
  });
  it('sends an rpc frame and resolves with the validated result', async () => {
    const { s, c } = connected();
    const pending = c.rpc('tmux.list', {});
    const [msg] = s.control().filter((m) => m.type === 'rpc');
    expect(msg.method).toBe('tmux.list');
    s.recvControl({ type: 'rpc_result', id: msg.id, ok: true, result: { sessions: ['a'] } });
    await expect(pending).resolves.toEqual({ sessions: ['a'] });
  });
  it('rejects an rpc whose result fails the schema', async () => {
    const { s, c } = connected();
    const pending = c.rpc('tmux.list', {});
    const [msg] = s.control().filter((m) => m.type === 'rpc');
    s.recvControl({ type: 'rpc_result', id: msg.id, ok: true, result: { sessions: 'nope' } });
    await expect(pending).rejects.toThrow(/invalid rpc result/);
  });
  it('times out an rpc and ignores the late result', async () => {
    vi.useFakeTimers();
    const { s, c } = connected();
    const pending = c.rpc('tmux.list', {}, 100);
    vi.advanceTimersByTime(101);
    await expect(pending).rejects.toBeInstanceOf(AgentTimeoutError);
    const [msg] = s.control().filter((m) => m.type === 'rpc');
    expect(() => s.recvControl({ type: 'rpc_result', id: msg.id, ok: true, result: { sessions: [] } })).not.toThrow();
    vi.useRealTimers();
  });
  it('opens a pty channel, relays bytes both ways and reports exit', async () => {
    const { s, c } = connected();
    const onData = vi.fn(); const onExit = vi.fn();
    const opening = c.openPty({ session: 'th-a', cwd: '/tmp', cols: 80, rows: 24 }, { onData, onExit });
    const [open] = s.control().filter((m) => m.type === 'open');
    expect(open.ch).toBe(1);
    s.recvControl({ type: 'opened', ch: 1 });
    const ch = await opening;
    ch.write('ls\n');
    expect(s.streams(1)[0]?.toString()).toBe('ls\n');
    s.recvStream(1, Buffer.from('out'));
    expect(onData).toHaveBeenCalledWith(Buffer.from('out'));
    ch.resize(100, 30);
    expect(s.control().at(-1)).toEqual({ type: 'resize', ch: 1, cols: 100, rows: 30 });
    s.recvControl({ type: 'closed', ch: 1, code: 0 });
    expect(onExit).toHaveBeenCalledWith(0);
  });
  it('refuses more than 64 channels', async () => {
    const { s, c } = connected();
    for (let i = 0; i < 64; i++) { const p = c.openPty({ session: 'th-a', cwd: '/tmp', cols: 80, rows: 24 }, { onData() {}, onExit() {} }); s.recvControl({ type: 'opened', ch: i + 1 }); await p; }
    await expect(c.openPty({ session: 'th-a', cwd: '/tmp', cols: 80, rows: 24 }, { onData() {}, onExit() {} })).rejects.toThrow(/channels/);
  });
  it('closes 1008 on a malformed frame or unknown channel', async () => {
    const { s } = connected();
    s.recvStream(42, Buffer.from('x'));
    expect(s.closed?.code).toBe(CLOSE.VIOLATION);
  });
  it('fails pending rpcs and open channels when the socket closes', async () => {
    const { s, c } = connected();
    const onExit = vi.fn();
    const opening = c.openPty({ session: 'th-a', cwd: '/tmp', cols: 80, rows: 24 }, { onData() {}, onExit });
    s.recvControl({ type: 'opened', ch: 1 }); await opening;
    const pending = c.rpc('tmux.list', {});
    s.close(1006, '');
    await expect(pending).rejects.toThrow(/closed/);
    expect(onExit).toHaveBeenCalledWith(null);
  });
  it('terminates when two heartbeats pass without a pong', () => {
    const { s, c } = connected();
    c.heartbeat(); s.emit('pong'); c.heartbeat(); c.heartbeat();
    expect(s.closed?.code).toBe(1006);
  });
});
```

- [ ] **Step 2: Run → FAIL** (`./connection.js` missing).

- [ ] **Step 3: Implement `connection.ts`**

Key points (write the full class):
- Constructor attaches `socket.on('message', (data, isBinary) => this.onMessage(data))`, `on('close', (code, reason) => this.onClose(code, reason))`, `on('pong', () => (this.alive = true))`, `on('error', …)`.
- `onMessage`: `decodeFrame` in try/catch → violation. `ch === 0` → JSON.parse + `agentMessage.safeParse`; failure → violation. Before hello: only `hello` accepted (resolve `waitHello`), otherwise violation. `rpc_result` → look up pending by id; unknown id → ignore (log debug); `ok:true` → `RPC[method].result.safeParse(result)` else reject `new Error('invalid rpc result for <method>')`; `ok:false` → reject `new AgentRpcError(error)`. `opened`/`open_error` → resolve/reject the channel's open promise. `closed` → call `handlers.onExit(code)`, delete channel. `ch > 0` → channel lookup; unknown → violation; else `handlers.onData(payload)`.
- `rpc`: `id = r${++seq}`; `send(encodeFrame(0, JSON.stringify({type:'rpc', id, method, params})))`; timer `timeoutMs ?? RPC[method].timeoutMs` → reject `AgentTimeoutError('agent rpc timeout: <method>')` and delete pending.
- `openPty`: if `channels.size >= MAX_CHANNELS` reject `Error('too many channels')`; `ch = nextChannel()` (smallest free ≥ 1); store `{handlers, open: {resolve,reject}}`; send `open`; timeout 10 s → reject + delete. Returned `AgentPtyChannel`: `write` → `send(encodeFrame(ch, data))`; `resize` → control `resize`; `close` → control `close` + delete channel (no `onExit`).
- `violation(reason)`: `log.warn({machineId, reason})`, `socket.close(CLOSE.VIOLATION, reason)`.
- `onClose`: reject all pending with `AgentClosedError('agent connection closed')`, call `onExit(null)` for every channel, clear maps, `emit('close', code, reason)`.
- `heartbeat()`: `if (!this.alive) return socket.terminate(); this.alive = false; socket.ping();` (initial `alive = true`).
- Logging: `log.info({ machineId, method, ms })` on rpc completion; never params/results.

- [ ] **Step 4: Run → PASS** (`npm test -w @termhub/server -- agent/connection`).

- [ ] **Step 5: Commit** — `git commit -m "Agent: server-side connection with mux, rpc and pty channels"`.

---

### Task 5: `AgentRegistry`

**Files:**
- Create: `apps/server/src/agent/registry.ts`, `apps/server/src/agent/registry.test.ts`

**Interfaces:**
- Produces:
```ts
export class AgentOfflineError extends Error {}
export interface AgentInfo { agent_version: string; os: 'macos' | 'linux'; tools: string[]; connected_at: string; }
export class AgentRegistry extends EventEmitter {
  attach(machineId: string, conn: AgentConnection): void; // replaces an existing one: old.close(CLOSE.CONFLICT, 'replaced')
  isOnline(machineId: string): boolean;
  info(machineId: string): AgentInfo | null;
  rpc<M extends RpcMethod>(machineId: string, method: M, params: RpcParams<M>, timeoutMs?: number): Promise<RpcResult<M>>; // rejects AgentOfflineError synchronously-ish when offline
  openPty(machineId: string, params: PtyOpenParams, handlers: PtyHandlers): Promise<AgentPtyChannel>;
  disconnect(machineId: string, code: number, reason?: string): void;
  reset(): void; // tests
  // events: 'online' (machineId, hello), 'offline' (machineId)
}
export const agents = new AgentRegistry(); // process-wide singleton used by the machine operations
```

- [ ] **Step 1: Failing tests**
```ts
import { describe, expect, it, vi } from 'vitest';
import { CLOSE } from '@termhub/agent-protocol';
import { AgentOfflineError, AgentRegistry } from './registry.js';

function fakeConn(machineId: string) {
  const listeners: Record<string, ((...a: unknown[]) => void)[]> = {};
  return {
    machineId, hello: { agent_version: '0.1.0', os: 'linux', tools: ['tmux'] }, connectedAt: Date.now(),
    close: vi.fn(function (this: unknown, code: number, reason?: string) { (listeners.close ?? []).forEach((l) => l(code, reason)); }),
    rpc: vi.fn(async () => ({ sessions: ['a'] })), openPty: vi.fn(),
    on(ev: string, l: (...a: unknown[]) => void) { (listeners[ev] ??= []).push(l); return this; },
  } as unknown as import('./connection.js').AgentConnection;
}

describe('AgentRegistry', () => {
  it('tracks online state and emits events', () => {
    const r = new AgentRegistry(); const online = vi.fn(); const offline = vi.fn();
    r.on('online', online); r.on('offline', offline);
    const c = fakeConn('m1'); r.attach('m1', c);
    expect(r.isOnline('m1')).toBe(true); expect(online).toHaveBeenCalledWith('m1', c.hello);
    c.close(1000); expect(r.isOnline('m1')).toBe(false); expect(offline).toHaveBeenCalledWith('m1');
  });
  it('replaces an existing connection with 4409 replaced', () => {
    const r = new AgentRegistry(); const a = fakeConn('m1'); const b = fakeConn('m1');
    r.attach('m1', a); r.attach('m1', b);
    expect(a.close).toHaveBeenCalledWith(CLOSE.CONFLICT, 'replaced');
    expect(r.isOnline('m1')).toBe(true);
    a.close(CLOSE.CONFLICT, 'replaced'); // the old one's close event must not mark m1 offline
    expect(r.isOnline('m1')).toBe(true);
  });
  it('rejects rpc for an offline machine', async () => {
    await expect(new AgentRegistry().rpc('m9', 'tmux.list', {})).rejects.toBeInstanceOf(AgentOfflineError);
  });
  it('forwards rpc to the connection', async () => {
    const r = new AgentRegistry(); const c = fakeConn('m1'); r.attach('m1', c);
    await expect(r.rpc('m1', 'tmux.list', {})).resolves.toEqual({ sessions: ['a'] });
    expect(c.rpc).toHaveBeenCalledWith('tmux.list', {}, undefined);
  });
});
```

- [ ] **Step 2: Run → FAIL. Step 3: Implement** (guard in the close listener: `if (this.conns.get(machineId) === conn) { delete; emit('offline') }`). **Step 4: Run → PASS.**

- [ ] **Step 5: Commit** — `git commit -m "Agent: registry of connected machines"`.

---

### Task 6: `/agent/ws` upgrade route and wiring

**Files:**
- Modify: `apps/server/src/ws/router.ts` (add `addPublic`), `apps/server/src/app.ts`
- Create: `apps/server/src/agent/ws.ts`
- Test: `apps/server/src/agent/ws.test.ts`

**Interfaces:**
- Consumes: `hashAgentToken`, `repos.machines.findByAgentTokenHash/touchAgent`, `AgentConnection`, `agents`.
- Produces: `registerAgentWs(router, { repos, log, registry = agents }): WebSocketServer`; `router.addPublic(pattern, handler: (ctx: { req, socket, head, url, params }) => void | Promise<void>)` — runs **before** cookie auth and skips the `terminals:read` check (the route authenticates itself).

- [ ] **Step 1: Failing tests** (`ws.test.ts`, using a real `http.Server` + `ws` client on port 0):
  - no `Authorization` → HTTP 401 on upgrade;
  - bearer that hashes to nothing → 401;
  - valid token: upgrade succeeds; sending `hello` makes `registry.isOnline(machineId)` true and `repos.machines.touchAgent` called with `{ version: '0.1.0', os: 'linux', capabilities: ['tmux'], lastSeenAt: expect.any(Date) }`;
  - valid token but no hello within 200 ms (pass `helloTimeoutMs` option) → closed 1008;
  - hello with `protocol: 99` → closed 4409 reason `protocol`.
  Stub `repos` as `{ machines: { findByAgentTokenHash: async (h) => h === hashAgentToken(GOOD) ? machine : undefined, touchAgent: vi.fn() } } as unknown as Repositories`.

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement**

`router.ts`: keep a second list `publicRoutes`; in the `upgrade` listener match public routes first: `if (pub) { try { await pub.handler({req, socket, head, url, params}) } catch { rejectUpgrade(socket, 500, …) } return; }`. Public routes skip `originAllowed` too (agents send no Origin; a browser cannot set `Authorization` on a WebSocket, so CSWSH does not apply).

`agent/ws.ts`:
```ts
export function registerAgentWs(router, deps: { repos: Repositories; log: FastifyBaseLogger; registry?: AgentRegistry; helloTimeoutMs?: number }) {
  const registry = deps.registry ?? agents;
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PASTE_FRAME });
  const log = deps.log.child({ mod: 'agent-ws' });
  router.addPublic(/^\/agent\/ws\/?$/, async ({ req, socket, head }) => {
    const auth = req.headers.authorization ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    if (!AGENT_TOKEN_RE.test(token)) return rejectUpgrade(socket, 401, 'Unauthorized');
    const machine = await deps.repos.machines.findByAgentTokenHash(hashAgentToken(token));
    if (!machine) return rejectUpgrade(socket, 401, 'Unauthorized');
    wss.handleUpgrade(req, socket, head, (ws) => {
      const conn = new AgentConnection(ws, { machineId: machine.id, log });
      conn.waitHello(deps.helloTimeoutMs).then(async (hello) => {
        if (hello.protocol > PROTOCOL_VERSION) return conn.close(CLOSE.CONFLICT, 'protocol');
        registry.attach(machine.id, conn);
        const touch = (extra = {}) => deps.repos.machines.touchAgent(machine.id, { lastSeenAt: new Date(), ...extra }).catch((err) => log.warn({ err, machineId: machine.id }, 'touchAgent failed'));
        await touch({ version: hello.agent_version, os: hello.os, capabilities: hello.tools });
        const seen = setInterval(() => void touch(), 60_000);
        const beat = setInterval(() => conn.heartbeat(), 20_000);
        conn.on('close', () => { clearInterval(seen); clearInterval(beat); });
        log.info({ machineId: machine.id, agentVersion: hello.agent_version, os: hello.os }, 'agent connected');
      }, () => { /* waitHello already closed the socket */ });
    });
  });
  return wss;
}
```
`app.ts`: after `registerTerminalWs`, add `registerAgentWs(upgrades, { repos, log: fastify.log });`.

- [ ] **Step 4: Run → PASS** (`npm test -w @termhub/server -- agent/ws`).

- [ ] **Step 5: Commit** — `git commit -m "Agent: /agent/ws upgrade route authenticated by bearer token"`.

---

### Task 7: PTY over the agent

**Files:**
- Modify: `apps/server/src/terminal/pty-session.ts` (interface + rename class to `LocalPtySession` + `createPtySession`), `apps/server/src/terminal/ws.ts`
- Create: `apps/server/src/agent/pty.ts`, `apps/server/src/agent/pty.test.ts`

**Interfaces:**
- Produces in `pty-session.ts`: `export interface PtySession { write(data: string | Buffer): void; resize(size: Partial<PtySize>): void; kill(): void; readonly pid: number | null; }`, `export class LocalPtySession implements PtySession` (today's class), `export async function createPtySession(machine, project, tab, size, handlers): Promise<PtySession>` — `agent` → `AgentPtySession.open(...)`, else `new LocalPtySession(...)`.
- `agent/pty.ts`: `export class AgentPtySession implements PtySession { static async open(registry: AgentRegistry, machine, project, tab, size, handlers): Promise<AgentPtySession> }` — validates `tab.kind === 'terminal' && tab.tmux_session`, `assertSessionName`, calls `registry.openPty(machine.id, { session, cwd: project.cwd, ...clampSize(size) }, { onData: (b) => handlers.onData(b.toString('utf8')), onExit: (code) => handlers.onExit(code ?? 1) })`. Throws `AgentOfflineError` when offline (caught in `ws.ts`).
- `ws.ts`: `handleConnection` becomes async; wraps `await createPtySession(...)`; on `AgentOfflineError` → `send({ type: 'error', message: 'Agente desconectado' }); ws.close(1011, 'agent offline')`; other errors keep today's `'Falha ao iniciar terminal'`.

- [ ] **Step 1: Failing test (`agent/pty.test.ts`)**: with a fake registry whose `openPty` records params and returns a channel with `write/resize/close` spies: `open` maps cols/rows through `clampSize` (600 → 500), `write` forwards, `resize` forwards, `kill` calls `close`, `onData` receives a string, offline registry rejects with `AgentOfflineError`.
- [ ] **Step 2: Run → FAIL. Step 3: Implement. Step 4: Run → PASS**, plus `npm run typecheck -w @termhub/server`.
- [ ] **Step 5: Commit** — `git commit -m "Agent: terminal tabs attach through the agent connection"`.

---

### Task 8: Named-RPC branches for machine operations + `captureScreen`

**Files:**
- Modify: `apps/server/src/terminal/machine-exec.ts` (`machineStatus`, `listTmuxSessions`, `killTmuxSession`), `apps/server/src/system/hardware.ts` (`collectHardware`), `apps/server/src/terminal/machine-fs.ts` (`browseMachine`, `makeDirectory`, `ensureDirectory`), `apps/server/src/ai/credentials.ts` (`readCredential`), `apps/server/src/terminal/paste-file.ts` (`saveFileOnMachine`)
- Create: `apps/server/src/agent/screen.ts`, `apps/server/src/agent/ops.test.ts`

**Interfaces:**
- Each function starts with an agent branch that calls `agents.rpc(machine.id, <method>, params)` and feeds the `stdout` into the **existing parser** (hardware `parse`, fs `parseOutput`, `adapter.parseCredential`). `machineStatus` for agents: `{ online: agents.isOnline(id), tmux: info?.tools.includes('tmux') ?? false, os: machine.os, capabilities: machine.capabilities }` — no RPC.
- Error mapping: `AgentOfflineError` → `HttpError(503, 'Agente desconectado')`; `AgentTimeoutError` → `HttpError(504, 'A máquina não respondeu')`; `AgentRpcError` with `eperm` → `HttpError(403, 'Sem acesso à pasta na máquina (Acesso Total ao Disco?)')`, `notfound` → 404, others → 502. Put this in `agent/errors.ts` as `toHttpError(err)` and use it in every branch.
- `captureScreen(machine, session, lines = 500): Promise<string>` — agent: `tmux.capture`; local/ssh: `runOnMachine(machine, { file: tmux(), args: ['capture-pane', '-p', '-S', `-${lines}`, '-t', `=${session}`] }, `${REMOTE_PATH_PREFIX}tmux capture-pane -p -S -${lines} -t '=${session}'`)`. Internal only.

- [ ] **Step 1: Failing tests (`ops.test.ts`)**: `vi.mock('node:child_process')` so `execFile`/`spawn` are spies; `agents.reset()` in `beforeEach`; attach a fake connection whose `rpc` returns canned stdout for each method; for an `agent` machine assert each of `listTmuxSessions`, `killTmuxSession`, `collectHardware`, `browseMachine`, `makeDirectory`, `readCredential(machine, claudeAdapter, null, '.claude')`, `saveFileOnMachine`, `captureScreen` calls `rpc` with the right method/params and **`execFile`/`spawn` were never called**; offline machine → `HttpError` 503 from `browseMachine`; `runOnMachine` on an agent machine throws.
- [ ] **Step 2: Run → FAIL. Step 3: Implement the branches. Step 4: Run → PASS**; run the whole server suite.
- [ ] **Step 5: Commit** — `git commit -m "Agent: machine operations use named RPCs for agent machines"`.

---

### Task 9: Machine routes — enrollment token, rotation, live status

**Files:**
- Modify: `apps/server/src/routes/machines.ts`, `apps/server/src/simulator/machine.ts` (agent → `conflict('Simulador indisponível em máquinas com agente')` in `listSimulators`), `apps/server/src/app.ts` (pass nothing new: routes use the `agents` singleton)
- Test: `apps/server/src/routes/machines.test.ts`

**Interfaces:**
- `machineBody.type` → `z.enum(['local', 'ssh', 'agent'])`; refine: `agent` with `host` set → issue `'máquina com agente não tem host'`.
- `POST /` for `agent`: `const { token, hash } = newAgentToken(); const machine = await repos.machines.create({...}); await repos.machines.rotateAgentToken(machine.id, hash); reply.code(201).send({ machine, agent_token: token })`.
- `POST /:id/agent-token` (`config: { action: 'update' }`): scoped machine must be `agent`; rotate; `agents.disconnect(id, CLOSE.UNAUTHORIZED, 'rotated')`; `{ agent_token }`.
- `GET /:id/status` for agents: `{ id, ...(await machineStatus(machine)), agent_version: info?.agent_version ?? machine.agent_version, last_seen_at: machine.agent_last_seen_at, checked_at: now }` and skip `setDetected`.
- `DELETE /:id`: `agents.disconnect(id, CLOSE.UNAUTHORIZED, 'deleted')` after the repo delete.
- `PATCH /:id` must not allow changing `type` to/from `agent` (issue `'tipo de transporte não pode ser alterado'`).

- [ ] **Step 1: Failing tests** with stubbed repos (pattern of `waitlist.test.ts`): create agent machine returns `agent_token` matching `AGENT_TOKEN_RE` and calls `rotateAgentToken` with its hash; create with `host` → 400; rotate returns a new token and calls `agents.disconnect`; status for an offline agent machine reports `online:false` without calling `execFile`.
- [ ] **Step 2: Run → FAIL. Step 3: Implement. Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `git commit -m "Agent: enroll and rotate agent machines from the API"`.

---

### Task 10: Agent package — config store and connecting client

**Files:**
- Create: `apps/agent/package.json`, `apps/agent/tsconfig.json`, `apps/agent/tsup.config.ts`, `apps/agent/src/config.ts`, `apps/agent/src/config.test.ts`, `apps/agent/src/client.ts`, `apps/agent/src/client.test.ts`, `apps/agent/src/version.ts`
- Modify: root `package.json` (`test` script adds `npm test -w @termhub/agent`), `.github/workflows/deploy.yml` (check job: `npm test -w @termhub/agent`), `Dockerfile` deps stage (`COPY apps/agent/package.json apps/agent/` — needed for `npm ci` in the monorepo even though the agent is not part of the image)

**Interfaces:**
- `package.json`: name `@termhub/agent`, version `0.1.0`, `"bin": { "termhub-agent": "./dist/cli.js" }`, `"files": ["dist"]`, deps `ws`, `node-pty` (same version as the server), `zod`; devDeps `tsup`, `typescript`, `vitest`, `@types/ws`, `@types/node`, `@termhub/agent-protocol`, `@termhub/machine-ops` (dev: bundled by tsup `noExternal: ['@termhub/agent-protocol', '@termhub/machine-ops']`); scripts `build: tsup`, `typecheck: tsc --noEmit`, `test: vitest run`, `dev: tsx src/cli.ts`.
- `config.ts`: `agentHome(): string` (`TERMHUB_AGENT_HOME` or `~/.termhub`), `readConfig(): AgentConfig | null`, `writeConfig(c: AgentConfig): void` (mkdir 0700, write 0600), `deleteConfig()`. `AgentConfig = { url: string; token: string; machine_id: string; machine_name: string; created_at: string }` (zod-validated on read).
- `client.ts`:
```ts
export interface ClientOptions { url: string; token: string; hello: Omit<HelloMessage, 'type' | 'protocol'>; onServerMessage(msg: ServerMessage, conn: AgentSocket): void; onStream(ch: number, data: Buffer): void; log: (msg: string, meta?: object) => void; backoff?: { minMs: number; maxMs: number }; maxUnauthorized?: number; }
export interface AgentSocket { sendControl(msg: AgentMessage): void; sendStream(ch: number, data: Buffer): void; }
export class RevokedError extends Error {}; export class ProtocolMismatchError extends Error {}
/** Connects once; resolves with the socket after the WebSocket opens and hello is sent; rejects on 4401/4409/network error. */
export function connectOnce(opts): Promise<{ socket: AgentSocket; closed: Promise<{ code: number; reason: string }> }>;
/** Runs forever with backoff; throws RevokedError after `maxUnauthorized` consecutive 4401, ProtocolMismatchError on 4409 'protocol'. */
export function runForever(opts, signal?: AbortSignal): Promise<never>;
export function nextBackoff(prevMs: number, min: number, max: number, rand = Math.random): number; // ×2, capped, ±20 % jitter
```
The URL is derived: `https://app.x` → `wss://app.x/agent/ws`, `http://localhost:3000` → `ws://localhost:3000/agent/ws`.

- [ ] **Step 1: Failing tests**
  - `config.test.ts`: uses a temp dir via `TERMHUB_AGENT_HOME`; write → file mode `0o600` and dir `0o700` (`fs.statSync(...).mode & 0o777`); read round-trips; corrupt JSON → `null`.
  - `client.test.ts`: start a real `WebSocketServer` on port 0 with a `verifyClient` that checks `Authorization`; (a) `connectOnce` sends the bearer, the first frame is a `hello` with `protocol: 1`; (b) server closing 4401 → `closed` resolves `{code: 4401}`; (c) `runForever` with `backoff {minMs: 5, maxMs: 20}` and `maxUnauthorized: 3` against a server that always closes 4401 rejects with `RevokedError` after exactly 3 connection attempts; (d) server closes 4409 reason `protocol` → `ProtocolMismatchError`; (e) `nextBackoff(1000, 1000, 30000, () => 0.5)` → 2000, `nextBackoff(20000, …)` → 30000 cap, jitter within ±20 %.
- [ ] **Step 2: Run → FAIL. Step 3: Implement. Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `git commit -m "Agent: package skeleton with config store and reconnecting client"`.

---

### Task 11: Agent RPC handlers and dispatch

**Files:**
- Create: `apps/agent/src/rpc/{index.ts,tmux.ts,tools.ts,hw.ts,fs.ts,ai.ts,paste.ts}`, `apps/agent/src/rpc/{tmux,fs,ai,paste}.test.ts`, `apps/agent/src/dispatch.ts`, `apps/agent/src/dispatch.test.ts`, `apps/agent/src/exec.ts`

**Interfaces:**
- `exec.ts`: `run(file: string, args: string[], opts?: { timeoutMs?: number; input?: Buffer; env?: NodeJS.ProcessEnv }) → Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }>` via `execFile`; `agentEnv()` returns `process.env` with `PATH` prefixed by `$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin`; `sh(script: string, opts)` = `run('/bin/sh', ['-c', script], opts)` — **`script` must be a constant imported from `@termhub/machine-ops` or built by its builders; never a value from the server.**
- `rpc/index.ts`: `export const handlers: { [M in RpcMethod]: (params: RpcParams<M>) => Promise<RpcResult<M>> }`.
  - `tmux.list`: `run(tmux, ['list-sessions', '-F', '#{session_name}'])` → `{ sessions }` (non-zero exit → `[]`).
  - `tmux.kill`: `run(tmux, ['kill-session', '-t', `=${session}`])` → `{ killed: code === 0 }`.
  - `tmux.capture`: `run(tmux, ['capture-pane', '-p', '-S', `-${lines}`, '-t', `=${session}`])` → `{ text }`; non-zero → `RpcFailure('notfound')`.
  - `tools.detect`: `sh(DETECT_SCRIPT)` → `parseDetect` → `{ os, tools: capabilities }`.
  - `hw.probe`: `sh(HARDWARE_SCRIPT, { timeoutMs: 14000 })` → `{ stdout }`.
  - `fs.list`: `sh(buildFsListScript(shellQuote(path)))` → `{ stdout }`; if stdout contains `ERR:eperm` (the script prints it when `ls` fails with permission denied — add that case to the shared script if missing) → `RpcFailure('eperm', path)`.
  - `fs.mkdir`: `sh(buildMkdirScript(shellQuote(parent), shellQuote(name)))` → `{ stdout }`.
  - `ai.credential`: `sh(`${configDirPrefix(config_dir, DEFAULT_CONFIG_DIRS[provider])}; ${credentialScript(provider)}`)` → `{ stdout }`.
  - `file.paste`: decode base64 (reject > `PASTE_MAX_BYTES` → `invalid`), `sh(buildPasteScript(name), { input })` → `{ path: last stdout line }`.
  - `class RpcFailure extends Error { constructor(public code: RpcError['code'], message: string, public path?: string) }`.
- `dispatch.ts`: `createDispatcher(deps: { handlers; pty: PtyManager; log })` returns `(msg: ServerMessage, socket: AgentSocket) => void`: `rpc` → `RPC[method].params.safeParse` (fail → `rpc_result ok:false invalid`), run handler, reply `rpc_result` (`RpcFailure` → its code; other errors → `internal` with a generic message, stack logged locally); `open` → `pty.open`; `resize`/`close` → `pty`. `PtyManager` interface `{ open(ch, params, socket): Promise<void>; resize(ch, cols, rows): void; close(ch): void; closeAll(): void }` (implemented in Task 12).

- [ ] **Step 1: Failing tests** — mock `./exec.js` (`vi.mock`) and assert exact `file`/`args` for each handler (`tmux.capture` with `lines: 200` → `['capture-pane','-p','-S','-200','-t','=th-a']`); `fs.list` maps `ERR:eperm` to `RpcFailure('eperm')`; `file.paste` rejects > 20 MiB and passes the decoded bytes as `input`; `ai.credential` builds the `$D` prefix from `DEFAULT_CONFIG_DIRS`; dispatch: invalid params → `ok:false code:'invalid'`, handler throwing → `internal`, `RpcFailure` → its code, and `sendControl` is called with the same `id`.
- [ ] **Step 2: Run → FAIL. Step 3: Implement. Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `git commit -m "Agent: named RPC handlers and dispatcher"`.

---

### Task 12: Agent PTY channels

**Files:**
- Create: `apps/agent/src/pty.ts`, `apps/agent/src/pty.test.ts`

**Interfaces:**
- `createPtyManager(deps: { spawn?: typeof pty.spawn; tmuxPath?: string; log }) → PtyManager` (interface from Task 11). `open(ch, params, socket)`: `spawn(tmux, ['-u', 'new-session', '-A', '-s', params.session, '-c', params.cwd], { name: 'xterm-256color', cols, rows, cwd: existsDir(params.cwd) ? params.cwd : HOME, env: { ...ptyEnv(agentEnv(), process.env.SHELL ?? '/bin/sh'), TERMHUB_TAB_ID: params.session, TERMHUB_SESSION: params.session } })`; `onData` → `socket.sendStream(ch, Buffer.from(data))`; `onExit` → `socket.sendControl({ type: 'closed', ch, code })` + delete; after spawn → `socket.sendControl({ type: 'opened', ch })`; spawn throwing → `open_error` with `no_tmux` when `ENOENT`, else `internal`. Incoming stream bytes: `write(ch, data)` → `proc.write(data.toString('utf8'))`. `resize`, `close` (kill; no `closed` message needed — the `onExit` will send it), `closeAll` on disconnect.

- [ ] **Step 1: Failing tests** with an injected fake `spawn` returning `{ onData(cb), onExit(cb), write, resize, kill, pid }`: open sends `opened` and exact tmux argv with `-A`; env has `TERM`, UTF-8 `LANG`, `TERMHUB=1`, `TERMHUB_TAB_ID`; data from the fake goes out on the channel; `write` forwards; exit sends `closed` with the code; `ENOENT` → `open_error no_tmux`; `closeAll` kills every proc.
- [ ] **Step 2: Run → FAIL. Step 3: Implement. Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `git commit -m "Agent: attach tmux sessions over pty channels"`.

---

### Task 13: CLI, service files, doctor

**Files:**
- Create: `apps/agent/src/cli.ts`, `apps/agent/src/run.ts`, `apps/agent/src/service/{index.ts,launchd.ts,systemd.ts}`, `apps/agent/src/service/service.test.ts`, `apps/agent/src/doctor.ts`, `apps/agent/src/doctor.test.ts`, `apps/agent/README.md`

**Interfaces:**
- `run.ts`: `runAgent(config: AgentConfig, { signal, log })` — builds `hello` (`os` from `process.platform` → `macos`/`linux`, `arch`, `hostname`, `tmux` = `tools.detect` result includes `tmux`, `tools`), creates the pty manager + dispatcher, calls `runForever`; on `RevokedError` prints `Token revogado. Rode: termhub-agent connect --url <url>` and `process.exit(78)`; on `ProtocolMismatchError` prints `Atualize o agente: npm i -g @termhub/agent` and exits 78. (CLI output is **user-facing copy → pt-BR**; logs in English.)
- `cli.ts` (hand-rolled argv parsing with `node:util.parseArgs`; no CLI framework): commands `connect`, `run`, `status`, `disconnect`, `service install|uninstall|status`, `doctor [paths…]`, `--version`, `--help`. `connect`: prompts for the token with `readline` when `--token` absent (echo off is not needed; read one line); `connectOnce` with the config's hello; on success `writeConfig` and then `runAgent` in foreground.
- `service/launchd.ts`: `renderPlist({ label: 'dev.termhub.agent', node: process.execPath, script: <path of dist/cli.js>, logPath })` → XML with `RunAtLoad`, `KeepAlive: { SuccessfulExit: false }`, `ProgramArguments: [node, script, 'run']`, `EnvironmentVariables.PATH`; `install()` writes `~/Library/LaunchAgents/dev.termhub.agent.plist` then `launchctl bootout gui/$UID <plist>` (ignore failure) + `launchctl bootstrap gui/$UID <plist>`.
- `service/systemd.ts`: `renderUnit(...)` with `Restart=on-failure`, `RestartPreventExitStatus=78`, `RestartSec=2`; `install()` writes `~/.config/systemd/user/termhub-agent.service`, runs `systemctl --user daemon-reload` and `systemctl --user enable --now termhub-agent`, prints the `loginctl enable-linger $USER` note.
- `doctor.ts`: `runDoctor(paths: string[]) → DoctorReport { config, server, tmux, nodePty, paths: { path, ok, error? }[] }` and `formatDoctor(report)` (pt-BR lines with ✓/✗; for `EPERM` on macOS the Full Disk Access sentence with `process.execPath`).

- [ ] **Step 1: Failing tests** — plist/unit snapshots (`expect(renderPlist(...)).toMatchInlineSnapshot()`), `formatDoctor` with an `EPERM` entry contains `Acesso Total ao Disco` and the node path; `runDoctor` with an injected `fs` that throws `EPERM` for one path reports `ok:false`.
- [ ] **Step 2: Run → FAIL. Step 3: Implement. Step 4: Run → PASS**; `npm run build -w @termhub/agent` produces `dist/cli.js` with a `#!/usr/bin/env node` banner (tsup `banner`); `node apps/agent/dist/cli.js --help` prints usage.
- [ ] **Step 5: Commit** — `git commit -m "Agent: CLI with connect, run, service install and doctor"`.

---

### Task 14: Web — agent enrollment and live status

**Files:**
- Modify: `apps/web/src/lib/types.ts`, `apps/web/src/lib/api.ts` (`create` returns `{ machine, agent_token?: string }`; add `rotateAgentToken(id)`; `status` gains `agent_version?`, `last_seen_at?`), `apps/web/src/components/MachineForm.tsx`, the machine card component
- Create: `apps/web/src/components/AgentEnrollment.tsx`

**Interfaces:**
- `AgentEnrollment({ machine, token, onConnected })`: renders the three steps with `CopyButton` (reuse from `MachineForm.tsx` — export it), the macOS note, and polls `api.machines.status(machine.id)` every 3 s until `online`, then shows `conectado ✓ · {os} · agente {agent_version}` and calls `onConnected`.
- `MachineForm`: `type` state `'agent' | 'ssh' | 'local'`, default `'agent'` for new machines; buttons order agent → ssh → local with labels `Agente (recomendado)`, `SSH (legado)`, `Local`; after `create` with `agent_token` in the response switch the modal body to `<AgentEnrollment>`; editing an agent machine shows a **Rotacionar token** button (confirm with `window.confirm('Gerar um novo token? O agente atual será desconectado.')`) that calls `rotateAgentToken` and shows `<AgentEnrollment>` with the new token; type buttons disabled when editing.
- Machine card: for `type === 'agent'` show the live dot from `status.online`, `agente {agent_version}`, and `visto há {relative(last_seen_at)}` when offline; hide simulator controls with the text `Simulador iOS: disponível em breve para agentes`.

- [ ] **Step 1: Write the component test** (`AgentEnrollment.test.tsx`, vitest + testing-library as the web package already uses — check `apps/web/package.json`): renders the `connect` command containing the token and `window.location.origin`; after a mocked `status` resolves `online:true`, shows `conectado`.
- [ ] **Step 2: Run → FAIL. Step 3: Implement. Step 4: Run → PASS**; `npm run build -w @termhub/web`.
- [ ] **Step 5: Commit** — `git commit -m "Web: enroll agent machines and show their live status"`.

---

### Task 15: End-to-end test (server + agent + real tmux) and CI

**Files:**
- Create: `apps/server/src/agent/e2e.test.ts`
- Modify: `.github/workflows/deploy.yml` (check job: `sudo apt-get install -y tmux` before tests; `npm test -w @termhub/agent`), `apps/server/vitest.config.ts` (if needed: `testTimeout: 20000` for this file via `describe.configure`… vitest 3: `it('...', { timeout: 20000 }, fn)`)

- [ ] **Step 1: Write the test** — skipped when `tmux` is not on PATH (`which tmux`) so local Docker runs without tmux still pass:
  1. Build a Fastify app with the real `createUpgradeRouter`, `registerAgentWs` and `registerTerminalWs`, stub repos (`machines.findByAgentTokenHash` → machine `m1` type `agent`; `tabs`/`Scoped` stubbed to return `{ tab: { id: 't1', kind: 'terminal', tmux_session: 'thtest-e2e' }, project: { cwd: tmpDir }, machine }`; `resolveUser`/`canAccess` stubbed to a user with `terminals:read`), listen on port 0.
  2. Start the agent in-process: `runForever({ url: `http://127.0.0.1:${port}`, token, hello, onServerMessage: dispatcher, onStream: pty.write })` with `TMUX_TMPDIR` set to a temp dir so it never touches the real tmux server.
  3. Wait for `agents.isOnline('m1')`.
  4. Open `ws://127.0.0.1:${port}/ws/tabs/t1?cols=80&rows=24`, wait for `{type:'ready'}`, send `echo E2E_OK\n` as binary, collect binary frames until the text contains `E2E_OK`.
  5. `await captureScreen(machine, 'thtest-e2e', 50)` contains `E2E_OK`.
  6. Cleanup: `tmux -L`/`TMUX_TMPDIR` kill-server, abort the agent, close the server.
- [ ] **Step 2: Run** in Docker with tmux: `docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/w" -w /w node:22 sh -c 'apt-get update >/dev/null && apt-get install -y tmux >/dev/null; npm test -w @termhub/server -- agent/e2e'` (needs root for apt: drop `-u` for this run, then `chown` nothing — tests write only to tmp). Expected: PASS.
- [ ] **Step 3: CI**: add `- run: sudo apt-get update && sudo apt-get install -y tmux` before the server tests; add `npm test -w @termhub/agent`.
- [ ] **Step 4: Commit** — `git commit -m "Agent: end-to-end test through a real tmux"`.

---

### Task 16: Docs, image and deploy checks

**Files:**
- Modify: `README.md` (section "Conectar uma máquina com o agente": install, connect, service, doctor, FDA note, how it differs from SSH), `Dockerfile` (verify the runner stage still only ships server + web; `packages/*` are bundled into `apps/server/dist`? — **no**: the server imports `@termhub/agent-protocol` and `@termhub/machine-ops` at runtime from `node_modules`, so the runner stage must copy them: `COPY --from=build --chown=app:app /app/packages ./packages` and the workspace symlinks in `node_modules/@termhub` must survive `npm prune` — verify with `docker build -t termhub-test . && docker run --rm termhub-test node -e "import('@termhub/agent-protocol').then(m=>console.log(Object.keys(m).length))"`), `deploy/blue-green.sh` (nothing to change; note that agents reconnect after the switch).

- [ ] **Step 1: Write the README section** (English, ≤ 60 lines, with the exact commands from Task 13).
- [ ] **Step 2: Build the production image locally** (`docker build -t termhub-agent-check .`) and run the import check above. Fix `Dockerfile` until it passes.
- [ ] **Step 3: Full verification** in the node container: `npm run prisma:generate && npm test && npm run typecheck -w @termhub/server && npm run build -w @termhub/web && npm run build -w @termhub/landing && npm run build -w @termhub/agent`.
- [ ] **Step 4: Commit** — `git commit -m "Agent: document enrollment and ship the shared packages in the image"`.
- [ ] **Step 5: Open the PR** (`gh pr create --head <branch> --body-file <file>`), let `check` run, merge per the user's standing instruction, watch the deploy, then on jarvis confirm `docker ps --filter name=termhub-app` healthy and `curl -s -o /dev/null -w '%{http_code}' -H 'Host: app.termhub.dev' http://127.0.0.1/` → 200.

---

## Self-review

**Spec coverage:** §3 protocol → Task 1; shared scripts → Task 2; §7 data/API → Tasks 3, 9; §4 server (connection, registry, ws, pty, screen, branches) → Tasks 4–8; §5 agent (client, config, dispatch, RPCs, pty, CLI, service, doctor, packaging) → Tasks 10–13; §8 web → Task 14; §10 tests incl. e2e → every task + Task 15; §6 Docker/CI → Tasks 1, 2, 10, 15, 16; §9 failure table → Tasks 4 (violations, close), 6 (4401/4409), 7 (offline tab), 8 (`toHttpError`), 10 (backoff, exit 78), 12 (`no_tmux`), 13 (exit codes, doctor). Simulator 409 → Task 9. Out of scope items untouched.

**Type consistency:** `AgentConnection.rpc(method, params, timeoutMs?)` (Task 4) is what `AgentRegistry.rpc` forwards (Task 5, asserts `toHaveBeenCalledWith('tmux.list', {}, undefined)`) and what Task 8 branches call through `agents.rpc(machine.id, …)`. `PtyHandlers.onData(Buffer)` on the connection vs `PtySessionHandlers.onData(string)` on the terminal side — converted in `AgentPtySession` (Task 7). `RpcFailure` (agent, Task 11) vs `AgentRpcError` (server, Task 4) are intentionally different classes on different sides. `touchAgent` signature identical in Tasks 3 and 6.

**Placeholders:** none; the two "check the current implementation" notes (paste `safeName` regex, enum name in migrations) instruct reading existing code, not inventing.
