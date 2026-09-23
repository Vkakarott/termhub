/**
 * The first `count` visible characters of `text`, whitespace skipped. Counted by grapheme through
 * Intl.Segmenter where it exists, so a joined emoji (👨‍👩‍👧) or one with a skin tone stays whole; by
 * code point otherwise, which at least never cuts a surrogate pair in half.
 */
export function firstGraphemes(text: string, count: number): string {
  const Segmenter = typeof Intl !== 'undefined' ? Intl.Segmenter : undefined;
  const chars = Segmenter ? Array.from(new Segmenter(undefined, { granularity: 'grapheme' }).segment(text), (s) => s.segment) : Array.from(text);
  return chars
    .filter((c) => c.trim() !== '')
    .slice(0, count)
    .join('');
}

/**
 * What a project's square in the collapsed rail shows (spec 2026-09-23 app chrome §5): the first two
 * characters of its name, uppercased — one for a one-letter name; a blank name shows "?".
 */
export function projectInitials(name: string): string {
  return firstGraphemes(name, 2).toUpperCase() || '?';
}
