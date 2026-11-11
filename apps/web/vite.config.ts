import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const apiTarget = process.env.API_PROXY_TARGET ?? 'http://localhost:8787';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // The SPA always calls same-origin `/api/...`; Vite proxies to the API in
    // development so cookies are first-party and no CORS config is needed.
    proxy: {
      '/api': { target: apiTarget, changeOrigin: false },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
  test: {
    environment: 'jsdom',
    // localStorage requires a non-opaque origin in jsdom.
    environmentOptions: { jsdom: { url: 'http://localhost:3000/' } },
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    // `userEvent.type` fires one keystroke per character with its own delay.
    // Under a fully loaded root `npm test` run (API suite + LibreOffice in
    // parallel) the default 5 s budget can expire mid-keystroke on slow CI
    // machines, so give jsdom-driven suites headroom. Real budget is asserted by
    // the API integration suite, not by wall-clock time here.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
