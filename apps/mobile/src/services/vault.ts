import * as SecureStore from 'expo-secure-store';

/** The closed set of secrets the app ever puts in SecureStore (design spec §5.1). */
export type VaultKey = 'key.private' | 'pin.wrapped' | 'pin.salt' | 'pin.biometric' | 'device.id';

const KEYS: VaultKey[] = ['key.private', 'pin.wrapped', 'pin.salt', 'pin.biometric', 'device.id'];

const opts = (biometric: boolean): SecureStore.SecureStoreOptions => ({
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  requireAuthentication: biometric,
  authenticationPrompt: 'Desbloquear o termhub',
});

export const vault = {
  get: (key: VaultKey, biometric = false) => SecureStore.getItemAsync(key, opts(biometric)),
  set: (key: VaultKey, value: string, { biometric = false } = {}) => SecureStore.setItemAsync(key, value, opts(biometric)),
  delete: (key: VaultKey) => SecureStore.deleteItemAsync(key),
  clear: async () => {
    for (const k of KEYS) await SecureStore.deleteItemAsync(k).catch(() => undefined);
  },
};
