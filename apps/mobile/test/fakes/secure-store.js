// In-memory stand-in for `expo-secure-store` under jest, where the native keychain is unavailable.
// `__items` is exported so a test can inspect or clear the store directly.

const items = new Map();

module.exports = {
  __items: items,
  getItemAsync: async (k) => items.get(k) ?? null,
  setItemAsync: async (k, v) => {
    items.set(k, v);
  },
  deleteItemAsync: async (k) => {
    items.delete(k);
  },
  canUseBiometricAuthentication: () => true,
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY',
};
