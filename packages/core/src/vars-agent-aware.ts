import type { AgentId } from './types.js'
import type {
  VarDefinition,
  VarOverride,
  VarsDiagnostic,
  VarsLayerRef,
  VarsResolvedEntry,
} from './vars-types.js'

export interface BuiltinVarsRuntime {
  agent: AgentId
  configDir?: string
  skillsDir?: string
  agentFile?: string
}

export interface LayeredVarsInput {
  agent?: AgentId
  base: Record<string, VarDefinition>
  baseAgent?: Record<string, VarOverride>
  local?: Record<string, VarOverride>
  localAgent?: Record<string, VarOverride>
  builtin?: Record<string, VarDefinition>
}

export type LayeredVarsResolution =
  | {
      ok: true
      values: Record<string, VarDefinition>
      sources: Record<string, VarsLayerRef>
      overrideChains: Record<string, VarsLayerRef[]>
      dependencies: Record<string, string[]>
      entries: VarsResolvedEntry[]
      diagnostics: VarsDiagnostic[]
    }
  | { ok: false; diagnostics: VarsDiagnostic[] }

export type RenderTextResult =
  | { ok: true; text: string; diagnostics: VarsDiagnostic[] }
  | { ok: false; diagnostics: VarsDiagnostic[] }

class ResolutionFailure extends Error {
  constructor(readonly diagnostic: VarsDiagnostic) {
    super(diagnostic.message)
  }
}

const baseLayer: VarsLayerRef = { locality: 'synced', layer: 'base' }
const localLayer: VarsLayerRef = { locality: 'local', layer: 'local' }
const builtinLayer = (agent: string): VarsLayerRef => ({
  locality: 'builtin',
  layer: 'runtime',
  agent,
})
const baseAgentLayer = (agent: string): VarsLayerRef => ({
  locality: 'synced',
  layer: 'agent',
  agent,
})
const localAgentLayer = (agent: string): VarsLayerRef => ({
  locality: 'local',
  layer: 'agent',
  agent,
})

function createRecord<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>
}

function diagnostic(
  code: string,
  message: string,
  details: Pick<VarsDiagnostic, 'environment' | 'key' | 'path' | 'referencedKey'> = {},
): VarsDiagnostic {
  return { code, severity: 'error', ...details, message }
}

function cloneDefinition(entry: VarDefinition): VarDefinition {
  return entry.type === 'json'
    ? { type: 'json', value: structuredClone(entry.value) }
    : { ...entry }
}

function definitionWithOverride(
  definition: VarDefinition,
  override: VarOverride,
): VarDefinition | null {
  if (definition.type === 'string' || definition.type === 'secret') {
    return typeof override.value === 'string' ? { ...definition, value: override.value } : null
  }
  if (definition.type === 'number')
    return typeof override.value === 'number' && Number.isFinite(override.value)
      ? { type: 'number', value: override.value }
      : null
  if (definition.type === 'boolean')
    return typeof override.value === 'boolean' ? { type: 'boolean', value: override.value } : null
  return { type: 'json', value: structuredClone(override.value) }
}

export function createBuiltinVars(runtime: BuiltinVarsRuntime): Record<string, VarDefinition> {
  return {
    LOOM_AGENT: { type: 'string', value: runtime.agent },
    LOOM_PROFILE: { type: 'string', value: 'base' },
    LOOM_CONFIG_DIR: { type: 'string', format: 'path', value: runtime.configDir ?? '' },
    LOOM_SKILLS_DIR: { type: 'string', format: 'path', value: runtime.skillsDir ?? '' },
    LOOM_AGENT_FILE: {
      type: 'string',
      format: 'path',
      value: runtime.agentFile ?? (runtime.agent === 'claude-code' ? 'CLAUDE.md' : 'AGENTS.md'),
    },
  }
}

function applyOverrideLayer(
  target: Record<string, VarDefinition>,
  sources: Record<string, VarsLayerRef>,
  chains: Record<string, VarsLayerRef[]>,
  baseDefinitions: Record<string, VarDefinition>,
  overrides: Record<string, VarOverride> | undefined,
  layer: VarsLayerRef,
  diagnostics: VarsDiagnostic[],
): void {
  if (!overrides) return
  for (const [key, override] of Object.entries(overrides)) {
    const definition = baseDefinitions[key]
    if (!definition) {
      diagnostics.push(diagnostic('UNKNOWN_OVERRIDE_KEY', '覆盖了未声明的变量: ' + key, { key }))
      continue
    }
    const next = definitionWithOverride(definition, override)
    if (!next) {
      diagnostics.push(
        diagnostic('OVERRIDE_TYPE_MISMATCH', '变量 ' + key + ' 覆盖值类型不匹配', { key }),
      )
      continue
    }
    target[key] = next
    sources[key] = layer
    if (!chains[key]) chains[key] = [baseLayer]
    chains[key].push(layer)
  }
}

