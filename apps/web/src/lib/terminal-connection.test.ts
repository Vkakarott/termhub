// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalConnection, type ConnectionState } from './terminal-connection';

/** Minimal stand-in for the browser WebSocket: the test drives open/message/close by hand. */
class FakeSocket {
  static all: FakeSocket[] = [];
  binaryType = '';
  readyState = 0;
  sent: unknown[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    FakeSocket.all.push(this);
  }
  send(data: unknown) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  message(msg: object) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  serverClose(code: number) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

const last = () => FakeSocket.all[FakeSocket.all.length - 1];

beforeEach(() => {
  FakeSocket.all = [];
  vi.stubGlobal('WebSocket', Object.assign(FakeSocket, { OPEN: 1 }));
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function start() {
  const states: [ConnectionState, number][] = [];
  const errors: string[] = [];
  const conn = new TerminalConnection('t1', { onData: () => {}, onState: (s, a) => states.push([s, a]), onError: (m) => errors.push(m) });
  conn.connect({ cols: 80, rows: 24 });
  return { conn, states, errors };
}

/** The server accepts the socket, then the machine refuses to start the terminal. */
function failOpen(ws: FakeSocket) {
  ws.open();
  ws.message({ type: 'error', message: 'Falha ao iniciar terminal' });
  ws.serverClose(1011);
}

describe('TerminalConnection', () => {
  it('backs off and gives up when the socket opens but the terminal never starts', () => {
    const { states, errors } = start();
    for (let i = 0; i < 20 && FakeSocket.all.length <= 20; i++) {
      const ws = last();
      failOpen(ws);
      vi.advanceTimersByTime(60_000);
      if (last() === ws) break; // no new attempt: it stopped
    }
    // 1 first try + 8 retries, then offline — not one retry per second forever
    expect(FakeSocket.all).toHaveLength(9);
    expect(states[states.length - 1][0]).toBe('offline');
    expect(states.some(([s]) => s === 'connected')).toBe(false);
    expect(errors[errors.length - 1]).toBe('Falha ao iniciar terminal');
  });

  it('is connected only once the server says the terminal is ready, and then resets the attempts', () => {
    const { states } = start();
    failOpen(last());
    vi.advanceTimersByTime(60_000);
    const ws = last();
    ws.open();
    expect(states[states.length - 1][0]).toBe('reconnecting');
    ws.message({ type: 'ready' });
    expect(states[states.length - 1]).toEqual(['connected', 0]);
    expect(ws.sent).toContain(JSON.stringify({ type: 'resize', cols: 80, rows: 24 }));
  });
});
