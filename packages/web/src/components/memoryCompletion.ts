export interface CompletionMatch {
  token: string
  query: string
  start: number
}

export function placeholderForKey(key: string): string {
  return '$' + '{' + key + '}'
}

export function completionAt(value: string, cursor: number): CompletionMatch | null {
  const match = value.slice(0, cursor).match(/\$\{([A-Za-z_][A-Za-z0-9_.-]*)?\}?$/)
  if (!match) return null
  const start = cursor - match[0].length
  if (start > 0 && value[start - 1] === '\\') return null
  return { token: match[0], query: (match[1] ?? '').toLowerCase(), start }
}

export function filterCompletionKeys(keys: string[], query: string): string[] {
  return keys.filter((key) => key.toLowerCase().includes(query)).slice(0, 8)
}
