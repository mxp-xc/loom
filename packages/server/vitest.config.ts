import { defineProject } from 'vitest/config'
export default defineProject({
  test: { environment: 'node', include: ['test/**/*.test.{ts,tsx}'], testTimeout: 30000 },
})
