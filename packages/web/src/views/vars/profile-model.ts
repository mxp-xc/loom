import type { AgentId } from '../../lib/agents'
import type {
  ResolvedVarEntry,
  StringFormat,
  VarEntryInput,
  VarOverride,
  VarsDiagnostic,
  VarsLayerRef,
  VarsMatrixResponse,
} from '../../lib/vars'

export type VarsProfileId = 'builtin' | 'base' | 'local'
export type VarsProfileKindBadge = 'runtime' | 'locked' | 'local'
export type VarsProfileEntryState = 'readonly' | 'configured' | 'available'

export type VarsProfileEntry = {
  key: string
  type: VarEntryInput['type']
  format?: StringFormat
  valuePreview: string
  state: VarsProfileEntryState
  agentSlots: AgentId[]
  diagnostics: VarsDiagnostic[]
}

export type VarsProfileSummary = {
  id: VarsProfileId
  name: 'Builtin' | 'Base' | 'Local'
  kindBadge: VarsProfileKindBadge
  description: string
  configuredCount: number
  locked: boolean
  entries: VarsProfileEntry[]
}

export type VarsResolvedRow = {
  key: string
  type: VarEntryInput['type']
  format?: StringFormat
  valuePreview: string
  sourceLabel: string
  diagnostics: VarsDiagnostic[]
}

export type VarsViewScope = 'default' | AgentId

export type VarsProfileState = {
  profiles: VarsProfileSummary[]
  resolvedRows: VarsResolvedRow[]
  activeMatrix: VarsMatrixResponse
  definitionMatrix: VarsMatrixResponse
}

export type BuildVarsProfileStateInput = {
  matricesByAgent: Record<AgentId, VarsMatrixResponse>
  activeAgent: AgentId
  definitionAgent: AgentId
  definitionScope: VarsViewScope
  showAvailable: boolean
}

const agents: AgentId[] = ['claude-code', 'codex', 'opencode']

export function entryValuePreview(
  entry: VarEntryInput | VarOverride | ResolvedVarEntry | undefined,
): string {
  if (!entry) return ''
  if (typeof entry.value === 'string') return entry.value
  if (typeof entry.value === 'number' || typeof entry.value === 'boolean')
    return String(entry.value)
  return JSON.stringify(entry.value, null, 2)
}

export function parseVarDraft(
  type: VarEntryInput['type'],
  value: string,
  format?: string,
): VarEntryInput {
  if (type === 'number') return { type, value: Number(value) }
  if (type === 'boolean') return { type, value: value === 'true' }
  if (type === 'json') return { type, value: JSON.parse(value) }
  if (type === 'secret') return { type, value }
  return format && format !== 'plain' ? { type, format: format as never, value } : { type, value }
}

export function parseOverrideDraft(type: VarEntryInput['type'], value: string): VarOverride {
  if (type === 'number') return { value: Number(value) }
  if (type === 'boolean') return { value: value === 'true' }
  if (type === 'json') return { value: JSON.parse(value) }
  return { value }
}

export function jsonStringError(value: string): string | null {
  try {
    JSON.parse(value)
    return null
  } catch (error) {
    return error instanceof Error ? error.message : 'JSON 格式无效'
  }
}

function sourceLabel(source: VarsLayerRef | undefined): string {
  if (!source) return '—'
  if (source.locality === 'builtin') return 'builtin/runtime'
  if (source.locality === 'synced' && source.layer === 'base') return 'base'
  if (source.locality === 'synced' && source.layer === 'agent') return 'base/' + source.agent
  if (source.locality === 'local' && source.layer === 'local') return 'local'
  return 'local/' + source.agent
}

function definitionFor(matrix: VarsMatrixResponse, key: string): VarEntryInput {
  return matrix.snapshot.base[key] ?? { type: 'string', value: '' }
}

function diagnosticsFor(matrix: VarsMatrixResponse, key: string): VarsDiagnostic[] {
  return matrix.resolution.diagnostics.filter((diagnostic) => diagnostic.key === key)
}

function agentSlotsFor(
  matricesByAgent: Record<AgentId, VarsMatrixResponse>,
  layer: 'baseAgent' | 'localAgent',
  key: string,
): AgentId[] {
  return agents.filter((agent) => Boolean(matricesByAgent[agent].snapshot[layer][key]))
}

function formatFor(entry: VarEntryInput | ResolvedVarEntry): StringFormat | undefined {
  return entry.type === 'string' && 'format' in entry ? entry.format : undefined
}

function buildBuiltinEntries(activeMatrix: VarsMatrixResponse): VarsProfileEntry[] {
  if (!activeMatrix.resolution.ok) return []
  const resolution = activeMatrix.resolution
  return activeMatrix.builtinKeys.map((key) => {
    const value = resolution.values[key]
    return {
      key,
      type: value?.type ?? 'string',
      format: value ? formatFor(value) : undefined,
      valuePreview: entryValuePreview(value),
      state: 'readonly',
      agentSlots: [],
      diagnostics: diagnosticsFor(activeMatrix, key),
    }
  })
}

