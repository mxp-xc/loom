import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const webuiSrc = resolve(dirname(fileURLToPath(import.meta.url)), 'webui', 'src')

export default defineConfig({
  esbuild: { jsx: 'automatic', jsxImportSource: 'react' },
  resolve: {
    alias: { '@': webuiSrc },
    dedupe: ['react', 'react-dom', 'react-router-dom'],
  },
  test: { environment: 'node', globals: true },
})
