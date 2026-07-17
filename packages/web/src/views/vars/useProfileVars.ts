import { useCallback, useEffect, useMemo, useState } from 'react'
import { configuredAgents as resolveConfiguredAgents, type AgentId } from '@loom/core'
import { api } from '../../lib/api'
import type { VarsMatrixResponse } from '../../lib/vars'
import { buildVarsProfileState, type VarsViewScope } from './profile-model'

export function useProfileVars(repoPath: string) {
  const [activeAgent, setActiveAgent] = useState<AgentId | null>(null)
  const [viewScope, setViewScope] = useState<VarsViewScope>('default')
  const [configuredAgents, setConfiguredAgents] = useState<AgentId[]>([])
  const [showAvailable, setShowAvailable] = useState(false)
  const [defaultMatrix, setDefaultMatrix] = useState<VarsMatrixResponse | null>(null)
  const [matricesByAgent, setMatricesByAgent] = useState<
    Partial<Record<AgentId, VarsMatrixResponse>>
  >({})
  const [loading, setLoading] = useState(true)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const manifest = (await api.getManifest(repoPath)) as { config?: { agents?: unknown[] } }
      const agents = resolveConfiguredAgents(manifest.config?.agents)
      const [nextDefaultMatrix, entries] = await Promise.all([
        api.vars.getMatrix(repoPath, 'default'),
        Promise.all(
          agents.map(async (agent) => [agent, await api.vars.getMatrix(repoPath, agent)] as const),
        ),
      ])
      setConfiguredAgents(agents)
      setDefaultMatrix(nextDefaultMatrix)
      setMatricesByAgent(Object.fromEntries(entries))
      setActiveAgent((currentAgent) =>
        currentAgent && agents.includes(currentAgent) ? currentAgent : (agents[0] ?? null),
      )
      setViewScope((currentScope) =>
        currentScope === 'default' || agents.includes(currentScope) ? currentScope : 'default',
      )
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
      defaultMatrix
        ? buildVarsProfileState({
            defaultMatrix,
            matricesByAgent,
            agents: configuredAgents,
            activeAgent: viewScope === 'default' ? null : activeAgent,
            definitionScope: viewScope,
            showAvailable,
          })
        : null,
    [activeAgent, configuredAgents, defaultMatrix, matricesByAgent, showAvailable, viewScope],
  )

  return {
    activeAgent,
    viewScope,
    setViewScope,
    configuredAgents,
    setActiveAgent,
    showAvailable,
    setShowAvailable,
    state,
    defaultMatrix,
    matricesByAgent,
    loading,
    pending,
    setPending,
    error,
    reload,
  }
}
