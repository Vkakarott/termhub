/** 1012 = the server is restarting (a deploy) or the machine is reconnecting: come back right away (spec 2026-09-27 §5.5). */
export const RESTART_CLOSE = 1012;

export function reconnectDelay(code: number, fallbackMs: number, rand: () => number = Math.random): number {
  return code === RESTART_CLOSE ? 250 + 500 * rand() : fallbackMs;
}
