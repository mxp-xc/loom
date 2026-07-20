import { configDefaults, defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: 'server',
    environment: 'node',
    include: ['test/**/*.test.{ts,tsx}'],
    exclude: [...configDefaults.exclude, '**/temp/**'],
    testTimeout: 30000,
    clearMocks: true,
    restoreMocks: true,
    unstubEnvs: true,
    unstubGlobals: true,
  },
})
