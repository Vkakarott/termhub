/**
 * The whole deep-link contract of the public city, in one place and testable on its own:
 * `/city/@nick` and `/city/@nick/<building>` — the city and one building (a published project). A
 * `?room=` from the links of the city by machine is not read, and a building id that matches nothing
 * (one of those old machine ids) falls back to the city on the page. main.tsx reads the nickname from
 * here before the page mounts; the page reads the rest of it on every move and on Back, and writes
 * it back through `cityPath`.
 */

/** Where the visitor stands, below the nickname. */
export interface Rest {
  building: string | null;
}

/**
 * One path segment as it was written. A malformed escape (a bare `%`) makes `decodeURIComponent`
 * throw, which at module level rendered a blank page: hand the raw segment on instead and let the
 * server answer it the same 404 as any other nickname that does not exist.
 */
function segment(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** The nickname of `/city/@nick[/…]`, without the `@` it is written with; '' when the path carries none. */
export function nicknameFromPath(pathname: string): string {
  const parts = pathname.split('/').filter(Boolean);
  return (segment(parts[1]) ?? '').replace(/^@/, '');
}

/** The building of `/city/@nick/<building>`; the query string is not part of the rest. */
export function restFromUrl(pathname: string): Rest {
  const parts = pathname.split('/').filter(Boolean);
  return { building: segment(parts[2]) };
}

/** The address of a rest, as the page pushes it and as a person shares it. */
export function cityPath(nickname: string, rest: Rest): string {
  return `/city/@${encodeURIComponent(nickname)}${rest.building ? `/${encodeURIComponent(rest.building)}` : ''}`;
}
