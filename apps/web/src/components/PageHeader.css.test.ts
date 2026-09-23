import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../index.css', import.meta.url).pathname, 'utf8');
const rule = css.match(/\.header-scroll-fade\s*\{([^}]*)\}/)?.[1] ?? '';
const MASK = /linear-gradient\(to right, transparent, #000 1\.5rem, #000 calc\(100% - 1\.5rem\), transparent\)/.source;

describe('the page header scroll fade', () => {
  it('fades both edges, padded by the same amount so nothing is faded at rest', () => {
    expect(rule).toMatch(/padding-inline:\s*1\.5rem/);
    expect(rule).toMatch(new RegExp(`(?<!-webkit-)mask-image:\\s*${MASK}`));
    expect(rule).toMatch(new RegExp(`-webkit-mask-image:\\s*${MASK}`));
  });
});
