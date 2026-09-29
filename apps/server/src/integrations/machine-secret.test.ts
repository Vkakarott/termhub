import { beforeEach, describe, expect, it, vi } from 'vitest';

const rpc = vi.fn();
const awaitAgent = vi.fn();
const info = vi.fn();
vi.mock('../agent/registry.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../agent/registry.js')>()),
  agents: { rpc: (...a: unknown[]) => rpc(...a), awaitAgent: (m: unknown) => awaitAgent(m), info: (id: string) => info(id) },
}));

import { AgentClosedError, AgentRpcError, AgentTimeoutError } from '../agent/connection.js';
import { AgentOfflineError } from '../agent/registry.js';
import type { Machine } from '../db/repositories/types.js';
import { readMachineSecret, SECRET_MIN_AGENT_VERSION } from './machine-secret.js';

const TOKEN = 'gho_S3cretTokenValue123';
const machine = (over: Partial<Machine> = {}): Machine => ({ id: 'm1', name: 'jarvis', type: 'agent', owner_id: 'u1', ...over }) as Machine;

/** The error thrown, and a check that neither its message nor its JSON carries the token. */
async function failure(p: Promise<unknown>): Promise<{ code?: string; message: string }> {
  const err = (await p.then(() => null, (e: unknown) => e)) as { code?: string; message: string } | null;
  expect(err).not.toBeNull();
  expect(err!.message).not.toContain(TOKEN);
  expect(JSON.stringify(err)).not.toContain(TOKEN);
  return err!;
}

beforeEach(() => {
  rpc.mockReset();
  awaitAgent.mockReset().mockResolvedValue(true);
  info.mockReset().mockReturnValue({ agent_version: '0.9.0', os: 'linux', tools: [], connected_at: '' });
});

describe('readMachineSecret', () => {
  it('asks the agent for secret.read and returns the value', async () => {
    rpc.mockResolvedValue({ value: TOKEN });
    await expect(readMachineSecret(machine(), 'gh_auth_token')).resolves.toBe(TOKEN);
    expect(rpc).toHaveBeenCalledWith('m1', 'secret.read', { source: 'gh_auth_token' });
    expect(SECRET_MIN_AGENT_VERSION).toBe('0.9.0');
  });

  it('refuses a machine that is not an agent (UNSUPPORTED_MACHINE)', async () => {
    const err = await failure(readMachineSecret(machine({ type: 'ssh' }), 'gh_auth_token'));
    expect(err.code).toBe('UNSUPPORTED_MACHINE');
    expect(rpc).not.toHaveBeenCalled();
  });

  it('waits for an agent moving between instances (a deploy) before asking it', async () => {
    const order: string[] = [];
    awaitAgent.mockImplementation(async () => {
      order.push('awaitAgent');
      return true;
    });
    rpc.mockImplementation(async () => {
      order.push('rpc');
      return { value: TOKEN };
    });
    const m = machine();
    await expect(readMachineSecret(m, 'gh_auth_token')).resolves.toBe(TOKEN);
    expect(awaitAgent).toHaveBeenCalledWith(m);
    expect(order).toEqual(['awaitAgent', 'rpc']);
  });

  it('answers MACHINE_OFFLINE for a disconnected agent, before any RPC', async () => {
    awaitAgent.mockResolvedValue(false);
    expect((await failure(readMachineSecret(machine(), 'gh_auth_token'))).code).toBe('MACHINE_OFFLINE');
    expect(rpc).not.toHaveBeenCalled();
  });

  it('answers AGENT_OUTDATED for an agent older than 0.9.0 (it would drop the unknown method)', async () => {
    info.mockReturnValue({ agent_version: '0.8.0', os: 'linux', tools: [], connected_at: '' });
    const err = await failure(readMachineSecret(machine(), 'gh_auth_token'));
    expect(err.code).toBe('AGENT_OUTDATED');
    expect(err.message).toContain('0.9.0');
    expect(rpc).not.toHaveBeenCalled();
  });

  it('maps a connection lost mid-call to MACHINE_OFFLINE and a timeout to AGENT_TIMEOUT', async () => {
    rpc.mockRejectedValueOnce(new AgentOfflineError());
    expect((await failure(readMachineSecret(machine(), 'gh_auth_token'))).code).toBe('MACHINE_OFFLINE');
    rpc.mockRejectedValueOnce(new AgentClosedError());
    expect((await failure(readMachineSecret(machine(), 'gh_auth_token'))).code).toBe('MACHINE_OFFLINE');
    rpc.mockRejectedValueOnce(new AgentTimeoutError());
    expect((await failure(readMachineSecret(machine(), 'gh_auth_token'))).code).toBe('AGENT_TIMEOUT');
  });

  it('maps a failed gh auth token to SECRET_UNAVAILABLE without forwarding the agent text', async () => {
    rpc.mockRejectedValue(new AgentRpcError({ code: 'failed', message: `gh auth token failed ${TOKEN}` }));
    const err = await failure(readMachineSecret(machine(), 'gh_auth_token'));
    expect(err.code).toBe('SECRET_UNAVAILABLE');
    expect(err.message).toContain('gh auth login');
    expect(err.message).toContain('jarvis');
  });

  it('maps any other RPC error to a fixed MACHINE_FAILED message', async () => {
    rpc.mockRejectedValue(new AgentRpcError({ code: 'internal', message: `boom ${TOKEN}` }));
    expect((await failure(readMachineSecret(machine(), 'gh_auth_token'))).code).toBe('MACHINE_FAILED');
  });

  it('refuses an empty, oversized or whitespace-bearing value without echoing it', async () => {
    for (const value of ['', `${TOKEN} ${TOKEN}`, `${TOKEN}\n${TOKEN}`, TOKEN.repeat(200)]) {
      rpc.mockResolvedValueOnce({ value });
      expect((await failure(readMachineSecret(machine(), 'gh_auth_token'))).code).toBe('SECRET_UNAVAILABLE');
    }
  });

  it('rethrows an unexpected error untouched', async () => {
    const boom = new Error('bug');
    rpc.mockRejectedValue(boom);
    await expect(readMachineSecret(machine(), 'gh_auth_token')).rejects.toBe(boom);
  });
});
