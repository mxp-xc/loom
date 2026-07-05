const VARIABLE_TOKEN = /\$\{([A-Za-z_][A-Za-z0-9_.-]*)(?::([^}]*))?\}/g

export interface VariableToken {
  key: string
  defaultValue?: string
  start: number
  end: number
}

export function parseVariableTokens(value: string): VariableToken[] {
  const tokens: VariableToken[] = []
  for (const match of value.matchAll(VARIABLE_TOKEN)) {
    tokens.push({
      key: match[1],
      ...(match[2] !== undefined ? { defaultValue: match[2] } : {}),
      start: match.index,
      end: match.index + match[0].length,
    })
  }
  return tokens
}

export function rewriteVariableKey(value: string, oldKey: string, newKey: string): string {
  const tokens = parseVariableTokens(value)
  let cursor = 0
  let rewritten = ''
  for (const token of tokens) {
    rewritten += value.slice(cursor, token.start)
    rewritten +=
      token.key === oldKey
        ? `\${${newKey}${token.defaultValue === undefined ? '' : `:${token.defaultValue}`}}`
        : value.slice(token.start, token.end)
    cursor = token.end
  }
  return rewritten + value.slice(cursor)
}
