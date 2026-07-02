import { join, dirname } from 'node:path'
import { ClaudeCodeAdapter } from '../adapters/claude-code.js'
import { CodexAdapter } from '../adapters/codex.js'
import { OpenCodeAdapter } from '../adapters/opencode.js'
import type { ProjectionDeps } from '../projection/executor.js'
import type { AgentId } from '@loom/core'
import { logger } from '../lib/logger.js'
import { skillPathFor } from '../remote/cache.js'
import type { IFileSystem } from '../ports/fs.js'
import type { IGit } from '../ports/git.js'
import type { IProcess } from '../ports/process.js'

const projectionLogger = logger.child('projection')

export function createDeps(
  platform: { fs: IFileSystem; git: IGit; proc: IProcess },
  repoPath: string,
  installedAgents: Set<AgentId>,
): ProjectionDeps {
  // State file records mcp ids loom projected per agent, so we can tell
  // loom-managed entries (removable when manifest deletes them) apart from
  // user-handwritten ones (must be preserved). Lives outside the git repo
  // (machine-local); loss degrades to preserving all existing entries.
  const home = process.env.HOME || process.env.USERPROFILE || ''
  const stateFile = join(home, '.loom', 'state', basenameRepo(repoPath), 'projected-mcp.json')
  const fs = platform.fs
  const readState = async (): Promise<Record<string, string[]>> => {
    try {
      return JSON.parse(await fs.readFile(stateFile)) as Record<string, string[]>
    } catch {
      return {}
    }
  }
  const writeState = async (data: Record<string, string[]>): Promise<void> => {
    await fs.mkdir(dirname(stateFile), true)
    await fs.writeFile(stateFile, JSON.stringify(data, null, 2))
  }
  return {
    fs,
    adapters: {
      'claude-code': new ClaudeCodeAdapter(),
      codex: new CodexAdapter(),
      opencode: new OpenCodeAdapter(),
    },
    installedAgents,
    resolveSkillSrc: (link) => {
      if (link.source === 'local') return join(repoPath, 'assets', 'skills', link.skillId)
      const { repoId, memberName } = link.source
      return skillPathFor(repoPath, repoId, memberName)
    },
    logger: {
      error: (o, m) => projectionLogger.error(m, o as Record<string, unknown>),
      warn: (o, m) => projectionLogger.warn(m, o as Record<string, unknown>),
    },
    getManagedMcpIds: async (agent) => new Set((await readState())[agent] ?? []),
    setManagedMcpIds: async (agent, ids) => {
      const data = await readState()
      data[agent] = ids
      await writeState(data)
    },
  }
}

function basenameRepo(repoPath: string): string {
  // Derive a stable state dir name from the repo path's last segment.
  const seg =
    repoPath
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .pop() ?? 'default'
  return seg || 'default'
}
