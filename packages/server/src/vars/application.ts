import {
  RESERVED_BUILTIN_PREFIX,
  deleteVariable as deleteLegacyVariable,
  danglingDiagnostics,
  inspectVariableDelete,
  prepareVarsMutationPersistence,
  renameVariable as renameLegacyVariable,
  resolveVarsLifecycle,
  setVariable as setLegacyVariable,
  validateVarDraft,
  type AgentId,
  type LayeredVarsResolution,
  type VarDefinition,
  type VarEntry,
  type VarOverride,
  type VarsDiagnostic,
  type VarsEnvironment,
  type VarsLifecycleResolution,
  type VarsMutationResult,
} from '@loom/core'
import { logger } from '../lib/logger.js'
import type { IFileSystem } from '../ports/fs.js'
import { VarsStore } from './store.js'
import {
  builtinForAgent,
  deleteAgentAwareBaseKey,
  readAgentAwareVars,
  readAgentAwareVarsWithDiagnostics,
  readDefaultVarsWithDiagnostics,
  renameAgentAwareBaseKey,
  resolveAgentAwareVars,
  resolveDefaultVars,
  validateAgentAwareBaseDefinitions,
  writeAgentAwareBase,
  writeAgentAwareOverride,
  type AgentAwareVarsSnapshot,
  type VarsLayerKind,
} from './agent-aware.js'

const varsLogger = logger.child('vars-application')
const MASK = '••••••••'

export class VarsApplicationError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 422,
    readonly code: string,
    message: string,
    readonly diagnostics?: VarsDiagnostic[],
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
  }
}

export interface VarsMatrix {
  ok: true
  agent: AgentId | 'default'
  builtinKeys: string[]
  userKeys: string[]
  snapshot: PresentedAgentAwareVarsSnapshot
  resolution: PresentedLayeredVarsResolution | Extract<LayeredVarsResolution, { ok: false }>
}

export type MaskedVarEntry = VarEntry | { type: 'secret'; value: string; masked: true }
export type PresentedVarOverride = VarOverride | { value: string; masked: true }
export interface PresentedAgentAwareVarsSnapshot {
  base: Record<string, MaskedVarEntry>
  baseAgent: Record<string, PresentedVarOverride>
  local: Record<string, PresentedVarOverride>
  localAgent: Record<string, PresentedVarOverride>
}
export type PresentedResolvedValues = Record<
  string,
  VarEntry | { type: VarEntry['type']; value: string; masked: true }
>
export type PresentedLayeredVarsEntry = Omit<
  Extract<LayeredVarsResolution, { ok: true }>['entries'][number],
  'value'
> & { value: PresentedResolvedValues[string] }

export interface PresentedVarsResolution {
  ok: true
  values: PresentedResolvedValues
  sources: Extract<VarsLifecycleResolution, { ok: true }>['sources']
  dependencies: Extract<VarsLifecycleResolution, { ok: true }>['dependencies']
  diagnostics: VarsDiagnostic[]
}

export interface PresentedLayeredVarsResolution {
  ok: true
  values: PresentedResolvedValues
  sources: Extract<LayeredVarsResolution, { ok: true }>['sources']
  overrideChains: Extract<LayeredVarsResolution, { ok: true }>['overrideChains']
  dependencies: Extract<LayeredVarsResolution, { ok: true }>['dependencies']
  entries: PresentedLayeredVarsEntry[]
  diagnostics: VarsDiagnostic[]
}

export interface VarsMutationResponse {
  changed: string[]
  diagnostics: VarsDiagnostic[]
}

export interface VarsSetVariableCommand {
  environment: string
  key: string
  entry: VarEntry
}

export interface VarsRenameVariableCommand {
  environment: string
  oldKey: string
  newKey: string
}

export interface VarsDeleteVariableCommand {
  environment: string
  key: string
  confirmed: boolean
  impactToken?: string
}

