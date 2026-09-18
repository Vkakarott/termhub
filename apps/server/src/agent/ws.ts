import { WebSocketServer } from 'ws';
import type { FastifyBaseLogger } from 'fastify';
import { CLOSE, MAX_PASTE_FRAME, PROTOCOL_VERSION } from '@termhub/agent-protocol';
import type { Repositories } from '../db/repositories/index.js';
import { rejectUpgrade, type createUpgradeRouter } from '../ws/router.js';
import { AGENT_TOKEN_RE, hashAgentToken } from './token.js';
import { AgentConnection } from './connection.js';
import { agents, type AgentRegistry } from './registry.js';

const HEARTBEAT_INTERVAL_MS = 20_000;
const TOUCH_INTERVAL_MS = 60_000;

interface Deps {
  repos: Repositories;
  log: FastifyBaseLogger;
  registry?: AgentRegistry;
  helloTimeoutMs?: number;
}

/** Upgrades `/agent/ws`: agents authenticate with `Authorization: Bearer thb_ag_…`, not a cookie. */
export function registerAgentWs(router: ReturnType<typeof createUpgradeRouter>, deps: Deps): WebSocketServer {
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
      conn.waitHello(deps.helloTimeoutMs).then(
        async (hello) => {
          if (hello.protocol > PROTOCOL_VERSION) return conn.close(CLOSE.CONFLICT, 'protocol');
          registry.attach(machine.id, conn);

          const touch = (extra: { version?: string; os?: string; capabilities?: string[] } = {}) =>
            deps.repos.machines
              .touchAgent(machine.id, { lastSeenAt: new Date(), ...extra })
              .catch((err) => log.warn({ err, machineId: machine.id }, 'touchAgent failed'));

          await touch({ version: hello.agent_version, os: hello.os, capabilities: hello.tools });
          const seen = setInterval(() => void touch(), TOUCH_INTERVAL_MS);
          seen.unref();
          const beat = setInterval(() => conn.heartbeat(), HEARTBEAT_INTERVAL_MS);
          beat.unref();
          conn.on('close', () => {
            clearInterval(seen);
            clearInterval(beat);
          });

          log.info({ machineId: machine.id, agentVersion: hello.agent_version, os: hello.os }, 'agent connected');
        },
        () => {
          // AgentConnection.waitHello() already closed the socket (1008) on timeout/violation.
          log.info({ machineId: machine.id }, 'agent disconnected before hello');
        },
      );
    });
  });

  return wss;
}
