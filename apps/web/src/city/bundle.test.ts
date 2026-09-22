import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const dist = new URL('../../dist-city/assets', import.meta.url).pathname;

/**
 * The point of the second bundle: what goes to the street must not contain the private app. Skipped
 * until `npm run build:city` has run, so a plain `vitest run` on a clean checkout stays green.
 */
describe.skipIf(!existsSync(dist))('the public bundle', () => {
  it('does not carry the private app', () => {
    const js = readdirSync(dist).filter((f) => f.endsWith('.js')).map((f) => readFileSync(join(dist, f), 'utf8')).join('\n');
    // The first four are the app's routes as a person reads them. `lib/api.ts` builds its URLs as
    // `/api${path}` at runtime, so two of those never appear as literals even in the private bundle
    // — the three after them are what a leak would really drag in: the api client's own literals,
    // its CSRF cookie, and the monitor's channel.
    for (const marker of ['/api/machines', '/api/projects', '/ws/monitor', '/api/auth/me', '/api/auth/google', '/api/tabs/', 'termhub_csrf']) {
      expect(js).not.toContain(marker);
    }
  });
});
