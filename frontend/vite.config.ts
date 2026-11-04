import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig(({ command, mode }) => {
  // index.html hands Shopify App Bridge the app's public client id (%VITE_SHOPIFY_API_KEY%). Left
  // unset, Vite would ship the literal placeholder and the app would open as a blank page inside the
  // Shopify admin, with nothing in the build to say why — so a build without it stops here instead.
  // Development is left alone: outside the admin App Bridge does nothing, and a key is not needed.
  const env = loadEnv(mode, process.cwd(), 'VITE_')
  if (command === 'build' && !env.VITE_SHOPIFY_API_KEY?.trim()) {
    throw new Error(
      'VITE_SHOPIFY_API_KEY is not set. Set it to the Shopify app\'s public client id before building ' +
        '(see frontend/.env.example), e.g. in PowerShell: $env:VITE_SHOPIFY_API_KEY = "<client id>"',
    )
  }

  return {
    plugins: [react()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
    server: {
      // Mirrors the production setup in server.cjs: the app always calls a same-origin /api.
      proxy: {
        '/api': {
          target: process.env.API_ORIGIN ?? 'http://127.0.0.1:5000',
          changeOrigin: true,
        },
      },
    },
  }
})
