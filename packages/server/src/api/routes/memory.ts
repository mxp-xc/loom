import { Hono } from 'hono'
import { join, sep } from 'node:path'
import { AgentIdSchema, normalizeOrder, sameOrder, type AgentId } from '@loom/core'
import { z } from 'zod'
import { resolveRepoPath } from '../repo.js'
import { readYaml, writeYaml } from '../repo-config.js'
import { jsonValidator, queryValidator } from '../request-validation.js'
import type { RouteDeps } from '../router.js'
import { renderAgentAwareText } from '../../vars/agent-aware.js'
import { logger } from '../../lib/logger.js'

const NAME_RE = /^[A-Za-z0-9._-]+$/
const WINDOWS_RESERVED_NAME_RE = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i
const NonEmptyString = z.string().min(1)
const MemoryName = z
  .string()
  .min(1)
  .max(252)
  .regex(NAME_RE)
  .refine((name) => !WINDOWS_RESERVED_NAME_RE.test(name))
const RepoQuery = z.object({ repo: NonEmptyString })
const MemoryQuery = RepoQuery.extend({ name: MemoryName.optional() })
const RequiredMemoryQuery = RepoQuery.extend({ name: MemoryName })
const CreateMemoryBody = z.object({ repo: NonEmptyString, name: MemoryName })
const MemoryContentBody = CreateMemoryBody.extend({ content: z.string() })
const RenameMemoryBody = CreateMemoryBody.extend({ newName: MemoryName })
const ActiveMemoryBody = z.object({ repo: NonEmptyString, name: MemoryName.nullable() })
const MemoryTargetBody = z.object({
  repo: NonEmptyString,
  target: AgentIdSchema,
  name: MemoryName.nullable(),
})
const ReorderMemoriesBody = z.object({ repo: NonEmptyString, names: z.array(MemoryName) })
const PreviewMemoryBody = z.object({
  repo: NonEmptyString,
  content: z.string(),
  agent: AgentIdSchema,
})

function memoriesDir(repoPath: string) {
  return join(repoPath, 'memories')
}

async function hasMemoryNameConflict(fs: RouteDeps['fs'], dir: string, name: string) {
  if (!(await fs.exists(dir))) return false
  const normalizedName = name.toLowerCase()
  return (await fs.readDir(dir)).some(
    (fileName) =>
      fileName.endsWith('.md') && fileName.slice(0, -'.md'.length).toLowerCase() === normalizedName,
  )
}

const memoryLogger = logger.child('memory-route')