export interface VarsDraftCommand {
  environment: string
  key: string
  entry: VarEntry
  chain: string[]
}

export type SetVarsOverrideCommand =
  | { layer: 'base-agent' | 'local-agent'; agent: AgentId; key: string; override: VarOverride }
  | { layer: 'local'; key: string; override: VarOverride }

export type ClearVarsOverrideCommand =
  | { layer: 'base-agent' | 'local-agent'; agent: AgentId; key: string }
  | { layer: 'local'; key: string }

export class VarsApplication {
  constructor(
    private readonly fs: IFileSystem,
    private readonly home: string,
  ) {}

  async listEnvironments(
    repoPath: string,
  ): Promise<{ environments: string[]; diagnostics: VarsDiagnostic[] }> {
    const values = await this.loadAll(repoPath)
    return {
      environments: Object.keys(values).sort(),
      diagnostics: danglingDiagnostics(values),
    }
  }

  async getEnvironment(
    repoPath: string,
    environment: string,
  ): Promise<{
    name: string
    environment: Omit<VarsEnvironment, 'entries'> & { entries: Record<string, MaskedVarEntry> }
  }> {
    return {
      name: environment,
      environment: maskEnvironment(await this.store(repoPath).read(environment)),
    }
  }

  async createEnvironment(repoPath: string, environment: string): Promise<void> {
    await this.store(repoPath).create(environment, { format: 'typed', entries: {} })
  }

  async deleteEnvironment(repoPath: string, environment: string): Promise<void> {
    await this.store(repoPath).delete(environment)
  }

  async setVariable(
    repoPath: string,
    command: VarsSetVariableCommand,
  ): Promise<VarsMutationResponse> {
    return this.persistMutation(repoPath, (environments) =>
      setLegacyVariable(environments, command.environment, command.key, command.entry),
    )
  }

  async renameVariable(
    repoPath: string,
    command: VarsRenameVariableCommand,
  ): Promise<VarsMutationResponse> {
    return this.persistMutation(repoPath, (environments) =>
      renameLegacyVariable(environments, command.environment, command.oldKey, command.newKey),
    )
  }

  async deleteVariable(
    repoPath: string,
    command: VarsDeleteVariableCommand,
  ): Promise<VarsMutationResponse> {
    return this.persistMutation(repoPath, (environments) =>
      deleteLegacyVariable(
        environments,
        command.environment,
        command.key,
        command.confirmed
          ? { confirmed: true, expectedImpactToken: command.impactToken }
          : { confirmed: false },
      ),
    )
  }

  async deleteImpact(
    repoPath: string,
    environment: string,
    key: string,
  ): Promise<ReturnType<typeof inspectVariableDelete>> {
    const environments = await this.loadAll(repoPath)
    if (!environments[environment])
      throw new VarsApplicationError(404, 'environment_not_found', '环境不存在')
    if (!Object.hasOwn(environments[environment].entries, key))
      throw new VarsApplicationError(404, 'not_found', '变量不存在')
    return inspectVariableDelete(environments, environment, key)
  }

  async resolve(repoPath: string, chain: string[]): Promise<PresentedVarsResolution> {
    const result = resolveVarsLifecycle(await this.loadAll(repoPath), chain)
    if (!result.ok)
      throw new VarsApplicationError(422, 'resolution_failed', '变量解析失败', result.diagnostics)
    return presentResolution(result)
  }

  async validateDraft(
    repoPath: string,
    command: VarsDraftCommand,
  ): Promise<{ resolution: PresentedVarsResolution }> {
    const result = validateVarDraft(await this.loadAll(repoPath), command)
    if (!result.ok)
      throw new VarsApplicationError(422, 'validation_failed', '变量验证失败', result.diagnostics)
    return { resolution: presentResolution(result.resolution) }
  }

