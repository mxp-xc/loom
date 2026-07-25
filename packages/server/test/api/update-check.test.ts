import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { createRemoteRoutes } from '../../src/api/routes/remote.js'
import { NodeFileSystem } from '../../src/platform/node/fs.js'
import type { IGit } from '../../src/ports/git.js'

let home: string
let repoPath: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'loom-update-check-'))
  repoPath = join(home, '.loom', 'repos', 'default')
  await mkdir(repoPath, { recursive: true })
  await writeFile(join(repoPath, 'skills.yaml'), 'sources: []\nskills: []\n')
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

describe('source update check', () => {
  it('returns needsRepair without contacting the remote when the local cache is missing', async () => {
    const git = mockGit()
    const app = new Hono().route(
      '/api',
      createRemoteRoutes({
        fs: new NodeFileSystem(),
        git,
        proc: {} as never,
        home,
      }),
    )

    const response = await app.request('/api/update', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo: 'default', sources: [source()] }),
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      updates: [
        {
          source: source(),
          hasUpdate: true,
          needsRepair: true,
          latestCommit: 'commit-1',
        },
      ],
    })
    expect(git.lsRemote).not.toHaveBeenCalled()
    expect(git.revParseHead).not.toHaveBeenCalled()
  })

  it('checks the remote only after a healthy local cache is confirmed', async () => {
    await mkdir(join(repoPath, 'remote-cache', 'skills', '.git'), { recursive: true })
    const git = mockGit()
    const app = new Hono().route(
      '/api',
      createRemoteRoutes({
        fs: new NodeFileSystem(),
        git,
        proc: {} as never,
        home,
      }),
    )

    const response = await app.request('/api/update', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo: 'default', sources: [source()] }),
    })

    expect(response.status).toBe(200)
    expect(git.revParseHead).toHaveBeenCalledTimes(1)
    expect(git.lsRemote).toHaveBeenCalledTimes(1)
  })
})

function source() {
  return {
    name: 'skills',
    url: 'https://example.test/skills.git',
    ref: 'main',
    pinned_commit: 'commit-1',
    members: [],
  }
}

function mockGit(): IGit {
  return {
    revParseHead: vi.fn(async () => 'commit-1'),
    lsRemote: vi.fn(async () => ({ tags: {}, head: 'commit-1', branches: ['main'] })),
  } as Partial<IGit> as IGit
}
