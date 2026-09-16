import type { Server as HttpServer, IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, WebSocket } from 'ws';
import type { FastifyBaseLogger } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import type { Repositories } from '../db/repositories/index.js';
import type { Machine, Project, Tab } from '../db/repositories/types.js';
import { parseCookies, resolveUser, type AuthContext } from '../auth/index.js';
import { PtySession } from './pty-session.js';

const WS_PATH_RE = /^\/ws\/tabs\/([a-z0-9]+)\/?$/;

const controlSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('resize'), cols: z.number().int().min(2).max(500), rows: z.number().int().min(2).max(200) }),
  z.object({ type: z.literal('ping') }),
]);

interface Deps {
  repos: Repositories;
  auth: AuthContext;
  log: FastifyBaseLogger;
}

function rejectUpgrade(socket: Duplex, status: number, text: string) {
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

export function attachTerminalWebSocket(server: HttpServer, deps: Deps): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  const log = deps.log.child({ mod: 'ws' });

  server.on('upgrade', async (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const match = url.pathname.match(WS_PATH_RE);
    if (!match) return rejectUpgrade(socket, 404, 'Not Found');
    if (!originAllowed(req)) return rejectUpgrade(socket, 403, 'Forbidden');

    let user;
    try {
      user = await resolveUser(deps.auth, { headers: req.headers, cookies: parseCookies(req.headers.cookie) });
    } catch {
      user = null;
    }
    if (!user) return rejectUpgrade(socket, 401, 'Unauthorized');

    const tabId = match[1];
    const tab = deps.repos.tabs.findById(tabId);
    const project = tab && deps.repos.projects.findById(tab.project_id);
    const machine = project && deps.repos.machines.findById(project.machine_id);
    if (!tab || !project || !machine) return rejectUpgrade(socket, 404, 'Not Found');

    const cols = Number(url.searchParams.get('cols')) || 80;
    const rows = Number(url.searchParams.get('rows')) || 24;

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
      handleConnection(ws, { tab, project, machine, cols, rows }, deps, log);
    });
  });

  // Heartbeat: derruba conexões mortas (sem ping do cliente) a cada 30s.
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

function handleConnection(
  ws: WebSocket,
  ctx: { tab: Tab; project: Project; machine: Machine; cols: number; rows: number },
  deps: Deps,
  log: FastifyBaseLogger,
) {
  const w = ws as WebSocket & { isAlive?: boolean };
  w.isAlive = true;
  ws.on('pong', () => (w.isAlive = true));

  const send = (msg: object) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };

  let session: PtySession;
  try {
    session = new PtySession(
      ctx.machine,
      ctx.project,
      ctx.tab,
      { cols: ctx.cols, rows: ctx.rows },
      {
        onData: (data) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(Buffer.from(data, 'utf8'), { binary: true });
        },
        onExit: (code) => {
          send({ type: 'exit', code });
          ws.close(1000, 'pty exit');
        },
      },
    );
  } catch (err) {
    log.error({ err, tabId: ctx.tab.id }, 'falha ao iniciar pty');
    send({ type: 'error', message: 'Falha ao iniciar terminal' });
    ws.close(1011, 'pty spawn failed');
    return;
  }

  // Nunca logamos conteúdo do terminal: só metadados.
  log.info({ tabId: ctx.tab.id, machineId: ctx.machine.id, pid: session.pid }, 'terminal conectado');
  deps.repos.projects.touchTerminal(ctx.project.id);
  send({ type: 'ready' });

  ws.on('message', (raw, isBinary) => {
    if (isBinary) {
      session.write(raw as Buffer);
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString());
    } catch {
      return;
    }
    const msg = controlSchema.safeParse(parsed);
    if (!msg.success) return;
    if (msg.data.type === 'resize') session.resize(msg.data);
    else if (msg.data.type === 'ping') send({ type: 'pong' });
  });

  ws.on('close', () => {
    session.kill();
    log.info({ tabId: ctx.tab.id }, 'terminal desconectado');
  });
  ws.on('error', () => session.kill());
}
