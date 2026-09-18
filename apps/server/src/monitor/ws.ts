import { WebSocketServer, WebSocket } from 'ws';
import type { FastifyBaseLogger } from 'fastify';
import type { createUpgradeRouter } from '../ws/router.js';
import { monitorBus } from './bus.js';

/**
 * `/ws/monitor`: pushes tab state changes to the browser (home list, tab bar dots). One
 * message per change, filtered by the caller's scope; the client fetches the snapshot over REST.
 * Only metadata and the tool's own message travel here — never terminal content.
 */
export function registerMonitorWs(router: ReturnType<typeof createUpgradeRouter>, deps: { log: FastifyBaseLogger }): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
  const log = deps.log.child({ mod: 'monitor-ws' });

  router.add(/^\/ws\/monitor\/?$/, async ({ req, socket, head, scope }) => {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
      const w = ws as WebSocket & { isAlive?: boolean };
      w.isAlive = true;
      ws.on('pong', () => (w.isAlive = true));

      const unsubscribe = monitorBus.subscribe((change) => {
        if (scope.ownerId !== null && change.owner_id !== scope.ownerId) return;
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'tab', tab: change.tab, project_id: change.project_id, machine_id: change.machine_id }));
      });
      log.info({ userId: scope.user.id }, 'monitor conectado');
      ws.on('close', () => {
        unsubscribe();
        log.info({ userId: scope.user.id }, 'monitor desconectado');
      });
      ws.on('error', () => unsubscribe());
    });
  });

  const interval = setInterval(() => {
    for (const ws of wss.clients) {
      const w = ws as WebSocket & { isAlive?: boolean };
      if (w.isAlive === false) {
        w.terminate();
        continue;
      }
      w.isAlive = false;
      w.ping();
    }
  }, 30_000);
  wss.on('close', () => clearInterval(interval));
  return wss;
}
