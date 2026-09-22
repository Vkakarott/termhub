import { describe, expect, it, vi } from 'vitest';
import type { AgentPtyChannel, PtyHandlers } from './connection.js';
import { AgentOfflineError } from './registry.js';
import type { PtyOpenParams } from '@termhub/agent-protocol';
import type { Machine, Tab } from '../db/repositories/types.js';
import { AgentPtySession } from './pty.js';

function fakeMachine(): Machine {
  return {
    id: 'm1',
    name: 'agent-machine',
    host: null,
    ssh_user: null,
    ssh_port: 22,
    type: 'agent',
    os: 'macos',
    capabilities: [],
    checked_at: null,
    agent_version: '0.1.0',
    agent_last_seen_at: null,
    agent_auto_update: false,
    is_local: false,
    owner_id: 'u1',
  } as Machine;
}

function fakeTab(overrides: Partial<Tab> = {}): Tab {
  return {
    id: 't1',
    project_id: 'p1',
    name: 'main',
    kind: 'terminal',
    tmux_session: 'termhub-t1',
    simulator_udid: null,
    position: 0,
    created_at: new Date().toISOString(),
    ...overrides,
  } as Tab;
}

function fakeChannel() {
  return {
    ch: 1,
    write: vi.fn(),
    resize: vi.fn(),
    close: vi.fn(),
  } satisfies AgentPtyChannel;
}

function fakeRegistry(channel: ReturnType<typeof fakeChannel>) {
  const openPty = vi.fn(
    (_machineId: string, _params: PtyOpenParams, _handlers: PtyHandlers) => Promise.resolve(channel as unknown as AgentPtyChannel),
  );
  return { openPty } as unknown as import('./registry.js').AgentRegistry;
}

describe('AgentPtySession', () => {
  it('opens via the registry, clamping cols/rows and forwarding onData as a string', async () => {
    const channel = fakeChannel();
    const registry = fakeRegistry(channel);
    const onData = vi.fn();
    const onExit = vi.fn();

    const session = await AgentPtySession.open(registry, fakeMachine(), '/Users/x/proj', fakeTab(), { cols: 600, rows: 24 }, { onData, onExit });

    expect(registry.openPty).toHaveBeenCalledTimes(1);
    const [machineId, params, handlers] = (registry.openPty as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(machineId).toBe('m1');
    expect(params).toEqual({ session: 'termhub-t1', cwd: '/Users/x/proj', cols: 500, rows: 24 });

    handlers.onData(Buffer.from('hello', 'utf8'));
    expect(onData).toHaveBeenCalledWith('hello');

    handlers.onExit(2);
    expect(onExit).toHaveBeenCalledWith(2);
    handlers.onExit(null);
    expect(onExit).toHaveBeenCalledWith(1);

    expect(session.pid).toBeNull();
  });

  it('forwards write to the channel', async () => {
    const channel = fakeChannel();
    const registry = fakeRegistry(channel);
    const session = await AgentPtySession.open(registry, fakeMachine(), '/Users/x/proj', fakeTab(), { cols: 80, rows: 24 }, { onData: vi.fn(), onExit: vi.fn() });

    session.write('abc');
    expect(channel.write).toHaveBeenCalledWith('abc');

    const buf = Buffer.from('xyz', 'utf8');
    session.write(buf);
    expect(channel.write).toHaveBeenCalledWith(buf);
  });

  it('forwards resize to the channel with clamped values', async () => {
    const channel = fakeChannel();
    const registry = fakeRegistry(channel);
    const session = await AgentPtySession.open(registry, fakeMachine(), '/Users/x/proj', fakeTab(), { cols: 80, rows: 24 }, { onData: vi.fn(), onExit: vi.fn() });

    session.resize({ cols: 1000, rows: 300 });
    expect(channel.resize).toHaveBeenCalledWith(500, 200);
  });

  it('kill closes the channel once even if called twice', async () => {
    const channel = fakeChannel();
    const registry = fakeRegistry(channel);
    const session = await AgentPtySession.open(registry, fakeMachine(), '/Users/x/proj', fakeTab(), { cols: 80, rows: 24 }, { onData: vi.fn(), onExit: vi.fn() });

    session.kill();
    session.kill();
    expect(channel.close).toHaveBeenCalledTimes(1);
  });

  it('rejects with AgentOfflineError when the agent is offline', async () => {
    const registry = { openPty: vi.fn(() => Promise.reject(new AgentOfflineError('offline'))) } as unknown as import('./registry.js').AgentRegistry;

    await expect(
      AgentPtySession.open(registry, fakeMachine(), '/Users/x/proj', fakeTab(), { cols: 80, rows: 24 }, { onData: vi.fn(), onExit: vi.fn() }),
    ).rejects.toBeInstanceOf(AgentOfflineError);
  });

  it('throws when the tab is not a terminal', async () => {
    const channel = fakeChannel();
    const registry = fakeRegistry(channel);
    await expect(
      AgentPtySession.open(registry, fakeMachine(), '/Users/x/proj', fakeTab({ kind: 'simulator', tmux_session: null }), { cols: 80, rows: 24 }, { onData: vi.fn(), onExit: vi.fn() }),
    ).rejects.toThrow('Tab não é um terminal');
  });
});
