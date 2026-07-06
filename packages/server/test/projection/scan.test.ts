import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanSourceMembers } from '../../src/projection/scan'
import { loadProjectionManifest, projectRepository } from '../../src/projection/workflow.js'
import { NodeFileSystem } from '../../src/platform/node/fs'
import type { IGit } from '../../src/ports/git'
import type { IProcess } from '../../src/ports/process'

vi.mock('../../src/lib/logger.js', () => {
  const logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    flush: async () => {},
    child: () => logger,
  }
  return { logger }
})

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'scan-'))
})
afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(root, { recursive: true, force: true })
})

describe('scanSourceMembers', () => {
  it('finds SKILL.md, member name = parent dir, excludes .git/node_modules/.cache', async () => {
    await mkdir(join(root, 'skills', 'brainstorming'), { recursive: true })
    await writeFile(join(root, 'skills', 'brainstorming', 'SKILL.md'), 'x')
    await mkdir(join(root, '.git', 'foo'), { recursive: true })
    await writeFile(join(root, '.git', 'foo', 'SKILL.md'), 'x')
    await mkdir(join(root, 'node_modules', 'bar'), { recursive: true })
    await writeFile(join(root, 'node_modules', 'bar', 'SKILL.md'), 'x')
    const members = await scanSourceMembers(root, {
      url: 'github:obra/superpowers',
      ref: 'v1',
    })
    expect(members.map((m) => m.name)).toEqual(['brainstorming'])
    expect(members[0].path).toBe(join(root, 'skills', 'brainstorming'))
  })

  it('ignores custom scan matches outside the supported skills/<name> layout', async () => {
    await mkdir(join(root, 'packages', 'brainstorming'), { recursive: true })
    await writeFile(join(root, 'packages', 'brainstorming', 'SKILL.md'), 'x')

    const members = await scanSourceMembers(root, {
      url: 'github:obra/superpowers',
      ref: 'v1',
      scan: 'packages/*/SKILL.md',
    })

    expect(members).toEqual([])
  })
})

describe('loadProjectionManifest', () => {
  it('loads repo manifest, discovers missing source members, merges local skills, and annotates refs', async () => {
    await writeFile(
      join(root, 'skills.yaml'),
      [
        'sources:',
        '  - url: github:obra/superpowers',
        '    ref: v1',
        'skills:',
        '  - id: ref-skill',
        '    path: ./assets/skills/ref-skill',
        '',
      ].join('\n'),
    )
    await writeFile(join(root, 'config.yaml'), 'targets:\n  - claude-code\nskill_naming: hyphen\n')
    await mkdir(join(root, 'remote-cache', 'superpowers', 'skills', 'brainstorming'), {
      recursive: true,
    })
    await writeFile(
      join(root, 'remote-cache', 'superpowers', 'skills', 'brainstorming', 'SKILL.md'),
      'x',
    )
    await mkdir(join(root, 'assets', 'skills', 'ref-skill'), { recursive: true })
    await writeFile(join(root, 'assets', 'skills', 'ref-skill', 'SKILL.md'), 'x')
    await mkdir(join(root, 'assets', 'skills', 'auto-local'), { recursive: true })
    await writeFile(join(root, 'assets', 'skills', 'auto-local', 'SKILL.md'), 'x')

    const manifest = await loadProjectionManifest(
      {
        fs: new NodeFileSystem(),
        git: {} as never,
        proc: {} as never,
        home: root,
      },
      root,
    )

    expect(manifest.skills.sources[0].members).toEqual([{ name: 'brainstorming', targets: [] }])
    expect(manifest.skills.skills).toContainEqual({
      id: 'ref-skill',
      path: './assets/skills/ref-skill',
      available: true,
    })
    expect(manifest.skills.skills).toContainEqual({ id: 'auto-local' })
    expect(manifest.config.skill_naming).toBe('hyphen')
  })

  it('installs missing cache for explicitly configured members before projection', async () => {
    await writeFile(
      join(root, 'skills.yaml'),
      [
        'sources:',
        '  - url: https://github.com/obra/superpowers.git',
        '    ref: main',
        '    members:',
        '      - name: brainstorming',
        '        targets:',
        '          - claude-code',
        'skills: []',
        '',
      ].join('\n'),
    )
    await writeFile(
      join(root, 'config.yaml'),
      ['targets:', '  - claude-code', 'projection:', '  strategy: copy', ''].join('\n'),
    )
    const cloneCalls: Array<{ url: string; dest: string }> = []
    const git = {
      clone: async (url: string, dest: string) => {
        cloneCalls.push({ url, dest })
        await mkdir(join(dest, '.git'), { recursive: true })
        await mkdir(join(dest, 'skills', 'brainstorming'), { recursive: true })
        await writeFile(join(dest, 'skills', 'brainstorming', 'SKILL.md'), 'x')
      },
      checkout: async () => {},
      revParseHead: async () => 'abc123',
    } as Partial<IGit> as IGit
    const proc = { isInstalled: async (agentId) => agentId === 'claude-code' } satisfies IProcess
    const fs = new NodeFileSystem()
    vi.stubEnv('CLAUDE_CONFIG_DIR', join(root, '.claude'))

    const result = await projectRepository(
      {
        fs,
        git,
        proc,
        home: root,
      },
      root,
      {},
    )

    expect(result.ok).toBe(true)
    expect(cloneCalls).toEqual([
      {
        url: 'https://github.com/obra/superpowers.git',
        dest: join(root, 'remote-cache', 'superpowers'),
      },
    ])
    expect(
      await fs.exists(join(root, 'remote-cache', 'superpowers', 'skills', 'brainstorming')),
    ).toBe(true)
    expect(
      await fs.exists(join(root, '.claude', 'skills', 'superpowers', 'brainstorming', 'SKILL.md')),
    ).toBe(true)
  })
})
