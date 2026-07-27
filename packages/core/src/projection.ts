import type { Manifest, AgentId, Config, Memory, SkillSource, SourceTreeNode } from './types.js'
import { applicableAgents } from './agents.js'
import {
  skillProjectionDestinationKey,
  skillProjectionDestinations,
  type SkillProjectionDestination,
  type SkillProjectionDestinationKey,
} from './skill-projection.js'
import { normalizeSourceResources, projectionBase, resourceSelectionState } from './source-tree.js'
import { assertLocalSkillId } from './skill-id.js'

export interface LinkPlan {
  skillId: string
  localPath?: string
  source: 'local' | { repoId: string; cacheId?: string; memberName: string; path?: string }
  destinations: SkillProjectionDestination[]
}
export interface McpPlanEntry {
  id: string
  agents: AgentId[]
}
export interface MemoryPlanEntry {
  memory: Memory
  content: string
  agents: AgentId[]
}
export interface MemoryPlan {
  entries?: MemoryPlanEntry[]
  /** Legacy compatibility fields. New executors use entries. */
  active: Memory | null
  content: string | null
  agents: AgentId[]
}
export interface SourceProjectionEntry {
  kind: 'bundle' | 'resource-file' | 'resource-directory'
  sourcePath: string
  targetPath: string
}
export interface SourceProjectionPlan {
  sourceName: string
  sourceUrl: string
  cacheId: string
  commit: string
  destination: SkillProjectionDestination
  projectionBase: string
  entries: SourceProjectionEntry[]
}
export interface PreservedSourceNamespace {
  sourceName: string
  sourceUrl: string
  destination: SkillProjectionDestination
}
export interface ProjectionPlan {
  links: LinkPlan[]
  sourcePlans: SourceProjectionPlan[]
  preservedSourceNamespaces?: PreservedSourceNamespace[]
  mcpEntries: McpPlanEntry[]
  memoryPlan: MemoryPlan
  skippedAgents: AgentId[]
  strategy: 'link' | 'copy'
}

export type SkillNaming = NonNullable<Config['skill_naming']>

export interface SourceIdentity {
  repoId: string
}

type SourceIdentityInput = string | Pick<SkillSource, 'name' | 'url'> | SourceIdentity

export function resolveSkillNaming(config?: Pick<Config, 'skill_naming'> | null): SkillNaming {
  return config?.skill_naming ?? 'dir'
}

export function sourceIdentity(source: string | Pick<SkillSource, 'name' | 'url'>): SourceIdentity {
  if (typeof source === 'string') return { repoId: deriveRepoId(source) }
  const name = source.name?.trim()
  return { repoId: name || deriveRepoId(source.url) }
}

export function formatSourceMemberSkillId(
  source: SourceIdentityInput,
  memberName: string,
  configOrNaming?: Pick<Config, 'skill_naming'> | SkillNaming | null,
): string {
  const repoId = sourceRepoId(source)
  const naming =
    typeof configOrNaming === 'string' ? configOrNaming : resolveSkillNaming(configOrNaming)
  return naming === 'hyphen' ? repoId + '-' + memberName : repoId + '/' + memberName
}

export function parseSourceMemberSkillId(skillId: string, source: SourceIdentityInput): string {
  const repoId = sourceRepoId(source)
  const hyphenPrefix = repoId + '-'
  const dirPrefix = repoId + '/'
  if (skillId.startsWith(hyphenPrefix)) return skillId.slice(hyphenPrefix.length)
  if (skillId.startsWith(dirPrefix)) return skillId.slice(dirPrefix.length)
  return skillId
}

