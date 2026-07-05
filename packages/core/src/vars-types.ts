export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

export type VarEntry =
  | { type: 'string' | 'secret'; value: string }
  | { type: 'number'; value: number }
  | { type: 'boolean'; value: boolean }
  | { type: 'json'; value: JsonValue }

export interface VarsEnvironment {
  format: 'legacy' | 'typed'
  entries: Record<string, VarEntry>
}

export interface VarsDiagnostic {
  code: string
  severity: 'error' | 'warning'
  environment?: string
  key?: string
  referencedKey?: string
  path?: string[]
  message: string
}

export const VAR_KEY = /^[A-Za-z_][A-Za-z0-9_.-]*$/
