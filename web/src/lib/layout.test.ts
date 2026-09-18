import { describe, expect, it } from 'vitest';
import { cellCount, cellRects, PRESETS, type Preset } from './layout';

describe('PRESETS / cellCount', () => {
  it('tem os cinco presets com o número de células da spec', () => {
    expect(PRESETS.map((p) => [p.key, p.cells])).toEqual([
      ['single', 1],
      ['columns', 2],
      ['rows', 2],
      ['stack-left', 3],
      ['grid', 4],
    ]);
    expect(cellCount('grid')).toBe(4);
  });
});

describe('cellRects', () => {
  const W = 1001;
  const H = 601;
  const area = (r: { w: number; h: number }) => r.w * r.h;

  it('single ocupa tudo', () => {
    expect(cellRects('single', W, H)).toEqual([{ x: 0, y: 0, w: W, h: H }]);
  });

  it('columns: duas colunas com 1px de gap, esquerda depois direita', () => {
    const [a, b] = cellRects('columns', W, H);
    expect(a).toEqual({ x: 0, y: 0, w: 500, h: H });
    expect(b).toEqual({ x: 501, y: 0, w: 500, h: H });
  });

  it('rows: duas linhas, cima depois baixo', () => {
    const [a, b] = cellRects('rows', W, H);
    expect(a).toEqual({ x: 0, y: 0, w: W, h: 300 });
    expect(b).toEqual({ x: 0, y: 301, w: W, h: 300 });
  });

  it('stack-left: esquerda empilhada (cima, baixo) e direita inteira', () => {
    const [a, b, c] = cellRects('stack-left', W, H);
    expect(a).toEqual({ x: 0, y: 0, w: 500, h: 300 });
    expect(b).toEqual({ x: 0, y: 301, w: 500, h: 300 });
    expect(c).toEqual({ x: 501, y: 0, w: 500, h: H });
  });

  it('grid: esq-cima, esq-baixo, dir-cima, dir-baixo', () => {
    const r = cellRects('grid', W, H);
    expect(r).toEqual([
      { x: 0, y: 0, w: 500, h: 300 },
      { x: 0, y: 301, w: 500, h: 300 },
      { x: 501, y: 0, w: 500, h: 300 },
      { x: 501, y: 301, w: 500, h: 300 },
    ]);
  });

  it('gap configurável e retângulos nunca se sobrepõem', () => {
    for (const p of PRESETS.map((x) => x.key) as Preset[]) {
      const rects = cellRects(p, 640, 480, 4);
      for (let i = 0; i < rects.length; i++) {
        for (let j = i + 1; j < rects.length; j++) {
          const a = rects[i];
          const b = rects[j];
          const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
          expect(overlap, `${p} ${i}/${j}`).toBe(false);
        }
        expect(area(rects[i])).toBeGreaterThan(0);
      }
    }
  });

  it('área pequena não gera tamanhos negativos', () => {
    for (const r of cellRects('grid', 1, 1)) {
      expect(r.w).toBeGreaterThanOrEqual(0);
      expect(r.h).toBeGreaterThanOrEqual(0);
    }
  });
});
