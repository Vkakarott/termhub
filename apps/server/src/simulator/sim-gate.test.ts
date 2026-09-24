import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentConnection } from '../agent/connection.js';
import { agents } from '../agent/registry.js';
import type { Machine } from '../db/repositories/types.js';
import { simGateMessage } from './sim-gate.js';

function attachAgent(machineId: string, hello: { os: string; capabilities: string[] }): void {
  const conn = {
    machineId,
    hello: { agent_version: '0.5.0', os: hello.os, tools: ['tmux', 'xcodebuild'], capabilities: hello.capabilities },
    connectedAt: Date.now(),
    close: vi.fn(),
    rpc: vi.fn(),
    openPty: vi.fn(),
    openClaude: vi.fn(),
    openTcp: vi.fn(),
    on() {
      return this;
    },
  } as unknown as AgentConnection;
  agents.attach(machineId, conn);
}

const base = { id: 'm-ws', name: 'mac', host: null, ssh_user: null, ssh_port: 22, os: 'macos', capabilities: ['wda'], checked_at: null, owner_id: null, owner_name: null, created_at: '' } as unknown as Machine;

describe('simGateMessage (/ws/sim capability gate)', () => {
  afterEach(() => agents.reset());

  it('lets ssh machines through', () => {
    expect(simGateMessage({ ...base, type: 'ssh' })).toBeNull();
  });

  it('an offline agent gets "Agente desconectado" without starting a session', () => {
    expect(simGateMessage({ ...base, type: 'agent' })).toBe('Agente desconectado');
  });

  it('an agent without sim is told to update', () => {
    attachAgent('m-ws', { os: 'macos', capabilities: [] });
    expect(simGateMessage({ ...base, type: 'agent' })).toMatch(/^Atualize o agente/);
  });

  it('a non-Mac agent is told it is not a Mac', () => {
    attachAgent('m-ws', { os: 'linux', capabilities: [] });
    expect(simGateMessage({ ...base, type: 'agent' })).toBe('Esta máquina não é um Mac com Xcode');
  });

  it('an agent claiming sim passes', () => {
    attachAgent('m-ws', { os: 'macos', capabilities: ['sim'] });
    expect(simGateMessage({ ...base, type: 'agent' })).toBeNull();
  });
});
