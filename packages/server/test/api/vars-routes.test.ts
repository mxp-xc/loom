import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { NodeFileSystem } from '../../src/platform/node/fs.js'
import { VarsStore } from '../../src/vars/store.js'
import { createVarsRoutes } from '../../src/api/routes/vars.js'
import { registerRoutes } from '../../src/api/router.js'

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

describe('vars HTTP API', () => {
  let root: string
  let home: string
  let store: VarsStore
  let app: ReturnType<typeof createVarsRoutes>

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'loom-vars-api-'))
    root = join(home, '.loom', 'repos', 'default')
    await mkdir(join(root, 'vars'), { recursive: true })
    await writeFile(join(home, '.loom', 'config.yaml'), 'active_repo: default\n')
    const fs = new NodeFileSystem()
    store = new VarsStore(root, fs)
    app = createVarsRoutes({ fs, git: {} as never, proc: {} as never, home })
    await store.create('dev', {
      format: 'typed',
      entries: {
        API_KEY: { type: 'secret', value: 'top-secret' },
        HOST: { type: 'string', value: 'localhost' },
        URL: { type: 'string', value: 'https://${HOST}' },
      },
    })
  })

  afterEach(async () => rm(home, { recursive: true, force: true }))

  async function json(path: string, init?: RequestInit) {
    const response = await app.request(path, init)
    return { response, body: (await response.json()) as any }
  }

  async function symlinkDirectory(target: string, path: string) {
    await symlink(target, path, process.platform === 'win32' ? 'junction' : 'dir')
  }

  it('lists environments and masks secrets in environment details', async () => {
    const listed = await json(`/vars/environments?repoPath=${encodeURIComponent(root)}`)
    expect(listed.response.status).toBe(200)
    expect(listed.body).toEqual({ ok: true, environments: ['dev'], diagnostics: [] })

    const detail = await json(`/vars/environments/dev?repoPath=${encodeURIComponent(root)}`)
    expect(detail.response.status).toBe(200)
    expect(detail.body.environment.entries.API_KEY).toEqual({
      type: 'secret',
      value: '••••••••',
      masked: true,
    })
    expect(JSON.stringify(detail.body)).not.toContain('top-secret')
  })

  it('accepts the active repository name as a vars repoPath alias', async () => {
    const listed = await json('/vars/environments?repoPath=default')
    expect(listed.response.status).toBe(200)
    expect(listed.body).toEqual({ ok: true, environments: ['dev'], diagnostics: [] })
  })

  it('returns an agent-aware key matrix from synced, local, and builtin layers', async () => {
    await mkdir(join(root, 'vars', 'agents'), { recursive: true })
    await mkdir(join(home, '.loom', 'local', 'repos', 'default', 'vars', 'agents'), {
      recursive: true,
    })
    await writeFile(
      join(root, 'vars', 'base.yaml'),
      [
        'agent_name:',
        '  type: string',
        '  value: Agent',
        'count:',
        '  type: number',
        '  value: 1',
        '',
      ].join('\n'),
    )
    await writeFile(join(root, 'vars', 'agents', 'codex.yaml'), 'agent_name:\n  value: Codex\n')
    await writeFile(
      join(home, '.loom', 'local', 'repos', 'default', 'vars', 'local.yaml'),
      'count:\n  value: 2\n',
    )
    await writeFile(
      join(home, '.loom', 'local', 'repos', 'default', 'vars', 'agents', 'codex.yaml'),
      'agent_name:\n  value: Local Codex\n',
    )

    const result = await json(`/vars/matrix?repoPath=${encodeURIComponent(root)}&agent=codex`)

    expect(result.response.status).toBe(200)
    expect(result.body.builtinKeys).toContain('LOOM_AGENT')
    expect(result.body.userKeys).toEqual(['agent_name', 'count'])
    expect(result.body.resolution.values.agent_name.value).toBe('Local Codex')
    expect(result.body.resolution.values.count.value).toBe(2)
    expect(result.body.resolution.sources.agent_name).toMatchObject({
      locality: 'local',
      layer: 'agent',
      agent: 'codex',
    })
    expect(result.body.resolution.overrideChains.agent_name).toEqual([
      { locality: 'synced', layer: 'base' },
      { locality: 'synced', layer: 'agent', agent: 'codex' },
      { locality: 'local', layer: 'agent', agent: 'codex' },
    ])
  })

  it('returns the default matrix without agent overrides or builtin runtime', async () => {
    await mkdir(join(root, 'vars', 'agents'), { recursive: true })
    await mkdir(join(home, '.loom', 'local', 'repos', 'default', 'vars'), { recursive: true })
    await writeFile(join(root, 'vars', 'base.yaml'), 'agent_name:\n  type: string\n  value: Base\n')
    await writeFile(join(root, 'vars', 'agents', 'codex.yaml'), 'agent_name:\n  value: Codex\n')
    await writeFile(
      join(home, '.loom', 'local', 'repos', 'default', 'vars', 'local.yaml'),
      'agent_name:\n  value: Local\n',
    )

    const result = await json(`/vars/matrix?repoPath=${encodeURIComponent(root)}&agent=default`)

    expect(result.response.status).toBe(200)
    expect(result.body.agent).toBe('default')
    expect(result.body.builtinKeys).toEqual([])
    expect(result.body.snapshot.baseAgent).toEqual({})
    expect(result.body.snapshot.localAgent).toEqual({})
    expect(result.body.resolution.values.agent_name.value).toBe('Local')
    expect(result.body.resolution.values).not.toHaveProperty('LOOM_AGENT')
  })

  it('masks secrets and secret-tainted values in the public vars preview', async () => {
    await writeFile(
      join(root, 'vars', 'base.yaml'),
      [
        'API_KEY:',
        '  type: secret',
        '  value: top-secret-preview',
        'AUTH_HEADER:',
        '  type: string',
        '  value: Bearer ${API_KEY}',
        '',
      ].join('\n'),
    )

    const result = await json(`/vars/preview?repoPath=${encodeURIComponent(root)}&agent=default`)

    expect(result.response.status).toBe(200)
    expect(result.body.values.API_KEY).toEqual({
      type: 'secret',
      value: '••••••••',
      masked: true,
    })
    expect(result.body.values.AUTH_HEADER).toEqual({
      type: 'string',
      value: '••••••••',
      masked: true,
    })
    expect(result.body.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: 'API_KEY',
          value: { type: 'secret', value: '••••••••', masked: true },
        }),
        expect.objectContaining({
          key: 'AUTH_HEADER',
          value: { type: 'string', value: '••••••••', masked: true },
        }),
      ]),
    )
    expect(JSON.stringify(result.body)).not.toContain('top-secret-preview')
    expect(JSON.stringify(result.body)).not.toContain('Bearer top-secret-preview')
  })

  it('sets base definitions and local overrides in their semantic layers', async () => {
    const created = await json('/vars/base-key', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        repoPath: root,
        key: 'agent_name',
        definition: { type: 'string', value: 'Agent' },
      }),
    })
    expect(created.response.status).toBe(200)
    expect(await readFile(join(root, 'vars', 'base.yaml'), 'utf8')).toContain('agent_name:')

    const overridden = await json('/vars/override', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        repoPath: root,
        layer: 'local',
        key: 'agent_name',
        override: { value: 'Local Agent' },
      }),
    })
    expect(overridden.response.status).toBe(200)
    const localPath = join(home, '.loom', 'local', 'repos', 'default', 'vars', 'local.yaml')
    expect(await readFile(localPath, 'utf8')).toContain('Local Agent')

    const matrix = await json(`/vars/matrix?repoPath=${encodeURIComponent(root)}&agent=codex`)
    expect(matrix.body.resolution.values.agent_name.value).toBe('Local Agent')

    const cleared = await json('/vars/override', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repoPath: root, layer: 'local', key: 'agent_name' }),
    })
    expect(cleared.response.status).toBe(200)
    expect(await readFile(localPath, 'utf8')).not.toContain('agent_name:')
  })

  it('renames and deletes base keys across known override layers', async () => {
    await mkdir(join(root, 'vars', 'agents'), { recursive: true })
    await mkdir(join(home, '.loom', 'local', 'repos', 'default', 'vars', 'agents'), {
      recursive: true,
    })
    await writeFile(
      join(root, 'vars', 'base.yaml'),
      ['agent_name:', '  type: string', '  value: Agent', ''].join('\n'),
    )
    await writeFile(join(root, 'vars', 'agents', 'codex.yaml'), 'agent_name:\n  value: Codex\n')
    await writeFile(
      join(home, '.loom', 'local', 'repos', 'default', 'vars', 'local.yaml'),
      'agent_name:\n  value: Local\n',
    )
    await writeFile(
      join(home, '.loom', 'local', 'repos', 'default', 'vars', 'agents', 'codex.yaml'),
      'agent_name:\n  value: Local Codex\n',
    )

    const renamed = await json('/vars/base-key/rename', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repoPath: root, oldKey: 'agent_name', newKey: 'assistant_name' }),
    })
    expect(renamed.response.status).toBe(200)

    const matrix = await json('/vars/matrix?repoPath=' + encodeURIComponent(root) + '&agent=codex')
    expect(matrix.body.userKeys).toEqual(['assistant_name'])
    expect(matrix.body.resolution.values.assistant_name.value).toBe('Local Codex')
    expect(await readFile(join(root, 'vars', 'agents', 'codex.yaml'), 'utf8')).toContain(
      'assistant_name:',
    )
    expect(
      await readFile(
        join(home, '.loom', 'local', 'repos', 'default', 'vars', 'agents', 'codex.yaml'),
        'utf8',
      ),
    ).toContain('assistant_name:')

    const deleted = await json('/vars/base-key', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repoPath: root, key: 'assistant_name' }),
    })
    expect(deleted.response.status).toBe(200)

    const afterDelete = await json(
      '/vars/matrix?repoPath=' + encodeURIComponent(root) + '&agent=codex',
    )
    expect(afterDelete.body.userKeys).toEqual([])
    expect(await readFile(join(root, 'vars', 'agents', 'codex.yaml'), 'utf8')).not.toContain(
      'assistant_name:',
    )
    expect(
      await readFile(
        join(home, '.loom', 'local', 'repos', 'default', 'vars', 'agents', 'codex.yaml'),
        'utf8',
      ),
    ).not.toContain('assistant_name:')
  })

  it('returns a repairable matrix with diagnostics when an override file has typed entries', async () => {
    await mkdir(join(root, 'vars', 'agents'), { recursive: true })
    await writeFile(
      join(root, 'vars', 'base.yaml'),
      ['agent_name:', '  type: string', '  value: Agent', ''].join('\n'),
    )
    await writeFile(
      join(root, 'vars', 'agents', 'codex.yaml'),
      ['agent_name:', '  type: string', '  value: Codex', ''].join('\n'),
    )

    const result = await json('/vars/matrix?repoPath=' + encodeURIComponent(root) + '&agent=codex')

    expect(result.response.status).toBe(200)
    expect(result.body.userKeys).toEqual(['agent_name'])
    expect(result.body.resolution.ok).toBe(false)
    expect(result.body.resolution.diagnostics[0]).toMatchObject({
      code: 'override_entry_invalid',
      layer: 'base-agent',
    })
  })

  it('keeps malformed override layers repairable during base mutations', async () => {
    await mkdir(join(root, 'vars', 'agents'), { recursive: true })
    await writeFile(
      join(root, 'vars', 'base.yaml'),
      ['agent_name:', '  type: string', '  value: Agent', ''].join('\n'),
    )
    await writeFile(
      join(root, 'vars', 'agents', 'codex.yaml'),
      ['agent_name:', '  type: string', '  value: Codex', ''].join('\n'),
    )

    const rejected = await json('/vars/base-key', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        repoPath: root,
        key: 'other',
        definition: { type: 'string', value: 'Other' },
      }),
    })

    expect(rejected.response.status).toBe(422)
    expect(rejected.body.error.code).toBe('validation_failed')
    expect(rejected.body.error.diagnostics[0]).toMatchObject({
      code: 'override_entry_invalid',
      layer: 'base-agent',
    })
    expect(await readFile(join(root, 'vars', 'base.yaml'), 'utf8')).not.toContain('other:')
  })

  it('includes orphan override keys in the matrix so they can be cleared', async () => {
    await mkdir(join(home, '.loom', 'local', 'repos', 'default', 'vars'), { recursive: true })
    await writeFile(
      join(root, 'vars', 'base.yaml'),
      ['known:', '  type: string', '  value: Known', ''].join('\n'),
    )
    await writeFile(
      join(home, '.loom', 'local', 'repos', 'default', 'vars', 'local.yaml'),
      ['orphan:', '  value: remove-me', ''].join('\n'),
    )

    const matrix = await json('/vars/matrix?repoPath=' + encodeURIComponent(root) + '&agent=codex')

    expect(matrix.response.status).toBe(200)
    expect(matrix.body.userKeys).toEqual(['known', 'orphan'])
    expect(matrix.body.resolution.ok).toBe(false)
    expect(matrix.body.resolution.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'UNKNOWN_OVERRIDE_KEY', key: 'orphan' }),
      ]),
    )
  })

  it('reports unsupported agent override files as diagnostics without rendering them', async () => {
    await mkdir(join(root, 'vars', 'agents'), { recursive: true })
    await writeFile(
      join(root, 'vars', 'base.yaml'),
      ['agent_name:', '  type: string', '  value: Agent', ''].join('\n'),
    )
    await writeFile(join(root, 'vars', 'agents', 'ghost.yaml'), 'agent_name:\n  value: Ghost\n')

    const matrix = await json('/vars/matrix?repoPath=' + encodeURIComponent(root) + '&agent=codex')

    expect(matrix.response.status).toBe(200)
    expect(matrix.body.resolution.ok).toBe(false)
    expect(matrix.body.resolution.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'UNKNOWN_AGENT_OVERRIDE_FILE',
          layer: 'base-agent',
        }),
      ]),
    )
    expect(matrix.body.snapshot.baseAgent).toEqual({})
  })

  it('blocks deleting a base key while other vars still reference it', async () => {
    await writeFile(
      join(root, 'vars', 'base.yaml'),
      [
        'API_URL:',
        '  type: string',
        '  value: https://example.test',
        'CLIENT:',
        '  type: string',
        '  value: ' + '$' + '{API_URL}/client',
        '',
      ].join('\n'),
    )

    const deleted = await json('/vars/base-key', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repoPath: root, key: 'API_URL' }),
    })

    expect(deleted.response.status).toBe(409)
    expect(deleted.body.error.code).toBe('delete_blocked_by_reference')
    expect(deleted.body.error.diagnostics[0]).toMatchObject({
      code: 'REFERENCE_EXISTS',
      key: 'CLIENT',
      referencedKey: 'API_URL',
      layer: 'base',
    })
    expect(await readFile(join(root, 'vars', 'base.yaml'), 'utf8')).toContain('API_URL:')
  })

  it('blocks deleting a base key while memory or MCP consumers still reference it', async () => {
    await mkdir(join(root, 'memories'), { recursive: true })
    await writeFile(
      join(root, 'vars', 'base.yaml'),
      ['API_URL:', '  type: string', '  value: https://example.test', ''].join('\n'),
    )
    await writeFile(
      join(root, 'memories', 'default.md'),
      'Use ' + '$' + '{API_URL}' + ' in memory\n',
    )
    await writeFile(
      join(root, 'mcp.yaml'),
      ['servers:', '  - id: api', '    type: stdio', '    command: ' + '$' + '{API_URL}', ''].join(
        '\n',
      ),
    )

    const deleted = await json('/vars/base-key', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repoPath: root, key: 'API_URL' }),
    })

    expect(deleted.response.status).toBe(409)
    expect(deleted.body.error.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'CONSUMER_REFERENCE_EXISTS', layer: 'memory' }),
        expect.objectContaining({ code: 'CONSUMER_REFERENCE_EXISTS', layer: 'mcp' }),
      ]),
    )
    expect(await readFile(join(root, 'vars', 'base.yaml'), 'utf8')).toContain('API_URL:')
  })

  it('treats an even-backslash consumer token as active when deleting a base key', async () => {
    await mkdir(join(root, 'memories'), { recursive: true })
    await writeFile(
      join(root, 'vars', 'base.yaml'),
      ['API_URL:', '  type: string', '  value: https://example.test', ''].join('\n'),
    )
    await writeFile(
      join(root, 'memories', 'default.md'),
      'literal=\\${API_URL}\nactive=\\\\${API_URL}\n',
    )

    const deleted = await json('/vars/base-key', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repoPath: root, key: 'API_URL' }),
    })

    expect(deleted.response.status).toBe(409)
    expect(deleted.body.error.diagnostics).toEqual([
      expect.objectContaining({ code: 'CONSUMER_REFERENCE_EXISTS', layer: 'memory' }),
    ])
  })

  it('renames base keys and rewrites vars references across base and override layers', async () => {
    await mkdir(join(home, '.loom', 'local', 'repos', 'default', 'vars'), { recursive: true })
    await writeFile(
      join(root, 'vars', 'base.yaml'),
      [
        'API_URL:',
        '  type: string',
        '  value: https://example.test',
        'CLIENT:',
        '  type: string',
        '  value: ' + '$' + '{API_URL}/client',
        '',
      ].join('\n'),
    )
    await writeFile(
      join(home, '.loom', 'local', 'repos', 'default', 'vars', 'local.yaml'),
      ['CLIENT:', '  value: ' + '$' + '{API_URL}/local', ''].join('\n'),
    )

    const renamed = await json('/vars/base-key/rename', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repoPath: root, oldKey: 'API_URL', newKey: 'SERVICE_URL' }),
    })

    expect(renamed.response.status).toBe(200)
    expect(await readFile(join(root, 'vars', 'base.yaml'), 'utf8')).toContain(
      '$' + '{SERVICE_URL}/client',
    )
    expect(
      await readFile(
        join(home, '.loom', 'local', 'repos', 'default', 'vars', 'local.yaml'),
        'utf8',
      ),
    ).toContain('$' + '{SERVICE_URL}/local')
  })

  it('renames base keys and rewrites known consumer references', async () => {
    await mkdir(join(root, 'memories'), { recursive: true })
    await writeFile(
      join(root, 'vars', 'base.yaml'),
      ['API_URL:', '  type: string', '  value: https://example.test', ''].join('\n'),
    )
    await writeFile(
      join(root, 'memories', 'default.md'),
      'Use ' + '$' + '{API_URL}' + ' in memory\n',
    )
    await writeFile(
      join(root, 'mcp.yaml'),
      ['servers:', '  - id: api', '    type: stdio', '    command: ' + '$' + '{API_URL}', ''].join(
        '\n',
      ),
    )

    const renamed = await json('/vars/base-key/rename', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repoPath: root, oldKey: 'API_URL', newKey: 'SERVICE_URL' }),
    })

    expect(renamed.response.status).toBe(200)
    expect(await readFile(join(root, 'memories', 'default.md'), 'utf8')).toContain(
      '$' + '{SERVICE_URL}',
    )
    expect(await readFile(join(root, 'mcp.yaml'), 'utf8')).toContain('$' + '{SERVICE_URL}')
  })

  it('preserves escaped consumer tokens while renaming active tokens with defaults', async () => {
    await mkdir(join(root, 'memories'), { recursive: true })
    await writeFile(
      join(root, 'vars', 'base.yaml'),
      ['API_URL:', '  type: string', '  value: https://example.test', ''].join('\n'),
    )
    await writeFile(
      join(root, 'memories', 'default.md'),
      ['default=${API_URL:fallback}', 'literal=\\${API_URL}', 'active=\\\\${API_URL}', ''].join(
        '\n',
      ),
    )

    const renamed = await json('/vars/base-key/rename', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repoPath: root, oldKey: 'API_URL', newKey: 'SERVICE_URL' }),
    })

    expect(renamed.response.status).toBe(200)
    const memory = await readFile(join(root, 'memories', 'default.md'), 'utf8')
    expect(memory).toContain('default=${SERVICE_URL:fallback}')
    expect(memory).toContain('literal=\\${API_URL}')
    expect(memory).toContain('active=\\\\${SERVICE_URL}')
  })

  it('rejects overrides that do not match the base definition type before persisting', async () => {
    await writeFile(
      join(root, 'vars', 'base.yaml'),
      ['count:', '  type: number', '  value: 1', ''].join('\n'),
    )

    const rejected = await json('/vars/override', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        repoPath: root,
        layer: 'local',
        key: 'count',
        override: { value: 'not-a-number' },
      }),
    })

    expect(rejected.response.status).toBe(422)
    expect(rejected.body.error.code).toBe('override_type_mismatch')
    const localPath = join(home, '.loom', 'local', 'repos', 'default', 'vars', 'local.yaml')
    await expect(readFile(localPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects base definition changes that would invalidate existing overrides', async () => {
    await mkdir(join(home, '.loom', 'local', 'repos', 'default', 'vars'), { recursive: true })
    await writeFile(
      join(root, 'vars', 'base.yaml'),
      ['count:', '  type: string', '  value: one', ''].join('\n'),
    )
    await writeFile(
      join(home, '.loom', 'local', 'repos', 'default', 'vars', 'local.yaml'),
      ['count:', '  value: local-one', ''].join('\n'),
    )

    const rejected = await json('/vars/base-key', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        repoPath: root,
        key: 'count',
        definition: { type: 'number', value: 1 },
      }),
    })

    expect(rejected.response.status).toBe(422)
    expect(rejected.body.error.code).toBe('validation_failed')
    expect(rejected.body.error.diagnostics[0]).toMatchObject({
      code: 'OVERRIDE_TYPE_MISMATCH',
      key: 'count',
      layer: 'local',
    })
    expect(await readFile(join(root, 'vars', 'base.yaml'), 'utf8')).toContain('type: string')
  })

  it('rejects every vars operation outside the dynamically active repository', async () => {
    const unauthorized = join(home, 'unauthorized')
    await mkdir(join(unauthorized, 'vars'), { recursive: true })
    await writeFile(
      join(unauthorized, 'vars', 'dev.yaml'),
      'API_KEY: { type: secret, value: stolen-secret }\n',
    )

    const requests = [
      app.request(`/vars/environments?repoPath=${encodeURIComponent(unauthorized)}`),
      app.request('/vars/variables/reveal', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ repoPath: unauthorized, environment: 'dev', key: 'API_KEY' }),
      }),
      app.request('/vars/resolve', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ repoPath: unauthorized, chain: ['dev'] }),
      }),
      app.request('/vars/validate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          repoPath: unauthorized,
          chain: ['dev'],
          environment: 'dev',
          key: 'DRAFT',
          entry: { type: 'string', value: 'safe' },
        }),
      }),
      app.request('/vars/variables', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          repoPath: unauthorized,
          environment: 'dev',
          key: 'NEW_SECRET',
          entry: { type: 'secret', value: 'new-secret' },
        }),
      }),
    ]
    for (const response of await Promise.all(requests)) {
      expect(response.status).toBe(403)
      expect(await response.json()).toEqual({
        ok: false,
        error: { code: 'repo_not_authorized', message: '仓库未授权' },
      })
    }

    const nextRoot = join(home, '.loom', 'repos', 'next')
    await mkdir(join(nextRoot, 'vars'), { recursive: true })
    await writeFile(join(home, '.loom', 'config.yaml'), 'active_repo: next\n')
    expect(
      (await app.request(`/vars/environments?repoPath=${encodeURIComponent(root)}`)).status,
    ).toBe(403)
    expect(
      (await app.request(`/vars/environments?repoPath=${encodeURIComponent(nextRoot)}`)).status,
    ).toBe(200)
  })

  it('accepts the active repository through a symlink alias', async () => {
    const alias = join(home, 'authorized-alias')
    await symlinkDirectory(root, alias)
    const response = await app.request(`/vars/environments?repoPath=${encodeURIComponent(alias)}`)
    expect(response.status).toBe(200)
  })

  it('uses only the authorized canonical path after a repository alias is swapped', async () => {
    const alias = join(home, 'swap-alias')
    const unauthorized = join(home, 'swap-target')
    const fs = new NodeFileSystem()
    const unauthorizedStore = new VarsStore(unauthorized, fs)
    await mkdir(join(unauthorized, 'vars'), { recursive: true })
    await unauthorizedStore.create('dev', {
      format: 'typed',
      entries: {
        API_KEY: { type: 'secret', value: 'stolen-secret' },
        HOST: { type: 'string', value: 'evil.example' },
        URL: { type: 'string', value: 'https://${HOST}' },
        TEMP: { type: 'string', value: 'unauthorized-temp' },
      },
    })
    await store.write('dev', {
      ...(await store.read('dev')),
      entries: {
        ...(await store.read('dev')).entries,
        TEMP: { type: 'string', value: 'authorized-temp' },
      },
    })

    let armed = false
    let removeAliasInstead = false
    const swappingFs = Object.create(fs) as NodeFileSystem
    swappingFs.realPath = async (path: string) => {
      const canonical = await fs.realPath(path)
      if (path === alias && armed) {
        armed = false
        await rm(alias, { force: true })
        if (!removeAliasInstead) await symlinkDirectory(unauthorized, alias)
      }
      return canonical
    }
    const swappingApp = createVarsRoutes({
      fs: swappingFs,
      git: {} as never,
      proc: {} as never,
      home,
    })
    const resetAlias = async (remove = false) => {
      await rm(alias, { force: true })
      await symlinkDirectory(root, alias)
      removeAliasInstead = remove
      armed = true
    }

    await resetAlias()
    const revealed = await swappingApp.request('/vars/variables/reveal', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repoPath: alias, environment: 'dev', key: 'API_KEY' }),
    })
    expect(await revealed.json()).toEqual({
      ok: true,
      entry: { type: 'secret', value: 'top-secret' },
    })

    await resetAlias(true)
    const detail = await swappingApp.request(
      `/vars/environments/dev?repoPath=${encodeURIComponent(alias)}`,
    )
    expect(((await detail.json()) as any).environment.entries.HOST.value).toBe('localhost')

    await resetAlias()
    const resolved = await swappingApp.request('/vars/resolve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repoPath: alias, chain: ['dev'] }),
    })
    expect(((await resolved.json()) as any).values.URL.value).toBe('https://localhost')

    await resetAlias()
    expect(
      (
        await swappingApp.request('/vars/variables', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            repoPath: alias,
            environment: 'dev',
            key: 'CANONICAL_ONLY',
            entry: { type: 'string', value: 'safe' },
          }),
        })
      ).status,
    ).toBe(200)

    await resetAlias()
    expect(
      (
        await swappingApp.request('/vars/variables', {
          method: 'DELETE',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ repoPath: alias, environment: 'dev', key: 'TEMP' }),
        })
      ).status,
    ).toBe(200)
    expect((await store.read('dev')).entries).toMatchObject({
      CANONICAL_ONLY: { type: 'string', value: 'safe' },
    })
    expect((await store.read('dev')).entries.TEMP).toBeUndefined()
    expect((await unauthorizedStore.read('dev')).entries).toMatchObject({
      API_KEY: { type: 'secret', value: 'stolen-secret' },
      TEMP: { type: 'string', value: 'unauthorized-temp' },
    })
    expect((await unauthorizedStore.read('dev')).entries.CANONICAL_ONLY).toBeUndefined()
  })

  it('creates and deletes environments with conflicts and not-found responses', async () => {
    const created = await json('/vars/environments', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repoPath: root, environment: 'prod' }),
    })
    expect(created.response.status).toBe(201)
    expect((await store.read('prod')).entries).toEqual({})

    const conflict = await json('/vars/environments', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repoPath: root, environment: 'prod' }),
    })
    expect(conflict.response.status).toBe(409)
    expect(conflict.body.error.code).toBe('environment_conflict')

    const deleted = await json('/vars/environments', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repoPath: root, environment: 'prod' }),
    })
    expect(deleted.response.status).toBe(200)
    const missing = await json(`/vars/environments/prod?repoPath=${encodeURIComponent(root)}`)
    expect(missing.response.status).toBe(404)
    expect(missing.body.error.code).toBe('environment_not_found')
  })

  it('sets typed values, renames references, and resolves a chain without exposing secrets', async () => {
    const set = await json('/vars/variables', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        repoPath: root,
        environment: 'dev',
        key: 'PORT',
        entry: { type: 'number', value: 3000 },
      }),
    })
    expect(set.response.status).toBe(200)

    const renamed = await json('/vars/variables/rename', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        repoPath: root,
        environment: 'dev',
        oldKey: 'HOST',
        newKey: 'DOMAIN',
      }),
    })
    expect(renamed.response.status).toBe(200)
    expect((await store.read('dev')).entries.URL).toEqual({
      type: 'string',
      value: 'https://${DOMAIN}',
    })

    const resolved = await json('/vars/resolve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repoPath: root, chain: ['dev'] }),
    })
    expect(resolved.response.status).toBe(200)
    expect(resolved.body.values.API_KEY).toEqual({
      type: 'secret',
      value: '••••••••',
      masked: true,
    })
    expect(resolved.body.values.URL.value).toBe('https://localhost')
    expect(resolved.body.sources.DOMAIN).toBe('dev')
    expect(resolved.body.dependencies.URL).toEqual(['DOMAIN'])
    expect(JSON.stringify(resolved.body)).not.toContain('top-secret')
  })

  it('masks every resolved value transitively tainted by a secret', async () => {
    await store.write('dev', {
      format: 'typed',
      entries: {
        API_KEY: { type: 'secret', value: 'top-secret' },
        DIRECT: { type: 'string', value: '${API_KEY}' },
        MIDDLE: { type: 'string', value: 'prefix-${DIRECT}-suffix' },
        MULTI_HOP: { type: 'string', value: '${MIDDLE}' },
        HOST: { type: 'string', value: 'localhost' },
        URL: { type: 'string', value: 'https://${HOST}' },
      },
    })

    const resolved = await json('/vars/resolve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repoPath: root, chain: ['dev'] }),
    })

    expect(resolved.response.status).toBe(200)
    for (const key of ['API_KEY', 'DIRECT', 'MIDDLE', 'MULTI_HOP']) {
      expect(resolved.body.values[key]).toEqual({
        type: resolved.body.values[key].type,
        value: '••••••••',
        masked: true,
      })
    }
    expect(resolved.body.values.URL).toEqual({ type: 'string', value: 'https://localhost' })
    expect(resolved.body.dependencies.MULTI_HOP).toEqual(['MIDDLE'])
    expect(JSON.stringify(resolved.body)).not.toContain('top-secret')
    expect(JSON.stringify(resolved.body)).not.toContain('prefix-top-secret-suffix')
  })

  it('validates drafts in memory without writing and returns masked resolutions or stable diagnostics', async () => {
    const writeMany = vi.spyOn(VarsStore.prototype, 'writeMany')
    const beforeValidation = await store.read('dev')
    const request = (key: string, entry: unknown, chain = ['dev']) =>
      json('/vars/validate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ repoPath: root, chain, environment: 'dev', key, entry }),
      })

    const valid = await request('DRAFT', { type: 'string', value: 'token=${API_KEY}' })
    expect(valid.response.status).toBe(200)
    expect(valid.body.resolution.values.DRAFT).toEqual({
      type: 'string',
      value: '••••••••',
      masked: true,
    })
    expect(JSON.stringify(valid.body)).not.toContain('top-secret')

    const missing = await request('DRAFT', { type: 'string', value: '${MISSING}' })
    expect(missing.response.status).toBe(422)
    expect(missing.body.error.code).toBe('validation_failed')
    expect(missing.body.error.diagnostics[0]).toMatchObject({
      code: 'MISSING_REFERENCE',
      key: 'DRAFT',
      path: ['DRAFT', 'MISSING'],
    })

    await store.write('dev', {
      ...(await store.read('dev')),
      entries: {
        ...(await store.read('dev')).entries,
        OTHER: { type: 'string', value: '${DRAFT}' },
      },
    })
    writeMany.mockClear()
    const cycle = await request('DRAFT', { type: 'string', value: '${OTHER}' })
    expect(cycle.response.status).toBe(422)
    expect(cycle.body.error.diagnostics[0]).toMatchObject({
      code: 'REFERENCE_CYCLE',
      path: ['OTHER', 'DRAFT', 'OTHER'],
    })

    const invalid = await request('DRAFT', { type: 'number', value: 'not-number' })
    expect(invalid.response.status).toBe(400)
    expect(invalid.body.error.code).toBe('invalid_request')
    expect(writeMany).not.toHaveBeenCalled()
    expect(await store.read('dev')).toEqual({
      ...beforeValidation,
      entries: { ...beforeValidation.entries, OTHER: { type: 'string', value: '${DRAFT}' } },
    })
    writeMany.mockRestore()
  })

  it('reveals only the explicitly requested variable', async () => {
    const revealed = await json('/vars/variables/reveal', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repoPath: root, environment: 'dev', key: 'API_KEY' }),
    })
    expect(revealed.response.status).toBe(200)
    expect(revealed.body).toEqual({ ok: true, entry: { type: 'secret', value: 'top-secret' } })
  })

  it('requires a current impact token for referenced variable deletion', async () => {
    const impact = await json('/vars/variables/delete-impact', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repoPath: root, environment: 'dev', key: 'HOST' }),
    })
    expect(impact.response.status).toBe(200)
    expect(impact.body.impact.direct).toHaveLength(1)

    const stale = await json('/vars/variables', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        repoPath: root,
        environment: 'dev',
        key: 'HOST',
        confirmed: true,
        impactToken: 'stale',
      }),
    })
    expect(stale.response.status).toBe(409)
    expect(stale.body.error.code).toBe('impact_changed')

    const deleted = await json('/vars/variables', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        repoPath: root,
        environment: 'dev',
        key: 'HOST',
        confirmed: true,
        impactToken: impact.body.impact.impactToken,
      }),
    })
    expect(deleted.response.status).toBe(200)
    expect((await store.read('dev')).entries.HOST).toBeUndefined()
  })

  it('returns stable validation errors for malformed JSON and invalid input', async () => {
    const malformed = await json('/vars/environments', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    })
    expect(malformed.response.status).toBe(400)
    expect(malformed.body.error.code).toBe('invalid_json')

    const invalid = await json('/vars/variables', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        repoPath: '',
        environment: '../bad',
        key: '1bad',
        entry: { type: 'secret', value: 1 },
      }),
    })
    expect(invalid.response.status).toBe(400)
    expect(invalid.body.error.code).toBe('invalid_request')

    const invalidChain = await json('/vars/resolve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repoPath: root, chain: ['..'] }),
    })
    expect(invalidChain.response.status).toBe(400)
    expect(invalidChain.body.error.code).toBe('invalid_request')
  })

  it('maps resolution failures and storage failures to safe stable errors', async () => {
    const unresolved = await json('/vars/resolve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repoPath: root, chain: ['missing'] }),
    })
    expect(unresolved.response.status).toBe(422)
    expect(unresolved.body.error.code).toBe('resolution_failed')

    const failedApp = createVarsRoutes({
      fs: {
        ...({} as any),
        realPath: async () => {
          throw new Error(`private path ${root}`)
        },
      },
      git: {} as never,
      proc: {} as never,
      home: root,
    })
    const failed = await failedApp.request(
      `/vars/environments?repoPath=${encodeURIComponent(root)}`,
    )
    expect(failed.status).toBe(500)
    const failedBody = (await failed.json()) as any
    expect(failedBody.error).toEqual({
      code: 'repo_unavailable',
      message: 'repository is unavailable',
    })
    expect(JSON.stringify(failedBody)).not.toContain(root)

    const missing = await app.request('/vars/environments?repoPath=/definitely/missing/repository')
    expect(missing.status).toBe(500)
    expect(await missing.json()).toEqual({
      ok: false,
      error: { code: 'io_error', message: '变量存储操作失败' },
    })
  })

  it('registers vars routes under the /api router', async () => {
    const fs = new NodeFileSystem()
    const routes = registerRoutes({ fs, git: {} as never, proc: {} as never, home })
    const router = new Hono().route('/api', routes)
    try {
      const response = await router.request(
        `/api/vars/environments?repoPath=${encodeURIComponent(root)}`,
      )
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({
        ok: true,
        environments: ['dev'],
        diagnostics: [],
      })
    } finally {
      await routes.dispose()
    }
  })
})
