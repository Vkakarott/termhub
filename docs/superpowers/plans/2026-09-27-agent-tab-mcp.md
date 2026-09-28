# Agent tab MCP (TER-212) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tabs opened by `start_agent` get their own tab-scoped termhub MCP token (search memory, record lessons, nothing else), delivered as a 0600 file on the machine and revoked when the tab closes.

**Architecture:** A tab token is an `api_tokens` row with `tab_id`; the `/mcp` route narrows it to a fixed tool allowlist and pins `project_id`/`tab_id` arguments to the tab. `startAgent` mints it, writes the config through a `@termhub/machine-ops` script (agent RPC `tab.mcp.write` or ssh stdin), and types a launch line that points to the file.

**Tech Stack:** Fastify + Prisma 6 + Postgres 16/pgvector, zod, Vitest, `@modelcontextprotocol/sdk`; `@termhub/agent` + `@termhub/agent-protocol` + `@termhub/machine-ops`.

**Spec:** `docs/superpowers/specs/2026-09-27-agent-tab-mcp-design.md` (decisions D1–D14 are referenced below).

## Global Constraints

- Worktree `/home/pedrogoiania/termhub-ter212`, branch `feat/ter-212-agent-tab-mcp`. Never touch the main checkout.
- No Node on the host: run everything in `node:22` containers, e.g. `docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/w" -w /w node:22 sh -c '…'`, then `rm -rf .npm`.
- DB tests: throwaway DB **`th-test-db-212`** on **`127.0.0.1:55433`** (another tab uses 55432): `docker build -t th-db-pgvector docker/db && docker run -d --name th-test-db-212 -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=termhub -p 127.0.0.1:55433:5432 th-db-pgvector`; run tests with `--network host -e TERMHUB_DB_TESTS=1 -e DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55433/termhub` after `npx prisma migrate deploy` in `apps/server`. Never touch `termhub-*`, `proxy-*`, `*-app-*` containers.
- The generated Prisma client is committed: after a schema change run `npm run prisma:generate -w @termhub/server` and commit the generated files.
- Migrations additive and nullable (blue/green).
- Token values never in a typed line, an argv, a log, or a test snapshot name. Log ids and codes only.
- Every value in a typed line goes through `shellQuote` (except `$HOME` expansion built by our code, like `configDirArg`).
- UI/tool-error copy pt-BR; code/comments English; commits English, imperative, ending with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- Agent version: `apps/agent/package.json` → `0.10.0` (0.9.0 is the latest published); `TAB_MCP_MIN_AGENT_VERSION = '0.10.0'`.
- Tab-token constants: server name `termhub_tab`; dir `~/.termhub/tabs/<tab_id>/`; files `mcp.json` (Claude) and `token` (Codex); env var `TERMHUB_MCP_TOKEN`; TTL 30 days; tools `search_memory`, `record_lesson`; excluded kinds `message`, `action`.

## Review Focus

1. A tab token whose tab row was deleted by a machine delete cascade (not `TabsRepository.delete`) → 401 on the next `/mcp` call. Test in Task 3.
2. A tab token calling `search_memory` with `project_id` of another of the same user's projects → refused; with none → results only from its project, decisions included (decisions filter by project for tab tokens). Test in Task 3.
3. `record_lesson` does not exist yet on main: the allowlist must not crash `allowedTools` or `tools/list` when a listed name has no tool. Test in Task 3.
4. `start_agent` on an agent older than 0.10.0, or with `MCP_URL` unset, or with the write RPC failing → the tab starts exactly as before, and the token minted (if any) is revoked. Test in Task 4.
5. A tab id is interpolated into a shell script and into the typed line: it must match `^[a-z0-9]{1,64}$` before either (ids come from `newId()`), or the call throws. Test in Task 2 and Task 4.

---

### Task 1: `api_tokens.tab_id`, repository and revoke on tab delete

