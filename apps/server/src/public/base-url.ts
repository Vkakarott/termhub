/**
 * Where this instance's public cities live: `<base>/@nickname`. A leaf module (no config import) so
 * it can be tested on its own; `config.publicCityUrl` is its answer for the running process.
 *
 * The city is served by the app itself on any host (app.ts serves `/city/*`), but it is meant to be
 * reached on a host that has no login in front of it. So, in order:
 *   1. PUBLIC_CITY_URL, when set — e.g. https://termhub.dev/city;
 *   2. the origin of HOOKS_URL, when set — that variable already names the host that is reachable
 *      without a browser session (termhub.dev in production, where PUBLIC_URL is the Access-protected
 *      app.termhub.dev);
 *   3. PUBLIC_URL — a single-host self-hosted instance serves the city beside the app.
 */
export function resolvePublicCityUrl(env: { PUBLIC_CITY_URL?: string; HOOKS_URL?: string; PUBLIC_URL: string }): string {
  if (env.PUBLIC_CITY_URL) return env.PUBLIC_CITY_URL.replace(/\/+$/, '');
  if (env.HOOKS_URL) return `${new URL(env.HOOKS_URL).origin}/city`;
  return `${new URL(env.PUBLIC_URL).origin}/city`;
}
