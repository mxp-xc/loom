import { Hono, type Context } from 'hono'
import {
  AgentIdSchema,
  LocalSkillIdSchema,
  LocalSkillSchema,
  changedSkillProjectionDestinations,
  deriveRepoId,
  loadRepoManifest,
  mergeConfig,
  skillProjectionDestinationKey,
  validateManifest,
  type Config,
  type SkillProjectionDestination,
  type SkillsManifest,
} from '@loom/core'
import { z } from 'zod'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { SkillsApplication, SkillsApplicationError } from '../../skills/application.js'
import { logger } from '../../lib/logger.js'
import { jsonValidator } from '../request-validation.js'
import type { RouteDeps } from '../router.js'
import {
  loadSkillsMutationManifest,
  projectRepository,
  projectSkillChanges,
} from '../../projection/workflow.js'
import {
  findSourceNamespaceCollision,
  sourceNamespaceCollisionPayload,
} from '../../projection/errors.js'
import { backupUserOwnedSourceNamespace } from '../../skills/source-namespace-collision.js'
import { LocalSkillBoundaryError } from '../../skills/local-paths.js'
import { repositoryErrorResponse } from '../repository-route-error.js'
import {
  readLocalConfig,
  readSkillsProjectionFiles,
  readSkillsManifest,
  RepoConfigError,
} from '../repo-config.js'
import {
  homeResourceKey,
  projectionResourceKeys,
  skillProjectionDestinationRoots,
  targetedSkillsProjectionResourceKeys,
} from '../../concurrency/resource-keys.js'
import { canonicalRepositoryHome, withRepositoryLease } from '../repository-lease.js'
import { resourceLeases } from '../../concurrency/resource-lease-coordinator.js'
import {
  invalidateSourceRuntimeCatalogs,
  refreshSourceRuntimeCatalogs,
} from '../../remote/source-cache-health.js'

const skillsRouteLogger = logger.child('skills-route')
const RepoField = z.unknown().optional()
const NonEmptyString = z.string().min(1)
const AgentSelection = z.array(AgentIdSchema).superRefine((agents, ctx) => {
  if (new Set(agents).size !== agents.length) {
    ctx.addIssue({ code: 'custom', message: 'agents must be unique' })
  }
})
const SkillProjectionAssignmentBody = z
  .object({
    agents: AgentSelection,
    shared: z.boolean(),
  })
  .strict()

const LocalSkillBody = LocalSkillSchema

const LocalSkillImportItem = z
  .object({
    name: LocalSkillIdSchema,
    path: NonEmptyString,
  })
  .strict()

const LocalSkillWriteItem = z
  .object({
    name: LocalSkillIdSchema,
    files: z.array(z.object({ path: z.string(), content: z.string() }).strict()).default([]),
  })
  .strict()

const ScanLocalSkillsBody = z.object({
  repo: RepoField,
  dir: NonEmptyString,
})

const AddLocalSkillBody = z.object({ repo: RepoField, skill: LocalSkillBody }).strict()

const ImportLocalSkillsBody = z
  .object({
    repo: RepoField,
    skills: z.array(LocalSkillImportItem),
    mode: z.enum(['move', 'ref']).default('ref'),
  })
  .strict()

const WriteLocalSkillsBody = z
  .object({ repo: RepoField, skills: z.array(LocalSkillWriteItem) })
  .strict()

const SourceMemberBody = z.object({
  name: NonEmptyString,
  entry: NonEmptyString,
})

const SourceResourceRuleBody = z.object({
  path: NonEmptyString,
  kind: z.enum(['file', 'directory']),
})

const SourceResourcesBody = z.object({
  include: z.array(SourceResourceRuleBody),
  exclude: z.array(SourceResourceRuleBody),
})

const AddSourceBody = z
  .object({
    repo: RepoField,
    name: z.string().optional(),
    url: NonEmptyString,
    ref: NonEmptyString,
    type: z.enum(['branch', 'tag']).optional(),
    members: z.array(SourceMemberBody).default([]),
    resources: SourceResourcesBody.optional(),
  })
  .strict()

const SourceUrlBody = z.object({
  repo: RepoField,
  url: NonEmptyString,
})

