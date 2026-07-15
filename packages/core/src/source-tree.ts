import type {
  SourceResourceKind,
  SourceResourceRule,
  SourceResources,
  SourceTreeNode,
  SourceTreeSummary,
} from './types.js'

export interface ResourceSelectionState {
  selected: boolean
  available: boolean
}

export interface ProjectionRoot {
  sourcePath: string
  targetPath: string
}

export function summarizeSourceTree(nodes: readonly SourceTreeNode[]): SourceTreeSummary {
  const summary: SourceTreeSummary = {
    bundles: 0,
    containers: 0,
    resources: 0,
    symlinks: 0,
    submodules: 0,
  }
  for (const node of nodes) {
    if (node.kind === 'bundle') summary.bundles += 1
    else if (node.kind === 'resource') summary.resources += 1
    else if (node.kind === 'symlink') summary.symlinks += 1
    else if (node.kind === 'submodule') summary.submodules += 1
    else {
      summary.containers += 1
      const children = summarizeSourceTree(node.children)
      for (const key of Object.keys(summary) as Array<keyof SourceTreeSummary>) {
        summary[key] += children[key]
      }
    }
  }
  return summary
}

export function normalizeSourcePath(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '')
  if (
    !normalized ||
    normalized.startsWith('/') ||
    /^[A-Za-z]:\//.test(normalized) ||
    normalized.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    throw new Error(`Invalid source-relative path: ${path}`)
  }
  return normalized
}

export function normalizeSourceResources(resources?: Partial<SourceResources>): SourceResources {
  const include = normalizeRules(resources?.include ?? [])
  const exclude = normalizeRules(resources?.exclude ?? [])
  return {
    include: removeRedundantRules(include, exclude, 'include'),
    exclude: removeRedundantRules(exclude, include, 'exclude'),
  }
}

export function resourceSelectionState(
  path: string,
  kind: SourceResourceKind,
  resources?: Partial<SourceResources>,
): ResourceSelectionState {
  const normalizedPath = normalizeSourcePath(path)
  const normalized = normalizeSourceResources(resources)
  const exactRules = [...normalized.include, ...normalized.exclude].filter(
    (rule) => rule.path === normalizedPath,
  )
  if (exactRules.some((rule) => rule.kind !== kind)) return { selected: false, available: false }

  const matches = [
    ...normalized.include.map((rule) => ({ ...rule, action: 'include' as const })),
    ...normalized.exclude.map((rule) => ({ ...rule, action: 'exclude' as const })),
  ]
    .filter((rule) =>
      rule.kind === 'directory'
        ? isSameOrDescendant(normalizedPath, rule.path)
        : normalizedPath === rule.path,
    )
    .sort(
      (a, b) =>
        pathDepth(b.path) - pathDepth(a.path) ||
        (a.action === b.action ? 0 : a.action === 'exclude' ? -1 : 1),
    )

  return { selected: matches[0]?.action === 'include', available: true }
}

export function projectionBase(selectedRootPaths: readonly string[]): string {
  if (selectedRootPaths.length === 0) return ''
  const parents = selectedRootPaths.map((path) => {
    const parts = normalizeSourcePath(path).split('/')
    return parts.slice(0, -1)
  })
  const common: string[] = []
  for (let i = 0; i < parents[0].length; i += 1) {
    const part = parents[0][i]
    if (!parents.every((candidate) => candidate[i] === part)) break
    common.push(part)
  }
  return common.join('/')
}

export function mapProjectionRoots(selectedRootPaths: readonly string[]): ProjectionRoot[] {
  const normalized = [...new Set(selectedRootPaths.map(normalizeSourcePath))].sort(comparePaths)
  const base = projectionBase(normalized)
  const prefix = base ? `${base}/` : ''
  const roots = normalized.map((sourcePath) => ({
    sourcePath,
    targetPath: sourcePath.startsWith(prefix) ? sourcePath.slice(prefix.length) : sourcePath,
  }))
  const destinations = new Set<string>()
  for (const root of roots) {
    const destination = root.targetPath.toLowerCase()
    if (destinations.has(destination)) {
      throw new Error(`Projection destination collision: ${root.targetPath}`)
    }
    destinations.add(destination)
  }
  return roots
}

function normalizeRules(rules: readonly SourceResourceRule[]): SourceResourceRule[] {
  const unique = new Map<string, SourceResourceRule>()
  for (const rule of rules) {
    const normalized = { path: normalizeSourcePath(rule.path), kind: rule.kind }
    unique.set(`${normalized.path}\0${normalized.kind}`, normalized)
  }
  return [...unique.values()].sort(
    (a, b) => comparePaths(a.path, b.path) || a.kind.localeCompare(b.kind),
  )
}

function removeRedundantRules(
  rules: readonly SourceResourceRule[],
  oppositeRules: readonly SourceResourceRule[],
  action: 'include' | 'exclude',
): SourceResourceRule[] {
  return rules.filter((rule) => {
    const ancestor = [...rules, ...oppositeRules]
      .filter(
        (candidate) =>
          candidate.path !== rule.path && isSameOrDescendant(rule.path, candidate.path),
      )
      .sort((a, b) => pathDepth(b.path) - pathDepth(a.path))[0]
    if (!ancestor || ancestor.kind !== 'directory') return true
    const ancestorAction = rules.includes(ancestor)
      ? action
      : action === 'include'
        ? 'exclude'
        : 'include'
    return ancestorAction !== action
  })
}

function isSameOrDescendant(path: string, ancestor: string): boolean {
  return path === ancestor || path.startsWith(`${ancestor}/`)
}

function pathDepth(path: string): number {
  return path.split('/').length
}

function comparePaths(a: string, b: string): number {
  return a.localeCompare(b, 'en')
}
