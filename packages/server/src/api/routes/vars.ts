import { Hono, type Context, type MiddlewareHandler } from 'hono'
import { isAbsolute, join, normalize } from 'node:path'
import { z } from 'zod'
import {
  AgentIdSchema,
  VarDefinitionSchema,
  VarOverrideSchema,
  VAR_KEY,
  normalizeVarEntry,
  type VarEntry,
  type VarsDiagnostic,
} from '@loom/core'
import { logger } from '../../lib/logger.js'
import { VarsApplication, VarsApplicationError } from '../../vars/application.js'
import { type VarsLayerKind } from '../../vars/agent-aware.js'
import { readLocalConfig } from '../repo-config.js'
import { paramValidator, queryValidator } from '../request-validation.js'
import type { RouteDeps } from '../router.js'

const apiLogger = logger.child('vars-api')
const ENVIRONMENT = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/
const NonEmptyString = z.string().min(1)
const RepoPathSchema = z
  .string()
  .transform((value) => value.trim())
  .refine((value) => value.length > 0)
const EnvironmentNameSchema = NonEmptyString.regex(ENVIRONMENT).refine(
  (value) => !value.includes('..'),
)
const VarKeySchema = NonEmptyString.regex(VAR_KEY)
const VarEntryRequestSchema = z.unknown().transform((value, ctx): VarEntry => {
  const entry = normalizeVarEntry(value)
  if (entry) return entry
  ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'entry 无效' })
  return z.NEVER
})

const VarsRepoQuery = z.object({ repoPath: RepoPathSchema })
const VarsAgentQuery = VarsRepoQuery.extend({
  agent: z.union([z.literal('default'), AgentIdSchema]),
})
const VarsEnvironmentParams = z.object({ environment: EnvironmentNameSchema })
const VarsRepoBody = z.object({ repoPath: RepoPathSchema })
const VarsKeyBody = VarsRepoBody.extend({ key: VarKeySchema })
const SetBaseKeyBody = VarsKeyBody.extend({ definition: VarDefinitionSchema })
const RenameBaseKeyBody = VarsRepoBody.extend({
  oldKey: VarKeySchema,
  newKey: VarKeySchema,
})
const SetOverrideBody = VarsKeyBody.extend({
  layer: z.enum(['base-agent', 'local', 'local-agent']),
  agent: AgentIdSchema.optional(),
  override: VarOverrideSchema,
}).superRefine(requireAgentForAgentLayer)
const ClearOverrideBody = VarsKeyBody.extend({
  layer: z.enum(['base-agent', 'local', 'local-agent']),
  agent: AgentIdSchema.optional(),
}).superRefine(requireAgentForAgentLayer)
const EnvironmentBody = VarsRepoBody.extend({ environment: EnvironmentNameSchema })
const SetVariableBody = EnvironmentBody.extend({
  key: VarKeySchema,
  entry: VarEntryRequestSchema,
})
const RenameVariableBody = EnvironmentBody.extend({
  oldKey: VarKeySchema,
  newKey: VarKeySchema,
})
const DeleteImpactBody = EnvironmentBody.extend({ key: VarKeySchema })
const DeleteVariableBody = DeleteImpactBody.extend({
  confirmed: z.boolean().optional(),
  impactToken: z.string().optional(),
})
const ChainBody = VarsRepoBody.extend({
  chain: z.array(EnvironmentNameSchema).min(1),
})
const ValidateVariableBody = EnvironmentBody.extend({
  key: VarKeySchema,
  entry: VarEntryRequestSchema,
  chain: z.array(EnvironmentNameSchema).min(1),
})
const RevealVariableBody = DeleteImpactBody
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

function requireAgentForAgentLayer(
  value: { layer: Exclude<VarsLayerKind, 'base'>; agent?: unknown },
  ctx: z.RefinementCtx,
): void {
  if (value.layer === 'local') return
  if (value.agent !== undefined) return
  ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['agent'], message: 'agent 无效' })
}

const varsValidationOptions = {
  error: 'invalid_request',
  body: (error: string, issues: z.ZodIssue[]) => ({
    ok: false,
    error: { code: error, message: varsValidationMessage(issues) },
  }),
}

