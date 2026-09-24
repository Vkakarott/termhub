import { sha256 } from '@noble/hashes/sha2.js';
import { b64url, fromB64url, fromUtf8, utf8 } from '../crypto/encoding';
import { SoftwareDeviceKey } from '../key/software';
import type { VaultKey } from '../vault';
import { createHttpMobileApi } from './client';
import type { Transport } from './transport';

function scripted(answers: Array<{ status: number; headers?: Record<string, string>; body: unknown }>) {
  const calls: Array<{ method: string; url: string; headers: Record<string, string>; body?: string }> = [];
  const transport: Transport = {
    fetch: async (req) => {
      calls.push(req);
      const a = answers.shift()!;
      return { status: a.status, headers: { date: new Date(NOW * 1000).toUTCString(), ...(a.headers ?? {}) }, text: JSON.stringify(a.body) };
    },
    connect: () => {
      throw new Error('not in this test');
    },
  };
  return { transport, calls };
}

const NOW = 1_800_000_000;
// Any vault slot works under the fake secure store; `key.create()` below seeds it.
const key = new SoftwareDeviceKey('pin.salt' as VaultKey);

beforeAll(async () => {
  await key.create();
});

const make = (t: Transport, onTokenExpired = jest.fn(async () => null as string | null)) =>
  createHttpMobileApi({ transport: t, baseUrl: 'https://termhub.dev', app: 'ios/0.1.0+1', key, onTokenExpired, now: () => NOW * 1000 });

const dpopPayload = (dpop: string) => JSON.parse(fromUtf8(fromB64url(dpop.split('.')[1]!))) as Record<string, unknown>;

it('sends the app header, bearer and a DPoP proof bound to method, canonical url and token hash', async () => {
  const { transport, calls } = scripted([{ status: 200, body: { projects: [] } }]);
  const api = make(transport);
  await api.chatProjects({ accessToken: 'tok' });
  expect(calls[0]!.headers['X-Termhub-App']).toBe('ios/0.1.0+1');
  expect(calls[0]!.headers.Authorization).toBe('Bearer tok');
  const payload = dpopPayload(calls[0]!.headers.DPoP!);
  expect(payload).toMatchObject({ htm: 'GET', htu: 'https://termhub.dev/api/m/v1/chat/projects', ath: b64url(sha256(utf8('tok'))) });
  expect(calls[0]!.url).toBe('https://termhub.dev/api/m/v1/chat/projects');
});

it('corrects iat by the skew learned from the Date header', async () => {
  const { transport, calls } = scripted([
    { status: 200, headers: { date: new Date((NOW + 180) * 1000).toUTCString() }, body: { projects: [] } },
    { status: 200, body: { projects: [] } },
  ]);
  const api = make(transport);
  await api.chatProjects({ accessToken: 'tok' });
  await api.chatProjects({ accessToken: 'tok' });
  const second = dpopPayload(calls[1]!.headers.DPoP!);
  expect(second.iat).toBe(NOW + 180);
  expect(api.skewSeconds).toBe(180);
});

it('renews once on TOKEN_EXPIRED and retries with the new token; a second 401 surfaces', async () => {
  const { transport, calls } = scripted([
    { status: 401, body: { error: 'x', code: 'TOKEN_EXPIRED' } },
    { status: 200, body: { projects: [] } },
  ]);
  const renew = jest.fn(async () => 'tok2');
  await make(transport, renew).chatProjects({ accessToken: 'tok' });
  expect(renew).toHaveBeenCalledTimes(1);
  expect(calls[1]!.headers.Authorization).toBe('Bearer tok2');
});

it('only TOKEN_EXPIRED triggers renewal: DEVICE_REVOKED, PROOF_REPLAYED and APP_TOO_OLD surface untouched', async () => {
  for (const [status, code] of [
    [401, 'DEVICE_REVOKED'],
    [401, 'PROOF_REPLAYED'],
    [426, 'APP_TOO_OLD'],
  ] as const) {
    const renew = jest.fn(async () => 'tok2');
    const { transport } = scripted([{ status, body: { error: 'x', code } }]);
    await expect(make(transport, renew).chatProjects({ accessToken: 'tok' })).rejects.toMatchObject({ status, code });
    expect(renew).not.toHaveBeenCalled();
  }
});

it('refuses a body that does not match the contract', async () => {
  const { transport } = scripted([{ status: 200, body: { nope: 1 } }]);
  await expect(make(transport).chatProjects({ accessToken: 'tok' })).rejects.toMatchObject({ status: 502, code: 'BAD_RESPONSE' });
});

it('activate and token carry no ath; token carries chal', async () => {
  const { transport, calls } = scripted([
    { status: 200, body: { device_id: 'd1', pin_secret: 'ps', access_token: 'at1', expires_in: 900 } },
    { status: 200, body: { access_token: 'at2', expires_in: 900 } },
  ]);
  const api = make(transport);

  await api.activate({ request_id: 'r1', request_secret: 's1' });
  const activatePayload = dpopPayload(calls[0]!.headers.DPoP!);
  expect(activatePayload.ath).toBeUndefined();
  expect(activatePayload.chal).toBeUndefined();
  expect(calls[0]!.headers.Authorization).toBeUndefined();

  await api.token({ device_id: 'd1', challenge: 'chal123', pin_proof: 'proof123' });
  const tokenPayload = dpopPayload(calls[1]!.headers.DPoP!);
  expect(tokenPayload.ath).toBeUndefined();
  expect(tokenPayload.chal).toBe('chal123');
  expect(calls[1]!.headers.Authorization).toBeUndefined();
});
