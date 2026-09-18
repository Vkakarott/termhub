import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/cli.ts'],
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  banner: { js: '#!/usr/bin/env node' },
  // Workspace packages are private and not published — bundle them into dist/cli.js.
  noExternal: ['@termhub/agent-protocol', '@termhub/machine-ops'],
  // Native/runtime deps stay external: node-pty ships a native addon, ws/zod are ordinary
  // npm deps resolved from the installed node_modules at runtime.
  external: ['node-pty', 'ws', 'zod'],
  clean: true,
  sourcemap: false,
});
