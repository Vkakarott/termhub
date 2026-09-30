/** WheelEvent.deltaMode values (DOM_DELTA_PIXEL / _LINE / _PAGE), spelled out so tests need no DOM. */
const DELTA_LINE = 1;
const DELTA_PAGE = 2;
/** Used when the cell height is not known yet (terminal not rendered). */
const FALLBACK_CELL_HEIGHT = 16;

/**
 * Turns one wheel event into whole terminal lines (TER-465): < 0 up (older output), > 0 down. A trackpad
 * sends many small pixel deltas, so the fraction left over is carried into the next event (`carry`);
 * turning around drops it, so a change of direction answers at once.
 */
export function wheelLines(
  e: { deltaY: number; deltaMode: number },
  carry: number,
  size: { cellHeight: number; rows: number },
): { lines: number; carry: number } {
  if (e.deltaY === 0) return { lines: 0, carry };
  const amount =
    e.deltaMode === DELTA_PAGE ? e.deltaY * size.rows : e.deltaMode === DELTA_LINE ? e.deltaY : e.deltaY / (size.cellHeight > 0 ? size.cellHeight : FALLBACK_CELL_HEIGHT);
  const kept = Math.sign(carry) === Math.sign(amount) ? carry : 0;
  const total = kept + amount;
  const lines = Math.trunc(total) || 0; // never -0
  return { lines, carry: total - lines };
}
