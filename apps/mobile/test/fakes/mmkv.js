/* global module */
// In-memory stand-in for `react-native-mmkv` under jest, where the native module is unavailable.
// Instances that share an `id` share their storage, mirroring how the real MMKV persists by id.

const stores = new Map();

function storeFor(id) {
  if (!stores.has(id)) stores.set(id, new Map());
  return stores.get(id);
}

class MMKV {
  constructor(config = {}) {
    this._store = storeFor(config.id ?? 'default');
  }

  getString(key) {
    return this._store.get(key);
  }

  set(key, value) {
    this._store.set(key, String(value));
  }

  delete(key) {
    this._store.delete(key);
  }

  contains(key) {
    return this._store.has(key);
  }

  getAllKeys() {
    return Array.from(this._store.keys());
  }

  clearAll() {
    this._store.clear();
  }
}

module.exports = { MMKV };
