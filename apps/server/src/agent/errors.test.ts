import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Machine } from '../db/repositories/types.js';
import { AgentRpcError, AgentTimeoutError } from './connection.js';
import { AgentOfflineError, agents } from './registry.js';
import { requireSimCapable, toHttpError, versionAtLeast } from './errors.js';

describe('versionAtLeast', () => {
  it('compares dotted numeric versions component by component', () => {
    expect(versionAtLeast('0.1.4', '0.1.4')).toBe(true);
    expect(versionAtLeast('0.1.10', '0.1.4')).toBe(true);
    expect(versionAtLeast('0.2.0', '0.1.4')).toBe(true);
    expect(versionAtLeast('1.0', '0.9.9')).toBe(true);
    expect(versionAtLeast('0.1.3', '0.1.4')).toBe(false);
    expect(versionAtLeast('0.1', '0.1.4')).toBe(false);
  });
});

describe('toHttpError', () => {
  it('relays a "failed" rpc error with the machine\'s own message as 502', () => {
    const err = toHttpError(new AgentRpcError({ code: 'failed', message: 'não deu' }));
    expect(err.statusCode).toBe(502);
    expect(err.message).toBe('não deu');
  });
});

describe('toHttpError codes', () => {
  it('gives every agent failure a code the audit can be read by', () => {
    expect(toHttpError(new AgentOfflineError('x'))).toMatchObject({ statusCode: 503, code: 'AGENT_OFFLINE' });
    expect(toHttpError(new AgentTimeoutError('x'))).toMatchObject({ statusCode: 504, code: 'AGENT_TIMEOUT' });
    expect(toHttpError(new AgentRpcError({ code: 'eperm', message: 'x' }))).toMatchObject({ statusCode: 403, code: 'MACHINE_EPERM' });
    expect(toHttpError(new AgentRpcError({ code: 'notfound', message: 'x' }))).toMatchObject({ statusCode: 404, code: 'MACHINE_NOT_FOUND' });
    expect(toHttpError(new AgentRpcError({ code: 'no_tmux', message: 'x' }))).toMatchObject({ statusCode: 502, code: 'NO_TMUX' });
    expect(toHttpError(new AgentRpcError({ code: 'invalid', message: 'x' }))).toMatchObject({ statusCode: 400, code: 'MACHINE_INVALID' });
    expect(toHttpError(new AgentRpcError({ code: 'failed', message: 'pasta não existe' }))).toMatchObject({ statusCode: 502, code: 'MACHINE_FAILED', message: 'pasta não existe' });
  });
});

function attachFake(machineId: string, hello: { agent_version: string; capabilities: string[] }): void {
  const listeners: Record<string, ((...a: unknown[]) => void)[]> = {};
  const conn = {
    machineId,
    hello: { agent_version: hello.agent_version, os: 'macos', tools: ['tmux', 'xcodebuild'], capabilities: hello.capabilities },
    connectedAt: Date.now(),
    close: vi.fn(function (code: number, reason?: string) {
      (listeners.close ?? []).forEach((l) => l(code, reason));
    }),
    rpc: vi.fn(),
    openPty: vi.fn(),
    openClaude: vi.fn(),
    openTcp: vi.fn(),
    on(ev: string, l: (...a: unknown[]) => void) {
      (listeners[ev] ??= []).push(l);
      return this;
    },
  } as unknown as import('./connection.js').AgentConnection;
  agents.attach(machineId, conn);
}

describe('requireSimCapable', () => {
  afterEach(() => agents.reset());
  const base = { id: 'm-sim', name: 'mac', host: null, ssh_user: null, ssh_port: 22, os: 'macos', capabilities: [], checked_at: null, owner_id: null, owner_name: null, created_at: '' } as unknown as Machine;
  it('passes non-agent machines through', () => {
    expect(() => requireSimCapable({ ...base, type: 'ssh' })).not.toThrow();
  });
  it('answers 503 AGENT_OFFLINE when the agent is not connected', () => {
    expect(() => requireSimCapable({ ...base, type: 'agent' })).toThrow(expect.objectContaining({ statusCode: 503, code: 'AGENT_OFFLINE' }));
  });
  it('answers 409 AGENT_OUTDATED when the connected agent lacks the sim capability', () => {
    attachFake('m-sim', { agent_version: '0.4.4', capabilities: [] });
    expect(() => requireSimCapable({ ...base, type: 'agent' })).toThrow(expect.objectContaining({ statusCode: 409, code: 'AGENT_OUTDATED' }));
  });
  it('passes when the agent claims sim', () => {
    attachFake('m-sim', { agent_version: '0.5.0', capabilities: ['sim'] });
    expect(() => requireSimCapable({ ...base, type: 'agent' })).not.toThrow();
  });
});
