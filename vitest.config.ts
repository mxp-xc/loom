import { configDefaults, defineConfig } from 'vitest/config'
import { availableParallelism } from 'node:os'

const maxWorkers = Math.min(6, Math.max(1, Math.round(availableParallelism() * 0.6)))

export default defineConfig({
  test: {
    coverage: { include: ['packages/*/src/**'] },
    testTimeout: 30000,
    pool: 'forks',
    isolate: true,
    fileParallelism: true,
    minWorkers: 1,
    maxWorkers,
    exclude: [
      ...configDefaults.exclude,
      '**/.claude/worktrees/**',
      '**/.worktrees/**',
      '**/temp/**',
    ],
  },
})
