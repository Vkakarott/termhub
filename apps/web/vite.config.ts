import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * A stamp of when this bundle was built, shown in the chat's header. It exists to settle one
 * question quickly: when a fix does not appear on a device, is the device showing an old page or is
 * the new code simply not fixing it? Without it every such report costs a round of guessing.
 */
const BUILD_STAMP = new Date().toISOString().slice(5, 16).replace('T', ' ');

export default defineConfig({
  define: { __BUILD_STAMP__: JSON.stringify(BUILD_STAMP) },
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
