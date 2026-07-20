import { Hono, type Context, type MiddlewareHandler } from 'hono'
import { join, sep } from 'node:path'
import { AgentIdSchema, normalizeOrder, sameOrder, type AgentId } from '@loom/core'
import { z } from 'zod'
import { readRepoConfig, RepoManifestError, writeYaml } from '../repo-config.js'
import { jsonValidator, queryValidator } from '../request-validation.js'
import type { RouteDeps } from '../router.js'
import { renderAgentAwareText } from '../../vars/agent-aware.js'
import { logger } from '../../lib/logger.js'
import { repositoryErrorResponse } from '../repository-route-error.js'
import { routeErrorResponse } from '../route-error.js'
import { canonicalRepositoryHome, withRepositoryLease } from '../repository-lease.js'
import { resourceLeases } from '../../concurrency/resource-lease-coordinator.js'

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
const MemoryAgentBody = z.object({
  repo: NonEmptyString,
  agent: AgentIdSchema,
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
interface MemoryLeaseContext {
  repoPath: string
  canonicalHome?: string
}

const leasedMemoryContexts = new WeakMap<object, MemoryLeaseContext>()

class MemoryRouteError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 422,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

async function readConfig(fs: RouteDeps['fs'], repoPath: string): Promise<Record<string, any>> {
  return readRepoConfig(fs, repoPath)
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
    cfg.memory_agents &&
    typeof cfg.memory_agents === 'object' &&
    !Array.isArray(cfg.memory_agents)
  ) {
    for (const agent of AgentIdSchema.options) {
      const name = cfg.memory_agents[agent]
      if (typeof name === 'string' && names.includes(name)) assignments[agent] = name
    }
    return assignments
  }
  if (typeof cfg.active_memory === 'string' && names.includes(cfg.active_memory)) {
    for (const agent of Array.isArray(cfg.agents) ? cfg.agents : []) {
      if (AgentIdSchema.safeParse(agent).success) assignments[agent as AgentId] = cfg.active_memory
    }
  }
  return assignments
}

export function createMemoryRoutes(deps: RouteDeps): Hono {
  const app = new Hono()
  const readLease = memoryLease(deps, 'read')
  const mutationLease = memoryLease(deps, 'mutation')
  const previewLease = memoryLease(deps, 'read', true)

  app.get(
    '/memory',
    queryValidator(MemoryQuery, { error: memoryQueryError }),
    readLease('query'),
    async (c) => {
      try {
        const { repo, name: nameQuery } = c.req.valid('query')
        const repoPath = memoryRepoPath(c)
        // ?name=<n> returns single memory raw content (for editing non-active memories)
        if (nameQuery) {
          const file = join(memoriesDir(repoPath), `${nameQuery}.md`)
          if (!(await deps.fs.exists(file)))
            return c.json({ ok: false, error: 'not_found', message: 'memory not found' }, 404)
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
            agents: AgentIdSchema.options.filter((agent) => assignments[agent] === n),
          })),
          assignments,
          active,
          activeContent,
        })
      } catch (e) {
        const repoFailure = memoryRepositoryFailure(c, e, 'memory read')
        if (repoFailure) return repoFailure
        return memoryErrorResponse(c, e, 'memory read failed', {
          code: 'read_failed',
          message: 'failed to read memories',
        })
      }
    },
  )

  app.post(
    '/memory',
    jsonValidator(CreateMemoryBody, { error: memoryBodyError }),
    mutationLease('json'),
    async (c) => {
      try {
        const { repo, name } = c.req.valid('json')
        const repoPath = memoryRepoPath(c)
        const dir = memoriesDir(repoPath)
        await deps.fs.mkdir(dir, true)
        const file = join(dir, `${name}.md`)
        if (await hasMemoryNameConflict(deps.fs, dir, name))
          return c.json({ ok: false, error: 'exists', message: 'memory already exists' }, 409)
        if (!file.startsWith(dir + sep))
          return c.json(
            { ok: false, error: 'invalid_name', message: 'memory name is invalid' },
            400,
          )
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
        const repoFailure = memoryRepositoryFailure(c, e, 'memory create')
        if (repoFailure) return repoFailure
        return memoryErrorResponse(c, e, 'memory create failed', {
          code: 'create_failed',
          message: 'failed to create memory',
        })
      }
    },
  )

  app.delete(
    '/memory',
    queryValidator(RequiredMemoryQuery, { error: memoryQueryError }),
    mutationLease('query'),
    async (c) => {
      try {
        const { repo, name } = c.req.valid('query')
        const repoPath = memoryRepoPath(c)
        const file = join(memoriesDir(repoPath), `${name}.md`)
        if (!(await deps.fs.exists(file)))
          return c.json({ ok: false, error: 'not_found', message: 'memory not found' }, 404)
        const content = await deps.fs.readFile(file)
        const cfg = await readConfig(deps.fs, repoPath)
        const names = await readMemoryNames(deps.fs, repoPath)
        const assignments = memoryAssignments(cfg, names)
        cfg.memory_order = normalizeOrder(cfg.memory_order, names).filter((item) => item !== name)
        if (cfg.active_memory === name) {
          delete cfg.active_memory
        }
        cfg.memory_agents = Object.fromEntries(
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
        const repoFailure = memoryRepositoryFailure(c, e, 'memory delete')
        if (repoFailure) return repoFailure
        return memoryErrorResponse(c, e, 'memory delete failed', {
          code: 'delete_failed',
          message: 'failed to delete memory',
        })
      }
    },
  )

  app.put(
    '/memory/content',
    jsonValidator(MemoryContentBody, { error: memoryContentError }),
    mutationLease('json'),
    async (c) => {
      try {
        const { repo, name, content } = c.req.valid('json')
        const repoPath = memoryRepoPath(c)
        const file = join(memoriesDir(repoPath), `${name}.md`)
        if (!(await deps.fs.exists(file)))
          return c.json({ ok: false, error: 'not_found', message: 'memory not found' }, 404)
        await deps.fs.writeFile(file, content)
        return c.json({ ok: true })
      } catch (e) {
        const repoFailure = memoryRepositoryFailure(c, e, 'memory content write')
        if (repoFailure) return repoFailure
        return memoryErrorResponse(c, e, 'memory content write failed', {
          code: 'write_failed',
          message: 'failed to write memory',
        })
      }
    },
  )

  app.post(
    '/memory/rename',
    jsonValidator(RenameMemoryBody, { error: memoryRenameError }),
    mutationLease('json'),
    async (c) => {
      try {
        const { repo, name, newName } = c.req.valid('json')
        const repoPath = memoryRepoPath(c)
        const dir = memoriesDir(repoPath)
        const oldFile = join(dir, `${name}.md`)
        const newFile = join(dir, `${newName}.md`)
        if (!(await deps.fs.exists(oldFile)))
          return c.json({ ok: false, error: 'not_found', message: 'memory not found' }, 404)
        if (await hasMemoryNameConflict(deps.fs, dir, newName))
          return c.json({ ok: false, error: 'exists', message: 'memory already exists' }, 409)
        if (!newFile.startsWith(dir + sep))
          return c.json(
            { ok: false, error: 'invalid_name', message: 'memory name is invalid' },
            400,
          )
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
        cfg.memory_agents = Object.fromEntries(
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
        const repoFailure = memoryRepositoryFailure(c, e, 'memory rename')
        if (repoFailure) return repoFailure
        return memoryErrorResponse(c, e, 'memory rename failed', {
          code: 'rename_failed',
          message: 'failed to rename memory',
        })
      }
    },
  )

  app.post(
    '/memory/active',
    jsonValidator(ActiveMemoryBody, { error: memoryBodyError }),
    mutationLease('json'),
    async (c) => {
      try {
        const { repo, name } = c.req.valid('json')
        const repoPath = memoryRepoPath(c)
        const cfg = await readConfig(deps.fs, repoPath)
        if (name === null) {
          delete cfg.active_memory
          delete cfg.memory_agents
          await writeYaml(deps.fs, join(repoPath, 'config.yaml'), cfg)
          return c.json({ ok: true })
        }
        const file = join(memoriesDir(repoPath), `${name}.md`)
        if (!(await deps.fs.exists(file)))
          return c.json({ ok: false, error: 'not_found', message: 'memory not found' }, 404)
        cfg.active_memory = name
        if (cfg.memory_agents && typeof cfg.memory_agents === 'object') {
          cfg.memory_agents = Object.fromEntries(
            (Array.isArray(cfg.agents) ? cfg.agents : [])
              .filter((agent) => AgentIdSchema.safeParse(agent).success)
              .map((agent: AgentId) => [agent, name]),
          )
        }
        await writeYaml(deps.fs, join(repoPath, 'config.yaml'), cfg)
        return c.json({ ok: true })
      } catch (e) {
        const repoFailure = memoryRepositoryFailure(c, e, 'memory activation')
        if (repoFailure) return repoFailure
        return memoryErrorResponse(c, e, 'legacy memory activation failed', {
          code: 'activate_failed',
          message: 'failed to activate memory',
        })
      }
    },
  )

  app.put(
    '/memory/agent',
    jsonValidator(MemoryAgentBody, { error: 'invalid_agent' }),
    mutationLease('json'),
    async (c) => {
      try {
        const { repo, agent, name } = c.req.valid('json')
        const repoPath = memoryRepoPath(c)
        const names = await readMemoryNames(deps.fs, repoPath)
        if (name !== null && !names.includes(name))
          return c.json({ ok: false, error: 'not_found', message: 'memory not found' }, 404)
        const cfg = await readConfig(deps.fs, repoPath)
        const assignments = memoryAssignments(cfg, names)
        if (name === null) delete assignments[agent]
        else assignments[agent] = name
        cfg.memory_agents = assignments
        delete cfg.active_memory
        await writeYaml(deps.fs, join(repoPath, 'config.yaml'), cfg)
        return c.json({ ok: true, assignments })
      } catch (e) {
        const repoFailure = memoryRepositoryFailure(c, e, 'memory agent update')
        if (repoFailure) return repoFailure
        return memoryErrorResponse(c, e, 'memory agent update failed', {
          code: 'agent_update_failed',
          message: 'failed to update memory agent',
        })
      }
    },
  )

  app.post(
    '/memory/preview',
    jsonValidator(PreviewMemoryBody, { error: 'invalid_request', message: '请求无效' }),
    previewLease('json'),
    async (c) => {
      try {
        const { repo, content, agent } = c.req.valid('json')
        const repoPath = memoryRepoPath(c)
        const result = await renderAgentAwareText(
          deps.fs,
          memoryCanonicalHome(c),
          repoPath,
          agent,
          content,
        )
        if (!result.ok)
          return c.json(
            {
              ok: false,
              error: 'render_failed',
              message: 'memory could not be rendered',
              diagnostics: result.diagnostics,
            },
            400,
          )
        return c.json({ rendered: result.rendered, diagnostics: [], resolution: result.resolution })
      } catch (e) {
        const repoFailure = memoryRepositoryFailure(c, e, 'memory preview')
        if (repoFailure) return repoFailure
        return memoryErrorResponse(c, e, 'memory preview failed', {
          code: 'render_failed',
          message: 'failed to render memory',
        })
      }
    },
  )

  app.put(
    '/memory/order',
    jsonValidator(ReorderMemoriesBody, { error: 'invalid_order' }),
    mutationLease('json'),
    async (c) => {
      try {
        const { repo, names: requestedNames } = c.req.valid('json')
        const repoPath = memoryRepoPath(c)
        const cfg = await readConfig(deps.fs, repoPath)
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
        const repoFailure = memoryRepositoryFailure(c, e, 'memory reorder')
        if (repoFailure) return repoFailure
        return memoryErrorResponse(c, e, 'memory reorder failed', {
          code: 'reorder_failed',
          message: 'failed to reorder memories',
        })
      }
    },
  )

  return app
}

function memoryLease(deps: RouteDeps, mode: 'read' | 'mutation', includeHome = false) {
  const leases = resourceLeases(deps, deps.leases)
  return (target: 'json' | 'query'): MiddlewareHandler =>
    async (c, next) => {
      let repo: string | undefined
      try {
        repo = (c.req as unknown as { valid(target: 'json' | 'query'): { repo: string } }).valid(
          target,
        ).repo
        const canonicalHome = includeHome ? await canonicalRepositoryHome(deps) : undefined
        const scopedDeps = canonicalHome ? { ...deps, home: canonicalHome, leases } : deps
        await withRepositoryLease(
          scopedDeps,
          repo,
          mode,
          (repoPath) => (canonicalHome ? [repoPath, canonicalHome] : [repoPath]),
          async (repoPath) => {
            leasedMemoryContexts.set(c, { repoPath, canonicalHome })
            try {
              await next()
            } finally {
              leasedMemoryContexts.delete(c)
            }
          },
        )
      } catch (error) {
        const repoFailure = memoryRepositoryFailure(c, error, `memory ${mode} lease`)
        if (repoFailure) return repoFailure
        memoryLogger.error('memory lease failed', { err: error, mode, repo })
        return c.json(
          { ok: false, error: 'memory_lease_failed', message: 'memory operation failed' },
          500,
        )
      }
    }
}

function memoryRepoPath(c: Context): string {
  const context = leasedMemoryContexts.get(c)
  if (!context) throw new Error('Memory route requires an active repository lease')
  return context.repoPath
}

function memoryCanonicalHome(c: Context): string {
  const canonicalHome = leasedMemoryContexts.get(c)?.canonicalHome
  if (!canonicalHome) throw new Error('Memory preview requires an active home lease')
  return canonicalHome
}

function memoryRepositoryFailure(c: Context, error: unknown, operation: string): Response | null {
  return repositoryErrorResponse(
    c,
    error,
    memoryLogger,
    `${operation} repository authorization failed`,
  )
}

function memoryErrorResponse(
  c: Context,
  error: unknown,
  logMessage: string,
  fallback: { code: string; message: string },
): Response {
  return routeErrorResponse(
    c,
    error,
    memoryLogger,
    logMessage,
    (cause) => {
      if (cause instanceof RepoManifestError) {
        return {
          status: 422,
          code: 'invalid_memory_config',
          message: 'memory configuration is invalid',
          diagnostics: cause.diagnostics,
        }
      }
      if (cause instanceof MemoryRouteError) {
        return { status: cause.status, code: cause.code, message: cause.message }
      }
      return null
    },
    { status: 500, ...fallback },
  )
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
