import { describe, expect, it } from 'vitest';
import { cleanMemoryText, excerpt, memoryText } from './text.js';

describe('text', () => {
  describe('cleanMemoryText', () => {
    it('drops bidi and control characters but keeps newlines', () => {
      expect(cleanMemoryText('a‮b\u0007c\nd')).toBe('a b c\nd');
    });
  });

  describe('memoryText', () => {
    it('embeds title and text', () => {
      expect(memoryText({ title: 'T', text: 'x' })).toBe('T\nx');
    });
  });

  describe('excerpt', () => {
    it('cuts excerpts', () => {
      expect(excerpt('a'.repeat(700))).toHaveLength(600);
    });
  });
});