function varsQueryValidator<T extends z.ZodTypeAny>(schema: T) {
  return queryValidator(schema, varsValidationOptions)
}

function varsParamValidator<T extends z.ZodTypeAny>(schema: T) {
  return paramValidator(schema, varsValidationOptions)
}

function varsJsonValidator<T extends z.ZodTypeAny>(schema: T): MiddlewareHandler {
  return async (c, next) => {
    let value: unknown
    try {
      value = await c.req.json()
    } catch {
      return errorResponse(c, new ApiError(400, 'invalid_json', 'JSON 请求体无效'), 'json-parse')
    }
    const result = await schema.safeParseAsync(value)
    if (!result.success) {
      return errorResponse(
        c,
        new ApiError(400, 'invalid_request', varsValidationMessage(result.error.issues)),
        'json-validation',
      )
    }
    c.req.addValidatedData('json', result.data)
    return next()
  }
}

function validJson<T extends z.ZodTypeAny>(c: Context, schema: T): z.infer<T> {
  void schema
  return (c.req as unknown as { valid: (target: 'json') => z.infer<T> }).valid('json')
}

function varsValidationMessage(issues: z.ZodIssue[]): string {
  const field = issues[0]?.path[0]
  if (typeof field !== 'string') return '请求体必须是对象'
  if (field === 'repoPath') return 'repoPath 无效'
  if (field === 'environment') return 'environment 无效'
  if (field === 'key') return 'key 无效'
  if (field === 'oldKey') return 'oldKey 无效'
  if (field === 'newKey') return 'newKey 无效'
  if (field === 'definition') return 'definition 无效'
  if (field === 'override') return 'override 无效'
  if (field === 'agent') return 'agent 无效'
  if (field === 'layer') return 'layer 无效'
  if (field === 'chain') return 'chain 无效'
  if (field === 'entry') return 'entry 无效'
  if (field === 'confirmed') return 'confirmed 无效'
  if (field === 'impactToken') return 'impactToken 无效'
  return '请求无效'
}

