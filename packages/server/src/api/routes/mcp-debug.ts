import { Hono } from 'hono'
import { join } from 'node:path'
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
import { readYaml } from '../repo-config.js'
import { resolveRepoPath } from '../repo.js'
import { jsonValidator, paramValidator } from '../request-validation.js'
import type { RouteDeps } from '../router.js'

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
    readonly status = 200,
    readonly diagnostics?: VarsDiagnostic[],
  ) {
    super(message)
    this.name = 'McpDebugRouteError'
  }
}

export function createMcpDebugRoutes(deps: McpDebugRouteDeps): Hono {
  const app = new Hono()

  app.post(
    '/mcp/debug/sessions',
    jsonValidator(CreateMcpDebugSessionBody, {
      error: 'invalid_request',
      message: 'MCP debug session 请求无效',
    }),
    async (c) => {
      try {
        const body = c.req.valid('json')
        const repoPath = await resolveRequestRepo(deps, body.repo)
        const sourceServer =
          body.source === 'saved'
            ? await readSavedServer(deps, repoPath, body.serverId)
            : body.draft
        const server = await resolveMcpServerForDebug(
          deps,
          repoPath,
          sourceServer,
          body.previewAgent,
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

async function resolveRequestRepo(deps: RouteDeps, repo: unknown): Promise<string> {
  try {
    return await resolveRepoPath(deps.fs, repo as string, deps.home)
  } catch (cause) {
    throw new McpDebugRouteError('invalid_repo', String((cause as Error).message), 400)
  }
}

async function readSavedServer(
  deps: RouteDeps,
  repoPath: string,
  serverId: string,
): Promise<McpServer> {
  const parsed = (await readYaml(deps.fs, join(repoPath, 'mcp.yaml'))) ?? []
  if (!Array.isArray(parsed))
    throw new McpDebugRouteError('invalid_mcp_yaml', 'mcp.yaml 格式无效', 200)
  const candidate = parsed.find(
    (item) => item && typeof item === 'object' && (item as { id?: unknown }).id === serverId,
  )
  const result = McpServerSchema.safeParse(candidate)
  if (!result.success) {
    throw new McpDebugRouteError('not_found', `MCP server ${serverId} not found`, 200)
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
      throw new McpDebugRouteError('resolution_failed', '变量解析失败', 200, diagnostics)
    }
    return resolved
  } catch (err) {
    if (err instanceof McpDebugRouteError) throw err
    if (err instanceof VarsApplicationError)
      throw new McpDebugRouteError(err.code, err.message, err.status, err.diagnostics)
    mcpDebugLogger.error('MCP debug variable resolution failed', {
      err,
      serverId: server.id,
      previewAgent,
    })
    throw new McpDebugRouteError('resolution_failed', normalizeErrorMessage(err, '变量解析失败'))
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

function mcpDebugErrorResponse(
  c: { json: (body: unknown, status?: number) => Response },
  err: unknown,
  logMessage: string,
): Response {
  if (err instanceof McpDebugSessionError) {
    return c.json(
      {
        ok: false,
        error: err.code,
        message: err.message,
        ...(err.durationMs === undefined ? {} : { durationMs: err.durationMs }),
      },
      err.status,
    )
  }
  if (err instanceof McpDebugRouteError) {
    return c.json(
      {
        ok: false,
        error: err.code,
        message: err.message,
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
      message: normalizeErrorMessage(err, 'MCP debug 操作失败'),
    },
    500,
  )
}

function normalizeErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message || fallback : String(error || fallback)
}
