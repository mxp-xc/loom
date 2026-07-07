export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

export type VarEntry =
  | { type: 'string' | 'secret'; value: string; format?: StringFormat }
  | { type: 'number'; value: number }
  | { type: 'boolean'; value: boolean }
  | { type: 'json'; value: JsonValue }

export type StringFormat = 'plain' | 'markdown' | 'json' | 'yaml' | 'toml' | 'shell' | 'path'

export type VarDefinition = VarEntry

export type VarOverride = { value: string | number | boolean | JsonValue }

export type VarsLayerRef =
  | { locality: 'synced'; layer: 'base'; agent?: undefined }
  | { locality: 'synced'; layer: 'agent'; agent: string }
  | { locality: 'local'; layer: 'local'; agent?: undefined }
  | { locality: 'local'; layer: 'agent'; agent: string }
  | { locality: 'builtin'; layer: 'runtime'; agent?: string }

export interface VarsResolvedEntry {
  key: string
  value: VarDefinition
  source: VarsLayerRef
  overrides: VarsLayerRef[]
  dependencies: string[]
}

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

export const VAR_KEY = /^[A-Za-z_][A-Za-z0-9_.-]*$/
export const RESERVED_BUILTIN_PREFIX = 'LOOM_'
