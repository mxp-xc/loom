import {
  buildVariableReferenceGraph,
  inspectVariableDelete,
  type VarLocation,
} from './vars-graph.js'
import { VAR_KEY, type VarEntry, type VarsDiagnostic, type VarsEnvironment } from './vars-types.js'
import { rewriteVariableKey } from './vars-template.js'
import { normalizeVarEntry } from './vars-value.js'

export interface MutationResult {
  environments: Record<string, VarsEnvironment>
  changed: string[]
  diagnostics: VarsDiagnostic[]
  deleteImpact?: ReturnType<typeof inspectVariableDelete>
}

type Environments = Record<string, VarsEnvironment>

function owns(record: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key)
}

function diagnostic(
  code: string,
  severity: VarsDiagnostic['severity'],
  message: string,
  environment?: string,
  key?: string,
): VarsDiagnostic {
  return { code, severity, environment, key, message }
}

function cloneEntries(entries: Record<string, VarEntry>): Record<string, VarEntry> {
  const clone = Object.create(null) as Record<string, VarEntry>
  for (const key of Object.keys(entries)) clone[key] = normalizeVarEntry(entries[key])!
  return clone
}

function cloneEnvironments(environments: Environments): Environments {
  const clone = Object.create(null) as Environments
  for (const name of Object.keys(environments)) {
    clone[name] = { ...environments[name], entries: cloneEntries(environments[name].entries) }
  }
  return clone
}

function snapshot(environments: Environments): Environments {
  return cloneEnvironments(environments)
}

function definedKeys(environments: Environments): Set<string> {
  const keys = new Set<string>()
  for (const environment of Object.values(environments)) {
    for (const key of Object.keys(environment.entries)) keys.add(key)
  }
  return keys
}

function danglingReferences(
  environments: Environments,
): Map<string, { location: VarLocation; referencedKey: string }> {
  const definitions = definedKeys(environments)
  const dangling = new Map<string, { location: VarLocation; referencedKey: string }>()
  for (const edge of buildVariableReferenceGraph(environments).edges) {
    if (definitions.has(edge.referencedKey) || edge.hasDefault) continue
    const id = `${edge.from.environment}\0${edge.from.key}\0${edge.referencedKey}`
    dangling.set(id, { location: edge.from, referencedKey: edge.referencedKey })
  }
  return dangling
}

export function danglingDiagnostics(environments: Environments): VarsDiagnostic[] {
  return [...danglingReferences(environments).values()].map(({ location, referencedKey }) => ({
    ...diagnostic(
      'dangling_reference',
      'warning',
      `变量 ${location.key} 引用了不存在的变量 ${referencedKey}`,
      location.environment,
      location.key,
    ),
    referencedKey,
    path: [location.key, referencedKey],
  }))
}

function validateEntry(key: string, entry: VarEntry): VarsDiagnostic[] {
  if (!VAR_KEY.test(key))
    return [diagnostic('invalid_key', 'error', `变量名不合法: ${key}`, undefined, key)]
  if (normalizeVarEntry(entry)) return []
  return [diagnostic('invalid_value', 'error', `变量 ${key} 的值与类型不匹配`, undefined, key)]
}

function missingEnvironment(
  environments: Environments,
  environment: string,
): MutationResult | undefined {
  if (owns(environments, environment)) return undefined
  return {
    environments: snapshot(environments),
    changed: [],
    diagnostics: [
      diagnostic('environment_not_found', 'error', `环境不存在: ${environment}`, environment),
    ],
  }
}

export function setVariable(
  environments: Environments,
  environment: string,
  key: string,
  entry: VarEntry,
): MutationResult {
  const environmentError = missingEnvironment(environments, environment)
  if (environmentError) return environmentError
  const entryDiagnostics = validateEntry(key, entry)
  if (entryDiagnostics.length > 0)
    return { environments: snapshot(environments), changed: [], diagnostics: entryDiagnostics }

  const beforeDangling = danglingReferences(environments)
  const next = cloneEnvironments(environments)
  next[environment].entries[key] = normalizeVarEntry(entry)!
  const afterDangling = danglingReferences(next)
  const additions = [...afterDangling.entries()].filter(([id]) => !beforeDangling.has(id))
  if (additions.length > 0) {
    return {
      environments: snapshot(environments),
      changed: [],
      diagnostics: additions.map(([, { location, referencedKey }]) => ({
        ...diagnostic(
          'missing_reference',
          'error',
          `变量 ${location.key} 引用了不存在的变量 ${referencedKey}`,
          location.environment,
          location.key,
        ),
        referencedKey,
        path: [location.key, referencedKey],
      })),
    }
  }
  return { environments: next, changed: [environment], diagnostics: danglingDiagnostics(next) }
}

