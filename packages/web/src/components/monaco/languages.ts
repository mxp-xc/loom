export function languageForFile(path: string, fallback = 'plaintext'): string {
  const normalized = path.toLowerCase()
  const extension = normalized.includes('.') ? normalized.slice(normalized.lastIndexOf('.')) : ''

  switch (extension) {
    case '.md':
    case '.markdown':
      return 'markdown'
    case '.json':
      return 'json'
    case '.yaml':
    case '.yml':
      return 'yaml'
    case '.sh':
    case '.bash':
    case '.zsh':
      return 'shell'
    case '.toml':
      return 'plaintext'
    default:
      return fallback
  }
}

export function languageForVarValue(type: string, format?: string | null): string {
  if (type === 'json') return 'json'
  if (type !== 'string') return 'plaintext'

  switch (format) {
    case 'markdown':
      return 'markdown'
    case 'json':
      return 'json'
    case 'yaml':
      return 'yaml'
    case 'shell':
      return 'shell'
    case 'toml':
    case 'path':
    case 'plain':
    default:
      return 'plaintext'
  }
}
