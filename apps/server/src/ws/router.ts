import type { Server as HttpServer, IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { config } from '../config.js';
import { parseCookies, resolveUser, type AuthContext } from '../auth/index.js';
import { canAccess } from '../auth/permissions.js';
import { resolveScope, type Scope } from '../auth/scope.js';
import type { User } from '../db/repositories/types.js';

export interface UpgradeContext {
  req: IncomingMessage;
  socket: Duplex;
  head: Buffer;
  url: URL;
  params: string[];
  user: User;
  scope: Scope;
}
export type UpgradeHandler = (ctx: UpgradeContext) => void | Promise<void>;

/** Public upgrade routes authenticate themselves (e.g. bearer token): no cookie user/scope. */
export interface PublicUpgradeContext {
  req: IncomingMessage;
  socket: Duplex;
  head: Buffer;
  url: URL;
  params: string[];
}
export type PublicUpgradeHandler = (ctx: PublicUpgradeContext) => void | Promise<void>;

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
  const publicRoutes: { pattern: RegExp; handler: PublicUpgradeHandler }[] = [];
  server.on('upgrade', async (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');

    // Public routes match first and authenticate themselves (bearer token, not cookie):
    // they skip originAllowed() too — agents send no Origin, and a browser can't set
    // Authorization on a WebSocket, so cross-site WebSocket hijacking doesn't apply here.
    const pub = publicRoutes.map((r) => ({ r, m: url.pathname.match(r.pattern) })).find((x) => x.m);
    if (pub?.m) {
      try {
        await pub.r.handler({ req, socket, head, url, params: pub.m.slice(1) });
      } catch {
        rejectUpgrade(socket, 500, 'Internal Server Error');
      }
      return;
    }

    const route = routes.map((r) => ({ r, m: url.pathname.match(r.pattern) })).find((x) => x.m);
    if (!route?.m) return rejectUpgrade(socket, 404, 'Not Found');
    if (!originAllowed(req)) return rejectUpgrade(socket, 403, 'Forbidden');
    const cookies = parseCookies(req.headers.cookie);
    let user: User | null = null;
    try {
      user = await resolveUser(deps.auth, { headers: req.headers, cookies });
    } catch {
      user = null;
    }
    if (!user) return rejectUpgrade(socket, 401, 'Unauthorized');
    const scope = await resolveScope(deps.auth.repos, user, cookies);
    // every WebSocket is a terminal or simulator stream: needs terminals:read
    if (!(await canAccess(deps.auth.repos, user, 'terminals', 'read'))) return rejectUpgrade(socket, 403, 'Forbidden');
    try {
      await route.r.handler({ req, socket, head, url, params: route.m.slice(1), user, scope });
    } catch {
      rejectUpgrade(socket, 500, 'Internal Server Error');
    }
  });
  return {
    add(pattern: RegExp, handler: UpgradeHandler) {
      routes.push({ pattern, handler });
    },
    addPublic(pattern: RegExp, handler: PublicUpgradeHandler) {
      publicRoutes.push({ pattern, handler });
    },
  };
}