**Files:**
- Modify: `apps/server/prisma/schema.prisma` (model `ApiToken`: `tabId String? @map("tab_id")` + `@@index([tabId])`)
- Create: `apps/server/prisma/migrations/20260927230000_api_token_tab/migration.sql`
- Modify: `apps/server/src/db/repositories/api-tokens.ts`, `apps/server/src/db/repositories/tabs.ts`
- Modify: generated client under `apps/server/src/generated/prisma/` (regenerate)
- Test: `apps/server/src/db/repositories/api-tokens.db.test.ts`, `apps/server/src/db/repositories/tabs.db.test.ts`

**Interfaces:**
- Produces: `ApiToken.tab_id: string | null`; `ApiTokensRepository.create(userId, { …, tabId?: string | null }, hash)`; `ApiTokensRepository.revokeForTab(tabId: string): Promise<number>`; `countActive` excludes tab tokens; `TabsRepository.delete(id)` revokes that tab's live tokens in the same transaction.

- [ ] **Step 1: Failing DB tests** (in `api-tokens.db.test.ts`):

```ts
it('maps tab_id, keeps tab tokens out of the active count, and revokes them by tab', async () => {
  const tabToken = await repo.create(userId, { name: 'aba', scopes: ['read', 'memory'], expiresAt: null, tabId: 'tab1' }, newId(32));
  await make(userId);
  expect(tabToken.tab_id).toBe('tab1');
  expect(await repo.countActive(userId)).toBe(1);
  expect(await repo.revokeForTab('tab1')).toBe(1);
  expect(await repo.revokeForTab('tab1')).toBe(0);
  expect((await repo.listByUser(userId)).find((t) => t.id === tabToken.id)?.revoked_at).not.toBeNull();
});
```

In `tabs.db.test.ts` (reuse its fixtures for user/machine/project/tab): create a token with `tabId: tab.id`, call `tabs.delete(tab.id)`, assert the token's `revokedAt` is set; a token of another tab stays live.

- [ ] **Step 2:** Run against `th-test-db-212` → FAIL (`tabId` unknown).
- [ ] **Step 3: Implement.** Migration:

```sql
ALTER TABLE "api_tokens" ADD COLUMN "tab_id" TEXT;
CREATE INDEX "api_tokens_tab_id_idx" ON "api_tokens"("tab_id");
```

No FK (spec D1). Repository: map `tab_id: t.tabId`; `create` writes `tabId: input.tabId ?? null`; `countActive` adds `tabId: null` to the where; `revokeForTab` = `updateMany({ where: { tabId, revokedAt: null }, data: { revokedAt: new Date() } })`. `TabsRepository.delete`:

```ts
async delete(id: string): Promise<boolean> {
  // A tab token dies with its tab (spec 2026-09-27 agent tab MCP D6): same transaction, so there is
  // no moment where the tab is gone and its token still works.
  const [, r] = await this.db.$transaction([
    this.db.apiToken.updateMany({ where: { tabId: id, revokedAt: null }, data: { revokedAt: new Date() } }),
    this.db.tab.deleteMany({ where: { id } }),
  ]);
  return r.count > 0;
}
```

- [ ] **Step 4:** Regenerate the client, run the two DB test files + `prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --shadow-database-url postgresql://postgres:postgres@127.0.0.1:55433/shadow --exit-code` → PASS / no drift (only the known pgvector index lines).
- [ ] **Step 5: Commit** `Tokens: tab_id on api_tokens, revoked with the tab`.

### Task 2: machine-ops scripts, agent protocol and agent 0.10.0

**Files:**
- Create: `packages/machine-ops/src/tab-mcp.ts`, `packages/machine-ops/src/tab-mcp.test.ts`; export from `packages/machine-ops/src/index.ts`
- Modify: `packages/agent-protocol/src/rpc.ts`, `packages/agent-protocol/src/rpc.test.ts`
- Create: `apps/agent/src/rpc/tab-mcp.ts`, `apps/agent/src/rpc/tab-mcp.test.ts`; register in `apps/agent/src/rpc/index.ts`
- Modify: `apps/agent/package.json` (`0.10.0`), any version constant/test the agent keeps in sync (grep `0.9.0` under `apps/agent`)