export function deleteVariable(
  environments: Environments,
  environment: string,
  key: string,
  options: { confirmed: false } | { confirmed: true; expectedImpactToken?: string },
): MutationResult {
  const environmentError = missingEnvironment(environments, environment)
  if (environmentError) return environmentError
  if (!owns(environments[environment].entries, key)) {
    return {
      environments: snapshot(environments),
      changed: [],
      diagnostics: [diagnostic('not_found', 'error', `变量不存在: ${key}`, environment, key)],
    }
  }
  const impact = inspectVariableDelete(environments, environment, key)
  if (!options.confirmed && (impact.direct.length > 0 || impact.transitive.length > 0)) {
    return {
      environments: snapshot(environments),
      changed: [],
      diagnostics: [
        diagnostic(
          'delete_confirmation_required',
          'error',
          `变量 ${key} 仍被其他变量引用`,
          environment,
          key,
        ),
      ],
      deleteImpact: impact,
    }
  }
  if (options.confirmed && (impact.direct.length > 0 || impact.transitive.length > 0)) {
    if (!options.expectedImpactToken) {
      return {
        environments: snapshot(environments),
        changed: [],
        diagnostics: [
          diagnostic(
            'delete_confirmation_required',
            'error',
            `变量 ${key} 需要确认删除影响`,
            environment,
            key,
          ),
        ],
        deleteImpact: impact,
      }
    }
    if (options.expectedImpactToken !== impact.impactToken) {
      return {
        environments: snapshot(environments),
        changed: [],
        diagnostics: [
          diagnostic('impact_changed', 'error', `变量 ${key} 的删除影响已变化`, environment, key),
        ],
        deleteImpact: impact,
      }
    }
  }
  const next = cloneEnvironments(environments)
  delete next[environment].entries[key]
  return { environments: next, changed: [environment], diagnostics: danglingDiagnostics(next) }
}

export function renameVariable(
  environments: Environments,
  environment: string,
  oldKey: string,
  newKey: string,
): MutationResult {
  const environmentError = missingEnvironment(environments, environment)
  if (environmentError) return environmentError
  if (!owns(environments[environment].entries, oldKey)) {
    return {
      environments: snapshot(environments),
      changed: [],
      diagnostics: [diagnostic('not_found', 'error', `变量不存在: ${oldKey}`, environment, oldKey)],
    }
  }
  const keyDiagnostics = validateEntry(newKey, environments[environment].entries[oldKey])
  if (keyDiagnostics.length > 0)
    return { environments: snapshot(environments), changed: [], diagnostics: keyDiagnostics }
  if (oldKey === newKey)
    return {
      environments: snapshot(environments),
      changed: [],
      diagnostics: danglingDiagnostics(environments),
    }
  if (Object.values(environments).some((item) => owns(item.entries, newKey))) {
    return {
      environments: snapshot(environments),
      changed: [],
      diagnostics: [
        diagnostic('variable_conflict', 'error', `变量已存在: ${newKey}`, environment, newKey),
      ],
    }
  }

  const next = cloneEnvironments(environments)
  const changed = new Set<string>()
  for (const name of Object.keys(next)) {
    const originalEntries = next[name].entries
    const rebuilt = Object.create(null) as Record<string, VarEntry>
    for (const key of Object.keys(originalEntries)) {
      const renamedKey = key === oldKey ? newKey : key
      let entry = originalEntries[key]
      if (entry.type === 'string' || entry.type === 'secret') {
        const value = rewriteVariableKey(entry.value, oldKey, newKey)
        if (value !== entry.value) {
          entry = { ...entry, value }
          changed.add(name)
        }
      }
      rebuilt[renamedKey] = entry
      if (renamedKey !== key) changed.add(name)
    }
    next[name] = { ...next[name], entries: rebuilt }
  }
  return {
    environments: next,
    changed: [...changed].sort(),
    diagnostics: danglingDiagnostics(next),
  }
}
