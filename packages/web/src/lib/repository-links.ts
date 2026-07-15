interface ParsedRepository {
  hostname: string
  webUrl: string
}

const fileRouteByHost = new Map([
  ['github.com', 'blob'],
  ['gitlab.com', '-/blob'],
  ['gitcode.com', 'blob'],
  ['gitee.com', 'blob'],
])

const windowsDrivePathPattern = /^[a-z]:[\\/]/i
const explicitUrlPattern = /^[a-z][a-z\d+.-]*:\/\//i
const unsupportedShorthandPattern = /^(?:github|gitee):/i

export function inferRepositoryWebUrl(sourceUrl: string): string | null {
  return parseRepository(sourceUrl)?.webUrl ?? null
}

export function inferRepositoryFileWebUrl(
  sourceUrl: string,
  ref: string,
  relativePath: string,
): string | null {
  const repository = parseRepository(sourceUrl)
  const encodedRef = encodePathSegments(ref)
  const encodedPath = encodePathSegments(relativePath.replace(/\\/g, '/'))
  if (!repository || !encodedRef || !encodedPath) return null

  const route = fileRouteByHost.get(repository.hostname) ?? 'blob'
  return `${repository.webUrl}/${route}/${encodedRef}/${encodedPath}`
}

function parseRepository(sourceUrl: string): ParsedRepository | null {
  const value = sourceUrl.trim()
  if (!value || windowsDrivePathPattern.test(value) || unsupportedShorthandPattern.test(value)) {
    return null
  }

  if (!explicitUrlPattern.test(value)) {
    const scpLike = parseScpLikeRemote(value)
    if (scpLike) return buildRepository('https:', scpLike.host, scpLike.path)
  }

  if (!URL.canParse(value)) return null
  const remote = new URL(value)
  if (!['http:', 'https:', 'ssh:', 'git:'].includes(remote.protocol)) return null

  const protocol = remote.protocol === 'http:' ? 'http:' : 'https:'
  const host =
    remote.protocol === 'http:' || remote.protocol === 'https:' ? remote.host : remote.hostname
  return buildRepository(protocol, host, remote.pathname)
}

function parseScpLikeRemote(value: string): { host: string; path: string } | null {
  const match = value.match(/^(?:[^@\s/:]+@)?(\[[^\]]+\]|[^:/\\\s]+):(.+)$/)
  if (!match) return null

  const [, host, path] = match
  if (!host || !path || path.includes('\\')) return null
  return { host, path: path.split(/[?#]/, 1)[0] ?? '' }
}

function buildRepository(
  protocol: 'http:' | 'https:',
  host: string,
  path: string,
): ParsedRepository | null {
  const repositoryPath = normalizeRepositoryPath(path)
  if (!host || !repositoryPath || !URL.canParse(`${protocol}//${host}`)) return null

  const webUrl = new URL(`${protocol}//${host}`)
  if (!webUrl.hostname) return null
  webUrl.username = ''
  webUrl.password = ''
  webUrl.search = ''
  webUrl.hash = ''
  webUrl.pathname = '/' + repositoryPath

  return {
    hostname: webUrl.hostname.toLowerCase(),
    webUrl: webUrl.href.replace(/\/$/, ''),
  }
}

function normalizeRepositoryPath(path: string): string {
  return path
    .split(/[?#]/, 1)[0]!
    .replace(/^\/+|\/+$/g, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '')
}

function encodePathSegments(value: string): string | null {
  const segments = value
    .replace(/^\/+|\/+$/g, '')
    .split('/')
    .filter(Boolean)
  if (segments.some((segment) => segment === '.' || segment === '..')) return null
  return segments.map(encodeURIComponent).join('/')
}
