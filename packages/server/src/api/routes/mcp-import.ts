import { Hono } from 'hono'
import { z } from 'zod'
import { applyMcpImports, scanMcpImports } from '../../mcp/importer.js'
import { logger } from '../../lib/logger.js'
import { resolveRepoPath } from '../repo.js'
import type { RouteDeps } from '../router.js'
import { AgentIdSchema } from '@loom/core'

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
  const importLogger = {
    error: (obj: unknown, msg: string) => apiLogger.error(msg, obj as Record<string, unknown>),
    warn: (obj: unknown, msg: string) => apiLogger.warn(msg, obj as Record<string, unknown>),
  }

  app.post('/mcp/import/scan', async (c) => {
    try {
      const { repo, sources } = parseImportBody(await c.req.json(), ImportScanBody, 'scan')
      const repoPath = await resolveImportRepo(deps, repo, 'scan')
      return c.json(await scanMcpImports({ fs: deps.fs, repoPath, sources, logger: importLogger }))
    } catch (err) {
      if (err instanceof ImportRouteError) {
        apiLogger.error(err.logMessage, { err, ...(err.context ?? {}) })
        return c.json({ ok: false, error: err.code, message: err.message }, err.status)
      }
      apiLogger.error('MCP import scan route failed', { err })
      return c.json(
        { ok: false, error: 'scan_failed', message: String((err as Error)?.message ?? err) },
        500,
      )
    }
  })

  app.post('/mcp/import/apply', async (c) => {
    try {
      const { repo, sources, keys } = parseImportBody(await c.req.json(), ImportApplyBody, 'apply')
      const repoPath = await resolveImportRepo(deps, repo, 'apply')
      const result = await applyMcpImports({
        fs: deps.fs,
        repoPath,
        sources,
        keys,
        logger: importLogger,
      })
      if (!result.ok) return c.json(result, 409)
      return c.json(result)
    } catch (err) {
      if (err instanceof ImportRouteError) {
        apiLogger.error(err.logMessage, { err, ...(err.context ?? {}) })
        return c.json({ ok: false, error: err.code, message: err.message }, err.status)
      }
      apiLogger.error('MCP import apply route failed', { err })
      return c.json(
        { ok: false, error: 'apply_failed', message: String((err as Error)?.message ?? err) },
        500,
      )
    }
  })

  return app
}

async function resolveImportRepo(
  deps: RouteDeps,
  repo: string,
  action: ImportAction,
): Promise<string> {
  try {
    return await resolveRepoPath(deps.fs, repo, deps.home)
  } catch (err) {
    throw new ImportRouteError(
      400,
      'invalid_repo',
      String((err as Error)?.message ?? err),
      'invalid repository path for MCP import ' + action,
      { repo },
      err,
    )
  }
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
    readonly status: 400,
    readonly code: string,
    message: string,
    readonly logMessage: string,
    readonly context?: Record<string, unknown>,
    cause?: unknown,
  ) {
    super(message, { cause })
  }
}
