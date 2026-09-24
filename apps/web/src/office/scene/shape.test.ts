import { describe, expect, it } from 'vitest';
import type { BuildingModel, CityModel, DeskModel } from '../model';
import { shapeOf } from './shape';

const desk = (id: string, kind: DeskModel['kind'] = 'person', over: Partial<DeskModel> = {}) => ({ id, kind, pose: 'sit', marker: null, ...over }) as DeskModel;
const building = (id: string, desks: DeskModel[], over: Partial<BuildingModel> = {}) => ({ id, desks, lit: true, notice: null, needsYou: 0, ...over }) as BuildingModel;
const city = (...buildings: BuildingModel[]): CityModel => ({ buildings, needsYou: 0 });

describe('shapeOf', () => {
  it('is one b{d:kind} entry per building, in order', () => {
    expect(shapeOf(city(building('p1', [desk('t1'), desk('s1', 'phone')]), building('p2', [])))).toBe('p1{t1:person,s1:phone};p2{}');
  });
  it('ignores everything a repaint can handle: state, light, notices, who needs you', () => {
    const a = city(building('p1', [desk('t1')]));
    const b = city(building('p1', [desk('t1', 'person', { pose: 'type', marker: 'input' })], { lit: false, notice: 'offline', needsYou: 1 }));
    expect(shapeOf(b)).toBe(shapeOf(a));
  });
  it('changes when a desk or a building comes, goes, moves or changes kind', () => {
    const base = shapeOf(city(building('p1', [desk('t1'), desk('t2')])));
    for (const other of [
      city(building('p1', [desk('t1')])),
      city(building('p1', [desk('t2'), desk('t1')])),
      city(building('p1', [desk('t1'), desk('t2', 'phone')])),
      city(building('p1', [desk('t1'), desk('t2')]), building('p2', [])),
    ]) {
      expect(shapeOf(other)).not.toBe(base);
    }
  });
});
