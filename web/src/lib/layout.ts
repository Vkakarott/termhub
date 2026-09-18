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
