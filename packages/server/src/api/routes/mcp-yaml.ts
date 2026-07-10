import { Hono } from 'hono'
import { AgentIdSchema, McpServerSchema } from '@loom/core'
import { z } from 'zod'
import { logger } from '../../lib/logger.js'
import { McpApplication, McpApplicationError } from '../../mcp/application.js'
import { resolveRepoPath } from '../repo.js'
import { jsonValidator } from '../request-validation.js'
import type { RouteDeps } from '../router.js'

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

const SetMcpTargetsBody = z.object({
  repo: RepoField,
  id: NonEmptyString,
  targets: z.array(AgentIdSchema),
})

export function createMcpYamlRoutes(deps: RouteDeps): Hono {
  const app = new Hono()
  const mcp = new McpApplication(deps.fs)

  app.post('/mcp', jsonValidator(AddMcpServerBody, { error: 'invalid_server' }), async (c) => {
    try {
      const { repo, server } = c.req.valid('json')
      const repoPath = await resolveRequestRepo(deps, repo)
      await mcp.addServer(repoPath, server)
      return c.json({ ok: true, server })
    } catch (e) {
      if (isInvalidRepo(e)) return invalidRepo(c, e)
      return c.json(errorBody(e, 'write_failed', 'failed to add MCP server'))
    }
  })

  app.delete('/mcp', jsonValidator(DeleteMcpServerBody, { error: 'invalid_id' }), async (c) => {
    try {
      const { repo, id } = c.req.valid('json')
      const repoPath = await resolveRequestRepo(deps, repo)
      await mcp.removeServer(repoPath, id)
      return c.json({ ok: true })
    } catch (e) {
      if (isInvalidRepo(e)) return invalidRepo(c, e)
      return c.json(errorBody(e, 'delete_failed', 'failed to remove MCP server'))
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
        const repoPath = await resolveRequestRepo(deps, repo)
        const result = await mcp.updateServer(repoPath, id, server)
        return c.json({ ok: true, server: result.server })
      } catch (e) {
        if (e instanceof McpApplicationError) {
          return c.json({ ok: false, error: e.code, message: e.message }, e.status)
        }
        logger.error('MCP server update failed', { err: e })
        return c.json(
          { ok: false, error: 'update_failed', message: String((e as Error)?.message ?? e) },
          500,
        )
      }
    },
  )

  app.post(
    '/mcp/targets',
    jsonValidator(SetMcpTargetsBody, { error: mcpTargetsError }),
    async (c) => {
      try {
        const { repo, id, targets } = c.req.valid('json')
        const repoPath = await resolveRequestRepo(deps, repo)
        await mcp.setTargets(repoPath, id, targets)
        return c.json({ ok: true })
      } catch (e) {
        if (isInvalidRepo(e)) return invalidRepo(c, e)
        return c.json(errorBody(e, 'update_failed', 'failed to update MCP targets'))
      }
    },
  )

  return app
}

async function resolveRequestRepo(deps: RouteDeps, repo: unknown): Promise<string> {
  try {
    return await resolveRepoPath(deps.fs, repo as string, deps.home)
  } catch (cause) {
    throw Object.assign(new Error(String((cause as Error).message), { cause }), {
      code: 'invalid_repo',
    })
  }
}

function isInvalidRepo(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && 'code' in error && error.code === 'invalid_repo'
  )
}

function invalidRepo(
  c: { json: (body: unknown, status?: 400) => Response },
  error: unknown,
): Response {
  return c.json(
    { ok: false, error: 'invalid_repo', message: String((error as Error).message) },
    400,
  )
}

function mcpTargetsError(issues: z.ZodIssue[]): string {
  return issues[0]?.path[0] === 'id' ? 'invalid_id' : 'invalid_targets'
}

function errorBody(
  error: unknown,
  fallbackCode: string,
  logMessage: string,
): { ok: false; error: string; message: string } {
  if (error instanceof McpApplicationError) {
    return { ok: false, error: error.code, message: error.message }
  }
  mcpRouteLogger.error(logMessage, { err: error })
  return {
    ok: false,
    error: fallbackCode,
    message: String((error as Error)?.message ?? error),
  }
}
