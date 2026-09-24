import { __items } from '../../test/fakes/secure-store';
import { vault } from './vault';

describe('vault', () => {
  beforeEach(() => __items.clear());

  it('round-trips a value and clears every key it owns', async () => {
    await vault.set('pin.salt', 'abc');
    expect(await vault.get('pin.salt')).toBe('abc');

    await vault.set('device.id', 'd1');
    await vault.clear();

    expect(await vault.get('pin.salt')).toBeNull();
    expect(await vault.get('device.id')).toBeNull();
  });
});
