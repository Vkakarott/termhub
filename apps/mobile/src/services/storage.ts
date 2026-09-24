import { MMKV } from 'react-native-mmkv';
import type { StateStorage } from 'zustand/middleware';

export const mmkv = new MMKV({ id: 'termhub' });

export const mmkvStateStorage: StateStorage = {
  getItem: (name) => mmkv.getString(name) ?? null,
  setItem: (name, value) => {
    mmkv.set(name, value);
  },
  removeItem: (name) => {
    mmkv.delete(name);
  },
};

/**
 * Clears every persisted zustand store (design spec §5.5: `wipe()` on "Sair e remover este
 * aparelho" or a `DEVICE_REVOKED` response resets every store that persists to MMKV).
 */
export function resetPersistedStores(): void {
  mmkv.clearAll();
}
