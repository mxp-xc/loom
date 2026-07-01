import { join } from 'node:path'
import { createNodePlatform } from '../platform/node/index.js'
import { ClaudeCodeAdapter } from '../adapters/claude-code.js'
import { CodexAdapter } from '../adapters/codex.js'
import { OpenCodeAdapter } from '../adapters/opencode.js'
import type { ProjectionDeps } from '../projection/executor.js'
import type { AgentId } from '../core/types.js'

export function createDeps(repoPath: string, installedAgents: Set<AgentId>): ProjectionDeps {
  const platform = createNodePlatform()
  return {
    fs: platform.fs,
    adapters: { 'claude-code': new ClaudeCodeAdapter(), 'codex': new CodexAdapter(), 'opencode': new OpenCodeAdapter() },
    installedAgents,
    resolveSkillSrc: (link) => {
      if (link.source === 'local') return join(repoPath, 'assets', 'skills', link.skillId)
      const { repoId, memberName } = link.source
      return join(repoPath, 'remote-cache', repoId, 'skills', memberName)
    },
    logger: { error: (o, m) => console.error(m, o), warn: (o, m) => console.warn(m, o) },
  }
}
