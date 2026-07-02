import { useState, useCallback } from 'react'

// Normalized error state for a view. setError accepts an unknown (Error object,
// string, or null to clear) and stores a string message.
export function useViewError() {
  const [error, setError] = useState<string | null>(null)
  const normalize = useCallback((e: unknown) => {
    if (e === null || e === undefined) setError(null)
    else if (e instanceof Error) setError(e.message)
    else setError(String(e))
  }, [])
  return { error, setError: normalize }
}
