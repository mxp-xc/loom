import { afterEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deriveRepoId } from '@loom/core'
import { createRemoteRoutes } from '../../src/api/routes/remote.js'
import { createNodePlatform } from '../../src/platform/node/index.js'

const SOURCE_URL = 'https://example.test/owned-source.git'
const SOURCE_ID = deriveRepoId(SOURCE_URL)

describe('source cache route boundary', () => {
  const roots: string[] = []

  afterEach(async () => {
    vi.restoreAllMocks()
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  })

  async function createFixture() {
    const home = await realpath(await mkdtemp(join(tmpdir(), 'loom-source-cache-home-')))
    const external = await realpath(await mkdtemp(join(tmpdir(), 'loom-source-cache-external-')))
    roots.push(home, external)
    const repoPath = join(home, '.loom', 'repos', 'demo')
    await mkdir(repoPath, { recursive: true })
    await writeFile(
      join(repoPath, 'skills.yaml'),
      [
        'sources:',
        `  - url: ${SOURCE_URL}`,
        '    ref: main',
        '    pinned_commit: abcdef1',
        'skills: []',
        '',
      ].join('\n'),
    )
    const platform = createNodePlatform()
    const app = new Hono().route('/api', createRemoteRoutes({ ...platform, home }))
    return { app, external, platform, repoPath }
  }

  it.each(['/api/sources/tree', '/api/sources/refresh'])(
    'rejects a direct-child source cache link before Git for %s',
    async (path) => {
      const { app, external, platform, repoPath } = await createFixture()
      await mkdir(join(external, '.git'))
      await writeFile(join(external, 'sentinel.txt'), 'keep')
      await mkdir(join(repoPath, 'remote-cache'))
      await symlink(
        external,
        join(repoPath, 'remote-cache', SOURCE_ID),
        process.platform === 'win32' ? 'junction' : 'dir',
      )
      const revParse = vi.spyOn(platform.git, 'revParse')
      const clone = vi.spyOn(platform.git, 'clone')

      const response = await app.request(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          repo: 'demo',
          url: SOURCE_URL,
          ...(path.endsWith('/tree') ? { pinned_commit: 'abcdef1' } : { ref: 'main' }),
        }),
      })

      expect(response.status).toBe(422)
      expect(await response.json()).toMatchObject({ ok: false, error: 'invalid_source_cache' })
      expect(revParse).not.toHaveBeenCalled()
      expect(clone).not.toHaveBeenCalled()
      expect(await readFile(join(external, 'sentinel.txt'), 'utf8')).toBe('keep')
    },
  )

  it('rejects a linked source cache root without cloning into its target', async () => {
    const { app, external, platform, repoPath } = await createFixture()
    await writeFile(join(external, 'sentinel.txt'), 'keep')
    await symlink(
      external,
      join(repoPath, 'remote-cache'),
      process.platform === 'win32' ? 'junction' : 'dir',
    )
    const clone = vi.spyOn(platform.git, 'clone')

    const response = await app.request('/api/sources/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo: 'demo', url: SOURCE_URL, ref: 'main' }),
    })

    expect(response.status).toBe(422)
    expect(await response.json()).toMatchObject({ ok: false, error: 'invalid_source_cache' })
    expect(clone).not.toHaveBeenCalled()
    expect(await readFile(join(external, 'sentinel.txt'), 'utf8')).toBe('keep')
    expect(await platform.fs.inspectEntry(join(external, SOURCE_ID))).toBeNull()
  })

  it('rejects an unregistered URL before inspecting or cloning a cache', async () => {
    const { app, platform } = await createFixture()
    const clone = vi.spyOn(platform.git, 'clone')
    const revParse = vi.spyOn(platform.git, 'revParse')

    const response = await app.request('/api/sources/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        repo: 'demo',
        url: 'https://example.test/not-registered.git',
        ref: 'main',
      }),
    })

    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({ ok: false, error: 'source_not_found' })
    expect(clone).not.toHaveBeenCalled()
    expect(revParse).not.toHaveBeenCalled()
  })
})
