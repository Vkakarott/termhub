# iOS Simulator over the termhub agent — design

Date: 2026-09-24. Status: approved in conversation (sections 1–7), written for implementation.

## 1. Why

The iOS simulator tab (`docs/superpowers/specs/2026-09-17-ios-simulator-tab-design.md`, floating
window in `2026-09-18-pane-layout-floating-simulator-design.md`) streams a simulator running on a
Mac into the browser through WebDriverAgent (WDA): the server boots the device, starts WDA's
runner in tmux, tunnels the runner's HTTP and MJPEG ports with `ssh -N -L`, relays JPEG frames to
the browser over `/ws/sim/<tabId>` and turns taps, drags, keys and buttons into WDA calls.

That whole stack is still in the tree (`apps/server/src/simulator/*`, `apps/web/src/components/
SimulatorView.tsx`, `SimulatorSetupCard.tsx`), but it only works for `ssh` and `local` machines: it
runs shell scripts through `runOnMachine` and opens an ssh tunnel, and both throw for `agent`
machines. Since commit `8add6b7` new machines can only be added as agents, so for every new
machine the feature is off (`409 Simulador indisponível em máquinas com agente`). The agent spec
(`2026-09-18-termhub-agent-design.md` §11) reserved a `tcp` stream kind exactly for this.

Goal: the same flow and the same UX as before — a Mac shows up in Máquinas, its terminals work,
the simulator button next to "+" opens a simulator tab, the device picker lists that Mac's
simulators, quality presets LAN/Remoto stay — now over the agent instead of SSH.

Out of scope: Android (people run it locally; iOS is the painful one), physical devices, audio,
adaptive quality, a generic port-forward for arbitrary ports.

## 2. Decisions (from brainstorming)

| Question | Decision |
|---|---|
| Platform | iOS only, via WDA, as before. Android is a separate epic if ever. |
| UX | Unchanged: simulator button in the tab bar, simulator tab, device picker, LAN (scale 50 / quality 50) and Remoto (25 / 30) presets, Home/Lock/Rotate/Screenshot, fps counter, "Preparar WDA" card on the machine. |
| Transport | **Approach A**: a generic `tcp` stream kind in the agent protocol, restricted to loopback and the WDA port ranges; the server's simulator code keeps seeing "two local ports" through a new `Tunnel` implementation. |
| Machine operations | Named RPCs with constant scripts in `@termhub/machine-ops`; the server never sends shell text (agent rule kept). |
| Flow control | Simple backpressure: the agent pauses the local socket when its WebSocket buffer is full. No frame dropping in the agent, no adaptive quality. |
| Future | **Approach C** documented as the upgrade path if latency builds up on slow links (§9). |
| Network topology | Not decided now; the code must not assume LAN or WAN. |

## 3. Protocol (`packages/agent-protocol`)

### 3.1 `tcp` stream kind

Server → agent: `{"type":"open","ch":n,"kind":"tcp","params":{"port":8137}}`.

- The agent connects to `127.0.0.1:<port>`. On `connect` it answers `opened`; from then on bytes
  on channel `n` are written to the socket and bytes from the socket are sent on channel `n`, raw,
  no envelope (same as `pty`).
- `port` is validated by zod on both sides: an integer in **8100–8199** or **9100–9199**, the ranges
  `apps/server/src/simulator/ports.ts` derives from a UDID (`fnv1a(udid) % 100`). No `host`
  parameter exists: loopback is fixed. The agent re-validates before connecting; it never trusts
  the server alone. Widening this to arbitrary ports (e.g. a dev-server preview) is a separate
  design decision, not a silent loosening here.
- `close` from the server destroys the socket. The socket ending, erroring or being refused makes
  the agent send `closed { ch, code: null, reason }` exactly once.
- A connection that fails before `opened` is reported as `open_error`; `rpcErrorSchema.code` gains
  `refused` (nothing listening on the port — the "WDA runner still starting" case), `internal`
  covers the rest. `closedReason` gains `reset` (the peer reset or errored after connecting).
- `resize` on a `tcp` channel is a protocol violation (1008), like an unknown channel.
- `PROTOCOL_VERSION` stays `1`: everything here is additive and optional.

### 3.2 Capability

`CAPABILITY_SIM = 'sim'`. The agent advertises it in `hello.capabilities` on macOS only. The server
requires it (through `registry.capabilities(machineId)`) before any `sim.*` / `wda.*` RPC and before
opening a `tcp` channel; an online agent without it gets `409 AGENT_OUTDATED` with the existing
"update the agent" sentence (`requireAgentVersion` / a new `requireSimCapable`).

