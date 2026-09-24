type Listener = () => void;

/**
 * A minimal pub/sub primitive with no payload: a module that needs to react to an event without
 * importing the one that raises it subscribes here instead, keeping dependencies one-directional
 * (design spec §3). Lives in `src/services` so services can use it without importing a feature.
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
