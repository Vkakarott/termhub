import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Static marketing site served at termhub.dev (see landing/Dockerfile).
export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', sourcemap: false },
  // dev: the waitlist form posts to the API served by the app (npm run dev:server)
  server: { proxy: { '/api': 'http://localhost:3000' } },
});
