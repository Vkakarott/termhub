# Agent update from the UI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show per agent machine that a newer `@termhub/agent` is on npm, let the user update it with one click, and optionally auto-update idle machines.

**Architecture:** Server-driven. The server polls the npm registry (cached hourly), compares with the version each agent reported in `hello`, decorates `GET /machines` / `GET /machines/:id/status` with `update_available`, and triggers the update through a new RPC `agent.update`. The agent installs the requested version with npm and exits non-zero when it runs as a service so launchd/systemd relaunch the new code.

**Tech Stack:** TypeScript, Fastify + zod (server), Prisma 7 (Postgres), vitest, React + Tailwind (web), node `execFile` (agent).

**Spec:** `docs/superpowers/specs/2026-09-20-agent-update-ui-design.md`

## Global Constraints

- Agent version becomes **0.2.1** (`apps/agent/package.json` and `apps/agent/src/version.ts` must match; `version.test.ts` asserts it). `MIN_SELF_UPDATE_VERSION = '0.2.1'`.
- RPC `agent.update` params: `{ version: /^\d+\.\d+\.\d+$/ }`; result `{ installed_version: string, restart: 'service' | 'manual' }`; timeout `180_000`.
- The version string is only ever an argv element (`run(npm, [...])`), never passed to `sh()`.
- Agent exit code after a service update is **1** (never 78, which stops the restart loop).
- npm registry URL: `https://registry.npmjs.org/@termhub/agent/latest`; refresh every 60 min; auto-update tick every 10 min; one attempt per (machine, version).
- Idle = `AgentConnection.channels.size === 0`.
- Column `machines.agent_auto_update BOOLEAN NOT NULL DEFAULT false` (additive; blue/green safe).
- Route `POST /machines/:id/agent/update` uses `{ config: { action: 'update' } }` (grant `machines:update`, admins bypass) — the same as the hooks routes.
- Never log credential/terminal content; log only machine id, versions, restart mode, exit code.
- Code comments and commit messages in English (imperative subject ≤ 72 chars); UI copy in pt-BR.
- Commits end with `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.
- Shell: `export PATH=$HOME/.nvm/versions/node/v22.23.1/bin:$PATH` before npm/vitest. `@termhub/agent-protocol` and `@termhub/machine-ops` are consumed from `dist/`: run `npm run build:packages` after editing them and before server/agent tests.
- Deviation from the spec (decided while planning): the list badge goes in the **Sidebar machine row** (`apps/web/src/components/Sidebar.tsx`, which already shows `v{agent_version}`), not in `ProjectsByMachine`; success feedback is an inline note in the card, no toast.

---

### Task 1: Protocol + agent handler `agent.update` (agent 0.2.1)

**Files:**
- Modify: `packages/agent-protocol/src/rpc.ts` (the `RPC` object)
- Modify: `packages/agent-protocol/src/rpc.test.ts`
- Create: `apps/agent/src/rpc/update.ts`
- Create: `apps/agent/src/rpc/update.test.ts`
- Modify: `apps/agent/src/rpc/index.ts` (handlers map)
- Modify: `apps/agent/package.json` (`"version": "0.2.1"`), `apps/agent/src/version.ts` (`AGENT_VERSION = '0.2.1'`)

**Interfaces:**
- Produces: RPC method `'agent.update'` with params `{ version: string }` and result `{ installed_version: string; restart: 'service' | 'manual' }` (timeout 180 000 ms). Server tasks call it as `agents.rpc(id, 'agent.update', { version }, 180_000)`.

- [ ] **Step 1: Failing protocol test**

In `packages/agent-protocol/src/rpc.test.ts`, add `'agent.update'` to the expected sorted method list (it sorts first) and this test:

```ts
  it('validates agent.update versions', () => {
    expect(RPC['agent.update'].params.safeParse({ version: '0.2.1' }).success).toBe(true);
    expect(RPC['agent.update'].params.safeParse({ version: 'latest' }).success).toBe(false);
    expect(RPC['agent.update'].params.safeParse({ version: '0.2.1; rm -rf /' }).success).toBe(false);
    expect(RPC['agent.update'].timeoutMs).toBe(180_000);
  });
```

Run: `npm test -w @termhub/agent-protocol` — expected: FAIL (method list mismatch, `RPC['agent.update']` undefined).

- [ ] **Step 2: Add the method**

In `packages/agent-protocol/src/rpc.ts`, inside `RPC` after `'hooks.uninstall'`:

```ts
  /** Installs `version` of @termhub/agent with npm; when the agent runs as a service it then exits so the service relaunches the new code (since agent 0.2.1). */
  'agent.update': def(
    z.object({ version: z.string().regex(/^\d+\.\d+\.\d+$/) }),
    z.object({ installed_version: z.string(), restart: z.enum(['service', 'manual']) }),
    180_000,
  ),
```

Run: `npm test -w @termhub/agent-protocol && npm run build:packages` — expected: PASS.

- [ ] **Step 3: Failing agent handler test**

Create `apps/agent/src/rpc/update.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunResult } from '../exec.js';
import { RpcFailure } from '../exec.js';
import { type UpdateDeps, updateAgent } from './update.js';

const ok: RunResult = { code: 0, stdout: '', stderr: '', timedOut: false, error: undefined };

