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

const REDACTED = '[已隐藏]'
const sensitiveKey = /^(?:authorization|password|token|secret|api[-_]?key)$/i
const sensitivePrefix =
  /(["']?(?:authorization|password|token|secret|api[-_]?key)["']?\s*[:=]\s*)/gi

function redactJsonValue(value: unknown, key?: string): unknown {
  if (key && sensitiveKey.test(key)) return REDACTED
  if (Array.isArray(value)) return value.map((item) => redactJsonValue(item))
  if (typeof value !== 'object' || value === null) return value
  return Object.fromEntries(
    Object.entries(value).map(([entryKey, entryValue]) => [
      entryKey,
      redactJsonValue(entryValue, entryKey),
    ]),
  )
}

function redactDetail(value: string) {
  const trimmed = value.trim()
  try {
    return JSON.stringify(redactJsonValue(JSON.parse(trimmed)))
  } catch {
    return value
      .replace(new RegExp(`${sensitivePrefix.source}(["'])(.*?)\\2`, 'gi'), `$1$2${REDACTED}$2`)
      .replace(/(authorization\s*[:=]\s*)(?:Bearer\s+)?[^\s,;&]+/gi, `$1${REDACTED}`)
      .replace(new RegExp(`${sensitivePrefix.source}[^\\s,;&]+`, 'gi'), `$1${REDACTED}`)
  }
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
