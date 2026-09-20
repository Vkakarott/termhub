import type { Machine } from '../db/repositories/types.js';
import { sendTextToSession } from '../terminal/session-ops.js';

// Declared once in session-ops.ts (also used by control/terminals.ts); re-exported here so
// apps/server/src/routes/tabs.ts keeps its existing named import.
export { INPUT_MAX_CHARS } from '../terminal/session-ops.js';
import { INPUT_MAX_CHARS } from '../terminal/session-ops.js';

/**
 * Types `text` into the tab's tmux session (literal keys) and, with `enter`, presses Enter after a
 * short pause. Works on agent machines too (named RPCs) as well as local/ssh, with or without a
 * terminal attached in the browser.
 */
export async function sendKeysToSession(machine: Machine, session: string, text: string, enter: boolean): Promise<{ ok: boolean; error: string | null }> {
  if (text.length > INPUT_MAX_CHARS) throw new Error('Texto longo demais');
  try {
    await sendTextToSession(machine, session, text, enter);
    return { ok: true, error: null };
  } catch (e) {
    // The monitor route reports the failure in the response body instead of a 5xx; keep that contract.
    return { ok: false, error: e instanceof Error ? e.message : 'tmux send-keys falhou' };
  }
}
