import { execFile, spawn } from 'node:child_process';
import Fastify, { type FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({ execFile: vi.fn(), spawn: vi.fn() }));

import { CLOSE } from '@termhub/agent-protocol';
import type { Repositories } from '../db/repositories/index.js';
import type { Machine, MachineType } from '../db/repositories/types.js';
import { applyErrorHandler } from '../lib/errors.js';
import { agents } from '../agent/registry.js';
import { AGENT_TOKEN_RE, hashAgentToken } from '../agent/token.js';
import { machineRoutes } from './machines.js';

function makeMachine(overrides: Partial<Machine> & { type: MachineType }): Machine {
  return {
    id: 'm1',
    name: 'box',
    host: overrides.type === 'ssh' ? 'example.com' : null,
    ssh_user: null,
    ssh_port: 22,
    os: null,
    capabilities: [],
    checked_at: null,
    agent_version: null,
    agent_last_seen_at: null,
    owner_id: 'u1',
    owner_name: null,
    created_at: '',
    ...overrides,
  };
}

/** Builds a Fastify app with stubbed repos and a fixed request scope, like waitlist.test.ts. */
function buildApp(store: Record<string, Machine>) {
  const app = Fastify();
  applyErrorHandler(app);
  app.addHook('preHandler', async (request) => {
    request.scope = { user: { id: 'u1' } as never, viewAs: { kind: 'self' }, ownerId: null, createAs: 'u1' };
    request.user = { id: 'u1' } as never;
  });

  const create = vi.fn(async (input: Partial<Machine> & { type: MachineType; name: string }) => {
    const m = makeMachine({
      id: 'm-new',
      name: input.name,
      type: input.type,
      host: input.host ?? null,
      ssh_user: input.ssh_user ?? null,
      ssh_port: input.ssh_port ?? 22,
      owner_id: input.owner_id ?? null,
    });
    store[m.id] = m;
    return m;
  });
  const rotateAgentToken = vi.fn(async (id: string, hash: string) => {
    if (store[id]) store[id] = { ...store[id], agent_version: store[id].agent_version };
    void hash;
  });
  const update = vi.fn(async (id: string, patch: Partial<Machine>) => {
    store[id] = { ...store[id], ...patch } as Machine;
    return store[id];
  });
  const del = vi.fn(async (id: string) => {
    delete store[id];
    return true;
  });

  const machineHooks = {
    findByMachine: vi.fn(async () => undefined),
    upsert: vi.fn(async (machine_id: string) => ({ machine_id, installed_at: '2026-01-01T00:00:00.000Z' })),
    delete: vi.fn(async () => true),
  };

  const repos = {
    machineHooks,
    machines: {
      findById: async (id: string) => store[id],
      list: async () => Object.values(store),
      create,
      rotateAgentToken,
      update,
      delete: del,
    },
    projects: {
      list: async () => [],
    },
    users: {
      findById: async () => undefined,
    },
  } as unknown as Repositories;

  app.register((instance) => machineRoutes(instance, repos), { prefix: '/api/machines' });
  return { app, repos: { create, rotateAgentToken, update, delete: del, machineHooks } };
}

let app: FastifyInstance;
let store: Record<string, Machine>;

beforeEach(() => {
  agents.reset();
  vi.clearAllMocks();
  store = {};
});

describe('POST /api/machines (agent enrollment)', () => {
  it('creates an agent machine, returns a plaintext token, and rotates the stored hash', async () => {
    ({ app } = buildApp(store));
    const res = await app.inject({ method: 'POST', url: '/api/machines', payload: { name: 'agent-box', type: 'agent' } });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(AGENT_TOKEN_RE.test(body.agent_token)).toBe(true);
    expect(body.machine.host).toBeNull();
  });

  it('rotateAgentToken is called with the hash of the returned token', async () => {
    const built = buildApp(store);
    app = built.app;
    const res = await app.inject({ method: 'POST', url: '/api/machines', payload: { name: 'agent-box', type: 'agent' } });
    const body = res.json();
    expect(built.repos.rotateAgentToken).toHaveBeenCalledWith(body.machine.id, hashAgentToken(body.agent_token));
  });

  it('rejects an agent machine with a host set (400)', async () => {
    ({ app } = buildApp(store));
    const res = await app.inject({ method: 'POST', url: '/api/machines', payload: { name: 'agent-box', type: 'agent', host: 'example.com' } });
    expect(res.statusCode).toBe(400);
  });

  it('still creates a plain ssh machine without an agent_token', async () => {
    ({ app } = buildApp(store));
    const res = await app.inject({ method: 'POST', url: '/api/machines', payload: { name: 'ssh-box', type: 'ssh', host: 'example.com' } });
    expect(res.statusCode).toBe(201);
    expect(res.json().agent_token).toBeUndefined();
  });
});

