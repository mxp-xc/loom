import { basename, join } from 'node:path'
import {
  AgentIdSchema,
  createBuiltinVars,
  parseVarsBaseDefinitions,
  parseVarsOverrides,
  renderTextWithResolvedVars,
  resolveLayeredVars,
  serializeVarsBaseDefinitions,
  serializeVarsOverrides,
  supportsAgentCapability,
  VarsCodecError,
  type AgentId,
  type LayeredVarsResolution,
  type VarDefinition,
  type VarOverride,
  type VarsDiagnostic,
} from '@loom/core'
import type { IFileSystem } from '../ports/fs.js'
import {
  agentConfigDir,
  agentMemoryFile,
  agentSkillsDir,
  runtimeAgentPathContext,
  type AgentPathContext,
} from '../adapters/paths.js'

export type VarsLayerKind = 'base' | 'base-agent' | 'local' | 'local-agent'

export interface AgentAwareVarsSnapshot {
  base: Record<string, VarDefinition>
  baseAgent: Record<string, VarOverride>
  local: Record<string, VarOverride>
  localAgent: Record<string, VarOverride>
}

export interface AgentAwareVarsReadResult {
  snapshot: AgentAwareVarsSnapshot
  diagnostics: VarsDiagnostic[]
}

type OverrideDocument = {
  layer: Exclude<VarsLayerKind, 'base'>
  agent?: AgentId
  path: string
  values: Record<string, VarOverride>
}

