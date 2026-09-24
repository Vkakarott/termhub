import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { buildCardSvg, renderCard, resolveFocus } from './card.js';
import type { PublicCity } from './city.js';

const city: PublicCity = {
  nickname: 'pedro',
  owner_name: 'Pedro',
  short_url: null,
  buildings: [
    { id: 'b1', name: 'Engage Easy', robots: [
      { id: 'x1', name: 'aba 1', kind: 'terminal', state: 'working', state_at: null, activity: 'coding', activity_verb: null, alive: true, progress: null },
      { id: 'x2', name: 'aba 2', kind: 'terminal', state: 'waiting_input', state_at: null, activity: null, activity_verb: null, alive: true, progress: null },
    ] },
    { id: 'b2', name: 'Vazio', robots: [] },
  ],
};

describe('the link preview card', () => {
  it('says whose city it is, how many projects it has and how many agents are working', () => {
    const svg = buildCardSvg(city, {});
    expect(svg).toContain('Pedro');
    expect(svg).toContain('2 projetos · 1 agente trabalhando');
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('width="1200"');
    expect(svg).toContain('height="630"');
  });

  it('names the project and counts only its own agents when the link points at a building', () => {
    expect(buildCardSvg(city, { building: 'b1' })).toContain('Engage Easy — 1 agente trabalhando');
    // §2.4: a published project with nobody in it right now is still a building with a card
    expect(buildCardSvg(city, { building: 'b2' })).toContain('Vazio — 0 agentes trabalhando');
    expect(buildCardSvg(city, { building: 'b1' })).not.toContain('projetos');
  });

  it('escapes a name that would otherwise break the drawing', () => {
    const hostile = { ...city, owner_name: 'Pedro & "cia" <b>', buildings: [{ ...city.buildings[0], name: 'a < b' }] };
    const svg = buildCardSvg(hostile, { building: 'b1' });
    expect(svg).not.toContain('<b>');
    expect(svg).toContain('&amp;');
    expect(svg).toContain('&lt;');
    expect(svg).toContain('&quot;');
  });

  // city-by-project §7: a building id of the old scheme (a machine's) is just an id that matches nothing
  it('falls back to the city card for an id that matches no building, an old machine id included', () => {
    expect(buildCardSvg(city, { building: 'old-machine-id' })).toContain('2 projetos · 1 agente trabalhando');
  });

  it('falls back to null instead of throwing when the rasteriser is missing', async () => {
    vi.stubEnv('TERMHUB_RSVG_BIN', '/nonexistent/rsvg-convert');
    await expect(renderCard('<svg xmlns="http://www.w3.org/2000/svg"/>')).resolves.toBeNull();
    vi.unstubAllEnvs();
  });

  it('strips control characters that would make the rasteriser fail to parse', () => {
    const hostile = { ...city, owner_name: 'Pedro\u0000\u0007 Bell' };
    const svg = buildCardSvg(hostile, {});
    expect(svg).not.toContain('\u0000');
    expect(svg).not.toContain('\u0007');
    expect(svg).toContain('Pedro Bell');
  });

  it('resolves an id from the query against the real city, and nothing for one that matches no building', () => {
    expect(resolveFocus(city, { building: 'b1' }).building?.name).toBe('Engage Easy');
    expect(resolveFocus(city, { building: 'not-a-real-id' }).building).toBeUndefined();
    expect(resolveFocus(city, {}).building).toBeUndefined();
  });

  it('resolves null instead of hanging when the rasteriser never exits', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'termhub-card-hang-'));
    const bin = join(dir, 'rsvg-convert');
    writeFileSync(bin, '#!/bin/sh\nsleep 30\n');
    chmodSync(bin, 0o755);
    vi.stubEnv('TERMHUB_RSVG_BIN', bin);
    vi.stubEnv('TERMHUB_RSVG_TIMEOUT_MS', '50');
    try {
      await expect(renderCard('<svg xmlns="http://www.w3.org/2000/svg"/>')).resolves.toBeNull();
    } finally {
      vi.unstubAllEnvs();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resolves null instead of buffering forever when the rasteriser floods stdout', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'termhub-card-flood-'));
    const bin = join(dir, 'rsvg-convert');
    // Emits well past a tiny cap, then hangs — a long timeout backstop proves it's the byte cap,
    // not the timeout, that ends this one.
    writeFileSync(bin, '#!/bin/sh\ndd if=/dev/zero bs=1024 count=64 2>/dev/null\nsleep 30\n');
    chmodSync(bin, 0o755);
    vi.stubEnv('TERMHUB_RSVG_BIN', bin);
    vi.stubEnv('TERMHUB_RSVG_MAX_BYTES', '1024');
    vi.stubEnv('TERMHUB_RSVG_TIMEOUT_MS', '5000');
    try {
      await expect(renderCard('<svg xmlns="http://www.w3.org/2000/svg"/>')).resolves.toBeNull();
    } finally {
      vi.unstubAllEnvs();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 2_000);
});
