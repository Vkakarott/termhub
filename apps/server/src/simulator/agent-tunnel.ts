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
  registry.on('offline', onOffline);

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
      sock.on('close', () => {
        sockets.delete(sock);
        channel?.close();
      });
      sock.on('error', () => sock.destroy());
      registry
        .openTcp(machineId, { port: remotePort }, {
          onData: (data) => {
            if (!sock.destroyed) sock.write(data);
          },
          onExit: () => sock.destroy(),
        })
        .then((ch) => {
          if (sock.destroyed) {
            ch.close();
            return;
          }
          channel = ch;
          sock.on('data', (d: Buffer) => ch.write(d));
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
