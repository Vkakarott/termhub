/* global jest */
// The `ui` jest project renders screens under jest-expo. Native modules touched at import time
// are replaced here, so a test only mocks what it is about.

// Safe-area insets have no native side under jest.
jest.mock('react-native-safe-area-context', () => {
  const { View } = require('react-native');
  const insets = { top: 0, right: 0, bottom: 0, left: 0 };
  const frame = { x: 0, y: 0, width: 390, height: 844 };
  return {
    ...require('react-native-safe-area-context/jest/mock'),
    initialWindowMetrics: { insets, frame },
    useSafeAreaInsets: () => insets,
    useSafeAreaFrame: () => frame,
    SafeAreaProvider: ({ children }) => children,
    SafeAreaView: View,
  };
});
