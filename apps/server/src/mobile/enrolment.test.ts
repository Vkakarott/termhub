import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  // encryptSecret needs a key; config reads the env at import time.
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
});
vi.mock('../auth/permissions.js', async (orig) => ({ ...(await orig<typeof import('../auth/permissions.js')>()), canAccess: vi.fn(async () => true) }));
vi.mock('../auth/tokens.js', async (orig) => {
  const actual = await orig<typeof import('../auth/tokens.js')>();
  return { ...actual, hashToken: vi.fn(actual.hashToken) };
});

import type { FastifyBaseLogger } from 'fastify';
import { deviceRequestBody, verificationCodeSchema } from '@termhub/mobile-api';
import type { Repositories } from '../db/repositories/index.js';
import type { User } from '../db/repositories/types.js';
import type { DeviceRequest } from '../db/repositories/device-requests.js';
import type { Mail, Mailer } from '../email/mailer.js';
import { canAccess } from '../auth/permissions.js';
import { hashToken } from '../auth/tokens.js';
import { decryptSecret } from '../lib/crypto.js';
import { HttpError } from '../lib/errors.js';
import { hashEmail, MOBILE_TOKEN_RE } from './codes.js';
import { EnrolmentService, MAX_ACTIVE_DEVICES } from './enrolment.js';

const T0 = new Date('2026-09-24T12:00:00.000Z');
const MIN = 60_000;
const ctx = { ip: '1.2.3.4', country: 'BR', city: 'São Paulo' };
const webCtx = { ip: '9.9.9.9', country: 'BR', city: 'Goiânia' };
const jwk = { kty: 'EC', crv: 'P-256', x: 'f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU', y: 'x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0' };

const mkUser = (id: string, email: string, overrides: Partial<User> = {}): User =>
  ({ id, email, name: id, role_id: 'role_x', review_enabled_until: null, review_enabled_by: null, ...overrides }) as unknown as User;

const body = (email: string) =>
  deviceRequestBody.parse({ email, public_key: jwk, device: { platform: 'ios', model: 'iPhone 15', os_version: '18.1', name: 'iPhone de Pedro' }, app_version: '1.0.0+12' });

type Row = DeviceRequest & { request_secret_hash: string };

const row = (overrides: Partial<Row> = {}): Row => ({
  id: 'r1',
  user_id: 'u1',
  email_hash: hashEmail('pedro@x.com'),
  public_key: JSON.stringify(jwk),
  key_thumbprint: 'tp1',
  platform: 'ios',
  model: 'iPhone 15',
  os_version: '18.1',
  device_name: 'iPhone de Pedro',
  app_version: '1.0.0+12',
  verification_code: 'K7F2QD',
  status: 'pending',
  ip: '1.2.3.4',
  country: 'BR',
  city: 'São Paulo',
  created_at: T0.toISOString(),
  expires_at: new Date(T0.getTime() + 10 * MIN).toISOString(),
  decided_at: null,
  activate_until: null,
  request_secret_hash: hashToken('thb_req_secret'),
  ...overrides,
});

