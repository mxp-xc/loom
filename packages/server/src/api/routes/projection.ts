import { Hono } from 'hono'
import { join, dirname, basename as pathBasename, isAbsolute } from 'node:path'
import { glob } from 'tinyglobby'
import { executeProjection } from '../../projection/executor.js'
import { scanSourceMembers } from '../../projection/scan.js'
import { mergeLocalSkills } from '../../projection/scan.js'
import {
  loadRepoManifest,
  mergeConfig,
  buildManifest,
  planProjection,
  deriveRepoId,
  type AgentId,
} from '@loom/core'
import { installSkill } from '../../remote/install.js'
import { createDeps } from '../deps.js'
import { readRepoFiles, readLocalConfig } from '../repo-config.js'
import { logger } from '../../lib/logger.js'
import type { RouteDeps } from '../router.js'

// Resolve a local skill path that may be relative (e.g. "./assets/skills/x")
// against the repo root, so SKILL.md reads/writes land in the right place
// regardless of the server's current working directory.
const resolveSkillDir = (localPath: string, repoPath: string) =>
  isAbsolute(localPath) ? localPath : join(repoPath, localPath)

const apiLogger = logger.child('api')

export function createProjectionRoutes(deps: RouteDeps): Hono {
  const app = new Hono()

  app.post('/project', async (c) => {
    const body = await c.req.json()
    const repoPath = body.repoPath
    apiLogger.info('projection started', { repoPath })
    // Detect installed agents
    const allAgents: AgentId[] =
      body.installedAgents ?? (['claude-code', 'codex', 'opencode'] as AgentId[])
    const installed = new Set<AgentId>()
    for (const a of allAgents) {
      try {
        if (await deps.proc.isInstalled(a)) installed.add(a)
      } catch {
        /* proc not available, assume installed */ installed.add(a)
      }
    }
    // Build manifest from repo files if not provided
    let mf = body.manifest
    if (!mf) {
      const files = await readRepoFiles(deps.fs, repoPath)
      const repoManifest = loadRepoManifest(files)
      repoManifest.skills.skills = await mergeLocalSkills(
        deps.fs,
        repoPath,
        repoManifest.skills.skills,
      )
      const localConfig = await readLocalConfig(deps.fs, deps.home)
      mf = buildManifest(repoManifest, localConfig as any)
    }
    // Plan projection (use provided plan or build from manifest)
    const plan = body.plan ?? planProjection(mf, mf.config, installed)
    const projDeps = createDeps(
      { fs: deps.fs, git: deps.git, proc: deps.proc },
      repoPath,
      installed,
    )
    const varsCtx = body.varsCtx ?? {
      env: {},
      activeProfile: mf.vars.active,
      defaultProfile: mf.vars.default,
    }
    const res = await executeProjection(plan, mf, varsCtx, projDeps)
    if (res.ok) {
      apiLogger.info('projection completed', { repoPath })
    } else {
      apiLogger.error('projection failed', {
        repoPath,
        step: res.failure.failedStep,
        err: res.failure.originalError,
      })
    }
    return c.json(res)
  })

  app.get('/manifest', async (c) => {
    const repoPath = c.req.query('repoPath')!
    const files = await readRepoFiles(deps.fs, repoPath)
    const repoManifest = loadRepoManifest(files)
    const localConfig = await readLocalConfig(deps.fs, deps.home)
    // Auto-discover members for sources that have none listed in skills.yaml
    for (const src of repoManifest.skills.sources ?? []) {
      if (src.members && src.members.length > 0) continue
      const repoId = deriveRepoId(src.url)
      const cacheDir = join(repoPath, 'remote-cache', repoId)
      // A source may arrive via sync/pull without a local cache clone.
      // Auto-install so member discovery works on every machine.
      if (!(await deps.fs.exists(cacheDir))) {
        try {
          await installSkill(deps.git, deps.fs, src.url, src.ref, repoPath, repoId)
        } catch (e) {
          apiLogger.error('auto-install failed for source', { url: src.url, err: e })
          continue
        }
      }
      if (!(await deps.fs.exists(cacheDir))) continue
      try {
        const scanned = await scanSourceMembers(deps.fs, cacheDir, { url: src.url, ref: src.ref })
        if (scanned.length > 0) {
          src.members = scanned.map((m) => ({ name: m.name, targets: (src as any).targets ?? [] }))
        }
      } catch {
        /* scan failure: leave members unset */
      }
    }
    // Auto-discover repo-local skills under assets/skills so they show up
    // even when not explicitly listed in skills.yaml.
    repoManifest.skills.skills = await mergeLocalSkills(
      deps.fs,
      repoPath,
      repoManifest.skills.skills,
    )
    const manifest = buildManifest(repoManifest, localConfig as any)
    return c.json(manifest)
  })

  app.get('/skill/content', async (c) => {
    try {
      const repoPath = c.req.query('repoPath')!
      const skillId = c.req.query('skillId')!
      const sourceUrl = c.req.query('sourceUrl') ?? ''
      const localPath = c.req.query('localPath') ?? ''

      let skillDir: string | null = null
      if (sourceUrl) {
        const repoId = deriveRepoId(sourceUrl)
        const memberName = skillId.startsWith(repoId + '-')
          ? skillId.slice(repoId.length + 1)
          : skillId.startsWith(repoId + '/')
            ? skillId.slice(repoId.length + 1)
            : skillId
        const cacheDir = join(repoPath, 'remote-cache', repoId)
        if (await deps.fs.exists(cacheDir)) {
          const matches = await glob('**/SKILL.md', {
            cwd: cacheDir,
            ignore: ['**/.git/**', '**/node_modules/**'],
            onlyFiles: true,
          })
          const found = matches.find((m) => pathBasename(dirname(m)) === memberName)
          if (found) skillDir = join(cacheDir, dirname(found))
        }
      } else if (localPath) {
        skillDir = resolveSkillDir(localPath, repoPath)
      } else {
        // Try ~/.agents/skills/<skillId> first, then fall back to repo assets
        // Repo assets/skills is the canonical home for local skills;
        // ~/.agents/skills is a legacy fallback.
        const assetsDir = join(repoPath, 'assets', 'skills', skillId)
        if (await deps.fs.exists(assetsDir)) {
          skillDir = assetsDir
        } else {
          const agentsDir = join(deps.home, '.agents', 'skills', skillId)
          if (await deps.fs.exists(agentsDir)) skillDir = agentsDir
        }
      }
      if (skillDir) {
        const skillFile = join(skillDir, 'SKILL.md')
        try {
          const content = await deps.fs.readFile(skillFile)
          return c.json({ ok: true, content, path: skillFile })
        } catch {
          /* fall through */
        }
      }
      return c.json({ ok: false, error: 'not_found', message: `SKILL.md not found for ${skillId}` })
    } catch (e) {
      return c.json({
        ok: false,
        error: 'read_failed',
        message: String((e as Error)?.message ?? e),
      })
    }
  })

  app.put('/skill/content', async (c) => {
    try {
      const { repoPath, skillId, sourceUrl, localPath, content } = await c.req.json()
      if (sourceUrl)
        return c.json({ ok: false, error: 'read_only', message: 'source skills are read-only' })

      let skillDir: string | null = null
      if (localPath) {
        skillDir = resolveSkillDir(localPath, repoPath)
      } else {
        // Try ~/.agents/skills/<skillId> first, then fall back to repo assets
        // Repo assets/skills is the canonical home for local skills;
        // ~/.agents/skills is a legacy fallback.
        const assetsDir = join(repoPath, 'assets', 'skills', skillId)
        if (await deps.fs.exists(assetsDir)) {
          skillDir = assetsDir
        } else {
          const agentsDir = join(deps.home, '.agents', 'skills', skillId)
          if (await deps.fs.exists(agentsDir)) skillDir = agentsDir
        }
      }
      if (!skillDir) return c.json({ ok: false, error: 'invalid_path' })

      const skillFile = join(skillDir, 'SKILL.md')
      await deps.fs.writeFile(skillFile, content)
      return c.json({ ok: true, path: skillFile })
    } catch (e) {
      apiLogger.error('failed to save skill content', { err: e })
      return c.json({
        ok: false,
        error: 'write_failed',
        message: String((e as Error)?.message ?? e),
      })
    }
  })

  return app
}
