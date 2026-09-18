import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { CLOSE, CONTROL_CHANNEL, decodeFrame, encodeFrame, PROTOCOL_VERSION } from '@termhub/agent-protocol';
import { AgentConnection, AgentTimeoutError } from './connection.js';

class FakeSocket extends EventEmitter {
  sent: Buffer[] = [];
  closed: { code?: number; reason?: string } | null = null;
  readyState = 1;
  send(data: Buffer) { this.sent.push(Buffer.from(data)); }
  close(code?: number, reason?: string) { this.closed = { code, reason }; this.readyState = 3; this.emit('close', code, Buffer.from(reason ?? '')); }
  terminate() { this.close(1006, ''); }
  ping() {}
  /** helpers */
  control() { return this.sent.filter((b) => decodeFrame(b).ch === CONTROL_CHANNEL).map((b) => JSON.parse(decodeFrame(b).payload.toString())); }
  streams(ch: number) { return this.sent.filter((b) => decodeFrame(b).ch === ch).map((b) => decodeFrame(b).payload); }
  recvControl(msg: object) { this.emit('message', encodeFrame(CONTROL_CHANNEL, JSON.stringify(msg)), true); }
  recvStream(ch: number, data: Buffer) { this.emit('message', encodeFrame(ch, data), true); }
}
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => log };
const hello = { type: 'hello', protocol: PROTOCOL_VERSION, agent_version: '0.1.0', os: 'linux', arch: 'x64', hostname: 'h', tmux: true, tools: ['tmux'] };
function connected() { const s = new FakeSocket(); const c = new AgentConnection(s, { machineId: 'm1', log }); const p = c.waitHello(); s.recvControl(hello); return { s, c, p }; }

describe('AgentConnection', () => {
  it('requires hello first and closes 1008 on anything else', async () => {
    const s = new FakeSocket(); const c = new AgentConnection(s, { machineId: 'm1', log });
    const p = c.waitHello();
    s.recvControl({ type: 'opened', ch: 1 });
    await expect(p).rejects.toThrow();
    expect(s.closed?.code).toBe(CLOSE.VIOLATION);
  });
  it('resolves hello and exposes it', async () => {
    const { c, p } = connected();
    expect((await p).hostname).toBe('h');
    expect(c.hello?.os).toBe('linux');
  });
  it('sends an rpc frame and resolves with the validated result', async () => {
    const { s, c } = connected();
    const pending = c.rpc('tmux.list', {});
    const [msg] = s.control().filter((m) => m.type === 'rpc');
    expect(msg.method).toBe('tmux.list');
    s.recvControl({ type: 'rpc_result', id: msg.id, ok: true, result: { sessions: ['a'] } });
    await expect(pending).resolves.toEqual({ sessions: ['a'] });
  });
  it('rejects an rpc whose result fails the schema', async () => {
    const { s, c } = connected();
    const pending = c.rpc('tmux.list', {});
    const [msg] = s.control().filter((m) => m.type === 'rpc');
    s.recvControl({ type: 'rpc_result', id: msg.id, ok: true, result: { sessions: 'nope' } });
    await expect(pending).rejects.toThrow(/invalid rpc result/);
  });
  it('times out an rpc and ignores the late result', async () => {
    vi.useFakeTimers();
    const { s, c } = connected();
    const pending = c.rpc('tmux.list', {}, 100);
    vi.advanceTimersByTime(101);
    await expect(pending).rejects.toBeInstanceOf(AgentTimeoutError);
    const [msg] = s.control().filter((m) => m.type === 'rpc');
    expect(() => s.recvControl({ type: 'rpc_result', id: msg.id, ok: true, result: { sessions: [] } })).not.toThrow();
    vi.useRealTimers();
  });
  it('opens a pty channel, relays bytes both ways and reports exit', async () => {
    const { s, c } = connected();
    const onData = vi.fn(); const onExit = vi.fn();
    const opening = c.openPty({ session: 'th-a', cwd: '/tmp', cols: 80, rows: 24 }, { onData, onExit });
    const [open] = s.control().filter((m) => m.type === 'open');
    expect(open.ch).toBe(1);
    s.recvControl({ type: 'opened', ch: 1 });
    const ch = await opening;
    ch.write('ls\n');
    expect(s.streams(1)[0]?.toString()).toBe('ls\n');
    s.recvStream(1, Buffer.from('out'));
    expect(onData).toHaveBeenCalledWith(Buffer.from('out'));
    ch.resize(100, 30);
    expect(s.control().at(-1)).toEqual({ type: 'resize', ch: 1, cols: 100, rows: 30 });
    s.recvControl({ type: 'closed', ch: 1, code: 0 });
    expect(onExit).toHaveBeenCalledWith(0);
  });
  it('refuses more than 64 channels', async () => {
    const { s, c } = connected();
    for (let i = 0; i < 64; i++) { const p = c.openPty({ session: 'th-a', cwd: '/tmp', cols: 80, rows: 24 }, { onData() {}, onExit() {} }); s.recvControl({ type: 'opened', ch: i + 1 }); await p; }
    await expect(c.openPty({ session: 'th-a', cwd: '/tmp', cols: 80, rows: 24 }, { onData() {}, onExit() {} })).rejects.toThrow(/channels/);
  });
  it('closes 1008 on a malformed frame or unknown channel', async () => {
    const { s } = connected();
    s.recvStream(42, Buffer.from('x'));
    expect(s.closed?.code).toBe(CLOSE.VIOLATION);
  });
  it('fails pending rpcs and open channels when the socket closes', async () => {
    const { s, c } = connected();
    const onExit = vi.fn();
    const opening = c.openPty({ session: 'th-a', cwd: '/tmp', cols: 80, rows: 24 }, { onData() {}, onExit });
    s.recvControl({ type: 'opened', ch: 1 }); await opening;
    const pending = c.rpc('tmux.list', {});
    s.close(1006, '');
    await expect(pending).rejects.toThrow(/closed/);
    expect(onExit).toHaveBeenCalledWith(null);
  });
  it('terminates when two heartbeats pass without a pong', () => {
    const { s, c } = connected();
    c.heartbeat(); s.emit('pong'); c.heartbeat(); c.heartbeat();
    expect(s.closed?.code).toBe(1006);
  });
});
