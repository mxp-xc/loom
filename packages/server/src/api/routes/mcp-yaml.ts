import { Hono } from 'hono'
import { join } from 'node:path'
import { addMcpServer, removeMcpServer, setMcpTargets } from '@loom/core'
import { readYaml, writeYaml } from '../repo-config.js'
import { resolveRepoPath } from '../repo.js'
import type { RouteDeps } from '../router.js'

export function createMcpYamlRoutes(deps: RouteDeps): Hono {
  const app = new Hono()

  app.post('/mcp', async (c) => {
    try {
      const { repo, server } = await c.req.json()
      let repoPath: string
      try {
        repoPath = await resolveRepoPath(deps.fs, repo, deps.home)
      } catch (e) {
        return c.json(
          { ok: false, error: 'invalid_repo', message: String((e as Error).message) },
          400,
        )
      }
      const filePath = join(repoPath, 'mcp.yaml')
      const data = (await readYaml(deps.fs, filePath)) ?? []
      const result = addMcpServer(data, server)
      if (result.changed) await writeYaml(deps.fs, filePath, result.data)
      return c.json({ ok: true, server })
    } catch (e) {
      return c.json({
        ok: false,
        error: 'write_failed',
        message: String((e as Error)?.message ?? e),
      })
    }
  })

  app.delete('/mcp', async (c) => {
    try {
      const { repo, id } = await c.req.json()
      if (!id || typeof id !== 'string') return c.json({ ok: false, error: 'invalid_id' }, 400)
      let repoPath: string
      try {
        repoPath = await resolveRepoPath(deps.fs, repo, deps.home)
      } catch (e) {
        return c.json(
          { ok: false, error: 'invalid_repo', message: String((e as Error).message) },
          400,
        )
      }
      const filePath = join(repoPath, 'mcp.yaml')
      const data = (await readYaml(deps.fs, filePath)) ?? []
      const result = removeMcpServer(data, id)
      if (result.changed) await writeYaml(deps.fs, filePath, result.data)
      return c.json({ ok: true })
    } catch (e) {
      return c.json({
        ok: false,
        error: 'delete_failed',
        message: String((e as Error)?.message ?? e),
      })
    }
  })

  app.post('/mcp/targets', async (c) => {
    try {
      const { repo, id, targets } = await c.req.json()
      let repoPath: string
      try {
        repoPath = await resolveRepoPath(deps.fs, repo, deps.home)
      } catch (e) {
        return c.json(
          { ok: false, error: 'invalid_repo', message: String((e as Error).message) },
          400,
        )
      }
      const filePath = join(repoPath, 'mcp.yaml')
      const data = (await readYaml(deps.fs, filePath)) ?? []
      const result = setMcpTargets(data, id, targets)
      if (result.changed) {
        await writeYaml(deps.fs, filePath, result.data)
      } else {
        return c.json({ ok: false, error: 'not_found', message: `MCP server ${id} not found` })
      }
      return c.json({ ok: true })
    } catch (e) {
      return c.json({
        ok: false,
        error: 'update_failed',
        message: String((e as Error)?.message ?? e),
      })
    }
  })

  return app
}
