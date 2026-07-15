import { useState, useEffect, useCallback, useRef } from 'react'
import { api } from '@/lib/api'
import type { Manifest } from '@loom/core'

// Module-level cache keyed by repoPath: every consumer sharing the same repoPath
// gets the same manifest data, so the fetch happens once. reload() busts the
// cache and notifies all listeners.
interface ManifestCacheEntry {
  data: Manifest | null
  listeners: Set<() => void>
  initialRequest: Promise<Manifest> | null
}

const cache = new Map<string, ManifestCacheEntry>()

function cacheEntry(repoPath: string): ManifestCacheEntry {
  const existing = cache.get(repoPath)
  if (existing) return existing
  const entry = { data: null, listeners: new Set<() => void>(), initialRequest: null }
  cache.set(repoPath, entry)
  return entry
}

function loadInitialManifest(repoPath: string, entry: ManifestCacheEntry): Promise<Manifest> {
  if (entry.initialRequest) return entry.initialRequest
  const request = api.getManifest(repoPath).then((manifest) => {
    const data = manifest as Manifest
    entry.data = data
    entry.listeners.forEach((listener) => listener())
    return data
  })
  entry.initialRequest = request
  const clear = () => {
    if (entry.initialRequest === request) entry.initialRequest = null
  }
  void request.then(clear, clear)
  return request
}

export async function refreshManifest(repoPath: string): Promise<Manifest> {
  const data = (await api.getManifest(repoPath)) as Manifest
  const entry = cacheEntry(repoPath)
  entry.data = data
  entry.listeners.forEach((listener) => listener())
  return data
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

  useEffect(() => {
    let active = true
    const listener = () => {
      const cached = cache.get(repoPath)
      if (cached) setManifest(cached.data)
    }
    const entry = cacheEntry(repoPath)
    entry.listeners.add(listener)

    if (!entry.data) {
      setLoading(true)
      loadInitialManifest(repoPath, entry)
        .then((data) => {
          if (!active) return
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
