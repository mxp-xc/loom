import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Hono } from 'hono'
import { registerRoutes } from '../../src/api/router.js'
import { createMemoryRoutes } from '../../src/api/routes/memory.js'
import { NodeFileSystem } from '../../src/platform/node/fs.js'

describe('memory routes', () => {
  let home: string
  let app: Hono

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'loom-mem-'))
    mkdirSync(join(home, '.loom', 'repos', 'default', 'memories'), { recursive: true })
    writeFileSync(join(home, '.loom', 'repos', 'default', 'config.yaml'), '')
    process.env.HOME = home
    app = new Hono().route('/api', registerRoutes())
  })
  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
  })

  const req = (method: string, path: string, body?: unknown) =>
    app.request(`http://localhost${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    })

  it('GET /memory lists memories + active', async () => {
    writeFileSync(join(home, '.loom', 'repos', 'default', 'memories', 'v1.md'), '# v1')
    writeFileSync(
      join(home, '.loom', 'repos', 'default', 'memories', 'v2.md'),
      '# v2 ${LOOM_AGENT}',
    )
    writeFileSync(join(home, '.loom', 'repos', 'default', 'config.yaml'), 'active_memory: v2\n')
    const res = await req('GET', '/api/memory?repo=default')
    const j = await res.json()
    expect(j.memories.map((m: any) => m.name).sort()).toEqual(['v1', 'v2'])
    expect(j.active).toBe('v2')
    expect(j.activeContent).toContain('${LOOM_AGENT}')
  })

  it('GET /memory?name= returns single memory raw content', async () => {
    writeFileSync(
      join(home, '.loom', 'repos', 'default', 'memories', 'v1.md'),
      '# raw ${LOOM_AGENT}',
    )
    const res = await req('GET', '/api/memory?repo=default&name=v1')
    const j = await res.json()
    expect(j.content).toBe('# raw ${LOOM_AGENT}')
  })

  it('supports dots in safe memory file names', async () => {
    const repo = join(home, '.loom', 'repos', 'default')
    writeFileSync(join(repo, 'memories', 'gpt-5.6.md'), '# dotted')

    const content = await req('GET', '/api/memory?repo=default&name=gpt-5.6')
    expect(await content.json()).toEqual({ content: '# dotted' })

    const reordered = await req('PUT', '/api/memory/order', {
      repo: 'default',
      names: ['gpt-5.6'],
    })
    expect(await reordered.json()).toEqual({ ok: true, names: ['gpt-5.6'] })
  })

  it('POST /memory creates new memory', async () => {
    const res = await req('POST', '/api/memory', { repo: 'default', name: 'v3' })
    const j = await res.json()
    expect(j.ok).toBe(true)
    expect(readFileSync(join(home, '.loom', 'repos', 'default', 'memories', 'v3.md'), 'utf8')).toBe(
      '',
    )
  })

  it('POST /memory accepts portable names containing dots', async () => {
    for (const name of ['.', 'team.v2', 'a'.repeat(252)]) {
      const res = await req('POST', '/api/memory', { repo: 'default', name })

      expect(res.status).toBe(200)
      expect(
        readFileSync(join(home, '.loom', 'repos', 'default', 'memories', `${name}.md`), 'utf8'),
      ).toBe('')
    }
  })

  it.each(['a'.repeat(253), 'CON', 'CON.notes', 'com1', 'com1.backup', 'Lpt9'])(
    'POST /memory rejects non-portable name %s',
    async (name) => {
      const res = await req('POST', '/api/memory', { repo: 'default', name })

      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ ok: false, error: 'invalid_name' })
    },
  )

  it('POST /memory rejects case-insensitive filename collisions', async () => {
    writeFileSync(join(home, '.loom', 'repos', 'default', 'memories', 'Team.md'), 'x')

    const res = await req('POST', '/api/memory', { repo: 'default', name: 'team' })

    expect(res.status).toBe(409)
  })

  it('POST /memory rejects duplicate name (409)', async () => {
    writeFileSync(join(home, '.loom', 'repos', 'default', 'memories', 'v1.md'), 'x')
    const res = await req('POST', '/api/memory', { repo: 'default', name: 'v1' })
    expect(res.status).toBe(409)
  })

  it('POST /memory rejects path-traversal name', async () => {
    const res = await req('POST', '/api/memory', { repo: 'default', name: '../etc' })
    expect(res.status).toBe(400)
  })

  it('PUT /memory/content writes content', async () => {
    writeFileSync(join(home, '.loom', 'repos', 'default', 'memories', 'v1.md'), 'old')
    await req('PUT', '/api/memory/content', { repo: 'default', name: 'v1', content: 'new content' })
    expect(readFileSync(join(home, '.loom', 'repos', 'default', 'memories', 'v1.md'), 'utf8')).toBe(
      'new content',
    )
  })

  it('PUT /memory/target creates a unique target assignment and removes legacy active memory', async () => {
    const repo = join(home, '.loom', 'repos', 'default')
    writeFileSync(join(repo, 'memories', 'v1.md'), '# v1')
    writeFileSync(join(repo, 'memories', 'v2.md'), '# v2')
    writeFileSync(join(repo, 'config.yaml'), 'active_memory: v1\ntargets:\n  - codex\n')

    const assigned = await req('PUT', '/api/memory/target', {
      repo: 'default',
      target: 'codex',
      name: 'v1',
    })
    expect(await assigned.json()).toEqual({ ok: true, assignments: { codex: 'v1' } })

    const moved = await req('PUT', '/api/memory/target', {
      repo: 'default',
      target: 'codex',
      name: 'v2',
    })
    expect(await moved.json()).toEqual({ ok: true, assignments: { codex: 'v2' } })

    const cfg = readFileSync(join(repo, 'config.yaml'), 'utf8')
    expect(cfg).toContain('memory_targets:\n  codex: v2')
    expect(cfg).not.toContain('active_memory')
    const listed = await req('GET', '/api/memory?repo=default')
    expect(await listed.json()).toMatchObject({
      assignments: { codex: 'v2' },
      memories: [
        { name: 'v1', targets: [] },
        { name: 'v2', targets: ['codex'] },
      ],
    })
  })

  it('POST /memory/active sets active_memory in config.yaml', async () => {
    writeFileSync(join(home, '.loom', 'repos', 'default', 'memories', 'v1.md'), 'x')
    await req('POST', '/api/memory/active', { repo: 'default', name: 'v1' })
    const cfg = readFileSync(join(home, '.loom', 'repos', 'default', 'config.yaml'), 'utf8')
    expect(cfg).toContain('active_memory: v1')
  })

  it('POST /memory/active clears active_memory when name is null', async () => {
    writeFileSync(join(home, '.loom', 'repos', 'default', 'config.yaml'), 'active_memory: v1\n')
    const res = await req('POST', '/api/memory/active', { repo: 'default', name: null })
    expect(res.status).toBe(200)
    const cfg = readFileSync(join(home, '.loom', 'repos', 'default', 'config.yaml'), 'utf8')
    expect(cfg).not.toContain('active_memory')
  })

  it('POST /memory/active remains effective after memory_targets migration', async () => {
    const repo = join(home, '.loom', 'repos', 'default')
    writeFileSync(join(repo, 'memories', 'v1.md'), '# v1')
    writeFileSync(join(repo, 'memories', 'v2.md'), '# v2')
    writeFileSync(
      join(repo, 'config.yaml'),
      'targets:\n  - codex\n  - opencode\nmemory_targets:\n  codex: v2\n',
    )

    await req('POST', '/api/memory/active', { repo: 'default', name: 'v1' })
    const activated = await req('GET', '/api/memory?repo=default')
    expect(await activated.json()).toMatchObject({
      active: 'v1',
      assignments: { codex: 'v1', opencode: 'v1' },
    })

    await req('POST', '/api/memory/active', { repo: 'default', name: null })
    const cleared = await req('GET', '/api/memory?repo=default')
    expect(await cleared.json()).toMatchObject({ active: null, assignments: {} })
  })

  it('DELETE /memory removes file + clears active if active', async () => {
    writeFileSync(join(home, '.loom', 'repos', 'default', 'memories', 'v1.md'), 'x')
    writeFileSync(join(home, '.loom', 'repos', 'default', 'config.yaml'), 'active_memory: v1\n')
    await req('DELETE', '/api/memory?repo=default&name=v1')
    const cfg = readFileSync(join(home, '.loom', 'repos', 'default', 'config.yaml'), 'utf8')
    expect(cfg).not.toContain('active_memory: v1')
  })

  it('DELETE /memory removes every target assignment for the deleted memory', async () => {
    const repo = join(home, '.loom', 'repos', 'default')
    writeFileSync(join(repo, 'memories', 'team.md'), '# team')
    writeFileSync(join(repo, 'config.yaml'), 'memory_targets:\n  codex: team\n  opencode: team\n')

    await req('DELETE', '/api/memory?repo=default&name=team')

    const cfg = readFileSync(join(repo, 'config.yaml'), 'utf8')
    expect(cfg).not.toContain('codex: team')
    expect(cfg).not.toContain('opencode: team')
  })

  it('DELETE /memory rejects a missing name query before resolving a file path', async () => {
    const res = await req('DELETE', '/api/memory?repo=default')

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ ok: false, error: 'invalid_name' })
  })

  it('POST /memory/rename renames + syncs active', async () => {
    writeFileSync(join(home, '.loom', 'repos', 'default', 'memories', 'v1.md'), 'content')
    writeFileSync(join(home, '.loom', 'repos', 'default', 'config.yaml'), 'active_memory: v1\n')
    await req('POST', '/api/memory/rename', { repo: 'default', name: 'v1', newName: 'v2' })
    expect(readFileSync(join(home, '.loom', 'repos', 'default', 'memories', 'v2.md'), 'utf8')).toBe(
      'content',
    )
    const cfg = readFileSync(join(home, '.loom', 'repos', 'default', 'config.yaml'), 'utf8')
    expect(cfg).toContain('active_memory: v2')
  })

  it('POST /memory/rename updates every target assignment', async () => {
    const repo = join(home, '.loom', 'repos', 'default')
    writeFileSync(join(repo, 'memories', 'team.md'), '# team')
    writeFileSync(join(repo, 'config.yaml'), 'memory_targets:\n  codex: team\n  opencode: team\n')

    await req('POST', '/api/memory/rename', {
      repo: 'default',
      name: 'team',
      newName: 'guidelines',
    })

    const cfg = readFileSync(join(repo, 'config.yaml'), 'utf8')
    expect(cfg).toContain('codex: guidelines')
    expect(cfg).toContain('opencode: guidelines')
    expect(cfg).not.toContain(': team')
  })

  it('uses a dotted name consistently across content, activation, rename, and deletion', async () => {
    expect((await req('POST', '/api/memory', { repo: 'default', name: '.' })).status).toBe(200)
    expect(
      (
        await req('PUT', '/api/memory/content', {
          repo: 'default',
          name: '.',
          content: 'portable',
        })
      ).status,
    ).toBe(200)
    expect((await req('POST', '/api/memory/active', { repo: 'default', name: '.' })).status).toBe(
      200,
    )

    const read = await req('GET', '/api/memory?repo=default&name=.')
    expect(await read.json()).toEqual({ content: 'portable' })

    expect(
      (
        await req('POST', '/api/memory/rename', {
          repo: 'default',
          name: '.',
          newName: 'release.v1',
        })
      ).status,
    ).toBe(200)
    expect(readFileSync(join(home, '.loom', 'repos', 'default', 'config.yaml'), 'utf8')).toContain(
      'active_memory: release.v1',
    )

    expect((await req('DELETE', '/api/memory?repo=default&name=release.v1')).status).toBe(200)
  })

  it('POST /memory/rename rejects a case-insensitive filename collision', async () => {
    writeFileSync(join(home, '.loom', 'repos', 'default', 'memories', 'draft.md'), 'draft')
    writeFileSync(join(home, '.loom', 'repos', 'default', 'memories', 'Release.md'), 'release')

    const res = await req('POST', '/api/memory/rename', {
      repo: 'default',
      name: 'draft',
      newName: 'release',
    })

    expect(res.status).toBe(409)
  })

  it('persists memory order and keeps it normalized through create, rename, and delete', async () => {
    const repo = join(home, '.loom', 'repos', 'default')
    writeFileSync(join(repo, 'memories', 'a.md'), 'a')
    writeFileSync(join(repo, 'memories', 'b.md'), 'b')

    const reordered = await req('PUT', '/api/memory/order', {
      repo: 'default',
      names: ['b', 'missing', 'b'],
    })
    expect(await reordered.json()).toEqual({ ok: true, names: ['b', 'a'] })

    await req('POST', '/api/memory', { repo: 'default', name: 'c' })
    await req('POST', '/api/memory/rename', { repo: 'default', name: 'b', newName: 'team' })
    await req('DELETE', '/api/memory?repo=default&name=a')

    const listed = await req('GET', '/api/memory?repo=default')
    expect((await listed.json()).memories.map((memory: any) => memory.name)).toEqual(['team', 'c'])
    expect(readFileSync(join(repo, 'config.yaml'), 'utf8')).toContain(
      'memory_order:\n  - team\n  - c',
    )
  })

  it('does not rewrite an unchanged order and rejects malformed memory data', async () => {
    const repo = join(home, '.loom', 'repos', 'default')
    writeFileSync(join(repo, 'memories', 'a.md'), 'a')
    writeFileSync(join(repo, 'memories', 'b.md'), 'b')
    const originalConfig = 'memory_order:\n  - a\n  - b\n'
    writeFileSync(join(repo, 'config.yaml'), originalConfig)

    const unchanged = await req('PUT', '/api/memory/order', {
      repo: 'default',
      names: ['a', 'b'],
    })
    expect(await unchanged.json()).toEqual({ ok: true, names: ['a', 'b'] })
    expect(readFileSync(join(repo, 'config.yaml'), 'utf8')).toBe(originalConfig)

    writeFileSync(join(repo, 'memories', 'invalid name.md'), 'invalid')
    const malformedFiles = await req('PUT', '/api/memory/order', {
      repo: 'default',
      names: [],
    })
    expect(malformedFiles.status).toBe(422)

    writeFileSync(join(repo, 'config.yaml'), '- invalid\n')
    const malformedConfig = await req('PUT', '/api/memory/order', {
      repo: 'default',
      names: [],
    })
    expect(malformedConfig.status).toBe(422)
  })

  it('rolls back memory file mutations when the config replace fails', async () => {
    const repo = join(home, '.loom', 'repos', 'default')
    class FailingConfigFileSystem extends NodeFileSystem {
      override async replaceFile(): Promise<void> {
        throw new Error('config replace failed')
      }
    }
    const rollbackApp = new Hono().route(
      '/api',
      createMemoryRoutes({ fs: new FailingConfigFileSystem(), home } as any),
    )
    const rollbackReq = (method: string, path: string, body?: unknown) =>
      rollbackApp.request(`http://localhost${path}`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      })

    const createResponse = await rollbackReq('POST', '/api/memory', {
      repo: 'default',
      name: 'created',
    })
    expect(createResponse.status).toBe(400)
    expect(existsSync(join(repo, 'memories', 'created.md'))).toBe(false)

    writeFileSync(join(repo, 'memories', 'original.md'), 'original content')
    writeFileSync(
      join(repo, 'config.yaml'),
      'active_memory: original\nmemory_order:\n  - original\n',
    )
    const deleteResponse = await rollbackReq('DELETE', '/api/memory?repo=default&name=original')
    expect(deleteResponse.status).toBe(400)
    expect(readFileSync(join(repo, 'memories', 'original.md'), 'utf8')).toBe('original content')

    const renameResponse = await rollbackReq('POST', '/api/memory/rename', {
      repo: 'default',
      name: 'original',
      newName: 'renamed',
    })
    expect(renameResponse.status).toBe(400)
    expect(existsSync(join(repo, 'memories', 'original.md'))).toBe(true)
    expect(existsSync(join(repo, 'memories', 'renamed.md'))).toBe(false)
    expect(readFileSync(join(repo, 'config.yaml'), 'utf8')).toBe(
      'active_memory: original\nmemory_order:\n  - original\n',
    )
  })

  it('POST /memory/preview renders ${VAR} for agent', async () => {
    process.env.CLAUDE_CONFIG_DIR = join(home, 'claude')
    const res = await req('POST', '/api/memory/preview', {
      repo: 'default',
      content: 'agent=${LOOM_AGENT} file=${LOOM_AGENT_FILE}',
      agent: 'claude-code',
    })
    const j = await res.json()
    expect(j.rendered).toBe('agent=claude-code file=CLAUDE.md')
    delete process.env.CLAUDE_CONFIG_DIR
  })

  it('POST /memory/preview renders agent-aware repo and local vars', async () => {
    mkdirSync(join(home, '.loom', 'repos', 'default', 'vars', 'agents'), { recursive: true })
    mkdirSync(join(home, '.loom', 'local', 'repos', 'default', 'vars'), { recursive: true })
    writeFileSync(
      join(home, '.loom', 'repos', 'default', 'vars', 'base.yaml'),
      [
        'agent_name:',
        '  type: string',
        '  value: Agent',
        'rtk:',
        '  type: string',
        '  format: path',
        "  value: '${LOOM_CONFIG_DIR}/RTK.md'",
      ].join('\n'),
    )
    writeFileSync(
      join(home, '.loom', 'repos', 'default', 'vars', 'agents', 'codex.yaml'),
      'agent_name:\n  value: Codex\n',
    )
    writeFileSync(
      join(home, '.loom', 'local', 'repos', 'default', 'vars', 'local.yaml'),
      'agent_name:\n  value: Local Codex\n',
    )
    process.env.CODEX_HOME = join(home, 'codex')

    const res = await req('POST', '/api/memory/preview', {
      repo: 'default',
      content: '# ${agent_name}\\n@${rtk}',
      agent: 'codex',
    })
    const j = await res.json()
    expect(res.status).toBe(200)
    expect(j.rendered).toBe('# Local Codex\\n@' + join(home, 'codex') + '/RTK.md')
    expect(j.resolution.sources.agent_name).toEqual({ locality: 'local', layer: 'local' })
    delete process.env.CODEX_HOME
  })
})