function build(opts: { users?: User[]; pending?: number; active?: number; rows?: Row[]; markActivated?: boolean; mailFails?: boolean } = {}) {
  const users = opts.users ?? [];
  const rows = new Map<string, Row>((opts.rows ?? []).map((r) => [r.id, r]));
  let n = 0;
  const strip = ({ request_secret_hash: _h, ...r }: Row): DeviceRequest => r;
  const repos = {
    users: {
      findByEmail: vi.fn(async (email: string) => users.find((u) => u.email === email)),
      findById: vi.fn(async (id: string) => users.find((u) => u.id === id)),
    },
    deviceRequests: {
      create: vi.fn(async (input: Record<string, unknown>) => {
        const r = {
          ...row(),
          ...input,
          id: `r_new${++n}`,
          status: (input.status as string) ?? 'pending',
          created_at: new Date().toISOString(),
          expires_at: (input.expires_at as Date).toISOString(),
          activate_until: input.activate_until ? (input.activate_until as Date).toISOString() : null,
        } as Row;
        rows.set(r.id, r);
        return strip(r);
      }),
      findById: vi.fn(async (id: string) => (rows.has(id) ? strip(rows.get(id)!) : undefined)),
      findByIdWithSecretHash: vi.fn(async (id: string) => {
        const r = rows.get(id);
        return r ? { request: strip(r), request_secret_hash: r.request_secret_hash } : undefined;
      }),
      countPendingForUser: vi.fn(async () => opts.pending ?? 0),
      countSinceByEmailHash: vi.fn(async () => 0),
      decide: vi.fn(async (id: string, userId: string, status: 'approved' | 'denied', now: Date, activateUntil: Date | null) => {
        const r = rows.get(id);
        if (!r || r.user_id !== userId || r.status !== 'pending' || new Date(r.expires_at) <= now) return undefined;
        Object.assign(r, { status, decided_at: now.toISOString(), activate_until: activateUntil?.toISOString() ?? null });
        return strip(r);
      }),
      markActivated: vi.fn(async (id: string) => {
        if (opts.markActivated === false) return false;
        const r = rows.get(id);
        if (!r || r.status !== 'approved') return false;
        r.status = 'activated';
        return true;
      }),
      listExpirable: vi.fn(async () => [...rows.values()].map(strip)),
      expireOlderThan: vi.fn(async () => rows.size),
    },
    devices: {
      create: vi.fn(async (input: Record<string, unknown>) => ({ ...input, id: 'd1', status: 'active' })),
      countActive: vi.fn(async () => opts.active ?? 0),
    },
    deviceSessions: { createToken: vi.fn(async () => undefined) },
    deviceEvents: { record: vi.fn(async () => undefined) },
  };
  const mails: Mail[] = [];
  const mailer: Mailer = {
    send: vi.fn(async (m: Mail) => {
      if (opts.mailFails) throw Object.assign(new Error('smtp down for pedro@x.com'), { code: 'ECONNREFUSED' });
      mails.push(m);
    }),
  };
  const log = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as FastifyBaseLogger;
  const service = new EnrolmentService({ repos: repos as unknown as Repositories, mailer, appUrl: 'https://app.termhub.dev', log, now: () => new Date() });
  return { service, repos, mails, mailer, log, rows };
}

const reject = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as HttpError;
  }
  throw new Error('expected a rejection');
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  vi.mocked(canAccess).mockReset();
  vi.mocked(canAccess).mockImplementation(async (_repos, user) => user?.id === 'u1');
  vi.mocked(hashToken).mockClear();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('EnrolmentService.request — neutral response', () => {
  const allowed = mkUser('u1', 'pedro@x.com');
  const noGrant = mkUser('u2', 'maria@x.com');

  it('answers the same shape for a known, an unknown and an ungranted e-mail; only the real one is mailed', async () => {
    const cases = ['pedro@x.com', 'ninguem@x.com', 'maria@x.com'];
    const results = [];
    for (const email of cases) {
      const b = build({ users: [allowed, noGrant] });
      const res = await b.service.request(body(email), ctx);
      results.push({ res, b, email });
    }
    const keys = results.map(({ res }) => Object.keys(res).sort().join(','));
    expect(new Set(keys).size).toBe(1);
    for (const { res, b, email } of results) {
      expect(verificationCodeSchema.safeParse(res.verification_code).success).toBe(true);
      expect(res.expires_at).toBe(new Date(T0.getTime() + 10 * MIN).toISOString());
      expect(res.poll_after).toBe(2000);
      expect(b.repos.deviceRequests.create).toHaveBeenCalledTimes(1);
      const arg = b.repos.deviceRequests.create.mock.calls[0][0] as Record<string, unknown>;
      expect(arg.email_hash).toBe(hashEmail(email));
      expect(arg.public_key).toBe(JSON.stringify(jwk));
      expect(arg.status).toBe('pending');
      const written = JSON.stringify([b.repos.deviceRequests.create.mock.calls, b.repos.deviceEvents.record.mock.calls]);
      expect(written).not.toContain(email);
    }
    const [real, unknown, ungranted] = results;
    expect((real.b.repos.deviceRequests.create.mock.calls[0][0] as { user_id: string | null }).user_id).toBe('u1');
    expect((unknown.b.repos.deviceRequests.create.mock.calls[0][0] as { user_id: string | null }).user_id).toBeNull();
    expect((ungranted.b.repos.deviceRequests.create.mock.calls[0][0] as { user_id: string | null }).user_id).toBeNull();
    expect(real.b.mails).toHaveLength(1);
    expect(real.b.mails[0].to).toBe('pedro@x.com');
    expect(unknown.b.mails).toHaveLength(0);
    expect(ungranted.b.mails).toHaveLength(0);
    expect(real.b.repos.deviceEvents.record).toHaveBeenCalledWith(expect.objectContaining({ kind: 'request_created', user_id: 'u1', actor: 'user' }));
    expect(unknown.b.repos.deviceEvents.record).not.toHaveBeenCalled();
    expect(ungranted.b.repos.deviceEvents.record).not.toHaveBeenCalled();
  });

  it('normalises the e-mail before the lookup and the limiter', async () => {
    const b = build({ users: [allowed] });
    await b.service.request(body('  Pedro@X.com '), ctx);
    expect(b.repos.users.findByEmail).toHaveBeenCalledWith('pedro@x.com');
    expect((b.repos.deviceRequests.create.mock.calls[0][0] as { email_hash: string }).email_hash).toBe(hashEmail('pedro@x.com'));
    await b.service.request(body('PEDRO@x.com'), ctx);
    await b.service.request(body('pedro@x.com'), ctx);
    const err = await reject(b.service.request(body(' pedro@X.COM'), ctx));
    expect(err.statusCode).toBe(429);
  });

  it('survives a failing mailer and logs no address', async () => {
    const b = build({ users: [allowed], mailFails: true });
    const res = await b.service.request(body('pedro@x.com'), ctx);
    expect(res.request_id).toBeTruthy();
    expect(b.log.warn).toHaveBeenCalled();
    expect(JSON.stringify(vi.mocked(b.log.warn).mock.calls)).not.toContain('pedro@x.com');
  });
});

