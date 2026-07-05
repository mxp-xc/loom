import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NodeFileSystem } from '../../src/platform/node/fs.js'
import { VarsStore } from '../../src/vars/store.js'
import {
  createVarsRoutes,
  varsAccessLockCountForTest,
  varsAccessPendingWritersForTest,
} from '../../src/api/routes/vars.js'
import { registerRoutes } from '../../src/api/router.js'

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
    await symlink(root, alias, 'dir')
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
        if (!removeAliasInstead) await symlink(unauthorized, alias, 'dir')
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
      await symlink(root, alias, 'dir')
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

  it('serializes concurrent mutations for the same repository', async () => {
    const request = (key: string) =>
      app.request('/vars/variables', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          repoPath: root,
          environment: 'dev',
          key,
          entry: { type: 'string', value: key },
        }),
      })
    const [left, right] = await Promise.all([request('LEFT'), request('RIGHT')])
    expect([left.status, right.status]).toEqual([200, 200])
    const entries = (await store.read('dev')).entries
    expect(entries.LEFT).toEqual({ type: 'string', value: 'LEFT' })
    expect(entries.RIGHT).toEqual({ type: 'string', value: 'RIGHT' })
  })

  it('serializes mutations across canonical repository aliases and releases the lock after failure', async () => {
    const alias = `${root}-alias`
    await symlink(root, alias, 'dir')
    let activeReplacements = 0
    let maximumReplacements = 0
    let failNextReplacement = false
    const fs = new NodeFileSystem()
    const trackedFs = Object.create(fs) as NodeFileSystem
    trackedFs.replaceFile = async (tempPath: string, targetPath: string) => {
      activeReplacements += 1
      maximumReplacements = Math.max(maximumReplacements, activeReplacements)
      try {
        await new Promise((resolve) => setTimeout(resolve, 20))
        if (failNextReplacement) {
          failNextReplacement = false
          throw new Error('injected replacement failure')
        }
        await fs.replaceFile(tempPath, targetPath)
      } finally {
        activeReplacements -= 1
      }
    }
    const aliasApp = createVarsRoutes({
      fs: trackedFs,
      git: {} as never,
      proc: {} as never,
      home,
    })
    const request = (repoPath: string, key: string) =>
      aliasApp.request('/vars/variables', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          repoPath,
          environment: 'dev',
          key,
          entry: { type: 'string', value: key },
        }),
      })

    try {
      const responses = await Promise.all([
        request(root, 'CANONICAL'),
        request(`${root}/.`, 'DOT_ALIAS'),
        request(alias, 'SYMLINK_ALIAS'),
      ])
      expect(responses.map((response) => response.status)).toEqual([200, 200, 200])
      expect(maximumReplacements).toBe(1)
      expect((await store.read('dev')).entries).toMatchObject({
        CANONICAL: { type: 'string', value: 'CANONICAL' },
        DOT_ALIAS: { type: 'string', value: 'DOT_ALIAS' },
        SYMLINK_ALIAS: { type: 'string', value: 'SYMLINK_ALIAS' },
      })

      failNextReplacement = true
      expect((await request(alias, 'FAILS')).status).toBe(500)
      expect((await request(root, 'AFTER_FAILURE')).status).toBe(200)
      expect((await store.read('dev')).entries.AFTER_FAILURE).toEqual({
        type: 'string',
        value: 'AFTER_FAILURE',
      })
    } finally {
      await rm(alias, { force: true })
    }
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
    expect(failedBody.error).toEqual({ code: 'io_error', message: '变量存储操作失败' })
    expect(JSON.stringify(failedBody)).not.toContain(root)

    const missing = await app.request('/vars/environments?repoPath=/definitely/missing/repository')
    expect(missing.status).toBe(500)
    expect(await missing.json()).toEqual({
      ok: false,
      error: { code: 'io_error', message: '变量存储操作失败' },
    })
  })

  it('does not expose malformed YAML secrets through error logs', async () => {
    const secret = 'top-secret-yaml-log-payload'
    await writeFile(join(root, 'vars', 'dev.yaml'), `API_KEY: [${secret}`)
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      const response = await app.request(
        `/vars/environments/dev?repoPath=${encodeURIComponent(root)}`,
      )
      expect(response.status).toBe(500)
      expect(write.mock.calls.map(([value]) => String(value)).join('')).not.toContain(secret)
    } finally {
      write.mockRestore()
    }
  })

  it('queues reads behind an atomic multi-environment rename', async () => {
    await store.create('prod', {
      format: 'typed',
      entries: { REF: { type: 'string', value: '${HOST}' } },
    })
    let releaseReplacement!: () => void
    const replacementGate = new Promise<void>((resolve) => {
      releaseReplacement = resolve
    })
    let signalStarted!: () => void
    const replacementStarted = new Promise<void>((resolve) => {
      signalStarted = resolve
    })
    let replacements = 0
    const fs = new NodeFileSystem()
    const delayedFs = Object.create(fs) as NodeFileSystem
    delayedFs.replaceFile = async (tempPath: string, targetPath: string) => {
      replacements += 1
      if (replacements === 1) {
        signalStarted()
        await replacementGate
      }
      await fs.replaceFile(tempPath, targetPath)
    }
    const transactionApp = createVarsRoutes({
      fs: delayedFs,
      git: {} as never,
      proc: {} as never,
      home,
    })
    const rename = transactionApp.request('/vars/variables/rename', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        repoPath: root,
        environment: 'dev',
        oldKey: 'HOST',
        newKey: 'DOMAIN',
      }),
    })
    await replacementStarted
    let readFinished = false
    const read = transactionApp
      .request('/vars/resolve', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ repoPath: root, chain: ['dev', 'prod'] }),
      })
      .then(async (response) => {
        readFinished = true
        return { response, body: (await response.json()) as any }
      })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(readFinished).toBe(false)
    releaseReplacement()
    expect((await rename).status).toBe(200)
    const resolved = await read
    expect(resolved.response.status).toBe(200)
    expect(resolved.body.values.REF.value).toBe('localhost')
    expect(resolved.body.dependencies.REF).toEqual(['DOMAIN'])
    expect(varsAccessLockCountForTest()).toBe(0)
  })

  it('allows parallel readers and queues a pending writer ahead of newer readers', async () => {
    let activeReaders = 0
    let maximumReaders = 0
    let releaseReaders!: () => void
    const readerGate = new Promise<void>((resolve) => {
      releaseReaders = resolve
    })
    let readersStarted = 0
    let signalReadersStarted!: () => void
    const bothReadersStarted = new Promise<void>((resolve) => {
      signalReadersStarted = resolve
    })
    let writerStarted = false
    let releaseWriter!: () => void
    const writerGate = new Promise<void>((resolve) => {
      releaseWriter = resolve
    })
    const fs = new NodeFileSystem()
    const controlledFs = Object.create(fs) as NodeFileSystem
    controlledFs.readFile = async (path: string) => {
      if (path.endsWith('/vars/dev.yaml') && !writerStarted) {
        activeReaders += 1
        maximumReaders = Math.max(maximumReaders, activeReaders)
        readersStarted += 1
        if (readersStarted === 2) signalReadersStarted()
        await readerGate
        activeReaders -= 1
      }
      return fs.readFile(path)
    }
    controlledFs.replaceFile = async (tempPath: string, targetPath: string) => {
      writerStarted = true
      await writerGate
      await fs.replaceFile(tempPath, targetPath)
    }
    const controlledApp = createVarsRoutes({
      fs: controlledFs,
      git: {} as never,
      proc: {} as never,
      home,
    })
    const detail = () =>
      controlledApp.request(`/vars/environments/dev?repoPath=${encodeURIComponent(root)}`)
    const firstReads = [detail(), detail()]
    await bothReadersStarted
    expect(maximumReaders).toBeGreaterThanOrEqual(2)

    let writeFinished = false
    const write = controlledApp
      .request('/vars/variables', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          repoPath: root,
          environment: 'dev',
          key: 'FAIR_WRITE',
          entry: { type: 'string', value: 'written' },
        }),
      })
      .then((response) => {
        writeFinished = true
        return response
      })
    while (varsAccessPendingWritersForTest() === 0)
      await new Promise((resolve) => setTimeout(resolve, 1))
    let newerReadFinished = false
    const newerRead = detail().then((response) => {
      newerReadFinished = true
      return response
    })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(writeFinished).toBe(false)
    expect(newerReadFinished).toBe(false)
    releaseReaders()
    await Promise.all(firstReads)
    while (!writerStarted) await new Promise((resolve) => setTimeout(resolve, 1))
    expect(newerReadFinished).toBe(false)
    releaseWriter()
    expect((await write).status).toBe(200)
    expect((await newerRead).status).toBe(200)
    expect(varsAccessLockCountForTest()).toBe(0)
  })

  it('fails closed when local config YAML is malformed and never logs its secret', async () => {
    const secret = 'top-secret-local-config-payload'
    await writeFile(join(home, '.loom', 'config.yaml'), `active_repo: [${secret}`)
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      const response = await app.request(`/vars/environments?repoPath=${encodeURIComponent(root)}`)
      expect(response.status).toBe(500)
      expect(await response.json()).toEqual({
        ok: false,
        error: { code: 'io_error', message: '变量存储操作失败' },
      })
      expect(write.mock.calls.map(([value]) => String(value)).join('')).not.toContain(secret)
    } finally {
      write.mockRestore()
    }
  })

  it('registers vars routes under the /api router', async () => {
    const fs = new NodeFileSystem()
    const router = new (await import('hono')).Hono().route(
      '/api',
      registerRoutes({ fs, git: {} as never, proc: {} as never, home }),
    )
    const response = await router.request(
      `/api/vars/environments?repoPath=${encodeURIComponent(root)}`,
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, environments: ['dev'], diagnostics: [] })
  })
})
