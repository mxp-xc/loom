import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { simpleGit } from 'simple-git'
import { NodeGit } from '../../../src/platform/node/git'

async function makeBareWithCommit(): Promise<string> {
  const bare = await mkdtemp(join(tmpdir(), 'bare-'))
  await simpleGit().raw(['init', '--bare', '-b', 'main', bare])
  const work = await mkdtemp(join(tmpdir(), 'work-'))
  const wg = simpleGit(work)
  await wg.raw(['init', '-b', 'main'])
  await wg.addConfig('user.email', 't@t.t')
  await wg.addConfig('user.name', 't')
  await writeFile(join(work, 'a.txt'), 'x')
  await wg.add('.')
  await wg.commit('init')
  await wg.addRemote('origin', bare)
  await wg.push('origin', 'HEAD:main')
  await wg.addTag('v1.0.0')
  await wg.pushTags('origin')
  return bare
}

describe('NodeGit', () => {
  let bare: string
  const created: string[] = []
  beforeAll(async () => {
    bare = await makeBareWithCommit()
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
    const w2 = simpleGit(work2)
    await w2.clone(bare, '.')
    await w2.addConfig('user.email', 't@t.t')
    await w2.addConfig('user.name', 't')
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
    const wg = simpleGit(dest)
    await wg.addConfig('user.email', 't@t.t')
    await wg.addConfig('user.name', 't')
    await writeFile(join(dest, 'c.txt'), 'z')
    await wg.add('.')
    await wg.commit('c3')
    const res = await git.push(dest)
    expect(res.ok).toBe(true)
    expect(res.nonFastForward).not.toBe(true)
  })

  describe('show/revParseHead/lsTree', () => {
    it('show reads file content at ref', async () => {
      const dest = await mkdtemp(join(tmpdir(), 'show-'))
      created.push(dest)
      await new NodeGit().clone(bare, dest, false)
      expect(await new NodeGit().show(dest, 'HEAD', 'a.txt')).toContain('x')
    })
    it('revParseHead returns HEAD hash', async () => {
      const dest = await mkdtemp(join(tmpdir(), 'rev-'))
      created.push(dest)
      await new NodeGit().clone(bare, dest, false)
      expect(await new NodeGit().revParseHead(dest)).toMatch(/^[0-9a-f]{7,40}$/)
    })
    it('lsTree lists files under dir', async () => {
      const dest = await mkdtemp(join(tmpdir(), 'lstree-'))
      created.push(dest)
      await new NodeGit().clone(bare, dest, false)
      const files = await new NodeGit().lsTree(dest, 'HEAD', '.')
      expect(files).toContain('a.txt')
    })
    it('lsTree returns [] for nonexistent dir', async () => {
      const dest = await mkdtemp(join(tmpdir(), 'lstree-none-'))
      created.push(dest)
      await new NodeGit().clone(bare, dest, false)
      expect(await new NodeGit().lsTree(dest, 'HEAD', 'nonexistent/')).toEqual([])
    })
  })
})
