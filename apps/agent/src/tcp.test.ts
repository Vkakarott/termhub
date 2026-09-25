import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentSocket } from './client.js';
import { createTcpManager } from './tcp.js';

interface FakeSocket extends AgentSocket {
  sendControl: ReturnType<typeof vi.fn>;
  sendStream: ReturnType<typeof vi.fn>;
  buffered: number;
}

function makeSocket(): FakeSocket {
  const s = {
    sendControl: vi.fn(),
    sendStream: vi.fn(),
    buffered: 0,
    bufferedAmount: () => s.buffered,
  };
  return s;
}

/** A TCP echo server on an ephemeral loopback port; `received` collects what clients wrote. */
function echoServer(): Promise<{ port: number; server: net.Server; sockets: net.Socket[]; received: Buffer[] }> {
  const sockets: net.Socket[] = [];
  const received: Buffer[] = [];
  const server = net.createServer((sock) => {
    sockets.push(sock);
    sock.on('data', (d) => {
      received.push(d);
      sock.write(d);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ port: (server.address() as AddressInfo).port, server, sockets, received })));
}

const waitFor = (pred: () => boolean, ms = 2000) =>
  vi.waitFor(() => expect(pred()).toBe(true), { timeout: ms, interval: 10 });

const servers: net.Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
});

describe('createTcpManager', () => {
  it('opens a channel to a loopback port, pipes both ways and reports closed once', async () => {
    const { port, server, sockets, received } = await echoServer();
    servers.push(server);
    const socket = makeSocket();
    const tcp = createTcpManager({ log: vi.fn(), allowPort: () => true });

    await tcp.open(1, { port }, socket);
    expect(socket.sendControl).toHaveBeenCalledWith({ type: 'opened', ch: 1 });

    expect(tcp.write(1, Buffer.from('ping'))).toBe(true);
    await waitFor(() => received.length > 0);
    expect(Buffer.concat(received).toString()).toBe('ping');
    await waitFor(() => socket.sendStream.mock.calls.length > 0);
    expect(socket.sendStream).toHaveBeenCalledWith(1, Buffer.from('ping'));

    sockets[0].end();
    await waitFor(() => socket.sendControl.mock.calls.some((c) => c[0].type === 'closed'));
    await new Promise((r) => setTimeout(r, 50));
    expect(socket.sendControl.mock.calls.filter((c) => c[0].type === 'closed')).toHaveLength(1);
    expect(socket.sendControl).toHaveBeenCalledWith({ type: 'closed', ch: 1, code: null });
    expect(tcp.write(1, Buffer.from('late'))).toBe(false);
  });

  it('answers open_error refused when nothing listens on the port', async () => {
    const { port, server } = await echoServer();
    servers.pop();
    await new Promise<void>((r) => server.close(() => r()));
    const socket = makeSocket();
    const tcp = createTcpManager({ log: vi.fn(), allowPort: () => true });
    await tcp.open(2, { port }, socket);
    expect(socket.sendControl).toHaveBeenCalledWith({ type: 'open_error', ch: 2, error: { code: 'refused', message: 'connection refused' } });
    expect(socket.sendControl).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'opened' }));
  });

  it('refuses a port outside the WDA ranges with the default allowPort, without connecting', async () => {
    const { port, server, sockets } = await echoServer();
    servers.push(server);
    const socket = makeSocket();
    const tcp = createTcpManager({ log: vi.fn() });
    await tcp.open(3, { port }, socket); // ephemeral port: never inside 8100-8199 / 9100-9199
    expect(socket.sendControl).toHaveBeenCalledWith({ type: 'open_error', ch: 3, error: { code: 'invalid', message: 'port not allowed' } });
    await new Promise((r) => setTimeout(r, 50));
    expect(sockets).toHaveLength(0);
  });

  it('refuses a channel number already in use', async () => {
    const { port, server } = await echoServer();
    servers.push(server);
    const socket = makeSocket();
    const tcp = createTcpManager({ log: vi.fn(), allowPort: () => true });
    await tcp.open(4, { port }, socket);
    await tcp.open(4, { port }, socket);
    expect(socket.sendControl).toHaveBeenCalledWith({ type: 'open_error', ch: 4, error: { code: 'invalid', message: 'channel in use' } });
    tcp.closeAll();
  });

  it('close(ch) destroys the socket and acks closed exactly once', async () => {
    const { port, server, sockets } = await echoServer();
    servers.push(server);
    const socket = makeSocket();
    const tcp = createTcpManager({ log: vi.fn(), allowPort: () => true });
    await tcp.open(5, { port }, socket);
    tcp.close(5);
    await waitFor(() => sockets[0].destroyed || sockets[0].readyState === 'closed');
    await new Promise((r) => setTimeout(r, 50));
    expect(socket.sendControl.mock.calls.filter((c) => c[0].type === 'closed')).toHaveLength(1);
  });

  it('reports closed reason: reset (not open_error) when the local socket errors after connecting', async () => {
    const { port, server, sockets } = await echoServer();
    servers.push(server);
    const socket = makeSocket();
    const tcp = createTcpManager({ log: vi.fn(), allowPort: () => true });
    await tcp.open(9, { port }, socket);
    expect(socket.sendControl).toHaveBeenCalledWith({ type: 'opened', ch: 9 });
    socket.sendControl.mockClear();

    await waitFor(() => sockets.length > 0);
    sockets[0].resetAndDestroy();

    await waitFor(() => socket.sendControl.mock.calls.some((c) => c[0].type === 'closed'));
    await new Promise((r) => setTimeout(r, 50));
    expect(socket.sendControl.mock.calls.filter((c) => c[0].type === 'closed')).toHaveLength(1);
    expect(socket.sendControl).toHaveBeenCalledWith({ type: 'closed', ch: 9, code: null, reason: 'reset' });
    expect(socket.sendControl).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'open_error' }));
  });

  it('pauses the local socket while the websocket buffer is above the high-water mark and resumes below the low-water mark', async () => {
    const { port, server, sockets } = await echoServer();
    servers.push(server);
    const socket = makeSocket();
    const tcp = createTcpManager({ log: vi.fn(), allowPort: () => true, highWater: 100, lowWater: 10, resumePollMs: 5 });
    await tcp.open(6, { port }, socket);

    socket.buffered = 500; // "the websocket is congested"
    tcp.write(6, Buffer.alloc(200, 1)); // echoed back → one data event → pause
    await waitFor(() => socket.sendStream.mock.calls.length >= 1);
    await waitFor(() => sockets[0] !== undefined && tcp.isPaused(6));

    socket.buffered = 0; // drained
    await waitFor(() => !tcp.isPaused(6));
    tcp.closeAll();
  });

  it('closeAll drops every channel without sending closed', async () => {
    const { port, server } = await echoServer();
    servers.push(server);
    const socket = makeSocket();
    const tcp = createTcpManager({ log: vi.fn(), allowPort: () => true });
    await tcp.open(7, { port }, socket);
    await tcp.open(8, { port }, socket);
    socket.sendControl.mockClear();
    tcp.closeAll();
    await new Promise((r) => setTimeout(r, 50));
    expect(socket.sendControl).not.toHaveBeenCalled();
    expect(tcp.write(7, Buffer.from('x'))).toBe(false);
  });
});
