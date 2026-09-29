---
symptom: "agent connect failed {\"error\":\"WebSocket was closed before the connection was established\"}"
tags: [agent, websocket, reconnect, network]
evidence: fixed
card: TER-408
pr: https://github.com/engenhariainversa/termhub/pull/211
agent: claude
date: 2026-09-29
---
## Cause

The machine shows offline, `agent.log` has no new line for hours, and the agent process is alive with a
socket still `ESTABLISHED`. The line above only appears when the stuck process is killed.

The agent was in the middle of a reconnect when the network changed (sleep, then another Wi-Fi). TCP and
TLS were up and the HTTP upgrade request was sent, and no response ever came back. The `ws` library sets
no limit on the opening handshake, and the agent's liveness ping only starts on `open`. So none of
`open`, `error`, `close` or `unexpected-response` fired, `connectOnce()` never settled, and the backoff
loop of `runForever()` stayed on that `await`.

## Fix

`connectOnce()` passes `handshakeTimeout` to the `WebSocket` constructor (`handshakeTimeoutMs`, 15 s by
default, in `apps/agent/src/client.ts`). `ws` then aborts with `Opening handshake has timed out`, the
promise rejects, and `runForever()` backs off and tries again. It is an idle timeout of the request, so
a slow link that still moves bytes does not trip it, and it is cleared once the socket is open.

On a machine with an agent older than 0.10.1, restarting the agent brings it back:
`launchctl kickstart -k gui/$(id -u)/dev.termhub.agent` on macOS.

## How to check

`agent.log` shows `agent connect failed {"error":"Opening handshake has timed out"}` followed by
`reconnecting`, instead of going silent. In the package: `npm pack @termhub/agent@0.10.1` and look for
`handshakeTimeout` inside `dist`.
