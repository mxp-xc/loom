import { describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSkillsYamlRoutes } from '../../src/api/routes/skills-yaml'
import { annotateLocalSkillAvailability } from '../../src/projection/workflow'

describe('local skill availability', () => {
  it('marks refs by checking their SKILL.md file', async () => {
    const fs = {
      exists: vi.fn(async (path: string) => path === '/repo/valid/SKILL.md'),
      readFile: vi.fn(async () => '---\ndescription: Valid local skill\n---\nbody'),
    }
    const skills = [
      { id: 'valid', path: './valid' },
      { id: 'missing', path: './missing' },
      { id: 'builtin' },
    ]

    await annotateLocalSkillAvailability(fs as never, '/repo', skills)

    expect(skills).toEqual([
      {
        id: 'valid',
        path: './valid',
        available: true,
        skillFilePath: 'valid/SKILL.md',
        description: 'Valid local skill',
      },
      { id: 'missing', path: './missing', available: false },
      { id: 'builtin' },
    ])
  })

  it('accepts desc frontmatter as a local skill description alias', async () => {
    const fs = {
      exists: vi.fn(async (path: string) => path === '/repo/alias/SKILL.md'),
      readFile: vi.fn(async () => '---\ndesc: Alias local skill\n---\nbody'),
    }
    const skills = [{ id: 'alias', path: './alias' }]

    await annotateLocalSkillAvailability(fs as never, '/repo', skills)

    expect(skills[0]).toMatchObject({ description: 'Alias local skill' })
  })
})

describe('local skill scan path', () => {
  it('expands ~/.agents/skills against the server home', async () => {
    const fs = {
      exists: vi.fn(async () => false),
    }
    const app = new Hono().route(
      '/api',
      createSkillsYamlRoutes({ fs, git: {}, proc: {}, home: '/home/tester' } as never),
    )

    const response = await app.request('/api/skills/local/scan', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dir: '~/.agents/skills' }),
    })

    expect(response.status).toBe(200)
    expect(fs.exists).toHaveBeenCalledWith('/home/tester/.agents/skills')
  })

  it('keeps previous scan behavior by including skills under .cache directories', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'local-skill-scan-'))
    try {
      await mkdir(join(dir, '.cache', 'cached-skill'), { recursive: true })
      await writeFile(join(dir, '.cache', 'cached-skill', 'SKILL.md'), 'x')
      await mkdir(join(dir, 'node_modules', 'ignored'), { recursive: true })
      await writeFile(join(dir, 'node_modules', 'ignored', 'SKILL.md'), 'x')
      const fs = {
        exists: vi.fn(async (path: string) => path === dir),
      }
      const app = new Hono().route(
        '/api',
        createSkillsYamlRoutes({ fs, git: {}, proc: {}, home: '/home/tester' } as never),
      )

      const response = await app.request('/api/skills/local/scan', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dir }),
      })

      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({
        ok: true,
        skills: [{ name: 'cached-skill', path: join(dir, '.cache', 'cached-skill') }],
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('source skill target routes', () => {
  it('updates multiple source member targets with one request and one yaml write', async () => {
    const files = new Map<string, string>()
    const fs = {
      readDir: vi.fn(async () => ['demo']),
      exists: vi.fn(async () => true),
      readFile: vi.fn(async (path: string) => {
        if (!path.endsWith('skills.yaml')) {
          throw Object.assign(new Error('missing'), { code: 'ENOENT' })
        }
        return [
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
        ].join('\n')
      }),
      writeFile: vi.fn(async (path: string, content: string) => {
        files.set(path, content)
      }),
      replaceFile: vi.fn(async (temporary: string, target: string) => {
        files.set(target, files.get(temporary) ?? '')
        files.delete(temporary)
      }),
      removeFile: vi.fn(async (path: string) => {
        files.delete(path)
      }),
    }
    const app = new Hono().route(
      '/api',
      createSkillsYamlRoutes({ fs, git: {}, proc: {}, home: '/home/tester' } as never),
    )

    const response = await app.request('/api/skills/source-targets', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        repo: 'demo',
        sourceUrl: 'https://example.test/skills.git',
        updates: [
          { memberName: 'alpha', targets: ['codex'] },
          { memberName: 'beta', targets: ['codex', 'opencode'] },
        ],
      }),
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
    expect(fs.writeFile).toHaveBeenCalledTimes(1)
    expect([...files.values()][0]).toContain('name: alpha')
    expect([...files.values()][0]).toContain('- codex')
    expect([...files.values()][0]).toContain('name: beta')
    expect([...files.values()][0]).toContain('- opencode')
  })
})
