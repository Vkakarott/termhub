# Painéis (presets) e simulador flutuante — Plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Na seção Terminais, mostrar várias abas ao mesmo tempo em cinco arranjos fixos e permitir que a aba de simulador flutue (arrastar/redimensionar) dentro da área.

**Architecture:** Um módulo puro `web/src/lib/layout.ts` guarda o estado (preset, abas por célula, célula focada, janela flutuante), o redutor de ações, o saneamento e a persistência em `localStorage`. `TerminalsView` mede a área com `ResizeObserver`, calcula um retângulo por aba e renderiza todas as abas numa lista plana com `position: absolute` (nada remonta ao mudar o layout). Uma camada de células (`PaneLayer`) e uma `FloatingWindow` ficam por cima só com cabeçalhos, bordas e alças.

**Tech Stack:** React 18 + Vite + TypeScript + Tailwind no `web/`; `vitest` (novo no workspace `web`) para o módulo puro. Sem mudança no servidor.

**Spec:** `docs/superpowers/specs/2026-09-18-pane-layout-floating-simulator-design.md`

## Global Constraints

- Estado só no navegador: chave `termhub:layout:<projectId>` em `localStorage`; migra `termhub:active-tab:<projectId>` na primeira carga (vira `cells[0]` do preset `single`) e remove a chave antiga.
- Presets e número de células: `single` 1, `columns` 2, `rows` 2, `stack-left` 3, `grid` 4. Ordem das células: columns [esq, dir]; rows [cima, baixo]; stack-left [esq-cima, esq-baixo, dir]; grid [esq-cima, esq-baixo, dir-cima, dir-baixo]. Proporções 50/50, `gap` de 1 px entre células.
- Invariantes: uma aba em no máximo um lugar (célula ou `floating`); `focusedCell` dentro do intervalo; toda `tabId` existe na lista de abas.
- Janela flutuante: só `kind === 'simulator'`, uma por projeto, sempre dentro da área, mínimo 200×300 px, posição inicial = altura 60% da área, largura pela proporção da tela (ou 9/19.5), canto inferior direito com margem 16 px.
- Abas nunca remontam ao mudar o layout: visibilidade via `visibility: hidden` + `pointer-events: none`, nunca `display: none`.
- Preset `single`: sem cabeçalho de célula, sem borda; comportamento idêntico ao atual.
- Atalhos: ⌘1-9 = assign da aba N; ⌘T = novo terminal na primeira célula vazia ou na focada; ⌘W = fecha a aba da célula focada (com diálogo). Alternativas ctrl+shift+T/W mantidas.
- Textos de UI em pt-BR. Commits em inglês, assunto imperativo ≤ 72 chars (CLAUDE.md), terminando com `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Comentários de código em inglês nos arquivos novos.
- `web/tsconfig.app.json` tem `noUnusedLocals`/`noUnusedParameters`: nada de variáveis sobrando. Testes ficam fora do `tsc -b` via `exclude`.

## Estrutura de arquivos

| Arquivo | Responsabilidade |
|---|---|
| `web/src/lib/layout.ts` | tipos, `PRESETS`, `cellRects`, redutor `reduce`, `sanitize`, `loadLayout`/`saveLayout`, `initialFloatingRect`/`clampFloating`, `placeOf` |
| `web/src/lib/layout.test.ts` | testes do módulo puro |
| `web/src/components/PaneLayer.tsx` | células: cabeçalho com nome/seletor/✕, borda de foco, estado vazio |
| `web/src/components/FloatingWindow.tsx` | janela: título arrastável, corpo, alça de redimensionar |
| `web/src/components/TerminalsView.tsx` | motor: mede a área, calcula retângulos, renderiza abas, atalhos, diálogo |
| `web/src/components/TabBar.tsx` | seletor de preset, marcador de abas na tela |
| `web/src/components/SimulatorView.tsx` | botões Destacar/Encaixar |
| `web/src/components/Terminal.tsx` | raiz sem `invisible` (o wrapper controla) |
| `web/package.json`, `web/tsconfig.app.json`, `.github/workflows/deploy.yml` | vitest no web + CI |

---

### Task 1: vitest no web + `layout.ts` (tipos, presets, `cellRects`)

**Files:**
- Modify: `web/package.json`, `web/tsconfig.app.json`, `package.json` (raiz), `.github/workflows/deploy.yml`
- Create: `web/src/lib/layout.ts`, `web/src/lib/layout.test.ts`

**Interfaces:**
- Produces: `type Preset`, `PRESETS: readonly { key: Preset; label: string; cells: number }[]`, `cellCount(preset): number`, `interface Rect { x; y; w; h }`, `interface Size { width; height }`, `cellRects(preset, width, height, gap = 1): Rect[]`

- [ ] **Step 1: vitest no workspace web**

```bash
cd /Volumes/Extra/projects/8020/termhub && npm i -D vitest@^3 -w web
```

`web/package.json` scripts: adicione `"test": "vitest run"` e `"test:watch": "vitest"`. `web/tsconfig.app.json`: adicione `"exclude": ["src/**/*.test.ts"]` ao lado de `"include": ["src"]`. Raiz `package.json`: troque `"test": "npm test -w server"` por `"test": "npm test -w server && npm test -w web"`. CI (`.github/workflows/deploy.yml`), logo após o passo "Testes server", adicione:

```yaml
      - name: Testes web
        run: npm test -w web
```

`vitest` usa o `web/vite.config.ts` existente (plugin react não atrapalha). Se `vitest run` reclamar do `environment`, adicione ao `vite.config.ts` um bloco `test: { environment: 'node' }` (o módulo é puro; `localStorage` é injetado nos testes que precisam, ver Task 2).

- [ ] **Step 2: Teste que falha**

`web/src/lib/layout.test.ts`:

```ts
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
```

- [ ] **Step 3: Rodar e ver falhar**

Run: `cd /Volumes/Extra/projects/8020/termhub/web && npx vitest run src/lib/layout.test.ts`
Expected: FAIL, módulo `./layout` não encontrado.

- [ ] **Step 4: Implementar**

`web/src/lib/layout.ts` (só esta parte nesta task; a Task 2 acrescenta o resto no mesmo arquivo):

```ts
// Pane layout for the terminals area: fixed presets, tab-per-cell assignment,
// one optional floating window. Pure module; persistence helpers at the bottom.

export type Preset = 'single' | 'columns' | 'rows' | 'stack-left' | 'grid';

export const PRESETS: readonly { key: Preset; label: string; cells: number }[] = [
  { key: 'single', label: 'Um painel', cells: 1 },
  { key: 'columns', label: 'Duas colunas', cells: 2 },
  { key: 'rows', label: 'Duas linhas', cells: 2 },
  { key: 'stack-left', label: 'Dois empilhados + um ao lado', cells: 3 },
  { key: 'grid', label: 'Quatro (2x2)', cells: 4 },
];

