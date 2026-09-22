import { describe, expect, it } from 'vitest';
import { isValidProjectKey, suggestProjectKey } from './project-key';

describe('isValidProjectKey', () => {
  it.each(['HC', 'TERMHUB', 'A1', 'ABCDEFGHIJ'])('accepts %s', (k) => expect(isValidProjectKey(k)).toBe(true));
  it.each(['h', 'hc', '1A', 'A', 'ABCDEFGHIJK', 'A-B', 'A B', '', 'Ç1'])('rejects %j', (k) => expect(isValidProjectKey(k)).toBe(false));
});

describe('suggestProjectKey', () => {
  it('uses the initials of a multi-word name', () => {
    expect(suggestProjectKey('Hub Community')).toBe('HC');
    expect(suggestProjectKey('meu app legal')).toBe('MAL');
  });
  it('uses the first three letters of a single word', () => {
    expect(suggestProjectKey('termhub')).toBe('TER');
    expect(suggestProjectKey('io')).toBe('IO');
  });
  it('strips accents and symbols, prefixes P when it would start with a digit', () => {
    expect(suggestProjectKey('Ação Ágil')).toBe('AA');
    expect(suggestProjectKey('42 things')).toBe('P4T');
    expect(suggestProjectKey('my-app')).toBe('MA');
  });
  it('caps at 10 chars and falls back to PRJ', () => {
    expect(suggestProjectKey('a b c d e f g h i j k l')).toBe('ABCDEFGHIJ');
    expect(suggestProjectKey('!!!')).toBe('PRJ');
    expect(suggestProjectKey('x')).toBe('PRJ');
  });
});
