import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../../lib/api'
import { AGENTS, type AgentId } from '../../lib/agents'
import type { VarsMatrixResponse } from '../../lib/vars'
import { buildVarsProfileState, type VarsViewScope } from './profile-model'

export function useProfileVars(repoPath: string) {
  const [activeAgent, setActiveAgent] = useState<AgentId>('codex')
  const [defaultAgent, setDefaultAgent] = useState<AgentId>('codex')
  const [viewScope, setViewScope] = useState<VarsViewScope>('default')
  const [configuredTargets, setConfiguredTargets] = useState<AgentId[]>([])
  const loadedDefaultAgent = useRef(false)
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
      const [manifest, entries] = await Promise.all([
        api.getManifest(repoPath) as Promise<{ config?: { targets?: string[] } }>,
        Promise.all(
          AGENTS.map(async (agent) => [agent, await api.vars.getMatrix(repoPath, agent)] as const),
        ),
      ])
      const targets =
        manifest.config?.targets?.filter((target): target is AgentId =>
          AGENTS.includes(target as AgentId),
        ) ?? []
      const nextDefaultAgent = targets[0] ?? 'codex'
      setConfiguredTargets(targets)
      setDefaultAgent(nextDefaultAgent)
      setActiveAgent((currentAgent) => {
        if (!loadedDefaultAgent.current) return nextDefaultAgent
        if (targets.length === 0) return nextDefaultAgent
        if (targets.length > 0 && !targets.includes(currentAgent)) return nextDefaultAgent
        return currentAgent
      })
      setViewScope((currentScope) => {
        if (currentScope === 'default') return currentScope
        return targets.includes(currentScope) ? currentScope : 'default'
      })
      loadedDefaultAgent.current = true
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
        ? buildVarsProfileState({
            matricesByAgent,
            activeAgent: viewScope === 'default' ? defaultAgent : activeAgent,
            definitionAgent: viewScope === 'default' ? defaultAgent : viewScope,
            definitionScope: viewScope,
            showAvailable,
          })
        : null,
    [activeAgent, defaultAgent, matricesByAgent, showAvailable, viewScope],
  )

  return {
    activeAgent,
    defaultAgent,
    viewScope,
    setViewScope,
    configuredTargets,
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
