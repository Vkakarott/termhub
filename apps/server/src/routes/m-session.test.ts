import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { describe, expect, it, vi } from 'vitest';
import type { Repositories } from '../db/repositories/index.js';
import type { Device } from '../db/repositories/devices.js';
import { applyErrorHandler, HttpError } from '../lib/errors.js';
import { JtiCache } from '../mobile/dpop.js';
import { DeviceLockedError, PinInvalidError, type SessionService } from '../mobile/session.js';
import { mobileSessionRoutes } from './m-session.js';

const BASE = 'https://termhub.dev';
const TOKEN_URL = '/api/m/v1/session/token';
const CHALLENGE = 'c'.repeat(43);
const nowSec = () => Math.floor(Date.now() / 1000);

async function keypair() {
  const { privateKey, publicKey } = await generateKeyPair('ES256');
  const jwk = await exportJWK(publicKey);
  const sign = (claims: Record<string, unknown>, headerJwk = jwk) =>
    new SignJWT({ iat: nowSec(), jti: randomUUID(), htm: 'POST', htu: `${BASE}${TOKEN_URL}`, chal: CHALLENGE, ...claims })
      .setProtectedHeader({ alg: 'ES256', typ: 'dpop+jwt', jwk: headerJwk })
      .sign(privateKey);
  return { jwk, sign };
}

const deviceRow = (jwk: object, status: 'active' | 'revoked' = 'active'): Device => ({
  id: 'd1',
  user_id: 'u1',
  name: 'iPhone',
  platform: 'ios',
  model: 'x',
  os_version: '18',
  app_version: '1.0.0',
  public_key: JSON.stringify(jwk),
  key_thumbprint: 't',
  pin_failures: 0,
  pin_locked_until: null,
  status,
  revoked_at: null,
  revoked_reason: null,
  push_token: null,
  last_seen_at: null,
  last_ip: null,
  request_id: null,
  created_at: '',
});

async function buildApp(opts: { device?: Device } = {}) {
  const key = await keypair();
  const device = opts.device ?? deviceRow(key.jwk);
  const session = {
    challenge: vi.fn(async () => ({ challenge: CHALLENGE, expires_at: '2026-09-24T12:01:00.000Z' })),
    refresh: vi.fn(async () => ({ access_token: 'thb_mob_' + 'A'.repeat(43), expires_in: 900 })),
    checkPin: vi.fn(),
  };
  const repos = {
    devices: {
      findActiveById: vi.fn(async (id: string) => (id === device.id && device.status === 'active' ? device : undefined)),
      findById: vi.fn(async (id: string) => (id === device.id ? device : undefined)),
    },
  };
  const app = Fastify();
  applyErrorHandler(app);
  app.register((a) => mobileSessionRoutes(a, repos as unknown as Repositories, { session: session as unknown as SessionService, jtis: new JtiCache(), publicUrl: BASE }), {
    prefix: '/api/m/v1/session',
  });
  const token = (proof: string, body: Record<string, unknown> = {}) =>
    app.inject({ method: 'POST', url: TOKEN_URL, headers: { dpop: proof }, payload: { device_id: 'd1', challenge: CHALLENGE, pin_proof: 'proof-x', ...body } });
  return { app, key, session, repos, device, token };
}

describe('POST /session/challenge', () => {
  it('validates the body with challengeBody', async () => {
    const { app, session } = await buildApp();
    const r = await app.inject({ method: 'POST', url: '/api/m/v1/session/challenge', payload: {} });
    expect(r.statusCode).toBe(400);
    expect(r.json().code).toBe('VALIDATION');
    expect(session.challenge).not.toHaveBeenCalled();
  });

  it('answers the challengeResponse for a refresh (purpose defaults to refresh, no action)', async () => {
    const { app, session } = await buildApp();
    const r = await app.inject({ method: 'POST', url: '/api/m/v1/session/challenge', payload: { device_id: 'd1' } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ challenge: CHALLENGE, expires_at: '2026-09-24T12:01:00.000Z' });
    expect(session.challenge).toHaveBeenCalledWith('d1', 'refresh', null);
  });

  it('a decision challenge carries its action_id, and requires one', async () => {
    const { app, session } = await buildApp();
    const ok = await app.inject({ method: 'POST', url: '/api/m/v1/session/challenge', payload: { device_id: 'd1', purpose: 'decision', action_id: 'act1' } });
    expect(ok.statusCode).toBe(200);
    expect(session.challenge).toHaveBeenCalledWith('d1', 'decision', 'act1');
    const bad = await app.inject({ method: 'POST', url: '/api/m/v1/session/challenge', payload: { device_id: 'd1', purpose: 'decision' } });
    expect(bad.statusCode).toBe(400);
  });

  it('passes the service errors through (404 DEVICE_NOT_FOUND)', async () => {
    const { app, session } = await buildApp();
    session.challenge.mockRejectedValueOnce(new HttpError(404, 'Aparelho não encontrado', 'DEVICE_NOT_FOUND'));
    const r = await app.inject({ method: 'POST', url: '/api/m/v1/session/challenge', payload: { device_id: 'd1' } });
    expect(r.statusCode).toBe(404);
    expect(r.json().code).toBe('DEVICE_NOT_FOUND');
  });
});

