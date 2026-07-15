import { join, dirname, isAbsolute, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { ClaudeCodeAdapter } from '../adapters/claude-code.js'
import { CodexAdapter } from '../adapters/codex.js'
import { OpenCodeAdapter } from '../adapters/opencode.js'
import type { ProjectionDeps } from './executor.js'
import type { AgentId } from '@loom/core'
import { logger } from '../lib/logger.js'
import { cacheDirFor, skillPathFor } from '../remote/cache.js'
import type { IFileSystem } from '../ports/fs.js'
import type { IGit } from '../ports/git.js'
import type { IProcess } from '../ports/process.js'

const projectionLogger = logger.child('projection')

export function createProjectionDeps(
  platform: { fs: IFileSystem; git: IGit; proc: IProcess },
  repoPath: string,
  installedAgents: Set<AgentId>,
  home: string,
): ProjectionDeps {
  const stateFile = join(home, '.loom', 'state', basenameRepo(repoPath), 'projected-mcp.json')
  const fs = platform.fs
  const readState = async (): Promise<Record<string, string[]>> => {
    try {
      return JSON.parse(await fs.readFile(stateFile)) as Record<string, string[]>
    } catch (err) {
      if (!isMissing(err))
        projectionLogger.error('failed to read projection state', { err, stateFile })
      return {}
    }
  }
  const writeState = async (data: Record<string, string[]>): Promise<void> => {
    await fs.mkdir(dirname(stateFile), true)
    await fs.writeFile(stateFile, JSON.stringify(data, null, 2))
  }
  return {
    fs,
    ownerRepo: sha256(resolve(repoPath)),
    adapters: {
      'claude-code': new ClaudeCodeAdapter(),
      codex: new CodexAdapter(),
      opencode: new OpenCodeAdapter(),
    },
    installedAgents,
    resolveSkillSrc: (link) => {
      if (link.source === 'local') return join(repoPath, 'assets', 'skills', link.skillId)
      return resolveSourceSkillDir(repoPath, link.source)
    },
    resolveSourceRoot: (sourcePlan) => cacheDirFor(repoPath, sourcePlan.cacheId),
    resolveSourceFiles: async (sourcePlan) => {
      const cacheDir = cacheDirFor(repoPath, sourcePlan.cacheId)
      const checkedOutCommit = await platform.git.revParseHead(cacheDir)
      if (checkedOutCommit !== sourcePlan.commit) {
        throw new Error(
          `Source cache checkout does not match planned commit: ${sourcePlan.cacheId}`,
        )
      }
      return (await platform.git.readTree(cacheDir, sourcePlan.commit))
        .filter((entry) => entry.type === 'blob' && entry.mode !== '120000')
        .map((entry) => entry.path)
    },
    logger: projectionLogger,
    getManagedMcpIds: async (agent) => new Set((await readState())[agent] ?? []),
    setManagedMcpIds: async (agent, ids) => {
      const data = await readState()
      data[agent] = ids
      await writeState(data)
    },
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function resolveSourceSkillDir(
  repoPath: string,
  source: { repoId: string; cacheId?: string; memberName: string; path?: string },
): string {
  const cacheId = source.cacheId ?? source.repoId
  const fallback = skillPathFor(repoPath, cacheId, source.memberName)
  if (!source.path || isAbsolute(source.path)) return fallback
  const normalized = source.path.replace(/\\/g, '/').replace(/^\/+/, '')
  if (!normalized || normalized.split('/').includes('..') || /^[A-Za-z]:\//.test(normalized)) {
    return fallback
  }
  const sourceDir =
    normalized === 'SKILL.md' || normalized.endsWith('/SKILL.md')
      ? dirname(normalized)
      : normalized.replace(/\/+$/, '')
  return join(cacheDirFor(repoPath, cacheId), sourceDir === '.' ? '' : sourceDir)
}

function basenameRepo(repoPath: string): string {
  const seg =
    repoPath
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .pop() ?? 'default'
  return seg || 'default'
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}