export function resolveLayeredVars(input: LayeredVarsInput): LayeredVarsResolution {
  const diagnostics: VarsDiagnostic[] = []
  const merged = createRecord<VarDefinition>()
  const sources = createRecord<VarsLayerRef>()
  const overrideChains = createRecord<VarsLayerRef[]>()

  for (const [key, definition] of Object.entries(input.base)) {
    if (key.startsWith('LOOM_')) {
      diagnostics.push(
        diagnostic('RESERVED_BUILTIN_KEY', '用户变量不能以 LOOM_ 开头: ' + key, { key }),
      )
      continue
    }
    merged[key] = cloneDefinition(definition)
    sources[key] = baseLayer
    overrideChains[key] = [baseLayer]
  }

  if (input.agent)
    applyOverrideLayer(
      merged,
      sources,
      overrideChains,
      input.base,
      input.baseAgent,
      baseAgentLayer(input.agent),
      diagnostics,
    )
  applyOverrideLayer(
    merged,
    sources,
    overrideChains,
    input.base,
    input.local,
    localLayer,
    diagnostics,
  )
  if (input.agent)
    applyOverrideLayer(
      merged,
      sources,
      overrideChains,
      input.base,
      input.localAgent,
      localAgentLayer(input.agent),
      diagnostics,
    )

  const builtin = input.builtin ?? (input.agent ? createBuiltinVars({ agent: input.agent }) : {})
  for (const [key, definition] of Object.entries(builtin)) {
    const layer = builtinLayer(input.agent ?? 'default')
    merged[key] = cloneDefinition(definition)
    sources[key] = layer
    overrideChains[key] = [layer]
  }

  if (diagnostics.some((item) => item.severity === 'error')) return { ok: false, diagnostics }

  const values = createRecord<VarDefinition>()
  const dependencies = createRecord<string[]>()
  const stack: string[] = []
  const visiting = new Set<string>()
  const ESC = String.fromCharCode(0) + 'DOLLAR_BRACE' + String.fromCharCode(0)

  const resolveEntry = (key: string): VarDefinition => {
    if (Object.hasOwn(values, key)) return values[key]
    const entry = merged[key]
    if (!entry)
      throw new ResolutionFailure(diagnostic('MISSING_REFERENCE', '变量不存在: ' + key, { key }))
    if (entry.type !== 'string' && entry.type !== 'secret') {
      values[key] = cloneDefinition(entry)
      return values[key]
    }
    if (visiting.has(key)) {
      const cycleStart = stack.indexOf(key)
      const path = [...stack.slice(cycleStart), key]
      throw new ResolutionFailure(
        diagnostic('REFERENCE_CYCLE', '变量引用形成循环: ' + path.join(' -> '), {
          key: path[0],
          path,
        }),
      )
    }
    visiting.add(key)
    stack.push(key)
    dependencies[key] = []
    try {
      const protectedValue = entry.value.replaceAll('\\${', ESC)
      const resolvedValue = protectedValue.replace(/\$\{([^}]+)\}/g, (full, raw: string) => {
        const [referencedKey, ...defaultParts] = raw.split(':')
        if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(referencedKey)) return full
        if (!dependencies[key].includes(referencedKey)) dependencies[key].push(referencedKey)
        if (defaultParts.length > 0)
          throw new ResolutionFailure(
            diagnostic('UNSUPPORTED_DEFAULT', '变量默认值语法暂不支持: ' + raw, {
              key,
              referencedKey,
              path: [...stack, referencedKey],
            }),
          )
        if (!Object.hasOwn(merged, referencedKey))
          throw new ResolutionFailure(
            diagnostic(
              'MISSING_REFERENCE',
              '变量 ' + key + ' 引用了不存在的变量 ' + referencedKey,
              {
                key,
                referencedKey,
                path: [...stack, referencedKey],
              },
            ),
          )
        const referenced = resolveEntry(referencedKey)
        if (referenced.type === 'json')
          throw new ResolutionFailure(
            diagnostic('JSON_TEXT_INTERPOLATION', 'JSON 变量不能直接插入文本: ' + referencedKey, {
              key,
              referencedKey,
              path: [...stack, referencedKey],
            }),
          )
        return String(referenced.value)
      })
      values[key] = { ...entry, value: resolvedValue.replaceAll(ESC, '${') }
      return values[key]
    } finally {
      stack.pop()
      visiting.delete(key)
    }
  }

  try {
    for (const key of Object.keys(merged)) resolveEntry(key)
  } catch (error) {
    if (error instanceof ResolutionFailure) return { ok: false, diagnostics: [error.diagnostic] }
    throw error
  }

  return {
    ok: true,
    values,
    sources,
    overrideChains,
    dependencies,
    entries: Object.keys(values)
      .sort()
      .map((key) => ({
        key,
        value: values[key],
        source: sources[key],
        overrides: overrideChains[key] ?? [sources[key]],
        dependencies: dependencies[key] ?? [],
      })),
    diagnostics: [],
  }
}

export function renderTextWithResolvedVars(
  text: string,
  resolution: Extract<LayeredVarsResolution, { ok: true }>,
): RenderTextResult {
  const ESC = String.fromCharCode(0) + 'DOLLAR_BRACE' + String.fromCharCode(0)
  const diagnostics: VarsDiagnostic[] = []
  const rendered = text
    .replaceAll('\\${', ESC)
    .replace(/\$\{([^}]+)\}/g, (full, raw: string) => {
      const [key, ...defaultParts] = raw.split(':')
      if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(key)) return full
      if (defaultParts.length > 0) {
        diagnostics.push(
          diagnostic('UNSUPPORTED_DEFAULT', '变量默认值语法暂不支持: ' + raw, { key, path: [key] }),
        )
        return full
      }
      const entry = resolution.values[key]
      if (!entry) {
        diagnostics.push(
          diagnostic('MISSING_REFERENCE', '模板引用了不存在的变量 ' + key, { key, path: [key] }),
        )
        return full
      }
      if (entry.type === 'json') {
        diagnostics.push(
          diagnostic('JSON_TEXT_INTERPOLATION', 'JSON 变量不能直接插入文本: ' + key, {
            key,
            path: [key],
          }),
        )
        return full
      }
      return String(entry.value)
    })
    .replaceAll(ESC, '${')
  return diagnostics.some((item) => item.severity === 'error')
    ? { ok: false, diagnostics }
    : { ok: true, text: rendered, diagnostics: [] }
}
