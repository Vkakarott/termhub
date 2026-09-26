import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

// Same reason as routes/tickets.test.ts: routes/setup.js -> control/tickets.js -> control/tasks.js
// reads config.publicUrl at import time, and config.js validates process.env on import.
vi.mock('../config.js', () => ({ config: { publicUrl: 'https://app.test' } }));

import type { Repositories } from '../db/repositories/index.js';
import { applyErrorHandler } from '../lib/errors.js';
import { setupRoutes } from './setup.js';

vi.mock('../setup/tickets-sync.js', () => ({
  syncProjectTickets: vi.fn(async () => ({ sources: [{ provider: 'github', integration_id: 'g', scope: 'a/b', error: 'Falha ao consultar github: 401' }], synced_at: 'now' })),
  lastSync: () => null,
}));

function build(saved: unknown[]) {
  const app = Fastify();
  applyErrorHandler(app);
  app.addHook('preHandler', async (request) => {
    request.scope = { user: { id: 'u1', role: 'admin' } as never, viewAs: { kind: 'self' }, ownerId: 'u1', createAs: 'u1' };
    request.user = { id: 'u1' } as never;
  });
  const pruneSource = vi.fn(async () => 2);
  const repos = {
    projects: { findById: vi.fn(async () => ({ id: 'p1', owner_id: 'u1' })) },
    integrations: { findById: vi.fn(async (id: string) => ({ id, owner_id: 'u1', provider: 'github', config: {} })) },
    machines: { findById: vi.fn() },
    projectSetup: {
      get: vi.fn(async () => ({ data: { ticket_sources: saved } })),
      save: vi.fn(async (_p: string, data: unknown) => ({ data })),
    },
    tickets: { pruneSource },
  } as unknown as Repositories;
  app.register((a) => setupRoutes(a, repos), { prefix: '/projects' });
  return { app, pruneSource };
}

const src = (scope: string) => ({ provider: 'github', integration_id: 'g', scope, filter: null, sync_minutes: 0 });

describe('setup routes', () => {
  it('saving without a source prunes that source\'s non-imported tickets', async () => {
    const { app, pruneSource } = build([src('a/b'), src('a/c')]);
    const res = await app.inject({ method: 'PUT', url: '/projects/p1/setup', payload: { ticket_sources: [src('a/b')] } });
    expect(res.statusCode).toBe(200);
    expect(pruneSource).toHaveBeenCalledExactlyOnceWith('p1', { integration_id: 'g', scope: 'a/c' });
  });

  it('refuses a duplicate source', async () => {
    const { app } = build([]);
    const res = await app.inject({ method: 'PUT', url: '/projects/p1/setup', payload: { ticket_sources: [src('a/b'), src('a/b')] } });
    expect(res.statusCode).toBe(400);
  });

  it('sync answers 502 when every source failed', async () => {
    const { app } = build([src('a/b')]);
    const res = await app.inject({ method: 'POST', url: '/projects/p1/tickets/sync' });
    expect(res.statusCode).toBe(502);
    expect(res.json().code).toBe('PROVIDER_ERROR');
  });
});
