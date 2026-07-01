import { Hono } from 'hono'
import { join, dirname, basename as pathBasename } from 'node:path'
import { simpleGit } from 'simple-git'
import { glob } from 'tinyglobby'
import { executeProjection } from '../projection/executor.js'
import { scanSourceMembers } from '../projection/scan.js'
import { syncPull } from '../sync/pull.js'
import { applyResolutions } from '../sync/pull.js'
import { syncPush } from '../sync/push.js'
import { installSkill } from '../remote/install.js'
import { checkUpdates, performUpdate } from '../remote/update.js'
import {
  loadRepoManifest,
  mergeConfig,
  buildManifest,
  planProjection,
  type AgentId,
} from '@loom/core'
import { createNodePlatform } from '../platform/node/index.js'
import { initLoom } from '../platform/node/init.js'
import { createDeps } from './deps.js'

async function readRepoFiles(
  fs: {
    readFile: (p: string) => Promise<string>
    exists: (p: string) => Promise<boolean>
    readDir: (p: string) => Promise<string[]>
  },
  repoPath: string,
): Promise<Record<string, string>> {
  const files: Record<string, string> = {}
  for (const p of ['config.yaml', 'skills.yaml', 'mcp.yaml']) {
    try {
      files[p] = await fs.readFile(join(repoPath, p))
    } catch {
      /* missing */
    }
  }
  try {
    const varsDir = join(repoPath, 'vars')
    if (await fs.exists(varsDir)) {
      for (const f of await fs.readDir(varsDir)) {
        if (f.endsWith('.yaml')) {
          try {
            files[`vars/${f}`] = await fs.readFile(join(varsDir, f))
          } catch {
            /* skip */
          }
        }
      }
    }
  } catch {
    /* no vars dir */
  }
  return files
}

async function readLocalConfig(
  fs: { readFile: (p: string) => Promise<string>; exists: (p: string) => Promise<boolean> },
  home: string,
): Promise<Record<string, unknown>> {
  try {
    const yaml = await import('js-yaml')
    const raw = await fs.readFile(join(home, '.loom', 'config.yaml'))
    return yaml.load(raw) as Record<string, unknown>
  } catch {
    return {}
  }
}

// -- YAML helpers for skills.yaml / mcp.yaml append operations --

async function readYaml(
  fs: { readFile: (p: string) => Promise<string>; exists: (p: string) => Promise<boolean> },
  filePath: string,
): Promise<any> {
  const yaml = await import('js-yaml')
  if (!(await fs.exists(filePath))) return null
  const raw = await fs.readFile(filePath)
  return yaml.load(raw) ?? null
}

async function writeYaml(
  fs: { writeFile: (p: string, content: string) => Promise<void> },
  filePath: string,
  data: any,
): Promise<void> {
  const yaml = await import('js-yaml')
  await fs.writeFile(filePath, yaml.dump(data) + '\n')
}

// -- Git remote helpers (using simple-git directly for commands not on IGit) --

async function gitAddOrUpdateRemote(repoPath: string, remoteUrl: string): Promise<void> {
  const sg = simpleGit(repoPath)
  try {
    await sg.raw(['remote', 'add', 'origin', remoteUrl])
  } catch {
    // origin already exists, update the URL
    await sg.raw(['remote', 'set-url', 'origin', remoteUrl])
  }
}

async function gitGetRemoteUrl(repoPath: string): Promise<string | null> {
  try {
    const sg = simpleGit(repoPath)
    const out = await sg.raw(['remote', 'get-url', 'origin'])
    return out.trim() || null
  } catch {
    return null
  }
}

function deriveRepoId(url: string): string {
  const parts = url.split(':')
  return parts[parts.length - 1]
    .split('/')
    .pop()!
    .replace(/\.git$/, '')
}