export function cellCount(preset: Preset): number {
  return PRESETS.find((p) => p.key === preset)?.cells ?? 1;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Size {
  width: number;
  height: number;
}

/** Splits `total` in two halves with `gap` between them: [first size, second offset, second size]. */
function halves(total: number, gap: number): [number, number, number] {
  const first = Math.max(0, Math.floor((total - gap) / 2));
  const secondStart = Math.min(total, first + gap);
  return [first, secondStart, Math.max(0, total - secondStart)];
}

/** Cell rectangles for a preset inside a width×height area, in the spec's cell order. */
export function cellRects(preset: Preset, width: number, height: number, gap = 1): Rect[] {
  const [lw, rx, rw] = halves(width, gap);
  const [th, by, bh] = halves(height, gap);
  switch (preset) {
    case 'single':
      return [{ x: 0, y: 0, w: width, h: height }];
    case 'columns':
      return [
        { x: 0, y: 0, w: lw, h: height },
        { x: rx, y: 0, w: rw, h: height },
      ];
    case 'rows':
      return [
        { x: 0, y: 0, w: width, h: th },
        { x: 0, y: by, w: width, h: bh },
      ];
    case 'stack-left':
      return [
        { x: 0, y: 0, w: lw, h: th },
        { x: 0, y: by, w: lw, h: bh },
        { x: rx, y: 0, w: rw, h: height },
      ];
    case 'grid':
      return [
        { x: 0, y: 0, w: lw, h: th },
        { x: 0, y: by, w: lw, h: bh },
        { x: rx, y: 0, w: rw, h: th },
        { x: rx, y: by, w: rw, h: bh },
      ];
  }
}
```

- [ ] **Step 5: Rodar e ver passar**

Run: `cd /Volumes/Extra/projects/8020/termhub/web && npx vitest run src/lib/layout.test.ts && npm run typecheck`
Expected: 8 passed; typecheck limpo (os testes estão excluídos do `tsc -b`).

- [ ] **Step 6: Commit**

```bash
git add web/package.json web/tsconfig.app.json package.json package-lock.json .github/workflows/deploy.yml web/src/lib/layout.ts web/src/lib/layout.test.ts web/vite.config.ts
git commit -m "Layout: vitest in web workspace, presets and cell rectangles

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: `layout.ts` — estado, redutor, saneamento, janela flutuante e persistência

**Files:**
- Modify: `web/src/lib/layout.ts` (acrescenta ao arquivo da Task 1), `web/src/lib/layout.test.ts` (acrescenta)

**Interfaces:**
- Consumes: `Preset`, `cellCount`, `Rect`, `Size` (Task 1)
- Produces:
  - `interface Floating extends Rect { tabId: string }`, `interface Layout { preset: Preset; cells: (string | null)[]; focusedCell: number; floating: Floating | null }`
  - `FLOATING_MIN = { w: 200, h: 300 }`, `FLOATING_MARGIN = 16`
  - `emptyLayout(preset?: Preset): Layout`
  - `type Action = { type: 'assign'; tabId } | { type: 'assignTo'; cell; tabId } | { type: 'focus'; cell } | { type: 'clearCell'; cell } | { type: 'setPreset'; preset } | { type: 'closeTab'; tabId } | { type: 'detach'; tabId; rect: Rect } | { type: 'dock' } | { type: 'moveFloating'; x; y } | { type: 'resizeFloating'; w; h }`
  - `reduce(layout: Layout, action: Action, area: Size | null): Layout` (puro; nunca muta)
  - `placeOf(layout, tabId): { kind: 'cell'; cell: number } | { kind: 'floating' } | null`
  - `initialFloatingRect(area: Size, aspect: number): Rect`, `clampFloating(f: Floating, area: Size): Floating`
  - `sanitize(raw: unknown, tabIds: string[], area: Size | null): Layout`
  - `loadLayout(projectId: string, tabIds: string[], area: Size | null, storage?: Storage): Layout`, `saveLayout(projectId: string, layout: Layout, storage?: Storage): void`, `layoutKey(projectId): string`

- [ ] **Step 1: Testes que falham**

Acrescente ao final de `web/src/lib/layout.test.ts`:

```ts
import {
  clampFloating,
  emptyLayout,
  FLOATING_MARGIN,
  FLOATING_MIN,
  initialFloatingRect,
  layoutKey,
  loadLayout,
  placeOf,
  reduce,
  sanitize,
  saveLayout,
  type Layout,
} from './layout';

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
    const rect = { x: 900, y: 500, w: 300, h: 400 }; // fora da área: clampa
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
    expect(r.w).toBe(Math.max(FLOATING_MIN.w, Math.round(360 * (9 / 19.5)))); // 166 sobe para o mínimo de 200
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
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `cd /Volumes/Extra/projects/8020/termhub/web && npx vitest run src/lib/layout.test.ts`
Expected: FAIL, exports não encontrados.

- [ ] **Step 3: Implementar (acrescentar a `layout.ts`)**

```ts
export interface Floating extends Rect {
  tabId: string;
}

export interface Layout {
  preset: Preset;
  cells: (string | null)[];
  focusedCell: number;
  floating: Floating | null;
}

export const FLOATING_MIN = { w: 200, h: 300 } as const;
export const FLOATING_MARGIN = 16;

const PRESET_KEYS = new Set<string>(PRESETS.map((p) => p.key));
const isPreset = (p: unknown): p is Preset => typeof p === 'string' && PRESET_KEYS.has(p);

export function emptyLayout(preset: Preset = 'single'): Layout {
  return { preset, cells: Array.from({ length: cellCount(preset) }, () => null), focusedCell: 0, floating: null };
}

export type Action =
  | { type: 'assign'; tabId: string }
  | { type: 'assignTo'; cell: number; tabId: string }
  | { type: 'focus'; cell: number }
  | { type: 'clearCell'; cell: number }
  | { type: 'setPreset'; preset: Preset }
  | { type: 'closeTab'; tabId: string }
  | { type: 'detach'; tabId: string; rect: Rect }
  | { type: 'dock' }
  | { type: 'moveFloating'; x: number; y: number }
  | { type: 'resizeFloating'; w: number; h: number };

export function placeOf(layout: Layout, tabId: string): { kind: 'cell'; cell: number } | { kind: 'floating' } | null {
  if (layout.floating?.tabId === tabId) return { kind: 'floating' };
  const cell = layout.cells.indexOf(tabId);
  return cell === -1 ? null : { kind: 'cell', cell };
}

const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), Math.max(lo, hi));

