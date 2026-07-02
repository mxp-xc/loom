import { Hono } from 'hono'
import { join } from 'node:path'
import {
  deriveRepoId,
  addLocalSkill,
  removeLocalSkill,
  addSource,
  removeSource,
  setSourceMembers,
  setSkillTargets,
  setLocalSkillTargets,
} from '@loom/core'
import { installSkill } from '../../remote/install.js'
import { readYaml, writeYaml } from '../repo-config.js'
import { logger } from '../../lib/logger.js'
import type { RouteDeps } from '../router.js'

const remoteLogger = logger.child('remote')

export function createSkillsYamlRoutes(deps: RouteDeps): Hono {
  const app = new Hono()

  app.post('/skills/local', async (c) => {
    try {
      const { repoPath, skill } = await c.req.json()
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

  app.post('/sources', async (c) => {
    try {
      const { repoPath, url, ref } = await c.req.json()
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
      const { repoPath, url, members } = await c.req.json()
      if (!url || typeof url !== 'string') return c.json({ ok: false, error: 'invalid_url' }, 400)
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
      const { repoPath, url } = await c.req.json()
      if (!url || typeof url !== 'string') return c.json({ ok: false, error: 'invalid_url' }, 400)
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

  app.delete('/skills/local', async (c) => {
    try {
      const { repoPath, id } = await c.req.json()
      if (!id || typeof id !== 'string') return c.json({ ok: false, error: 'invalid_id' }, 400)
      const filePath = join(repoPath, 'skills.yaml')
      const data = (await readYaml(deps.fs, filePath)) ?? { sources: [], skills: [] }
      const result = removeLocalSkill(data, id)
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

  app.post('/skills/targets', async (c) => {
    try {
      const { repoPath, sourceUrl, memberName, targets } = await c.req.json()
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
      const { repoPath, id, targets } = await c.req.json()
      if (!id || typeof id !== 'string') return c.json({ ok: false, error: 'invalid_id' }, 400)
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
