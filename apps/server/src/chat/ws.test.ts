import { afterEach, expect, it, vi } from 'vitest';
import { chatBus } from './bus.js';
import type { ChatMessage } from '../db/repositories/chat.js';

/** Fake sockets: what each connection was actually sent is the whole point of this file. */
class FakeSocket {
  readyState = 1;
  sent: string[] = [];
  handlers = new Map<string, (...args: unknown[]) => void>();
  send(payload: string) {
    this.sent.push(payload);
  }
  on(event: string, fn: (...args: unknown[]) => void) {
    this.handlers.set(event, fn);
    return this;
  }
}

const sockets: FakeSocket[] = [];
let serverHandlers = new Map<string, (...args: unknown[]) => void>();

vi.mock('ws', () => {
  class WebSocketServer {
    clients = new Set<FakeSocket>();
    constructor(public options: unknown) {}
    handleUpgrade(_req: unknown, _socket: unknown, _head: unknown, cb: (ws: FakeSocket) => void) {
      const ws = new FakeSocket();
      sockets.push(ws);
      this.clients.add(ws);
      cb(ws);
    }
    emit() {}
    on(event: string, fn: (...args: unknown[]) => void) {
      serverHandlers.set(event, fn);
      return this;
    }
  }
  return { WebSocketServer, WebSocket: { OPEN: 1 } };
});

const { registerChatWs } = await import('./ws.js');

const log = { child: () => ({ info: () => {} }) } as never;
const message = (id: string) => ({ id, conversation_id: 'c1', role: 'assistant', text: 'ok', usage: null, error_code: null, created_at: '' }) as ChatMessage;

/** Registers the route and opens one connection per user id, returning their sockets. */
async function connect(userIds: string[]) {
  let handler: ((ctx: unknown) => Promise<void>) | undefined;
  const router = { add: (_pattern: RegExp, h: (ctx: unknown) => Promise<void>) => void (handler = h) } as never;
  const wss = registerChatWs(router, { log });
  for (const id of userIds) {
    await handler!({ req: {}, socket: {}, head: Buffer.alloc(0), scope: { user: { id } } });
  }
  return { wss, opened: sockets.slice(-userIds.length) };
}

afterEach(() => {
  serverHandlers.get('close')?.(); // clears the ping interval the server keeps
  serverHandlers = new Map();
  sockets.length = 0;
});

it('sends each connection only its own user events', async () => {
  const { opened } = await connect(['u1', 'u2']);
  const [first, second] = opened;

  chatBus.publish({ type: 'message', user_id: 'u1', message: message('m1') });
  chatBus.publish({ type: 'delta', user_id: 'u2', message_id: 'm2', delta: 'oi' });
  chatBus.publish({ type: 'action', user_id: 'u1', message_id: 'm1', tool: 'list_tabs', tool_use_id: 'tu_1', args: {} });

  // The per-user filter is this socket's only cross-user isolation control: another account's
  // deltas, actions and messages must never reach a connection.
  expect(first.sent.map((s) => JSON.parse(s).type)).toEqual(['message', 'action']);
  expect(second.sent.map((s) => JSON.parse(s).type)).toEqual(['delta']);
  expect(first.sent.every((s) => JSON.parse(s).user_id === 'u1')).toBe(true);
  expect(second.sent.every((s) => JSON.parse(s).user_id === 'u2')).toBe(true);
});

it('stops sending to a closed connection and leaves the other one working', async () => {
  const { opened } = await connect(['u1', 'u2']);
  const [first, second] = opened;

  first.handlers.get('close')?.();
  chatBus.publish({ type: 'message', user_id: 'u1', message: message('m1') });
  chatBus.publish({ type: 'message', user_id: 'u2', message: message('m2') });

  expect(first.sent).toEqual([]);
  expect(second.sent).toHaveLength(1);
});
