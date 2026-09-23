import { describe, expect, it } from 'vitest';
import { SPINNER_VERB } from '../monitor/state.js';
import { publicSpinnerVerb } from './spinner-verbs.js';

describe('publicSpinnerVerb', () => {
  it('lets the well-known defaults through', () => {
    for (const v of ['Accomplishing', 'Clauding', 'Moonwalking', 'Reticulating', 'Schlepping', 'Wrangling', 'Zigzagging']) expect(publicSpinnerVerb(v)).toBe(v);
  });

  it('answers null for anything else', () => {
    for (const v of [null, undefined, '', 'Deploying', 'moonwalking', 'Moonwalking…', 'Sautéing', 'Dilly-dallying', 'hasOwnProperty']) expect(publicSpinnerVerb(v)).toBeNull();
  });

  it('only lists words the monitor accepts at all', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('./spinner-verbs.ts', import.meta.url), 'utf8');
    const listed = [...src.matchAll(/^ {2}'.*$/gm)].flatMap((m) => [...m[0].matchAll(/'([^']*)'/g)].map((x) => x[1]));
    expect(listed.length).toBeGreaterThan(150);
    for (const v of listed) {
      expect(SPINNER_VERB.safeParse(v).success).toBe(true);
      expect(publicSpinnerVerb(v)).toBe(v);
    }
  });
});