**Interfaces:**
- Produces (machine-ops): `TAB_MCP_DIR_REL = '.termhub/tabs'`; `TAB_ID_RE = /^[a-z0-9]{1,64}$/`; `type TabMcpFile = 'mcp.json' | 'token'`; `buildTabMcpWriteScript(tabId: string, file: TabMcpFile): string` (reads the body from stdin, prints `ok`); `buildTabMcpRemoveScript(tabId: string): string`. Both throw `Error('tab id inválido')` when `!TAB_ID_RE.test(tabId)`.
- Produces (protocol): `'tab.mcp.write': { tab_id, file: 'mcp.json'|'token', body: string ≤ 8192 } → { ok: true }` (10 s); `'tab.mcp.remove': { tab_id } → { ok: true }` (10 s).

- [ ] **Step 1: Failing tests.** `tab-mcp.test.ts` (machine-ops) runs the scripts for real with `sh` in a temp HOME:

```ts
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildTabMcpRemoveScript, buildTabMcpWriteScript } from './tab-mcp.js';

describe('tab MCP scripts', () => {
  it('writes the body from stdin to a 0600 file in a 0700 dir, then removes the dir', () => {
    const home = mkdtempSync(join(tmpdir(), 'tabmcp-'));
    const env = { ...process.env, HOME: home };
    const out = execFileSync('sh', ['-c', buildTabMcpWriteScript('abc123', 'mcp.json')], { input: '{"x":1}', env }).toString();
    expect(out.trim()).toBe('ok');
    const dir = join(home, '.termhub/tabs/abc123');
    expect(readFileSync(join(dir, 'mcp.json'), 'utf8')).toBe('{"x":1}');
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, 'mcp.json')).mode & 0o777).toBe(0o600);
    execFileSync('sh', ['-c', buildTabMcpRemoveScript('abc123')], { env });
    expect(existsSync(dir)).toBe(false);
  });
  it('refuses a tab id that is not [a-z0-9]', () => {
    expect(() => buildTabMcpWriteScript('../x', 'token')).toThrow('tab id inválido');
    expect(() => buildTabMcpRemoveScript("a'b")).toThrow('tab id inválido');
  });
  it('never puts the body in the script', () => {
    expect(buildTabMcpWriteScript('abc', 'token')).not.toContain('thb_pat_');
  });
});
```

Protocol test: `tab.mcp.write` accepts `{ tab_id: 'abc', file: 'token', body: 'x' }`, refuses `tab_id: '../x'`, `file: 'other'`, a 8193-char body; `tab.mcp.remove` refuses a bad id; add both names to the method-list assertion. Agent handler test: with a temp HOME (inject `home` like `hooks.ts` does, or set `process.env.HOME`), `write` then `remove`.

- [ ] **Step 2:** `npm test -w @termhub/machine-ops -w @termhub/agent-protocol -w @termhub/agent` → FAIL.
- [ ] **Step 3: Implement.** Script:

```ts
export function buildTabMcpWriteScript(tabId: string, file: TabMcpFile): string {
  const dir = tabDir(tabId); // throws on a bad id
  return [
    'umask 077',
    `d="$HOME/${dir}"`,
    'mkdir -p "$d" || exit 1',
    'chmod 700 "$d" || exit 1',
    `cat > "$d/${file}.tmp" || exit 1`,
    `mv -f "$d/${file}.tmp" "$d/${file}" || exit 1`,
    'echo ok',
  ].join('\n');
}
export function buildTabMcpRemoveScript(tabId: string): string {
  return `rm -rf "$HOME/${tabDir(tabId)}"; echo ok`;
}
```

Agent handler: `sh(buildTabMcpWriteScript(p.tab_id, p.file), { input: Buffer.from(p.body), timeoutMs: 10_000 })`, `RpcFailure('timeout'|'internal', …)` like `paste.ts`; never log `body`. Bump the agent to `0.10.0`.
- [ ] **Step 4:** Tests PASS; `npm run typecheck -w @termhub/agent && npm run build -w @termhub/agent`.
- [ ] **Step 5: Commit** `Agent: tab.mcp.write/remove RPCs for the tab MCP config (0.10.0)`.

### Task 3: Tab token on `/mcp` — allowlist, pinning, auth, memory restrictions

