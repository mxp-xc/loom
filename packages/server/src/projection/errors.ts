import type { AgentId } from '@loom/core'

export class SourceNamespaceCollisionError extends Error {
  readonly code = 'source_namespace_collision'

  constructor(
    readonly agent: AgentId,
    readonly sourceName: string,
    readonly sourceUrl: string,
    readonly namespace: string,
  ) {
    super(`refuse to overwrite user-owned source namespace: ${namespace}`)
    this.name = 'SourceNamespaceCollisionError'
  }
}

export function findSourceNamespaceCollision(error: unknown): SourceNamespaceCollisionError | null {
  const visited = new Set<unknown>()
  const pending: unknown[] = [error]
  while (pending.length > 0) {
    const candidate = pending.shift()
    if (!candidate || visited.has(candidate)) continue
    visited.add(candidate)
    if (candidate instanceof SourceNamespaceCollisionError) return candidate
    if (candidate instanceof AggregateError) pending.push(...candidate.errors)
    if (candidate instanceof Error && candidate.cause) pending.push(candidate.cause)
  }
  return null
}

export function sourceNamespaceCollisionPayload(error: SourceNamespaceCollisionError) {
  return {
    ok: false as const,
    error: error.code,
    message: 'A user-owned Skill directory conflicts with the Source projection',
    diagnostics: [
      {
        code: error.code,
        message: 'Back up the existing directory before letting Loom manage this Source',
        agent: error.agent,
        sourceName: error.sourceName,
        sourceUrl: error.sourceUrl,
      },
    ],
  }
}
