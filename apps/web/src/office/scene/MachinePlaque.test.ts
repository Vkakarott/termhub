import { describe, expect, it } from 'vitest';
import { allocateSign, layoutCity, SIGN_FOOTPRINT } from '../layout/city';
import { layoutFloor } from '../layout/floor';
import { ART_URLS } from '../pack/art';
import { machinePlaqueArtKey, machinePlaquePose, machinePlaqueSize } from './MachinePlaque';

describe('SIGN_FOOTPRINT', () => {
  it('matches a 1-terminal office bay', () => {
    expect(SIGN_FOOTPRINT).toEqual({ width: 5, height: 4 });
  });
});

describe('machinePlaqueSize', () => {
  it('is always the large size, regardless of office count', () => {
    expect(machinePlaqueSize(1)).toEqual(machinePlaqueSize(9));
    expect(machinePlaqueSize(2).spriteW).toBe(140);
  });
});

describe('machinePlaqueArtKey', () => {
  it('asks for machine-signin/lg, which does not ship yet, so the plaque is drawn procedurally', () => {
    expect(machinePlaqueArtKey(1)).toBe('machine-signin/lg');
    expect(ART_URLS['machine-signin/lg']).toBeUndefined();
  });
});

describe('machinePlaquePose', () => {
  it('sits one tile toward the walls from the bay centre, not on a room', () => {
    const city = layoutCity([{ id: 'a', rooms: [{ id: 'r1', desks: 2 }, { id: 'r2', desks: 2 }, { id: 'r3', desks: 2 }] }]);
    const block = city.blocks[0]!;
    expect(block.sign.width).toBe(SIGN_FOOTPRINT.width);
    expect(block.sign.height).toBe(SIGN_FOOTPRINT.height);
    const pose = machinePlaquePose(block);
    expect(pose.gx).toBeCloseTo(block.origin.gx + block.sign.origin.gx + block.sign.width / 2 - 1);
    expect(pose.gy).toBeCloseTo(block.origin.gy + block.sign.origin.gy + block.sign.height / 2 - 1);
    for (const room of block.floor.rooms) {
      const inside =
        pose.gx >= room.origin.gx &&
        pose.gx < room.origin.gx + room.layout.width &&
        pose.gy >= room.origin.gy &&
        pose.gy < room.origin.gy + room.layout.height;
      expect(inside).toBe(false);
    }
  });
});

describe('allocateSign bay', () => {
  it('reserves a 1-terminal office bay on the front line', () => {
    const floor = layoutFloor([
      { id: 'r1', desks: 2 },
      { id: 'r2', desks: 2 },
      { id: 'r3', desks: 2 },
    ]);
    const front = Math.max(...floor.rooms.map((r) => r.origin.gy + r.layout.height));
    const sized = allocateSign(floor);
    expect(sized.sign).toMatchObject(SIGN_FOOTPRINT);
    expect(sized.sign.origin.gy + sized.sign.height).toBe(front);
    expect(sized.height).toBe(floor.height);
  });
});