function buildBaseEntries(
  matricesByAgent: Record<AgentId, VarsMatrixResponse>,
  activeMatrix: VarsMatrixResponse,
  scope: VarsViewScope,
): VarsProfileEntry[] {
  return activeMatrix.userKeys.map((key) => {
    const definition = definitionFor(activeMatrix, key)
    const value =
      scope === 'default' ? definition : (activeMatrix.snapshot.baseAgent[key] ?? definition)
    return {
      key,
      type: definition.type,
      format: formatFor(definition),
      valuePreview: entryValuePreview(value),
      state: 'configured',
      agentSlots: agentSlotsFor(matricesByAgent, 'baseAgent', key),
      diagnostics: diagnosticsFor(activeMatrix, key),
    }
  })
}

function buildLocalEntries(
  matricesByAgent: Record<AgentId, VarsMatrixResponse>,
  activeMatrix: VarsMatrixResponse,
  scope: VarsViewScope,
  showAvailable: boolean,
): VarsProfileEntry[] {
  const configuredKeys = new Set<string>(Object.keys(activeMatrix.snapshot.local))
  for (const agent of agents) {
    for (const key of Object.keys(matricesByAgent[agent].snapshot.localAgent))
      configuredKeys.add(key)
  }

  const configured = Array.from(configuredKeys)
    .sort()
    .map((key) => {
      const definition = definitionFor(activeMatrix, key)
      const localValue = activeMatrix.snapshot.local[key]
      const localAgentValue =
        scope === 'default' ? undefined : activeMatrix.snapshot.localAgent[key]
      return {
        key,
        type: definition.type,
        format: formatFor(definition),
        valuePreview: entryValuePreview(localAgentValue ?? localValue),
        state: 'configured' as const,
        agentSlots: agentSlotsFor(matricesByAgent, 'localAgent', key),
        diagnostics: diagnosticsFor(activeMatrix, key),
      }
    })

  if (!showAvailable) return configured

  const available = activeMatrix.userKeys
    .filter((key) => !configuredKeys.has(key))
    .map((key) => {
      const definition = definitionFor(activeMatrix, key)
      return {
        key,
        type: definition.type,
        format: formatFor(definition),
        valuePreview: '未配置',
        state: 'available' as const,
        agentSlots: [],
        diagnostics: diagnosticsFor(activeMatrix, key),
      }
    })

  return [...configured, ...available]
}

function buildResolvedRows(activeMatrix: VarsMatrixResponse): VarsResolvedRow[] {
  if (!activeMatrix.resolution.ok) return []
  const resolution = activeMatrix.resolution
  return [...activeMatrix.builtinKeys, ...activeMatrix.userKeys].map((key) => {
    const value = resolution.values[key]
    const source = resolution.sources[key]
    return {
      key,
      type: value?.type ?? 'string',
      format: value ? formatFor(value) : undefined,
      valuePreview: entryValuePreview(value),
      sourceLabel: sourceLabel(source),
      diagnostics: diagnosticsFor(activeMatrix, key),
    }
  })
}

export function buildVarsProfileState(input: BuildVarsProfileStateInput): VarsProfileState {
  const activeMatrix = input.matricesByAgent[input.activeAgent]
  const definitionMatrix = input.matricesByAgent[input.definitionAgent] ?? activeMatrix
  const builtinEntries = buildBuiltinEntries(definitionMatrix)
  const baseEntries = buildBaseEntries(
    input.matricesByAgent,
    definitionMatrix,
    input.definitionScope,
  )
  const localEntries = buildLocalEntries(
    input.matricesByAgent,
    definitionMatrix,
    input.definitionScope,
    input.showAvailable,
  )

  return {
    activeMatrix,
    definitionMatrix,
    resolvedRows: buildResolvedRows(activeMatrix),
    profiles: [
      {
        id: 'builtin',
        name: 'Builtin',
        kindBadge: 'runtime',
        description: '运行时内置 · 只读',
        configuredCount: builtinEntries.length,
        locked: true,
        entries: builtinEntries,
      },
      {
        id: 'base',
        name: 'Base',
        kindBadge: 'locked',
        description: '变量定义 registry',
        configuredCount: baseEntries.length,
        locked: true,
        entries: baseEntries,
      },
      {
        id: 'local',
        name: 'Local',
        kindBadge: 'local',
        description: '本机专属',
        configuredCount: localEntries.filter((entry) => entry.state === 'configured').length,
        locked: false,
        entries: localEntries,
      },
    ],
  }
}
