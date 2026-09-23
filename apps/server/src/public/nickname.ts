/**
 * A nickname is the address of a public city (`/city/@<nickname>`), so it lives in the same space as
 * the paths around it: the reserved list is every first segment the public host already answers.
 */
export const RESERVED_NICKNAMES = ['city', 'api', 'ws', 'mcp', 'admin', 'www', 'static', 'assets', 'health', 'login', 'office'] as const;

const SHAPE = /^[a-z0-9]([a-z0-9-]{1,28})[a-z0-9]$/;

export function normalizeNickname(input: unknown): { ok: true; value: string } | { ok: false; reason: 'format' | 'reserved' } {
  if (typeof input !== 'string') return { ok: false, reason: 'format' };
  const value = input.trim().toLowerCase();
  // Reserved words are checked before the shape: 'ws' is only 2 characters (too short to ever be a
  // valid nickname on shape alone), yet it must still be refused as 'reserved', not 'format'.
  if ((RESERVED_NICKNAMES as readonly string[]).includes(value)) return { ok: false, reason: 'reserved' };
  if (!SHAPE.test(value)) return { ok: false, reason: 'format' };
  return { ok: true, value };
}