function deps(overrides: Partial<UpdateDeps> = {}): UpdateDeps & { run: ReturnType<typeof vi.fn>; exit: ReturnType<typeof vi.fn>; log: ReturnType<typeof vi.fn> } {
  return {
    run: vi.fn(async () => ok),
    npmPath: () => '/opt/node/bin/npm',
    installedVersion: async () => '0.2.2',
    serviceInstalled: async () => true,
    exit: vi.fn(),
    log: vi.fn(),
    ...overrides,
  } as never;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('agent.update', () => {
  it('installs the requested version with npm (argv, no shell) and schedules an exit(1) when a service runs it', async () => {
    const d = deps();
    const r = await updateAgent({ version: '0.2.2' }, d);
    expect(d.run).toHaveBeenCalledWith('/opt/node/bin/npm', ['install', '-g', '--no-fund', '--no-audit', '@termhub/agent@0.2.2'], { timeoutMs: 150_000 });
    expect(r).toEqual({ installed_version: '0.2.2', restart: 'service' });
    expect(d.exit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(750);
    expect(d.exit).toHaveBeenCalledWith(1);
  });

  it('does not exit when no service is installed (manual restart)', async () => {
    const d = deps({ serviceInstalled: async () => false });
    const r = await updateAgent({ version: '0.2.2' }, d);
    expect(r.restart).toBe('manual');
    vi.advanceTimersByTime(2000);
    expect(d.exit).not.toHaveBeenCalled();
  });

  it('reports notfound when npm is missing', async () => {
    const d = deps({ run: vi.fn(async () => ({ ...ok, code: null, error: 'enoent' })) });
    await expect(updateAgent({ version: '0.2.2' }, d)).rejects.toMatchObject({ code: 'notfound' });
  });

  it('reports failed with the exit code when npm fails, without logging npm output', async () => {
    const d = deps({ run: vi.fn(async () => ({ ...ok, code: 243, stderr: 'EACCES secret-path' })) });
    await expect(updateAgent({ version: '0.2.2' }, d)).rejects.toMatchObject({ code: 'failed', message: 'npm exited with code 243' });
    expect(JSON.stringify(d.log.mock.calls)).not.toContain('secret-path');
    expect(d.exit).not.toHaveBeenCalled();
  });

  it('reports failed when the installed version does not match', async () => {
    const d = deps({ installedVersion: async () => '0.2.0' });
    await expect(updateAgent({ version: '0.2.2' }, d)).rejects.toBeInstanceOf(RpcFailure);
    expect(d.exit).not.toHaveBeenCalled();
  });

  it('refuses a second update while one is running', async () => {
    let release!: () => void;
    const d = deps({ run: vi.fn(() => new Promise<RunResult>((res) => (release = () => res(ok)))) });
    const first = updateAgent({ version: '0.2.2' }, d);
    await expect(updateAgent({ version: '0.2.2' }, d)).rejects.toMatchObject({ code: 'failed', message: 'update already running' });
    release();
    await first;
  });
});
```

Run: `npm test -w @termhub/agent -- update` — expected: FAIL (module `./update.js` not found).

- [ ] **Step 4: Implement the handler**

Create `apps/agent/src/rpc/update.ts`:

```ts
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { RpcParams, RpcResult } from '@termhub/agent-protocol';
import { RpcFailure, run, type RunResult } from '../exec.js';
import { resolveScriptPath } from '../paths.js';
import * as service from '../service/index.js';
import { AGENT_VERSION } from '../version.js';

/**
 * Self-update, driven by the server: `npm install -g @termhub/agent@<version>` (argv form — the
 * version is validated by the RPC schema and never reaches a shell), then, when this process
 * runs under launchd/systemd, exit 1 so the service relaunches the freshly installed code.
 * `npm i -g` overwrites the same directory the service file points at, so the restart picks
 * the new version up without touching the service definition.
 */
const PACKAGE = '@termhub/agent';
const NPM_TIMEOUT_MS = 150_000;
/** Enough for the rpc_result frame to leave the socket before the process goes away. */
const EXIT_DELAY_MS = 750;

export interface UpdateDeps {
  run: (file: string, args: string[], opts?: { timeoutMs?: number }) => Promise<RunResult>;
  npmPath: () => string;
  installedVersion: () => Promise<string | null>;
  serviceInstalled: () => Promise<boolean>;
  exit: (code: number) => void;
  log: (msg: string, meta?: object) => void;
}

/** The `npm` shipped next to the running node (nvm, Homebrew and the official installer all do that); PATH lookup otherwise. */
export function npmBesideNode(execPath = process.execPath): string {
  const beside = path.join(path.dirname(execPath), 'npm');
  return existsSync(beside) ? beside : 'npm';
}

/** Version of the package this process was started from: <pkg>/dist/cli.js → <pkg>/package.json. */
export async function installedAgentVersion(argv1 = process.argv[1]): Promise<string | null> {
  const script = resolveScriptPath(argv1);
  if (!script) return null;
  try {
    const pkg = JSON.parse(await readFile(path.join(path.dirname(script), '..', 'package.json'), 'utf8')) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : null;
  } catch {
    return null;
  }
}

const defaultDeps: UpdateDeps = {
  run,
  npmPath: npmBesideNode,
  installedVersion: installedAgentVersion,
  serviceInstalled: () => service.status(),
  exit: (code) => process.exit(code),
  log: (msg, meta) => console.error(meta ? `[termhub-agent] ${msg} ${JSON.stringify(meta)}` : `[termhub-agent] ${msg}`),
};

let inFlight: Promise<RpcResult<'agent.update'>> | null = null;

export async function updateAgent(params: RpcParams<'agent.update'>, deps: UpdateDeps = defaultDeps): Promise<RpcResult<'agent.update'>> {
  if (inFlight) throw new RpcFailure('failed', 'update already running');
  inFlight = doUpdate(params.version, deps);
  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}

async function doUpdate(version: string, deps: UpdateDeps): Promise<RpcResult<'agent.update'>> {
  deps.log('update starting', { from: AGENT_VERSION, to: version });
  // npm's own output is never logged: it can echo paths and registry details.
  const r = await deps.run(deps.npmPath(), ['install', '-g', '--no-fund', '--no-audit', `${PACKAGE}@${version}`], { timeoutMs: NPM_TIMEOUT_MS });
  if (r.error === 'enoent') throw new RpcFailure('notfound', 'npm not found on this machine');
  if (r.timedOut) throw new RpcFailure('timeout', 'npm install timed out');
  if (r.code !== 0) {
    deps.log('update failed', { to: version, code: r.code });
    throw new RpcFailure('failed', `npm exited with code ${r.code ?? 'unknown'}`);
  }
  const installed = await deps.installedVersion();
  if (installed !== version) throw new RpcFailure('failed', `installed version mismatch (${installed ?? 'unknown'})`);
  const restart = (await deps.serviceInstalled()) ? 'service' : 'manual';
  deps.log('update installed', { from: AGENT_VERSION, to: version, restart });
  if (restart === 'service') {
    // Reply first; exit 1 (never 78, which would stop the restart loop) so launchd/systemd relaunch us.
    setTimeout(() => deps.exit(1), EXIT_DELAY_MS);
  }
  return { installed_version: installed, restart };
}

export const update = (params: RpcParams<'agent.update'>): Promise<RpcResult<'agent.update'>> => updateAgent(params);
```

In `apps/agent/src/rpc/index.ts` add `import * as update from './update.js';` and `'agent.update': update.update,` to `handlers`.

Check that `RunResult` is exported from `apps/agent/src/exec.ts` (it is: `export interface RunResult`). If `RunOptions` requires more than `timeoutMs`, keep the `UpdateDeps.run` signature as written — `run` is assignable because extra optional props are fine.

- [ ] **Step 5: Bump the agent version**

`apps/agent/package.json`: `"version": "0.2.1"`. `apps/agent/src/version.ts`: `export const AGENT_VERSION = '0.2.1';`.

- [ ] **Step 6: Run tests and typecheck**

Run: `npm test -w @termhub/agent -- update version dispatch && npm run typecheck -w @termhub/agent` — expected: PASS (the `paths.test.ts`/`cli.test.ts` symlink cases fail only on this Mac and are pre-existing; do not touch them).

- [ ] **Step 7: Commit**

```bash
git add packages/agent-protocol/src/rpc.ts packages/agent-protocol/src/rpc.test.ts apps/agent/src/rpc/update.ts apps/agent/src/rpc/update.test.ts apps/agent/src/rpc/index.ts apps/agent/package.json apps/agent/src/version.ts
git commit -m "Agent: add the agent.update RPC that installs a version and restarts (0.2.1)"
```

---

### Task 2: Server — latest agent version (npm registry, cache, compare)

**Files:**
- Create: `apps/server/src/agent/latest-version.ts`
- Create: `apps/server/src/agent/latest-version.test.ts`

**Interfaces:**
- Consumes: `httpJson(url, init)` from `apps/server/src/ai/credentials.ts` (returns `{ status, body, text, headers }`, never throws on HTTP errors); `versionAtLeast(a, b)` from `apps/server/src/agent/errors.ts`.
- Produces: `latestAgentVersion(): string | null`, `setLatestAgentVersion(v)` (tests), `isOutdated(current, latest): boolean`, `fetchLatestAgentVersion(fetchJson?)`, `startAgentVersionPoller(log, onRefresh?) => stop`, `REFRESH_MS`, `MIN_SELF_UPDATE_VERSION = '0.2.1'`. Task 5 adds `runAgentUpdate`, `autoUpdateTick`, `startAgentUpdateScheduler` to the same file.

- [ ] **Step 1: Failing test**

Create `apps/server/src/agent/latest-version.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchLatestAgentVersion, isOutdated, latestAgentVersion, setLatestAgentVersion, startAgentVersionPoller, REFRESH_MS } from './latest-version.js';

const log = { info: vi.fn(), warn: vi.fn() };
const json = (status: number, body: unknown) => vi.fn(async () => ({ status, body, text: JSON.stringify(body), headers: new Headers() }));

afterEach(() => {
  setLatestAgentVersion(null);
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('isOutdated', () => {
  it('is true only when both versions parse and current < latest', () => {
    expect(isOutdated('0.2.0', '0.2.1')).toBe(true);
    expect(isOutdated('0.2.1', '0.2.1')).toBe(false);
    expect(isOutdated('0.3.0', '0.2.9')).toBe(false);
    expect(isOutdated(null, '0.2.1')).toBe(false);
    expect(isOutdated('0.2.0', null)).toBe(false);
    expect(isOutdated('dev', '0.2.1')).toBe(false);
    expect(isOutdated('0.2.0', '0.2.1-beta')).toBe(false);
  });
});

describe('fetchLatestAgentVersion', () => {
  it('reads dist-tags latest from the registry', async () => {
    const f = json(200, { name: '@termhub/agent', version: '0.2.5' });
    expect(await fetchLatestAgentVersion(f)).toBe('0.2.5');
    expect(f).toHaveBeenCalledWith('https://registry.npmjs.org/@termhub/agent/latest', expect.objectContaining({ timeoutMs: 10_000 }));
  });
  it('returns null on a non-200, a malformed body or a thrown fetch', async () => {
    expect(await fetchLatestAgentVersion(json(503, {}))).toBeNull();
    expect(await fetchLatestAgentVersion(json(200, { version: 'latest' }))).toBeNull();
    expect(await fetchLatestAgentVersion(vi.fn(async () => { throw new Error('boom'); }))).toBeNull();
  });
});

describe('startAgentVersionPoller', () => {
  it('fetches at boot, caches, refreshes hourly and calls onRefresh after each success', async () => {
    vi.useFakeTimers();
    const f = json(200, { version: '0.2.5' });
    const onRefresh = vi.fn(async () => {});
    const stop = startAgentVersionPoller(log, onRefresh, f);
    expect(latestAgentVersion()).toBeNull();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(latestAgentVersion()).toBe('0.2.5');
    expect(onRefresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(REFRESH_MS);
    expect(f).toHaveBeenCalledTimes(2);
    stop();
    await vi.advanceTimersByTimeAsync(REFRESH_MS);
    expect(f).toHaveBeenCalledTimes(2);
  });
  it('keeps the previous value and warns when a refresh fails', async () => {
    vi.useFakeTimers();
    setLatestAgentVersion('0.2.4');
    const stop = startAgentVersionPoller(log, undefined, json(500, {}));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(latestAgentVersion()).toBe('0.2.4');
    expect(log.warn).toHaveBeenCalled();
    stop();
  });
});
```

Run: `npm test -w @termhub/server -- latest-version` — expected: FAIL (module missing).

- [ ] **Step 2: Implement**

Create `apps/server/src/agent/latest-version.ts`:

```ts
import { httpJson } from '../ai/credentials.js';
import { versionAtLeast } from './errors.js';

/**
 * Which @termhub/agent is the newest on npm, so the UI can offer an update and the auto-update
 * scheduler (below, Task 5) knows what to install. One process-wide cache, refreshed hourly;
 * null until the registry answered once (the UI then shows nothing).
 */
export const AGENT_PACKAGE = '@termhub/agent';
const REGISTRY_URL = `https://registry.npmjs.org/${AGENT_PACKAGE}/latest`;
export const REFRESH_MS = 60 * 60 * 1000;
const FIRST_FETCH_DELAY_MS = 2_000;
/** First agent that knows the agent.update RPC. */
export const MIN_SELF_UPDATE_VERSION = '0.2.1';
const SEMVER = /^\d+\.\d+\.\d+$/;

type FetchJson = typeof httpJson;
export interface VersionLog {
  info: (o: object, m: string) => void;
  warn: (o: object, m: string) => void;
}

let cached: string | null = null;

export function latestAgentVersion(): string | null {
  return cached;
}

/** Tests only. */
export function setLatestAgentVersion(v: string | null): void {
  cached = v;
}

/** True when both are plain x.y.z and `current` is older than `latest`. */
export function isOutdated(current: string | null | undefined, latest: string | null): boolean {
  if (!current || !latest || !SEMVER.test(current) || !SEMVER.test(latest)) return false;
  return !versionAtLeast(current, latest);
}

export async function fetchLatestAgentVersion(fetchJson: FetchJson = httpJson): Promise<string | null> {
  try {
    const r = await fetchJson(REGISTRY_URL, { headers: { accept: 'application/json' }, timeoutMs: 10_000 });
    if (r.status !== 200 || !r.body || typeof r.body !== 'object') return null;
    const v = (r.body as { version?: unknown }).version;
    return typeof v === 'string' && SEMVER.test(v) ? v : null;
  } catch {
    return null;
  }
}

/** Fetches shortly after boot and then every REFRESH_MS; `onRefresh` runs after each successful fetch. Returns a stop function. */
export function startAgentVersionPoller(log: VersionLog, onRefresh?: () => Promise<void>, fetchJson: FetchJson = httpJson): () => void {
  const tick = async () => {
    const v = await fetchLatestAgentVersion(fetchJson);
    if (!v) {
      log.warn({ package: AGENT_PACKAGE }, 'npm registry: could not read the latest agent version');
      return;
    }
    if (v !== cached) log.info({ version: v }, 'latest agent version on npm');
    cached = v;
    try {
      await onRefresh?.();
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'agent version refresh hook failed');
    }
  };
  const timer = setInterval(() => void tick(), REFRESH_MS);
  timer.unref();
  const first = setTimeout(() => void tick(), FIRST_FETCH_DELAY_MS);
  first.unref();
  return () => {
    clearInterval(timer);
    clearTimeout(first);
  };
}
```

- [ ] **Step 3: Run tests**

Run: `npm test -w @termhub/server -- latest-version` — expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/agent/latest-version.ts apps/server/src/agent/latest-version.test.ts
git commit -m "Server: cache the latest @termhub/agent version from the npm registry"
```

---

### Task 3: Server — `agent_auto_update` column, repository, PATCH

**Files:**
- Modify: `apps/server/prisma/schema.prisma` (model Machine, after `agentLastSeenAt`)
- Create: `apps/server/prisma/migrations/20260920120000_machine_agent_auto_update/migration.sql`
- Modify: `apps/server/src/db/repositories/types.ts` (`Machine`, `mapMachine`)
- Modify: `apps/server/src/db/repositories/machines.ts` (`MachineInput`, `update`, new `listAutoUpdate`)
- Modify: `apps/server/src/routes/machines.ts` (`machineBody`)
- Modify: `apps/server/src/routes/machines.test.ts` (`makeMachine` + a PATCH test)
- Regenerate + commit: `apps/server/src/generated/prisma/**` (tracked in git)

**Interfaces:**
- Produces: `Machine.agent_auto_update: boolean`; `MachineInput.agent_auto_update?: boolean`; `repos.machines.listAutoUpdate(): Promise<Machine[]>` (agent machines with the flag on); `PATCH /machines/:id` accepts `agent_auto_update` (agent machines only).

- [ ] **Step 1: Schema + migration**

In `schema.prisma`, after `agentLastSeenAt     DateTime? @map("agent_last_seen_at")`:

```prisma
  /// Install newer agent versions on their own while no terminal is open on the machine (see agent/latest-version.ts)
  agentAutoUpdate     Boolean   @default(false) @map("agent_auto_update")
```

Create the migration file:

```sql
-- AlterTable
ALTER TABLE "machines" ADD COLUMN     "agent_auto_update" BOOLEAN NOT NULL DEFAULT false;
```

Run: `npm run prisma:generate -w @termhub/server` (regenerates `apps/server/src/generated/prisma`).

- [ ] **Step 2: Failing route test**

In `apps/server/src/routes/machines.test.ts`, add `agent_auto_update: false,` to `makeMachine` (before `...overrides`), and add:

```ts
describe('PATCH /api/machines/:id (agent_auto_update)', () => {
  it('stores the auto-update flag for an agent machine', async () => {
    store.m1 = makeMachine({ type: 'agent' });
    const built = buildApp(store);
    app = built.app;
    const res = await app.inject({ method: 'PATCH', url: '/api/machines/m1', payload: { agent_auto_update: true } });
    expect(res.statusCode).toBe(200);
    expect(built.repos.update).toHaveBeenCalledWith('m1', expect.objectContaining({ agent_auto_update: true }));
  });
  it('rejects the flag on an ssh machine', async () => {
    store.m1 = makeMachine({ type: 'ssh' });
    ({ app } = buildApp(store));
    const res = await app.inject({ method: 'PATCH', url: '/api/machines/m1', payload: { agent_auto_update: true } });
    expect(res.statusCode).toBe(400);
  });
});
```

Run: `npm test -w @termhub/server -- routes/machines` — expected: FAIL (flag not forwarded / 200 instead of 400).

- [ ] **Step 3: Types, repository, route**

`types.ts` — in `interface Machine` after `agent_last_seen_at`: `/** newer agent versions are installed automatically while the machine has no open terminal */ agent_auto_update: boolean;`. In `mapMachine`: `agent_auto_update: m.agentAutoUpdate,`.

`machines.ts` — `MachineInput` gains `agent_auto_update?: boolean;`. In `update()` data add `agentAutoUpdate: next.agent_auto_update ?? false,`. Add:

```ts
  /** Agent machines that opted into automatic updates (the scheduler checks online/idle itself). */
  async listAutoUpdate(): Promise<Machine[]> {
    const rows = await this.db.machine.findMany({ where: { type: 'agent', agentAutoUpdate: true }, include: withOwner });
    return rows.map(mapMachine);
  }
```

`routes/machines.ts` — in `machineBody` add `agent_auto_update: z.boolean().optional(),` and in `superRefine`: `if (m.agent_auto_update && m.type !== 'agent') ctx.addIssue({ code: 'custom', path: ['agent_auto_update'], message: 'só máquinas com agente atualizam sozinhas' });`.

Fix every other place that builds a `Machine` literal in server tests (grep `agent_last_seen_at:` under `apps/server/src` test files and add `agent_auto_update: false`).

- [ ] **Step 4: Run tests + typecheck**

Run: `npm test -w @termhub/server && npm run typecheck -w @termhub/server` — expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/prisma apps/server/src/generated apps/server/src/db apps/server/src/routes/machines.ts apps/server/src/routes/machines.test.ts
git commit -m "Server: store whether an agent machine updates itself (agent_auto_update)"
```

---

### Task 4: Server — `update_available` in list/status and `POST /machines/:id/agent/update`

**Files:**
- Modify: `apps/server/src/agent/connection.ts` (add `openChannels` getter)
- Modify: `apps/server/src/agent/registry.ts` (add `openChannels(machineId)`)
- Modify: `apps/server/src/agent/latest-version.ts` (add `runAgentUpdate`)
- Modify: `apps/server/src/routes/machines.ts` (GET `/`, GET `/:id/status`, new POST)
- Modify: `apps/server/src/routes/machines.test.ts`

**Interfaces:**
- Consumes: `latestAgentVersion`, `isOutdated`, `MIN_SELF_UPDATE_VERSION` (Task 2); `requireAgentVersion(machine, min)` and `toHttpError` from `agent/errors.ts`; `AgentClosedError` from `agent/connection.ts`.
- Produces: `agents.openChannels(id): number`; `runAgentUpdate(machineId, version, log): Promise<{ installed_version: string | null; restart: 'service' | 'manual'; restarting: boolean }>`; `GET /machines` → `{ machines: (Machine & { update_available: boolean })[], latest_agent_version: string | null }`; `GET /machines/:id/status` (agent) adds `latest_agent_version`, `update_available`; `POST /machines/:id/agent/update` → the outcome above.

- [ ] **Step 1: Failing route tests**

Append to `apps/server/src/routes/machines.test.ts` (imports: `import { AgentClosedError } from '../agent/connection.js';` — extend the existing import — and `import { setLatestAgentVersion } from '../agent/latest-version.js';`). Reuse the `attachAgent` helper from the hooks describe (move it to module scope if it is not already):

```ts
describe('agent update', () => {
  afterEach(() => setLatestAgentVersion(null));

  it('GET /api/machines flags outdated online agents and carries the latest version', async () => {
    store.m1 = makeMachine({ type: 'agent', agent_version: '0.2.1' });
    store.m2 = makeMachine({ id: 'm2', type: 'agent', agent_version: '0.2.5' });
    ({ app } = buildApp(store));
    setLatestAgentVersion('0.2.5');
    attachAgent('0.2.1');
    const res = await app.inject({ method: 'GET', url: '/api/machines' });
    const body = res.json();
    expect(body.latest_agent_version).toBe('0.2.5');
    expect(body.machines.find((m: { id: string }) => m.id === 'm1').update_available).toBe(true);
    expect(body.machines.find((m: { id: string }) => m.id === 'm2').update_available).toBe(false); // offline: nothing to update
  });

  it('GET /api/machines/:id/status carries latest_agent_version and update_available', async () => {
    store.m1 = makeMachine({ type: 'agent' });
    ({ app } = buildApp(store));
    setLatestAgentVersion('0.2.5');
    attachAgent('0.2.1');
    const res = await app.inject({ method: 'GET', url: '/api/machines/m1/status' });
    expect(res.json()).toMatchObject({ online: true, agent_version: '0.2.1', latest_agent_version: '0.2.5', update_available: true });
  });

  it('POST answers 503 when the agent is offline', async () => {
    store.m1 = makeMachine({ type: 'agent' });
    ({ app } = buildApp(store));
    setLatestAgentVersion('0.2.5');
    const res = await app.inject({ method: 'POST', url: '/api/machines/m1/agent/update' });
    expect(res.statusCode).toBe(503);
  });

  it('POST answers 503 while the latest version is unknown', async () => {
    store.m1 = makeMachine({ type: 'agent' });
    ({ app } = buildApp(store));
    attachAgent('0.2.1');
    const res = await app.inject({ method: 'POST', url: '/api/machines/m1/agent/update' });
    expect(res.statusCode).toBe(503);
  });

  it('POST answers 409 when the agent is already up to date', async () => {
    store.m1 = makeMachine({ type: 'agent' });
    ({ app } = buildApp(store));
    setLatestAgentVersion('0.2.5');
    const rpc = attachAgent('0.2.5');
    const res = await app.inject({ method: 'POST', url: '/api/machines/m1/agent/update' });
    expect(res.statusCode).toBe(409);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('POST answers 409 AGENT_OUTDATED for agents that predate the RPC', async () => {
    store.m1 = makeMachine({ type: 'agent' });
    ({ app } = buildApp(store));
    setLatestAgentVersion('0.2.5');
    attachAgent('0.2.0');
    const res = await app.inject({ method: 'POST', url: '/api/machines/m1/agent/update' });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('AGENT_OUTDATED');
  });

  it('POST runs agent.update with the latest version and returns the outcome', async () => {
    store.m1 = makeMachine({ type: 'agent' });
    ({ app } = buildApp(store));
    setLatestAgentVersion('0.2.5');
    const rpc = attachAgent('0.2.1', vi.fn(async () => ({ installed_version: '0.2.5', restart: 'service' })));
    const res = await app.inject({ method: 'POST', url: '/api/machines/m1/agent/update' });
    expect(res.statusCode).toBe(200);
    expect(rpc).toHaveBeenCalledWith('agent.update', { version: '0.2.5' }, 180_000);
    expect(res.json()).toEqual({ installed_version: '0.2.5', restart: 'service', restarting: true });
  });

  it('POST treats a connection closed mid-update as "restarting"', async () => {
    store.m1 = makeMachine({ type: 'agent' });
    ({ app } = buildApp(store));
    setLatestAgentVersion('0.2.5');
    attachAgent('0.2.1', vi.fn(async () => { throw new AgentClosedError('closed'); }));
    const res = await app.inject({ method: 'POST', url: '/api/machines/m1/agent/update' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ installed_version: null, restart: 'service', restarting: true });
  });

  it('POST maps an RPC failure to 502 with the agent message', async () => {
    store.m1 = makeMachine({ type: 'agent' });
    ({ app } = buildApp(store));
    setLatestAgentVersion('0.2.5');
    attachAgent('0.2.1', vi.fn(async () => { throw new AgentRpcError({ code: 'failed', message: 'npm exited with code 243' }); }));
    const res = await app.inject({ method: 'POST', url: '/api/machines/m1/agent/update' });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe('npm exited with code 243');
  });
});
```

Check how `AgentClosedError` is constructed in `apps/server/src/agent/connection.ts` and adapt the `new AgentClosedError(...)` call to its constructor. Check the error JSON shape emitted by `applyErrorHandler` (`error` / `code` keys) and adapt the assertions.

Run: `npm test -w @termhub/server -- routes/machines` — expected: FAIL (404 on the new route, missing fields).

- [ ] **Step 2: Registry + connection**

`connection.ts`, inside `class AgentConnection`: `/** Open PTY channels — 0 means no terminal is attached (the auto-update "idle" test). */ get openChannels(): number { return this.channels.size; }`.

`registry.ts`: `openChannels(machineId: string): number { return this.conns.get(machineId)?.openChannels ?? 0; }`.

- [ ] **Step 3: `runAgentUpdate`**

Append to `apps/server/src/agent/latest-version.ts` (imports: `import { AgentClosedError } from './connection.js'; import { toHttpError } from './errors.js'; import { agents } from './registry.js';` — merge with the existing `errors.js` import):

```ts
export const UPDATE_TIMEOUT_MS = 180_000;
export interface AgentUpdateOutcome {
  installed_version: string | null;
  restart: 'service' | 'manual';
  /** the agent is leaving to come back on the new version: poll the status until agent_version changes */
  restarting: boolean;
}

/** Runs agent.update on a connected agent. The connection closing mid-call means the agent already left to restart. */
export async function runAgentUpdate(machineId: string, version: string, log: VersionLog): Promise<AgentUpdateOutcome> {
  try {
    const r = await agents.rpc(machineId, 'agent.update', { version }, UPDATE_TIMEOUT_MS);
    log.info({ machineId, version: r.installed_version, restart: r.restart }, 'agent updated');
    return { ...r, restarting: r.restart === 'service' };
  } catch (err) {
    if (err instanceof AgentClosedError) {
      log.info({ machineId, version }, 'agent connection closed during update (restarting)');
      return { installed_version: null, restart: 'service', restarting: true };
    }
    throw toHttpError(err);
  }
}
```

- [ ] **Step 4: Routes**

In `routes/machines.ts` add imports: `import { isOutdated, latestAgentVersion, MIN_SELF_UPDATE_VERSION, runAgentUpdate } from '../agent/latest-version.js';` and `import { requireAgentVersion } from '../agent/errors.js';` and `import type { Machine } from '../db/repositories/types.js';`. Add the helper above `machineRoutes`:

```ts
/** Newer agent on npm than the one connected? Offline agents never count: there is nothing to update. */
function updateAvailable(m: Machine): boolean {
  if (m.type !== 'agent') return false;
  const info = agents.info(m.id);
  return !!info && isOutdated(info.agent_version, latestAgentVersion());
}
```

`GET /`:
```ts
  app.get('/', async (request) => {
    const machines = await repos.machines.list(request.scope.ownerId);
    return { machines: machines.map((m) => ({ ...m, update_available: updateAvailable(m) })), latest_agent_version: latestAgentVersion() };
  });
```

`GET /:id/status` agent branch return: add `latest_agent_version: latestAgentVersion(), update_available: updateAvailable(machine)`.

New route (next to the hooks routes):
```ts
  /** Installs the latest @termhub/agent on the machine through the agent itself; the agent restarts when it runs as a service. */
  app.post('/:id/agent/update', { config: { action: 'update' } }, async (request) => {
    const { id } = idParam.parse(request.params);
    const machine = await scoped(repos, request).machine(id);
    if (machine.type !== 'agent') throw badRequest('Só máquinas com agente são atualizadas por aqui');
    const latest = latestAgentVersion();
    if (!latest) throw new HttpError(503, 'Versão mais nova do agente ainda desconhecida (npm)', 'AGENT_LATEST_UNKNOWN');
    const info = agents.info(machine.id);
    if (!info) throw new HttpError(503, 'Agente desconectado', 'AGENT_OFFLINE');
    if (!isOutdated(info.agent_version, latest)) throw conflict(`O agente já está na versão ${info.agent_version}`);
    requireAgentVersion(machine, MIN_SELF_UPDATE_VERSION);
    return runAgentUpdate(machine.id, latest, request.log);
  });
```

- [ ] **Step 5: Run tests + typecheck**

Run: `npm test -w @termhub/server && npm run typecheck -w @termhub/server` — expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/agent apps/server/src/routes/machines.ts apps/server/src/routes/machines.test.ts
git commit -m "Server: flag outdated agents and update them through agent.update"
```

---

### Task 5: Server — auto-update scheduler + app wiring

**Files:**
- Modify: `apps/server/src/agent/latest-version.ts` (`autoUpdateTick`, `startAgentUpdateScheduler`)
- Modify: `apps/server/src/agent/latest-version.test.ts`
- Modify: `apps/server/src/app.ts` (start/stop next to `startTicketSyncScheduler`)

**Interfaces:**
- Consumes: `repos.machines.listAutoUpdate()` (Task 3); `agents.info`, `agents.openChannels` (Task 4); `runAgentUpdate` (Task 4).
- Produces: `autoUpdateTick(repos, log)`, `startAgentUpdateScheduler(repos, log) => stop`, `AUTO_UPDATE_MS = 10 * 60 * 1000`, `resetAutoUpdateAttempts()` (tests).

- [ ] **Step 1: Failing test**

Append to `latest-version.test.ts` (extend the import with `autoUpdateTick, resetAutoUpdateAttempts`, plus `import { agents } from './registry.js'; import { EventEmitter } from 'node:events'; import type { Repositories } from '../db/repositories/index.js';`):

```ts
describe('autoUpdateTick', () => {
  function attach(id: string, version: string, channels: number, rpc = vi.fn(async () => ({ installed_version: '0.2.5', restart: 'service' }))) {
    const conn = Object.assign(new EventEmitter(), {
      hello: { type: 'hello', protocol: 1, agent_version: version, os: 'macos', tools: ['tmux'] },
      connectedAt: Date.now(),
      openChannels: channels,
      rpc,
      close: vi.fn(),
    });
    agents.attach(id, conn as never);
    return rpc;
  }
  const machine = (id: string) => ({ id, type: 'agent', agent_auto_update: true }) as never;
  const repos = (ids: string[]) => ({ machines: { listAutoUpdate: async () => ids.map(machine) } }) as unknown as Repositories;

  afterEach(() => {
    agents.reset();
    resetAutoUpdateAttempts();
  });

  it('updates only online, outdated, idle machines that know the RPC — once per version', async () => {
    setLatestAgentVersion('0.2.5');
    const idle = attach('idle', '0.2.1', 0);
    const busy = attach('busy', '0.2.1', 2);
    const fresh = attach('fresh', '0.2.5', 0);
    const old = attach('old', '0.2.0', 0);
    await autoUpdateTick(repos(['idle', 'busy', 'fresh', 'old', 'offline']), log);
    expect(idle).toHaveBeenCalledWith('agent.update', { version: '0.2.5' }, 180_000);
    expect(busy).not.toHaveBeenCalled();
    expect(fresh).not.toHaveBeenCalled();
    expect(old).not.toHaveBeenCalled();
    await autoUpdateTick(repos(['idle']), log);
    expect(idle).toHaveBeenCalledTimes(1);
  });

  it('does nothing before the latest version is known and survives a failing agent', async () => {
    const rpc = attach('idle', '0.2.1', 0, vi.fn(async () => { throw new Error('boom'); }));
    await autoUpdateTick(repos(['idle']), log);
    expect(rpc).not.toHaveBeenCalled();
    setLatestAgentVersion('0.2.5');
    await expect(autoUpdateTick(repos(['idle']), log)).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalled();
  });
});
```

Run: `npm test -w @termhub/server -- latest-version` — expected: FAIL (`autoUpdateTick` not exported).

- [ ] **Step 2: Implement**

Append to `latest-version.ts` (import `type { Repositories } from '../db/repositories/index.js'`):

```ts
export const AUTO_UPDATE_MS = 10 * 60 * 1000;
/** machine id → version already attempted, so a failing install is tried once per release. */
const attempted = new Map<string, string>();

/** Tests only. */
export function resetAutoUpdateAttempts(): void {
  attempted.clear();
}

/** Installs the latest agent on opted-in machines that are online, outdated, idle (no open terminal) and new enough to know the RPC. */
export async function autoUpdateTick(repos: Pick<Repositories, 'machines'>, log: VersionLog): Promise<void> {
  const latest = cached;
  if (!latest) return;
  const machines = await repos.machines.listAutoUpdate();
  for (const m of machines) {
    const info = agents.info(m.id);
    if (!info || !isOutdated(info.agent_version, latest)) continue;
    if (!versionAtLeast(info.agent_version, MIN_SELF_UPDATE_VERSION)) continue;
    if (agents.openChannels(m.id) > 0) continue;
    if (attempted.get(m.id) === latest) continue;
    attempted.set(m.id, latest);
    try {
      const r = await runAgentUpdate(m.id, latest, log);
      log.info({ machineId: m.id, from: info.agent_version, to: latest, restart: r.restart }, 'agent auto-update');
    } catch (err) {
      log.warn({ machineId: m.id, to: latest, err: (err as Error).message }, 'agent auto-update failed');
    }
  }
}

/** Boot-time wiring: the npm poller (each refresh runs a tick) plus a tick every AUTO_UPDATE_MS. */
export function startAgentUpdateScheduler(repos: Pick<Repositories, 'machines'>, log: VersionLog): () => void {
  const tick = () => autoUpdateTick(repos, log).catch((err) => log.warn({ err: (err as Error).message }, 'agent auto-update tick failed'));
  const stopPoll = startAgentVersionPoller(log, tick);
  const timer = setInterval(() => void tick(), AUTO_UPDATE_MS);
  timer.unref();
  return () => {
    stopPoll();
    clearInterval(timer);
  };
}
```

In `app.ts` (next to `const stopSync = startTicketSyncScheduler(repos, fastify.log);`): `const stopAgentUpdates = startAgentUpdateScheduler(repos, fastify.log);` with the import `import { startAgentUpdateScheduler } from './agent/latest-version.js';`, and `stopAgentUpdates();` inside the `onClose` hook.

- [ ] **Step 3: Run tests + typecheck**

Run: `npm test -w @termhub/server && npm run typecheck -w @termhub/server` — expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/agent/latest-version.ts apps/server/src/agent/latest-version.test.ts apps/server/src/app.ts
git commit -m "Server: auto-update idle agents that opted in"
```

---

### Task 6: Web — types, API, data provider and the sidebar badge

**Files:**
- Modify: `apps/web/src/lib/types.ts` (`Machine`)
- Modify: `apps/web/src/lib/api.ts` (`machines.list`, `machines.status`, new `machines.updateAgent`)
- Modify: `apps/web/src/lib/data.tsx` (`checkStatus` merges `update_available`)
- Modify: `apps/web/src/components/Sidebar.tsx` (version span)
- Modify: `apps/web/src/components/Sidebar.test.tsx` and every web test fixture typed as `Machine` (`AgentEnrollment.test.tsx`, `ProjectsByMachine.test.tsx`, `NeedsYouList.test.tsx`, …: add `agent_auto_update: false`)

**Interfaces:**
- Produces: `Machine.agent_auto_update: boolean`, `Machine.update_available?: boolean`; `api.machines.list(): Promise<{ machines: Machine[]; latest_agent_version: string | null }>`; `api.machines.status()` result adds `latest_agent_version?: string | null; update_available?: boolean`; `api.machines.updateAgent(id): Promise<{ installed_version: string | null; restart: 'service' | 'manual'; restarting: boolean }>`; exported `agentVersionBadge(m: Machine): { text: string; title: string; outdated: boolean } | null` from `Sidebar.tsx`.

- [ ] **Step 1: Failing test**

In `Sidebar.test.tsx` add `agent_auto_update: false,` to `agentMachine` and:

```ts
import { agentVersionBadge, machineTitle } from './Sidebar';

describe('agentVersionBadge', () => {
  it('shows the version, and marks it when a newer agent is available', () => {
    expect(agentVersionBadge(agentMachine({ agent_version: '0.2.1' }))).toEqual({ text: 'v0.2.1', title: 'agente v0.2.1', outdated: false });
    expect(agentVersionBadge(agentMachine({ agent_version: '0.2.1', update_available: true }))).toEqual({ text: 'v0.2.1 ↑', title: 'Nova versão do agente disponível — abra a máquina para atualizar', outdated: true });
  });
  it('is null without a reported version or for non-agent machines', () => {
    expect(agentVersionBadge(agentMachine({ agent_version: null }))).toBeNull();
    expect(agentVersionBadge(agentMachine({ type: 'ssh', host: 'h' }))).toBeNull();
  });
});
```

Run: `npm test -w @termhub/web -- Sidebar` — expected: FAIL.

- [ ] **Step 2: Types + API + data**

`types.ts` `Machine`: after `agent_last_seen_at` add
```ts
  /** newer agent versions are installed automatically while the machine has no open terminal */
  agent_auto_update: boolean;
  /** server-computed: the connected agent is older than the latest on npm (absent for offline/non-agent) */
  update_available?: boolean;
```

`api.ts` `machines`:
```ts
    list: () => request<{ machines: Machine[]; latest_agent_version: string | null }>('GET', '/machines'),
    status: (id: string) =>
      request<{ id: string; online: boolean; tmux: boolean; os: string | null; capabilities: string[]; agent_version?: string | null; last_seen_at?: string | null; latest_agent_version?: string | null; update_available?: boolean }>(
        'GET',
        `/machines/${id}/status`,
      ),
    /** installs the latest @termhub/agent through the agent; `restarting` = poll the status until the version changes */
    updateAgent: (id: string) => request<{ installed_version: string | null; restart: 'service' | 'manual'; restarting: boolean }>('POST', `/machines/${id}/agent/update`, {}),
```

`data.tsx` `checkStatus`, inside the `setMachines` mapper, add `update_available: r.update_available ?? next.update_available,` to the returned object.

`Sidebar.tsx` — export the helper and use it:
```ts
/** The small "vX.Y.Z" next to an agent machine; `outdated` turns it into the update hint (the card in the machine form does the update). */
export function agentVersionBadge(m: Machine): { text: string; title: string; outdated: boolean } | null {
  if (m.type !== 'agent' || !m.agent_version) return null;
  if (m.update_available) return { text: `v${m.agent_version} ↑`, title: 'Nova versão do agente disponível — abra a máquina para atualizar', outdated: true };
  return { text: `v${m.agent_version}`, title: `agente v${m.agent_version}`, outdated: false };
}
```
Replace the existing `{m.type === 'agent' && m.agent_version && (<span …>v{m.agent_version}</span>)}` block with:
```tsx
                {(() => {
                  const badge = agentVersionBadge(m);
                  if (!badge) return null;
                  return badge.outdated ? (
                    <button type="button" className="rounded px-1 text-[10px] text-warn hover:bg-bg-3" title={badge.title} onClick={() => setMachineForm({ open: true, machine: m })}>
                      {badge.text}
                    </button>
                  ) : (
                    <span className="text-[10px] text-fg-dim" title={badge.title}>
                      {badge.text}
                    </span>
                  );
                })()}
```

Add `agent_auto_update: false` to every `Machine` fixture in `apps/web/src` tests (grep `agent_last_seen_at:` in `*.test.tsx`) and anywhere else a `Machine` literal is built (e.g. `lib/data.tsx` optimistic objects, `MachineForm.tsx` if it builds one — grep `agent_version:` under `apps/web/src`).

- [ ] **Step 3: Run tests + typecheck/build**

Run: `npm test -w @termhub/web && npm run build -w @termhub/web` — expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src
git commit -m "Web: mark agents with a newer version available in the sidebar"
```

---

### Task 7: Web — `AgentUpdateCard` in the machine form

**Files:**
- Create: `apps/web/src/components/AgentUpdateCard.tsx`
- Create: `apps/web/src/components/AgentUpdateCard.test.tsx`
- Modify: `apps/web/src/components/MachineForm.tsx` (mount for existing agent machines, above `MonitorHooksCard`)

**Interfaces:**
- Consumes: `api.machines.status`, `api.machines.updateAgent`, `api.machines.update` (Task 6); `useData().updateMachine(id, input)` for the toggle (existing).

- [ ] **Step 1: Failing test**

Create `apps/web/src/components/AgentUpdateCard.test.tsx`:

```tsx
// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Machine } from '../lib/types';

const statusMock = vi.fn();
const updateAgentMock = vi.fn();
const updateMachineMock = vi.fn(async (_id: string, input: Partial<Machine>) => ({ ...machine, ...input }));

vi.mock('../lib/api', () => ({
  api: { machines: { status: (...a: unknown[]) => statusMock(...a), updateAgent: (...a: unknown[]) => updateAgentMock(...a) } },
  ApiError: class ApiError extends Error {},
}));
vi.mock('../lib/data', () => ({ useData: () => ({ updateMachine: updateMachineMock, checkStatus: vi.fn() }) }));

import { AgentUpdateCard, POLL_MS } from './AgentUpdateCard';

const machine: Machine = {
  id: 'm1', name: 'mini', host: null, ssh_user: null, ssh_port: 22, type: 'agent', os: 'macos', capabilities: ['tmux'], checked_at: null,
  agent_version: '0.2.1', agent_last_seen_at: null, agent_auto_update: false, is_local: false, owner_id: 'u1', owner_name: null, created_at: '',
};
const status = (agent_version: string, latest = '0.2.5', online = true) => ({ id: 'm1', online, tmux: true, os: 'macos', capabilities: [], agent_version, latest_agent_version: latest, update_available: online && agent_version !== latest });

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('AgentUpdateCard', () => {
  it('shows the current version and no button when up to date', async () => {
    statusMock.mockResolvedValue(status('0.2.5'));
    render(<AgentUpdateCard machine={machine} />);
    await screen.findByText('v0.2.5 · atualizado');
    expect(screen.queryByRole('button', { name: 'Atualizar' })).toBeNull();
  });

  it('offers the update, then polls until the new version reports back', async () => {
    vi.useFakeTimers();
    statusMock.mockResolvedValueOnce(status('0.2.1')).mockResolvedValueOnce(status('0.2.1', '0.2.5', false)).mockResolvedValue(status('0.2.5'));
    updateAgentMock.mockResolvedValue({ installed_version: '0.2.5', restart: 'service', restarting: true });
    render(<AgentUpdateCard machine={machine} />);
    await act(async () => {});
    expect(screen.getByText('v0.2.1 · v0.2.5 disponível')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Atualizar' }));
    await act(async () => {});
    expect(updateAgentMock).toHaveBeenCalledWith('m1');
    expect(screen.getByText(/reinicia/)).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_MS * 2); });
    expect(screen.getByText('Agente atualizado para v0.2.5.')).toBeTruthy();
  });

  it('asks for a manual restart when the agent does not run as a service', async () => {
    statusMock.mockResolvedValue(status('0.2.1'));
    updateAgentMock.mockResolvedValue({ installed_version: '0.2.5', restart: 'manual', restarting: false });
    render(<AgentUpdateCard machine={machine} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Atualizar' }));
    await screen.findByText(/reinicie o agente/);
  });

  it('toggles automatic updates through updateMachine', async () => {
    statusMock.mockResolvedValue(status('0.2.5'));
    render(<AgentUpdateCard machine={machine} />);
    fireEvent.click(await screen.findByLabelText('Atualizar automaticamente quando ociosa'));
    await waitFor(() => expect(updateMachineMock).toHaveBeenCalledWith('m1', { agent_auto_update: true }));
  });
});
```

Run: `npm test -w @termhub/web -- AgentUpdateCard` — expected: FAIL (module missing).

- [ ] **Step 2: Implement the card**

Create `apps/web/src/components/AgentUpdateCard.tsx`:

```tsx
import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { useData } from '../lib/data';
import type { Machine } from '../lib/types';

export const POLL_MS = 3000;
const POLL_MAX_MS = 90_000;

type Versions = { current: string | null; latest: string | null; online: boolean; updateAvailable: boolean };

/** Machine form: the agent's version, the update button and the auto-update switch. */
export function AgentUpdateCard({ machine }: { machine: Machine }) {
  const { updateMachine, checkStatus } = useData();
  const [v, setV] = useState<Versions | null>(null);
  const [busy, setBusy] = useState(false);
  const [auto, setAuto] = useState(machine.agent_auto_update);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  const load = async (): Promise<Versions> => {
    const s = await api.machines.status(machine.id);
    const next = { current: s.agent_version ?? null, latest: s.latest_agent_version ?? null, online: s.online, updateAvailable: !!s.update_available };
    setV(next);
    return next;
  };

  useEffect(() => {
    let cancelled = false;
    load().catch((e) => !cancelled && setError(e instanceof ApiError ? e.message : 'Erro ao consultar'));
    const all = timers.current;
    return () => {
      cancelled = true;
      all.forEach(clearTimeout);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [machine.id]);

  /** After a service restart the agent reconnects with the new version; poll until it does (or give up). */
  const pollUntil = (target: string) => {
    const started = Date.now();
    const tick = async () => {
      let s: Versions | null = null;
      try {
        s = await load();
      } catch {
        /* offline while restarting: keep polling */
      }
      if (s && s.online && s.current === target) {
        setNote(`Agente atualizado para v${target}.`);
        setBusy(false);
        void checkStatus(machine.id);
        return;
      }
      if (Date.now() - started > POLL_MAX_MS) {
        setNote('Ainda reconectando… verifique o agente na máquina.');
        setBusy(false);
        return;
      }
      timers.current.push(setTimeout(() => void tick(), POLL_MS));
    };
    timers.current.push(setTimeout(() => void tick(), POLL_MS));
  };

  const update = async () => {
    if (!v?.latest) return;
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const r = await api.machines.updateAgent(machine.id);
      if (r.restarting) {
        setNote('Instalando… o agente reinicia e os terminais abertos reconectam.');
        pollUntil(v.latest);
      } else {
        setNote(`Instalado v${r.installed_version ?? v.latest}; reinicie o agente nesta máquina (termhub-agent run ou o serviço).`);
        setBusy(false);
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Erro ao atualizar');
      setBusy(false);
    }
  };

  const toggleAuto = async (next: boolean) => {
    setAuto(next);
    try {
      await updateMachine(machine.id, { agent_auto_update: next });
    } catch (e) {
      setAuto(!next);
      setError(e instanceof ApiError ? e.message : 'Erro ao salvar');
    }
  };

  const summary = !v ? '…' : !v.current ? 'versão desconhecida' : v.updateAvailable && v.latest ? `v${v.current} · v${v.latest} disponível` : v.latest ? `v${v.current} · atualizado` : `v${v.current}`;

  return (
    <div className="rounded-md border border-line bg-bg p-2 text-xs">
      <div className="flex items-center gap-2">
        <p className="font-medium text-fg-muted">Agente</p>
        <span className="text-fg-dim">{summary}</span>
        {v?.updateAvailable && (
          <span className="ml-auto">
            <button type="button" className="btn-ghost px-2 py-0.5" onClick={() => void update()} disabled={busy || !v.online}>
              {busy ? '…' : 'Atualizar'}
            </button>
          </span>
        )}
      </div>
      <label className="mt-1 flex items-center gap-2 text-fg-dim">
        <input type="checkbox" checked={auto} onChange={(e) => void toggleAuto(e.target.checked)} />
        Atualizar automaticamente quando ociosa
      </label>
      <p className="mt-1 text-fg-dim">Sem terminais abertos, o servidor instala novas versões do agente sozinho. Atualizar reinicia o agente; os terminais reconectam.</p>
      {note && <p className="mt-1 text-fg-muted">{note}</p>}
      {error && <p className="mt-1 text-danger">{error}</p>}
    </div>
  );
}
```

Confirm `useData()` exposes `updateMachine(id, input)` and `checkStatus(id)` (both in `DataState`). If `updateMachine` sends a full PATCH that trips `machineBody`, it is fine: the server merges with the current row.

In `MachineForm.tsx`: `import { AgentUpdateCard } from './AgentUpdateCard';` and, just before `{machine && <MonitorHooksCard machine={machine} />}`, add `{machine && machine.type === 'agent' && <AgentUpdateCard machine={machine} />}`.

- [ ] **Step 3: Run tests + build**

Run: `npm test -w @termhub/web && npm run build -w @termhub/web` — expected: PASS. Adjust the tests' text matchers to the exact copy if they drift, never the other way round for the assertions on API calls.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/AgentUpdateCard.tsx apps/web/src/components/AgentUpdateCard.test.tsx apps/web/src/components/MachineForm.tsx
git commit -m "Web: update the agent from the machine form, with an auto-update switch"
```

---

### Task 8: Docs

**Files:**
- Modify: `README.md` (the agent section — search for `termhub-agent connect` or "Agent")
- Modify: `docs/superpowers/specs/2026-09-20-agent-update-ui-design.md` (record the two deviations)

- [ ] **Step 1: README**

Add, in the agent section, one paragraph:

> **Updating the agent.** The server checks npm hourly for a newer `@termhub/agent`. In the sidebar an outdated online agent shows `vX.Y.Z ↑`; open the machine and press **Atualizar** — the agent runs `npm i -g @termhub/agent@<latest>` itself and, when it runs as a service (`termhub-agent service install`), restarts on the new version (open terminals reconnect). Without the service it installs and asks you to restart it. The switch **Atualizar automaticamente quando ociosa** lets the server do this on its own whenever the machine has no open terminal (one attempt per version). Needs agent ≥ 0.2.1; older agents show the badge and the manual command.

- [ ] **Step 2: Spec deviations**

Under "## Web" in the spec, add: "Implementation note (2026-09-20): the list badge lives in the Sidebar machine row (which already showed the agent version), not in ProjectsByMachine; success feedback is an inline note in the card instead of a toast."

- [ ] **Step 3: Commit**

```bash
git add README.md docs/superpowers/specs/2026-09-20-agent-update-ui-design.md
git commit -m "Docs: describe updating the agent from the UI"
```
