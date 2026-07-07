import { Hono, type Context } from 'hono'
import { isAbsolute, join, normalize } from 'node:path'
import {
  AgentIdSchema,
  VarDefinitionSchema,
  VarOverrideSchema,
  VAR_KEY,
  deleteVariable,
  danglingDiagnostics,
  inspectVariableDelete,
  normalizeVarEntry,
  prepareVarsMutationPersistence,
  renameVariable,
  resolveVarsLifecycle,
  setVariable,
  type VarEntry,
  type VarsLifecycleResolution,
  type VarsDiagnostic,
  type VarsEnvironment,
  type VarsMutationResult,
  validateVarDraft,
} from '@loom/core'
import { logger } from '../../lib/logger.js'
import { VarsStore } from '../../vars/store.js'
import {
  builtinForAgent,
  deleteAgentAwareBaseKey,
  readAgentAwareVars,
  readAgentAwareVarsWithDiagnostics,
  renameAgentAwareBaseKey,
  resolveAgentAwareVars,
  validateAgentAwareBaseDefinitions,
  writeAgentAwareBase,
  writeAgentAwareOverride,
  type VarsLayerKind,
} from '../../vars/agent-aware.js'
import { readLocalConfig } from '../repo-config.js'
import type { RouteDeps } from '../router.js'

const apiLogger = logger.child('vars-api')
const MASK = '••••••••'
const ENVIRONMENT = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/
type AccessMode = 'read' | 'write'
type AccessWaiter = { mode: AccessMode; grant: (release: () => void) => void }
type AccessState = { readers: number; writer: boolean; queue: AccessWaiter[] }
const repoAccessLocks = new Map<string, AccessState>()

class ApiError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409 | 422 | 500,
    readonly code: string,
    message: string,
    readonly diagnostics?: VarsDiagnostic[],
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
  }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ApiError(400, 'invalid_request', '请求体必须是对象')
  return value as Record<string, unknown>
}

function textField(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0)
    throw new ApiError(400, 'invalid_request', `${name} 无效`)
  return value
}

function repoField(value: unknown): string {
  return (
    textField(value, 'repoPath').trim() ||
    (() => {
      throw new ApiError(400, 'invalid_request', 'repoPath 无效')
    })()
  )
}

function environmentField(value: unknown): string {
  const environment = textField(value, 'environment')
  if (!ENVIRONMENT.test(environment) || environment.includes('..'))
    throw new ApiError(400, 'invalid_request', 'environment 无效')
  return environment
}

function keyField(value: unknown, name = 'key'): string {
  const key = textField(value, name)
  if (!VAR_KEY.test(key)) throw new ApiError(400, 'invalid_request', `${name} 无效`)
  return key
}

function entryField(value: unknown): VarEntry {
  const entry = normalizeVarEntry(value)
  if (entry) return entry
  throw new ApiError(400, 'invalid_request', 'entry 无效')
}

function definitionField(value: unknown) {
  const result = VarDefinitionSchema.safeParse(value)
  if (result.success) return result.data
  throw new ApiError(400, 'invalid_request', 'definition 无效')
}

function overrideField(value: unknown) {
  const result = VarOverrideSchema.safeParse(value)
  if (result.success) return result.data
  throw new ApiError(400, 'invalid_request', 'override 无效')
}

function agentField(value: unknown) {
  const result = AgentIdSchema.safeParse(value)
  if (result.success) return result.data
  throw new ApiError(400, 'invalid_request', 'agent 无效')
}

function overrideLayerField(value: unknown): Exclude<VarsLayerKind, 'base'> {
  if (value === 'base-agent' || value === 'local' || value === 'local-agent') return value
  throw new ApiError(400, 'invalid_request', 'layer 无效')
}

function assertOverrideMatchesDefinition(definition: VarEntry, override: { value: unknown }): void {
  const value = override.value
  const matches =
    definition.type === 'string' || definition.type === 'secret'
      ? typeof value === 'string'
      : definition.type === 'number'
        ? typeof value === 'number' && Number.isFinite(value)
        : definition.type === 'boolean'
          ? typeof value === 'boolean'
          : true
  if (!matches) throw new ApiError(422, 'override_type_mismatch', '覆盖值类型与 base 定义不匹配')
}