### 3.3 RPC catalog additions

All params and results validated with zod on both sides (schemas in `rpc.ts`). Scripts are
compile-time constants in `@termhub/machine-ops`; values reach them only through the environment.

| Method | Params | Result | Timeout | Replaces |
|---|---|---|---|---|
| `sim.list` | `{}` | `{ stdout }` (raw `xcrun simctl list devices -j`; parser stays on the server) | 15 s | `listSimulators` |
| `sim.boot` | `{ udid }` | `{ stdout }` (combined output; `isBootFailure` stays on the server) | 60 s | `bootSimulator` |
| `wda.runner.start` | `{ udid, wda_port, mjpeg_port }` | `{ started: boolean }` (`false` = tmux session already existed) | 10 s | `startRunner` |
| `wda.runner.alive` | `{ udid }` | `{ alive: boolean }` | 8 s | `runnerAlive` |
| `wda.runner.tail` | `{ udid, lines: 1..200 }` | `{ lines: string[] }` | 8 s | `runnerTail` |
| `wda.setup.start` | `{}` | `{ started: boolean }` (`false` = setup already running) | 10 s | `startWdaSetup` |
| `wda.setup.state` | `{}` | `{ stdout }` (same `STATE:/VERSION:/TAIL:` text; `parseSetupOutput` stays on the server) | 8 s | `wdaSetupState` |

`stopRunner` needs no new RPC: it is `tmux.kill` of the session `termhub-wda-<first 8 chars of
udid>`, which already has an agent branch. `udid` matches `^[A-Fa-f0-9-]{8,64}$` on both sides;
`wda_port` / `mjpeg_port` use the port ranges above.

## 4. Agent (`apps/agent`)

### 4.1 `src/tcp.ts` — `createTcpManager`

Same shape as `PtyManager` and `ClaudeManager`, so `dispatch.ts` keeps routing by `kind` only.

- `open(ch, { port }, socket)`: re-validates the port range, `net.connect({ host: '127.0.0.1', port })`.
  On `connect` → `opened`; on `error` before connect → `open_error` (`refused` for ECONNREFUSED,
  `internal` otherwise). After that, socket `data` → `socket.sendStream(ch, chunk)`; channel bytes →
  `sock.write`.
- `write(ch, data)`: returns `false` when the channel is not its own, matching the existing
  `claude.write(ch, data) || pty.write(ch, data)` chain in `dispatch.ts` (`tcp` joins the chain).
- `close(ch)`: destroys the socket. Socket `end` / `close` / `error` send `closed { ch, code: null,
  reason }` once. `closeAll()` runs on `onDisconnect` like the other managers.

### 4.2 Flow control

- Agent → server: before forwarding a chunk, if `ws.bufferedAmount` > **4 MiB**, `sock.pause()`;
  a 50 ms timer resumes once it drops below **1 MiB**. The MJPEG stream is a single TCP connection,
  so pausing it pushes the pressure back to WDA, which holds frames at the source instead of the
  agent growing its memory or starving the terminals that share the WebSocket.
- Server → agent: channel bytes go to `sock.write`; a `false` return is left to the kernel to
  queue (that direction only carries WDA command HTTP, negligible volume).
- Chunks larger than `MAX_FRAME - HEADER_BYTES` are sliced before `sendStream`, so the server's
  1 MiB `maxPayload` (which closes the whole socket with 1009) is never hit. This guard moves into
  `client.ts`'s `sendStream` itself, because the PTY channel has the same latent risk.

### 4.3 RPC handlers

`src/rpc/sim.ts` and `src/rpc/wda.ts`, one pure `(params) => Promise<result>` per method, calling
`sh(SCRIPT, { env })` from `exec.ts`. The scripts live in `packages/machine-ops/src/simulator.ts`,
moved from `apps/server/src/simulator/machine.ts` and `setup.ts` (which import them from there
afterwards). They keep the login `PATH_PREFIX` (Homebrew, `~/.local/bin`). The setup script still
runs inside the tmux session `termhub-wda-setup`, so it survives an agent restart; the runner
still runs inside `termhub-wda-<udid8>`.

`hello.capabilities` gains `'sim'` on macOS. `tools.detect` already emits `wda` when the built
runner app exists, so detection is unchanged.

### 4.4 Version

`apps/agent/package.json` → `0.5.0` (a new channel kind is a minor bump). CI publishes on merge
(`publish-agent.yml`); machines with `agent_auto_update` pick it up within the hour, the rest use
the update button in Máquinas.

