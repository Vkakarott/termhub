import type { Server as HttpServer, IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { config } from '../config.js';
import { parseCookies, resolveUser, type AuthContext } from '../auth/index.js';
import { canAccess } from '../auth/permissions.js';
import type { User } from '../db/repositories/types.js';

export interface UpgradeContext {
  req: IncomingMessage;
  socket: Duplex;
  head: Buffer;
  url: URL;
  params: string[];
  user: User;
}
export type UpgradeHandler = (ctx: UpgradeContext) => void | Promise<void>;

export function rejectUpgrade(socket: Duplex, status: number, text: string) {
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

/** Anti CSWSH: a origem do navegador precisa bater com o host servido ou o PUBLIC_URL. */
function originAllowed(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true; // clientes não-navegador (curl, wscat) — já protegidos pela auth
  let o: URL;
  try {
    o = new URL(origin);
  } catch {
    return false;
  }
  const host = req.headers.host;
  if (host && o.host === host) return true;
  try {
    if (o.host === new URL(config.publicUrl).host) return true;
  } catch {
    /* ignore */
  }
  if (!config.isProd && (o.hostname === 'localhost' || o.hostname === '127.0.0.1')) return true;
  return false;
}

/** Um único listener de `upgrade`: casa o path, checa origem e auth, e delega ao handler. */
export function createUpgradeRouter(server: HttpServer, deps: { auth: AuthContext }) {
  const routes: { pattern: RegExp; handler: UpgradeHandler }[] = [];
  server.on('upgrade', async (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const route = routes.map((r) => ({ r, m: url.pathname.match(r.pattern) })).find((x) => x.m);
    if (!route?.m) return rejectUpgrade(socket, 404, 'Not Found');
    if (!originAllowed(req)) return rejectUpgrade(socket, 403, 'Forbidden');
    let user: User | null = null;
    try {
      user = await resolveUser(deps.auth, { headers: req.headers, cookies: parseCookies(req.headers.cookie) });
    } catch {
      user = null;
    }
    if (!user) return rejectUpgrade(socket, 401, 'Unauthorized');
    // every WebSocket is a terminal or simulator stream: needs terminals:read
    if (!(await canAccess(deps.auth.repos, user, 'terminals', 'read'))) return rejectUpgrade(socket, 403, 'Forbidden');
    try {
      await route.r.handler({ req, socket, head, url, params: route.m.slice(1), user });
    } catch {
      rejectUpgrade(socket, 500, 'Internal Server Error');
    }
  });
  return {
    add(pattern: RegExp, handler: UpgradeHandler) {
      routes.push({ pattern, handler });
    },
  };
}
