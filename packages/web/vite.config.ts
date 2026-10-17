import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwind from '@tailwindcss/vite'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const server = process.env.DMIXER_SERVER ?? 'http://localhost:5184'

export default defineConfig({
  plugins: [react(), tailwind()],
  resolve: {
    alias: {
      // core as source: the browser and the server run the same code
      '@dmixer/core': path.resolve(here, '../core/src/index.ts'),
      '@': path.resolve(here, 'src'),
    },
  },
  server: {
    port: 5183,
    host: process.env.DMIXER_UI_HOST ?? 'localhost',
    allowedHosts: ['localhost', '127.0.0.1', '.ts.net'],
    proxy: {
      '/api': { target: server, changeOrigin: true },
      '/ws': { target: server.replace('http', 'ws'), ws: true },
    },
  },
})