type OverrideDocumentsReadResult = {
  documents: OverrideDocument[]
  diagnostics: VarsDiagnostic[]
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

async function readOptional(fs: IFileSystem, path: string): Promise<string | null> {
  try {
    return await fs.readFile(path)
  } catch (error) {
    if (isMissing(error)) return null
    throw error
  }
}

function localRepoPath(home: string, repoPath: string): string {
  return join(home, '.loom', 'local', 'repos', basename(repoPath))
}

function syncedVarsPath(repoPath: string, agent?: AgentId): string {
  return agent
    ? join(repoPath, 'vars', 'agents', agent + '.yaml')
    : join(repoPath, 'vars', 'base.yaml')
}

function localVarsPath(home: string, repoPath: string, agent?: AgentId): string {
  const root = localRepoPath(home, repoPath)
  return agent ? join(root, 'vars', 'agents', agent + '.yaml') : join(root, 'vars', 'local.yaml')
}

async function listAgentOverrideFiles(
  fs: IFileSystem,
  directory: string,
): Promise<Array<{ agent: AgentId; path: string }>> {
  let entries: string[]
  try {
    entries = await fs.readDir(directory)
  } catch (error) {
    if (isMissing(error)) return []
    throw error
  }
  return entries
    .filter((entry) => entry.endsWith('.yaml'))
    .map((entry) => ({ entry, agent: AgentIdSchema.safeParse(entry.slice(0, -'.yaml'.length)) }))
    .filter(
      (item): item is { entry: string; agent: { success: true; data: AgentId } } =>
        item.agent.success,
    )
    .map((item) => ({ agent: item.agent.data, path: join(directory, item.entry) }))
}

async function listAgentOverrideFilesWithDiagnostics(
  fs: IFileSystem,
  directory: string,
  layer: Exclude<VarsLayerKind, 'base'>,
  diagnostics: VarsDiagnostic[],
): Promise<Array<{ agent: AgentId; path: string }>> {
  let entries: string[]
  try {
    entries = await fs.readDir(directory)
  } catch (error) {
    if (isMissing(error)) return []
    throw error
  }
  const files: Array<{ agent: AgentId; path: string }> = []
  for (const entry of entries) {
    if (!entry.endsWith('.yaml')) continue
    const agent = AgentIdSchema.safeParse(entry.slice(0, -'.yaml'.length))
    const path = join(directory, entry)
    if (!agent.success) {
      diagnostics.push(
        diagnostic('UNKNOWN_AGENT_OVERRIDE_FILE', '未知 agent 覆盖文件: ' + entry, {
          layer,
          path: [path],
        }),
      )
      continue
    }
    files.push({ agent: agent.data, path })
  }
  return files
}

async function collectUnknownAgentOverrideDiagnostics(
  fs: IFileSystem,
  directory: string,
  layer: Exclude<VarsLayerKind, 'base'>,
  diagnostics: VarsDiagnostic[],
): Promise<void> {
  await listAgentOverrideFilesWithDiagnostics(fs, directory, layer, diagnostics)
}

function renameKey<T>(values: Record<string, T>, oldKey: string, newKey: string | null): boolean {
  if (!Object.prototype.hasOwnProperty.call(values, oldKey)) return false
  const value = values[oldKey]
  delete values[oldKey]
  if (newKey) values[newKey] = value
  return true
}

function diagnostic(
  code: string,
  message: string,
  options: Partial<VarsDiagnostic> = {},
): VarsDiagnostic {
  return { code, severity: 'error', message, ...options }
}

function codecDiagnostic(error: unknown, layer: string, path: string): VarsDiagnostic {
  const code = error instanceof VarsCodecError ? error.code : 'vars_layer_invalid'
  const message = error instanceof Error ? error.message : 'invalid vars layer'
  return diagnostic(code, message, { layer, path: [path] })
}

function parseBaseLayer(
  source: string | null,
  layer: string,
  path: string,
  diagnostics: VarsDiagnostic[],
) {
  if (!source) return {}
  try {
    return parseVarsBaseDefinitions(source)
  } catch (error) {
    diagnostics.push(codecDiagnostic(error, layer, path))
    return {}
  }
}

function parseOverrideLayer(
  source: string | null,
  layer: string,
  path: string,
  diagnostics: VarsDiagnostic[],
) {
  if (!source) return {}
  try {
    return parseVarsOverrides(source)
  } catch (error) {
    diagnostics.push(codecDiagnostic(error, layer, path))
    return {}
  }
}

export async function readAgentAwareVars(
  fs: IFileSystem,
  home: string,
  repoPath: string,
  agent: AgentId,
): Promise<AgentAwareVarsSnapshot> {
  return (await readAgentAwareVarsWithDiagnostics(fs, home, repoPath, agent)).snapshot
}

export async function readAgentAwareVarsWithDiagnostics(
  fs: IFileSystem,
  home: string,
  repoPath: string,
  agent: AgentId,
): Promise<AgentAwareVarsReadResult> {
  const diagnostics: VarsDiagnostic[] = []
  const basePath = syncedVarsPath(repoPath)
  const baseAgentPath = syncedVarsPath(repoPath, agent)
  const localPath = localVarsPath(home, repoPath)
  const localAgentPath = localVarsPath(home, repoPath, agent)
  const [baseSource, baseAgentSource, localSource, localAgentSource] = await Promise.all([
    readOptional(fs, basePath),
    readOptional(fs, baseAgentPath),
    readOptional(fs, localPath),
    readOptional(fs, localAgentPath),
  ])
  await Promise.all([
    collectUnknownAgentOverrideDiagnostics(
      fs,
      join(repoPath, 'vars', 'agents'),
      'base-agent',
      diagnostics,
    ),
    collectUnknownAgentOverrideDiagnostics(
      fs,
      join(localRepoPath(home, repoPath), 'vars', 'agents'),
      'local-agent',
      diagnostics,
    ),
  ])

  return {
    snapshot: {
      base: parseBaseLayer(baseSource, 'base', basePath, diagnostics),
      baseAgent: parseOverrideLayer(baseAgentSource, 'base-agent', baseAgentPath, diagnostics),
      local: parseOverrideLayer(localSource, 'local', localPath, diagnostics),
      localAgent: parseOverrideLayer(localAgentSource, 'local-agent', localAgentPath, diagnostics),
    },
    diagnostics,
  }
}

export function builtinForAgent(
  agent: AgentId,
  context: AgentPathContext = runtimeAgentPathContext(),
) {
  return createBuiltinVars({
    agent,
    configDir: agentConfigDir(agent, context),
    skillsDir: supportsAgentCapability(agent, 'skills') ? agentSkillsDir(agent, context) : '',
    agentFile: supportsAgentCapability(agent, 'memory')
      ? basename(agentMemoryFile(agent, context))
      : '',
  })
}

export async function resolveAgentAwareVars(
  fs: IFileSystem,
  home: string,
  repoPath: string,
  agent: AgentId,
): Promise<LayeredVarsResolution> {
  const { snapshot, diagnostics } = await readAgentAwareVarsWithDiagnostics(
    fs,
    home,
    repoPath,
    agent,
  )
  if (diagnostics.length > 0) return { ok: false, diagnostics }
  return resolveLayeredVars({
    agent,
    base: snapshot.base,
    baseAgent: snapshot.baseAgent,
    local: snapshot.local,
    localAgent: snapshot.localAgent,
    builtin: builtinForAgent(agent, runtimeAgentPathContext(home)),
  })
}

export async function readDefaultVarsWithDiagnostics(
  fs: IFileSystem,
  home: string,
  repoPath: string,
): Promise<AgentAwareVarsReadResult> {
  const diagnostics: VarsDiagnostic[] = []
  const basePath = syncedVarsPath(repoPath)
  const localPath = localVarsPath(home, repoPath)
  const [baseSource, localSource] = await Promise.all([
    readOptional(fs, basePath),
    readOptional(fs, localPath),
  ])
  return {
    snapshot: {
      base: parseBaseLayer(baseSource, 'base', basePath, diagnostics),
      baseAgent: {},
      local: parseOverrideLayer(localSource, 'local', localPath, diagnostics),
      localAgent: {},
    },
    diagnostics,
  }
}

export async function resolveDefaultVars(
  fs: IFileSystem,
  home: string,
  repoPath: string,
): Promise<LayeredVarsResolution> {
  const { snapshot, diagnostics } = await readDefaultVarsWithDiagnostics(fs, home, repoPath)
  if (diagnostics.length > 0) return { ok: false, diagnostics }
  return resolveLayeredVars({ base: snapshot.base, local: snapshot.local })
}

export async function renderAgentAwareText(
  fs: IFileSystem,
  home: string,
  repoPath: string,
  agent: AgentId,
  text: string,
): Promise<
  | { ok: true; rendered: string; resolution: Extract<LayeredVarsResolution, { ok: true }> }
  | { ok: false; diagnostics: VarsDiagnostic[] }
> {
  const resolution = await resolveAgentAwareVars(fs, home, repoPath, agent)
  if (!resolution.ok) return { ok: false, diagnostics: resolution.diagnostics }
  const rendered = renderTextWithResolvedVars(text, resolution)
  if (!rendered.ok) return { ok: false, diagnostics: rendered.diagnostics }
  return { ok: true, rendered: rendered.text, resolution }
}

export async function writeAgentAwareBase(
  fs: IFileSystem,
  repoPath: string,
  base: Record<string, VarDefinition>,
): Promise<void> {
  const path = syncedVarsPath(repoPath)
  await fs.mkdir(join(path, '..'), true)
  await fs.writeFile(path, serializeVarsBaseDefinitions(base))
}

export async function writeAgentAwareOverride(
  fs: IFileSystem,
  home: string,
  repoPath: string,
  kind: Exclude<VarsLayerKind, 'base'>,
  agent: AgentId | undefined,
  overrides: Record<string, VarOverride>,
): Promise<void> {
  const path =
    kind === 'base-agent'
      ? syncedVarsPath(repoPath, agent)
      : localVarsPath(home, repoPath, kind === 'local-agent' ? agent : undefined)
  await fs.mkdir(join(path, '..'), true)
  await fs.writeFile(path, serializeVarsOverrides(overrides))
}

export async function validateAgentAwareBaseDefinitions(
  fs: IFileSystem,
  home: string,
  repoPath: string,
  base: Record<string, VarDefinition>,
): Promise<VarsDiagnostic[]> {
  const diagnostics: VarsDiagnostic[] = []
  const overrides = await readAllOverrideDocumentsWithDiagnostics(fs, home, repoPath)
  diagnostics.push(...overrides.diagnostics)
  for (const document of overrides.documents) {
    for (const [key, override] of Object.entries(document.values)) {
      const definition = base[key]
      if (!definition) {
        diagnostics.push(
          diagnostic('UNKNOWN_OVERRIDE_KEY', '覆盖了未声明的变量: ' + key, {
            key,
            layer: document.agent ? document.layer + '/' + document.agent : document.layer,
          }),
        )
        continue
      }
      if (!overrideMatchesDefinition(definition, override)) {
        diagnostics.push(
          diagnostic('OVERRIDE_TYPE_MISMATCH', '变量 ' + key + ' 覆盖值类型不匹配', {
            key,
            layer: document.agent ? document.layer + '/' + document.agent : document.layer,
          }),
        )
      }
    }
  }
  return diagnostics
}

export async function deleteAgentAwareBaseKey(
  fs: IFileSystem,
  home: string,
  repoPath: string,
  key: string,
): Promise<
  | { status: 'deleted' }
  | { status: 'missing' }
  | { status: 'blocked'; diagnostics: VarsDiagnostic[] }
> {
  const baseSource = await readOptional(fs, syncedVarsPath(repoPath))
  const base = baseSource ? parseVarsBaseDefinitions(baseSource) : {}
  if (!Object.prototype.hasOwnProperty.call(base, key)) return { status: 'missing' }
  const overrides = await readAllOverrideDocumentsWithDiagnostics(fs, home, repoPath)
  const diagnostics = [
    ...overrides.diagnostics,
    ...findReferences(base, overrides.documents, key),
    ...(await findConsumerReferences(fs, repoPath, key)),
  ]
  if (diagnostics.length > 0) return { status: 'blocked', diagnostics }
  renameKey(base, key, null)
  await writeAgentAwareBase(fs, repoPath, base)
  await rewriteOverrideDocuments(fs, overrides.documents, key, null)
  return { status: 'deleted' }
}

export async function renameAgentAwareBaseKey(
  fs: IFileSystem,
  home: string,
  repoPath: string,
  oldKey: string,
  newKey: string,
): Promise<
  | { status: 'renamed' }
  | { status: 'missing' }
  | { status: 'conflict' }
  | { status: 'blocked'; diagnostics: VarsDiagnostic[] }
> {
  const baseSource = await readOptional(fs, syncedVarsPath(repoPath))
  const base = baseSource ? parseVarsBaseDefinitions(baseSource) : {}
  if (!Object.prototype.hasOwnProperty.call(base, oldKey)) return { status: 'missing' }
  if (Object.prototype.hasOwnProperty.call(base, newKey)) return { status: 'conflict' }
  const overrides = await readAllOverrideDocumentsWithDiagnostics(fs, home, repoPath)
  if (overrides.diagnostics.length > 0)
    return { status: 'blocked', diagnostics: overrides.diagnostics }
  renameKey(base, oldKey, newKey)
  rewriteDefinitionReferences(base, oldKey, newKey)
  await writeAgentAwareBase(fs, repoPath, base)
  await rewriteOverrideDocuments(fs, overrides.documents, oldKey, newKey, true)
  await rewriteConsumerReferences(fs, repoPath, oldKey, newKey)
  return { status: 'renamed' }
}

async function readAllOverrideDocumentsWithDiagnostics(
  fs: IFileSystem,
  home: string,
  repoPath: string,
): Promise<OverrideDocumentsReadResult> {
  const documents: OverrideDocument[] = []
  const diagnostics: VarsDiagnostic[] = []
  for (const file of await listAgentOverrideFilesWithDiagnostics(
    fs,
    join(repoPath, 'vars', 'agents'),
    'base-agent',
    diagnostics,
  )) {
    const source = await readOptional(fs, file.path)
    if (source) {
      const values = parseOverrideLayer(source, 'base-agent', file.path, diagnostics)
      if (Object.keys(values).length > 0)
        documents.push({
          layer: 'base-agent',
          agent: file.agent,
          path: file.path,
          values,
        })
    }
  }
  const localPath = localVarsPath(home, repoPath)
  const localSource = await readOptional(fs, localPath)
  if (localSource) {
    const values = parseOverrideLayer(localSource, 'local', localPath, diagnostics)
    if (Object.keys(values).length > 0) documents.push({ layer: 'local', path: localPath, values })
  }
  for (const file of await listAgentOverrideFilesWithDiagnostics(
    fs,
    join(localRepoPath(home, repoPath), 'vars', 'agents'),
    'local-agent',
    diagnostics,
  )) {
    const source = await readOptional(fs, file.path)
    if (source) {
      const values = parseOverrideLayer(source, 'local-agent', file.path, diagnostics)
      if (Object.keys(values).length > 0)
        documents.push({
          layer: 'local-agent',
          agent: file.agent,
          path: file.path,
          values,
        })
    }
  }
  return { documents, diagnostics }
}

async function findConsumerReferences(
  fs: IFileSystem,
  repoPath: string,
  referencedKey: string,
): Promise<VarsDiagnostic[]> {
  const diagnostics: VarsDiagnostic[] = []
  const memoryDir = join(repoPath, 'memories')
  let memories: string[] = []
  try {
    memories = await fs.readDir(memoryDir)
  } catch (error) {
    if (!isMissing(error)) throw error
  }
  for (const memory of memories.filter((entry) => entry.endsWith('.md'))) {
    const path = join(memoryDir, memory)
    const source = await readOptional(fs, path)
    if (source && referencesKey(source, referencedKey)) {
      diagnostics.push(
        diagnostic('CONSUMER_REFERENCE_EXISTS', 'Memory 仍引用变量: ' + referencedKey, {
          referencedKey,
          layer: 'memory',
          path: [path, referencedKey],
        }),
      )
    }
  }
  const mcpPath = join(repoPath, 'mcp.yaml')
  const mcpSource = await readOptional(fs, mcpPath)
  if (mcpSource && referencesKey(mcpSource, referencedKey)) {
    diagnostics.push(
      diagnostic('CONSUMER_REFERENCE_EXISTS', 'MCP 仍引用变量: ' + referencedKey, {
        referencedKey,
        layer: 'mcp',
        path: [mcpPath, referencedKey],
      }),
    )
  }
  return diagnostics
}

async function rewriteConsumerReferences(
  fs: IFileSystem,
  repoPath: string,
  oldKey: string,
  newKey: string,
): Promise<void> {
  const memoryDir = join(repoPath, 'memories')
  let memories: string[] = []
  try {
    memories = await fs.readDir(memoryDir)
  } catch (error) {
    if (!isMissing(error)) throw error
  }
  for (const memory of memories.filter((entry) => entry.endsWith('.md'))) {
    const path = join(memoryDir, memory)
    const source = await readOptional(fs, path)
    if (source && referencesKey(source, oldKey))
      await fs.writeFile(path, rewriteRefs(source, oldKey, newKey))
  }
  const mcpPath = join(repoPath, 'mcp.yaml')
  const mcpSource = await readOptional(fs, mcpPath)
  if (mcpSource && referencesKey(mcpSource, oldKey))
    await fs.writeFile(mcpPath, rewriteRefs(mcpSource, oldKey, newKey))
}

async function rewriteOverrideDocuments(
  fs: IFileSystem,
  documents: OverrideDocument[],
  oldKey: string,
  newKey: string | null,
  rewriteReferences = false,
): Promise<void> {
  for (const document of documents) {
    const changedKey = renameKey(document.values, oldKey, newKey)
    const changedRefs = rewriteReferences
      ? rewriteOverrideReferences(document.values, oldKey, newKey ?? oldKey)
      : false
    if (changedKey || changedRefs)
      await fs.writeFile(document.path, serializeVarsOverrides(document.values))
  }
}

function placeholderPattern(key: string): RegExp {
  const escaped = key.replace(/[.*+?^\${}()|[\]\\]/g, '\\$&')
  return new RegExp('(^|[^\\\\])\\$\\{' + escaped + '\\}', 'g')
}

function referencesKey(value: string, key: string): boolean {
  return placeholderPattern(key).test(value)
}

function rewriteRefs(value: string, oldKey: string, newKey: string): string {
  return value.replace(
    placeholderPattern(oldKey),
    (_, prefix: string) => prefix + '\${' + newKey + '}',
  )
}

function rewriteDefinitionReferences(
  definitions: Record<string, VarDefinition>,
  oldKey: string,
  newKey: string,
): boolean {
  let changed = false
  for (const definition of Object.values(definitions)) {
    if (
      (definition.type === 'string' || definition.type === 'secret') &&
      referencesKey(definition.value, oldKey)
    ) {
      definition.value = rewriteRefs(definition.value, oldKey, newKey)
      changed = true
    }
  }
  return changed
}

function rewriteOverrideReferences(
  overrides: Record<string, VarOverride>,
  oldKey: string,
  newKey: string,
): boolean {
  let changed = false
  for (const override of Object.values(overrides)) {
    if (typeof override.value === 'string' && referencesKey(override.value, oldKey)) {
      override.value = rewriteRefs(override.value, oldKey, newKey)
      changed = true
    }
  }
  return changed
}

function overrideMatchesDefinition(definition: VarDefinition, override: VarOverride): boolean {
  if (definition.type === 'string' || definition.type === 'secret')
    return typeof override.value === 'string'
  if (definition.type === 'number')
    return typeof override.value === 'number' && Number.isFinite(override.value)
  if (definition.type === 'boolean') return typeof override.value === 'boolean'
  return true
}

function findReferences(
  base: Record<string, VarDefinition>,
  overrides: OverrideDocument[],
  referencedKey: string,
): VarsDiagnostic[] {
  const diagnostics: VarsDiagnostic[] = []
  for (const [key, definition] of Object.entries(base)) {
    if (key === referencedKey) continue
    if (
      (definition.type === 'string' || definition.type === 'secret') &&
      referencesKey(definition.value, referencedKey)
    ) {
      diagnostics.push(
        diagnostic('REFERENCE_EXISTS', '变量仍被引用: ' + referencedKey, {
          key,
          referencedKey,
          layer: 'base',
          path: [key, referencedKey],
        }),
      )
    }
  }
  for (const document of overrides) {
    for (const [key, override] of Object.entries(document.values)) {
      if (key === referencedKey) continue
      if (typeof override.value === 'string' && referencesKey(override.value, referencedKey)) {
        diagnostics.push(
          diagnostic('REFERENCE_EXISTS', '变量仍被引用: ' + referencedKey, {
            key,
            referencedKey,
            layer: document.agent ? document.layer + '/' + document.agent : document.layer,
            path: [key, referencedKey],
          }),
        )
      }
    }
  }
  return diagnostics
}
