import { configDefaults, defineProject } from 'vitest/config'
import { fileURLToPath } from 'node:url'

const testSetup = fileURLToPath(new URL('./test/setup.ts', import.meta.url))

export default defineProject({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src/', import.meta.url)) },
    dedupe: ['react', 'react-dom', 'react-router-dom'],
  },
  test: {
    name: 'web',
    globals: true,
    environment: 'jsdom',
    environmentOptions: { jsdom: { url: 'http://localhost/' } },
    setupFiles: [testSetup],
    include: ['test/**/*.test.{ts,tsx}'],
    exclude: [...configDefaults.exclude, '**/temp/**'],
  },
})
