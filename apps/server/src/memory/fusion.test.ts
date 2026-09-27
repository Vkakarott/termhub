import { describe, expect, it } from 'vitest';
import { rrf } from './fusion.js';

describe('rrf', () => {
  it('rewards keys present in both lists', () => {
    const out = rrf([[{ key: 'a', rank: 1 }, { key: 'b', rank: 2 }], [{ key: 'b', rank: 1 }, { key: 'c', rank: 2 }]]);
    expect(out.map((o) => o.key)).toEqual(['b', 'a', 'c']);
    expect(out[0]!.score).toBeCloseTo(1 / 62 + 1 / 61, 10);
  });
  it('handles an empty list (text-only or vector-only search)', () => {
    expect(rrf([[], [{ key: 'x', rank: 1 }]]).map((o) => o.key)).toEqual(['x']);
  });
});