class MemoryRouteError extends Error {
  constructor(
    readonly status: 409 | 422,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

async function readConfig(fs: any, repoPath: string): Promise<Record<string, any>> {
  return (await readYaml(fs, join(repoPath, 'config.yaml'))) ?? {}
}

async function readMemoryNames(fs: RouteDeps['fs'], repoPath: string): Promise<string[]> {
  const dir = memoriesDir(repoPath)
  if (!(await fs.exists(dir))) return []
  return (await fs.readDir(dir))
    .filter((name) => name.endsWith('.md'))
    .map((name) => name.slice(0, -'.md'.length))
    .sort()
}

function memoryAssignments(
  cfg: Record<string, any>,
  names: string[],
): Partial<Record<AgentId, string>> {
  const assignments: Partial<Record<AgentId, string>> = {}
  if (
    cfg.memory_targets &&
    typeof cfg.memory_targets === 'object' &&
    !Array.isArray(cfg.memory_targets)
  ) {
    for (const agent of AgentIdSchema.options) {
      const name = cfg.memory_targets[agent]
      if (typeof name === 'string' && names.includes(name)) assignments[agent] = name
    }
    return assignments
  }
  if (typeof cfg.active_memory === 'string' && names.includes(cfg.active_memory)) {
    for (const target of Array.isArray(cfg.targets) ? cfg.targets : []) {
      if (AgentIdSchema.safeParse(target).success)
        assignments[target as AgentId] = cfg.active_memory
    }
  }
  return assignments
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
      const fileNames = await readMemoryNames(deps.fs, repoPath)
      const cfg = await readConfig(deps.fs, repoPath)
      const names = normalizeOrder(cfg.memory_order, fileNames)
      const active = typeof cfg.active_memory === 'string' ? cfg.active_memory : null
      const assignments = memoryAssignments(cfg, names)
      let activeContent = ''
      if (active && names.includes(active)) {
        activeContent = await deps.fs.readFile(join(dir, `${active}.md`))
      }
      return c.json({
        memories: names.map((n) => ({
          name: n,
          targets: AgentIdSchema.options.filter((agent) => assignments[agent] === n),
        })),
        assignments,
        active,
        activeContent,
      })
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
      if (await hasMemoryNameConflict(deps.fs, dir, name))
        return c.json({ ok: false, error: 'exists' }, 409)
      if (!file.startsWith(dir + sep)) return c.json({ ok: false, error: 'invalid_name' }, 400)
      const cfg = await readConfig(deps.fs, repoPath)
      const names = await readMemoryNames(deps.fs, repoPath)
      await deps.fs.writeFile(file, '')
      try {
        cfg.memory_order = [...normalizeOrder(cfg.memory_order, names), name]
        await writeYaml(deps.fs, join(repoPath, 'config.yaml'), cfg)
      } catch (error) {
        try {
          await deps.fs.removeFile(file)
        } catch (rollbackError) {
          memoryLogger.error('memory create rollback failed', {
            err: rollbackError,
            repoPath,
            name,
          })
          throw new AggregateError([error, rollbackError], 'memory create and rollback failed', {
            cause: error,
          })
        }
        throw error
      }
      return c.json({ ok: true, name })
    } catch (e) {
      memoryLogger.error('memory create failed', { err: e })
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
        const content = await deps.fs.readFile(file)
        const cfg = await readConfig(deps.fs, repoPath)
        const names = await readMemoryNames(deps.fs, repoPath)
        const assignments = memoryAssignments(cfg, names)
        cfg.memory_order = normalizeOrder(cfg.memory_order, names).filter((item) => item !== name)
        if (cfg.active_memory === name) {
          delete cfg.active_memory
        }
        cfg.memory_targets = Object.fromEntries(
          Object.entries(assignments).filter(([, memoryName]) => memoryName !== name),
        )
        await deps.fs.removeFile(file)
        try {
          await writeYaml(deps.fs, join(repoPath, 'config.yaml'), cfg)
        } catch (error) {
          try {
            await deps.fs.writeFile(file, content)
          } catch (rollbackError) {
            memoryLogger.error('memory delete rollback failed', {
              err: rollbackError,
              repoPath,
              name,
            })
            throw new AggregateError([error, rollbackError], 'memory delete and rollback failed', {
              cause: error,
            })
          }
          throw error
        }
        return c.json({ ok: true })
      } catch (e) {
        memoryLogger.error('memory delete failed', { err: e })
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
        memoryLogger.error('memory content write failed', { err: e })
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
        if (await hasMemoryNameConflict(deps.fs, dir, newName))
          return c.json({ ok: false, error: 'exists' }, 409)
        if (!newFile.startsWith(dir + sep)) return c.json({ ok: false, error: 'invalid_name' }, 400)
        const cfg = await readConfig(deps.fs, repoPath)
        const names = await readMemoryNames(deps.fs, repoPath)
        const assignments = memoryAssignments(cfg, names)
        const renamedNames = names.map((item) => (item === name ? newName : item))
        cfg.memory_order = normalizeOrder(cfg.memory_order, names).map((item) =>
          item === name ? newName : item,
        )
        cfg.memory_order = normalizeOrder(cfg.memory_order, renamedNames)
        if (cfg.active_memory === name) {
          cfg.active_memory = newName
        }
        cfg.memory_targets = Object.fromEntries(
          Object.entries(assignments).map(([agent, memoryName]) => [
            agent,
            memoryName === name ? newName : memoryName,
          ]),
        )
        await deps.fs.move(oldFile, newFile)
        try {
          await writeYaml(deps.fs, join(repoPath, 'config.yaml'), cfg)
        } catch (error) {
          try {
            await deps.fs.move(newFile, oldFile)
          } catch (rollbackError) {
            memoryLogger.error('memory rename rollback failed', {
              err: rollbackError,
              repoPath,
              name,
              newName,
            })
            throw new AggregateError([error, rollbackError], 'memory rename and rollback failed', {
              cause: error,
            })
          }
          throw error
        }
        return c.json({ ok: true, name: newName })
      } catch (e) {
        memoryLogger.error('memory rename failed', { err: e })
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
        const cfg = await readConfig(deps.fs, repoPath)
        if (name === null) {
          delete cfg.active_memory
          delete cfg.memory_targets
          await writeYaml(deps.fs, join(repoPath, 'config.yaml'), cfg)
          return c.json({ ok: true })
        }
        const file = join(memoriesDir(repoPath), `${name}.md`)
        if (!(await deps.fs.exists(file))) return c.json({ ok: false, error: 'not_found' }, 404)
        cfg.active_memory = name
        if (cfg.memory_targets && typeof cfg.memory_targets === 'object') {
          cfg.memory_targets = Object.fromEntries(
            (Array.isArray(cfg.targets) ? cfg.targets : [])
              .filter((target) => AgentIdSchema.safeParse(target).success)
              .map((target: AgentId) => [target, name]),
          )
        }
        await writeYaml(deps.fs, join(repoPath, 'config.yaml'), cfg)
        return c.json({ ok: true })
      } catch (e) {
        memoryLogger.error('legacy memory activation failed', { err: e })
        return c.json(
          { ok: false, error: 'activate_failed', message: String((e as Error).message) },
          400,
        )
      }
    },
  )

  app.put(
    '/memory/target',
    jsonValidator(MemoryTargetBody, { error: 'invalid_target' }),
    async (c) => {
      try {
        const { repo, target, name } = c.req.valid('json')
        const repoPath = await resolveRepoPath(deps.fs, repo, deps.home)
        const names = await readMemoryNames(deps.fs, repoPath)
        if (name !== null && !names.includes(name))
          return c.json({ ok: false, error: 'not_found' }, 404)
        const cfg = await readConfig(deps.fs, repoPath)
        const assignments = memoryAssignments(cfg, names)
        if (name === null) delete assignments[target]
        else assignments[target] = name
        cfg.memory_targets = assignments
        delete cfg.active_memory
        await writeYaml(deps.fs, join(repoPath, 'config.yaml'), cfg)
        return c.json({ ok: true, assignments })
      } catch (e) {
        memoryLogger.error('memory target update failed', { err: e })
        return c.json(
          { ok: false, error: 'target_update_failed', message: String((e as Error).message) },
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

  app.put(
    '/memory/order',
    jsonValidator(ReorderMemoriesBody, { error: 'invalid_order' }),
    async (c) => {
      try {
        const { repo, names: requestedNames } = c.req.valid('json')
        const repoPath = await resolveRepoPath(deps.fs, repo, deps.home)
        const configValue = await readYaml(deps.fs, join(repoPath, 'config.yaml'))
        if (
          configValue !== null &&
          (typeof configValue !== 'object' || Array.isArray(configValue))
        ) {
          throw new MemoryRouteError(422, 'invalid_memory_config', 'Memory config is malformed')
        }
        const cfg = (configValue ?? {}) as Record<string, any>
        const memoryNames = await readMemoryNames(deps.fs, repoPath)
        if (memoryNames.some((name) => !NAME_RE.test(name))) {
          throw new MemoryRouteError(
            422,
            'invalid_memory_manifest',
            'Memory files contain an invalid name',
          )
        }
        const current = normalizeOrder(cfg.memory_order, memoryNames)
        const next = normalizeOrder(requestedNames, current)
        if (!sameOrder(current, next)) {
          cfg.memory_order = next
          await writeYaml(deps.fs, join(repoPath, 'config.yaml'), cfg)
        }
        return c.json({ ok: true, names: next })
      } catch (e) {
        if (e instanceof MemoryRouteError)
          return c.json({ ok: false, error: e.code, message: e.message }, e.status)
        memoryLogger.error('memory reorder failed', { err: e })
        return c.json(
          { ok: false, error: 'reorder_failed', message: String((e as Error).message) },
          500,
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