## 5. Server (`apps/server`)

### 5.1 `src/simulator/agent-tunnel.ts`

Implements the existing `Tunnel` interface (`wdaPort`, `mjpegPort`, `close()`, `onClose(cb)`):

- Two `net.Server`s on `127.0.0.1` with free ports (`findFreePort` already exists in `tunnel.ts`).
- Each accepted connection opens a `tcp` channel on the machine's agent connection —
  `agents.openTcp(machineId, { port: remotePort }, handlers)`, a new method on `AgentConnection`
  and `AgentRegistry` next to `openPty` / `openClaude` — and pipes: local socket bytes →
  `channel.write`, channel bytes → local socket. Either side closing closes the other.
- The tunnel reports `onClose` when the agent goes offline (`registry` `offline` event) or when a
  channel cannot be opened for a reason other than `refused`. That triggers the session manager's
  existing recovery (up to 3 reopen attempts, 2 s apart).
- `openTunnel(machine, ports)` dispatches: `local` → passthrough, `ssh` → today's ssh tunnel,
  `agent` → the new one.

Everything downstream is untouched: `WdaClient`, `mjpeg-reader`, `session-manager`, `/ws/sim` and
its server→browser backpressure. `WdaClient` sets `keepAlive: true` explicitly on its `http.Agent`
so command calls reuse one channel instead of opening one per request.

### 5.2 Machine operations

Each function in `src/simulator/machine.ts` and `setup.ts` gets an `if (machine.type === 'agent')`
branch at the top calling `agentRpc(machine, …)` with the matching method and reusing the parsers
(`parseSimctlList`, `isBootFailure`, `parseSetupOutput`). A unit test per function asserts that
`runOnMachine` is never called for an agent machine, as the other agent-aware functions do.

### 5.3 Routes

`routes/machines.ts` (`/:id/simulators`, `/:id/simulator/setup` GET and POST), `routes/tabs.ts`
(`simulator_udid`, screenshot) and `routes/projects.ts` (simulator tab creation): the three
`409 Simulador indisponível em máquinas com agente` checks go away, replaced by
`requireSimCapable(machine)`: for an agent machine it must be online and have `'sim'` in
`registry.capabilities`, else `409 AGENT_OUTDATED`. `requireMac` stays.

In `GET /:id/simulator/setup`, when the state becomes `ok` and the machine has no `wda` capability
yet, the refresh for an agent machine is a `tools.detect` RPC followed by `setDetected` (today it
calls `machineStatus`, which for agents only returns the cached row).

### 5.4 Session lifecycle

No data-model change (`Tab.kind`, `Tab.simulator_udid` exist). When the agent reconnects mid-session
(deploy, network), the tunnel closes, the session manager reopens it, and the runner is still alive
in tmux on the Mac — the browser reconnects and sees the image again without a new boot.

Channels: one simulator session takes 2–3 of the machine's 64 channels (MJPEG plus the keep-alive
HTTP connection). No quota is reserved; a `ChannelLimitError` is logged with its reason and the
viewer gets `status: error` "Máquina sem canais livres".

## 6. Web (`apps/web`)

The UX is the existing one; changes are unblocking and messages only.

- `SimulatorSetupCard`: the "Simulador iOS: disponível em breve para agentes" text goes away. For
  an agent machine the same four states (indisponível / não preparado / preparando / pronto) call
  the same routes. Two new conditions first: agent **offline** → "Conecte o agente para preparar o
  simulador", no button; agent **without `sim`** (`409 AGENT_OUTDATED`) → the server's message plus
  the "Atualizar agente" button `AgentUpdateCard` already has.
- `TabBar` / `TerminalsView`: unchanged — the simulator button already shows when a linked machine
  has `wda` in `capabilities`, and agents already report `wda` through `tools.detect`.
- `SimulatorView`: no functional change (presets, device picker, buttons, fps counter stay). Two new
  `status: error` messages from `/ws/sim` are rendered with the existing Reconectar button:
  "Agente desconectado" and "Máquina sem canais livres".
- `MachineForm`: nothing (the card lives inside it). No new route, no new sidebar entry.

## 7. Errors and edge cases

