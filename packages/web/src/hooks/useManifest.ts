import { useState, useEffect, useCallback, useRef } from 'react'
import { api } from '@/lib/api'
import type { Manifest } from '@loom/core'

// Module-level cache keyed by repoPath: every consumer sharing the same repoPath
// gets the same manifest data, so the fetch happens once. reload() busts the
// cache and notifies all listeners.
interface ManifestCacheEntry {
  data: Manifest | null
  listeners: Set<() => void>
  initialRequest: Promise<ManifestRequest> | null
  generation: number
  committedGeneration: number
}

interface ManifestRequest {
  data: Manifest
  committed: boolean
}

const cache = new Map<string, ManifestCacheEntry>()

function cacheEntry(repoPath: string): ManifestCacheEntry {
  const existing = cache.get(repoPath)
  if (existing) return existing
  const entry = {
    data: null,
    listeners: new Set<() => void>(),
    initialRequest: null,
    generation: 0,
    committedGeneration: 0,
  }
  cache.set(repoPath, entry)
  return entry
}

function requestManifest(repoPath: string, entry: ManifestCacheEntry): Promise<ManifestRequest> {
  const generation = ++entry.generation
  return api.getManifest(repoPath).then((data) => {
    const committed = generation > entry.committedGeneration
    if (committed) {
      entry.committedGeneration = generation
      entry.data = data
      entry.listeners.forEach((listener) => listener())
    }
    return { data, committed }
  })
}

function loadInitialManifest(
  repoPath: string,
  entry: ManifestCacheEntry,
): Promise<ManifestRequest> {
  if (entry.initialRequest) return entry.initialRequest
  const request = requestManifest(repoPath, entry)
  entry.initialRequest = request
  const clear = () => {
    if (entry.initialRequest === request) entry.initialRequest = null
  }
  void request.then(clear, clear)
  return request
}

export async function refreshManifest(repoPath: string): Promise<Manifest> {
  const entry = cacheEntry(repoPath)
  return (await requestManifest(repoPath, entry)).data
}

export function useManifest(
  repoPath: string,
  opts?: { onError?: (e: unknown) => void; onSuccess?: () => void },
) {
  const [manifest, setManifest] = useState<Manifest | null>(() => cache.get(repoPath)?.data ?? null)
  const [loading, setLoading] = useState(cache.get(repoPath)?.data == null)
  // Keep the latest callbacks in refs so the fetch callbacks (which only depend
  // on repoPath) always invoke the current ones without re-running the effect.
  const onErrorRef = useRef(opts?.onError)
  onErrorRef.current = opts?.onError
  const onSuccessRef = useRef(opts?.onSuccess)
  onSuccessRef.current = opts?.onSuccess
  const mountedRef = useRef(false)
  const requestSequence = useRef(0)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      requestSequence.current += 1
    }
  }, [])

  useEffect(() => {
    let active = true
    requestSequence.current += 1
    const listener = () => {
      if (!active) return
      const cached = cache.get(repoPath)
      if (cached) {
        setManifest(cached.data)
        setLoading(cached.data == null)
      }
    }
    const entry = cacheEntry(repoPath)
    entry.listeners.add(listener)

    if (!entry.data) {
      setManifest(null)
      setLoading(true)
      loadInitialManifest(repoPath, entry)
        .then(({ data, committed }) => {
          if (!active || !committed) return
          setManifest(data)
          setLoading(false)
          onSuccessRef.current?.()
        })
        .catch((e: unknown) => {
          if (!active) return
          console.error({ err: e, repoPath }, 'Failed to load manifest')
          setLoading(false)
          onErrorRef.current?.(e)
        })
    } else {
      setManifest(entry.data)
      setLoading(false)
    }

    return () => {
      active = false
      entry.listeners.delete(listener)
    }
  }, [repoPath])

  const reload = useCallback(() => {
    const sequence = ++requestSequence.current
    setLoading(true)
    requestManifest(repoPath, cacheEntry(repoPath))
      .then(({ committed }) => {
        if (!mountedRef.current || requestSequence.current !== sequence || !committed) return
        setLoading(false)
        onSuccessRef.current?.()
      })
      .catch((e: unknown) => {
        if (!mountedRef.current || requestSequence.current !== sequence) return
        console.error({ err: e, repoPath }, 'Failed to reload manifest')
        setLoading(false)
        onErrorRef.current?.(e)
      })
  }, [repoPath])

  return { manifest, loading, reload }
}