/** Keeps the floating window inside the area and above the minimum size. */
export function clampFloating(f: Floating, area: Size): Floating {
  const w = clamp(Math.round(f.w), Math.min(FLOATING_MIN.w, area.width), area.width);
  const h = clamp(Math.round(f.h), Math.min(FLOATING_MIN.h, area.height), area.height);
  const x = clamp(Math.round(f.x), 0, area.width - w);
  const y = clamp(Math.round(f.y), 0, area.height - h);
  return { tabId: f.tabId, x, y, w, h };
}

/** First position when detaching: 60% of the area height, device aspect, bottom-right corner. */
export function initialFloatingRect(area: Size, aspect: number): Rect {
  const h = Math.max(FLOATING_MIN.h, Math.round(area.height * 0.6));
  const w = Math.max(FLOATING_MIN.w, Math.round(h * aspect));
  const f = clampFloating({ tabId: '', x: area.width - w - FLOATING_MARGIN, y: area.height - h - FLOATING_MARGIN, w, h }, area);
  return { x: f.x, y: f.y, w: f.w, h: f.h };
}

function withCell(cells: (string | null)[], index: number, value: string | null): (string | null)[] {
  return cells.map((c, i) => (i === index ? value : c));
}

export function reduce(layout: Layout, action: Action, area: Size | null): Layout {
  const n = layout.cells.length;
  switch (action.type) {
    case 'assign': {
      const place = placeOf(layout, action.tabId);
      if (place?.kind === 'floating') return layout;
      if (place?.kind === 'cell') return { ...layout, focusedCell: place.cell };
      return { ...layout, cells: withCell(layout.cells, layout.focusedCell, action.tabId) };
    }
    case 'assignTo': {
      if (action.cell < 0 || action.cell >= n) return layout;
      const cells = layout.cells.map((c) => (c === action.tabId ? null : c));
      return { ...layout, cells: withCell(cells, action.cell, action.tabId), focusedCell: action.cell };
    }
    case 'focus':
      return action.cell >= 0 && action.cell < n ? { ...layout, focusedCell: action.cell } : layout;
    case 'clearCell':
      return { ...layout, cells: withCell(layout.cells, action.cell, null) };
    case 'setPreset': {
      const count = cellCount(action.preset);
      const cells = Array.from({ length: count }, (_, i) => layout.cells[i] ?? null);
      return { ...layout, preset: action.preset, cells, focusedCell: clamp(layout.focusedCell, 0, count - 1) };
    }
    case 'closeTab':
      return {
        ...layout,
        cells: layout.cells.map((c) => (c === action.tabId ? null : c)),
        floating: layout.floating?.tabId === action.tabId ? null : layout.floating,
      };
    case 'detach': {
      const f: Floating = { tabId: action.tabId, ...action.rect };
      return {
        ...layout,
        cells: layout.cells.map((c) => (c === action.tabId ? null : c)),
        floating: area ? clampFloating(f, area) : f,
      };
    }
    case 'dock': {
      if (!layout.floating) return layout;
      return { ...layout, cells: withCell(layout.cells, layout.focusedCell, layout.floating.tabId), floating: null };
    }
    case 'moveFloating': {
      if (!layout.floating) return layout;
      const f = { ...layout.floating, x: action.x, y: action.y };
      return { ...layout, floating: area ? clampFloating(f, area) : f };
    }
    case 'resizeFloating': {
      if (!layout.floating) return layout;
      const f = { ...layout.floating, w: action.w, h: action.h };
      return { ...layout, floating: area ? clampFloating(f, area) : f };
    }
  }
}

/** Turns anything (old storage, hand-edited JSON) into a valid layout for the given tabs. */
export function sanitize(raw: unknown, tabIds: string[], area: Size | null): Layout {
  if (!raw || typeof raw !== 'object') return emptyLayout('single');
  const r = raw as Partial<Layout>;
  const preset: Preset = isPreset(r.preset) ? r.preset : 'single';
  const count = cellCount(preset);
  const known = new Set(tabIds);
  const rawFloating = r.floating && typeof r.floating === 'object' ? (r.floating as Floating) : null;
  const floatingOk = rawFloating && typeof rawFloating.tabId === 'string' && known.has(rawFloating.tabId) && [rawFloating.x, rawFloating.y, rawFloating.w, rawFloating.h].every((v) => typeof v === 'number' && Number.isFinite(v));
  const floating = floatingOk ? (area ? clampFloating(rawFloating, area) : { ...rawFloating }) : null;
  const seen = new Set<string>(floating ? [floating.tabId] : []);
  const cells = Array.from({ length: count }, (_, i) => {
    const c = Array.isArray(r.cells) ? r.cells[i] : null;
    if (typeof c !== 'string' || !known.has(c) || seen.has(c)) return null;
    seen.add(c);
    return c;
  });
  const focusedCell = typeof r.focusedCell === 'number' && Number.isFinite(r.focusedCell) ? clamp(Math.floor(r.focusedCell), 0, count - 1) : 0;
  return { preset, cells, focusedCell, floating };
}

export const layoutKey = (projectId: string) => `termhub:layout:${projectId}`;
const legacyActiveKey = (projectId: string) => `termhub:active-tab:${projectId}`;

export function loadLayout(projectId: string, tabIds: string[], area: Size | null, storage: Storage = localStorage): Layout {
  let raw: unknown;
  try {
    const text = storage.getItem(layoutKey(projectId));
    raw = text ? JSON.parse(text) : undefined;
  } catch {
    raw = undefined;
  }
  if (raw === undefined) {
    // Migrate the pre-layout "active tab" key into a single-pane layout.
    const legacy = storage.getItem(legacyActiveKey(projectId));
    if (legacy) {
      storage.removeItem(legacyActiveKey(projectId));
      raw = { preset: 'single', cells: [legacy], focusedCell: 0, floating: null };
    }
  }
  return sanitize(raw, tabIds, area);
}

