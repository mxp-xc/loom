import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import yaml from 'js-yaml'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NodeFileSystem } from '../../src/platform/node/fs.js'
import type { IGit } from '../../src/ports/git.js'
import { SkillsApplication } from '../../src/skills/application.js'

describe('SkillsApplication', () => {
  let home: string
  let repoPath: string
  let fs: NodeFileSystem
  let git: IGit
  let log: {
    error: ReturnType<typeof vi.fn>
    warn: ReturnType<typeof vi.fn>
    info: ReturnType<typeof vi.fn>
  }
  let app: SkillsApplication

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'loom-skills-app-'))
    repoPath = join(home, '.loom', 'repos', 'default')
    await mkdir(repoPath, { recursive: true })
    fs = new NodeFileSystem()
    git = {
      clone: vi.fn(async () => {
        throw new Error('clone failed')
      }),
      checkout: vi.fn(),
      revParseHead: vi.fn(),
    } as unknown as IGit
    log = {
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
    }
    app = new SkillsApplication(fs, git, home, log)
  })

  afterEach(async () => rm(home, { recursive: true, force: true }))

  it('scans local skills from home and repo-relative directories with local ignore rules', async () => {
    await mkdir(join(home, '.agents', 'skills', '.cache', 'cached-skill'), { recursive: true })
    await mkdir(join(home, '.agents', 'skills', 'node_modules', 'ignored'), { recursive: true })
    await mkdir(join(repoPath, 'assets', 'skills', 'repo-skill'), { recursive: true })
    await writeFile(join(home, '.agents', 'skills', '.cache', 'cached-skill', 'SKILL.md'), 'x')
    await writeFile(join(home, '.agents', 'skills', 'node_modules', 'ignored', 'SKILL.md'), 'x')
    await writeFile(join(repoPath, 'assets', 'skills', 'repo-skill', 'SKILL.md'), 'x')

    await expect(app.scanLocalSkills({ dir: '~/.agents/skills' })).resolves.toEqual([
      { name: 'cached-skill', path: join(home, '.agents', 'skills', '.cache', 'cached-skill') },
    ])
    await expect(app.scanLocalSkills({ dir: 'assets/skills', repoPath })).resolves.toEqual([
      { name: 'repo-skill', path: join(repoPath, 'assets', 'skills', 'repo-skill') },
    ])
    await expect(app.scanLocalSkills({ dir: 'missing', repoPath })).resolves.toEqual([])
  })

  it('imports repo asset refs as pathless local skills', async () => {
    await writeFile(join(repoPath, 'skills.yaml'), 'sources: []\nskills: []\n')

    await expect(
      app.importLocalSkills(repoPath, {
        mode: 'ref',
        skills: [
          { name: 'test-qa-skill', path: join(repoPath, 'assets', 'skills', 'test-qa-skill') },
        ],
      }),
    ).resolves.toEqual({ count: 1 })

    const parsed = yaml.load(await readFile(join(repoPath, 'skills.yaml'), 'utf8')) as any
    expect(parsed.skills).toEqual([{ id: 'test-qa-skill' }])
  })

  it('writes local skill files safely and rejects existing destinations', async () => {
    await writeFile(join(repoPath, 'skills.yaml'), 'sources: []\nskills: []\n')

    await expect(
      app.writeLocalSkills(repoPath, {
        skills: [
          {
            name: 'new-skill',
            files: [
              { path: 'SKILL.md', content: '# New skill' },
              { path: 'docs/usage.md', content: 'usage' },
              { path: '../escape.md', content: 'bad' },
            ],
          },
        ],
      }),
    ).resolves.toEqual({ count: 1 })

    await expect(
      readFile(join(repoPath, 'assets', 'skills', 'new-skill', 'SKILL.md'), 'utf8'),
    ).resolves.toBe('# New skill')
    await expect(
      readFile(join(repoPath, 'assets', 'skills', 'new-skill', 'docs', 'usage.md'), 'utf8'),
    ).resolves.toBe('usage')
    expect(existsSync(join(repoPath, 'assets', 'skills', 'escape.md'))).toBe(false)

    await expect(
      app.writeLocalSkills(repoPath, {
        skills: [{ name: 'new-skill', files: [{ path: 'SKILL.md', content: 'again' }] }],
      }),
    ).rejects.toMatchObject({ status: 409, code: 'already_exists' })
  })

  it('removes pathless local skill files but keeps external refs', async () => {
    const externalDir = join(home, 'external-skill')
    await mkdir(join(repoPath, 'assets', 'skills', 'pathless'), { recursive: true })
    await mkdir(externalDir, { recursive: true })
    await writeFile(join(repoPath, 'assets', 'skills', 'pathless', 'SKILL.md'), 'x')
    await writeFile(join(externalDir, 'SKILL.md'), 'x')
    await writeFile(
      join(repoPath, 'skills.yaml'),
      [
        'sources: []',
        'skills:',
        '  - id: pathless',
        '  - id: external',
        `    path: ${externalDir.replace(/\\/g, '/')}`,
        '',
      ].join('\n'),
    )

    await app.removeLocalSkill(repoPath, 'pathless')
    await app.removeLocalSkill(repoPath, 'external')

    const parsed = yaml.load(await readFile(join(repoPath, 'skills.yaml'), 'utf8')) as any
    expect(parsed.skills).toEqual([])
    expect(existsSync(join(repoPath, 'assets', 'skills', 'pathless'))).toBe(false)
    expect(existsSync(externalDir)).toBe(true)
  })

  it('updates multiple source member targets with one yaml write', async () => {
    await writeFile(
      join(repoPath, 'skills.yaml'),
      [
        'sources:',
        '  - url: https://example.test/skills.git',
        '    ref: main',
        '    members:',
        '      - name: alpha',
        '        targets:',
        '          - claude-code',
        '      - name: beta',
        '        targets: []',
        'skills: []',
        '',
      ].join('\n'),
    )
    const writeSpy = vi.spyOn(fs, 'writeFile')

    await app.setSourceMemberTargets(repoPath, 'https://example.test/skills.git', [
      { memberName: 'alpha', targets: ['codex'] },
      { memberName: 'beta', targets: ['codex', 'opencode'] },
    ])

    expect(writeSpy).toHaveBeenCalledTimes(1)
    const output = await readFile(join(repoPath, 'skills.yaml'), 'utf8')
    expect(output).toContain('name: alpha')
    expect(output).toContain('- codex')
    expect(output).toContain('name: beta')
    expect(output).toContain('- opencode')
  })

  it('keeps source creation when auto-install fails and logs the full error object', async () => {
    await writeFile(join(repoPath, 'skills.yaml'), 'sources: []\nskills: []\n')
    const err = new Error('clone failed')
    vi.mocked(git.clone).mockRejectedValueOnce(err)

    const result = await app.addSource(repoPath, {
      url: 'https://github.com/mattpocock/skills',
      type: 'tag',
      ref: 'v1.0.1',
      scan: 'skills/engineering/**/SKILL.md',
    })

    expect(result.source).toMatchObject({
      url: 'https://github.com/mattpocock/skills',
      type: 'tag',
      ref: 'v1.0.1',
      scan: 'skills/engineering/**/SKILL.md',
    })
    const parsed = yaml.load(await readFile(join(repoPath, 'skills.yaml'), 'utf8')) as any
    expect(parsed.sources).toHaveLength(1)
    expect(log.error).toHaveBeenCalledWith('auto-install failed for source', {
      err,
      url: 'https://github.com/mattpocock/skills',
    })
  })
})
