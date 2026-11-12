import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'path'

// Kept apart from vite.config.ts so the production build config stays exactly as it is.
export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@': path.resolve(import.meta.dirname, './src') } },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    css: false,
    restoreMocks: true,
    // Every test file builds its own jsdom, and the files run in parallel, so under a full run the
    // CPU is shared and a heavy render (the 120-row list) can take several seconds that it needs
    // well under one on its own. Five seconds is too tight for that; the failure it caused was
    // load, not a bug.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
})
