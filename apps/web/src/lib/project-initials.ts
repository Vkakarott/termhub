/**
 * What a project's square in the collapsed rail shows (spec 2026-09-23 app chrome §5): the first two
 * characters of its name, uppercased — one for a one-letter name. Counted by code point, so an emoji
 * is never cut in half; a blank name shows "?".
 */
export function projectInitials(name: string): string {
  const chars = Array.from(name.trim());
  return chars.length ? chars.slice(0, 2).join('').toUpperCase() : '?';
}
