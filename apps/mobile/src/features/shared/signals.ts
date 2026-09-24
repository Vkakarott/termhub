type Listener = () => void;

/**
 * A minimal pub/sub primitive with no payload: a feature that needs to react to an event without
 * importing the store that raises it subscribes here instead, keeping dependencies one-directional
 * (design spec §3).
 */
export function signal() {
  const listeners = new Set<Listener>();
  return {
    subscribe(listener: Listener): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    emit(): void {
      listeners.forEach((listener) => listener());
    },
  };
}

/**
 * Fired when a session ends — "Sair e remover este aparelho" or a `DEVICE_REVOKED` response
 * (design spec §5.5). Every feature store that persists per-session data subscribes and resets
 * itself, so the next enrolled device never sees the previous session's data.
 */
export const sessionEnded = signal();
