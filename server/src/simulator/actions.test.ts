import { describe, expect, it } from 'vitest';
import { dragActions, tapActions } from './actions.js';

describe('tapActions', () => {
  it('move, pressiona, pausa 80ms e solta', () => {
    const a = tapActions({ x: 10.6, y: 20.4 });
    expect(a.actions).toHaveLength(1);
    const seq = a.actions[0];
    expect(seq.type).toBe('pointer');
    expect(seq.parameters).toEqual({ pointerType: 'touch' });
    expect(seq.actions).toEqual([
      { type: 'pointerMove', duration: 0, x: 11, y: 20 },
      { type: 'pointerDown', button: 0 },
      { type: 'pause', duration: 80 },
      { type: 'pointerUp', button: 0 },
    ]);
  });
});

describe('dragActions', () => {
  it('usa as diferenças de t como duração dos moves', () => {
    const a = dragActions([
      { x: 0, y: 0, t: 1000 },
      { x: 10, y: 50, t: 1016 },
      { x: 20, y: 120, t: 1040 },
    ]);
    expect(a.actions[0].actions).toEqual([
      { type: 'pointerMove', duration: 0, x: 0, y: 0 },
      { type: 'pointerDown', button: 0 },
      { type: 'pointerMove', duration: 16, x: 10, y: 50 },
      { type: 'pointerMove', duration: 24, x: 20, y: 120 },
      { type: 'pointerUp', button: 0 },
    ]);
  });

  it('duração mínima 1ms e máxima 2000ms', () => {
    const a = dragActions([
      { x: 0, y: 0, t: 0 },
      { x: 1, y: 1, t: 0 },
      { x: 2, y: 2, t: 99999 },
    ]);
    const moves = a.actions[0].actions.filter((x) => x.type === 'pointerMove');
    expect(moves[1]).toMatchObject({ duration: 1 });
    expect(moves[2]).toMatchObject({ duration: 2000 });
  });

  it('com um ponto só vira tap', () => {
    expect(dragActions([{ x: 5, y: 5, t: 0 }])).toEqual(tapActions({ x: 5, y: 5 }));
  });

  it('sem pontos lança erro', () => {
    expect(() => dragActions([])).toThrow();
  });
});
