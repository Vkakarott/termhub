import { describe, expect, it } from 'vitest';
import { ease, frame, MAX_SCALE, MIN_SCALE, sameBox, settled, zoomAt } from './camera';

const screen = { width: 1000, height: 600 };

describe('frame', () => {
  it('centres the box and fits it inside the margin', () => {
    const v = frame({ x: -100, y: -50, w: 400, h: 200 }, screen, 50);
    expect(v.scale).toBeCloseTo(Math.min(900 / 400, 500 / 200));
    expect(v.x + (-100 + 200) * v.scale).toBeCloseTo(500);
    expect(v.y + (-50 + 100) * v.scale).toBeCloseTo(300);
  });
  it('caps the zoom for a tiny box and stays finite for an empty one or an empty screen', () => {
    expect(frame({ x: 0, y: 0, w: 10, h: 10 }, screen, 40, 2.5).scale).toBe(2.5);
    for (const v of [frame({ x: 0, y: 0, w: 0, h: 0 }, screen), frame({ x: 0, y: 0, w: 100, h: 100 }, { width: 0, height: 0 })]) {
      expect(Object.values(v).every(Number.isFinite)).toBe(true);
      expect(v.scale).toBeGreaterThanOrEqual(MIN_SCALE);
    }
  });
});

describe('sameBox', () => {
  it('is true only when all four numbers match, so a rebuild can tell a box that moved', () => {
    const box = { x: -12.5, y: 3, w: 400, h: 220 };
    expect(sameBox(box, { ...box })).toBe(true);
    for (const key of ['x', 'y', 'w', 'h'] as const) expect(sameBox(box, { ...box, [key]: box[key] + 0.5 })).toBe(false);
  });
});

describe('zoomAt', () => {
  it('keeps the world point under the cursor where it is', () => {
    const before = { x: 120, y: 40, scale: 1 };
    const after = zoomAt(before, 300, 200, 1.5);
    expect((300 - after.x) / after.scale).toBeCloseTo((300 - before.x) / before.scale);
    expect((200 - after.y) / after.scale).toBeCloseTo((200 - before.y) / before.scale);
  });
  it('clamps to the scale limits', () => {
    expect(zoomAt({ x: 0, y: 0, scale: 3.9 }, 0, 0, 10).scale).toBe(MAX_SCALE);
    expect(zoomAt({ x: 0, y: 0, scale: 0.2 }, 0, 0, 0.01).scale).toBe(MIN_SCALE);
  });
});

describe('ease / settled', () => {
  it('moves a fraction of the way and reports when it has arrived', () => {
    const t = { x: 100, y: 0, scale: 2 };
    expect(ease({ x: 0, y: 0, scale: 1 }, t, 0.5)).toEqual({ x: 50, y: 0, scale: 1.5 });
    expect(settled({ x: 99.95, y: 0, scale: 2 }, t)).toBe(true);
    expect(settled({ x: 90, y: 0, scale: 2 }, t)).toBe(false);
  });
});