  async revealVariable(repoPath: string, environment: string, key: string): Promise<VarEntry> {
    const value = await this.store(repoPath).read(environment)
    if (!Object.hasOwn(value.entries, key))
      throw new VarsApplicationError(404, 'not_found', '变量不存在')
    return value.entries[key]!
  }

  async preview(
    repoPath: string,
    context: AgentId | 'default',
  ): Promise<PresentedLayeredVarsResolution> {
    return presentLayeredResolution(await this.resolveUnmaskedForInterpolation(repoPath, context))
  }

  async resolveUnmaskedForInterpolation(
    repoPath: string,
    context: AgentId | 'default',
  ): Promise<Extract<LayeredVarsResolution, { ok: true }>> {
    const result =
      context === 'default'
        ? await resolveDefaultVars(this.fs, this.home, repoPath)
        : await resolveAgentAwareVars(this.fs, this.home, repoPath, context)
    if (!result.ok)
      throw new VarsApplicationError(422, 'resolution_failed', '变量解析失败', result.diagnostics)
    return result
  }

  async matrix(repoPath: string, agent: AgentId | 'default'): Promise<VarsMatrix> {
    const [readResult, resolution] = await Promise.all([
      agent === 'default'
        ? readDefaultVarsWithDiagnostics(this.fs, this.home, repoPath)
        : readAgentAwareVarsWithDiagnostics(this.fs, this.home, repoPath, agent),
      agent === 'default'
        ? resolveDefaultVars(this.fs, this.home, repoPath)
        : resolveAgentAwareVars(this.fs, this.home, repoPath, agent),
    ])
    const snapshot = readResult.snapshot
    const mergedDiagnostics = [
      ...readResult.diagnostics,
      ...(!resolution.ok ? resolution.diagnostics : []),
    ]
    const builtinKeys = Object.keys(
      resolution.ok
        ? Object.fromEntries(
            Object.entries(resolution.values).filter(
              ([key]) => resolution.sources[key]?.locality === 'builtin',
            ),
          )
        : agent === 'default'
          ? {}
          : builtinForAgent(agent),
    ).sort()
    const userKeys = [
      ...new Set([
        ...Object.keys(snapshot.base),
        ...Object.keys(snapshot.baseAgent),
        ...Object.keys(snapshot.local),
        ...Object.keys(snapshot.localAgent),
      ]),
    ].sort()

    return {
      ok: true,
      agent,
      builtinKeys,
      userKeys,
      snapshot: presentAgentAwareSnapshot(snapshot),
      resolution: resolution.ok
        ? presentLayeredResolution(resolution)
        : { ok: false, diagnostics: mergedDiagnostics },
    }
  }

  async setBaseKey(repoPath: string, key: string, definition: VarDefinition): Promise<void> {
    this.assertUserKey(key)
    const snapshot = await readAgentAwareVars(this.fs, this.home, repoPath, 'codex')
    snapshot.base[key] = definition
    const diagnostics = await validateAgentAwareBaseDefinitions(
      this.fs,
      this.home,
      repoPath,
      snapshot.base,
    )
    if (diagnostics.length > 0)
      throw new VarsApplicationError(
        422,
        'validation_failed',
        '变量定义会导致覆盖层失效',
        diagnostics,
      )
    await writeAgentAwareBase(this.fs, repoPath, snapshot.base)
  }

  async deleteBaseKey(repoPath: string, key: string): Promise<void> {
    const result = await deleteAgentAwareBaseKey(this.fs, this.home, repoPath, key)
    if (result.status === 'missing') throw new VarsApplicationError(404, 'not_found', '变量不存在')
    if (result.status === 'blocked')
      throw new VarsApplicationError(
        409,
        'delete_blocked_by_reference',
        '变量仍被引用',
        result.diagnostics,
      )
  }

