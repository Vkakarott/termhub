import { describe, expect, it } from 'vitest';
import {
  cellCount,
  cellRects,
  clampFloating,
  emptyLayout,
  FLOATING_MARGIN,
  FLOATING_MIN,
  initialFloatingRect,
  layoutKey,
  loadLayout,
  placeOf,
  PRESETS,
  reduce,
  sanitize,
  saveLayout,
  type Layout,
  type Preset,
} from './layout';

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

const AREA = { width: 1000, height: 600 };
const L = (over: Partial<Layout> = {}): Layout => ({ ...emptyLayout('columns'), ...over });

describe('reduce', () => {
  it('assign coloca na célula focada', () => {
    const l = reduce(L({ focusedCell: 1 }), { type: 'assign', tabId: 'a' }, AREA);
    expect(l.cells).toEqual([null, 'a']);
  });

  it('assign de aba já em outra célula move o foco em vez de duplicar', () => {
    const l = reduce(L({ cells: ['a', 'b'], focusedCell: 1 }), { type: 'assign', tabId: 'a' }, AREA);
    expect(l.cells).toEqual(['a', 'b']);
    expect(l.focusedCell).toBe(0);
  });

  it('assign de aba flutuando não mexe nas células', () => {
    const l = L({ cells: ['a', null], floating: { tabId: 's', x: 0, y: 0, w: 300, h: 400 } });
    expect(reduce(l, { type: 'assign', tabId: 's' }, AREA)).toEqual(l);
  });

  it('assignTo tira a aba da célula anterior', () => {
    const l = reduce(L({ cells: ['a', 'b'] }), { type: 'assignTo', cell: 1, tabId: 'a' }, AREA);
    expect(l.cells).toEqual([null, 'a']);
    expect(l.focusedCell).toBe(1);
  });

  it('assignTo de aba flutuando encaixa na célula e fecha a janela flutuante', () => {
    const l = reduce(L({ cells: ['a', null], floating: { tabId: 's', x: 0, y: 0, w: 300, h: 400 } }), { type: 'assignTo', cell: 1, tabId: 's' }, AREA);
    expect(l.cells).toEqual(['a', 's']);
    expect(l.floating).toBeNull();
    expect(l.focusedCell).toBe(1);
  });

  it('focus e clearCell', () => {
    let l = reduce(L({ cells: ['a', 'b'] }), { type: 'focus', cell: 1 }, AREA);
    expect(l.focusedCell).toBe(1);
    l = reduce(l, { type: 'clearCell', cell: 0 }, AREA);
    expect(l.cells).toEqual([null, 'b']);
  });

  it('setPreset descarta excedente, preenche com null e clampa o foco', () => {
    const l = reduce({ preset: 'grid', cells: ['a', 'b', 'c', 'd'], focusedCell: 3, floating: null }, { type: 'setPreset', preset: 'columns' }, AREA);
    expect(l).toEqual({ preset: 'columns', cells: ['a', 'b'], focusedCell: 1, floating: null });
    const g = reduce(l, { type: 'setPreset', preset: 'grid' }, AREA);
    expect(g.cells).toEqual(['a', 'b', null, null]);
  });

  it('closeTab limpa célula e floating', () => {
    const l = L({ cells: ['a', 'b'], floating: { tabId: 's', x: 0, y: 0, w: 300, h: 400 } });
    expect(reduce(l, { type: 'closeTab', tabId: 'a' }, AREA).cells).toEqual([null, 'b']);
    expect(reduce(l, { type: 'closeTab', tabId: 's' }, AREA).floating).toBeNull();
  });

  it('detach tira da célula e cria floating clampado; dock devolve à célula focada', () => {
    const rect = { x: 900, y: 500, w: 300, h: 400 }; // outside the area: gets clamped
    let l = reduce(L({ cells: ['s', 'b'], focusedCell: 1 }), { type: 'detach', tabId: 's', rect }, AREA);
    expect(l.cells).toEqual([null, 'b']);
    expect(l.floating).toEqual({ tabId: 's', x: 700, y: 200, w: 300, h: 400 });
    l = reduce(l, { type: 'dock' }, AREA);
    expect(l.floating).toBeNull();
    expect(l.cells).toEqual([null, 's']);
  });

  it('moveFloating/resizeFloating clampam à área e ao mínimo', () => {
    let l = L({ floating: { tabId: 's', x: 10, y: 10, w: 300, h: 400 } });
    l = reduce(l, { type: 'moveFloating', x: -50, y: 5000 }, AREA);
    expect(l.floating).toEqual({ tabId: 's', x: 0, y: 200, w: 300, h: 400 });
    l = reduce(l, { type: 'resizeFloating', w: 50, h: 5000 }, AREA);
    expect(l.floating).toEqual({ tabId: 's', x: 0, y: 0, w: FLOATING_MIN.w, h: 600 });
    expect(reduce(L(), { type: 'moveFloating', x: 1, y: 1 }, AREA)).toEqual(L());
  });

  it('nunca muta o layout de entrada', () => {
    const l = L({ cells: ['a', 'b'] });
    const copy = JSON.parse(JSON.stringify(l));
    reduce(l, { type: 'assignTo', cell: 1, tabId: 'a' }, AREA);
    expect(l).toEqual(copy);
  });
});

describe('placeOf', () => {
  it('encontra célula, floating ou null', () => {
    const l = L({ cells: ['a', null], floating: { tabId: 's', x: 0, y: 0, w: 300, h: 400 } });
    expect(placeOf(l, 'a')).toEqual({ kind: 'cell', cell: 0 });
    expect(placeOf(l, 's')).toEqual({ kind: 'floating' });
    expect(placeOf(l, 'zz')).toBeNull();
  });
});

