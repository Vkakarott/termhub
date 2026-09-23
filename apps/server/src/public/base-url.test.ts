import { describe, expect, it } from 'vitest';
import { resolvePublicCityUrl } from './base-url.js';

describe('resolvePublicCityUrl', () => {
  it('takes PUBLIC_CITY_URL as given, without a trailing slash', () => {
    expect(resolvePublicCityUrl({ PUBLIC_CITY_URL: 'https://city.example.org/city/', HOOKS_URL: 'https://h.example.org/api/hooks/events', PUBLIC_URL: 'https://app.example.org' })).toBe('https://city.example.org/city');
  });

  // Production: PUBLIC_URL is the Access-protected app host, HOOKS_URL the open landing host.
  it('falls back to the host HOOKS_URL names, which is reachable without a session', () => {
    expect(resolvePublicCityUrl({ HOOKS_URL: 'https://termhub.dev/api/hooks/events', PUBLIC_URL: 'https://app.termhub.dev' })).toBe('https://termhub.dev/city');
  });

  it('falls back to PUBLIC_URL on a single-host instance', () => {
    expect(resolvePublicCityUrl({ PUBLIC_URL: 'http://localhost:3000/' })).toBe('http://localhost:3000/city');
  });
});
