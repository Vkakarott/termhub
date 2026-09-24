import { signal } from '@/services/signal';

export { signal };

/**
 * Fired when a session ends — "Sair e remover este aparelho" or a `DEVICE_REVOKED` response
 * (design spec §5.5). Every feature store that persists per-session data subscribes and resets
 * itself, so the next enrolled device never sees the previous session's data.
 */
export const sessionEnded = signal();
