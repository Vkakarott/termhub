const moduleNameMapper = {
  '^@/(.*)$': '<rootDir>/src/$1',
  // babel-preset-expo rewrites `process.env.EXPO_PUBLIC_*` to `expo/virtual/env` (ESM); the plain
  // Node `logic` project cannot load that module, so it gets a stub.
  '^expo/virtual/env$': '<rootDir>/test/expo-env-stub.js',
};

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
      moduleNameMapper,
    },
    {
      displayName: 'ui',
      preset: 'jest-expo',
      testMatch: ['<rootDir>/(app|src)/**/*.test.tsx'],
      setupFiles: ['<rootDir>/test/ui-setup.js'],
      // jest-expo's own transformIgnorePatterns already cover react-native, expo and the
      // navigation packages; a native library that ships untransformed ESM is added here when needed.
      moduleNameMapper,
    },
  ],
};
