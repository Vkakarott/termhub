import { describe, expect, it, vi } from 'vitest';
import { buildCardSvg, renderCard } from './card.js';
import type { PublicCity } from './city.js';

const city: PublicCity = {
  nickname: 'pedro',
  owner_name: 'Pedro',
  buildings: [
    { id: 'b1', name: 'Jarvis', rooms: [{ id: 'r1', name: 'Engage Easy', robots: [
      { id: 'x1', name: 'aba 1', kind: 'terminal', state: 'working', state_at: null, activity: 'coding', alive: true, progress: null },
      { id: 'x2', name: 'aba 2', kind: 'terminal', state: 'waiting_input', state_at: null, activity: null, alive: true, progress: null },
    ] }] },
  ],
};

describe('the link preview card', () => {
  it('says whose city it is and what is happening in it', () => {
    const svg = buildCardSvg(city, {});
    expect(svg).toContain('Pedro');
    expect(svg).toContain('1 robô trabalhando');
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('width="1200"');
    expect(svg).toContain('height="630"');
  });

  it('names the building or the room when the link points at one', () => {
    expect(buildCardSvg(city, { building: 'b1' })).toContain('Jarvis');
    expect(buildCardSvg(city, { building: 'b1', room: 'r1' })).toContain('Engage Easy');
  });

  it('escapes a name that would otherwise break the drawing', () => {
    const hostile = { ...city, owner_name: 'Pedro & "cia" <b>', buildings: [{ ...city.buildings[0], name: 'a < b' }] };
    const svg = buildCardSvg(hostile, { building: 'b1' });
    expect(svg).not.toContain('<b>');
    expect(svg).toContain('&amp;');
    expect(svg).toContain('&lt;');
    expect(svg).toContain('&quot;');
  });

  it('falls back to null instead of throwing when the rasteriser is missing', async () => {
    vi.stubEnv('TERMHUB_RSVG_BIN', '/nonexistent/rsvg-convert');
    await expect(renderCard('<svg xmlns="http://www.w3.org/2000/svg"/>')).resolves.toBeNull();
    vi.unstubAllEnvs();
  });
});
