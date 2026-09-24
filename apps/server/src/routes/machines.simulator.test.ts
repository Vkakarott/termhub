import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Repositories } from '../db/repositories/index.js';
import type { Machine, MachineType } from '../db/repositories/types.js';
import { applyErrorHandler } from '../lib/errors.js';
import { agents } from '../agent/registry.js';
import { machineRoutes } from './machines.js';

const { listSimulators, wdaSetupState, startWdaSetup, agentRpc } = vi.hoisted(() => ({ listSimulators: vi.fn(), wdaSetupState: vi.fn(), startWdaSetup: vi.fn(), agentRpc: vi.fn() }));
vi.mock('../simulator/machine.js', () => ({ listSimulators }));
vi.mock('../simulator/setup.js', () => ({ wdaSetupState, startWdaSetup }));
vi.mock('../agent/errors.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../agent/errors.js')>()), agentRpc }));

function makeMachine(overrides: Partial<Machine> & { type: MachineType }): Machine {
  return {
    id: 'm1',
    name: 'box',
    subtitle: null,
    host: overrides.type === 'ssh' ? 'example.com' : null,
    ssh_user: null,
    ssh_port: 22,
    os: null,
    capabilities: [],
    checked_at: null,
    agent_version: null,
    agent_last_seen_at: null,
    agent_auto_update: false,
    is_local: false,
    owner_id: 'u1',
    owner_name: null,
    created_at: '',
    ...overrides,
  };
}

/** Minimal harness copied from routes/machines.test.ts: Fastify + a fixed request scope + a repos stub. */
function buildAppWithSpies(store: Record<string, Machine>) {
  const app = Fastify();
  applyErrorHandler(app);
  app.addHook('preHandler', async (request) => {
    request.scope = { user: { id: 'u1' } as never, viewAs: { kind: 'self' }, ownerId: null, createAs: 'u1' };
    request.user = { id: 'u1' } as never;
  });

  const setDetected = vi.fn(async () => {});
  const repos = {
    machines: {
      findById: async (id: string) => store[id],
      setDetected,
    },
  } as unknown as Repositories;

  app.register((instance) => machineRoutes(instance, repos), { prefix: '' });
  return { app, setDetected };
}

function buildApp(store: Record<string, Machine>) {
  return buildAppWithSpies(store).app;
}

/** A connected agent as the registry sees it (from agent/registry.test.ts's fakeConn pattern). */
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
  } as unknown as import('../agent/connection.js').AgentConnection;
  agents.attach(machineId, conn);
}

describe('simulator routes on agent machines', () => {
  afterEach(() => agents.reset());

  it('GET /:id/simulators answers 503 AGENT_OFFLINE when the agent is offline', async () => {
    const app = buildApp({ m1: makeMachine({ type: 'agent', os: 'macos', capabilities: ['xcodebuild'] }) });
    const res = await app.inject({ method: 'GET', url: '/m1/simulators' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ code: 'AGENT_OFFLINE' });
  });

  it('answers 409 AGENT_OUTDATED when the connected agent has no sim capability', async () => {
    attachFake('m1', { agent_version: '0.4.4', capabilities: [] });
    const app = buildApp({ m1: makeMachine({ type: 'agent', os: 'macos', capabilities: ['xcodebuild'] }) });
    const res = await app.inject({ method: 'GET', url: '/m1/simulators' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'AGENT_OUTDATED' });
    expect(res.json().error).toContain('0.5.0');
  });

  it('lists simulators when the agent claims sim', async () => {
    attachFake('m1', { agent_version: '0.5.0', capabilities: ['sim'] });
    listSimulators.mockResolvedValue([{ udid: 'A', name: 'iPhone', runtime: 'iOS 26.3', state: 'Booted' }]);
    const app = buildApp({ m1: makeMachine({ type: 'agent', os: 'macos', capabilities: ['xcodebuild'] }) });
    const res = await app.inject({ method: 'GET', url: '/m1/simulators' });
    expect(res.statusCode).toBe(200);
    expect(res.json().simulators).toHaveLength(1);
  });

  it('GET /:id/simulator/setup refreshes capabilities through tools.detect once the setup is ok', async () => {
    attachFake('m1', { agent_version: '0.5.0', capabilities: ['sim'] });
    wdaSetupState.mockResolvedValue({ state: 'ok', tail: [], version: '16.12.8' });
    agentRpc.mockResolvedValue({ os: 'macos', tools: ['xcodebuild', 'wda'] });
    const { app, setDetected } = buildAppWithSpies({ m1: makeMachine({ type: 'agent', os: 'macos', capabilities: ['xcodebuild'] }) });
    const res = await app.inject({ method: 'GET', url: '/m1/simulator/setup' });
    expect(res.statusCode).toBe(200);
    expect(agentRpc).toHaveBeenCalledWith(expect.objectContaining({ id: 'm1' }), 'tools.detect', {});
    expect(setDetected).toHaveBeenCalledWith('m1', 'macos', ['xcodebuild', 'wda']);
  });

  it('POST /:id/simulator/setup starts the setup on a capable agent', async () => {
    attachFake('m1', { agent_version: '0.5.0', capabilities: ['sim'] });
    startWdaSetup.mockResolvedValue(undefined);
    const app = buildApp({ m1: makeMachine({ type: 'agent', os: 'macos', capabilities: ['xcodebuild'] }) });
    const res = await app.inject({ method: 'POST', url: '/m1/simulator/setup' });
    expect(res.statusCode).toBe(202);
  });
});