async function body(c: Context): Promise<Record<string, unknown>> {
  try {
    return object(await c.req.json())
  } catch (error) {
    if (error instanceof ApiError) throw error
    throw new ApiError(400, 'invalid_json', 'JSON 请求体无效')
  }
}

function maskEntry(entry: VarEntry): VarEntry | { type: 'secret'; value: string; masked: true } {
  return entry.type === 'secret' ? ({ type: 'secret', value: MASK, masked: true } as const) : entry
}

function maskEnvironment(environment: VarsEnvironment) {
  return {
    ...environment,
    entries: Object.fromEntries(
      Object.entries(environment.entries).map(([key, entry]) => [key, maskEntry(entry)]),
    ),
  }
}

function presentResolvedValues(
  values: Record<string, VarEntry>,
  secretTaintedKeys: string[],
): Record<string, VarEntry | { type: VarEntry['type']; value: string; masked: true }> {
  const tainted = new Set(secretTaintedKeys)
  return Object.fromEntries(
    Object.entries(values).map(([key, entry]) => [
      key,
      tainted.has(key) ? { ...entry, value: MASK, masked: true } : entry,
    ]),
  )
}

function presentResolution(resolution: Extract<VarsLifecycleResolution, { ok: true }>) {
  return {
    ok: true,
    values: presentResolvedValues(resolution.values, resolution.secretTaintedKeys),
    sources: resolution.sources,
    dependencies: resolution.dependencies,
    diagnostics: resolution.diagnostics,
  }
}

function errorResponse(c: Context, error: unknown, operation: string, repoPath?: string) {
  if (error instanceof ApiError) {
    return c.json(
      {
        ok: false,
        error: {
          code: error.code,
          message: error.message,
          ...(error.diagnostics ? { diagnostics: error.diagnostics } : {}),
          ...error.details,
        },
      },
      error.status,
    )
  }
  const code =
    typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
  if (code === 'environment_not_found')
    return c.json({ ok: false, error: { code, message: '环境不存在' } }, 404)
  if (code === 'EEXIST')
    return c.json(
      { ok: false, error: { code: 'environment_conflict', message: '环境已存在' } },
      409,
    )
  apiLogger.error('vars API operation failed', {
    err: error,
    operation,
    ...(repoPath ? { repoPath } : {}),
  })
  return c.json({ ok: false, error: { code: 'io_error', message: '变量存储操作失败' } }, 500)
}

async function run(
  c: Context,
  operation: string,
  action: () => Promise<Response>,
  repoPath?: string,
): Promise<Response> {
  try {
    return await action()
  } catch (error) {
    return errorResponse(c, error, operation, repoPath)
  }
}

function storeFor(deps: RouteDeps, repoPath: string): VarsStore {
  return new VarsStore(repoPath, deps.fs, {
    error: (context, message) => apiLogger.error(message, context),
  })
}

async function loadAll(store: VarsStore): Promise<Record<string, VarsEnvironment>> {
  const values: Record<string, VarsEnvironment> = Object.create(null)
  for (const environment of await store.list()) values[environment] = await store.read(environment)
  return values
}

async function resolveAuthorizedRepo(deps: RouteDeps, repoPath: string): Promise<string> {
  const localConfig = await readLocalConfig(deps.fs, deps.home)
  const activeRepo = localConfig.active_repo ?? 'default'
  if (typeof activeRepo !== 'string' || !ENVIRONMENT.test(activeRepo) || activeRepo.includes('..'))
    throw new Error('invalid active repository configuration')
  const requestedPath =
    !isAbsolute(repoPath) && ENVIRONMENT.test(repoPath) && !repoPath.includes('..')
      ? join(deps.home, '.loom', 'repos', repoPath)
      : repoPath
  const [allowed, requested] = await Promise.all([
    deps.fs.realPath(join(deps.home, '.loom', 'repos', activeRepo)),
    deps.fs.realPath(requestedPath),
  ])
  if (normalize(allowed) !== normalize(requested))
    throw new ApiError(403, 'repo_not_authorized', '仓库未授权')
  return normalize(requested)
}

