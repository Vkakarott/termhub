import { WebSocketServer, WebSocket } from 'ws';
import type { FastifyBaseLogger } from 'fastify';
import type { createUpgradeRouter } from '../ws/router.js';
import { chatBus } from './bus.js';

/** `/ws/chat`: pushes the concierge's deltas and action trail to the browser, for the signed-in
 * user only. No history and no terminal content — the client reads the conversation over REST. */
export function registerChatWs(router: ReturnType<typeof createUpgradeRouter>, deps: { log: FastifyBaseLogger }): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  const log = deps.log.child({ mod: 'chat-ws' });

  router.add(/^\/ws\/chat\/?$/, async ({ req, socket, head, scope }) => {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
      const w = ws as WebSocket & { isAlive?: boolean };
      w.isAlive = true;
      ws.on('pong', () => (w.isAlive = true));

      const unsubscribe = chatBus.subscribe((event) => {
        if (event.user_id !== scope.user.id) return;
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(event));
      });
      log.info({ userId: scope.user.id }, 'chat conectado');
      ws.on('close', () => {
        unsubscribe();
        log.info({ userId: scope.user.id }, 'chat desconectado');
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
