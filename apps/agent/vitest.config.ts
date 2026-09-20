import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Guards every test file against touching the machine's real service manager (see test-setup.ts).
    setupFiles: ['./src/test-setup.ts'],
  },
});
