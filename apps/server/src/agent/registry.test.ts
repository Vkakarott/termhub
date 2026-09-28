import { describe, expect, it, vi } from 'vitest';
import { CLOSE } from '@termhub/agent-protocol';
import { AgentOfflineError, AgentRegistry, MOVING_WAIT_MS } from './registry.js';

function fakeConn(machineId: string) {
  const listeners: Record<string, ((...a: unknown[]) => void)[]> = {};
  return {
    machineId, hello: { agent_version: '0.1.0', os: 'linux', tools: ['tmux'], capabilities: ['claude'] }, connectedAt: Date.now(),
    close: vi.fn(function (this: unknown, code: number, reason?: string) { (listeners.close ?? []).forEach((l) => l(code, reason)); }),
    rpc: vi.fn(async () => ({ sessions: ['a'] })), openPty: vi.fn(), openClaude: vi.fn(async () => ({ ch: 1, write() {}, close() {} })),
    on(ev: string, l: (...a: unknown[]) => void) { (listeners[ev] ??= []).push(l); return this; },
  } as unknown as import('./connection.js').AgentConnection;
}

const claudeParams = { session_id: 's-1', resume: false, config_dir: null, mcp_url: 'https://termhub.dev/mcp', token: 'tok', model: null };
const handlers = { onData() {}, onExit() {} };

describe('AgentRegistry', () => {
  it('tracks online state and emits events', () => {
    const r = new AgentRegistry(); const online = vi.fn(); const offline = vi.fn();
    r.on('online', online); r.on('offline', offline);
    const c = fakeConn('m1'); r.attach('m1', c);
    expect(r.isOnline('m1')).toBe(true); expect(online).toHaveBeenCalledWith('m1', c.hello);
    c.close(1000); expect(r.isOnline('m1')).toBe(false); expect(offline).toHaveBeenCalledWith('m1');
  });
  it('replaces an existing connection with 4409 replaced', () => {
    const r = new AgentRegistry(); const a = fakeConn('m1'); const b = fakeConn('m1');
    r.attach('m1', a); r.attach('m1', b);
    expect(a.close).toHaveBeenCalledWith(CLOSE.CONFLICT, 'replaced');
    expect(r.isOnline('m1')).toBe(true);
    a.close(CLOSE.CONFLICT, 'replaced'); // the old one's close event must not mark m1 offline
    expect(r.isOnline('m1')).toBe(true);
  });
  it('rejects rpc for an offline machine', async () => {
    await expect(new AgentRegistry().rpc('m9', 'tmux.list', {})).rejects.toBeInstanceOf(AgentOfflineError);
  });
  it('forwards rpc to the connection', async () => {
    const r = new AgentRegistry(); const c = fakeConn('m1'); r.attach('m1', c);
    await expect(r.rpc('m1', 'tmux.list', {})).resolves.toEqual({ sessions: ['a'] });
    expect(c.rpc).toHaveBeenCalledWith('tmux.list', {}, undefined);
  });
  it('reports the capabilities an attached agent advertised, and null for a machine nobody is on', () => {
    const r = new AgentRegistry();
    expect(r.capabilities('m9')).toBeNull();
    const c = fakeConn('m1');
    r.attach('m1', c);
    expect(r.capabilities('m1')).toEqual(['claude']);
  });
  it('rejects a claude channel for an offline machine and forwards it for an online one', async () => {
    await expect(new AgentRegistry().openClaude('m9', claudeParams, handlers)).rejects.toBeInstanceOf(AgentOfflineError);
    const r = new AgentRegistry();
    const c = fakeConn('m1');
    r.attach('m1', c);
    await r.openClaude('m1', claudeParams, handlers);
    expect(c.openClaude).toHaveBeenCalledWith(claudeParams, handlers);
  });
});

describe('AgentRegistry.waitOnline / awaitAgent', () => {
  const agentMachine = (lastSeen: string | null) => ({ id: 'm1', type: 'agent' as const, agent_last_seen_at: lastSeen });

  it('resolves true at once when already online', async () => {
    const r = new AgentRegistry(); r.attach('m1', fakeConn('m1'));
    await expect(r.waitOnline('m1', 1000)).resolves.toBe(true);
  });
  it('resolves true when the agent attaches during the wait', async () => {
    vi.useFakeTimers();
    const r = new AgentRegistry();
    const p = r.waitOnline('m1', 5000);
    await vi.advanceTimersByTimeAsync(1000);
    r.attach('m1', fakeConn('m1'));
    await expect(p).resolves.toBe(true);
    expect(r.listenerCount('online')).toBe(0);
    vi.useRealTimers();
  });
  it('resolves false on timeout and removes its listener', async () => {
    vi.useFakeTimers();
    const r = new AgentRegistry();
    const p = r.waitOnline('m1', 5000);
    await vi.advanceTimersByTimeAsync(5000);
    await expect(p).resolves.toBe(false);
    expect(r.listenerCount('online')).toBe(0);
    vi.useRealTimers();
  });
  it('ignores another machine coming online', async () => {
    vi.useFakeTimers();
    const r = new AgentRegistry();
    const p = r.waitOnline('m1', 2000);
    r.attach('m2', fakeConn('m2'));
    await vi.advanceTimersByTimeAsync(2000);
    await expect(p).resolves.toBe(false);
    vi.useRealTimers();
  });
  it('awaitAgent: a non-agent machine passes at once', async () => {
    await expect(new AgentRegistry().awaitAgent({ id: 'm1', type: 'ssh', agent_last_seen_at: null } as never)).resolves.toBe(true);
  });
  it('awaitAgent: does not wait for a stale machine', async () => {
    const now = Date.parse('2026-09-28T00:10:00Z');
    const r = new AgentRegistry(); const spy = vi.spyOn(r, 'waitOnline');
    await expect(r.awaitAgent(agentMachine('2026-09-28T00:00:00Z'), { now })).resolves.toBe(false);
    await expect(r.awaitAgent(agentMachine(null), { now })).resolves.toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });
  it('awaitAgent: waits for a machine seen within the moving window', async () => {
    const now = Date.parse('2026-09-28T00:10:00Z');
    const r = new AgentRegistry(); const spy = vi.spyOn(r, 'waitOnline').mockResolvedValue(true);
    await expect(r.awaitAgent(agentMachine('2026-09-28T00:08:00Z'), { now })).resolves.toBe(true);
    expect(spy).toHaveBeenCalledWith('m1', MOVING_WAIT_MS);
  });
  it('closeAll closes every connection with the given code', () => {
    const r = new AgentRegistry(); const a = fakeConn('m1'); const b = fakeConn('m2');
    r.attach('m1', a); r.attach('m2', b);
    expect(r.closeAll(1012, 'service restart')).toBe(2);
    expect(a.close).toHaveBeenCalledWith(1012, 'service restart');
    expect(b.close).toHaveBeenCalledWith(1012, 'service restart');
    expect(r.isOnline('m1')).toBe(false);
  });
});
