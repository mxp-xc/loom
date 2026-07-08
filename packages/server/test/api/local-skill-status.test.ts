import { describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { createSkillsYamlRoutes } from '../../src/api/routes/skills-yaml'
import { annotateLocalSkillAvailability } from '../../src/projection/workflow'

describe('local skill availability', () => {
  it('marks refs by checking their SKILL.md file', async () => {
    const fs = {
      exists: vi.fn(async (path: string) => path === '/repo/valid/SKILL.md'),
    }
    const skills = [
      { id: 'valid', path: './valid' },
      { id: 'missing', path: './missing' },
      { id: 'builtin' },
    ]

    await annotateLocalSkillAvailability(fs as never, '/repo', skills)

    expect(skills).toEqual([
      { id: 'valid', path: './valid', available: true },
      { id: 'missing', path: './missing', available: false },
      { id: 'builtin' },
    ])
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
