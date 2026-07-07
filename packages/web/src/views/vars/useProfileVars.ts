import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../../lib/api'
import { AGENTS, type AgentId } from '../../lib/agents'
import type { VarsMatrixResponse } from '../../lib/vars'
import { buildVarsProfileState } from './profile-model'

export function useProfileVars(repoPath: string) {
  const [activeAgent, setActiveAgent] = useState<AgentId>('codex')
  const [showAvailable, setShowAvailable] = useState(false)
  const [matricesByAgent, setMatricesByAgent] = useState<Record<
    AgentId,
    VarsMatrixResponse
  > | null>(null)
  const [loading, setLoading] = useState(true)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const entries = await Promise.all(
        AGENTS.map(async (agent) => [agent, await api.vars.getMatrix(repoPath, agent)] as const),
      )
      setMatricesByAgent(Object.fromEntries(entries) as Record<AgentId, VarsMatrixResponse>)
    } catch (cause) {
      console.error('Failed to load profile vars', cause)
      setError(cause instanceof Error ? cause.message : '变量加载失败')
    } finally {
      setLoading(false)
    }
  }, [repoPath])

  useEffect(() => {
    void reload()
  }, [reload])

  const state = useMemo(
    () =>
      matricesByAgent
        ? buildVarsProfileState({ matricesByAgent, activeAgent, showAvailable })
        : null,
    [activeAgent, matricesByAgent, showAvailable],
  )

  return {
    activeAgent,
    setActiveAgent,
    showAvailable,
    setShowAvailable,
    state,
    matricesByAgent,
    loading,
    pending,
    setPending,
    error,
    reload,
  }
}
