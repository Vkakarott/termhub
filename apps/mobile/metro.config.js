const { getDefaultConfig } = require('expo/metro-config');
const { withNativeWind } = require('nativewind/metro');

// expo/metro-config detects the npm workspace root on its own; only NativeWind is layered on.
module.exports = withNativeWind(getDefaultConfig(__dirname), { input: './global.css' });
