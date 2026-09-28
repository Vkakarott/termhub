# Zero-downtime deploys for terminals — design

Card: **TER-320** (subtasks TER-321 to TER-324). The existing blue/green deploy (`deploy/blue-green.sh`)
already keeps HTTP answering during a deploy. Open terminals still drop, and new ones fail for a while.
This spec explains why, then keeps the single-active-colour model and fixes the handover.

## 1. What happens today (measured on the 2026-09-28 01:04 UTC deploy of #190)

| t (s) | Event (from the two colours' logs) |
|---|---|
| 0 | green is listening. It becomes healthy, nginx switches to it. |
| 0–35 | Every agent is still connected to **blue**. On green, every machine is offline, so a terminal opened now fails ("Agente desconectado") and MCP/REST/chat calls answer `AGENT_OFFLINE`. |
| 35 | `retire_old` has slept its 30 s grace and runs `compose stop app-blue`. SIGTERM. |
| 35–45 | `fastify.close()` waits for the upgraded sockets, which nothing closes. Terminals keep working through blue. |
| 45 | Docker SIGKILLs blue (`Exited (137)`): every socket dies at once, `onClose` never runs. |
| 45.8–47.1 | The browsers reconnect first. Green has no agent yet, so each terminal gets `{type:'error', 'Agente desconectado'}` + close 1011. |
| 46.9–48.5 | The agents reconnect (their backoff: 1.6–2.4 s after a healthy session). |
| 47.2–49.4 | The browsers' next attempt succeeds. |

So the user sees two things: a terminal error on every open tab for about 2 s after the kill, and any tab opened
(or reloaded) in the 35–45 s before it fails outright. A third problem shows up whenever the agent socket
closes *before* the browser socket (agent auto-update, a Wi-Fi hop, a graceful server close): the server
turns the lost channel into `{type:'exit'}` + 1000, and the web client treats that as "Sessão encerrada"
and stops reconnecting until someone clicks "Reconectar".

The tmux sessions themselves are never lost: the agent's PTY is only a tmux client (`tmux new-session -A`),
so every reconnect re-attaches and tmux redraws the screen.

## 2. Goal and success criteria

- During a deploy, an open terminal shows at most "Reconectando…" for a few seconds and comes back on its own,
  with no error text and the same tmux session.
- A terminal opened during a deploy connects, even if its machine's agent is still moving between colours.
- New traffic reaches the new colour only after it is ready (database reachable), and the old colour hands its
  sockets over instead of being killed.
- The first deploy after this change still runs with the old code on the retiring colour, so it behaves like
  today. The deploy after that one is the proof (§8).

## 3. Approaches considered

1. **Recommended — keep one active colour, make the handover explicit.** The retiring colour drains on SIGTERM
   (agents first, then every other socket with a "restart" close code), the new colour waits a few seconds
   for an agent that was connected moments ago instead of failing, and the clients reconnect at once on that
   close code. No new infrastructure.
2. **Several active replicas behind an nginx `upstream`, shared state in Redis.** Each agent connects to one
   replica, so a terminal opened on another replica needs a relay between instances (pub/sub plus channel
   forwarding). All the in-memory buses (§4) would have to move too. It is a large change for a single-host
   deployment whose only real problem is the handover, and it adds Redis to the production path.
3. **More Cloudflare Tunnel connectors / Cloudflare Load Balancing.** The tunnel and the proxy are not where the
   gap is: an nginx reload keeps existing connections on the old workers, and the tunnel never drops. The gap
   is which colour holds the agent sockets.

Decision: approach 1.

## 4. TER-321 — in-memory state that stops two instances overlapping

Both colours run at the same time while the new one starts and until the old one exits. Findings, from a full
pass over `apps/server`:

| State | What goes wrong during the overlap | Decision |
|---|---|---|
| Agent registry (`agent/registry.ts`, a per-process `Map`) | The colour without the agent sees the machine offline: terminals, MCP, REST, chat host. | **Fixed here**: drain moves agents promptly (§5.2) and the new colour waits for a recently seen agent (§5.3). |
| Event buses (chat, monitor, public, mobile revocation) | Events reach only the browsers on the colour that produced them. | Accepted. The drain closes the old colour's sockets with 1012, and those clients reconnect to the new colour, which reloads over REST (chat, monitor, mobile already do). |
| Schedulers (ticket sync, CI poll, decision/memory sweepers, hourly purge, auto-update) | Duplicate provider calls during the overlap. | Accepted: writes are upserts, conditional or `ON CONFLICT`. Nothing changes in how they coordinate. |
| Auto-answer sweeper | Already claimed with a conditional update. | Unchanged. |
| Concierge live runs (TER-301) | Already handled: `suspendAll()` releases the rows on a graceful close, and the sweep on the colour that holds the agent resumes them. | Improved: the close is now actually graceful (§5.2), and a sweep runs as soon as an agent comes online (§5.4) instead of up to 30 s later. |
| Permission cache (30 s), rate limiters, small caches | Divergent for up to 30 s. | Accepted. |
| Attachment extraction queue | The new colour re-queues pending rows at boot while the old may still extract them. | Accepted (double work at worst; attempts are capped). |

Conclusion: no Redis, no shared registry. The only state that makes terminals fail is where the agent socket
lives, and the handover below deals with it.

## 5. Design

### 5.1 Readiness (TER-322)

- New `GET /api/ready` (public, like `/api/health`): `200 {ok:true}` when a `SELECT 1` answers within 2 s and the
  process is not draining; `503 {ok:false, reason}` otherwise (`database` or `draining`).
- The compose healthcheck uses `/api/ready`, so `blue-green.sh`'s wait for `healthy` now means "database
  reachable" too. `/api/health` stays as it is (liveness, used by nothing that must change).

### 5.2 Graceful drain on SIGTERM (TER-323)

`index.ts` calls a new `drain()` from `buildApp()` before `fastify.close()`:

1. Mark the process as draining: `/api/ready` → 503, and the upgrade router refuses new WebSockets with 503.
2. `chat.suspendAll()` (it already runs in `preClose`; it moves to the start of the drain so the rows are released
   before the agents leave; `preClose` keeps calling it, and a second call finds nothing to suspend).
3. Close every agent connection with **1012** (`service restart`, a server-side `RESTART_CLOSE` constant; `@termhub/agent-protocol` is untouched).
   The agent reconnects with its normal backoff (≈2 s), through nginx, to the new colour. No agent release is
   needed: every close code other than 4401/4409-protocol already reconnects.
4. Close every other WebSocket (terminal, chat, monitor, public, simulator, mobile) with 1012.
5. `fastify.close()` then finishes, because no upgraded socket is left, and `onClose` runs (timers stop, Prisma
   closes). No more SIGKILL.

The compose file gets `stop_grace_period: 30s` for the app so a slow `suspendAll` is not cut short. The drain
itself has an overall timeout of 15 s; past it, it proceeds to `fastify.close()` anyway.

### 5.3 Waiting for an agent that is moving (TER-323)

`AgentRegistry.waitOnline(machineId, timeoutMs)` resolves `true` as soon as the machine is attached (at once if
it already is), `false` on timeout. It listens to the registry's own `online` event.

A machine counts as **moving** when its agent is offline here but `agent_last_seen_at` is less than 150 s old (the
server touches it every 60 s while connected). Only then do we wait, up to **15 s**. A machine that has really been
offline for a while fails at once, as today.

Where the wait applies — the places that open something on a machine right now:

- the terminal WebSocket, before `createPtySession()` (the browser keeps showing "Conectando…/Reconectando…");
- the terminal control used by the MCP and the chat (`control/terminals.ts` `assertReady`, `control/screen.ts`
  `readScreen`) and the generic `agentRpc` helper (`agent/errors.ts`), which the REST routes use;
- the chat host resolution (`chat/host.ts`), so a message sent in those seconds is not answered "máquina offline".

A small helper, `AgentRegistry.awaitAgent(machine)`, holds the rule so each place calls one function. The agent
WebSocket also touches `agent_last_seen_at` when the agent disconnects, so the timestamp says when it left.

### 5.4 A lost agent is not the end of the session (TER-324, server side)

When the agent connection closes, its open PTY channels get `onExit(null)`. Today `AgentPtySession` turns that into
exit code 1, and the terminal WebSocket sends `{type:'exit'}`. From now on:

- `PtySessionHandlers` gets an optional `onLost()`; `AgentPtySession` calls it for `onExit(null)` and keeps
  `onExit(code)` for a real process exit.
- The terminal WebSocket answers `onLost` by closing the browser socket with **1012** `agent reconnecting`,
  without an `exit` frame.

The chat service also runs `resumeSweep()` (debounced, once per second at most) when the registry emits `online`,
so a released live run resumes as soon as its host is back instead of on the next 30 s tick.

### 5.5 Clients (TER-324)

- **Web terminal** (`apps/web/src/lib/terminal-connection.ts`): a close with 1012 reconnects after 250–750 ms and does
  not count as a failed attempt (the attempt counter and backoff reset). The label stays "Reconectando…". Any other
  close keeps today's behaviour. The `error` frame sent while the server still cannot reach the agent after the
  15 s wait keeps today's handling.
- **Web chat and monitor sockets** (fixed 5 s reconnect today): 1012 reconnects after 250–750 ms.
- **Mobile app**: nothing to change. It reconnects everything but 4400/4401 with a 1 s first delay and reloads over
  REST.
- **Agent**: nothing to change (§5.2).

### 5.6 Deploy script (TER-323)

`retire_old` today sleeps 30 s and then stops the old colour, which is SIGKILLed 10 s later. It becomes:

1. After the nginx reload, wait `DRAIN_DELAY` (default 3 s) so in-flight HTTP requests on the old nginx workers finish
   against the old colour.
2. `compose stop -t 30 app-<old>`: SIGTERM → the drain in §5.2. The agents move to the new colour, then the browsers
   follow, and the new colour waits for the agents it has not seen yet (§5.3).
3. Log how long the stop took and the old container's exit code (0 expected; 137 means the drain did not finish).

The rollback path already stops the colour it leaves with the same command, so it drains too. Nothing changes in the
shared proxy (`/mnt/hd2tb/proxy`): same vhost template, same `nginx -t` + reload with backup and restore, no
edit to `nginx.conf` or the tunnel.

`deploy.yml` gets a `workflow_dispatch` trigger (deploy job allowed on `main` for it), so a deploy can be re-run
without an empty commit. That is how §8 checks the second deploy.

## 6. Errors and edge cases

| Case | Behaviour |
|---|---|
| First deploy with this change | The retiring colour runs the old code: no drain, SIGKILL after 30 s (the new `-t 30`) instead of 10 s. Terminals behave as today. The new colour's wait (§5.3) already helps the browsers that reconnect before the agents. |
| An agent that never comes back (machine asleep) | Last seen > 150 s ago: fails at once. Seen recently: the terminal waits 15 s, then gets today's "Agente desconectado" error. |
| Drain takes longer than 15 s | It stops waiting and calls `fastify.close()`; Docker kills the container at 30 s. The next deploy's log shows exit 137. |
| New colour unhealthy | Unchanged: it is stopped, nginx never switches, the old colour keeps serving. |
| Readiness flaps on a slow database | The container is marked unhealthy only after 5 failed checks (compose retries), as today. |
| A browser reconnects to the old colour after the drain started | Not possible through nginx after the reload (new connections use the new workers). If it happens (a stale keep-alive), the old colour's upgrade answers 503 while draining and the client retries. |
| Rollback | `bash deploy/blue-green.sh --rollback` starts the stopped colour, waits for ready, switches nginx and drains the one it leaves. |

## 7. Testing

- Server unit/integration (vitest): `waitOnline` (already online, comes online, timeout); `awaitAgent` rule (recent vs
  stale `agent_last_seen_at`); `/api/ready` (ok, database down, draining); the terminal WebSocket closes 1012 without an
  `exit` frame when the agent connection drops; the terminal WebSocket waits for a moving agent and then gets `ready`;
  `drain()` closes an agent socket and a terminal socket with 1012 and `fastify.close()` resolves promptly with them open.
- Web (vitest): the terminal connection reconnects quickly on 1012 without spending an attempt; chat/monitor reconnect
  quickly on 1012.
- Script: `DRY_RUN=1 bash deploy/blue-green.sh` shows the new sequence (no 30 s sleep, `stop -t 30`).

## 8. Production verification

1. Merge; watch "CI e Deploy". This first deploy still retires a colour with the old code (§6).
2. Check `docker ps --filter name=termhub-app` and the two health checks (`app.termhub.dev` 200 through the local proxy,
   `termhub.dev` 200).
3. Open a probe terminal on a machine (MCP `open_tab`) running a counter in tmux; keep a script polling it through the
   MCP (`read_screen`) once a second.
4. Run the second deploy with `gh workflow run "CI e Deploy" --ref main`. Expected: the old colour exits 0 (not 137); the
   new colour logs no "agente desconectado" for tabs whose agent was connected; the probe never fails for more than a few
   seconds and the counter never resets (same tmux session).
5. If anything breaks in production: `bash deploy/blue-green.sh --rollback`, stop, and record it on the card.

## 9. Out of scope

- Multiple active replicas and a shared registry (approach 2).
- Keeping headless Claude processes alive across an agent reconnect (rejected in the TER-301 spec §8; resume covers it).
- Faster agent reconnect on 1012 (would need an agent release; the server-side wait makes it unnecessary).
- The literal `__APP_HOST__` in the `/city/` and `/ws/public/` locations of the vhost template: rendered per switch and
  re-resolved on every reload, so it does not pin a stale address in this flow.
