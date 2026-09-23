import { describe, expect, it } from 'vitest';
import { normalizeNickname, RESERVED_NICKNAMES } from './nickname.js';

describe('normalizeNickname', () => {
  it('accepts a plain nickname and lowercases it', () => {
    expect(normalizeNickname('Pedro')).toEqual({ ok: true, value: 'pedro' });
    expect(normalizeNickname('  eng-inversa  ')).toEqual({ ok: true, value: 'eng-inversa' });
  });

  it('refuses what cannot be an address', () => {
    for (const bad of ['', 'ab', 'a'.repeat(31), 'pedro!', 'pedro goiania', 'pe_dro', '-pedro', 'pedro-', 'pedrõ', 42, null, undefined, {}]) {
      expect(normalizeNickname(bad as unknown)).toEqual({ ok: false, reason: 'format' });
    }
  });

  it('refuses the words the routes need', () => {
    for (const word of RESERVED_NICKNAMES) {
      expect(normalizeNickname(word)).toEqual({ ok: false, reason: 'reserved' });
      expect(normalizeNickname(word.toUpperCase())).toEqual({ ok: false, reason: 'reserved' });
    }
    expect(RESERVED_NICKNAMES).toContain('city');
    expect(RESERVED_NICKNAMES).toContain('api');
  });
});
