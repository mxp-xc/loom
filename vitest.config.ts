import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

const webSrc = fileURLToPath(new URL('./packages/web/src/', import.meta.url))

export default defineConfig({
  resolve: {
    alias: { '@': webSrc },
  },
  test: {
    projects: ['packages/*'],
    coverage: { include: ['packages/*/src/**'] },
    testTimeout: 30000,
    globals: true,
    setupFiles: ['./packages/web/test/setup.ts'],
    environmentOptions: { jsdom: { url: 'http://localhost/' } },
    exclude: ['**/node_modules/**', '**/.claude/worktrees/**', '**/.worktrees/**'],
  },
})
