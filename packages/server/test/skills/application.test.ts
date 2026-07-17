import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import yaml from 'js-yaml'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NodeFileSystem } from '../../src/platform/node/fs.js'
import type { GitTreeEntry, IGit } from '../../src/ports/git.js'
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

  it('updates multiple source member agents with one yaml write', async () => {
    await writeFile(
      join(repoPath, 'skills.yaml'),
      [
        'sources:',
        '  - url: https://example.test/skills.git',
        '    ref: main',
        '    members:',
        '      - name: alpha',
        '        entry: alpha/SKILL.md',
        '        agents:',
        '          - claude-code',
        '      - name: beta',
        '        entry: beta/SKILL.md',
        '        agents: []',
        'skills: []',
        '',
      ].join('\n'),
    )
    const writeSpy = vi.spyOn(fs, 'writeFile')

    await app.setSourceMemberAgents(repoPath, 'https://example.test/skills.git', [
      { memberEntry: 'alpha/SKILL.md', agents: ['codex'] },
      { memberEntry: 'beta/SKILL.md', agents: ['codex', 'opencode'] },
    ])

    expect(writeSpy).toHaveBeenCalledTimes(1)
    const output = await readFile(join(repoPath, 'skills.yaml'), 'utf8')
    expect(output).toContain('name: alpha')
    expect(output).toContain('- codex')
    expect(output).toContain('name: beta')
    expect(output).toContain('- opencode')
  })

  it('does not persist a source when installation fails and logs the full error object', async () => {
    await writeFile(join(repoPath, 'skills.yaml'), 'sources: []\nskills: []\n')
    const err = new Error('clone failed')
    vi.mocked(git.clone).mockRejectedValueOnce(err)

    await expect(
      app.addSource(repoPath, {
        url: 'https://github.com/mattpocock/skills',
        type: 'tag',
        ref: 'v1.0.1',
        members: [{ name: 'engineering', entry: 'skills/engineering/SKILL.md' }],
        resources: { include: [{ path: 'shared', kind: 'directory' }], exclude: [] },
      }),
    ).rejects.toBe(err)

    const parsed = yaml.load(await readFile(join(repoPath, 'skills.yaml'), 'utf8')) as any
    expect(parsed.sources).toEqual([])
    expect(log.error).toHaveBeenCalledWith('source candidate preparation failed', {
      err,
      url: 'https://github.com/mattpocock/skills',
      ref: 'v1.0.1',
    })
  })

  it('persists a custom source name and still installs into URL-derived cache', async () => {
    await writeFile(join(repoPath, 'skills.yaml'), 'sources: []\nskills: []\n')
    mockRemoteSource({})

    const result = await app.addSource(repoPath, {
      name: 'openai-skills',
      url: 'https://github.com/mattpocock/skills',
      ref: 'main',
    })

    expect(result.source).toMatchObject({
      name: 'openai-skills',
      url: 'https://github.com/mattpocock/skills',
      ref: 'main',
      pinned_commit: 'abc123',
    })
    expect(git.clone).toHaveBeenCalled()
    const cloneDest = vi.mocked(git.clone).mock.calls[0]?.[1]
    expect(cloneDest).toContain(join(repoPath, 'temp', 'source-edits'))
    expect(existsSync(join(repoPath, 'remote-cache', 'skills'))).toBe(true)
    const parsed = yaml.load(await readFile(join(repoPath, 'skills.yaml'), 'utf8')) as any
    expect(parsed.sources[0].name).toBe('openai-skills')
    expect(parsed.sources[0].pinned_commit).toBe('abc123')
  })

  it('rejects duplicate source urls and names', async () => {
    await writeFile(
      join(repoPath, 'skills.yaml'),
      [
        'sources:',
        '  - name: superpowers',
        '    url: https://example.test/superpowers.git',
        '    ref: main',
        'skills: []',
        '',
      ].join('\n'),
    )

    await expect(
      app.addSource(repoPath, {
        name: 'other',
        url: 'https://example.test/superpowers.git',
        ref: 'main',
      }),
    ).rejects.toMatchObject({ status: 409, code: 'source_url_exists' })

    await expect(
      app.addSource(repoPath, {
        name: 'superpowers',
        url: 'https://example.test/other.git',
        ref: 'main',
      }),
    ).rejects.toMatchObject({ status: 409, code: 'source_name_exists' })
  })

  it('rejects invalid source names', async () => {
    await writeFile(join(repoPath, 'skills.yaml'), 'sources: []\nskills: []\n')

    await expect(
      app.addSource(repoPath, {
        name: 'bad/name',
        url: 'https://example.test/skills.git',
        ref: 'main',
      }),
    ).rejects.toMatchObject({ status: 400, code: 'invalid_source_name' })
  })

  it('renames a source while preserving members and agents', async () => {
    await writeFile(
      join(repoPath, 'skills.yaml'),
      [
        'sources:',
        '  - name: old-name',
        '    url: https://example.test/skills.git',
        '    ref: main',
        '    members:',
        '      - name: alpha',
        '        entry: alpha/SKILL.md',
        '        agents:',
        '          - codex',
        'skills: []',
        '',
      ].join('\n'),
    )

    await mkdir(join(repoPath, 'remote-cache', 'skills', 'alpha'), { recursive: true })
    await writeFile(join(repoPath, 'remote-cache', 'skills', 'alpha', 'SKILL.md'), '# Alpha')
    mockRemoteSource({ 'alpha/SKILL.md': '# Alpha' })
    await app.reconcileSource(repoPath, {
      url: 'https://example.test/skills.git',
      name: 'new-name',
      members: [{ name: 'alpha', entry: 'alpha/SKILL.md' }],
    })

    const parsed = yaml.load(await readFile(join(repoPath, 'skills.yaml'), 'utf8')) as any
    expect(parsed.sources[0]).toEqual({
      name: 'new-name',
      url: 'https://example.test/skills.git',
      ref: 'main',
      pinned_commit: 'abc123',
      members: [{ name: 'alpha', entry: 'alpha/SKILL.md', agents: ['codex'] }],
      resources: { include: [], exclude: [] },
    })
    expect(git.clone).not.toHaveBeenCalled()
  })

  it('uses the desired source name when replacing a root bundle from a renamed ref', async () => {
    const sourceUrl = 'https://example.test/my_skills.git'
    const cacheDir = join(repoPath, 'remote-cache', 'my_skills')
    await mkdir(cacheDir, { recursive: true })
    await writeFile(join(cacheDir, 'SKILL.md'), '# Old root')
    await writeFile(
      join(repoPath, 'skills.yaml'),
      [
        'sources:',
        '  - name: old-root',
        `    url: ${sourceUrl}`,
        '    ref: main',
        '    pinned_commit: old-commit',
        '    members:',
        '      - name: old-root',
        '        entry: SKILL.md',
        'skills: []',
        '',
      ].join('\n'),
    )
    mockRemoteSource({ 'SKILL.md': '# New root' }, 'new-commit')

    await expect(
      app.reconcileSource(repoPath, {
        url: sourceUrl,
        name: 'new-root',
        ref: 'release',
        type: 'tag',
        members: [{ name: 'new-root', entry: 'SKILL.md' }],
      }),
    ).resolves.toMatchObject({ finalized: true })

    const parsed = yaml.load(await readFile(join(repoPath, 'skills.yaml'), 'utf8')) as any
    expect(parsed.sources[0]).toMatchObject({
      name: 'new-root',
      ref: 'release',
      members: [{ name: 'new-root', entry: 'SKILL.md' }],
    })
  })

  it('rejects same-ref edits when the source cache is missing without cloning', async () => {
    await writeFile(
      join(repoPath, 'skills.yaml'),
      'sources:\n  - url: https://example.test/skills.git\n    ref: main\n    pinned_commit: abc123\n    members: []\nskills: []\n',
    )
    mockRemoteSource({ 'alpha/SKILL.md': '# Alpha' })

    await expect(
      app.reconcileSource(repoPath, {
        url: 'https://example.test/skills.git',
        ref: 'main',
        type: 'branch',
        members: [{ name: 'alpha', entry: 'alpha/SKILL.md' }],
      }),
    ).rejects.toMatchObject({ status: 409, code: 'source_cache_unavailable' })
    expect(git.clone).not.toHaveBeenCalled()
  })

  it('previews removed members and preserves selected ones as local with agents', async () => {
    await mkdir(join(repoPath, 'remote-cache', 'skills', 'nested', 'removed'), { recursive: true })
    await writeFile(
      join(repoPath, 'remote-cache', 'skills', 'nested', 'removed', 'SKILL.md'),
      '# Removed',
    )
    await writeFile(
      join(repoPath, 'skills.yaml'),
      [
        'sources:',
        '  - name: skills',
        '    url: https://example.test/skills.git',
        '    ref: main',
        '    members:',
        '      - name: keep',
        '        entry: keep/SKILL.md',
        '      - name: removed',
        '        entry: nested/removed/SKILL.md',
        '        agents:',
        '          - codex',
        'skills: []',
        '',
      ].join('\n'),
    )
    const command = {
      url: 'https://example.test/skills.git',
      ref: 'main',
      type: 'branch' as const,
      members: [
        { name: 'keep', entry: 'keep/SKILL.md' },
        { name: 'added', entry: 'added/SKILL.md' },
      ],
    }
    mockRemoteSource({
      'keep/SKILL.md': '# Keep',
      'added/SKILL.md': '# Added',
    })

    await expect(app.reconcileSource(repoPath, command)).resolves.toMatchObject({
      finalized: false,
      changes: { added: [{ name: 'added' }], removed: [{ name: 'removed', agents: ['codex'] }] },
    })
    await app.reconcileSource(repoPath, { ...command, preserve: ['removed'] })

    const parsed = yaml.load(await readFile(join(repoPath, 'skills.yaml'), 'utf8')) as any
    expect(parsed.sources[0].members).toEqual([
      { name: 'keep', entry: 'keep/SKILL.md' },
      { name: 'added', entry: 'added/SKILL.md' },
    ])
    expect(parsed.skills).toEqual([{ id: 'removed', agents: ['codex'] }])
    await expect(
      readFile(join(repoPath, 'assets', 'skills', 'removed', 'SKILL.md'), 'utf8'),
    ).resolves.toBe('# Removed')
  })

  it('classifies a same-name member at a different scanned path as updated', async () => {
    await mkdir(join(repoPath, 'remote-cache', 'skills', 'old', 'alpha'), { recursive: true })
    await mkdir(join(repoPath, 'remote-cache', 'skills', 'new', 'alpha'), { recursive: true })
    await writeFile(join(repoPath, 'remote-cache', 'skills', 'old', 'alpha', 'SKILL.md'), '# Same')
    await writeFile(join(repoPath, 'remote-cache', 'skills', 'new', 'alpha', 'SKILL.md'), '# Same')
    await writeFile(
      join(repoPath, 'skills.yaml'),
      'sources:\n  - url: https://example.test/skills.git\n    ref: main\n    members:\n      - name: alpha\n        entry: old/alpha/SKILL.md\nskills: []\n',
    )
    mockRemoteSource({ 'new/alpha/SKILL.md': '# Same' })

    await expect(
      app.reconcileSource(repoPath, {
        url: 'https://example.test/skills.git',
        members: [{ name: 'alpha', entry: 'new/alpha/SKILL.md' }],
      }),
    ).resolves.toMatchObject({
      finalized: false,
      changes: { added: [{ name: 'alpha' }], removed: [{ name: 'alpha' }] },
    })
  })

  it('rolls back manifest and preserved directories when projection fails', async () => {
    const projection = vi
      .fn()
      .mockRejectedValueOnce(new Error('projection failed'))
      .mockResolvedValueOnce(undefined)
    app = new SkillsApplication(fs, git, home, log, projection)
    await mkdir(join(repoPath, 'remote-cache', 'skills', 'removed'), { recursive: true })
    await writeFile(join(repoPath, 'remote-cache', 'skills', 'removed', 'SKILL.md'), '# Removed')
    const original =
      'sources:\n  - url: https://example.test/skills.git\n    ref: main\n    members:\n      - name: removed\n        entry: removed/SKILL.md\n        agents: [codex]\nskills: []\n'
    await writeFile(join(repoPath, 'skills.yaml'), original)
    mockRemoteSource({})

    await expect(
      app.reconcileSource(repoPath, {
        url: 'https://example.test/skills.git',
        members: [],
        preserve: ['removed'],
      }),
    ).rejects.toThrow('projection failed')

    const parsed = yaml.load(await readFile(join(repoPath, 'skills.yaml'), 'utf8')) as any
    expect(parsed.sources[0].members).toEqual([
      { name: 'removed', entry: 'removed/SKILL.md', agents: ['codex'] },
    ])
    expect(parsed.skills).toEqual([])
    expect(existsSync(join(repoPath, 'assets', 'skills', 'removed'))).toBe(false)
    await expect(
      readFile(join(repoPath, 'remote-cache', 'skills', 'removed', 'SKILL.md'), 'utf8'),
    ).resolves.toBe('# Removed')
    expect(projection).toHaveBeenCalledTimes(2)
  })

  it('validates add selections before replacing an existing cache', async () => {
    await writeFile(join(repoPath, 'skills.yaml'), 'sources: []\nskills: []\n')
    const existingCache = join(repoPath, 'remote-cache', 'skills')
    await mkdir(existingCache, { recursive: true })
    await writeFile(join(existingCache, 'marker.txt'), 'keep')
    mockRemoteSource({
      'alpha/SKILL.md': '# Alpha',
      'shared/prompt.md': 'prompt',
    })

    await expect(
      app.addSource(repoPath, {
        url: 'https://example.test/skills.git',
        ref: 'main',
        members: [{ name: 'missing', entry: 'missing/SKILL.md' }],
      }),
    ).rejects.toMatchObject({ status: 400, code: 'invalid_member_selection' })
    await expect(readFile(join(existingCache, 'marker.txt'), 'utf8')).resolves.toBe('keep')

    await expect(
      app.addSource(repoPath, {
        url: 'https://example.test/skills.git',
        ref: 'main',
        resources: { include: [{ path: 'shared', kind: 'file' }], exclude: [] },
      }),
    ).rejects.toMatchObject({ status: 400, code: 'invalid_resource_selection' })
    const parsed = yaml.load(await readFile(join(repoPath, 'skills.yaml'), 'utf8')) as any
    expect(parsed.sources).toEqual([])
  })

  it('normalizes resource selection before persisting a source', async () => {
    await writeFile(join(repoPath, 'skills.yaml'), 'sources: []\nskills: []\n')
    mockRemoteSource({
      'shared/a.md': 'a',
      'shared/b.md': 'b',
      'z.md': 'z',
    })

    await app.addSource(repoPath, {
      url: 'https://example.test/skills.git',
      ref: 'main',
      resources: {
        include: [
          { path: 'z.md', kind: 'file' },
          { path: 'shared/a.md', kind: 'file' },
          { path: 'shared', kind: 'directory' },
          { path: 'shared', kind: 'directory' },
        ],
        exclude: [],
      },
    })

    const parsed = yaml.load(await readFile(join(repoPath, 'skills.yaml'), 'utf8')) as any
    expect(parsed.sources[0].resources).toEqual({
      include: [
        { path: 'shared', kind: 'directory' },
        { path: 'z.md', kind: 'file' },
      ],
      exclude: [],
    })

    await expect(
      app.reconcileSource(repoPath, {
        url: 'https://example.test/skills.git',
        members: [],
        resources: {
          include: [{ path: 'z.md', kind: 'file' }],
          exclude: [{ path: 'z.md', kind: 'file' }],
        },
      }),
    ).rejects.toMatchObject({ status: 400, code: 'invalid_resource_selection' })
  })

  it('allows a mixed directory resource rule while keeping bundle selection explicit', async () => {
    await writeFile(join(repoPath, 'skills.yaml'), 'sources: []\nskills: []\n')
    mockRemoteSource({
      'mixed/alpha/SKILL.md': '# Alpha',
      'mixed/workflow.md': 'workflow',
    })

    await app.addSource(repoPath, {
      url: 'https://example.test/mixed.git',
      ref: 'main',
      members: [{ name: 'alpha', entry: 'mixed/alpha/SKILL.md' }],
      resources: { include: [{ path: 'mixed', kind: 'directory' }], exclude: [] },
    })

    const parsed = yaml.load(await readFile(join(repoPath, 'skills.yaml'), 'utf8')) as any
    expect(parsed.sources[0].resources).toEqual({
      include: [{ path: 'mixed', kind: 'directory' }],
      exclude: [],
    })
  })

  it('preserves unavailable previous resource rules during reconcile but rejects new invalid rules', async () => {
    const cacheDir = join(repoPath, 'remote-cache', 'skills')
    await mkdir(join(cacheDir, 'alpha'), { recursive: true })
    await writeFile(join(cacheDir, 'alpha', 'SKILL.md'), '# Alpha')
    await writeFile(
      join(repoPath, 'skills.yaml'),
      [
        'sources:',
        '  - url: https://example.test/skills.git',
        '    ref: main',
        '    members:',
        '      - name: alpha',
        '        entry: alpha/SKILL.md',
        '    resources:',
        '      include:',
        '        - path: removed.md',
        '          kind: file',
        '      exclude: []',
        'skills: []',
        '',
      ].join('\n'),
    )
    mockRemoteSource({ 'alpha/SKILL.md': '# Alpha' })

    await app.reconcileSource(repoPath, {
      url: 'https://example.test/skills.git',
      members: [{ name: 'alpha', entry: 'alpha/SKILL.md' }],
      resources: { include: [{ path: 'removed.md', kind: 'file' }], exclude: [] },
    })
    const parsed = yaml.load(await readFile(join(repoPath, 'skills.yaml'), 'utf8')) as any
    expect(parsed.sources[0].resources).toEqual({
      include: [{ path: 'removed.md', kind: 'file' }],
      exclude: [],
    })

    mockRemoteSource({ 'alpha/SKILL.md': '# Alpha' })
    await expect(
      app.reconcileSource(repoPath, {
        url: 'https://example.test/skills.git',
        members: [{ name: 'alpha', entry: 'alpha/SKILL.md' }],
        resources: { include: [{ path: 'never-existed.md', kind: 'file' }], exclude: [] },
      }),
    ).rejects.toMatchObject({ status: 400, code: 'invalid_resource_selection' })
  })

  it('checks out an edited ref and atomically updates cache and pinned commit', async () => {
    const cacheDir = join(repoPath, 'remote-cache', 'skills')
    await mkdir(join(cacheDir, 'alpha'), { recursive: true })
    await writeFile(join(cacheDir, 'alpha', 'SKILL.md'), '# Old')
    await writeFile(
      join(repoPath, 'skills.yaml'),
      'sources:\n  - url: https://example.test/skills.git\n    ref: main\n    pinned_commit: old-commit\n    members:\n      - name: alpha\n        entry: alpha/SKILL.md\nskills: []\n',
    )
    mockRemoteSource({ 'alpha/SKILL.md': '# New' }, 'new-commit')

    await expect(
      app.reconcileSource(repoPath, {
        url: 'https://example.test/skills.git',
        ref: 'release',
        type: 'tag',
        members: [{ name: 'alpha', entry: 'alpha/SKILL.md' }],
      }),
    ).resolves.toMatchObject({ finalized: true, changes: { updated: [{ name: 'alpha' }] } })

    expect(git.checkout).toHaveBeenCalledWith(expect.any(String), 'release')
    await expect(readFile(join(cacheDir, 'alpha', 'SKILL.md'), 'utf8')).resolves.toBe('# New')
    const parsed = yaml.load(await readFile(join(repoPath, 'skills.yaml'), 'utf8')) as any
    expect(parsed.sources[0]).toMatchObject({
      ref: 'release',
      type: 'tag',
      pinned_commit: 'new-commit',
      members: [{ name: 'alpha', entry: 'alpha/SKILL.md' }],
    })
  })

  it('does not replace the live cache when editing selection at the same commit', async () => {
    const cacheDir = join(repoPath, 'remote-cache', 'skills')
    await mkdir(join(cacheDir, 'alpha'), { recursive: true })
    await writeFile(join(cacheDir, 'alpha', 'SKILL.md'), '# Alpha')
    await writeFile(
      join(repoPath, 'skills.yaml'),
      'sources:\n  - url: https://example.test/skills.git\n    ref: main\n    pinned_commit: abc123\n    members: []\nskills: []\n',
    )
    mockRemoteSource({ 'alpha/SKILL.md': '# Alpha' }, 'abc123')
    const move = vi.spyOn(fs, 'move')

    await app.reconcileSource(repoPath, {
      url: 'https://example.test/skills.git',
      ref: 'main',
      type: 'branch',
      members: [{ name: 'alpha', entry: 'alpha/SKILL.md' }],
    })

    expect(move).not.toHaveBeenCalled()
    expect(git.clone).not.toHaveBeenCalled()
    await expect(readFile(join(cacheDir, 'alpha', 'SKILL.md'), 'utf8')).resolves.toBe('# Alpha')
    const parsed = yaml.load(await readFile(join(repoPath, 'skills.yaml'), 'utf8')) as any
    expect(parsed.sources[0]).toMatchObject({
      pinned_commit: 'abc123',
      members: [{ name: 'alpha', entry: 'alpha/SKILL.md' }],
    })
  })

  it('prepares a candidate when an unchanged ref is saved against a refreshed commit', async () => {
    const cacheDir = join(repoPath, 'remote-cache', 'skills')
    await mkdir(join(cacheDir, 'alpha'), { recursive: true })
    await writeFile(join(cacheDir, 'alpha', 'SKILL.md'), '# Old')
    await writeFile(
      join(repoPath, 'skills.yaml'),
      'sources:\n  - url: https://example.test/skills.git\n    ref: main\n    pinned_commit: old-commit\n    members:\n      - name: alpha\n        entry: alpha/SKILL.md\nskills: []\n',
    )
    mockRemoteSource({ 'alpha/SKILL.md': '# New' }, 'new-commit')
    git.revParse = vi.fn(async (path, ref) => {
      if (ref.endsWith('^{tree}')) return 'root-tree'
      return path === cacheDir ? 'old-commit' : 'new-commit'
    })

    await app.reconcileSource(repoPath, {
      url: 'https://example.test/skills.git',
      ref: 'main',
      type: 'branch',
      expected_commit: 'new-commit',
      members: [{ name: 'alpha', entry: 'alpha/SKILL.md' }],
    })

    expect(git.clone).toHaveBeenCalledTimes(1)
    await expect(readFile(join(cacheDir, 'alpha', 'SKILL.md'), 'utf8')).resolves.toBe('# New')
    const parsed = yaml.load(await readFile(join(repoPath, 'skills.yaml'), 'utf8')) as any
    expect(parsed.sources[0].pinned_commit).toBe('new-commit')
  })

  it('rejects a refreshed save when the remote ref moved after the tree was scanned', async () => {
    const sourceUrl = 'https://secret-token@example.test/skills.git'
    const cacheDir = join(repoPath, 'remote-cache', 'skills')
    await mkdir(join(cacheDir, 'alpha'), { recursive: true })
    await writeFile(join(cacheDir, 'alpha', 'SKILL.md'), '# Old')
    await writeFile(
      join(repoPath, 'skills.yaml'),
      `sources:\n  - url: ${sourceUrl}\n    ref: main\n    pinned_commit: old-commit\n    members:\n      - name: alpha\n        entry: alpha/SKILL.md\nskills: []\n`,
    )
    mockRemoteSource({ 'alpha/SKILL.md': '# Moved again' }, 'newer-commit')
    git.revParse = vi.fn(async (path, ref) => {
      if (ref.endsWith('^{tree}')) return 'root-tree'
      return path === cacheDir ? 'old-commit' : 'newer-commit'
    })

    await expect(
      app.reconcileSource(repoPath, {
        url: sourceUrl,
        ref: 'main',
        type: 'branch',
        expected_commit: 'scanned-commit',
        members: [{ name: 'alpha', entry: 'alpha/SKILL.md' }],
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: 'source_commit_changed',
      message: 'Source changed from scanned-commit to newer-commit; refresh and retry',
    })

    await expect(readFile(join(cacheDir, 'alpha', 'SKILL.md'), 'utf8')).resolves.toBe('# Old')
    const parsed = yaml.load(await readFile(join(repoPath, 'skills.yaml'), 'utf8')) as any
    expect(parsed.sources[0].pinned_commit).toBe('old-commit')
  })

  it('preserves a removed root bundle without copying git metadata', async () => {
    const cacheDir = join(repoPath, 'remote-cache', 'root-skill')
    await mkdir(join(cacheDir, '.git'), { recursive: true })
    await writeFile(join(cacheDir, '.git', 'config'), 'private')
    await writeFile(join(cacheDir, 'SKILL.md'), '# Root')
    await writeFile(join(cacheDir, 'prompt.md'), 'prompt')
    await writeFile(
      join(repoPath, 'skills.yaml'),
      'sources:\n  - name: root-skill\n    url: https://example.test/root-skill.git\n    ref: main\n    members:\n      - name: root-skill\n        entry: SKILL.md\nskills: []\n',
    )
    mockRemoteSource({})

    await app.reconcileSource(repoPath, {
      url: 'https://example.test/root-skill.git',
      members: [],
      preserve: ['root-skill'],
    })

    const preserved = join(repoPath, 'assets', 'skills', 'root-skill')
    await expect(readFile(join(preserved, 'SKILL.md'), 'utf8')).resolves.toBe('# Root')
    await expect(readFile(join(preserved, 'prompt.md'), 'utf8')).resolves.toBe('prompt')
    expect(existsSync(join(preserved, '.git'))).toBe(false)
  })

  it('reorders top-level source and local groups with stale ids normalized', async () => {
    await writeFile(
      join(repoPath, 'skills.yaml'),
      [
        'sources:',
        '  - url: https://example.test/a',
        '    ref: main',
        '  - url: https://example.test/b',
        '    ref: main',
        'skills:',
        '  - id: local-skill',
        'group_order:',
        '  - source:https://example.test/missing',
        '  - source:https://example.test/a',
        '',
      ].join('\n'),
    )

    await expect(
      app.reorderGroups(repoPath, ['local', 'source:https://example.test/b', 'unknown']),
    ).resolves.toEqual({
      ids: ['local', 'source:https://example.test/b', 'source:https://example.test/a'],
    })
    const parsed = yaml.load(await readFile(join(repoPath, 'skills.yaml'), 'utf8')) as any
    expect(parsed.group_order).toEqual([
      'local',
      'source:https://example.test/b',
      'source:https://example.test/a',
    ])
  })

  it('rejects duplicate source urls when reordering', async () => {
    await writeFile(
      join(repoPath, 'skills.yaml'),
      'sources:\n  - url: https://example.test/a\n    ref: main\n  - url: https://example.test/a\n    ref: dev\nskills: []\n',
    )

    await expect(app.reorderGroups(repoPath, [])).rejects.toMatchObject({
      status: 409,
      code: 'duplicate_source_url',
    })
  })

  it('does not rewrite an unchanged group order and rejects malformed entities', async () => {
    await writeFile(
      join(repoPath, 'skills.yaml'),
      'sources:\n  - url: https://example.test/a\n    ref: main\nskills: []\ngroup_order:\n  - source:https://example.test/a\n',
    )
    const replace = vi.spyOn(fs, 'replaceFile')

    await expect(app.reorderGroups(repoPath, ['source:https://example.test/a'])).resolves.toEqual({
      ids: ['source:https://example.test/a'],
    })
    expect(replace).not.toHaveBeenCalled()

    await writeFile(join(repoPath, 'skills.yaml'), 'sources: {}\nskills: []\n')
    await expect(app.reorderGroups(repoPath, [])).rejects.toMatchObject({
      status: 422,
      code: 'invalid_skills_manifest',
    })
  })

  function mockRemoteSource(files: Record<string, string>, commit = 'abc123'): void {
    const directories = new Set<string>()
    for (const path of Object.keys(files)) {
      const parts = path.split('/')
      for (let index = 1; index < parts.length; index += 1) {
        directories.add(parts.slice(0, index).join('/'))
      }
    }
    const entries: GitTreeEntry[] = [
      ...[...directories].map((path) => ({
        mode: '040000',
        type: 'tree' as const,
        oid: `tree:${path}`,
        path,
      })),
      ...Object.keys(files).map((path) => ({
        mode: '100644',
        type: 'blob' as const,
        oid: `blob:${path}`,
        path,
      })),
    ]
    vi.mocked(git.clone).mockImplementation(async (_url, destination) => {
      await mkdir(destination, { recursive: true })
      for (const [path, content] of Object.entries(files)) {
        const target = join(destination, path)
        await mkdir(join(target, '..'), { recursive: true })
        await writeFile(target, content)
      }
    })
    git.revParse = vi.fn(async (_path, ref) => (ref.endsWith('^{tree}') ? 'root-tree' : commit))
    git.readTree = vi.fn(async () => entries)
    git.show = vi.fn(async (_path, _ref, path) => files[path] ?? '')
  }
})
