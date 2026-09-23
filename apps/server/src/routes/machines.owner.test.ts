import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Repositories } from '../db/repositories/index.js';
import type { Machine } from '../db/repositories/types.js';
import { applyErrorHandler } from '../lib/errors.js';
import { publicBus, type PublicChange, type RoomsGone } from '../public/bus.js';
import { monitorBus, type TabLifecycle } from '../monitor/bus.js';
import { machineRoutes } from './machines.js';

const machine = { id: 'm1', name: 'box', type: 'agent', owner_id: 'u1', public_id: 'x' } as Machine;
const TABS = [
  { id: 't1', project_id: 'p1', machine_id: 'm1', name: 'Ana', kind: 'terminal' },
  { id: 't2', project_id: 'p2', machine_id: 'm1', name: 'Bia', kind: 'terminal' },
];

function buildApp() {
  const store: Record<string, Machine> = { m1: { ...machine } };
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
      delete: vi.fn(async (id: string) => delete store[id]),
    },
    tabs: { listByMachine: vi.fn(async () => TABS) },
    // no `projects` on purpose: a transfer must not touch any project (nothing is unpublished)
  } as unknown as Repositories;
  app.register((a) => machineRoutes(a, repos), { prefix: '/machines' });
  return { app };
}

describe('PATCH /machines/:id — owner transfer', () => {
  let changes: PublicChange[];
  let gone: RoomsGone[];
  const offs: (() => void)[] = [];
  beforeEach(() => {
    changes = [];
    gone = [];
    offs.push(publicBus.subscribe((c) => changes.push(c)), publicBus.subscribeRoomsGone((g) => gone.push(g)));
  });
  afterEach(() => offs.splice(0).forEach((off) => off()));

  // Merge ruling 4: a city only shows machines its person owns (public/read.ts), so a transferred
  // machine leaves the old owner's city by that rule alone. Nothing is unpublished — the projects
  // belong to their owners, not to the machine — but open pages must drop the building at once.
  it('drops the building from open public pages when its owner changes, without unpublishing anything', async () => {
    const { app } = buildApp();
    const res = await app.inject({ method: 'PATCH', url: '/machines/m1', payload: { owner_id: 'u2' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().machine.owner_id).toBe('u2');
    expect(gone).toEqual([{ machine_id: 'm1' }]);
    expect(changes).toEqual([]);
  });

  it('also when the machine is left without an owner', async () => {
    const { app } = buildApp();
    const res = await app.inject({ method: 'PATCH', url: '/machines/m1', payload: { owner_id: null } });
    expect(res.statusCode).toBe(200);
    expect(gone).toEqual([{ machine_id: 'm1' }]);
    expect(changes).toEqual([]);
  });

  it('leaves the public city alone when the owner does not change', async () => {
    const { app } = buildApp();
    await app.inject({ method: 'PATCH', url: '/machines/m1', payload: { name: 'renamed' } });
    await app.inject({ method: 'PATCH', url: '/machines/m1', payload: { owner_id: 'u1' } });
    expect(gone).toEqual([]);
    expect(changes).toEqual([]);
  });

  it('drops the building from open public pages when the machine is deleted', async () => {
    const { app } = buildApp();
    const res = await app.inject({ method: 'DELETE', url: '/machines/m1' });
    expect(res.statusCode).toBe(200);
    expect(gone).toEqual([{ machine_id: 'm1' }]);
    expect(changes).toEqual([]);
  });
});

describe('PATCH /machines/:id — owner transfer on the monitor bus', () => {
  async function lifecycleDuring(work: () => Promise<unknown>): Promise<TabLifecycle[]> {
    const events: TabLifecycle[] = [];
    const off = monitorBus.subscribeLifecycle((e) => events.push(e));
    try {
      await work();
    } finally {
      off();
    }
    return events;
  }

  it('moves each of the machine\'s tabs from the old owner\'s sidebar to the new owner\'s', async () => {
    const { app } = buildApp();
    const events = await lifecycleDuring(() => app.inject({ method: 'PATCH', url: '/machines/m1', payload: { owner_id: 'u2' } }));
    expect(events).toEqual([
      { kind: 'removed', tab_id: 't1', project_id: 'p1', machine_id: 'm1', owner_id: 'u1' },
      { kind: 'upsert', tab: TABS[0], project_id: 'p1', machine_id: 'm1', owner_id: 'u2' },
      { kind: 'removed', tab_id: 't2', project_id: 'p2', machine_id: 'm1', owner_id: 'u1' },
      { kind: 'upsert', tab: TABS[1], project_id: 'p2', machine_id: 'm1', owner_id: 'u2' },
    ]);
  });

  it('publishes nothing when the owner does not change', async () => {
    const { app } = buildApp();
    const events = await lifecycleDuring(async () => {
      await app.inject({ method: 'PATCH', url: '/machines/m1', payload: { name: 'renamed' } });
      await app.inject({ method: 'PATCH', url: '/machines/m1', payload: { owner_id: 'u1' } });
    });
    expect(events).toEqual([]);
  });
});