**Files:**
- Create: `apps/server/src/mcp/tab-token.ts`, `apps/server/src/mcp/tab-token.test.ts`
- Modify: `apps/server/src/mcp/auth.ts`, `apps/server/src/mcp/route.ts`, `apps/server/src/mcp/tools.ts` (`allowedTools` only), `apps/server/src/control/context.ts`, `apps/server/src/control/memory.ts`, `apps/server/src/db/repositories/chat-decisions.ts` (optional `projectId` on `nearestAny`/`textSearch`)
- Test: `apps/server/src/mcp/route.test.ts` (or the file that tests `tools/list` per scope), `apps/server/src/control/memory.test.ts`, `apps/server/src/db/repositories/chat-decisions.db.test.ts`

**Interfaces:**
- Consumes: `ApiToken.tab_id` (Task 1).
- Produces:
  - `ControlContext.token?: { id; scopes; gated?; tab?: { id: string; project_id: string } }`, and `controlContextFor(repos, user, token)` passes it through.
  - `authenticateToken` → `{ token, user, tab: { id, project_id } | null }`; null (401) when `token.tab_id` is set and `repos.tabs.findById(token.tab_id)` is undefined.
  - `tab-token.ts`: `TAB_TOKEN_TOOLS = ['search_memory', 'record_lesson'] as const`; `TAB_TOKEN_SCOPES: ApiTokenScope[] = ['read', 'memory']`; `TAB_EXCLUDED_KINDS = ['message', 'action'] as const`; `TAB_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000`; `tabTokenName(tabName: string): string` → `` `aba «${tabName.slice(0, 60)}» (automático)` ``; `mintTabToken(repos, userId, tab: { id: string; name: string }): Promise<{ token: string; id: string }>` (always `gated: false`); `pinTabArgs(tab: { id; project_id }, args: Record<string, unknown>): Record<string, unknown>` — throws `ControlError('TAB_SCOPE', 'O token desta aba só acessa o projeto da aba')` when `project_id` is present and different, `ControlError('TAB_SCOPE', 'O token desta aba só age em nome da própria aba')` when `tab_id` is present and different; fills both when absent **only for keys the tool's input declares** (pass the tool's `input` shape: `pinTabArgs(tab, args, Object.keys(tool.input))`).
  - `allowedTools(ctx, scopes)`: when `ctx.token?.tab`, keep only names in `TAB_TOKEN_TOOLS`.
  - `ChatDecisionsRepository.nearestAny(userId, vector, k, projectId?)` / `textSearch(userId, query, k, projectId?)`: when `projectId` is given, `AND d.project_id = ${projectId}`.
  - `searchMemory`: when `ctx.token?.tab`, `project_id` is forced to the tab's project (the route already pinned it; keep the check here too), decisions are filtered by it, and `kinds` loses `message`/`action` (default = all kinds minus those); a request for only excluded kinds → `ControlError('TAB_SCOPE', 'O token desta aba não lê mensagens do chat nem decisões do gate')`.

- [ ] **Step 1: Failing tests.**
  - `tab-token.test.ts`: `pinTabArgs` fills `project_id` when declared and absent, refuses a different one, forces `tab_id`, leaves undeclared keys alone; `tabTokenName` truncates.
  - Route/tools test (follow the existing `route.test.ts` style of building the app with a fake repos or the DB): with a token `{ scopes: ['read','memory'], tab: {…} }`, `tools/list` names ⊆ `['search_memory','record_lesson']` and includes `search_memory`; `tools/call list_tabs` → refusal text; `search_memory` with `project_id` of another project → error text containing "projeto da aba".
  - Auth test: `authenticateToken` with a tab token whose `tabs.findById` returns undefined → null.
  - `memory.test.ts`: with `ctx.token.tab`, the repos' `memoryItems.*` receive `kinds` without `message`/`action` and `projectId` = the tab's project; `chatDecisions.*` receive the project id; `kinds: ['message']` throws `TAB_SCOPE`.
  - `chat-decisions.db.test.ts`: `textSearch(..., projectId)` returns only that project's rows.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: Implement.** In `route.ts`, inside the tool handler, before `applyGate`:

