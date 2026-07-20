import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { agentsSupporting } from '@loom/core'
import {
  agentMcpFile,
  agentMemoryFile,
  agentSkillsDir,
  runtimeAgentPathContext,
} from '../adapters/paths.js'
import type { IFileSystem } from '../ports/fs.js'
import type { ProjectionScope } from '../projection/executor.js'

export async function homeResourceKey(fs: IFileSystem, home: string): Promise<string> {
  return typeof fs.realPath === 'function' ? fs.realPath(home) : home
}

export function projectionResourceKeys(
  home: string,
  repoPath: string,
  canonicalHomeKey: string,
  scope: ProjectionScope = 'all',
): string[] {
  const context = runtimeAgentPathContext(home)
  const keys = [resolve(repoPath), canonicalHomeKey]

  if (scope === 'skills' || scope === 'all') {
    keys.push(
      join(home, '.loom', 'state', repoIdentity(repoPath), 'projected-skills.json'),
      ...agentsSupporting('skills').map((agent) => agentSkillsDir(agent, context)),
    )
  }
  if (scope === 'mcp' || scope === 'all') {
    keys.push(
      join(home, '.loom', 'state', repoIdentity(repoPath), 'projected-mcp.json'),
      join(home, '.loom', 'state', repoBasename(repoPath), 'projected-mcp.json'),
      ...agentsSupporting('mcp').map((agent) => agentMcpFile(agent, context)),
    )
  }
  if (scope === 'memory' || scope === 'all') {
    keys.push(...agentsSupporting('memory').map((agent) => agentMemoryFile(agent, context)))
  }

  return keys.map((key) => resolve(key))
}

export function mcpImportResourceKeys(
  home: string,
  repoPath: string,
  canonicalHomeKey: string,
): string[] {
  const context = runtimeAgentPathContext(home)
  return [
    resolve(repoPath),
    canonicalHomeKey,
    ...agentsSupporting('mcp').map((agent) => resolve(agentMcpFile(agent, context))),
  ]
}

function repoIdentity(repoPath: string): string {
  return createHash('sha256').update(resolve(repoPath)).digest('hex')
}

function repoBasename(repoPath: string): string {
  return resolve(repoPath).split(/[\\/]/).pop() || 'default'
}
