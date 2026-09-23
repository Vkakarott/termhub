import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/** The public city: the same scene, built on its own with base /city/ so it never shares an asset path with the app or the landing. */
export default defineConfig({
  base: '/city/',
  plugins: [react()],
  build: { outDir: 'dist-city', sourcemap: false, rollupOptions: { input: 'index-city.html' } },
});
