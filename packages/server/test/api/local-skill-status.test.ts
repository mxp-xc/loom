import { describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { createSkillsYamlRoutes } from '../../src/api/routes/skills-yaml'
import { annotateLocalSkillAvailability } from '../../src/api/routes/projection'

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
      body: JSON.stringify({ dir: '~/.agents/skills', repoPath: '/repo' }),
    })

    expect(response.status).toBe(200)
    expect(fs.exists).toHaveBeenCalledWith('/home/tester/.agents/skills')
  })
})
