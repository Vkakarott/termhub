import { describe, expect, it } from 'vitest';
import { nextTerminalName } from './tab-names.js';

describe('nextTerminalName', () => {
  it('picks a teammate name instead of "Terminal N"', () => {
    const name = nextTerminalName([]);
    expect(name).toMatch(/^[A-Z][a-z]+$/);
  });

  it('never repeats a name already used in the project', () => {
    const used: string[] = [];
    for (let i = 0; i < 60; i += 1) {
      const name = nextTerminalName(used);
      expect(used.map((n) => n.toLowerCase())).not.toContain(name.toLowerCase());
      used.push(name);
    }
  });

  it('ignores case and surrounding spaces when checking what is taken', () => {
    const used = [' alex ', 'BLAIR'];
    const name = nextTerminalName(used);
    expect(['alex', 'blair']).not.toContain(name.toLowerCase());
  });

  it('falls back to a numbered suffix once the pool runs out', () => {
    const used: string[] = [];
    for (let i = 0; i < 51; i += 1) used.push(nextTerminalName(used));
    expect(used[50]).toMatch(/ 2$/);
  });
});
