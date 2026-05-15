import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  server: {
    port: 7777,
    strictPort: false,
    host: '127.0.0.1',
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:7778',
        changeOrigin: true,
        ws: false,
        configure: (proxy) => {
          proxy.on('proxyRes', (proxyRes) => {
            proxyRes.headers['cache-control'] = 'no-cache';
          });
        },
      },
    },
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        session: resolve(__dirname, 'session.html'),
      },
    },
  },
});
