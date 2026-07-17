import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { simpleGit } from 'simple-git'
import { NodeFileSystem } from '../../../src/platform/node/fs'
import { NodeGit } from '../../../src/platform/node/git'
import { initLoom } from '../../../src/platform/node/init'

let home: string
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'home-'))
})
afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

describe('initLoom', () => {
  it('creates the default ~/.loom skeleton', async () => {
    const fs = new NodeFileSystem(),
      git = new NodeGit()
    await initLoom(home, fs, git)
    expect(await fs.exists(join(home, '.loom', 'config.yaml'))).toBe(true)
    expect(await fs.readFile(join(home, '.loom', 'config.yaml'))).toContain('active_repo: default')

    const repoConfig = await fs.readFile(join(home, '.loom', 'repos', 'default', 'config.yaml'))
    expect(repoConfig).toContain('profile: local')
    expect(repoConfig).toContain('agents:')
    expect(repoConfig).toContain('projection:')

    expect(await fs.exists(join(home, '.loom', 'repos', 'default', 'skills.yaml'))).toBe(true)
    const skills = await fs.readFile(join(home, '.loom', 'repos', 'default', 'skills.yaml'))
    expect(skills).toContain('sources: []')
    expect(skills).toContain('skills: []')

    expect(await fs.exists(join(home, '.loom', 'repos', 'default', 'mcp.yaml'))).toBe(true)
    expect(await fs.exists(join(home, '.loom', 'repos', 'default', 'vars', 'base.yaml'))).toBe(true)
    expect(await fs.exists(join(home, '.loom', 'repos', 'default', 'vars', 'default.yaml'))).toBe(
      false,
    )
    expect(await fs.exists(join(home, '.loom', 'repos', 'default', '.gitignore'))).toBe(true)
    expect(await simpleGit(join(home, '.loom', 'repos', 'default')).checkIsRepo()).toBe(true)
  })
  it('idempotent: running twice does not overwrite existing config or skills', async () => {
    const fs = new NodeFileSystem(),
      git = new NodeGit()
    await initLoom(home, fs, git)
    await fs.writeFile(join(home, '.loom', 'config.yaml'), 'active_repo: custom\n')
    await fs.writeFile(
      join(home, '.loom', 'repos', 'default', 'skills.yaml'),
      'sources: []\nskills: [{ id: mine }]\n',
    )
    await initLoom(home, fs, git)
    expect(await fs.readFile(join(home, '.loom', 'config.yaml'))).toContain('custom')
    expect(await fs.readFile(join(home, '.loom', 'repos', 'default', 'skills.yaml'))).toContain(
      'mine',
    )
  })
})
