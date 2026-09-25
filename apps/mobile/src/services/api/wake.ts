// The chat socket's wake-up call (design spec §4.1): emitted when the app comes back to the
// foreground and when the session enters `unlocked`, so a socket that backed off while the app
// was away (or locked) reconnects at once instead of waiting out its backoff.
import { signal } from '../signal';

export const socketWake = signal();
