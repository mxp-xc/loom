import { Hono } from 'hono'
import { join, isAbsolute, dirname } from 'node:path'
import {
  deriveRepoId,
  addLocalSkill,
  removeLocalSkill,
  addSource,
  removeSource,
  setSourceMembers,
  updateSourceMeta,
  setSkillTargets,
  setLocalSkillTargets,
} from '@loom/core'
import { installSkill } from '../../remote/install.js'
import { readYaml, writeYaml } from '../repo-config.js'
import { resolveRepoPath } from '../repo.js'
import { logger } from '../../lib/logger.js'
import type { RouteDeps } from '../router.js'

const remoteLogger = logger.child('remote')

export function createSkillsYamlRoutes(deps: RouteDeps): Hono {
  const app = new Hono()

  app.post('/skills/local', async (c) => {
    try {
      const { repo, skill } = await c.req.json()
      let repoPath: string
      try {
        repoPath = await resolveRepoPath(deps.fs, repo, deps.home)
      } catch (e) {
        return c.json(
          { ok: false, error: 'invalid_repo', message: String((e as Error).message) },
          400,
        )
      }
      const filePath = join(repoPath, 'skills.yaml')
      const data = (await readYaml(deps.fs, filePath)) ?? { sources: [], skills: [] }
      const result = addLocalSkill(data, skill)
      if (result.changed) await writeYaml(deps.fs, filePath, result.data)
      return c.json({ ok: true, skill })
    } catch (e) {
      return c.json({
        ok: false,
        error: 'write_failed',
        message: String((e as Error)?.message ?? e),
      })
    }
  })

  app.post('/skills/local/scan', async (c) => {
    try {
      const { dir, repo } = await c.req.json()
      if (!dir || typeof dir !== 'string') return c.json({ ok: false, error: 'invalid_dir' }, 400)
      let repoPath: string | undefined
      try {
        if (repo) repoPath = await resolveRepoPath(deps.fs, repo, deps.home)
      } catch (e) {
        return c.json(
          { ok: false, error: 'invalid_repo', message: String((e as Error).message) },
          400,
        )
      }
      const { glob } = await import('tinyglobby')
      const { basename, dirname } = await import('node:path')
      let resolvedDir = dir.replace(/^~/, deps.home)
      // Relative paths (e.g. "assets/skills") resolve against the repo root,
      // so the default scan target lands inside the managed repo.
      if (!isAbsolute(resolvedDir) && repoPath) resolvedDir = join(repoPath, resolvedDir)
      if (!(await deps.fs.exists(resolvedDir))) {
        return c.json({ ok: true, skills: [] })
      }
      const matches = await glob('**/SKILL.md', {
        cwd: resolvedDir,
        ignore: ['**/.git/**', '**/node_modules/**'],
        onlyFiles: true,
      })
      const skills = matches
        .map((m) => ({ name: basename(dirname(m)), path: join(resolvedDir, dirname(m)) }))
        .sort((a, b) => a.name.localeCompare(b.name))
      return c.json({ ok: true, skills })
    } catch (e) {
      return c.json({
        ok: false,
        error: 'scan_failed',
        message: String((e as Error)?.message ?? e),
      })
    }
  })

  app.post('/skills/local/import', async (c) => {
    try {
      const { repo, skills, mode } = await c.req.json()
      if (!Array.isArray(skills)) return c.json({ ok: false, error: 'invalid_skills' }, 400)
      let repoPath: string
      try {
        repoPath = await resolveRepoPath(deps.fs, repo, deps.home)
      } catch (e) {
        return c.json(
          { ok: false, error: 'invalid_repo', message: String((e as Error).message) },
          400,
        )
      }
      // Local skills canonical home is <repo>/assets/skills — this is where
      // projection (resolveSkillSrc) looks for them, and it git-syncs.
      const assetsSkillsDir = join(repoPath, 'assets', 'skills')
      const assetsSkillsPrefix = assetsSkillsDir.replace(/\\/g, '/').replace(/\/+$/, '')
      const filePath = join(repoPath, 'skills.yaml')
      const data = (await readYaml(deps.fs, filePath)) ?? { sources: [], skills: [] }

      for (const skill of skills) {
        const skillPath = String(skill.path ?? '')
          .replace(/\\/g, '/')
          .replace(/\/+$/, '')
        const isRepoAssetSkill =
          skillPath === assetsSkillsPrefix + '/' + skill.name ||
          skillPath.startsWith(assetsSkillsPrefix + '/' + skill.name + '/')
        if (mode === 'move') {
          const dest = join(assetsSkillsDir, skill.name)
          if (await deps.fs.exists(dest)) {
            return c.json({
              ok: false,
              error: 'already_exists',
              message: `Skill \`${skill.name}\` already exists in assets/skills`,
            })
          }
          await deps.fs.mkdir(assetsSkillsDir, true)
          await deps.fs.move(skill.path, dest)
          const result = addLocalSkill(data, { id: skill.name })
          if (result.changed) Object.assign(data, result.data)
        } else {
          const result = addLocalSkill(
            data,
            isRepoAssetSkill ? { id: skill.name } : { id: skill.name, path: skill.path },
          )
          if (result.changed) Object.assign(data, result.data)
        }
      }
      await writeYaml(deps.fs, filePath, data)
      return c.json({ ok: true, count: skills.length })
    } catch (e) {
      return c.json({
        ok: false,
        error: 'import_failed',
        message: String((e as Error)?.message ?? e),
      })
    }
  })

  // Import local skills by writing their file contents directly into
  // <repo>/assets/skills/<name>/. Used by the folder picker flow, which
  // reads files client-side (the web File API hides absolute paths) and
  // ships the content here so it lands in the git-synced repo.
  app.post('/skills/local/write', async (c) => {
    try {
      const { repo, skills } = await c.req.json()
      if (!Array.isArray(skills)) return c.json({ ok: false, error: 'invalid_skills' }, 400)
      let repoPath: string
      try {
        repoPath = await resolveRepoPath(deps.fs, repo, deps.home)
      } catch (e) {
        return c.json(
          { ok: false, error: 'invalid_repo', message: String((e as Error).message) },
          400,
        )
      }
      const assetsSkillsDir = join(repoPath, 'assets', 'skills')
      const filePath = join(repoPath, 'skills.yaml')
      const data = (await readYaml(deps.fs, filePath)) ?? { sources: [], skills: [] }

      for (const skill of skills) {
        const dest = join(assetsSkillsDir, skill.name)
        if (await deps.fs.exists(dest)) {
          return c.json({
            ok: false,
            error: 'already_exists',
            message: `Skill \`${skill.name}\` already exists in assets/skills`,
          })
        }
        await deps.fs.mkdir(dest, true)
        for (const f of Array.isArray(skill.files) ? skill.files : []) {
          const rel = String(f.path).replace(/^[/\\]+/, '')
          if (!rel || rel.includes('..')) continue
          const target = join(dest, rel)
          await deps.fs.mkdir(dirname(target), true)
          await deps.fs.writeFile(target, String(f.content ?? ''))
        }
        const result = addLocalSkill(data, { id: skill.name })
        if (result.changed) Object.assign(data, result.data)
      }
      await writeYaml(deps.fs, filePath, data)
      return c.json({ ok: true, count: skills.length })
    } catch (e) {
      return c.json({
        ok: false,
        error: 'import_failed',
        message: String((e as Error)?.message ?? e),
      })
    }
  })

  app.post('/sources', async (c) => {
    try {
      const { repo, url, ref } = await c.req.json()
      let repoPath: string
      try {
        repoPath = await resolveRepoPath(deps.fs, repo, deps.home)
      } catch (e) {
        return c.json(
          { ok: false, error: 'invalid_repo', message: String((e as Error).message) },
          400,
        )
      }
      const filePath = join(repoPath, 'skills.yaml')
      const data = (await readYaml(deps.fs, filePath)) ?? { sources: [], skills: [] }
      const result = addSource(data, { url, ref })
      if (result.changed) await writeYaml(deps.fs, filePath, result.data)
      // Auto-clone source repo to remote-cache so SKILL.md content is available
      const sourceId = deriveRepoId(url)
      try {
        await installSkill(deps.git, deps.fs, url, ref, repoPath, sourceId)
      } catch (installErr) {
        // Clone failure shouldn't block source creation; user can retry via check/scan
        remoteLogger.error('auto-install failed for source', { err: installErr, url })
      }
      return c.json({ ok: true, source: { url, ref } })
    } catch (e) {
      return c.json({
        ok: false,
        error: 'write_failed',
        message: String((e as Error)?.message ?? e),
      })
    }
  })

  // Write the selected member list for a source into skills.yaml, replacing
  // whatever was there before. Called after the user picks members in the
  // scan popup. Preserves existing per-member targets/enabled where possible.
  app.post('/sources/members', async (c) => {
    try {
      const { repo, url, members } = await c.req.json()
      if (!url || typeof url !== 'string') return c.json({ ok: false, error: 'invalid_url' }, 400)
      let repoPath: string
      try {
        repoPath = await resolveRepoPath(deps.fs, repo, deps.home)
      } catch (e) {
        return c.json(
          { ok: false, error: 'invalid_repo', message: String((e as Error).message) },
          400,
        )
      }
      const memberNames: string[] = Array.isArray(members) ? members : []
      const filePath = join(repoPath, 'skills.yaml')
      const data = (await readYaml(deps.fs, filePath)) ?? { sources: [], skills: [] }
      const result = setSourceMembers(data, url, memberNames)
      if (result.changed) {
        await writeYaml(deps.fs, filePath, result.data)
      } else {
        return c.json({ ok: false, error: 'not_found', message: `Source ${url} not found` })
      }
      return c.json({ ok: true })
    } catch (e) {
      return c.json({
        ok: false,
        error: 'write_failed',
        message: String((e as Error)?.message ?? e),
      })
    }
  })

  app.delete('/sources', async (c) => {
    try {
      const { repo, url } = await c.req.json()
      if (!url || typeof url !== 'string') return c.json({ ok: false, error: 'invalid_url' }, 400)
      let repoPath: string
      try {
        repoPath = await resolveRepoPath(deps.fs, repo, deps.home)
      } catch (e) {
        return c.json(
          { ok: false, error: 'invalid_repo', message: String((e as Error).message) },
          400,
        )
      }
      const filePath = join(repoPath, 'skills.yaml')
      const data = (await readYaml(deps.fs, filePath)) ?? { sources: [], skills: [] }
      const result = removeSource(data, url)
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

  app.post('/sources/update', async (c) => {
    try {
      const { repo, url, ref, type } = await c.req.json()
      if (!url || typeof url !== 'string') return c.json({ ok: false, error: 'invalid_url' }, 400)
      let repoPath: string
      try {
        repoPath = await resolveRepoPath(deps.fs, repo, deps.home)
      } catch (e) {
        return c.json(
          { ok: false, error: 'invalid_repo', message: String((e as Error).message) },
          400,
        )
      }
      const filePath = join(repoPath, 'skills.yaml')
      const data = (await readYaml(deps.fs, filePath)) ?? { sources: [], skills: [] }
      const updates: { ref?: string; type?: 'branch' | 'tag' } = {}
      if (typeof ref === 'string') updates.ref = ref
      if (type === 'branch' || type === 'tag') updates.type = type
      const result = updateSourceMeta(data, url, updates)
      if (result.changed) {
        await writeYaml(deps.fs, filePath, result.data)
        return c.json({ ok: true })
      } else {
        return c.json({ ok: false, error: 'not_found', message: `Source ${url} not found` })
      }
    } catch (e) {
      return c.json({
        ok: false,
        error: 'update_failed',
        message: String((e as Error)?.message ?? e),
      })
    }
  })

  app.delete('/skills/local', async (c) => {
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
      const filePath = join(repoPath, 'skills.yaml')
      const data = (await readYaml(deps.fs, filePath)) ?? { sources: [], skills: [] }
      // Pathless skills live in <repo>/assets/skills/<id>; removing the yaml
      // entry should also delete that directory. ref skills keep an external
      // path and their files are left untouched.
      const existing = data.skills.find((s: { id: string; path?: string }) => s.id === id)
      const result = removeLocalSkill(data, id)
      if (result.changed) await writeYaml(deps.fs, filePath, result.data)
      if (!existing?.path) {
        const dir = join(repoPath, 'assets', 'skills', id)
        if (await deps.fs.exists(dir)) await deps.fs.removeDir(dir)
      }
      return c.json({ ok: true })
    } catch (e) {
      return c.json({
        ok: false,
        error: 'delete_failed',
        message: String((e as Error)?.message ?? e),
      })
    }
  })

  app.post('/skills/targets', async (c) => {
    try {
      const { repo, sourceUrl, memberName, targets } = await c.req.json()
      let repoPath: string
      try {
        repoPath = await resolveRepoPath(deps.fs, repo, deps.home)
      } catch (e) {
        return c.json(
          { ok: false, error: 'invalid_repo', message: String((e as Error).message) },
          400,
        )
      }
      const filePath = join(repoPath, 'skills.yaml')
      const data = (await readYaml(deps.fs, filePath)) ?? { sources: [], skills: [] }
      const result = setSkillTargets(data, sourceUrl, memberName, targets)
      if (result.changed) {
        await writeYaml(deps.fs, filePath, result.data)
      } else {
        return c.json({ ok: false, error: 'not_found', message: `Source ${sourceUrl} not found` })
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

  app.post('/skills/local/targets', async (c) => {
    try {
      const { repo, id, targets } = await c.req.json()
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
      const filePath = join(repoPath, 'skills.yaml')
      const data = (await readYaml(deps.fs, filePath)) ?? { sources: [], skills: [] }
      const result = setLocalSkillTargets(data, id, targets)
      if (result.changed) {
        await writeYaml(deps.fs, filePath, result.data)
      } else {
        return c.json({ ok: false, error: 'not_found', message: `Local skill ${id} not found` })
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
