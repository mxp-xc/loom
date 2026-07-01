export function resolveGitUrl(url: string): string {
  const m = url.match(/^(github|gitee):([^/]+\/[^/]+)$/)
  if (m) return `https://${m[1]}.com/${m[2]}.git`
  return url
}
