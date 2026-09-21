import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * What the chat's header shows, so that "it did not change on my phone" can be answered by reading
 * the screen instead of guessing whether a device is on an old page. The version alone cannot do
 * that — `@termhub/web` has been `0.1.0` throughout — so it travels with the commit the bundle was
 * built from (`VITE_BUILD_SHA`, passed as a build arg by `deploy/blue-green.sh`), and falls back to
 * a build time when that is absent, which is every local build.
 */
const APP_VERSION = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version as string;
const BUILD_STAMP = new Date().toISOString().slice(5, 16).replace('T', ' ');

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(APP_VERSION), __BUILD_STAMP__: JSON.stringify(BUILD_STAMP) },
  plugins: [react()],
  server: {
    host: process.env.VITE_HOST || 'localhost',
    port: 5173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:3000', changeOrigin: false },
      '/ws': { target: 'ws://127.0.0.1:3000', ws: true, changeOrigin: false },
    },
  },
  build: { outDir: 'dist', sourcemap: false },
});
