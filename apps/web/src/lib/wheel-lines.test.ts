import { describe, expect, it } from 'vitest';
import { wheelLines } from './wheel-lines';

const PIXEL = 0;
const LINE = 1;
const PAGE = 2;
const at = (deltaY: number, deltaMode: number, carry = 0) => wheelLines({ deltaY, deltaMode }, carry, { cellHeight: 16, rows: 24 });

describe('wheelLines', () => {
  it('turns pixels into lines by the cell height, up negative and down positive', () => {
    expect(at(-48, PIXEL)).toEqual({ lines: -3, carry: 0 });
    expect(at(32, PIXEL)).toEqual({ lines: 2, carry: 0 });
  });

  it('takes line deltas as lines and page deltas as a screen of rows', () => {
    expect(at(-3, LINE)).toEqual({ lines: -3, carry: 0 });
    expect(at(1, PAGE)).toEqual({ lines: 24, carry: 0 });
    expect(at(-1, PAGE)).toEqual({ lines: -24, carry: 0 });
  });

  it('carries the fraction until it adds up to a line (trackpads send small deltas)', () => {
    let r = at(-6, PIXEL);
    expect(r.lines).toBe(0);
    r = at(-6, PIXEL, r.carry);
    expect(r.lines).toBe(0);
    r = at(-6, PIXEL, r.carry);
    expect(r.lines).toBe(-1);
    expect(r.carry).toBeCloseTo(-2 / 16);
  });

  it('drops the carry when the direction changes', () => {
    expect(at(8, PIXEL, -0.9)).toEqual({ lines: 0, carry: 0.5 });
  });

  it('never divides by a zero cell height, and ignores a horizontal-only wheel', () => {
    const r = wheelLines({ deltaY: -32, deltaMode: PIXEL }, 0, { cellHeight: 0, rows: 24 });
    expect(Number.isFinite(r.lines)).toBe(true);
    expect(r.lines).toBeLessThan(0);
    expect(at(0, PIXEL, -0.5)).toEqual({ lines: 0, carry: -0.5 });
  });
});
