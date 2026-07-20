import { Hono, type Context } from 'hono'
import { z } from 'zod'
import { applyMcpImports, scanMcpImports } from '../../mcp/importer.js'
import { logger } from '../../lib/logger.js'
import type { RouteDeps } from '../router.js'
import { AgentIdSchema, applicableAgents, mergeConfig, type AgentId, type Config } from '@loom/core'
import { readLocalConfig, readRepoConfig, RepoConfigError } from '../repo-config.js'
import { runtimeAgentPathContext } from '../../adapters/paths.js'
import { repositoryErrorResponse } from '../repository-route-error.js'
import { homeResourceKey, mcpImportResourceKeys } from '../../concurrency/resource-keys.js'
import { withRepositoryLease } from '../repository-lease.js'
import { resourceLeases } from '../../concurrency/resource-lease-coordinator.js'

const apiLogger = logger.child('api.mcp-import')
const NonEmptyString = z.string().min(1)
const ImportScanBody = z.object({
  repo: NonEmptyString,
  sources: z.array(AgentIdSchema).optional(),
})
const ImportApplyBody = ImportScanBody.extend({
  keys: z.array(NonEmptyString),
})
type ImportAction = 'scan' | 'apply'
type ImportValidationError = 'invalid_repo' | 'invalid_sources' | 'invalid_keys'

export function createMcpImportRoutes(deps: RouteDeps): Hono {
  const app = new Hono()
  const leases = resourceLeases(deps, deps.leases)
  const importLogger = {
    error: (obj: unknown, msg: string) => apiLogger.error(msg, obj as Record<string, unknown>),
    warn: (obj: unknown, msg: string) => apiLogger.warn(msg, obj as Record<string, unknown>),
  }

  app.post('/mcp/import/scan', async (c) => {
    try {
      const { repo, sources } = await readImportBody(c, ImportScanBody, 'scan')
      const home = await homeResourceKey(deps.fs, deps.home)
      const scopedDeps = { ...deps, home, leases }
      return c.json(
        await withRepositoryLease(
          scopedDeps,
          repo,
          'read',
          (repoPath) => mcpImportResourceKeys(home, repoPath, home),
          async (repoPath) => {
            const resolvedSources = await resolveImportSources(
              scopedDeps,
              repoPath,
              sources,
              'scan',
            )
            return scanMcpImports({
              fs: deps.fs,
              repoPath,
              sources: resolvedSources,
              pathContext: runtimeAgentPathContext(home),
              logger: importLogger,
            })
          },
        ),
      )
    } catch (err) {
      return mcpImportErrorResponse(c, err, {
        code: 'scan_failed',
        message: 'Failed to scan MCP imports',
        logMessage: 'MCP import scan failed',
      })
    }
  })

  app.post('/mcp/import/apply', async (c) => {
    try {
      const { repo, sources, keys } = await readImportBody(c, ImportApplyBody, 'apply')
      const home = await homeResourceKey(deps.fs, deps.home)
      const scopedDeps = { ...deps, home, leases }
      const result = await withRepositoryLease(
        scopedDeps,
        repo,
        'mutation',
        (repoPath) => mcpImportResourceKeys(home, repoPath, home),
        async (repoPath) => {
          const resolvedSources = await resolveImportSources(scopedDeps, repoPath, sources, 'apply')
          return applyMcpImports({
            fs: deps.fs,
            repoPath,
            sources: resolvedSources,
            keys,
            pathContext: runtimeAgentPathContext(home),
            logger: importLogger,
          })
        },
      )
      if (!result.ok) {
        return mcpImportErrorResponse(
          c,
          new ImportRouteError(
            409,
            result.error,
            '导入预览已过期，请重新扫描',
            'stale MCP import preview',
          ),
          {
            code: 'apply_failed',
            message: 'Failed to apply MCP imports',
            logMessage: 'MCP import apply failed',
          },
        )
      }
      return c.json(result)
    } catch (err) {
      return mcpImportErrorResponse(c, err, {
        code: 'apply_failed',
        message: 'Failed to apply MCP imports',
        logMessage: 'MCP import apply failed',
      })
    }
  })

  return app
}

