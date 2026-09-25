import { requireSimCapable } from '../agent/errors.js';
import type { Machine } from '../db/repositories/types.js';
import { HttpError } from '../lib/errors.js';

/**
 * The `status: error` message `/ws/sim` sends instead of starting a session on a machine that cannot
 * run one (agent offline, not a Mac, or an agent without `sim`); null when it can. The same
 * `requireSimCapable` gate as the HTTP routes, so an old agent never gets an RPC it cannot answer.
 */
export function simGateMessage(machine: Machine): string | null {
  try {
    requireSimCapable(machine);
    return null;
  } catch (err) {
    if (err instanceof HttpError) return err.message;
    throw err;
  }
}
