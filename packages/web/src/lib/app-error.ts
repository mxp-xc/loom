export type ErrorFeedbackAction = {
  label: string
  run: () => void | Promise<void>
}

export type AppErrorFeedback = {
  title: string
  message: string
  detail?: string
  code?: string
  action?: ErrorFeedbackAction
}

export type ErrorFeedbackFallback = Pick<AppErrorFeedback, 'title' | 'message' | 'action'>

const knownErrors: Record<string, Pick<AppErrorFeedback, 'title' | 'message'>> = {
  session_expired: {
    title: 'MCP session 已过期',
    message: '请重新连接后再试',
  },
}

function redactDetail(value: string) {
  return value
    .replace(/(authorization\s*[:=]\s*)(?:Bearer\s+)?[^\s,;]+/gi, '$1[已隐藏]')
    .replace(/((?:password|token|secret|api[-_]?key)\s*[:=]\s*)[^\s,;]+/gi, '$1[已隐藏]')
}

export function normalizeErrorFeedback(
  error: unknown,
  fallback: ErrorFeedbackFallback,
): AppErrorFeedback {
  const code =
    error instanceof Error && 'code' in error && typeof error.code === 'string'
      ? error.code
      : undefined
  const known = code ? knownErrors[code] : undefined
  const rawDetail = error instanceof Error ? error.message.trim() : ''
  const detail = rawDetail ? redactDetail(rawDetail) : undefined

  return {
    ...(known ?? fallback),
    ...(code ? { code } : {}),
    ...(detail ? { detail } : {}),
    ...(fallback.action ? { action: fallback.action } : {}),
  }
}