```ts
const tab = ctx.token?.tab;
const callArgs = tab ? pinTabArgs(tab, args, Object.keys(tool.input)) : args;
```

and pass `callArgs` to `applyGate`/`tool.run`; `ControlError` from `pinTabArgs` is already turned into a tool error by the existing `catch` (move the call inside the `try`). In `authenticate`: `ctx.token.tab = auth.tab ?? undefined`.
- [ ] **Step 4:** Server unit + DB tests PASS; `npm run typecheck -w @termhub/server`.
- [ ] **Step 5: Commit** `MCP: tab tokens see only memory tools, pinned to their tab`.

### Task 4: Deliver the config and launch with it

**Files:**
- Create: `apps/server/src/terminal/tab-mcp.ts`, `apps/server/src/terminal/tab-mcp.test.ts`
- Modify: `apps/server/src/control/agents.ts`, `apps/server/src/control/agents.test.ts`, `apps/server/src/control/account-swap.ts` (resume line), `apps/server/src/control/terminals.ts` (`closeTab`), `apps/server/src/routes/tabs.ts` (DELETE), `apps/server/src/control/project-links.ts` (`removeProjectMachineLink`)
- Test: `apps/server/src/mcp/start-agent.e2e.test.ts` if it covers `startAgent` end to end

**Interfaces:**
- Consumes: `buildTabMcpWriteScript`/`buildTabMcpRemoveScript`/`TAB_ID_RE` (Task 2), `mintTabToken`/`TAB_TOKEN_TOOLS` (Task 3), `revokeForTab` (Task 1), `mcpConfig(url, token)` from `@termhub/claude-cli` (server name changes: add an optional third parameter `name = 'termhub'`).
- Produces:
  - `TAB_MCP_MIN_AGENT_VERSION = '0.10.0'`; `TAB_MCP_SERVER = 'termhub_tab'`.
  - `installTabMcp(machine: Machine, tabId: string, file: 'mcp.json' | 'token', body: string): Promise<void>` — agent: `requireAgentVersion` then `agentRpc('tab.mcp.write', …)`; ssh/local: `runOnMachineWithInput(machine, { file: 'sh', args: ['-c', script] }, script, Buffer.from(body), 10_000)` and check `stdout` has `ok`. Throws on failure.
  - `removeTabMcp(machine, tabId): Promise<void>` — best effort, never throws (same dispatch; an agent older than 0.10.0 is skipped).
  - `tabMcpSupported(machine): boolean` — `ssh`/`local` always; agent when its version ≥ 0.10.0.
  - `launchLine(provider, configDir, prompt, mcp?: { tabId: string; url: string } | null)`:
    - Claude + mcp: `` `${env}claude --mcp-config "$HOME"/${shellQuote(`.termhub/tabs/${tabId}/mcp.json`)} --allowedTools ${shellQuote('mcp__termhub_tab__search_memory')} ${shellQuote('mcp__termhub_tab__record_lesson')} -- ${shellQuote(prompt)}` ``
    - Codex + mcp: `` `TERMHUB_MCP_TOKEN="$(cat "$HOME"/${shellQuote(`.termhub/tabs/${tabId}/token`)})" ${env}codex -c ${shellQuote(`mcp_servers.termhub_tab.url="${url}"`)} -c ${shellQuote('mcp_servers.termhub_tab.bearer_token_env_var="TERMHUB_MCP_TOKEN"')} ${shellQuote(prompt)}` ``
    - Throws `ControlError('INVALID_TAB', …)` when `!TAB_ID_RE.test(tabId)`; the url must match `/^https?:\/\/[^\s'"]+$/`.
    - Without `mcp`: exactly today's line.
  - `resumeLine(configDir, sessionId, prompt, mcpTabId?: string | null)`: Claude flags as above inserted before `--resume`… keep order `claude --mcp-config … --allowedTools … --resume <id> -- '<prompt>'`.
  - `startAgent` flow after `openTab`: if `config.mcpUrl` and provider ∈ {claude, chatgpt} and `tabMcpSupported(machine)`: `mintTabToken` → `installTabMcp` (Claude: `mcp.json` = `mcpConfig(url, token, TAB_MCP_SERVER)`; Codex: `token`) → on any failure `repos.apiTokens.revokeForTab(tab.tab_id)` and fall back to the plain line. The result's `note` appends `' A aba tem o MCP termhub_tab (search_memory) para consultar a memória do projeto.'` or `' A aba abriu sem o MCP de memória: <motivo>.'` (motivos: `MCP_URL não configurado`, `o termhub-agent desta máquina é anterior à 0.10.0`, `não foi possível gravar a configuração na máquina`). Log `{ tabId, machineId, installed: boolean, reason }` only.
  - Close paths: after the tmux kill, `void removeTabMcp(machine, tab.id)`.
  - `account-swap.ts`: pass `tab.id` as `mcpTabId` when `(await repos.apiTokens.listByUser(userId)).some((t) => t.tab_id === tab.id && t.revoked_at === null)` — or add `ApiTokensRepository.hasLiveForTab(tabId)` and use it.

