import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Repositories, WaitlistEntry } from '../db/repositories/index.js';
import type { User } from '../db/repositories/types.js';
import type { Role } from '../db/repositories/roles.js';
import type { Mail } from '../email/mailer.js';
import { applyErrorHandler } from '../lib/errors.js';
import { publicBus } from '../public/bus.js';
import { userRoutes } from './users.js';

const role: Role = { id: 'r-auth', name: 'AUTHENTICATED', label: 'Autenticado', description: null, is_system: true, is_admin: false, created_at: '' };

function entry(overrides: Partial<WaitlistEntry>): WaitlistEntry {
  return {
    id: 'w1', first_name: 'Ana', last_name: 'Lima', email: 'ana@gmail.com', phone_country: '55', phone_area: '62', phone_number: '999990000',
    phone: '+5562999990000', linkedin: null, github: null, locale: 'pt', source: 'landing', created_at: '2026-09-18T00:00:00.000Z', ...overrides,
  };
}

function user(overrides: Partial<User>): User {
  return {
    id: 'u-existing', email: 'ana@gmail.com', name: 'Ana', avatar_url: null, password_hash: null, google_id: null, role: 'member', role_id: role.id,
    invited_at: null, last_login_at: null, created_at: '', ...overrides,
  };
}

/** Stubbed repos, mailer and allowlist; the route under test is the waitlist → alpha invite. */
function buildApp(opts: { entries: WaitlistEntry[]; users?: User[]; sendError?: Error }) {
  const app = Fastify();
  applyErrorHandler(app);
  app.addHook('preHandler', async (request) => {
    request.user = user({ id: 'admin', name: 'Pedro', email: 'pedro@gmail.com' });
  });
  const users = [...(opts.users ?? [])];
  const created: Parameters<Repositories['users']['create']>[0][] = [];
  const marked: string[][] = [];
  const sent: Mail[] = [];
  const repos = {
    users: {
      findByEmail: async (email: string) => users.find((u) => u.email === email),
      create: async (input: Parameters<Repositories['users']['create']>[0]) => {
        created.push(input);
        const u = user({ id: `u-${created.length}`, email: input.email, name: input.name, role_id: input.role_id, invited_at: new Date().toISOString() });
        users.push(u);
        return u;
      },
    },
    roles: { findById: async (id: string) => (id === role.id ? role : undefined) },
    waitlist: {
      findByIds: async (ids: string[]) => opts.entries.filter((e) => ids.includes(e.id)),
      markInvited: async (ids: string[]) => {
        marked.push(ids);
      },
    },
  } as unknown as Repositories;
  const mailer = {
    send: vi.fn(async (mail: Mail) => {
      if (opts.sendError) throw opts.sendError;
      sent.push(mail);
    }),
  };
  const access = { add: vi.fn(), remove: vi.fn(), status: vi.fn() };
  app.register((instance) => userRoutes(instance, repos, { mailer, access: access as never }), { prefix: '/api/users' });
  return { app, created, marked, sent };
}

const invite = (app: ReturnType<typeof Fastify>, payload: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: '/api/users/invite-from-waitlist', payload });

describe('POST /api/users/invite-from-waitlist', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('creates a user per entry, sends the alpha e-mail in the entry locale and marks it invited', async () => {
    const { app, created, marked, sent } = buildApp({ entries: [entry({}), entry({ id: 'w2', email: 'bob@gmail.com', first_name: 'Bob', locale: 'en' })] });
    const res = await invite(app, { ids: ['w1', 'w2'], role_id: role.id });
    expect(res.statusCode).toBe(200);
    expect(created.map((c) => [c.email, c.name, c.role_id])).toEqual([
      ['ana@gmail.com', 'Ana Lima', role.id],
      ['bob@gmail.com', 'Bob Lima', role.id],
    ]);
    expect(sent.map((m) => [m.to, m.subject])).toEqual([
      ['ana@gmail.com', expect.stringContaining('Você está na alpha')],
      ['bob@gmail.com', expect.stringContaining("You're in the termhub alpha")],
    ]);
    expect(sent[0]!.text).toContain('https://77a.it/comunidadetermhub');
    expect(marked).toEqual([['w1', 'w2']]);
    const body = res.json();
    expect(body.results.map((r: { id: string; mail: { sent: boolean } }) => [r.id, r.mail.sent])).toEqual([
      ['w1', true],
      ['w2', true],
    ]);
  });

  it('reuses an existing user with the same e-mail instead of failing with 409', async () => {
    const existing = user({ id: 'u-existing' });
    const { app, created, marked, sent } = buildApp({ entries: [entry({})], users: [existing] });
    const res = await invite(app, { ids: ['w1'], role_id: role.id });
    expect(res.statusCode).toBe(200);
    expect(created).toHaveLength(0);
    expect(sent).toHaveLength(1);
    expect(marked).toEqual([['w1']]);
    expect(res.json().results[0]).toMatchObject({ id: 'w1', user_id: 'u-existing', existing: true });
  });

  it('reports an unknown id in the results without touching the others', async () => {
    const { app, created, marked } = buildApp({ entries: [entry({})] });
    const res = await invite(app, { ids: ['w1', 'nope'], role_id: role.id });
    expect(res.statusCode).toBe(200);
    expect(created).toHaveLength(1);
    expect(marked).toEqual([['w1']]);
    expect(res.json().results).toEqual([expect.objectContaining({ id: 'w1' }), { id: 'nope', error: 'Entry not found' }]);
  });

  it('still marks the entry and reports the mail failure when sending fails', async () => {
    const { app, marked } = buildApp({ entries: [entry({})], sendError: new Error('smtp down') });
    const res = await invite(app, { ids: ['w1'], role_id: role.id });
    expect(res.statusCode).toBe(200);
    expect(marked).toEqual([['w1']]);
    expect(res.json().results[0].mail).toEqual({ sent: false, error: 'smtp down' });
  });

  it('answers 400 for an unknown role', async () => {
    const { app } = buildApp({ entries: [entry({})] });
    const res = await invite(app, { ids: ['w1'], role_id: 'r-nope' });
    expect(res.statusCode).toBe(400);
  });
});

describe('DELETE /api/users/:id', () => {
  // The deleted person's nickname and city go with them: the public bus drops the memoised city
  // and hangs up every visitor watching it (public/read.ts, public/ws.ts).
  it('tells the public bus the owner is gone', async () => {
    const app = Fastify();
    applyErrorHandler(app);
    app.addHook('preHandler', async (request) => {
      request.user = user({ id: 'admin', name: 'Pedro', email: 'pedro@gmail.com' });
    });
    const del = vi.fn(async () => {});
    const repos = {
      users: { findById: async (id: string) => (id === 'u-ana' ? user({ id: 'u-ana' }) : undefined), delete: del },
      roles: { findById: async (id: string) => (id === role.id ? role : undefined) },
    } as unknown as Repositories;
    const access = { add: vi.fn(), remove: vi.fn(), status: vi.fn() };
    app.register((instance) => userRoutes(instance, repos, { mailer: { send: vi.fn() }, access: access as never }), { prefix: '/api/users' });
    const gone: unknown[] = [];
    const off = publicBus.subscribeOwnerGone((g) => gone.push(g));
    try {
      const res = await app.inject({ method: 'DELETE', url: '/api/users/u-ana' });
      expect(res.statusCode).toBe(200);
      expect(del).toHaveBeenCalledWith('u-ana');
      expect(gone).toEqual([{ owner_id: 'u-ana' }]);
    } finally {
      off();
    }
  });
});
