import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:8787',
        changeOrigin: true,
        // Without this the WebSocket upgrade is not forwarded, so real-time
        // delivery silently never worked in development.
        ws: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    // The Worker serves dist/ as public static assets, so a source map here is
    // published to the internet — the previous `true` shipped a 1.7 MB map and
    // with it the full annotated source. Build locally with `vite build
    // --sourcemap` when you actually need one.
    sourcemap: false,
  },
});
