import { describe, expect, expectTypeOf, it } from 'vitest';
import { buildCityModel } from '../office/model';
import type { PublicBuilding, PublicCity, PublicRobot } from '../lib/types';
import { toBuildingEntries } from './api';

const ROBOT: PublicRobot = { id: 'x1', name: 'aba 1', kind: 'terminal', state: 'working', state_at: '2026-09-22T10:00:00.000Z', activity: 'coding', activity_verb: null, alive: true, progress: null };
const CITY: PublicCity = {
  nickname: 'pedro',
  owner_name: 'Pedro',
  short_url: null,
  buildings: [
    { id: 'b1', name: 'Engage Easy', robots: [ROBOT, { ...ROBOT, id: 'x2', name: 'aba 2', alive: false }] },
    { id: 'b2', name: 'Vazio', robots: [] },
  ],
};

describe('the public city as the office model', () => {
  it('has no machine anywhere in the public types', () => {
    expectTypeOf<keyof PublicBuilding>().toEqualTypeOf<'id' | 'name' | 'robots'>();
    expectTypeOf<keyof PublicCity>().toEqualTypeOf<'nickname' | 'owner_name' | 'short_url' | 'buildings'>();
    expectTypeOf<'machine_id' extends keyof PublicRobot ? true : false>().toEqualTypeOf<false>();
    expectTypeOf<'subtitle' extends keyof PublicRobot ? true : false>().toEqualTypeOf<false>();
  });

  it('makes one building per published project, its robots as desks in order', () => {
    const model = buildCityModel(toBuildingEntries(CITY), () => undefined);
    expect(model.buildings.map((b) => [b.id, b.name, b.desks.map((d) => d.id)])).toEqual([['b1', 'Engage Easy', ['x1', 'x2']], ['b2', 'Vazio', []]]);
    expect(model.buildings.map((b) => b.lit)).toEqual([true, false]);
  });

  it('gives the model no machine: no desk has a machine line or is dimmed for one, no building has a notice', () => {
    const entries = toBuildingEntries(CITY);
    expect(entries.machines).toEqual([]);
    const model = buildCityModel(entries, () => undefined);
    expect(model.buildings[0].desks.map((d) => [d.machine, d.dimmed])).toEqual([[null, false], [null, false]]);
    expect(model.buildings.map((b) => b.notice)).toEqual([null, null]);
  });

  it('never hands a machine or a subtitle to the model, even one smuggled into the payload', () => {
    const smuggled = {
      ...CITY,
      buildings: [{ ...CITY.buildings[0], machine: { name: 'MAQUINA-SECRETA' }, subtitle: 'MacBook do escritório secreto', robots: [{ ...ROBOT, machine_id: 'm-secreta' }] }],
    } as unknown as PublicCity;
    const entries = toBuildingEntries(smuggled);
    const model = buildCityModel(entries, () => undefined);
    for (const secret of ['MAQUINA-SECRETA', 'MacBook do escritório secreto', 'm-secreta']) {
      expect(JSON.stringify(entries)).not.toContain(secret);
      expect(JSON.stringify(model)).not.toContain(secret);
    }
  });
});
