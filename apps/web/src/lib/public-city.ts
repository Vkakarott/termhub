/**
 * The address of a user's public city: this instance's own base for public cities, as the server
 * tells it (never a hardcoded host, which on a self-hosted instance would hand out a link to somebody
 * else's city), plus the owner's nickname. Null until both are known.
 */
export function cityLinkFor(publicCityUrl: string | null, nickname: string | null): string | null {
  return nickname && publicCityUrl ? `${publicCityUrl}/@${encodeURIComponent(nickname)}` : null;
}
