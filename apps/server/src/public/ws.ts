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
    // A malformed escape (`%`) makes decodeURIComponent throw; every rejected nickname answers
    // the same 404, not a 500 that would tell a stranger their input broke something.
    let raw: string;
    try {
      raw = decodeURIComponent(params[0] ?? '');
    } catch {
      return rejectUpgrade(socket, 404, 'Not Found');
    }
    const parsed = normalizeNickname(raw);
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
        // A change proves the tab's tmux session existed once, not that it still does (a plain
        // "seen" click on the tab publishes here too) — matches readPublicCity's cold-memo rule
        // (public/read.ts) so a visitor never sees the two public surfaces disagree.
        const alive = change.tab.kind === 'terminal' && change.tab.state !== null;
        ws.send(JSON.stringify({ type: 'robot', building: publicId('machine', change.machine_id), room: publicId('project', change.project_id), robot: toPublicRobot(change.tab, { alive, progress: null }) }));
      });
      const offPublic = publicBus.subscribe((change) => {
        if (!published.has(change.project_id) || change.is_public) return;
        published.delete(change.project_id);
        ws.close(1000, 'unpublished');
      });
      const teardown = () => { offTab(); offPublic(); };
      log.info({ nickname: parsed.value, rooms: published.size }, 'public visitor connected');
      ws.on('close', () => {
        teardown();
        log.info({ nickname: parsed.value, rooms: published.size }, 'public visitor disconnected');
      });
      // A server-side ws socket with no error listener throws on a protocol violation (e.g. a
      // frame over maxPayload) — uncaught, that takes the whole process down. This route is
      // unauthenticated on a vhost with no Cloudflare Access, so it gets no benefit of the doubt.
      ws.on('error', (err) => {
        teardown();
        log.warn({ nickname: parsed.value, err: err.message }, 'public visitor socket error');
      });
    });
  });

  return wss;
}
