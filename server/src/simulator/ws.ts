import { WebSocketServer, WebSocket } from 'ws';
import type { FastifyBaseLogger } from 'fastify';
import type { Repositories } from '../db/repositories/index.js';
import type { Tab } from '../db/repositories/types.js';
import { rejectUpgrade, type createUpgradeRouter } from '../ws/router.js';
import { dragActions, tapActions } from './actions.js';
import { specialKeyToWda } from './keys.js';
import type { SessionHandle, SimulatorSessionManager, Viewer } from './session-manager.js';
import { WdaError } from './wda-client.js';
import { clientMessageSchema } from './ws-messages.js';

interface Deps {
  repos: Repositories;
  manager: SimulatorSessionManager;
  log: FastifyBaseLogger;
}

const MAX_BUFFERED = 1024 * 1024;
const BUTTON_NAME: Record<string, string> = { home: 'home', lock: 'lock', volumeUp: 'volumeUp', volumeDown: 'volumeDown' };

export function registerSimulatorWs(router: ReturnType<typeof createUpgradeRouter>, deps: Deps) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
  const log = deps.log.child({ mod: 'sim-ws' });
  const byTab = new Map<string, Set<WebSocket>>();

  router.add(/^\/ws\/sim\/([a-z0-9]+)\/?$/, async ({ req, socket, head, params }) => {
    const tab = await deps.repos.tabs.findById(params[0]);
    const project = tab && (await deps.repos.projects.findById(tab.project_id));
    const machine = project && (await deps.repos.machines.findById(project.machine_id));
    if (!tab || !project || !machine || tab.kind !== 'simulator') return rejectUpgrade(socket, 404, 'Not Found');
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
      const set = byTab.get(tab.id) ?? new Set<WebSocket>();
      set.add(ws);
      byTab.set(tab.id, set);
      ws.once('close', () => {
        set.delete(ws);
        if (set.size === 0) byTab.delete(tab.id);
      });
      void handleConnection(ws, tab, machine, deps, log);
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

  return {
    wss,
    /** Fecha as conexões abertas da tab (ex.: trocou de aparelho); os clientes reconectam. */
    closeTab(tabId: string) {
      for (const ws of byTab.get(tabId) ?? []) ws.close(4100, 'tab changed');
    },
  };
}

async function handleConnection(ws: WebSocket, tab: Tab, machine: Parameters<SimulatorSessionManager['acquire']>[0], deps: Deps, log: FastifyBaseLogger) {
  const w = ws as WebSocket & { isAlive?: boolean };
  w.isAlive = true;
  ws.on('pong', () => (w.isAlive = true));
  const send = (msg: object) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };

  if (!tab.simulator_udid) {
    send({ type: 'status', state: 'no_device' });
    ws.on('message', (raw, isBinary) => {
      if (!isBinary && String(raw) === '{"type":"ping"}') send({ type: 'pong' });
    });
    return;
  }
  const udid = tab.simulator_udid;

  // Controle de fluxo: guarda só o último frame; envia quando o buffer do socket tem espaço.
  let paused = false;
  let pending: Buffer | null = null;
  const flush = () => {
    if (!pending || paused || ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > MAX_BUFFERED) return;
    ws.send(pending, { binary: true });
    pending = null;
  };
  const flushTimer = setInterval(flush, 100);

  const viewer: Viewer = {
    onFrame(frame) {
      pending = frame;
      flush();
    },
    onStatus(s) {
      send({ type: 'status', ...s });
    },
    onScreen(s) {
      send({ type: 'screen', ...s });
    },
  };

  let handle: SessionHandle | null = null;
  try {
    handle = await deps.manager.acquire(machine, udid, viewer);
  } catch (err) {
    clearInterval(flushTimer);
    log.warn({ tabId: tab.id, machineId: machine.id, udid, err: err instanceof Error ? err.message : err }, 'simulador não subiu');
    // status 'error' já foi enviado pelo manager
    return;
  }
  log.info({ tabId: tab.id, machineId: machine.id, udid }, 'simulador conectado');

  const toast = (message: string) => send({ type: 'toast', message });
  const run = (p: Promise<unknown>) =>
    p.catch((err) => toast(err instanceof WdaError ? `WDA: ${err.message}` : err instanceof Error ? err.message : 'Comando falhou'));

  ws.on('message', (raw, isBinary) => {
    if (isBinary || !handle) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString());
    } catch {
      return;
    }
    const r = clientMessageSchema.safeParse(parsed);
    if (!r.success) return;
    const m = r.data;
    const { client } = handle;
    switch (m.type) {
      case 'ping':
        return send({ type: 'pong' });
      case 'pause':
        paused = true;
        return;
      case 'resume':
        paused = false;
        return flush();
      case 'tap':
        return void run(client.actions(tapActions(m)));
      case 'drag':
        return void run(client.actions(dragActions(m.points)));
      case 'keys':
        return void run(client.keys([...m.text]));
      case 'key': {
        const code = specialKeyToWda(m.name);
        if (code) void run(client.keys([code]));
        return;
      }
      case 'button':
        return void run(client.pressButton(BUTTON_NAME[m.name]));
      case 'rotate':
        return void run(client.setOrientation(m.orientation).then(() => handle!.refreshScreen()));
      case 'settings':
        return void run(handle.setSettings(m.scale, m.quality));
    }
  });

  const cleanup = () => {
    clearInterval(flushTimer);
    handle?.release();
    handle = null;
    log.info({ tabId: tab.id }, 'simulador desconectado');
  };
  ws.on('close', cleanup);
  ws.on('error', cleanup);
}
