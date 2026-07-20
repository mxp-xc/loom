import { Hono, type Context } from 'hono'
import { AgentIdSchema, McpServerSchema } from '@loom/core'
import { z } from 'zod'
import { logger } from '../../lib/logger.js'
import { McpApplication, McpApplicationError } from '../../mcp/application.js'
import { jsonValidator } from '../request-validation.js'
import type { RouteDeps } from '../router.js'
import { repositoryErrorResponse } from '../repository-route-error.js'
import { RepoConfigError } from '../repo-config.js'
import { withRepositoryLease } from '../repository-lease.js'

const mcpRouteLogger = logger.child('mcp-route')
const RepoField = z.unknown().optional()
const NonEmptyString = z.string().min(1)

const AddMcpServerBody = z.object({
  repo: RepoField,
  server: McpServerSchema,
})

const DeleteMcpServerBody = z.object({
  repo: RepoField,
  id: NonEmptyString,
})

const UpdateMcpServerBody = z.object({
  repo: RepoField,
  id: NonEmptyString,
  server: z.unknown().refine((value) => Boolean(value) && typeof value === 'object'),
})

const SetMcpAgentsBody = z.object({
  repo: RepoField,
  id: NonEmptyString,
  agents: z.array(AgentIdSchema),
})

const ReorderMcpServersBody = z.object({
  repo: RepoField,
  ids: z.array(NonEmptyString),
})

export function createMcpYamlRoutes(deps: RouteDeps): Hono {
  const app = new Hono()
  const mcp = new McpApplication(deps.fs)

  app.post('/mcp', jsonValidator(AddMcpServerBody, { error: 'invalid_server' }), async (c) => {
    try {
      const { repo, server } = c.req.valid('json')
      await withRepositoryLease(
        deps,
        repo as string,
        'mutation',
        (repoPath) => [repoPath],
        (repoPath) => mcp.addServer(repoPath, server),
      )
      return c.json({ ok: true, server })
    } catch (e) {
      return mcpErrorResponse(c, e, {
        code: 'write_failed',
        message: 'Failed to add MCP server',
        logMessage: 'MCP server add failed',
      })
    }
  })

  app.delete('/mcp', jsonValidator(DeleteMcpServerBody, { error: 'invalid_id' }), async (c) => {
    try {
      const { repo, id } = c.req.valid('json')
      await withRepositoryLease(
        deps,
        repo as string,
        'mutation',
        (repoPath) => [repoPath],
        (repoPath) => mcp.removeServer(repoPath, id),
      )
      return c.json({ ok: true })
    } catch (e) {
      return mcpErrorResponse(c, e, {
        code: 'delete_failed',
        message: 'Failed to remove MCP server',
        logMessage: 'MCP server removal failed',
      })
    }
  })

  app.put(
    '/mcp',
    jsonValidator(UpdateMcpServerBody, {
      error: 'invalid_server',
      message: 'id 和 server 不能为空',
    }),
    async (c) => {
      try {
        const { repo, id, server } = c.req.valid('json')
        const result = await withRepositoryLease(
          deps,
          repo as string,
          'mutation',
          (repoPath) => [repoPath],
          (repoPath) => mcp.updateServer(repoPath, id, server),
        )
        return c.json({ ok: true, server: result.server })
      } catch (e) {
        return mcpErrorResponse(c, e, {
          code: 'update_failed',
          message: 'Failed to update MCP server',
          logMessage: 'MCP server update failed',
        })
      }
    },
  )

  app.post('/mcp/agents', jsonValidator(SetMcpAgentsBody, { error: mcpAgentsError }), async (c) => {
    try {
      const { repo, id, agents } = c.req.valid('json')
      await withRepositoryLease(
        deps,
        repo as string,
        'mutation',
        (repoPath) => [repoPath],
        (repoPath) => mcp.setAgents(repoPath, id, agents),
      )
      return c.json({ ok: true })
    } catch (e) {
      return mcpErrorResponse(c, e, {
        code: 'update_failed',
        message: 'Failed to update MCP agents',
        logMessage: 'MCP agent update failed',
      })
    }
  })

  app.put(
    '/mcp/order',
    jsonValidator(ReorderMcpServersBody, { error: 'invalid_order' }),
    async (c) => {
      try {
        const { repo, ids } = c.req.valid('json')
        const result = await withRepositoryLease(
          deps,
          repo as string,
          'mutation',
          (repoPath) => [repoPath],
          (repoPath) => mcp.reorderServers(repoPath, ids),
        )
        return c.json({ ok: true, ...result })
      } catch (e) {
        return mcpErrorResponse(c, e, {
          code: 'reorder_failed',
          message: 'Failed to reorder MCP servers',
          logMessage: 'MCP server reorder failed',
        })
      }
    },
  )

  return app
}

function mcpRepositoryFailure(c: Context, error: unknown, logMessage: string): Response | null {
  return repositoryErrorResponse(c, error, mcpRouteLogger, logMessage)
}

function mcpAgentsError(issues: z.ZodIssue[]): string {
  return issues[0]?.path[0] === 'id' ? 'invalid_id' : 'invalid_agents'
}

type McpErrorStatus = 400 | 404 | 409 | 422

const MCP_ERROR_MESSAGES: Record<McpErrorStatus, string> = {
  400: 'Invalid MCP request',
  404: 'MCP server not found',
  409: 'MCP state conflict',
  422: 'MCP configuration is invalid',
}

function mcpErrorResponse(
  c: Context,
  error: unknown,
  options: { code: string; message: string; logMessage: string },
): Response {
  const repoFailure = mcpRepositoryFailure(c, error, options.logMessage)
  if (repoFailure) return repoFailure

  mcpRouteLogger.error(options.logMessage, { err: error })
  if (error instanceof McpApplicationError) {
    return c.json(
      { ok: false, error: error.code, message: MCP_ERROR_MESSAGES[error.status] },
      error.status,
    )
  }
  if (error instanceof RepoConfigError) {
    return c.json(
      { ok: false, error: 'invalid_mcp_manifest', message: MCP_ERROR_MESSAGES[422] },
      422,
    )
  }
  return c.json({ ok: false, error: options.code, message: options.message }, 500)
}
