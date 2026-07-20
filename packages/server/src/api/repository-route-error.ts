import type { Context } from 'hono'
import { RepositoryAccessError } from './repo.js'

interface ErrorLogger {
  error(message: string, context?: Record<string, unknown>): void
}

export interface RepositoryRouteError {
  status: 400 | 500
  code: 'invalid_repo' | 'repo_unavailable'
  message: 'invalid repository' | 'repository is unavailable'
}

export function repositoryRouteError(error: unknown): RepositoryRouteError | null {
  if (!(error instanceof RepositoryAccessError)) return null
  return {
    status: error.status,
    code: error.code,
    message: error.code === 'invalid_repo' ? 'invalid repository' : 'repository is unavailable',
  }
}

export function repositoryErrorResponse(
  c: Context,
  error: unknown,
  logger: ErrorLogger,
  logMessage: string,
  context: Record<string, unknown> = {},
): Response | null {
  const mapped = repositoryRouteError(error)
  if (!mapped) return null
  logger.error(logMessage, { err: error, ...context })
  return c.json({ ok: false, error: mapped.code, message: mapped.message }, mapped.status)
}

export function repositoryResolutionErrorResponse(
  c: Context,
  error: unknown,
  logger: ErrorLogger,
  logMessage: string,
  context: Record<string, unknown> = {},
): Response {
  const mapped = repositoryRouteError(error) ?? {
    status: 500 as const,
    code: 'repo_unavailable' as const,
    message: 'repository is unavailable' as const,
  }
  logger.error(logMessage, { err: error, ...context })
  return c.json({ ok: false, error: mapped.code, message: mapped.message }, mapped.status)
}
