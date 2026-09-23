import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../index.css', import.meta.url).pathname, 'utf8');

describe('the settings sidebar slide', () => {
  it('moves by transform for 150 ms', () => {
    expect(css).toMatch(/@keyframes chrome-slide-in\s*\{\s*from\s*\{\s*transform:\s*translateX\(-100%\);?\s*\}/);
    expect(css).toMatch(/\.chrome-slide-in\s*\{\s*animation:\s*chrome-slide-in 150ms ease-out;?\s*\}/);
  });

  it('does not move at all under reduced motion', () => {
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.chrome-slide-in\s*\{\s*animation:\s*none;?\s*\}\s*\}/);
  });
});