describe('floating helpers', () => {
  it('initialFloatingRect: 60% da altura, largura pela proporção, canto inferior direito com margem', () => {
    const r = initialFloatingRect(AREA, 9 / 19.5);
    expect(r.h).toBe(360);
    expect(r.w).toBe(Math.max(FLOATING_MIN.w, Math.round(360 * (9 / 19.5)))); // 166 rounds up to the 200 minimum
    expect(r.x).toBe(AREA.width - r.w - FLOATING_MARGIN);
    expect(r.y).toBe(AREA.height - r.h - FLOATING_MARGIN);
  });

  it('initialFloatingRect respeita o mínimo em áreas pequenas', () => {
    const r = initialFloatingRect({ width: 300, height: 320 }, 0.5);
    expect(r.w).toBeGreaterThanOrEqual(FLOATING_MIN.w);
    expect(r.h).toBeGreaterThanOrEqual(FLOATING_MIN.h);
    expect(r.x).toBeGreaterThanOrEqual(0);
    expect(r.y).toBeGreaterThanOrEqual(0);
  });

  it('clampFloating: reduz ao tamanho da área quando maior e reposiciona', () => {
    const f = clampFloating({ tabId: 's', x: 500, y: 500, w: 2000, h: 2000 }, AREA);
    expect(f).toEqual({ tabId: 's', x: 0, y: 0, w: 1000, h: 600 });
  });
});

describe('sanitize', () => {
  const tabs = ['a', 'b', 's'];
  it('lixo vira layout vazio single', () => {
    expect(sanitize(undefined, tabs, AREA)).toEqual(emptyLayout('single'));
    expect(sanitize('nope', tabs, AREA)).toEqual(emptyLayout('single'));
    expect(sanitize({ preset: 'weird', cells: ['a'], focusedCell: 0, floating: null }, tabs, AREA).preset).toBe('single');
  });

  it('remove ids inexistentes, ajusta tamanho de cells ao preset e clampa foco', () => {
    const l = sanitize({ preset: 'columns', cells: ['a', 'zz', 'b'], focusedCell: 7, floating: { tabId: 'gone', x: 0, y: 0, w: 300, h: 400 } }, tabs, AREA);
    expect(l).toEqual({ preset: 'columns', cells: ['a', null], focusedCell: 1, floating: null });
  });

  it('aba repetida fica só na primeira ocorrência; floating vence célula', () => {
    const l = sanitize({ preset: 'columns', cells: ['s', 's'], focusedCell: 0, floating: { tabId: 's', x: 0, y: 0, w: 300, h: 400 } }, tabs, AREA);
    expect(l.cells).toEqual([null, null]);
    expect(l.floating?.tabId).toBe('s');
  });

  it('floating fora da área é clampado; sem área, mantido', () => {
    const raw = { preset: 'single', cells: [null], focusedCell: 0, floating: { tabId: 's', x: 5000, y: 5000, w: 300, h: 400 } };
    expect(sanitize(raw, tabs, AREA).floating).toEqual({ tabId: 's', x: 700, y: 200, w: 300, h: 400 });
    expect(sanitize(raw, tabs, null).floating).toEqual(raw.floating);
  });

  it('floating com coordenada não numérica é descartado; a aba some do floating e sobra só na célula', () => {
    const raw = { preset: 'columns', cells: ['s', null], focusedCell: 0, floating: { tabId: 's', x: 'nope', y: 0, w: 300, h: 400 } };
    const l = sanitize(raw, tabs, AREA);
    expect(l.floating).toBeNull();
    expect(l.cells).toEqual(['s', null]);
  });
});

describe('load/save', () => {
  function memStorage(): Storage {
    const m = new Map<string, string>();
    return {
      getItem: (k) => m.get(k) ?? null,
      setItem: (k, v) => void m.set(k, String(v)),
      removeItem: (k) => void m.delete(k),
      clear: () => m.clear(),
      key: (i) => [...m.keys()][i] ?? null,
      get length() {
        return m.size;
      },
    };
  }

  it('sem nada salvo: single vazio', () => {
    expect(loadLayout('p1', ['a'], AREA, memStorage())).toEqual(emptyLayout('single'));
  });

  it('migra termhub:active-tab e remove a chave antiga', () => {
    const s = memStorage();
    s.setItem('termhub:active-tab:p1', 'a');
    expect(loadLayout('p1', ['a', 'b'], AREA, s)).toEqual({ preset: 'single', cells: ['a'], focusedCell: 0, floating: null });
    expect(s.getItem('termhub:active-tab:p1')).toBeNull();
  });

  it('round-trip save → load com saneamento', () => {
    const s = memStorage();
    saveLayout('p1', { preset: 'grid', cells: ['a', 'b', 'zz', null], focusedCell: 2, floating: null }, s);
    expect(s.getItem(layoutKey('p1'))).toBeTruthy();
    expect(loadLayout('p1', ['a', 'b'], AREA, s)).toEqual({ preset: 'grid', cells: ['a', 'b', null, null], focusedCell: 2, floating: null });
  });

  it('JSON corrompido não quebra', () => {
    const s = memStorage();
    s.setItem(layoutKey('p1'), '{oops');
    expect(loadLayout('p1', ['a'], AREA, s)).toEqual(emptyLayout('single'));
  });
});