const UpdateSourceBody = SourceUrlBody.extend({
  name: z.string().optional(),
  ref: z.string().optional(),
  type: z.enum(['branch', 'tag']).optional(),
}).strict()
const ReconcileSourceBody = UpdateSourceBody.extend({
  expected_commit: NonEmptyString.optional(),
  members: z.array(SourceMemberBody),
  resources: SourceResourcesBody.optional(),
  preserve: z.array(NonEmptyString).optional(),
})

const DeleteLocalSkillBody = z.object({ repo: RepoField, id: LocalSkillIdSchema }).strict()

const NewAssignmentUpdateBody = z
  .object({
    expected: SkillProjectionAssignmentBody,
    next: SkillProjectionAssignmentBody,
  })
  .strict()
const LegacyAgentUpdateBody = z
  .object({
    expectedAgents: AgentSelection,
    agents: AgentSelection,
  })
  .strict()
const SourceAssignmentUpdateBody = z.union([
  NewAssignmentUpdateBody.extend({ memberEntry: NonEmptyString }),
  LegacyAgentUpdateBody.extend({ memberEntry: NonEmptyString }),
])
const LocalAssignmentUpdateBody = z.union([
  NewAssignmentUpdateBody.extend({ id: LocalSkillIdSchema }),
  LegacyAgentUpdateBody.extend({ id: LocalSkillIdSchema }),
])

const SetSkillAgentsBatchBody = z
  .object({
    repo: RepoField,
    sources: z.array(
      z
        .object({
          sourceUrl: NonEmptyString,
          updates: z.array(SourceAssignmentUpdateBody),
        })
        .strict(),
    ),
    locals: z.array(LocalAssignmentUpdateBody),
  })
  .strict()

const ResolveSourceNamespaceCollisionBody = z
  .object({
    repo: RepoField,
    sourceUrl: NonEmptyString,
    agent: AgentIdSchema,
  })
  .strict()

const ReorderSkillGroupsBody = z.object({
  repo: RepoField,
  ids: z.array(NonEmptyString),
})

