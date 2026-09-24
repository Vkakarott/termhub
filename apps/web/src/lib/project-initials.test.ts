import { afterEach, describe, expect, it, vi } from 'vitest';
import { firstGraphemes, projectInitials } from './project-initials';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('projectInitials', () => {
  it('takes the first two letters of the name, uppercased', () => {
    expect(projectInitials('termhub')).toBe('TE');
  });
  it('keeps a one-letter name as that letter', () => {
    expect(projectInitials('x')).toBe('X');
  });
  it('ignores surrounding spaces and keeps accents', () => {
    expect(projectInitials('  ética ')).toBe('ÉT');
  });
  it('never splits an emoji in half', () => {
    expect(projectInitials('🚀rocket')).toBe('🚀R');
  });
  it('skips spaces between the characters it takes', () => {
    expect(projectInitials('🚀 Rocket')).toBe('🚀R');
    expect(projectInitials('a b')).toBe('AB');
  });
  it('keeps joined emoji and skin tones whole', () => {
    expect(projectInitials('👨‍👩‍👧x')).toBe('👨‍👩‍👧X');
    expect(projectInitials('👍🏽ok')).toBe('👍🏽O');
  });
  it('falls back to ? for a blank name', () => {
    expect(projectInitials('   ')).toBe('?');
  });
  it('still counts by code point where Intl.Segmenter is missing', () => {
    vi.stubGlobal('Intl', { ...Intl, Segmenter: undefined });
    expect(projectInitials('🚀 Rocket')).toBe('🚀R');
    expect(firstGraphemes('😀ana', 1)).toBe('😀');
  });
});
