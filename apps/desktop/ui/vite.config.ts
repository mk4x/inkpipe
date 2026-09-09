import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The UI is served by the sidecar in production, so the build lands in dist/
// and the dev server proxies API calls to a locally running service.
export default defineConfig({
  plugins: [react()],
  root: import.meta.dirname,
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    port: 5273,
    proxy: {
      '/api': { target: process.env.INKPIPE_SERVICE ?? 'http://127.0.0.1:5272', changeOrigin: true },
    },
  },
});
