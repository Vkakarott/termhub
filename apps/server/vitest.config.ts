import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Loads the key `publicId` needs (production loads it from the database at boot).
    setupFiles: ['./test/setup.ts'],
  },
});
