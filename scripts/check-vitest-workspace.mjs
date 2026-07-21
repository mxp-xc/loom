import assert from 'node:assert/strict'
import { readdir } from 'node:fs/promises'
import { availableParallelism } from 'node:os'
import { relative, resolve, sep } from 'node:path'
import { createVitest } from 'vitest/node'

const repoRoot = resolve(import.meta.dirname, '..')
const expectedMaxWorkers = Math.min(6, Math.max(1, Math.round(availableParallelism() * 0.6)))
const expected = {
  core: {
    root: resolve(repoRoot, 'packages/core'),
    environment: 'node',
    setupFiles: 0,
    suffixes: ['.test.ts'],
  },
  server: {
    root: resolve(repoRoot, 'packages/server'),
    environment: 'node',
    setupFiles: 0,
    suffixes: ['.test.ts', '.test.tsx'],
  },
  web: {
    root: resolve(repoRoot, 'packages/web'),
    environment: 'jsdom',
    setupFiles: 1,
    suffixes: ['.test.ts', '.test.tsx'],
  },
}
const ignoredDirectories = new Set(['temp', 'node_modules', '.git', '.worktrees'])

async function conventionTestFiles(packageRoot, suffixes) {
  const files = []

  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue
      const path = resolve(directory, entry.name)
      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name)) await walk(path)
      } else if (entry.isFile() && suffixes.some((suffix) => entry.name.endsWith(suffix))) {
        files.push(relative(packageRoot, path))
      }
    }
  }

  await walk(resolve(packageRoot, 'test'))
  return files.sort()
}

const vitest = await createVitest('test', {
  root: repoRoot,
  run: true,
  watch: false,
  passWithNoTests: true,
})

try {
  const projects = new Map(vitest.projects.map((project) => [project.getName(), project]))
  assert.deepEqual([...projects.keys()].sort(), Object.keys(expected).sort())
  assert.equal(vitest.config.pool, 'forks', 'root pool')
  assert.equal(vitest.config.isolate, true, 'root isolate')
  assert.equal(vitest.config.fileParallelism, true, 'root fileParallelism')
  assert.equal(vitest.config.minWorkers, 1, 'root minWorkers')
  assert.equal(vitest.config.maxWorkers, expectedMaxWorkers, 'root maxWorkers')

  for (const [name, contract] of Object.entries(expected)) {
    const project = projects.get(name)
    assert(project, `missing Vitest project: ${name}`)
    assert.equal(resolve(project.config.root), contract.root, `${name} root`)
    assert.equal(project.config.environment, contract.environment, `${name} environment`)
    assert.equal(project.config.setupFiles.length, contract.setupFiles, `${name} setupFiles`)
    assert(
      project.config.exclude.some((pattern) => pattern.includes('temp')),
      `${name} must exclude temp`,
    )

    const { testFiles } = await project.globTestFiles()
    assert(testFiles.length > 0, `${name} did not resolve any tests`)
    const actualFiles = testFiles.map((testFile) => relative(contract.root, testFile)).sort()
    for (const testFile of testFiles) {
      const path = relative(contract.root, testFile)
      assert(!path.startsWith(`..${sep}`) && path !== '..', `${name} collected ${testFile}`)
      assert(!path.split(sep).includes('temp'), `${name} collected temp file ${testFile}`)
    }
    const expectedFiles = await conventionTestFiles(contract.root, contract.suffixes)
    const actualSet = new Set(actualFiles)
    const expectedSet = new Set(expectedFiles)
    assert.deepEqual(
      {
        missing: expectedFiles.filter((file) => !actualSet.has(file)),
        unexpected: actualFiles.filter((file) => !expectedSet.has(file)),
      },
      { missing: [], unexpected: [] },
      `${name} test discovery mismatch`,
    )
  }

  console.log(
    [
      ...[...projects.entries()]
        .map(([name, project]) => `${name}:${project.config.environment}`)
        .sort(),
      `pool=${vitest.config.pool}`,
      `workers=${vitest.config.minWorkers}-${vitest.config.maxWorkers}`,
    ].join(' '),
  )
} finally {
  await vitest.close()
}
