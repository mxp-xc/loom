import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { simpleGit } from 'simple-git'
import { NodeGit } from '../../src/platform/node/git'
import { syncPush } from '../../src/sync/push'

describe('syncPush', () => {
  let bare: string
  const created: string[] = []
  beforeAll(async () => {
    bare = await mkdtemp(join(tmpdir(), 'pushbare-'))
    await simpleGit().raw(['init', '--bare', '-b', 'main', bare])
    const w = await mkdtemp(join(tmpdir(), 'pushw-'))
    const gw = simpleGit(w)
    await gw.raw(['init', '-b', 'main'])
    await gw.addConfig('user.email', 't@t.t')
    await gw.addConfig('user.name', 't')
    await writeFile(join(w, 'a.txt'), 'x')
    await gw.add('.')
    await gw.commit('init')
    await gw.addRemote('origin', bare)
    await gw.push('origin', 'HEAD:main')
  })
  afterEach(async () => {
    for (const p of created.splice(0)) await rm(p, { recursive: true, force: true }).catch(() => {})
  })

  it('non-fast-forward when local behind', async () => {
    const dest = await mkdtemp(join(tmpdir(), 'pushdest-'))
    created.push(dest)
    await simpleGit().clone(bare, dest)
    const w2 = await mkdtemp(join(tmpdir(), 'pushw2-'))
    created.push(w2)
    const gw2 = simpleGit(w2)
    await gw2.clone(bare, '.')
    await gw2.addConfig('user.email', 't@t.t')
    await gw2.addConfig('user.name', 't')
    await writeFile(join(w2, 'b.txt'), 'y')
    await gw2.add('.')
    await gw2.commit('remote-update')
    await gw2.push('origin', 'HEAD:main')
    const res = await syncPush(dest, new NodeGit())
    expect(res.ok).toBe(false)
    expect(res.nonFastForward).toBe(true)
  })
})
