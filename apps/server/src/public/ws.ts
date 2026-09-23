import { WebSocketServer, WebSocket } from 'ws';
import type { FastifyBaseLogger } from 'fastify';
import type { createUpgradeRouter } from '../ws/router.js';
import type { Repositories } from '../db/repositories/index.js';
import { rejectUpgrade, type PublicUpgradeContext } from '../ws/router.js';
import { monitorBus } from '../monitor/bus.js';
import { publicBus } from './bus.js';
import { toPublicRobot, toPublicRobotGone } from './city.js';
import { publicId } from './public-id.js';
import { normalizeNickname } from './nickname.js';
import { publicAlive } from './read.js';
import { cachedTmuxProbe } from '../terminal/machine-exec.js';

/**
 * `/ws/public/<nickname>`: the live city for a visitor with no account. It is not `/ws/monitor` with
 * a filter — a different channel, a different payload, and a set of published project ids resolved
 * at connect and kept current by `publicBus`, so unpublishing drops the socket instead of leaving
 * somebody watching a room that is no longer public.
 */
/** Every public socket this process holds at once, across all cities: past it, new visitors get a 503. */
export const PUBLIC_WS_MAX_SOCKETS = 1_000;
/** How often each public socket is pinged; one that has not answered the previous ping is dropped. */
export const PUBLIC_WS_HEARTBEAT_MS = 30_000;

export function registerPublicWs(
  router: ReturnType<typeof createUpgradeRouter>,
  deps: { repos: Repositories; log: FastifyBaseLogger; limits?: { maxSockets?: number; heartbeatMs?: number } },
): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 });
  const log = deps.log.child({ mod: 'public-ws' });
  const maxSockets = deps.limits?.maxSockets ?? PUBLIC_WS_MAX_SOCKETS;

  // These sockets are anonymous, skip the Origin check (any page can open them from its visitors'
  // browsers) and sit behind a one-hour proxy read timeout: nginx's per-IP cap is the only other
  // bound. So the process keeps its own: a ceiling on how many it holds (counting upgrades still
  // resolving their nickname), and a ping per interval that drops a half-open socket which never
  // answered the last one, instead of letting it hold its bus listeners until the proxy gives up.
  let slots = 0;
  const answered = new WeakMap<WebSocket, boolean>();
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (answered.get(ws) === false) {
        ws.terminate();
        continue;
      }
      answered.set(ws, false);
      ws.ping();
    }
  }, deps.limits?.heartbeatMs ?? PUBLIC_WS_HEARTBEAT_MS);
  heartbeat.unref();
  wss.on('close', () => clearInterval(heartbeat));

  router.addPublic(/^\/ws\/public\/([^/]+)\/?$/, async (ctx) => {
    if (slots >= maxSockets) {
      log.warn({ slots }, 'public visitor refused: socket ceiling reached');
      return rejectUpgrade(ctx.socket, 503, 'Service Unavailable');
    }
    slots++;
    let held = true;
    const release = () => {
      if (!held) return;
      held = false;
      slots--;
    };
    try {
      await admit(ctx, release);
    } catch (err) {
      release();
      throw err;
    }
  });

  async function admit({ req, socket, head, params }: PublicUpgradeContext, release: () => void): Promise<void> {
    const reject = (status: number, text: string) => {
      release();
      rejectUpgrade(socket, status, text);
    };
    // A malformed escape (`%`) makes decodeURIComponent throw; every rejected nickname answers
    // the same 404, not a 500 that would tell a stranger their input broke something.
    let raw: string;
    try {
      raw = decodeURIComponent(params[0] ?? '');
    } catch {
      return reject(404, 'Not Found');
    }
    const parsed = normalizeNickname(raw);
    if (!parsed.ok) return reject(404, 'Not Found');
    const owner = await deps.repos.users.findByNickname(parsed.value);
    if (!owner) return reject(404, 'Not Found');
    const published = new Set((await deps.repos.projects.list({ owner: owner.id })).filter((p) => p.is_public && p.status !== 'archived').map((p) => p.id));
    if (published.size === 0) return reject(404, 'Not Found');

    // The slot goes back with the socket, however it ends — including a handshake `ws` aborts
    // without ever calling back (the visitor left mid-upgrade).
    socket.once('close', release);
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
      answered.set(ws, true);
      ws.on('pong', () => answered.set(ws, true));
      const offTab = monitorBus.subscribe((change) => {
        if (change.owner_id !== owner.id || !published.has(change.project_id)) return;
        if (ws.readyState !== WebSocket.OPEN) return;
        // A change proves the tab's tmux session existed once, not that it still does (a plain
        // "seen" click on the tab publishes here too): the same rule as the snapshot, reading the
        // same memo (never probing), so a visitor never sees the two public surfaces disagree.
        const probe = change.tab.kind === 'terminal' ? cachedTmuxProbe(change.machine_id) : undefined;
        const alive = publicAlive(change.tab, probe);
        ws.send(JSON.stringify({ type: 'robot', building: publicId('machine', change.machine_id), room: publicId('project', change.project_id), robot: toPublicRobot(change.tab, { alive, progress: null }) }));
      });
      const offPublic = publicBus.subscribe((change) => {
        if (!published.has(change.project_id) || change.is_public) return;
        published.delete(change.project_id);
        ws.close(1000, 'unpublished');
      });
      const offGone = publicBus.subscribeTabRemoved((removed) => {
        if (!published.has(removed.project_id) || ws.readyState !== WebSocket.OPEN) return;
        ws.send(JSON.stringify(toPublicRobotGone({ machineId: removed.machine_id, projectId: removed.project_id, tabId: removed.tab_id })));
      });
      const teardown = () => {
        offTab();
        offPublic();
        offGone();
        release();
      };
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
  }

  return wss;
}