function errorResponse(c: Context, error: unknown, operation: string, repoPath?: string) {
  if (error instanceof ApiError || error instanceof VarsApplicationError) {
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

async function withRepoAccess<T>(
  deps: RouteDeps,
  repoPath: string,
  _mode: 'read' | 'write',
  action: (authorizedRepoPath: string) => Promise<T>,
): Promise<T> {
  const authorizedRepoPath = await resolveAuthorizedRepo(deps, repoPath)
  return action(authorizedRepoPath)
}

export function createVarsRoutes(deps: RouteDeps): Hono {
  const app = new Hono()
  const varsApp = new VarsApplication(deps.fs, deps.home)

  app.get('/vars/preview', varsQueryValidator(VarsAgentQuery), (c) =>
    run(
      c,
      'agent-aware-preview',
      async () => {
        const { repoPath, agent } = c.req.valid('query')
        return withRepoAccess(deps, repoPath, 'read', async (authorizedRepoPath) =>
          c.json(await varsApp.preview(authorizedRepoPath, agent)),
        )
      },
      c.req.valid('query').repoPath,
    ),
  )
  app.get('/vars/matrix', varsQueryValidator(VarsAgentQuery), (c) =>
    run(
      c,
      'agent-aware-matrix',
      async () => {
        const { repoPath, agent } = c.req.valid('query')
        return withRepoAccess(deps, repoPath, 'read', async (authorizedRepoPath) =>
          c.json(await varsApp.matrix(authorizedRepoPath, agent)),
        )
      },
      c.req.valid('query').repoPath,
    ),
  )

  app.put('/vars/base-key', varsJsonValidator(SetBaseKeyBody), async (c) => {
    const request = validJson(c, SetBaseKeyBody)
    return run(
      c,
      'set-base-key',
      async () => {
        const { repoPath, key, definition } = request
        return withRepoAccess(deps, repoPath, 'write', async (authorizedRepoPath) => {
          await varsApp.setBaseKey(authorizedRepoPath, key, definition)
          return c.json({ ok: true })
        })
      },
      request.repoPath,
    )
  })

  app.delete('/vars/base-key', varsJsonValidator(VarsKeyBody), async (c) => {
    const request = validJson(c, VarsKeyBody)
    return run(
      c,
      'delete-base-key',
      async () => {
        const { repoPath, key } = request
        return withRepoAccess(deps, repoPath, 'write', async (authorizedRepoPath) => {
          await varsApp.deleteBaseKey(authorizedRepoPath, key)
          return c.json({ ok: true })
        })
      },
      request.repoPath,
    )
  })

  app.post('/vars/base-key/rename', varsJsonValidator(RenameBaseKeyBody), async (c) => {
    const request = validJson(c, RenameBaseKeyBody)
    return run(
      c,
      'rename-base-key',
      async () => {
        const { repoPath, oldKey, newKey } = request
        return withRepoAccess(deps, repoPath, 'write', async (authorizedRepoPath) => {
          await varsApp.renameBaseKey(authorizedRepoPath, oldKey, newKey)
          return c.json({ ok: true })
        })
      },
      request.repoPath,
    )
  })

  app.put('/vars/override', varsJsonValidator(SetOverrideBody), async (c) => {
    const request = validJson(c, SetOverrideBody)
    return run(
      c,
      'set-override',
      async () => {
        const { repoPath, key, layer, override } = request
        return withRepoAccess(deps, repoPath, 'write', async (authorizedRepoPath) => {
          await varsApp.setOverride(
            authorizedRepoPath,
            layer === 'local'
              ? { layer, key, override }
              : { layer, agent: request.agent!, key, override },
          )
          return c.json({ ok: true })
        })
      },
      request.repoPath,
    )
  })

  app.delete('/vars/override', varsJsonValidator(ClearOverrideBody), async (c) => {
    const request = validJson(c, ClearOverrideBody)
    return run(
      c,
      'clear-override',
      async () => {
        const { repoPath, key, layer } = request
        return withRepoAccess(deps, repoPath, 'write', async (authorizedRepoPath) => {
          await varsApp.clearOverride(
            authorizedRepoPath,
            layer === 'local' ? { layer, key } : { layer, agent: request.agent!, key },
          )
          return c.json({ ok: true })
        })
      },
      request.repoPath,
    )
  })
  app.get('/vars/environments', varsQueryValidator(VarsRepoQuery), (c) =>
    run(
      c,
      'list-environments',
      async () => {
        const { repoPath } = c.req.valid('query')
        return withRepoAccess(deps, repoPath, 'read', async (authorizedRepoPath) =>
          c.json({ ok: true, ...(await varsApp.listEnvironments(authorizedRepoPath)) }),
        )
      },
      c.req.valid('query').repoPath,
    ),
  )

  app.get(
    '/vars/environments/:environment',
    varsQueryValidator(VarsRepoQuery),
    varsParamValidator(VarsEnvironmentParams),
    (c) =>
      run(
        c,
        'get-environment',
        async () => {
          const { repoPath } = c.req.valid('query')
          const { environment } = c.req.valid('param')
          return withRepoAccess(deps, repoPath, 'read', async (authorizedRepoPath) =>
            c.json({
              ok: true,
              ...(await varsApp.getEnvironment(authorizedRepoPath, environment)),
            }),
          )
        },
        c.req.valid('query').repoPath,
      ),
  )

  app.post('/vars/environments', varsJsonValidator(EnvironmentBody), async (c) => {
    const request = validJson(c, EnvironmentBody)
    return run(
      c,
      'create-environment',
      async () => {
        const { repoPath, environment } = request
        await withRepoAccess(deps, repoPath, 'write', (authorizedRepoPath) =>
          varsApp.createEnvironment(authorizedRepoPath, environment),
        )
        return c.json({ ok: true, environment }, 201)
      },
      request.repoPath,
    )
  })

  app.delete('/vars/environments', varsJsonValidator(EnvironmentBody), async (c) => {
    const request = validJson(c, EnvironmentBody)
    return run(
      c,
      'delete-environment',
      async () => {
        const { repoPath, environment } = request
        await withRepoAccess(deps, repoPath, 'write', (authorizedRepoPath) =>
          varsApp.deleteEnvironment(authorizedRepoPath, environment),
        )
        return c.json({ ok: true })
      },
      request.repoPath,
    )
  })

  app.put('/vars/variables', varsJsonValidator(SetVariableBody), async (c) => {
    const request = validJson(c, SetVariableBody)
    return run(
      c,
      'set-variable',
      async () => {
        const { repoPath, environment, key, entry } = request
        const result = await withRepoAccess(deps, repoPath, 'write', (authorizedRepoPath) =>
          varsApp.setVariable(authorizedRepoPath, {
            environment,
            key,
            entry,
          }),
        )
        return c.json({ ok: true, changed: result.changed, diagnostics: result.diagnostics })
      },
      request.repoPath,
    )
  })

  app.post('/vars/variables/rename', varsJsonValidator(RenameVariableBody), async (c) => {
    const request = validJson(c, RenameVariableBody)
    return run(
      c,
      'rename-variable',
      async () => {
        const { repoPath, environment, oldKey, newKey } = request
        const result = await withRepoAccess(deps, repoPath, 'write', (authorizedRepoPath) =>
          varsApp.renameVariable(authorizedRepoPath, {
            environment,
            oldKey,
            newKey,
          }),
        )
        return c.json({ ok: true, changed: result.changed, diagnostics: result.diagnostics })
      },
      request.repoPath,
    )
  })

  app.post('/vars/variables/delete-impact', varsJsonValidator(DeleteImpactBody), async (c) => {
    const request = validJson(c, DeleteImpactBody)
    return run(
      c,
      'delete-impact',
      async () => {
        const { repoPath, environment, key } = request
        return withRepoAccess(deps, repoPath, 'read', async (authorizedRepoPath) => {
          return c.json({
            ok: true,
            impact: await varsApp.deleteImpact(authorizedRepoPath, environment, key),
          })
        })
      },
      request.repoPath,
    )
  })

  app.delete('/vars/variables', varsJsonValidator(DeleteVariableBody), async (c) => {
    const request = validJson(c, DeleteVariableBody)
    return run(
      c,
      'delete-variable',
      async () => {
        const { repoPath, environment, key } = request
        const confirmed = request.confirmed === true
        const result = await withRepoAccess(deps, repoPath, 'write', (authorizedRepoPath) =>
          varsApp.deleteVariable(authorizedRepoPath, {
            environment,
            key,
            confirmed,
            ...(request.impactToken !== undefined ? { impactToken: request.impactToken } : {}),
          }),
        )
        return c.json({ ok: true, changed: result.changed, diagnostics: result.diagnostics })
      },
      request.repoPath,
    )
  })

  app.post('/vars/resolve', varsJsonValidator(ChainBody), async (c) => {
    const request = validJson(c, ChainBody)
    return run(
      c,
      'resolve',
      async () => {
        const { repoPath, chain } = request
        return withRepoAccess(deps, repoPath, 'read', async (authorizedRepoPath) => {
          return c.json(await varsApp.resolve(authorizedRepoPath, chain))
        })
      },
      request.repoPath,
    )
  })

  app.post('/vars/validate', varsJsonValidator(ValidateVariableBody), async (c) => {
    const request = validJson(c, ValidateVariableBody)
    return run(
      c,
      'validate-variable',
      async () => {
        const { repoPath, environment, key, entry, chain } = request
        return withRepoAccess(deps, repoPath, 'read', async (authorizedRepoPath) => {
          return c.json({
            ok: true,
            ...(await varsApp.validateDraft(authorizedRepoPath, {
              environment,
              key,
              entry,
              chain,
            })),
          })
        })
      },
      request.repoPath,
    )
  })

  app.post('/vars/variables/reveal', varsJsonValidator(RevealVariableBody), async (c) => {
    const request = validJson(c, RevealVariableBody)
    return run(
      c,
      'reveal-variable',
      async () => {
        const { repoPath, environment, key } = request
        return withRepoAccess(deps, repoPath, 'read', async (authorizedRepoPath) => {
          return c.json({
            ok: true,
            entry: await varsApp.revealVariable(authorizedRepoPath, environment, key),
          })
        })
      },
      request.repoPath,
    )
  })

  return app
}
