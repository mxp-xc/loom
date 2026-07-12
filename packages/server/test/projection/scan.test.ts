import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanLocalSkills, scanSourceMembers } from '../../src/projection/scan'
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
  it('finds SKILL.md in any directory, member name = parent dir, excludes .git/node_modules/.cache', async () => {
    await mkdir(join(root, 'skills', 'brainstorming'), { recursive: true })
    await writeFile(
      join(root, 'skills', 'brainstorming', 'SKILL.md'),
      '---\ndescription: Debug systematically\n---\nbody',
    )
    await mkdir(join(root, 'packages', 'diagnosing-bugs'), { recursive: true })
    await writeFile(
      join(root, 'packages', 'diagnosing-bugs', 'SKILL.md'),
      '---\ndescription: Diagnose before fixing\n---\nbody',
    )
    await mkdir(join(root, 'skills', 'engineering', 'tdd'), { recursive: true })
    await writeFile(
      join(root, 'skills', 'engineering', 'tdd', 'SKILL.md'),
      '---\ndescription: Test first\n---\nbody',
    )
    await mkdir(join(root, '.git', 'foo'), { recursive: true })
    await writeFile(join(root, '.git', 'foo', 'SKILL.md'), 'x')
    await mkdir(join(root, 'node_modules', 'bar'), { recursive: true })
    await writeFile(join(root, 'node_modules', 'bar', 'SKILL.md'), 'x')
    const members = await scanSourceMembers(root, {
      url: 'github:obra/superpowers',
      ref: 'v1',
    })
    expect(members.map((m) => m.name)).toEqual(['brainstorming', 'diagnosing-bugs', 'tdd'])
    expect(members.find((m) => m.name === 'brainstorming')).toMatchObject({
      path: join(root, 'skills', 'brainstorming'),
      relativePath: 'skills/brainstorming/SKILL.md',
      description: 'Debug systematically',
    })
    expect(members.find((m) => m.name === 'diagnosing-bugs')).toMatchObject({
      path: join(root, 'packages', 'diagnosing-bugs'),
      relativePath: 'packages/diagnosing-bugs/SKILL.md',
      description: 'Diagnose before fixing',
    })
    expect(members.find((m) => m.name === 'tdd')).toMatchObject({
      path: join(root, 'skills', 'engineering', 'tdd'),
      relativePath: 'skills/engineering/tdd/SKILL.md',
      description: 'Test first',
    })
  })

  it('scans local skills with the same ignore and ordering rules', async () => {
    await mkdir(join(root, 'engineering', 'tdd'), { recursive: true })
    await writeFile(join(root, 'engineering', 'tdd', 'SKILL.md'), 'x')
    await mkdir(join(root, 'brainstorming'), { recursive: true })
    await writeFile(join(root, 'brainstorming', 'SKILL.md'), 'x')
    await mkdir(join(root, 'node_modules', 'ignored'), { recursive: true })
    await writeFile(join(root, 'node_modules', 'ignored', 'SKILL.md'), 'x')
    await mkdir(join(root, '.cache', 'ignored'), { recursive: true })
    await writeFile(join(root, '.cache', 'ignored', 'SKILL.md'), 'x')

    await expect(scanLocalSkills(root)).resolves.toEqual([
      { name: 'brainstorming', path: join(root, 'brainstorming') },
      { name: 'tdd', path: join(root, 'engineering', 'tdd') },
    ])
  })

  it('uses custom scan pattern to restrict discovered members', async () => {
    await mkdir(join(root, 'packages', 'brainstorming'), { recursive: true })
    await writeFile(join(root, 'packages', 'brainstorming', 'SKILL.md'), 'x')
    await mkdir(join(root, 'skills', 'engineering', 'tdd'), { recursive: true })
    await writeFile(join(root, 'skills', 'engineering', 'tdd', 'SKILL.md'), 'x')

    const members = await scanSourceMembers(root, {
      url: 'github:obra/superpowers',
      ref: 'v1',
      scan: 'skills/engineering/**/SKILL.md',
    })

    expect(members.map((m) => m.name)).toEqual(['tdd'])
    expect(members[0].relativePath).toBe('skills/engineering/tdd/SKILL.md')
  })

  it('uses URL-derived repo id for root-level source member names even with custom source name', async () => {
    await writeFile(join(root, 'SKILL.md'), '---\ndescription: Root source skill\n---\nbody')

    const members = await scanSourceMembers(root, {
      name: 'openai-skills',
      url: 'github:obra/superpowers',
      ref: 'v1',
    })

    expect(members.map((m) => m.name)).toEqual(['superpowers'])
    expect(members[0]).toMatchObject({
      path: root,
      relativePath: 'SKILL.md',
      description: 'Root source skill',
    })
  })

  it('rejects custom scan patterns that escape the source cache', async () => {
    await expect(
      scanSourceMembers(root, {
        url: 'github:obra/superpowers',
        ref: 'v1',
        scan: '../**/SKILL.md',
      }),
    ).rejects.toThrow('Invalid source scan pattern "../**/SKILL.md"')
  })

  it('throws when two discovered members derive the same name', async () => {
    await mkdir(join(root, 'skills', 'engineering', 'tdd'), { recursive: true })
    await writeFile(join(root, 'skills', 'engineering', 'tdd', 'SKILL.md'), 'x')
    await mkdir(join(root, 'skills', 'productivity', 'tdd'), { recursive: true })
    await writeFile(join(root, 'skills', 'productivity', 'tdd', 'SKILL.md'), 'x')

    await expect(
      scanSourceMembers(root, {
        url: 'github:obra/superpowers',
        ref: 'v1',
      }),
    ).rejects.toThrow(
      'Duplicate source skill member name "tdd" from skills/engineering/tdd/SKILL.md and skills/productivity/tdd/SKILL.md',
    )
  })

  it('enriches configured source members with runtime path and description metadata', async () => {
    await writeFile(
      join(root, 'skills.yaml'),
      [
        'sources:',
        '  - url: github:obra/superpowers',
        '    ref: v1',
        '    members:',
        '      - name: brainstorming',
        '        targets:',
        '          - codex',
        'skills: []',
        '',
      ].join('\n'),
    )
    await mkdir(
      join(root, 'remote-cache', 'superpowers', 'skills', 'engineering', 'brainstorming'),
      {
        recursive: true,
      },
    )
    await writeFile(
      join(
        root,
        'remote-cache',
        'superpowers',
        'skills',
        'engineering',
        'brainstorming',
        'SKILL.md',
      ),
      '---\ndescription: Runtime source metadata\n---\nbody',
    )

    const manifest = await loadProjectionManifest(
      {
        fs: new NodeFileSystem(),
        git: {} as never,
        proc: {} as never,
        home: root,
      },
      root,
    )

    expect(manifest.skills.sources[0].members).toEqual([
      {
        name: 'brainstorming',
        targets: ['codex'],
        path: 'skills/engineering/brainstorming/SKILL.md',
        description: 'Runtime source metadata',
      },
    ])
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
    await mkdir(
      join(root, 'remote-cache', 'superpowers', 'skills', 'engineering', 'brainstorming'),
      {
        recursive: true,
      },
    )
    await writeFile(
      join(
        root,
        'remote-cache',
        'superpowers',
        'skills',
        'engineering',
        'brainstorming',
        'SKILL.md',
      ),
      'x',
    )
    await mkdir(join(root, 'assets', 'skills', 'ref-skill'), { recursive: true })
    await writeFile(
      join(root, 'assets', 'skills', 'ref-skill', 'SKILL.md'),
      '---\ndescription: Referenced local skill\n---\nbody',
    )
    await mkdir(join(root, 'assets', 'skills', 'auto-local'), { recursive: true })
    await writeFile(
      join(root, 'assets', 'skills', 'auto-local', 'SKILL.md'),
      '---\ndescription: Built-in local skill\n---\nbody',
    )

    const manifest = await loadProjectionManifest(
      {
        fs: new NodeFileSystem(),
        git: {} as never,
        proc: {} as never,
        home: root,
      },
      root,
    )

    expect(manifest.skills.sources[0].members).toEqual([
      { name: 'brainstorming', targets: [], path: 'skills/engineering/brainstorming/SKILL.md' },
    ])
    expect(manifest.skills.skills).toContainEqual({
      id: 'ref-skill',
      path: './assets/skills/ref-skill',
      available: true,
      skillFilePath: 'assets/skills/ref-skill/SKILL.md',
      description: 'Referenced local skill',
    })
    expect(manifest.skills.skills).toContainEqual({
      id: 'auto-local',
      skillFilePath: 'assets/skills/auto-local/SKILL.md',
      description: 'Built-in local skill',
    })
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
        await mkdir(join(dest, 'skills', 'engineering', 'brainstorming'), { recursive: true })
        await writeFile(join(dest, 'skills', 'engineering', 'brainstorming', 'SKILL.md'), 'x')
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
      await fs.exists(
        join(root, 'remote-cache', 'superpowers', 'skills', 'engineering', 'brainstorming'),
      ),
    ).toBe(true)
    expect(
      await fs.exists(join(root, '.claude', 'skills', 'superpowers', 'brainstorming', 'SKILL.md')),
    ).toBe(true)
  })
})