- [ ] **Step 1: Failing tests.**
  - `agents.test.ts`: Claude line with mcp equals the exact string above for `tabId: 'abc'`; Codex line likewise; neither contains `thb_pat_`; a prompt starting with a quote stays quoted; `launchLine('claude', null, 'x', { tabId: '../x', url })` throws; without `mcp` the line is unchanged (existing tests keep passing).
  - `tab-mcp.test.ts`: with a fake agent machine at 0.9.0 → `tabMcpSupported` false; `installTabMcp` on an agent calls `agentRpc` with `tab.mcp.write` (mock `../agent/errors.js`), on ssh calls `runOnMachineWithInput` with the body as input and the script (not the body) as the remote command; `removeTabMcp` swallows errors.
  - `startAgent`: with `config.mcpUrl` set and a stubbed installer, the typed line contains `--mcp-config` and a token row with `tab_id` exists; when the installer throws, the line is the plain one and `revokeForTab` was called; with `mcpUrl` null no token is minted.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: Implement** as specified. `mcpConfig` gains `name = 'termhub'` (concierge unchanged).
- [ ] **Step 4:** `npm test -w @termhub/claude-cli` and the server suite PASS; typecheck.
- [ ] **Step 5: Commit** `start_agent: give the tab a memory MCP through a per-tab token`.

### Task 5: Docs, full verification and smoke

**Files:**
- Modify: `README.md` (MCP section: tab tokens), `docs/superpowers/specs/2026-09-27-agent-tab-mcp-design.md` (§9 deviations, if any)

- [ ] **Step 1:** Full checks in `node:22`: `npm run build:packages && npm run prisma:generate`, the Prisma client staleness check (`git diff --exit-code apps/server/src/generated`), `npm test` for agent-protocol, machine-ops, claude-cli, agent, server (unit + DB against `th-test-db-212`), web; `npm run typecheck -w @termhub/server && npm run build -w @termhub/web && npm run build -w @termhub/landing && npm run typecheck -w @termhub/agent`.
- [ ] **Step 2: Smoke** (throwaway containers only): start the server against `th-test-db-212` with `MCP_URL` set; seed a user, project, local-type machine is not needed — call `mintTabToken` through a tiny `tsx` script for a seeded tab; `POST /mcp tools/list` with that token → only `search_memory`; `tools/call search_memory` → ok; delete the tab row with SQL → the next call 401. Record outputs in the report. Remove `th-*` containers.
- [ ] **Step 3:** README: one paragraph under the MCP section ("Abas abertas por start_agent recebem um token próprio…" in English, per repo rules).
- [ ] **Step 4: Commit** `Docs: tab-scoped MCP tokens for agent tabs`.

## Board mapping

- TER-213 (desenho) → spec + this plan.
- TER-214 (servidor + agente: config por aba) → Tasks 2 and 4.
- TER-215 (prompt inicial) → resolved by TER-205 D13 (spec D14): no prompt text here.
- TER-216 (testes) → the tests of Tasks 1–5.
- New: T1 migração/revogação, T3 allowlist/pin no /mcp, PR/CI/merge/deploy + publicação do agente 0.10.0, verificar Codex no hulk.
