import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { CLOSE, CONTROL_CHANNEL, decodeFrame, encodeFrame, PROTOCOL_VERSION } from '@termhub/agent-protocol';
import { AgentClosedError, AgentConnection, AgentRpcError, AgentTimeoutError } from './connection.js';

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

// Fix round 1 — regression tests for the 4 Important review findings.
describe('AgentConnection — fix round 1', () => {
  it('rejects the pending rpc (not just a violation) when rpc_result is not ok and has no error', async () => {
    const { s, c } = connected();
    const pending = c.rpc('tmux.list', {});
    const [msg] = s.control().filter((m) => m.type === 'rpc');
    s.recvControl({ type: 'rpc_result', id: msg.id, ok: false });
    await expect(pending).rejects.toThrow();
    expect(s.closed?.code).toBe(CLOSE.VIOLATION);
  });

  it('rejects openPty (and never calls onExit) when closed arrives before opened', async () => {
    const { s, c } = connected();
    const onData = vi.fn();
    const onExit = vi.fn();
    const opening = c.openPty({ session: 'th-a', cwd: '/tmp', cols: 80, rows: 24 }, { onData, onExit });
    const [open] = s.control().filter((m) => m.type === 'open');
    s.recvControl({ type: 'closed', ch: open.ch, code: 1 });
    await expect(opening).rejects.toThrow(/closed before opened/);
    expect(onExit).not.toHaveBeenCalled();
    expect(s.closed).toBeNull();
  });

  it('tombstones a timed-out open so a late "opened" cannot resolve a new openPty on the reused number', async () => {
    vi.useFakeTimers();
    const { s, c } = connected();
    const onExit1 = vi.fn();
    const opening1 = c.openPty({ session: 'th-a', cwd: '/tmp', cols: 80, rows: 24 }, { onData() {}, onExit: onExit1 });
    const [open1] = s.control().filter((m) => m.type === 'open');
    vi.advanceTimersByTime(10_001);
    await expect(opening1).rejects.toBeInstanceOf(AgentTimeoutError);

    const onData2 = vi.fn();
    const onExit2 = vi.fn();
    const opening2 = c.openPty({ session: 'th-b', cwd: '/tmp', cols: 80, rows: 24 }, { onData: onData2, onExit: onExit2 });
    const opens = s.control().filter((m) => m.type === 'open');
    const open2 = opens[opens.length - 1];
    expect(open2.ch).not.toBe(open1.ch);

    // Late reply for the timed-out attempt: must not resolve/violate, and must not touch channel 2.
    s.recvControl({ type: 'opened', ch: open1.ch });
    expect(s.closed).toBeNull();
    expect(onExit1).not.toHaveBeenCalled();

    s.recvControl({ type: 'opened', ch: open2.ch });
    const ch2 = await opening2;
    expect(ch2.ch).toBe(open2.ch);
    vi.useRealTimers();
  });

  it('rejects rpc/openPty immediately once the connection is closing, without waiting out the timeout', async () => {
    const { c } = connected();
    c.close(1000, 'bye');
    await expect(c.rpc('tmux.list', {})).rejects.toBeInstanceOf(AgentClosedError);
    await expect(c.openPty({ session: 'th-a', cwd: '/tmp', cols: 80, rows: 24 }, { onData() {}, onExit() {} })).rejects.toBeInstanceOf(
      AgentClosedError,
    );
  });
});

// Final fix wave — I5: params are validated before anything hits the wire.
describe('AgentConnection — rpc params validation', () => {
  it('rejects invalid params with AgentRpcError "invalid" and sends no frame', async () => {
    const { s, c } = connected();
    const before = s.sent.length;
    const pending = c.rpc('tmux.kill', { session: 'bad name' } as never);
    await expect(pending).rejects.toBeInstanceOf(AgentRpcError);
    await pending.catch((err: AgentRpcError) => expect(err.rpcError.code).toBe('invalid'));
    expect(s.sent.length).toBe(before);
    expect(s.closed).toBeNull();
  });

  it('still sends valid params unchanged', async () => {
    const { s, c } = connected();
    const pending = c.rpc('fs.mkdir', { parent: '/tmp', name: 'x', recursive: true });
    const [msg] = s.control().filter((m) => m.type === 'rpc');
    expect(msg.params).toEqual({ parent: '/tmp', name: 'x', recursive: true });
    s.recvControl({ type: 'rpc_result', id: msg.id, ok: true, result: { stdout: 'PWD:/tmp/x' } });
    await expect(pending).resolves.toEqual({ stdout: 'PWD:/tmp/x' });
  });
});

// Final fix wave — C1: channel close is a handshake, not a fire-and-forget delete.
describe('AgentConnection — channel close handshake', () => {
  it('stream data arriving after a local close is ignored and the number is freed only after the ack', async () => {
    const { s, c } = connected();
    const onData = vi.fn();
    const onExit = vi.fn();
    const opening = c.openPty({ session: 'th-a', cwd: '/tmp', cols: 80, rows: 24 }, { onData, onExit });
    s.recvControl({ type: 'opened', ch: 1 });
    const ch = await opening;

    ch.close();
    expect(s.control().at(-1)).toEqual({ type: 'close', ch: 1 });

    // In-flight output from the agent (tmux's "[lost tty]", resets, …) for the channel we
    // just closed: must be dropped silently — neither a violation nor delivered to the handler.
    s.recvStream(1, Buffer.from('late output'));
    expect(s.closed).toBeNull();
    expect(onData).not.toHaveBeenCalled();

    // The number stays reserved until the agent acks: a new open gets a different one.
    const opening2 = c.openPty({ session: 'th-b', cwd: '/tmp', cols: 80, rows: 24 }, { onData() {}, onExit() {} });
    const open2 = s.control().filter((m) => m.type === 'open').at(-1);
    expect(open2.ch).toBe(2);
    s.recvControl({ type: 'opened', ch: 2 });
    await opening2;

    // The ack frees the number without reporting an exit for a channel we closed ourselves.
    s.recvControl({ type: 'closed', ch: 1, code: null });
    expect(onExit).not.toHaveBeenCalled();
    expect(s.closed).toBeNull();

    const opening3 = c.openPty({ session: 'th-c', cwd: '/tmp', cols: 80, rows: 24 }, { onData() {}, onExit() {} });
    const open3 = s.control().filter((m) => m.type === 'open').at(-1);
    expect(open3.ch).toBe(1);
    s.recvControl({ type: 'opened', ch: 1 });
    await opening3;
  });

  it('stream data for a timed-out (tombstoned) open is ignored, not a violation', async () => {
    vi.useFakeTimers();
    try {
      const { s, c } = connected();
      const onData = vi.fn();
      const opening = c.openPty({ session: 'th-a', cwd: '/tmp', cols: 80, rows: 24 }, { onData, onExit() {} });
      vi.advanceTimersByTime(10_001);
      await expect(opening).rejects.toBeInstanceOf(AgentTimeoutError);
      s.recvStream(1, Buffer.from('late'));
      expect(s.closed).toBeNull();
      expect(onData).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a socket close after a local channel close does not report an exit for that channel', async () => {
    const { s, c } = connected();
    const onExit = vi.fn();
    const opening = c.openPty({ session: 'th-a', cwd: '/tmp', cols: 80, rows: 24 }, { onData() {}, onExit });
    s.recvControl({ type: 'opened', ch: 1 });
    const ch = await opening;
    ch.close();
    s.close(1006, '');
    expect(onExit).not.toHaveBeenCalled();
  });
});
