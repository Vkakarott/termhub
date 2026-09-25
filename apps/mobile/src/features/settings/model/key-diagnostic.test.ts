// The device-key diagnostic (P§11.1, design spec §10 "manual, on a device"): every step against a
// dedicated key, never the enrolled one (vault key `key.diagnostic`).
import { __items } from '../../../../test/fakes/secure-store';
import type { DeviceKey } from '@/services/key/types';
import { SoftwareDeviceKey } from '@/services/key/software';
import { runKeyDiagnostic } from './key-diagnostic';

describe('runKeyDiagnostic', () => {
  beforeEach(() => __items.clear());

  it('reports every step ok over a real SoftwareDeviceKey', async () => {
    const key = new SoftwareDeviceKey('key.diagnostic');

    const result = await runKeyDiagnostic(key);

    expect(result.ok).toBe(true);
    expect(result.steps.map((s) => s.name)).toEqual(['create', 'exists', 'publicJwk', 'thumbprint', 'sign+verify', 'destroy']);
    expect(result.steps.every((s) => s.ok)).toBe(true);
    expect(result.steps.every((s) => s.detail === undefined)).toBe(true);
  });

  it('never touches the enrolled device key', async () => {
    const enrolled = new SoftwareDeviceKey('key.private');
    await enrolled.create();
    const enrolledJwk = await enrolled.publicJwk();

    await runKeyDiagnostic(new SoftwareDeviceKey('key.diagnostic'));

    expect(await enrolled.exists()).toBe(true);
    expect(await enrolled.publicJwk()).toEqual(enrolledJwk);
  });

  it('leaves nothing in the vault under key.diagnostic once it finishes', async () => {
    await runKeyDiagnostic(new SoftwareDeviceKey('key.diagnostic'));
    expect(__items.has('key.diagnostic')).toBe(false);
  });

  it('reports a thrown step as "falhou" with the error message as detail, never key material, and still runs destroy', async () => {
    let destroyed = false;
    const destroy = jest.fn(async () => {
      destroyed = true;
    });
    const key: DeviceKey = {
      create: async () => ({ kty: 'EC', crv: 'P-256', x: 'x', y: 'y' }),
      exists: async () => !destroyed,
      publicJwk: async () => ({ kty: 'EC', crv: 'P-256', x: 'x', y: 'y' }),
      sign: async () => {
        throw new Error('boom: secret material would go here');
      },
      destroy,
    };

    const result = await runKeyDiagnostic(key);

    expect(result.ok).toBe(false);
    const signStep = result.steps.find((s) => s.name === 'sign+verify')!;
    expect(signStep.ok).toBe(false);
    expect(signStep.detail).toBe('boom: secret material would go here');
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(result.steps.find((s) => s.name === 'destroy')?.ok).toBe(true);
  });

  it('fails the destroy step and its own detail when destroy() rejects, without throwing out of runKeyDiagnostic', async () => {
    const key: DeviceKey = {
      create: async () => ({ kty: 'EC', crv: 'P-256', x: 'x', y: 'y' }),
      exists: async () => true,
      publicJwk: async () => ({ kty: 'EC', crv: 'P-256', x: 'x', y: 'y' }),
      sign: async () => new Uint8Array(64),
      destroy: async () => {
        throw new Error('DESTROY_FAILED');
      },
    };

    const result = await runKeyDiagnostic(key);

    expect(result.ok).toBe(false);
    expect(result.steps.find((s) => s.name === 'destroy')).toMatchObject({ ok: false, detail: 'DESTROY_FAILED' });
  });

  it('fails the thumbprint step when the public key cannot be read', async () => {
    const key: DeviceKey = {
      create: async () => ({ kty: 'EC', crv: 'P-256', x: 'x', y: 'y' }),
      exists: async () => true,
      publicJwk: async () => {
        throw new Error('NO_PUBLIC_KEY');
      },
      sign: async () => new Uint8Array(64),
      destroy: async () => undefined,
    };

    const result = await runKeyDiagnostic(key);

    expect(result.steps.find((s) => s.name === 'thumbprint')).toMatchObject({ ok: false, detail: 'NO_PUBLIC_KEY' });
  });
});
