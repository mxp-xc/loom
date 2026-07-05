import type { VarsEnvironment } from './vars-types.js'
import { parseVariableTokens } from './vars-template.js'

export interface VarLocation {
  environment: string
  key: string
}

export interface VariableReferenceEdge {
  from: VarLocation
  referencedKey: string
  hasDefault?: true
}

export interface VariableReferenceGraph {
  edges: VariableReferenceEdge[]
}

export interface VariableDeleteImpact {
  direct: VarLocation[]
  transitive: VarLocation[]
  impactToken: string
}

export function extractVariableReferences(value: string): string[] {
  const references: string[] = []
  const seen = new Set<string>()
  for (const token of parseVariableTokens(value)) {
    const key = token.key
    if (!seen.has(key)) {
      seen.add(key)
      references.push(key)
    }
  }
  return references
}

export function buildVariableReferenceGraph(
  environments: Record<string, VarsEnvironment>,
): VariableReferenceGraph {
  const edges: VariableReferenceEdge[] = []
  for (const environment of Object.keys(environments).sort()) {
    for (const key of Object.keys(environments[environment].entries).sort()) {
      const entry = environments[environment].entries[key]
      if (entry.type !== 'string' && entry.type !== 'secret') continue
      const references = new Map<string, boolean>()
      for (const token of parseVariableTokens(entry.value)) {
        const referencedKey = token.key
        const hasDefault = token.defaultValue !== undefined
        references.set(referencedKey, (references.get(referencedKey) ?? true) && hasDefault)
      }
      for (const [referencedKey, hasDefault] of references) {
        edges.push({
          from: { environment, key },
          referencedKey,
          ...(hasDefault ? { hasDefault: true as const } : {}),
        })
      }
    }
  }
  return { edges }
}

function compareLocation(left: VarLocation, right: VarLocation): number {
  if (left.environment !== right.environment) return left.environment < right.environment ? -1 : 1
  if (left.key === right.key) return 0
  return left.key < right.key ? -1 : 1
}

function locationId(location: VarLocation): string {
  return `${location.environment}\0${location.key}`
}

export function inspectVariableDelete(
  environments: Record<string, VarsEnvironment>,
  _environment: string,
  key: string,
): VariableDeleteImpact {
  const edges = buildVariableReferenceGraph(environments).edges
  const reverse = new Map<string, VarLocation[]>()
  for (const edge of edges) {
    const locations = reverse.get(edge.referencedKey)
    if (locations) locations.push(edge.from)
    else reverse.set(edge.referencedKey, [edge.from])
  }
  for (const locations of reverse.values()) locations.sort(compareLocation)
  const direct = reverse.get(key) ?? []
  const directIds = new Set(direct.map(locationId))
  const visited = new Set(directIds)
  const queue = [...direct]
  const transitive: VarLocation[] = []

  let queueIndex = 0
  while (queueIndex < queue.length) {
    const dependency = queue[queueIndex++]
    for (const dependent of reverse.get(dependency.key) ?? []) {
      const id = locationId(dependent)
      if (visited.has(id)) continue
      visited.add(id)
      transitive.push(dependent)
      queue.push(dependent)
    }
  }

  const stableDirect = [
    ...new Map(direct.map((location) => [locationId(location), location])).values(),
  ].sort(compareLocation)
  const stableTransitive = transitive
    .filter((location) => !directIds.has(locationId(location)))
    .sort(compareLocation)
  const targetDefinitions = Object.keys(environments)
    .filter((environment) =>
      Object.prototype.hasOwnProperty.call(environments[environment].entries, key),
    )
    .map((environment) => ({ environment, key }))
    .sort(compareLocation)
  const relevant = [
    ...new Map(
      [
        ...targetDefinitions,
        { environment: _environment, key },
        ...stableDirect,
        ...stableTransitive,
      ].map((location) => [locationId(location), location]),
    ).values(),
  ]
  const relevantIds = new Set(relevant.map(locationId))
  const relevantEdges = edges
    .filter((edge) => relevantIds.has(locationId(edge.from)))
    .sort((left, right) => {
      const locationOrder = compareLocation(left.from, right.from)
      if (locationOrder !== 0) return locationOrder
      if (left.referencedKey !== right.referencedKey)
        return left.referencedKey < right.referencedKey ? -1 : 1
      return Number(Boolean(left.hasDefault)) - Number(Boolean(right.hasDefault))
    })
    .map((edge) => ({
      from: edge.from,
      referencedKey: edge.referencedKey,
      hasDefault: Boolean(edge.hasDefault),
    }))
  const topology = {
    target: { environment: _environment, key },
    definitions: targetDefinitions,
    direct: stableDirect,
    transitive: stableTransitive,
    edges: relevantEdges,
  }
  return {
    direct: stableDirect,
    transitive: stableTransitive,
    impactToken: `vars-delete-v2:${encodeURIComponent(JSON.stringify(topology))}`,
  }
}
