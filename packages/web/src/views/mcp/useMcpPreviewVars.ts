import { useEffect, useState } from 'react'
import { api } from '@/lib/api'
import type { AgentId } from '@/lib/agents'
import type { VarsMatrixResponse } from '@/lib/vars'

export type McpResolveContext = 'default' | AgentId

export function useMcpPreviewVars(repoPath: string, agents: AgentId[], enabled = true) {
  const [matrices, setMatrices] = useState<Partial<Record<McpResolveContext, VarsMatrixResponse>>>(
    {},
  )
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    setLoading(true)
    Promise.all(
      (['default', ...agents] as const).map(async (agent) => {
        try {
          const matrix = await api.vars.getMatrix(repoPath, agent)
          return [agent, matrix] as const
        } catch (err) {
          console.error({ err, agent }, 'Failed to load MCP preview vars matrix')
          return [agent, null] as const
        }
      }),
    )
      .then((entries) => {
        if (cancelled) return
        setMatrices(
          Object.fromEntries(
            entries.filter((entry): entry is [McpResolveContext, VarsMatrixResponse] =>
              Boolean(entry[1]),
            ),
          ),
        )
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [agents, enabled, repoPath])

  return { matrices, loading }
}