describe('POST /session/token', () => {
  it('verifies the device proof and answers the tokenResponse', async () => {
    const { key, session, token, device } = await buildApp();
    const r = await token(await key.sign({}));
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ access_token: 'thb_mob_' + 'A'.repeat(43), expires_in: 900 });
    expect(session.refresh).toHaveBeenCalledWith({ device, challenge: CHALLENGE, pin_proof: 'proof-x' }, { ip: expect.any(String) });
  });

  it('rejects an invalid body with 400 before anything else', async () => {
    const { key, session, token, repos } = await buildApp();
    const r = await token(await key.sign({}), { pin_proof: '' });
    expect(r.statusCode).toBe(400);
    expect(repos.devices.findActiveById).not.toHaveBeenCalled();
    expect(session.refresh).not.toHaveBeenCalled();
  });

  it('404 DEVICE_NOT_FOUND for an unknown device, 401 DEVICE_REVOKED for a revoked one', async () => {
    const a = await buildApp();
    const r1 = await a.token(await a.key.sign({}), { device_id: 'nope' });
    expect(r1.statusCode).toBe(404);
    expect(r1.json().code).toBe('DEVICE_NOT_FOUND');

    const key = await keypair();
    const b = await buildApp({ device: deviceRow(key.jwk, 'revoked') });
    const r2 = await b.token(await key.sign({}));
    expect(r2.statusCode).toBe(401);
    expect(r2.json().code).toBe('DEVICE_REVOKED');
    expect(b.session.refresh).not.toHaveBeenCalled();
  });

  it('Review Focus 1: a bad signature is 401 PROOF_INVALID and never reaches refresh/checkPin', async () => {
    const { key, session, token } = await buildApp();
    const attacker = await keypair();
    // The attacker signs with their own key but presents the device's stored jwk in the header.
    const r = await token(await attacker.sign({}, key.jwk));
    expect(r.statusCode).toBe(401);
    expect(r.json().code).toBe('PROOF_INVALID');
    expect(session.refresh).not.toHaveBeenCalled();
    expect(session.checkPin).not.toHaveBeenCalled();
  });

  it('a missing proof, a proof for another challenge or URL never reaches refresh', async () => {
    const { key, session, app } = await buildApp();
    const missing = await app.inject({ method: 'POST', url: TOKEN_URL, payload: { device_id: 'd1', challenge: CHALLENGE, pin_proof: 'p' } });
    expect(missing.statusCode).toBe(401);
    expect(missing.json().code).toBe('PROOF_MISSING');
    const other = await app.inject({ method: 'POST', url: TOKEN_URL, headers: { dpop: await key.sign({ chal: 'other' }) }, payload: { device_id: 'd1', challenge: CHALLENGE, pin_proof: 'p' } });
    expect(other.statusCode).toBe(401);
    expect(other.json().code).toBe('PROOF_CLAIM');
    const url = await app.inject({ method: 'POST', url: TOKEN_URL, headers: { dpop: await key.sign({ htu: `${BASE}/api/m/v1/other` }) }, payload: { device_id: 'd1', challenge: CHALLENGE, pin_proof: 'p' } });
    expect(url.statusCode).toBe(401);
    expect(url.json().code).toBe('PROOF_URL');
    expect(session.refresh).not.toHaveBeenCalled();
  });

  it('a replayed jti is 401 PROOF_REPLAYED', async () => {
    const { key, session, token } = await buildApp();
    const proof = await key.sign({});
    expect((await token(proof)).statusCode).toBe(200);
    const r = await token(proof);
    expect(r.statusCode).toBe(401);
    expect(r.json().code).toBe('PROOF_REPLAYED');
    expect(session.refresh).toHaveBeenCalledTimes(1);
  });

  it('a 423 from the service carries retry-after in whole seconds', async () => {
    const { key, session, token } = await buildApp();
    session.refresh.mockRejectedValueOnce(new DeviceLockedError(899_001));
    const r = await token(await key.sign({}));
    expect(r.statusCode).toBe(423);
    expect(r.headers['retry-after']).toBe('900');
    expect(r.json().code).toBe('DEVICE_LOCKED');
  });

  it('a wrong PIN answers 401 PIN_INVALID with the failure count', async () => {
    const { key, session, token } = await buildApp();
    session.refresh.mockRejectedValueOnce(new PinInvalidError(2));
    const r = await token(await key.sign({}));
    expect(r.statusCode).toBe(401);
    expect(r.json()).toEqual({ error: 'PIN incorreto', code: 'PIN_INVALID', failures: 2 });
  });
});
