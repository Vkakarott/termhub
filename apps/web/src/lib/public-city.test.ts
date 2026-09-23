import { describe, expect, it } from 'vitest';
import { cityLinkFor } from './public-city';

describe('cityLinkFor', () => {
  it('builds the city address from the instance base and the nickname', () => {
    expect(cityLinkFor('https://termhub.dev/city', 'pedro')).toBe('https://termhub.dev/city/@pedro');
  });

  it('encodes the nickname', () => {
    expect(cityLinkFor('https://x.dev/city', 'a b')).toBe('https://x.dev/city/@a%20b');
  });

  it('has no link without a nickname or without the base', () => {
    expect(cityLinkFor('https://x.dev/city', null)).toBeNull();
    expect(cityLinkFor(null, 'pedro')).toBeNull();
  });
});
