import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@optimystic/core': fileURLToPath(new URL('../../packages/core/src/index.ts', import.meta.url)) } },
  server: { port: 5173, proxy: { '/api': 'http://localhost:8080' } },
  build: { outDir: 'dist', sourcemap: true, assetsInlineLimit: 0 }
});
