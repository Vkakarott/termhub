import { EventEmitter } from 'node:events';
import net from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import type { AgentChannel, ChannelHandlers } from '../agent/connection.js';
import { AgentRpcError, ChannelLimitError } from '../agent/connection.js';
import { AgentOfflineError } from '../agent/registry.js';
import { AGENT_OFFLINE_MESSAGE, NO_CHANNELS_MESSAGE, openAgentTunnel, type TunnelRegistry } from './agent-tunnel.js';

/** A registry whose tcp channels are in-memory loops: what the "machine" answers is scripted per test. */
function fakeRegistry(opts: { online?: boolean; onOpen?: (port: number, handlers: ChannelHandlers) => AgentChannel | Error } = {}) {
  const emitter = new EventEmitter();
  const opened: { port: number; handlers: ChannelHandlers; channel: AgentChannel }[] = [];
  const registry: TunnelRegistry = {
    isOnline: () => opts.online ?? true,
    openTcp: vi.fn(async (_machineId: string, params: { port: number }, handlers: ChannelHandlers) => {
      const res = opts.onOpen?.(params.port, handlers);
      if (res instanceof Error) throw res;
      const channel: AgentChannel = res ?? { ch: opened.length + 1, write: vi.fn(), close: vi.fn() };
      opened.push({ port: params.port, handlers, channel });
      return channel;
    }),
    on: (event, cb) => emitter.on(event, cb),
    off: (event, cb) => emitter.off(event, cb),
  };
  return { registry, opened, emitter };
}

function connect(port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const s = net.connect({ port, host: '127.0.0.1' });
    s.once('connect', () => resolve(s));
    s.once('error', reject);
  });
}

const waitFor = (pred: () => boolean) => vi.waitFor(() => expect(pred()).toBe(true), { timeout: 2000, interval: 10 });