describe('EnrolmentService.request — limits', () => {
  const allowed = mkUser('u1', 'pedro@x.com');

  it('refuses the 4th request for one e-mail inside 10 minutes, before the user lookup', async () => {
    const b = build({ users: [allowed] });
    for (let i = 0; i < 3; i++) await b.service.request(body('pedro@x.com'), { ...ctx, ip: `10.0.0.${i}` });
    const err = await reject(b.service.request(body('pedro@x.com'), { ...ctx, ip: '10.0.0.9' }));
    expect(err).toBeInstanceOf(HttpError);
    expect(err.statusCode).toBe(429);
    expect(err.code).toBe('RATE_LIMITED');
    expect(b.repos.users.findByEmail).toHaveBeenCalledTimes(3);
    expect(b.repos.deviceRequests.create).toHaveBeenCalledTimes(3);
  });

  it('refuses the 11th request from one IP', async () => {
    const b = build();
    for (let i = 0; i < 10; i++) await b.service.request(body(`p${i}@x.com`), ctx);
    const err = await reject(b.service.request(body('p99@x.com'), ctx));
    expect(err.statusCode).toBe(429);
    expect(err.code).toBe('RATE_LIMITED');
    expect(b.repos.deviceRequests.create).toHaveBeenCalledTimes(10);
  });

  it('turns the 4th pending request of an account into a decoy with no mail', async () => {
    const b = build({ users: [allowed], pending: 3 });
    await b.service.request(body('pedro@x.com'), ctx);
    expect((b.repos.deviceRequests.create.mock.calls[0][0] as { user_id: string | null }).user_id).toBeNull();
    expect(b.mails).toHaveLength(0);
    expect(b.repos.deviceEvents.record).not.toHaveBeenCalled();
  });

  it('stops mailing after 5 in an hour but keeps the rows real', async () => {
    const b = build({ users: [allowed] });
    for (let i = 0; i < 6; i++) {
      if (i === 3) vi.setSystemTime(new Date(T0.getTime() + 11 * MIN)); // past the per-e-mail window
      await b.service.request(body('pedro@x.com'), { ...ctx, ip: `10.0.0.${i}` });
    }
    expect(b.repos.deviceRequests.create).toHaveBeenCalledTimes(6);
    for (const [arg] of b.repos.deviceRequests.create.mock.calls) expect((arg as { user_id: string }).user_id).toBe('u1');
    expect(b.mails).toHaveLength(5);
  });
});

