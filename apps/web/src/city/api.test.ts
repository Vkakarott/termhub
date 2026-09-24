import { describe, expect, expectTypeOf, it } from 'vitest';
import { buildCityModel } from '../office/model';
import type { PublicBuilding, PublicCity, PublicRobot, PublicRoom } from '../lib/types';
import { toMachineEntries } from './api';

const CITY: PublicCity = {
  nickname: 'pedro',
  owner_name: 'Pedro',
  short_url: null,
  buildings: [{ id: 'b1', name: 'Jarvis', rooms: [{ id: 'r1', name: 'Engage Easy', robots: [] }] }],
};

/**
 * A machine's subtitle is the owner's own note about it: the public payload never carries one
 * (apps/server/src/public/city.test.ts), and the street's own types and adapter do not know it either,
 * so the sign on the street is the machine's name and nothing else even if a payload ever did.
 */
describe('the public city and a machine subtitle', () => {
  it('has no subtitle in the public types', () => {
    expectTypeOf<keyof PublicBuilding>().toEqualTypeOf<'id' | 'name' | 'rooms'>();
    expectTypeOf<keyof PublicCity>().toEqualTypeOf<'nickname' | 'owner_name' | 'short_url' | 'buildings'>();
    expectTypeOf<'subtitle' extends keyof PublicRoom | keyof PublicRobot ? true : false>().toEqualTypeOf<false>();
  });

  it('never hands a subtitle to the model, even one smuggled into the payload', () => {
    const smuggled = { ...CITY, buildings: [{ ...CITY.buildings[0], subtitle: 'MacBook do escritório secreto' }] } as unknown as PublicCity;
    const entries = toMachineEntries(smuggled);
    expect('subtitle' in entries[0]).toBe(false);
    expect(JSON.stringify(entries)).not.toContain('MacBook do escritório secreto');
    const model = buildCityModel(entries, () => undefined);
    expect(model.machines[0].subtitle).toBeNull();
    expect(JSON.stringify(model)).not.toContain('MacBook do escritório secreto');
  });
});
