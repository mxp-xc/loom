import { setVariable, type MutationResult as VarsMutationResult } from './vars-mutators.js'
import { resolveVarsChain, type VarsResolutionResult } from './vars.js'
import type { VarEntry, VarsDiagnostic, VarsEnvironment } from './vars-types.js'
import { normalizeVarEntry } from './vars-value.js'

type Environments = Record<string, VarsEnvironment>

export type VarsLifecycleResolution =
  | (Extract<VarsResolutionResult, { ok: true }> & { secretTaintedKeys: string[] })
  | Extract<VarsResolutionResult, { ok: false }>

export type VarsDraftValidationResult =
  | { ok: true; resolution: Extract<VarsLifecycleResolution, { ok: true }> }
  | Extract<VarsResolutionResult, { ok: false }>

export interface VarDraftValidationCommand {
  environment: string
  key: string
  entry: VarEntry
  chain: string[]
}

export type VarsMutationPersistencePlan =
  | { ok: true; environments: Record<string, VarsEnvironment> }
  | {
      ok: false
      diagnostic: VarsDiagnostic
      diagnostics: VarsDiagnostic[]
      deleteImpact?: VarsMutationResult['deleteImpact']
    }

function secretTaintedKeys(
  values: Record<string, VarEntry>,
  dependencies: Record<string, string[]>,
): string[] {
  const tainted = new Map<string, boolean>()
  const isTainted = (key: string): boolean => {
    const cached = tainted.get(key)
    if (cached !== undefined) return cached
    tainted.set(key, false)
    const entry = values[key]
    const result = entry?.type === 'secret' || (dependencies[key] ?? []).some(isTainted)
    tainted.set(key, result)
    return result
  }

  return Object.keys(values).filter(isTainted)
}

function draftOverlay(
  environments: Environments,
  environment: string,
  key: string,
  entry: VarEntry,
): Environments {
  const normalized = normalizeVarEntry(entry)!
  return {
    ...environments,
    [environment]: {
      ...environments[environment],
      entries: { ...environments[environment].entries, [key]: normalized },
    },
  }
}

export function resolveVarsLifecycle(
  environments: Environments,
  chain: string[],
): VarsLifecycleResolution {
  const resolution = resolveVarsChain(environments, chain)
  if (!resolution.ok) return resolution
  return {
    ...resolution,
    secretTaintedKeys: secretTaintedKeys(resolution.values, resolution.dependencies),
  }
}

export function validateVarDraft(
  environments: Environments,
  command: VarDraftValidationCommand,
): VarsDraftValidationResult {
  const mutation = setVariable(environments, command.environment, command.key, command.entry)
  const errors = mutation.diagnostics.filter((item) => item.severity === 'error')
  if (errors.some((item) => item.code !== 'missing_reference')) {
    return { ok: false, diagnostics: mutation.diagnostics }
  }

  const overlay =
    errors.length === 0
      ? mutation.environments
      : draftOverlay(environments, command.environment, command.key, command.entry)
  const resolution = resolveVarsLifecycle(overlay, command.chain)
  if (!resolution.ok) return resolution
  return { ok: true, resolution }
}

export function prepareVarsMutationPersistence(
  result: VarsMutationResult,
): VarsMutationPersistencePlan {
  const diagnostic = result.diagnostics.find((item) => item.severity === 'error')
  if (diagnostic) {
    return {
      ok: false,
      diagnostic,
      diagnostics: result.diagnostics,
      ...(result.deleteImpact ? { deleteImpact: result.deleteImpact } : {}),
    }
  }
  return {
    ok: true,
    environments: Object.fromEntries(
      result.changed.map((name) => [name, result.environments[name]]),
    ),
  }
}
