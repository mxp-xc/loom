import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import type { IGit } from '../../src/ports/git.js'
import { NodeFileSystem } from '../../src/platform/node/fs.js'
import { createConfigRoutes } from '../../src/api/routes/config.js'
import { createProjectionRoutes } from '../../src/api/routes/projection.js'
import { createSyncRoutes } from '../../src/api/routes/sync.js'
import { createVarsRoutes } from '../../src/api/routes/vars.js'
import type { SyncSessionManager } from '../../src/sync/session-manager.js'

type ContractSync = Pick<
  SyncSessionManager,
  'pull' | 'forcePull' | 'getSession' | 'saveConflict' | 'abort'
>

interface ContractAppOverrides {
  git?: IGit
  sync?: Partial<ContractSync>
}

export async function createContractApp(overrides: ContractAppOverrides = {}) {
  const home = await mkdtemp(join(tmpdir(), 'loom-http-contract-'))
  const repoPath = join(home, '.loom', 'repos', 'default')
  await mkdir(repoPath, { recursive: true })
  await Promise.all([
    writeFile(join(repoPath, 'config.yaml'), 'agents: []\n'),
    writeFile(join(repoPath, 'skills.yaml'), 'sources: []\nskills: []\n'),
    writeFile(join(repoPath, 'mcp.yaml'), '[]\n'),
  ])

  const fs = new NodeFileSystem()
  const git =
    overrides.git ??
    ({
      status: async () => ({ dirty: false }),
      add: async () => undefined,
      commit: async () => undefined,
      push: async () => ({ ok: true }),
      forcePush: async () => ({ ok: true }),
    } as unknown as IGit)
  const sync = {
    pull: async () => ({ clean: true as const, conflicts: [] }),
    forcePull: async () => ({ clean: true as const, conflicts: [] }),
    getSession: async () => null,
    saveConflict: async () => ({ clean: true as const, remaining: [] }),
    abort: async () => undefined,
    ...overrides.sync,
  } as unknown as SyncSessionManager
  const deps = {
    fs,
    git,
    proc: { isCommandInstalled: async () => false },
    home,
  }
  const routes = new Hono()
  routes.route('/', createConfigRoutes(deps))
  routes.route('/', createProjectionRoutes(deps))
  routes.route('/', createSyncRoutes({ ...deps, sync }))
  routes.route('/', createVarsRoutes(deps))

  return {
    app: new Hono().route('/api', routes),
    fs,
    home,
    repoPath,
    dispose: () => rm(home, { recursive: true, force: true }),
  }
}