export function planProjection(
  manifest: Manifest,
  effectiveConfig: Config,
  installedAgents: Set<AgentId>,
): ProjectionPlan {
  const skippedAgents: AgentId[] = []
  const activeAgents = (
    ts: readonly AgentId[],
    capability: 'skills' | 'mcp' | 'memory',
  ): AgentId[] => {
    const out: AgentId[] = []
    const requested = new Set(ts)
    for (const a of applicableAgents(effectiveConfig.agents, capability)) {
      if (!requested.has(a)) continue
      if (installedAgents.has(a)) out.push(a)
      else skippedAgents.push(a)
    }
    return out
  }

  const links: LinkPlan[] = []
  for (const s of manifest.skills.skills) {
    assertLocalSkillId(s.id)
    const agents = activeAgents(s.agents ?? [], 'skills')
    links.push({
      skillId: s.id,
      source: 'local',
      ...(s.path ? { localPath: s.path } : {}),
      destinations: skillProjectionDestinations(s, agents),
    })
  }
  const sourcePlans = manifest.skills.sources.flatMap((source) =>
    planSourceProjection(source, (assignment) => {
      const agents = activeAgents(assignment.agents ?? [], 'skills')
      return skillProjectionDestinations(assignment, agents)
    }),
  )
  const preservedSourceNamespaces = manifest.skills.sources.flatMap((source) =>
    planUnavailableSourceNamespaces(source, (assignment) => {
      const agents = activeAgents(assignment.agents ?? [], 'skills')
      return skillProjectionDestinations(assignment, agents)
    }),
  )
  assertSkillDestinationCollisions(links, [...sourcePlans, ...preservedSourceNamespaces])

  const mcpEntries: McpPlanEntry[] = manifest.mcp.map((m) => ({
    id: m.id,
    agents: activeAgents(m.agents ?? [], 'mcp'),
  }))

  const explicitMemoryEntries = manifest.memory.memories.flatMap((memory) => {
    const agents = activeAgents(memory.agents ?? [], 'memory')
    return agents.length && memory.content !== undefined
      ? [{ memory, content: memory.content, agents }]
      : []
  })
  const legacyMemoryAgents = activeAgents(
    applicableAgents(effectiveConfig.agents, 'memory'),
    'memory',
  )
  const legacyMemory = manifest.memory.active
  const usesExplicitMemoryAgents = effectiveConfig.memory_agents !== undefined
  const memoryEntries =
    usesExplicitMemoryAgents || !legacyMemory
      ? explicitMemoryEntries
      : [
          {
            memory: legacyMemory,
            content: manifest.memory.activeContent,
            agents: legacyMemoryAgents,
          },
        ]
  const memoryPlan: MemoryPlan = {
    entries: memoryEntries,
    active: legacyMemory,
    content: legacyMemory ? manifest.memory.activeContent : null,
    agents: legacyMemoryAgents,
  }

  return {
    links,
    sourcePlans,
    preservedSourceNamespaces,
    mcpEntries,
    memoryPlan,
    skippedAgents: [...new Set(skippedAgents)],
    strategy: effectiveConfig.projection?.strategy ?? 'link',
  }
}

export function assertSkillDestinationCollisions(
  links: Array<Pick<LinkPlan, 'skillId' | 'destinations'>>,
  sourcePlans: Array<Pick<SourceProjectionPlan, 'sourceName' | 'destination'>>,
): void {
  const namespacesByDestination = new Map<
    SkillProjectionDestinationKey,
    Array<Pick<SourceProjectionPlan, 'sourceName' | 'destination'>>
  >()
  for (const sourcePlan of sourcePlans) {
    const key = skillProjectionDestinationKey(sourcePlan.destination)
    const plans = namespacesByDestination.get(key) ?? []
    plans.push(sourcePlan)
    namespacesByDestination.set(key, plans)
  }

  for (const link of links) {
    const localPath = normalizeProjectionDestination(link.skillId)
    for (const destination of link.destinations) {
      const destinationKey = skillProjectionDestinationKey(destination)
      for (const sourcePlan of namespacesByDestination.get(destinationKey) ?? []) {
        const namespace = normalizeProjectionDestination(sourcePlan.sourceName)
        if (
          localPath === namespace ||
          localPath.startsWith(`${namespace}/`) ||
          namespace.startsWith(`${localPath}/`)
        ) {
          throw new Error(
            `Local skill destination "${link.skillId}" overlaps source namespace "${sourcePlan.sourceName}" for ${destinationKey}`,
          )
        }
      }
    }
  }
}

function normalizeProjectionDestination(path: string): string {
  return path
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '')
    .toLowerCase()
}