describe('EnrolmentService.request — review account', () => {
  it('creates the row already approved, records the auto-approval and still mails', async () => {
    const reviewer = mkUser('u1', 'review@x.com', { review_enabled_until: new Date(T0.getTime() + 60 * MIN).toISOString() });
    const b = build({ users: [reviewer] });
    const res = await b.service.request(body('review@x.com'), ctx);
    const arg = b.repos.deviceRequests.create.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.status).toBe('approved');
    expect(arg.activate_until).toEqual(new Date(T0.getTime() + 10 * MIN));
    expect(b.repos.deviceEvents.record).toHaveBeenCalledWith(expect.objectContaining({ kind: 'review_auto_approved', actor: 'system', user_id: 'u1', request_id: res.request_id }));
    expect(b.mails).toHaveLength(1);
    expect(b.repos.deviceRequests.decide).not.toHaveBeenCalled();
  });

  it('is an ordinary pending request once the flag is in the past', async () => {
    const reviewer = mkUser('u1', 'review@x.com', { review_enabled_until: new Date(T0.getTime() - MIN).toISOString() });
    const b = build({ users: [reviewer] });
    await b.service.request(body('review@x.com'), ctx);
    const arg = b.repos.deviceRequests.create.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.status).toBe('pending');
    expect(arg.activate_until).toBeNull();
    expect(b.repos.deviceEvents.record).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'review_auto_approved' }));
  });

  it('reads the flag once: turning it on later does not approve a pending request', async () => {
    const reviewer = mkUser('u1', 'review@x.com');
    const b = build({ users: [reviewer] });
    const res = await b.service.request(body('review@x.com'), ctx);
    reviewer.review_enabled_until = new Date(T0.getTime() + 60 * MIN).toISOString();
    expect(await b.service.poll(res.request_id, res.request_secret)).toEqual({ status: 'pending' });
    expect(b.repos.deviceRequests.decide).not.toHaveBeenCalled();
  });

  it('never auto-approves a decoy even when the flag is on', async () => {
    const reviewer = mkUser('u2', 'review@x.com', { review_enabled_until: new Date(T0.getTime() + 60 * MIN).toISOString() });
    const b = build({ users: [reviewer] }); // canAccess only grants u1
    await b.service.request(body('review@x.com'), ctx);
    const arg = b.repos.deviceRequests.create.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.user_id).toBeNull();
    expect(arg.status).toBe('pending');
  });
});

describe('EnrolmentService.poll', () => {
  const secret = 'thb_req_secret';
  const past = new Date(T0.getTime() - MIN).toISOString();
  const future = new Date(T0.getTime() + 5 * MIN).toISOString();

  it.each([
    ['pending', row(), 'pending'],
    ['pending past expiry', row({ expires_at: past }), 'closed'],
    ['approved in window', row({ status: 'approved', activate_until: future }), 'approved'],
    ['approved past window', row({ status: 'approved', activate_until: past }), 'closed'],
    ['denied', row({ status: 'denied' }), 'closed'],
    ['expired', row({ status: 'expired' }), 'closed'],
    ['activated', row({ status: 'activated' }), 'closed'],
    ['decoy', row({ user_id: null }), 'closed'],
  ] as const)('%s → %s', async (_label, r, expected) => {
    const b = build({ rows: [r as Row] });
    expect(await b.service.poll('r1', secret)).toEqual({ status: expected });
  });

  it('answers closed for an unknown id or a wrong secret, hashing the given secret', async () => {
    const b = build({ rows: [row()] });
    expect(await b.service.poll('nope', secret)).toEqual({ status: 'closed' });
    expect(await b.service.poll('r1', 'thb_req_wrong')).toEqual({ status: 'closed' });
    expect(hashToken).toHaveBeenCalledWith('thb_req_wrong');
  });
});

