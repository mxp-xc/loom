import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
  const [matrixErrorsByAgent, setMatrixErrorsByAgent] = useState<Partial<Record<AgentId, string>>>(
    {},
  )
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const mountedRef = useRef(false)
  const requestSequence = useRef(0)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      requestSequence.current += 1
    }
  }, [])

  const reload = useCallback(async () => {
    const sequence = ++requestSequence.current
    const isCurrent = () => mountedRef.current && requestSequence.current === sequence
    setLoading(true)
    setError(null)
    try {
      const manifest = await api.getManifest(repoPath)
      if (!isCurrent()) return
      const agents = resolveConfiguredAgents(manifest.config?.agents)
      const [nextDefaultMatrix, agentResults] = await Promise.all([
        api.vars.getMatrix(repoPath, 'default'),
        Promise.allSettled(
          agents.map(async (agent) => [agent, await api.vars.getMatrix(repoPath, agent)] as const),
        ),
      ])
      if (!isCurrent()) return
      const entries: Array<readonly [AgentId, VarsMatrixResponse]> = []
      const agentErrors: Partial<Record<AgentId, string>> = {}
      agentResults.forEach((result, index) => {
        const agent = agents[index]!
        if (result.status === 'fulfilled') entries.push(result.value)
        else {
          console.error({ err: result.reason, repoPath, agent }, 'Failed to load agent vars')
          agentErrors[agent] =
            result.reason instanceof Error ? result.reason.message : 'Agent 变量加载失败'
        }
      })
      const availableAgents = entries.map(([agent]) => agent)
      setConfiguredAgents(agents)
      setDefaultMatrix(nextDefaultMatrix)
      setMatricesByAgent(Object.fromEntries(entries))
      setMatrixErrorsByAgent(agentErrors)
      setActiveAgent((currentAgent) =>
        currentAgent && availableAgents.includes(currentAgent)
          ? currentAgent
          : (availableAgents[0] ?? null),
      )
      setViewScope((currentScope) =>
        currentScope === 'default' || availableAgents.includes(currentScope)
          ? currentScope
          : 'default',
      )
    } catch (cause) {
      if (!isCurrent()) return
      console.error({ err: cause, repoPath }, 'Failed to load profile vars')
      setError(cause instanceof Error ? cause.message : '变量加载失败')
    } finally {
      if (isCurrent()) setLoading(false)
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
    matrixErrorsByAgent,
    loading,
    error,
    reload,
  }
}
