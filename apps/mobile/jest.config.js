const expoPreset = require('jest-expo/jest-preset');

const moduleNameMapper = {
  '^@/(.*)$': '<rootDir>/src/$1',
  // babel-preset-expo rewrites `process.env.EXPO_PUBLIC_*` to `expo/virtual/env` (ESM); the plain
  // Node `logic` project cannot load that module, so it gets a stub.
  '^expo/virtual/env$': '<rootDir>/test/expo-env-stub.js',
};

// The `ui` project renders NativeWind-styled components: nativewind and react-native-css-interop
// ship untransformed ESM, so jest-expo's own ignore list is extended to transform them too.
const [expoIgnore, ...restIgnore] = expoPreset.transformIgnorePatterns;
const uiTransformIgnore = [
  expoIgnore.replace('))', '|nativewind|react-native-css-interop|react-native-markdown-display))'),
  ...restIgnore,
];

/**
 * Two projects keep the pure logic apart from the screens (spec §14):
 * - `logic` (*.test.ts): `src/lib` runs in plain Node — no jest-expo preset, no React Native.
 *   A module that pulls in RN fails here, which is the point.
 * - `ui` (*.test.tsx): screens and components under jest-expo + @testing-library/react-native.
 */
/** @type {import('jest').Config} */
module.exports = {
  passWithNoTests: true,
  projects: [
    {
      displayName: 'logic',
      testEnvironment: 'node',
      testMatch: ['<rootDir>/src/**/*.test.ts'],
      transform: { '\\.[jt]sx?$': 'babel-jest' },
      // @noble/hashes ships ESM-only (`"type": "module"`); transform it too so plain `require` doesn't choke on `import`.
      transformIgnorePatterns: ['/node_modules/(?!(@noble)/)'],
      moduleNameMapper,
      setupFiles: ['<rootDir>/test/logic-setup.js'],
    },
    {
      displayName: 'ui',
      preset: 'jest-expo',
      testMatch: ['<rootDir>/(app|src)/**/*.test.tsx'],
      setupFiles: ['<rootDir>/test/ui-setup.js'],
      transformIgnorePatterns: uiTransformIgnore,
      moduleNameMapper: { ...moduleNameMapper, '\\.css$': '<rootDir>/test/css-stub.js' },
    },
  ],
};