export function saveLayout(projectId: string, layout: Layout, storage: Storage = localStorage): void {
  try {
    storage.setItem(layoutKey(projectId), JSON.stringify(layout));
  } catch {
    /* storage full or blocked: layout stays in memory only */
  }
}
```

Observação sobre os números esperados nos testes: `detach` com `rect {900,500,300,400}` em 1000×600 clampa para `x = 700, y = 200`; `resizeFloating {50, 5000}` com `x = 0, y = 200` vira `w = 200, h = 600` e `y` é reclampado para 0.

- [ ] **Step 4: Rodar e ver passar**

Run: `cd /Volumes/Extra/projects/8020/termhub/web && npx vitest run src/lib/layout.test.ts && npm run typecheck`
Expected: todos passam (8 da Task 1 + 20 novos); typecheck limpo. `localStorage` não é usado nos testes (storage injetado), então o ambiente `node` basta.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/layout.ts web/src/lib/layout.test.ts
git commit -m "Layout: reducer, sanitize, floating helpers and localStorage persistence

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: `PaneLayer` (células, cabeçalhos, estado vazio)

**Files:**
- Create: `web/src/components/PaneLayer.tsx`

**Interfaces:**
- Consumes: `Rect`, `Preset` (Task 1), `Tab` (`web/src/lib/types`)
- Produces:
  - `PANE_HEADER_HEIGHT = 24`
  - `PaneLayer({ preset, rects, cells, focusedCell, tabs, onFocus(cell), onAssign(cell, tabId), onClear(cell), onNewTerminal(cell) })` — camada absoluta por cima das abas; em `single` não renderiza nada.

- [ ] **Step 1: Implementar**

```tsx
import type { Preset, Rect } from '../lib/layout';
import type { Tab } from '../lib/types';

export const PANE_HEADER_HEIGHT = 24;

interface Props {
  preset: Preset;
  rects: Rect[];
  cells: (string | null)[];
  focusedCell: number;
  tabs: Tab[];
  onFocus: (cell: number) => void;
  onAssign: (cell: number, tabId: string) => void;
  onClear: (cell: number) => void;
  onNewTerminal: (cell: number) => void;
}

/** Dropdown listing every tab of the project plus a "new terminal" entry. */
function TabPicker({ tabs, value, onPick, onNew }: { tabs: Tab[]; value: string | null; onPick: (id: string) => void; onNew: () => void }) {
  return (
    <select
      className="h-5 max-w-[180px] rounded border border-line bg-bg px-1 text-[11px] text-fg"
      value={value ?? ''}
      onChange={(e) => {
        if (e.target.value === '__new__') onNew();
        else if (e.target.value) onPick(e.target.value);
      }}
      onPointerDown={(e) => e.stopPropagation()}
      aria-label="Aba deste painel"
    >
      <option value="">Escolha uma aba…</option>
      {tabs.map((t) => (
        <option key={t.id} value={t.id}>
          {t.kind === 'simulator' ? '📱 ' : ''}
          {t.name}
        </option>
      ))}
      <option value="__new__">+ novo terminal</option>
    </select>
  );
}

/**
 * Overlay above the tab wrappers: one header strip per cell (name, picker, clear) and a focus
 * border. Empty cells get a centered picker. Everything else is pointer-transparent so the
 * terminals underneath keep receiving events.
 */
