import { describe, expect, it } from 'vitest';
import { cleanMemoryText, excerpt, memoryText } from './text.js';

describe('text', () => {
  describe('cleanMemoryText', () => {
    it('drops bidi and control characters but keeps newlines', () => {
      expect(cleanMemoryText('a‮b\u0007c\nd')).toBe('a b c\nd');
    });

    it('removes all control and bidi chars on one line (not just first)', () => {
      expect(cleanMemoryText('a\u0007b\u0007c‎d‎e')).toBe('a b c d e');
    });
  });

  describe('memoryText', () => {
    it('embeds title and text', () => {
      expect(memoryText({ title: 'T', text: 'x' })).toBe('T\nx');
    });

    it('cleans control and bidi chars in title and text', () => {
      expect(memoryText({ title: 'a\u0007b\u0007c', text: 'x‮y' })).not.toMatch(/[\u0007‮]/);
    });
  });

  describe('excerpt', () => {
    it('cuts excerpts', () => {
      expect(excerpt('a'.repeat(700))).toHaveLength(600);
    });
  });
});
