# Agent update from the UI — design

Date: 2026-09-20. Status: approved in conversation (Pedro), implementation follows.

## Goal

Show, per agent machine, that a newer `@termhub/agent` is published on npm, and let the user
update it from the web app with one click — or opt in to automatic updates when the machine
is idle. Only `type: 'agent'` machines are concerned (ssh/local are legacy and have no agent).

## Non-goals

- Updating the web app or the server.
- Rollback, pinning to a version, or channels other than npm `latest`.
- Notifying by e-mail/push.

## Architecture

Server-driven. The server is the single place that knows the latest published version
(npm registry, cached), the version each agent reported in its `hello`, and whether a machine is
idle (open PTY channels on its `AgentConnection`). The agent exposes one new RPC that installs
a given version and restarts itself when it runs as a service.

```
npm registry ──(hourly, cached)──▶ server latest-version ──▶ GET /machines, GET /machines/:id/status
                                        │                          (latest_agent_version, update_available)
                                        ├─ auto-update tick (idle + opted-in machines)
                                        └─ POST /machines/:id/agent/update ──RPC agent.update──▶ agent
                                                                                                 npm i -g @termhub/agent@X
                                                                                                 exit 1 → launchd/systemd restarts
```

## Server

### `apps/server/src/agent/latest-version.ts`

- `fetchLatestAgentVersion()` → `GET https://registry.npmjs.org/@termhub/agent/latest`
  through `httpJson` (from `ai/credentials.ts`, 10 s timeout); reads `body.version`; returns
  `string | null`. Any error → `null` and a warn log with status only.
- In-memory cache `{ version: string | null; fetched_at: number }`. `latestAgentVersion()` returns
  the cached version (null until the first successful fetch).
- `startAgentVersionPoller(deps)` called from `app.ts` next to the other `setInterval` jobs:
  fetch at boot, then every 60 min (`.unref()`), each success followed by `autoUpdateTick()`.
  Returns a stop function for tests / shutdown. Disabled when `NODE_ENV === 'test'` unless
  started explicitly.
- `compareVersions(a, b)`: numeric compare of `major.minor.patch` (pre-release suffix ignored).
  `isOutdated(current: string | null, latest: string | null)` → true only when both are
  parseable and `current < latest`.

### Status / list

- `GET /machines/:id/status` (agent branch) adds `latest_agent_version` and
  `update_available = online && isOutdated(agent_version, latest)`.
- `GET /machines` adds `update_available` per machine (agents online only, same rule) and
  `latest_agent_version` at the top level (`{ machines, latest_agent_version }`).
  `Machine` serialization (`repositories/types.ts`) is unchanged; the route decorates.

### Trigger: `POST /machines/:id/agent/update`

- Registered inside the existing machines plugin (already `guarded('machines', …)`);
  the handler checks the `machines:write` grant like the hooks routes do.
- Load the machine through `scoped(repos, request).machine(id)`; 400 unless `type === 'agent'`.
- 409 `Agente desconectado` when `!agents.isOnline(id)`; 409 `Agente já está na versão mais nova`
  when not outdated; 503 `Versão mais nova desconhecida` when the npm cache is empty.
- Calls `agents.rpc(id, 'agent.update', { version: latest }, 180_000)` and returns
  `{ installed_version, restart }`. Error mapping: `AgentClosedError` during the call →
  `{ installed_version: null, restart: 'service', restarting: true }` (the agent went away
  after replying, or while exiting); `AgentTimeoutError` → 504; `AgentRpcError` → through
  `toHttpError` (never forward the raw message).

### Auto-update

- New column `machines.agent_auto_update Boolean @default(false) @map("agent_auto_update")`
  (additive migration, safe for the blue/green window). Exposed as `agent_auto_update` in the
  `Machine` serialization and accepted by `PATCH /machines/:id` (zod boolean, agent machines only).
- `autoUpdateTick()` in `latest-version.ts`: runs after each successful fetch and every 10 min
  (`.unref()`). For each machine with `agent_auto_update` (repository method
  `machines.listAutoUpdate()`), skip unless: online, `isOutdated(info.agent_version, latest)`,
  idle (`agents.openChannels(id) === 0` — new registry method exposing
  `conn.channels.size`), and `attempted.get(id) !== latest` (in-memory map so a failing
  install is tried once per version). Run the same RPC; log outcome as metadata only
  (machine id, from → to, restart, error code). Never throws; errors are caught per machine.

## Agent

### Protocol (`packages/agent-protocol/src/rpc.ts`)

```ts
'agent.update': def(
  z.object({ version: z.string().regex(/^\d+\.\d+\.\d+$/) }),
  z.object({ installed_version: z.string(), restart: z.enum(['service', 'manual']) }),
  180_000,
),
```