export function registerRoutes(): Hono {
  const app = new Hono()

  app.get('/health', (c) => c.json({ ok: true }))

  app.post('/init', async (c) => {
    const { fs, git } = createNodePlatform()
    const home = process.env.HOME || process.env.USERPROFILE || ''
    await initLoom(home, fs, git)
    const localConfig = await readLocalConfig(fs, home)
    const activeRepo = (localConfig.active_repo as string) ?? 'default'
    return c.json({
      ok: true,
      active_repo: activeRepo,
      repoPath: join(home, '.loom', 'repos', activeRepo),
    })
  })

  app.get('/status', async (c) => {
    const { fs } = createNodePlatform()
    const home = process.env.HOME || process.env.USERPROFILE || ''
    const localConfig = await readLocalConfig(fs, home)
    const activeRepo = (localConfig.active_repo as string) ?? 'default'
    return c.json({ active_repo: activeRepo, repoPath: join(home, '.loom', 'repos', activeRepo) })
  })

  app.post('/project', async (c) => {
    const body = await c.req.json()
    const repoPath = body.repoPath
    const { proc } = createNodePlatform()
    // Detect installed agents
    const allAgents: AgentId[] =
      body.installedAgents ?? (['claude-code', 'codex', 'opencode'] as AgentId[])
    const installed = new Set<AgentId>()
    for (const a of allAgents) {
      try {
        if (await proc.isInstalled(a)) installed.add(a)
      } catch {
        /* proc not available, assume installed */ installed.add(a)
      }
    }
    // Build manifest from repo files if not provided
    let mf = body.manifest
    if (!mf) {
      const { fs } = createNodePlatform()
      const files = await readRepoFiles(fs, repoPath)
      const repoManifest = loadRepoManifest(files)
      const home = process.env.HOME || process.env.USERPROFILE || ''
      const localConfig = await readLocalConfig(fs, home)
      mf = buildManifest(repoManifest, localConfig as any)
    }
    // Plan projection (use provided plan or build from manifest)
    const plan = body.plan ?? planProjection(mf, mf.config, installed)
    const deps = createDeps(repoPath, installed)
    const varsCtx = body.varsCtx ?? {
      env: {},
      activeProfile: mf.vars.active,
      defaultProfile: mf.vars.default,
    }
    const res = await executeProjection(plan, mf, varsCtx, deps)
    return c.json(res)
  })

  app.post('/sync/pull', async (c) => {
    try {
      const { repoPath } = await c.req.json()
      const { git, fs } = createNodePlatform()
      const res = await syncPull(repoPath, git, fs, {
        error: (o, m) => console.error(m, o),
        warn: (o, m) => console.warn(m, o),
      })
      return c.json({ ok: true, ...res })
    } catch (e) {
      const msg = String(e?.message ?? e)
      const noRemote =
        /no remote|could not find remote|not a git repository|does not appear to be a git/i.test(
          msg,
        )
      return c.json({ ok: false, error: noRemote ? 'no_remote' : 'other', message: msg })
    }
  })

  app.post('/sync/apply', async (c) => {
    try {
      const { repoPath, resolutions } = await c.req.json()
      const { git, fs } = createNodePlatform()
      await applyResolutions(repoPath, git, fs, resolutions, {
        error: (o, m) => console.error(m, o),
        warn: (o, m) => console.warn(m, o),
      })
      return c.json({ ok: true })
    } catch (e) {
      const msg = String(e?.message ?? e)
      return c.json({ ok: false, error: 'apply_failed', message: msg })
    }
  })

  app.post('/sync/push', async (c) => {
    try {
      const { repoPath } = await c.req.json()
      const { git } = createNodePlatform()
      // Auto-commit uncommitted yaml changes before pushing
      const status = await git.status(repoPath)
      if (status.dirty) {
        await git.add(repoPath, ['.'])
        await git.commit(repoPath, 'loom: sync changes')
      }
      const res = await syncPush(repoPath, git)
      return c.json(res)
    } catch (e) {
      const msg = String(e?.message ?? e)
      const noRemote =
        /no remote|could not find remote|not a git repository|does not appear to be a git/i.test(
          msg,
        )
      return c.json({ ok: false, error: noRemote ? 'no_remote' : 'other', message: msg })
    }
  })

  app.post('/install', async (c) => {
    const { url, ref, repoPath, sourceId } = await c.req.json()
    const { git, fs } = createNodePlatform()
    const res = await installSkill(git, fs, url, ref, repoPath, sourceId)
    return c.json(res)
  })

  app.post('/update', async (c) => {
    const { sources } = await c.req.json()
    const { git } = createNodePlatform()
    const updates = await checkUpdates(sources, git)
    return c.json({ updates })
  })

  app.post('/update/perform', async (c) => {
    const body = await c.req.json()
    const { git, fs } = createNodePlatform()
    const res = await performUpdate(
      git,
      fs,
      body.source,
      body.newRef,
      body.repoPath,
      body.sourceId,
      body.oldMembers,
    )
    return c.json(res)
  })

  app.get('/config', async (c) => {
    const repoPath = c.req.query('repoPath')!
    const { fs } = createNodePlatform()
    const files = await readRepoFiles(fs, repoPath)
    const repoManifest = loadRepoManifest(files)
    const home = process.env.HOME || process.env.USERPROFILE || ''
    const localConfig = await readLocalConfig(fs, home)
    const effective = mergeConfig(repoManifest.repoConfig, localConfig as any)
    return c.json({ effective, repo: repoManifest.repoConfig, local: localConfig })
  })

  app.get('/manifest', async (c) => {
    const repoPath = c.req.query('repoPath')!
    const { fs } = createNodePlatform()
    const files = await readRepoFiles(fs, repoPath)
    const repoManifest = loadRepoManifest(files)
    const home = process.env.HOME || process.env.USERPROFILE || ''
    const localConfig = await readLocalConfig(fs, home)
    // Auto-discover members for sources that have none listed in skills.yaml
    for (const src of repoManifest.skills.sources ?? []) {
      if (src.members && src.members.length > 0) continue
      const repoId = deriveRepoId(src.url)
      const cacheDir = join(repoPath, 'remote-cache', repoId)
      if (!(await fs.exists(cacheDir))) continue
      try {
        const scanned = await scanSourceMembers(fs, cacheDir, { url: src.url, ref: src.ref })
        if (scanned.length > 0) {
          src.members = scanned.map((m) => ({ name: m.name, targets: src.targets ?? [] }))
        }
      } catch {
        /* scan failure: leave members unset */
      }
    }
    const manifest = buildManifest(repoManifest, localConfig as any)
    return c.json(manifest)
  })

  app.get('/skill/content', async (c) => {
    try {
      const repoPath = c.req.query('repoPath')!
      const skillId = c.req.query('skillId')!
      const sourceUrl = c.req.query('sourceUrl') ?? ''
      const localPath = c.req.query('localPath') ?? ''
      const { fs } = createNodePlatform()

      let skillDir: string | null = null
      if (sourceUrl) {
        const repoId = deriveRepoId(sourceUrl)
        const memberName = skillId.startsWith(repoId + '-')
          ? skillId.slice(repoId.length + 1)
          : skillId
        const cacheDir = join(repoPath, 'remote-cache', repoId)
        if (await fs.exists(cacheDir)) {
          const matches = await glob('**/SKILL.md', {
            cwd: cacheDir,
            ignore: ['**/.git/**', '**/node_modules/**'],
            onlyFiles: true,
          })
          const found = matches.find((m) => pathBasename(dirname(m)) === memberName)
          if (found) skillDir = join(cacheDir, dirname(found))
        }
      } else if (localPath) {
        skillDir = localPath
      } else {
        skillDir = join(repoPath, 'assets', 'skills', skillId)
      }
      if (skillDir) {
        const skillFile = join(skillDir, 'SKILL.md')
        try {
          const content = await fs.readFile(skillFile)
          return c.json({ ok: true, content, path: skillFile })
        } catch {
          /* fall through */
        }
      }
      return c.json({ ok: false, error: 'not_found', message: `SKILL.md not found for ${skillId}` })
    } catch (e) {
      return c.json({ ok: false, error: 'read_failed', message: String(e?.message ?? e) })
    }
  })

  app.put('/skill/content', async (c) => {
    try {
      const { repoPath, skillId, sourceUrl, localPath, content } = await c.req.json()
      if (sourceUrl)
        return c.json({ ok: false, error: 'read_only', message: 'source skills are read-only' })
      const { fs } = createNodePlatform()

      let skillDir: string | null = null
      if (localPath) {
        skillDir = localPath
      } else {
        skillDir = join(repoPath, 'assets', 'skills', skillId)
      }
      if (!skillDir) return c.json({ ok: false, error: 'invalid_path' })

      const skillFile = join(skillDir, 'SKILL.md')
      await fs.writeFile(skillFile, content)
      return c.json({ ok: true, path: skillFile })
    } catch (e) {
      logger.error({ err: e }, 'Failed to save skill content')
      return c.json({ ok: false, error: 'write_failed', message: String(e?.message ?? e) })
    }
  })

  app.put('/config', async (c) => {
    try {
      const { repoPath, level, field, value } = await c.req.json()
      if (level !== 'repo' && level !== 'local')
        return c.json({ ok: false, error: 'invalid_level' }, 400)
      if (!field || typeof field !== 'string')
        return c.json({ ok: false, error: 'invalid_field' }, 400)
      const { fs } = createNodePlatform()
      const home = process.env.HOME || process.env.USERPROFILE || ''

      if (level === 'local') {
        const localPath = join(home, '.loom', 'config.yaml')
        const data = (await readYaml(fs, localPath)) ?? {}
        if (value === null) delete data[field]
        else data[field] = value
        await writeYaml(fs, localPath, data)
      } else {
        const repoConfigPath = join(repoPath, 'config.yaml')
        const data = (await readYaml(fs, repoConfigPath)) ?? {}
        if (value === null) delete data[field]
        else data[field] = value
        await writeYaml(fs, repoConfigPath, data)
      }
      return c.json({ ok: true })
    } catch (e) {
      return c.json({ ok: false, error: 'config_update_failed', message: String(e?.message ?? e) })
    }
  })

  // -- New creation endpoints --

  app.post('/skills/local', async (c) => {
    try {
      const { repoPath, skill } = await c.req.json()
      const { fs } = createNodePlatform()
      const filePath = join(repoPath, 'skills.yaml')
      const data = (await readYaml(fs, filePath)) ?? { sources: [], skills: [] }
      data.skills = data.skills ?? []
      data.skills.push(skill)
      await writeYaml(fs, filePath, data)
      return c.json({ ok: true, skill })
    } catch (e) {
      return c.json({ ok: false, error: 'write_failed', message: String(e?.message ?? e) })
    }
  })

  app.post('/sources', async (c) => {
    try {
      const { repoPath, url, ref } = await c.req.json()
      const { fs, git } = createNodePlatform()
      const filePath = join(repoPath, 'skills.yaml')
      const data = (await readYaml(fs, filePath)) ?? { sources: [], skills: [] }
      data.sources = data.sources ?? []
      data.sources.push({ url, ref })
      await writeYaml(fs, filePath, data)
      // Auto-clone source repo to remote-cache so SKILL.md content is available
      const sourceId = deriveRepoId(url)
      try {
        await installSkill(git, fs, url, ref, repoPath, sourceId)
      } catch (installErr) {
        // Clone failure shouldn't block source creation; user can retry via check/scan
        console.error('auto-install failed for source', url, installErr)
      }
      return c.json({ ok: true, source: { url, ref } })
    } catch (e) {
      return c.json({ ok: false, error: 'write_failed', message: String(e?.message ?? e) })
    }
  })

  app.post('/sources/scan', async (c) => {
    try {
      const { url } = await c.req.json()
      const { git, fs } = createNodePlatform()
      const { discoverSkills } = await import('../remote/discover.js')
      const members = await discoverSkills(git, fs, url)
      return c.json({ members })
    } catch (e) {
      return c.json({ ok: false, error: 'scan_failed', message: String(e?.message ?? e) })
    }
  })

  app.post('/mcp', async (c) => {
    try {
      const { repoPath, server } = await c.req.json()
      const { fs } = createNodePlatform()
      const filePath = join(repoPath, 'mcp.yaml')
      const data = (await readYaml(fs, filePath)) ?? []
      data.push(server)
      await writeYaml(fs, filePath, data)
      return c.json({ ok: true, server })
    } catch (e) {
      return c.json({ ok: false, error: 'write_failed', message: String(e?.message ?? e) })
    }
  })

  app.delete('/sources', async (c) => {
    try {
      const { repoPath, url } = await c.req.json()
      if (!url || typeof url !== 'string') return c.json({ ok: false, error: 'invalid_url' }, 400)
      const { fs } = createNodePlatform()
      const filePath = join(repoPath, 'skills.yaml')
      const data = (await readYaml(fs, filePath)) ?? { sources: [], skills: [] }
      data.sources = (data.sources ?? []).filter((s: any) => s.url !== url)
      await writeYaml(fs, filePath, data)
      return c.json({ ok: true })
    } catch (e) {
      return c.json({ ok: false, error: 'delete_failed', message: String(e?.message ?? e) })
    }
  })

  app.delete('/skills/local', async (c) => {
    try {
      const { repoPath, id } = await c.req.json()
      if (!id || typeof id !== 'string') return c.json({ ok: false, error: 'invalid_id' }, 400)
      const { fs } = createNodePlatform()
      const filePath = join(repoPath, 'skills.yaml')
      const data = (await readYaml(fs, filePath)) ?? { sources: [], skills: [] }
      data.skills = (data.skills ?? []).filter((s: any) => s.id !== id)
      await writeYaml(fs, filePath, data)
      return c.json({ ok: true })
    } catch (e) {
      return c.json({ ok: false, error: 'delete_failed', message: String(e?.message ?? e) })
    }
  })

  app.delete('/mcp', async (c) => {
    try {
      const { repoPath, id } = await c.req.json()
      if (!id || typeof id !== 'string') return c.json({ ok: false, error: 'invalid_id' }, 400)
      const { fs } = createNodePlatform()
      const filePath = join(repoPath, 'mcp.yaml')
      const data = (await readYaml(fs, filePath)) ?? []
      const filtered = data.filter((s: any) => s.id !== id)
      await writeYaml(fs, filePath, filtered)
      return c.json({ ok: true })
    } catch (e) {
      return c.json({ ok: false, error: 'delete_failed', message: String(e?.message ?? e) })
    }
  })

  app.post('/mcp/targets', async (c) => {
    try {
      const { repoPath, id, targets } = await c.req.json()
      const { fs } = createNodePlatform()
      const filePath = join(repoPath, 'mcp.yaml')
      const data = (await readYaml(fs, filePath)) ?? []
      const server = data.find((s: any) => s.id === id)
      if (!server)
        return c.json({ ok: false, error: 'not_found', message: `MCP server ${id} not found` })
      server.targets = targets
      await writeYaml(fs, filePath, data)
      return c.json({ ok: true })
    } catch (e) {
      return c.json({ ok: false, error: 'update_failed', message: String(e?.message ?? e) })
    }
  })

  app.post('/skills/targets', async (c) => {
    try {
      const { repoPath, sourceUrl, memberName, targets } = await c.req.json()
      const { fs } = createNodePlatform()
      const filePath = join(repoPath, 'skills.yaml')
      const data = (await readYaml(fs, filePath)) ?? { sources: [], skills: [] }
      const source = (data.sources ?? []).find((s: any) => s.url === sourceUrl)
      if (!source)
        return c.json({ ok: false, error: 'not_found', message: `Source ${sourceUrl} not found` })
      if (!memberName || !memberName.trim()) {
        // Source-level targets (applies to all members without explicit targets)
        source.targets = targets
      } else {
        if (!source.members) source.members = []
        let member = source.members.find((m: any) => m.name === memberName)
        if (!member) {
          member = { name: memberName, targets }
          source.members.push(member)
        } else {
          member.targets = targets
        }
      }
      await writeYaml(fs, filePath, data)
      return c.json({ ok: true })
    } catch (e) {
      return c.json({ ok: false, error: 'update_failed', message: String(e?.message ?? e) })
    }
  })

  app.post('/skills/local/targets', async (c) => {
    try {
      const { repoPath, id, targets } = await c.req.json()
      if (!id || typeof id !== 'string') return c.json({ ok: false, error: 'invalid_id' }, 400)
      const { fs } = createNodePlatform()
      const filePath = join(repoPath, 'skills.yaml')
      const data = (await readYaml(fs, filePath)) ?? { sources: [], skills: [] }
      const skill = (data.skills ?? []).find((s: any) => s.id === id)
      if (!skill)
        return c.json({ ok: false, error: 'not_found', message: `Local skill ${id} not found` })
      skill.targets = targets
      await writeYaml(fs, filePath, data)
      return c.json({ ok: true })
    } catch (e) {
      return c.json({ ok: false, error: 'update_failed', message: String(e?.message ?? e) })
    }
  })

  // -- Git remote endpoints --

  app.post('/sync/remote', async (c) => {
    try {
      const { repoPath, remoteUrl } = await c.req.json()
      await gitAddOrUpdateRemote(repoPath, remoteUrl)
      return c.json({ ok: true, remoteUrl })
    } catch (e) {
      return c.json({ ok: false, error: 'remote_failed', message: String(e?.message ?? e) })
    }
  })

  app.get('/sync/remote', async (c) => {
    const repoPath = c.req.query('repoPath')!
    const remoteUrl = await gitGetRemoteUrl(repoPath)
    return c.json({ remoteUrl })
  })

  return app
}