export function createSkillsYamlRoutes(deps: RouteDeps): Hono {
  const app = new Hono()
  const leases = resourceLeases(deps, deps.leases)
  const leaseDeps = { ...deps, leases }
  const skills = createSkillsApplication(deps)
  const runRepo = <T>(
    repo: unknown,
    mode: 'read' | 'mutation',
    operation: (repoPath: string) => Promise<T>,
  ) => withRepositoryLease(leaseDeps, repo as string, mode, (repoPath) => [repoPath], operation)
  const runLocalSkillImport = async <T>(
    repo: unknown,
    localSkills: z.infer<typeof ImportLocalSkillsBody>['skills'],
    mode: z.infer<typeof ImportLocalSkillsBody>['mode'],
    operation: (
      repoPath: string,
      scopedDeps: RouteDeps,
      normalizedSkills: z.infer<typeof ImportLocalSkillsBody>['skills'],
    ) => Promise<T>,
  ) => {
    const home = await canonicalRepositoryHome(deps)
    const scopedDeps = { ...leaseDeps, home }
    let normalizedSkills: z.infer<typeof ImportLocalSkillsBody>['skills'] | undefined
    return withRepositoryLease(
      scopedDeps,
      repo as string,
      'mutation',
      async (repoPath) => {
        normalizedSkills = await Promise.all(
          localSkills.map(async (skill) => ({
            ...skill,
            path: await canonicalPhysicalDirectory(deps, resolve(repoPath, skill.path)),
          })),
        )
        const sources = normalizedSkills.map((skill) => skill.path)
        return localSkillInputResourceKeys(home, repoPath, sources, mode === 'move')
      },
      (repoPath) => {
        if (!normalizedSkills) throw new Error('Local skill import lease paths are unavailable')
        return operation(repoPath, scopedDeps, normalizedSkills)
      },
    )
  }
  const runLocalSkillScan = async <T>(
    repo: unknown,
    dir: string,
    operation: (repoPath: string, scanRoot: string) => Promise<T>,
  ) => {
    const home = await canonicalRepositoryHome(deps)
    const scopedDeps = { ...leaseDeps, home }
    let scanRoot: string | undefined
    return withRepositoryLease(
      scopedDeps,
      repo as string,
      'read',
      async (repoPath) => {
        scanRoot = await canonicalPhysicalDirectory(
          deps,
          resolveLocalSkillScanRoot(home, repoPath, dir),
        )
        return localSkillInputResourceKeys(home, repoPath, [scanRoot], false)
      },
      (repoPath) => {
        if (!scanRoot) throw new Error('Local skill scan lease path is unavailable')
        return operation(repoPath, scanRoot)
      },
    )
  }
  const runTargetedSkillsMutation = async <T>(
    repo: unknown,
    destinations: readonly SkillProjectionDestination[],
    operation: (repoPath: string, scopedDeps: RouteDeps) => Promise<T>,
  ) => {
    const home = await canonicalRepositoryHome(deps)
    const scopedDeps = { ...leaseDeps, home }
    return withRepositoryLease(
      scopedDeps,
      repo as string,
      'mutation',
      (repoPath) => targetedSkillsProjectionResourceKeys(home, repoPath, home, destinations),
      (repoPath) => operation(repoPath, scopedDeps),
    )
  }
  const runSkillsMutation = async <T>(
    repo: unknown,
    operation: (repoPath: string, scopedDeps: RouteDeps) => Promise<T>,
  ) => {
    const home = await canonicalRepositoryHome(deps)
    const scopedDeps = { ...leaseDeps, home }
    return withRepositoryLease(
      scopedDeps,
      repo as string,
      'mutation',
      (repoPath) => projectionResourceKeys(home, repoPath, home, 'skills'),
      (repoPath) => operation(repoPath, scopedDeps),
    )
  }

  app.post(
    '/skills/local',
    jsonValidator(AddLocalSkillBody, { error: 'invalid_skill' }),
    async (c) => {
      try {
        const { repo, skill } = c.req.valid('json')
        await runRepo(repo, 'mutation', (repoPath) => skills.addLocalSkill(repoPath, skill))
        return c.json({ ok: true, skill })
      } catch (e) {
        return skillsErrorResponse(c, e, {
          code: 'write_failed',
          message: 'Failed to add local skill',
          logMessage: 'local skill add failed',
        })
      }
    },
  )

  app.post(
    '/skills/local/scan',
    jsonValidator(ScanLocalSkillsBody, { error: 'invalid_dir' }),
    async (c) => {
      try {
        const { dir, repo } = c.req.valid('json')
        const scanned = repo
          ? await runLocalSkillScan(repo, dir, (repoPath, scanRoot) =>
              skills.scanLocalSkills({ dir: scanRoot, repoPath }),
            )
          : await skills.scanLocalSkills({ dir })
        return c.json({ ok: true, skills: scanned })
      } catch (e) {
        return skillsErrorResponse(c, e, {
          code: 'scan_failed',
          message: 'Failed to scan local skills',
          logMessage: 'local skill scan failed',
        })
      }
    },
  )

  app.post(
    '/skills/local/import',
    jsonValidator(ImportLocalSkillsBody, { error: 'invalid_skills' }),
    async (c) => {
      try {
        const { repo, skills: localSkills, mode } = c.req.valid('json')
        const result = await runLocalSkillImport(
          repo,
          localSkills,
          mode,
          (repoPath, scopedDeps, normalizedSkills) =>
            createSkillsApplication(scopedDeps).importLocalSkills(repoPath, {
              skills: normalizedSkills,
              mode,
            }),
        )
        return c.json({ ok: true, count: result.count })
      } catch (e) {
        return skillsErrorResponse(c, e, {
          code: 'import_failed',
          message: 'Failed to import local skills',
          logMessage: 'local skill import failed',
        })
      }
    },
  )

  app.post(
    '/skills/local/write',
    jsonValidator(WriteLocalSkillsBody, { error: 'invalid_skills' }),
    async (c) => {
      try {
        const { repo, skills: localSkills } = c.req.valid('json')
        const result = await runRepo(repo, 'mutation', (repoPath) =>
          skills.writeLocalSkills(repoPath, { skills: localSkills }),
        )
        return c.json({ ok: true, count: result.count })
      } catch (e) {
        return skillsErrorResponse(c, e, {
          code: 'write_failed',
          message: 'Failed to write local skills',
          logMessage: 'local skill write failed',
        })
      }
    },
  )

  app.post('/sources', jsonValidator(AddSourceBody, { error: sourceError }), async (c) => {
    try {
      const { repo, name, url, ref, type, members, resources } = c.req.valid('json')
      const result = await runRepo(repo, 'mutation', async (repoPath) => {
        const added = await skills.addSource(repoPath, {
          name,
          url,
          ref,
          type,
          members,
          resources,
        })
        await refreshSourceCatalogs(deps, repoPath, added.source)
        return added
      })
      return c.json({ ok: true, source: result.source })
    } catch (e) {
      return skillsErrorResponse(c, e, {
        code: 'write_failed',
        message: 'Failed to add source',
        logMessage: 'source add failed',
      })
    }
  })

  app.delete('/sources', jsonValidator(SourceUrlBody, { error: 'invalid_url' }), async (c) => {
    try {
      const { repo, url } = c.req.valid('json')
      await runRepo(repo, 'mutation', async (repoPath) => {
        await skills.removeSource(repoPath, url)
        invalidateSourceRuntimeCatalogs(
          deps.sourceProjectionCatalog,
          deps.sourceCacheHealthCatalog,
          repoPath,
          url,
        )
      })
      return c.json({ ok: true })
    } catch (e) {
      return skillsErrorResponse(c, e, {
        code: 'delete_failed',
        message: 'Failed to remove source',
        logMessage: 'source removal failed',
      })
    }
  })

  app.post(
    '/sources/reconcile',
    jsonValidator(ReconcileSourceBody, { error: updateSourceError }),
    async (c) => {
      const body = c.req.valid('json')
      try {
        const home = await homeResourceKey(deps.fs, deps.home)
        const scopedDeps = { ...deps, home, leases }
        const result = await withRepositoryLease(
          scopedDeps,
          body.repo as string,
          'mutation',
          (repoPath) => projectionResourceKeys(home, repoPath, home, 'skills'),
          async (repoPath) => {
            const reconciled = await createSkillsApplication(scopedDeps).reconcileSource(
              repoPath,
              body,
            )
            if (reconciled.finalized) {
              const manifest = await readSkillsManifest(deps.fs, repoPath)
              const source = manifest.sources?.find((candidate) => candidate.url === body.url)
              if (source) await refreshSourceCatalogs(deps, repoPath, source)
            }
            return reconciled
          },
        )
        return c.json({ ok: true, ...result })
      } catch (e) {
        return skillsErrorResponse(c, e, {
          code: 'reconcile_failed',
          message: 'Failed to reconcile source',
          logMessage: 'source reconciliation failed',
          context: { url: body.url },
        })
      }
    },
  )

  app.delete(
    '/skills/local',
    jsonValidator(DeleteLocalSkillBody, { error: 'invalid_id' }),
    async (c) => {
      try {
        const { repo, id } = c.req.valid('json')
        await runRepo(repo, 'mutation', (repoPath) => skills.removeLocalSkill(repoPath, id))
        return c.json({ ok: true })
      } catch (e) {
        return skillsErrorResponse(c, e, {
          code: 'delete_failed',
          message: 'Failed to remove local skill',
          logMessage: 'local skill removal failed',
        })
      }
    },
  )

  app.post(
    '/skills/agents/batch',
    jsonValidator(SetSkillAgentsBatchBody, { error: 'invalid_agent_batch' }),
    async (c) => {
      try {
        const { repo, sources, locals } = c.req.valid('json')
        const destinations = batchChangedDestinations(sources, locals)
        const result = await runTargetedSkillsMutation(
          repo,
          destinations,
          async (repoPath, scopedDeps) => {
            const manifest = await validateSkillBatchManifest(scopedDeps, repoPath)
            return createSkillsApplication(scopedDeps).setSkillAgentsBatch(
              repoPath,
              {
                sources,
                locals,
              },
              manifest,
            )
          },
        )
        return c.json({ ok: true, ...result })
      } catch (e) {
        return skillsErrorResponse(c, e, {
          code: 'update_failed',
          message: 'Failed to update skill agents',
          logMessage: 'skill agent batch update failed',
        })
      }
    },
  )

  app.post(
    '/skills/source-namespace-collisions/resolve',
    jsonValidator(ResolveSourceNamespaceCollisionBody, { error: 'invalid_collision_resolution' }),
    async (c) => {
      const { repo, sourceUrl, agent } = c.req.valid('json')
      try {
        const result = await runSkillsMutation(repo, async (repoPath, scopedDeps) => {
          const manifest = await readSkillsManifest(scopedDeps.fs, repoPath)
          const source = manifest.sources.find((candidate) => candidate.url === sourceUrl)
          if (!source) {
            throw new SkillsApplicationError(404, 'source_not_found', 'Source not found')
          }
          return backupUserOwnedSourceNamespace(
            scopedDeps,
            repoPath,
            source,
            agent,
            async () => {
              const projected = await projectRepository(scopedDeps, repoPath, { scope: 'skills' })
              if (!projected.ok) throw projected.failure.originalError
            },
            {
              preserveBackupOnProjectionError: (err) => {
                const nextCollision = findSourceNamespaceCollision(err)
                return Boolean(
                  nextCollision &&
                  (nextCollision.agent !== agent || nextCollision.sourceUrl !== source.url),
                )
              },
            },
          )
        })
        return c.json({ ok: true, ...result })
      } catch (e) {
        return skillsErrorResponse(c, e, {
          code: 'collision_resolution_failed',
          message: 'Failed to resolve source namespace collision',
          logMessage: 'source namespace collision resolution failed',
          context: { sourceUrl, agent },
        })
      }
    },
  )

  app.put(
    '/skills/order',
    jsonValidator(ReorderSkillGroupsBody, { error: 'invalid_order' }),
    async (c) => {
      try {
        const { repo, ids } = c.req.valid('json')
        const result = await runRepo(repo, 'mutation', (repoPath) =>
          skills.reorderGroups(repoPath, ids),
        )
        return c.json({ ok: true, ...result })
      } catch (e) {
        return skillsErrorResponse(c, e, {
          code: 'reorder_failed',
          message: 'Failed to reorder skill groups',
          logMessage: 'skill group reorder failed',
        })
      }
    },
  )

  return app
}

