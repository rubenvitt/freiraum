import preact from '@preact/preset-vite'
import { defineConfig } from 'vitest/config'

// Web-Oberfläche von Freiraum (ADR 0007). Der Build liegt im Backend-Image und wird dort mit der
// strengen CSP ausgeliefert: kein Inline-Skript, kein Inline-Stil, nichts von fremden Servern.
export default defineConfig({
  plugins: [preact()],
  build: {
    assetsDir: 'assets',
    assetsInlineLimit: 0,
    modulePreload: { polyfill: false },
    sourcemap: false,
  },
  server: {
    // Gleicher Ursprung aus Sicht des Browsers: die API läuft im Backend auf Port 3000.
    proxy: { '/v1': 'http://localhost:3000' },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