function drainAccessQueue(lockKey: string, state: AccessState): void {
  if (state.writer || state.readers > 0) return
  const first = state.queue[0]
  if (!first) {
    if (repoAccessLocks.get(lockKey) === state) repoAccessLocks.delete(lockKey)
    return
  }
  if (first.mode === 'write') {
    state.queue.shift()
    state.writer = true
    first.grant(() => {
      state.writer = false
      drainAccessQueue(lockKey, state)
    })
    return
  }
  while (state.queue[0]?.mode === 'read') {
    const waiter = state.queue.shift()!
    state.readers += 1
    waiter.grant(() => {
      state.readers -= 1
      drainAccessQueue(lockKey, state)
    })
  }
}

function acquireRepoAccess(lockKey: string, mode: AccessMode): Promise<() => void> {
  const state = repoAccessLocks.get(lockKey) ?? { readers: 0, writer: false, queue: [] }
  repoAccessLocks.set(lockKey, state)
  if (mode === 'read' && !state.writer && state.queue.length === 0) {
    state.readers += 1
    return Promise.resolve(() => {
      state.readers -= 1
      drainAccessQueue(lockKey, state)
    })
  }
  if (mode === 'write' && !state.writer && state.readers === 0 && state.queue.length === 0) {
    state.writer = true
    return Promise.resolve(() => {
      state.writer = false
      drainAccessQueue(lockKey, state)
    })
  }
  return new Promise((grant) => state.queue.push({ mode, grant }))
}

async function queued<T>(lockKey: string, mode: AccessMode, action: () => Promise<T>): Promise<T> {
  const release = await acquireRepoAccess(lockKey, mode)
  try {
    return await action()
  } finally {
    release()
  }
}

async function withRepoAccess<T>(
  deps: RouteDeps,
  repoPath: string,
  mode: AccessMode,
  action: (authorizedRepoPath: string) => Promise<T>,
): Promise<T> {
  const authorizedRepoPath = await resolveAuthorizedRepo(deps, repoPath)
  return queued(authorizedRepoPath, mode, () => action(authorizedRepoPath))
}

export function varsAccessLockCountForTest(): number {
  return repoAccessLocks.size
}

export function varsAccessPendingWritersForTest(): number {
  return [...repoAccessLocks.values()].reduce(
    (count, state) => count + state.queue.filter((waiter) => waiter.mode === 'write').length,
    0,
  )
}

type MutationFailure = Extract<ReturnType<typeof prepareVarsMutationPersistence>, { ok: false }>

function mutationError(failure: MutationFailure): ApiError {
  const diagnostic = failure.diagnostic
  const status =
    diagnostic.code === 'environment_not_found' || diagnostic.code === 'not_found'
      ? 404
      : diagnostic.code === 'variable_conflict' ||
          diagnostic.code === 'impact_changed' ||
          diagnostic.code === 'delete_confirmation_required'
        ? 409
        : 422
  return new ApiError(
    status,
    diagnostic.code,
    diagnostic.message,
    failure.diagnostics,
    failure.deleteImpact ? { deleteImpact: failure.deleteImpact } : undefined,
  )
}

async function persistMutation(store: VarsStore, result: VarsMutationResult): Promise<void> {
  const plan = prepareVarsMutationPersistence(result)
  if (!plan.ok) throw mutationError(plan)
  await store.writeMany(plan.environments)
}