function resolveLocalSkillScanRoot(home: string, repoPath: string, dir: string): string {
  const expanded = dir.replace(/^~/, home)
  return resolve(isAbsolute(expanded) ? expanded : join(repoPath, expanded))
}

async function canonicalPhysicalDirectory(deps: RouteDeps, path: string): Promise<string> {
  const entry = await deps.fs.inspectEntry(path)
  if (entry?.kind !== 'directory') return path
  const canonical = resolve(await deps.fs.realPath(path))
  const confirmed = await deps.fs.inspectEntry(path)
  if (confirmed?.kind !== 'directory' || confirmed.identity !== entry.identity) {
    throw new Error(`Local skill lease path identity changed: ${path}`)
  }
  return canonical
}

function localSkillInputResourceKeys(
  home: string,
  repoPath: string,
  inputs: readonly string[],
  includeBuiltInRoot: boolean,
): string[] {
  const sources = inputs.map((path) => resolve(path))
  const overlappingDestinations = skillProjectionDestinationRoots(home).filter((destination) =>
    sources.some(
      (source) => containsPath(destination, source) || containsPath(source, destination),
    ),
  )
  return [
    ...new Set([
      resolve(repoPath),
      resolve(home),
      ...sources,
      ...overlappingDestinations,
      ...(includeBuiltInRoot ? [resolve(repoPath, 'assets', 'skills')] : []),
    ]),
  ]
}