`version` is validated by the schema and only ever passed as an argv element — never to `sh()`.

### Handler `apps/agent/src/rpc/update.ts`

1. Mutex: a module-level `inFlight` promise; a second call while one runs rejects with
   `RpcFailure('failed', 'update already running')`.
2. Locate npm: `path.join(path.dirname(process.execPath), 'npm')` if it exists (nvm, Homebrew,
   official installer all ship `npm` beside `node`); otherwise `'npm'` from `PATH`.
3. `run(npm, ['install', '-g', '--no-fund', '--no-audit', `@termhub/agent@${version}`], { timeoutMs: 150_000 })`.
   Non-zero exit → `RpcFailure('failed', `npm exited with code ${code}`)` (stdout/stderr never
   logged or forwarded). Missing npm (`ENOENT`) → `RpcFailure('notfound', 'npm not found')`.
4. Read the installed version: the `package.json` two levels above
   `resolveScriptPath(process.argv[1])` (`dist/cli.js` → package root). If it does not equal
   `version` → `RpcFailure('failed', 'installed version mismatch')`.
5. `restart = (await service.status()) ? 'service' : 'manual'`.
6. Return the result; when `restart === 'service'`, `setTimeout(() => process.exit(1), 750)`
   (unref'd) so the reply is flushed first; launchd (`KeepAlive.SuccessfulExit=false`) and
   systemd (`Restart=on-failure`) relaunch the new code. Exit code 1, never 78.
7. Logs: `[termhub-agent] update { from, to, restart }` and failures with code only.

Register in `apps/agent/src/rpc/index.ts`. Bump agent to **0.2.1** (`package.json` +
`version.ts`); tag `agent-v0.2.1` after merge.

## Web

### Types / API (`apps/web/src/lib`)

- `Machine.agent_auto_update: boolean`, `Machine.update_available?: boolean`.
- `api.machines.list()` result gains `latest_agent_version: string | null`.
- `api.machines.status()` gains `latest_agent_version`, `update_available`.
- `api.machines.updateAgent(id)` → `POST /machines/:id/agent/update`.
- `api.machines.update(id, { agent_auto_update })` (existing PATCH).

### Badge in the list (`ProjectsByMachine.tsx`)

Next to the machine name, when `update_available`: a small pill `atualização` (warn tone)
with `title="Nova versão do agente disponível"`; clicking opens the machine modal (same
handler the name/edit action already uses).

### `AgentUpdateCard.tsx` (mounted in `MachineForm` for existing agent machines)

Modeled on `MonitorHooksCard`. On mount fetch `api.machines.status(machine.id)`.

- Header "Agente" · body `v<current>` and, when `update_available`, `· v<latest> disponível`.
- Button **Atualizar** (disabled when offline, up to date, or latest unknown).
  Click → `updateAgent`; state `updating`: spinner + "Instalando… o agente reinicia e os
  terminais reconectam." Then poll `status` every 3 s (max 90 s) until `agent_version === latest`;
  success toast "Agente atualizado para v<latest>". `restart: 'manual'` → note "Instalado;
  reinicie o agente nesta máquina (`termhub-agent run`)." Poll timeout → note "Ainda
  reconectando… verifique a máquina." Errors → inline error with the server message.
- Toggle "Atualizar automaticamente quando ociosa" → PATCH `agent_auto_update`; helper text
  "Sem terminais abertos, o servidor instala novas versões sozinho."
- Copy in pt-BR.

## Error handling summary

| Situation | Behaviour |
|---|---|
| npm registry unreachable | cache stays null → no badge, card shows only current version |
| agent offline | 409, button disabled |
| npm install fails | RPC `failed` with exit code; agent keeps running old version; UI shows the message and the manual command |
| agent exits before replying | `AgentClosedError` → `restarting: true`; UI polls |
| service not installed | update files, `restart: 'manual'`; UI tells the user to restart |
| auto-update fails | one attempt per version per machine; warn log |

## Testing

- `latest-version.test.ts`: registry parse, `compareVersions`/`isOutdated`, cache null before
  first fetch, `autoUpdateTick` selects only online+outdated+idle+opted-in machines, attempts
  once per version, swallows RPC errors.
- Routes: status/list decoration, update route refusals (offline, up to date, unknown latest,
  non-agent), error mapping.
- Agent handler with `run`/`service.status`/fs mocked: npm missing, exit ≠ 0, version mismatch,
  success with service (exit scheduled) and without.
- Web: `AgentUpdateCard` renders up-to-date / update available / updating / manual restart.
- Protocol: `agent.update` schema rejects non-semver versions.

## Docs

README "Agent" section: one paragraph on the badge, the button, the auto-update toggle
(idle = no open terminals), and that agents ≥ 0.2.1 support it (older agents show the badge
but the button reports the RPC as unsupported).