export function createVarsRoutes(deps: RouteDeps): Hono {
  const app = new Hono()

  app.get('/vars/preview', (c) =>
    run(
      c,
      'agent-aware-preview',
      async () => {
        const repoPath = repoField(c.req.query('repoPath'))
        const agent = AgentIdSchema.safeParse(c.req.query('agent'))
        if (!agent.success) throw new ApiError(400, 'invalid_request', 'agent 无效')
        return withRepoAccess(deps, repoPath, 'read', async (authorizedRepoPath) => {
          const result = await resolveAgentAwareVars(
            deps.fs,
            deps.home,
            authorizedRepoPath,
            agent.data,
          )
          if (!result.ok)
            throw new ApiError(422, 'resolution_failed', '变量解析失败', result.diagnostics)
          return c.json({ ok: true, ...result })
        })
      },
      c.req.query('repoPath'),
    ),
  )
  app.get('/vars/matrix', (c) =>
    run(
      c,
      'agent-aware-matrix',
      async () => {
        const repoPath = repoField(c.req.query('repoPath'))
        const agent = agentField(c.req.query('agent'))
        return withRepoAccess(deps, repoPath, 'read', async (authorizedRepoPath) => {
          const [readResult, resolution] = await Promise.all([
            readAgentAwareVarsWithDiagnostics(deps.fs, deps.home, authorizedRepoPath, agent),
            resolveAgentAwareVars(deps.fs, deps.home, authorizedRepoPath, agent),
          ])
          const snapshot = readResult.snapshot
          const mergedDiagnostics = [
            ...readResult.diagnostics,
            ...(!resolution.ok ? resolution.diagnostics : []),
          ]
          const builtinKeys = Object.keys(
            resolution.ok
              ? Object.fromEntries(
                  Object.entries(resolution.values).filter(
                    ([key]) => resolution.sources[key]?.locality === 'builtin',
                  ),
                )
              : builtinForAgent(agent),
          ).sort()
          const userKeys = [
            ...new Set([
              ...Object.keys(snapshot.base),
              ...Object.keys(snapshot.baseAgent),
              ...Object.keys(snapshot.local),
              ...Object.keys(snapshot.localAgent),
            ]),
          ].sort()
          return c.json({
            ok: true,
            agent,
            builtinKeys,
            userKeys,
            snapshot,
            resolution: resolution.ok ? resolution : { ok: false, diagnostics: mergedDiagnostics },
          })
        })
      },
      c.req.query('repoPath'),
    ),
  )

  app.put('/vars/base-key', async (c) => {
    let request: Record<string, unknown>
    try {
      request = await body(c)
    } catch (error) {
      return errorResponse(c, error, 'set-base-key')
    }
    return run(
      c,
      'set-base-key',
      async () => {
        const repoPath = repoField(request.repoPath)
        const key = keyField(request.key)
        const definition = definitionField(request.definition)
        if (key.startsWith('LOOM_'))
          throw new ApiError(400, 'reserved_builtin_key', 'LOOM_ 前缀保留给 builtin')
        return withRepoAccess(deps, repoPath, 'write', async (authorizedRepoPath) => {
          const snapshot = await readAgentAwareVars(deps.fs, deps.home, authorizedRepoPath, 'codex')
          snapshot.base[key] = definition
          const diagnostics = await validateAgentAwareBaseDefinitions(
            deps.fs,
            deps.home,
            authorizedRepoPath,
            snapshot.base,
          )
          if (diagnostics.length > 0)
            throw new ApiError(422, 'validation_failed', '变量定义会导致覆盖层失效', diagnostics)
          await writeAgentAwareBase(deps.fs, authorizedRepoPath, snapshot.base)
          return c.json({ ok: true })
        })
      },
      typeof request.repoPath === 'string' ? request.repoPath : undefined,
    )
  })

  app.delete('/vars/base-key', async (c) => {
    let request: Record<string, unknown>
    try {
      request = await body(c)
    } catch (error) {
      return errorResponse(c, error, 'delete-base-key')
    }
    return run(
      c,
      'delete-base-key',
      async () => {
        const repoPath = repoField(request.repoPath)
        const key = keyField(request.key)
        return withRepoAccess(deps, repoPath, 'write', async (authorizedRepoPath) => {
          const result = await deleteAgentAwareBaseKey(deps.fs, deps.home, authorizedRepoPath, key)
          if (result.status === 'missing') throw new ApiError(404, 'not_found', '变量不存在')
          if (result.status === 'blocked')
            throw new ApiError(
              409,
              'delete_blocked_by_reference',
              '变量仍被引用',
              result.diagnostics,
            )
          return c.json({ ok: true })
        })
      },
      typeof request.repoPath === 'string' ? request.repoPath : undefined,
    )
  })

  app.post('/vars/base-key/rename', async (c) => {
    let request: Record<string, unknown>
    try {
      request = await body(c)
    } catch (error) {
      return errorResponse(c, error, 'rename-base-key')
    }
    return run(
      c,
      'rename-base-key',
      async () => {
        const repoPath = repoField(request.repoPath)
        const oldKey = keyField(request.oldKey, 'oldKey')
        const newKey = keyField(request.newKey, 'newKey')
        if (newKey.startsWith('LOOM_'))
          throw new ApiError(400, 'reserved_builtin_key', 'LOOM_ 前缀保留给 builtin')
        return withRepoAccess(deps, repoPath, 'write', async (authorizedRepoPath) => {
          const result = await renameAgentAwareBaseKey(
            deps.fs,
            deps.home,
            authorizedRepoPath,
            oldKey,
            newKey,
          )
          if (result.status === 'missing') throw new ApiError(404, 'not_found', '变量不存在')
          if (result.status === 'conflict')
            throw new ApiError(409, 'variable_conflict', '目标变量已存在')
          if (result.status === 'blocked')
            throw new ApiError(422, 'validation_failed', '变量覆盖层无效', result.diagnostics)
          return c.json({ ok: true })
        })
      },
      typeof request.repoPath === 'string' ? request.repoPath : undefined,
    )
  })

  app.put('/vars/override', async (c) => {
    let request: Record<string, unknown>
    try {
      request = await body(c)
    } catch (error) {
      return errorResponse(c, error, 'set-override')
    }
    return run(
      c,
      'set-override',
      async () => {
        const repoPath = repoField(request.repoPath)
        const key = keyField(request.key)
        const layer = overrideLayerField(request.layer)
        const agent =
          layer === 'base-agent' || layer === 'local-agent' ? agentField(request.agent) : undefined
        const override = overrideField(request.override)
        return withRepoAccess(deps, repoPath, 'write', async (authorizedRepoPath) => {
          const snapshot = await readAgentAwareVars(
            deps.fs,
            deps.home,
            authorizedRepoPath,
            agent ?? 'codex',
          )
          const definition = snapshot.base[key]
          if (!definition) throw new ApiError(404, 'not_found', '变量不存在')
          assertOverrideMatchesDefinition(definition, override)
          const target =
            layer === 'base-agent'
              ? snapshot.baseAgent
              : layer === 'local'
                ? snapshot.local
                : snapshot.localAgent
          target[key] = override
          await writeAgentAwareOverride(
            deps.fs,
            deps.home,
            authorizedRepoPath,
            layer,
            agent,
            target,
          )
          return c.json({ ok: true })
        })
      },
      typeof request.repoPath === 'string' ? request.repoPath : undefined,
    )
  })

  app.delete('/vars/override', async (c) => {
    let request: Record<string, unknown>
    try {
      request = await body(c)
    } catch (error) {
      return errorResponse(c, error, 'clear-override')
    }
    return run(
      c,
      'clear-override',
      async () => {
        const repoPath = repoField(request.repoPath)
        const key = keyField(request.key)
        const layer = overrideLayerField(request.layer)
        const agent =
          layer === 'base-agent' || layer === 'local-agent' ? agentField(request.agent) : undefined
        return withRepoAccess(deps, repoPath, 'write', async (authorizedRepoPath) => {
          const snapshot = await readAgentAwareVars(
            deps.fs,
            deps.home,
            authorizedRepoPath,
            agent ?? 'codex',
          )
          const target =
            layer === 'base-agent'
              ? snapshot.baseAgent
              : layer === 'local'
                ? snapshot.local
                : snapshot.localAgent
          delete target[key]
          await writeAgentAwareOverride(
            deps.fs,
            deps.home,
            authorizedRepoPath,
            layer,
            agent,
            target,
          )
          return c.json({ ok: true })
        })
      },
      typeof request.repoPath === 'string' ? request.repoPath : undefined,
    )
  })
  app.get('/vars/environments', (c) =>
    run(
      c,
      'list-environments',
      async () => {
        const repoPath = repoField(c.req.query('repoPath'))
        return withRepoAccess(deps, repoPath, 'read', async (authorizedRepoPath) => {
          const values = await loadAll(storeFor(deps, authorizedRepoPath))
          return c.json({
            ok: true,
            environments: Object.keys(values).sort(),
            diagnostics: danglingDiagnostics(values),
          })
        })
      },
      c.req.query('repoPath'),
    ),
  )

  app.get('/vars/environments/:environment', (c) =>
    run(
      c,
      'get-environment',
      async () => {
        const repoPath = repoField(c.req.query('repoPath'))
        const environment = environmentField(c.req.param('environment'))
        return withRepoAccess(deps, repoPath, 'read', async (authorizedRepoPath) =>
          c.json({
            ok: true,
            name: environment,
            environment: maskEnvironment(
              await storeFor(deps, authorizedRepoPath).read(environment),
            ),
          }),
        )
      },
      c.req.query('repoPath'),
    ),
  )

  app.post('/vars/environments', async (c) => {
    let request: Record<string, unknown>
    try {
      request = await body(c)
    } catch (error) {
      return errorResponse(c, error, 'create-environment')
    }
    const candidateRepo = typeof request.repoPath === 'string' ? request.repoPath : undefined
    return run(
      c,
      'create-environment',
      async () => {
        const repoPath = repoField(request.repoPath)
        const environment = environmentField(request.environment)
        await withRepoAccess(deps, repoPath, 'write', (authorizedRepoPath) =>
          storeFor(deps, authorizedRepoPath).create(environment, {
            format: 'typed',
            entries: {},
          }),
        )
        return c.json({ ok: true, environment }, 201)
      },
      candidateRepo,
    )
  })

  app.delete('/vars/environments', async (c) => {
    let request: Record<string, unknown>
    try {
      request = await body(c)
    } catch (error) {
      return errorResponse(c, error, 'delete-environment')
    }
    return run(
      c,
      'delete-environment',
      async () => {
        const repoPath = repoField(request.repoPath)
        const environment = environmentField(request.environment)
        await withRepoAccess(deps, repoPath, 'write', (authorizedRepoPath) =>
          storeFor(deps, authorizedRepoPath).delete(environment),
        )
        return c.json({ ok: true })
      },
      typeof request.repoPath === 'string' ? request.repoPath : undefined,
    )
  })

  app.put('/vars/variables', async (c) =>
    mutationRequest(c, deps, 'set-variable', (request, environments) =>
      setVariable(
        environments,
        environmentField(request.environment),
        keyField(request.key),
        entryField(request.entry),
      ),
    ),
  )

  app.post('/vars/variables/rename', async (c) =>
    mutationRequest(c, deps, 'rename-variable', (request, environments) =>
      renameVariable(
        environments,
        environmentField(request.environment),
        keyField(request.oldKey, 'oldKey'),
        keyField(request.newKey, 'newKey'),
      ),
    ),
  )

  app.post('/vars/variables/delete-impact', async (c) => {
    let request: Record<string, unknown>
    try {
      request = await body(c)
    } catch (error) {
      return errorResponse(c, error, 'delete-impact')
    }
    return run(
      c,
      'delete-impact',
      async () => {
        const repoPath = repoField(request.repoPath)
        const environment = environmentField(request.environment)
        const key = keyField(request.key)
        return withRepoAccess(deps, repoPath, 'read', async (authorizedRepoPath) => {
          const environments = await loadAll(storeFor(deps, authorizedRepoPath))
          if (!environments[environment])
            throw new ApiError(404, 'environment_not_found', '环境不存在')
          if (!Object.hasOwn(environments[environment].entries, key))
            throw new ApiError(404, 'not_found', '变量不存在')
          return c.json({
            ok: true,
            impact: inspectVariableDelete(environments, environment, key),
          })
        })
      },
      typeof request.repoPath === 'string' ? request.repoPath : undefined,
    )
  })

  app.delete('/vars/variables', async (c) =>
    mutationRequest(c, deps, 'delete-variable', (request, environments) => {
      const confirmed = request.confirmed === true
      if (request.confirmed !== undefined && typeof request.confirmed !== 'boolean')
        throw new ApiError(400, 'invalid_request', 'confirmed 无效')
      if (request.impactToken !== undefined && typeof request.impactToken !== 'string')
        throw new ApiError(400, 'invalid_request', 'impactToken 无效')
      return deleteVariable(
        environments,
        environmentField(request.environment),
        keyField(request.key),
        confirmed
          ? { confirmed: true, expectedImpactToken: request.impactToken as string | undefined }
          : { confirmed: false },
      )
    }),
  )

  app.post('/vars/resolve', async (c) => {
    let request: Record<string, unknown>
    try {
      request = await body(c)
    } catch (error) {
      return errorResponse(c, error, 'resolve')
    }
    return run(
      c,
      'resolve',
      async () => {
        const repoPath = repoField(request.repoPath)
        if (
          !Array.isArray(request.chain) ||
          request.chain.length === 0 ||
          request.chain.some((item) => {
            try {
              environmentField(item)
              return false
            } catch {
              return true
            }
          })
        ) {
          throw new ApiError(400, 'invalid_request', 'chain 无效')
        }
        return withRepoAccess(deps, repoPath, 'read', async (authorizedRepoPath) => {
          const result = resolveVarsLifecycle(
            await loadAll(storeFor(deps, authorizedRepoPath)),
            request.chain as string[],
          )
          if (!result.ok)
            throw new ApiError(422, 'resolution_failed', '变量解析失败', result.diagnostics)
          return c.json({
            ok: true,
            values: presentResolvedValues(result.values, result.secretTaintedKeys),
            sources: result.sources,
            dependencies: result.dependencies,
            diagnostics: result.diagnostics,
          })
        })
      },
      typeof request.repoPath === 'string' ? request.repoPath : undefined,
    )
  })

  app.post('/vars/validate', async (c) => {
    let request: Record<string, unknown>
    try {
      request = await body(c)
    } catch (error) {
      return errorResponse(c, error, 'validate-variable')
    }
    return run(
      c,
      'validate-variable',
      async () => {
        const repoPath = repoField(request.repoPath)
        const environment = environmentField(request.environment)
        const key = keyField(request.key)
        const entry = entryField(request.entry)
        if (
          !Array.isArray(request.chain) ||
          request.chain.length === 0 ||
          request.chain.some((item) => {
            try {
              environmentField(item)
              return false
            } catch {
              return true
            }
          })
        )
          throw new ApiError(400, 'invalid_request', 'chain 无效')
        return withRepoAccess(deps, repoPath, 'read', async (authorizedRepoPath) => {
          const environments = await loadAll(storeFor(deps, authorizedRepoPath))
          const result = validateVarDraft(environments, {
            environment,
            key,
            entry,
            chain: request.chain as string[],
          })
          if (!result.ok)
            throw new ApiError(422, 'validation_failed', '变量验证失败', result.diagnostics)
          return c.json({
            ok: true,
            resolution: presentResolution(result.resolution),
          })
        })
      },
      typeof request.repoPath === 'string' ? request.repoPath : undefined,
    )
  })

  app.post('/vars/variables/reveal', async (c) => {
    let request: Record<string, unknown>
    try {
      request = await body(c)
    } catch (error) {
      return errorResponse(c, error, 'reveal-variable')
    }
    return run(
      c,
      'reveal-variable',
      async () => {
        const repoPath = repoField(request.repoPath)
        const environment = environmentField(request.environment)
        const key = keyField(request.key)
        return withRepoAccess(deps, repoPath, 'read', async (authorizedRepoPath) => {
          const value = await storeFor(deps, authorizedRepoPath).read(environment)
          if (!Object.hasOwn(value.entries, key)) throw new ApiError(404, 'not_found', '变量不存在')
          return c.json({ ok: true, entry: value.entries[key] })
        })
      },
      typeof request.repoPath === 'string' ? request.repoPath : undefined,
    )
  })

  return app
}

async function mutationRequest(
  c: Context,
  deps: RouteDeps,
  operation: string,
  mutate: (
    request: Record<string, unknown>,
    environments: Record<string, VarsEnvironment>,
  ) => VarsMutationResult,
): Promise<Response> {
  let request: Record<string, unknown>
  try {
    request = await body(c)
  } catch (error) {
    return errorResponse(c, error, operation)
  }
  return run(
    c,
    operation,
    async () => {
      const repoPath = repoField(request.repoPath)
      const result = await withRepoAccess(deps, repoPath, 'write', async (authorizedRepoPath) => {
        const store = storeFor(deps, authorizedRepoPath)
        const mutation = mutate(request, await loadAll(store))
        await persistMutation(store, mutation)
        return mutation
      })
      return c.json({ ok: true, changed: result.changed, diagnostics: result.diagnostics })
    },
    typeof request.repoPath === 'string' ? request.repoPath : undefined,
  )
}