  async renameBaseKey(repoPath: string, oldKey: string, newKey: string): Promise<void> {
    this.assertUserKey(newKey)
    const result = await renameAgentAwareBaseKey(this.fs, this.home, repoPath, oldKey, newKey)
    if (result.status === 'missing') throw new VarsApplicationError(404, 'not_found', '变量不存在')
    if (result.status === 'conflict')
      throw new VarsApplicationError(409, 'variable_conflict', '目标变量已存在')
    if (result.status === 'blocked')
      throw new VarsApplicationError(422, 'validation_failed', '变量覆盖层无效', result.diagnostics)
  }

  async setOverride(repoPath: string, command: SetVarsOverrideCommand): Promise<void> {
    const snapshot = await readAgentAwareVars(
      this.fs,
      this.home,
      repoPath,
      command.layer === 'local' ? 'codex' : command.agent,
    )
    const definition = snapshot.base[command.key]
    if (!definition) throw new VarsApplicationError(404, 'not_found', '变量不存在')
    assertOverrideMatchesDefinition(definition, command.override)
    const target = layerSnapshot(snapshot, command.layer)
    target[command.key] = command.override
    await writeAgentAwareOverride(
      this.fs,
      this.home,
      repoPath,
      command.layer,
      command.layer === 'local' ? undefined : command.agent,
      target,
    )
  }

  async clearOverride(repoPath: string, command: ClearVarsOverrideCommand): Promise<void> {
    const snapshot = await readAgentAwareVars(
      this.fs,
      this.home,
      repoPath,
      command.layer === 'local' ? 'codex' : command.agent,
    )
    const target = layerSnapshot(snapshot, command.layer)
    delete target[command.key]
    await writeAgentAwareOverride(
      this.fs,
      this.home,
      repoPath,
      command.layer,
      command.layer === 'local' ? undefined : command.agent,
      target,
    )
  }

  private assertUserKey(key: string): void {
    if (key.startsWith(RESERVED_BUILTIN_PREFIX))
      throw new VarsApplicationError(
        400,
        'reserved_builtin_key',
        `${RESERVED_BUILTIN_PREFIX} 前缀保留给 builtin`,
      )
  }

  private store(repoPath: string): VarsStore {
    return new VarsStore(repoPath, this.fs, varsLogger)
  }

  private async loadAll(repoPath: string): Promise<Record<string, VarsEnvironment>> {
    return loadAll(this.store(repoPath))
  }

  private async persistMutation(
    repoPath: string,
    mutate: (environments: Record<string, VarsEnvironment>) => VarsMutationResult,
  ): Promise<VarsMutationResponse> {
    const store = this.store(repoPath)
    const mutation = mutate(await loadAll(store))
    const plan = prepareVarsMutationPersistence(mutation)
    if (!plan.ok) throw mutationError(plan)
    await store.writeMany(plan.environments)
    return { changed: mutation.changed, diagnostics: mutation.diagnostics }
  }
}

type MutationFailure = Extract<ReturnType<typeof prepareVarsMutationPersistence>, { ok: false }>

function mutationError(failure: MutationFailure): VarsApplicationError {
  const diagnostic = failure.diagnostic
  const status =
    diagnostic.code === 'environment_not_found' || diagnostic.code === 'not_found'
      ? 404
      : diagnostic.code === 'variable_conflict' ||
          diagnostic.code === 'impact_changed' ||
          diagnostic.code === 'delete_confirmation_required'
        ? 409
        : 422
  return new VarsApplicationError(
    status,
    diagnostic.code,
    diagnostic.message,
    failure.diagnostics,
    failure.deleteImpact ? { deleteImpact: failure.deleteImpact } : undefined,
  )
}

async function loadAll(store: VarsStore): Promise<Record<string, VarsEnvironment>> {
  const values: Record<string, VarsEnvironment> = Object.create(null)
  for (const environment of await store.list()) values[environment] = await store.read(environment)
  return values
}

function maskEntry(entry: VarEntry): MaskedVarEntry {
  return entry.type === 'secret' ? ({ type: 'secret', value: MASK, masked: true } as const) : entry
}

