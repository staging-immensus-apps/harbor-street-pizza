// FIXED. `base: '/web/'` because Harper's static plugin serves the build
// under /web/ (rule 22) — static at the root swallowed every Fastify route. Build
// output is web/ (BUILT, gitignored); `npm run build` must run before any deploy.
//
// Dev: `harper dev .` serves the API on 9926; `vite` serves src/ with HMR and proxies
// every resource path and /build to it. No @harperfast/vite-plugin.

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'

const HARPER = process.env.HARPER_DEV_URL ?? 'http://localhost:9926'

export default defineConfig({
  base: '/web/',
  plugins: [react()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  build: {
    outDir: 'web',
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    port: 5173,
    proxy: {
      // Every Harper resource — a class name, so its path starts with a capital: /<Entity>Api, and a kit's
      // own (/AuthApi, /Bootstrap, /StripeWebhook) — and /build. A page route is lower-case by convention
      // and stays with Vite. No resource is named here, so a kit the platform copies in needs no edit.
      '^/(?:[A-Z][A-Za-z0-9]*|build)(?:/|$)': { target: HARPER, changeOrigin: false },
    },
  },
})
