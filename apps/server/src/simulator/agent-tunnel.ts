import net from 'node:net';
import type { TcpOpenParams } from '@termhub/agent-protocol';
import { AgentClosedError, AgentRpcError, ChannelLimitError, type AgentChannel, type ChannelHandlers } from '../agent/connection.js';
import { AgentOfflineError } from '../agent/registry.js';
import type { WdaPorts } from './ports.js';
import { findFreePort, type Tunnel } from './tunnel-types.js';

/** What the tunnel needs from the agent registry (`agents` in production; a fake in tests). */
export interface TunnelRegistry {
  isOnline(machineId: string): boolean;
  openTcp(machineId: string, params: TcpOpenParams, handlers: ChannelHandlers): Promise<AgentChannel>;
  on(event: 'offline', cb: (machineId: string) => void): unknown;
  off(event: 'offline', cb: (machineId: string) => void): unknown;
}

export const AGENT_OFFLINE_MESSAGE = 'Agente desconectado';
export const NO_CHANNELS_MESSAGE = 'Máquina sem canais livres';

interface Options {
  log?: (msg: string, meta?: object) => void;
}

/**
 * The agent-machine counterpart of the ssh `-L` tunnel: two local listeners whose every accepted
 * connection becomes a `tcp` channel to the WDA port on the machine. Downstream (`WdaClient`, the
 * MJPEG reader, the session manager) keeps seeing "two local ports" and does not change.
 *
 * A refused channel (runner still starting) only drops that one local socket — the session manager
 * keeps polling `/status`. Anything else that keeps channels from opening (agent offline, channel
 * limit) and the agent going offline end the tunnel through `onClose`, once, so the session manager
 * runs its usual recovery.
 */
export async function openAgentTunnel(machineId: string, remote: WdaPorts, registry: TunnelRegistry, opts: Options = {}): Promise<Tunnel> {
  const log = opts.log ?? (() => {});
  if (!registry.isOnline(machineId)) throw new Error(AGENT_OFFLINE_MESSAGE);

  const closeCbs: ((err?: Error) => void)[] = [];
  const sockets = new Set<net.Socket>();
  const servers: net.Server[] = [];
  let closed = false;

  const teardown = () => {
    registry.off('offline', onOffline);
    for (const s of sockets) s.destroy();
    sockets.clear();
    for (const srv of servers) srv.close();
  };
  const fail = (err: Error) => {
    if (closed) return;
    closed = true;
    log('túnel do agente caiu', { machineId, error: err.message });
    teardown();
    for (const cb of closeCbs) cb(err);
  };
  const onOffline = (id: string) => {
    if (id === machineId) fail(new Error(AGENT_OFFLINE_MESSAGE));
  };

  const forward = async (remotePort: number): Promise<number> => {
    const port = await findFreePort();
    const server = net.createServer((sock) => {
      if (closed) {
        sock.destroy();
        return;
      }
      sockets.add(sock);
      sock.pause();
      let channel: AgentChannel | null = null;
      // Byte counts only (spec §7: "bytes per direction"), logged once when the local socket closes.
      // `up` is local → machine, `down` is machine → local. Payload content is never logged.
      let bytesUp = 0;
      let bytesDown = 0;
      let exitReason: string | undefined;
      sock.on('close', () => {
        sockets.delete(sock);
        channel?.close();
        if (channel) log('canal tcp do túnel fechado', { machineId, remotePort, channel: channel.ch, bytesUp, bytesDown, reason: exitReason ?? null });
      });
      sock.on('error', () => sock.destroy());
      registry
        .openTcp(machineId, { port: remotePort }, {
          onData: (data) => {
            bytesDown += data.length;
            if (!sock.destroyed) sock.write(data);
          },
          onExit: (_code, reason) => {
            exitReason = reason;
            // A clean close (WDA answered and closed) must not drop bytes still queued to the local
            // socket — a large screenshot body, the tail of an HTTP response — so end() flushes them
            // first. A reset or error has nothing worth flushing: destroy.
            if (reason === undefined) sock.end();
            else sock.destroy();
          },
        })
        .then((ch) => {
          if (sock.destroyed) {
            ch.close();
            return;
          }
          channel = ch;
          sock.on('data', (d: Buffer) => {
            bytesUp += d.length;
            ch.write(d);
          });
          sock.resume();
        })
        .catch((err: unknown) => {
          sock.destroy();
          if (err instanceof AgentRpcError && err.rpcError.code === 'refused') {
            log('porta do WDA ainda não responde', { machineId, port: remotePort });
            return;
          }
          if (err instanceof ChannelLimitError) return fail(new Error(NO_CHANNELS_MESSAGE));
          if (err instanceof AgentOfflineError || err instanceof AgentClosedError) return fail(new Error(AGENT_OFFLINE_MESSAGE));
          fail(err instanceof Error ? err : new Error(String(err)));
        });
    });
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => resolve());
    });
    return port;
  };

  let wdaPort: number;
  let mjpegPort: number;
  try {
    [wdaPort, mjpegPort] = await Promise.all([forward(remote.wdaPort), forward(remote.mjpegPort)]);
  } catch (err) {
    closed = true;
    teardown();
    throw err;
  }

  // Only from here is there a live tunnel for `onOffline` to end through `onClose` — register it
  // now, then re-check: `findFreePort()`/`listen()` awaited above, so the agent may have gone
  // offline while both listeners were coming up, with nothing yet registered to hear it. Without
  // this check that race would hand back a tunnel nothing will ever tear down.
  registry.on('offline', onOffline);
  if (!registry.isOnline(machineId)) {
    closed = true;
    teardown();
    throw new Error(AGENT_OFFLINE_MESSAGE);
  }
  log('túnel do agente aberto', { machineId, wdaPort, mjpegPort, remote });

  return {
    wdaPort,
    mjpegPort,
    close() {
      if (closed) return;
      closed = true;
      teardown();
    },
    onClose(cb) {
      closeCbs.push(cb);
    },
  };
}