export function PaneLayer({ preset, rects, cells, focusedCell, tabs, onFocus, onAssign, onClear, onNewTerminal }: Props) {
  if (preset === 'single') return null;
  return (
    <div className="pointer-events-none absolute inset-0">
      {rects.map((r, cell) => {
        const tab = cells[cell] ? tabs.find((t) => t.id === cells[cell]) : undefined;
        const focused = cell === focusedCell;
        return (
          <div
            key={cell}
            className={`absolute ${focused ? 'ring-1 ring-inset ring-accent/60' : 'ring-1 ring-inset ring-line'}`}
            style={{ left: r.x, top: r.y, width: r.w, height: r.h }}
          >
            <div
              className="pointer-events-auto flex items-center gap-2 border-b border-line bg-bg-2 px-2 text-[11px] text-fg-muted"
              style={{ height: PANE_HEADER_HEIGHT }}
              onPointerDown={() => onFocus(cell)}
            >
              {tab ? (
                <>
                  <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${tab.alive ? 'bg-ok' : 'bg-fg-dim'}`} />
                  <span className="truncate text-fg">{tab.name}</span>
                  <TabPicker tabs={tabs} value={tab.id} onPick={(id) => onAssign(cell, id)} onNew={() => onNewTerminal(cell)} />
                  <button
                    className="ml-auto rounded px-1 text-fg-dim hover:bg-bg-4 hover:text-fg"
                    onClick={() => onClear(cell)}
                    title="Tirar deste painel (a aba continua na barra)"
                    aria-label="Esvaziar painel"
                  >
                    ✕
                  </button>
                </>
              ) : (
                <span className="text-fg-dim">Painel vazio</span>
              )}
            </div>
            {!tab && (
              <div
                className="pointer-events-auto flex flex-col items-center justify-center gap-2 text-sm text-fg-muted"
                style={{ height: r.h - PANE_HEADER_HEIGHT }}
                onPointerDown={() => onFocus(cell)}
              >
                <p>Escolha uma aba</p>
                <TabPicker tabs={tabs} value={null} onPick={(id) => onAssign(cell, id)} onNew={() => onNewTerminal(cell)} />
                <button className="btn-ghost text-xs" onClick={() => onNewTerminal(cell)}>
                  + terminal
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 2: Verificar**

Run: `cd /Volumes/Extra/projects/8020/termhub && npm run build -w web`
Expected: limpo. (O componente ainda não é usado; `noUnusedLocals` não reclama de exports.)

- [ ] **Step 3: Commit**

```bash
git add web/src/components/PaneLayer.tsx
git commit -m "Layout: pane overlay with per-cell header, picker and empty state

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: `FloatingWindow` (arrastar e redimensionar)

**Files:**
- Create: `web/src/components/FloatingWindow.tsx`

**Interfaces:**
- Consumes: `Rect` (Task 1)
- Produces: `FLOATING_TITLE_HEIGHT = 24`; `FloatingWindow({ rect, title, onMove(x, y), onResize(w, h), onDock(), onFocus(), children })` — `children` é renderizado dentro do corpo (área = rect menos a barra de título).

- [ ] **Step 1: Implementar**

```tsx
import { useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import type { Rect } from '../lib/layout';

export const FLOATING_TITLE_HEIGHT = 24;

interface Props {
  rect: Rect;
  title: string;
  onMove: (x: number, y: number) => void;
  onResize: (w: number, h: number) => void;
  onDock: () => void;
  onFocus: () => void;
  children: ReactNode;
}

/**
 * Draggable/resizable frame positioned by `rect` inside the terminals area. Pointer capture keeps
 * the gesture alive when the cursor leaves the handle; the parent clamps the values it receives.
 */
export function FloatingWindow({ rect, title, onMove, onResize, onDock, onFocus, children }: Props) {
  const drag = useRef<{ dx: number; dy: number } | null>(null);
  const resize = useRef<{ x0: number; y0: number; w0: number; h0: number } | null>(null);

  const startDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    onFocus();
    drag.current = { dx: e.clientX - rect.x, dy: e.clientY - rect.y };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const moveDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    onMove(e.clientX - drag.current.dx, e.clientY - drag.current.dy);
  };
  const endDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    drag.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
  };

  const startResize = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    onFocus();
    resize.current = { x0: e.clientX, y0: e.clientY, w0: rect.w, h0: rect.h };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const moveResize = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!resize.current) return;
    onResize(resize.current.w0 + (e.clientX - resize.current.x0), resize.current.h0 + (e.clientY - resize.current.y0));
  };
  const endResize = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!resize.current) return;
    resize.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
  };

  return (
    <div
      className="absolute z-20 flex flex-col overflow-hidden rounded-md border border-accent/50 bg-bg shadow-2xl"
      style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
      onPointerDown={onFocus}
    >
      <div
        className="flex shrink-0 cursor-move select-none items-center gap-2 border-b border-line bg-bg-2 px-2 text-[11px] text-fg-muted"
        style={{ height: FLOATING_TITLE_HEIGHT }}
        onPointerDown={startDrag}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <span className="text-[10px]" aria-hidden>
          📱
        </span>
        <span className="truncate text-fg">{title}</span>
        <button className="ml-auto rounded px-1 hover:bg-bg-4 hover:text-fg" onPointerDown={(e) => e.stopPropagation()} onClick={onDock} title="Encaixar no painel focado">
          Encaixar
        </button>
      </div>
      <div className="relative min-h-0 flex-1">{children}</div>
      <div
        className="absolute bottom-0 right-0 h-4 w-4 cursor-nwse-resize"
        style={{ background: 'linear-gradient(135deg, transparent 50%, rgba(255,255,255,0.25) 50%)' }}
        onPointerDown={startResize}
        onPointerMove={moveResize}
        onPointerUp={endResize}
        onPointerCancel={endResize}
        aria-label="Redimensionar"
      />
    </div>
  );
}
```

Observação: `rect.x/y` são relativos à área de terminais, mas `clientX/Y` são da janela. A diferença é constante durante um arrasto (a área não se move), então `dx/dy` capturados no início absorvem o deslocamento; o valor passado a `onMove` fica relativo à área.

- [ ] **Step 2: Verificar**

Run: `cd /Volumes/Extra/projects/8020/termhub && npm run build -w web`
Expected: limpo.

- [ ] **Step 3: Commit**

```bash
git add web/src/components/FloatingWindow.tsx
git commit -m "Layout: floating window frame with drag and resize handles

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: motor no `TerminalsView` + raízes de `Terminal`/`SimulatorView`

**Files:**
- Modify: `web/src/components/TerminalsView.tsx` (reescrita), `web/src/components/Terminal.tsx` (linha da raiz: `absolute inset-0 flex flex-col ${active ? '' : 'invisible'}` → `absolute inset-0 flex flex-col`), `web/src/components/SimulatorView.tsx` (raiz `absolute inset-0 flex flex-col ${active ? '' : 'hidden'}` → `absolute inset-0 flex flex-col`)

**Interfaces:**
- Consumes: tudo de `layout.ts` (Tasks 1–2), `PaneLayer`/`PANE_HEADER_HEIGHT` (Task 3), `FloatingWindow`/`FLOATING_TITLE_HEIGHT` (Task 4), `TabBar` (props atuais; a Task 6 acrescenta `preset`/`onPreset`/`onScreen`), `SimulatorView` (props atuais; a Task 6 acrescenta `floating`/`onDetach`/`onDock`).
- Produces: `TerminalsView` com o mesmo contrato externo (`{ project, visible }`).

Regras que este código implementa (da spec): abas em lista plana com wrapper absoluto; `visibility: hidden` + `pointer-events: none` sem retângulo; célula focada por `onPointerDown`; atalhos; `?tab=` faz `assign`; `?tab=` de aba desconhecida recarrega a lista; diálogo de fechar por tipo.

- [ ] **Step 1: Raízes dos componentes de aba**

Em `Terminal.tsx`, troque a linha da raiz por `<div className="absolute inset-0 flex flex-col">` (o `active` continua controlando `fit`/`focus`). Em `SimulatorView.tsx`, `<div className="absolute inset-0 flex flex-col">` (o `active` continua controlando `pause`/`resume`).

- [ ] **Step 2: Reescrever `TerminalsView.tsx`**

```tsx
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import {
  cellRects,
  initialFloatingRect,
  loadLayout,
  placeOf,
  reduce,
  sanitize,
  saveLayout,
  type Action,
  type Layout,
  type Preset,
  type Rect,
  type Size,
} from '../lib/layout';
import type { Project, Tab, TabKind } from '../lib/types';
import { TabBar } from './TabBar';
import { TerminalView } from './Terminal';
import { SimulatorView } from './SimulatorView';
import { PaneLayer, PANE_HEADER_HEIGHT } from './PaneLayer';
import { FloatingWindow, FLOATING_TITLE_HEIGHT } from './FloatingWindow';
import { ConfirmDialog } from './Modal';
import { useData } from '../lib/data';

interface Props {
  project: Project;
  visible: boolean;
}

export function TerminalsView({ project, visible }: Props) {
  const { machines, missingTmux } = useData();
  const [searchParams, setSearchParams] = useSearchParams();
  const machine = machines.find((m) => m.id === project.machine_id);
  const noTmux = !!missingTmux[project.machine_id];
  const canSimulator = !!machine?.capabilities.includes('wda');
  const [tabs, setTabs] = useState<Tab[] | null>(null);
  const [reachable, setReachable] = useState(true);
  const [closing, setClosing] = useState<Tab | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Tabs mount only after the section was visible once (xterm cannot initialize inside display:none).
  const [shown, setShown] = useState(visible);
  useEffect(() => {
    if (visible) setShown(true);
  }, [visible]);

  // --- Layout state -------------------------------------------------------
  const areaRef = useRef<HTMLDivElement>(null);
  const [area, setArea] = useState<Size | null>(null);
  const [layout, setLayout] = useState<Layout>(() => loadLayout(project.id, [], null));
  const [floatingFocused, setFloatingFocused] = useState(false);
  const tabIds = useMemo(() => (tabs ?? []).map((t) => t.id), [tabs]);

  useLayoutEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      setArea({ width: Math.floor(r.width), height: Math.floor(r.height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Re-sanitize whenever the tab list or the area changes (deleted tabs, smaller window).
  useEffect(() => {
    if (!tabs) return;
    setLayout((l) => sanitize(l, tabIds, area));
  }, [tabs, tabIds, area]);

  // First load with the real tab list: pick up the stored layout (or migrate the old active-tab key).
  const loadedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!tabs || loadedFor.current === project.id) return;
    loadedFor.current = project.id;
    setLayout(loadLayout(project.id, tabIds, area));
  }, [tabs, tabIds, area, project.id]);

  useEffect(() => {
    if (loadedFor.current === project.id) saveLayout(project.id, layout);
  }, [layout, project.id]);

  const dispatch = useCallback((action: Action) => setLayout((l) => reduce(l, action, area)), [area]);

  const rects = useMemo(() => (area ? cellRects(layout.preset, area.width, area.height) : []), [area, layout.preset]);
  const headerH = layout.preset === 'single' ? 0 : PANE_HEADER_HEIGHT;

  /** Where a tab is drawn: its cell (minus the header) or the floating body; null = hidden. */
  const rectOf = (tabId: string): Rect | null => {
    const place = placeOf(layout, tabId);
    if (!place) return null;
    if (place.kind === 'floating' && layout.floating) {
      const f = layout.floating;
      return { x: f.x, y: f.y + FLOATING_TITLE_HEIGHT, w: f.w, h: Math.max(0, f.h - FLOATING_TITLE_HEIGHT) };
    }
    if (place.kind === 'cell') {
      const r = rects[place.cell];
      return r ? { x: r.x, y: r.y + headerH, w: r.w, h: Math.max(0, r.h - headerH) } : null;
    }
    return null;
  };

  const focusedTabId = layout.floating && floatingFocused ? layout.floating.tabId : layout.cells[layout.focusedCell] ?? null;

  // --- Data -----------------------------------------------------------------
  const load = useCallback(async () => {
    try {
      const r = await api.projects.tabs(project.id);
      setTabs(r.tabs);
      setReachable(r.reachable);
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Erro ao carregar tabs');
      setTabs([]);
    }
  }, [project.id]);

  useEffect(() => {
    void load();
  }, [load]);

  // ?tab=<id> (from a task card) shows the tab in the focused cell and clears the param.
  useEffect(() => {
    const wanted = searchParams.get('tab');
    if (!wanted || !tabs) return;
    if (tabs.some((t) => t.id === wanted)) dispatch({ type: 'assign', tabId: wanted });
    else void load();
    setSearchParams(
      (p) => {
        p.delete('tab');
        return p;
      },
      { replace: true },
    );
  }, [searchParams, tabs, setSearchParams, load, dispatch]);

  const newTab = useCallback(
    async (kind: TabKind = 'terminal', cell?: number) => {
      try {
        const { tab } = await api.projects.createTab(project.id, { kind });
        setTabs((t) => [...(t ?? []), tab]);
        setLayout((l) => {
          const target = cell ?? (l.cells.indexOf(null) === -1 ? l.focusedCell : l.cells.indexOf(null));
          return reduce(l, { type: 'assignTo', cell: target, tabId: tab.id }, area);
        });
      } catch (e) {
        setError(e instanceof ApiError ? e.message : 'Erro ao criar tab');
      }
    },
    [project.id, area],
  );

  const rename = useCallback(
    async (id: string, name: string) => {
      setTabs((t) => (t ?? []).map((x) => (x.id === id ? { ...x, name } : x)));
      try {
        await api.tabs.rename(id, name);
      } catch {
        void load();
      }
    },
    [load],
  );

  const closeTab = useCallback(
    async (tab: Tab) => {
      setClosing(null);
      setTabs((t) => (t ?? []).filter((x) => x.id !== tab.id));
      dispatch({ type: 'closeTab', tabId: tab.id });
      try {
        await api.tabs.remove(tab.id);
      } catch (e) {
        setError(e instanceof ApiError ? e.message : 'Erro ao fechar tab');
        void load();
      }
    },
    [dispatch, load],
  );

  // Mark the session alive as soon as the tab connects (no need to wait for the next load).
  const markAlive = useCallback((id: string) => {
    setTabs((t) => (t ?? []).map((x) => (x.id === id && !x.alive ? { ...x, alive: true } : x)));
  }, []);

  const detach = useCallback(
    (tab: Tab, aspect: number) => {
      if (!area || tab.kind !== 'simulator') return;
      dispatch({ type: 'detach', tabId: tab.id, rect: initialFloatingRect(area, aspect) });
      setFloatingFocused(true);
    },
    [area, dispatch],
  );

  // Shortcuts: ⌘T new tab, ⌘W close focused, ⌘1..9 assign (ctrl+shift+T/W as alternatives).
  useEffect(() => {
    if (!visible) return;
    const onKey = (e: KeyboardEvent) => {
      const list = tabs ?? [];
      const meta = e.metaKey && !e.ctrlKey && !e.altKey;
      const ctrlShift = e.ctrlKey && e.shiftKey && !e.metaKey && !e.altKey;
      if ((meta && e.key === 't') || (ctrlShift && e.key === 'T')) {
        e.preventDefault();
        void newTab();
      } else if ((meta && e.key === 'w') || (ctrlShift && e.key === 'W')) {
        e.preventDefault();
        const t = list.find((x) => x.id === focusedTabId);
        if (t) setClosing(t);
      } else if (meta && /^[1-9]$/.test(e.key)) {
        const t = list[Number(e.key) - 1];
        if (t) {
          e.preventDefault();
          dispatch({ type: 'assign', tabId: t.id });
          setFloatingFocused(false);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [visible, tabs, focusedTabId, newTab, dispatch]);

  const floatingTab = layout.floating ? (tabs ?? []).find((t) => t.id === layout.floating?.tabId) : undefined;

  return (
    <div className={`absolute inset-0 flex flex-col ${visible ? '' : 'hidden'}`}>
      <TabBar
        tabs={tabs ?? []}
        activeId={focusedTabId}
        onScreen={(id) => placeOf(layout, id) !== null}
        preset={layout.preset}
        onPreset={(p: Preset) => dispatch({ type: 'setPreset', preset: p })}
        onSelect={(id) => {
          dispatch({ type: 'assign', tabId: id });
          setFloatingFocused(layout.floating?.tabId === id);
        }}
        onNew={() => void newTab()}
        onNewSimulator={() => void newTab('simulator')}
        canSimulator={canSimulator}
        onRename={(id, name) => void rename(id, name)}
        onClose={(id) => {
          const t = (tabs ?? []).find((x) => x.id === id);
          if (t) setClosing(t);
        }}
      />
      {noTmux && (
        <div className="border-b border-warn/30 bg-warn/10 px-3 py-1 text-xs text-warn">
          <strong>{machine?.name}</strong> está online mas não tem <code className="font-mono">tmux</code> instalado. Instale (ex.:{' '}
          <code className="font-mono">sudo apt install tmux</code>) para abrir terminais.
        </div>
      )}
      {!reachable && (
        <div className="border-b border-warn/30 bg-warn/10 px-3 py-1 text-xs text-warn">
          Não foi possível consultar as sessões tmux nesta máquina (offline?). Os terminais podem não conectar.
        </div>
      )}
      {error && (
        <div className="border-b border-danger/30 bg-danger/10 px-3 py-1 text-xs text-danger">
          {error}{' '}
          <button className="underline" onClick={() => setError(null)}>
            fechar
          </button>
        </div>
      )}
      <div ref={areaRef} className="relative min-h-0 flex-1 overflow-hidden">
        {tabs === null ? (
          <div className="flex h-full items-center justify-center text-sm text-fg-dim">Carregando tabs…</div>
        ) : tabs.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-fg-muted">
            <p>Nenhum terminal aberto neste projeto.</p>
            <button className="btn-primary" onClick={() => void newTab()}>
              Abrir terminal <kbd className="ml-1 rounded bg-black/30 px-1 text-[10px]">⌘T</kbd>
            </button>
          </div>
        ) : shown && area ? (
          <>
            {tabs.map((t) => {
              const r = rectOf(t.id);
              const place = placeOf(layout, t.id);
              const isFloating = place?.kind === 'floating';
              const active = visible && r !== null;
              return (
                <div
                  key={t.id}
                  className="absolute"
                  style={
                    r
                      ? { left: r.x, top: r.y, width: r.w, height: r.h, zIndex: isFloating ? 21 : 1 }
                      : { left: 0, top: 0, width: area.width, height: area.height, visibility: 'hidden', pointerEvents: 'none' }
                  }
                  onPointerDownCapture={() => {
                    if (place?.kind === 'cell') {
                      dispatch({ type: 'focus', cell: place.cell });
                      setFloatingFocused(false);
                    } else if (isFloating) setFloatingFocused(true);
                  }}
                >
                  {t.kind === 'simulator' ? (
                    <SimulatorView
                      tab={t}
                      machineId={project.machine_id}
                      active={active}
                      floating={isFloating}
                      onDetach={(aspect) => detach(t, aspect)}
                      onDock={() => {
                        dispatch({ type: 'dock' });
                        setFloatingFocused(false);
                      }}
                      onTabChange={(updated) => setTabs((list) => (list ?? []).map((x) => (x.id === updated.id ? { ...updated, alive: x.alive } : x)))}
                      onConnected={() => markAlive(t.id)}
                    />
                  ) : (
                    <TerminalView tabId={t.id} active={active} onConnected={() => markAlive(t.id)} />
                  )}
                </div>
              );
            })}
            <PaneLayer
              preset={layout.preset}
              rects={rects}
              cells={layout.cells}
              focusedCell={layout.focusedCell}
              tabs={tabs}
              onFocus={(cell) => {
                dispatch({ type: 'focus', cell });
                setFloatingFocused(false);
              }}
              onAssign={(cell, tabId) => dispatch({ type: 'assignTo', cell, tabId })}
              onClear={(cell) => dispatch({ type: 'clearCell', cell })}
              onNewTerminal={(cell) => void newTab('terminal', cell)}
            />
            {layout.floating && floatingTab && (
              <FloatingWindow
                rect={layout.floating}
                title={floatingTab.name}
                onMove={(x, y) => dispatch({ type: 'moveFloating', x, y })}
                onResize={(w, h) => dispatch({ type: 'resizeFloating', w, h })}
                onDock={() => {
                  dispatch({ type: 'dock' });
                  setFloatingFocused(false);
                }}
                onFocus={() => setFloatingFocused(true)}
              >
                {null}
              </FloatingWindow>
            )}
          </>
        ) : null}
      </div>
      <ConfirmDialog
        open={!!closing}
        title="Fechar tab"
        message={
          closing?.kind === 'simulator' ? (
            <>
              Fechar <strong>{closing?.name}</strong>? O simulador continua ligado na máquina; só a aba é removida.
            </>
          ) : (
            <>
              Fechar <strong>{closing?.name}</strong>? A sessão tmux <code className="font-mono text-xs">{closing?.tmux_session}</code> será
              encerrada na máquina e o que estiver rodando nela será interrompido.
            </>
          )
        }
        confirmLabel="Fechar tab"
        danger
        onCancel={() => setClosing(null)}
        onConfirm={() => {
          if (closing) void closeTab(closing);
        }}
      />
    </div>
  );
}
```

Como a janela flutuante e a aba são irmãos (a aba não é filha do `FloatingWindow`, para nunca remontar): o frame da janela fica em `z-index: 20` e o wrapper da aba flutuante em `z-index: 21`, posicionado sobre o corpo do frame (o `rectOf` já desconta a barra de título). O `children` do `FloatingWindow` fica vazio (`{null}`). A alça de redimensionar do frame (`z-index` do frame) fica coberta pelo wrapper da aba; por isso o wrapper deixa 16 px livres no canto: acrescente ao `style` do wrapper flutuante `clipPath: 'polygon(0 0, 100% 0, 100% calc(100% - 16px), calc(100% - 16px) 100%, 0 100%)'` — ou, mais simples e preferível, dê ao frame `z-index: 22` só na alça (classe `z-30` no `div` da alça em `FloatingWindow.tsx`). Use a segunda opção: a alça com `z-30` fica acima do wrapper (`21`).

- [ ] **Step 3: Verificar**

Run: `cd /Volumes/Extra/projects/8020/termhub && npm run build -w web`
Expected: vai falhar até a Task 6 adicionar as props novas em `TabBar` (`onScreen`, `preset`, `onPreset`) e `SimulatorView` (`floating`, `onDetach`, `onDock`). Faça a Task 6 antes de commitar esta, ou commite as duas juntas — o commit desta task só acontece com o build limpo.

- [ ] **Step 4: Commit (após a Task 6 compilar)**

```bash
git add web/src/components/TerminalsView.tsx web/src/components/Terminal.tsx web/src/components/SimulatorView.tsx
git commit -m "Terminals: pane presets and floating simulator driven by the layout engine

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: `TabBar` (seletor de preset, marcador) e `SimulatorView` (Destacar/Encaixar)

**Files:**
- Modify: `web/src/components/TabBar.tsx`, `web/src/components/SimulatorView.tsx`, `web/src/components/FloatingWindow.tsx` (alça com `z-30`)

**Interfaces:**
- Produces: `TabBar` props novas `preset: Preset`, `onPreset: (p: Preset) => void`, `onScreen: (tabId: string) => boolean`; `SimulatorView` props novas `floating?: boolean`, `onDetach?: (aspect: number) => void`, `onDock?: () => void`.

- [ ] **Step 1: `TabBar`**

Adicione às props:

```ts
  preset: Preset;
  onPreset: (p: Preset) => void;
  /** whether the tab is currently on screen (in a cell or floating) */
  onScreen: (tabId: string) => boolean;
```

Importe `PRESETS`, `type Preset` de `../lib/layout`. No `map` das abas, além do `active`, calcule `const shown = onScreen(t.id);` e troque o marcador de topo por: `{(active || shown) && <span className={`absolute inset-x-0 top-0 h-px ${active ? 'bg-accent' : 'bg-accent/40'}`} />}`. Depois dos botões `+`/📱, adicione o seletor:

```tsx
      <div className="ml-auto flex items-center gap-0.5 px-2" role="radiogroup" aria-label="Arranjo dos painéis">
        {PRESETS.map((p) => (
          <button
            key={p.key}
            role="radio"
            aria-checked={preset === p.key}
            className={`rounded p-0.5 ${preset === p.key ? 'bg-bg-4 text-fg' : 'text-fg-dim hover:bg-bg-3 hover:text-fg'}`}
            onClick={() => onPreset(p.key)}
            title={p.label}
          >
            <PresetIcon preset={p.key} />
          </button>
        ))}
      </div>
```

E o ícone, no mesmo arquivo:

```tsx
/** 16×12 glyph of the preset's cell arrangement. */
function PresetIcon({ preset }: { preset: Preset }) {
  const cells: [number, number, number, number][] =
    preset === 'single'
      ? [[0, 0, 16, 12]]
      : preset === 'columns'
        ? [
            [0, 0, 7.5, 12],
            [8.5, 0, 7.5, 12],
          ]
        : preset === 'rows'
          ? [
              [0, 0, 16, 5.5],
              [0, 6.5, 16, 5.5],
            ]
          : preset === 'stack-left'
            ? [
                [0, 0, 7.5, 5.5],
                [0, 6.5, 7.5, 5.5],
                [8.5, 0, 7.5, 12],
              ]
            : [
                [0, 0, 7.5, 5.5],
                [0, 6.5, 7.5, 5.5],
                [8.5, 0, 7.5, 5.5],
                [8.5, 6.5, 7.5, 5.5],
              ];
  return (
    <svg width="16" height="12" viewBox="0 0 16 12" aria-hidden>
      {cells.map(([x, y, w, h], i) => (
        <rect key={i} x={x} y={y} width={w} height={h} rx="1" fill="currentColor" />
      ))}
    </svg>
  );
}
```

- [ ] **Step 2: `SimulatorView`**

Props: `floating?: boolean; onDetach?: (aspect: number) => void; onDock?: () => void;`. Na barra de ações, antes do botão Home, adicione:

```tsx
          {floating ? (
            <button className="btn-ghost px-2 py-0.5" onClick={onDock} title="Encaixar no painel focado">
              Encaixar
            </button>
          ) : (
            <button className="btn-ghost px-2 py-0.5" onClick={() => onDetach?.(screen ? screen.width / screen.height : 9 / 19.5)} title="Destacar em janela flutuante">
              Destacar
            </button>
          )}
```

- [ ] **Step 3: `FloatingWindow`**: na `div` da alça de redimensionar, acrescente a classe `z-30` (fica acima do wrapper da aba, `z-index 21`).

- [ ] **Step 4: Verificar e commitar junto com a Task 5**

Run: `cd /Volumes/Extra/projects/8020/termhub && npm run build -w web && npm test -w web`
Expected: build limpo, 28 testes passando. Suba `npm run dev` e confira rapidamente: preset `single` igual ao de antes; trocar para `columns` mostra dois painéis com cabeçalho.

```bash
git add web/src/components/TabBar.tsx web/src/components/SimulatorView.tsx web/src/components/FloatingWindow.tsx web/src/components/TerminalsView.tsx web/src/components/Terminal.tsx
git commit -m "Terminals: preset picker, on-screen markers and detach/dock for the simulator

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

(Se a Task 5 já foi commitada separadamente porque o build passou, commite aqui só os arquivos desta task.)

---

### Task 7: verificação manual

**Files:** o que a verificação apontar.

- [ ] **Step 1: Roteiro** (com `npm run dev`, projeto do Mac mini, 3 terminais e 1 simulador criados)

1. Preset `single`: comportamento idêntico ao anterior (sem cabeçalho de célula, ⌘1-9 troca a aba, ⌘T cria, ⌘W fecha com diálogo). Recarregar a página mantém a aba ativa (migração de `termhub:active-tab`).
2. `columns`: dois painéis com cabeçalho; clicar numa aba na barra coloca na célula focada; clicar dentro de um painel muda o foco (borda); o seletor do cabeçalho troca a aba; ✕ esvazia sem fechar a aba; "+ terminal" na célula vazia cria e coloca ali.
3. `rows`, `stack-left`, `grid`: mesmas regras; trocar de preset mantém as primeiras abas e nunca pisca um terminal (o prompt e o histórico continuam).
4. Mover uma aba de célula pelo seletor: o terminal não reconecta (badge continua "Conectado", o que estava rodando continua).
5. Simulador: "Destacar" abre a janela no canto inferior direito com o stream rodando; arrastar pela barra de título; redimensionar pela alça; não sai da área; mínimo 200×300; "Encaixar" volta para a célula focada.
6. Sair para Tarefas e voltar: layout e janela no mesmo lugar. Recarregar a página: idem. Diminuir a janela do navegador: a janela flutuante entra na área.
7. Fechar uma aba que está numa célula: célula fica vazia. Fechar a aba flutuante: janela some.
8. Abas marcadas na barra (sublinhado) correspondem ao que está na tela.
9. Sidebar recolhida/expandida (feature da main): os painéis reajustam.

- [ ] **Step 2: Suíte completa**

Run: `cd /Volumes/Extra/projects/8020/termhub && npm test && npm run typecheck -w server && npm run build -w web && npm run build -w server`

- [ ] **Step 3: Commit dos ajustes** com mensagem em inglês e o trailer.

---

## Auto-revisão do plano

- **Cobertura da spec:** modelo/ações/invariantes/atalhos (T2, T5); motor com retângulos, `visibility: hidden`, `active` = tem retângulo, camada de células, `single` sem cabeçalho (T3, T5); janela flutuante com limites, mínimo, posição inicial, destacar/encaixar, z-index e foco (T2, T4, T5, T6); interface: seletor de preset, marcador, cabeçalhos, vazio, botões (T3, T6); arquivos (T1–T6); casos de borda via `sanitize`/`clampFloating` (T2, T5); testes do módulo puro + CI (T1, T2) e roteiro (T7).
- **Consistência:** `reduce(layout, action, area)`, `placeOf`, `initialFloatingRect(area, aspect)`, `loadLayout(projectId, tabIds, area)`/`saveLayout` usados em T5 como definidos em T2; `PANE_HEADER_HEIGHT`/`FLOATING_TITLE_HEIGHT` de T3/T4 usados em T5; props novas de `TabBar`/`SimulatorView` definidas em T6 e consumidas em T5 (por isso T5 e T6 commitam juntas).
- **Placeholders:** nenhum.