describe('POST /api/machines/:id/agent-token (rotation)', () => {
  it('rotates the token and disconnects the live connection', async () => {
    store.m1 = makeMachine({ id: 'm1', type: 'agent' });
    const built = buildApp(store);
    app = built.app;
    const disconnect = vi.spyOn(agents, 'disconnect');
    const res = await app.inject({ method: 'POST', url: '/api/machines/m1/agent-token' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(AGENT_TOKEN_RE.test(body.agent_token)).toBe(true);
    expect(built.repos.rotateAgentToken).toHaveBeenCalledWith('m1', hashAgentToken(body.agent_token));
    expect(disconnect).toHaveBeenCalledWith('m1', CLOSE.UNAUTHORIZED, 'rotated');
  });

  it('rejects rotation on a non-agent machine (400)', async () => {
    store.m1 = makeMachine({ id: 'm1', type: 'ssh', host: 'example.com' });
    ({ app } = buildApp(store));
    const res = await app.inject({ method: 'POST', url: '/api/machines/m1/agent-token' });
    expect(res.statusCode).toBe(400);
  });
});

describe('PATCH /api/machines/:id (transport type is fixed)', () => {
  it('rejects changing type to agent (400)', async () => {
    store.m1 = makeMachine({ id: 'm1', type: 'ssh', host: 'example.com' });
    ({ app } = buildApp(store));
    const res = await app.inject({ method: 'PATCH', url: '/api/machines/m1', payload: { type: 'agent' } });
    expect(res.statusCode).toBe(400);
  });

  it('rejects changing type away from agent (400)', async () => {
    store.m1 = makeMachine({ id: 'm1', type: 'agent' });
    ({ app } = buildApp(store));
    const res = await app.inject({ method: 'PATCH', url: '/api/machines/m1', payload: { type: 'ssh', host: 'example.com' } });
    expect(res.statusCode).toBe(400);
  });

  it('still allows a plain rename', async () => {
    store.m1 = makeMachine({ id: 'm1', type: 'ssh', host: 'example.com' });
    ({ app } = buildApp(store));
    const res = await app.inject({ method: 'PATCH', url: '/api/machines/m1', payload: { name: 'renamed' } });
    expect(res.statusCode).toBe(200);
  });
});

describe('DELETE /api/machines/:id', () => {
  it('disconnects any live agent connection after deleting', async () => {
    store.m1 = makeMachine({ id: 'm1', type: 'agent' });
    ({ app } = buildApp(store));
    const disconnect = vi.spyOn(agents, 'disconnect');
    const res = await app.inject({ method: 'DELETE', url: '/api/machines/m1' });
    expect(res.statusCode).toBe(200);
    expect(disconnect).toHaveBeenCalledWith('m1', CLOSE.UNAUTHORIZED, 'deleted');
  });
});

describe('GET /api/machines/:id/status', () => {
  it('reports an offline agent without shelling out', async () => {
    store.m1 = makeMachine({ id: 'm1', type: 'agent', agent_version: '0.1.0', agent_last_seen_at: '2026-01-01T00:00:00.000Z' });
    ({ app } = buildApp(store));
    const res = await app.inject({ method: 'GET', url: '/api/machines/m1/status' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.online).toBe(false);
    expect(body.agent_version).toBe('0.1.0');
    expect(body.last_seen_at).toBe('2026-01-01T00:00:00.000Z');
    expect(execFile).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe('GET /api/machines/:id/simulators', () => {
  it('answers 409 for an agent machine, before the "is this a Mac" check', async () => {
    // No os/capabilities set (a freshly enrolled agent machine): the agent guard must run
    // before requireMac, or this would 400 with "Esta máquina não é um Mac com Xcode" instead.
    store.m1 = makeMachine({ id: 'm1', type: 'agent' });
    ({ app } = buildApp(store));
    const res = await app.inject({ method: 'GET', url: '/api/machines/m1/simulators' });
    expect(res.statusCode).toBe(409);
    expect(execFile).not.toHaveBeenCalled();
  });
});

describe('/api/machines/:id/hooks (monitor hooks on an agent machine)', () => {
  it('POST answers 409 without shelling out or minting a token', async () => {
    store.m1 = makeMachine({ id: 'm1', type: 'agent' });
    const built = buildApp(store);
    app = built.app;
    const res = await app.inject({ method: 'POST', url: '/api/machines/m1/hooks' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('Instalação de hooks ainda não disponível em máquinas com agente');
    expect(built.repos.machineHooks.upsert).not.toHaveBeenCalled();
    expect(execFile).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it('DELETE answers 409 and keeps whatever is stored', async () => {
    store.m1 = makeMachine({ id: 'm1', type: 'agent' });
    const built = buildApp(store);
    app = built.app;
    const res = await app.inject({ method: 'DELETE', url: '/api/machines/m1/hooks' });
    expect(res.statusCode).toBe(409);
    expect(built.repos.machineHooks.delete).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it('GET still answers for an agent machine (DB only)', async () => {
    store.m1 = makeMachine({ id: 'm1', type: 'agent' });
    ({ app } = buildApp(store));
    const res = await app.inject({ method: 'GET', url: '/api/machines/m1/hooks' });
    expect(res.statusCode).toBe(200);
    expect(res.json().installed_at).toBeNull();
  });
});
