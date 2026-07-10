import { Hono } from 'hono'
import { join, sep } from 'node:path'
import { AgentIdSchema } from '@loom/core'
import { z } from 'zod'
import { resolveRepoPath } from '../repo.js'
import { readYaml, writeYaml } from '../repo-config.js'
import { jsonValidator, queryValidator } from '../request-validation.js'
import type { RouteDeps } from '../router.js'
import { renderAgentAwareText } from '../../vars/agent-aware.js'

const NAME_RE = /^[A-Za-z0-9_-]+$/
const NonEmptyString = z.string().min(1)
const MemoryName = z.string().regex(NAME_RE)
const RepoQuery = z.object({ repo: NonEmptyString })
const MemoryQuery = RepoQuery.extend({ name: MemoryName.optional() })
const RequiredMemoryQuery = RepoQuery.extend({ name: MemoryName })
const CreateMemoryBody = z.object({ repo: NonEmptyString, name: MemoryName })
const MemoryContentBody = CreateMemoryBody.extend({ content: z.string() })
const RenameMemoryBody = CreateMemoryBody.extend({ newName: MemoryName })
const ActiveMemoryBody = z.object({ repo: NonEmptyString, name: MemoryName.nullable() })
const PreviewMemoryBody = z.object({
  repo: NonEmptyString,
  content: z.string(),
  agent: AgentIdSchema,
})

function memoriesDir(repoPath: string) {
  return join(repoPath, 'memories')
}

async function readConfig(fs: any, repoPath: string): Promise<Record<string, any>> {
  return (await readYaml(fs, join(repoPath, 'config.yaml'))) ?? {}
}

export function createMemoryRoutes(deps: RouteDeps): Hono {
  const app = new Hono()

  app.get('/memory', queryValidator(MemoryQuery, { error: memoryQueryError }), async (c) => {
    try {
      const { repo, name: nameQuery } = c.req.valid('query')
      const repoPath = await resolveRepoPath(deps.fs, repo, deps.home)
      // ?name=<n> returns single memory raw content (for editing non-active memories)
      if (nameQuery) {
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

  app.post('/memory', jsonValidator(CreateMemoryBody, { error: memoryBodyError }), async (c) => {
    try {
      const { repo, name } = c.req.valid('json')
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

  app.delete(
    '/memory',
    queryValidator(RequiredMemoryQuery, { error: memoryQueryError }),
    async (c) => {
      try {
        const { repo, name } = c.req.valid('query')
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
    },
  )

  app.put(
    '/memory/content',
    jsonValidator(MemoryContentBody, { error: memoryContentError }),
    async (c) => {
      try {
        const { repo, name, content } = c.req.valid('json')
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
    },
  )

  app.post(
    '/memory/rename',
    jsonValidator(RenameMemoryBody, { error: memoryRenameError }),
    async (c) => {
      try {
        const { repo, name, newName } = c.req.valid('json')
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
    },
  )

  app.post(
    '/memory/active',
    jsonValidator(ActiveMemoryBody, { error: memoryBodyError }),
    async (c) => {
      try {
        const { repo, name } = c.req.valid('json')
        const repoPath = await resolveRepoPath(deps.fs, repo, deps.home)
        if (name === null) {
          const cfg = await readConfig(deps.fs, repoPath)
          delete cfg.active_memory
          await writeYaml(deps.fs, join(repoPath, 'config.yaml'), cfg)
          return c.json({ ok: true })
        }
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
    },
  )

  app.post(
    '/memory/preview',
    jsonValidator(PreviewMemoryBody, { error: 'invalid_request', message: '请求无效' }),
    async (c) => {
      try {
        const { repo, content, agent } = c.req.valid('json')
        const repoPath = await resolveRepoPath(deps.fs, repo, deps.home)
        const result = await renderAgentAwareText(deps.fs, deps.home, repoPath, agent, content)
        if (!result.ok)
          return c.json({ ok: false, error: 'render_failed', diagnostics: result.diagnostics }, 400)
        return c.json({ rendered: result.rendered, diagnostics: [], resolution: result.resolution })
      } catch (e) {
        return c.json(
          { ok: false, error: 'render_failed', message: String((e as Error).message) },
          400,
        )
      }
    },
  )

  return app
}

function memoryQueryError(issues: z.ZodIssue[]): string {
  return issues[0]?.path[0] === 'name' ? 'invalid_name' : 'invalid_repo'
}

function memoryBodyError(issues: z.ZodIssue[]): string {
  return issues[0]?.path[0] === 'name' ? 'invalid_name' : 'invalid_repo'
}

function memoryContentError(issues: z.ZodIssue[]): string {
  const field = issues[0]?.path[0]
  if (field === 'name') return 'invalid_name'
  if (field === 'content') return 'invalid_content'
  return 'invalid_repo'
}

function memoryRenameError(issues: z.ZodIssue[]): string {
  const field = issues[0]?.path[0]
  return field === 'name' || field === 'newName' ? 'invalid_name' : 'invalid_repo'
}
