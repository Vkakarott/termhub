import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Repositories } from '../db/repositories/index.js';
import type { Machine } from '../db/repositories/types.js';
import { applyErrorHandler } from '../lib/errors.js';
import { publicBus, type PublicChange } from '../public/bus.js';
import { machineRoutes } from './machines.js';

const machine = { id: 'm1', name: 'box', type: 'agent', owner_id: 'u1', public_id: 'x' } as Machine;

function buildApp() {
  const store: Record<string, Machine> = { m1: { ...machine } };
  const unpublishByMachine = vi.fn(async () => ['p1', 'p2']);
  const app = Fastify();
  applyErrorHandler(app);
  app.addHook('preHandler', async (request) => {
    request.user = { id: 'admin', role_id: 'r-admin' } as never;
    request.scope = { user: request.user, viewAs: { kind: 'all' }, ownerId: null, createAs: 'admin' } as never;
  });
  const repos = {
    roles: { findById: async () => ({ id: 'r-admin', is_admin: true }), permissionsOf: async () => [] },
    users: { findById: async (id: string) => ({ id }) },
    machines: {
      findById: async (id: string) => store[id],
      update: vi.fn(async (id: string, patch: Partial<Machine>) => (store[id] = { ...store[id]!, ...patch })),
    },
    projects: { unpublishByMachine },
  } as unknown as Repositories;
  app.register((a) => machineRoutes(a, repos), { prefix: '/machines' });
  return { app, unpublishByMachine };
}

describe('PATCH /machines/:id — owner transfer', () => {
  let changes: PublicChange[];
  let off: () => void;
  beforeEach(() => {
    changes = [];
    off = publicBus.subscribe((c) => changes.push(c));
  });
  afterEach(() => off());

  // Publishing is the owner's own decision (spec §4): the receiving owner never consented to it,
  // and the rooms must not move into their city on an admin's click.
  it('takes every project of the machine off the street when its owner changes, and tells open pages', async () => {
    const { app, unpublishByMachine } = buildApp();
    const res = await app.inject({ method: 'PATCH', url: '/machines/m1', payload: { owner_id: 'u2' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().machine.owner_id).toBe('u2');
    expect(unpublishByMachine).toHaveBeenCalledWith('m1');
    expect(changes).toEqual([
      { project_id: 'p1', is_public: false },
      { project_id: 'p2', is_public: false },
    ]);
  });

  it('also when the machine is left without an owner', async () => {
    const { app, unpublishByMachine } = buildApp();
    await app.inject({ method: 'PATCH', url: '/machines/m1', payload: { owner_id: null } });
    expect(unpublishByMachine).toHaveBeenCalledWith('m1');
  });

  it('leaves publishing alone when the owner does not change', async () => {
    const { app, unpublishByMachine } = buildApp();
    await app.inject({ method: 'PATCH', url: '/machines/m1', payload: { name: 'renamed' } });
    await app.inject({ method: 'PATCH', url: '/machines/m1', payload: { owner_id: 'u1' } });
    expect(unpublishByMachine).not.toHaveBeenCalled();
    expect(changes).toEqual([]);
  });
});
