import { Hono, type Context } from 'hono'
import {
  AgentIdSchema,
  McpServerSchema,
  renderTextWithResolvedVars,
  type McpServer,
  type VarsDiagnostic,
} from '@loom/core'
import { z } from 'zod'
import { logger } from '../../lib/logger.js'
import {
  McpDebugSessionError,
  McpDebugSessionManager,
  type McpDebugCallResult,
  type McpDebugPreviewAgent,
  type McpDebugSessionSnapshot,
} from '../../mcp/debug-session.js'
import { VarsApplication, VarsApplicationError } from '../../vars/application.js'
import { readMcpManifest, RepoConfigError } from '../repo-config.js'
import { jsonValidator, paramValidator } from '../request-validation.js'
import type { RouteDeps } from '../router.js'
import { repositoryErrorResponse } from '../repository-route-error.js'
import { canonicalRepositoryHome, withRepositoryLease } from '../repository-lease.js'
import { resourceLeases } from '../../concurrency/resource-lease-coordinator.js'

export interface McpDebugSessionManagerLike {
  createSession(input: {
    source: 'saved' | 'draft'
    server: McpServer
    previewAgent: McpDebugPreviewAgent
  }): Promise<McpDebugSessionSnapshot>
  callTool(
    sessionId: string,
    request: { toolName: string; arguments: Record<string, unknown> },
  ): Promise<McpDebugCallResult>
  disconnect(sessionId: string): Promise<void>
}

export interface McpDebugRouteDeps extends RouteDeps {
  mcpDebug: McpDebugSessionManagerLike
}

const mcpDebugLogger = logger.child('mcp-debug-route')
const NonEmptyString = z.string().min(1)
const RepoField = z.unknown()
const McpDebugPreviewAgentSchema = z.union([z.literal('default'), AgentIdSchema])
const CreateMcpDebugSessionBody = z.discriminatedUnion('source', [
  z.object({
    repo: RepoField,
    source: z.literal('saved'),
    serverId: NonEmptyString,
    previewAgent: McpDebugPreviewAgentSchema,
  }),
  z.object({
    repo: RepoField,
    source: z.literal('draft'),
    draft: McpServerSchema,
    previewAgent: McpDebugPreviewAgentSchema,
  }),
])
const SessionParams = z.object({ id: NonEmptyString })
const CallToolBody = z.object({
  toolName: NonEmptyString,
  arguments: z.record(z.unknown()),
})

class McpDebugRouteError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: 400 | 404 | 409 | 422 | 500,
    readonly diagnostics?: VarsDiagnostic[],
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'McpDebugRouteError'
  }
}

export function createMcpDebugRoutes(deps: McpDebugRouteDeps): Hono {
  const app = new Hono()
  const leases = resourceLeases(deps, deps.leases)

  app.post(
    '/mcp/debug/sessions',
    jsonValidator(CreateMcpDebugSessionBody, {
      error: 'invalid_request',
      message: 'MCP debug session 请求无效',
    }),
    async (c) => {
      try {
        const body = c.req.valid('json')
        const canonicalHome = await canonicalRepositoryHome(deps)
        const scopedDeps = { ...deps, home: canonicalHome, leases }
        const server = await withRepositoryLease(
          scopedDeps,
          body.repo as string,
          'read',
          (repoPath) => [repoPath, canonicalHome],
          async (repoPath) => {
            const sourceServer =
              body.source === 'saved'
                ? await readSavedServer(scopedDeps, repoPath, body.serverId)
                : body.draft
            return resolveMcpServerForDebug(scopedDeps, repoPath, sourceServer, body.previewAgent)
          },
        )
        const session = await deps.mcpDebug.createSession({
          source: body.source,
          previewAgent: body.previewAgent,
          server,
        })
        return c.json({ ok: true, ...session })
      } catch (err) {
        return mcpDebugErrorResponse(c, err, 'MCP debug session create failed')
      }
    },
  )

  app.post(
    '/mcp/debug/sessions/:id/tools/call',
    paramValidator(SessionParams, { error: 'invalid_session' }),
    jsonValidator(CallToolBody, {
      error: 'invalid_request',
      message: 'MCP tool 调用请求无效',
    }),
    async (c) => {
      try {
        const { id } = c.req.valid('param')
        const body = c.req.valid('json')
        const result = await deps.mcpDebug.callTool(id, body)
        return c.json(result)
      } catch (err) {
        return mcpDebugErrorResponse(c, err, 'MCP debug tool call failed')
      }
    },
  )

  app.delete(
    '/mcp/debug/sessions/:id',
    paramValidator(SessionParams, { error: 'invalid_session' }),
    async (c) => {
      try {
        const { id } = c.req.valid('param')
        await deps.mcpDebug.disconnect(id)
        return c.json({ ok: true })
      } catch (err) {
        return mcpDebugErrorResponse(c, err, 'MCP debug disconnect failed')
      }
    },
  )

  return app
}

export function createDefaultMcpDebugManager(): McpDebugSessionManager {
  return new McpDebugSessionManager({
    logger: {
      error: (message, context) => mcpDebugLogger.error(message, context),
      warn: (message, context) => mcpDebugLogger.warn(message, context),
      info: (message, context) => mcpDebugLogger.info(message, context),
    },
  })
}

