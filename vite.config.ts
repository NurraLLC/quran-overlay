import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const backend = `http://127.0.0.1:${process.env.PORT ?? 4317}`;

export default defineConfig({
  root: 'src/web',
  // Relative asset addresses: the server anchors them under QO_BASE_PATH when it serves the page.
  base: './',
  // Web app manifest and icons (installable reader).
  publicDir: 'public',
  plugins: [react()],
  build: { outDir: '../../dist/web', emptyOutDir: true },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': backend,
      '/fonts': backend,
      '/ws': { target: backend.replace('http', 'ws'), ws: true },
    },
  },
});