function planSourceProjection(
  source: SkillSource,
  activeDestinations: (assignment: {
    agents?: readonly AgentId[]
    shared?: boolean
  }) => SkillProjectionDestination[],
): SourceProjectionPlan[] {
  const sourceTree = source.sourceTree
  const members = source.members ?? []
  if (members.length === 0) return []
  if (source.availability?.available === false) return []
  if (!sourceTree) throw new Error(`SourceTree unavailable for ${source.url}`)
  if (sourceTree.diagnostics.length > 0) {
    throw new Error(sourceTree.diagnostics.map((diagnostic) => diagnostic.message).join('; '))
  }

  const nodes = flattenSourceTree(sourceTree.nodes)
  const bundles = new Map(
    nodes.filter((node) => node.kind === 'bundle').map((node) => [node.entry, node]),
  )
  const resources = normalizeSourceResources(source.resources)
  const selectedResourceNodes = nodes.filter(
    (node) =>
      node.kind === 'resource' && resourceSelectionState(node.path, 'file', resources).selected,
  )
  const destinations = new Map<
    SkillProjectionDestinationKey,
    { destination: SkillProjectionDestination; members: typeof members }
  >()
  for (const member of members) {
    if (!bundles.has(member.entry)) throw new Error(`Selected bundle unavailable: ${member.entry}`)
    for (const destination of activeDestinations(member)) {
      const key = skillProjectionDestinationKey(destination)
      const current = destinations.get(key) ?? { destination, members: [] }
      current.members.push(member)
      destinations.set(key, current)
    }
  }

  const sourceName = sourceIdentity(source).repoId
  const cacheId = deriveRepoId(source.url)
  return [...destinations.values()].map(({ destination, members: destinationMembers }) => {
    const bundleEntries: SourceProjectionEntry[] = destinationMembers.map((member) => {
      const bundle = bundles.get(member.entry)!
      return { kind: 'bundle', sourcePath: bundle.path, targetPath: '' }
    })
    const resourceEntries = planResourceEntries(nodes, selectedResourceNodes, resources)
    const rootPaths = [
      ...bundleEntries.map((entry) => entry.sourcePath),
      ...selectedResourceRoots(resources, nodes, selectedResourceNodes),
    ]
    const base = rootPaths.includes('') ? '' : projectionBase(rootPaths)
    const entries = [...bundleEntries, ...resourceEntries]
      .map((entry) => ({ ...entry, targetPath: relativeToProjectionBase(entry.sourcePath, base) }))
      .sort(
        (left, right) =>
          left.targetPath.localeCompare(right.targetPath, 'en') ||
          left.kind.localeCompare(right.kind),
      )
    assertProjectionDestinations(entries)
    return {
      sourceName,
      sourceUrl: source.url,
      cacheId,
      commit: sourceTree.commit,
      destination,
      projectionBase: base,
      entries,
    }
  })
}

function planUnavailableSourceNamespaces(
  source: SkillSource,
  activeDestinations: (assignment: {
    agents?: readonly AgentId[]
    shared?: boolean
  }) => SkillProjectionDestination[],
): PreservedSourceNamespace[] {
  if (source.availability?.available !== false) return []
  const sourceName = sourceIdentity(source).repoId
  const destinations = new Map<SkillProjectionDestinationKey, SkillProjectionDestination>()
  for (const member of source.members ?? []) {
    for (const destination of activeDestinations(member)) {
      destinations.set(skillProjectionDestinationKey(destination), destination)
    }
  }
  return [...destinations.values()].map((destination) => ({
    sourceName,
    sourceUrl: source.url,
    destination,
  }))
}

export function planSourceProjectionForAgents(
  source: SkillSource,
  agents: ReadonlySet<AgentId>,
): SourceProjectionPlan[] {
  return planSourceProjection(source, (assignment) =>
    skillProjectionDestinations(
      assignment,
      applicableAgents([...agents], 'skills').filter((agent) => agents.has(agent)),
    ).filter((destination) => destination.kind === 'agent'),
  )
}

export function planSourceProjectionForDestinations(
  source: SkillSource,
  destinationKeys: ReadonlySet<SkillProjectionDestinationKey>,
): SourceProjectionPlan[] {
  return planSourceProjection(source, (assignment) =>
    skillProjectionDestinations(assignment, applicableAgents(assignment.agents, 'skills')).filter(
      (destination) => destinationKeys.has(skillProjectionDestinationKey(destination)),
    ),
  )
}

