import { Hono } from 'hono'
import { join } from 'node:path'
import { executeProjection } from '../projection/executor.js'
import { syncPull } from '../sync/pull.js'
import { syncPush } from '../sync/push.js'
import { installSkill } from '../remote/install.js'
import { checkUpdates, performUpdate } from '../remote/update.js'
import { loadRepoManifest, mergeConfig, buildManifest } from '../core/manifest.js'
import { planProjection } from '../core/projection.js'
import { createNodePlatform } from '../platform/node/index.js'
import { initLoom } from '../platform/node/init.js'
import { createDeps } from './deps.js'
import type { AgentId } from '../core/types.js'

async function readRepoFiles(fs: { readFile: (p: string) => Promise<string>; exists: (p: string) => Promise<boolean>; readDir: (p: string) => Promise<string[]> }, repoPath: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {}
  for (const p of ['config.yaml', 'skills.yaml', 'mcp.yaml']) {
    try { files[p] = await fs.readFile(join(repoPath, p)) } catch { /* missing */ }
  }
  try {
    const varsDir = join(repoPath, 'vars')
    if (await fs.exists(varsDir)) {
      for (const f of await fs.readDir(varsDir)) {
        if (f.endsWith('.yaml')) {
          try { files[`vars/${f}`] = await fs.readFile(join(varsDir, f)) } catch { /* skip */ }
        }
      }
    }
  } catch { /* no vars dir */ }
  return files
}

async function readLocalConfig(fs: { readFile: (p: string) => Promise<string>; exists: (p: string) => Promise<boolean> }, home: string): Promise<Record<string, unknown>> {
  try {
    const yaml = await import('js-yaml')
    const raw = await fs.readFile(join(home, '.loom', 'config.yaml'))
    return yaml.load(raw) as Record<string, unknown>
  } catch { return {} }
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
    return c.json({ ok: true, active_repo: activeRepo, repoPath: join(home, '.loom', 'repos', activeRepo) })
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
    const allAgents: AgentId[] = body.installedAgents ?? (['claude-code', 'codex', 'opencode'] as AgentId[])
    const installed = new Set<AgentId>()
    for (const a of allAgents) {
      try { if (await proc.isInstalled(a)) installed.add(a) } catch { /* proc not available, assume installed */ installed.add(a) }
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
    const varsCtx = body.varsCtx ?? { env: {}, activeProfile: mf.vars.active, defaultProfile: mf.vars.default }
    const res = await executeProjection(plan, mf, varsCtx, deps)
    return c.json(res)
  })

  app.post('/sync/pull', async (c) => {
    const { repoPath } = await c.req.json()
    const { git, fs } = createNodePlatform()
    const res = await syncPull(repoPath, git, fs, { error: (o, m) => console.error(m, o), warn: (o, m) => console.warn(m, o) })
    return c.json(res)
  })

  app.post('/sync/push', async (c) => {
    const { repoPath } = await c.req.json()
    const { git } = createNodePlatform()
    const res = await syncPush(repoPath, git)
    return c.json(res)
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
    const res = await performUpdate(git, fs, body.source, body.newRef, body.repoPath, body.sourceId, body.oldMembers)
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
    const manifest = buildManifest(repoManifest, localConfig as any)
    return c.json(manifest)
  })

  app.put('/config', async (c) => {
    const { repoPath, level, field, value } = await c.req.json()
    // Not yet implemented: persisting config edits is a follow-up milestone.
    // Return 501 so the WebUI can surface "save failed" instead of silently
    // implying success.
    return c.json({ ok: false, error: 'not_implemented', repoPath, level, field, value }, 501)
  })

  return app
}