describe('EnrolmentService.approve / deny', () => {
  const user = mkUser('u1', 'pedro@x.com');

  it('approves through decide with a 10-minute activation window and records the web caller', async () => {
    const b = build({ rows: [row()] });
    const r = await b.service.approve('r1', user, webCtx);
    expect(r.status).toBe('approved');
    expect(b.repos.deviceRequests.decide).toHaveBeenCalledWith('r1', 'u1', 'approved', T0, new Date(T0.getTime() + 10 * MIN));
    expect(b.repos.deviceEvents.record).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'request_approved', user_id: 'u1', request_id: 'r1', actor: 'user', ip: '9.9.9.9', country: 'BR', city: 'Goiânia' }),
    );
  });

  it('refuses with DEVICE_LIMIT at 5 active devices', async () => {
    const b = build({ rows: [row()], active: MAX_ACTIVE_DEVICES });
    const err = await reject(b.service.approve('r1', user, webCtx));
    expect(err.statusCode).toBe(409);
    expect(err.code).toBe('DEVICE_LIMIT');
    expect(err.message).toBe('Revogue um aparelho antes');
    expect(b.repos.deviceRequests.decide).not.toHaveBeenCalled();
  });

  it("answers 404 for another user's row or an unknown id", async () => {
    const b = build({ rows: [row({ user_id: 'u9' })] });
    expect((await reject(b.service.approve('r1', user, webCtx))).statusCode).toBe(404);
    expect((await reject(b.service.approve('nope', user, webCtx))).statusCode).toBe(404);
    expect((await reject(b.service.deny('r1', user, webCtx))).statusCode).toBe(404);
  });

  it('answers 409 CODE_EXPIRED for a pending row past its expiry', async () => {
    const b = build({ rows: [row({ expires_at: new Date(T0.getTime() - MIN).toISOString() })] });
    const err = await reject(b.service.approve('r1', user, webCtx));
    expect(err.statusCode).toBe(409);
    expect(err.code).toBe('CODE_EXPIRED');
  });

  it('denies through decide and records request_denied', async () => {
    const b = build({ rows: [row()], active: MAX_ACTIVE_DEVICES });
    const r = await b.service.deny('r1', user, webCtx);
    expect(r.status).toBe('denied');
    expect(b.repos.deviceRequests.decide).toHaveBeenCalledWith('r1', 'u1', 'denied', T0, null);
    expect(b.repos.deviceEvents.record).toHaveBeenCalledWith(expect.objectContaining({ kind: 'request_denied', ip: '9.9.9.9' }));
  });
});