async function readSavedServer(
  deps: RouteDeps,
  repoPath: string,
  serverId: string,
): Promise<McpServer> {
  let parsed: McpServer[]
  try {
    parsed = await readMcpManifest(deps.fs, repoPath)
  } catch (error) {
    if (error instanceof RepoConfigError)
      throw new McpDebugRouteError('invalid_mcp_yaml', 'mcp.yaml 格式无效', 422, undefined, {
        cause: error,
      })
    throw error
  }
  const candidate = parsed.find(
    (item) => item && typeof item === 'object' && (item as { id?: unknown }).id === serverId,
  )
  const result = McpServerSchema.safeParse(candidate)
  if (!result.success) {
    throw new McpDebugRouteError('not_found', `MCP server ${serverId} not found`, 404)
  }
  return result.data
}

async function resolveMcpServerForDebug(
  deps: RouteDeps,
  repoPath: string,
  server: McpServer,
  previewAgent: McpDebugPreviewAgent,
): Promise<McpServer> {
  if (!serverHasVariables(server)) return connectionOnlyServer(server)

  try {
    const resolution = await new VarsApplication(
      deps.fs,
      deps.home,
    ).resolveUnmaskedForInterpolation(repoPath, previewAgent)
    const diagnostics: VarsDiagnostic[] = []
    const render = (value: string | undefined): string | undefined => {
      if (value === undefined) return undefined
      const rendered = renderTextWithResolvedVars(value, resolution)
      if (!rendered.ok) {
        diagnostics.push(...rendered.diagnostics)
        return value
      }
      return rendered.text
    }
    const renderRecord = (record: Record<string, string> | undefined) => {
      if (!record) return undefined
      const entries = Object.entries(record).map(([key, value]) => [key, render(value) ?? value])
      return entries.length ? Object.fromEntries(entries) : undefined
    }
    const resolved: McpServer =
      server.type === 'stdio'
        ? {
            id: server.id,
            type: server.type,
            command: render(server.command),
            args: server.args?.map((item) => render(item) ?? item),
            env: renderRecord(server.env),
          }
        : {
            id: server.id,
            type: server.type,
            url: render(server.url),
            env: renderRecord(server.env),
            headers: renderRecord(server.headers),
          }
    if (diagnostics.some((item) => item.severity === 'error')) {
      throw new McpDebugRouteError('resolution_failed', '变量解析失败', 422, diagnostics)
    }
    return resolved
  } catch (err) {
    if (err instanceof McpDebugRouteError) throw err
    if (err instanceof VarsApplicationError)
      throw new McpDebugRouteError(err.code, err.message, err.status, err.diagnostics, {
        cause: err,
      })
    throw new McpDebugRouteError('resolution_failed', '变量解析失败', 500, undefined, {
      cause: err,
    })
  }
}

function connectionOnlyServer(server: McpServer): McpServer {
  return server.type === 'stdio'
    ? {
        id: server.id,
        type: server.type,
        command: server.command,
        args: server.args,
        env: server.env,
      }
    : {
        id: server.id,
        type: server.type,
        url: server.url,
        env: server.env,
        headers: server.headers,
      }
}

function serverHasVariables(server: McpServer): boolean {
  return [
    server.command,
    ...(server.args ?? []),
    server.url,
    ...Object.values(server.env ?? {}),
    ...Object.values(server.headers ?? {}),
  ].some((value) => typeof value === 'string' && /(^|[^\\])\$\{[^}]+\}/.test(value))
}

function mcpDebugErrorResponse(c: Context, err: unknown, logMessage: string): Response {
  const repoFailure = repositoryErrorResponse(c, err, mcpDebugLogger, logMessage)
  if (repoFailure) return repoFailure
  if (err instanceof McpDebugSessionError) {
    const mapped = mcpDebugSessionError(err)
    mcpDebugLogger.error(logMessage, { err })
    return c.json(
      {
        ok: false,
        error: mapped.code,
        message: mapped.message,
        ...(err.durationMs === undefined ? {} : { durationMs: err.durationMs }),
      },
      mapped.status,
    )
  }
  if (err instanceof McpDebugRouteError) {
    mcpDebugLogger.error(logMessage, { err })
    return c.json(
      {
        ok: false,
        error: err.code,
        message: mcpDebugRouteMessage(err),
        ...(err.diagnostics ? { diagnostics: err.diagnostics } : {}),
      },
      err.status,
    )
  }
  mcpDebugLogger.error(logMessage, { err })
  return c.json(
    {
      ok: false,
      error: 'debug_failed',
      message: 'MCP debug operation failed',
    },
    500,
  )
}

function mcpDebugSessionError(error: McpDebugSessionError): {
  status: 404 | 409 | 500
  code: string
  message: string
} {
  switch (error.code as string) {
    case 'session_expired':
      return { status: 404, code: error.code, message: 'MCP debug session not found' }
    case 'too_many_sessions':
      return { status: 409, code: error.code, message: 'MCP debug session capacity reached' }
    case 'connect_failed':
      return { status: 500, code: error.code, message: 'MCP connection failed' }
    case 'list_tools_failed':
      return { status: 500, code: error.code, message: 'Failed to list MCP tools' }
    case 'tool_call_failed':
      return { status: 500, code: error.code, message: 'MCP tool call failed' }
    default:
      return { status: 500, code: 'debug_failed', message: 'MCP debug operation failed' }
  }
}

function mcpDebugRouteMessage(error: McpDebugRouteError): string {
  if (error.code === 'not_found') return 'MCP server not found'
  if (error.code === 'invalid_mcp_yaml') return 'MCP configuration is invalid'
  if (error.code === 'resolution_failed' && error.status === 422)
    return 'MCP variables could not be resolved'
  if (error.status === 400) return 'Invalid MCP debug request'
  if (error.status === 404) return 'MCP debug dependency not found'
  if (error.status === 409) return 'MCP debug state conflict'
  if (error.status === 422) return 'MCP debug configuration is invalid'
  return 'MCP debug operation failed'
}
