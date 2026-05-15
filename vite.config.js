import { defineConfig } from 'vite';

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
        // SSE needs no buffering
        configure: (proxy) => {
          proxy.on('proxyRes', (proxyRes) => {
            // Pass through SSE headers cleanly
            proxyRes.headers['cache-control'] = 'no-cache';
          });
        },
      },
    },
  },
});
