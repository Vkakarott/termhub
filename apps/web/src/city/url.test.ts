import { describe, expect, it } from 'vitest';
import { cityPath, nicknameFromPath, restFromUrl } from './url';

describe('the public city URL', () => {
  it('reads the three depths', () => {
    expect(nicknameFromPath('/city/@pedro')).toBe('pedro');
    expect(restFromUrl('/city/@pedro', '')).toEqual({ building: null, room: null });
    expect(restFromUrl('/city/@pedro/b1', '')).toEqual({ building: 'b1', room: null });
    expect(restFromUrl('/city/@pedro/b1', '?room=r1')).toEqual({ building: 'b1', room: 'r1' });
  });

  it('round-trips an address it wrote itself', () => {
    const path = cityPath('pedro', { building: 'b1', room: 'r1' });
    expect(path).toBe('/city/@pedro/b1?room=r1');
    expect(nicknameFromPath(path.split('?')[0])).toBe('pedro');
    expect(restFromUrl(path.split('?')[0], '?room=r1')).toEqual({ building: 'b1', room: 'r1' });
    expect(cityPath('pedro', { building: null, room: null })).toBe('/city/@pedro');
  });

  it('escapes what it writes, and reads it back', () => {
    const path = cityPath('pedro', { building: 'a/b', room: 'r 1' });
    expect(path).toBe('/city/@pedro/a%2Fb?room=r%201');
    expect(restFromUrl('/city/@pedro/a%2Fb', '?room=r%201')).toEqual({ building: 'a/b', room: 'r 1' });
  });

  it('never throws on a malformed escape, so the page can say the city is not there', () => {
    expect(nicknameFromPath('/city/@100%')).toBe('100%');
    expect(restFromUrl('/city/@pedro/%E0%A4%A', '?room=%')).toEqual({ building: '%E0%A4%A', room: '%' });
  });

  it('answers empty for a path that carries no nickname', () => {
    expect(nicknameFromPath('/city/')).toBe('');
    expect(nicknameFromPath('/')).toBe('');
  });
});
