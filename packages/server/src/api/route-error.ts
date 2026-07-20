import type { Context } from 'hono'

export type RouteErrorStatus = 400 | 404 | 409 | 413 | 422 | 500

export interface RouteErrorDescriptor {
  status: RouteErrorStatus
  code: string
  message: string
  diagnostics?: unknown
}

interface RouteErrorLogger {
  error(message: string, context: Record<string, unknown>): void
}

export function routeErrorResponse(
  c: Context,
  error: unknown,
  logger: RouteErrorLogger,
  logMessage: string,
  classify: (error: unknown) => RouteErrorDescriptor | null,
  fallback: RouteErrorDescriptor,
  context: Record<string, unknown> = {},
): Response {
  logger.error(logMessage, { err: error, ...context })
  const descriptor = classify(error) ?? fallback
  return c.json(
    {
      ok: false,
      error: descriptor.code,
      message: descriptor.message,
      ...(descriptor.diagnostics === undefined ? {} : { diagnostics: descriptor.diagnostics }),
    },
    descriptor.status,
  )
}
