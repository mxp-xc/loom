export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

export type StringFormat = 'plain' | 'markdown' | 'json' | 'yaml' | 'toml' | 'shell' | 'path'

export type NonSecretVarEntry =
  | { type: 'string'; value: string; format?: StringFormat }
  | { type: 'number'; value: number }
  | { type: 'boolean'; value: boolean }
  | { type: 'json'; value: JsonValue }

export type VarEntryInput = NonSecretVarEntry | { type: 'secret'; value: string }

export type VarEntry = NonSecretVarEntry | { type: 'secret'; value: '••••••••'; masked: true }

export type VarType = VarEntryInput['type']
export type ResolvedVarEntry = VarEntry | { type: VarType; value: '••••••••'; masked: true }

export type RevealedVarEntry = NonSecretVarEntry | { type: 'secret'; value: string; masked?: false }

export interface VarsEnvironment {
  format: 'legacy' | 'typed'
  entries: Record<string, VarEntry>
}

export interface VarsDiagnostic {
  code: string
  severity: 'error' | 'warning'
  environment?: string
  layer?: string
  key?: string
  referencedKey?: string
  path?: string[]
  message: string
}

export interface VarsApiError {
  ok: false
  error: { code: string; message: string; diagnostics?: VarsDiagnostic[] }
}

export interface VarsResolution {
  ok: true
  values: Record<string, ResolvedVarEntry>
  sources: Record<string, string>
  dependencies: Record<string, string[]>
  diagnostics: VarsDiagnostic[]
}

export interface DeleteImpact {
  direct: Array<{ environment: string; key: string }>
  transitive: Array<{ environment: string; key: string }>
  impactToken: string
}

export interface VarsMutationResponse {
  ok: true
  changed: string[]
  diagnostics: VarsDiagnostic[]
}

export type VarsLayerRef =
  | { locality: 'synced'; layer: 'base' }
  | { locality: 'synced'; layer: 'agent'; agent: string }
  | { locality: 'local'; layer: 'local' }
  | { locality: 'local'; layer: 'agent'; agent: string }
  | { locality: 'builtin'; layer: 'runtime'; agent?: string }

export type VarOverride = { value: string | number | boolean | JsonValue }

export interface AgentAwareVarsSnapshot {
  base: Record<string, VarEntryInput>
  baseAgent: Record<string, VarOverride>
  local: Record<string, VarOverride>
  localAgent: Record<string, VarOverride>
}

export type AgentAwareVarsResolution =
  | {
      ok: true
      values: Record<string, VarEntryInput>
      sources: Record<string, VarsLayerRef>
      overrideChains: Record<string, VarsLayerRef[]>
      dependencies: Record<string, string[]>
      diagnostics: VarsDiagnostic[]
    }
  | { ok: false; diagnostics: VarsDiagnostic[] }

export interface VarsMatrixResponse {
  ok: true
  agent: string
  builtinKeys: string[]
  userKeys: string[]
  snapshot: AgentAwareVarsSnapshot
  resolution: AgentAwareVarsResolution
}
