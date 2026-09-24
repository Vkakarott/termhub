import { describe, expect, it } from 'vitest';
import { cityPath, nicknameFromPath, restFromUrl } from './url';

describe('the public city URL', () => {
  it('reads the two depths', () => {
    expect(nicknameFromPath('/city/@pedro')).toBe('pedro');
    expect(restFromUrl('/city/@pedro')).toEqual({ building: null });
    expect(restFromUrl('/city/@pedro/b1')).toEqual({ building: 'b1' });
  });

  it('round-trips an address it wrote itself', () => {
    const path = cityPath('pedro', { building: 'b1' });
    expect(path).toBe('/city/@pedro/b1');
    expect(nicknameFromPath(path)).toBe('pedro');
    expect(restFromUrl(path)).toEqual({ building: 'b1' });
    expect(cityPath('pedro', { building: null })).toBe('/city/@pedro');
  });

  it('escapes what it writes, and reads it back', () => {
    const path = cityPath('pedro', { building: 'a/b' });
    expect(path).toBe('/city/@pedro/a%2Fb');
    expect(restFromUrl(path)).toEqual({ building: 'a/b' });
  });

  it('never throws on a malformed escape, so the page can say the city is not there', () => {
    expect(nicknameFromPath('/city/@100%')).toBe('100%');
    expect(restFromUrl('/city/@pedro/%E0%A4%A')).toEqual({ building: '%E0%A4%A' });
  });

  it('answers empty for a path that carries no nickname', () => {
    expect(nicknameFromPath('/city/')).toBe('');
    expect(nicknameFromPath('/')).toBe('');
  });
});
