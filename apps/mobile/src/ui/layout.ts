/**
 * Widths for tablets and multitasking (spec 2026-09-28 iPad §2.3, §2.4). Pure on purpose: no React
 * Native import, so the `logic` project tests it.
 */

/** From this window width on, Chats shows the list and the conversation side by side: the iPad mini
 * in portrait (744) splits; Slide Over (320), a 50/50 Split View on an 11" iPad (~590) and every
 * iPhone (portrait only, ≤ 440) stay compact. */
export const WIDE_MIN_WIDTH = 700;
/** The list pane of the split. */
export const SPLIT_LIST_WIDTH = 320;
/** Past this, text and forms stop being comfortable to read: content is centred in a column. */
export const MAX_READABLE_WIDTH = 720;
/** The bottom sheets' panel, centred, on a wide window. */
export const SHEET_MAX_WIDTH = 560;

export function isWide(width: number): boolean {
  return width >= WIDE_MIN_WIDTH;
}
