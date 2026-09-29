---
symptom: "A máquina <nome> está offline — machines and the chat host read as offline right after a deploy"
tags: [deploy, blue-green, agent, websocket, chat]
evidence: fixed
agent: claude
date: 2026-09-29
---
## Cause

In a blue/green deploy the agents are the last thing to move. nginx switches to the new colour, the
script waits `DRAIN_DELAY` (3 s), the old colour gets SIGTERM and closes its agents with 1012, and each
agent reconnects with its ≈2 s backoff. Measured on the 2026-09-29 06:27 UTC deploy: nginx reloaded at
06:27:00.3, the agents attached to the new colour between 06:27:05.5 and 06:27:06.1. For those ≈6 s the
colour that answers every request holds no agent.

The wait for a moving agent (`AgentRegistry.awaitAgent`, spec 2026-09-27 §5.3) covered the *actions*
(terminal socket, `agentRpc`, a chat message about to be sent). The *reads* answered from
`agents.isOnline()` / `agents.capabilities()` at once: `GET /api/machines/:id/status`, the chat host in
`GET /api/chat`, the MCP inventory, the office probe. A browser socket reconnects in 250–750 ms after a
1012, so it re-reads the chat before the agents arrive, gets `host.kind = 'offline'`, and keeps that
banner until the next read. The office probe memoised "unreachable" for a minute.

## Fix

`AgentRegistry.awaitHandover(machine)`: the same wait, only for an agent this process has never held
(the registry remembers every machine it attached). A colour that just started waits for the agents
seen moments ago; an agent that was here and left is answered at once, so a read never stalls on a
laptop that went to sleep — the reason reads stopped waiting in the first place. The read paths call it
before looking at the registry: `machineStatus`, `probeTmuxSessions`, `listMachines`/`listTabs` and
`ChatService.hostFor` (`resolveHost` with `wait: 'handover'`).

Three actions had been left checking `agents.isOnline()` as well and now go through `awaitAgent` like
every other action: `readMachineSecret`, `swapAccount` and `sendTabSuggestion`. A new action on a
machine asks `awaitAgent`, a new read for a screen asks `awaitHandover`; neither reads `isOnline`
to decide that a machine is offline.

## How to check

After a deploy, in the new colour's log (`docker logs termhub-app-<color>`): the first
`GET /api/machines/<id>/status` and `GET /api/chat` requests complete right after the matching
`agent connected` line (a `responseTime` of a second or two instead of a few milliseconds), and the
screens show the machines online and no "está offline" banner in the chat.
