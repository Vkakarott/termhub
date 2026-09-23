import { describe, expect, it } from 'vitest';
import { projectInitials } from './project-initials';

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
  it('falls back to ? for a blank name', () => {
    expect(projectInitials('   ')).toBe('?');
  });
});
