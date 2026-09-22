import { WebSocketServer, WebSocket } from 'ws';
import type { FastifyBaseLogger } from 'fastify';
import type { createUpgradeRouter } from '../ws/router.js';
import type { Repositories } from '../db/repositories/index.js';
import { rejectUpgrade } from '../ws/router.js';
import { monitorBus } from '../monitor/bus.js';
import { publicBus } from './bus.js';
import { publicId, toPublicRobot } from './city.js';
import { normalizeNickname } from './nickname.js';

/**
 * `/ws/public/<nickname>`: the live city for a visitor with no account. It is not `/ws/monitor` with
 * a filter — a different channel, a different payload, and a set of published project ids resolved
 * at connect and kept current by `publicBus`, so unpublishing drops the socket instead of leaving
 * somebody watching a room that is no longer public.
 */
export function registerPublicWs(router: ReturnType<typeof createUpgradeRouter>, deps: { repos: Repositories; log: FastifyBaseLogger }): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 });
  const log = deps.log.child({ mod: 'public-ws' });

  router.addPublic(/^\/ws\/public\/([^/]+)\/?$/, async ({ req, socket, head, params }) => {
    const parsed = normalizeNickname(decodeURIComponent(params[0] ?? ''));
    if (!parsed.ok) return rejectUpgrade(socket, 404, 'Not Found');
    const owner = await deps.repos.users.findByNickname(parsed.value);
    if (!owner) return rejectUpgrade(socket, 404, 'Not Found');
    const published = new Set((await deps.repos.projects.list({ owner: owner.id })).filter((p) => p.is_public && p.status !== 'archived').map((p) => p.id));
    if (published.size === 0) return rejectUpgrade(socket, 404, 'Not Found');

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
      const offTab = monitorBus.subscribe((change) => {
        if (change.owner_id !== owner.id || !published.has(change.project_id)) return;
        if (ws.readyState !== WebSocket.OPEN) return;
        ws.send(JSON.stringify({ type: 'robot', building: publicId('machine', change.machine_id), room: publicId('project', change.project_id), robot: toPublicRobot(change.tab, { alive: true, progress: null }) }));
      });
      const offPublic = publicBus.subscribe((change) => {
        if (!published.has(change.project_id) || change.is_public) return;
        published.delete(change.project_id);
        ws.close(1000, 'unpublished');
      });
      ws.on('close', () => { offTab(); offPublic(); });
    });
  });

  return wss;
}
