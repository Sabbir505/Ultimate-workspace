import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: fileURLToPath(new URL('./site', import.meta.url)),
  base: './',
  publicDir: 'public',
  server: {
    host: '127.0.0.1',
    port: 1510,
    strictPort: true,
  },
  preview: {
    host: '127.0.0.1',
    port: 1511,
    strictPort: true,
  },
  build: {
    outDir: '../dist-site',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: fileURLToPath(new URL('./site/index.html', import.meta.url)),
        docs: fileURLToPath(new URL('./site/docs.html', import.meta.url)),
        releases: fileURLToPath(new URL('./site/releases.html', import.meta.url)),
      },
    },
  },
});
