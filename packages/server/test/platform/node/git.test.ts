import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { simpleGit } from 'simple-git'
import { NodeGit } from '../../../src/platform/node/git'
import { createBareRepo, testGit } from '../../helpers/git'

async function makeBareWithCommit(): Promise<string> {
  return createBareRepo([
    {
      message: 'init',
      files: { 'a.txt': 'x', 'skills/demo/SKILL.md': 'body' },
      tags: ['v1.0.0'],
    },
  ])
}

describe('NodeGit', () => {
  let bare: string
  let readOnlyRepo: string
  const created: string[] = []
  beforeAll(async () => {
    bare = await makeBareWithCommit()
    created.push(bare)
    readOnlyRepo = await mkdtemp(join(tmpdir(), 'readonly-'))
    created.push(readOnlyRepo)
    await new NodeGit().clone(bare, readOnlyRepo, false)
  })
  afterAll(async () => {
    await Promise.all(created.map((p) => rm(p, { recursive: true, force: true })))
  })

  it('init creates a git repo at path', async () => {
    const dest = await mkdtemp(join(tmpdir(), 'init-'))
    created.push(dest)
    await new NodeGit().init(dest)
    expect(await simpleGit(dest).checkIsRepo()).toBe(true)
  })
  it('clone fetches the repo', async () => {
    const dest = await mkdtemp(join(tmpdir(), 'clone-'))
    created.push(dest)
    await new NodeGit().clone(bare, dest, true)
    const log = await simpleGit(dest).log()
    expect(log.total).toBe(1)
  })
  it('lsRemote returns tags and head', async () => {
    const r = await new NodeGit().lsRemote(bare)
    expect(r.head).toBeTruthy()
    expect(r.tags['v1.0.0']).toBeTruthy()
  })
  it('lsRemote returns branches and tags', async () => {
    const git = new NodeGit()
    const result = await git.lsRemote(bare)
    expect(result.head).toBeTruthy()
    expect(result.branches).toContain('main')
    expect(result.tags['v1.0.0']).toBeTruthy()
  })
  it('push reports nonFastForward when remote ahead', async () => {
    const dest = await mkdtemp(join(tmpdir(), 'push-'))
    created.push(dest)
    const git = new NodeGit()
    await git.clone(bare, dest, false)
    const work2 = await mkdtemp(join(tmpdir(), 'w2-'))
    created.push(work2)
    const w2 = testGit(work2)
    await w2.clone(bare, '.')
    await writeFile(join(work2, 'b.txt'), 'y')
    await w2.add('.')
    await w2.commit('c2')
    await w2.push('origin', 'main:main')
    const res = await git.push(dest)
    if (res.ok) throw new Error('expected push to fail')
    expect(res.nonFastForward).toBe(true)
    expect(res.cause).toBeInstanceOf(Error)
    expect(String((res.cause as Error).message)).toMatch(
      /non-fast-forward|fetch first|updates were rejected because the tip/i,
    )
  })
  it('push succeeds when local ahead, returns ok:true', async () => {
    const dest = await mkdtemp(join(tmpdir(), 'pushok-'))
    created.push(dest)
    const git = new NodeGit()
    await git.clone(bare, dest, false)
    const wg = testGit(dest)
    await writeFile(join(dest, 'c.txt'), 'z')
    await wg.add('.')
    await wg.commit('c3')
    const res = await git.push(dest)
    expect(res.ok).toBe(true)
    expect(res.nonFastForward).not.toBe(true)
  })
  it('forcePush overwrites a remote that is ahead', async () => {
    const dest = await mkdtemp(join(tmpdir(), 'forcepush-'))
    created.push(dest)
    const git = new NodeGit()
    await git.clone(bare, dest, false)

    const work2 = await mkdtemp(join(tmpdir(), 'forcepush-w2-'))
    created.push(work2)
    const remotePeer = testGit(work2)
    await remotePeer.clone(bare, '.')
    await writeFile(join(work2, 'remote.txt'), 'remote')
    await remotePeer.add('.')
    await remotePeer.commit('remote ahead')
    await remotePeer.push('origin', 'main:main')

    const local = testGit(dest)
    await writeFile(join(dest, 'local.txt'), 'local')
    await local.add('.')
    await local.commit('local overwrite')

    const res = await git.forcePush(dest)

    expect(res).toEqual({ ok: true })
    const files = await testGit().raw(['--git-dir', bare, 'ls-tree', '-r', '--name-only', 'HEAD'])
    expect(files).toContain('local.txt')
    expect(files).not.toContain('remote.txt')
  })

  describe('show/revParseHead/lsTree/readTree', () => {
    it('show reads file content at ref', async () => {
      expect(await new NodeGit().show(readOnlyRepo, 'HEAD', 'a.txt')).toContain('x')
    })
    it('revParseHead returns HEAD hash', async () => {
      expect(await new NodeGit().revParseHead(readOnlyRepo)).toMatch(/^[0-9a-f]{7,40}$/)
    })
    it('lsTree lists files under dir', async () => {
      const files = await new NodeGit().lsTree(readOnlyRepo, 'HEAD', '.')
      expect(files).toContain('a.txt')
    })
    it('lsTree returns [] for nonexistent dir', async () => {
      expect(await new NodeGit().lsTree(readOnlyRepo, 'HEAD', 'nonexistent/')).toEqual([])
    })
    it('readTree returns structured and stably sorted commit entries', async () => {
      await writeFile(join(readOnlyRepo, 'untracked.txt'), 'not committed')

      const entries = await new NodeGit().readTree(readOnlyRepo, 'HEAD')

      expect(entries.map((entry) => entry.path)).toEqual([
        'a.txt',
        'skills',
        'skills/demo',
        'skills/demo/SKILL.md',
      ])
      expect(entries.find((entry) => entry.path === 'skills/demo')).toMatchObject({
        mode: '040000',
        type: 'tree',
      })
      expect(entries.find((entry) => entry.path === 'skills/demo/SKILL.md')).toMatchObject({
        mode: '100644',
        type: 'blob',
      })
      expect(entries.every((entry) => /^[0-9a-f]{40,64}$/.test(entry.oid))).toBe(true)
      expect(entries.some((entry) => entry.path === 'untracked.txt')).toBe(false)
    })
  })
})