describe('EnrolmentService.activate', () => {
  const user = mkUser('u1', 'pedro@x.com');
  const secret = 'thb_req_secret';
  const approved = () => row({ status: 'approved', activate_until: new Date(T0.getTime() + 5 * MIN).toISOString() });
  const proof = { jwk: jwk as JsonWebKey, thumbprint: 'tp1' };
  const input = { request_id: 'r1', request_secret: secret };

  it('creates the device, a 15-minute token and records the activation', async () => {
    const b = build({ users: [user], rows: [approved()], active: 4 });
    const res = await b.service.activate(input, proof, ctx);
    expect(res.expires_in).toBe(900);
    expect(res.access_token).toMatch(MOBILE_TOKEN_RE);
    const created = b.repos.devices.create.mock.calls[0][0] as Record<string, unknown>;
    expect(created).toMatchObject({ user_id: 'u1', name: 'iPhone de Pedro', platform: 'ios', model: 'iPhone 15', key_thumbprint: 'tp1', public_key: JSON.stringify(jwk), request_id: 'r1' });
    expect(decryptSecret(created.pin_secret_enc as string)).toBe(res.pin_secret);
    expect(b.repos.deviceSessions.createToken).toHaveBeenCalledWith('d1', hashToken(res.access_token), new Date(T0.getTime() + 15 * MIN));
    expect(b.repos.deviceRequests.markActivated).toHaveBeenCalledWith('r1');
    expect(b.repos.deviceRequests.markActivated.mock.invocationCallOrder[0]).toBeLessThan(b.repos.devices.create.mock.invocationCallOrder[0]);
    expect(b.repos.deviceEvents.record).toHaveBeenCalledWith(expect.objectContaining({ kind: 'device_activated', user_id: 'u1', device_id: 'd1', request_id: 'r1' }));
    expect(res.device.id).toBe('d1');
  });

  it('never hands the plain pin secret or access token to a repository', async () => {
    const b = build({ users: [user], rows: [approved()] });
    const res = await b.service.activate(input, proof, ctx);
    const calls = JSON.stringify(Object.values(b.repos).flatMap((repo) => Object.values(repo).map((fn) => (fn as ReturnType<typeof vi.fn>).mock.calls)));
    expect(calls).not.toContain(res.pin_secret);
    expect(calls).not.toContain(res.access_token);
    expect(JSON.stringify(vi.mocked(b.log.warn).mock.calls)).not.toContain(res.access_token);
  });

  it('refuses a proof from another key with PROOF_KEY_MISMATCH', async () => {
    const b = build({ users: [user], rows: [approved()] });
    const err = await reject(b.service.activate(input, { ...proof, thumbprint: 'other' }, ctx));
    expect(err.statusCode).toBe(401);
    expect(err.code).toBe('PROOF_KEY_MISMATCH');
    expect(b.repos.devices.create).not.toHaveBeenCalled();
  });

  it('refuses a pending request with NOT_APPROVED', async () => {
    const b = build({ users: [user], rows: [row()] });
    const err = await reject(b.service.activate(input, proof, ctx));
    expect(err.statusCode).toBe(409);
    expect(err.code).toBe('NOT_APPROVED');
  });

  it('refuses past the activation window with CODE_EXPIRED', async () => {
    const b = build({ users: [user], rows: [row({ status: 'approved', activate_until: new Date(T0.getTime() - MIN).toISOString() })] });
    const err = await reject(b.service.activate(input, proof, ctx));
    expect(err.statusCode).toBe(409);
    expect(err.code).toBe('CODE_EXPIRED');
  });

  it('answers 404 for a wrong secret or an unknown id', async () => {
    const b = build({ users: [user], rows: [approved()] });
    expect((await reject(b.service.activate({ ...input, request_secret: 'thb_req_wrong' }, proof, ctx))).statusCode).toBe(404);
    expect((await reject(b.service.activate({ ...input, request_id: 'nope' }, proof, ctx))).statusCode).toBe(404);
  });

  it('re-checks the device limit and the grant', async () => {
    const full = build({ users: [user], rows: [approved()], active: MAX_ACTIVE_DEVICES });
    expect((await reject(full.service.activate(input, proof, ctx))).code).toBe('DEVICE_LIMIT');
    vi.mocked(canAccess).mockImplementation(async () => false);
    const revoked = build({ users: [user], rows: [approved()] });
    expect((await reject(revoked.service.activate(input, proof, ctx))).statusCode).toBe(403);
    expect(revoked.repos.devices.create).not.toHaveBeenCalled();
  });

  it('creates nothing when markActivated loses the race with expiry', async () => {
    const b = build({ users: [user], rows: [approved()], markActivated: false });
    const err = await reject(b.service.activate(input, proof, ctx));
    expect(err.statusCode).toBe(409);
    expect(err.code).toBe('CODE_EXPIRED');
    expect(b.repos.devices.create).not.toHaveBeenCalled();
    expect(b.repos.deviceSessions.createToken).not.toHaveBeenCalled();
  });
});

describe('EnrolmentService.expire', () => {
  it('expires the rows and records request_expired only for real ones', async () => {
    const b = build({ rows: [row({ id: 'r1', expires_at: new Date(T0.getTime() - MIN).toISOString() }), row({ id: 'r2', user_id: null, expires_at: new Date(T0.getTime() - MIN).toISOString() })] });
    expect(await b.service.expire()).toBe(2);
    expect(b.repos.deviceRequests.expireOlderThan).toHaveBeenCalledWith(T0);
    expect(b.repos.deviceEvents.record).toHaveBeenCalledTimes(1);
    expect(b.repos.deviceEvents.record).toHaveBeenCalledWith(expect.objectContaining({ kind: 'request_expired', user_id: 'u1', request_id: 'r1', actor: 'system' }));
  });
});
