import { configDefaults, defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: 'core',
    environment: 'node',
    include: ['test/**/*.test.ts'],
    exclude: [...configDefaults.exclude, '**/temp/**'],
  },
})
