import { useState, useEffect, useCallback, useRef } from 'react'
import { api } from '@/lib/api'
import type { Manifest } from '@loom/core'

// Module-level cache keyed by repoPath: every consumer sharing the same repoPath
// gets the same manifest data, so the fetch happens once. reload() busts the
// cache and notifies all listeners.
const cache = new Map<string, { data: Manifest | null; listeners: Set<() => void> }>()

export async function refreshManifest(repoPath: string): Promise<Manifest> {
  const data = (await api.getManifest(repoPath)) as Manifest
  const entry = cache.get(repoPath) ?? { data: null, listeners: new Set<() => void>() }
  entry.data = data
  cache.set(repoPath, entry)
  entry.listeners.forEach((listener) => listener())
  return data
}

export function useManifest(
  repoPath: string,
  opts?: { onError?: (e: unknown) => void; onSuccess?: () => void },
) {
  const [manifest, setManifest] = useState<Manifest | null>(() => cache.get(repoPath)?.data ?? null)
  const [loading, setLoading] = useState(!cache.has(repoPath))
  // Keep the latest callbacks in refs so the fetch callbacks (which only depend
  // on repoPath) always invoke the current ones without re-running the effect.
  const onErrorRef = useRef(opts?.onError)
  onErrorRef.current = opts?.onError
  const onSuccessRef = useRef(opts?.onSuccess)
  onSuccessRef.current = opts?.onSuccess

  useEffect(() => {
    const listener = () => {
      const cached = cache.get(repoPath)
      if (cached) setManifest(cached.data)
    }
    if (!cache.has(repoPath)) cache.set(repoPath, { data: null, listeners: new Set() })
    const entry = cache.get(repoPath)!
    entry.listeners.add(listener)

    if (!entry.data) {
      setLoading(true)
      api
        .getManifest(repoPath)
        .then((m) => {
          const data = m as Manifest
          entry.data = data
          setManifest(data)
          setLoading(false)
          entry.listeners.forEach((l) => l())
          onSuccessRef.current?.()
        })
        .catch((e: unknown) => {
          setLoading(false)
          onErrorRef.current?.(e)
        })
    }

    return () => {
      entry.listeners.delete(listener)
    }
  }, [repoPath])

  const reload = useCallback(() => {
    setLoading(true)
    refreshManifest(repoPath)
      .then(() => {
        setLoading(false)
        onSuccessRef.current?.()
      })
      .catch((e: unknown) => {
        setLoading(false)
        onErrorRef.current?.(e)
      })
  }, [repoPath])

  return { manifest, loading, reload }
}
