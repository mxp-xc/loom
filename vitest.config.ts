import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

const webSrc = fileURLToPath(new URL('./packages/web/src/', import.meta.url))
const webTestSetup = fileURLToPath(new URL('./packages/web/test/setup.ts', import.meta.url))

export default defineConfig({
  resolve: {
    alias: { '@': webSrc },
  },
  test: {
    projects: ['packages/*'],
    coverage: { include: ['packages/*/src/**'] },
    setupFiles: [webTestSetup],
    testTimeout: 30000,
    globals: true,
    maxConcurrency: 8,
    poolOptions: { threads: { maxThreads: 4 } },
    exclude: ['**/node_modules/**', '**/.claude/worktrees/**', '**/.worktrees/**'],
  },
})
