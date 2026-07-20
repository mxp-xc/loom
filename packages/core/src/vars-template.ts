const VARIABLE_TOKEN = /\$\{([A-Za-z_][A-Za-z0-9_.-]*)(?::([^}]*))?\}/g

export interface VariableToken {
  key: string
  defaultValue?: string
  start: number
  end: number
}

export interface ScannedVariableToken extends VariableToken {
  backslashCount: number
  escaped: boolean
}

export function scanVariableTokens(value: string): ScannedVariableToken[] {
  const tokens: ScannedVariableToken[] = []
  for (const match of value.matchAll(VARIABLE_TOKEN)) {
    let slashStart = match.index
    while (slashStart > 0 && value[slashStart - 1] === '\\') slashStart -= 1
    const backslashCount = match.index - slashStart
    tokens.push({
      key: match[1],
      ...(match[2] !== undefined ? { defaultValue: match[2] } : {}),
      start: match.index,
      end: match.index + match[0].length,
      backslashCount,
      escaped: backslashCount % 2 === 1,
    })
  }
  return tokens
}

export function parseVariableTokens(value: string): VariableToken[] {
  return scanVariableTokens(value)
    .filter((token) => !token.escaped)
    .map(({ key, defaultValue, start, end }) => ({
      key,
      ...(defaultValue !== undefined ? { defaultValue } : {}),
      start,
      end,
    }))
}

export function replaceVariableTokens(
  value: string,
  replace: (token: VariableToken) => string,
): string {
  const tokens = scanVariableTokens(value)
  let cursor = 0
  let rendered = ''
  for (const token of tokens) {
    const slashStart = token.start - token.backslashCount
    rendered += value.slice(cursor, slashStart)
    rendered += '\\'.repeat(Math.floor(token.backslashCount / 2))
    rendered += token.escaped ? value.slice(token.start, token.end) : replace(token)
    cursor = token.end
  }
  return rendered + value.slice(cursor)
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
