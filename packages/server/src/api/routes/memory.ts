import { Hono } from 'hono'
import { join, sep } from 'node:path'
import { AgentIdSchema } from '@loom/core'
import { resolveRepoPath } from '../repo.js'
import { readYaml, writeYaml } from '../repo-config.js'
import type { RouteDeps } from '../router.js'
import { renderAgentAwareText } from '../../vars/agent-aware.js'

const NAME_RE = /^[A-Za-z0-9_-]+$/

function memoriesDir(repoPath: string) {
  return join(repoPath, 'memories')
}

function validName(name: string): boolean {
  return NAME_RE.test(name)
}

async function readConfig(fs: any, repoPath: string): Promise<Record<string, any>> {
  return (await readYaml(fs, join(repoPath, 'config.yaml'))) ?? {}
}

export function createMemoryRoutes(deps: RouteDeps): Hono {
  const app = new Hono()

  app.get('/memory', async (c) => {
    try {
      const repo = c.req.query('repo')!
      const repoPath = await resolveRepoPath(deps.fs, repo, deps.home)
      // ?name=<n> returns single memory raw content (for editing non-active memories)
      const nameQuery = c.req.query('name')
      if (nameQuery) {
        if (!validName(nameQuery)) return c.json({ ok: false, error: 'invalid_name' }, 400)
        const file = join(memoriesDir(repoPath), `${nameQuery}.md`)
        if (!(await deps.fs.exists(file))) return c.json({ ok: false, error: 'not_found' }, 404)
        return c.json({ content: await deps.fs.readFile(file) })
      }
      const dir = memoriesDir(repoPath)
      const names: string[] = []
      if (await deps.fs.exists(dir)) {
        for (const f of await deps.fs.readDir(dir)) {
          if (f.endsWith('.md')) names.push(f.slice(0, -'.md'.length))
        }
      }
      names.sort()
      const cfg = await readConfig(deps.fs, repoPath)
      const active = typeof cfg.active_memory === 'string' ? cfg.active_memory : null
      let activeContent = ''
      if (active && names.includes(active)) {
        activeContent = await deps.fs.readFile(join(dir, `${active}.md`))
      }
      return c.json({ memories: names.map((n) => ({ name: n })), active, activeContent })
    } catch (e) {
      return c.json({ ok: false, error: 'read_failed', message: String((e as Error).message) }, 400)
    }
  })

  app.post('/memory', async (c) => {
    try {
      const { repo, name } = await c.req.json()
      if (!validName(name)) return c.json({ ok: false, error: 'invalid_name' }, 400)
      const repoPath = await resolveRepoPath(deps.fs, repo, deps.home)
      const dir = memoriesDir(repoPath)
      await deps.fs.mkdir(dir, true)
      const file = join(dir, `${name}.md`)
      if (await deps.fs.exists(file)) return c.json({ ok: false, error: 'exists' }, 409)
      if (!file.startsWith(dir + sep)) return c.json({ ok: false, error: 'invalid_name' }, 400)
      await deps.fs.writeFile(file, '')
      return c.json({ ok: true, name })
    } catch (e) {
      return c.json(
        { ok: false, error: 'create_failed', message: String((e as Error).message) },
        400,
      )
    }
  })

  app.delete('/memory', async (c) => {
    try {
      const repo = c.req.query('repo')!
      const name = c.req.query('name')!
      if (!validName(name)) return c.json({ ok: false, error: 'invalid_name' }, 400)
      const repoPath = await resolveRepoPath(deps.fs, repo, deps.home)
      const file = join(memoriesDir(repoPath), `${name}.md`)
      if (!(await deps.fs.exists(file))) return c.json({ ok: false, error: 'not_found' }, 404)
      await deps.fs.removeFile(file)
      const cfg = await readConfig(deps.fs, repoPath)
      if (cfg.active_memory === name) {
        delete cfg.active_memory
        await writeYaml(deps.fs, join(repoPath, 'config.yaml'), cfg)
      }
      return c.json({ ok: true })
    } catch (e) {
      return c.json(
        { ok: false, error: 'delete_failed', message: String((e as Error).message) },
        400,
      )
    }
  })

  app.put('/memory/content', async (c) => {
    try {
      const { repo, name, content } = await c.req.json()
      if (!validName(name)) return c.json({ ok: false, error: 'invalid_name' }, 400)
      const repoPath = await resolveRepoPath(deps.fs, repo, deps.home)
      const file = join(memoriesDir(repoPath), `${name}.md`)
      if (!(await deps.fs.exists(file))) return c.json({ ok: false, error: 'not_found' }, 404)
      await deps.fs.writeFile(file, content)
      return c.json({ ok: true })
    } catch (e) {
      return c.json(
        { ok: false, error: 'write_failed', message: String((e as Error).message) },
        400,
      )
    }
  })

  app.post('/memory/rename', async (c) => {
    try {
      const { repo, name, newName } = await c.req.json()
      if (!validName(name) || !validName(newName))
        return c.json({ ok: false, error: 'invalid_name' }, 400)
      const repoPath = await resolveRepoPath(deps.fs, repo, deps.home)
      const dir = memoriesDir(repoPath)
      const oldFile = join(dir, `${name}.md`)
      const newFile = join(dir, `${newName}.md`)
      if (!(await deps.fs.exists(oldFile))) return c.json({ ok: false, error: 'not_found' }, 404)
      if (await deps.fs.exists(newFile)) return c.json({ ok: false, error: 'exists' }, 409)
      if (!newFile.startsWith(dir + sep)) return c.json({ ok: false, error: 'invalid_name' }, 400)
      await deps.fs.move(oldFile, newFile)
      const cfg = await readConfig(deps.fs, repoPath)
      if (cfg.active_memory === name) {
        cfg.active_memory = newName
        await writeYaml(deps.fs, join(repoPath, 'config.yaml'), cfg)
      }
      return c.json({ ok: true, name: newName })
    } catch (e) {
      return c.json(
        { ok: false, error: 'rename_failed', message: String((e as Error).message) },
        400,
      )
    }
  })

  app.post('/memory/active', async (c) => {
    try {
      const { repo, name } = await c.req.json()
      const repoPath = await resolveRepoPath(deps.fs, repo, deps.home)
      if (name === null) {
        const cfg = await readConfig(deps.fs, repoPath)
        delete cfg.active_memory
        await writeYaml(deps.fs, join(repoPath, 'config.yaml'), cfg)
        return c.json({ ok: true })
      }
      if (!validName(name)) return c.json({ ok: false, error: 'invalid_name' }, 400)
      const file = join(memoriesDir(repoPath), `${name}.md`)
      if (!(await deps.fs.exists(file))) return c.json({ ok: false, error: 'not_found' }, 404)
      const cfg = await readConfig(deps.fs, repoPath)
      cfg.active_memory = name
      await writeYaml(deps.fs, join(repoPath, 'config.yaml'), cfg)
      return c.json({ ok: true })
    } catch (e) {
      return c.json(
        { ok: false, error: 'activate_failed', message: String((e as Error).message) },
        400,
      )
    }
  })

  app.post('/memory/preview', async (c) => {
    try {
      const { repo, content, agent } = await c.req.json()
      const parsedAgent = AgentIdSchema.safeParse(agent)
      if (!parsedAgent.success || typeof content !== 'string')
        return c.json({ ok: false, error: 'invalid_request', message: '请求无效' }, 400)
      const repoPath = await resolveRepoPath(deps.fs, repo, deps.home)
      const result = await renderAgentAwareText(
        deps.fs,
        deps.home,
        repoPath,
        parsedAgent.data,
        content,
      )
      if (!result.ok)
        return c.json({ ok: false, error: 'render_failed', diagnostics: result.diagnostics }, 400)
      return c.json({ rendered: result.rendered, diagnostics: [], resolution: result.resolution })
    } catch (e) {
      return c.json(
        { ok: false, error: 'render_failed', message: String((e as Error).message) },
        400,
      )
    }
  })

  return app
}
