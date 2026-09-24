const { getDefaultConfig } = require('expo/metro-config');

// expo/metro-config detects the npm workspace root on its own (watch folders and module paths),
// so nothing is overridden here; expo-doctor flags custom resolver settings as a risk.
module.exports = getDefaultConfig(__dirname);
