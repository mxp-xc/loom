import { describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSkillsYamlRoutes } from '../../src/api/routes/skills-yaml'
import { annotateLocalSkillAvailability } from '../../src/projection/workflow'
import { NodeFileSystem } from '../../src/platform/node/fs'

describe('local skill availability', () => {
  it('marks refs by checking their SKILL.md file', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'local-skill-status-'))
    try {
      await mkdir(join(repo, 'valid'), { recursive: true })
      await writeFile(
        join(repo, 'valid', 'SKILL.md'),
        '---\ndescription: Valid local skill\n---\nbody',
      )
      const skills = [
        { id: 'valid', path: './valid' },
        { id: 'missing', path: './missing' },
        { id: 'builtin' },
      ]

      await annotateLocalSkillAvailability(new NodeFileSystem(), repo, skills)

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
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('accepts desc frontmatter as a local skill description alias', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'local-skill-alias-'))
    try {
      await mkdir(join(repo, 'alias'), { recursive: true })
      await writeFile(join(repo, 'alias', 'SKILL.md'), '---\ndesc: Alias local skill\n---\nbody')
      const skills = [{ id: 'alias', path: './alias' }]

      await annotateLocalSkillAvailability(new NodeFileSystem(), repo, skills)

      expect(skills[0]).toMatchObject({ description: 'Alias local skill' })
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
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

describe('source skill agent routes', () => {
  it('updates multiple source member agents with one request and one yaml write', async () => {
    const home = await mkdtemp(join(tmpdir(), 'source-agents-route-'))
    const repo = join(home, '.loom', 'repos', 'demo')
    await mkdir(repo, { recursive: true })
    await writeFile(
      join(repo, 'skills.yaml'),
      [
        'sources:',
        '  - url: https://example.test/skills.git',
        '    ref: main',
        '    members:',
        '      - name: alpha',
        '        entry: skills/alpha/SKILL.md',
        '        agents:',
        '          - claude-code',
        '      - name: beta',
        '        entry: skills/beta/SKILL.md',
        '        agents: []',
        'skills: []',
        '',
      ].join('\n'),
    )
    const app = new Hono().route(
      '/api',
      createSkillsYamlRoutes({
        fs: new NodeFileSystem(),
        git: {},
        proc: {},
        home,
      } as never),
    )

    const response = await app.request('/api/skills/source-agents', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        repo: 'demo',
        sourceUrl: 'https://example.test/skills.git',
        updates: [
          { memberEntry: 'skills/alpha/SKILL.md', agents: ['codex'] },
          { memberEntry: 'skills/beta/SKILL.md', agents: ['codex', 'opencode'] },
        ],
      }),
    })

    try {
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ ok: true })
      const content = await new NodeFileSystem().readFile(join(repo, 'skills.yaml'))
      expect(content).toContain('name: alpha')
      expect(content).toContain('- codex')
      expect(content).toContain('name: beta')
      expect(content).toContain('- opencode')
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})