describe('openAgentTunnel', () => {
  it('listens on two local ports and opens one tcp channel per accepted connection, to the remote port', async () => {
    const { registry, opened } = fakeRegistry();
    const t = await openAgentTunnel('m1', { wdaPort: 8137, mjpegPort: 9137 }, registry);
    expect(t.wdaPort).not.toBe(8137);
    expect(t.mjpegPort).not.toBe(9137);

    const a = await connect(t.wdaPort);
    await waitFor(() => opened.length === 1);
    expect(opened[0].port).toBe(8137);
    const b = await connect(t.mjpegPort);
    await waitFor(() => opened.length === 2);
    expect(opened[1].port).toBe(9137);

    a.destroy();
    b.destroy();
    t.close();
  });

  it('pipes local bytes into channel.write and channel data back to the local socket', async () => {
    const { registry, opened } = fakeRegistry();
    const t = await openAgentTunnel('m1', { wdaPort: 8137, mjpegPort: 9137 }, registry);
    const sock = await connect(t.wdaPort);
    await waitFor(() => opened.length === 1);
    const received: Buffer[] = [];
    sock.on('data', (d) => received.push(d));

    sock.write('GET /status HTTP/1.1\r\n\r\n');
    await waitFor(() => (opened[0].channel.write as ReturnType<typeof vi.fn>).mock.calls.length > 0);
    expect(Buffer.concat((opened[0].channel.write as ReturnType<typeof vi.fn>).mock.calls.map((c) => Buffer.from(c[0]))).toString()).toBe('GET /status HTTP/1.1\r\n\r\n');

    opened[0].handlers.onData(Buffer.from('HTTP/1.1 200 OK\r\n'));
    await waitFor(() => received.length > 0);
    expect(Buffer.concat(received).toString()).toBe('HTTP/1.1 200 OK\r\n');
    sock.destroy();
    t.close();
  });

  it('closing the local socket closes the channel, and channel exit destroys the local socket', async () => {
    const { registry, opened } = fakeRegistry();
    const t = await openAgentTunnel('m1', { wdaPort: 8137, mjpegPort: 9137 }, registry);
    const a = await connect(t.wdaPort);
    await waitFor(() => opened.length === 1);
    a.end();
    await waitFor(() => (opened[0].channel.close as ReturnType<typeof vi.fn>).mock.calls.length === 1);

    const b = await connect(t.wdaPort);
    await waitFor(() => opened.length === 2);
    const ended = new Promise<void>((r) => b.once('close', () => r()));
    opened[1].handlers.onExit(null);
    await ended;
    t.close();
  });

  it('a refused channel destroys only that local socket; the tunnel stays up', async () => {
    const { registry, opened } = fakeRegistry({ onOpen: () => new AgentRpcError({ code: 'refused', message: 'connection refused' }) });
    const onClose = vi.fn();
    const t = await openAgentTunnel('m1', { wdaPort: 8137, mjpegPort: 9137 }, registry);
    t.onClose(onClose);
    const a = await connect(t.wdaPort);
    await new Promise<void>((r) => a.once('close', () => r()));
    expect(opened).toHaveLength(0);
    expect(onClose).not.toHaveBeenCalled();
    // still listening
    const b = await connect(t.wdaPort);
    await new Promise<void>((r) => b.once('close', () => r()));
    t.close();
  });

  it('the channel limit fails the tunnel with the "no channels" message', async () => {
    const { registry } = fakeRegistry({ onOpen: () => new ChannelLimitError('too many channels') });
    const onClose = vi.fn();
    const t = await openAgentTunnel('m1', { wdaPort: 8137, mjpegPort: 9137 }, registry);
    t.onClose(onClose);
    const a = await connect(t.wdaPort);
    await new Promise<void>((r) => a.once('close', () => r()));
    await waitFor(() => onClose.mock.calls.length === 1);
    expect(onClose.mock.calls[0][0]).toBeInstanceOf(Error);
    expect((onClose.mock.calls[0][0] as Error).message).toBe(NO_CHANNELS_MESSAGE);
    t.close();
  });

  it('refuses to open when the agent is offline, with the pt-BR message', async () => {
    const { registry } = fakeRegistry({ online: false });
    await expect(openAgentTunnel('m1', { wdaPort: 8137, mjpegPort: 9137 }, registry)).rejects.toThrow(AGENT_OFFLINE_MESSAGE);
  });

  it('going offline between listen and return fails the setup with the offline message and leaves no listener registered', async () => {
    const { registry, emitter } = fakeRegistry();
    let calls = 0;
    // First call is the up-front check before any listener is up; second is the re-check made
    // right after both local listeners started — that is the window the fix closes.
    registry.isOnline = vi.fn(() => {
      calls++;
      return calls === 1;
    });
    await expect(openAgentTunnel('m1', { wdaPort: 8137, mjpegPort: 9137 }, registry)).rejects.toThrow(AGENT_OFFLINE_MESSAGE);
    expect(emitter.listenerCount('offline')).toBe(0);
  });

  it('an offline event for this machine fires onClose exactly once, destroys local sockets and stops listening', async () => {
    const { registry, opened, emitter } = fakeRegistry();
    const onClose = vi.fn();
    const t = await openAgentTunnel('m1', { wdaPort: 8137, mjpegPort: 9137 }, registry);
    t.onClose(onClose);
    const a = await connect(t.wdaPort);
    const b = await connect(t.mjpegPort);
    await waitFor(() => opened.length === 2);

    emitter.emit('offline', 'other-machine');
    expect(onClose).not.toHaveBeenCalled();

    emitter.emit('offline', 'm1');
    opened[0].handlers.onExit(null);
    opened[1].handlers.onExit(null);
    await waitFor(() => a.destroyed && b.destroyed);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect((onClose.mock.calls[0][0] as Error).message).toBe(AGENT_OFFLINE_MESSAGE);
    await expect(connect(t.wdaPort)).rejects.toThrow();
    expect(emitter.listenerCount('offline')).toBe(0);
  });

  it('close() is idempotent and never fires onClose', async () => {
    const { registry } = fakeRegistry();
    const onClose = vi.fn();
    const t = await openAgentTunnel('m1', { wdaPort: 8137, mjpegPort: 9137 }, registry);
    t.onClose(onClose);
    t.close();
    t.close();
    await new Promise((r) => setTimeout(r, 20));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('an AgentOfflineError from openTcp (race with a disconnect) fails the tunnel with the offline message', async () => {
    const { registry } = fakeRegistry({ onOpen: () => new AgentOfflineError('agent offline: m1') });
    const onClose = vi.fn();
    const t = await openAgentTunnel('m1', { wdaPort: 8137, mjpegPort: 9137 }, registry);
    t.onClose(onClose);
    const a = await connect(t.wdaPort);
    await new Promise<void>((r) => a.once('close', () => r()));
    await waitFor(() => onClose.mock.calls.length === 1);
    expect((onClose.mock.calls[0][0] as Error).message).toBe(AGENT_OFFLINE_MESSAGE);
  });
});