function containsPath(parent: string, child: string): boolean {
  const value = relative(parent, child)
  return value === '' || (!isAbsolute(value) && value !== '..' && !value.startsWith(`..${sep}`))
}

function batchChangedDestinations(
  sources: z.infer<typeof SetSkillAgentsBatchBody>['sources'],
  locals: z.infer<typeof SetSkillAgentsBatchBody>['locals'],
): SkillProjectionDestination[] {
  const destinations = [...sources.flatMap((source) => source.updates), ...locals].flatMap(
    (update) =>
      'expected' in update
        ? changedSkillProjectionDestinations(update.expected, update.next)
        : changedSkillProjectionDestinations(
            { agents: update.expectedAgents },
            { agents: update.agents },
          ),
  )
  return [
    ...new Map(
      destinations.map((destination) => [skillProjectionDestinationKey(destination), destination]),
    ).values(),
  ]
}

async function validateSkillBatchManifest(
  deps: RouteDeps,
  repoPath: string,
): Promise<SkillsManifest> {
  const [files, localConfig] = await Promise.all([
    readSkillsProjectionFiles(deps.fs, repoPath),
    readLocalConfig(deps.fs, deps.home),
  ])
  const repoManifest = loadRepoManifest(files)
  const errors = validateManifest(repoManifest)
  const effectiveConfig = z
    .object({ agents: z.array(AgentIdSchema).optional() })
    .passthrough()
    .safeParse(mergeConfig(repoManifest.repoConfig, localConfig as Config))
  if (!effectiveConfig.success) {
    errors.push(
      ...effectiveConfig.error.issues.map(
        (issue) => `config.${issue.path.join('.')}: ${issue.message}`,
      ),
    )
  }
  if (errors.length > 0) {
    throw new SkillsApplicationError(422, 'invalid_skills_manifest', errors.join('; '))
  }
  return repoManifest.skills
}

