import { defineConfig } from '../../../packages/web/node_modules/vite/dist/node/index.js'
import tailwindcss from '../../../packages/web/node_modules/@tailwindcss/vite/dist/index.mjs'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [tailwindcss()],
  esbuild: {
    jsx: 'automatic',
    jsxImportSource: 'react',
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('../../../packages/web/src/', import.meta.url)),
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5187,
  },
})
