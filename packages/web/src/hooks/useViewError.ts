import { useState, useCallback, useRef } from 'react'
import {
  normalizeErrorFeedback,
  type AppErrorFeedback,
  type ErrorFeedbackFallback,
} from '@/lib/app-error'

// Normalized error state for a view. setError accepts an unknown (Error object,
// string, or null to clear) and stores a string message.
const defaultFallback: ErrorFeedbackFallback = {
  title: '内容加载失败',
  message: '请稍后重试',
}

export function useViewError(fallback: ErrorFeedbackFallback = defaultFallback) {
  const [error, setError] = useState<AppErrorFeedback | null>(null)
  const fallbackRef = useRef(fallback)
  fallbackRef.current = fallback
  const normalize = useCallback((e: unknown) => {
    if (e === null || e === undefined) setError(null)
    else setError(normalizeErrorFeedback(e, fallbackRef.current))
  }, [])
  return { error, setError: normalize }
}