function createSkillsApplication(deps: RouteDeps): SkillsApplication {
  return new SkillsApplication(
    deps.fs,
    deps.git,
    deps.home,
    undefined,
    async (repoPath, changes) => {
      const projected = changes
        ? await projectSkillChanges(deps, repoPath, changes)
        : await projectRepository(deps, repoPath, { scope: 'skills' })
      if (!projected.ok) throw projected.failure.originalError
      return projected.warnings
    },
  )
}

async function refreshSourceCatalogs(
  deps: RouteDeps,
  repoPath: string,
  source: Awaited<ReturnType<typeof readSkillsManifest>>['sources'][number],
): Promise<void> {
  try {
    const health = await refreshSourceRuntimeCatalogs(
      deps.fs,
      deps.git,
      deps.sourceProjectionCatalog,
      deps.sourceCacheHealthCatalog,
      repoPath,
      source,
    )
    if (!health.healthy) {
      skillsRouteLogger.error('source cache is unhealthy after source mutation', {
        err: health.err ?? new Error(`Source cache is ${health.reason}`),
        sourceId: deriveRepoId(source.url),
      })
    }
  } catch (err) {
    skillsRouteLogger.error('source runtime catalog refresh failed', {
      err,
      sourceId: deriveRepoId(source.url),
    })
  }
}

function skillsRepositoryFailure(
  c: Context,
  error: unknown,
  logMessage: string,
  context: Record<string, unknown>,
): Response | null {
  return repositoryErrorResponse(c, error, skillsRouteLogger, logMessage, context)
}

function sourceError(issues: z.ZodIssue[]): string {
  const field = issues[0]?.path[0]
  if (field === 'name') return 'invalid_source_name'
  if (field === 'ref') return 'invalid_ref'
  return 'invalid_url'
}

function updateSourceError(issues: z.ZodIssue[]): string {
  const field = issues[0]?.path[0]
  if (field === 'name') return 'invalid_source_name'
  if (field === 'ref') return 'invalid_ref'
  return 'invalid_url'
}

type SkillsErrorStatus = 400 | 404 | 409 | 422 | 500

const SKILLS_ERROR_MESSAGES: Record<SkillsErrorStatus, string> = {
  400: 'Invalid skills request',
  404: 'Skill or source not found',
  409: 'Skills state conflict',
  422: 'Skills configuration is invalid',
  500: 'Skills operation failed',
}

function skillsErrorResponse(
  c: Context,
  error: unknown,
  options: {
    code: string
    message: string
    logMessage: string
    context?: Record<string, unknown>
  },
): Response {
  const context = options.context ?? {}
  const repoFailure = skillsRepositoryFailure(c, error, options.logMessage, context)
  if (repoFailure) return repoFailure

  skillsRouteLogger.error(options.logMessage, { err: error, ...context })
  const collision = findSourceNamespaceCollision(error)
  if (collision) {
    return c.json(sourceNamespaceCollisionPayload(collision), 409)
  }
  if (error instanceof SkillsApplicationError || error instanceof LocalSkillBoundaryError) {
    return c.json(
      { ok: false, error: error.code, message: SKILLS_ERROR_MESSAGES[error.status] },
      error.status,
    )
  }
  if (error instanceof RepoConfigError) {
    return c.json(
      {
        ok: false,
        error: 'invalid_skills_manifest',
        message: SKILLS_ERROR_MESSAGES[422],
      },
      422,
    )
  }
  return c.json({ ok: false, error: options.code, message: options.message }, 500)
}
