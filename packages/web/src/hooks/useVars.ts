import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../lib/api'
import type { VarsDiagnostic, VarsEnvironment, VarsResolution } from '../lib/vars'

export function useVars(repoPath: string) {
  const [environments, setEnvironments] = useState<string[]>([])
  const [selectedEnvironment, setSelectedEnvironment] = useState<string | null>(null)
  const [environment, setEnvironment] = useState<VarsEnvironment | null>(null)
  const [previewChain, setPreviewChain] = useState<string[]>([])
  const [resolution, setResolution] = useState<VarsResolution | null>(null)
  const [diagnostics, setDiagnostics] = useState<VarsDiagnostic[]>([])
  const [loading, setLoading] = useState(true)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [resolutionError, setResolutionError] = useState<string | null>(null)
  const requestSequence = useRef(0)
  const resolutionSequence = useRef(0)
  const createSequence = useRef(0)
  const mounted = useRef(true)
  const activeRepoPath = useRef(repoPath)
  const previewChainRef = useRef<string[]>([])
  const committedSelection = useRef<{
    name: string | null
    environment: VarsEnvironment | null
  }>({ name: null, environment: null })

  const select = useCallback(
    async (name: string, addToChain = true) => {
      if (!mounted.current) return
      const request = ++requestSequence.current
      resolutionSequence.current += 1
      const previous = committedSelection.current
      const previousChain = previewChainRef.current
      setSelectedEnvironment(name)
      setEnvironment(null)
      setPending(true)
      setError(null)
      if (addToChain && !previousChain.includes(name)) {
        previewChainRef.current = [...previousChain, name]
        setPreviewChain(previewChainRef.current)
      }
      try {
        const response = await api.vars.getEnvironment(repoPath, name)
        if (
          !mounted.current ||
          repoPath !== activeRepoPath.current ||
          request !== requestSequence.current
        )
          return
        setEnvironment(response.environment)
        committedSelection.current = { name, environment: response.environment }
        return true
      } catch (cause) {
        if (
          !mounted.current ||
          repoPath !== activeRepoPath.current ||
          request !== requestSequence.current
        )
          return
        console.error('Failed to select vars environment', cause)
        setSelectedEnvironment(previous.name)
        setEnvironment(previous.environment)
        previewChainRef.current = previousChain
        setPreviewChain(previousChain)
        setError('变量环境加载失败')
        return false
      } finally {
        if (
          mounted.current &&
          repoPath === activeRepoPath.current &&
          request === requestSequence.current
        )
          setPending(false)
      }
    },
    [repoPath],
  )

  const load = useCallback(async () => {
    if (!mounted.current) return
    const request = ++requestSequence.current
    setLoading(true)
    setError(null)
    try {
      const response = await api.vars.listEnvironments(repoPath)
      if (
        !mounted.current ||
        repoPath !== activeRepoPath.current ||
        request !== requestSequence.current
      )
        return
      setEnvironments(response.environments)
      setDiagnostics(response.diagnostics ?? [])
      if (response.environments.length === 0) {
        setSelectedEnvironment(null)
        setEnvironment(null)
        committedSelection.current = { name: null, environment: null }
        previewChainRef.current = []
        setPreviewChain([])
      } else {
        const first = response.environments[0]
        setSelectedEnvironment(first)
        previewChainRef.current = [first]
        setPreviewChain(previewChainRef.current)
        const detail = await api.vars.getEnvironment(repoPath, first)
        if (
          !mounted.current ||
          repoPath !== activeRepoPath.current ||
          request !== requestSequence.current
        )
          return
        setEnvironment(detail.environment)
        committedSelection.current = { name: first, environment: detail.environment }
      }
    } catch (cause) {
      if (
        !mounted.current ||
        repoPath !== activeRepoPath.current ||
        request !== requestSequence.current
      )
        return
      console.error('Failed to load vars', cause)
      setError('变量环境加载失败')
    } finally {
      if (
        mounted.current &&
        repoPath === activeRepoPath.current &&
        request === requestSequence.current
      )
        setLoading(false)
    }
  }, [repoPath])

  useEffect(() => {
    mounted.current = true
    requestSequence.current += 1
    resolutionSequence.current += 1
    createSequence.current += 1
    activeRepoPath.current = repoPath
    committedSelection.current = { name: null, environment: null }
    previewChainRef.current = []
    setEnvironments([])
    setSelectedEnvironment(null)
    setEnvironment(null)
    setPreviewChain([])
    setResolution(null)
    setResolutionError(null)
    setDiagnostics([])
    setPending(false)
    setLoading(true)
    setError(null)
    void load()
    return () => {
      mounted.current = false
      requestSequence.current += 1
      resolutionSequence.current += 1
      createSequence.current += 1
    }
  }, [load, repoPath])

  useEffect(() => {
    const request = ++resolutionSequence.current
    setResolution(null)
    setResolutionError(null)
    if (previewChain.length === 0 || previewChain !== previewChainRef.current) {
      setResolution(null)
      return () => {
        resolutionSequence.current += 1
      }
    }
    api.vars.resolve(repoPath, previewChain).then(
      (response) => {
        if (
          mounted.current &&
          repoPath === activeRepoPath.current &&
          request === resolutionSequence.current
        ) {
          setResolution(response)
          setResolutionError(null)
        }
      },
      (cause) => {
        if (
          !mounted.current ||
          repoPath !== activeRepoPath.current ||
          request !== resolutionSequence.current
        )
          return
        setResolution(null)
        console.error('Failed to resolve vars preview', cause)
        setResolutionError('变量预览解析失败')
      },
    )
    return () => {
      resolutionSequence.current += 1
    }
  }, [previewChain, repoPath])

  const removeFromChain = useCallback((name: string) => {
    resolutionSequence.current += 1
    previewChainRef.current = previewChainRef.current.filter((item) => item !== name)
    setPreviewChain(previewChainRef.current)
  }, [])

  const refreshCurrent = useCallback(async () => {
    const name = committedSelection.current.name
    if (!name || !mounted.current) return
    const request = ++requestSequence.current
    const resolutionRequest = ++resolutionSequence.current
    const [listed, detail] = await Promise.all([
      api.vars.listEnvironments(repoPath),
      api.vars.getEnvironment(repoPath, name),
    ])
    if (
      !mounted.current ||
      repoPath !== activeRepoPath.current ||
      request !== requestSequence.current
    )
      return
    setEnvironment(detail.environment)
    setEnvironments(listed.environments)
    setDiagnostics(listed.diagnostics ?? [])
    committedSelection.current = { name, environment: detail.environment }
    setResolutionError(null)
    if (previewChainRef.current.length === 0) {
      setResolution(null)
      return
    }
    try {
      const resolved = await api.vars.resolve(repoPath, previewChainRef.current)
      if (
        mounted.current &&
        repoPath === activeRepoPath.current &&
        request === requestSequence.current &&
        resolutionRequest === resolutionSequence.current
      )
        setResolution(resolved)
    } catch (cause) {
      if (
        !mounted.current ||
        repoPath !== activeRepoPath.current ||
        request !== requestSequence.current ||
        resolutionRequest !== resolutionSequence.current
      )
        return
      console.error('Failed to resolve vars preview after refresh', cause)
      setResolution(null)
      setResolutionError('变量预览解析失败')
    }
  }, [repoPath])

  const createEnvironment = useCallback(
    async (name: string) => {
      if (!mounted.current) return 'failed' as const
      const create = ++createSequence.current
      const isCurrent = () =>
        mounted.current && repoPath === activeRepoPath.current && create === createSequence.current
      setPending(true)
      setError(null)
      try {
        await api.vars.createEnvironment(repoPath, name)
        if (!isCurrent()) return 'failed' as const
        let listed = [name]
        try {
          listed = (await api.vars.listEnvironments(repoPath)).environments
        } catch (cause) {
          if (!isCurrent()) return 'failed' as const
          console.error('Failed to reload vars after creating environment', cause)
        }
        if (!isCurrent()) return 'failed' as const
        setEnvironments((current) => [...new Set([...current, ...listed, name])])
        if (!previewChainRef.current.includes(name)) {
          previewChainRef.current = [...previewChainRef.current, name]
          setPreviewChain(previewChainRef.current)
        }
        if (!(await select(name, false))) {
          setError('环境已创建，但详情加载失败')
          return 'partial' as const
        }
        return 'complete' as const
      } catch (cause) {
        if (!isCurrent()) return 'failed' as const
        console.error('Failed to create vars environment', cause)
        setError('变量环境创建失败')
        return 'failed' as const
      } finally {
        if (isCurrent()) setPending(false)
      }
    },
    [repoPath, select],
  )

  return {
    environments,
    selectedEnvironment,
    environment,
    previewChain,
    resolution,
    diagnostics,
    loading,
    pending,
    error,
    resolutionError,
    load,
    reload: load,
    select,
    removeFromChain,
    createEnvironment,
    refreshCurrent,
  }
}
