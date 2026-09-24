import { describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import type { Repositories } from '../db/repositories/index.js';
import type { Device } from '../db/repositories/devices.js';
import type { Mailer } from '../email/mailer.js';
import { MobileSocketRegistry, revokeDevice, type RevokeInput } from './revocation.js';

const fakeSocket = () => ({ close: vi.fn() }) as unknown as WebSocket;

describe('MobileSocketRegistry', () => {
  it('tracks liveness per device and per user', () => {
    const registry = new MobileSocketRegistry();
    expect(registry.hasLive('d1')).toBe(false);
    expect(registry.liveDevices('u1')).toEqual(new Set());

    registry.add('d1', fakeSocket(), 'u1');
    expect(registry.hasLive('d1')).toBe(true);
    expect(registry.liveDevices('u1')).toEqual(new Set(['d1']));

    registry.add('d2', fakeSocket(), 'u1');
    expect(registry.liveDevices('u1')).toEqual(new Set(['d1', 'd2']));
  });

  it('closeDevice closes every live socket for that device and reports how many', () => {
    const registry = new MobileSocketRegistry();
    const a = fakeSocket();
    const b = fakeSocket();
    registry.add('d1', a, 'u1');
    registry.add('d1', b, 'u1');
    registry.add('d2', fakeSocket(), 'u1');

    expect(registry.closeDevice('d1', 4001, 'revoked')).toBe(2);
    expect(a.close).toHaveBeenCalledWith(4001, 'revoked');
    expect(b.close).toHaveBeenCalledWith(4001, 'revoked');
    expect(registry.closeDevice('d3', 4001, 'revoked')).toBe(0);
  });

  it('the release function returned by add() removes exactly that socket', () => {
    const registry = new MobileSocketRegistry();
    const a = fakeSocket();
    const b = fakeSocket();
    const releaseA = registry.add('d1', a, 'u1');
    registry.add('d1', b, 'u1');

    releaseA();
    expect(registry.hasLive('d1')).toBe(true); // b is still live
    expect(registry.liveDevices('u1')).toEqual(new Set(['d1']));

    const releaseB = registry.add('d1', b, 'u1'); // re-registering b: capture its own release
    void releaseB;
  });

  it('releasing the last socket of a device drops it from both maps, and is safe to call twice', () => {
    const registry = new MobileSocketRegistry();
    const a = fakeSocket();
    const release = registry.add('d1', a, 'u1');

    release();
    expect(registry.hasLive('d1')).toBe(false);
    expect(registry.liveDevices('u1')).toEqual(new Set());

    expect(() => release()).not.toThrow();
    expect(registry.hasLive('d1')).toBe(false);
  });

  it('liveDevices returns a snapshot: mutating it does not affect the registry', () => {
    const registry = new MobileSocketRegistry();
    registry.add('d1', fakeSocket(), 'u1');
    const snapshot = registry.liveDevices('u1');
    snapshot.add('d2');
    expect(registry.liveDevices('u1')).toEqual(new Set(['d1']));
  });
});

describe('MobileSocketRegistry.closeDevice removal', () => {
  it('closes with 4401 and removes that device from hasLive and liveDevices at once', () => {
    const registry = new MobileSocketRegistry();
    const a = fakeSocket();
    const b = fakeSocket();
    const releaseA = registry.add('d1', a, 'u1');
    registry.add('d1', b, 'u1');
    registry.add('d2', fakeSocket(), 'u1');

    expect(registry.closeDevice('d1', 4401, 'device revoked')).toBe(2);
    expect(a.close).toHaveBeenCalledWith(4401, 'device revoked');
    expect(b.close).toHaveBeenCalledWith(4401, 'device revoked');
    expect(registry.hasLive('d1')).toBe(false);
    expect(registry.liveDevices('u1')).toEqual(new Set(['d2']));
    expect(registry.closeDevice('d1', 4401, 'device revoked')).toBe(0);

    // The socket's own release, arriving later on 'close', is harmless.
    expect(() => releaseA()).not.toThrow();
    expect(registry.liveDevices('u1')).toEqual(new Set(['d2']));
  });
});

const T0 = new Date('2026-09-24T12:00:00.000Z');

const device: Device = {
  id: 'd1',
  user_id: 'u1',
  name: 'iPhone de Ana',
  platform: 'ios',
  model: 'iPhone 15',
  os_version: '18.0',
  app_version: '1.0.0+1',
  public_key: '{}',
  key_thumbprint: 'thumb',
  pin_failures: 0,
  pin_locked_until: null,
  status: 'revoked',
  revoked_at: T0.toISOString(),
  revoked_reason: 'user',
  push_token: 'ExponentPushToken[x]',
  last_seen_at: null,
  last_ip: null,
  request_id: null,
  created_at: T0.toISOString(),
};

function buildRevoke() {
  let active = true;
  const calls: string[] = [];
  const track = <A extends unknown[], R>(name: string, fn: (...args: A) => R) =>
    vi.fn((...args: A) => {
      calls.push(name);
      return fn(...args);
    });
  const repos = {
    devices: {
      revoke: track('revoke', async (_id: string, _reason: string, _now: Date) => {
        if (!active) return undefined;
        active = false;
        return device;
      }),
      setPushToken: track('setPushToken', async (_id: string, _token: string | null) => undefined),
    },
    deviceSessions: { deleteTokensForDevice: vi.fn(async (_id: string) => 1) },
    deviceEvents: { record: track('event', async (_e: unknown) => undefined) },
    users: { findById: vi.fn(async (id: string) => (id === 'u1' ? { id: 'u1', email: 'ana@example.com' } : undefined)) },
  };
  const sockets = new MobileSocketRegistry();
  const ws = fakeSocket();
  sockets.add('d1', ws, 'u1');
  const closeSpy = vi.spyOn(sockets, 'closeDevice');
  closeSpy.mockImplementation((...args) => {
    calls.push('close');
    return MobileSocketRegistry.prototype.closeDevice.apply(sockets, args);
  });
  const mailer = { send: vi.fn(async () => undefined) } satisfies Mailer;
  const deps = { repos: repos as unknown as Repositories, sockets, mailer, now: () => T0 };
  const run = (input: RevokeInput) => revokeDevice(deps, 'd1', input);
  return { repos, sockets, ws, mailer, run, calls };
}

describe('revokeDevice', () => {
  it('revokes, keeps the tokens, clears the push token, records the event, closes sockets with 4401, in that order', async () => {
    const t = buildRevoke();
    const r = await t.run({ reason: 'user', actor: 'user', ip: '1.2.3.4' });
    expect(r).toEqual(device);
    expect(t.repos.devices.revoke).toHaveBeenCalledWith('d1', 'user', T0);
    expect(t.repos.deviceSessions.deleteTokensForDevice).not.toHaveBeenCalled();
    expect(t.repos.devices.setPushToken).toHaveBeenCalledWith('d1', null);
    expect(t.repos.deviceEvents.record).toHaveBeenCalledWith({ user_id: 'u1', device_id: 'd1', kind: 'device_revoked', actor: 'user', ip: '1.2.3.4', meta: { reason: 'user' } });
    expect(t.ws.close).toHaveBeenCalledWith(4401, 'device revoked');
    expect(t.sockets.hasLive('d1')).toBe(false);
    expect(t.calls).toEqual(['revoke', 'setPushToken', 'event', 'close']);
    expect(t.mailer.send).not.toHaveBeenCalled();
  });

  it('records the actor it is given (an admin id)', async () => {
    const t = buildRevoke();
    await t.run({ reason: 'admin', actor: 'admin_u9' });
    expect(t.repos.deviceEvents.record).toHaveBeenCalledWith(expect.objectContaining({ actor: 'admin_u9', ip: null, meta: { reason: 'admin' } }));
    expect(t.mailer.send).not.toHaveBeenCalled();
  });

  it('mails the owner only for pin_bruteforce, naming the device', async () => {
    const t = buildRevoke();
    await t.run({ reason: 'pin_bruteforce', actor: 'system' });
    expect(t.mailer.send).toHaveBeenCalledTimes(1);
    const [mail] = t.mailer.send.mock.calls[0] as unknown as [{ to: string; subject: string; text: string }];
    expect(mail.to).toBe('ana@example.com');
    expect(mail.subject).toBe('Um aparelho foi removido da sua conta por tentativas de PIN');
    expect(mail.text).toContain('iPhone de Ana');
  });

  it('a mail failure does not undo or fail the revoke', async () => {
    const t = buildRevoke();
    t.mailer.send.mockRejectedValueOnce(new Error('smtp down'));
    await expect(t.run({ reason: 'pin_bruteforce', actor: 'system' })).resolves.toEqual(device);
  });

  it('is idempotent: a second call returns undefined and does nothing else', async () => {
    const t = buildRevoke();
    await t.run({ reason: 'pin_bruteforce', actor: 'system' });
    t.calls.length = 0;
    t.mailer.send.mockClear();
    t.repos.deviceEvents.record.mockClear();
    await expect(t.run({ reason: 'pin_bruteforce', actor: 'system' })).resolves.toBeUndefined();
    expect(t.calls).toEqual(['revoke']);
    expect(t.repos.deviceEvents.record).not.toHaveBeenCalled();
    expect(t.mailer.send).not.toHaveBeenCalled();
  });
});