function maskEnvironment(
  environment: VarsEnvironment,
): Omit<VarsEnvironment, 'entries'> & { entries: Record<string, MaskedVarEntry> } {
  return {
    ...environment,
    entries: Object.fromEntries(
      Object.entries(environment.entries).map(([key, entry]) => [key, maskEntry(entry)]),
    ),
  }
}

function presentAgentAwareSnapshot(
  snapshot: AgentAwareVarsSnapshot,
): PresentedAgentAwareVarsSnapshot {
  const secretKeys = new Set(
    Object.entries(snapshot.base)
      .filter(([, entry]) => entry.type === 'secret')
      .map(([key]) => key),
  )
  const maskOverrides = (overrides: Record<string, VarOverride>) =>
    Object.fromEntries(
      Object.entries(overrides).map(([key, override]) => [
        key,
        secretKeys.has(key) ? { value: MASK, masked: true } : override,
      ]),
    )
  return {
    base: Object.fromEntries(
      Object.entries(snapshot.base).map(([key, entry]) => [key, maskEntry(entry)]),
    ),
    baseAgent: maskOverrides(snapshot.baseAgent),
    local: maskOverrides(snapshot.local),
    localAgent: maskOverrides(snapshot.localAgent),
  }
}

function presentLayeredResolution(
  resolution: Extract<LayeredVarsResolution, { ok: true }>,
): PresentedLayeredVarsResolution {
  const tainted = new Set(
    Object.entries(resolution.values)
      .filter(([, entry]) => entry.type === 'secret')
      .map(([key]) => key),
  )
  let changed = true
  while (changed) {
    changed = false
    for (const [key, dependencies] of Object.entries(resolution.dependencies)) {
      if (!tainted.has(key) && dependencies.some((dependency) => tainted.has(dependency))) {
        tainted.add(key)
        changed = true
      }
    }
  }
  const values = presentResolvedValues(resolution.values, [...tainted])
  return {
    ok: true,
    values,
    sources: resolution.sources,
    overrideChains: resolution.overrideChains,
    dependencies: resolution.dependencies,
    entries: resolution.entries.map((entry) => ({ ...entry, value: values[entry.key] })),
    diagnostics: resolution.diagnostics,
  }
}

function presentResolvedValues(
  values: Record<string, VarEntry>,
  secretTaintedKeys: string[],
): PresentedResolvedValues {
  const tainted = new Set(secretTaintedKeys)
  return Object.fromEntries(
    Object.entries(values).map(([key, entry]) => [
      key,
      tainted.has(key) ? { ...entry, value: MASK, masked: true } : entry,
    ]),
  )
}

function presentResolution(
  resolution: Extract<VarsLifecycleResolution, { ok: true }>,
): PresentedVarsResolution {
  return {
    ok: true,
    values: presentResolvedValues(resolution.values, resolution.secretTaintedKeys),
    sources: resolution.sources,
    dependencies: resolution.dependencies,
    diagnostics: resolution.diagnostics,
  }
}

function layerSnapshot(
  snapshot: AgentAwareVarsSnapshot,
  layer: Exclude<VarsLayerKind, 'base'>,
): Record<string, VarOverride> {
  return layer === 'base-agent'
    ? snapshot.baseAgent
    : layer === 'local'
      ? snapshot.local
      : snapshot.localAgent
}

function assertOverrideMatchesDefinition(definition: VarEntry, override: { value: unknown }): void {
  const value = override.value
  const matches =
    definition.type === 'string' || definition.type === 'secret'
      ? typeof value === 'string'
      : definition.type === 'number'
        ? typeof value === 'number' && Number.isFinite(value)
        : definition.type === 'boolean'
          ? typeof value === 'boolean'
          : true
  if (!matches)
    throw new VarsApplicationError(422, 'override_type_mismatch', '覆盖值类型与 base 定义不匹配')
}
