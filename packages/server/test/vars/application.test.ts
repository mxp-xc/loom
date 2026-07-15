import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NodeFileSystem } from '../../src/platform/node/fs.js'
import { VarsApplication } from '../../src/vars/application.js'

describe('VarsApplication', () => {
  let home: string
  let repoPath: string
  let app: VarsApplication

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'loom-vars-app-'))
    repoPath = join(home, '.loom', 'repos', 'default')
    await mkdir(join(repoPath, 'vars'), { recursive: true })
    app = new VarsApplication(new NodeFileSystem(), home)
  })

  afterEach(async () => rm(home, { recursive: true, force: true }))

  it('rejects reserved builtin base keys before writing', async () => {
    await expect(
      app.setBaseKey(repoPath, 'LOOM_AGENT', { type: 'string', value: 'Codex' }),
    ).rejects.toMatchObject({
      status: 400,
      code: 'reserved_builtin_key',
    })
  })

  it('rejects overrides for missing base keys', async () => {
    await expect(
      app.setOverride(repoPath, {
        layer: 'local',
        key: 'missing',
        override: { value: 'x' },
      }),
    ).rejects.toMatchObject({
      status: 404,
      code: 'not_found',
    })
  })

  it('rejects override values that do not match the base definition type', async () => {
    await writeFile(
      join(repoPath, 'vars', 'base.yaml'),
      ['count:', '  type: number', '  value: 1', ''].join('\n'),
    )

    await expect(
      app.setOverride(repoPath, {
        layer: 'local',
        key: 'count',
        override: { value: 'not-a-number' },
      }),
    ).rejects.toMatchObject({
      status: 422,
      code: 'override_type_mismatch',
    })
  })

  it('returns the agent-aware matrix without HTTP concerns', async () => {
    await mkdir(join(repoPath, 'vars', 'agents'), { recursive: true })
    await mkdir(join(home, '.loom', 'local', 'repos', 'default', 'vars', 'agents'), {
      recursive: true,
    })
    await writeFile(
      join(repoPath, 'vars', 'base.yaml'),
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
    await writeFile(join(repoPath, 'vars', 'agents', 'codex.yaml'), 'agent_name:\n  value: Codex\n')
    await writeFile(
      join(home, '.loom', 'local', 'repos', 'default', 'vars', 'local.yaml'),
      'count:\n  value: 2\n',
    )
    await writeFile(
      join(home, '.loom', 'local', 'repos', 'default', 'vars', 'agents', 'codex.yaml'),
      'agent_name:\n  value: Local Codex\n',
    )

    const result = await app.matrix(repoPath, 'codex')

    expect(result.builtinKeys).toContain('LOOM_AGENT')
    expect(result.userKeys).toEqual(['agent_name', 'count'])
    expect(result.snapshot.base.agent_name).toEqual({ type: 'string', value: 'Agent' })
    expect(result.resolution.ok).toBe(true)
    if (!result.resolution.ok) throw new Error('expected matrix resolution to succeed')
    expect(result.resolution.values.agent_name.value).toBe('Local Codex')
    expect(result.resolution.values.count.value).toBe(2)
  })

  it('returns a default matrix with only base and local layers', async () => {
    await mkdir(join(repoPath, 'vars', 'agents'), { recursive: true })
    await mkdir(join(home, '.loom', 'local', 'repos', 'default', 'vars', 'agents'), {
      recursive: true,
    })
    await writeFile(join(repoPath, 'vars', 'base.yaml'), 'name:\n  type: string\n  value: Base\n')
    await writeFile(join(repoPath, 'vars', 'agents', 'codex.yaml'), 'name:\n  value: Codex\n')
    await writeFile(
      join(home, '.loom', 'local', 'repos', 'default', 'vars', 'local.yaml'),
      'name:\n  value: Local\n',
    )
    await writeFile(
      join(home, '.loom', 'local', 'repos', 'default', 'vars', 'agents', 'codex.yaml'),
      'name:\n  value: Local Codex\n',
    )

    const result = await app.matrix(repoPath, 'default')

    expect(result.agent).toBe('default')
    expect(result.builtinKeys).toEqual([])
    expect(result.snapshot.baseAgent).toEqual({})
    expect(result.snapshot.localAgent).toEqual({})
    expect(result.resolution.ok).toBe(true)
    if (!result.resolution.ok) throw new Error('expected default matrix resolution to succeed')
    expect(result.resolution.values.name.value).toBe('Local')
    expect(result.resolution.values).not.toHaveProperty('LOOM_AGENT')
  })

  it('masks secrets and secret-tainted values in the agent-aware matrix', async () => {
    await writeFile(
      join(repoPath, 'vars', 'base.yaml'),
      [
        'API_KEY:',
        '  type: secret',
        '  value: top-secret',
        'AUTH_HEADER:',
        '  type: string',
        '  value: Bearer ${API_KEY}',
        '',
      ].join('\n'),
    )
    await mkdir(join(home, '.loom', 'local', 'repos', 'default', 'vars'), { recursive: true })
    await writeFile(
      join(home, '.loom', 'local', 'repos', 'default', 'vars', 'local.yaml'),
      'API_KEY:\n  value: local-secret\n',
    )

    const result = await app.matrix(repoPath, 'codex')

    expect(result.snapshot.base.API_KEY).toEqual({
      type: 'secret',
      value: '••••••••',
      masked: true,
    })
    expect(result.snapshot.local.API_KEY).toEqual({ value: '••••••••', masked: true })
    expect(result.resolution.ok).toBe(true)
    if (!result.resolution.ok) throw new Error('expected matrix resolution to succeed')
    expect(result.resolution.values.API_KEY).toMatchObject({ value: '••••••••', masked: true })
    expect(result.resolution.values.AUTH_HEADER).toMatchObject({ value: '••••••••', masked: true })
    expect(JSON.stringify(result)).not.toContain('top-secret')
    expect(JSON.stringify(result)).not.toContain('local-secret')
  })

  it('writes a valid local override through the module interface', async () => {
    await writeFile(
      join(repoPath, 'vars', 'base.yaml'),
      ['name:', '  type: string', '  value: Base', ''].join('\n'),
    )

    await app.setOverride(repoPath, {
      layer: 'local',
      key: 'name',
      override: { value: 'Local' },
    })

    const localPath = join(home, '.loom', 'local', 'repos', 'default', 'vars', 'local.yaml')
    expect(await readFile(localPath, 'utf8')).toContain('value: Local')
  })

  it('lists environments and masks secrets in environment details', async () => {
    await app.createEnvironment(repoPath, 'dev')
    await app.setVariable(repoPath, {
      environment: 'dev',
      key: 'API_KEY',
      entry: { type: 'secret', value: 'top-secret' },
    })

    await expect(app.listEnvironments(repoPath)).resolves.toEqual({
      environments: ['dev'],
      diagnostics: [],
    })
    await expect(app.getEnvironment(repoPath, 'dev')).resolves.toMatchObject({
      name: 'dev',
      environment: {
        entries: {
          API_KEY: { type: 'secret', value: '••••••••', masked: true },
        },
      },
    })
  })

  it('mutates and resolves legacy variables without exposing secret values', async () => {
    await app.createEnvironment(repoPath, 'dev')
    await app.setVariable(repoPath, {
      environment: 'dev',
      key: 'API_KEY',
      entry: { type: 'secret', value: 'top-secret' },
    })
    await app.setVariable(repoPath, {
      environment: 'dev',
      key: 'HOST',
      entry: { type: 'string', value: 'localhost' },
    })
    await app.setVariable(repoPath, {
      environment: 'dev',
      key: 'URL',
      entry: { type: 'string', value: 'https://${HOST}' },
    })

    const renamed = await app.renameVariable(repoPath, {
      environment: 'dev',
      oldKey: 'HOST',
      newKey: 'DOMAIN',
    })
    expect(renamed.changed).toEqual(['dev'])

    const resolved = await app.resolve(repoPath, ['dev'])
    expect(resolved.values.API_KEY).toEqual({
      type: 'secret',
      value: '••••••••',
      masked: true,
    })
    expect(resolved.values.URL.value).toBe('https://localhost')
    expect(resolved.sources.DOMAIN).toBe('dev')
    expect(JSON.stringify(resolved)).not.toContain('top-secret')
  })

  it('validates drafts without writing and masks tainted results', async () => {
    await app.createEnvironment(repoPath, 'dev')
    await app.setVariable(repoPath, {
      environment: 'dev',
      key: 'API_KEY',
      entry: { type: 'secret', value: 'top-secret' },
    })

    const valid = await app.validateDraft(repoPath, {
      environment: 'dev',
      key: 'AUTH_HEADER',
      entry: { type: 'string', value: 'Bearer ${API_KEY}' },
      chain: ['dev'],
    })

    expect(valid.resolution.values.AUTH_HEADER).toEqual({
      type: 'string',
      value: '••••••••',
      masked: true,
    })
    expect(JSON.stringify(valid)).not.toContain('top-secret')
    await expect(app.revealVariable(repoPath, 'dev', 'AUTH_HEADER')).rejects.toMatchObject({
      status: 404,
      code: 'not_found',
    })
  })

  it('reveals only the explicitly requested variable', async () => {
    await app.createEnvironment(repoPath, 'dev')
    await app.setVariable(repoPath, {
      environment: 'dev',
      key: 'API_KEY',
      entry: { type: 'secret', value: 'top-secret' },
    })

    await expect(app.revealVariable(repoPath, 'dev', 'API_KEY')).resolves.toEqual({
      type: 'secret',
      value: 'top-secret',
    })
  })

  it('preserves delete impact diagnostics and rejects stale tokens', async () => {
    await app.createEnvironment(repoPath, 'dev')
    await app.setVariable(repoPath, {
      environment: 'dev',
      key: 'HOST',
      entry: { type: 'string', value: 'localhost' },
    })
    await app.setVariable(repoPath, {
      environment: 'dev',
      key: 'URL',
      entry: { type: 'string', value: 'https://${HOST}' },
    })

    const impact = await app.deleteImpact(repoPath, 'dev', 'HOST')
    expect(impact.direct).toEqual([{ environment: 'dev', key: 'URL' }])

    await expect(
      app.deleteVariable(repoPath, {
        environment: 'dev',
        key: 'HOST',
        confirmed: true,
        impactToken: 'stale',
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: 'impact_changed',
    })

    const deleted = await app.deleteVariable(repoPath, {
      environment: 'dev',
      key: 'HOST',
      confirmed: true,
      impactToken: impact.impactToken,
    })
    expect(deleted.changed).toEqual(['dev'])
  })
})