function planResourceEntries(
  nodes: SourceTreeNode[],
  selected: SourceTreeNode[],
  resources: ReturnType<typeof normalizeSourceResources>,
): SourceProjectionEntry[] {
  const entries: SourceProjectionEntry[] = []
  const covered = new Set<string>()
  for (const include of resources.include) {
    if (include.kind !== 'directory') continue
    const container = nodes.find((node) => node.kind === 'container' && node.path === include.path)
    if (!container) continue
    const hasBoundary = nodes.some(
      (node) => node.kind === 'bundle' && isDescendant(node.path, include.path),
    )
    const hasExclusion = resources.exclude.some((rule) =>
      isSameOrDescendant(rule.path, include.path),
    )
    if (hasBoundary || hasExclusion) continue
    const descendants = selected.filter((node) => isDescendant(node.path, include.path))
    if (descendants.length === 0) continue
    entries.push({ kind: 'resource-directory', sourcePath: include.path, targetPath: '' })
    for (const node of descendants) covered.add(node.path)
  }
  for (const node of selected) {
    if (!covered.has(node.path)) {
      entries.push({ kind: 'resource-file', sourcePath: node.path, targetPath: '' })
    }
  }
  return entries
}

function selectedResourceRoots(
  resources: ReturnType<typeof normalizeSourceResources>,
  nodes: SourceTreeNode[],
  selected: SourceTreeNode[],
): string[] {
  return resources.include
    .filter((rule) => {
      const exists = nodes.some(
        (node) =>
          node.path === rule.path &&
          (rule.kind === 'directory' ? node.kind === 'container' : node.kind === 'resource'),
      )
      return exists && selected.some((node) => isSameOrDescendant(node.path, rule.path))
    })
    .map((rule) => rule.path)
}

function flattenSourceTree(nodes: SourceTreeNode[]): SourceTreeNode[] {
  return nodes.flatMap((node) => [
    node,
    ...(node.kind === 'container' ? flattenSourceTree(node.children) : []),
  ])
}

function relativeToProjectionBase(path: string, base: string): string {
  if (!path) return ''
  if (!base) return path
  const prefix = `${base}/`
  if (!path.startsWith(prefix)) throw new Error(`Projection root ${path} is outside base ${base}`)
  return path.slice(prefix.length)
}

function assertProjectionDestinations(entries: SourceProjectionEntry[]): void {
  const roots = new Set<string>()
  for (const entry of entries) {
    const destination = entry.targetPath.toLowerCase()
    if (roots.has(destination)) {
      throw new Error(`Projection destination collision: ${entry.targetPath || '.'}`)
    }
    roots.add(destination)
  }
}

function isDescendant(path: string, ancestor: string): boolean {
  return Boolean(path) && path.startsWith(`${ancestor}/`)
}

function isSameOrDescendant(path: string, ancestor: string): boolean {
  return path === ancestor || isDescendant(path, ancestor)
}

export function deriveRepoId(url: string): string {
  const input = url.trim()
  if (!input) throw new Error('Repository URL must not be empty')

  let pathname: string
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(input)) {
    const authorityAndPath = input.replace(/^[a-z][a-z\d+.-]*:\/\//i, '')
    if (!authorityAndPath || /\s/.test(authorityAndPath)) {
      throw new Error('Invalid repository URL')
    }
    const pathStart = authorityAndPath.indexOf('/')
    pathname = pathStart === -1 ? '' : authorityAndPath.slice(pathStart)
  } else {
    const scpMatch = input.match(/^(?:[^/@:\s]+@)?[^/:\s]+:(.*)$/)
    pathname = scpMatch ? scpMatch[1] : input
  }

  const normalized = pathname.split(/[?#]/, 1)[0].replace(/\/+$/, '')
  const repoId = normalized
    .split('/')
    .at(-1)
    ?.replace(/\.git$/, '')
  if (!repoId || repoId === '.' || repoId === '..') {
    throw new Error('Repository URL has no repository name')
  }
  return repoId
}

function sourceRepoId(source: SourceIdentityInput): string {
  if (typeof source === 'string') return deriveRepoId(source)
  if ('repoId' in source) return source.repoId
  return sourceIdentity(source).repoId
}