| Situation | Behaviour |
|---|---|
| Agent offline when the tab opens | `/ws/sim` sends `status: error` "Agente desconectado"; Reconectar button |
| Agent without `sim` (old version) | routes answer `409 AGENT_OUTDATED`; machine card shows "Atualizar agente" |
| Runner still starting (port refused) | `open_error refused` on the channel; the session manager already polls WDA `/status` for up to 90 s, so it logs and retries every 1 s |
| Agent reconnects mid-session | `offline` closes the tunnel → existing recovery (3 attempts, 2 s); runner stays alive in tmux, no new boot |
| Server restart | as today: `runnerAlive` rediscovers the runner through tmux and reopens the tunnel |
| Agent WebSocket buffer above 4 MiB | agent pauses reading the MJPEG socket; nothing is dropped in the agent, pressure goes to WDA |
| Chunk larger than the max frame | sliced in `sendStream`; never 1009 |
| 64 channels in use | `status: error` "Máquina sem canais livres" |
| `resize` on a `tcp` channel, port outside the ranges | 1008 / `open_error invalid`; metadata logged |

Logs on both sides: machine id, channel, remote port, bytes per direction, close codes. Never
frames, never typed text.

## 8. Testing

- `agent-protocol`: `open tcp` schema (port inside/outside the ranges, extra fields rejected), the
  new `refused` error code and `reset` close reason, params/results of every `sim.*` / `wda.*` method.
- Agent: `tcp.test.ts` with a real `net.Server` on an ephemeral port and a fake socket — `opened`,
  piping both ways, `open_error refused`, `closed` sent once, pause/resume with a simulated
  `bufferedAmount`, large-chunk slicing. RPC handlers with `execFile` mocked (exact argv; invalid
  `udid` / port rejected).
- Server: `agent-tunnel.test.ts` with a fake `AgentConnection` (in-memory channel) — an accepted
  connection opens a channel, piping, cross-close, `onClose` on `offline`. One test per function in
  `machine.ts` / `setup.ts` proving an agent machine never reaches `runOnMachine`. Routes:
  `409 AGENT_OUTDATED` without the capability, `200` with it.
- End-to-end (same mould as `apps/server/src/agent/e2e.test.ts`, runs in CI): in-process agent plus
  a stub `net.Server` on port 8100 answering a fixed HTTP response; the server opens the tunnel and
  reads the response through the channel. No WDA or Xcode in CI.
- Manual on the Mac mini (not a gate): update the agent, prepare WDA from the card, create a
  simulator tab, pick the device, see the image, tap, drag, type, Home, switch LAN/Remoto and watch
  the bandwidth drop, restart the agent with the tab open and see the reconnection without a new
  boot.

## 9. Delivery and future upgrade

- Order: protocol → agent (bump `0.5.0`; merge publishes through CI) → server and web (same PR or
  the next). The server can ship before agents are updated: without `sim` it answers
  `AGENT_OUTDATED`, it never breaks.
- No migration.
- **Approach C, the documented upgrade**: if latency accumulates on slow links, replace only the
  MJPEG transport with a `kind: 'mjpeg'` channel in which the agent parses the multipart stream
  and forwards only the newest frame (drop at the source), keeping `tcp` for the command HTTP.
  `WdaClient`, `session-manager` and `/ws/sim` stay as they are. Approach B (the agent owning the
  whole WDA client and the server becoming a relay) was rejected: it moves ~500 lines of WDA/MJPEG
  logic into the agent or duplicates them against the ssh path, and every WDA tweak becomes an
  agent release.

## 10. Files

- `packages/agent-protocol/src/{messages,rpc,messages.test,rpc.test}.ts`
- `packages/machine-ops/src/simulator.ts` (+ test): `SIMCTL_LIST`, `SIMCTL_BOOT`, runner
  start/alive/tail, setup start/state scripts, `WDA_DIR`, `UDID_RE`, port ranges.
- `apps/agent/src/{tcp,tcp.test,dispatch,run,client}.ts`, `apps/agent/src/rpc/{sim,wda,index}.ts`
  (+ tests), `apps/agent/package.json`.
- `apps/server/src/agent/{connection,registry,errors}.ts` (`openTcp`, `requireSimCapable`),
  `apps/server/src/simulator/{agent-tunnel,agent-tunnel.test,tunnel,machine,setup,wda-client,ws}.ts`,
  `apps/server/src/routes/{machines,tabs,projects}.ts`, `apps/server/src/agent/e2e.test.ts`.
- `apps/web/src/components/{SimulatorSetupCard,SimulatorView}.tsx`.
- `README.md`: a short paragraph on the iOS simulator tab over the agent (the README has no
  simulator section today): WDA, the `tcp` channel, the `sim` capability and `AGENT_OUTDATED`.
