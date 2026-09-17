import { describe, expect, it } from 'vitest';
import { fnv1a, runnerSessionName, wdaPorts } from './ports.js';

describe('ports', () => {
  it('fnv1a é determinístico e diferente para strings diferentes', () => {
    expect(fnv1a('abc')).toBe(fnv1a('abc'));
    expect(fnv1a('abc')).not.toBe(fnv1a('abd'));
  });

  it('portas ficam na faixa 8100-8199 / 9100-9199 e são estáveis', () => {
    const udid = 'BAE07EB5-8CA8-4C6E-819A-A0240342FF00';
    const p = wdaPorts(udid);
    expect(p.wdaPort).toBeGreaterThanOrEqual(8100);
    expect(p.wdaPort).toBeLessThan(8200);
    expect(p.mjpegPort - p.wdaPort).toBe(1000);
    expect(wdaPorts(udid.toLowerCase())).toEqual(p);
  });

  it('nome da sessão tmux usa os 8 primeiros chars do udid em minúsculas', () => {
    expect(runnerSessionName('BAE07EB5-8CA8-4C6E-819A-A0240342FF00')).toBe('termhub-wda-bae07eb5');
  });
});
