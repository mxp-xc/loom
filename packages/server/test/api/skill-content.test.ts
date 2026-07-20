import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deriveRepoId } from '@loom/core'
import { createProjectionRoutes } from '../../src/api/routes/projection.js'
import { NodeFileSystem } from '../../src/platform/node/fs.js'
import type { IGit } from '../../src/ports/git.js'
import type { IProcess } from '../../src/ports/process.js'
import { validationError } from '../helpers/http.js'

const PINNED_COMMIT = 'a'.repeat(40)
const SOURCE_URL = 'https://example.test/team/skills.git'

describe('skill content identity boundary', () => {
  let home: string
  let repoPath: string
  let fs: NodeFileSystem
  let git: IGit
  let readTree: ReturnType<typeof vi.fn>
  let show: ReturnType<typeof vi.fn>
  let app: Hono

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'loom-skill-content-'))
    repoPath = join(home, '.loom', 'repos', 'default')
    await mkdir(repoPath, { recursive: true })
    fs = new NodeFileSystem()
    readTree = vi.fn(async () => [
      {
        mode: '100644',
        type: 'blob' as const,
        oid: 'b'.repeat(40),
        path: 'skills/selected/SKILL.md',
      },
    ])
    show = vi.fn(async () => '# Pinned source skill\n')
    git = { readTree, show } as unknown as IGit
    app = new Hono().route('/api', createProjectionRoutes({ fs, git, proc: {} as IProcess, home }))
    await writeSkillsManifest({ sources: [], skills: [] })
  })

  afterEach(async () => rm(home, { recursive: true, force: true }))

  it('reads and writes registered built-in and external local skills by id', async () => {
    const builtIn = join(repoPath, 'assets', 'skills', 'built-in')
    const external = join(home, 'external-skill')
    await mkdir(builtIn, { recursive: true })
    await mkdir(external, { recursive: true })
    await writeFile(join(builtIn, 'SKILL.md'), '# Built in')
    await writeFile(join(external, 'SKILL.md'), '# External')
    await writeSkillsManifest({
      sources: [],
      skills: [{ id: 'built-in' }, { id: 'external', path: external }],
    })

    const builtInResponse = await app.request(localContentUrl('built-in'))
    expect(builtInResponse.status).toBe(200)
    expect(await builtInResponse.json()).toMatchObject({ ok: true, content: '# Built in' })

    const externalResponse = await app.request(localContentUrl('external'))
    expect(externalResponse.status).toBe(200)
    expect(await externalResponse.json()).toMatchObject({ ok: true, content: '# External' })

    const saved = await app.request('/api/skill/content', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo: 'default', skillId: 'external', content: '# Updated' }),
    })
    expect(saved.status).toBe(200)
    await expect(readFile(join(external, 'SKILL.md'), 'utf8')).resolves.toBe('# Updated')
  })

  it('allows canonical direct-child discovery but never falls back to ~/.agents', async () => {
    const discovered = join(repoPath, 'assets', 'skills', 'discovered')
    const legacy = join(home, '.agents', 'skills', 'legacy')
    await mkdir(discovered, { recursive: true })
    await mkdir(legacy, { recursive: true })
    await writeFile(join(discovered, 'SKILL.md'), '# Discovered')
    await writeFile(join(legacy, 'SKILL.md'), '# Legacy')

    const discoveredResponse = await app.request(localContentUrl('discovered'))
    expect(discoveredResponse.status).toBe(200)
    expect(await discoveredResponse.json()).toMatchObject({
      ok: true,
      content: '# Discovered',
    })

    const legacyResponse = await app.request(localContentUrl('legacy'))
    expect(legacyResponse.status).toBe(404)
    expect(await legacyResponse.json()).toMatchObject({
      ok: false,
      error: 'local_skill_unavailable',
    })
  })

  it('rejects linked built-in directories and caller-controlled local paths', async () => {
    const external = join(home, 'linked-target')
    const builtInRoot = join(repoPath, 'assets', 'skills')
    await mkdir(external, { recursive: true })
    await mkdir(builtInRoot, { recursive: true })
    await writeFile(join(external, 'SKILL.md'), '# Linked')
    await symlink(external, join(builtInRoot, 'linked'), 'dir')

    const linked = await app.request(localContentUrl('linked'))
    expect(linked.status).toBe(422)
    expect(await linked.json()).toMatchObject({ ok: false, error: 'invalid_local_skill_path' })

    const legacyGet = await app.request(
      `${localContentUrl('linked')}&localPath=${encodeURIComponent(external)}`,
    )
    expect(legacyGet.status).toBe(400)
    expect(await legacyGet.json()).toEqual(validationError('invalid_skill_identity'))

    const legacyPut = await app.request('/api/skill/content', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        repo: 'default',
        skillId: 'linked',
        localPath: external,
        content: 'overwrite',
      }),
    })
    expect(legacyPut.status).toBe(400)
    expect(await legacyPut.json()).toEqual(validationError('invalid_skill_identity'))
    await expect(readFile(join(external, 'SKILL.md'), 'utf8')).resolves.toBe('# Linked')
  })

  it('reads an exact selected source member from its pinned Git blob', async () => {
    const cacheDir = await prepareSource()
    await writeFile(join(cacheDir, 'working-tree-only.md'), 'must not be read')

    const response = await app.request(sourceContentUrl(SOURCE_URL, 'skills/selected/SKILL.md'))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      ok: true,
      content: '# Pinned source skill\n',
    })
    const canonicalCacheDir = await realpath(cacheDir)
    expect(readTree).toHaveBeenCalledWith(canonicalCacheDir, PINNED_COMMIT)
    expect(show).toHaveBeenCalledWith(canonicalCacheDir, PINNED_COMMIT, 'skills/selected/SKILL.md')
  })

  it.each([
    ['unselected member', SOURCE_URL, 'skills/unselected/SKILL.md'],
    ['different source', 'https://example.test/other.git', 'skills/selected/SKILL.md'],
  ])('rejects a %s before reading Git', async (_label, sourceUrl, memberEntry) => {
    await prepareSource()

    const response = await app.request(sourceContentUrl(sourceUrl, memberEntry))

    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({ ok: false, error: 'source_skill_not_found' })
    expect(readTree).not.toHaveBeenCalled()
    expect(show).not.toHaveBeenCalled()
  })

  it('rejects non-regular Git entries before reading their content', async () => {
    await prepareSource()
    readTree = vi.fn(async () => [
      {
        mode: '120000',
        type: 'blob' as const,
        oid: 'b'.repeat(40),
        path: 'skills/selected/SKILL.md',
      },
    ])
    git = { readTree, show } as unknown as IGit
    app = new Hono().route('/api', createProjectionRoutes({ fs, git, proc: {} as IProcess, home }))

    const response = await app.request(sourceContentUrl(SOURCE_URL, 'skills/selected/SKILL.md'))

    expect(response.status).toBe(422)
    expect(await response.json()).toMatchObject({ ok: false, error: 'source_skill_unavailable' })
    expect(show).not.toHaveBeenCalled()
  })

  async function prepareSource(): Promise<string> {
    const cacheDir = join(repoPath, 'remote-cache', deriveRepoId(SOURCE_URL))
    await mkdir(cacheDir, { recursive: true })
    await writeSkillsManifest({
      sources: [
        {
          url: SOURCE_URL,
          ref: 'main',
          pinned_commit: PINNED_COMMIT,
          members: [{ name: 'selected', entry: 'skills/selected/SKILL.md' }],
        },
      ],
      skills: [],
    })
    return cacheDir
  }

  async function writeSkillsManifest(manifest: unknown): Promise<void> {
    await writeFile(join(repoPath, 'skills.yaml'), JSON.stringify(manifest))
  }
})

function localContentUrl(skillId: string): string {
  return `/api/skill/content?${new URLSearchParams({
    repo: 'default',
    kind: 'local',
    skillId,
  })}`
}

function sourceContentUrl(sourceUrl: string, memberEntry: string): string {
  return `/api/skill/content?${new URLSearchParams({
    repo: 'default',
    kind: 'source',
    sourceUrl,
    memberEntry,
  })}`
}
