import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Static marketing site served at termhub.dev (see landing/Dockerfile).
export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', sourcemap: false },
});
