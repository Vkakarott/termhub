import { describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { MobileSocketRegistry } from './revocation.js';

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
    // closeDevice only asks the sockets to close; it does not itself remove them from the registry
    // (that happens through the release function each socket gets from `add`, on its own 'close').
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