async function resolveImportSources(
  deps: RouteDeps,
  repoPath: string,
  sources: AgentId[] | undefined,
  action: ImportAction,
): Promise<AgentId[]> {
  if (sources !== undefined) return applicableAgents(sources, 'mcp')

  let repoConfig: Config
  try {
    repoConfig = await readRepoConfig(deps.fs, repoPath)
  } catch (err) {
    if (!(err instanceof RepoConfigError)) throw err
    throw new ImportRouteError(
      422,
      'invalid_config',
      err.message,
      'invalid repository config for MCP import ' + action,
      { repoPath },
      err,
    )
  }

  let local: Record<string, unknown>
  try {
    local = await readLocalConfig(deps.fs, deps.home)
  } catch (err) {
    if (!(err instanceof RepoConfigError)) throw err
    throw new ImportRouteError(
      422,
      'invalid_config',
      err.message,
      'invalid local config for MCP import ' + action,
      { repoPath },
      err,
    )
  }
  return applicableAgents(mergeConfig(repoConfig, local).agents, 'mcp')
}

function parseImportBody<T extends z.ZodTypeAny>(
  value: unknown,
  schema: T,
  action: ImportAction,
): z.infer<T> {
  const result = schema.safeParse(value)
  if (result.success) return result.data
  const error = importValidationError(result.error.issues)
  throw new ImportRouteError(
    400,
    error,
    importValidationMessage(error),
    importValidationLogMessage(error, action),
    importValidationContext(value, error),
    result.error,
  )
}

async function readImportBody<T extends z.ZodTypeAny>(
  c: Context,
  schema: T,
  action: ImportAction,
): Promise<z.infer<T>> {
  let value: unknown
  try {
    value = await c.req.json()
  } catch (err) {
    throw new ImportRouteError(
      400,
      'invalid_request',
      'MCP import request is invalid',
      'invalid MCP import JSON for ' + action,
      undefined,
      err,
    )
  }
  return parseImportBody(value, schema, action)
}

function importValidationError(issues: z.ZodIssue[]): ImportValidationError {
  const field = issues[0]?.path[0]
  if (field === 'sources') return 'invalid_sources'
  if (field === 'keys') return 'invalid_keys'
  return 'invalid_repo'
}

function importValidationMessage(error: ImportValidationError): string {
  if (error === 'invalid_sources') return 'sources 无效'
  if (error === 'invalid_keys') return 'keys 无效'
  return 'repo 无效'
}

function importValidationLogMessage(error: ImportValidationError, action: ImportAction): string {
  if (error === 'invalid_sources') return 'invalid MCP import sources'
  if (error === 'invalid_keys') return 'invalid MCP import keys'
  return 'invalid repository input for MCP import ' + action
}

function importValidationContext(
  value: unknown,
  error: ImportValidationError,
): Record<string, unknown> {
  const body = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  if (error === 'invalid_sources') return { sources: (body as { sources?: unknown }).sources }
  if (error === 'invalid_keys') return { keys: (body as { keys?: unknown }).keys }
  return { repo: (body as { repo?: unknown }).repo }
}

class ImportRouteError extends Error {
  constructor(
    readonly status: 400 | 409 | 422,
    readonly code: string,
    message: string,
    readonly logMessage: string,
    readonly context?: Record<string, unknown>,
    cause?: unknown,
  ) {
    super(message, { cause })
  }
}

function mcpImportErrorResponse(
  c: Context,
  error: unknown,
  options: { code: string; message: string; logMessage: string },
): Response {
  const repoFailure = repositoryErrorResponse(c, error, apiLogger, options.logMessage)
  if (repoFailure) return repoFailure

  if (error instanceof ImportRouteError) {
    apiLogger.error(error.logMessage, { err: error, ...(error.context ?? {}) })
    const message =
      error.status === 400
        ? 'Invalid MCP import request'
        : error.status === 409
          ? '导入预览已过期，请重新扫描'
          : 'MCP import configuration is invalid'
    return c.json({ ok: false, error: error.code, message }, error.status)
  }

  apiLogger.error(options.logMessage, { err: error })
  return c.json({ ok: false, error: options.code, message: options.message }, 500)
}
